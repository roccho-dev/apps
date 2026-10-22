import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson, sha256Hex, validateExpectation, parseJsonl, verifyDirectory } from "../../../docs/voice-ui/closure-20261021/verify.mjs";

// R1 (apps#94 comment 6313847759): this test proves only that the evaluation
// vessel is self-consistent. A green run is no judgment of the product (§8-12).
// Each bypass found by W (apps#135 review) is fixed as a mutation of one
// complete fixture vessel that must be refused with its own rule's code, so
// removing that rule makes the test fail.
const vessel = fileURLToPath(new URL("../../../docs/voice-ui/closure-20261021/", import.meta.url));
const baseline = vessel + "fixtures/baseline/";
const NEW = "8890af76de0f31cd55539e69337b247ffb6db07a";

const records = (dir, file) => parseJsonl(readFileSync(join(dir, file), "utf8")).records;
const writeRecords = (dir, file, list) => writeFileSync(join(dir, file), list.map(record => JSON.stringify(record)).join("\n") + "\n");
const edit = (file, change) => dir => writeRecords(dir, file, change(records(dir, file)));
const judgments = change => edit("ledgers/judgments.jsonl", change);
// Copy bytes only: under Nix the source is a read-only store path, and a mode-preserving copy stays read-only.
const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else writeFileSync(join(to, entry.name), readFileSync(join(from, entry.name)));
  }
};
const run = (...mutations) => {
  const dir = mkdtempSync(join(tmpdir(), "closure-20261021-"));
  try {
    copyTree(baseline, dir);
    for (const mutate of mutations) mutate(dir);
    return verifyDirectory(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const codes = result => result.errors.map(error => error.split(" ")[0]);
const accepts = (...mutations) => assert.deepEqual(run(...mutations), { ok: true, errors: [] });
const refuses = (code, ...mutations) => {
  const result = run(...mutations);
  assert.equal(result.ok, false, `${code}: the mutation was ACCEPTED`);
  assert.ok(codes(result).includes(code), `${code} expected, got ${JSON.stringify(result.errors)}`);
};
const where = (match, change) => list => list.map(record => match(record) ? change(record) : record);
const isNew = record => record.product.arm === "new";

test("the committed vessel and the complete fixture vessel verify, and the CLI agrees", () => {
  assert.deepEqual(verifyDirectory(vessel), { ok: true, errors: [] });
  accepts();
  const cli = spawnSync(process.execPath, [vessel + "verify.mjs", baseline], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.deepEqual(JSON.parse(cli.stdout), { ok: true, errors: [] });
});

test("1: a PASS cites a gold seal, not the expectation's seal", () => {
  const expectation = records(baseline, "ledgers/seals.jsonl").find(seal => seal.target === "expectation").sha256;
  refuses("E_GOLD_TARGET", judgments(where(record => record.verdict === "PASS", record => ({ ...record, gold_seal_sha256: expectation }))));
});

test("2: a seal is recomputed from the sealed file's bytes", () => {
  refuses("E_SEAL_DIGEST", dir => writeFileSync(join(dir, "gold/presented-1/gold.json"), '{"items":{"r1":"present","r2":"present","f1":"present"}}\n'));
  refuses("E_SEAL_BYTES", edit("ledgers/seals.jsonl", where(seal => seal.target === "gold", seal => ({ ...seal, bytes: 0 }))));
  refuses("E_SEAL_MISSING", edit("ledgers/seals.jsonl", where(seal => seal.target === "gold", seal => ({ ...seal, path: "gold/presented-1/absent.json" }))));
});

test("3: a seal dated after a judgment that cites it is no seal, whatever it declares", () => {
  refuses("E_SEAL_LATE", edit("ledgers/seals.jsonl", where(seal => seal.target === "gold", seal => ({ ...seal, sealed_at: "2026-10-21T04:00:00Z" }))));
});

test("4: rounds are counted per cycle from the cycle ledger, so renaming a cycle does not reset them", () => {
  const rename = list => list.map(record => ({ ...record, cycle: "c2" }));
  refuses("E_CYCLE_UNOPENED", judgments(rename), edit("ledgers/costs.jsonl", rename));
  const openC2 = edit("ledgers/cycles.jsonl", list => [...list,
    { schema: "voice-ui.closure.cycle/1", kind: "cycle-open", cycle: "c2", seq: 2, previous: "c1", at: "2026-10-21T02:30:00Z" }]);
  refuses("E_CYCLE_OPEN_BEFORE_END", openC2, judgments(rename), edit("ledgers/costs.jsonl", rename));
  const round = value => list => list.map(record => ({ ...record, round: value }));
  refuses("E_ROUND_GAP", judgments(round(3)), edit("ledgers/costs.jsonl", round(3)));
  // Control: a new cycle after the previous one has ended is a new cycle.
  accepts(edit("ledgers/cycles.jsonl", list => [...list,
    { schema: "voice-ui.closure.cycle/1", kind: "cycle-end", cycle: "c1", end: "END2", at: "2026-10-21T04:00:00Z" },
    { schema: "voice-ui.closure.cycle/1", kind: "cycle-open", cycle: "c2", seq: 2, previous: "c1", at: "2026-10-21T04:10:00Z" }]));
});

test("5: END1 counts only a product SHA with a recorded GitHub readback for that SHA", () => {
  refuses("E_END1_RECEIPT", judgments(where(isNew, record => ({ ...record, product: { ...record.product, receipts: [] } }))));
  refuses("E_END1_RECEIPT", judgments(where(isNew, record => ({ ...record, product: { ...record.product, apps: "1".repeat(40) } }))));
  refuses("E_END1_RECEIPT", dir => rmSync(join(dir, `receipts/github/${NEW}.json`)));
  // Without END1 the same unverified SHA is only a reference.
  accepts(judgments(where(isNew, record => ({ ...record, counts_toward_end1: false, product: { ...record.product, receipts: [] } }))));
});

test("6: a counted cost cites an existing ledger line whose bytes and count match", () => {
  const ledger = change => edit("ledgers/costs.jsonl", list => list.map(cost => ({ ...cost, ...change(cost) })));
  refuses("E_COST_LEDGER", ledger(cost => ({ calls: 0, ledger: { ...cost.ledger, file: "no-such.jsonl", line: 9999 } })));
  refuses("E_COST_LEDGER", ledger(cost => ({ ledger: { ...cost.ledger, line_sha256: "0".repeat(64) } })));
  refuses("E_COST_MISMATCH", ledger(() => ({ calls: 25 })));
  accepts(ledger(() => ({ calls: "UNKNOWN", ledger: null })));
});

test("7: an evaluator change is detected by identity, not by its arm label", () => {
  refuses("E_EVALUATOR_ARM", judgments(where(isNew, record => ({ ...record, evaluator: { ...record.evaluator, sha256: "1e".repeat(32) } }))));
  const newEvaluator = list => [...list, ...list.map(record => ({ ...record, counts_toward_end1: false,
    evaluator: { arm: "new", id: "fixture-evaluator", sha256: "1e".repeat(32) } }))];
  accepts(judgments(newEvaluator));
  refuses("E_FOUR_CELL", judgments(list => newEvaluator(list).filter(record => !(isNew(record) && record.evaluator.arm === "new"))));
});

test("8: the denominator is the sealed expectation's Required and Forbidden, in at least two product cells", () => {
  refuses("E_DENOMINATOR", judgments(list => list.filter(record => record.verdict !== "UNKNOWN")));
  refuses("E_DENOMINATOR", judgments(list => [...list, ...list.filter(record => record.item === "r2")
    .map(record => ({ ...record, item: "zz", verdict: "FAIL", counts_toward_end1: false }))]));
  refuses("E_SINGLE_CELL", judgments(list => list.filter(record => !isNew(record))));
});

test("13: a judgment's gold is the gold set its sealed expectation names", () => {
  const atlas = '{"items":{"r1":"present","r2":"present","f1":"absent"}}\n';
  const sha = sha256Hex(canonicalJson(JSON.parse(atlas)));
  const sealAtlas = dir => {
    mkdirSync(join(dir, "gold/atlas"), { recursive: true });
    writeFileSync(join(dir, "gold/atlas/gold.json"), atlas);
    edit("ledgers/seals.jsonl", list => [...list, { ...list.find(seal => seal.target === "gold"),
      set: "atlas", path: "gold/atlas/gold.json", bytes: Buffer.byteLength(atlas), sha256: sha }])(dir);
  };
  accepts(sealAtlas);
  refuses("E_GOLD_SET", sealAtlas, judgments(where(record => record.verdict === "PASS", record => ({ ...record, gold_seal_sha256: sha }))));
});

test("14: a judgment cites the newest seal of its target and set that existed when it was judged (W, apps#145)", () => {
  const v2 = '{"items":{"r1":"present","r2":"present","f1":"absent"},"version":2}\n';
  const sha = sha256Hex(canonicalJson(JSON.parse(v2)));
  const sealV2 = at => dir => {
    writeFileSync(join(dir, "gold/presented-1/gold.v2.json"), v2);
    edit("ledgers/seals.jsonl", list => [...list, { ...list.find(seal => seal.target === "gold"),
      path: "gold/presented-1/gold.v2.json", bytes: Buffer.byteLength(v2), sha256: sha, sealed_at: at }])(dir);
  };
  refuses("E_SEAL_SUPERSEDED", sealV2("2026-10-21T02:30:00Z"));
  accepts(sealV2("2026-10-21T02:30:00Z"), judgments(list => list.map(record => ({ ...record, gold_seal_sha256: sha }))));
  // A newer seal made after the judgment does not rewrite that judgment's history.
  accepts(sealV2("2026-10-21T04:00:00Z"));
});

test("5c: the JUDGE lane records evaluator-eligibility judgments as its own denominator", () => {
  const judge = list => [...list, ...list.map(record => ({ ...record, lane: "JUDGE", step: ["8", "13"], counts_toward_end1: false }))];
  accepts(judgments(judge));
  refuses("E_DENOMINATOR", judgments(list => judge(list).filter(record => !(record.lane === "JUDGE" && record.item === "f1"))));
  refuses("E_SHAPE", judgments(list => list.map(record => ({ ...record, lane: "SCORE" }))));
  // W's review of apps#142: an evaluator-eligibility judgment never counts toward the product's END1,
  // and it records only the evaluator steps (§7 8 and 13), not product steps.
  refuses("E_SHAPE", judgments(list => judge(list).map(record => record.lane === "JUDGE" ? { ...record, counts_toward_end1: true } : record)));
  refuses("E_SHAPE", judgments(list => judge(list).map(record => record.lane === "JUDGE" ? { ...record, step: ["5"] } : record)));
});

test("record shapes still refuse what they exist to refuse", () => {
  refuses("E_SHAPE", judgments(list => list.map(record => ({ ...record, judge: "W" }))));
  refuses("E_SHAPE", judgments(list => list.map(record => ({ ...record, round: 5 }))));
  refuses("E_SHAPE", judgments(where(record => record.verdict === "PASS", record => ({ ...record, gold_seal_sha256: null }))));
  refuses("E_SHAPE", edit("ledgers/seals.jsonl", list => list.map(seal => ({ ...seal, before_exposure: false }))));
  refuses("E_SHAPE", edit("ledgers/seals.jsonl", list => list.map(seal => ({ ...seal, path: "../../../../../packages/voice-ui/src/turn.mjs" }))));
  refuses("E_SHAPE", edit("ledgers/costs.jsonl", list => list.map(cost => ({ ...cost, calls: "none" }))));
});

test("one canonical digest regardless of key order", () => {
  const a = { b: [1, { d: "é", c: null }], a: true };
  assert.equal(canonicalJson(a), canonicalJson({ a: true, b: [1, { c: null, d: "é" }] }));
  assert.equal(canonicalJson(a), '{"a":true,"b":[1,{"c":null,"d":"é"}]}');
  assert.match(sha256Hex(canonicalJson(a)), /^[0-9a-f]{64}$/u);
});

test("the expectation rules keep UNKNOWN, identities and the filled state honest", () => {
  const filled = JSON.parse(readFileSync(baseline + "expectations/e1.json", "utf8"));
  assert.deepEqual(validateExpectation(filled), []);
  assert.notDeepEqual(validateExpectation({ ...filled, required: [] }), []);
  assert.notDeepEqual(validateExpectation({ ...filled, source: { ...filled.source, text: "" } }), []);
  assert.notDeepEqual(validateExpectation({ ...filled, forbidden: [{ id: "r1", claim: "z", step: ["4"] }] }), []);
  assert.notDeepEqual(validateExpectation({ ...filled, unknown: undefined }), []);
});

test("the vessel keeps both presented diagrams and the whole Atlas; each sealed set matches its gold seal", () => {
  const sets = JSON.parse(readFileSync(vessel + "gold/sets.json", "utf8"));
  assert.deepEqual(sets.sets.map(set => set.id).sort(), ["atlas", "presented-1", "presented-2"]);
  const seals = records(vessel, "ledgers/seals.jsonl").filter(seal => seal.target === "gold");
  for (const set of sets.sets) {
    if (set.status === "unfilled") { assert.equal(set.seal_sha256, null, set.id); continue; }
    assert.equal(set.status, "sealed", set.id);
    assert.ok(seals.some(seal => seal.set === set.id && seal.sha256 === set.seal_sha256), `${set.id} names a recorded gold seal`);
  }
  assert.equal(sets.sets.find(set => set.id === "atlas").status, "unfilled", "Atlas is not sealed yet");
});

test("malformed JSONL lines are reported with their line numbers", () => {
  const parsed = parseJsonl('{"kind":"cost"}\nnot json\n\n');
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.errors.map(error => error.line), [2, 3]);
});
