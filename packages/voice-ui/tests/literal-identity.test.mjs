import assert from 'node:assert/strict';
import test from 'node:test';
import { literalInventory } from '../src/literal-inventory.mjs';

const part = (key, label, kind) => ({ key, label, kind, purpose: `one ${kind} ${label}` });
const inventory = (utterance, parts) => ({ utterance, parts, maxRequired: 16,
  regions: [{ id: 'root', label: 'World', kind: 'boundary', parent: null }], edges: [] });
const sorted = rows => rows.map(row => JSON.stringify(row)).sort();

for (const reverse of [false, true]) {
  const stock = [part('request-instance', 'API', 'step'), part('record-instance', 'API', 'data')];
  if (reverse) stock.reverse();
  test(`ambiguous stock name is not a kind declaration or an order-based choice: reverse=${reverse}`, () => {
    for (const utterance of ['APIを1個追加', 'APIを追加', 'API「新規」を1個追加']) {
      const input = inventory(utterance, stock), before = JSON.stringify(input);
      const result = literalInventory(input);
      assert.deepEqual(result.required, []);
      assert.equal(result.recognized, false);
      assert.equal(result.status, 'unsupported-syntax');
      assert.equal(JSON.stringify(input), before);
    }
  });
  test(`explicit kinds preserve both same-name instances: reverse=${reverse}`, () => {
    const result = literalInventory(inventory('step「API」を2個とdata「API」を1個追加', stock));
    assert.equal(result.valid, true);
    assert.deepEqual(sorted(result.required), sorted([
      { label: 'API', kind: 'step', quantity: 2 }, { label: 'API', kind: 'data', quantity: 1 },
    ]));
    assert.deepEqual(result.missing, [{ label: 'API', kind: 'step', occurrence: 1 }]);
  });
}
test('a catalogue name cannot redefine a primitive kind, even when the name is step', () => {
  const stock = [part('named-step', 'step', 'data')];
  assert.deepEqual(literalInventory(inventory('step「作業」を1個追加', stock)).required,
    [{ label: '作業', kind: 'step', quantity: 1 }]);
  assert.deepEqual(literalInventory(inventory('stepを1個追加', stock)).required,
    [{ label: 'step', kind: 'data', quantity: 1 }]);
});
test('same-name same-kind instances keep their finite stock and requested total', () => {
  const stock = [part('db-one', 'DB', 'data'), part('db-two', 'DB', 'data')];
  const result = literalInventory(inventory('DBを3個追加', stock));
  assert.equal(result.valid, true);
  assert.deepEqual(result.required, [{ label: 'DB', kind: 'data', quantity: 3 }]);
  assert.deepEqual(result.missing, [{ label: 'DB', kind: 'data', occurrence: 1 }]);
});
test('legacy unambiguous aliases and explicit shape syntax remain supported', () => {
  for (const utterance of ['DBを2個追加', 'DB「ログ」を2個追加', 'data「ログ」を2個追加']) {
    const state = inventory(utterance, [part('db', 'DB', 'data')]);
    delete state.maxRequired;
    const result = literalInventory(state);
    assert.equal(result.valid, true);
    assert.equal(result.required[0].kind, 'data');
    assert.equal(result.required[0].quantity, 2);
  }
});
