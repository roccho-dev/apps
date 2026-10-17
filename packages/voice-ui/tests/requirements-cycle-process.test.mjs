import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRequirementsProcess } from "./requirements-cycle-process.mjs";
const dir = process.env.POC_REQUIREMENTS_FIXTURES ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/voice-ui/requirements-cycle-20261017/preregistered");
const read = name => fs.readFileSync(path.join(dir, name));
const commitmentBytes = read("requirements-cycle-commitment.json"), addendumBytes = read("requirements-cycle-public-E2-correction.json");
const commitment = JSON.parse(commitmentBytes), addendum = JSON.parse(addendumBytes);
const publicFiles = Object.fromEntries(["original", "corrected"].flatMap(v => ["input", "oracle"].map(r =>
  [addendum[v][r], read(addendum[v][r])])));
const fixture = () => {
  const records = ["F", "V", "E", "V", "F", "E"].map((axis, i) => {
    const phase_kind = i < 3 ? "public" : "final", id = "phase-" + i;
    const file = commitment.files.find(f => f.axis === axis && f.visibility === (i < 3 ? "public" : "sealed"));
    const input_sha256 = phase_kind === "public" && axis === "E" ? addendum.corrected.input_sha256 : file.input_sha256;
    const count = phase_kind === "public" ? ({ F: 6, V: 6, E: 2 })[axis] : ({ F: 8, V: 10, E: 10 })[axis];
    return { index: { id, phase_kind, axis, apps_sha: "a".repeat(40) },
      input: { axis, cases: Array.from({ length: count }, (_, n) => ({ id: "case-" + n })) },
      config: { phase_id: id, stage: phase_kind, axis, case_count: count, heads: { apps: "a".repeat(40) }, input_sha256,
        allowances: axis === "F" ? { jev: 0, typellm: count } : axis === "V" ? { jev: count, typellm: 0 }
          : { jev: count * 19, typellm: count } },
      report: { binding: { status: "PASS" }, phase: { status: "PASS" }, raw: { status: "PASS", inputs_sha256: input_sha256,
        semantic: { requirements_criteria: "PASS", verification_criteria: "PASS", enabled_criteria: "PASS", effect_criteria: "PASS" } } } };
  });
  const journalBytes = Buffer.from([{ kind: "phase-reconcile", id: "axes-final-E-20261017" },
    ...records.flatMap(r => [{ kind: "phase-reserve", id: r.config.phase_id, prior_charged: { jev: 689, typellm: 40 } },
      { kind: "phase-reconcile", id: r.config.phase_id }])].map(JSON.stringify).join("\n") + "\n");
  return { records, journalBytes, commitmentBytes, addendumBytes, publicFiles };
};
test("fixed preregistration, corrected public oracle and full same-head sequence close", () => {
  assert.equal(auditRequirementsProcess(fixture()).status, "PASS");
});
test("unmet public criteria and a passed E pair from another head cannot unlock fresh inputs", () => {
  for (const change of [x => { x.records[0].report.raw.semantic.requirements_criteria = "UNMET"; },
    x => { x.records[2].report.raw.semantic.effect_criteria = "UNMET"; },
    x => { x.records[2].config.heads.apps = "b".repeat(40); x.records[2].index.apps_sha = "b".repeat(40); },
    x => { x.records[2].input.cases.pop(); x.records[2].config.case_count--; }]) {
    const x = fixture(); change(x); assert.equal(auditRequirementsProcess(x).status, "FAIL");
  }
});
test("dropped zero-send phases or changed order cannot disappear from process history", () => {
  for (const change of [x => { x.records.splice(0, 1); }, x => { x.records.reverse(); },
    x => { x.journalBytes = Buffer.from(x.journalBytes.toString().replace('689', '690')); }]) {
    const x = fixture(); change(x); assert.equal(auditRequirementsProcess(x).status, "FAIL");
  }
});
test("retained original and corrected oracle bytes are both mandatory", () => {
  for (const name of Object.keys(publicFiles)) {
    const x = fixture(); x.publicFiles = { ...publicFiles, [name]: Buffer.from("{}") };
    assert.equal(auditRequirementsProcess(x).status, "FAIL");
  }
});
test("over-reservation, extra correction groups and enlarged denominator fail", () => {
  for (const change of [x => { x.records[0].config.allowances.typellm = 7; },
    x => { x.records[2].config.correction_batch = 3; x.records[2].index.correction_batch = 3;
      x.records[2].index.phase_kind = "correction"; x.records[2].config.stage = "correction"; },
    x => { x.records[5].input.cases.push({ id: "extra" }); x.records[5].config.case_count++; }]) {
    const x = fixture(); change(x); assert.equal(auditRequirementsProcess(x).status, "FAIL");
  }
});
test("a stopped public-only trial remains recordable without claiming fresh admission", () => {
  const x = fixture(); x.records = x.records.slice(0, 3);
  x.records[2].report.raw.semantic.effect_criteria = "UNMET";
  x.journalBytes = Buffer.from(x.journalBytes.toString().split("\n").slice(0, 7).join("\n") + "\n");
  const r = auditRequirementsProcess(x); assert.equal(r.status, "PASS"); assert.deepEqual(r.releases, []);
});

const journalFor = records => Buffer.from([{ kind: "phase-reconcile", id: "axes-final-E-20261017" },
  ...records.flatMap(r => [{ kind: "phase-reserve", id: r.config.phase_id, prior_charged: { jev: 689, typellm: 40 } },
    { kind: "phase-reconcile", id: r.config.phase_id }])].map(JSON.stringify).join("\n") + "\n");
const correction = (record, batch, head, suffix) => {
  const r = structuredClone(record);
  r.index.phase_kind = "correction"; r.index.correction_batch = batch; r.index.apps_sha = head;
  r.config.stage = "correction"; r.config.correction_batch = batch; r.config.heads.apps = head;
  r.config.phase_id = "correction-" + suffix;
  return r;
};
test("corrections before initial E can qualify only with full F/V and E on that same head", () => {
  const x = fixture(), head = "b".repeat(40);
  const repairs = x.records.slice(0, 2).map((r, i) => correction(r, 1, head, String(i)));
  for (const r of x.records.slice(2)) { r.index.apps_sha = head; r.config.heads.apps = head; }
  x.records.splice(2, 0, ...repairs); x.journalBytes = journalFor(x.records);
  assert.equal(auditRequirementsProcess(x).status, "PASS");
});
test("raw input binding cannot be omitted or substituted after registration", () => {
  for (const edit of [x => { delete x.records[0].report.raw.inputs_sha256; },
    x => { x.records[0].report.raw.inputs_sha256 = "f".repeat(64); }]) {
    const x = fixture(); edit(x); assert.equal(auditRequirementsProcess(x).status, "FAIL");
  }
});
test("one correction batch cannot mix heads or return after a later batch", () => {
  const seed = fixture();
  for (const rows of [[correction(seed.records[0], 1, "b".repeat(40), "a"), correction(seed.records[1], 1, "c".repeat(40), "b")],
    [correction(seed.records[0], 1, "b".repeat(40), "a"), correction(seed.records[1], 2, "c".repeat(40), "b"),
      correction(seed.records[1], 1, "b".repeat(40), "c")]]) {
    const x = fixture(); x.records = rows; x.journalBytes = journalFor(rows);
    const result = auditRequirementsProcess(x); assert.equal(result.status, "FAIL");
    assert.ok(result.issues.some(i => i === "one source per correction batch" || i === "correction order"));
  }
});
