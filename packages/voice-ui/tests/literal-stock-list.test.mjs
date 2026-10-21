import assert from 'node:assert/strict';
import test from 'node:test';
import { literalInventory } from '../src/literal-inventory.mjs';
import { requiredDifference, readLiteralInspection } from '../src/completion.mjs';

const parts = [
  { key: 'api', label: 'API', kind: 'step', purpose: 'request handling' },
  { key: 'db', label: 'DB', kind: 'data', purpose: 'stored information' },
  { key: 'start', label: '開始', kind: 'start', purpose: 'begin' },
];
const input = (utterance, stock = parts) => ({ utterance, head: 'fixture-head', maxRequired: 16,
  relations: [{ kind: 'flow', label: '' }], parts: stock,
  regions: [{ id: 'root', label: 'World', kind: 'boundary', parent: null },
    { id: 'container', label: 'OCI', kind: 'group', parent: 'root' },
    { id: 'old-db', label: 'DB', kind: 'data', parent: 'container' }], edges: [] });
const expected = quantity => [{ label: 'API', kind: 'step', quantity }, { label: 'DB', kind: 'data', quantity }];

for (const [count, quantity] of [['1', 1], ['２', 2], ['三', 3]]) {
  for (const separator of ['と', '、', ', ']) test(`shared stock count ${count} / ${separator}`, () => {
    const state = input(`OCIにAPI${separator}DBを${count}個ずつ追加`), frozen = JSON.stringify(state);
    const result = literalInventory(state);
    assert.equal(result.valid, true);
    assert.deepEqual(result.required, expected(quantity));
    assert.deepEqual(result.missing, requiredDifference(expected(quantity), parts));
    assert.deepEqual(result.spans.map(row => state.utterance.slice(row.start, row.end)), ['API', 'DB']);
    assert.equal(readLiteralInspection({ source: 'literal+jev', recognized: result.recognized,
      required: result.required, missing: result.missing, spans: result.spans,
      completeness: { choice: 'complete', confidence: 1 } }, state.utterance, { max: 16 }) !== null, true);
    assert.equal(JSON.stringify(state), frozen, 'graph, keys and displayed names are untouched');
  });
}
test('three kinds and repeated names preserve per-mention spans and summed counts', () => {
  assert.deepEqual(literalInventory(input('OCIにAPI、DB、開始を１個ずつ追加')).required,
    [...expected(1), { label: '開始', kind: 'start', quantity: 1 }]);
  const result = literalInventory(input('OCIにAPIとDBとAPIを2個ずつ追加'));
  assert.deepEqual(result.required, [{ label: 'API', kind: 'step', quantity: 4 }, { label: 'DB', kind: 'data', quantity: 2 }]);
  assert.equal(result.spans.length, 3);
});
test('same-kind duplicate keys contribute capacity, existing nodes do not', () => {
  const stock = [...parts, { ...parts[1], key: 'db-second' }];
  assert.deepEqual(literalInventory(input('OCIにAPIとDBを2個ずつ追加', stock)).missing,
    [{ label: 'API', kind: 'step', occurrence: 1 }]);
});
test('quoted text remains one name, even beside a separate stock list', () => {
  assert.deepEqual(literalInventory(input('OCIにstep「APIとDB」を1個追加')).required,
    [{ label: 'APIとDB', kind: 'step', quantity: 1 }]);
  assert.deepEqual(literalInventory(input('OCIにstep「APIとDB」を1個追加、APIとDBを1個ずつ追加')).required,
    [{ label: 'APIとDB', kind: 'step', quantity: 1 }, ...expected(1)]);
});
test('list recognition does not turn alternatives or shared totals into an each-count', () => {
  for (const text of ['APIかDBを2個追加', 'APIとDBを2個追加']) {
    const result = literalInventory(input('OCIに' + text));
    assert.notDeepEqual(result.required, expected(2));
  }
});
test('ambiguous kinds and composite aliases never authorize the coordinated reading', () => {
  for (const extra of [
    { key: 'other-api', label: 'API', kind: 'data', purpose: 'ambiguous' },
    { key: 'whole', label: 'APIとDB', kind: 'step', purpose: 'composite name' },
    { key: 'partial', label: 'DBと開始', kind: 'step', purpose: 'composite suffix' },
  ]) {
    for (const stock of [[...parts, extra], [extra, ...parts].reverse()]) {
      const result = literalInventory(input('OCIにAPIとDBと開始を1個ずつ追加', stock));
      assert.equal(result.valid, false);
      assert.deepEqual(result.required, []);
    }
  }
});
test('unsupported counts and finite overflow do not become a valid smaller list', () => {
  for (const count of ['0', '零', '17', '百', '-1', '３．５', '1e1', '3/4'])
    assert.equal(literalInventory(input(`OCIにAPIとDBを${count}個ずつ追加`)).valid
      && literalInventory(input(`OCIにAPIとDBを${count}個ずつ追加`)).recognized, false, count);
  assert.equal(literalInventory(input('OCIにAPIとDBを9個ずつ追加')).valid, false);
  const legacy = input('OCIにAPIとDBを2個ずつ追加'); delete legacy.maxRequired; delete legacy.relations;
  assert.equal(literalInventory(legacy).valid, false);
});
