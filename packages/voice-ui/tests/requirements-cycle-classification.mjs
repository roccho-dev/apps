// Interpret independently frozen audits. Integrity and product/effect criteria stay separate.
import { canonical } from "./semantic-score.mjs";
const counts = { V: 10, F: 8, E: 20 };
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fresh = (raw, axis) => raw?.status === "PASS" && raw.axis === axis && raw.phase_kind === "fresh"
  && raw.planned === counts[axis] && raw.consumed === counts[axis] && raw.complete === true
  && raw.all_valid_execution === true && raw.admissible_for_semantic_claim === true
  && Array.isArray(raw.rows) && raw.rows.length === counts[axis] && raw.rows.every(r => r.grade?.contract_valid === true);
export function classifyRequirementAxis({ phaseKind, axis, binding, raw, phase, ciReplay = null, ciRaw = null }) {
  if (!["public", "correction", "final"].includes(phaseKind) || !Object.hasOwn(counts, axis))
    throw Error("requirements classification scope");
  const unproven = { quality: "UNPROVEN", effect: axis === "E" ? "UNPROVEN" : "NOT_EVALUATED" };
  if ([binding, raw, phase].some(a => a?.status !== "PASS")) return unproven;
  if (phaseKind !== "final") return { quality: "PUBLIC_REGRESSION_ONLY", effect: "PUBLIC_REGRESSION_ONLY" };
  if (!fresh(raw, axis)) return unproven;
  if (axis === "E" && (raw.replay?.status !== "PASS" || ciReplay?.status !== "PASS" || !fresh(ciRaw, axis)
      || !same(raw.semantic, ciRaw.semantic)
      || !["PASS", "UNMET"].includes(raw.replay.recorded_paint_status)
      || !["PASS", "UNMET"].includes(ciReplay.recorded_paint_status)
      || raw.rows.some(r => !["PASS", "UNMET"].includes(r.paint_status)
        || !Number.isFinite(r.goal_elapsedMs) || r.goal_elapsedMs < 0
        || !["PASS", "UNMET"].includes(r.goal_deadline_status)))) return unproven;
  const s = raw.semantic;
  const criterion = axis === "V" ? s?.verification_criteria : axis === "F" ? s?.requirements_criteria : s?.enabled_criteria;
  if (!["PASS", "UNMET"].includes(criterion) || axis === "E" && !["PASS", "UNMET"].includes(s?.effect_criteria)) return unproven;
  let effect = "NOT_EVALUATED";
  if (axis === "E") {
    effect = s.effect_criteria === "PASS" ? "FINITE_EFFECT_DEMONSTRATED" : "UNMET";
    const missingPairs = s.pairs?.filter(p => raw.rows.some(r => r.id === p.id && r.grade?.expected_gate === "missing"));
    if (effect === "UNMET" && s.missing_gains === 0)
      effect = missingPairs?.length === 4 && missingPairs.every(p => p.eligible) && s.regressions === 0
        && s.no_false_adoption === true && s.all_arm_guards === true ? "NO_EFFECT_IN_REGISTERED_MISSING_CASES" : "UNPROVEN";
  }
  return { quality: criterion === "PASS" ? "FINITE_CRITERIA_PASS" : "UNMET", effect };
}
