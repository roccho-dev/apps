import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const base = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, "$1"));
const repo = path.dirname(base);
const packageRoot = path.join(repo, "packages/voice-ui");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(fs.readFileSync(path.join(base, file)));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stringify = value => JSON.stringify(canonical(value));
const same = (a, b) => stringify(a) === stringify(b);
const bag = values => values.map(stringify).sort();
const equalBag = (a, b) => same(bag(a), bag(b));
const stripGeometry = record => {
  if (record.type === "layout") return null;
  if (record.type === "region") { const { bounds, ...semantic } = record; return semantic; }
  return record;
};
const semantic = records => records.map(stripGeometry).filter(Boolean);
const sealBytes = fs.readFileSync(path.join(base, "poc-holdout.sealed.json"));
assert.equal(hash(sealBytes), "22e47667ba3d6eaf1061c058b7f3e8fe07824dd3885b24264603a2be0b1f2c32");
const seal = JSON.parse(sealBytes);
const projection = read("poc-main-inputs.json");
const dir = path.join(base, "paired-main-e4a2");
const parse = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
const identity = parse("identity.json"), execution = parse("execution.json");
assert.equal(execution.status, "RECORDED"); assert.equal(execution.summary.length, 20);
assert.equal(identity.inputs_sha256, hash(fs.readFileSync(path.join(base, "poc-main-inputs.json"))));
assert.equal(identity.source.sealed_inputs_sha256, hash(sealBytes));
assert.deepEqual(identity.source.heads, {
  apps: "e4a2af1efe9278996391f0374d4546a51aa98736", ops: "cab432ef717cbde9ebd0197ae006c0efe75269bf",
  windows: "6aef693c0946903d8b87c2348039de1420acd61b", envs: "063e685b8b21a97fc8658879da93fa858552bcd6",
});
assert.equal(identity.source.worker_entry.sha256, "cfc3baca20a2ede70504610e84046c1a32894160c50f2ceae20835ef69d4e00b");
assert.equal(identity.source.provider_entry.sha256, "ad4ac08ae8c42f3bf0e9d0aeedb0a2e9192c776585a3251b2ff1e18358cfe2e7");
assert.equal(identity.source.semantic_map.protocol_sha256, "1689dcf63e1ed19cdea7be22e3f90a09f434841f980b9ca8b9018a987c9c38f8");
assert.equal(identity.source.launcher.pid, 102693);
assert.equal(identity.source.launcher.start_ticks, "7751187");
assert.equal(identity.bundle_sha256, hash(fs.readFileSync(path.join(packageRoot, "web/data/bundle.v1.json"))));
for (const [name, digest] of Object.entries(identity.source_sha256))
  assert.equal(hash(fs.readFileSync(path.join(packageRoot, name))), digest, name);
const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const expectedOrder = projection.comparison.case_order.flatMap((id, i) => projection.comparison.arm_order[i].map(arm => ({ id, arm })));
assert.deepEqual(execution.summary.map(({ id, arm }) => ({ id, arm })), expectedOrder);
assert.deepEqual(events.filter(e => e.kind === "arm-start").map(({ id, arm }) => ({ id, arm })), expectedOrder);
assert.deepEqual(events.filter(e => e.kind === "arm-end").map(({ id, arm }) => ({ id, arm })), expectedOrder);
const validReasons = new Set(["inventory-not-confident", "inventory-ambiguous", "inventory-no-change", "inventory-unsupported",
  "completion-empty", "none", "not-confident", "no-executable-delta", "candidate-overflow", "budget-requests", "budget-time"]);
const rows = [], callCounts = { jev: 0, typellm: 0 };
for (const gold of seal.cases) {
  const pair = ["A", "B"].map(arm => parse(gold.id + "-" + arm + ".json"));
  assert.equal(pair[0].initial_head, pair[1].initial_head); assert.equal(pair[0].initial_log_sha256, pair[1].initial_log_sha256);
  assert.ok(same(pair[0].initial_records, pair[1].initial_records));
  for (const output of pair) {
    const { id, arm } = output, fixture = seal.fixture_contract.fixtures[gold.fixture];
    assert.equal(output.id, gold.id); assert.equal(output.fixture, gold.fixture); assert.equal(output.utterance, gold.utterance);
    assert.equal(output.valid_execution, true); assert.ok(validReasons.has(output.result.reason));
    const expectedInitial = [...seal.fixture_contract.base_records, ...fixture.extra_records];
    const expectedPins = [...seal.fixture_contract.base_pins, ...fixture.extra_pins]
      .map(({ regionId, bounds }) => ({ type: "layout", regionId, pin: "hard", bounds }));
    assert.ok(equalBag(semantic(output.initial_records), semantic(expectedInitial)), id + ":initial-semantic");
    assert.ok(equalBag(output.initial_records.filter(r => r.type === "layout"), expectedPins), id + ":initial-pins");
    const localEvents = events.filter(e => e.id === id && e.arm === arm);
    assert.equal(localEvents.filter(e => e.kind === "arm-start").length, 1);
    assert.equal(localEvents.filter(e => e.kind === "arm-end").length, 1);
    assert.equal(localEvents.filter(e => e.kind === "http-start").length, output.calls.length);
    assert.equal(localEvents.filter(e => e.kind === "http-end").length, output.calls.length);
    const routes = { check: 0, complete: 0, goal: 0 };
    output.calls.forEach((call, index) => {
      assert.equal(call.n, index + 1); assert.equal(call.id, id); assert.equal(call.arm, arm);
      assert.equal(call.status, 200); assert.equal(call.error, undefined); assert.ok(call.response);
      const starts = localEvents.filter(e => e.kind === "http-start" && e.n === call.n);
      const ends = localEvents.filter(e => e.kind === "http-end" && e.n === call.n);
      assert.equal(starts.length, 1); assert.equal(ends.length, 1);
      assert.ok(same(starts[0].request, call.request)); assert.equal(starts[0].route, call.route);
      assert.ok(same(ends[0].response, call.response)); assert.equal(ends[0].status, call.status);
      if (call.route === "/api/parts/check") { routes.check++; callCounts.jev++; }
      else if (call.route === "/api/parts/complete") { routes.complete++; callCounts.typellm++; }
      else { assert.equal(call.route, "/api/judge"); routes.goal++; callCounts.jev++; }
    });
    assert.equal(routes.check, 1); assert.ok(routes.complete <= 1); assert.ok(routes.goal <= 8);
    if (arm === "A") assert.equal(routes.complete, 0);
    assert.equal(output.result.requests, routes.check + routes.goal);
    assert.equal(output.result.inventory.checks, routes.check);
    assert.equal(output.result.inventory.completions, routes.complete);
    assert.ok(same(output.calls[0].response, output.result.inventory.coverage));
    const coverage = output.result.inventory.coverage;
    const controlled = !["sufficient", "missing"].includes(gold.expected_gate);
    const accepted = coverage.confidence >= 0.5 && (controlled
      ? output.result.reason === "inventory-" + gold.expected_gate
      : output.calls.length > 1 || ["no-executable-delta", "candidate-overflow", "budget-requests"].includes(output.result.reason));
    const initial = semantic(output.initial_records), final = semantic(output.final_records);
    const key = r => r.type === "meta" ? "meta" : r.type + ":" + r.id;
    const initialMap = new Map(initial.map(r => [key(r), r]));
    const finalMap = new Map(final.map(r => [key(r), r]));
    assert.equal(initialMap.size, initial.length); assert.equal(finalMap.size, final.length);
    const preserved = initial.every(r => same(r, finalMap.get(key(r))));
    const added = final.filter(r => !initialMap.has(key(r)));
    const newRegions = added.filter(r => r.type === "region"), newEdges = added.filter(r => r.type === "relation");
    const initialRegionIds = new Set(initial.filter(r => r.type === "region").map(r => r.id));
    const newById = new Map(newRegions.map(r => [r.id, r]));
    const ref = regionId => {
      if (initialRegionIds.has(regionId)) return "fixture:" + regionId;
      const item = newById.get(regionId);
      return item && newRegions.filter(r => r.label === item.label).length === 1 ? "added:" + item.label : "UNRESOLVED:" + regionId;
    };
    const actualRegions = newRegions.map(r => ({ label: r.label, kind: r.kind, parent: ref(r.parent) }));
    const actualEdges = newEdges.map(r => ({ from: ref(r.from), to: ref(r.to), kind: r.kind, label: r.label }));
    const noOtherNewSemantics = added.length === newRegions.length + newEdges.length;
    const cleanNewRegions = newRegions.every(r => r.summary === ""
      && equalBag(Object.keys(r), ["type", "id", "parent", "label", "kind", "summary"]));
    const cleanNewEdges = newEdges.every(r => equalBag(Object.keys(r), ["type", "id", "from", "to", "kind", "label"]));
    const graphExact = preserved && noOtherNewSemantics && cleanNewRegions && cleanNewEdges
      && equalBag(actualRegions, gold.expected_added_regions) && equalBag(actualEdges, gold.expected_added_edges);
    const unchanged = equalBag(initial, final);
    const minimal = arm === "B" && gold.expected_gate === "missing" && routes.complete === 1
      && equalBag(output.result.inventory.missing, gold.expected_missing);
    rows.push({ id, arm, expected_gate: gold.expected_gate, coverage, accepted_gate_correct: accepted && coverage.choice === gold.expected_gate,
      raw_choice_correct: coverage.choice === gold.expected_gate, reason: output.result.reason,
      graph_exact: graphExact, existing_semantics_preserved: preserved, control_unchanged: controlled ? unchanged : null,
      actual_added_regions: actualRegions, actual_added_edges: actualEdges,
      missing_candidates: output.result.inventory.missing, completion_minimal: gold.expected_gate === "missing" && arm === "B" ? minimal : null,
      calls: routes, elapsedMs: output.elapsedMs });
  }
}
const count = (arm, predicate) => rows.filter(r => r.arm === arm && predicate(r)).length;
const metrics = Object.fromEntries(["A", "B"].map(arm => [arm, {
  accepted_gate_correct: count(arm, r => r.accepted_gate_correct), raw_choice_correct: count(arm, r => r.raw_choice_correct),
  missing_gate_correct: count(arm, r => r.expected_gate === "missing" && r.accepted_gate_correct),
  sufficient_graph_exact: count(arm, r => r.expected_gate === "sufficient" && r.graph_exact),
  missing_graph_exact: count(arm, r => r.expected_gate === "missing" && r.graph_exact),
  missing_completion_minimal: count(arm, r => r.completion_minimal === true),
  unchanged_controls: count(arm, r => r.control_unchanged === true),
  type_on_sufficient_control: rows.filter(r => r.arm === arm && r.expected_gate !== "missing").reduce((n, r) => n + r.calls.complete, 0),
}]));
const thresholds = {
  gate_each_arm_9_of_10: metrics.A.accepted_gate_correct >= 9 && metrics.B.accepted_gate_correct >= 9,
  all_missing_gates_each_arm: metrics.A.missing_gate_correct === 4 && metrics.B.missing_gate_correct === 4,
  no_type_on_sufficient_control: metrics.A.type_on_sufficient_control === 0 && metrics.B.type_on_sufficient_control === 0,
  unchanged_controls_both: metrics.A.unchanged_controls === 2 && metrics.B.unchanged_controls === 2,
  sufficient_B_3_of_4_no_regression: metrics.B.sufficient_graph_exact >= 3 && metrics.B.sufficient_graph_exact >= metrics.A.sufficient_graph_exact,
  missing_B_3_of_4_gain_2: metrics.B.missing_graph_exact >= 3 && metrics.B.missing_graph_exact - metrics.A.missing_graph_exact >= 2,
  missing_minimal_3_of_4: metrics.B.missing_completion_minimal >= 3,
};
const result = { schema: "voice-ui.poc.independent-main-score/1", reviewer: "/root/poc_reviewer",
  sealed_sha256: hash(sealBytes), projection_sha256: identity.inputs_sha256,
  source: identity.source, execution_integrity: "PASS_LOCAL_STRUCTURAL_AND_REQUEST_RESPONSE_CHECKS",
  actual_main_sends_from_recorded_http: callCounts, metrics, thresholds,
  effect_numerical_thresholds_met: Object.values(thresholds).every(Boolean),
  verdict: Object.values(thresholds).every(Boolean) ? "EFFECT_NUMERICAL_PENDING_PROTOCOL_AUDIT" : "EFFECT_NOT_DEMONSTRATED",
  measurement_scope: "VALID_DIAGNOSTIC_ONLY; final-correction known fallback UI failed",
  effect_closure_admissible: false,
  rows };
console.log(JSON.stringify(result, null, 2));
