import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  canonicalJson, sha256Hex, validateExpectation, validateRecord, parseJsonl,
  checkDenominators, checkFourCell, verifyDirectory,
} from "../../../docs/voice-ui/closure-20261021/verify.mjs";

// R1 (apps#94 comment 6313847759): this test proves only that the evaluation
// vessel is self-consistent. A green run is no judgment of the product (§8-12).
const vessel = fileURLToPath(new URL("../../../docs/voice-ui/closure-20261021/", import.meta.url));
const examples = parseJsonl(readFileSync(vessel + "examples/records.jsonl", "utf8"));
const template = JSON.parse(readFileSync(vessel + "expectations/expectation.template.json", "utf8"));
const kinds = kind => examples.records.filter(record => record.kind === kind);
const copy = value => JSON.parse(JSON.stringify(value));

test("the committed vessel verifies, and its CLI agrees", () => {
  assert.deepEqual(verifyDirectory(vessel), { ok: true, errors: [] });
  const run = spawnSync(process.execPath, [vessel + "verify.mjs", vessel], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, errors: [] });
});

test("the examples are well-formed records with equal denominators and four complete cells", () => {
  assert.deepEqual(examples.errors, []);
  assert.ok(kinds("judgment").length >= 8 && kinds("seal").length >= 1 && kinds("cost").length >= 1);
  for (const record of examples.records) assert.deepEqual(validateRecord(record), [], JSON.stringify(record));
  assert.deepEqual(checkDenominators(kinds("judgment")), []);
  assert.deepEqual(checkFourCell(kinds("judgment")), []);
  assert.deepEqual(validateExpectation(template), []);
});

test("one canonical digest regardless of key order", () => {
  const a = { b: [1, { d: "é", c: null }], a: true };
  const b = { a: true, b: [1, { c: null, d: "é" }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":true,"b":[1,{"c":null,"d":"é"}]}');
  assert.match(sha256Hex(canonicalJson(a)), /^[0-9a-f]{64}$/u);
  assert.notEqual(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson({ ...a, a: false })));
});

test("each record rule rejects what it exists to reject", () => {
  const judgment = kinds("judgment")[0], seal = kinds("seal")[0], cost = kinds("cost")[0];
  const rejected = [
    ["judge other than R", { ...judgment, judge: "W" }],
    ["round above four", { ...judgment, round: 5 }],
    ["END1 count on a SHA not readable on GitHub", { ...judgment, counts_toward_end1: true, product: { ...judgment.product, github_readable: false } }],
    ["PASS without a sealed gold", { ...judgment, verdict: "PASS", gold_seal_sha256: null }],
    ["unknown lane", { ...judgment, lane: "AB" }],
    ["unknown step", { ...judgment, step: ["14"] }],
    ["short product SHA", { ...judgment, product: { ...judgment.product, apps: "928bcc1" } }],
    ["extra field", { ...judgment, score: 1 }],
    ["seal after exposure", { ...seal, before_exposure: false }],
    ["seal by someone other than R", { ...seal, sealed_by: "P" }],
    ["seal path outside the vessel", { ...seal, path: "../../packages/voice-ui/src/turn.mjs" }],
    ["cost counted without its ledger line", { ...cost, ledger: null }],
    ["cost of zero without its ledger line", { ...cost, calls: 0, ledger: null }],
    ["cost as a free word", { ...cost, calls: "none" }],
    ["unknown kind", { ...cost, kind: "note" }],
  ];
  for (const [name, record] of rejected) assert.notDeepEqual(validateRecord(record), [], name);
  assert.deepEqual(validateRecord({ ...cost, calls: "UNKNOWN", ledger: null }), [], "UNKNOWN stays UNKNOWN, not zero");
});

test("the expectation rules keep UNKNOWN, identities and the filled state honest", () => {
  const filled = { ...copy(template), status: "candidate", source: { text: "抽象的な期待", ref: "apps#118 c6310563121" },
    required: [{ id: "r1", claim: "x", step: ["4"] }], unknown: [{ id: "u1", question: "y" }] };
  assert.deepEqual(validateExpectation(filled), []);
  assert.notDeepEqual(validateExpectation({ ...filled, required: [] }), [], "a filled expectation needs a Required");
  assert.notDeepEqual(validateExpectation({ ...filled, source: { ...filled.source, text: "" } }), [], "and its source text");
  assert.notDeepEqual(validateExpectation({ ...filled, forbidden: [{ id: "r1", claim: "z", step: ["4"] }] }), [], "ids are unique across the four");
  assert.notDeepEqual(validateExpectation({ ...filled, unknown: undefined }), [], "UNKNOWN is a required list, never dropped");
  assert.notDeepEqual(validateExpectation({ ...filled, status: "sealed" }), [], "sealing is a seal record, not a status");
});

test("a denominator that differs between arms, or drops an UNKNOWN, is refused", () => {
  const judgments = kinds("judgment");
  const unknownItem = judgments.find(record => record.verdict === "UNKNOWN");
  assert.ok(unknownItem, "precondition: the examples carry an UNKNOWN");
  const dropUnknown = judgments.filter(record => !(record.item === unknownItem.item
    && record.product.arm === "new" && record.evaluator.arm === "old" && record.lane === unknownItem.lane));
  assert.notDeepEqual(checkDenominators(dropUnknown), []);
  const duplicate = [...judgments, judgments[0]];
  assert.notDeepEqual(checkDenominators(duplicate), []);
  const strayItem = [...judgments, { ...judgments[0], item: "stray", product: { ...judgments[0].product, arm: "new" } }];
  assert.notDeepEqual(checkDenominators(strayItem), []);
});

test("an evaluator change without all four cells is refused", () => {
  const judgments = kinds("judgment");
  for (const [product, evaluator] of [["old", "old"], ["old", "new"], ["new", "old"], ["new", "new"]]) {
    const missing = judgments.filter(record => !(record.product.arm === product && record.evaluator.arm === evaluator));
    assert.notDeepEqual(checkFourCell(missing), [], `missing ${product}/${evaluator}`);
  }
});

test("the vessel keeps the presented diagrams and the whole Atlas as gold sets", () => {
  const sets = JSON.parse(readFileSync(vessel + "gold/sets.json", "utf8"));
  assert.deepEqual(sets.sets.map(set => set.id).sort(), ["atlas", "presented-1", "presented-2"]);
  assert.ok(sets.sets.every(set => set.status === "unfilled" && set.seal_sha256 === null));
});

test("malformed JSONL lines are reported with their line numbers", () => {
  const parsed = parseJsonl('{"kind":"cost"}\nnot json\n\n');
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.errors.map(error => error.line), [2, 3]);
});
