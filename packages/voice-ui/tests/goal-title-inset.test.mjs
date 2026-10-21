import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {legalLocalDeltas,proveLocalDelta,OUTCOME_STEP} from '../src/turn.mjs';
import {MAP_ID,STATE_SCHEMA} from '../src/log.mjs';
const protocol=await import(pathToFileURL(path.resolve(process.env.VOICE_UI_TEST_PROTOCOL
  ?? path.join(process.env.SEMANTIC_MAP ?? '', 'packages/semantic-map/protocol/index.js'))));
const stock=Array.from({length:5},(_,i)=>({key:'job-'+i,label:'Job'+i,kind:'step',purpose:'one Job'+i}));
async function seed(){
 const initial=await protocol.createDecisionLog([
  {type:'meta',schema:STATE_SCHEMA,root:'root',title:'title inset regression'},
  {type:'region',id:'root',label:'World',kind:'boundary',parent:null,bounds:[0,0,1000,700],summary:''},
  {type:'region',id:'container',label:'OCI',kind:'group',parent:'root',bounds:[0,0,2000,500],summary:''},
 ],MAP_ID);
 const pin=await protocol.createDecision(initial.head,[{type:'PinRegions',items:[{regionId:'container',bounds:[0,0,2000,500]}]}],initial.records);
 return (await protocol.appendDecision(initial.log,pin.decision)).verified;
}
for(const expressive of [false,true])test('title inset preserves '+(expressive?'v8 provider spacing':'v7 legacy placement'),async()=>{
 const before=await seed(), selected=[];let working=before;
 for(const part of stock){
  const options={bundle:{parts:stock},protocol,selected,expressive};
  const held=legalLocalDeltas(working,options);
  const candidate=held.candidates.find(item=>item.part===part.key&&item.parent==='container');assert.ok(candidate);
  const proved=await proveLocalDelta({working,held,candidateId:candidate.id,confidence:1,...options});
  assert.equal(proved.outcome,OUTCOME_STEP);
  working=(await protocol.appendDecision(working.log,proved.step.decision)).verified;
  const region=candidate.operations[0].regionId;selected.push({key:part.key,region,parent:'container'});
 }
 const view={pattern:protocol.GRAPH_PATTERN};
 const layout=protocol.layoutBoundsFor(working.records,view);
 const natural=protocol.layoutBoundsFor(working.records.filter(r=>r.type!=='layout'),view);
 const nodes=working.records.filter(r=>r.type==='region'&&r.parent==='container');assert.equal(nodes.length,5);
 const inset=Math.min(...nodes.map(r=>natural.bounds[r.id][1]))-natural.bounds.container[1];
 assert.ok(inset>36,'provider title inset exceeds the old compact allowance');
 for(const node of nodes){
  const actual=layout.bounds[node.id][1]-layout.bounds.container[1];
  if(expressive)assert.ok(actual>=inset,'every new child stays below the provider title area');
  else assert.equal(actual,36,'legacy geometry remains exact');
 }
 assert.ok(before.records.every(old=>working.records.some(r=>JSON.stringify(r)===JSON.stringify(old))), 'existing graph and hard pins are untouched');
});
