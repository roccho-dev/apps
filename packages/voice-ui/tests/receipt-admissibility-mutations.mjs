import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { auditRawPanel, auditProviderPhase, auditProducerBinding, auditReplayJoin, sha256, jsonLines } from "./receipt-admissibility.mjs";

// Tests consume the actual stopped public INVALID snapshot. Mutations below are
// test-only and never replace or become live evidence.
const base = process.env.POC_RECEIPT_FIXTURES ?? fileURLToPath(new URL("./", import.meta.url));
const read = name => fs.readFileSync(path.join(base, name));
const rawDir = path.join(base, "public-invalid-f2"), phaseDir = "public-invalid-f2-phase/";
const rawFiles = Object.fromEntries(fs.readdirSync(rawDir).map(name => [name, fs.readFileSync(path.join(rawDir, name))]));
const protocolPath = process.env.POC_PROTOCOL_ENTRY ?? fileURLToPath(new URL("../../../../ui.git/.worktrees/voice-ui-render-identity-20261017/packages/semantic-map/protocol/index.js", import.meta.url));
const assessorPath = process.env.POC_ASSESSOR_ENTRY ?? fileURLToPath(new URL("../../typellm-ci-20261017/packages/voice-ui/tests/painted-goal.mjs", import.meta.url));
const protocol = await import(pathToFileURL(protocolPath));
const { assessPaintedGoal: assessGoal, assessPaintedEdge: assessEdge } = await import(pathToFileURL(assessorPath));
const rawArgs = () => ({ projectionBytes: read("public-eight.inputs.json"), oracleBytes: read("public-eight.oracle.json"),
  rawFiles: { ...rawFiles }, bundleBytes: read(phaseDir + "bundle.json"), protocol, stdoutBytes: read(phaseDir + "stdout.log") });
const phaseArgs = () => Object.fromEntries(["config", "process", "stderr", "stdout", "journal"].map(name =>
  [name + "Bytes", read(phaseDir + name + (["stderr", "stdout"].includes(name) ? ".log" : name === "journal" ? ".jsonl" : ".json"))]));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const mutateJson = (files, name, fn) => { const value = JSON.parse(files[name]); fn(value); files[name] = encode(value); };
const asJsonl = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");

test("all actual INVALID raw files join, but five of24 arms cannot become an admissible panel", async () => {
  const report = await auditRawPanel(rawArgs());
  assert.equal(report.status, "PASS"); assert.deepEqual(report.issues, []);
  assert.equal(report.recorded_execution_status, "INVALID"); assert.equal(report.model_comparison_admissible, false);
  assert.deepEqual([report.consumed, report.planned, report.factor_count], [5, 24, 5]);
  assert.deepEqual(report.http_attempts, { jev: 17, typellm: 1 });
  assert.deepEqual(report.missing_responses, [{ id: "H05", arm: "C", n: 2, status: null }]);
  assert.ok(report.proofs.every(row => row.status === "PASS"));
  for (const panel of Object.values(report.panels)) assert.equal(panel.selected_finite_semantic_criteria, "UNMET");
});

test("protocol/records, event/response, factors, order, inputs and file omissions are independently refused", async () => {
  const cases = [
    args => mutateJson(args.rawFiles, "H01-A.json", row => { row.final_records.find(r => r.type === "region" && r.id === "part-1").label = "tampered"; }),
    args => mutateJson(args.rawFiles, "H01-A.json", row => { row.final_log = row.final_log.replace('"parentId":"container"', '"parentId":"other"'); }),
    args => mutateJson(args.rawFiles, "H01-A.json", row => { row.calls[0].response.confidence = .99; }),
    args => { const events = jsonLines(args.rawFiles["events.jsonl"]); events.splice(2, 1); args.rawFiles["events.jsonl"] = asJsonl(events); },
    args => { const rows = args.stdoutBytes.toString().split("\n"); const at = rows.findIndex(s => s.startsWith('{"kind":"voice-ui.parts.factors.v1"'));
      const factor = JSON.parse(rows[at]); factor.factors.intent.confidence = .01; rows[at] = JSON.stringify(factor); args.stdoutBytes = Buffer.from(rows.join("\n")); },
    args => mutateJson(args.rawFiles, "execution.json", row => { [row.summary[0], row.summary[1]] = [row.summary[1], row.summary[0]]; }),
    args => { args.projectionBytes = Buffer.concat([args.projectionBytes, Buffer.from(" ")]); },
    args => { delete args.rawFiles["H01-C.json"]; },
    args => { args.rawFiles["H01-X.json"] = Buffer.from("{}\n"); },
    args => mutateJson(args.rawFiles, "execution.json", row => { row.status = "RECORDED"; }),
  ];
  for (const change of cases) {
    const args = rawArgs(); change(args); let refused;
    try { refused = (await auditRawPanel(args)).status !== "PASS"; } catch { refused = true; }
    assert.equal(refused, true, "a mutated receipt must not retain integrity PASS");
  }
});

test("actual journal cutoff joins reserve/log sequence/reconcile, and missing or altered charges do not", () => {
  const report = auditProviderPhase(phaseArgs(), { jev: 17, typellm: 1 });
  assert.equal(report.status, "PASS"); assert.deepEqual(report.prior_charged, { jev: 292, typellm: 18 });
  assert.deepEqual(report.charged_at_cutoff, { jev: 309, typellm: 19 });
  const cases = [
    args => { args.stderrBytes = Buffer.from(args.stderrBytes.toString().replace("provider-send:jev:2\n", "provider-send:jev:3\n")); },
    args => { const rows = jsonLines(args.journalBytes); rows.at(-1).sent.typellm = 0; args.journalBytes = asJsonl(rows); },
    args => { const rows = jsonLines(args.journalBytes); rows.pop(); args.journalBytes = asJsonl(rows); },
    args => { const value = JSON.parse(args.processBytes); value.pid++; args.processBytes = encode(value); },
    args => { args.stdoutBytes = Buffer.concat([args.stdoutBytes, Buffer.from("unexpected\n")]); },
  ];
  for (const change of cases) {
    const args = phaseArgs(); change(args); let refused;
    try { refused = auditProviderPhase(args, { jev: 17, typellm: 1 }).status !== "PASS"; } catch { refused = true; }
    assert.equal(refused, true);
  }
});

test("all five actual raw outputs, including failed H05-C, join every exact artifact replay frame", () => {
  const args = { replayBytes: read(phaseDir + "replay.json"), rawFiles, artifactManifestBytes: read(phaseDir + "artifact-manifest.json"), assessGoal, assessEdge };
  const report = auditReplayJoin(args);
  assert.equal(report.status, "PASS"); assert.equal(report.consumed, 5); assert.equal(report.recorded_paint_status, "PASS");
  assert.equal(report.model_quality_scope, "NONE");
  for (const change of [
    row => row.rows.pop(), row => { row.rows[0].raw_sha256 = "0".repeat(64); },
    row => row.rows[0].frames.pop(), row => { row.rows[0].frames[1].observation.shapes[0].rawLabel = "wrong"; },
    row => { row.rows[0].frames[1].assessment.status = "UNMET"; },
    row => { row.status = "UNMET"; }, row => { row.artifact_manifest_sha256 = "0".repeat(64); },
  ]) {
    const receipt = JSON.parse(args.replayBytes); change(receipt); let refused;
    try { refused = auditReplayJoin({ ...args, replayBytes: encode(receipt) }).status !== "PASS"; } catch { refused = true; }
    assert.equal(refused, true);
  }
});

test("fixed producer expectations bind actual bytes plus explicit independent audit references", () => {
  const producer = JSON.parse(read("public-invalid-f2.producer.json"));
  const sourceFiles = Object.fromEntries(Object.keys(producer.source_sha256).map(name => [name,
    process.env.POC_SOURCE_ROOT ? fs.readFileSync(path.join(process.env.POC_SOURCE_ROOT, "packages/voice-ui", name))
    : execFileSync(process.env.POC_GIT ?? "git", ["--no-optional-locks", "-C", process.env.POC_FROZEN_REPOSITORY ?? path.resolve(base, ".."),
      "show", producer.heads.apps + ":packages/voice-ui/" + name], { maxBuffer: 1000000 })]));
  const args = { identityBytes: rawFiles["identity.json"], runtimeAuditBytes: read(phaseDir + "runtime-build.json"),
    configBytes: read(phaseDir + "config.json"), processBytes: read(phaseDir + "process.json"),
    artifactManifestBytes: read(phaseDir + "artifact-manifest.json"), workerBytes: read(phaseDir + "worker.mjs"),
    providerBytes: read(phaseDir + "provider.mjs"), protocolEntryBytes: read(phaseDir + "protocol-entry.js"),
    bundleBytes: read(phaseDir + "bundle.json"), sourceFiles, rawFiles,
    stdoutBytes: read(phaseDir + "stdout.log"), stderrBytes: read(phaseDir + "stderr.log"),
    journalBytes: read(phaseDir + "journal.jsonl"), replayBytes: read(phaseDir + "replay.json"),
    auditReferences: Object.fromEntries(Object.entries(producer.audit_files).map(([name, file]) => [name, read(file)])) };
  assert.equal(auditProducerBinding(args, producer).status, "PASS");
  for (const field of ["workerBytes", "protocolEntryBytes", "bundleBytes"]) {
    assert.equal(auditProducerBinding({ ...args, [field]: Buffer.concat([args[field], Buffer.from(" ")]) }, producer).status, "FAIL");
  }
  const changed = structuredClone(producer); changed.heads.apps = "0".repeat(40);
  assert.equal(auditProducerBinding(args, changed).status, "FAIL");
  assert.equal(auditProducerBinding({ ...args, auditReferences: {} }, producer).status, "FAIL");
  const tampered = { ...rawFiles };
  mutateJson(tampered, "H05-C.json", row => { row.calls[1].status = 502; row.calls[1].response = { error: "parts_contract" }; });
  const rewrittenReplay = JSON.parse(args.replayBytes);
  rewrittenReplay.rows.find(row => row.id === "H05" && row.arm === "C").raw_sha256 = sha256(tampered["H05-C.json"]);
  assert.equal(auditProducerBinding({ ...args, rawFiles: tampered, replayBytes: encode(rewrittenReplay) }, producer).status, "FAIL");
  const journal = Buffer.concat([args.journalBytes, Buffer.from('{"kind":"outcome","id":"invented"}\n')]);
  assert.equal(auditProducerBinding({ ...args, journalBytes: journal }, producer).status, "FAIL");
  assert.equal(sha256(args.identityBytes), producer.raw_identity_sha256);
});

test("selected receipt is explicitly partial, and flat/nested/keyed ignored arms are refused", async () => {
  const parent = JSON.parse(read("public-eight.inputs.json"));
  const selected = { schema: "voice-ui.poc.selected-cells/1", phase_kind: "correction",
    parent_inputs_sha256: sha256(read("public-eight.inputs.json")), fixture_contract: parent.fixture_contract,
    cases: [parent.cases.find(row => row.id === "H01")], comparison: { case_order: ["H01"], arm_order: ["C"] } };
  const make = plan => {
    const args = rawArgs(), selectedBytes = encode(plan), identity = JSON.parse(rawFiles["identity.json"]);
    Object.assign(identity, { schema: "voice-ui.poc.selected-cell-execution/1", inputs_sha256: sha256(selectedBytes),
      phase_kind: "correction", parent_inputs_sha256: selected.parent_inputs_sha256,
      selected_cells: [{ id: "H01", arm: "C" }], planned_arms: 1 });
    const execution = JSON.parse(rawFiles["execution.json"]), row = execution.summary.find(row => row.id === "H01" && row.arm === "C");
    args.rawFiles = { "identity.json": encode(identity), "execution.json": encode({ status: "RECORDED", summary: [row] }),
      "H01-C.json": rawFiles["H01-C.json"], "events.jsonl": asJsonl(jsonLines(rawFiles["events.jsonl"]).filter(e => e.id === "H01" && e.arm === "C")) };
    const factors = args.stdoutBytes.toString().split("\n").filter(line => line.startsWith('{"kind":"voice-ui.parts.factors.v1"'));
    args.stdoutBytes = Buffer.from(factors[2] + "\n");
    return { ...args, selectedProjectionBytes: selectedBytes, phaseKind: "correction" };
  };
  const report = await auditRawPanel(make(selected));
  assert.equal(report.status, "PASS"); assert.deepEqual([report.consumed, report.planned], [1, 1]);
  assert.equal(report.recorded_execution_status, "RECORDED"); assert.equal(report.complete_same_source_panel, false);
  assert.equal(report.model_comparison_admissible, false);
  for (const armOrder of [["C", "X"], [["C"], ["X"]], { H01: ["C"], unknown: ["A"] }]) {
    const changed = structuredClone(selected); changed.comparison.arm_order = armOrder;
    await assert.rejects(() => auditRawPanel(make(changed)), /arm_order/u);
  }
  const changed = structuredClone(selected); changed.cases[0].utterance += " changed";
  await assert.rejects(() => auditRawPanel(make(changed)), /selected_parent_projection/u);
  const unknown = structuredClone(selected); unknown.schema = "voice-ui.poc.selected-cells/unknown";
  await assert.rejects(() => auditRawPanel(make(unknown)), /selected_parent_projection/u);
});
