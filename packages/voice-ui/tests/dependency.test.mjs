import assert from "node:assert/strict";
import test from "node:test";
import { inventoryQuestion, requiredRequest } from "../src/completion.mjs";
import { onRequirements } from "../functions/api/parts.mjs";

const inventory = { kind: "voice-ui.goal.inventory.v1", state: {
  utterance: "ContainerにFixtureを3つ追加", head: "fixture-head",
  regions: [{ id: "root", parent: null, label: "World", kind: "boundary" },
    { id: "container", parent: "root", label: "Container", kind: "group" }], edges: [],
  parts: [{ key: "sample", purpose: "one reusable instance", label: "Fixture", kind: "step" }],
} };
const slots = { required1: { label: "Fixture", kind: "step", quantity: "3" },
  required2: { label: "", kind: "none", quantity: "0" }, required3: { label: "", kind: "none", quantity: "0" } };
const invoke = (ports, options = {}) => onRequirements({
  request: new Request("https://fixture.invalid/api/parts/requirements", { method: "POST", body: JSON.stringify(inventory) }),
  mode: "requirements", method: "adaptive-v2", available: true, ...options,
}, ports);

test("the dependency ablation retains every context, instruction, enum and answer path", () => {
  const context = inventoryQuestion(inventory.state).state;
  const independent = requiredRequest(context, { generation: "independent" });
  const dependent = requiredRequest(context);
  assert.deepEqual(dependent, requiredRequest(context, { generation: "dependent" }));
  const dependencies = {};
  const strip = (value, path = "") => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => strip(v, path));
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (key === "depends_on") { dependencies[path] = child; return []; }
      return [[key, strip(child, path ? path + "." + key : key)]];
    }));
  };
  assert.deepEqual(strip(dependent), independent);
  assert.deepEqual(dependencies, {
    "questions.required1.properties.label": ["kind"],
    "questions.required1.properties.quantity": ["kind", "label"],
    "questions.required2.properties.label": ["kind"],
    "questions.required2.properties.quantity": ["kind", "label"],
    "questions.required2": ["required1"],
    "questions.required3.properties.label": ["kind"],
    "questions.required3.properties.quantity": ["kind", "label"],
    "questions.required3": ["required1", "required2"],
  });
  assert.throws(() => requiredRequest(inventory.state, { generation: "repair" }));
});

test("direct extraction binds each actual payload and valid/invalid receipt to its policy", async () => {
  const logs = [], original = console.info;
  console.info = line => logs.push(JSON.parse(line));
  try {
    for (const generation of ["independent", "dependent"]) for (const valid of [true, false]) {
      let sends = 0;
      const response = await invoke({ judge: () => assert.fail("direct F Jev"), generate: async request => {
        sends++; assert.deepEqual(request, requiredRequest(inventoryQuestion(inventory.state).state, { generation }));
        return { result: valid ? slots : { ...slots, private: "must-not-leak" } };
      } }, { generation });
      assert.equal(response.status, valid ? 200 : 502); assert.equal(sends, 1);
      const stage = logs.at(-1);
      assert.equal(stage.stage, "TYPE_REQUIRED"); assert.equal(stage.generation, generation); assert.equal(stage.valid, valid);
      assert.equal(JSON.stringify(stage).includes("must-not-leak"), false);
    }
    for (const options of [{ generation: "repair" }, { mode: "check", generation: "independent" },
      { mode: "verify", generation: "independent" }]) {
      const response = await invoke({ judge: () => assert.fail("invalid Jev"), generate: () => assert.fail("invalid Type") }, options);
      assert.equal(response.status, 422);
    }
  } finally { console.info = original; }
});

test("literal-only interpretation still prepares recognized stock shortages without Type", async () => {
  let sends = 0;
  const response = await invoke({ judge: async () => {
    sends++;
    return { answers: Object.fromEntries(Object.entries({ intent: "change", labels: "available", capacity: "exceeded", completeness: "complete" })
      .map(([name, choice]) => [name, { choice, confidence: .9 }])) };
  }, generate: () => assert.fail("complete B must not interpret") }, { mode: "check", method: "literal-v2" });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(sends, 1); assert.equal(result.choice, "missing");
  assert.equal(result.inspection.proposal, null);
  assert.deepEqual(result.inspection.required, [{ label: "Fixture", kind: "step", quantity: 3 }]);
  assert.deepEqual(result.inspection.missing, [1, 2].map(occurrence => ({ label: "Fixture", kind: "step", occurrence })));
});
