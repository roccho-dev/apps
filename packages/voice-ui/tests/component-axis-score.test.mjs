import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { axisSchedule, validateAxisInput, gradeSupply, gradeGateAxes, gradeReady, missingFromRequired } from './component-axis-score.mjs';

const read = name => JSON.parse(readFileSync(new URL('../../../docs/voice-ui/component-axes-20261017/preregistered/' + name, import.meta.url), 'utf8'));
const clone = structuredClone;
const stock = read('component-axes-public-G4.oracle.public.json').stock_parts;
const part = (label, kind, occurrence) => ({ label, kind, occurrence });
const required = (label, kind, quantity = 1) => ({ label, kind, quantity });

test('public inputs obey exact axis schema; schedule is fixed and F order alternates', () => {
  for (const stem of ['G4', 'R2', 'F3', 'E4']) assert.equal(validateAxisInput(read('component-axes-public-' + stem + '.inputs.public.json')), true);
  const f = read('component-axes-public-F3.inputs.public.json');
  assert.deepEqual(axisSchedule(f).map(x => x.method), ['literal', 'typed', 'typed', 'literal', 'literal', 'typed']);
  assert.equal(axisSchedule(read('component-axes-public-R2.inputs.public.json')).every(x => x.method === 'ready' && x.compatibility_arm === 'A'), true);
});

test('input mutations cannot leak oracle graph into candidate axes or reuse R keys', () => {
  const f = read('component-axes-public-F3.inputs.public.json');
  for (const mutate of [v => { v.axis = 'Z'; }, v => { v.oracle = { answer: true }; },
    v => { v.cases[0].parts = stock; }, v => { v.cases[0].parent = 'container'; },
    v => { v.cases.push(clone(v.cases[0])); }, v => { v.schema = 'future-schema'; }]) {
    const x = clone(f); mutate(x); assert.throws(() => validateAxisInput(x));
  }
  const r = read('component-axes-public-R2.inputs.public.json');
  for (const mutate of [v => { v.cases[0].parts[1].key = v.cases[0].parts[0].key; },
    v => { v.cases[0].parts[0].parent = 'container'; },
    v => { v.cases[0].parts.pop(); }, v => { v.cases[0].parts[0].kind = 'operator'; }]) {
    const x = clone(r); mutate(x); assert.throws(() => validateAxisInput(x));
  }
});

test('candidate score detects omitted instances, extras and invalid occurrence identities', () => {
  const expected = [part('DB', 'data', 1), part('DB', 'data', 2)];
  assert.equal(gradeSupply(expected.toReversed(), expected).exact, true);
  const omitted = gradeSupply([expected[0]], expected);
  assert.equal(omitted.exact, false); assert.equal(omitted.recall, 0.5); assert.equal(omitted.omitted_instances, 1);
  const extra = gradeSupply([...expected, part('別名', 'step', 1)], expected);
  assert.equal(extra.extra_instances, 1); assert.equal(extra.minimal, false);
  for (const actual of [[expected[0], expected[0]], [part('DB', 'data', 2)],
    [{ ...expected[0], parent: 'container' }], [{ ...expected[0], occurrence: '1' }]])
    assert.equal(gradeSupply(actual, expected).contract_valid, false);
  assert.equal(gradeSupply([], expected).recall, 0);
  assert.equal(gradeSupply([part('DB', 'step', 1)], expected).matched_instances, 0);
});

test('one-use inventory subtracts the library, not same-name existing graph records', () => {
  assert.deepEqual(missingFromRequired([required('DB', 'data', 3)], stock), [part('DB', 'data', 1), part('DB', 'data', 2)]);
  assert.deepEqual(missingFromRequired([required('API', 'step', 1)], stock), []);
});

test('a correct-looking missing choice cannot hide partial extraction or mistaken completeness', () => {
  const oracle = { expected_intent: 'change', expected_gate: 'missing', required: [required('甲', 'step'), required('乙', 'data')] };
  const observation = { decision: { choice: 'missing', confidence: 0.9 },
    inspection: { recognized: true, required: [required('甲', 'step')], missing: [part('甲', 'step', 1)] },
    intent: { choice: 'change', confidence: 0.9 }, completeness: { choice: 'complete', confidence: 0.9 } };
  const score = gradeGateAxes(observation, oracle, stock);
  assert.equal(score.normalized_accepted_correct, true);
  assert.equal(score.difference_mechanism_correct, true);
  assert.equal(score.extraction_exact, false);
  assert.equal(score.completeness_expected, 'incomplete');
  assert.equal(score.completeness_raw_correct, false);
  assert.equal(score.availability_accepted_correct, false);
});

test('weak completeness/UNKNOWN is not accepted as availability; controls are not availability samples', () => {
  const oracle = { expected_intent: 'change', expected_gate: 'sufficient', required: [required('API', 'step')] };
  const observation = { decision: { choice: 'unknown', confidence: null },
    inspection: { recognized: true, required: oracle.required, missing: [] },
    intent: { choice: 'change', confidence: 0.9 }, completeness: { choice: 'complete', confidence: 0.49 } };
  let score = gradeGateAxes(observation, oracle, stock);
  assert.equal(score.contract_valid, true); assert.equal(score.availability_raw_correct, true);
  assert.equal(score.availability_accepted_correct, false); assert.equal(score.normalized_accepted_correct, false);
  const badUnknown = clone(observation); badUnknown.decision.confidence = 0.99;
  assert.equal(gradeGateAxes(badUnknown, oracle, stock).contract_valid, false);
  const control = gradeGateAxes({ ...observation, decision: { choice: 'ambiguous', confidence: 0.8 },
    intent: { choice: 'ambiguous', confidence: 0.8 } }, { expected_intent: 'ambiguous', expected_gate: 'ambiguous', required: null }, stock);
  assert.equal(control.intent_accepted_correct, true); assert.equal(control.normalized_accepted_correct, true);
  assert.equal(control.availability_accepted_correct, null); assert.equal(control.completeness_expected, null);
});

test('ready inventory success is distinct from wrong nesting, relation direction and preservation', () => {
  const initial = [{ type: 'meta', schema: 'semantic-map-state/1', root: 'root', title: 'test' },
    { type: 'region', id: 'root', parent: null, label: 'root', kind: 'boundary', summary: '' },
    { type: 'region', id: 'container', parent: 'root', label: 'OCI', kind: 'group', summary: '' }];
  const added = [{ type: 'region', id: 'a', parent: 'container', label: 'API', kind: 'step', summary: '' },
    { type: 'region', id: 'b', parent: 'container', label: 'DB', kind: 'data', summary: '' },
    { type: 'relation', id: 'e', from: 'a', to: 'b', kind: 'flow', label: '' }];
  const oracle = { required: [required('API', 'step'), required('DB', 'data')],
    expected_added_regions: [{ label: 'API', kind: 'step', parent: 'fixture:container' }, { label: 'DB', kind: 'data', parent: 'fixture:container' }],
    expected_added_edges: [{ from: 'added:API', to: 'added:DB', kind: 'flow', label: '' }] };
  const final = [...clone(initial), ...clone(added)];
  assert.equal(gradeReady(initial, final, oracle, stock).graph.graph_exact, true);
  for (const mutate of [x => { x[3].parent = 'root'; }, x => { x[3].label = 'wrong'; },
    x => { x[5].from = 'b'; x[5].to = 'a'; }, x => { x[2].label = 'changed'; },
    x => { x.push({ type: 'region', id: 'extra', parent: 'container', label: 'extra', kind: 'step', summary: '' }); }]) {
    const x = clone(final); mutate(x); const s = gradeReady(initial, x, oracle, stock);
    assert.equal(s.oracle_inventory_sufficient, true); assert.equal(s.graph.graph_exact, false);
  }
});
