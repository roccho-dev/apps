// Independent new quota semantics. No product imports or provider calls.
// Old per-cell ordinary Goal meaning is reused without modifying its module.
import {createHash} from 'node:crypto';
import {canonical,gradeGraph} from './semantic-score.mjs';
import {exactKeys,sameValue,validRequirements,validStock,stockDifference,sameRequirements,
 validateRequirementInput} from './requirements-cycle-score.mjs';
import {gradeFrontierGoal} from './frontier-cycle-score.mjs';
export {exactKeys,sameValue,validRequirements,validStock,stockDifference,sameRequirements} from './requirements-cycle-score.mjs';
export const QUOTA_METHODS=Object.freeze({O:'ready-open',Q:'ready-quota',B:'literal-v2',C:'adaptive-v3'});
export const QUOTA_GENERATIONS=Object.freeze({O:null,Q:null,B:null,C:'dependent'});
export const QUOTA_GOAL_POLICIES=Object.freeze({O:'open',Q:'quota',B:'quota',C:'quota'});
export const QUOTA_COMMITMENTS=Object.freeze({
 public:Object.freeze({R:{input:'35e6e31053ab8ea187899258e79623e74bc837ba482a73e043ef1ed99c296179',oracle:'5612d2c372266cbee6ee89cd6b0829c00b0568f8ca08d42627cdbb2e89506ea9'},E:{input:'e3c4c653c8225dfb668c18bf022345e1e3ef7a8665d821f3da72219d6c98a1a7',oracle:'c67b083bb6d17096594807074f72a562efebd17b8198f8c6f8aba9b91e1155c2'}}),
 fresh:Object.freeze({R:{input:'4ab4662aa00925d7e1bf480efadbc840f4421e6e6cfd16ae53d972387ce005d7',oracle:'c3d0c9df12837d0de03c9fb7e532f955f23ed60e7e0409ac473b0da7b293a32c'},E:{input:'926d7007508e0f4b67fe2fb564e1d299d82219ca9e1b95f96e3b26c3d6c9ae40',oracle:'87bc601021241e65ee78e5e8c4a30d316d0e8e9c7fcbbfe3ac2f6b4b7a2b87b3'}}),
});
// This registered repeat shares the original quota grades, caller and closed stages.
// The ordinary generation name remains the dependency policy; extraction is recorded separately.
export const TYPED_QUOTA_PROFILE=Object.freeze({
 "id": "typed-ordinary-E-20261018",
 "charged_prior": {
  "jev": 847,
  "typellm": 136
 },
 "cycle_cap": {
  "jev": 133,
  "typellm": 7
 },
 "baseline_journal_sha256": "2b938983023a8e2627041d52cb943a3d0f6bd530aeed637c606b816a57328d35",
 "cutoff_phase_id": "thinking-fresh-D-20261018",
 "commitment_sha256": "8543f8c0f8b1c572a4b0fe41d94720522bc7b58fa1cb3dea27d2ad5f30118225",
 "freeze_sha256": "8a5c84c4f3546a82fcc49ca4e7734a3f2ba58aafd8c322fc23c8b06d7889fd29",
 "commitments": {
  "public": {
   "E": {
    "input": "52b95efd0dc3301c746b1d947e5896400bf7f12ee0e8d2d53113ddf8c2c08283",
    "oracle": "837d68dd6c1da85ac3ce199d27dc88ceeb3ea57eff0ec18bdf5451ff6dd7124e"
   }
  },
  "fresh": {
   "E": {
    "input": "f646112dbb14896a2e8f27d99f2b995e374aacf68b87058c7520e9821f420e43",
    "oracle": "94ba803d5633ab9ddcbeedaedda3d04387255be27cadd93351fff6f68cbb08d7"
   }
  }
 },
 "provider_sources": {
  "jev": {
   "contract": "named-questions/1",
   "entry_sha256": "0773b5c96d0da7f05fef9f9cf95772b6722a03022648e90fc56a4fdc9ac6046e",
   "locator": "https://github.com/roccho-org/ops/releases/download/jev-provider-c7ed1132ad7bec8e5f05c6da38d719a05dec4877/jev-provider.zip",
   "manifest_sha256": "a5386f84f0606c6900b3c0e89d19f94dcf701d344d7c7e6384889d8bb6a1aab5",
   "proof_sha256": "d756b5855a55c07e7b93687f1556ad1a2657ce0acc701c89476d87d9461a46ff",
   "provenance_sha256": "90e295578042b89fcf4e1d6dfc2a5cdee6d76916f97a3668472883810811ea17",
   "sha256": "0c063b050895db87029fd514c81add33e291e321109e2aa55a3befdd42593f03"
  },
  "typellm": {
   "contract": "typed-completion/1",
   "entry_sha256": "3c10462eecd7f83dd790bfe208587c99347dcbed324b32ae674afbab48bdfb22",
   "locator": "https://github.com/roccho-org/ops/releases/download/jev-provider-a724bdfa1864762cd9050a00e2642450af29c196/typellm-provider.zip",
   "manifest_sha256": "4addcd161cb80f8800ee8d78a4b212c3fd2b7e92900cb10c492f3cf560878b2b",
   "proof_sha256": "8e79073aa7fb94ffa7d4c0003c592d85622099b251c0958712eb2f7ea59bfba6",
   "provenance_sha256": "d3d3b35ce4a77077823230da4790070db5ba206d09c66111c72b4fc44f4cc9ac",
   "sha256": "25f8bf076d24577ad512fc63c9491e13796e76007d2e52349b5a9fc223395de6"
  }
 },
 "extraction_profile": "thinking-labels"
});
// V remains the existing six-case predicate grade; E retains the quota grades.
export const COMPACT_VERIFIER_PROFILE=Object.freeze({
 "id": "compact-verifier-VE-20261018",
 "charged_prior": {
  "jev": 850,
  "typellm": 137
 },
 "cycle_cap": {
  "jev": 139,
  "typellm": 7
 },
 "baseline_journal_sha256": "90525733f94f161502411d957c953e1162850e7a1740f13cdad69a455e0d1478",
 "cutoff_phase_id": "quota-typed-public-E-20261018",
 "commitment_sha256": "a9062129f2bda9dab84f5e311d35f7b071b1035f22a1485a38c4c8aafd6d12a2",
 "freeze_sha256": "4e9c70316b95d938a00a48fa7693330fe51b644ac1cd9c895b431fccc3dffe2e",
 "commitments": {
  "public": {
   "V": {
    "input": "a508e239d34896726e0a21c9e7cd0eb52486879652be70e786be362d57db573d",
    "oracle": "c2bfbe81c8d7c7c07f8e36a985b7a2c537bd3fd2ef0eb61147d0beeb8c704d2d"
   },
   "E": {
    "input": "52b95efd0dc3301c746b1d947e5896400bf7f12ee0e8d2d53113ddf8c2c08283",
    "oracle": "837d68dd6c1da85ac3ce199d27dc88ceeb3ea57eff0ec18bdf5451ff6dd7124e"
   }
  },
  "fresh": {
   "E": {
    "input": "f646112dbb14896a2e8f27d99f2b995e374aacf68b87058c7520e9821f420e43",
    "oracle": "94ba803d5633ab9ddcbeedaedda3d04387255be27cadd93351fff6f68cbb08d7"
   }
  }
 },
 "extraction_profile": "thinking-labels",
 "verification_prerequisite": true,
 "phase_ids": {
  "V": {
   "public": "compact-verifier-public-V-20261018"
  },
  "E": {
   "public": "compact-verifier-public-E-20261018",
   "final": "compact-verifier-final-E-20261018"
  }
 },
 provider_sources:TYPED_QUOTA_PROFILE.provider_sources,
});
export function quotaRepeatProfile(name=null){
 if(name===null)return null;
 if(name===TYPED_QUOTA_PROFILE.id)return TYPED_QUOTA_PROFILE;
 if(name===COMPACT_VERIFIER_PROFILE.id)return COMPACT_VERIFIER_PROFILE;
 throw Error('unknown quota repeat profile');
}
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const kinds=['step','decision','data','start','end','group'];
const text=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
const pair=x=>JSON.stringify([x.label,x.kind]);
export function validQuotaParts(parts){return Array.isArray(parts)&&parts.length<=11&&parts.every(p=>exactKeys(p,['key','purpose','label','kind'])
 &&/^[a-z][a-z0-9-]{0,63}$/u.test(p.key??'')&&p.key!=='none'&&text(p.purpose,300)&&text(p.label,120)&&kinds.includes(p.kind))&&new Set(parts.map(p=>p.key)).size===parts.length;}
// Independent reference, deliberately does not call the implementation helper.
export function referenceQuota(parts,required){
 if(!validQuotaParts(parts)||!validRequirements(required))return null;
 const remaining=new Map(required.map(r=>[pair(r),r.quantity]));
 return parts.filter(p=>{const key=pair(p),n=remaining.get(key)??0;if(n===0)return false;remaining.set(key,n-1);return true;}).map(p=>({...p}));
}
export function validateQuotaInput(input,{phaseKind=null}={}){
 if(!exactKeys(input,['schema','axis','oracle_sha256','parent_inputs_sha256','fixture_contract','cases'])||input.schema!=='voice-ui.quota-cycle-input/1'||!['R','E'].includes(input.axis)||input.parent_inputs_sha256!==null)throw Error('quota input identity');
 if(input.fixture_contract?.map_id!=='voice-graph')throw Error('ordinary app map namespace');
 const kind=phaseKind??(input.cases?.length===1?'public':'fresh');if(!['public','fresh'].includes(kind))throw Error('quota phase');
 const count=kind==='public'?1:input.axis==='R'?2:6;
 if(!Array.isArray(input.cases)||input.cases.length!==count)throw Error('quota fixed denominator');
 const prior={schema:'voice-ui.requirements-cycle-input/1',axis:'E',oracle_sha256:input.oracle_sha256,fixture_contract:input.fixture_contract,cases:input.cases.map((c,i)=>{
  const names=input.axis==='R'?['id','fixture','utterance','parts','required','arms']:['id','fixture','utterance','arms'];
  if(!exactKeys(c,names))throw Error('quota case fields');
  const arms=input.axis==='R'?(i%2===0?['O','Q']:['Q','O']):(i%2===0?['B','C']:['C','B']);if(!sameValue(c.arms,arms))throw Error('quota order');
  if(input.axis==='R'&&(!validStock(c.parts)||!validRequirements(c.required)||stockDifference(c.required,c.parts).length!==0))throw Error('R incomplete independent supply');
  return{id:c.id,fixture:c.fixture,utterance:c.utterance};
 })};
 validateRequirementInput(prior);if(!sameValue(input.fixture_contract.recent_conversation,[])||input.fixture_contract.scope!==null)throw Error('quota conversation/scope');
 return true;
}
export function quotaSchedule(input,options){validateQuotaInput(input,options);return input.cases.flatMap(c=>c.arms.map(arm=>({axis:input.axis,id:c.id,arm,method:QUOTA_METHODS[arm],generation_policy:QUOTA_GENERATIONS[arm],goal_parts_policy:QUOTA_GOAL_POLICIES[arm]})));}
const bag=x=>x.map(r=>JSON.stringify([r.label,r.kind])).sort();
export function validateQuotaOracle(oracle,input){
 validateQuotaInput(input);if(oracle?.schema!=='voice-ui.quota-cycle-oracle/1'||oracle.axis!==input.axis||oracle.parent_oracle_sha256!==null||!sameValue(oracle.fixture_contract,input.fixture_contract)||!validStock(oracle.stock_parts)||!Array.isArray(oracle.cases)||oracle.cases.length!==input.cases.length)throw Error('quota oracle identity');
 for(const [i,c]of input.cases.entries()){
  const o=oracle.cases[i];if(!o||o.id!==c.id||o.fixture!==c.fixture||o.utterance!==c.utterance||!sameValue(o.arms,c.arms)||!validRequirements(o.required)||!Array.isArray(o.expected_added_regions)||!Array.isArray(o.expected_added_edges))throw Error('quota oracle case');
  const parts=input.axis==='R'?c.parts:oracle.stock_parts;
  if(!sameValue(o.expected_missing,stockDifference(o.required,parts))||!sameValue(bag(o.expected_added_regions),bag(o.required.flatMap(r=>Array.from({length:r.quantity},()=>r)))))throw Error('quota independent target multiset');
  if(input.axis==='R'&&(!sameValue(o.parts,c.parts)||!sameValue(o.required,c.required)||o.expected_missing.length!==0))throw Error('R hidden/public supply mismatch');
  if(!['change','ambiguous','no-change','unsupported'].includes(o.expected_intent)||!['sufficient','missing','ambiguous','no-change','unsupported'].includes(o.expected_gate))throw Error('quota expected gate');
  if(o.expected_intent!=='change'&&(o.required.length||o.expected_added_regions.length||o.expected_added_edges.length))throw Error('quota control target');
 }
 return true;
}
function noExcess(graph,oracle){
 const subset=(got,wanted)=>{const rest=wanted.map(v=>JSON.stringify(canonical(v)));return got.every(v=>{const i=rest.indexOf(JSON.stringify(canonical(v)));if(i<0)return false;rest.splice(i,1);return true;});};
 return graph.existing_semantics_preserved&&graph.no_other_new_semantics&&graph.clean_new_regions&&graph.clean_new_edges&&subset(graph.actual_added_regions,oracle.expected_added_regions)&&subset(graph.actual_added_edges,oracle.expected_added_edges);
}
export function gradeQuotaReady(o,oracle){
 if(!validStock(oracle.parts)||!validRequirements(oracle.required)||stockDifference(oracle.required,oracle.parts).length)throw Error('R incomplete oracle supply');
 const graph=gradeGraph(o.initial_records,o.final_records,oracle),supply=validStock(o.parts)&&sameValue(o.parts,oracle.parts)&&sameValue(o.supplied_required,oracle.required);
 const policy=['open','quota'].includes(o.goal_parts_policy),expected=policy?(o.goal_parts_policy==='open'?o.parts:referenceQuota(o.parts,o.supplied_required)):null;
 const offered=expected?.map(({key,purpose,label})=>({key,purpose,label}));
 const actualOffers=Array.isArray(o.goal_offers)&&o.goal_offers.every(value=>sameValue(value,offered));
 const selected=Array.isArray(o.selected)&&new Set(o.selected.map(s=>s.key)).size===o.selected.length&&o.selected.every(s=>expected?.some(p=>p.key===s.key));
 const mechanical=supply&&policy&&actualOffers&&selected&&o.quota_proof_valid===true;
 return{contract_valid:mechanical,graph_exact:graph.graph_exact,graph,no_false_adoption:noExcess(graph,oracle),existing_semantics_preserved:graph.existing_semantics_preserved,
  supplied_inventory_complete:supply,goal_parts_policy:o.goal_parts_policy,quota_offers_exact:actualOffers,selected_one_use:selected,
  initial_log_sha256:typeof o.initial_log==='string'?hash(o.initial_log):null,supply_sha256:supply?hash(o.parts):null,required_sha256:supply?hash(o.supplied_required):null,
  deadline:Number.isFinite(o.elapsedMs)&&o.elapsedMs>=0&&o.elapsedMs<=180000,
  scope:'conditional native expression only; open extra/wrong graph is an outcome, never filtered from pair admission'};
}
export function gradeQuotaOrdinary(o,oracle,parts){
 const frozen=gradeFrontierGoal(o,oracle,parts),quota=o.goal_parts_policy==='quota'&&o.quota_proof_valid===true;
 return{...frozen,goal_parts_policy:o.goal_parts_policy,quota_mechanism_valid:quota,contract_valid:frozen.contract_valid&&quota,
  scope:'unchanged frozen per-cell /2 and /3 Goal meaning plus independently audited quota mechanism; new whole-six aggregation only'};
}
const valid=r=>r?.valid_execution===true&&r.grade?.contract_valid===true;
const painted=r=>r?.paint_status==='PASS'&&r?.persisted_raw_equal===true&&r.grade.deadline===true;
const rSuccess=r=>valid(r)&&painted(r)&&r.grade.graph_exact===true&&r.grade.no_false_adoption===true;
const eSuccess=r=>valid(r)&&painted(r)&&r.grade.gate_correct===true&&r.grade.graph_exact===true&&r.grade.non_regression_guards===true
 &&(['ambiguous','no-change','unsupported'].includes(r.grade.expected_gate)||r.grade.full_required_exact===true&&r.grade.missing_exact_minimal===true);
export function summarizeQuotaAxis(axis,rows,oracles,{phaseKind='fresh'}={}){
 if(!['R','E'].includes(axis)||!['public','fresh'].includes(phaseKind))throw Error('quota summary scope');
 const arms=axis==='R'?['O','Q']:['B','C'],wanted=phaseKind==='public'?1:axis==='R'?2:6;
 const complete=oracles.length===wanted&&rows.length===wanted*2&&new Set(rows.map(r=>r.id+'/'+r.arm)).size===rows.length&&oracles.every(o=>arms.every(a=>rows.some(r=>r.id===o.id&&r.arm===a)))
  &&rows.every(r=>oracles.some(o=>o.id===r.id)&&arms.includes(r.arm)&&r.method===QUOTA_METHODS[r.arm]&&r.generation_policy===QUOTA_GENERATIONS[r.arm]&&r.goal_parts_policy===QUOTA_GOAL_POLICIES[r.arm]);
 const allValid=complete&&rows.every(valid),baseline=rows.filter(r=>r.arm===arms[0]),candidate=rows.filter(r=>r.arm===arms[1]);
 if(axis==='R'){
  const pairs=oracles.map(o=>{const a=baseline.find(r=>r.id===o.id),b=candidate.find(r=>r.id===o.id),matching=valid(a)&&valid(b)&&a.grade.supply_sha256===b.grade.supply_sha256&&a.grade.required_sha256===b.grade.required_sha256&&a.grade.initial_log_sha256===b.grade.initial_log_sha256;
   const eligible=matching&&painted(a)&&painted(b)&&a.grade.existing_semantics_preserved&&b.grade.existing_semantics_preserved,as=rSuccess(a),bs=rSuccess(b);
   return{id:o.id,eligible:Boolean(eligible),matching_complete_supply:Boolean(matching),open_success:as,quota_success:bs,open_false_adoption:valid(a)?!a.grade.no_false_adoption:null,assembly_gain:Boolean(eligible&&!as&&bs),extra_adoption_fixed:Boolean(eligible&&!a.grade.no_false_adoption&&bs),regression:Boolean(eligible&&as&&!bs),excluded_from_causal_only:!eligible};});
  const quotaCorrect=candidate.filter(rSuccess).length,openCorrect=baseline.filter(rSuccess).length,gains=pairs.filter(p=>p.assembly_gain).length,regressions=pairs.filter(p=>p.regression).length,allAdmitted=complete&&pairs.every(p=>p.eligible);
  const quality=allValid&&allAdmitted&&quotaCorrect===wanted,gate=quality;
  return{complete,total_pairs:wanted,valid_cells:rows.filter(valid).length,open_correct:openCorrect,quota_correct:quotaCorrect,assembly_gains:gains,extra_adoptions_fixed:pairs.filter(p=>p.extra_adoption_fixed).length,regressions,admitted_pairs:pairs.filter(p=>p.eligible).length,pairs,
   quality_criteria:quality?'PASS':'UNMET',public_gate:phaseKind==='public'?(gate?'PASS':'UNMET'):null,
   effect_criteria:phaseKind==='fresh'&&quality&&gains>=1&&regressions===0?'PASS':'UNMET',
   no_effect_criteria_pending_integrity:phaseKind==='fresh'&&quality&&openCorrect===2&&gains===0&&regressions===0?'PASS':'UNPROVEN',
   scope:'finite conditional expression; open wrong additions remain outcomes; no Type or ordinary interpretation inference'};
 }
 const pairs=oracles.map(o=>{const a=baseline.find(r=>r.id===o.id),b=candidate.find(r=>r.id===o.id),eligible=valid(a)&&valid(b)&&painted(a)&&painted(b)&&a.grade.eligible&&b.grade.eligible&&sameValue(a.grade.initial_literal,b.grade.initial_literal),as=eSuccess(a),bs=eSuccess(b);
  const gain=o.expected_gate==='missing'&&eligible&&!as&&a.grade.raw_unchanged&&bs&&b.grade.proposal_policy_implemented&&b.grade.proposal_present&&b.grade.verification_accepted;
  return{id:o.id,eligible:Boolean(eligible),baseline_success:as,candidate_success:bs,missing_gain:Boolean(gain),regression:as&&!bs,excluded_from_causal_only:!eligible};});
 const missing=oracles.filter(o=>o.expected_gate==='missing'),shape=phaseKind==='public'?oracles.length===1&&missing.length===1:oracles.length===6&&missing.length===2&&oracles.filter(o=>o.expected_gate==='sufficient').length===2&&oracles.filter(o=>o.expected_intent!=='change').length===2;
 const gains=pairs.filter(p=>p.missing_gain).length,regressions=pairs.filter(p=>p.regression).length,allGuards=complete&&rows.every(r=>r.grade?.non_regression_guards===true),noFalse=complete&&rows.every(r=>r.grade?.no_false_adoption===true),allMissing=missing.every(o=>pairs.find(p=>p.id===o.id)?.eligible);
 const quality=allValid&&shape&&candidate.length===wanted&&candidate.every(eSuccess)&&allGuards&&noFalse;
 const effect=allValid&&shape&&allMissing&&gains===(phaseKind==='public'?1:2)&&regressions===0&&allGuards&&noFalse&&rows.every(painted);
 const noEffect=phaseKind==='fresh'&&allValid&&shape&&allMissing&&gains===0&&regressions===0&&allGuards&&noFalse&&rows.every(painted);
 const counts=rs=>Object.fromEntries(['sufficient','missing','ambiguous','no-change'].map(g=>[g,{correct:rs.filter(r=>r.grade?.expected_gate===g&&eSuccess(r)).length,total:oracles.filter(o=>o.expected_gate===g).length}]));
 return{complete,total_pairs:wanted,valid_cells:rows.filter(valid).length,baseline:counts(baseline),candidate:counts(candidate),baseline_success:baseline.filter(eSuccess).length,candidate_success:candidate.filter(eSuccess).length,missing_gains:gains,regressions,admissible_missing_pairs:missing.filter(o=>pairs.find(p=>p.id===o.id)?.eligible).length,all_arm_guards:allGuards,no_false_adoption:noFalse,all_missing_admitted:allMissing,pairs,
  quality_criteria:quality?'PASS':'UNMET',public_gate:phaseKind==='public'?(quality&&effect?'PASS':'UNMET'):null,effect_criteria:effect?'PASS':'UNMET',no_effect_criteria_pending_integrity:noEffect?'PASS':'UNPROVEN',
  scope:'all six ordinary pairs retained; both paths quota; supplementation effect separate from R assembly effect and prior frontier taxonomy'};
}
export function classifyQuotaAxis({phaseKind,axis,binding,raw,phase,ciRaw=null,ciReplay=null}){
 if(!['public','final'].includes(phaseKind)||!['R','E'].includes(axis))throw Error('quota classification scope');
 const unproven={quality:'UNPROVEN',effect:'UNPROVEN',...(phaseKind==='public'?{public_gate:'UNPROVEN'}:{})};
 const identity=x=>x?.status==='PASS'&&x.schema==='voice-ui.quota-cycle-raw-audit/1'&&x.axis===axis;
 if(binding?.status!=='PASS'||phase?.status!=='PASS'||!identity(raw)||!identity(ciRaw)||!sameValue(raw.semantic,ciRaw.semantic))return unproven;
 const s=raw.semantic,count=phaseKind==='public'?2:axis==='R'?4:12;
 const admitted=x=>x.phase_kind===(phaseKind==='public'?'public':'fresh')&&x.planned===count&&x.consumed===count&&x.complete===true&&x.all_valid_execution===true&&x.admissible_for_semantic_claim===true&&x.rows?.length===count&&x.rows.every(r=>valid(r)&&r.method===QUOTA_METHODS[r.arm]&&r.generation_policy===QUOTA_GENERATIONS[r.arm]&&r.goal_parts_policy===QUOTA_GOAL_POLICIES[r.arm]
  &&['PASS','UNMET'].includes(r.paint_status)&&Number.isFinite(r.goal_elapsedMs)&&r.goal_elapsedMs>=0&&['PASS','UNMET'].includes(r.goal_deadline_status)&&typeof r.persisted_raw_equal==='boolean');
 const paint=[raw.replay,ciRaw.replay,ciReplay].every(x=>x?.status==='PASS'&&['PASS','UNMET'].includes(x.recorded_paint_status));
 if(phaseKind==='public')return{quality:'PUBLIC_REGRESSION_ONLY',effect:'PUBLIC_REGRESSION_ONLY',public_gate:admitted(raw)&&admitted(ciRaw)&&paint?s.public_gate:'UNMET'};
 if(!admitted(raw)||!admitted(ciRaw)||!paint)return unproven;
 if(!['PASS','UNMET'].includes(s.quality_criteria)||!['PASS','UNMET'].includes(s.effect_criteria))return unproven;
 const effect=s.effect_criteria==='PASS'?(axis==='R'?'FINITE_ASSEMBLY_EFFECT_DEMONSTRATED':'FINITE_SUPPLEMENTATION_EFFECT_DEMONSTRATED')
  :s.no_effect_criteria_pending_integrity==='PASS'?(axis==='R'?'NO_EFFECT_IN_REGISTERED_EXPRESSION_PAIRS':'NO_EFFECT_IN_REGISTERED_MISSING_PAIRS')
  :axis==='R'?s.admitted_pairs===2?'UNMET':'UNPROVEN':s.all_missing_admitted?'UNMET':'UNPROVEN';
 return{quality:s.quality_criteria==='PASS'?'FINITE_CRITERIA_PASS':'UNMET',effect};
}
