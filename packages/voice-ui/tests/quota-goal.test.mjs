import assert from "node:assert/strict";
import test from "node:test";
import { quotaGoalBundle } from "../src/completion.mjs";
import { GOAL_OFFER_MAX } from "../src/contract.mjs";

const part = (key, label = "検証", kind = "step") => ({ key, label, kind, purpose: "one offered component" });
const required = (quantity = 1, kind = "step", label = "検証") => [{ label, kind, quantity }];

test("quota preserves inventory order and exact label/kind while enforcing one-use capacity", () => {
  const parts = [part("first"), part("other-kind", "検証", "data"), part("second"), part("other-label", "検証 "), part("third")];
  const bundle = { version: "fixture", parts, diagrams: null }, before = structuredClone(bundle);
  const result = quotaGoalBundle(bundle, required(2));
  assert.deepEqual(result.parts.map(p => p.key), ["first", "second"]);
  assert.deepEqual(result.parts, [parts[0], parts[2]]);
  assert.equal(result.version, bundle.version); assert.equal(result.diagrams, bundle.diagrams);
  assert.deepEqual(bundle, before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.parts) && result.parts.every(Object.isFrozen));
  parts[0].label = "changed input";
  assert.equal(result.parts[0].label, "検証");
});

test("empty and insufficient requirements preserve the available minimum without renaming or generation", () => {
  const bundle = { parts: [part("known")], diagrams: null };
  assert.deepEqual(quotaGoalBundle(bundle, []).parts, []);
  assert.deepEqual(quotaGoalBundle(bundle, required(3)).parts, bundle.parts);
  assert.deepEqual(quotaGoalBundle(bundle, required(1, "decision")).parts, []);
  assert.deepEqual(quotaGoalBundle({ parts: [] }, required()).parts, []);
});

test("each exact pair has its own quantity and the returned order follows stock, not requirement order", () => {
  const parts = [part("data-first", "検証", "data"), part("step-first"), part("data-second", "検証", "data"), part("step-second")];
  const rows = [...required(1), ...required(2, "data")];
  assert.deepEqual(quotaGoalBundle({ parts }, rows).parts.map(p => p.key), ["data-first", "step-first", "data-second"]);
});

test("closed invalid rows and repeated keys are refused before returning an executable bundle", () => {
  const valid = { parts: [part("known")] };
  for (const rows of [null, {}, [{ ...required()[0], extra: true }], required(0), required(4), required(1.5),
    required(1, "unknown"), required(1, "step", ""), [...required(), ...required()],
    [...required(2), ...required(2, "data")]]) assert.equal(quotaGoalBundle(valid, rows), null);
  for (const bundle of [null, undefined, [], {}, { parts: null }, { parts: [part("known"), part("known")] },
    { parts: [{ ...part("known"), parent: "oracle" }] }, { parts: [part("none")] }]) {
    assert.equal(quotaGoalBundle(bundle, required()), null);
  }
});

test("validated augmented stock uses the existing Goal offer ceiling", () => {
  const parts = Array.from({ length: GOAL_OFFER_MAX }, (_, i) => part("key-" + i));
  assert.equal(quotaGoalBundle({ parts }, required(3)).parts.length, 3);
  assert.equal(quotaGoalBundle({ parts: [...parts, part("excess")] }, required()), null);
});
