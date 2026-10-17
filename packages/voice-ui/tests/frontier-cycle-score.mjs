// Independent uncertainty-frontier semantics. No product imports/provider calls.
// Historical /2 readers and pure V/F grades are unchanged, never translated.
import {createHash} from 'node:crypto';
import {canonical,gradeGraph} from './semantic-score.mjs';
import {exactKeys,sameValue,validateRequirementInput as validateV2Input,validRequirements,validDecision,validFactors,
 validLiteral,readRequirementInspection,decodeRequiredSlots,stockDifference,verifierDecision,sameRequirements} from './requirements-cycle-score.mjs';
import {normalizeInitialIntent,gradeInitialIntent} from './intent-cycle-score.mjs';
import {summarizeDependencyAxis} from './dependency-cycle-score.mjs';
export {exactKeys,sameValue,validRequirements,validStock,stockDifference,sameRequirements,validFactors,validLiteral,
 validDecision,verifierDecision,decodeRequiredSlots,readRequirementInspection,gradeFullRequired,gradeVerification} from './requirements-cycle-score.mjs';
export {normalizeInitialIntent} from './intent-cycle-score.mjs';
export const FRONTIER_METHODS=Object.freeze({G0:'literal-v2',V:'verify',D:'full-required',B:'literal-v2',C:'adaptive-v3'});
export const FRONTIER_POLICIES=Object.freeze({G0:null,V:null,D:'dependent',B:null,C:'dependent'});
export const FRONTIER_PUBLIC=Object.freeze({
 G0:Object.freeze({input:'560b9126d385c9cfa1a48431fc6c78355b9f811e92b7a2f9736684a2c7f91c0f',oracle:'1ecb1b93dd057aa2d30c026e59625504fd545422e7929627a7e7f9fed2165007',parentInput:'bb2e090c218ef9be4db85416a87b60bf85a9d2d10a3156c4994bc1e6fd4bc4ba',parentOracle:'a5f08d8d2ed57b802870c76f4a86b9481400325d9c6342e8a0d66f58b5fb8653'}),
 E:Object.freeze({input:'27f0f8cc6f8a2f0bcd8bf7b92a75b93706c979f4fcb3ad002674ba8317a9db1a',oracle:'017eb6365b04a62e83d5747b91c604d41d639495c9541635331d2f334bc70a28',parentInput:'6ed1692b94371faef36475e08a221926b96cbc783f15f5d230ebb118a28b0afa',parentOracle:'9f5418a40cef083ff4119b0553c5f58a35451dbbec6147ea53db0e5b97d79ee5'}),
});
export const FRONTIER_SEALED_COMMITMENTS=Object.freeze({
 V:Object.freeze({input:'61afe307f57600439d0b70a63a4efcf5a36d3166dd74dfca4655cf466a2f8dd8',oracle:'61de89a893767d873af19ea26da11901acaa6b04005aef87cf7b9e83864a7a5e'}),
 F:Object.freeze({input:'78159163bebb25c87c6dd17ceff7c4eb746d34bf4bdd3c9d387bc5cb206c824a',oracle:'c36e4f748a6c82a9d3255b39f7e6bc087d1d15282bed892c9c69731e538a5caf'}),
 E:Object.freeze({input:'74d5eb6b1504ffd5ab223daa4b6682a1952f7db113f6bfb438fc2fe5d3cc67f7',oracle:'c6ee6fca910a2fd91581886cd24aad9d0cb5e7a53b50d33dc27ebad88d45bf13'}),
});
const hash=b=>createHash('sha256').update(b).digest('hex'),decode=b=>JSON.parse(Buffer.from(b).toString('utf8'));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(x);
export function validateFrontierInput(input,{phaseKind=null,parentProjectionBytes=null}={}){
 if(!exactKeys(input,['schema','axis','oracle_sha256','parent_inputs_sha256','fixture_contract','cases'])||input.schema!=='voice-ui.frontier-cycle-input/1'||!['G0','V','F','E'].includes(input.axis))throw Error('frontier input identity');
 const kind=phaseKind??(input.axis==='G0'||input.parent_inputs_sha256!==null?'public':'fresh');
 if(!['public','fresh'].includes(kind)||kind==='public'&&!['G0','E'].includes(input.axis)||kind==='fresh'&&input.axis==='G0')throw Error('frontier unregistered phase');
 const count=kind==='public'?input.axis==='G0'?10:2:({V:10,F:8,E:10})[input.axis];
 if(!Array.isArray(input.cases)||input.cases.length!==count)throw Error('frontier fixed denominator');
 const parent=kind==='public'?FRONTIER_PUBLIC[input.axis].parentInput:null;if(input.parent_inputs_sha256!==parent)throw Error('frontier immutable parent');
 const old={schema:'voice-ui.requirements-cycle-input/1',axis:input.axis==='G0'?'F':input.axis,oracle_sha256:input.oracle_sha256,fixture_contract:input.fixture_contract,
  cases:input.cases.map((c,i)=>{if(!exactKeys(c,['id','fixture','utterance',...(input.axis==='V'?['required']:[]),'arms']))throw Error('frontier case fields');
   const wanted=input.axis==='G0'?['G0']:input.axis==='V'?['V']:input.axis==='F'?['D']:i%2===0?['B','C']:['C','B'];if(!sameValue(c.arms,wanted))throw Error('frontier arm schedule');const{arms,...value}=c;return value;})};
 validateV2Input(old);
 if(parentProjectionBytes!==null){if(parent===null||hash(parentProjectionBytes)!==parent)throw Error('frontier parent bytes');const prior=decode(parentProjectionBytes);
  if(prior.schema!=='voice-ui.intent-cycle-input/1'||prior.axis!==input.axis||!sameValue(prior.fixture_contract,input.fixture_contract)||!sameValue(prior.cases,input.cases))throw Error('frontier changed public semantics');}
 return true;
}
export function frontierSchedule(input,options){validateFrontierInput(input,options);return input.cases.flatMap(c=>c.arms.map(arm=>({axis:input.axis,id:c.id,arm,method:FRONTIER_METHODS[arm],generation_policy:FRONTIER_POLICIES[arm]})));}
export function proposalPolicy(factors){
 if(!validFactors(factors))return null;
 const i=factors.intent,c=factors.completeness;let reason=null;
 if(c.choice==='incomplete'&&c.confidence>=.5){if(i.choice==='change'&&i.confidence>=.5)reason='confident-change-incomplete';
  else if(['change','ambiguous'].includes(i.choice)&&i.confidence<.5)reason='uncertain-intent-incomplete';}
 return{id:'uncertainty-frontier-v1',eligible:reason!==null,reason};
}
export const oldInterpretationEligible=f=>validFactors(f)&&f.intent.choice==='change'&&f.intent.confidence>=.5&&f.completeness.choice==='incomplete'&&f.completeness.confidence>=.5;
export function readFrontierInspection(x,utterance,parts,initialRecords){
 if(!exactKeys(x,['schema','request_id','mode','initial','proposal_policy','proposal','verification','required','missing'])||x.schema!=='voice-ui.parts.inspection/3'||x.mode!=='adaptive-v3'||!uuid(x.request_id)
  ||!exactKeys(x.initial,['decision','factors','literal','observation'])||!validDecision(x.initial.decision)||!validFactors(x.initial.factors)||!validLiteral(x.initial.literal,utterance)
  ||!exactKeys(x.initial.observation,['valid','status'])||typeof x.initial.observation.valid!=='boolean'||!['transcribed','unsupported-syntax'].includes(x.initial.observation.status)||!validRequirements(x.required))return null;
 if(!x.initial.observation.valid&&(x.initial.literal.recognized||x.initial.literal.required.length||x.initial.literal.spans.length))return null;
 const normalizedInitial=normalizeInitialIntent(x.initial,utterance,parts,initialRecords),policy=proposalPolicy(x.initial.factors);
 if(normalizedInitial===null||!sameValue(normalizedInitial,x.initial.decision)||!sameValue(policy,x.proposal_policy))return null;
 if(x.proposal===null){if(x.verification!==null||policy.eligible||!sameValue(x.required,x.initial.literal.required))return null;}
 else{const rows=decodeRequiredSlots(x.proposal?.slots);if(!exactKeys(x.proposal,['slots','required'])||rows===null||!sameValue(rows,x.proposal.required)||!sameValue(x.required,rows)||!validFactors(x.verification)||!policy.eligible)return null;}
 const difference=stockDifference(x.required,parts);if(!sameValue(x.missing,difference))return null;
 const verification=x.verification===null?null:verifierDecision(x.verification),vf=x.verification;
 const choice=vf===null?null:vf.intent.choice!=='change'?vf.intent.choice:vf.completeness.choice==='complete'&&vf.completeness.confidence>=.5?difference.length?'missing':'sufficient':'unknown';
 const normalized=x.proposal===null?x.initial.decision:{choice,confidence:choice==='unknown'?null:vf.intent.choice!=='change'?vf.intent.confidence:verification.confidence};
 return{value:x,eligible:policy.eligible,old_eligible:oldInterpretationEligible(x.initial.factors),frontier_eligible:policy.reason==='uncertain-intent-incomplete',policy,verification,normalized,full_required:x.required,projected_missing:difference};
}
export function gradeInitialPolicy(response,oracle,parts,observation={}){
 if(typeof oracle.expected_proposal_eligible!=='boolean')throw Error('G0 explicit proposal-policy oracle');
 const taxonomy=gradeInitialIntent(response,oracle,parts,observation),f=response?.inspection?.initial?.factors;
 const policy=proposalPolicy(f),old=oldInterpretationEligible(f),newEligible=policy?.eligible??false;
 const correct=taxonomy.contract_valid&&taxonomy.raw_unchanged&&taxonomy.type_zero&&policy!==null&&newEligible===oracle.expected_proposal_eligible;
 return{...taxonomy,taxonomy_correct:taxonomy.correct,correct,policy_correct:correct,expected_proposal_eligible:oracle.expected_proposal_eligible,old_interpretation_eligible:old,new_interpretation_eligible:newEligible,frontier_eligible:!old&&newEligible,proposal_policy:policy,
  scope:'direct /2 G0 taxonomy retained separately; new policy is independently derived, not proof of actual C execution; inherited E targets never authorize adoption'};
}
export function gradeFrontierGoal(o,oracle,parts){
 const raw=o.inspection,mode=raw?.mode;
 const inspected=mode==='literal-v2'?readRequirementInspection(raw,oracle.utterance,parts):mode==='adaptive-v3'?readFrontierInspection(raw,oracle.utterance,parts,o.initial_records):null;
 const initial=inspected?.value.initial,normalizedInitial=initial?normalizeInitialIntent(initial,oracle.utterance,parts,o.initial_records):null;
 const inspection=inspected&&normalizedInitial!==null&&sameValue(normalizedInitial,initial.decision)?inspected:null;
 const policy=initial?proposalPolicy(initial.factors):null,decisionValid=validDecision(o.decision),graph=gradeGraph(o.initial_records,o.final_records,oracle);
 const control=oracle.expected_intent!=='change',sufficient=oracle.expected_gate==='sufficient';
 const unchanged=o.initial_log===o.final_log&&o.initial_head===o.final_head&&sameValue(o.initial_records,o.final_records);
 const subset=(got,wanted)=>{const rest=wanted.map(x=>JSON.stringify(canonical(x)));return got.every(x=>{const i=rest.indexOf(JSON.stringify(canonical(x)));if(i<0)return false;rest.splice(i,1);return true;});};
 const noFalse=graph.existing_semantics_preserved&&graph.no_other_new_semantics&&graph.clean_new_regions&&graph.clean_new_edges&&subset(graph.actual_added_regions,oracle.expected_added_regions)&&subset(graph.actual_added_edges,oracle.expected_added_edges);
 const preparationsValid=Number.isSafeInteger(o.preparations)&&o.preparations>=0&&o.preparations<=1,typeValid=Number.isSafeInteger(o.typellm_sends)&&o.typellm_sends>=0&&o.typellm_sends<=1;
 const typePolicy=typeValid&&(mode==='adaptive-v3'&&inspection&&policy?.eligible?o.typellm_sends===1:o.typellm_sends===0);
 const knownCost=oracle.syntax_stratum==='B-known'?o.typellm_sends===0:true;
 const materialized=o.materialized_missing??(o.preparations===1?raw?.missing:[]),zeroCandidates=Array.isArray(materialized)&&materialized.length===0&&preparationsValid&&o.preparations===0;
 const finalAuthorized=decisionValid&&['sufficient','missing'].includes(o.decision.choice)&&o.decision.confidence>=.5&&(inspection?.value.proposal===null||inspection?.verification?.accepted===true);
 const stopped=finalAuthorized||unchanged&&o.preparations===0;
 const guarded=preparationsValid&&typePolicy&&knownCost&&noFalse&&stopped&&(control?zeroCandidates&&o.typellm_sends===0&&unchanged:sufficient?zeroCandidates:true);
 return{contract_valid:decisionValid&&inspection!==null&&sameValue(o.decision,inspection.normalized)&&preparationsValid&&typeValid,
  expected_gate:oracle.expected_gate,gate_correct:decisionValid&&o.decision.choice===oracle.expected_gate&&o.decision.choice!=='unknown'&&o.decision.confidence>=.5,
  full_required_exact:control?null:inspection!==null&&sameRequirements(inspection.full_required,oracle.required),missing_exact_minimal:inspection!==null&&sameValue(inspection.projected_missing,oracle.expected_missing),
  graph_exact:graph.graph_exact,graph,no_false_adoption:noFalse,raw_unchanged:unchanged,non_regression_guards:guarded,type_policy_guard:typePolicy,known_syntax_type_free:knownCost,stop_authorization_guard:stopped,
  true_sufficient_zero_candidates:sufficient?zeroCandidates:null,interpretation_type_calls:sufficient?o.typellm_sends:0,
  eligible:policy?.eligible??false,old_eligible:initial?oldInterpretationEligible(initial.factors):false,frontier_eligible:policy?.reason==='uncertain-intent-incomplete',proposal_policy:policy,
  proposal_policy_implemented:mode==='adaptive-v3'&&inspection!==null,proposal_present:raw?.proposal!==null&&raw?.proposal!==undefined,verification_accepted:inspection?.verification?.accepted??false,initial_literal:initial?.literal??null,
  deadline:Number.isFinite(o.elapsedMs)&&o.elapsedMs>=0&&o.elapsedMs<=180000,scope:'new /3 policy validation with unchanged graph/target/authorization/finite quality meanings; no historical receipt translation'};
}
const valid=r=>r?.valid_execution===true&&r.grade?.contract_valid===true;
const success=r=>valid(r)&&r.grade.gate_correct&&r.grade.graph_exact&&r.grade.non_regression_guards&&r.grade.deadline&&r.paint_status==='PASS'&&r.persisted_raw_equal===true
 &&(['ambiguous','no-change','unsupported'].includes(r.grade.expected_gate)||r.grade.full_required_exact&&r.grade.missing_exact_minimal);
export function summarizeFrontierAxis(axis,rows,oracles,{phaseKind='fresh'}={}){
 if(!['public','fresh'].includes(phaseKind)||!['G0','V','F','E'].includes(axis))throw Error('frontier summary scope');
 if(['V','F'].includes(axis))return summarizeDependencyAxis(axis,rows,oracles,{phaseKind});
 if(axis==='G0'){
  if(phaseKind!=='public'||oracles.length!==10)throw Error('G0 public10 only');
  const complete=rows.length===10&&new Set(rows.map(r=>r.id)).size===10&&rows.every(r=>oracles.some(o=>o.id===r.id)&&r.arm==='G0'&&r.method==='literal-v2'&&r.generation_policy===null);
  const admitted=rows.filter(valid),correct=admitted.filter(r=>r.grade.policy_correct),taxonomy=admitted.filter(r=>r.grade.taxonomy_correct);
  return{complete,total:10,valid:admitted.length,correct:correct.length,taxonomy_correct:taxonomy.length,intent_criteria:complete&&taxonomy.length===10?'PASS':'UNMET',policy_criteria:complete&&correct.length===10?'PASS':'UNMET',
   actual_old_eligible:admitted.filter(r=>r.grade.old_interpretation_eligible).map(r=>r.id),actual_new_eligible:admitted.filter(r=>r.grade.new_interpretation_eligible).map(r=>r.id),actual_frontier_eligible:admitted.filter(r=>r.grade.frontier_eligible).map(r=>r.id),scope:'public candidate-policy regression gate; initial taxonomy remains a separate unchanged observation'};
 }
 const arms=['B','C'],complete=rows.length===oracles.length*2&&new Set(rows.map(r=>JSON.stringify([r.id,r.arm]))).size===rows.length&&oracles.every(o=>arms.every(a=>rows.some(r=>r.id===o.id&&r.arm===a)))
  &&rows.every(r=>oracles.some(o=>o.id===r.id)&&arms.includes(r.arm)&&r.method===FRONTIER_METHODS[r.arm]&&r.generation_policy===FRONTIER_POLICIES[r.arm]);
 const baseline=rows.filter(r=>r.arm==='B'),enabled=rows.filter(r=>r.arm==='C'),allValid=complete&&rows.every(valid);
 const pairs=oracles.map(o=>{const a=baseline.find(r=>r.id===o.id),b=enabled.find(r=>r.id===o.id),eligible=valid(a)&&valid(b)&&a.grade.eligible&&b.grade.eligible&&sameValue(a.grade.initial_literal,b.grade.initial_literal);
  const as=success(a),bs=success(b),gain=o.expected_gate==='missing'&&eligible&&!as&&a.grade.raw_unchanged&&bs&&b.grade.proposal_policy_implemented&&b.grade.proposal_present&&b.grade.verification_accepted;
  return{id:o.id,eligible:Boolean(eligible),baseline_success:as,enabled_success:bs,missing_gain:Boolean(gain),frontier_gain:Boolean(gain&&b.grade.frontier_eligible&&!b.grade.old_eligible),both_arms_frontier:Boolean(eligible&&a.grade.frontier_eligible&&!a.grade.old_eligible&&b.grade.frontier_eligible&&!b.grade.old_eligible),regression:as&&!bs,excluded_from_causal_only:!eligible};});
 const gain=pairs.filter(p=>p.missing_gain).length,frontier=pairs.filter(p=>p.frontier_gain).length,regressions=pairs.filter(p=>p.regression).length;
 const allGuards=complete&&rows.every(r=>r.grade?.non_regression_guards===true),noFalse=complete&&rows.every(r=>r.grade?.no_false_adoption===true);
 const enabledPass=allValid&&enabled.length===oracles.length&&enabled.every(success)&&allGuards&&noFalse;
 const missing=oracles.filter(o=>o.expected_gate==='missing');
 const shape=phaseKind==='fresh'?oracles.length===10&&oracles.filter(o=>o.expected_gate==='sufficient').length===4&&missing.length===4&&oracles.filter(o=>o.expected_intent!=='change').length===2:oracles.length===2;
 const effect=allValid&&shape&&gain>=2&&regressions===0&&allGuards&&noFalse;
 const noEffect=allValid&&phaseKind==='fresh'&&missing.length===4&&allGuards&&noFalse&&regressions===0&&gain===0&&rows.every(r=>r.paint_status==='PASS'&&r.persisted_raw_equal===true)&&missing.every(o=>pairs.find(p=>p.id===o.id)?.eligible);
 const frontierNoEffect=noEffect&&missing.every(o=>{const r=enabled.find(r=>r.id===o.id);return r.grade.frontier_eligible&&!r.grade.old_eligible;});
 const counts=own=>Object.fromEntries(['sufficient','missing','ambiguous','no-change'].map(s=>[s,{correct:own.filter(r=>r.grade?.expected_gate===s&&success(r)).length,total:oracles.filter(o=>o.expected_gate===s).length}]));
 return{complete,total:oracles.length,total_pairs:oracles.length,baseline:counts(baseline),enabled:counts(enabled),enabled_success:enabled.filter(success).length,baseline_success:baseline.filter(success).length,missing_gains:gain,frontier_missing_gains:frontier,regressions,eligible_pairs:pairs.filter(p=>p.eligible).length,admissible_missing_pairs:missing.filter(o=>pairs.find(p=>p.id===o.id)?.eligible).length,
  all_arm_guards:allGuards,no_false_adoption:noFalse,interpretation_type_calls:enabled.reduce((n,r)=>n+(r.grade?.interpretation_type_calls??0),0),pairs,enabled_criteria:enabledPass&&shape?'PASS':'UNMET',effect_criteria:effect?'PASS':'UNMET',frontier_effect_criteria_pending_integrity:effect&&frontier>=1?'PASS':'UNPROVEN',
  no_effect_criteria_pending_integrity:noEffect?'PASS':'UNPROVEN',frontier_no_effect_criteria_pending_integrity:frontierNoEffect?'PASS':'UNPROVEN',
  scope:'fixed whole E denominator; generic Type-path effect and newly added frontier-specific effect are separate; integrity/paint/source admission mandatory'};
}
// Classification only consumes independent new-schema audits. It cannot make
// failed/missing live, source or paint proof into a performance conclusion.
export function classifyFrontierAxis({phaseKind,axis,binding,raw,phase,ciRaw=null,ciReplay=null}){
 if(!['public','final'].includes(phaseKind)||!['G0','V','F','E'].includes(axis)||axis==='G0'&&phaseKind!=='public')throw Error('frontier classification scope');
 const unproven={quality:'UNPROVEN',effect:axis==='E'?'UNPROVEN':'NOT_EVALUATED',frontier_effect:axis==='E'?'UNPROVEN':'NOT_EVALUATED',...(phaseKind==='public'?{public_gate:'UNPROVEN'}:{})};
 const rawIdentity=x=>x?.status==='PASS'&&x.schema==='voice-ui.frontier-cycle-raw-audit/1'&&x.axis===axis;
 if(binding?.status!=='PASS'||phase?.status!=='PASS'||!rawIdentity(raw)||!rawIdentity(ciRaw)||!sameValue(raw.semantic,ciRaw.semantic))return unproven;
 const s=raw.semantic;
 if(phaseKind==='public'){
  const gate=axis==='G0'?s?.policy_criteria:axis==='E'&&s?.enabled_criteria==='PASS'&&s?.effect_criteria==='PASS'?'PASS':'UNMET';
  if(!['G0','E'].includes(axis)||!['PASS','UNMET'].includes(gate))return unproven;
  const complete=raw.phase_kind==='public'&&ciRaw.phase_kind==='public'&&raw.complete===true&&ciRaw.complete===true&&raw.all_valid_execution===true&&ciRaw.all_valid_execution===true;
  return{quality:'PUBLIC_REGRESSION_ONLY',effect:axis==='E'?'PUBLIC_REGRESSION_ONLY':'NOT_EVALUATED',frontier_effect:axis==='E'?'PUBLIC_REGRESSION_ONLY':'NOT_EVALUATED',public_gate:complete?gate:'UNMET'};
 }
 const count=({V:10,F:8,E:20})[axis];
 const fresh=x=>x.phase_kind==='fresh'&&x.planned===count&&x.consumed===count&&x.complete===true&&x.all_valid_execution===true&&x.admissible_for_semantic_claim===true&&Array.isArray(x.rows)&&x.rows.length===count
  &&x.rows.every(r=>r.valid_execution===true&&r.grade?.contract_valid===true&&r.method===FRONTIER_METHODS[r.arm]&&r.generation_policy===FRONTIER_POLICIES[r.arm]);
 if(!fresh(raw)||!fresh(ciRaw))return unproven;
 if(axis==='E'&&(raw.replay?.status!=='PASS'||ciReplay?.status!=='PASS'||!['PASS','UNMET'].includes(raw.replay.recorded_paint_status)||!['PASS','UNMET'].includes(ciReplay.recorded_paint_status)
  ||[raw,ciRaw].some(x=>x.rows.some(r=>!['PASS','UNMET'].includes(r.paint_status)||!Number.isFinite(r.goal_elapsedMs)||r.goal_elapsedMs<0||!['PASS','UNMET'].includes(r.goal_deadline_status)))))return unproven;
 const criterion=axis==='V'?s?.verification_criteria:axis==='F'?s?.requirements_criteria:s?.enabled_criteria;
 if(!['PASS','UNMET'].includes(criterion)||axis==='E'&&!['PASS','UNMET'].includes(s?.effect_criteria))return unproven;
 if(axis!=='E')return{quality:criterion==='PASS'?'FINITE_CRITERIA_PASS':'UNMET',effect:'NOT_EVALUATED',frontier_effect:'NOT_EVALUATED'};
 let effect=s.effect_criteria==='PASS'?'FINITE_EFFECT_DEMONSTRATED':'UNMET',frontier='UNPROVEN';
 const missing=s.pairs?.filter(p=>raw.rows.some(r=>r.id===p.id&&r.grade.expected_gate==='missing'));
 const noEffect=s.no_effect_criteria_pending_integrity==='PASS'&&missing?.length===4&&missing.every(p=>p.eligible)&&s.missing_gains===0&&s.regressions===0&&s.no_false_adoption===true&&s.all_arm_guards===true
  &&raw.replay.recorded_paint_status==='PASS'&&ciReplay.recorded_paint_status==='PASS'&&[raw,ciRaw].every(x=>x.rows.every(r=>r.paint_status==='PASS'&&r.persisted_raw_equal===true));
 if(effect==='UNMET'&&s.missing_gains===0)effect=noEffect?'NO_EFFECT_IN_REGISTERED_MISSING_CASES':'UNPROVEN';
 if(effect==='FINITE_EFFECT_DEMONSTRATED'&&s.frontier_effect_criteria_pending_integrity==='PASS'&&s.frontier_missing_gains>=1)frontier='FINITE_FRONTIER_EFFECT_DEMONSTRATED';
 if(noEffect&&s.frontier_no_effect_criteria_pending_integrity==='PASS'&&missing.every(p=>raw.rows.find(r=>r.id===p.id&&r.arm==='C')?.grade.frontier_eligible===true&&!raw.rows.find(r=>r.id===p.id&&r.arm==='C')?.grade.old_eligible))frontier='NO_EFFECT_IN_REGISTERED_FRONTIER_CASES';
 return{quality:criterion==='PASS'?'FINITE_CRITERIA_PASS':'UNMET',effect,frontier_effect:frontier};
}
