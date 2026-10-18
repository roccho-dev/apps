import assert from "node:assert/strict";
import test from "node:test";
import { onRequirements } from "../functions/api/parts.mjs";
import { readRequirementInspection, readRequiredSlots, requiredDifference } from "../src/completion.mjs";
import { readLiteralInspection, runInventoryGoal } from "../src/completion.mjs";
import { readBundle } from "../src/bundle.mjs";
import { createSession } from "../src/session.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stock = [{ key: "sample", purpose: "one reusable instance", label: "Fixture", kind: "step" }];
const inventory = (utterance = 'Containerに工程「Novel」を1個追加') => ({ kind: "voice-ui.goal.inventory.v1", state: {
  utterance, head: "fixture-head", regions: [{ id: "root", parent: null, label: "World", kind: "boundary" },
    { id: "container", parent: "root", label: "Container", kind: "group" }], edges: [], parts: stock,
} });
const factors = (complete = "incomplete", intent = "change", confidence = .9) => Object.fromEntries(Object.entries({
  intent, labels: "missing", capacity: "within", completeness: complete,
}).map(([name, choice]) => [name, { choice, confidence }]));
const slots = (rows = [{ label: "Novel", kind: "step", quantity: 1 }]) => Object.fromEntries([1, 2, 3].map((n, i) =>
  ["required" + n, rows[i] ? { ...rows[i], quantity: String(rows[i].quantity) } : { label: "", kind: "none", quantity: "0" }]));
const invoke = (body, judge, generate, method = "adaptive-v2", mode = "check", signal) => onRequirements({
  request: new Request("https://fixture.invalid/api/parts/" + mode, { method: "POST", body: JSON.stringify(body), signal }),
  method, mode, available: true,
}, { judge, generate });

test("full requirements retain total counts and one-use stock subtraction ignores existing nodes", () => {
  const rows = [{ label: "Fixture", kind: "step", quantity: 3 }];
  assert.deepEqual(readRequiredSlots(slots(rows)), rows);
  assert.deepEqual(requiredDifference(rows, stock), [1, 2].map(occurrence => ({ label: "Fixture", kind: "step", occurrence })));
  for (const change of [x => { x.extra = true; }, x => { x.required1.parent = "container"; },
    x => { x.required2 = { ...x.required1 }; }, x => { x.required1.quantity = "0"; },
    x => { x.required1.kind = "operation"; }, x => { x.required2 = x.required1; x.required1 = { label: "", kind: "none", quantity: "0" }; }]) {
    const value = slots(); change(value); assert.equal(readRequiredSlots(value), null);
  }
});

test("adaptive check preserves G0, independently verifies, and refuses omission without retry", async () => {
  for (const complete of ["complete", "incomplete"]) {
    let j = 0, t = 0;
    const response = await invoke(inventory(), async request => {
      j++;
      if (j === 1) { assert.ok(request.state.literal); return { answers: factors() }; }
      assert.deepEqual(request.state.required, [{ label: "Novel", kind: "step", quantity: 1 }]);
      assert.equal(Object.hasOwn(request.state, "literal"), false);
      return { answers: factors(complete) };
    }, async request => { t++; assert.deepEqual(Object.keys(request.questions), ["required1", "required2", "required3"]); return { result: slots() }; });
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(j, 2); assert.equal(t, 1);
    assert.equal(body.inspection.initial.decision.choice, "unknown");
    assert.equal(body.inspection.initial.factors.completeness.choice, "incomplete");
    assert.equal(body.inspection.verification.completeness.choice, complete);
    assert.equal(body.choice, complete === "complete" ? "missing" : "unknown");
    assert.ok(readRequirementInspection(body.inspection, inventory().state, readLiteralInspection));
  }
});

test("complete baseline, disabled fallback, controls and weak intent never call Type", async () => {
  for (const [f, method] of [[factors("complete"), "adaptive-v2"], [factors(), "literal-v2"],
    [factors("incomplete", "ambiguous"), "adaptive-v2"], [factors("incomplete", "no-change"), "adaptive-v2"],
    [factors("incomplete", "unsupported"), "adaptive-v2"], [factors("incomplete", "change", .49), "adaptive-v2"]]) {
    let j = 0;
    const response = await invoke(inventory(), async () => { j++; return { answers: f }; },
      async () => assert.fail("ineligible generation"), method);
    assert.equal(response.status, 200); assert.equal(j, 1);
    assert.equal((await response.json()).inspection.proposal, null);
  }
});

test("invalid partial parser observations cannot become an adoptable proposal", async () => {
  const input = inventory('Containerにstep「Novel」を1個とstep「Second」を0個追加');
  const response = await invoke(input, async request => {
    assert.deepEqual(request.state.literal, { recognized: false, required: [], spans: [] });
    return { answers: factors() };
  }, async () => assert.fail("disabled baseline generation"), "literal-v2");
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.inspection.initial.observation.valid, false);
  assert.deepEqual(body.inspection.initial.literal.required, []);
  assert.equal(body.choice, "unknown");
});

test("interpreting sufficient stock creates no candidates; receipt mutations cannot authorize additions", async () => {
  const input = inventory("ContainerへFixtureを1つ追加"); input.state.parts = stock;
  const response = await invoke(input, async request => ({ answers: factors(request.state.required ? "complete" : "incomplete") }),
    async () => ({ result: slots([{ label: "Fixture", kind: "step", quantity: 1 }]) }));
  const body = await response.json(); assert.equal(body.choice, "sufficient"); assert.deepEqual(body.inspection.missing, []);
  for (const edit of [x => { x.missing.push({ label: "Fixture", kind: "step", occurrence: 1 }); },
    x => { x.proposal.slots.required1.quantity = "2"; }, x => { x.initial.decision.choice = "missing"; },
    x => { x.verification.intent.extra = true; }, x => { x.initial.factors.intent.confidence = .49; },
    x => { x.mode = "literal-v2"; }, x => { x.missing = null; }, x => { delete x.missing; }]) {
    const receipt = structuredClone(body.inspection); edit(receipt);
    assert.equal(readRequirementInspection(receipt, input.state, readLiteralInspection), null);
  }
});

test("direct V shares verification without generation; malformed or extra requests have no provider effect", async () => {
  const required = [{ label: "Novel", kind: "step", quantity: 1 }];
  const input = { schema: "voice-ui.parts.verify/2", inventory: inventory(), required };
  let j = 0;
  const requests = [];
  const judge = async request => { j++; requests.push(request); return { answers: factors("complete", "change", .49) }; };
  const response = await invoke(input, judge, async () => assert.fail("direct V Type"), "adaptive-v2", "verify");
  const body = await response.json(); assert.equal(body.accepted, false); assert.equal(body.confidence, .49); assert.equal(j, 1);
  for (const malformed of [{ ...input, expected: true }, { ...input, required: [{ ...required[0], id: "injected" }] }])
    assert.equal((await invoke(malformed, judge, null, "adaptive-v2", "verify")).status, 422);
  assert.equal(j, 1);
  const second = { schema: input.schema, inventory: inventory("ContainerへDBを二つ追加"),
    required: [{ label: "DB", kind: "data", quantity: 2 }] };
  assert.equal((await invoke(second, judge, null, "adaptive-v2", "verify")).status, 200);
  assert.equal(j, 2);
  assert.deepEqual(requests[0].state.required, required);
  assert.deepEqual(requests[1].state.required, second.required);
  assert.equal(requests[0].state.utterance, input.inventory.state.utterance);
  assert.equal(requests[1].state.utterance, second.inventory.state.utterance);
  assert.deepEqual(requests[0].questions, requests[1].questions,
    "variable proposals and utterances live in state; verification questions stay constant");
});

test("unapproved Type fields stay out of response and stage logs; already cancelled has zero sends", async () => {
  const logs = [], saved = console.info;
  console.info = value => logs.push(value);
  try {
    let calls = 0;
    const response = await invoke(inventory(), async () => ({ answers: factors() }), async () => {
      calls++; return { result: { ...slots(), private: "upstream-private-canary" } };
    });
    assert.equal(response.status, 502); assert.equal(calls, 1);
    assert.equal(JSON.stringify(logs).includes("upstream-private-canary"), false);
    const controller = new AbortController(); controller.abort();
    const stopped = await invoke(inventory(), async () => assert.fail("cancelled send"), async () => assert.fail("cancelled send"),
      "adaptive-v2", "check", controller.signal);
    assert.equal(stopped.status, 504);
  } finally { console.info = saved; }
});

test("cancellation between stages prevents any next provider send", async () => {
  for (const at of ["G0", "TYPE_REQUIRED"]) {
    const controller = new AbortController(), signals = [];
    let j = 0, t = 0;
    const response = await invoke(inventory(), async (_, options) => {
      signals.push(options.signal); j++; if (at === "G0") controller.abort();
      return { answers: factors() };
    }, async (_, options) => {
      signals.push(options.signal); t++; controller.abort(); return { result: slots() };
    }, "adaptive-v2", "check", controller.signal);
    assert.equal(response.status, 504); assert.equal(j, 1); assert.equal(t, at === "G0" ? 0 : 1);
    assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
  }
});

test("v2 preparation uses its verified receipt exactly once with zero HTTP complete callbacks", async () => {
  const protocol = await import(pathToFileURL(process.env.POC_PROTOCOL_ENTRY ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../../../../../ui.git/.worktrees/voice-ui-render-identity-20261017/packages/semantic-map/protocol/index.js")));
  const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("../web/data/bundle.v1.json", import.meta.url))));
  const input = inventory(); input.state.parts = bundle.parts;
  const response = await invoke(input, async request => ({ answers: factors(request.state.required ? "complete" : "incomplete") }),
    async () => ({ result: slots() }));
  const coverage = await response.json();
  const session = createSession({ accepted: { head: input.state.head, log: "fixture-log", decisions: [],
    records: input.state.regions.map(r => ({ type: "region", ...r, bounds: [0, 0, 200, 100], summary: "" })) }, stored: "fixture-log" });
  const result = await runInventoryGoal({ utterance: input.state.utterance, bundle, protocol, current: () => session, cancelled: () => false,
    check: async () => coverage, complete: async () => assert.fail("second provider preparation"),
    ask: async () => ({ kind: "unknown" }), adopt: async () => assert.fail("unknown should not adopt") });
  assert.equal(result.inventory.completions, 0); assert.equal(result.inventory.preparations, 1);
  assert.deepEqual(result.inventory.missing, [{ label: "Novel", kind: "step", occurrence: 1 }]);
});
