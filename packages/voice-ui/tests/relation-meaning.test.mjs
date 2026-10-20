import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

// One frozen set of expectations, also used against the prior public source.
// Synthetic answers prove the application's read set and mechanics only.
const root=process.env.VOICE_RELATION_SOURCE??new URL('..',import.meta.url).pathname;
const load=relative=>import(pathToFileURL(path.join(root,relative)));
const {requestFor,planStep,appendStep,legalLocalDeltas,proveLocalDelta,revertStep}=await load('src/turn.mjs');
const {isRequest,slotsFor,REQUEST_KIND,ANNOTATION_REQUEST_KIND,ARCHITECTURE_INTENT_KIND}=await load('src/contract.mjs');
const {questionsFor}=await load('src/judgment.mjs');
const {readBundle}=await load('src/bundle.mjs');
const {createSession,propose,undo,apply}=await load('src/session.mjs');
const {commitLog,restoreLog}=await load('src/log.mjs');
const {onRequestPost}=await load('functions/api/judge.mjs');
const protocol=await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL??path.join(process.env.SEMANTIC_MAP,'packages/semantic-map/protocol/index.js')));
const fixtures=fs.readFileSync(new URL('./fixtures/normal-composition/editing.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.typedRelation);
const canonical=x=>Array.isArray(x)?x.map(canonical):x!==null&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const bag=rows=>rows.map(row=>JSON.stringify(canonical(row))).sort();
const initial=async(fixture,edges=null,extra=[])=>{
 const rows=fixture.edit.initialRecords;
 const graph=await protocol.createDecisionLog(edges===null?rows:[...rows.filter(r=>r.type!=='relation'),...extra,...edges],'voice-graph');
 const built=await protocol.createDecision(graph.head,[{type:'PinRegions',items:fixture.edit.pins}],graph.records);
 return (await protocol.appendDecision(graph.log,built.decision)).verified;
};
const prepare=(working,fixture,typed=true)=>{
 const bundle=readBundle(fixture.bundle),layout=protocol.layoutBoundsFor(working.records,{pattern:protocol.GRAPH_PATTERN});
 const frame=[0,0,2100,800];
 const {turn,request}=requestFor({working,utterance:fixture.text,bundle,layout,offeredFrame:frame,draft:[],focus:null,pending:null,recent:[],typedEdges:typed});
 const answers=Object.fromEntries(Object.keys(turn.slots).map(key=>[key,{type:'choice',choice:fixture.edit.response[key]??'none',confidence:.9}]));
 return {working,bundle,layout,turn,request,answers,protocol,visibleFrame:{head:working.head,frame}};
};
const plainEdge=({id,from,to,kind,label})=>({id,from,to,kind,label});

for(const fixture of fixtures){
 test('B meaningful relation input is closed and complete / '+fixture.id,async()=>{
  const prepared=prepare(await initial(fixture),fixture);
  assert.equal(ANNOTATION_REQUEST_KIND,'voice-ui.judge.request.v3');
  assert.equal(prepared.request.kind,ANNOTATION_REQUEST_KIND);assert.equal(isRequest(prepared.request),true);
  assert.deepEqual(prepared.request.state.graph.edges,fixture.typedRelation.expectedInputEdges.map(plainEdge));
 });
 test('B performs only the requested typed edit and preserves every other record / '+fixture.id,async()=>{
  const prepared=prepare(await initial(fixture),fixture),planned=await planStep(prepared);
  assert.equal(planned.outcome,'step',JSON.stringify(planned));
  const changed=await appendStep({...prepared,step:planned.step});assert.equal(changed.outcome,'step');
  assert.deepEqual(bag(changed.graph.records),bag(fixture.edit.expectedRecords));
 });
 test('B actual function route -> state -> Undo -> save -> reread -> history inverse / '+fixture.id,async()=>{
  const before=await initial(fixture),prepared=prepare(before,fixture);
  let calls=0;
  const response=await onRequestPost({request:new Request('https://fixture.invalid/api/judge',{method:'POST',body:JSON.stringify(prepared.request)}),available:true},async({state,questions})=>{
   calls++;assert.deepEqual(state.graph.edges,fixture.typedRelation.expectedInputEdges.map(plainEdge));
   for(const edge of state.graph.edges){assert.ok(questions.edge.options[edge.id].includes(JSON.stringify(edge.kind)));assert.ok(questions.edge.options[edge.id].includes(JSON.stringify(edge.label)));}
   return {answers:Object.fromEntries(Object.entries(prepared.answers).map(([k,{type,...v}])=>[k,v]))};
  });
  assert.equal(response.status,200);assert.equal(calls,1);
  const input={source:'typed',text:fixture.text},answers=(await response.json()).answers;
  const original=createSession({accepted:before,stored:before.log});
  const changed=await propose(original,{...prepared,answers,input,repair:null});assert.equal(changed.result.outcome,'step');
  assert.deepEqual(bag(changed.session.working.records),bag(fixture.edit.expectedRecords));
  assert.equal(changed.session.stored,before.log);
  const undone=await undo(changed.session,{verifyDecisionLog:protocol.verifyDecisionLog});assert.equal(undone.working.log,before.log);
  let stored=before.log;
  const saved=await apply(changed.session,{commit:({graph,expected})=>commitLog({graph,expected,key:'fixture',read:async()=>stored,write:async(_key,value)=>{stored=value;},lock:async(_key,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog})});
  assert.equal(saved.result.status,'committed');
  const reopened=await restoreLog({key:'fixture',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});assert.equal(reopened.status,'restored');
  assert.deepEqual(bag(reopened.graph.records),bag(fixture.edit.expectedRecords));
  const inverse=await revertStep({before:before.records,after:changed.session.working.records,working:reopened.graph,protocol});assert.equal(inverse.outcome,'step');
  const restored=await appendStep({working:reopened.graph,step:inverse.step,protocol});assert.deepEqual(bag(restored.graph.records),bag(before.records));
 });
}

test('v1 request/criteria keep their exact old read set',async()=>{
 const f=fixtures[1],p=prepare(await initial(f),f,false);assert.equal(p.request.kind,REQUEST_KIND);assert.equal(isRequest(p.request),true);
 assert.deepEqual(p.request.state.graph.edges,f.typedRelation.expectedInputEdges.map(({id,from,to})=>({id,from,to})));
 const questions=questionsFor(p.request.state,p.turn.slots,{kind:REQUEST_KIND});
 assert.ok(!questions.edge.options['metrics-up'].includes('stored in Working'));
});
test('typed stored descriptions do not impersonate source provenance',async()=>{
 const p=prepare(await initial(fixtures[1]),fixtures[1]);
 const questions=questionsFor(p.request.state,p.turn.slots,{kind:p.request.kind});
 assert.ok(questions.edge.instruction.includes('not verified source evidence'));
 assert.ok(questions.edge.options['metrics-up'].includes('"metrics"'));assert.ok(questions.edge.options['metrics-up'].includes('"RPS"'));
 assert.ok(!questions.edge.options['metrics-up'].includes('snapshot defines'));
});
for(const [name,mutate] of [
 ['missing-kind',r=>{delete r.state.graph.edges[0].kind;}],['missing-label',r=>{delete r.state.graph.edges[0].label;}],
 ['extra-data',r=>{r.state.graph.edges[0].trusted=true;}],['bad-kind',r=>{r.state.graph.edges[0].kind='bad kind';}],
 ['reserved-kind',r=>{r.state.graph.edges[0].kind='none';}],['long-label',r=>{r.state.graph.edges[0].label='x'.repeat(121);}],
 ['self-edge',r=>{r.state.graph.edges[0].to=r.state.graph.edges[0].from;}],['unknown-end',r=>{r.state.graph.edges[0].to='absent';}],
 ['duplicate-id',r=>{r.state.graph.edges[1].id=r.state.graph.edges[0].id;}],['v1-with-v2-edges',r=>{r.kind=REQUEST_KIND;}],
])test('typed route rejects malformed input before any provider call / '+name,async()=>{
 const request=structuredClone(prepare(await initial(fixtures[0]),fixtures[0]).request);mutate(request);let calls=0;
 const response=await onRequestPost({request:new Request('https://fixture.invalid/api/judge',{method:'POST',body:JSON.stringify(request)}),available:true},async()=>{calls++;throw new Error('must not call');});
 assert.equal(response.status,422);assert.equal(calls,0);
});
for(const [id,change] of [
 ['low-confidence',p=>{p.answers.edge.confidence=.49;}],['unselected',p=>{p.answers.edge.choice='none';}],
 ['unknown-id',p=>{p.answers.edge.choice='not-an-offer';}],['stale',p=>{p.turn={...p.turn,head:'not-current'};}],
])test('unchanged graph on refused/uncertain edit / '+id,async()=>{
 const p=prepare(await initial(fixtures[0]),fixtures[0]),before=p.working.log;change(p);
 assert.notEqual((await planStep(p)).outcome,'step');assert.equal(p.working.log,before);
});
test('actual duplicate at opposite direction and same kind stays refused',async()=>{
 const f=fixtures[0],other={type:'relation',id:'already',from:'monitor',to:'task',kind:'metrics',label:'other annotation'};
 const p=prepare(await initial(f,[f.edit.initialRecords.find(r=>r.id==='metrics-up'),other]),f);
 assert.equal((await planStep(p)).reason,'reversed-exists');
});
test('v8 does not advertise an impossible same-kind differently labelled parallel line',async()=>{
 const f=fixtures[0],g=await initial(f),bundle={version:'choices',goalSelection:'delta',parts:[],diagrams:[],relations:[{kind:'metrics',label:'Latency'}]};
 const held=legalLocalDeltas(g,{bundle,protocol,expressive:true});
 assert.equal(held.candidates.some(c=>c.from==='task'&&c.to==='monitor'),false);
});
test('fixed reducer boundary: same direction/kind with another annotation cannot coexist',async()=>{
 const f=fixtures[0],g=await initial(f),saved=g.log;
 await assert.rejects(()=>protocol.createDecision(g.head,[{type:'ConnectRegions',relationId:'another-metric',from:'task',to:'monitor',kind:'metrics',label:'Latency'}],g.records));
 assert.equal(g.log,saved);
 // Detecting the boundary is not meeting the user's two-line expectation.
});
test('v8 advertised relation ID cannot collide with a region ID',async()=>{
 const f=fixtures[0],g=await initial(f,[],[{type:'region',id:'voice-task-to-monitor',parent:'container',kind:'step',label:'Reserved ID',summary:'',bounds:[1300,150,160,90]}]);
 const bundle={version:'choices',goalSelection:'delta',parts:[],diagrams:[]};
 const held=legalLocalDeltas(g,{bundle,protocol,expressive:true}),candidate=held.candidates.find(c=>c.from==='task'&&c.to==='monitor');assert.ok(candidate);
 assert.ok(!g.records.some(record=>record.id===candidate.operations[0].relationId),'a legal kernel edge must also remain a unique UI camera target');
 assert.equal((await proveLocalDelta({working:g,held,candidateId:candidate.id,confidence:.9,bundle,protocol,expressive:true})).outcome,'step');
});
