import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isInventory, inventoryQuestion, readMissing, runInventoryGoal, typedMissingRequest } from "../src/completion.mjs";
import { readBundle } from "../src/bundle.mjs";
import { onParts } from "../functions/api/parts.mjs";
const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("../web/data/bundle.v1.json", import.meta.url))));
const initial = { working: { head: "fixture-head", records: [
  { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary" },
  { type: "region", id: "parent", parent: "root", label: "Container", kind: "group" },
] } };
const inventory = { kind: "voice-ui.goal.inventory.v1", state: { utterance: "Add a named step inside Container", head: "fixture-head",
  regions: initial.working.records.map(({ id, parent, label, kind }) => ({ id, parent, label, kind })), edges: [], parts: bundle.parts } };
const call = (mode, input = inventory, ports = {}, available = true) => onParts({ mode, available,
  request: new Request("https://fixture.invalid/api/parts/" + mode, { method: "POST", body: JSON.stringify(input) }),
}, ports);

test("inventory gate explicitly compares labels, kinds and one-instance capacities, not next-step NONE", () => {
  assert.equal(isInventory(inventory), true);
  const question = inventoryQuestion(inventory.state);
  assert.equal(question.state, inventory.state);
  assert.deepEqual(Object.keys(question.questions), ["intent", "coverage"]);
  assert.deepEqual(Object.keys(question.questions.intent.options), ["change", "ambiguous", "no-change", "unsupported"]);
  assert.deepEqual(Object.keys(question.questions.coverage.options), ["sufficient", "missing"]);
  for (const mutate of [x => { x.state.parts.push(x.state.parts[0]); }, x => { x.state.regions[0].kind = "code"; },
    x => { x.state.regions[1].parent = "unknown"; }, x => { x.state.extra = true; }]) {
    const x = structuredClone(inventory); mutate(x); assert.equal(isInventory(x), false);
  }
});

test("completion asks only for missing instances, with fixed existing kinds and no graph/operator fields", () => {
  const typed = typedMissingRequest(inventory.state);
  assert.equal(typed.context, JSON.stringify(inventory.state));
  assert.deepEqual(Object.keys(typed.questions), ["missing"]);
  assert.equal(typed.questions.missing.maxItems, 3);
  assert.deepEqual(Object.keys(typed.questions.missing.items.properties), ["label", "kind", "occurrence"]);
  assert.deepEqual(readMissing([{ label: "Build", kind: "step", occurrence: 1 }, { label: "Build", kind: "step", occurrence: 2 }]),
    [{ label: "Build", kind: "step", occurrence: 1 }, { label: "Build", kind: "step", occurrence: 2 }]);
  for (const value of [null, [{ label: "Build", kind: "step", occurrence: 2 }],
    [{ label: "Build", kind: "step", occurrence: 1, parent: "parent" }],
    [{ label: "Build", kind: "operation", occurrence: 1 }],
    [{ label: " ", kind: "step", occurrence: 1 }],
    Array(4).fill({ label: "Build", kind: "step", occurrence: 1 })]) assert.equal(readMissing(value), null);
});

test("API closures validate before invoking bound operations and never reflect raw failures", async () => {
  let calls = 0;
  const ports = { judge: async request => { calls++; assert.ok(request.questions.coverage); return { answers: {
    intent: { choice: "change", confidence: 1 }, coverage: { choice: "missing", confidence: 1 },
  } }; },
    generate: async request => { calls++; assert.ok(request.questions.missing); return { result: { missing: [{ label: "Build", kind: "step", occurrence: 1 }] } }; } };
  assert.deepEqual(await (await call("check", inventory, ports)).json(), { choice: "missing", confidence: 1 });
  assert.deepEqual(await (await call("complete", inventory, ports)).json(), { missing: [{ label: "Build", kind: "step", occurrence: 1 }] });
  assert.equal(calls, 2);
  assert.equal((await call("check", {}, ports)).status, 422);
  assert.equal((await call("complete", inventory, ports, false)).status, 503);
  assert.equal(calls, 2);
  const failed = await call("complete", inventory, { generate: async () => { throw Object.assign(new Error("private-canary"), { code: "provider_http_error" }); } });
  assert.equal(failed.status, 502); assert.deepEqual(await failed.json(), { error: "parts_provider_error" });
});

test("one batch separates intent from inventory and retains the weaker change confidence", async () => {
  for (const [intent, coverage, expected] of [
    [{ choice: "change", confidence: 0.8 }, { choice: "missing", confidence: 0.7 }, { choice: "missing", confidence: 0.7 }],
    [{ choice: "change", confidence: 0.4 }, { choice: "missing", confidence: 0.9 }, { choice: "missing", confidence: 0.4 }],
    [{ choice: "change", confidence: 0.9 }, { choice: "sufficient", confidence: 0.49 }, { choice: "sufficient", confidence: 0.49 }],
  ]) {
    let calls = 0;
    const response = await call("check", inventory, { judge: async () => { calls++; return { answers: { intent, coverage } }; } });
    assert.equal(calls, 1); assert.deepEqual(await response.json(), expected);
  }
  for (const choice of ["ambiguous", "no-change", "unsupported"]) {
    let calls = 0, generated = 0, adopted = 0;
    const result = await runInventoryGoal({ utterance: inventory.state.utterance, bundle, current: () => initial, cancelled: () => false,
      check: async () => (await call("check", inventory, { judge: async () => { calls++; return { answers: {
        intent: { choice, confidence: 0.8 }, coverage: { choice: "missing", confidence: 1 },
      } }; } })).json(), complete: async () => { generated++; }, adopt: async () => { adopted++; } });
    assert.equal(result.reason, "inventory-" + choice); assert.equal(calls, 1);
    assert.equal(generated, 0); assert.equal(adopted, 0);
  }
});

test("both factor answers are required and validated even for a non-change intent", async () => {
  const valid = { intent: { choice: "no-change", confidence: 1 }, coverage: { choice: "sufficient", confidence: 1 } };
  for (const change of [x => { delete x.intent; }, x => { delete x.coverage; },
    x => { x.intent.choice = "missing"; }, x => { x.coverage.choice = "ambiguous"; },
    x => { x.intent.confidence = NaN; }, x => { x.coverage.confidence = Infinity; },
    x => { x.intent.confidence = -0.1; }, x => { x.coverage.confidence = 1.1; }]) {
    const answers = structuredClone(valid); change(answers);
    const response = await call("check", inventory, { judge: async () => ({ answers }) });
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: "parts_contract" });
  }
});

test("ambiguous/no-change/unsupported/weak gates never synthesize or mutate", async () => {
  for (const [choice, confidence] of [["ambiguous", 1], ["no-change", 1], ["unsupported", 1], ["missing", 0.49]]) {
    let generated = 0, adopted = 0;
    const result = await runInventoryGoal({ utterance: inventory.state.utterance, bundle, current: () => initial, cancelled: () => false,
      check: async () => ({ choice, confidence }), complete: async () => { generated++; }, adopt: async () => { adopted++; } });
    assert.equal(result.requests, 1); assert.equal(generated, 0); assert.equal(adopted, 0);
  }
});

test("stale/cancelled/invalid answers stop before completion; unknown detail is discarded", async () => {
  let current = initial, generated = 0;
  const options = { utterance: inventory.state.utterance, bundle, current: () => current, cancelled: () => false,
    complete: async () => { generated++; } };
  const stale = await runInventoryGoal({ ...options, check: async () => { current = { ...initial }; return { choice: "missing", confidence: 1 }; } });
  assert.equal(stale.reason, "stale-goal"); assert.equal(generated, 0);
  current = initial;
  const invalid = await runInventoryGoal({ ...options, check: async () => ({ choice: "missing", confidence: 1, extra: "private-canary" }) });
  assert.equal(invalid.reason, "inventory-contract"); assert.ok(!JSON.stringify(invalid).includes("canary"));
  const cancelled = await runInventoryGoal({ ...options, cancelled: () => true, check: () => { throw new Error("must not call"); } });
  assert.equal(cancelled.requests, 0); assert.equal(generated, 0);
});

test("completion and the legal loop share one absolute dispatch deadline", async () => {
  let clock = 0, armed = false, asked = 0;
  const now = () => { const value = clock; if (armed) clock = 180001; return value; };
  const result = await runInventoryGoal({ now, utterance: inventory.state.utterance, bundle,
    current: () => initial, cancelled: () => false, check: async () => ({ choice: "missing", confidence: 1 }),
    complete: async () => { clock = 179999; armed = true; return { missing: [{ label: "Build", kind: "step", occurrence: 1 }] }; },
    ask: async () => { asked++; }, adopt: async () => { throw new Error("must not adopt"); } });
  assert.equal(result.reason, "budget-time"); assert.equal(asked, 0);
  assert.equal(result.inventory.completions, 1);
});
