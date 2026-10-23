import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { runInventoryGoal, isInventory } from "../src/completion.mjs";
import { readBundle } from "../src/bundle.mjs";
import { createSession } from "../src/session.mjs";
import { OFFER_MAX } from "../src/contract.mjs";

// A quoted relation label next to a relation word becomes one request-local flow offer (round 3). The phrasings are
// written for this test; none is an EV script line.
const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("../web/data/bundle.v1.json", import.meta.url))));
const regions = [{ id: "root", parent: null, label: "World", kind: "boundary" },
  { id: "container", parent: "root", label: "Container", kind: "group" },
  { id: "alpha", parent: "container", label: "Alpha", kind: "step" }, { id: "beta", parent: "container", label: "Beta", kind: "step" }];
async function offered(utterance, given = bundle) {
  const session = createSession({ accepted: { head: "fixture-head", log: "fixture-log", decisions: [],
    records: regions.map(r => ({ type: "region", ...r, bounds: [0, 0, 200, 100], summary: "" })) }, stored: "fixture-log" });
  let request = null;
  const result = await runInventoryGoal({ utterance, bundle: given, protocol: {}, current: () => session, cancelled: () => false,
    check: async value => { request = structuredClone(value); throw Error("stop after the inventory request"); },
    complete: async () => assert.fail("no completion"), ask: async () => assert.fail("no Goal"), adopt: async () => assert.fail("no adoption") });
  assert.equal(result.reason, "inventory-unknown");
  assert.equal(session.working.log, "fixture-log");
  return request;
}
const flow = label => ({ kind: "flow", label });

test("bundle/2 is extended (delta) and its default relation catalogue is the unlabelled flow", async () => {
  assert.equal(bundle.goalSelection, "delta");
  const request = await offered("AlphaからBetaへ矢印をつないで");
  assert.ok(isInventory(request));
  assert.deepEqual(request.state.relations, [flow("")]);
});

for (const [utterance, labels] of [
  ["AlphaからBetaへ「同期する」の矢印をつないで", ["同期する"]],
  ["AlphaとBetaを『呼び出し』という関係で結んで", ["呼び出し"]],
  ["Alphaから Beta に「通知」の線を引いてください", ["通知"]],
  ["Alpha→Beta に「読む」の矢印、Beta→Alpha に「書く」の矢印", ["読む", "書く"]],
  ["「参照」の矢印と「参照」の矢印", ["参照"]],
]) test(`quoted relation label offered: ${utterance}`, async () => {
  const request = await offered(utterance);
  assert.ok(isInventory(request));
  assert.deepEqual(request.state.relations, [flow(""), ...labels.map(flow)]);
});

test("quotes not next to a relation word, and unquoted labels, offer nothing new", async () => {
  for (const utterance of ["Alphaに「同期する」と書いて", "「Gamma」を追加して", "AlphaからBetaへ同期の矢印をつないで"])
    assert.deepEqual((await offered(utterance)).state.relations, [flow("")], utterance);
});

test("the catalogue stays first, duplicates are not offered twice, and the finite bound holds", async () => {
  const catalogued = Object.freeze({ ...bundle, relations: Object.freeze([flow(""), flow("同期する")]) });
  assert.deepEqual((await offered("AlphaからBetaへ「同期する」の矢印", catalogued)).state.relations, [flow(""), flow("同期する")]);
  const many = Array.from({ length: OFFER_MAX + 3 }, (_, i) => `「L${i}」の矢印`).join("、");
  const request = await offered(many);
  assert.ok(isInventory(request));
  assert.equal(request.state.relations.length, OFFER_MAX);
  assert.deepEqual(request.state.relations.slice(0, 2), [flow(""), flow("L0")]);
});
