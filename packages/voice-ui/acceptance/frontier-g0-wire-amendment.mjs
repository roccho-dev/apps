import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// The frontier cycle compares the current G0 upstream bytes with the frozen
// 664c8a8 baseline. r12 (9646eb9/b95e121) changed exactly three intent texts in
// literalQuestion (src/literal-inventory.mjs:141-147). This registered
// amendment is the only admitted difference (apps#94, R 3/12): each original
// text must occur exactly once in the baseline body, and after the three edits
// the current body must equal it byte for byte. Nothing else may differ.
const AMENDMENT = Object.freeze([
  { field: "intent.instructions",
    from: "Missing library candidates do not make a clear supported request ambiguous or unsupported. A requested new part",
    to: "Missing library candidates do not make a clear supported request ambiguous or unsupported. "
      + "Judge the requested operation, not whether a label already appears in the picture. An explicit addition requests NEW instances; the existing group named as destination is only a parent reference. "
      + "『AにBをN個追加』は既存のAの中へ新しいBをN個増やす要求です。AやBが既に存在しても、その追加要求は満たされていません。在庫不足と配置可否はこの意図判定とは別です。 "
      + "A requested new part" },
  { field: "intent.criteria.change", key: "change",
    from: "A clear request adds one to three regions or one directed flow edge and at least one requested fact is not yet satisfied. New display names are allowed. Ignore whether the candidate parts are in the library.",
    to: "A clear request adds one to three regions or one directed flow edge and at least one requested fact is not yet satisfied. New display names are allowed. Ignore whether the candidate parts are in the library. 明確な追加または接続の要求。既存ノードと同じ名前の新規追加も含む。" },
  { field: "intent.criteria.no-change", key: "no-change",
    from: "No graph change is requested, or every requested fact already exists in the current graph.",
    to: "No change is requested, or a requested existing-state fact is already satisfied. An explicit request to ADD more instances is never satisfied merely by an existing matching label. 追加の指示がなく、変更不要な場合。" },
]);

const encode = (text, key) => key === undefined ? JSON.stringify(text).slice(1, -1) : `${JSON.stringify(key)}:${JSON.stringify(text)}`;
const occurrences = (body, part) => body.split(part).length - 1;

export const G0_WIRE_AMENDMENT_SHA256 = createHash("sha256").update(JSON.stringify(AMENDMENT)).digest("hex");

// The baseline body with exactly the registered edits applied.
export function amendBaselineG0Body(body) {
  let amended = body;
  for (const edit of AMENDMENT) {
    const from = encode(edit.from, edit.key), to = encode(edit.to, edit.key);
    assert.equal(occurrences(amended, from), 1, `registered amendment ${edit.field}: original text occurs exactly once`);
    amended = amended.replace(from, () => to);
  }
  assert.notEqual(amended, body);
  return amended;
}

// A captured upstream request: the raw body and, beside it, the same body parsed.
// Both views carry the amendment; every other field stays the baseline's.
export function amendBaselineG0Wire(wire) {
  const body_utf8 = amendBaselineG0Body(wire.body_utf8);
  assert.deepEqual(wire.wire, JSON.parse(wire.body_utf8), "the parsed view is the baseline body");
  return { ...wire, body_utf8, wire: JSON.parse(body_utf8) };
}

export const G0_WIRE_AMENDMENT = AMENDMENT;
