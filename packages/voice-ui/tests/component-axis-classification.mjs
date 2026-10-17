// Classification of frozen axis audits only; this never regrades or edits them.
import { canonical } from "./semantic-score.mjs";
const counts = { G: 10, R: 8, F: 16, E: 10 };
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fresh = (raw, axis) => raw?.status === "PASS" && raw.axis === axis && raw.phase_kind === "fresh"
  && raw.planned === counts[axis] && raw.consumed === counts[axis] && raw.complete === true
  && raw.all_valid_execution === true && raw.admissible_for_semantic_claim === true
  && Array.isArray(raw.rows) && raw.rows.length === counts[axis];
export function classifyComponentAxis({ phaseKind, axis, binding, raw, phase, ciReplay = null, ciRaw = null }) {
  if (!["public", "correction", "final"].includes(phaseKind) || !Object.hasOwn(counts, axis))
    throw Error("axis classification scope");
  if ([binding, raw, phase].some(a => a?.status !== "PASS")) return "UNPROVEN";
  if (phaseKind !== "final") return "PUBLIC_REGRESSION_ONLY";
  if (!fresh(raw, axis)) return "UNPROVEN";
  const contractValid = rows => rows.every(r => axis === "G" || axis === "F" ? r.grade?.contract_valid === true
    : axis === "E" ? r.grade?.decision_contract_valid === true : true);
  if (!contractValid(raw.rows)) return "UNPROVEN";
  if (axis === "R" || axis === "E") {
    if (raw.replay?.status !== "PASS" || ciReplay?.status !== "PASS" || !fresh(ciRaw, axis) || !contractValid(ciRaw.rows)
        || !same(raw.semantic, ciRaw.semantic)
        || !["PASS", "UNMET"].includes(raw.replay.recorded_paint_status)
        || !["PASS", "UNMET"].includes(ciReplay.recorded_paint_status)
        || raw.rows.some(r => !["PASS", "UNMET"].includes(r.paint_status))) return "UNPROVEN";
    if (axis === "E" && raw.rows.some(r => !Number.isFinite(r.goal_elapsedMs) || r.goal_elapsedMs < 0
        || !["PASS", "UNMET"].includes(r.goal_deadline_status))) return "UNPROVEN";
  }
  const criteria = axis === "G" ? [raw.semantic?.semantic_criteria]
    : axis === "R" ? [raw.semantic?.representation_criteria]
    : axis === "F" ? [raw.semantic?.per_method?.literal?.semantic_criteria, raw.semantic?.per_method?.typed?.semantic_criteria]
    : [raw.semantic?.ordinary_criteria];
  if (criteria.some(c => !["PASS", "UNMET"].includes(c))) return "UNPROVEN";
  return criteria.every(c => c === "PASS") ? "FINITE_CRITERIA_PASS" : "UNMET";
}
