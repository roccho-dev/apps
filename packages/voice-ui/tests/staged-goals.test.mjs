import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runGoal} from '../src/goal.mjs';
import * as contract from '../src/contract.mjs';
import {questionsFor} from '../src/judgment.mjs';
import {onRequestPost} from '../functions/api/judge.mjs';
import {createSession, undo} from '../src/session.mjs';
import {MAP_ID, STATE_SCHEMA} from '../src/log.mjs';
import {legalLocalDeltas, proveLocalDelta} from '../src/turn.mjs';
const protocolPath=process.env.VOICE_UI_TEST_PROTOCOL ?? path.join(process.env.SEMANTIC_MAP ?? '', 'packages/semantic-map/protocol/index.js');
if (!protocolPath) throw Error('an exact UI protocol is required');
const protocol=await import(pathToFileURL(path.resolve(protocolPath)).href);
const readRows=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const inputs=readRows('./fixtures/staged-diagrams/inputs.jsonl');
const record=row=>{if(process.env.STAGE_EVIDENCE)fs.appendFileSync(process.env.STAGE_EVIDENCE,JSON.stringify(row)+'\n');};
const open=async (empty=false)=>{
 const records=[{type:'meta',schema:STATE_SCHEMA,root:'root',title:'staged-controlled'},
 {type:'region',id:'root',parent:null,label:'World',kind:'boundary',bounds:[0,0,6000,4000],summary:''}];
 if(!empty)records.push({type:'region',id:'container',parent:'root',label:'Cloud',kind:'group',bounds:[0,0,2400,800],summary:''});
 const initial=await protocol.createDecisionLog(records,MAP_ID);
 // Explicit starting geometry is fixture data, never an expected answer or product fallback.
 if(empty)return createSession({accepted:initial,stored:initial.log});
 const d=await protocol.createDecision(initial.head,[{type:'PinRegions',items:[{regionId:'container',bounds:[0,0,2400,800]}]}],initial.records);
 const graph=(await protocol.appendDecision(initial.log,d.decision)).verified;
 return createSession({accepted:graph,stored:graph.log});
};
const response=(name,choice,confidence=1)=>({kind:'answered',decision:{answers:{[name]:{type:'choice',choice,confidence}}}});
const observed=(before,after)=>{
 const labels=new Map(after.records.filter(r=>r.type==='region').map(r=>[r.id,r.label]));
 return {regions:after.records.filter(r=>r.type==='region'&&!before.records.some(b=>b.type==='region'&&b.id===r.id))
  .map(r=>({label:r.label,kind:r.kind,parent:labels.get(r.parent)})),
 edges:after.records.filter(r=>r.type==='relation').map(r=>({from:labels.get(r.from),to:labels.get(r.to),kind:r.kind,label:r.label}))};
};
const canonical=x=>JSON.stringify({regions:x.regions.map(r=>JSON.stringify(r)).sort(),edges:x.edges.map(e=>JSON.stringify(e)).sort()});
globalThis.fetch=async()=>{throw Error('no external networking in controlled tests');};

for(const input of inputs)test('controlled state transition: '+input.id,async()=>{
 const before=await open(input.initial==='empty');let session=before,index=0;const requests=[];
 const bundle={parts:input.parts,diagrams:[],...(input.relations?{relations:input.relations}:{})};
 const result=await runGoal({utterance:input.utterance,bundle,protocol,selection:"delta",current:()=>session,cancelled:()=>false,adopt:async s=>{session=s;index++;},ask:async req=>{
  requests.push(req);assert.equal(contract.isRequest(req),true);
  const slots=req.kind===contract.GOAL_COMPLETION_KIND?contract.goalCompletionSlots():contract.slotsFor(req.state);
  const questions=questionsFor(req.state,slots,{kind:req.kind});
  for(const [name,options]of Object.entries(slots))assert.deepEqual(Object.keys(questions[name].options),options);
  assert.equal(Object.hasOwn(req.state,'expected'),false);
  if(req.kind===contract.GOAL_COMPLETION_KIND)return response('completion','complete');
  const action=input.actions[index];if(!action)return response('delta',contract.NONE);
  const labelId=name=>req.state.graph.find(r=>r.label===name)?.id;
  const chosen=req.state.candidates.find(c=>action.part?c.part===action.part&&c.parent===labelId(action.parent)
   :c.from===labelId(action.from)&&c.to===labelId(action.to)&&(c.kind??'flow')===action.kind&&(c.label??'')===action.label);
  if(!chosen)throw Error('requested transition absent from legal candidates');
  return response('delta',req.state.placing===null&&chosen.part?`part:${chosen.part}`:chosen.id);
 }});
 // Gold is opened only after all synthetic model requests have finished.
 const expected=readRows('./fixtures/staged-diagrams/expected.jsonl').find(r=>r.id===input.id);
 const actual=observed(before.working,session.working);const met=canonical(actual)===canonical(expected);
 record({id:input.id,graph_met:met,requests:result.requests,reason:result.reason,completion:result.completion.status,actual,evidence:'controlled-selector; actual-source-and-protocol; NOT_REAL_MODEL'});
 assert.equal(met,true);assert.equal(result.completion.status,'complete');assert.ok(result.requests<=8);
 assert.equal(session.stored,before.stored);
 assert.deepEqual((await undo(session,{verifyDecisionLog:protocol.verifyDecisionLog})).working.records,before.working.records);
 for(const mutate of [g=>g.regions[0].label='wrong',g=>g.regions[0].kind='wrong',g=>g.regions[0].parent='wrong',g=>g.regions.push({...g.regions[0],label:'extra'})]){
  const bad=structuredClone(actual);mutate(bad);assert.notEqual(canonical(bad),canonical(expected));
 }
 if(actual.edges.length){const bad=structuredClone(actual);[bad.edges[0].from,bad.edges[0].to]=[bad.edges[0].to,bad.edges[0].from];assert.notEqual(canonical(bad),canonical(expected));}
});
for(const mode of ['weak','stale','cancelled','unknown','malformed','late'])test('reject '+mode+' without state update',async()=>{
 const before=await open();let session=before,cancelled=false,time=0;
 const bundle={parts:inputs[0].parts,diagrams:[]};
 const result=await runGoal({utterance:inputs[0].utterance,bundle,protocol,selection:"delta",now:()=>time,current:()=>session,cancelled:()=>cancelled,adopt:async()=>assert.fail('guard adopted'),ask:async req=>{
  if(mode==='stale')session={...session};if(mode==='cancelled')cancelled=true;if(mode==='late')time=180000;
  if(mode==='unknown')throw Error('unknown');if(mode==='malformed')return {};
  return response('delta',req.state.candidates[0].id,mode==='weak'?.49:1);
 }});
 assert.deepEqual(session.working.records,before.working.records);assert.equal(result.completion.status,'unknown');record({id:'guard-'+mode,graph_unchanged:true,status:result.reason});
});
test('root group addition is offered, root leaf addition is not',async()=>{
 const before=await open(true);const bundle={parts:[{key:'g',label:'Cloud',kind:'group',purpose:'one group'},inputs[0].parts[0]],diagrams:[]};
 const held=legalLocalDeltas(before.working,{bundle,protocol,expressive:true});assert.ok(held.candidates.some(c=>c.part==='g'&&c.parent==='root'));assert.equal(held.candidates.some(c=>c.part==='p0'),false);
});
test('relation catalogue is part of latest-state proof',async()=>{
 const initial=await protocol.createDecisionLog([{type:'meta',schema:STATE_SCHEMA,root:'root',title:'r'},
 {type:'region',id:'root',label:'World',kind:'boundary',parent:null,bounds:[0,0,2000,1000],summary:''},
 ...['a','b'].map((id,i)=>({type:'region',id,label:id,kind:'step',parent:'root',bounds:[i*200,0,100,64],summary:''}))],MAP_ID);
 const bundle={parts:[],relations:[{kind:'call',label:'request'}]};const held=legalLocalDeltas(initial,{bundle,protocol,expressive:true});
 const changed={...bundle,relations:[{kind:'flow',label:'other'}]};
 const r=await proveLocalDelta({working:initial,held,candidateId:held.candidates[0].id,confidence:1,bundle:changed,protocol,expressive:true});assert.equal(r.outcome,'refused');
 for(const relations of [[],[{kind:'x',label:'a',extra:1}],[{kind:'x',label:'a'},{kind:'x',label:'a'}]])assert.throws(()=>legalLocalDeltas(initial,{bundle:{parts:[],relations},protocol,expressive:true}));
});

// The server accepts the same explicit v8 contract the client constructs.
test('v8 API: typed context, root boundary, invalid requests and responses',async()=>{
 const before=await open(true);const bundle={parts:[{key:'cloud',label:'Cloud',kind:'group',purpose:'one cloud'}],diagrams:[]};
 let captured;
 await runGoal({utterance:'Cloudという囲みを作る',bundle,protocol,selection:'delta',current:()=>before,cancelled:()=>false,adopt:async()=>assert.fail('no adoption'),ask:async req=>{captured??=req;return response('delta',contract.NONE,.49);}});
 assert.equal(captured.kind,contract.DIRECT_GOAL_REQUEST_KIND);
 assert.equal(captured.state.graph[0].kind,'boundary');assert.equal(captured.state.offers.parts[0].kind,'group');
 const invoke=(value,judge)=>onRequestPost({available:true,request:new Request('http://fixture.invalid/api/judge',{method:'POST',body:JSON.stringify(value)})},judge);
 let calls=0;
 const judge=async()=>{calls++;return{answers:{delta:{choice:captured.state.candidates[0].id,confidence:1}}};};
 assert.equal((await invoke(captured,judge)).status,200);assert.equal(calls,1);
 for(const mutate of [x=>x.state.extra=true,x=>delete x.state.graph[0].kind,x=>x.state.placing=null,x=>x.state.offers.parts[0].kind='step',x=>x.kind=contract.GOAL_REQUEST_KIND]){
  const invalid=structuredClone(captured);mutate(invalid);assert.equal((await invoke(invalid,judge)).status,422);
 }
 assert.equal(calls,1,'invalid requests never reach the model');
 for(const value of [{noul:1},{score:1},{choice:'foreign',confidence:1},{choice:contract.NONE,confidence:NaN}])assert.equal((await invoke(captured,async()=>({answers:{delta:value}}))).status,502);
});
