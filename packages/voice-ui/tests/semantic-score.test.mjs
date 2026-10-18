import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeGraph, gradeMissing, gradeGate } from './semantic-score.mjs';

const region = (id, label, kind = 'step', parent = 'container') => ({ type: 'region', id, parent, label, kind, summary: '', bounds: [0, 0, 100, 50] });
const initial = [{ type: 'meta', schema: 'test', root: 'root', title: 'baseline' }, region('root', 'Root', 'boundary', null), region('container', 'Container', 'group', 'root')];
const empty = { expected_added_regions: [], expected_added_edges: [], expected_missing: [], expected_gate: 'no-change' };
const copy = x => structuredClone(x);

test('same-name instances are a multiset and cannot disappear, merge or duplicate an ID', () => {
  const oracle = { ...empty, expected_added_regions: [{ label: 'Unit', kind: 'step', parent: 'fixture:container' }, { label: 'Unit', kind: 'step', parent: 'fixture:container' }] };
  const final = [...initial, region('a', 'Unit'), region('b', 'Unit')];
  assert.equal(gradeGraph(initial, final, oracle).graph_exact, true);
  assert.equal(gradeGraph(initial, final.slice(0, -1), oracle).graph_exact, false);
  assert.equal(gradeGraph(initial, [...initial, region('a', 'Unit'), region('a', 'Unit')], oracle).graph_exact, false);
  const altered = copy(final); altered.at(-1).parent = 'root';
  assert.equal(gradeGraph(initial, altered, oracle).graph_exact, false);
});
test('new parent identity and directed edge are graded independently of generated ID spelling', () => {
  const oracle = { ...empty, expected_added_regions: [
    { label: 'Room', kind: 'group', parent: 'fixture:container' },
    { label: 'Unit', kind: 'step', parent: 'added:Room' },
    { label: 'Sheet', kind: 'data', parent: 'added:Room' },
  ], expected_added_edges: [{ from: 'added:Unit', to: 'added:Sheet', kind: 'flow', label: '' }] };
  const final = [...initial, region('r9', 'Room', 'group'), region('u9', 'Unit', 'step', 'r9'), region('s9', 'Sheet', 'data', 'r9'),
    { type: 'relation', id: 'edge9', from: 'u9', to: 's9', kind: 'flow', label: '' }];
  assert.equal(gradeGraph(initial, final, oracle).graph_exact, true);
  const reversed = copy(final); [reversed.at(-1).from, reversed.at(-1).to] = [reversed.at(-1).to, reversed.at(-1).from];
  assert.equal(gradeGraph(initial, reversed, oracle).graph_exact, false);
  const extraField = copy(final); extraField.at(-1).claimed = true;
  assert.equal(gradeGraph(initial, extraField, oracle).graph_exact, false);
});
test('preserve every existing semantic field; layout exclusion cannot hide new semantic data', () => {
  assert.equal(gradeGraph(initial, [...initial, { type: 'layout', regionId: 'container', bounds: [0, 0, 300, 100] }], empty).graph_exact, true);
  const movedBounds = copy(initial); movedBounds[2].bounds = [5, 6, 700, 200];
  assert.equal(gradeGraph(initial, movedBounds, empty).graph_exact, true);
  const changed = copy(initial); changed[0].title = 'changed';
  assert.equal(gradeGraph(initial, changed, empty).graph_exact, false);
  const summary = copy(initial); summary[2].summary = 'changed';
  assert.equal(gradeGraph(initial, summary, empty).graph_exact, false);
  assert.equal(gradeGraph(initial, initial.slice(1), empty).graph_exact, false);
  assert.equal(gradeGraph(initial, [...initial, { type: 'authority', id: 'x', value: true }], empty).graph_exact, false);
});
test('minimality checks exact missing capacity and refuses hidden fields and repeated occurrences', () => {
  const oracle = { expected_missing: [{ label: 'Unit', kind: 'step', occurrence: 1 }, { label: 'Unit', kind: 'step', occurrence: 2 }] };
  assert.equal(gradeMissing([...oracle.expected_missing].reverse(), oracle), true);
  assert.equal(gradeMissing([oracle.expected_missing[0]], oracle), false);
  assert.equal(gradeMissing([oracle.expected_missing[0], oracle.expected_missing[0]], oracle), false);
  assert.equal(gradeMissing(oracle.expected_missing.map(x => ({ ...x, parent: 'injected' })), oracle), false);
});
test('weak correct raw choices are not accepted, and malformed confidence is not a quality success', () => {
  const oracle = { expected_gate: 'missing' };
  assert.deepEqual(gradeGate({ choice: 'missing', confidence: 0.49 }, oracle), { contract_valid: true, raw_choice_correct: true, accepted_gate_correct: false });
  assert.equal(gradeGate({ choice: 'missing', confidence: 0.5 }, oracle).accepted_gate_correct, true);
  for (const confidence of [NaN, Infinity, -1, 1.1, '1']) assert.equal(gradeGate({ choice: 'missing', confidence }, oracle).contract_valid, false);
  assert.equal(gradeGate({ choice: 'missing', confidence: 1, hidden: true }, oracle).contract_valid, false);
});
