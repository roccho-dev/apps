import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequirementAxis } from "./requirements-cycle-classification.mjs";
const sample = (axis = "E") => {
  const n = { V: 10, F: 8, E: 20 }[axis];
  const raw = { status: "PASS", axis, phase_kind: "fresh", planned: n, consumed: n, complete: true,
    all_valid_execution: true, admissible_for_semantic_claim: true, replay: { status: "PASS", recorded_paint_status: "PASS" },
    rows: Array.from({ length: n }, (_, i) => ({ id: "case-" + i % 10, grade: { contract_valid: true, expected_gate: i % 10 < 4 ? "missing" : "sufficient" },
      paint_status: "PASS", goal_elapsedMs: 100, goal_deadline_status: "PASS" })),
    semantic: { verification_criteria: "PASS", requirements_criteria: "PASS", enabled_criteria: "PASS", effect_criteria: "PASS",
      missing_gains: 2, regressions: 0, no_false_adoption: true, all_arm_guards: true,
      pairs: Array.from({ length: 10 }, (_, i) => ({ id: "case-" + i, eligible: true })) } };
  return { phaseKind: "final", axis, binding: { status: "PASS" }, phase: { status: "PASS" }, raw,
    ciRaw: structuredClone(raw), ciReplay: { status: "PASS", recorded_paint_status: "PASS" } };
};
test("finite effect is distinct from full enabled performance", () => {
  const x = sample(); x.raw.semantic.enabled_criteria = "UNMET"; x.ciRaw = structuredClone(x.raw);
  assert.deepEqual(classifyRequirementAxis(x), { quality: "UNMET", effect: "FINITE_EFFECT_DEMONSTRATED" });
});
test("fresh V/F can pass finite criteria without making an effect claim", () => {
  for (const axis of ["V", "F"]) assert.deepEqual(classifyRequirementAxis(sample(axis)),
    { quality: "FINITE_CRITERIA_PASS", effect: "NOT_EVALUATED" });
});
test("public and correction outputs never promote to unseen claims", () => {
  for (const phaseKind of ["public", "correction"]) assert.deepEqual(classifyRequirementAxis({ ...sample(), phaseKind }),
    { quality: "PUBLIC_REGRESSION_ONLY", effect: "PUBLIC_REGRESSION_ONLY" });
});
test("invalid, incomplete, synthetic or wrong-size records remain unproven", () => {
  for (const edit of [x => { x.raw.all_valid_execution = false; }, x => { x.raw.complete = false; },
    x => { x.raw.admissible_for_semantic_claim = false; }, x => { x.raw.planned = 19; },
    x => { x.raw.rows[0].grade.contract_valid = false; }, x => { x.phase.status = "FAIL"; }]) {
    const x = sample(); edit(x); assert.equal(classifyRequirementAxis(x).quality, "UNPROVEN");
  }
});
test("missing or nonmatching CI paint and unknown deadlines prevent closure", () => {
  for (const edit of [x => { x.ciReplay = null; }, x => { x.ciRaw.semantic.missing_gains = 3; },
    x => { x.raw.rows[0].goal_elapsedMs = null; }, x => { x.raw.rows[0].paint_status = "UNPROVEN"; }]) {
    const x = sample(); edit(x); assert.equal(classifyRequirementAxis(x).effect, "UNPROVEN");
  }
});
test("no effect requires the registered missing cases to have eligible measured pairs", () => {
  const x = sample(); x.raw.semantic.effect_criteria = "UNMET"; x.raw.semantic.missing_gains = 0;
  x.ciRaw = structuredClone(x.raw);
  assert.equal(classifyRequirementAxis(x).effect, "NO_EFFECT_IN_REGISTERED_MISSING_CASES");
  x.raw.semantic.pairs[0].eligible = false; x.ciRaw = structuredClone(x.raw);
  assert.equal(classifyRequirementAxis(x).effect, "UNPROVEN");
});
