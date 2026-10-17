import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDependencyInput, dependencySchedule, summarizeDependencyAxis, DEPENDENCY_METHODS, DEPENDENCY_POLICIES } from './dependency-cycle-score.mjs';
const root = process.env.POC_DEPENDENCY_PREREG_ROOT ?? path.dirname(fileURLToPath(import.meta.url));
const parentRoot = process.env.POC_DEPENDENCY_PARENT_ROOT ?? root;
const read = name => fs.readFileSync(path.join(root, name));
const clone = x => structuredClone(x);
const input = JSON.parse(read('dependency-cycle-public-F6.inputs.json'));
const options = { phaseKind: 'public', parentProjectionBytes: fs.readFileSync(path.join(parentRoot, 'requirements-cycle-public-F6.inputs.json')) };
test('immutable public wrappers preserve cases and alternate one explicit I/D order', () => {
  assert.equal(validateDependencyInput(input, options), true);
  assert.deepEqual(dependencySchedule(input).slice(0, 4).map(x => [x.arm, x.generation_policy, x.method]),
    [['I', 'independent', 'full-required'], ['D', 'dependent', 'full-required'], ['D', 'dependent', 'full-required'], ['I', 'independent', 'full-required']]);
});
test('unknown schema/parent/phase/denominator and ignored schedule forms fail closed', () => {
  const mutations = [x => x.schema = 'voice-ui.requirements-cycle-input/1', x => delete x.parent_inputs_sha256,
    x => x.parent_inputs_sha256 = '0'.repeat(64), x => x.cases.pop(), x => x.cases[0].arms = ['D', 'I'],
    x => x.cases[0].arms = ['I', 'I'], x => x.cases[0].arms = ['I', 'D', 'X'],
    x => x.arm_order = ['I', 'D'], x => x.cases[0].arms = { I: 1, D: 2 }, x => x.cases[0].arms = [['I', 'D']],
    x => x.cases[0].utterance += ' changed', x => x.fixture_contract.base_pins[0].bounds[0]++ ];
  for (const mutate of mutations) { const changed = clone(input); mutate(changed); assert.throws(() => validateDependencyInput(changed, options)); }
  assert.throws(() => validateDependencyInput(input, { ...options, phaseKind: 'correction' }));
});
test('public input cannot be relabelled fresh; fresh denominators and D-only are fixed', () => {
  assert.throws(() => validateDependencyInput(input, { phaseKind: 'fresh' }));
  const fresh = clone(input); fresh.parent_inputs_sha256 = null;
  fresh.cases = Array.from({ length: 8 }, (_, n) => ({ ...clone(input.cases[n % 6]), id: 'T' + n, arms: ['D'] }));
  assert.equal(validateDependencyInput(fresh, { phaseKind: 'fresh' }), true);
  for (const mutate of [x => x.cases.pop(), x => x.cases[0].arms = ['I', 'D'], x => x.parent_inputs_sha256 = input.parent_inputs_sha256]) {
    const changed = clone(fresh); mutate(changed); assert.throws(() => validateDependencyInput(changed, { phaseKind: 'fresh' }));
  }
});
const grade = (yes, valid = true) => ({ contract_valid: valid, exact: yes, minimal: yes, stock_difference: [], true_sufficient: false });
const fOracle = input.cases.map(c => ({ id: c.id, expected_gate: 'missing' }));
const fRows = () => dependencySchedule(input).map(p => ({ ...p, valid_execution: true, grade: grade(true) }));
test('invalid independent arm is operational validity gain, never semantic gain or denominator shrink', () => {
  const rows = fRows(); rows[0].valid_execution = false; rows[0].grade = grade(false, false);
  const got = summarizeDependencyAxis('F', rows, fOracle, { phaseKind: 'public' });
  assert.equal(got.by_arm.I.denominator, 6); assert.equal(got.by_arm.I.exact_valid, 5);
  assert.equal(got.by_arm.D.exact_valid, 6); assert.equal(got.validity_gains, 1); assert.equal(got.semantic_gains, 0);
  assert.equal(got.admissible_semantic_pairs, 5); assert.equal(got.candidate_requirements_criteria, 'PASS');
});
test('valid semantic gain/regression distinct; policy/arm/duplicate omission cannot pass a panel', () => {
  const rows = fRows(); rows[0].grade = grade(false); rows[2].grade = grade(false);
  const got = summarizeDependencyAxis('F', rows, fOracle, { phaseKind: 'public' });
  assert.equal(got.semantic_gains, 1); assert.equal(got.semantic_regressions, 1);
  for (const mutate of [x => x.pop(), x => x[0].generation_policy = 'dependent', x => x[0] = clone(x[1]), x => x[0].method = 'dependent']) {
    const changed = clone(rows); mutate(changed); const bad = summarizeDependencyAxis('F', changed, fOracle, { phaseKind: 'public' });
    assert.equal(bad.complete, false); assert.equal(bad.candidate_requirements_criteria, 'UNMET');
  }
});
const eOracle = Array.from({ length: 10 }, (_, n) => ({ id: 'E' + n, expected_gate: n < 4 ? 'sufficient' : n < 8 ? 'missing' : n === 8 ? 'ambiguous' : 'no-change', expected_intent: n < 8 ? 'change' : n === 8 ? 'ambiguous' : 'no-change' }));
const eRows = () => eOracle.flatMap(o => ['B', 'C'].map(arm => ({ id: o.id, arm, method: DEPENDENCY_METHODS[arm], generation_policy: DEPENDENCY_POLICIES[arm], valid_execution: true,
  paint_status: 'PASS', persisted_raw_equal: true, grade: { contract_valid: true, gate_correct: true, graph_exact: o.expected_gate !== 'missing',
    expected_gate: o.expected_gate, non_regression_guards: true, deadline: true, full_required_exact: true, missing_exact_minimal: true,
    no_false_adoption: true, eligible: o.expected_gate === 'missing', initial_literal: { required: [] }, raw_unchanged: true,
    proposal_present: false, verification_accepted: false } })));
test('NO_EFFECT only pending external admission with all four actual eligible M pairs and zero gains', () => {
  const rows = eRows(); const got = summarizeDependencyAxis('E', rows, eOracle);
  assert.equal(got.no_effect_criteria_pending_integrity, 'PASS'); assert.equal(got.enabled.missing.total, 4);
  const weak = clone(rows); weak.find(r => r.id === 'E4' && r.arm === 'B').grade.eligible = false;
  const bad = summarizeDependencyAxis('E', weak, eOracle); assert.equal(bad.no_effect_criteria_pending_integrity, 'UNPROVEN');
  assert.equal(bad.enabled.missing.total, 4);
  const invalid = clone(rows); invalid[0].valid_execution = false;
  assert.equal(summarizeDependencyAxis('E', invalid, eOracle).no_effect_criteria_pending_integrity, 'UNPROVEN');
});
test('one causal gain is partial effect, never zero-effect; full E criteria still fail at one', () => {
  const rows = eRows(), candidate = rows.find(r => r.id === 'E4' && r.arm === 'C');
  Object.assign(candidate.grade, { graph_exact: true, proposal_present: true, verification_accepted: true });
  const got = summarizeDependencyAxis('E', rows, eOracle);
  assert.equal(got.missing_gains, 1); assert.equal(got.effect_criteria, 'UNMET');
  assert.equal(got.no_effect_criteria_pending_integrity, 'UNPROVEN');
});
