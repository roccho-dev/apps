import assert from 'node:assert/strict';
import test from 'node:test';
import { literalInventory } from '../src/literal-inventory.mjs';
import { readLiteralInspection } from '../src/completion.mjs';

// Ordinary placement verbs after catalogue names (R 5/200 (1)). The phrasings here are general Japanese requests
// written for this test; none is a line of the EV scripts, which are the exam and are not tuned against.
const parts = [
  { key: 'api', label: 'API', kind: 'step', purpose: 'request handling' },
  { key: 'db', label: 'DB', kind: 'data', purpose: 'stored information' },
  { key: 'cache', label: 'Cache', kind: 'data', purpose: 'a fast copy of stored information' },
];
const input = (utterance, stock = parts) => ({ utterance, head: 'fixture-head', maxRequired: 16,
  relations: [{ kind: 'flow', label: '' }], parts: stock,
  regions: [{ id: 'root', label: 'World', kind: 'boundary', parent: null },
    { id: 'container', label: 'OCI', kind: 'group', parent: 'root' }], edges: [] });
const one = (...labels) => labels.map(label => ({ label, kind: parts.find(p => p.label === label).kind, quantity: 1 }));
const read = utterance => {
  const state = input(utterance), frozen = JSON.stringify(state), result = literalInventory(state);
  assert.equal(JSON.stringify(state), frozen, 'graph, keys and displayed names are untouched');
  return { state, result };
};

for (const [utterance, labels] of [
  ['OCIにCacheを置く', ['Cache']],
  ['OCIにAPIを加えてください', ['API']],
  ['DBも入れてほしい', ['DB']],
  ['OCIにCacheを作って', ['Cache']],
  ['OCIにAPIを追加してください', ['API']],
  ['OCIにAPIとDBを加えてください', ['API', 'DB']],
  ['Cache、DB を入れて', ['Cache', 'DB']],
  ['API, Cache を作る', ['API', 'Cache']],
  ['OCIにAPIおよびCacheを配置する', ['API', 'Cache']],
]) test(`placement verb: ${utterance}`, () => {
  const { state, result } = read(utterance);
  assert.equal(result.valid, true);
  assert.equal(result.status, 'transcribed');
  assert.deepEqual(result.required, one(...labels));
  assert.deepEqual(result.spans.map(row => state.utterance.slice(row.start, row.end)), labels);
  assert.notEqual(readLiteralInspection({ source: 'literal+jev', recognized: result.recognized,
    required: result.required, missing: result.missing, spans: result.spans,
    completeness: { choice: 'complete', confidence: 1 } }, state.utterance, { max: 16 }), null);
});

test('negative, other or absent verbs transcribe nothing', () => {
  for (const utterance of ['OCIにCacheを置かないで', 'OCIにCacheを置きません', 'APIとDBを加えずにおいて',
    'DBを入れないでください', 'APIとDBを確認して', 'Cacheについて説明して'])
    assert.deepEqual(read(utterance).result.required, [], utterance);
});

test('a count between the names and the verb keeps the counted reading, never each-count', () => {
  // As literal-stock-list: a shared total is not an each-count; the uncounted list form does not apply.
  assert.notDeepEqual(read('OCIにAPIとDBを2個追加').result.required,
    [{ label: 'API', kind: 'step', quantity: 2 }, { label: 'DB', kind: 'data', quantity: 2 }]);
});

test('ambiguous kinds and composite names refuse the uncounted coordination too', () => {
  for (const extra of [
    { key: 'other-api', label: 'API', kind: 'data', purpose: 'ambiguous' },
    { key: 'whole', label: 'APIとDB', kind: 'step', purpose: 'composite name' },
  ]) {
    const result = literalInventory(input('OCIにAPIとDBを加えて', [...parts, extra]));
    assert.equal(result.valid, false);
    assert.deepEqual(result.required, []);
  }
});

test('names outside the catalogue are not invented', () => {
  assert.deepEqual(read('OCIにQueueとDBを加えて').result.required, one('DB'));
  assert.deepEqual(read('OCIにQueueを置く').result.required, []);
});
