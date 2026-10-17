import assert from "node:assert/strict";
import test from "node:test";
import { onParts } from "../functions/api/parts.mjs";
import { runInventoryGoal } from "../src/completion.mjs";
import { literalInventory } from "../src/literal-inventory.mjs";

const input = utterance => ({ kind: "voice-ui.goal.inventory.v1", state: { utterance, head: "fixture-head",
  regions: [{ id: "root", label: "World", kind: "boundary", parent: null },
    { id: "container", label: "Container", kind: "group", parent: "root" },
    { id: "existing-db", label: "DB", kind: "data", parent: "container" }], edges: [],
  parts: [{ key: "db", purpose: "one database", label: "DB", kind: "data" }] } });
const answer = (completeness = "complete", confidence = .9) => ({ answers: {
  intent: { choice: "change", confidence: .8 }, labels: { choice: "missing", confidence: .1 },
  capacity: { choice: "within", confidence: .1 }, completeness: { choice: completeness, confidence },
} });
const check = async (value, response) => {
  let calls = 0;
  const result = await onParts({ method: "literal", mode: "check", available: true,
    request: new Request("http://localhost/api/parts/check", { method: "POST", body: JSON.stringify(value) }) }, {
    judge: async question => {
      calls++; assert.deepEqual(Object.keys(question.questions), ["intent", "labels", "capacity", "completeness"]);
      assert.equal(question.state.literal.spans.every(span => value.state.utterance.slice(span.start, span.end) === span.source), true);
      return response;
    }, generate: () => { throw Error("unexpected Type call"); },
  });
  assert.equal(calls, 1); assert.equal(result.status, 200); return result.json();
};
test("literal capacity counts keys rather than existing nodes and preserves original names/counts", () => {
  const value = literalInventory(input("DBを3個追加").state);
  assert.deepEqual(value.required, [{ label: "DB", kind: "data", quantity: 3 }]);
  assert.equal(value.missing.length, 2);
  assert.equal(value.recognized, true);
});
test("Jev intent and completeness, independently of legacy labels/capacity, bound deterministic availability", async () => {
  const value = await check(input("DBを3個追加"), answer());
  assert.equal(value.choice, "missing"); assert.equal(value.confidence, .8);
  assert.equal(value.inspection.completeness.confidence, .9);
  assert.equal((await check(input("DBを1個だけ追加"), answer("complete", .6))).confidence, .6);
});
test("partial recognition, incomplete or low-confidence assessment cannot authorize execution", async () => {
  const value = input("data「A」を追加し、別の何かも追加");
  for (const response of [answer("incomplete"), answer("complete", .49)]) {
    const result = await check(value, response);
    assert.equal(result.choice, "unknown"); assert.equal(result.confidence, null);
    const session = { working: { head: value.state.head, records: value.state.regions.map(region => ({ type: "region", ...region })) } };
    let extra = 0;
    const stopped = await runInventoryGoal({ utterance: value.state.utterance, bundle: { parts: value.state.parts },
      current: () => session, cancelled: () => false, check: async () => result,
      complete: () => { extra++; }, ask: () => { extra++; }, adopt: () => { extra++; } });
    assert.equal(stopped.reason, "inventory-unresolved"); assert.equal(extra, 0);
  }
  const unrecognized = await check(input("create a new uniquely named thing"), answer());
  assert.equal(unrecognized.choice, "unknown");
});
