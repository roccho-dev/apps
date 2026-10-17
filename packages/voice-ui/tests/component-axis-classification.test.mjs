import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { classifyComponentAxis } from "./component-axis-classification.mjs";
const fixture = axis => {
  const count = { G: 10, R: 8, F: 16, E: 10 }[axis];
  const semantic = axis === "G" ? { semantic_criteria: "PASS" }
    : axis === "R" ? { representation_criteria: "PASS" }
    : axis === "F" ? { per_method: { literal: { semantic_criteria: "PASS" }, typed: { semantic_criteria: "PASS" } } }
    : { ordinary_criteria: "PASS" };
  return { phaseKind: "final", axis, binding: { status: "PASS" }, phase: { status: "PASS" },
    raw: { status: "PASS", axis, phase_kind: "fresh", planned: count, consumed: count, complete: true,
      all_valid_execution: true, admissible_for_semantic_claim: true, semantic,
      rows: Array.from({ length: count }, () => ({ grade: { contract_valid: true, decision_contract_valid: true },
        paint_status: "PASS", goal_elapsedMs: 20, goal_deadline_status: "PASS" })),
      replay: { status: "PASS", recorded_paint_status: "PASS" } },
    ciReplay: { status: "PASS", recorded_paint_status: "PASS" }, ciRaw: { status: "PASS", axis, phase_kind: "fresh",
      planned: count, consumed: count, complete: true, all_valid_execution: true, admissible_for_semantic_claim: true,
      rows: Array.from({ length: count }, () => ({ grade: { decision_contract_valid: true } })), semantic: structuredClone(semantic) } };
};
test("only complete fresh admitted axes can pass; classifications never edit audit observations", () => {
  for (const axis of ["G", "R", "F", "E"]) {
    const f = fixture(axis), before = JSON.stringify(f);
    assert.equal(classifyComponentAxis(f), "FINITE_CRITERIA_PASS"); assert.equal(JSON.stringify(f), before);
    for (const kind of ["public", "correction"]) {
      f.phaseKind = kind; f.raw.all_valid_execution = false;
      assert.equal(classifyComponentAxis(f), "PUBLIC_REGRESSION_ONLY");
    }
  }
});
test("missing/invalid source, cells, contract or fresh identity cannot pass even with perfect numerators", () => {
  for (const axis of ["G", "R", "F", "E"])
    for (const mutate of [f => { f.binding.status = "FAIL"; }, f => { f.phase.status = "FAIL"; },
      f => { f.raw.status = "FAIL"; }, f => { f.raw.all_valid_execution = false; },
      f => { f.raw.admissible_for_semantic_claim = false; }, f => { f.raw.consumed--; },
      f => { f.raw.phase_kind = "public"; }, f => { f.raw.rows.pop(); }]) {
      const f = fixture(axis); mutate(f); assert.equal(classifyComponentAxis(f), "UNPROVEN");
    }
});
test("one failed Type arm is never removed from the whole F comparison", () => {
  const f = fixture("F"); f.raw.semantic.per_method.typed.semantic_criteria = "UNMET";
  assert.equal(classifyComponentAxis(f), "UNMET");
  f.raw.all_valid_execution = false; f.raw.admissible_for_semantic_claim = false;
  assert.equal(classifyComponentAxis(f), "UNPROVEN");
  f.phaseKind = "public"; assert.equal(classifyComponentAxis(f), "PUBLIC_REGRESSION_ONLY");
});
test("known paint failure is UNMET while absent or unjoined paint is UNPROVEN", () => {
  for (const axis of ["R", "E"]) {
    const f = fixture(axis), key = axis === "R" ? "representation_criteria" : "ordinary_criteria";
    f.raw.semantic[key] = "UNMET"; f.ciRaw.semantic[key] = "UNMET"; f.raw.rows[0].paint_status = "UNMET";
    f.raw.replay.recorded_paint_status = "UNMET"; f.ciReplay.recorded_paint_status = "UNMET";
    assert.equal(classifyComponentAxis(f), "UNMET");
    f.raw.rows[0].paint_status = "UNPROVEN"; assert.equal(classifyComponentAxis(f), "UNPROVEN");
  }
  const missing = fixture("R"); missing.ciReplay = null; assert.equal(classifyComponentAxis(missing), "UNPROVEN");
});
test("Goal timing and CI semantic disagreement never become a performance failure or success guess", () => {
  const f = fixture("E"); f.raw.rows[0].goal_elapsedMs = null;
  f.raw.rows[0].goal_deadline_status = "UNPROVEN"; assert.equal(classifyComponentAxis(f), "UNPROVEN");
  const mismatch = fixture("R"); mismatch.ciRaw.semantic.graph_exact = 0;
  assert.equal(classifyComponentAxis(mismatch), "UNPROVEN");
  const absent = fixture("G"); absent.raw.semantic = null; assert.equal(classifyComponentAxis(absent), "UNPROVEN");
});
test("CI raw admission, contract validity and deadline enum remain fail closed", () => {
  for (const axis of ["R", "E"]) for (const mutate of [r => { r.complete = false; },
    r => { r.all_valid_execution = false; }, r => { r.admissible_for_semantic_claim = false; },
    r => { r.axis = "G"; }, r => { r.phase_kind = "public"; }, r => { r.consumed--; }, r => { r.rows.pop(); }]) {
    const f = fixture(axis); mutate(f.ciRaw); assert.equal(classifyComponentAxis(f), "UNPROVEN");
  }
  for (const axis of ["G", "F", "E"]) {
    const f = fixture(axis); f.raw.rows[0].grade[axis === "E" ? "decision_contract_valid" : "contract_valid"] = false;
    assert.equal(classifyComponentAxis(f), "UNPROVEN");
  }
  const f = fixture("E"); f.raw.rows[0].goal_deadline_status = "unknown";
  assert.equal(classifyComponentAxis(f), "UNPROVEN");
});
test("all four stopped real public reports remain public regression, including invalid Type", () => {
  const root = new URL("../../../docs/voice-ui/component-axes-20261017/evidence/", import.meta.url);
  const read = name => JSON.parse(fs.readFileSync(new URL(name, root)));
  for (const axis of ["G", "R", "F", "E"]) {
    const prefix = `public-${axis}/axes-public-${axis}-286e-`;
    const raw = read(prefix + "raw-audit.json");
    assert.equal(classifyComponentAxis({ phaseKind: "public", axis, raw,
      binding: read(prefix + "producer-audit.json"), phase: read(prefix + "provider-audit.json") }), "PUBLIC_REGRESSION_ONLY");
    if (axis === "F") assert.equal(raw.all_valid_execution, false);
  }
});
