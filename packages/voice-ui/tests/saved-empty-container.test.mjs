import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {newMap, legalLocalDeltas, proveLocalDelta, appendStep}=await import(process.env.VOICE_UI_TEST_TURN
  ? pathToFileURL(path.resolve(process.env.VOICE_UI_TEST_TURN)) : new URL('../src/turn.mjs',import.meta.url));
const protocol=await import(pathToFileURL(path.resolve(process.env.VOICE_UI_TEST_PROTOCOL
  ?? path.join(process.env.SEMANTIC_MAP ?? '', 'packages/semantic-map/protocol/index.js'))));
globalThis.fetch=async()=>{throw Error('no network in container geometry tests');};
const group={key:'area',label:'Area',kind:'group',purpose:'a container for later parts'};
const stock=Array.from({length:3},(_,i)=>({key:'item-'+i,label:'Item',kind:'data',purpose:'a stored item'}));
const add=async(working,part,parent,parts)=>{
  // Each addition is a separate post-save operation, with no current-Goal
  // selected group granting permission to resize any existing container.
  const options={bundle:{parts},protocol,expressive:true,selected:[],reserved:[]};
  const held=legalLocalDeltas(working,options),candidate=held.candidates.find(c=>c.part===part.key&&c.parent===parent);
  assert.ok(candidate,'new saved container must have a legal child slot');
  const proof=await proveLocalDelta({working,held,candidateId:candidate.id,confidence:1,...options});
  assert.equal(proof.outcome,'step');
  return (await appendStep({working,step:proof.step,protocol})).graph;
};
test('ordinary new map -> group -> verified saved log -> three later parts preserves saved records',async()=>{
  let working=(await newMap({title:'World',protocol})).graph;
  working=await add(working,group,'root',[group]);
  const saved=await protocol.verifyDecisionLog(working.log),groupId=saved.records.find(r=>r.type==='region'&&r.kind==='group').id;
  assert.deepEqual(saved.records,working.records);
  for(const part of stock)working=await add(working,part,groupId,[part]);
  assert.equal(working.records.filter(r=>r.type==='region'&&r.parent===groupId).length,3);
  for(const record of saved.records)assert.ok(working.records.some(r=>JSON.stringify(r)===JSON.stringify(record)),'saved record must remain exact');
  const again=await protocol.verifyDecisionLog(working.log);assert.deepEqual(again.records,working.records);
  const layout=protocol.layoutBoundsFor(again.records,{pattern:protocol.GRAPH_PATTERN}),frame=layout.bounds[groupId];
  const children=again.records.filter(r=>r.type==='region'&&r.parent===groupId).map(r=>layout.bounds[r.id]);
  for(const b of children)assert.ok(b[0]>=frame[0]&&b[1]>=frame[1]&&b[0]+b[2]<=frame[0]+frame[2]&&b[1]+b[3]<=frame[1]+frame[3]);
  for(let i=0;i<children.length;i++)for(let j=0;j<i;j++){const a=children[i],b=children[j];assert.ok(a[0]>=b[0]+b[2]||b[0]>=a[0]+a[2]||a[1]>=b[1]+b[3]||b[1]>=a[1]+a[3]);}
});
test('an existing small saved container still refuses instead of silently growing',async()=>{
  let working=(await newMap({title:'World',protocol})).graph;working=await add(working,group,'root',[group]);
  const id=working.records.find(r=>r.type==='region'&&r.kind==='group').id;
  const d=await protocol.createDecision(working.head,[{type:'PinRegions',items:[{regionId:id,bounds:[12,187,180,92]}]}],working.records);
  const small=(await protocol.appendDecision(working.log,d.decision)).verified;
  const held=legalLocalDeltas(small,{bundle:{parts:stock},protocol,expressive:true,selected:[]});
  assert.equal(held.candidates.some(c=>c.parent===id),false);
});
test('a new root container preserves a saved sibling and its entire subtree positions',async()=>{
  const initial=await protocol.createDecisionLog([
    {type:'meta',schema:'semantic-map-state/1',root:'root',title:'siblings'},
    {type:'region',id:'root',kind:'boundary',label:'World',summary:'',parent:null,bounds:[0,0,1000,700]},
    {type:'region',id:'keeper',kind:'group',label:'Keeper',summary:'',parent:'root',bounds:[650,150,200,400]},
  ],'voice-graph');
  const pin=await protocol.createDecision(initial.head,[{type:'PinRegions',items:[{regionId:'keeper',bounds:[650,150,200,400]}]}],initial.records);
  const before=(await protocol.appendDecision(initial.log,pin.decision)).verified,after=await add(before,group,'root',[group]);
  for(const r of before.records)assert.ok(after.records.some(x=>JSON.stringify(x)===JSON.stringify(r)));
  const layout=protocol.layoutBoundsFor(after.records,{pattern:protocol.GRAPH_PATTERN});
  const id=after.records.find(r=>r.type==='region'&&r.label==='Area').id,a=layout.bounds[id],b=layout.bounds.keeper;
  assert.ok(a[0]+a[2]+12<=b[0]||b[0]+b[2]+12<=a[0]||a[1]+a[3]+12<=b[1]||b[1]+b[3]+12<=a[1]);
});
test('a second root container remains available after saving a content canvas',async()=>{
  let working=(await newMap({title:'World',protocol})).graph;
  working=await add(working,group,'root',[group]);
  const before=await protocol.verifyDecisionLog(working.log),other={...group,key:'other',label:'Other'};
  const after=await add(before,other,'root',[other]);
  const layout=protocol.layoutBoundsFor(after.records,{pattern:protocol.GRAPH_PATTERN}),previous=protocol.layoutBoundsFor(before.records,{pattern:protocol.GRAPH_PATTERN});
  for(const record of before.records){assert.ok(after.records.some(r=>JSON.stringify(r)===JSON.stringify(record)));if(record.type==='region'&&record.parent!==null)assert.deepEqual(layout.bounds[record.id],previous.bounds[record.id]);}
  assert.equal(after.records.filter(r=>r.type==='region'&&r.parent==='root').length,2);
});
