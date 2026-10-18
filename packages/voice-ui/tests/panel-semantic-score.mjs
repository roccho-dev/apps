// Independent finite semantic/call scoring. This is NOT protocol, artifact,
// runtime, provider-journal, factor-log, or actual-browser admissibility proof.
import { createHash } from "node:crypto";
import { canonical, gradeGate, gradeGraph, gradeMissing } from "./semantic-score.mjs";
const json = value => JSON.stringify(canonical(value));
const same = (a, b) => json(a) === json(b);
const subset = (actual, expected) => {
  const stock = expected.map(json);
  return actual.every(row => { const at = stock.indexOf(json(row)); if (at < 0) return false; stock.splice(at, 1); return true; });
};
const hash = value => createHash("sha256").update(value).digest("hex");
const stopReasons = new Set(["inventory-not-confident", "inventory-ambiguous", "inventory-no-change", "inventory-unsupported",
  "completion-empty", "none", "not-confident", "no-executable-delta", "candidate-overflow", "budget-requests", "budget-time"]);
const isControl = oracle => ["ambiguous", "no-change", "unsupported"].includes(oracle.expected_gate);

export function gradeArm(raw, oracle) {
  const issues = [];
  if (raw.id !== oracle.id || !["A", "B", "C"].includes(raw.arm)) issues.push("case/arm identity");
  if (raw.utterance !== oracle.utterance || raw.fixture !== oracle.fixture) issues.push("case input");
  const inventory = raw.result?.inventory, calls = raw.calls ?? [], preparation = raw.preparation ?? [];
  if (raw.valid_execution !== true || !stopReasons.has(raw.result?.reason)) issues.push("execution/stop reason");
  if (!Array.isArray(calls) || !Array.isArray(preparation)) throw Error("scorer input shape");
  const checks = calls.filter(c => c.route === "/api/parts/check");
  const typed = calls.filter(c => c.route === "/api/parts/complete");
  const judges = calls.filter(c => c.route === "/api/judge");
  if (checks.length !== 1 || judges.length > 8 || typed.length > 1 || calls[0]?.route !== "/api/parts/check"
      || checks.length + judges.length + typed.length !== calls.length
      || calls.some((c, i) => c.n !== i + 1 || c.status !== 200 || Object.hasOwn(c, "error") || !Object.hasOwn(c, "response")))
    issues.push("closed sequential HTTP");
  if (inventory?.checks !== 1 || raw.result?.requests !== checks.length + judges.length
      || !same(checks[0]?.response, inventory?.coverage)) issues.push("coordinator/check accounting");
  const expectedCompletions = raw.arm === "C" ? typed.length : raw.arm === "B" ? preparation.length : 0;
  if (inventory?.completions !== expectedCompletions || raw.arm !== "C" && typed.length !== 0
      || raw.arm !== "B" && preparation.length !== 0 || expectedCompletions > 1) issues.push("candidate-method accounting");
  if (typed.length && !same(typed[0].response?.missing, inventory?.missing)
      || preparation.length && !same(preparation[0].missing, inventory?.missing)) issues.push("candidate receipt equality");
  const gate = gradeGate(inventory?.coverage, oracle);
  if (!gate.contract_valid) issues.push("closed gate contract");
  const graph = gradeGraph(raw.initial_records, raw.final_records, oracle);
  const control = isControl(oracle), missing = oracle.expected_gate === "missing";
  const rawUnchanged = same(raw.initial_records, raw.final_records) && raw.initial_head === raw.final_head
    && typeof raw.final_log === "string" && hash(raw.final_log) === raw.initial_log_sha256;
  const noFalseAdoption = graph.existing_semantics_preserved && graph.no_other_new_semantics
    && graph.clean_new_regions && graph.clean_new_edges
    && subset(graph.actual_added_regions, oracle.expected_added_regions)
    && subset(graph.actual_added_edges, oracle.expected_added_edges);
  const generationFree = inventory?.completions === 0 && typed.length === 0 && preparation.length === 0
    && Array.isArray(inventory?.missing) && inventory.missing.length === 0;
  const deadline = typeof raw.elapsedMs === "number" && Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0 && raw.elapsedMs <= 180000;
  return { id: raw.id, arm: raw.arm, expected_gate: oracle.expected_gate,
    score_input_valid: issues.length === 0, issues, gate, graph_exact: graph.graph_exact, graph,
    missing_minimal: gradeMissing(inventory?.missing, oracle),
    raw_unchanged: rawUnchanged, no_false_adoption: noFalseAdoption, generation_free: generationFree,
    all_arm_guard: !(control || oracle.expected_gate === "sufficient")
      || noFalseAdoption && generationFree && (!control || rawUnchanged),
    deadline, jev_http: checks.length + judges.length, typellm_http: typed.length,
    elapsedMs: raw.elapsedMs, scope: missing ? "missing" : control ? "control" : "sufficient" };
}

export function summarizePanel(rows, oracles, selected) {
  if (!["A", "B", "C"].includes(selected)) throw Error("selected method");
  const unique = new Set(rows.map(row => row.id + "/" + row.arm));
  const complete = rows.length === oracles.length * 3 && unique.size === rows.length
    && oracles.every(o => ["A", "B", "C"].every(arm => rows.some(r => r.id === o.id && r.arm === arm)));
  const valid = complete && rows.every(r => r.score_input_valid);
  const perArm = Object.fromEntries(["A", "B", "C"].map(arm => {
    const own = rows.filter(r => r.arm === arm), group = scope => own.filter(r => r.scope === scope);
    const sufficient = group("sufficient"), missing = group("missing"), controls = group("control");
    return [arm, { gate: { accepted: own.filter(r => r.gate.accepted_gate_correct).length, total: own.length },
      sufficient: { exact: sufficient.filter(r => r.graph_exact).length, total: sufficient.length },
      missing: { exact: missing.filter(r => r.graph_exact).length, minimal: missing.filter(r => r.missing_minimal).length, total: missing.length },
      controls: { raw_unchanged: controls.filter(r => r.raw_unchanged).length, total: controls.length },
      non_regression_guards: own.every(r => r.all_arm_guard), deadlines: own.every(r => r.deadline),
      jev_http: own.reduce((n, r) => n + r.jev_http, 0), typellm_http: own.reduce((n, r) => n + r.typellm_http, 0) }];
  }));
  const paired = baseline => {
    let eligible = 0, wins = 0, losses = 0, excludedGatePairs = 0;
    for (const o of oracles.filter(o => o.expected_gate === "missing")) {
      const c = rows.find(r => r.id === o.id && r.arm === "C"), b = rows.find(r => r.id === o.id && r.arm === baseline);
      if (!c?.gate.accepted_gate_correct || !b?.gate.accepted_gate_correct) { excludedGatePairs++; continue; }
      eligible++; if (c.graph_exact && !b.graph_exact) wins++; if (!c.graph_exact && b.graph_exact) losses++;
    }
    return { baseline, eligible, wins, losses, signed_gain: wins - losses, excluded_gate_pairs: excludedGatePairs };
  };
  const gains = { over_A: paired("A"), over_B: paired("B") }, s = perArm[selected];
  const finalShape = oracles.length === 10 && oracles.filter(o => o.expected_gate === "sufficient").length === 4
    && oracles.filter(o => o.expected_gate === "missing").length === 4 && oracles.filter(isControl).length === 2;
  const allGuards = ["A", "B", "C"].every(arm => perArm[arm].non_regression_guards);
  const selectedPass = valid && finalShape && s.gate.accepted === 10 && s.sufficient.exact === 4
    && s.sufficient.exact >= perArm.A.sufficient.exact && s.missing.exact === 4 && s.missing.minimal === 4
    && s.controls.raw_unchanged === 2 && s.deadlines && allGuards
    && (selected !== "C" || gains.over_A.signed_gain >= 2 && gains.over_B.signed_gain >= 1);
  return { schema: "voice-ui.poc.semantic-panel-score/1", selected, complete, score_inputs_valid: valid,
    final_shape: finalShape, per_arm: perArm, paired_accepted_gate_gains: gains,
    all_arm_non_regression: allGuards, selected_finite_semantic_criteria: selectedPass ? "PASS" : "UNMET",
    mandatory_separate_admissibility: ["consumed-input commitment and raw arm order/equal initial bytes",
      "actual protocol/log/proof verification", "actual runtime/source/artifact binding",
      "provider journal/process closure and all count deltas", "raw factor recomputation",
      "completed-artifact browser/paint/lifecycle and mutation controls"],
    four_way_comparison: "INCOMPLETE_D_BLOCKED_COST", CI_LIVE_EXECUTION: "UNPROVEN", currency: "COST_NOT_MEASURED" };
}
