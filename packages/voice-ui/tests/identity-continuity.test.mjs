import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { partSummary, partResourceView } from '../src/part-description.mjs';
import { legalLocalDeltas, proveLocalDelta } from '../src/turn.mjs';
import { createSession, proposeGoal, undo, apply } from '../src/session.mjs';
import { commitLog, restoreLog } from '../src/log.mjs';
const protocol = await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL ?? path.join(process.env.SEMANTIC_MAP,'packages/semantic-map/protocol/index.js')));
const parts = [
  { key:'task-a', label:'Fargate Task', kind:'step', purpose:'task instance intended for Private Subnet 1' },
  { key:'task-b', label:'Fargate Task', kind:'step', purpose:'task instance intended for Private Subnet 2' },
];
const identity = p => JSON.stringify({schema:'voice-ui.part-description/2',key:p.key,purpose:p.purpose});
const initial = async () => {
  const g = await protocol.createDecisionLog([
    {type:'meta',schema:'semantic-map-state/1',root:'root',title:'reference identity continuity'},
    {type:'region',id:'root',parent:null,label:'World',kind:'boundary',bounds:[0,0,3000,1200],summary:''},
    {type:'region',id:'subnet-a',parent:'root',label:'Private Subnet 1',kind:'group',bounds:[0,0,1000,700],summary:''},
    {type:'region',id:'subnet-b',parent:'root',label:'Private Subnet 2',kind:'group',bounds:[1200,0,1000,700],summary:''},
  ],'voice-graph');
  const d=await protocol.createDecision(g.head,[{type:'PinRegions',items:g.records.filter(r=>r.type==='region'&&r.parent!==null).map(r=>({regionId:r.id,bounds:r.bounds}))}],g.records);
  return (await protocol.appendDecision(g.log,d.decision)).verified;
};
for(const p of parts)test('B identity without symbol / '+p.key,()=>{
 assert.equal(partSummary(p,{preserveIdentity:true}),identity(p));
 assert.equal(partSummary(p),'','legacy summaries are unchanged');
 assert.deepEqual(partResourceView([{type:'region',id:'x',summary:identity(p)}]),{});
});
test('old symbol bytes and placements are retained, not downgraded to identity-only',()=>{
 const symbol={href:'/assets/task.svg',alt:'Task',provenanceRef:'catalog:task:1'};
 const p={...parts[0],symbol};
 const text=JSON.stringify({schema:'voice-ui.part-description/1',key:p.key,purpose:p.purpose,symbol});
 assert.equal(partSummary(p),text);assert.equal(partSummary(p,{preserveIdentity:true}),text);
 const view=partResourceView([{type:'region',id:'task',summary:text},{type:'region',id:'other',summary:identity(parts[1])}]);
 assert.equal(view.resourceComposition.placements.length,1);
 assert.equal(view.resourceComposition.placements[0].targetRef,'node:task');
});
for(const [id,bad] of [
 ['missing-key',{purpose:'task'}],['empty-purpose',{key:'task',purpose:''}],['invalid-key',{key:'bad key',purpose:'task'}],
 ['oversize-purpose',{key:'task',purpose:'x'.repeat(301)}],['null-symbol',{key:'task',purpose:'task',symbol:null}],
])test('B refuses malformed identity / '+id,()=>assert.throws(()=>partSummary(bad,{preserveIdentity:true})));
for(const [id,bad] of [
 ['v1-missing-image',{schema:'voice-ui.part-description/1',key:'task',purpose:'task'}],
 ['v2-unknown-image',{schema:'voice-ui.part-description/2',key:'task',purpose:'task',symbol:{}}],
 ['v2-extra',{schema:'voice-ui.part-description/2',key:'task',purpose:'task',extra:true}],
])test('B fails closed on stored malformed description / '+id,()=>assert.throws(()=>partResourceView([{type:'region',id:'task',summary:JSON.stringify(bad)}])));

test('A held candidates and B reduced graph keep two equal labels separate across subnets and persistence',async()=>{
 const before=await initial();let session=createSession({accepted:before,stored:before.log});const start=session;
 const bundle={goalSelection:'delta',parts,diagrams:[]}, frozen=JSON.stringify(bundle);const selected=[];
 for(const [i,p] of parts.entries()){
  const args={bundle,protocol,reserved:session.issuedPartIds,selected,expressive:true};
  const held=legalLocalDeltas(session.working,args),c=held.candidates.find(c=>c.part===p.key&&c.parent===(i?'subnet-b':'subnet-a'));
  assert.ok(c);
  const planned=await proveLocalDelta({working:session.working,...args,held,candidateId:c.id,confidence:1});
  assert.equal(planned.outcome,'step');
  const next=await proposeGoal(session,{step:planned.step,input:{source:'typed',text:'one task in each subnet'},group:start.nextSeq,protocol});
  assert.equal(next.result.outcome,'step');session=next.session;
  const regionId=planned.step.decision.operations[0].regionId;
  selected.push({key:p.key,region:regionId,parent:c.parent});
 }
 const added=session.working.records.filter(r=>r.type==='region'&&r.label==='Fargate Task');
 assert.equal(added.length,2);
 assert.deepEqual(added.map(r=>[r.label,r.kind,r.parent,r.summary]),parts.map((p,i)=>[p.label,p.kind,i?'subnet-b':'subnet-a',identity(p)]));
 assert.equal(JSON.stringify(bundle),frozen,'candidate catalogue remains untouched');
 assert.ok(before.records.every(r=>session.working.records.some(x=>JSON.stringify(x)===JSON.stringify(r))));
 const reread=await protocol.verifyDecisionLog(session.working.log);assert.deepEqual(reread.records,session.working.records);
 const undone=await undo(session,{verifyDecisionLog:protocol.verifyDecisionLog});assert.deepEqual(undone.working.records,before.records);
 let stored=before.log;
 const saved=await apply(session,{commit:({graph,expected})=>commitLog({graph,expected,key:'fixture',read:async()=>stored,write:async(_key,v)=>{stored=v;},lock:async(_key,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog})});
 assert.equal(saved.result.status,'committed');
 const restored=await restoreLog({key:'fixture',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(restored.status,'restored');assert.deepEqual(restored.graph.records,reread.records);
 assert.deepEqual(partResourceView(restored.graph.records),{});
});
