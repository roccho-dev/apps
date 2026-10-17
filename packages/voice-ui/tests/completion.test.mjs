import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isInventory, inventoryQuestion, readTypedMissing, runInventoryGoal, typedMissingRequest } from "../src/completion.mjs";
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
const slots = rows => Object.fromEntries([1, 2, 3].map((n, i) => ["missing" + n,
  rows[i] ?? { label: "", kind: "none", quantity: 0 }]));

test("inventory gate explicitly compares labels, kinds and one-instance capacities, not next-step NONE", () => {
  assert.equal(isInventory(inventory), true);
  const question = inventoryQuestion(inventory.state);
  assert.equal(question.state.utterance, inventory.state.utterance);
  assert.deepEqual(question.state.regions, inventory.state.regions);
  assert.deepEqual(question.state.edges, inventory.state.edges);
  assert.equal(question.state.parts.find(p => p.label === "API").capacity, 1);
  assert.deepEqual(Object.keys(question.questions), ["intent", "labels", "capacity"]);
  assert.deepEqual(Object.keys(question.questions.intent.options), ["change", "ambiguous", "no-change", "unsupported"]);
  assert.deepEqual(Object.keys(question.questions.labels.options), ["available", "missing"]);
  assert.deepEqual(Object.keys(question.questions.capacity.options), ["within", "exceeded"]);
  for (const { label, kind } of inventory.state.parts)
    assert.ok(question.questions.labels.options.available.includes(JSON.stringify({ label, kind })));
  for (const mutate of [x => { x.state.parts.push(x.state.parts[0]); }, x => { x.state.regions[0].kind = "code"; },
    x => { x.state.regions[1].parent = "unknown"; }, x => { x.state.extra = true; }]) {
    const x = structuredClone(inventory); mutate(x); assert.equal(isInventory(x), false);
  }
});

test("provider inventory counts executable keys, retains existing graph facts and does not infer requested quantities", () => {
  const state = structuredClone(inventory.state);
  state.parts.push({ ...state.parts[0], key: "another-step" });
  const before = JSON.stringify(state), context = inventoryQuestion(state).state;
  assert.equal(context.parts.find(p => p.label === state.parts[0].label).capacity, 2);
  assert.deepEqual(context.regions, state.regions); assert.deepEqual(context.edges, state.edges);
  assert.equal(context.utterance, state.utterance); assert.equal(JSON.stringify(state), before);
  assert.deepEqual(Object.keys(context).sort(), ["edges", "limits", "parts", "regions", "utterance"]);
});

test("completion asks only for missing instances, with fixed existing kinds and no graph/operator fields", () => {
  const typed = typedMissingRequest(inventory.state);
  assert.deepEqual(JSON.parse(typed.context), inventoryQuestion(inventory.state).state);
  assert.deepEqual(Object.keys(typed.questions), ["missing1", "missing2", "missing3"]);
  for (const question of Object.values(typed.questions)) {
    assert.equal(question.type, "object");
    assert.deepEqual(Object.keys(question.properties), ["label", "kind", "quantity"]);
    assert.ok(question.properties.kind.enum.includes("none"));
  }
});

test("invalid completed instance contracts stop before the legal loop or adoption", async () => {
  for (const value of [null, [{ label: "Build", kind: "step", occurrence: 2 }],
    [{ label: "Build", kind: "step", occurrence: 1, parent: "parent" }],
    [{ label: "Build", kind: "operation", occurrence: 1 }],
    [{ label: " ", kind: "step", occurrence: 1 }],
    Array(4).fill({ label: "Build", kind: "step", occurrence: 1 })]) {
    const result = await runInventoryGoal({ utterance: inventory.state.utterance, bundle, current: () => initial, cancelled: () => false,
      check: async () => ({ choice: "missing", confidence: 1 }), complete: async () => ({ missing: value }),
      ask: async () => { assert.fail("invalid instances reached the legal loop"); },
      adopt: async () => { assert.fail("invalid instances were adopted"); } });
    assert.equal(result.reason, "completion-contract");
  }
});

test("distinct typed quantities expand exactly; duplicate pairs, extra fields and oversized totals fail closed", () => {
  assert.deepEqual(readTypedMissing(slots([])), []);
  assert.deepEqual(readTypedMissing(slots([{ label: "Box", kind: "step", quantity: 2 }, { label: "Store", kind: "data", quantity: 1 }])), [
    { label: "Box", kind: "step", occurrence: 1 }, { label: "Box", kind: "step", occurrence: 2 },
    { label: "Store", kind: "data", occurrence: 1 },
  ]);
  for (const value of [null, [{ label: "Box", kind: "step", quantity: 0 }],
    [{ label: "Box", kind: "step", quantity: 1.5 }], [{ label: "Box", kind: "step", quantity: 4 }],
    [{ label: "Box", kind: "step", quantity: 1, parent: "parent" }], [{ label: "Box", kind: "operator", quantity: 1 }],
    [{ label: " ", kind: "step", quantity: 1 }],
    [{ label: "Box", kind: "step", quantity: 1 }, { label: "Box", kind: "step", quantity: 2 }],
    [{ label: "Box", kind: "step", quantity: 2 }, { label: "Store", kind: "data", quantity: 2 }]]) {
    assert.equal(readTypedMissing(value === null ? null : slots(value)), null);
  }
  for (const value of [[], { ...slots([]), extra: true },
    slots([{ label: "unused", kind: "none", quantity: 0 }]),
    slots([{ label: "", kind: "none", quantity: 1 }]),
    slots([{ label: "", kind: "none", quantity: 0 }, { label: "Box", kind: "step", quantity: 1 }])])
    assert.equal(readTypedMissing(value), null);
});

test("API closures validate before invoking bound operations and never reflect raw failures", async () => {
  let calls = 0;
  const ports = { judge: async request => { calls++; assert.ok(request.questions.labels); assert.ok(request.questions.capacity); return { answers: {
    intent: { choice: "change", confidence: 1 }, labels: { choice: "missing", confidence: 1 }, capacity: { choice: "within", confidence: 1 },
  } }; },
    generate: async request => { calls++; assert.deepEqual(Object.keys(request.questions), ["missing1", "missing2", "missing3"]);
      return { result: slots([{ label: "Build", kind: "step", quantity: 1 }]) }; } };
  assert.deepEqual(await (await call("check", inventory, ports)).json(), { choice: "missing", confidence: 1 });
  assert.deepEqual(await (await call("complete", inventory, ports)).json(), { missing: [{ label: "Build", kind: "step", occurrence: 1 }] });
  assert.equal(calls, 2);
  assert.equal((await call("check", {}, ports)).status, 422);
  assert.equal((await call("complete", inventory, ports, false)).status, 503);
  assert.equal(calls, 2);
  const failed = await call("complete", inventory, { generate: async () => { throw Object.assign(new Error("private-canary"), { code: "provider_http_error" }); } });
  assert.equal(failed.status, 502); assert.deepEqual(await failed.json(), { error: "parts_provider_error" });
});

test("completion failure diagnostics expose only finite structural facts", async () => {
  const logs = [], original = console.info;
  console.info = value => logs.push(JSON.parse(value));
  try {
    const response = await call("complete", inventory, { generate: async () => ({ result: slots([
      { label: "private-label-canary", kind: "none", quantity: 0 },
    ]) }) });
    assert.equal(response.status, 502);
    assert.deepEqual(logs[0], { kind: "voice-ui.parts.contract.v1", stage: "local-result", rootExact: true,
      slots: [{ exact: true, label: "nonempty", kind: "none", quantity: 0 },
        { exact: true, label: "empty", kind: "none", quantity: 0 },
        { exact: true, label: "empty", kind: "none", quantity: 0 }], duplicatePair: false });
    for (const code of ["provider_contract_error", "private-code-canary"]) {
      const failed = await call("complete", inventory, { generate: async () => {
        throw Object.assign(Error("private-message-canary"), { code, result: "private-result-canary" });
      } });
      assert.equal(failed.status, 502);
    }
    assert.deepEqual(logs.slice(1), [
      { kind: "voice-ui.parts.contract.v1", stage: "provider", code: "provider_contract_error" },
      { kind: "voice-ui.parts.contract.v1", stage: "provider", code: "unknown" },
    ]);
    assert.equal(JSON.stringify(logs).includes("private-"), false);
  } finally { console.info = original; }
});

test("missing uses only positive witnesses bounded by intent; sufficient needs every factor", async () => {
  for (const [intent, labels, capacity, expected] of [
    [{ choice: "change", confidence: 0.8 }, { choice: "missing", confidence: 0.7 }, { choice: "within", confidence: 1 }, { choice: "missing", confidence: 0.7 }],
    [{ choice: "change", confidence: 0.9 }, { choice: "missing", confidence: 0.4 }, { choice: "within", confidence: 1 }, { choice: "missing", confidence: 0.4 }],
    [{ choice: "change", confidence: 0.9 }, { choice: "available", confidence: 1 }, { choice: "exceeded", confidence: 0.49 }, { choice: "missing", confidence: 0.49 }],
    [{ choice: "change", confidence: 1 }, { choice: "missing", confidence: 0.4 }, { choice: "exceeded", confidence: 0.9 }, { choice: "missing", confidence: 0.9 }],
    [{ choice: "change", confidence: 0.4 }, { choice: "missing", confidence: 0.9 }, { choice: "exceeded", confidence: 1 }, { choice: "missing", confidence: 0.4 }],
    [{ choice: "change", confidence: 0.8 }, { choice: "available", confidence: 0.9 }, { choice: "within", confidence: 0.7 }, { choice: "sufficient", confidence: 0.7 }],
    [{ choice: "change", confidence: 1 }, { choice: "available", confidence: 0.49 }, { choice: "within", confidence: 1 }, { choice: "sufficient", confidence: 0.49 }],
    [{ choice: "change", confidence: 1 }, { choice: "available", confidence: 1 }, { choice: "within", confidence: 0.49 }, { choice: "sufficient", confidence: 0.49 }],
  ]) {
    let calls = 0;
    const response = await call("check", inventory, { judge: async () => { calls++; return { answers: { intent, labels, capacity } }; } });
    assert.equal(calls, 1); assert.deepEqual(await response.json(), expected);
  }
  for (const choice of ["ambiguous", "no-change", "unsupported"]) {
    let calls = 0, generated = 0, adopted = 0;
    const result = await runInventoryGoal({ utterance: inventory.state.utterance, bundle, current: () => initial, cancelled: () => false,
      check: async () => (await call("check", inventory, { judge: async () => { calls++; return { answers: {
        intent: { choice, confidence: 0.8 }, labels: { choice: "missing", confidence: 1 }, capacity: { choice: "exceeded", confidence: 1 },
      } }; } })).json(), complete: async () => { generated++; }, adopt: async () => { adopted++; } });
    assert.equal(result.reason, "inventory-" + choice); assert.equal(calls, 1);
    assert.equal(generated, 0); assert.equal(adopted, 0);
  }
});

test("every factor is required and validated even for a non-change intent", async () => {
  const valid = { intent: { choice: "no-change", confidence: 1 }, labels: { choice: "available", confidence: 1 }, capacity: { choice: "within", confidence: 1 } };
  for (const change of [x => { delete x.intent; }, x => { delete x.labels; }, x => { delete x.capacity; },
    x => { x.intent.choice = "missing"; }, x => { x.labels.choice = "ambiguous"; }, x => { x.capacity.choice = "sufficient"; },
    x => { x.intent.confidence = NaN; }, x => { x.labels.confidence = Infinity; }, x => { x.capacity.confidence = "1"; },
    x => { x.intent.confidence = -0.1; }, x => { x.labels.confidence = 1.1; }, x => { x.capacity.confidence = -1; }]) {
    const answers = structuredClone(valid); change(answers);
    const response = await call("check", inventory, { judge: async () => ({ answers }) });
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: "parts_contract" });
  }
});

test("factor evidence logs only finite choices/confidences and a canonical head", async () => {
  const saved = console.info, lines = [];
  console.info = line => { lines.push(JSON.parse(line)); };
  try {
    const ports = { judge: async () => ({ answers: {
      intent: { choice: "change", confidence: 1, extra: "private-canary" },
      labels: { choice: "missing", confidence: 0.9 }, capacity: { choice: "within", confidence: 1 },
    } }) };
    const canonical = structuredClone(inventory); canonical.state.head = "sha256:" + "a".repeat(64);
    await call("check", canonical, ports); await call("check", inventory, ports);
    assert.equal(lines[0].head, canonical.state.head); assert.equal(lines[1].head, null);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["factors", "head", "kind"]);
    assert.deepEqual(Object.keys(lines[0].factors), ["intent", "labels", "capacity"]);
    assert.deepEqual(Object.keys(lines[0].factors.intent), ["choice", "confidence"]);
    assert.ok(!JSON.stringify(lines).includes("private-canary"));
    assert.ok(!JSON.stringify(lines).includes(inventory.state.utterance));
  } finally { console.info = saved; }
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
