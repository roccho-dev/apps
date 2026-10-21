import assert from "node:assert/strict";
import test from "node:test";
import { onRequirements } from "../functions/api/parts.mjs";
import { readLiteralInspection, readRequirementInspection, runInventoryGoal } from "../src/completion.mjs";

const input = (utterance = '作業区に工程「検算窓🧮」を2個とデータ「台帳」を1個追加') => ({
  kind: "voice-ui.goal.inventory.v1", state: { utterance, head: "fixture",
    regions: [{ id: "root", label: "World", kind: "boundary", parent: null },
      { id: "g", label: "作業区", kind: "group", parent: "root" },
      { id: "existing", label: "検算窓🧮", kind: "step", parent: "g" }], edges: [],
    parts: [{ key: "step", label: "検算窓🧮", kind: "step", purpose: "one new task instance" },
      { key: "data", label: "台帳", kind: "data", purpose: "one new data instance" },
      { key: "default", label: "工程", kind: "step", purpose: "one default task instance" }],
  },
});
const rows = [{ label: "検算窓🧮", kind: "step", quantity: 2 }, { label: "台帳", kind: "data", quantity: 1 }];
const slots = required => Object.fromEntries([1, 2, 3].map((n, i) => ["required" + n, required[i]
  ? { ...required[i], quantity: String(required[i].quantity) } : { label: "", kind: "none", quantity: "0" }]));
const flat = required => Object.fromEntries(Object.entries(slots(required)).flatMap(([name, row]) =>
  Object.entries(row).map(([field, value]) => [name + "_" + field, value])));
const factors = (complete = "incomplete", confidence = .9) => Object.fromEntries(Object.entries({
  intent: "change", labels: "missing", capacity: "within", completeness: complete,
}).map(([name, choice]) => [name, { choice, confidence }]));
const invoke = (inventory, ports, { mode = "check", generation = "dependent" } = {}) => onRequirements({
  request: new Request("http://fixture.invalid", { method: "POST", body: JSON.stringify(inventory) }),
  mode, generation, method: "adaptive-v3", available: true,
}, ports);

test("ordinary adaptive extraction refuses an invented name before Jev verification without retry", async () => {
  let judges = 0, types = 0;
  const response = await invoke(input(), {
    judge: async () => { judges++; return { answers: factors() }; },
    generate: async request => {
      types++;
      assert.equal(Object.keys(request.questions).length, 9);
      assert.equal(Object.values(request.questions).filter(q => q.thinking === true).length, 3);
      return { result: flat([{ label: "InventedNowhere", kind: "step", quantity: 1 }]) };
    },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "parts_contract" });
  assert.equal(judges, 1); assert.equal(types, 1);
});

test("explicit names and exact definition defaults retain total counts and minimal missing stock", async () => {
  const novel = input(); novel.state.parts = [];
  for (const [inventory, required, missing] of [[input(), rows, [{ label: "検算窓🧮", kind: "step", occurrence: 1 }]],
    [novel, rows, [{ label: "検算窓🧮", kind: "step", occurrence: 1 },
      { label: "検算窓🧮", kind: "step", occurrence: 2 }, { label: "台帳", kind: "data", occurrence: 1 }]],
    [input("作業区に作業を1個追加"), [{ label: "工程", kind: "step", quantity: 1 }], []]]) {
    let judges = 0, types = 0;
    const response = await invoke(inventory, {
      judge: async () => ({ answers: factors(++judges === 1 ? "incomplete" : "complete") }),
      generate: async () => { types++; return { result: flat(required) }; },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.inspection.required, required);
    assert.deepEqual(body.inspection.missing, missing);
    assert.equal(body.choice, missing.length ? "missing" : "sufficient");
    assert.ok(readRequirementInspection(body.inspection, inventory.state, readLiteralInspection));
    assert.equal(judges, 2); assert.equal(types, 1);
  }
});

test("ordinary full-extraction profiles reject names without a matching display source", async () => {
  for (const generation of ["independent", "dependent", "flat-scalars", "thinking-labels"]) {
    for (const required of [[{ label: "InventedNowhere", kind: "step", quantity: 1 }],
      [{ label: "工程", kind: "data", quantity: 1 }]]) {
      let types = 0;
      const response = await invoke(input("作業区に作業を1個追加"), {
        judge: async () => assert.fail("direct extraction must not verify"),
        generate: async () => { types++; return { result: generation.includes("scalar") || generation === "thinking-labels"
          ? flat(required) : slots(required) }; },
      }, { mode: "requirements", generation });
      assert.equal(response.status, 502, generation); assert.equal(types, 1);
    }
  }
});

test("browser receipt readback cannot reintroduce an ungrounded generated name", async () => {
  const inventory = input();
  const response = await invoke(inventory, {
    judge: async request => ({ answers: factors(request.state.required ? "complete" : "incomplete") }),
    generate: async () => ({ result: flat(rows) }),
  });
  const { inspection } = await response.json();
  for (const row of [inspection.proposal.slots.required1, inspection.proposal.required[0],
    inspection.required[0], inspection.missing[0]]) row.label = "InventedNowhere";
  assert.equal(readRequirementInspection(inspection, inventory.state, readLiteralInspection), null);
});

test("a grounded but unverified proposal stays unknown and prepares no executable candidates", async () => {
  for (const verification of [factors("incomplete"), factors("complete", .49)]) {
    const inventory = input(), first = { working: { head: inventory.state.head,
      records: inventory.state.regions.map(region => ({ type: "region", ...region })) } };
    let judges = 0, types = 0;
    const result = await runInventoryGoal({ utterance: inventory.state.utterance, bundle: { parts: inventory.state.parts },
      current: () => first, cancelled: () => false,
      check: async request => (await invoke(request, {
        judge: async () => ({ answers: ++judges === 1 ? factors() : verification }),
        generate: async () => { types++; return { result: flat([{ label: "工程", kind: "step", quantity: 2 }]) }; },
      })).json(),
      complete: async () => assert.fail("no second completion"), ask: async () => assert.fail("unverified Goal"),
      adopt: async () => assert.fail("unverified adoption"),
    });
    assert.equal(result.reason, "inventory-unresolved");
    assert.equal(result.inventory.preparations, 0); assert.deepEqual(result.inventory.missing, []);
    assert.equal(judges, 2); assert.equal(types, 1);
  }
});
