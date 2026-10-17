import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gradeArm, summarizePanel } from "./panel-semantic-score.mjs";
const sha = text => createHash("sha256").update(text).digest("hex");
const initial = [{ type: "meta", schema: "example/1", root: "p" },
  { type: "region", id: "p", parent: null, label: "Parent", kind: "group", summary: "", bounds: [0, 0, 600, 300] }];
const oracle = (gate = "missing") => ({ id: "synthetic-case", fixture: "example", utterance: "synthetic input", expected_gate: gate,
  expected_missing: gate === "missing" ? [{ label: "Item", kind: "step", occurrence: 1 }] : [],
  expected_added_regions: ["missing", "sufficient"].includes(gate) ? [{ label: "Item", kind: "step", parent: "fixture:p" }] : [],
  expected_added_edges: [] });
const raw = (arm, o) => {
  const coverage = { choice: o.expected_gate, confidence: .9 }, complete = o.expected_gate === "missing" && arm !== "A";
  const added = ["missing", "sufficient"].includes(o.expected_gate)
    ? [{ type: "region", id: "new", parent: "p", label: "Item", kind: "step", summary: "", bounds: [10, 40, 100, 60] }] : [];
  const calls = [{ route: "/api/parts/check", response: coverage, request: { state: { utterance: o.utterance } } }];
  if (complete && arm === "C") calls.push({ route: "/api/parts/complete", response: { missing: o.expected_missing } });
  if (added.length) calls.push({ route: "/api/judge", response: { kind: "synthetic" } });
  const changed = added.length > 0;
  return { id: o.id, arm, fixture: o.fixture, utterance: o.utterance, valid_execution: true, elapsedMs: 100,
    result: { reason: ["ambiguous", "no-change", "unsupported"].includes(o.expected_gate) ? "inventory-" + o.expected_gate : "none",
      requests: calls.filter(c => c.route !== "/api/parts/complete").length,
      inventory: { checks: 1, completions: complete ? 1 : 0, coverage, missing: complete ? o.expected_missing : [] } },
    calls: calls.map((c, i) => ({ ...c, n: i + 1, status: 200 })),
    preparation: complete && arm === "B" ? [{ missing: o.expected_missing }] : [],
    initial_head: "initial", initial_log_sha256: sha("initial log"), initial_records: initial,
    final_head: changed ? "after" : "initial", final_log: changed ? "after log" : "initial log", final_records: [...initial, ...added] };
};

test("source-level arm score keeps HTTP accounting distinct from protocol/browser proof", () => {
  const o = oracle(), r = gradeArm(raw("C", o), o);
  assert.equal(r.score_input_valid, true); assert.equal(r.graph_exact, true); assert.equal(r.missing_minimal, true);
  assert.equal(r.jev_http, 2); assert.equal(r.typellm_http, 1); assert.equal(r.all_arm_guard, true);
  const bad = raw("C", o); bad.result.requests = 3;
  assert.equal(gradeArm(bad, o).score_input_valid, false);
});
test("control layout/log changes cannot hide behind semantic projection", () => {
  const o = oracle("no-change"), x = raw("C", o);
  x.final_records = [...initial, { type: "layout", id: "paint-change" }];
  assert.equal(gradeArm(x, o).graph.semantic_unchanged, true);
  assert.equal(gradeArm(x, o).raw_unchanged, false); assert.equal(gradeArm(x, o).all_arm_guard, false);
  const y = raw("C", o); y.final_log = "appended no-op";
  assert.equal(gradeArm(y, o).raw_unchanged, false);
});
test("scope all-arm guards to sufficient/control and report missing extras independently", () => {
  const o = oracle("sufficient"), x = raw("B", o);
  x.result.inventory.completions = 1; x.preparation = [{ missing: [] }];
  assert.equal(gradeArm(x, o).all_arm_guard, false);
  const y = raw("C", oracle()); y.final_records.push({ type: "region", id: "extra", parent: "p", label: "Extra", kind: "data", summary: "" });
  assert.equal(gradeArm(y, oracle()).no_false_adoption, false);
  assert.equal(gradeArm(y, oracle()).graph_exact, false);
  assert.equal(gradeArm(y, oracle()).all_arm_guard, true, "missing-case error is reported, not a global S/control guard");
});
test("incomplete correct subset is a task failure without manufacturing a false-adoption finding", () => {
  const o = oracle(); o.expected_added_regions.push({ label: "Later", kind: "data", parent: "fixture:p" });
  const r = gradeArm(raw("C", o), o);
  assert.equal(r.graph_exact, false); assert.equal(r.no_false_adoption, true);
});
test("baseline gate failure cannot manufacture a causal TypeLLM gain", () => {
  const oracles = Array.from({ length: 10 }, (_, i) => ({ id: "case-" + i, expected_gate: i < 4 ? "sufficient" : i < 8 ? "missing" : "no-change" }));
  const rows = oracles.flatMap((o, i) => ["A", "B", "C"].map(arm => ({
    id: o.id, arm, score_input_valid: true, gate: { accepted_gate_correct: !(i === 4 && arm === "B") },
    graph_exact: i < 4 || i >= 8 || arm === "C" || arm === "B" && i !== 4,
    missing_minimal: arm === "C", raw_unchanged: i >= 8, no_false_adoption: true,
    generation_free: i < 4 || i >= 8, all_arm_guard: true, deadline: true,
    jev_http: 2, typellm_http: i >= 4 && i < 8 && arm === "C" ? 1 : 0, elapsedMs: 100,
    scope: i < 4 ? "sufficient" : i < 8 ? "missing" : "control" })));
  const before = summarizePanel(rows, oracles, "C");
  assert.equal(before.per_arm.C.missing.exact - before.per_arm.B.missing.exact, 1);
  assert.equal(before.paired_accepted_gate_gains.over_B.signed_gain, 0);
  assert.equal(before.selected_finite_semantic_criteria, "UNMET");
  rows.find(r => r.id === "case-4" && r.arm === "B").gate.accepted_gate_correct = true;
  const after = summarizePanel(rows, oracles, "C");
  assert.equal(after.paired_accepted_gate_gains.over_B.signed_gain, 1);
  assert.equal(after.selected_finite_semantic_criteria, "PASS");
  assert.ok(after.mandatory_separate_admissibility.length >= 6);
  assert.equal(after.CI_LIVE_EXECUTION, "UNPROVEN");
  assert.notEqual(summarizePanel(rows.slice(1), oracles, "C").selected_finite_semantic_criteria, "PASS");
});
