import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runGoal} from '../src/goal.mjs';
import {createSession, undo} from '../src/session.mjs';
import {readBundle} from '../src/bundle.mjs';
import {partResourceView} from '../src/part-description.mjs';
import {quotaGoalBundle} from '../src/completion.mjs';
import {auditReferenceDiagram,referenceChoice} from './reference-diagram-audit.mjs';
const protocol=await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL ?? path.join(process.env.SEMANTIC_MAP,'packages/semantic-map/protocol/index.js')));
const read=name=>fs.readFileSync(new URL('./fixtures/reference-fidelity/'+name+'.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const [input]=read('inputs');
async function execute(){
 const g=await protocol.createDecisionLog(input.initialRecords,'voice-graph');
 const d=await protocol.createDecision(g.head,[{type:'PinRegions',items:input.pins}],g.records);
 const before=(await protocol.appendDecision(g.log,d.decision)).verified;
 const first=createSession({accepted:before,stored:before.log});let current=first;
 const bundle=readBundle(input.bundle);
 const result=await runGoal({utterance:input.text,bundle,protocol,current:()=>current,cancelled:()=>false,
  adopt:async next=>{current=next;},ask:async req=>({kind:'answered',decision:{answers:req.state.candidates?
   {delta:{type:'choice',choice:referenceChoice(req.state,input.syntheticChanges),confidence:1}}
   :{completion:{type:'choice',choice:'unknown',confidence:1}}}})});
 return {before,first,current,result};
}
const uiOf=graph=>({head:graph.head,records:graph.records,view:partResourceView(graph.records)});

test('A sufficient candidates retain both same-named task keys and purposes; no generation',()=>{
 const bundle=readBundle(input.bundle);const result=quotaGoalBundle(bundle,[{label:'Fargate Task',kind:'step',quantity:2}]);
 assert.deepEqual(result.parts,input.bundle.parts);
});
test('B independently fixed reference subset: branches, distinct subnet ownership, identities and Undo',async()=>{
 const r=await execute();const [expected]=read('expected');
 assert.equal(r.result.completion.status,'unknown');assert.equal(r.result.reason,'none');assert.equal(r.result.requests,6);
 for(const [stage,graph] of [['before',r.before],['after',r.current.working],['undo',(await undo(r.current,{verifyDecisionLog:protocol.verifyDecisionLog})).working]]){
  assert.equal((await auditReferenceDiagram({log:graph.log,ui:uiOf(graph),expected,initialRecords:r.before.records,protocol,stage})).status,'PASS');
 }
});
for(const [id,mutate] of [
 ['wrong-task-parent',e=>{e.addedNodes[0].parent='subnet-b';}],
 ['swapped-task-identities',e=>{[e.addedNodes[0].summary,e.addedNodes[1].summary]=[e.addedNodes[1].summary,e.addedNodes[0].summary];}],
 ['wrong-label',e=>{e.addedNodes[0].label='Task';}],
 ['wrong-kind',e=>{e.addedNodes[0].kind='data';}],
 ['missing-task',e=>{e.addedNodes.pop();}],
 ['extra-task',e=>{e.addedNodes.push({...e.addedNodes[0],id:'third'});}],
 ['missing-branch',e=>{e.addedEdges.pop();}],
 ['wrong-direction',e=>{[e.addedEdges[0].from,e.addedEdges[0].to]=[e.addedEdges[0].to,e.addedEdges[0].from];}],
 ['both-branches-to-one-task',e=>{e.addedEdges[1].to=e.addedEdges[0].to;}],
 ['wrong-relation-meaning',e=>{e.addedEdges[0].kind='metrics';}],
 ['lost-annotation',e=>{e.addedEdges[0].label='not-the-requested-label';}],
 ['changed-initial-group',e=>{e.initialNodes.find(n=>n.id==='public').label='Other subnet';}],
])test('B independent reference oracle rejects '+id,async()=>{
 const r=await execute(),[expected]=read('expected');mutate(expected);
 await assert.rejects(()=>auditReferenceDiagram({log:r.current.working.log,ui:uiOf(r.current.working),expected,initialRecords:r.before.records,protocol,stage:'after'}));
});
for(const mode of ['head','records'])test('B refuses stale UI '+mode,async()=>{
 const r=await execute(),[expected]=read('expected'),ui=uiOf(r.current.working);ui[mode]=mode==='head'?r.before.head:r.before.records;
 await assert.rejects(()=>auditReferenceDiagram({log:r.current.working.log,ui,expected,initialRecords:r.before.records,protocol,stage:'after'}));
});
