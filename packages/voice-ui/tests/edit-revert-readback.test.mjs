import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL,fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('..',import.meta.url));
const source=process.env.VOICE_UI_SOURCE_DIR??path.join(here,'src');
const load=file=>import(pathToFileURL(path.join(source,file)).href);
const {revertStep,appendStep,requestFor}=await load('turn.mjs');
const {createSession,propose,appendRevert,undo,apply}=await load('session.mjs');
const {commitLog,restoreLog}=await load('log.mjs');
const {drawGraph}=await load('render.mjs');
const {isRequest}=await load('contract.mjs');
const protocolPath=process.env.VOICE_UI_TEST_PROTOCOL??path.join(process.env.SEMANTIC_MAP??'','packages/semantic-map/protocol/index.js');
const protocol=await import(pathToFileURL(path.resolve(protocolPath)).href);
// These are mechanical edits of valid stored logs. No inference or browser
// painting is simulated as success. Existing UI reducer/protocol is unchanged.
globalThis.fetch=async()=>{throw new Error('network forbidden in edit mechanics');};
const baseRecords=[
 {type:'meta',schema:'semantic-map-state/1',root:'root',title:'Independent edit expectations'},
 {type:'region',id:'root',parent:null,label:'World',kind:'boundary',bounds:[0,0,2400,1400],summary:''},
 {type:'region',id:'group',parent:'root',label:'OCI',kind:'group',bounds:[0,0,1200,900],summary:''},
 ...['a','b','c'].map((id,i)=>({type:'region',id,parent:'group',label:id.toUpperCase(),kind:i===1?'data':'step',bounds:[10+i*220,80,160,80],summary:''}))
];
const sorted=records=>records.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort();
const append=async(g,operations)=>operations.length?(await protocol.appendDecision(g.log,(await protocol.createDecision(g.head,operations,g.records)).decision)).verified:g;
const emit=row=>{if(process.env.EDIT_EVIDENCE)fs.appendFileSync(process.env.EDIT_EVIDENCE,JSON.stringify(row)+'\n');};
const cases=fs.readFileSync(new URL('./fixtures/edit-readback/cases.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const expectedRecords=changes=>{
 const records=structuredClone(baseRecords);
 for(const row of changes){
  if(row.kind==='rename')records.find(x=>x.id===row.id).label=row.label;
  else if(row.kind==='edge')records.push(row.record);
  else if(row.kind==='pin')records.push({type:'layout',regionId:row.id,pin:'hard',bounds:row.bounds});
  else assert.fail('unknown expected record descriptor');
 }
 return records;
};
// Real log/envelope/readback, injected drawing port and memory-only store.
// Neither is an actual browser/paint or production storage acceptance.
const inspect=async graph=>{
 const mount={style:{},children:[]};
 mount.append=element=>{element.parent=mount;mount.children.push(element);};
 mount.replaceChildren=()=>{mount.children=[];};
 const document={defaultView:{getComputedStyle:()=>({position:'relative'})},createElement:()=>{
  const element={style:{}};element.remove=()=>{mount.children=mount.children.filter(x=>x!==element);};return element;
 }};
 let observed=null;
 await drawGraph({graph,frame:null,mount,document,protocol,renderProjection:async({input})=>{observed=await protocol.inspectEnvelope(input.envelope);}});
 assert.equal(observed.base.head,graph.head);assert.deepEqual(observed.base.records,graph.records);
 const reduced=await protocol.verifyDecisionLog(graph.log);assert.equal(reduced.head,graph.head);assert.deepEqual(reduced.records,graph.records);
 return {head:graph.head,records:graph.records,view:observed.view};
};
for(const c of cases)test('B saved-entry inverse / '+c.id,async()=>{
 const seed=await protocol.createDecisionLog(baseRecords,'voice-graph');
 const before=await append(seed,c.setup),after=await append(before,c.target),working=await append(after,c.later);
 const savedInput=working.log;
 const result=await revertStep({before:before.records,after:after.records,working,protocol});
 const observed=result.outcome;
 emit({id:c.id,source,expected:c.expect,observed,reason:result.reason??null,live_calls:0,paint:'NOT_RUN'});
 assert.equal(result.outcome,c.expect,'fixed edit acceptance must not erase later user changes');
 if(c.expect==='refused'){
  assert.equal(working.log,savedInput);assert.equal(result.step,undefined);
  await inspect(working);return;
 }
 const session=createSession({accepted:working,stored:working.log});
 const proposed=await appendRevert(session,{step:result.step,protocol});
 assert.equal(proposed.result.outcome,'step');
 const wanted=expectedRecords(c.expected);
 assert.deepEqual(sorted(proposed.session.working.records),sorted(wanted),'full independent expected structure');
 const stages=[await inspect(working),await inspect(proposed.session.working)];
 const back=await undo(proposed.session,{verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(back.working.log,working.log);stages.push(await inspect(back.working));
 let stored=working.log;
 const applied=await apply(proposed.session,{commit:({graph,expected})=>commitLog({graph,expected,key:'fixture',read:async()=>stored,write:async(_key,v)=>{stored=v;},lock:async(_key,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog})});
 assert.equal(applied.result.status,'committed');stages.push(await inspect(applied.session.working));
 const restored=await restoreLog({key:'fixture',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(restored.status,'restored');assert.deepEqual(sorted(restored.graph.records),sorted(wanted));stages.push(await inspect(restored.graph));
 emit({id:c.id,stages:['before','revert','undo','apply','reload'],checks:5,log_readback:'PASS',independent_expected:'PASS',paint:'NOT_RUN',live_calls:0});
});
const edge={type:'ConnectRegions',relationId:'ab',from:'a',to:'b',kind:'request',label:'HTTP'};
for(const action of ['remove-edge','reverse-edge'])test('B ordinary typed/voice shared editing path / '+action,async()=>{
 const seed=await protocol.createDecisionLog(baseRecords,'voice-graph'),working=await append(seed,[edge]);
 const session=createSession({accepted:working,stored:working.log}),bundle={version:'empty',parts:[],diagrams:[]};
 const {turn,request}=requestFor({working,utterance:action+' A B',bundle,layout:null,offeredFrame:null,draft:[],focus:null,pending:null,recent:[]});
 assert.equal(isRequest(request),true);
 const answers=Object.fromEntries(Object.entries(turn.slots).map(([slot])=>[slot,{type:'choice',choice:slot==='action'?action:slot==='edge'?'ab':'none',confidence:1}]));
 const changed=await propose(session,{turn,answers,protocol,bundle,layout:null,visibleFrame:null,input:{source:'typed',text:request.state.utterance},repair:null});
 assert.equal(changed.result.outcome,'step');
 const wanted=action==='remove-edge'?[]:[{type:'relation',id:'voice-b-to-a',from:'b',to:'a',kind:'request',label:'HTTP'}];
 assert.deepEqual(sorted(changed.session.working.records),sorted([...baseRecords,...wanted]));
 const direct=await appendStep({working,step:changed.result.step,protocol});assert.equal(direct.outcome,'step');
 await inspect(changed.session.working);
 assert.equal((await undo(changed.session,{verifyDecisionLog:protocol.verifyDecisionLog})).working.log,working.log);
});
