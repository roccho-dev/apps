import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { classifyFinite, joinJournalSnapshots } from "./candidate-closure.mjs";

test("semantic success cannot promote failed or unknown physical drawing to finite product pass", () => {
  const raw = { model_comparison_admissible: true, panels: { C: { selected_finite_semantic_criteria: "PASS" } } };
  const paint = status => ({ status: "PASS", recorded_paint_status: status });
  assert.equal(classifyFinite(raw, "C", [paint("PASS"), paint("PASS")]), "SELECTED_FINITE_METHOD_PASS");
  assert.equal(classifyFinite(raw, "C", [paint("PASS"), paint("UNMET")]), "UNMET");
  assert.equal(classifyFinite(raw, "C", [paint("UNPROVEN"), paint("PASS")]), "UNPROVEN");
  assert.equal(classifyFinite({ ...raw, model_comparison_admissible: false }, "C", [paint("PASS"), paint("PASS")]), "UNPROVEN");
  raw.panels.C.selected_finite_semantic_criteria = "UNMET";
  assert.equal(classifyFinite(raw, "C", [paint("PASS"), paint("PASS")]), "UNMET");
});

test("actual journal cutoffs form one history; equal-cost forks and wrong phase cutoffs are refused", () => {
  const base = new URL("../../../docs/voice-ui/candidate-ci-20261017/evidence/closed-audits/", import.meta.url);
  const ids = ["candidate-public-20261017", ...[1, 2, 3].map(n => "candidate-type-diagnostic-" + n)];
  const snapshots = ids.map(id => ({ id, bytes: fs.readFileSync(new URL(id + ".journal.jsonl", base)),
    phase: { charged_at_cutoff: { jev: 309, typellm: id.endsWith("3") ? 21 : 20 } } }));
  assert.deepEqual(joinJournalSnapshots(snapshots), { jev: 309, typellm: 21 });
  const fork = snapshots.map(row => ({ ...row }));
  fork[0].bytes = Buffer.from(fork[0].bytes.toString().replace('"at":', '"fork_at":'));
  assert.throws(() => joinJournalSnapshots(fork), /one exact history/u);
  assert.throws(() => joinJournalSnapshots([...snapshots, snapshots[0]]), /one cutoff per phase/u);
  assert.throws(() => joinJournalSnapshots([{ ...snapshots.at(-1), id: "other" }]), /AssertionError/u);
});
