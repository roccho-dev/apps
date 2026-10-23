import assert from 'node:assert/strict';
import test from 'node:test';
import { literalInventory } from '../src/literal-inventory.mjs';
import { readLiteralInspection } from '../src/completion.mjs';

// Round 3 (R 13/200 (2)): a catalogue name may be followed by という and a short word saying what it is, and a sentence
// may go on after a continuative verb before a comma. The catalogue decides the kind; a word that is itself a
// catalogue alias (here グループ, as in the default bundle) must agree. Phrasings are written for this test; none
// is an EV script line.
const parts = [
  { key: 'frontend', label: 'Frontend', kind: 'group', purpose: 'a grouping of user-facing services' },
  { key: 'backend', label: 'Backend', kind: 'group', purpose: 'a grouping of server-side services' },
  { key: 'cache', label: 'Cache', kind: 'data', purpose: 'a fast copy of stored information' },
  { key: 'api', label: 'API', kind: 'step', purpose: 'request handling' },
  { key: 'group', label: 'グループ', kind: 'group', purpose: 'a generic group, as in the default bundle' },
];
const input = utterance => ({ utterance, head: 'fixture-head', maxRequired: 16,
  relations: [{ kind: 'flow', label: '' }], parts,
  regions: [{ id: 'root', label: 'World', kind: 'boundary', parent: null },
    { id: 'container', label: 'OCI', kind: 'group', parent: 'root' }], edges: [] });
const row = label => ({ label, kind: parts.find(p => p.label === label).kind, quantity: 1 });
const read = utterance => {
  const state = input(utterance), frozen = JSON.stringify(state), result = literalInventory(state);
  assert.equal(JSON.stringify(state), frozen, 'graph, keys and displayed names are untouched');
  return { state, result };
};

for (const [utterance, labels] of [
  ['OCIの中にFrontendというグループを作って', ['Frontend']],
  ['FrontendとBackendというグループを置く', ['Frontend', 'Backend']],
  ['Backendというグループを作り、その中にCacheを入れて', ['Backend', 'Cache']],
  ['Frontendという名前のグループを置き、APIも加えてください', ['Frontend', 'API']],
  ['Cacheというデータを追加して', ['Cache']],
  ['APIという工程を入れる', ['API']],
]) test(`kind phrase / continued sentence: ${utterance}`, () => {
  const { state, result } = read(utterance);
  assert.equal(result.valid, true);
  assert.deepEqual(result.required, labels.map(row));
  assert.deepEqual(result.spans.map(span => state.utterance.slice(span.start, span.end)), labels);
  assert.notEqual(readLiteralInspection({ source: 'literal+jev', recognized: result.recognized,
    required: result.required, missing: result.missing, spans: result.spans,
    completeness: { choice: 'complete', confidence: 1 } }, state.utterance, { max: 16 }), null);
});

test('a kind word after という/の is never read as a second part, even when it is a catalogue label', () => {
  assert.deepEqual(read('Queueというグループを作り、APIを置いて').result.required, [row('API')]);
  assert.deepEqual(read('Frontendというグループを作って').result.required, [row('Frontend')]);
});

test('a word that is a catalogue alias of another kind refuses the mention', () => {
  for (const utterance of ['Cacheというグループを作って', 'FrontendとCacheというグループを置く', 'APIというグループを入れる']) {
    const result = read(utterance).result;
    assert.equal(result.valid, false, utterance);
    assert.deepEqual(result.required, [], utterance);
  }
});

test('the の form is not read as naming a kind, so a possessive never adds the name before it', () => {
  assert.deepEqual(read('Cacheの説明を追加して').result.required, []);
  assert.deepEqual(read('FrontendとBackendの説明を置いて').result.required, []);
});

test('prohibitions and other continuations still transcribe nothing', () => {
  for (const utterance of ['Frontendというグループを作ってはいけない', 'FrontendとBackendのグループを作らないで',
    'Backendというグループを作りません', 'Frontendというグループを作りたい', 'Backendのグループを置きっぱなしにしないで',
    'Frontendというグループを入れないでください'])
    assert.deepEqual(read(utterance).result.required, [], utterance);
});
