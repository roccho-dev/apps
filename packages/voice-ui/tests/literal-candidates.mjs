// Preserve the closed comparison import; the ordinary API shares this extractor.
import { literalInventory } from "../src/literal-inventory.mjs";
export function literalCandidates(state) {
  const value = literalInventory(state);
  return { missing: value.missing, extraction: { status: value.status, spans: value.spans } };
}
