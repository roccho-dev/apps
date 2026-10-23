import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { onRequirements } from "../functions/api/parts.mjs";
import { readRequirementInspection, readLiteralInspection, runInventoryGoal, flatRequiredRequest, inventoryQuestion } from "../src/completion.mjs";
import { readBundle } from "../src/bundle.mjs";
import { createSession } from "../src/session.mjs";

const inventory = () => ({ kind: "voice-ui.goal.inventory.v1", state: {
  utterance: 'Containerに工程「Novel」を1個追加', head: "fixture-head",
  regions: [{ id: "root", parent: null, label: "World", kind: "boundary" },
    { id: "container", parent: "root", label: "Container", kind: "group" }], edges: [],
  parts: [{ key: "sample", purpose: "one reusable instance", label: "Fixture", kind: "step" }],
} });
const factors = (intent = "ambiguous", confidence = .49, completeness = "incomplete", certainty = .9) => ({
  intent: { choice: intent, confidence }, labels: { choice: "missing", confidence: .9 },
  capacity: { choice: "within", confidence: .9 }, completeness: { choice: completeness, confidence: certainty },
});
const slots = () => Object.fromEntries([1, 2, 3].map(n => ["required" + n,
  n === 1 ? { label: "Novel", kind: "step", quantity: "1" } : { label: "", kind: "none", quantity: "0" }]));
async function invoke({ first = factors(), verified = factors("change", .9, "complete"), method = "adaptive-v3",
  mode = "check", fail = null, input = inventory() } = {}) {
  const stages = [], requests = [], sends = { jev: 0, typellm: 0 }, saved = console.info;
  console.info = line => stages.push(JSON.parse(line));
  try {
    const response = await onRequirements({ request: new Request("https://fixture.invalid/api/parts/" + mode,
      { method: "POST", body: JSON.stringify(input) }), mode, method, available: true }, {
      judge: async request => {
        sends.jev++; requests.push(structuredClone(request));
        if (fail === "G0-http" && sends.jev === 1) throw Error("unknown transport");
        return { answers: sends.jev === 1 ? first : verified };
      },
      generate: async request => { sends.typellm++; requests.push(structuredClone(request));
        if (fail === "Type-http") throw Error("unknown transport");
        const rows = slots(), answers = Object.hasOwn(request.questions, "required1_label")
          ? Object.fromEntries(Object.entries(rows).flatMap(([name, row]) => Object.entries(row).map(([key, value]) => [name + "_" + key, value])))
          : rows;
        return { result: fail === "Type-contract" ? {} : answers };
      },
    });
    return { status: response.status, body: await response.json(), stages, requests, sends, input };
  } finally { console.info = saved; }
}

test("v3 one-shot proposal follows the exact confidence frontier; hard stops and v2 are retained", async () => {
  for (const intent of ["change", "ambiguous", "no-change", "unsupported"]) {
    for (const confidence of [0, .49, .5, 1]) for (const completeness of ["complete", "incomplete"]) {
      for (const certainty of [.49, .5]) {
        const eligible = completeness === "incomplete" && certainty >= .5
          && (intent === "change" || intent === "ambiguous" && confidence < .5);
        const result = await invoke({ first: factors(intent, confidence, completeness, certainty) });
        assert.equal(result.status, 200);
        assert.deepEqual(result.sends, { jev: eligible ? 2 : 1, typellm: eligible ? 1 : 0 });
        const inspected = result.body.inspection;
        assert.equal(inspected.schema, "voice-ui.parts.inspection/3");
        assert.equal(inspected.mode, "adaptive-v3");
        assert.deepEqual(inspected.initial.factors, factors(intent, confidence, completeness, certainty));
        assert.deepEqual(inspected.proposal_policy, { id: "uncertainty-frontier-v1", eligible,
          reason: !eligible ? null : intent === "change" && confidence >= .5
            ? "confident-change-incomplete" : "uncertain-intent-incomplete" });
        assert.deepEqual(result.stages[0].proposal_policy, inspected.proposal_policy);
        assert.ok(result.stages.every(row => row.kind === "voice-ui.parts.stage.v3"));
        assert.ok(readRequirementInspection(inspected, result.input.state, readLiteralInspection));
      }
    }
  }
  for (const method of ["literal-v2", "adaptive-v2"]) {
    const result = await invoke({ method });
    assert.deepEqual(result.sends, { jev: 1, typellm: 0 });
    assert.equal(result.body.inspection.schema, "voice-ui.parts.inspection/2");
    assert.ok(!Object.hasOwn(result.body.inspection, "proposal_policy"));
    assert.ok(result.stages.every(row => row.kind === "voice-ui.parts.stage.v2"));
  }
});

// The frontier proposal sends the flat body without label thinking: 16 thinking labels made TypeLLM answer 504
// (apps#94 c6358191815), the same question without thinking returned the same parts (W round 2 direct calls).
test("ordinary C uses the bounded flat extraction body without label thinking, retaining its closed dependent stage", async () => {
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.deepEqual(result.requests[1], flatRequiredRequest(inventoryQuestion(result.input.state).state, { labelThinking: false }));
  const typed = result.stages.find(row => row.stage === "TYPE_REQUIRED");
  assert.deepEqual(Object.keys(typed), ["kind", "request_id", "stage", "valid", "generation", "proposal"]);
  assert.equal(typed.generation, "dependent");
  assert.deepEqual(typed.proposal.slots, slots());
  assert.deepEqual(result.sends, { jev: 2, typellm: 1 });
});

test("failed or invalid G0 cannot trigger Type; failed Type cannot trigger V or retry", async () => {
  for (const options of [{ fail: "G0-http" }, { first: {} }, { first: factors("ambiguous", NaN) }]) {
    const result = await invoke(options);
    assert.ok(result.status >= 500); assert.deepEqual(result.sends, { jev: 1, typellm: 0 });
  }
  for (const fail of ["Type-http", "Type-contract"]) {
    const result = await invoke({ fail });
    assert.ok(result.status >= 500); assert.deepEqual(result.sends, { jev: 1, typellm: 1 });
  }
});

test("rejected, weak or invalid V never reaches materialization or Goal", async () => {
  const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("../web/data/bundle.v1.json", import.meta.url))));
  for (const verified of [factors("change", .9, "incomplete"), factors("change", .49, "complete"),
    factors("ambiguous", .9, "complete"), {}]) {
    const input = inventory(); input.state.parts = bundle.parts;
    const response = await invoke({ input, verified });
    assert.deepEqual(response.sends, { jev: 2, typellm: 1 });
    const session = createSession({ accepted: { head: input.state.head, log: "fixture-log", decisions: [],
      records: input.state.regions.map(r => ({ type: "region", ...r, bounds: [0, 0, 200, 100], summary: "" })) }, stored: "fixture-log" });
    const result = await runInventoryGoal({ utterance: input.state.utterance, bundle, protocol: {},
      current: () => session, cancelled: () => false,
      check: async () => { if (response.status !== 200) throw Error("unknown HTTP"); return response.body; },
      complete: async () => assert.fail("unexpected second completion"),
      ask: async () => assert.fail("unverified Goal"), adopt: async () => assert.fail("unverified adoption") });
    assert.equal(result.inventory.preparations, 0); assert.equal(result.inventory.completions, 0);
    assert.deepEqual(result.selected, []);
    assert.equal(session.working.log, "fixture-log");
  }
});

test("receipt policy/schema/mode tampering cannot grant authority; initial ambiguity is preserved", async () => {
  const result = await invoke(); const original = result.body.inspection;
  assert.equal(original.initial.decision.choice, "ambiguous");
  assert.equal(result.body.choice, "missing");
  for (const mutate of [x => { x.schema = "voice-ui.parts.inspection/2"; }, x => { x.mode = "adaptive-v2"; },
    x => { delete x.proposal_policy; }, x => { x.proposal_policy.eligible = false; },
    x => { x.proposal_policy.reason = "confident-change-incomplete"; }, x => { x.proposal_policy.extra = true; },
    x => { x.initial.factors.intent.confidence = .5; }, x => { x.initial.decision.choice = "change"; }]) {
    const copy = structuredClone(original); mutate(copy);
    assert.equal(readRequirementInspection(copy, result.input.state, readLiteralInspection), null);
  }
});
