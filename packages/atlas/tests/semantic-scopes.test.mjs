// Explicit synthetic counterexamples. These are not actual domain/Factory proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSemanticScopes } from '../semantic-scopes.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/semantic-scopes.json', import.meta.url), 'utf8'));
const declaration = () => structuredClone(fixture.frames[1].semantic);
const normalize = value => normalizeSemanticScopes(value);

test('initial Scope completes while whole Purpose regresses; retain residual and history', () => {
  const before = normalize(fixture.frames[0].semantic);
  const after = normalize(fixture.frames[1].semantic);
  assert.equal(before.closure.scope_status, 'unmet');
  assert.equal(after.closure.scope_status, 'declared_satisfied');
  assert.equal(after.closure.purpose_status, 'unmet');
  assert.deepEqual(after.closure.residual, ['criterion.recovery']);
  assert.deepEqual(after.history, fixture.frames[0].semantic.history);
  assert.equal(after.authority, false);
  assert.equal(after.semantic_truth, 'domain-declared-not-verified');
});

test('same representation may change meaning; new spelling alone creates no Scope', () => {
  const changed = declaration();
  changed.comparison.presentation_before = changed.comparison.presentation_after = 'ready';
  assert.equal(normalize(changed).status, 'declared_partition');
  const equivalent = declaration();
  equivalent.comparison.parts.forEach(part => { part.verdict = 'equivalent'; });
  equivalent.comparison.presentation_before = 'Ready';
  equivalent.comparison.presentation_after = 'READY';
  equivalent.partition = [];
  equivalent.observation.criteria = [];
  delete equivalent.observation.purpose_evaluation;
  const result = normalize(equivalent);
  assert.deepEqual(result.scopes, []);
  assert.equal(result.status, 'declared_equivalent');
  assert.equal(result.closure.purpose_status, 'unknown');
});

test('explicit direction and revision-bound comparison basis are necessary', () => {
  const reversed = declaration();
  reversed.comparison.direction = 'target-to-current';
  assert.throws(() => normalize(reversed), /direction/);
  const stale = declaration();
  stale.comparison.basis.target_ref.revision = 'another-target';
  // Break the shared fixture value identity deliberately, preserving the selected pair.
  stale.comparison.target_ref = structuredClone(fixture.frames[1].semantic.comparison.target_ref);
  const result = normalize(stale);
  assert.equal(result.status, 'unknown');
  assert.equal(result.scopes, null);
});

test('unknown/conflict or missing comparison, coverage and decomposition never become []', () => {
  for (const state of ['unknown', 'conflict']) {
    const input = declaration(); input.comparison.availability = state;
    assert.equal(normalize(input).status, state);
    assert.equal(normalize(input).scopes, null);
  }
  for (const change of [input => { delete input.comparison.target_ref; },
    input => { input.comparison.semantic_coverage.assessment = 'unknown'; },
    input => { input.comparison.parts[1].verdict = 'unknown'; },
    input => { input.partition = null; }, input => { delete input.partition; }]) {
    const input = declaration(); change(input);
    assert.equal(normalize(input).scopes, null);
  }
});

test('unassigned transformation stays residual; accountability and criteria cannot be invented', () => {
  const partial = declaration(); partial.comparison.parts[1].verdict = 'change';
  assert.deepEqual(normalize(partial).uncovered, ['recovery']);
  assert.equal(normalize(partial).status, 'incomplete');
  for (const change of [input => { input.partition[0].owner_actor = true; },
    input => { input.partition[0].required_evidence = true; },
    input => { input.partition[0].parts = ['invented']; },
    input => { input.partition[0].criteria = {}; },
    input => { input.partition.push({ ...input.partition[0], id: 'another-owner' }); }]) {
    const input = declaration(); change(input); assert.throws(() => normalize(input));
  }
});

test('multiple justified partitions can cover one semantic transformation', () => {
  const coarse = declaration();
  coarse.comparison.parts[1].verdict = 'change';
  coarse.partition[0].parts.push('recovery');
  coarse.partition[0].criteria.recovery = ['criterion.recovery'];
  coarse.observation = null;
  const fine = structuredClone(coarse);
  fine.partition = [{ ...fine.partition[0], id: 'delivery-only', parts: ['delivery'], criteria: { delivery: ['criterion.delivery'] } },
    { ...fine.partition[0], id: 'recovery-only', parts: ['recovery'], criteria: { recovery: ['criterion.recovery'] } }];
  const a = normalize(coarse), b = normalize(fine);
  assert.equal(a.status, b.status);
  assert.deepEqual(a.uncovered, []); assert.deepEqual(b.uncovered, []);
  assert.equal(a.scopes.length, 1); assert.equal(b.scopes.length, 2);
  assert.deepEqual(a.comparison, b.comparison);
});

test('unassigned recovery preserves a valid delivery checkpoint, observation and whole-Purpose limit', () => {
  const input = declaration(); input.comparison.parts[1].verdict = 'change';
  const result = normalize(input);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.uncovered, ['recovery']);
  assert.equal(result.closure.scope_status, 'declared_satisfied');
  assert.equal(result.closure.purpose_status, 'unmet');
  assert.equal(result.closure.coverage_status, 'incomplete');
  assert.deepEqual(result.closure.responsibility_residual, ['recovery']);
  assert.deepEqual(result.closure.observation, input.observation);
  assert.deepEqual(result.closure.residual, ['criterion.recovery']);
  delete input.observation.purpose_evaluation;
  const missingWhole = normalize(input);
  assert.equal(missingWhole.closure.scope_status, 'declared_satisfied');
  assert.equal(missingWhole.closure.purpose_status, 'unknown');
  input.observation.purpose_evaluation = structuredClone(fixture.frames[1].semantic.observation.purpose_evaluation);
  input.observation.purpose_evaluation.state = 'satisfied'; input.observation.purpose_evaluation.residual = [];
  const incompletePositive = normalize(input);
  assert.equal(incompletePositive.closure.scope_status, 'declared_satisfied');
  assert.equal(incompletePositive.closure.purpose_status, 'unknown');
  assert.equal(incompletePositive.closure.observation.purpose_evaluation.state, 'satisfied');
});

test('Scope-only checkpoint and missing whole-target evaluation preserve Purpose UNKNOWN', () => {
  const input = declaration(); delete input.observation.purpose_evaluation;
  const result = normalize(input);
  assert.equal(result.closure.scope_status, 'declared_satisfied');
  assert.equal(result.closure.purpose_status, 'unknown');
  assert.equal(result.closure.status, 'unknown');
});

test('required evidence is tied to requirement, actual observed revision, target and independent evaluator', () => {
  for (const [field, value] of [['requirements', ['unrelated-status']], ['observed_ref', { space: 'other', revision: 'old', id: 'other' }],
    ['target_ref', { space: 'other', revision: 'old', id: 'other' }], ['evaluator', 'fixture-W'], ['state', 'unknown'], ['fresh', false], ['ref', null]]) {
    const input = declaration(); input.observation.criteria[0].evidence[0][field] = value;
    assert.equal(normalize(input).closure.scope_status, 'unknown', field);
  }
});

test('joint independent evidence is accepted without claiming authenticated truth', () => {
  const input = declaration(); input.partition[0].required_evidence = ['post-state', 'independent-readback'];
  const witness = input.observation.criteria[0].evidence[0];
  input.observation.criteria[0].evidence = [{ ...witness, requirements: ['post-state'] }, { ...witness, requirements: ['independent-readback'] }];
  assert.equal(normalize(input).closure.scope_status, 'declared_satisfied');
});

test('whole-target proof cannot hide stale/self-only/mismatched/partial evaluation or residual', () => {
  for (const [field, value] of [['observed_ref', { space: 'other', revision: 'old', id: 'other' }],
    ['target_ref', { space: 'other', revision: 'old', id: 'other' }], ['evaluator', 'fixture-W'], ['coverage', 'initial-delta-only'], ['fresh', false]]) {
    const input = declaration(); input.observation.purpose_evaluation[field] = value;
    assert.equal(normalize(input).closure.purpose_status, 'unknown', field);
  }
  const contradiction = declaration(); contradiction.observation.purpose_evaluation.state = 'satisfied';
  assert.equal(normalize(contradiction).closure.purpose_status, 'conflict');
  delete contradiction.observation.purpose_evaluation.residual;
  assert.equal(normalize(contradiction).closure.purpose_status, 'unknown');
});

test('a fully supported declaration remains bounded; work status has no closure weight', () => {
  const input = declaration(); input.observation.purpose_evaluation.state = 'satisfied'; input.observation.purpose_evaluation.residual = [];
  const a = normalize(input); input.observation.work_done = false; const b = normalize(input);
  assert.equal(a.closure.purpose_status, 'declared_satisfied');
  assert.equal(a.closure.purpose_status, b.closure.purpose_status);
  assert.equal(a.semantic_truth, 'domain-declared-not-verified');
});

test('comparison/Scope/observation provenance and historical obligations survive without input mutation', () => {
  const input = declaration(), saved = structuredClone(input), result = normalize(input);
  assert.deepEqual(input, saved);
  assert.deepEqual(result.comparison, input.comparison);
  assert.deepEqual(result.observation, input.observation);
  assert.deepEqual(result.scopes[0].transformations, [input.comparison.parts[0]]);
  assert.deepEqual(result.history, input.history);
  const replaced = declaration(); replaced.comparison.target_ref = { ...replaced.comparison.target_ref, revision: 'new-target' };
  assert.equal(normalize(replaced).closure.purpose_status, 'unknown');
  assert.deepEqual(normalize(replaced).history, input.history);
});
