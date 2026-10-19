import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

// One revision only. The optional artifact mode reopens that revision's own
// modules, UI and compiled Worker, rather than joining two different Workers.
const artifact = process.env.VOICE_UI_COMPOSED_ARTIFACT;
const local = fileURLToPath(new URL('..', import.meta.url));
const moduleAt = rel => artifact ? path.join(artifact, rel.startsWith('src/') ? 'site/app/'+rel : 'site/'+rel.replace(/^web\//,'')) : path.join(local,rel);
const load = rel => import(pathToFileURL(moduleAt(rel)).href);
const {runInventoryGoal,readRequirementInspection,readLiteralInspection} = await load('src/completion.mjs');
const {readBundle} = await load('src/bundle.mjs');
const {createSession,undo,apply} = await load('src/session.mjs');
const {MAP_ID,STATE_SCHEMA,commitLog,restoreLog} = await load('src/log.mjs');
const {drawGraph} = await load('src/render.mjs');
const {createCompletion} = await load('web/adapters/completion.mjs');
const protocolFile = artifact ? path.join(artifact,'site/ui/semantic-map/protocol/index.js') : process.env.VOICE_UI_TEST_PROTOCOL ?? path.join(process.env.SEMANTIC_MAP ?? '', 'packages/semantic-map/protocol/index.js');
const protocol = await import(pathToFileURL(path.resolve(protocolFile)).href);
const worker = artifact ? (await import(pathToFileURL(path.join(artifact,'worker/worker.mjs')).href)).default : null;
const handlers = artifact ? null : {parts:(await import('../functions/api/parts.mjs')).onRequirements,judge:(await import('../functions/api/judge.mjs')).onRequestPost};
const fixture = name => fs.readFileSync(new URL('./fixtures/normal-composition/'+name+'.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const emit = row => { if(process.env.COMPOSITION_EVIDENCE)fs.appendFileSync(process.env.COMPOSITION_EVIDENCE,JSON.stringify(row)+'\n'); };
const symbol = {href:'/assets/sql.svg',alt:'SQL',provenanceRef:'catalog:sql:v1'};
const stockPart = (label,index,kind='step') => ({key:'stock-'+index,label,kind,purpose:'one '+label});
const sorted = rows => rows.map(row=>JSON.stringify(row)).sort();
const describe = graph => {
 const labels = new Map(graph.records.filter(r=>r.type==='region').map(r=>[r.id,r.label]));
 return {regions:sorted(graph.records.filter(r=>r.type==='region'&&r.parent!==null).map(r=>[r.label,r.kind,labels.get(r.parent)])),
  edges:sorted(graph.records.filter(r=>r.type==='relation').map(r=>[labels.get(r.from),labels.get(r.to),r.kind,r.label]))};
};
const seed = async empty => {
 const graph = await protocol.createDecisionLog([{type:'meta',schema:STATE_SCHEMA,root:'root',title:'controlled normal composition'},
  {type:'region',id:'root',parent:null,label:'World',kind:'boundary',bounds:empty?[0,0,720,260]:[0,0,6000,4000],summary:''},
  ...empty?[]:[{type:'region',id:'cloud',parent:'root',label:'Cloud',kind:'group',bounds:[0,0,2400,1200],summary:''}]], MAP_ID);
 if(empty)return createSession({accepted:graph,stored:graph.log});
 const decision = await protocol.createDecision(graph.head,[{type:'PinRegions',items:[{regionId:'cloud',bounds:[0,0,2400,1200]}]}],graph.records);
 const prepared = (await protocol.appendDecision(graph.log,decision.decision)).verified;
 return createSession({accepted:prepared,stored:prepared.log});
};
// This is a projection-port double, NOT a browser, SVG paint or Atlas review.
const documentDouble = () => ({defaultView:{getComputedStyle:()=>({position:'relative'})},createElement(){return {style:{},remove(){this.parent.children=this.parent.children.filter(x=>x!==this);}};}});
const mountDouble = () => ({style:{},children:[],append(child){child.parent=this;this.children.push(child);},replaceChildren(){this.children=[];}});

async function exercise(input, mutation=null) {
 const before = await seed(input.initial==='empty');let session=before,adoptions=0;
 const counters={app:0,jev:0,typellm:0,projection_port:0};const envelopes=[];let lastReceipt=null,lastInput=null;
 const raw = {schema:'voice-ui.bundle/2',version:'controlled-normal-composition',parts:input.stock.map((p,i)=>({...stockPart(p.label,i,p.kind),...(p.symbol?{symbol}:{}),...(p.purpose?{purpose:p.purpose}:{})})),diagrams:[],relations:input.relations??[{kind:'flow',label:''}]};
 const bundle = readBundle(raw);const original=JSON.stringify(bundle);
 const normalizeState = req => typeof req.context==='string'?JSON.parse(req.context):req.state??req.context;
 const answer = req => {
  counters.jev++;const s=normalizeState(req), answers={};
  for(const name of Object.keys(req.questions)) {
   let choice={intent:'change',labels:'missing',capacity:'within',completeness:input.interpreted&&s.literal?'incomplete':'complete',completion:'complete'}[name]??'none';
   if(name==='delta'){
    const action=input.actions[adoptions], id=label=>s.graph.find(r=>r.label===label)?.id;
    const part=action?.label?s.offers.parts.find(p=>p.label===action.label&&(!action.kind||p.kind===action.kind)&&!s.selected.some(x=>x.key===p.key)):null;
    const selected=action?s.candidates.find(c=>part?c.part===part.key&&c.parent===id(action.parent)
     :!action.label&&c.from===id(action.from)&&c.to===id(action.to)&&c.kind===action.kind&&c.label===action.text):null;
    choice=selected?.id??'none';
   }
   answers[name]={choice,confidence:1};
  }
  return {answers};
 };
 const generate = req => {
  counters.typellm++;assert.equal(Object.keys(req.questions).length,48);
  const rows=input.typeRows??[];
  return {result:Object.fromEntries(Array.from({length:16},(_,i)=>Object.entries(rows[i]??{label:'',kind:'none',quantity:0}).map(([k,v])=>['required'+(i+1)+'_'+k,String(v)])).flat())};
 };
 const priorFetch=globalThis.fetch;
 globalThis.fetch=async (url,init)=>{
  const wire=JSON.parse(init.body);
  if(!wire.questions)throw Error('unexpected external request');
  if(Object.values(wire.questions).some(q=>q.type==='string'))return Response.json({status:'completed',...generate(wire)});
  const result=answer(wire);
  return Response.json({model:'synthetic-only',answers:Object.fromEntries(Object.entries(result.answers).map(([name,a])=>[name,{type:'choice',...a,probabilities:Object.fromEntries(Object.keys(wire.questions[name].criteria).map(k=>[k,k===a.choice?1:0]))}]))});
 };
 const requestFor = (url,body) => new Request('https://voice-ui.invalid'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const invoke = async (url,body) => {
  counters.app++;const request=requestFor(url,body);
  if(worker)return worker.fetch(request,{JEV_API_KEY:'synthetic-not-a-real-key',TYPELLM_API_KEY:'synthetic-not-a-real-key',ASSETS:{fetch:()=>{throw Error('unexpected asset request');}}});
  return url==='/api/judge'?handlers.judge({request,available:true},async req=>answer(req))
   :handlers.parts({request,available:true,mode:'check',method:'adaptive-v3'},{judge:async req=>answer(req),generate:async req=>generate(req)});
 };
 const completion=createCompletion({fetchImpl:async (url,init)=>{
  const body=JSON.parse(init.body);lastInput=body;
  const response=await invoke(url,body);if(!response.ok)return response;
  const value=await response.json();lastReceipt=value;
  if(mutation==='forged-head')value.inspection.input.head='wrong';
  if(mutation==='stale')session={...session};
  return Response.json(value);
 }});
 let result;
 try {result=await runInventoryGoal({utterance:input.utterance,bundle,protocol,current:()=>session,cancelled:()=>false,
  check:completion.check,complete:async()=>assert.fail('validated receipt must supply exact missing rows'),
  ask:async body=>{const response=await invoke('/api/judge',body);return response.ok?{kind:'answered',decision:await response.json()}:{kind:'failed',reason:'judge-failed'};},
  adopt:async next=>{
   await drawGraph({graph:next.working,frame:null,mount:mountDouble(),document:documentDouble(),protocol,
    renderProjection:async ({input:projected})=>{
     const inspected=await protocol.inspectEnvelope(projected.envelope);
     assert.equal(inspected.base.head,next.working.head);assert.deepEqual(inspected.base.records,next.working.records);
     counters.projection_port++;envelopes.push(projected.envelope);
    }});
   session=next;adoptions++;
  }});}finally{globalThis.fetch=priorFetch;}
 assert.equal(JSON.stringify(bundle),original,'input catalogue unchanged');
 return {before,session,result,counters,envelopes,lastReceipt,lastInput};
}

for(const input of fixture('inputs'))test('normal source/Worker composition: '+input.id,async()=>{
 const run=await exercise(input);
 // The independent expected data are not an input to any model or port.
 // The same test author supplied both files: this is not an independent reviewer.
 const gold=fixture('expected').find(x=>x.id===input.id);
 const supplied=run.result.inventory.prepared??[];
 const actual={regions:describe(run.session.working).regions,edges:describe(run.session.working).edges};
 const wanted={regions:sorted(gold.regions),edges:sorted(gold.edges)};
 const supply=sorted(supplied.map(p=>[p.label,p.kind]));
 emit({id:input.id,artifact:artifact??null,source_supply:JSON.stringify(supply)===JSON.stringify(sorted(gold.supply)),state_match:JSON.stringify(actual)===JSON.stringify(wanted),
  counters:run.counters,reason:run.result.reason,completion:run.result.completion?.status??'unknown',actual,live_api_calls:0,paint:'NOT_RUN',microphone:'NOT_RUN'});
 assert.deepEqual(supply,sorted(gold.supply),'candidate names/kinds/quantities');
 assert.equal(new Set(supplied.map(p=>p.key)).size,supplied.length,'instance IDs must be unique');
 assert.deepEqual(actual,wanted,'whole state, not the model complete answer');
 assert.equal(run.result.completion.status,'complete');
 assert.equal(run.result.inventory.preparations,gold.preparations);assert.equal(run.counters.typellm,gold.typellm);
 assert.equal(run.counters.projection_port,input.actions.length);
 assert.equal(run.session.stored,run.before.stored);
 assert.ok(run.before.working.records.every(old=>run.session.working.records.some(row=>JSON.stringify(row)===JSON.stringify(old))),'pre-existing records remain unchanged');
 for(let i=0;i<input.stock.length;i++)assert.ok(supplied.some(p=>p.key==='stock-'+i),'existing instance identity retained');
 assert.ok(readRequirementInspection(run.lastReceipt.inspection,run.lastInput.state,readLiteralInspection));
 assert.deepEqual((await undo(run.session,{verifyDecisionLog:protocol.verifyDecisionLog})).working.records,run.before.working.records);
 // Actual persistence core and reread with a memory port, not browser storage.
 let stored=run.before.stored;
 const saved=await apply(run.session,{commit:({graph,expected})=>commitLog({graph,expected,key:'fixture',read:async()=>stored,write:async(_key,value)=>{stored=value;},lock:async(_key,fn)=>fn(),verifyDecisionLog:protocol.verifyDecisionLog})});
 assert.equal(saved.result.status,'committed');
 const restored=await restoreLog({key:'fixture',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog});
 assert.equal(restored.status,'restored');assert.deepEqual(restored.graph.records,run.session.working.records);
 for(const change of [x=>x.regions.pop(),x=>x.regions.push('["extra","step","Cloud"]'),x=>x.regions[0]='["wrong","data","World"]']){
  const bad=structuredClone(actual);change(bad);assert.notDeepEqual(bad,wanted);
 }
 if(input.id==='repeated-symbol')assert.ok(supplied.every(p=>JSON.stringify(p.symbol)===JSON.stringify(symbol)),'known symbol retained for every prepared instance');
});
for(const mutation of ['forged-head','stale'])test('normal preparation refuses '+mutation,async()=>{
 const run=await exercise(fixture('inputs')[0],mutation);
 assert.deepEqual(run.session.working.records,run.before.working.records);assert.equal(run.counters.projection_port,0);
 assert.equal(run.result.reason,mutation==='stale'?'stale-goal':'inventory-contract');
});
test('bundle/2 accepts empty stock and supplied symbols, legacy remains strict',()=>{
 const raw={schema:'voice-ui.bundle/2',version:'test',parts:[],diagrams:[]};assert.deepEqual(readBundle(raw).parts,[]);
 assert.equal(readBundle({...raw,schema:'voice-ui.bundle/1'}).parts,null);
 const p={...stockPart('SQL',0,'data'),symbol};assert.deepEqual(readBundle({...raw,parts:[p]}).parts,[p]);
 assert.equal(readBundle({...raw,schema:'voice-ui.bundle/1',parts:[p]}).parts,null);
 assert.equal(readBundle({...raw,parts:[{...p,symbol:{...symbol,href:'https://untrusted.invalid/sql.svg'}}]}).parts,null);
});

test('false complete over an unparsed nested request cannot authorize changes',async()=>{
 const input={...fixture('inputs').find(x=>x.id==='empty-nested'),interpreted:false};
 const run=await exercise(input);assert.equal(run.result.reason,'inventory-unresolved');
 assert.deepEqual(run.session.working.records,run.before.working.records);assert.equal(run.counters.projection_port,0);
});
