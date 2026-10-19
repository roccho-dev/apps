import assert from 'node:assert/strict';
import test from 'node:test';
import { literalInventory, literalQuestion } from '../src/literal-inventory.mjs';
import { readLiteralInspection, requiredDifference, quotaGoalBundle } from '../src/completion.mjs';

// A only: fixed literal forms and independent numeric expectations. This is
// neither natural-language/model accuracy nor graph/painted/voice acceptance.
const label = 'Counter４';
const stock = { key: 'counter-primary', label, kind: 'data', purpose: 'retained counter' };
const stateFor = (utterance, maxRequired = 16) => ({ utterance, head: 'fixture-head', maxRequired,
  relations: [{ kind: 'flow', label: '' }], parts: [stock],
  regions: [{ id: 'root', label: 'World', kind: 'boundary', parent: null },
    { id: 'container', label: 'OCI', kind: 'group', parent: 'root' },
    { id: 'existing-counter', label, kind: 'data', parent: 'container' }], edges: [] });
const kanji = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六'];
const forms = {
  prefix: count => `OCIにdata「${label}」を${count}個追加。他は変更しない。`,
  suffix: count => `OCIに「${label}」というdataを${count}個追加。他は変更しない。`,
  stock: count => `OCIに${label}を${count}個追加。他は変更しない。`,
};
for (const [index, word] of kanji.entries()) {
  const quantity = index + 1;
  const spellings = { ascii: String(quantity), fullwidth: String(quantity).replace(/[0-9]/gu,
    digit => String.fromCharCode(digit.charCodeAt(0) + 0xfee0)), kanji: word };
  for (const [spelling, count] of Object.entries(spellings)) for (const [form, utterance] of Object.entries(forms)) {
    test(`A counted instance ${quantity} / ${spelling} / ${form}`, () => {
      const state = stateFor(utterance(count)), frozen = JSON.stringify(state);
      const result = literalInventory(state);
      assert.equal(result.valid && result.recognized, true);
      assert.deepEqual(result.required, [{ label, kind: 'data', quantity }]);
      assert.deepEqual(result.missing, Array.from({ length: quantity - 1 }, (_, i) => ({ label, kind: 'data', occurrence: i + 1 })));
      assert.deepEqual(requiredDifference(result.required, state.parts), result.missing);
      assert.equal(result.spans.length, 1);
      assert.equal(result.spans[0].source, label, 'numeral normalization must not change a label');
      const inspected = readLiteralInspection({ source: 'literal+jev', recognized: result.recognized,
        required: result.required, missing: result.missing, spans: result.spans,
        completeness: { choice: 'complete', confidence: 1 } }, state.utterance, { max: 16 });
      assert.ok(inspected, 'the same literal result crosses the existing browser readback contract');
      assert.equal(JSON.stringify(state), frozen, 'existing graph and candidate identity remain unchanged');
      const selected = quotaGoalBundle({ goalSelection: 'delta', parts: state.parts }, result.required);
      assert.deepEqual(selected.parts, [stock], 'do not create missing candidates during stock selection');
    });
  }
}

for (const count of ['0', '０', '零', '17', '１７', '十七', '二十', '百', '一二', '十十', '三.五', '３．５', '-1', '－１', '1e1', '3/4']) {
  for (const form of ['prefix', 'suffix']) test(`A refuses unsupported count ${count} / ${form}`, () => {
    const result = literalInventory(stateFor(forms[form](count)));
    assert.equal(result.valid && result.recognized, false, 'never replace an explicit bad count with one or a prefix');
  });
}
for (const count of ['4', '４', '四']) test(`A retains the legacy three-instance limit / ${count}`, () => {
  const state = stateFor(forms.prefix(count)); delete state.maxRequired; delete state.relations;
  const result = literalInventory(state);
  assert.equal(result.valid && result.recognized, false);
});

test('A combines repeated names/counts without normalizing names, kinds or the source text', () => {
  const text = 'OCIにdata「X１」を二個、step「X１」を３個、data「X１」を一個追加。';
  const state = stateFor(text), before = JSON.stringify(state), result = literalInventory(state);
  assert.equal(result.valid, true);
  assert.deepEqual(result.required, [{ label: 'X１', kind: 'data', quantity: 3 }, { label: 'X１', kind: 'step', quantity: 3 }]);
  assert.equal(result.spans.length, 3);
  assert.deepEqual(result.spans.map(row => state.utterance.slice(row.start, row.end)), ['X１', 'X１', 'X１']);
  assert.equal(JSON.stringify(state), before);
});

test('A counts each explicitly named part and refuses ambiguous shared totals', () => {
  const each = literalInventory(stateFor('OCIに「A」「B」というdataを四個ずつ追加。'));
  assert.equal(each.valid, true);
  assert.deepEqual(each.required, [{ label: 'A', kind: 'data', quantity: 4 }, { label: 'B', kind: 'data', quantity: 4 }]);
  assert.equal(literalInventory(stateFor('OCIに「A」「B」というdataを四個追加。')).valid, false);
  assert.equal(literalInventory(stateFor('OCIにdata「A」を九個、data「B」を八個追加。')).valid, false);
});

test('literal evidence does not replace the separate completeness judgment or invent missing part names', () => {
  const state = stateFor('OCIにあと四個追加。'), extracted = literalInventory(state);
  assert.equal(extracted.recognized, false);
  assert.deepEqual(extracted.required, []);
  const question = literalQuestion(state, extracted);
  assert.ok(question.questions.completeness.options.complete);
  assert.ok(question.questions.completeness.options.incomplete);
  assert.equal(Object.hasOwn(extracted, 'complete'), false);
});
