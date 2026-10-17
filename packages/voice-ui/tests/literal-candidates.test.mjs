import assert from "node:assert/strict";
import test from "node:test";
import { literalCandidates } from "./literal-candidates.mjs";

const state = utterance => ({ utterance, regions: [{ label: "Existing", kind: "group" }], parts: [
  { key: "db", label: "DB", kind: "data" },
  { key: "box", label: "Box", kind: "step" },
] });
test("literal preparation preserves original spans, kinds and finite missing quantities", () => {
  const input = state('In group「Existing」 add step「A+B」 and data"DB"×3.');
  const result = literalCandidates(input);
  assert.deepEqual(result.missing, [
    { label: "A+B", kind: "step", occurrence: 1 },
    { label: "DB", kind: "data", occurrence: 1 }, { label: "DB", kind: "data", occurrence: 2 },
  ]);
  for (const span of result.extraction.spans) assert.equal(input.utterance.slice(span.start, span.end), span.source);
});
test("literal baseline has no semantic fallback, never truncates oversized quantities or creates four rows", () => {
  for (const input of ['build a clever name for me', 'step「A」×10', 'step「A」×0',
    'step「A」×-1', 'step「A」×2.5', 'step「A」×two', 'step「A」を-1個',
    'step「A」×2e2', 'weekend「A」', '「A」というendless',
    'step「A」 step「B」 data「C」 group「D」', 'step「A」×3 data「B」']) {
    const result = literalCandidates(state(input));
    assert.deepEqual(result.missing, []);
    assert.equal(result.extraction.status, "unsupported-syntax");
  }
  assert.deepEqual(literalCandidates(state('Box「Box」')).missing, []);
  assert.equal(literalCandidates(state('step「A」 step「A」')).missing.length, 2);
});
test("the same generic grammar handles suffix kinds, lists and explicit stock counts", () => {
  assert.deepEqual(literalCandidates(state('「受付」という名前のstepを作る')).missing,
    [{ label: "受付", kind: "step", occurrence: 1 }]);
  assert.deepEqual(literalCandidates(state('「甲」「乙」「丙」という3つのgroupを追加')).missing.map(x => x.label), ["甲", "乙", "丙"]);
  assert.equal(literalCandidates(state('DBを3つ追加して')).missing.length, 2);
  assert.deepEqual(literalCandidates(state('「甲」「乙」という3つのgroup')).missing, []);
  assert.equal(literalCandidates(state('misstep「A」')).extraction.status, "unsupported-syntax");
});
