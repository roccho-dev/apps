import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {validateFrontierInput,frontierSchedule,proposalPolicy,oldInterpretationEligible,readFrontierInspection,gradeInitialPolicy,gradeFrontierGoal,summarizeFrontierAxis,classifyFrontierAxis,normalizeInitialIntent,stockDifference,gradeFullRequired,gradeVerification} from './frontier-cycle-score.mjs';
import * as frozen from './requirements-cycle-score.mjs';
const root=process.env.POC_FRONTIER_PREREG_ROOT??path.dirname(fileURLToPath(import.meta.url)),load=n=>JSON.parse(fs.readFileSync(path.join(root,n)));
const gi=load('frontier-cycle-public-G0-10.inputs.json'),go=load('frontier-cycle-public-G0-10.oracle.json'),ei=load('frontier-cycle-public-E-2.inputs.json'),eo=load('frontier-cycle-public-E-2.oracle.json'),pre=load('frontier-cycle-public-literal-preflight.json'),parts=eo.stock_parts;
const records=o=>[...gi.fixture_contract.base_records,...gi.fixture_contract.fixtures[o.fixture].extra_records];
const factors=(intent='change',ic=.8,complete='incomplete',cc=.8)=>({intent:{choice:intent,confidence:ic},labels:{choice:'missing',confidence:.8},capacity:{choice:'exceeded',confidence:.8},completeness:{choice:complete,confidence:cc}});
const slots=rows=>Object.fromEntries([1,2,3].map((n,i)=>['required'+n,rows[i]?{...rows[i],quantity:String(rows[i].quantity)}:{label:'irrelevant bounded padding',kind:'none',quantity:'2'}]));
const uuid='00000000-0000-4000-8000-000000000000';
function gResponse(o){const literal=structuredClone(pre.G0.find(x=>x.id===o.id)),f=factors(o.expected_intent,.8,o.expected_completeness??'complete');
 const initial={factors:f,literal:{recognized:literal.recognized,required:literal.required,spans:literal.spans},observation:{valid:literal.valid,status:literal.status}};initial.decision=normalizeInitialIntent(initial,o.utterance,parts,records(o));
 return{...initial.decision,inspection:{schema:'voice-ui.parts.inspection/2',request_id:uuid,mode:'literal-v2',initial,proposal:null,verification:null,required:initial.literal.required,missing:stockDifference(initial.literal.required,parts)}};
}
const unchanged=o=>({initial_log:'before\n',final_log:'before\n',initial_head:'before',final_head:'before',initial_records:records(o),final_records:records(o),typellm_sends:0});
function target(o){const out=structuredClone(records(o)),ids=new Map();let n=0;const ref=x=>x.startsWith('fixture:')?x.slice(8):ids.get(x.slice(6));
 for(const r of o.expected_added_regions){const id='new-'+(++n);out.push({type:'region',id,label:r.label,kind:r.kind,parent:ref(r.parent),summary:'',bounds:[n*140,36,120,64]});ids.set(r.label,id);}
 for(const e of o.expected_added_edges)out.push({type:'relation',id:'edge-'+(++n),from:ref(e.from),to:ref(e.to),kind:e.kind,label:e.label});return out;
}
function eObservation(o,candidate,{intent='ambiguous',confidence=.39,complete='incomplete',cc=.96,vIntent='change',vc=.9,vComplete='complete',vcc=.9,parserValid=true}={}){
 const literal={recognized:false,required:[],spans:[]},initial={factors:factors(intent,confidence,complete,cc),literal,observation:{valid:parserValid,status:'unsupported-syntax'}};
 initial.decision=normalizeInitialIntent(initial,o.utterance,parts,records(o));
 const eligible=proposalPolicy(initial.factors).eligible,required=candidate&&eligible?o.required:[];
 const inspection={schema:candidate?'voice-ui.parts.inspection/3':'voice-ui.parts.inspection/2',request_id:uuid,mode:candidate?'adaptive-v3':'literal-v2',initial,
  ...(candidate?{proposal_policy:proposalPolicy(initial.factors)}:{}),proposal:candidate&&eligible?{slots:slots(required),required}:null,verification:candidate&&eligible?factors(vIntent,vc,vComplete,vcc):null,required,missing:stockDifference(required,parts)};
 const choice=vIntent!=='change'?vIntent:vComplete==='complete'&&vcc>=.5?inspection.missing.length?'missing':'sufficient':'unknown';
 const decision=candidate&&eligible?{choice,confidence:choice==='unknown'?null:vIntent!=='change'?vc:Math.min(vc,vcc)}:initial.decision;
 const authorized=candidate&&eligible&&vIntent==='change'&&vComplete==='complete'&&Math.min(vc,vcc)>=.5;
 return{...unchanged(o),inspection,decision,preparations:authorized&&inspection.missing.length?1:0,materialized_missing:authorized?inspection.missing:[],typellm_sends:candidate&&eligible?1:0,elapsedMs:1200,
  ...(authorized?{final_records:target(o),final_log:'after\n',final_head:'after'}:{})};
}
function publicRows(options){return eo.cases.flatMap(o=>['B','C'].map(arm=>({id:o.id,arm,method:arm==='B'?'literal-v2':'adaptive-v3',generation_policy:arm==='B'?null:'dependent',valid_execution:true,grade:gradeFrontierGoal(eObservation(o,arm==='C',options),o,parts),paint_status:'PASS',persisted_raw_equal:true})));}

test('new schema and explicit schedules bind public parents and reject unknown/duplicate arms, sizes and silent aliases',()=>{
 assert.equal(validateFrontierInput(gi),true);assert.equal(frontierSchedule(gi).length,10);assert.equal(frontierSchedule(ei)[1].method,'adaptive-v3');
 for(const change of[x=>x.schema='voice-ui.intent-cycle-input/1',x=>x.cases.pop(),x=>x.cases[0].arms=['G0','G0'],x=>x.cases[0].arms=['C'],x=>x.parent_inputs_sha256=null,x=>x.cases[0].expected='leak']){const bad=structuredClone(gi);change(bad);assert.throws(()=>validateFrontierInput(bad));}
 assert.throws(()=>validateFrontierInput(gi,{phaseKind:'fresh'}));
});
test('full confidence threshold grid preserves hard stops and distinguishes old region from the new frontier',()=>{
 for(const i of ['change','ambiguous','no-change','unsupported'])for(const ic of [0,.49,.5,1])for(const c of ['complete','incomplete'])for(const cc of [.49,.5,1]){
  const f=factors(i,ic,c,cc),got=proposalPolicy(f),eligible=c==='incomplete'&&cc>=.5&&(['change','ambiguous'].includes(i)&&ic<.5||i==='change'&&ic>=.5);
  assert.equal(got.eligible,eligible);assert.equal(got.reason,eligible?i==='change'&&ic>=.5?'confident-change-incomplete':'uncertain-intent-incomplete':null);
  assert.equal(oldInterpretationEligible(f),i==='change'&&ic>=.5&&c==='incomplete'&&cc>=.5);
 }
 for(const f of [null,{}, {...factors(),extra:true}, {...factors(),intent:{choice:'change',confidence:NaN}}])assert.equal(proposalPolicy(f),null);
});
test('G0 taxonomy may remain wrong while the distinct policy gate succeeds; neither label is rewritten',()=>{
 const o=go.cases[0],r=gResponse(o);r.inspection.initial.factors=factors('ambiguous',.39,'incomplete',.96);const normalized=normalizeInitialIntent(r.inspection.initial,o.utterance,parts,records(o));r.inspection.initial.decision=normalized;r.choice=normalized.choice;r.confidence=normalized.confidence;
 const g=gradeInitialPolicy(r,o,parts,unchanged(o));assert.equal(g.contract_valid,true);assert.equal(g.taxonomy_correct,false);assert.equal(g.policy_correct,true);assert.equal(g.old_interpretation_eligible,false);assert.equal(g.new_interpretation_eligible,true);assert.equal(g.frontier_eligible,true);assert.equal(r.choice,'ambiguous');
 for(const o of go.cases)assert.equal(gradeInitialPolicy(gResponse(o),o,parts,unchanged(o)).policy_correct,true,o.id);
});
test('G0 closed normalization, unchanged logs/records/head and Type0 remain mandatory despite matching altered receipts',()=>{
 const o=go.cases[0];for(const mutate of[x=>x.choice='sufficient',x=>{x.choice='sufficient';x.confidence=.8;x.inspection.initial.decision={choice:'sufficient',confidence:.8};},x=>x.inspection.initial.literal.spans.push({})]){const r=gResponse(o);mutate(r);assert.equal(gradeInitialPolicy(r,o,parts,unchanged(o)).contract_valid,false);}
 for(const mutate of[x=>x.typellm_sends=1,x=>x.final_log+='adopted',x=>x.final_head='changed',x=>x.final_records=[]]){const obs=unchanged(o);mutate(obs);assert.equal(gradeInitialPolicy(gResponse(o),o,parts,obs).policy_correct,false);}
});
test('inspection3 is read independently without /2 aliasing and retains actual initial ambiguity plus separate V authorization',()=>{
 const o=eo.cases[0],obs=eObservation(o,true),x=obs.inspection,r=readFrontierInspection(x,o.utterance,parts,obs.initial_records);
 assert.equal(r.eligible,true);assert.equal(r.old_eligible,false);assert.equal(r.frontier_eligible,true);assert.equal(r.value.initial.decision.choice,'ambiguous');assert.equal(r.normalized.choice,'missing');assert.equal(r.verification.accepted,true);
 assert.equal(frozen.readRequirementInspection(x,o.utterance,parts),null);
 for(const mutate of[z=>z.schema='voice-ui.parts.inspection/2',z=>z.mode='adaptive-v2',z=>z.proposal_policy.reason='confident-change-incomplete',z=>z.proposal_policy.eligible=false,z=>z.proposal_policy.extra=true,z=>z.proposal=null,z=>z.initial.decision={choice:'missing',confidence:.8},z=>z.missing=[]]){const bad=structuredClone(x);mutate(bad);assert.equal(readFrontierInspection(bad,o.utterance,parts,obs.initial_records),null);}
});
test('parser observation.valid=false is not an invalid-factor fallback; hard factor and complete cases remain stopped',()=>{
 const o=eo.cases[0],obs=eObservation(o,true,{parserValid:false});assert.equal(readFrontierInspection(obs.inspection,o.utterance,parts,obs.initial_records).eligible,true);
 for(const options of [{intent:'no-change',confidence:.1},{intent:'unsupported',confidence:.1},{intent:'ambiguous',confidence:.5},{complete:'complete'},{cc:.49}]){
  const stopped=eObservation(o,true,options);assert.equal(stopped.typellm_sends,0);assert.equal(stopped.inspection.proposal,null);assert.equal(readFrontierInspection(stopped.inspection,o.utterance,parts,stopped.initial_records).eligible,false);
 }
});
test('rejected or weak V grants no materialization; a true control Type call is still a non-regression failure',()=>{
 const o=eo.cases[0];for(const options of [{vIntent:'ambiguous'},{vc:.49},{vComplete:'incomplete'}]){
  const obs=eObservation(o,true,options),g=gradeFrontierGoal(obs,o,parts);assert.equal(g.contract_valid,true);assert.equal(g.verification_accepted,false);assert.equal(g.graph_exact,false);assert.equal(g.raw_unchanged,true);assert.equal(g.stop_authorization_guard,true);
  obs.preparations=1;obs.materialized_missing=obs.inspection.missing;obs.final_records=target(o);obs.final_log='adopted';obs.final_head='adopted';assert.equal(gradeFrontierGoal(obs,o,parts).stop_authorization_guard,false);
 }
 const control={...o,expected_intent:'ambiguous',expected_gate:'ambiguous',required:[],expected_missing:[],expected_added_regions:[],expected_added_edges:[]},obs=eObservation(control,true,{vIntent:'ambiguous'});
 const g=gradeFrontierGoal(obs,control,parts);assert.equal(g.graph_exact,true);assert.equal(g.non_regression_guards,false);
});
test('new C actual policy path and frozen B path receive the same semantic target/guard/deadline scrutiny',()=>{
 for(const o of eo.cases){const c=gradeFrontierGoal(eObservation(o,true),o,parts),b=gradeFrontierGoal(eObservation(o,false),o,parts);assert.equal(c.contract_valid,true);assert.equal(c.graph_exact,true);assert.equal(c.non_regression_guards,true);assert.equal(c.proposal_policy_implemented,true);assert.equal(b.contract_valid,true);assert.equal(b.graph_exact,false);assert.equal(b.non_regression_guards,true);assert.equal(b.proposal_policy_implemented,false);}
 const o=eo.cases[0],obs=eObservation(o,true);obs.elapsedMs=180001;assert.equal(gradeFrontierGoal(obs,o,parts).deadline,false);
});
test('V/F functions are exact frozen functions; no new policy meaning is applied to their records',()=>{assert.equal(gradeFullRequired,frozen.gradeFullRequired);assert.equal(gradeVerification,frozen.gradeVerification);});
test('G0 full denominator and separate taxonomy cannot be bypassed with missing/invalid/duplicate cells',()=>{
 const rows=go.cases.map(o=>({id:o.id,arm:'G0',method:'literal-v2',generation_policy:null,valid_execution:true,grade:gradeInitialPolicy(gResponse(o),o,parts,unchanged(o))}));assert.equal(summarizeFrontierAxis('G0',rows,go.cases,{phaseKind:'public'}).policy_criteria,'PASS');
 for(const change of[x=>x.pop(),x=>x[0]=x[1],x=>x[0].valid_execution=false,x=>x[0].grade.policy_correct=false,x=>x[0].method='adaptive-v3']){const bad=structuredClone(rows);change(bad);assert.equal(summarizeFrontierAxis('G0',bad,go.cases,{phaseKind:'public'}).policy_criteria,'UNMET');}
});
test('generic two-gain effect and frontier-specific mechanism effect stay distinct with actual eligible tags',()=>{
 const rows=publicRows();let s=summarizeFrontierAxis('E',rows,eo.cases,{phaseKind:'public'});assert.equal(s.effect_criteria,'PASS');assert.equal(s.frontier_missing_gains,2);assert.equal(s.frontier_effect_criteria_pending_integrity,'PASS');
 const old=publicRows({intent:'change',confidence:.9});s=summarizeFrontierAxis('E',old,eo.cases,{phaseKind:'public'});assert.equal(s.effect_criteria,'PASS');assert.equal(s.frontier_missing_gains,0);assert.equal(s.frontier_effect_criteria_pending_integrity,'UNPROVEN');
 for(const change of[x=>x.pop(),x=>x[0].valid_execution=false,x=>x[1].paint_status='UNMET',x=>x[1].persisted_raw_equal=false,x=>x[0].grade.eligible=false,x=>x[1].grade.initial_literal={recognized:false,required:[],spans:[{}]}]){const bad=structuredClone(rows);change(bad);assert.equal(summarizeFrontierAxis('E',bad,eo.cases,{phaseKind:'public'}).effect_criteria,'UNMET');}
});
test('NO_EFFECT needs every registered missing opportunity, complete paint and actual new eligibility, not just zero counted wins',()=>{
 const oracles=Array.from({length:10},(_,i)=>({...eo.cases[0],id:'synthetic-'+i,expected_intent:i>=8?'no-change':'change',expected_gate:i<4?'sufficient':i<8?'missing':'no-change'}));
 const rows=oracles.flatMap(o=>['B','C'].map(arm=>({id:o.id,arm,method:arm==='B'?'literal-v2':'adaptive-v3',generation_policy:arm==='B'?null:'dependent',valid_execution:true,paint_status:'PASS',persisted_raw_equal:true,grade:{contract_valid:true,expected_gate:o.expected_gate,gate_correct:false,graph_exact:false,non_regression_guards:true,no_false_adoption:true,raw_unchanged:true,eligible:true,old_eligible:false,frontier_eligible:true,initial_literal:{recognized:false,required:[],spans:[]}}})));
 assert.equal(summarizeFrontierAxis('E',rows,oracles).no_effect_criteria_pending_integrity,'PASS');assert.equal(summarizeFrontierAxis('E',rows,oracles).frontier_no_effect_criteria_pending_integrity,'PASS');
 for(const change of[x=>x.pop(),x=>x[8].grade.eligible=false,x=>x[8].paint_status='UNPROVEN',x=>x[8].valid_execution=false]){const bad=structuredClone(rows);change(bad);assert.equal(summarizeFrontierAxis('E',bad,oracles).no_effect_criteria_pending_integrity,'UNPROVEN');}
 const old=structuredClone(rows);old[9].grade.old_eligible=true;old[9].grade.frontier_eligible=false;assert.equal(summarizeFrontierAxis('E',old,oracles).no_effect_criteria_pending_integrity,'PASS');assert.equal(summarizeFrontierAxis('E',old,oracles).frontier_no_effect_criteria_pending_integrity,'UNPROVEN');
});
function classified(axis='E'){
 const n=({V:10,F:8,E:20})[axis],rows=Array.from({length:n},(_,i)=>({id:'test-'+Math.floor(i/2),arm:axis==='E'?i%2?'C':'B':axis==='V'?'V':'D',method:axis==='E'?i%2?'adaptive-v3':'literal-v2':axis==='V'?'verify':'full-required',generation_policy:axis==='E'?i%2?'dependent':null:axis==='V'?null:'dependent',valid_execution:true,paint_status:'PASS',persisted_raw_equal:true,goal_elapsedMs:1200,goal_deadline_status:'PASS',grade:{contract_valid:true,expected_gate:i>=8&&i<16?'missing':'sufficient',frontier_eligible:true,old_eligible:false}}));
 const semantic={verification_criteria:'PASS',requirements_criteria:'PASS',enabled_criteria:'PASS',effect_criteria:'PASS',frontier_effect_criteria_pending_integrity:'PASS',frontier_missing_gains:2,missing_gains:2,regressions:0,all_arm_guards:true,no_false_adoption:true,pairs:Array.from({length:10},(_,i)=>({id:'test-'+i,eligible:true}))};
 const raw={schema:'voice-ui.frontier-cycle-raw-audit/1',status:'PASS',axis,phase_kind:'fresh',planned:n,consumed:n,complete:true,all_valid_execution:true,admissible_for_semantic_claim:true,rows,semantic,replay:{status:'PASS',recorded_paint_status:'PASS'}};
 return{phaseKind:'final',axis,binding:{status:'PASS'},phase:{status:'PASS'},raw,ciRaw:structuredClone(raw),ciReplay:{status:'PASS',recorded_paint_status:'PASS'}};
}
test('classification rejects old/synthetic/missing contract or paint proof and separates known unmet from unknown evidence',()=>{
 const args=classified();assert.deepEqual(classifyFrontierAxis(args),{quality:'FINITE_CRITERIA_PASS',effect:'FINITE_EFFECT_DEMONSTRATED',frontier_effect:'FINITE_FRONTIER_EFFECT_DEMONSTRATED'});
 for(const change of[x=>x.binding.status='FAIL',x=>x.raw.schema='voice-ui.intent-cycle-raw-audit/1',x=>x.ciRaw.rows.pop(),x=>x.raw.rows[0].grade.contract_valid=false,x=>x.raw.admissible_for_semantic_claim=false,x=>x.raw.rows[1].method='adaptive-v2',x=>x.ciRaw.semantic.enabled_criteria='UNMET',x=>x.raw.rows[0].paint_status='UNPROVEN',x=>x.ciReplay.status='FAIL',x=>x.raw.rows[0].goal_elapsedMs=null]){const bad=structuredClone(args);change(bad);assert.equal(classifyFrontierAxis(bad).quality,'UNPROVEN');}
 const unmet=structuredClone(args);unmet.raw.semantic.enabled_criteria='UNMET';unmet.ciRaw.semantic.enabled_criteria='UNMET';assert.equal(classifyFrontierAxis(unmet).quality,'UNMET');
 for(const axis of ['V','F']){const a=classified(axis);assert.equal(classifyFrontierAxis(a).quality,'FINITE_CRITERIA_PASS');a.ciRaw.all_valid_execution=false;assert.equal(classifyFrontierAxis(a).quality,'UNPROVEN');}
});
test('classification never promotes generic gains to frontier mechanism effect or zero observed gains to unqualified NO_EFFECT',()=>{
 const args=classified();for(const x of [args.raw,args.ciRaw]){x.semantic.frontier_missing_gains=0;x.semantic.frontier_effect_criteria_pending_integrity='UNPROVEN';}
 assert.equal(classifyFrontierAxis(args).effect,'FINITE_EFFECT_DEMONSTRATED');assert.equal(classifyFrontierAxis(args).frontier_effect,'UNPROVEN');
 for(const x of [args.raw,args.ciRaw]){x.semantic.effect_criteria='UNMET';x.semantic.enabled_criteria='UNMET';x.semantic.missing_gains=0;}
 assert.equal(classifyFrontierAxis(args).effect,'UNPROVEN');
 for(const x of [args.raw,args.ciRaw]){x.semantic.no_effect_criteria_pending_integrity='PASS';x.semantic.frontier_no_effect_criteria_pending_integrity='PASS';}
 assert.equal(classifyFrontierAxis(args).effect,'NO_EFFECT_IN_REGISTERED_MISSING_CASES');assert.equal(classifyFrontierAxis(args).frontier_effect,'NO_EFFECT_IN_REGISTERED_FRONTIER_CASES');
 const bad=structuredClone(args);bad.raw.rows[9].grade.old_eligible=true;bad.ciRaw.rows[9].grade.old_eligible=true;assert.equal(classifyFrontierAxis(bad).frontier_effect,'UNPROVEN');
});
