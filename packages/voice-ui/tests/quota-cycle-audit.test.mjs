import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {auditQuotaRaw,auditQuotaProviderPhase,auditQuotaProducerBinding,auditQuotaReplayJoin,auditQuotaProcess,QUOTA_SOURCE_NAMES,sha256} from './quota-cycle-audit.mjs';
import {quotaSchedule,QUOTA_METHODS,QUOTA_GENERATIONS,QUOTA_GOAL_POLICIES,quotaRepeatProfile} from './quota-cycle-score.mjs';
import {stockDifference,proposalPolicy,normalizeInitialIntent} from './frontier-cycle-score.mjs';
// Only new public cases and marked synthetic receipts; no sealed oracle, fetch or credential read.
const here=path.dirname(fileURLToPath(import.meta.url)),fixtures=process.env.POC_QUOTA_PREREG_ROOT??here;
const source=process.env.POC_SOURCE_ROOT??path.resolve(here,'../../typellm-ci-20261017/packages/voice-ui');
const protocolPath=process.env.POC_PROTOCOL_ENTRY??path.resolve(here,'../../../../ui.git/.worktrees/voice-ui-render-identity-20261017/packages/semantic-map/protocol/index.js');
const protocol=await import(pathToFileURL(protocolPath));
const {runInventoryGoal,quotaGoalBundle}=await import(pathToFileURL(path.join(source,'src/completion.mjs')));
const {runGoal}=await import(pathToFileURL(path.join(source,'src/goal.mjs')));
const {createSession,apply}=await import(pathToFileURL(path.join(source,'src/session.mjs')));
const {commitLog,restoreLog}=await import(pathToFileURL(path.join(source,'src/log.mjs')));
const {readBundle}=await import(pathToFileURL(path.join(source,'src/bundle.mjs')));
const {assessPaintedGoal:assessGoal,assessPaintedEdge:assessEdge}=await import(pathToFileURL(path.join(source,'tests/painted-goal.mjs')));
const bundleBytes=fs.readFileSync(path.join(source,'web/data/bundle.v1.json')),bundleValue=JSON.parse(bundleBytes),bundle=readBundle(bundleValue);
const enc=x=>Buffer.from(JSON.stringify(x,null,2)+'\n'),json=b=>JSON.parse(Buffer.from(b).toString('utf8'));
const lines=rs=>rs.length?Buffer.from(rs.map(r=>JSON.stringify(r)).join('\n')+'\n'):Buffer.alloc(0);
const jsonLines=b=>Buffer.from(b).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const factors=(completeness='complete',intent='change',confidence=.9)=>({intent:{choice:intent,confidence},labels:{choice:'missing',confidence},capacity:{choice:'within',confidence},completeness:{choice:completeness,confidence}});
const slots=required=>Object.fromEntries([1,2,3].map((n,i)=>['required'+n,required[i]?{...required[i],quantity:String(required[i].quantity)}:{label:'unused bounded padding',kind:'none',quantity:'0'}]));
function framesFor(records){
 const regions=records.filter(r=>r.type==='region'),groups=regions.filter(r=>r.kind==='group'&&r.parent!==null);
 const text=box=>({box,clips:[],svg:[0,0,2000,1000],unmet:null});
 return[{camera:'overview'},...groups.map(group=>{
  const observation={identity:true,association:'render-owned-semantic-id',complete:true,contained:true,nonoverlap:true,viewport:[0,0,2000,1000],
   container:{id:group.id,bounds:[0,0,2000,1000]},title:text([10,10,100,16]),edge:null,
   shapes:regions.filter(r=>r.parent===group.id).map((r,i)=>({id:r.id,rawLabel:r.label,bounds:[10+i*200,50,140,70],name:text([20+i*200,70,100,16])}))};
  return{camera:group.id,observation,assessment:assessGoal(observation)};
 })];
}
async function synthetic(axis,{openExtra=false}={}){
 const prefix='quota-cycle-public-'+axis+'-1',projectionBytes=fs.readFileSync(path.join(fixtures,prefix+'.v2.inputs.json')),
  oracleBytes=fs.readFileSync(path.join(fixtures,prefix+'.v2.oracle.json')),input=json(projectionBytes),oracle=json(oracleBytes),rawFiles={},summary=[],events=[],stdout=[];
 let tick=0,seq=0;const event=e=>events.push({at:new Date(Date.UTC(2026,9,18)+tick++).toISOString(),...e});
 for(const p of quotaSchedule(input)){
  const item=input.cases.find(c=>c.id===p.id),o=oracle.cases.find(c=>c.id===p.id),f=input.fixture_contract,sub=f.fixtures[item.fixture];
  const made=await protocol.createDecisionLog([...f.base_records,...sub.extra_records],f.map_id),pin=await protocol.createDecision(made.head,[{type:'PinRegions',items:[...f.base_pins,...sub.extra_pins]}],made.records);
  const graph=(await protocol.appendDecision(made.log,pin.decision)).verified,calls=[];let session=createSession({accepted:graph,stored:graph.log});
  event({kind:'cell-start',...p,initial_head:graph.head,initial_log_sha256:sha256(graph.log)});
  const post=(route,request,response)=>{
   const call={id:p.id,arm:p.arm,n:calls.length+1,route,request,status:200,response,elapsedMs:1,
    ...(axis==='E'?{upstream_route:route==='/api/parts/check'?route+'?method='+p.method:route}:{})};
   calls.push(call);event({kind:'http-start',axis,method:p.method,id:p.id,arm:p.arm,n:call.n,route,request,...(axis==='E'?{upstream_route:call.upstream_route}:{})});
   event({kind:'http-end',id:p.id,arm:p.arm,n:call.n,status:200,response,elapsedMs:1});return response;
  };
  const ask=async request=>{
   const state=request.state,oldIds=new Set(graph.records.map(r=>r.id)),added=session.working.records.filter(r=>r.type==='region'&&!oldIds.has(r.id));
   const next=o.required.find(r=>added.filter(a=>a.label===r.label&&a.kind===r.kind).length<r.quantity);
   const label=next?.label??(openExtra&&p.arm==='O'&&!added.some(r=>r.label==='判断')?'判断':null);
   const candidate=label&&state.candidates.find(c=>c.action==='add-part'&&c.parent==='container'&&state.offers.parts.find(a=>a.key===c.part)?.label===label);
   const choice=!candidate?'none':state.placing===null?'part:'+candidate.part:candidate.id;
   const response=post('/api/judge',request,{kind:'voice-ui.judge.decision.v1',answers:{delta:{type:'choice',choice,confidence:.9}}});
   return{kind:'answered',decision:response};
  };
  let result;
  if(axis==='R'){
   const supplied=readBundle({...bundleValue,parts:item.parts}),goalBundle=p.arm==='O'?supplied:quotaGoalBundle(supplied,item.required);
   result=await runGoal({utterance:item.utterance,bundle:goalBundle,protocol,current:()=>session,cancelled:()=>false,adopt:async next=>{session=next;},ask});
  }else{
   const request_id='00000000-0000-4000-8000-'+String(++seq).padStart(12,'0');
   const initial={factors:{...factors('incomplete'),intent:{choice:'ambiguous',confidence:.39}},literal:{recognized:false,required:[],spans:[]},observation:{valid:true,status:'unsupported-syntax'}};
   initial.decision=normalizeInitialIntent(initial,item.utterance,bundle.parts,graph.records);
   const enabled=p.arm==='C',required=enabled?o.required:[],missing=stockDifference(required,bundle.parts),proposal=enabled?{slots:slots(required),required}:null,verification=enabled?factors():null;
   const stage=(name,fields)=>stdout.push({kind:enabled?'voice-ui.parts.stage.v3':'voice-ui.parts.stage.v2',request_id,stage:name,...fields,...(name==='G0'&&enabled?{proposal_policy:proposalPolicy(initial.factors)}:{}),...(name==='TYPE_REQUIRED'?{generation:'dependent'}:{})});
   stage('G0',{valid:true,initial});if(enabled){stage('TYPE_REQUIRED',{valid:true,proposal});stage('VERIFY_REQUIRED',{valid:true,required,factors:verification});}
   const decision=enabled?{choice:missing.length?'missing':'sufficient',confidence:.9}:initial.decision;
   stage('STOCK_DIFF',{required,missing,decision});
   const inspection={schema:enabled?'voice-ui.parts.inspection/3':'voice-ui.parts.inspection/2',request_id,mode:p.method,initial,...(enabled?{proposal_policy:proposalPolicy(initial.factors)}:{}),proposal,verification,required,missing};
   result=await runInventoryGoal({utterance:item.utterance,bundle,protocol,current:()=>session,cancelled:()=>false,adopt:async next=>{session=next;},
    check:request=>post('/api/parts/check',request,{...decision,inspection}),complete:()=>assert.fail('no second completion'),ask});
  }
  const working=session.working,target={log:working.log,records:working.records,stored:graph.log,goal:result},applyEnabled=session.draft.length>0;
  let stored=graph.log;
  const applied=await apply(session,{commit:({graph:value,expected})=>commitLog({graph:value,expected,key:'synthetic',read:async()=>stored,write:async(_key,value)=>{stored=value;},lock:async(_key,action)=>action(),verifyDecisionLog:protocol.verifyDecisionLog})});
  const restored=await restoreLog({key:'synthetic',read:async()=>stored,verifyDecisionLog:protocol.verifyDecisionLog}),reloaded=createSession({accepted:restored.graph,stored});
  const snap=s=>({log:s.working.log,records:s.working.records,stored:s.stored,goal:result});
  const lifecycle={target,applied:snap(applied.session),reloaded:snap(reloaded),apply_enabled:applyEnabled,persistence:'PASS',
   ...(axis==='R'?{scope:'NATIVE_SESSION_APPLY_RESTORE_NOT_BROWSER_GOAL',browser_restore:{target:{...target,stored:working.log,goal:null},applied:{...target,stored:working.log,goal:null},reloaded:{...target,stored:working.log,goal:null},apply_enabled:false,persistence:'PASS',scope:'KEYLESS_COMPLETED_UI_RESTORE_NOT_BROWSER_GOAL'}}:{undo:'separate keyless mechanics'})};
  const row={schema:'voice-ui.quota-cycle-cell/1',...p,supplied_required:axis==='R'?item.required:null,replay_suffix_scope:'compatibility only',fixture:item.fixture,utterance:item.utterance,
   parts:axis==='R'?item.parts:bundle.parts,valid_execution:true,elapsedMs:25,result,calls,initial_head:graph.head,initial_log:graph.log,initial_log_sha256:sha256(graph.log),initial_records:graph.records,
   final_head:working.head,final_log:working.log,final_records:working.records,frames:framesFor(working.records),lifecycle};
  rawFiles[p.id+'-'+p.arm+'.json']=enc(row);summary.push({...p,valid_execution:true,calls:calls.length});event({kind:'cell-end',...summary.at(-1),final_head:working.head});
 }
 rawFiles['identity.json']=enc({schema:'voice-ui.quota-cycle-execution/1',axis,source:{scope:'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE'},inputs_sha256:sha256(projectionBytes),bundle_sha256:sha256(bundleBytes),
  source_sha256:Object.fromEntries(QUOTA_SOURCE_NAMES.map(n=>[n,'0'.repeat(64)])),case_order:input.cases.map(c=>c.id),arm_order:quotaSchedule(input).map(({id,arm})=>({id,arm})),methods:QUOTA_METHODS,generation_policies:QUOTA_GENERATIONS,goal_parts_policies:QUOTA_GOAL_POLICIES});
 rawFiles['execution.json']=enc({schema:'voice-ui.quota-cycle-phase/1',axis,status:'RECORDED',summary,invalid_cells:0,expected_cells:summary.length});rawFiles['events.jsonl']=lines(events);
 return{projectionBytes,oracleBytes,rawFiles,bundleBytes,protocol,stdoutBytes:lines(stdout),assessGoal,assessEdge};
}
function edit(a,name,fn){const v=json(a.rawFiles[name]);fn(v);a.rawFiles[name]=enc(v);}
function editEvents(a,fn){const es=jsonLines(a.rawFiles['events.jsonl']);fn(es);a.rawFiles['events.jsonl']=lines(es);}
function editStages(a,fn){const s=jsonLines(a.stdoutBytes);fn(s);a.stdoutBytes=lines(s);}
function synchronize(a,row){
 a.rawFiles[row.id+'-'+row.arm+'.json']=enc(row);
 editEvents(a,es=>{
  for(let i=es.length-1;i>=0;i--)if(es[i].id===row.id&&es[i].arm===row.arm&&['http-start','http-end'].includes(es[i].kind)&&es[i].n>row.calls.length)es.splice(i,1);
  for(const c of row.calls){const s=es.find(e=>e.kind==='http-start'&&e.id===row.id&&e.arm===row.arm&&e.n===c.n),e=es.find(e=>e.kind==='http-end'&&e.id===row.id&&e.arm===row.arm&&e.n===c.n);
   if(s){s.request=c.request;s.route=c.route;if(c.upstream_route)s.upstream_route=c.upstream_route;}
   if(e){delete e.response;delete e.error;Object.assign(e,{status:c.status,elapsedMs:c.elapsedMs,...Object.hasOwn(c,'response')?{response:c.response}:{},...c.error?{error:c.error}:{}});}}
  const end=es.find(e=>e.kind==='cell-end'&&e.id===row.id&&e.arm===row.arm);Object.assign(end,{valid_execution:row.valid_execution,calls:row.calls.length,final_head:row.final_head});
 });
 edit(a,'execution.json',e=>{const s=e.summary.find(s=>s.id===row.id&&s.arm===row.arm);Object.assign(s,{valid_execution:row.valid_execution,calls:row.calls.length});e.invalid_cells=e.summary.filter(s=>!s.valid_execution).length;e.status=e.invalid_cells?'INVALID':'RECORDED';});
}
const refuse=async a=>{try{return(await auditQuotaRaw(a)).status!=='PASS';}catch{return true;}};
function addReplay(a,mutate=()=>{}){
 a.artifactManifestBytes=enc({sources:{apps:'a'.repeat(40),ui:'b'.repeat(40)}});const rows=[],failures=[];
 for(const[n,b]of Object.entries(a.rawFiles))if(/-[OQBC][.]json$/u.test(n)){
  const raw=json(b),frames=framesFor(raw.final_records);mutate(frames,raw);
  for(const f of frames.slice(1)){f.assessment=assessGoal(f.observation);if(f.assessment.status!=='PASS')failures.push({id:raw.id,arm:raw.arm,camera:f.camera,assessment:f.assessment});}
  rows.push({id:raw.id,arm:raw.arm,raw_sha256:sha256(b),log_sha256:sha256(raw.final_log),frames});
 }
 a.replayBytes=enc({schema:'voice-ui.closed-live-log-browser/1',scope:'KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY',ci_live_execution:'UNPROVEN',viewport:[1280,720],deviceScaleFactor:1,
  artifact_manifest_sha256:sha256(a.artifactManifestBytes),artifact_sources:json(a.artifactManifestBytes).sources,rows,failures,status:failures.length?'UNMET':'PASS'});return a;
}
test('public native R and ordinary E use actual source Goal, independently graded offers, stages and retained synthetic scope',async()=>{
 for(const axis of['R','E']){const a=addReplay(await synthetic(axis)),r=await auditQuotaRaw(a);assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.equal(r.complete,true);assert.equal(r.consumed,2);assert.equal(r.semantic.public_gate,'PASS');assert.equal(r.admissible_for_semantic_claim,false);assert.ok(r.rows.every(x=>x.paint_status==='PASS'&&x.persisted_raw_equal));
  assert.equal(r.external_provider_attempts.typellm,axis==='R'?0:1);assert.equal(r.replay.consumed,2);assert.equal(r.proofs.length,2);}
});
test('legal open extra stock adoption is retained as an outcome rather than filtered out of R admission',async()=>{
 const r=await auditQuotaRaw(addReplay(await synthetic('R',{openExtra:true})));assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.equal(r.semantic.open_correct,0);assert.equal(r.semantic.quota_correct,1);assert.equal(r.semantic.admitted_pairs,1);assert.equal(r.semantic.extra_adoptions_fixed,1);assert.equal(r.semantic.public_gate,'PASS');assert.equal(r.rows.find(x=>x.arm==='O').grade.contract_valid,true);assert.equal(r.rows.find(x=>x.arm==='O').grade.no_false_adoption,false);
});
test('exact source28, O/Q schedule, full supplied requirements, stock and null parents reject coordinated substitutes',async()=>{
 for(const change of[a=>edit(a,'identity.json',r=>{delete r.source_sha256['tests/quota-cycle-audit.mjs'];}),a=>edit(a,'identity.json',r=>{r.goal_parts_policies.Q='open';}),a=>edit(a,'execution.json',r=>{r.summary.reverse();}),a=>edit(a,'PR01-Q.json',r=>{r.supplied_required=[];}),a=>edit(a,'PR01-Q.json',r=>{r.parts.reverse();}),a=>{a.rawFiles['PR01-B.json']=a.rawFiles['PR01-Q.json'];delete a.rawFiles['PR01-Q.json'];},a=>{a.parentProjectionBytes=a.projectionBytes;},a=>{a.phaseKind='fresh';}]){const a=await synthetic('R');change(a);assert.equal(await refuse(a),true);}
});
test('quota offerings and adopted deltas cannot be forged even when all call and event copies agree',async()=>{
 for(const change of[r=>{r.calls[0].request.state.offers.parts.push({key:'decision',purpose:'extra',label:'判断'});},r=>{r.calls[0].request.state.offers.parts[0].label='forged';},r=>{r.calls[0].request.kind='voice-ui.judge.other';},r=>{r.calls[0].request.state.parents=[];},r=>{r.calls[0].request.state.target_oracle={extra:'forbidden'};},r=>{r.calls[0].request.state.candidates[0].part='unoffered';},r=>{r.result.selected[0].key='decision';},r=>{r.result.selected[0].parent='other';},r=>{r.result.trace[1].head=r.final_head;},r=>{r.calls[1].response.answers.delta.confidence=.49;r.result.trace[1].answers.delta.confidence=.49;}]){const a=await synthetic('R'),r=json(a.rawFiles['PR01-Q.json']);change(r);r.lifecycle.target.goal=r.result;synchronize(a,r);assert.equal(await refuse(a),true);}
});
test('R native commit/restore and completed-browser restore are separately required; apply/no-op scope cannot be relabeled',async()=>{
 for(const change of[r=>{delete r.lifecycle.browser_restore;},r=>{r.lifecycle.scope='ORDINARY_BROWSER_GOAL';},r=>{r.lifecycle.reloaded.stored+=' ';},r=>{r.lifecycle.browser_restore.reloaded.records=[];},r=>{r.lifecycle.browser_restore.apply_enabled=true;},r=>{r.lifecycle.browser_restore.scope='NATIVE_SESSION_APPLY_RESTORE_NOT_BROWSER_GOAL';}]){const a=await synthetic('R'),r=json(a.rawFiles['PR01-Q.json']);change(r);synchronize(a,r);assert.equal(await refuse(a),true);}
});
test('both actual and replay paint preserve real O/Q names, labels and individual failures without global cell poisoning',async()=>{
 const a=addReplay(await synthetic('R'),(frames,r)=>{if(r.arm==='Q')frames[1].observation.title.box=[-1,-1,100,16];}),r=await auditQuotaRaw(a);
 assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.equal(r.replay.recorded_paint_status,'UNMET');assert.equal(r.rows.find(x=>x.arm==='Q').paint_status,'UNMET');assert.equal(r.rows.find(x=>x.arm==='O').paint_status,'PASS');assert.equal(r.semantic.public_gate,'UNMET');
 for(const change of[x=>{x.rows[1].arm='B';},x=>{x.rows[0].raw_sha256='0'.repeat(64);},x=>{x.rows[0].frames[1].observation.shapes[0].rawLabel='not the log label';},x=>{x.rows[0].frames=[{camera:'overview'}];}]){const b={...a},v=json(b.replayBytes);change(v);b.replayBytes=enc(v);let rejected;try{rejected=auditQuotaReplayJoin(b).status!=='PASS';}catch{rejected=true;}assert.equal(rejected,true);}
});
test('E /3 authorization, Type dependent policy, independent normalization and full-required quota are joined without changing old meanings',async()=>{
 for(const change of[a=>{const r=json(a.rawFiles['PE01-C.json']);r.calls[0].upstream_route='/api/parts/check?method=literal-v2';synchronize(a,r);},a=>editStages(a,s=>{s.find(x=>x.stage==='TYPE_REQUIRED').generation='independent';}),a=>editStages(a,s=>{s.find(x=>x.kind.endsWith('v3')&&x.stage==='G0').proposal_policy.eligible=false;}),a=>{const r=json(a.rawFiles['PE01-C.json']);r.calls[1].request.state.offers.parts.push({key:'decision',label:'判断',purpose:'extra unused stock'});synchronize(a,r);},a=>{const r=json(a.rawFiles['PE01-C.json']);r.result.inventory.completions=1;synchronize(a,r);}]){const a=await synthetic('E');change(a);assert.equal(await refuse(a),true);}
 const a=await synthetic('E'),r=json(a.rawFiles['PE01-C.json']),id=r.calls[0].response.inspection.request_id;
 const changed={choice:'sufficient',confidence:.9};r.calls[0].response.inspection.initial.decision=changed;r.result.inventory.coverage=r.calls[0].response;r.lifecycle.target.goal=r.result;synchronize(a,r);
 editStages(a,s=>{s.find(x=>x.request_id===id&&x.stage==='G0').initial.decision=changed;});assert.equal(await refuse(a),true);
});
test('Goal deadline is recorded independently of full-cell browser time and unknown elapsed cannot promote finite criteria',async()=>{
 const a=await synthetic('R'),r=json(a.rawFiles['PR01-Q.json']);r.elapsedMs=900000;r.result.elapsedMs=180001;r.lifecycle.target.goal=r.result;synchronize(a,r);
 const out=await auditQuotaRaw(a);assert.equal(out.status,'PASS',JSON.stringify(out.issues));const q=out.rows.find(x=>x.arm==='Q');assert.equal(q.goal_deadline_status,'UNMET');assert.equal(q.cell_wall_elapsedMs,900000);assert.equal(out.semantic.public_gate,'UNMET');
});
test('closed HTTP failures keep terminal data and full denominator but never become valid evidence or NO_EFFECT',async()=>{
 for(const axis of['R','E']){const a=await synthetic(axis),name=axis==='R'?'PR01-Q.json':'PE01-C.json',r=json(a.rawFiles[name]),c=r.calls[0],requestId=c.response.inspection?.request_id;
  c.status=503;c.response={error:'parts_unavailable'};c.error='http_or_contract_unknown';r.calls=[c];r.valid_execution=false;r.final_log=r.initial_log;r.final_head=r.initial_head;r.final_records=r.initial_records;r.frames=framesFor(r.final_records);r.lifecycle=null;
  r.result={reason:axis==='R'?'judge-unknown':'inventory-unknown',requests:1,elapsedMs:3,selected:[],trace:axis==='R'?[{head:r.initial_head,answers:null,failure:'judge-unknown'}]:[],...(axis==='E'?{inventory:{checks:1,completions:0,preparations:0,coverage:null,missing:[]}}:{})};
  synchronize(a,r);if(requestId)editStages(a,s=>{for(let i=s.length-1;i>=0;i--)if(s[i].request_id===requestId)s.splice(i,1);});
  const out=await auditQuotaRaw(a);assert.equal(out.status,'PASS',JSON.stringify(out.issues));assert.equal(out.complete,true);assert.equal(out.all_valid_execution,false);assert.equal(out.admissible_for_semantic_claim,false);assert.equal(out.semantic.no_effect_criteria_pending_integrity,'UNPROVEN');
  editEvents(a,es=>{es.find(e=>e.kind==='http-end'&&e.arm===r.arm).response={error:'invented'};});assert.equal(await refuse(a),true);
 }
});

function stoppedFixture(input_sha256='f'.repeat(64)){
 const heads=Object.fromEntries(['apps','ops','envs','windows','ui'].map((n,i)=>[n,String(i+1).repeat(40)]));
 const config={phase_id:'synthetic-quota-R',stage:'public',axis:'R',case_count:1,heads,input_sha256,program:'/nix/store/test-launcher/bin/dev',allowances:{jev:16,typellm:0}},configBytes=enc(config);
 const process={phase_id:config.phase_id,heads,program:config.program,allowances:config.allowances,pid:1234,pgid:1234,start_ticks:'5678',config_sha256:sha256(configBytes)};
 const stderrBytes=Buffer.from(Array.from({length:7},(_,i)=>'provider-send:jev:'+(i+1)).join('\n')+'\n'),stdoutBytes=Buffer.from('stopped\n'),j=[];let charged={jev:0,typellm:0};
 for(const[i,sent]of[{jev:300,typellm:40},{jev:300,typellm:18},{jev:208,typellm:27}].entries()){
  j.push({kind:'phase-reserve',id:'history-'+i,allowances:sent,prior_charged:{...charged}},{kind:'phase-reconcile',id:'history-'+i,sent});charged={jev:charged.jev+sent.jev,typellm:charged.typellm+sent.typellm};}
 j.push({kind:'phase-reserve',id:config.phase_id,allowances:config.allowances,prior_charged:charged,config_sha256:sha256(configBytes),heads,program:config.program},
  {kind:'phase-reconcile',id:config.phase_id,sent:{jev:7,typellm:0},pid:process.pid,start_ticks:process.start_ticks,stopped_group_empty:true,stdout_sha256:sha256(stdoutBytes),stderr_sha256:sha256(stderrBytes)});
 return{configBytes,processBytes:enc(process),stdoutBytes,stderrBytes,journalBytes:lines(j)};
}
const phaseAudit=a=>auditQuotaProviderPhase(a,{jev:{min:6,max:8},typellm:0},{axis:'R',caseCount:1});
test('stopped phase matches real provider sequence, conservative whole baseline, caps, PID and finally reconciliation',()=>{
 const r=phaseAudit(stoppedFixture());assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.deepEqual(r.prior_charged,{jev:808,typellm:85});assert.deepEqual(r.charged_at_cutoff,{jev:815,typellm:85});assert.deepEqual(r.cycle_remaining,{jev:174,typellm:7});
 for(const change of[a=>{a.stderrBytes=Buffer.from('provider-send:jev:2\n');},a=>{a.stdoutBytes=Buffer.concat([a.stdoutBytes,Buffer.from('late')]);},a=>{const j=jsonLines(a.journalBytes);j.at(-1).stopped_group_empty=false;a.journalBytes=lines(j);},a=>{const c=json(a.configBytes);c.allowances.jev=17;a.configBytes=enc(c);},a=>{const p=json(a.processBytes);p.pgid++;a.processBytes=enc(p);},a=>{const j=jsonLines(a.journalBytes);j.splice(-1,0,j.at(-2));a.journalBytes=lines(j);},a=>{const j=jsonLines(a.journalBytes);j.at(-1).sent.jev=6;a.journalBytes=lines(j);}]){
  const a=stoppedFixture();change(a);let refused;try{refused=phaseAudit(a).status!=='PASS';}catch{refused=true;}assert.equal(refused,true);}
 assert.throws(()=>auditQuotaProviderPhase(stoppedFixture(),{jev:7,typellm:0},{axis:'R',caseCount:1,phaseKind:'final'}));
 assert.throws(()=>auditQuotaProviderPhase(stoppedFixture(),{jev:7,typellm:0},{axis:'F',caseCount:1}));
});
async function producerFixture(){
 const a=await synthetic('R'),bytes=stoppedFixture(sha256(a.projectionBytes)),config=json(bytes.configBytes),process=json(bytes.processBytes);
 const workerBytes=Buffer.from('completed worker bytes\n'),providerBytes=Buffer.from('admitted provider bytes\n'),protocolEntryBytes=Buffer.from('immutable protocol entry\n');
 const artifactManifestBytes=enc({sources:{apps:config.heads.apps,ui:config.heads.ui,'jev-provider':{entry_sha256:sha256(providerBytes)}}});
 const runtime={apps_sha:config.heads.apps,worker:{path:'/nix/store/worker/worker.mjs',sha256:sha256(workerBytes)},manifest:{sha256:sha256(artifactManifestBytes)},artifact_root:'/nix/store/dist',provider:{path:'/nix/store/provider/batch.mjs',sha256:sha256(providerBytes)},semantic_map:{root:'/nix/store/semantic',protocol:{sha256:sha256(protocolEntryBytes)}},dev_program:{path:'/nix/store/dev/bin/dev'}};
 const runtimeAuditBytes=enc(runtime),identity=json(a.rawFiles['identity.json']),sourceFiles=Object.fromEntries(QUOTA_SOURCE_NAMES.map(n=>[n,Buffer.from('test built bytes for '+n)]));
 identity.source_sha256=Object.fromEntries(Object.entries(sourceFiles).map(([n,b])=>[n,sha256(b)]));
 identity.source={schema:'voice-ui.poc.runtime/1',heads:config.heads,audit_sha256:sha256(runtimeAuditBytes),worker_entry:runtime.worker,provider_entry:runtime.provider,artifact:{root:runtime.artifact_root,manifest_sha256:runtime.manifest.sha256},semantic_map:{root:runtime.semantic_map.root,protocol_sha256:runtime.semantic_map.protocol.sha256},launcher:{phase_id:config.phase_id,pid:process.pid,start_ticks:process.start_ticks,allowances:config.allowances,dev_program:runtime.dev_program.path,program:config.program}};
 a.rawFiles['identity.json']=enc(identity);const auditReferences={'independent-zero-stop-source.json':enc({scope:'synthetic testimony only'})};
 const args={...bytes,identityBytes:a.rawFiles['identity.json'],runtimeAuditBytes,artifactManifestBytes,workerBytes,providerBytes,protocolEntryBytes,bundleBytes:a.bundleBytes,sourceFiles,auditReferences,rawFiles:a.rawFiles,replayBytes:null};
 const producer={schema:'voice-ui.quota-cycle-producer/1',axis:'R',arm_order:identity.arm_order,generation_policies:QUOTA_GENERATIONS,goal_parts_policies:QUOTA_GOAL_POLICIES,heads:config.heads,inputs_sha256:identity.inputs_sha256,phase_id:config.phase_id,bundle_sha256:sha256(a.bundleBytes),parent_inputs_sha256:null,replay_sha256:null,source_sha256:identity.source_sha256,raw_sha256:Object.fromEntries(Object.entries(a.rawFiles).map(([n,b])=>[n,sha256(b)])),independent_audit_sha256:Object.fromEntries(Object.entries(auditReferences).map(([n,b])=>[n,sha256(b)]))};
 for(const[n,b]of Object.entries({raw_identity_sha256:args.identityBytes,runtime_audit_sha256:runtimeAuditBytes,config_sha256:args.configBytes,process_sha256:args.processBytes,artifact_manifest_sha256:artifactManifestBytes,worker_sha256:workerBytes,provider_sha256:providerBytes,protocol_sha256:protocolEntryBytes,stdout_sha256:args.stdoutBytes,stderr_sha256:args.stderrBytes,journal_sha256:args.journalBytes}))producer[n]=sha256(b);
 return{args,producer};
}
test('R-authored fixed producer binds every actual28 source byte, runtime tuple, whole raw inventory and physical audit references',async()=>{
 const{args,producer}=await producerFixture();assert.equal(auditQuotaProducerBinding(args,producer).status,'PASS');
 for(const change of[a=>{a.workerBytes=Buffer.from('wrong worker');},a=>{a.providerBytes=Buffer.from('wrong provider');},a=>{a.protocolEntryBytes=Buffer.from('wrong protocol');},a=>{delete a.sourceFiles['tests/quota-cycle-audit.mjs'];},a=>{a.sourceFiles['src/completion.mjs']=Buffer.from('wrong implementation');},a=>{a.rawFiles['PR01-Q.json']=Buffer.concat([a.rawFiles['PR01-Q.json'],Buffer.from(' ')]);},a=>{a.auditReferences['independent-zero-stop-source.json']=enc({changed:true});},a=>{a.replayBytes=enc({invented:true});}]){const a=structuredClone(args);change(a);assert.equal(auditQuotaProducerBinding(a,producer).status,'FAIL');}
});
test('coordinated synthetic marker, launch identity, policy and input changes cannot be laundered into admitted producer testimony',async()=>{
 for(const change of[i=>{i.source.scope='SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE';},i=>{i.source.provider_entry.scope='bundled provider with synthetic fetch only';},i=>{i.source.launcher.start_ticks++;},i=>{i.goal_parts_policies.Q='open';},i=>{i.inputs_sha256='8'.repeat(64);}]){const{args,producer}=await producerFixture(),id=json(args.identityBytes);change(id);args.identityBytes=enc(id);args.rawFiles['identity.json']=args.identityBytes;producer.raw_identity_sha256=sha256(args.identityBytes);producer.raw_sha256['identity.json']=sha256(args.identityBytes);assert.equal(auditQuotaProducerBinding(args,producer).status,'FAIL');}
});
const baselinePath=process.env.POC_QUOTA_OLD_JOURNAL??path.resolve(source,'../../docs/voice-ui/frontier-cycle-20261018/evidence/final-E/frontier-final-E-20261018.journal.jsonl');
function processFixture(count=0,repeatProfile=null){
 const repeat=quotaRepeatProfile(repeatProfile),compact=repeat?.verification_prerequisite,
  commitmentBytes=fs.readFileSync(path.join(fixtures,compact?'verifier-cycle-commitment.json':repeat?'quota-cycle-typed-commitment.json':'quota-cycle-commitment.v2.json')),
  freezeBytes=fs.readFileSync(path.join(fixtures,compact?'verifier-cycle-public-freeze.json':repeat?'quota-cycle-typed-public-freeze.json':'quota-cycle-public-freeze.v2.json')),commitment=json(commitmentBytes),freeze=json(freezeBytes);
 const publicFiles=Object.fromEntries(freeze.copy_allowlist.map(r=>[r.name,fs.readFileSync(path.join(fixtures,r.name))])),
  base=fs.readFileSync(compact?path.resolve(source,'../../docs/voice-ui/quota-cycle-20261018/evidence/typed-repeat/public-E/quota-typed-public-E-20261018.journal.jsonl')
    :repeat?path.resolve(source,'../../docs/voice-ui/extraction-cycle-20261018/thinking-labels/evidence/fresh-D/journal.jsonl'):baselinePath);
 assert.equal(sha256(base),repeat?.baseline_journal_sha256??'ce6896e0b1eb7c3c749b659b36e3ed4467dc133042ace81dd990b9f2e10c28d4');
 const records=[],tail=[],charged={...commitment.charged_prior},head='a'.repeat(40),pubR=repeat?null:json(fs.readFileSync(path.join(fixtures,'quota-cycle-public-R-1.v2.inputs.json'))),
  pubE=json(fs.readFileSync(path.join(fixtures,repeat?'quota-cycle-typed-public-E-1.inputs.json':'quota-cycle-public-E-1.v2.inputs.json'))),
  pubV=compact?json(fs.readFileSync(path.join(fixtures,'verifier-cycle-public-V-6.inputs.json'))):null;
 for(const st of commitment.stages.slice(0,count)){
  const kind=st.id.startsWith('public')?'public':'final',stamp=commitment.files.find(r=>r.axis===st.axis&&r.visibility===(kind==='public'?'public':'sealed'));
  // Public geometry plus synthetic stage identifiers; hidden case payloads are never read.
  const input=structuredClone(st.axis==='V'?pubV:st.axis==='R'?pubR:pubE);input.oracle_sha256=stamp.oracle.sha256;
  if(kind==='final')input.cases=Array.from({length:st.cases},(_,i)=>({...structuredClone(input.cases[0]),id:'SYN'+i,utterance:'synthetic graph-only case '+i,arms:st.axis==='R'?(i%2===0?['O','Q']:['Q','O']):(i%2===0?['B','C']:['C','B'])}));
  const config={...(repeat?{repeat_profile:repeat.id}:{}),phase_id:repeat?st.phase_id:'synthetic-'+st.id,stage:kind,axis:st.axis,case_count:st.cases,heads:{apps:head},input_sha256:stamp.input.sha256,allowances:{jev:st.jev,typellm:st.typellm}},prior={...charged};charged.jev+=st.jev;charged.typellm+=st.typellm;
  const report={binding:{status:'PASS'},phase:{status:'PASS',phase:config.phase_id,prior_charged:prior,charged_at_cutoff:{...charged},sent:{jev:st.jev,typellm:st.typellm}},raw:{status:'PASS',complete:true,planned:st.cells,consumed:st.cells,all_valid_execution:kind==='public',inputs_sha256:stamp.input.sha256,parent_inputs_sha256:null,parent_oracle_sha256:null,semantic:{public_gate:kind==='public'?'PASS':null,quality_criteria:'UNMET',effect_criteria:'UNMET'}}};
  if(st.axis==='V')Object.assign(report.raw,{axis:'V',admissible_for_semantic_claim:true,
   rows:Array.from({length:6},()=>({grade:{contract_valid:true,correct:true}})),
   semantic:{total:6,correct:6,false_acceptance:0,verification_criteria:'PASS'}});
  records.push({index:{id:st.id,axis:st.axis,phase_kind:kind,apps_sha:head},config,input,report});tail.push({kind:'phase-reserve',id:config.phase_id,prior_charged:prior,allowances:config.allowances},{kind:'phase-reconcile',id:config.phase_id,sent:report.phase.sent});
 }
 return{records,journalBytes:Buffer.concat([base,lines(tail)]),commitmentBytes,freezeBytes,publicFiles,repeatProfile};
}
test('versioned public lineage and exact baseline admit only four bounded stages; complete fresh failures do not become quality interlocks',()=>{
 const empty=auditQuotaProcess(processFixture());assert.equal(empty.status,'PASS',JSON.stringify(empty.issues));assert.equal(empty.state,'NOT_MEASURED');assert.deepEqual(empty.charged_at_cutoff,{jev:808,typellm:85});
 const r=auditQuotaProcess(processFixture(4));assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.equal(r.releases.length,2);assert.ok(r.releases.every(x=>x.admitted&&x.prior_fresh_quality_required===false));assert.deepEqual(r.charged_at_cutoff,{jev:989,typellm:92});assert.deepEqual(r.reserved,{jev:181,typellm:7});
});
test('failed same-head public gates, changed source, missing raw, unindexed retries and silent eleven-Jev transfer reject release',()=>{
 const reject=a=>{try{return auditQuotaProcess(a).status!=='PASS';}catch{return true;}};
 for(const change of[a=>{a.records[0].report.raw.semantic.public_gate='UNMET';},a=>{a.records[1].report.raw.semantic.public_gate='UNMET';},a=>{a.records[2].report.raw.complete=false;},a=>{a.records[2].report.binding.status='FAIL';},a=>{a.records[3].index.apps_sha='b'.repeat(40);},a=>{a.records[0].config.correction_batch=1;},a=>{a.records[0].config.allowances.jev=17;},a=>{a.journalBytes=Buffer.concat([a.journalBytes,lines([{kind:'phase-reserve',id:'unindexed',allowances:{jev:1,typellm:0}}])]);},a=>{a.publicFiles['quota-cycle-prelive-map-addendum.v2.json']=enc({erased:true});},a=>{a.records[2].report.raw.parent_inputs_sha256='0'.repeat(64);}]){const a=processFixture(4);change(a);assert.equal(reject(a),true);}
});
test('the new registered E-only repeat keeps its own two stages, unopened payloads and 133J/7T boundary',()=>{
 const name='typed-ordinary-E-20261018',empty=auditQuotaProcess(processFixture(0,name));
 assert.equal(empty.status,'PASS',JSON.stringify(empty.issues));assert.equal(empty.state,'NOT_MEASURED');assert.deepEqual(empty.charged_at_cutoff,{jev:847,typellm:136});
 const full=auditQuotaProcess(processFixture(2,name));assert.equal(full.status,'PASS',JSON.stringify(full.issues));
 assert.equal(full.releases.length,1);assert.deepEqual(full.reserved,{jev:133,typellm:7});assert.deepEqual(full.charged_at_cutoff,{jev:980,typellm:143});
 assert.throws(()=>quotaRepeatProfile('invented-repeat'));
 const reject=a=>{try{return auditQuotaProcess(a).status!=='PASS';}catch{return true;}};
 for(const change of[a=>{a.records[0].report.raw.semantic.public_gate='UNMET';},a=>{delete a.records[0].config.repeat_profile;},
  a=>{a.records[1].config.phase_id='unregistered-retry';},a=>{a.records[0].config.allowances.jev=20;},
  a=>{a.repeatProfile=null;},a=>{a.journalBytes=Buffer.concat([a.journalBytes,lines([{kind:'phase-reserve',id:'extra',allowances:{jev:1,typellm:0}}])]);}]){
  const a=processFixture(2,name);change(a);assert.equal(reject(a),true);
 }
});
test('a new-profile source/config cannot drop the matching producer profile to bypass Type supply binding',async()=>{
 const{args,producer}=await producerFixture(),id=json(args.identityBytes),config=json(args.configBytes);
 id.source.repeat_profile=config.repeat_profile='typed-ordinary-E-20261018';args.identityBytes=enc(id);args.rawFiles['identity.json']=args.identityBytes;args.configBytes=enc(config);
 producer.raw_identity_sha256=sha256(args.identityBytes);producer.config_sha256=sha256(args.configBytes);producer.raw_sha256['identity.json']=sha256(args.identityBytes);
 const result=auditQuotaProducerBinding(args,producer);assert.equal(result.status,'FAIL');assert.ok(result.issues.includes('producer/config/source repeat identity'));
});

test('compact V prerequisite precedes same-head E gates and cannot spend the unallocated eleven Jev calls',()=>{
 const name='compact-verifier-VE-20261018',empty=auditQuotaProcess(processFixture(0,name));
 assert.equal(empty.status,'PASS',JSON.stringify(empty.issues));assert.equal(empty.state,'NOT_MEASURED');
 assert.deepEqual(empty.charged_at_cutoff,{jev:850,typellm:137});
 const stoppedV=processFixture(1,name);stoppedV.records[0].report.raw.semantic.verification_criteria='UNMET';
 assert.equal(auditQuotaProcess(stoppedV).status,'PASS','retained V quality failure is evidence, not an invalid receipt');
 const full=auditQuotaProcess(processFixture(3,name));assert.equal(full.status,'PASS',JSON.stringify(full.issues));
 assert.deepEqual(full.reserved,{jev:139,typellm:7});assert.deepEqual(full.charged_at_cutoff,{jev:989,typellm:144});
 assert.equal(full.releases.length,1);assert.equal(full.releases[0].admitted,true);
 const reject=a=>{try{return auditQuotaProcess(a).status!=='PASS';}catch{return true;}};
 for(const change of[
  a=>{a.records[0].report.raw.semantic.verification_criteria='UNMET';},
  a=>{a.records[0].report.raw.semantic.false_acceptance=1;},
  a=>{a.records[0].report.raw.rows[0].grade.correct=false;},
  a=>{a.records[0].report.raw.admissible_for_semantic_claim=false;},
  a=>{a.records[0].report.raw.all_valid_execution=false;},
  a=>{a.records[0].report.raw.planned=5;},
  a=>{a.records[1].report.raw.semantic.public_gate='UNMET';},
  a=>{a.records[1].config.phase_id='quota-typed-public-E-20261018';},
  a=>{a.records[0].config.allowances.jev=7;},
  a=>{a.records[2].index.apps_sha='b'.repeat(40);},
  a=>{a.records.shift();},
  a=>{a.repeatProfile='typed-ordinary-E-20261018';}
 ]){const a=processFixture(3,name);change(a);assert.equal(reject(a),true);}
});
