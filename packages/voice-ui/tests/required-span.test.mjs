import assert from 'node:assert/strict';
import test from 'node:test';
import { literalInventory } from '../src/literal-inventory.mjs';

const input = (utterance, parts = []) => ({ utterance, maxRequired: 16, regions: [], parts });
const p = (label, kind) => ({ key: 'definition', label, kind, purpose: 'one named item' });
// Expected offsets come only from the fixed quoted substring, not the extractor.
const examples = [
  ['primitive-name', 'step「step」を1個追加', 'step', 'step', []],
  ['primitive-substring', 'step「t」を1個追加', 't', 'step', []],
  ['ascii-quotes', 'data"data"を2個追加', 'data', 'data', []],
  ['explicit-alias', '工程「工程」を1個追加', '工程', 'step', [p('工程','step')]],
  ['alias-substring', 'long-name「name」を1個追加', 'name', 'data', [p('long-name','data')]],
  ['unicode-prefix', '🚀の後にstep「step」を1個追加', 'step', 'step', []],
  ['plain-name', 'Cloud内にstep「API」を1個追加', 'API', 'step', []],
  ['quote-in-alias', 'the"alias「alias」を1個追加', 'alias', 'data', [p('the"alias','data')]],
];
for (const [id, text, label, kind, parts] of examples) test('literal evidence points inside the declared quoted name: '+id, () => {
  const result = literalInventory(input(text,parts));
  assert.equal(result.valid,true);assert.equal(result.spans.length,1);
  const quoted = text.includes('「'+label+'」') ? '「'+label+'」' : '"'+label+'"';
  const start=text.indexOf(quoted)+1, span=result.spans[0];
  assert.deepEqual([span.start,span.end,span.source],[start,start+label.length,label]);
  assert.deepEqual(result.required,[{label,kind,quantity:id==='ascii-quotes'?2:1}]);
});
test('repeated quoted names preserve both source locations and summed quantity', () => {
  const text='step「step」を1個、step「step」を2個追加';
  const r=literalInventory(input(text));
  assert.equal(r.valid,true);assert.deepEqual(r.required,[{label:'step',kind:'step',quantity:3}]);
  assert.deepEqual(r.spans.map(s=>s.start),[text.indexOf('「step」')+1,text.lastIndexOf('「step」')+1]);
});
test('existing versus new stock and malformed count guards do not change', () => {
  const state=input('step「step」を3個追加',[p('step','step')]);
  state.regions=[{label:'step',kind:'step'}];
  const r=literalInventory(state);assert.equal(r.required[0].quantity,3);assert.equal(r.missing.length,2);
  for(const text of ['step「step」を17個追加','step「step」×0追加','step「step」×1.5追加'])
    assert.equal(literalInventory(input(text)).valid,false,text);
});
