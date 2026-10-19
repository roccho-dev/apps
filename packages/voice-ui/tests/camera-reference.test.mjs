import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runGoal} from '../src/goal.mjs';
import {readBundle} from '../src/bundle.mjs';
import {createSession,undo,apply} from '../src/session.mjs';
import {commitLog,restoreLog} from '../src/log.mjs';
import {cameraLabels} from '../src/render.mjs';
import {auditReferenceDiagram,referenceChoice} from './reference-diagram-audit.mjs';
const protocol=await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL??path.join(process.env.SEMANTIC_MAP,'packages/semantic-map/protocol/index.js')));
const read=name=>fs.readFileSync(new URL('./fixtures/reference-fidelity/'+name+'.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const [input]=read('inputs').filter(x=>x.cameraDistinct===true),expected=read('expected').find(x=>x.id===input.id);

test('B camera collisions preserve independently expected structure through Goal/Undo/save/reload',async()=>{
 const initial=await protocol.createDecisionLog(input.initialRecords,'voice-graph');
 const pin=await protocol.createDecision(initial.head,[{type:'PinRegions',items:input.pins}],initial.records);
 const before=(await protocol.appendDecision(initial.log,pin.decision)).verified;
 let current=createSession({accepted:before,stored:before.log});
 const run=()=>runGoal({utterance:input.text,bundle:readBundle(input.bundle),protocol,current:()=>current,cancelled:()=>false,
  adopt:async next=>{current=next;},ask:async req=>({kind:'answered',decision:{answers:req.state.candidates?
   {delta:{type:'choice',choice:referenceChoice(req.state,input.syntheticChanges),confidence:1}}:
   {completion:{type:'choice',choice:'unknown',confidence:1}}}})});
 const audit=async(stage,graph)=>{
  await auditReferenceDiagram({log:graph.log,ui:{head:graph.head,records:graph.records,view:{}},expected,initialRecords:before.records,protocol,stage});
  const labels=cameraLabels(graph.records);assert.equal(new Set(labels.values()).size,labels.size);
 };
 await audit('before',before);assert.equal((await run()).completion.status,'unknown');await audit('after',current.working);
 current=await undo(current,{verifyDecisionLog:protocol.verifyDecisionLog});await audit('undo',current.working);
 assert.equal((await run()).completion.status,'unknown');await audit('redo',current.working);
 let stored=before.log;
 const saved=await apply(current,{commit:({graph,expected})=>commitLog({graph,expected,key:'fixture',read:async()=>stored,write:async(_key,v)=>{stored=v;},lock:async(_key,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog})});
 assert.equal(saved.result.status,'committed');await audit('apply',saved.session.working);
 const reread=await restoreLog({key:'fixture',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(reread.status,'restored');await audit('reload',reread.graph);
});
