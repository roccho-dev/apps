import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequirementInput, requirementsSchedule, stockDifference, decodeRequiredSlots, validFactors,
  verifierDecision, gradeFullRequired, gradeVerification, readRequirementInspection, gradeRequirementGoal,
  summarizeRequirementAxis } from './requirements-cycle-score.mjs';

// Public regression/synthetic fixtures only. This file never opens a sealed pool.
const dir = process.env.POC_REQUIREMENTS_FIXTURES ?? path.dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
const inputs = Object.fromEntries(['V6', 'F6', 'E2'].map(k => [k[0], load(`requirements-cycle-public-${k}${k[0] === 'E' ? '.v2' : ''}.inputs.json`)]));
const oracles = Object.fromEntries(['V6', 'F6', 'E2'].map(k => [k[0], load(`requirements-cycle-public-${k}${k[0] === 'E' ? '.v2' : ''}.oracle.json`)]));
const parts = oracles.E.stock_parts;
const uuid = '7732c832-e278-437e-9a3c-a2ccdf671bb8';
const factors = (complete = 'complete', intent = 'change', confidence = 0.9) => ({
  intent: { choice: intent, confidence }, labels: { choice: 'missing', confidence },
  capacity: { choice: 'within', confidence }, completeness: { choice: complete, confidence },
});
const slots = rows => Object.fromEntries([1, 2, 3].map((n, i) => ['required' + n, rows[i]
  ? { ...rows[i], quantity: String(rows[i].quantity) } : { label: 'bounded irrelevant filler', kind: 'none', quantity: '2' }]));
const full = required => ({ schema: 'voice-ui.parts.requirements/2', request_id: uuid, slots: slots(required), required });
const verify = (required, f = factors()) => ({ schema: 'voice-ui.parts.verification/2', request_id: uuid, required, factors: f, ...verifierDecision(f) });
const initialRecords = inputs.E.fixture_contract.base_records;
const target = oracle => {
  const final = structuredClone(initialRecords), ids = new Map(); let n = 0;
  for (const r of oracle.expected_added_regions) {
    const id = 'generated-' + ++n;
    const parent = r.parent.startsWith('fixture:') ? r.parent.slice(8) : ids.get(r.parent.slice(6));
    final.push({ type: 'region', id, parent, label: r.label, kind: r.kind, bounds: [12 + n * 200, 36, 140, 64], summary: '' });
    ids.set(r.label, id);
  }
  for (const r of oracle.expected_added_edges) final.push({ type: 'relation', id: 'edge-' + ++n,
    from: r.from.startsWith('fixture:') ? r.from.slice(8) : ids.get(r.from.slice(6)),
    to: r.to.startsWith('fixture:') ? r.to.slice(8) : ids.get(r.to.slice(6)), kind: r.kind, label: r.label });
  return final;
};
function observation(oracle, enabled) {
  const required = enabled ? oracle.required : [];
  const inspection = { schema: 'voice-ui.parts.inspection/2', request_id: uuid,
    mode: enabled ? 'adaptive-v2' : 'literal-v2', initial: { decision: { choice: 'unknown', confidence: null },
      factors: factors('incomplete'), literal: { recognized: false, required: [], spans: [] },
      observation: { valid: true, status: 'unsupported-syntax' } },
    proposal: enabled ? { slots: slots(required), required } : null,
    verification: enabled ? factors() : null, required, missing: stockDifference(required, parts) };
  return { inspection, decision: enabled ? { choice: inspection.missing.length ? 'missing' : 'sufficient', confidence: 0.9 }
    : { choice: 'unknown', confidence: null }, initial_records: initialRecords,
    final_records: enabled ? target(oracle) : initialRecords, initial_log: 'before\n', final_log: enabled ? 'after\n' : 'before\n',
    initial_head: 'before', final_head: enabled ? 'after' : 'before', preparations: enabled && inspection.missing.length ? 1 : 0,
    typellm_sends: enabled ? 1 : 0, elapsedMs: 1200 };
}
const grade = (o, oracle) => gradeRequirementGoal(o, oracle, parts);
const rowsFor = () => oracles.E.cases.flatMap(o => [false, true].map(enabled => ({ id: o.id,
  method: enabled ? 'adaptive-v2' : 'literal-v2', valid_execution: true, grade: grade(observation(o, enabled), o),
  paint_status: 'PASS', persisted_raw_equal: true })));

test('strict new inputs and deterministic arm order reject legacy/ignored scheduling and oracle fields', () => {
  for (const input of Object.values(inputs)) assert.equal(validateRequirementInput(input), true);
  assert.deepEqual(requirementsSchedule(inputs.E).map(r => r.arm), ['B', 'C', 'C', 'B']);
  assert.ok(requirementsSchedule(inputs.V).every(r => r.arm === 'V' && r.method === 'verify'));
  for (const mutate of [p => { p.schema = 'voice-ui.component-axes-input/1'; }, p => { p.arm_order = ['X']; },
    p => { p.cases[0].expected_gate = 'missing'; }, p => { p.cases.push(p.cases[0]); },
    p => { p.fixture_contract.fixtures.unused = { extra_records: [], extra_pins: [], oracle: true }; }]) {
    const changed = structuredClone(inputs.E); mutate(changed); assert.throws(() => validateRequirementInput(changed));
  }
});
test('full NEW quantity is not missing quantity, and existing Working never replenishes stock', () => {
  const required = [{ label: 'API', kind: 'step', quantity: 3 }];
  assert.deepEqual(stockDifference(required, parts), [{ label: 'API', kind: 'step', occurrence: 1 }, { label: 'API', kind: 'step', occurrence: 2 }]);
  const oracle = { required, expected_gate: 'missing' };
  assert.equal(gradeFullRequired(full(required), oracle, parts).exact, true);
  const subtracted = [{ label: 'API', kind: 'step', quantity: 2 }];
  assert.equal(gradeFullRequired(full(subtracted), oracle, parts).exact, false);
  assert.throws(() => stockDifference([{ label: 'API', kind: 'step', quantity: 4 }], parts));
});
test('closed scalar slots refuse duplicates, gaps, invalid active counts and extra fields while ignoring bounded none padding', () => {
  const base = slots([{ label: 'new', kind: 'step', quantity: 1 }]);
  assert.deepEqual(decodeRequiredSlots(base), [{ label: 'new', kind: 'step', quantity: 1 }]);
  for (const mutate of [s => { s.required1.quantity = 1; }, s => { s.required1.quantity = '0'; },
    s => { s.required1.label = ''; }, s => { s.required1.kind = 'operator'; }, s => { s.required1.raw = 'private'; },
    s => { s.required2 = { ...s.required1 }; }, s => { s.required3 = { label: 'later', kind: 'data', quantity: '1' }; },
    s => { s.required2.label = 'x'.repeat(121); }, s => { s.required2.quantity = '4'; }]) {
    const changed = structuredClone(base); mutate(changed); assert.equal(decodeRequiredSlots(changed), null);
  }
});
test('all named factors are validated and min confidence preserves each weak witness including rejected verification', () => {
  const proposed = inputs.V.cases[0].required, oracle = oracles.V.cases[0];
  assert.equal(gradeVerification(verify(proposed), oracle, proposed).correct, true);
  for (const name of ['intent', 'labels', 'capacity', 'completeness']) for (const bad of [NaN, -0.1, 1.1, '0.9']) {
    const f = factors(); f[name].confidence = bad; assert.equal(validFactors(f), false);
    assert.equal(gradeVerification(verify(proposed, f), oracle, proposed).contract_valid, false);
  }
  for (const name of ['intent', 'completeness']) {
    const f = factors(); f[name].confidence = 0.49;
    assert.deepEqual(verifierDecision(f), { accepted: false, confidence: 0.49 });
  }
  const f = factors('incomplete'); f.intent.confidence = 0.51; f.completeness.confidence = 0.72;
  assert.deepEqual(verifierDecision(f), { accepted: false, confidence: 0.51 });
});
test('verification preserves supplied proposal identity and does not confuse syntactic legality with correctness', () => {
  const negative = oracles.V.cases[1], proposed = inputs.V.cases[1].required;
  assert.equal(gradeVerification(verify(proposed), negative, proposed).false_acceptance, true);
  assert.equal(gradeVerification(verify(proposed, factors('incomplete')), negative, proposed).correct, true);
  const changed = verify(proposed); changed.required = [];
  assert.equal(gradeVerification(changed, negative, proposed).contract_valid, false);
  changed.required = proposed; changed.accepted = false;
  assert.equal(gradeVerification(changed, negative, proposed).contract_valid, false);
});
test('inspection recomputes exact stock difference and retains initial unknown independently of verified final judgment', () => {
  const oracle = oracles.E.cases[0], o = observation(oracle, true);
  const read = readRequirementInspection(o.inspection, oracle.utterance, parts);
  assert.equal(read.eligible, true); assert.equal(read.verification.accepted, true);
  assert.equal(o.inspection.initial.decision.choice, 'unknown'); assert.equal(o.decision.choice, 'missing');
  for (const mutate of [i => { i.missing.pop(); }, i => { i.proposal.required = []; },
    i => { i.initial.factors.labels.choice = 'guess'; }, i => { i.verification.capacity.confidence = 2; },
    i => { i.mode = 'literal-v2'; }, i => { i.proposal = undefined; }]) {
    const changed = structuredClone(o.inspection); mutate(changed);
    assert.equal(readRequirementInspection(changed, oracle.utterance, parts), null);
  }
});
test('correct target cannot launder a rejected proposal, wrong parent, stale literal evidence or false new semantics', () => {
  const oracle = oracles.E.cases[0]; assert.equal(grade(observation(oracle, true), oracle).graph_exact, true);
  const rejected = observation(oracle, true); rejected.inspection.verification.completeness.choice = 'incomplete';
  assert.equal(grade(rejected, oracle).contract_valid, false);
  const wrongParent = observation(oracle, true); wrongParent.final_records.at(-1).parent = 'other';
  assert.equal(grade(wrongParent, oracle).graph_exact, false); assert.equal(grade(wrongParent, oracle).no_false_adoption, false);
  const fake = observation(oracle, true); fake.final_records.push({ type: 'operator', id: 'invented' });
  assert.equal(grade(fake, oracle).no_false_adoption, false);
  const stale = observation(oracle, true); stale.inspection.initial.literal.spans = [{ start: 0, end: 1, source: 'bad', label: 'bad', kind: 'step', quantity: 1 }];
  assert.equal(grade(stale, oracle).contract_valid, false);
});
test('true sufficient unknown syntax may pay for interpretation but must add no candidate; B-known cost remains visible', () => {
  const source = oracles.V.cases.find(c => c.expected_gate === 'sufficient');
  const oracle = { ...source, syntax_stratum: 'natural-alternate' };
  const o = observation(oracle, true), g = grade(o, oracle);
  assert.equal(g.graph_exact, true); assert.equal(g.true_sufficient_zero_candidates, true);
  assert.equal(g.non_regression_guards, true); assert.equal(g.interpretation_type_calls, 1);
  const known = grade(o, { ...oracle, syntax_stratum: 'B-known' });
  assert.equal(known.known_syntax_type_free, false); assert.equal(known.non_regression_guards, false);
});
test('a verifier control or weak intent stays a valid stopped observation and cannot authorize graph adoption', () => {
  const oracle = oracles.E.cases[0];
  for (const control of [true, false]) {
    const o = observation(oracle, true);
    o.inspection.verification.intent = control ? { choice: 'ambiguous', confidence: 0.95 } : { choice: 'change', confidence: 0.49 };
    o.decision = control ? { choice: 'ambiguous', confidence: 0.95 } : { choice: 'missing', confidence: 0.49 };
    o.final_records = o.initial_records; o.final_log = o.initial_log; o.final_head = o.initial_head; o.preparations = 0;
    const g = grade(o, oracle);
    assert.equal(g.contract_valid, true); assert.equal(g.graph_exact, false); assert.equal(g.gate_correct, false);
    assert.equal(g.stop_authorization_guard, true);
    o.final_records = target(oracle); o.final_log = 'after\n'; o.final_head = 'after';
    assert.equal(grade(o, oracle).stop_authorization_guard, false);
  }
});
test('same-head E gain needs two actual eligible arms; eligibility mismatch affects causal scope only', () => {
  const rows = rowsFor(), good = summarizeRequirementAxis('E', rows, oracles.E.cases, { phaseKind: 'public' });
  assert.equal(good.missing_gains, 2); assert.equal(good.effect_criteria, 'PASS');
  const changed = structuredClone(rows); changed[0].grade.eligible = false;
  const s = summarizeRequirementAxis('E', changed, oracles.E.cases, { phaseKind: 'public' });
  assert.equal(s.total_pairs, 2); assert.equal(s.missing_gains, 1); assert.equal(s.enabled.missing.total, 2);
  assert.equal(s.enabled.missing.correct, 2); assert.equal(s.effect_criteria, 'UNMET');
});
test('invalid cells, wrong paint, persistence failures and partial panels cannot become finite PASS', () => {
  for (const mutate of [rs => { rs[1].valid_execution = false; }, rs => { rs[1].paint_status = 'UNMET'; },
    rs => { rs[1].persisted_raw_equal = false; }, rs => { rs[1].grade.deadline = false; }, rs => { rs.pop(); }]) {
    const rows = rowsFor(); mutate(rows);
    assert.equal(summarizeRequirementAxis('E', rows, oracles.E.cases, { phaseKind: 'public' }).effect_criteria, 'UNMET');
  }
  assert.equal(summarizeRequirementAxis('E', rowsFor(), oracles.E.cases, { phaseKind: 'fresh' }).effect_criteria, 'UNMET');
});
