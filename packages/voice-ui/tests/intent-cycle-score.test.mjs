import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {validateIntentInput,intentSchedule,gradeInitialIntent,normalizeInitialIntent,summarizeIntentAxis,stockDifference,
 gradeFullRequired,gradeVerification,gradeRequirementGoal} from './intent-cycle-score.mjs';
import * as frozen from './requirements-cycle-score.mjs';
const root=process.env.POC_INTENT_PREREG_ROOT??path.dirname(fileURLToPath(import.meta.url));
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const input=read('intent-cycle-public-G0-10.inputs.json'),oracle=read('intent-cycle-public-G0-10.oracle.json'),pre=read('intent-cycle-public-literal-preflight.json');
function fixture(o){return [...input.fixture_contract.base_records,...input.fixture_contract.fixtures[o.fixture].extra_records];}
function observation(o){const records=fixture(o);return {initial_records:records,final_records:structuredClone(records),initial_log:'fixed\n',final_log:'fixed\n',initial_head:'fixed-head',final_head:'fixed-head',typellm_sends:0};}
function response(o){const actual=structuredClone(pre.G0.find(r=>r.id===o.id)),factors={intent:{choice:o.expected_intent,confidence:.8},labels:{choice:'available',confidence:.8},capacity:{choice:'within',confidence:.8},
 completeness:{choice:o.expected_completeness??'complete',confidence:.8}};
 const initial={factors,literal:{recognized:actual.recognized,required:actual.required,spans:actual.spans},observation:{valid:actual.valid,status:actual.status}};
 initial.decision=normalizeInitialIntent(initial,o.utterance,oracle.stock_parts,fixture(o));
 return {...initial.decision,inspection:{schema:'voice-ui.parts.inspection/2',request_id:'00000000-0000-4000-8000-000000000000',mode:'literal-v2',initial,proposal:null,verification:null,required:initial.literal.required,missing:stockDifference(initial.literal.required,oracle.stock_parts)}};
}
test('explicit new G0 schedule and ten-case public denominator; no schema/arm/default aliases',()=>{
 assert.equal(validateIntentInput(input),true);assert.equal(intentSchedule(input).length,10);
 assert.ok(intentSchedule(input).every(r=>r.axis==='G0'&&r.arm==='G0'&&r.method==='literal-v2'&&r.generation_policy===null));
 for(const mutate of[x=>x.schema='voice-ui.dependency-cycle-input/1',x=>x.cases.pop(),x=>x.cases[0].arms=['B'],x=>x.cases[0].arms=['G0','G0'],x=>x.parent_inputs_sha256='0'.repeat(64),x=>x.cases[0].extra=true]){
  const bad=structuredClone(input);mutate(bad);assert.throws(()=>validateIntentInput(bad));}
 assert.throws(()=>validateIntentInput(input,{phaseKind:'fresh'}));
});
test('all ten independent G0 oracles accept internally coherent evidence, including inherited nonempty E provenance',()=>{
 assert.ok(oracle.cases[0].expected_added_regions.length>0);
 for(const o of oracle.cases){const g=gradeInitialIntent(response(o),o,oracle.stock_parts,observation(o));assert.equal(g.contract_valid,true,o.id);assert.equal(g.correct,true,o.id);}
});
test('inherited E target never grants G0 adoption authority; exact log/head/records and Type0 are mandatory',()=>{
 const o=oracle.cases[0],r=response(o);
 for(const mutate of[x=>x.final_log+='added\n',x=>x.final_head='changed',x=>x.final_records.push({type:'region',id:'new',label:'API',kind:'step',parent:'container',summary:''}),x=>x.typellm_sends=1,x=>delete x.initial_head]){
  const obs=observation(o);mutate(obs);assert.equal(gradeInitialIntent(r,o,oracle.stock_parts,obs).correct,false);}
});
test('same changed normalized decision in HTTP and initial receipt is rejected against unchanged factor evidence',()=>{
 const o=oracle.cases[0],r=response(o);r.choice='sufficient';r.confidence=.8;r.inspection.initial.decision={choice:'sufficient',confidence:.8};
 assert.equal(gradeInitialIntent(r,o,oracle.stock_parts,observation(o)).contract_valid,false);
});
test('intrinsic ambiguity remains distinct from literal omission; weak confidence and false completeness fail the fixed gate',()=>{
 const o=oracle.cases[0];for(const mutate of[x=>x.inspection.initial.factors.intent={choice:'ambiguous',confidence:.8},x=>x.inspection.initial.factors.intent.confidence=.49,x=>x.inspection.initial.factors.completeness={choice:'complete',confidence:.8},x=>x.inspection.initial.factors.completeness.confidence=.49]){
  const r=response(o);mutate(r);const n=normalizeInitialIntent(r.inspection.initial,o.utterance,oracle.stock_parts,fixture(o));r.inspection.initial.decision=n;r.choice=n.choice;r.confidence=n.confidence;
  assert.equal(gradeInitialIntent(r,o,oracle.stock_parts,observation(o)).correct,false);}
 const negative=oracle.cases[6],r=response(negative);assert.equal(gradeInitialIntent(r,negative,oracle.stock_parts,observation(negative)).correct,true);
 r.inspection.initial.factors.intent={choice:'change',confidence:.9};const n=normalizeInitialIntent(r.inspection.initial,negative.utterance,oracle.stock_parts,fixture(negative));r.inspection.initial.decision=n;r.choice=n.choice;r.confidence=n.confidence;
 assert.equal(gradeInitialIntent(r,negative,oracle.stock_parts,observation(negative)).correct,false);
});
test('closed inspection and deterministic shortage are mandatory; unknown evidence cannot become a quality pass',()=>{
 const o=oracle.cases[3];for(const mutate of[x=>x.inspection.missing=[],x=>x.inspection.initial.literal.spans[0].source='tampered',x=>x.inspection.initial.factors.intent.confidence=NaN,x=>x.extra='raw',x=>x.inspection.mode='adaptive-v2']){
  const r=response(o);mutate(r);assert.equal(gradeInitialIntent(r,o,oracle.stock_parts,observation(o)).contract_valid,false);}
 const weak={...o,minimum_intent_confidence:.1};assert.throws(()=>gradeInitialIntent(response(o),weak,oracle.stock_parts,observation(o)));
});
test('complete G0 numerator cannot ignore missing/invalid/duplicate cells or substitute V/F/E criteria',()=>{
 const rows=oracle.cases.map(o=>({id:o.id,arm:'G0',method:'literal-v2',generation_policy:null,valid_execution:true,grade:gradeInitialIntent(response(o),o,oracle.stock_parts,observation(o))}));
 assert.equal(summarizeIntentAxis('G0',rows,oracle.cases,{phaseKind:'public'}).intent_criteria,'PASS');
 for(const mutate of[x=>x.pop(),x=>x[0].valid_execution=false,x=>x[0]=x[1],x=>x[0].grade.correct=false,x=>x[0].generation_policy='dependent']){const bad=structuredClone(rows);mutate(bad);assert.equal(summarizeIntentAxis('G0',bad,oracle.cases,{phaseKind:'public'}).intent_criteria,'UNMET');}
 assert.throws(()=>summarizeIntentAxis('G0',rows,oracle.cases,{phaseKind:'fresh'}));
});
test('V/F/E per-cell functions are the exact frozen functions, not reimplemented target semantics',()=>{
 assert.equal(gradeFullRequired,frozen.gradeFullRequired);assert.equal(gradeVerification,frozen.gradeVerification);assert.equal(gradeRequirementGoal,frozen.gradeRequirementGoal);
});
test('existing-endpoint readiness counts distinct non-group labels, never group names or duplicate named node IDs',()=>{
 const initial={factors:{intent:{choice:'change',confidence:.8},labels:{choice:'available',confidence:.8},capacity:{choice:'within',confidence:.8},completeness:{choice:'complete',confidence:.8}},
 literal:{recognized:false,required:[],spans:[]},observation:{valid:true,status:'unsupported-syntax'}};
 const groups=[{type:'region',id:'a',label:'OCI',kind:'group'},{type:'region',id:'b',label:'Other',kind:'group'}];
 assert.equal(normalizeInitialIntent(initial,'OCIからOtherへ',oracle.stock_parts,groups).choice,'unknown');
 const duplicates=[{type:'region',id:'x',label:'API',kind:'step'},{type:'region',id:'y',label:'API',kind:'step'}];
 assert.equal(normalizeInitialIntent(initial,'APIを接続',oracle.stock_parts,duplicates).choice,'unknown');
 const endpoints=[...duplicates,{type:'region',id:'z',label:'DB',kind:'data'}];
 assert.equal(normalizeInitialIntent(initial,'APIからDBへ',oracle.stock_parts,endpoints).choice,'sufficient');
});
