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
    'step「A」 step「B」 data「C」 group「D」', 'step「A」×3 data「B」']) {
    const result = literalCandidates(state(input));
    assert.deepEqual(result.missing, []);
    assert.equal(result.extraction.status, "unsupported-syntax");
  }
  assert.deepEqual(literalCandidates(state('Box「Box」')).missing, []);
  assert.equal(literalCandidates(state('step「A」 step「A」')).missing.length, 2);
});
