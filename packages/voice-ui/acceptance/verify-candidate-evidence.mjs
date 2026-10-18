// Keyless CI verification of stopped real executions. This never calls a model.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoSecretInputs } from "../tests/runtime-acceptance.mjs";
import { auditRawPanel, auditProviderPhase, auditProducerBinding, auditReplayJoin, sha256 } from "../tests/receipt-admissibility.mjs";
import { assessPaintedGoal as assessGoal, assessPaintedEdge as assessEdge } from "../tests/painted-goal.mjs";
import { classifyFinite, joinJournalSnapshots } from "../tests/candidate-closure.mjs";

assertNoSecretInputs();
const [indexFile, outputDirectory] = process.argv.slice(2);
assert.ok(indexFile && outputDirectory && process.argv.length === 4);
const repository = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const base = path.dirname(path.resolve(indexFile)), out = path.resolve(outputDirectory);
const within = relative => {
  assert.equal(typeof relative, "string");
  const absolute = path.resolve(base, relative);
  assert.ok(absolute.startsWith(repository + path.sep), "evidence path must remain in this repository");
  return absolute;
};
const read = relative => fs.readFileSync(within(relative));
const decode = bytes => JSON.parse(bytes);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const index = decode(fs.readFileSync(indexFile));
assert.equal(index.schema, "voice-ui.closed-evidence-index/1");
assert.ok(Array.isArray(index.panels) && index.panels.length > 0);
assert.equal(new Set(index.panels.map(row => row.id)).size, index.panels.length);
for (const row of [...index.panels, ...(index.diagnostics ?? [])]) {
  assert.match(row.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u);
  assert.match(row.apps_sha, /^[a-f0-9]{40}$/u);
}
fs.mkdirSync(out, { recursive: false });
const run = (program, args, options = {}) => {
  try { return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8000000, ...options }).trim(); }
  catch (error) { throw Error(`${program} failed (${error.status ?? "unknown"}): ${(error.stderr ?? "").toString().slice(-2000)}`); }
};
const nix = args => run("nix", ["--extra-experimental-features", "nix-command flakes", ...args]);
const artifacts = new Map();
for (const sha of new Set([...index.panels, ...(index.diagnostics ?? [])].map(row => row.apps_sha))) {
  const ref = "github:roccho-dev/apps/" + sha;
  const metadata = decode(nix(["flake", "metadata", "--json", ref]));
  assert.equal(metadata.locked.rev, sha);
  const built = nix(["build", "--no-link", "--print-out-paths", ref + "#voice-ui-dist"]);
  assert.match(built, /^\/nix\/store\/[a-z0-9]{32}-voice-ui-dist$/u);
  const stage = path.join(out, sha), opened = path.join(stage, "opened");
  fs.mkdirSync(stage); fs.mkdirSync(opened);
  fs.cpSync(built, path.join(stage, "voice-ui-dist"), { recursive: true, errorOnExist: true });
  run("zip", ["-qr", path.join(stage, "voice-ui-dist.zip"), "voice-ui-dist"], { cwd: stage });
  run("unzip", ["-q", path.join(stage, "voice-ui-dist.zip"), "-d", opened]);
  const artifact = path.join(opened, "voice-ui-dist");
  run("python3", [path.join(repository, "packages/voice-ui/dist.py"), "verify", "--dist", artifact]);
  const manifestBytes = fs.readFileSync(path.join(artifact, "manifest.json")), manifest = decode(manifestBytes);
  assert.equal(manifest.sources.apps, sha);
  artifacts.set(sha, { artifact, source: metadata.path, manifestBytes });
}
const reports = [];
const journalSnapshots = [];
for (const row of index.panels) {
  const built = artifacts.get(row.apps_sha), directory = path.join(out, row.id);
  fs.mkdirSync(directory);
  const rawFiles = Object.fromEntries(fs.readdirSync(within(row.raw_dir)).map(name =>
    [name, fs.readFileSync(path.join(within(row.raw_dir), name))]));
  const producer = decode(read(row.producer)), runtimeAuditBytes = read(row.runtime);
  assert.equal(producer.heads.apps, row.apps_sha);
  assert.ok(["A", "B", "C"].includes(row.selected_method));
  assert.equal(producer.oracle_sha256, sha256(read(row.oracle)));
  const runtime = decode(runtimeAuditBytes);
  assert.match(runtime.provider.path, /^\/nix\/store\/[a-z0-9]{32}-jev-provider-admitted\/batch[.]mjs$/u);
  const providerBytes = fs.readFileSync(runtime.provider.path);
  const workerBytes = fs.readFileSync(path.join(built.artifact, "worker/worker.mjs"));
  const protocolEntry = path.join(built.artifact, "site/ui/semantic-map/protocol/index.js");
  const protocolEntryBytes = fs.readFileSync(protocolEntry), protocol = await import(pathToFileURL(protocolEntry));
  const bundleBytes = fs.readFileSync(path.join(built.artifact, "site/data/bundle.v1.json"));
  const stdoutBytes = read(row.stdout), stderrBytes = read(row.stderr), journalBytes = read(row.journal);
  const configBytes = read(row.config), processBytes = read(row.process), replayBytes = read(row.recorded_replay);
  const sourceFiles = Object.fromEntries(Object.keys(producer.source_sha256).map(name => {
    assert.match(name, /^(?:src|tests)\/[a-zA-Z0-9_.-]+[.]mjs$/u);
    return [name, fs.readFileSync(path.join(built.source, "packages/voice-ui", name))];
  }));
  const auditReferences = Object.fromEntries(Object.entries(row.audits).map(([name, file]) => [name, read(file)]));
  const binding = auditProducerBinding({ identityBytes: rawFiles["identity.json"], runtimeAuditBytes, configBytes,
    processBytes, artifactManifestBytes: built.manifestBytes, workerBytes, providerBytes, protocolEntryBytes,
    bundleBytes, sourceFiles, auditReferences, rawFiles, stdoutBytes, stderrBytes, journalBytes, replayBytes }, producer);
  const raw = await auditRawPanel({ projectionBytes: read(row.parent_input), oracleBytes: read(row.oracle),
    rawFiles, bundleBytes, protocol, stdoutBytes, phaseKind: row.phase_kind,
    selectedProjectionBytes: row.selected_input ? read(row.selected_input) : null });
  const phase = auditProviderPhase({ configBytes, processBytes, stdoutBytes, stderrBytes, journalBytes }, raw.http_attempts);
  journalSnapshots.push({ bytes: journalBytes, id: decode(configBytes).phase_id, phase });
  const recordedReplay = auditReplayJoin({ replayBytes, rawFiles, artifactManifestBytes: built.manifestBytes, assessGoal, assessEdge });
  const replayDirectory = path.join(directory, "ci-replay");
  run(process.execPath, [path.join(repository, "packages/voice-ui/acceptance/replay-candidates.mjs"),
    built.artifact, within(row.raw_dir), replayDirectory]);
  const ciReplay = auditReplayJoin({ replayBytes: fs.readFileSync(path.join(replayDirectory, "receipt.json")), rawFiles,
    artifactManifestBytes: built.manifestBytes, assessGoal, assessEdge });
  for (const axis of [binding, raw, phase, recordedReplay, ciReplay]) assert.equal(axis.status, "PASS", JSON.stringify(axis.issues));
  assert.equal(raw.recorded_execution_status, row.expected_execution_status);
  const report = { id: row.id, binding, raw, phase, recordedReplay, ciReplay,
    performance_classification: classifyFinite(raw, row.selected_method, [recordedReplay, ciReplay]) };
  write(path.join(directory, "audit.json"), report); reports.push(report);
  if (row.mutation_fixture) {
    const fixture = path.join(directory, "mutation-fixture"), phaseFixture = path.join(fixture, "public-invalid-f2-phase");
    fs.mkdirSync(fixture); fs.mkdirSync(phaseFixture);
    fs.cpSync(within(row.raw_dir), path.join(fixture, "public-invalid-f2"), { recursive: true });
    for (const [name, bytes] of Object.entries({ "config.json": configBytes, "process.json": processBytes,
      "stdout.log": stdoutBytes, "stderr.log": stderrBytes, "journal.jsonl": journalBytes,
      "runtime-build.json": runtimeAuditBytes, "artifact-manifest.json": built.manifestBytes, "worker.mjs": workerBytes,
      "provider.mjs": providerBytes, "protocol-entry.js": protocolEntryBytes, "bundle.json": bundleBytes, "replay.json": replayBytes }))
      fs.writeFileSync(path.join(phaseFixture, name), bytes, { flag: "wx" });
    for (const [name, bytes] of Object.entries({ "public-eight.inputs.json": read(row.parent_input),
      "public-eight.oracle.json": read(row.oracle), "public-invalid-f2.producer.json": read(row.producer) }))
      fs.writeFileSync(path.join(fixture, name), bytes, { flag: "wx" });
    for (const [name, file] of Object.entries(producer.audit_files)) {
      assert.equal(row.audits[name], file);
      fs.writeFileSync(path.join(fixture, file), auditReferences[name], { flag: "wx" });
    }
    const mutationOutput = run(process.execPath, ["--test", path.join(repository, "packages/voice-ui/tests/receipt-admissibility-mutations.mjs")], {
      env: { ...process.env, POC_RECEIPT_FIXTURES: fixture, POC_SOURCE_ROOT: built.source,
        POC_PROTOCOL_ENTRY: protocolEntry, POC_ASSESSOR_ENTRY: path.join(repository, "packages/voice-ui/tests/painted-goal.mjs") } });
    fs.writeFileSync(path.join(directory, "mutation-test.txt"), mutationOutput + "\n", { flag: "wx" });
    }
}
const diagnostics = [];
for (const row of index.diagnostics ?? []) {
  const journalBytes = read(row.journal), configBytes = read(row.config);
  const phase = auditProviderPhase({ configBytes, processBytes: read(row.process),
    stdoutBytes: read(row.stdout), stderrBytes: read(row.stderr), journalBytes }, row.expected_sends);
  journalSnapshots.push({ bytes: journalBytes, id: decode(configBytes).phase_id, phase });
  assert.equal(phase.status, "PASS", JSON.stringify(phase.issues));
  const auditBytes = read(row.stop_audit), audit = decode(auditBytes);
  assert.equal(sha256(auditBytes), row.stop_audit_sha256);
  assert.equal(audit.phase, decode(configBytes).phase_id);
  for (const [bytes, expected] of [[configBytes, audit.config_sha256], [journalBytes, audit.ledger_sha256],
    [read(row.stdout), audit.stdout_sha256], [read(row.stderr), audit.stderr_sha256]]) assert.equal(sha256(bytes), expected);
  assert.deepEqual(audit.sent, row.expected_sends); assert.deepEqual(audit.pending, []);
  assert.deepEqual(audit.group_members_including_z, []);
  assert.deepEqual(audit.charged, phase.charged_at_cutoff);
  const process = decode(read(row.process));
  assert.equal(process.pid, audit.reconciliation.pid);
  assert.equal(process.start_ticks, audit.reconciliation.start_ticks);
  assert.equal(decode(read(row.config)).heads.apps, row.apps_sha);
  if (row.response) {
    const response = decode(read(row.response));
    assert.equal(response.scope, "NEW_ATTEMPT_DIAGNOSTIC_ONLY");
    assert.equal(response.status, row.expected_status);
    assert.equal(response.request_sha256, sha256(read(row.request)));
    assert.equal(response.request_sha256, audit.request_sha256 ?? audit.payload_sha256);
    assert.equal(sha256(read(row.response)), audit.response_sha256);
    assert.deepEqual(response.body, row.expected_body);
  }
  diagnostics.push({ id: row.id, phase, scope: "DIAGNOSTIC_ONLY_NO_MODEL_QUALITY_CLAIM" });
}
const cumulative = joinJournalSnapshots(journalSnapshots);
assert.deepEqual(cumulative, index.expected_cumulative);
write(path.join(out, "receipt.json"), { schema: "voice-ui.closed-evidence-ci/1", integrity: "PASS", cumulative, reports, diagnostics,
  CI_LIVE_EXECUTION: "UNPROVEN", four_way_comparison: "INCOMPLETE_D_BLOCKED_COST", currency: "COST_NOT_MEASURED" });
console.log(JSON.stringify({ integrity: "PASS", panels: reports.length, diagnostics: diagnostics.length,
  classification: reports.map(row => ({ id: row.id, performance: row.performance_classification })) }));
