// Public examples and synthetic counterfactuals only. No private pool reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateQuotaInput,quotaSchedule,validateQuotaOracle,referenceQuota,gradeQuotaReady,gradeQuotaOrdinary,summarizeQuotaAxis,classifyQuotaAxis} from './quota-cycle-score.mjs';
import {gradeFrontierGoal} from './frontier-cycle-score.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),fixtures=process.env.POC_QUOTA_PREREG_ROOT??here;
const read=n=>JSON.parse(fs.readFileSync(path.join(fixtures,n))),clone=x=>structuredClone(x);
const rInput=read('quota-cycle-public-R-1.v2.inputs.json'),rOracle=read('quota-cycle-public-R-1.v2.oracle.json'),eInput=read('quota-cycle-public-E-1.v2.inputs.json'),eOracle=read('quota-cycle-public-E-1.v2.oracle.json');
const rc=rOracle.cases[0],ec=eOracle.cases[0];
const initial=o=>[...rInput.fixture_contract.base_records,...rInput.fixture_contract.fixtures[o.fixture].extra_records];
function target(o,extra=false){return[...initial(o),...o.expected_added_regions.map((r,i)=>({type:'region',id:'synthetic-target-'+i,parent:r.parent.slice(8),label:r.label,kind:r.kind,summary:'',bounds:[0,0,100,60]})),...(extra?[{type:'region',id:'synthetic-extra',parent:'container',label:'判断',kind:'decision',summary:'',bounds:[0,0,100,60]}]:[])];}
function rrow(id,arm,{extra=false,correct=true,valid=true,paint='PASS'}={}){
 const o={...rc,id},policy=arm==='O'?'open':'quota',parts=policy==='open'?o.parts:referenceQuota(o.parts,o.required),wanted=parts.find(p=>p.label===o.required[0].label&&p.kind===o.required[0].kind);
 const value={parts:o.parts,supplied_required:o.required,goal_parts_policy:policy,goal_offers:[parts.map(({key,purpose,label})=>({key,purpose,label}))],selected:correct?[{key:wanted.key,region:'synthetic-target-0',parent:'container'},...(extra?[{key:'decision',region:'synthetic-extra',parent:'container'}]:[])]:[],quota_proof_valid:true,initial_log:'synthetic-initial-'+id,initial_records:initial(o),final_records:correct?target(o,extra):initial(o),elapsedMs:100};
 return{id,arm,method:arm==='O'?'ready-open':'ready-quota',generation_policy:null,goal_parts_policy:policy,valid_execution:valid,paint_status:paint,persisted_raw_equal:true,goal_elapsedMs:100,goal_deadline_status:'PASS',grade:gradeQuotaReady(value,o)};
}
function rpanel(options={}){return['R1','R2'].flatMap(id=>[rrow(id,'O',options[id]??{}),rrow(id,'Q')]);}
const ro=['R1','R2'].map(id=>({...rc,id}));
function erow(o,arm,success=true){const missing=o.expected_gate==='missing',control=o.expected_intent!=='change';return{id:o.id,arm,method:arm==='B'?'literal-v2':'adaptive-v3',generation_policy:arm==='C'?'dependent':null,goal_parts_policy:'quota',valid_execution:true,paint_status:'PASS',persisted_raw_equal:true,goal_elapsedMs:100,goal_deadline_status:'PASS',grade:{contract_valid:true,expected_gate:o.expected_gate,gate_correct:success,graph_exact:success,non_regression_guards:true,deadline:true,full_required_exact:success,missing_exact_minimal:success,no_false_adoption:true,raw_unchanged:!success||control,eligible:missing,old_eligible:missing,frontier_eligible:false,initial_literal:{recognized:false,required:[],spans:[]},proposal_policy_implemented:arm==='C',proposal_present:arm==='C'&&missing,verification_accepted:arm==='C'&&missing&&success,goal_parts_policy:'quota',quota_mechanism_valid:true}};}
const eo=[{id:'S1',expected_gate:'sufficient',expected_intent:'change'},{id:'S2',expected_gate:'sufficient',expected_intent:'change'},{id:'M1',expected_gate:'missing',expected_intent:'change'},{id:'M2',expected_gate:'missing',expected_intent:'change'},{id:'C1',expected_gate:'ambiguous',expected_intent:'ambiguous'},{id:'C2',expected_gate:'no-change',expected_intent:'no-change'}];
const epanel=()=>eo.flatMap(o=>[erow(o,'B',o.expected_gate!=='missing'),erow(o,'C')]);
const classify=(axis,rows,semantic,{allValid=true,replay='PASS',phaseKind='final'}={})=>{const raw={schema:'voice-ui.quota-cycle-raw-audit/1',status:'PASS',axis,phase_kind:phaseKind==='final'?'fresh':'public',planned:rows.length,consumed:rows.length,complete:true,all_valid_execution:allValid,admissible_for_semantic_claim:allValid,rows,semantic,replay:{status:'PASS',recorded_paint_status:replay}};return classifyQuotaAxis({phaseKind,axis,binding:{status:'PASS'},phase:{status:'PASS'},raw,ciRaw:clone(raw),ciReplay:{status:'PASS',recorded_paint_status:replay}});};

test('public input/oracle supply contracts and fixed R/E schedules validate without private payloads',()=>{
 assert.equal(validateQuotaInput(rInput,{phaseKind:'public'}),true);assert.equal(validateQuotaOracle(rOracle,rInput),true);assert.equal(validateQuotaOracle(eOracle,eInput),true);
 assert.deepEqual(quotaSchedule(rInput).map(r=>[r.arm,r.goal_parts_policy]),[['O','open'],['Q','quota']]);assert.deepEqual(quotaSchedule(eInput).map(r=>r.method),['literal-v2','adaptive-v3']);
 for(const mutate of [x=>x.fixture_contract.map_id='quota-expression',x=>x.cases[0].arms.reverse(),x=>x.parent_inputs_sha256='0'.repeat(64),x=>x.cases[0].expected_added_regions=[],x=>x.cases[0].parts.pop(),x=>x.cases[0].required[0].quantity=3]){const x=clone(rInput);mutate(x);assert.throws(()=>validateQuotaInput(x,{phaseKind:'public'}));}
 assert.throws(()=>validateQuotaInput(rInput,{phaseKind:'fresh'}));assert.throws(()=>validateQuotaInput(eInput,{phaseKind:'fresh'}));
 const changed=clone(rOracle);changed.cases[0].expected_added_regions=[];assert.throws(()=>validateQuotaOracle(changed,rInput));
});
test('independent quota is stable by exact label/kind, capped by capacity, and preserves original objects',()=>{
 const p=[{key:'a',purpose:'first',label:'X',kind:'step'},{key:'b',purpose:'other kind',label:'X',kind:'data'},{key:'c',purpose:'second',label:'X',kind:'step'}],before=clone(p);
 assert.deepEqual(referenceQuota(p,[{label:'X',kind:'step',quantity:1}]).map(x=>x.key),['a']);
 assert.deepEqual(referenceQuota(p,[{label:'X',kind:'step',quantity:3}]).map(x=>x.key),['a','c']);
 assert.deepEqual(referenceQuota(p,[]),[]);assert.deepEqual(p,before);
 assert.equal(referenceQuota([...p,{...p[0]}],[]),null);assert.equal(referenceQuota(p,[{label:'X',kind:'step',quantity:0}]),null);
 assert.equal(referenceQuota(p,[{label:'X',kind:'step',quantity:1},{label:'X',kind:'step',quantity:1}]),null);
});
test('R open extra adoption remains an admitted failure and a measurable assembly gain',()=>{
 const rows=rpanel({R1:{extra:true}}),s=summarizeQuotaAxis('R',rows,ro);
 assert.equal(rows[0].grade.contract_valid,true);assert.equal(rows[0].grade.no_false_adoption,false);assert.equal(s.pairs[0].eligible,true);assert.equal(s.assembly_gains,1);assert.equal(s.extra_adoptions_fixed,1);assert.equal(s.quota_correct,2);assert.equal(s.quality_criteria,'PASS');assert.equal(classify('R',rows,s).effect,'FINITE_ASSEMBLY_EFFECT_DEMONSTRATED');
});
test('public R never forces open failure or gain to admit a correct quota implementation',()=>{
 for(const extra of [false,true]){const rows=[rrow('PR01','O',{extra}),rrow('PR01','Q')],s=summarizeQuotaAxis('R',rows,[rc],{phaseKind:'public'});assert.equal(s.public_gate,'PASS');assert.equal(classify('R',rows,s,{phaseKind:'public'}).public_gate,'PASS');}
});
test('R source/supply/initial-state matching and preservation are independent admission conditions',()=>{
 const rows=rpanel({R1:{extra:true}});rows[0].grade.required_sha256='altered';let s=summarizeQuotaAxis('R',rows,ro);assert.equal(s.assembly_gains,0);assert.equal(s.pairs[0].eligible,false);assert.equal(s.no_effect_criteria_pending_integrity,'UNPROVEN');
 rows[0].grade.required_sha256=rows[1].grade.required_sha256;rows[0].grade.existing_semantics_preserved=false;s=summarizeQuotaAxis('R',rows,ro);assert.equal(s.pairs[0].eligible,false);assert.equal(s.assembly_gains,0);
});
test('R finite no-effect requires both complete admitted open successes; invalid/paint failure cannot prove it',()=>{
 const rows=rpanel(),s=summarizeQuotaAxis('R',rows,ro);assert.equal(s.no_effect_criteria_pending_integrity,'PASS');assert.equal(classify('R',rows,s).effect,'NO_EFFECT_IN_REGISTERED_EXPRESSION_PAIRS');
 for(const changed of [()=>{rows[0].valid_execution=false;},()=>{rows[0].valid_execution=true;rows[0].paint_status='UNMET';}]){changed();const bad=summarizeQuotaAxis('R',rows,ro);assert.equal(bad.no_effect_criteria_pending_integrity,'UNPROVEN');}
 assert.equal(classify('R',rows,s,{allValid:false}).effect,'UNPROVEN');assert.equal(classify('R',rpanel(),s,{replay:null}).quality,'UNPROVEN');
});
test('R selected key reuse or an extra quota offer violates mechanism rather than becoming a semantic gain',()=>{
 const parts=rc.parts,q=referenceQuota(parts,rc.required),selected=[{key:q[0].key},{key:q[0].key}],o={parts,supplied_required:rc.required,goal_parts_policy:'quota',goal_offers:[parts.map(({key,purpose,label})=>({key,purpose,label}))],selected,quota_proof_valid:true,initial_log:'synthetic',initial_records:initial(rc),final_records:target(rc),elapsedMs:1};
 const g=gradeQuotaReady(o,rc);assert.equal(g.graph_exact,true);assert.equal(g.contract_valid,false);assert.equal(g.selected_one_use,false);assert.equal(g.quota_offers_exact,false);
});
test('ordinary per-cell grade is the unchanged /3 meaning plus the separate quota proof',()=>{
 const none={label:'',kind:'none',quantity:'0'},factors={intent:{choice:'change',confidence:.9},labels:{choice:'missing',confidence:.9},capacity:{choice:'within',confidence:.9},completeness:{choice:'incomplete',confidence:.9}};
 const inspection={schema:'voice-ui.parts.inspection/3',request_id:'11111111-1111-4111-8111-111111111111',mode:'adaptive-v3',initial:{decision:{choice:'unknown',confidence:null},factors,literal:{recognized:false,required:[],spans:[]},observation:{valid:true,status:'unsupported-syntax'}},proposal_policy:{id:'uncertainty-frontier-v1',eligible:true,reason:'confident-change-incomplete'},proposal:{slots:{required1:{label:ec.required[0].label,kind:ec.required[0].kind,quantity:'1'},required2:none,required3:none},required:ec.required},verification:{...factors,completeness:{choice:'complete',confidence:.9}},required:ec.required,missing:ec.expected_missing};
 const o={inspection,decision:{choice:'missing',confidence:.9},initial_records:initial(ec),final_records:target(ec),initial_log:'before',final_log:'after',initial_head:'before',final_head:'after',preparations:1,typellm_sends:1,materialized_missing:ec.expected_missing,elapsedMs:1,goal_parts_policy:'quota',quota_proof_valid:true};
 const old=gradeFrontierGoal(o,ec,eOracle.stock_parts),q=gradeQuotaOrdinary(o,ec,eOracle.stock_parts);assert.equal(old.contract_valid,true);assert.equal(old.graph_exact,true);for(const k of Object.keys(old).filter(k=>k!=='scope'))assert.deepEqual(q[k],old[k],k);
 const bad=gradeQuotaOrdinary({...o,quota_proof_valid:false},ec,eOracle.stock_parts);assert.equal(bad.graph_exact,true);assert.equal(bad.contract_valid,false);
});
test('E requires both missing gains, exact whole six and quota on both B/C; R gains cannot substitute',()=>{
 const rows=epanel(),s=summarizeQuotaAxis('E',rows,eo);assert.equal(s.quality_criteria,'PASS');assert.equal(s.missing_gains,2);assert.equal(s.effect_criteria,'PASS');assert.equal(classify('E',rows,s).effect,'FINITE_SUPPLEMENTATION_EFFECT_DEMONSTRATED');
 rows.find(r=>r.id==='M1'&&r.arm==='C').grade.graph_exact=false;const one=summarizeQuotaAxis('E',rows,eo);assert.equal(one.missing_gains,1);assert.equal(one.effect_criteria,'UNMET');assert.equal(classify('E',rows,one).effect,'UNMET');
 rows[0].goal_parts_policy='open';assert.equal(summarizeQuotaAxis('E',rows,eo).complete,false);
});
test('E unchanged baseline and matching actual literal/eligibility are causal requirements, not denominator filters',()=>{
 const rows=epanel();rows.find(r=>r.id==='M1'&&r.arm==='B').grade.initial_literal={recognized:true,required:[],spans:[]};
 const s=summarizeQuotaAxis('E',rows,eo);assert.equal(s.total_pairs,6);assert.equal(s.admissible_missing_pairs,1);assert.equal(s.missing_gains,1);assert.equal(s.no_effect_criteria_pending_integrity,'UNPROVEN');
 const publicRows=[erow({...ec,id:'PE01'},'B',true),erow({...ec,id:'PE01'},'C')],p=summarizeQuotaAxis('E',publicRows,[ec],{phaseKind:'public'});assert.equal(p.public_gate,'UNMET');
});
test('a stopped baseline with bad paint, persistence or deadline cannot be relabeled as a supplementation gain',()=>{
 for(const change of[r=>{r.paint_status='UNMET';},r=>{r.persisted_raw_equal=false;},r=>{r.grade.deadline=false;}]){
  const rows=epanel(),baseline=rows.find(r=>r.id==='M1'&&r.arm==='B');change(baseline);
  const s=summarizeQuotaAxis('E',rows,eo);assert.equal(s.total_pairs,6);assert.equal(s.candidate_success,6);assert.equal(s.quality_criteria,'PASS');
  assert.equal(s.pairs.find(p=>p.id==='M1').eligible,false);assert.equal(s.missing_gains,1);assert.equal(s.effect_criteria,'UNMET');assert.equal(s.no_effect_criteria_pending_integrity,'UNPROVEN');assert.equal(classify('E',rows,s).effect,'UNPROVEN');
 }
 const publicRows=[erow(ec,'B',false),erow(ec,'C')];publicRows[0].paint_status='UNMET';const pub=summarizeQuotaAxis('E',publicRows,[ec],{phaseKind:'public'});assert.equal(pub.public_gate,'UNMET');assert.equal(pub.missing_gains,0);
 const rows=epanel();rows.find(r=>r.id==='C1'&&r.arm==='B').persisted_raw_equal=false;const all=summarizeQuotaAxis('E',rows,eo);assert.equal(all.effect_criteria,'UNMET');assert.equal(all.no_effect_criteria_pending_integrity,'UNPROVEN');
});
test('E finite zero-gain outcome retains quality failure and never promotes missing/invalid opportunity',()=>{
 const rows=epanel();for(const r of rows.filter(r=>r.arm==='C'&&r.grade.expected_gate==='missing')){r.grade.graph_exact=false;r.grade.gate_correct=false;r.grade.raw_unchanged=true;r.grade.verification_accepted=false;}
 const s=summarizeQuotaAxis('E',rows,eo);assert.equal(s.quality_criteria,'UNMET');assert.equal(s.no_effect_criteria_pending_integrity,'PASS');assert.equal(classify('E',rows,s).effect,'NO_EFFECT_IN_REGISTERED_MISSING_PAIRS');
 rows.find(r=>r.id==='M1'&&r.arm==='C').valid_execution=false;const invalid=summarizeQuotaAxis('E',rows,eo);assert.equal(invalid.total_pairs,6);assert.equal(invalid.no_effect_criteria_pending_integrity,'UNPROVEN');assert.equal(classify('E',rows,invalid,{allValid:false}).effect,'UNPROVEN');
});
test('classification requires independent actual CI, valid closed grades, replay and identical semantics',()=>{
 const rows=rpanel({R1:{extra:true}}),semantic=summarizeQuotaAxis('R',rows,ro),raw={schema:'voice-ui.quota-cycle-raw-audit/1',status:'PASS',axis:'R',phase_kind:'fresh',planned:4,consumed:4,complete:true,all_valid_execution:true,admissible_for_semantic_claim:true,rows,semantic,replay:{status:'PASS',recorded_paint_status:'PASS'}};
 const args={phaseKind:'final',axis:'R',binding:{status:'PASS'},phase:{status:'PASS'},raw,ciRaw:clone(raw),ciReplay:{status:'PASS',recorded_paint_status:'PASS'}};
 for(const mutate of [x=>x.ciRaw=null,x=>x.binding.status='FAIL',x=>x.ciRaw.semantic.assembly_gains=0,x=>x.ciReplay=null,x=>x.ciRaw.rows[1].grade.contract_valid=false,x=>x.ciRaw.rows[1].paint_status=null,x=>delete x.ciRaw.rows[1].goal_elapsedMs,x=>x.ciRaw.replay=null]){const x=clone(args);mutate(x);assert.equal(classifyQuotaAxis(x).effect,'UNPROVEN');}
});
test('causal ineligibility stays effect UNPROVEN while whole quality remains separately observed',()=>{
 const rows=epanel();rows.find(r=>r.id==='M1'&&r.arm==='B').grade.eligible=false;
 const s=summarizeQuotaAxis('E',rows,eo),c=classify('E',rows,s);assert.equal(s.quality_criteria,'PASS');assert.equal(s.effect_criteria,'UNMET');assert.equal(c.quality,'FINITE_CRITERIA_PASS');assert.equal(c.effect,'UNPROVEN');
});
