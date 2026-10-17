import assert from "node:assert/strict";

export function classifyFinite(raw, selected, paints) {
  assert.ok(["A", "B", "C"].includes(selected) && paints.length === 2);
  if (!raw.model_comparison_admissible) return "UNPROVEN";
  if (raw.panels[selected].selected_finite_semantic_criteria !== "PASS"
      || paints.some(paint => paint.recorded_paint_status === "UNMET")) return "UNMET";
  if (paints.some(paint => paint.recorded_paint_status !== "PASS")) return "UNPROVEN";
  return "SELECTED_FINITE_METHOD_PASS";
}

export function joinJournalSnapshots(snapshots) {
  assert.ok(snapshots.length > 0);
  assert.equal(new Set(snapshots.map(row => row.id)).size, snapshots.length, "one cutoff per phase");
  const latest = snapshots.reduce((a, b) => a.bytes.length > b.bytes.length ? a : b);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.bytes.at(-1) === 10 && latest.bytes.subarray(0, snapshot.bytes.length).equals(snapshot.bytes),
      "journal snapshots must share one exact history");
    const last = JSON.parse(snapshot.bytes.toString("utf8").trimEnd().split("\n").at(-1));
    assert.equal(last.kind, "phase-reconcile"); assert.equal(last.id, snapshot.id);
  }
  return structuredClone(latest.phase.charged_at_cutoff);
}
