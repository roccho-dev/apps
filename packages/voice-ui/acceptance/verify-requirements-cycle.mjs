// Keyless CI closure for axis-specific, already stopped provider executions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoSecretInputs } from "../tests/runtime-acceptance.mjs";
import { auditRequirementRaw, auditRequirementProducerBinding, auditRequirementProviderPhase, auditRequirementReplayJoin } from "../tests/requirements-cycle-audit.mjs";
import { assessPaintedGoal as assessGoal, assessPaintedEdge as assessEdge } from "../tests/painted-goal.mjs";
import { joinJournalSnapshots } from "../tests/candidate-closure.mjs";
import { classifyRequirementAxis } from "../tests/requirements-cycle-classification.mjs";
import { auditRequirementsProcess } from "../tests/requirements-cycle-process.mjs";
assertNoSecretInputs();
const [indexFile, outputDirectory] = process.argv.slice(2);
assert.ok(indexFile && outputDirectory && process.argv.length === 4);
const repository = path.resolve(fileURLToPath(new URL("../../../", import.meta.url))), base = path.dirname(path.resolve(indexFile));
const within = relative => {
  assert.equal(typeof relative, "string");
  const absolute = path.resolve(base, relative);
  assert.ok(absolute.startsWith(repository + path.sep), "evidence path outside repository");
  return absolute;
};
const read = relative => fs.readFileSync(within(relative)), decode = bytes => JSON.parse(bytes);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const index = decode(fs.readFileSync(indexFile));
assert.equal(index.schema, "voice-ui.requirements-cycle-evidence-index/1");
assert.ok(Array.isArray(index.phases) && index.phases.length > 0);
assert.equal(new Set(index.phases.map(row => row.id)).size, index.phases.length);
const out = path.resolve(outputDirectory); fs.mkdirSync(out);
const run = (program, args, options = {}) => {
  try { return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8000000, ...options }).trim(); }
  catch (e) { throw Error(program + " failed: " + (e.stderr ?? "").toString().slice(-2500)); }
};
const nix = args => run("nix", ["--extra-experimental-features", "nix-command flakes", ...args]), builds = new Map();
const representationReference = "286eb7d0bc0bdef160bda900547314aa5be3a752";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const sha of new Set([...index.phases.map(row => row.apps_sha), representationReference])) {
  assert.match(sha, /^[a-f0-9]{40}$/u);
  const ref = "github:roccho-dev/apps/" + sha, metadata = decode(nix(["flake", "metadata", "--json", ref]));
  assert.equal(metadata.locked.rev, sha);
  const artifact = nix(["build", "--no-link", "--print-out-paths", ref + "#voice-ui-dist"]);
  assert.match(artifact, /^\/nix\/store\/[a-z0-9]{32}-voice-ui-dist$/u);
  const stage = path.join(out, sha), opened = path.join(stage, "opened"); fs.mkdirSync(stage); fs.mkdirSync(opened);
  fs.cpSync(artifact, path.join(stage, "voice-ui-dist"), { recursive: true, errorOnExist: true });
  run("zip", ["-qr", path.join(stage, "voice-ui-dist.zip"), "voice-ui-dist"], { cwd: stage });
  run("unzip", ["-q", path.join(stage, "voice-ui-dist.zip"), "-d", opened]);
  const completed = path.join(opened, "voice-ui-dist");
  run("python3", [path.join(repository, "packages/voice-ui/dist.py"), "verify", "--dist", completed]);
  const manifestBytes = fs.readFileSync(path.join(completed, "manifest.json"));
  assert.equal(decode(manifestBytes).sources.apps, sha);
  builds.set(sha, { artifact: completed, source: metadata.path, manifestBytes });
}
const reference = builds.get(representationReference), representation = [];
for (const sha of new Set(index.phases.map(row => row.apps_sha))) {
  const candidate = builds.get(sha);
  const core = ["src/goal.mjs", "src/turn.mjs", "src/contract.mjs", "src/session.mjs", "src/log.mjs", "web/app.mjs"];
  for (const name of core) assert.equal(hash(fs.readFileSync(path.join(candidate.source, "packages/voice-ui", name))),
    hash(fs.readFileSync(path.join(reference.source, "packages/voice-ui", name))), "conditional representation core " + name);
  const renderer = built => decode(built.manifestBytes).files.filter(row => row.path.startsWith("site/ui/semantic-map/"))
    .map(row => ({ path: row.path, bytes: row.bytes, sha256: hash(fs.readFileSync(path.join(built.artifact, row.path))) }));
  const baseline = renderer(reference), actual = renderer(candidate);
  assert.ok(baseline.length > 0); assert.deepEqual(actual, baseline, "actual completed renderer and protocol bytes");
  representation.push({ apps_sha: sha, reference: representationReference, core_files: core.length, renderer_files: actual.length,
    status: "SAME_REPRESENTATION_BYTES_ONLY", scope: "conditional prior R8 evidence; current ordinary Goal paint is independently required" });
}
const reports = [], snapshots = [], processRecords = [];
for (const row of index.phases) {
  assert.match(row.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
  assert.ok(["V", "F", "E"].includes(row.axis));
  assert.ok(["public", "correction", "final"].includes(row.phase_kind));
  const built = builds.get(row.apps_sha), directory = path.join(out, row.id); fs.mkdirSync(directory);
  const rawFiles = Object.fromEntries(fs.readdirSync(within(row.raw_dir)).map(name =>
    [name, fs.readFileSync(path.join(within(row.raw_dir), name))]));
  const producer = decode(read(row.producer)), runtimeAuditBytes = read(row.runtime), runtime = decode(runtimeAuditBytes);
  assert.equal(producer.axis, row.axis); assert.equal(producer.heads.apps, row.apps_sha);
  assert.match(runtime.provider.path, /^\/nix\/store\/[a-z0-9]{32}-jev-provider-admitted\/batch[.]mjs$/u);
  const providerBytes = fs.readFileSync(runtime.provider.path), workerBytes = fs.readFileSync(path.join(built.artifact, "worker/worker.mjs"));
  const protocolEntry = path.join(built.artifact, "site/ui/semantic-map/protocol/index.js");
  const protocolEntryBytes = fs.readFileSync(protocolEntry), protocol = await import(pathToFileURL(protocolEntry));
  const bundleBytes = fs.readFileSync(path.join(built.artifact, "site/data/bundle.v1.json"));
  const stdoutBytes = read(row.stdout), stderrBytes = read(row.stderr), journalBytes = read(row.journal);
  const configBytes = read(row.config), processBytes = read(row.process), replayBytes = row.recorded_replay ? read(row.recorded_replay) : null;
  const sourceFiles = Object.fromEntries(Object.keys(producer.source_sha256).map(name => {
    assert.match(name, /^(?:src|tests|functions|web|dev)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+[.]mjs$/u);
    return [name, fs.readFileSync(path.join(built.source, "packages/voice-ui", name))];
  }));
  const auditReferences = Object.fromEntries(Object.entries(row.audits).map(([name, file]) => [name, read(file)]));
  const binding = auditRequirementProducerBinding({ identityBytes: rawFiles["identity.json"], runtimeAuditBytes, configBytes, processBytes,
    artifactManifestBytes: built.manifestBytes, workerBytes, providerBytes, protocolEntryBytes, bundleBytes, sourceFiles,
    auditReferences, rawFiles, stdoutBytes, stderrBytes, journalBytes, replayBytes }, producer);
  const raw = await auditRequirementRaw({ projectionBytes: read(row.input), oracleBytes: read(row.oracle), rawFiles, bundleBytes,
    protocol, stdoutBytes, assessGoal, assessEdge, replayBytes, artifactManifestBytes: built.manifestBytes,
    phaseKind: row.phase_kind === "final" ? "fresh" : row.phase_kind,
    parentProjectionBytes: row.parent_input ? read(row.parent_input) : null });
  const phase = auditRequirementProviderPhase({ configBytes, processBytes, stdoutBytes, stderrBytes, journalBytes },
    raw.external_provider_attempt_bounds, { axis: row.axis, caseCount: decode(read(row.input)).cases.length, phaseKind: row.phase_kind });
  if (row.phase_kind === "correction") assert.equal(producer.parent_inputs_sha256, raw.parent_inputs_sha256);
  else assert.equal(producer.parent_inputs_sha256 ?? null, null);
  snapshots.push({ id: decode(configBytes).phase_id, bytes: journalBytes, phase });
  for (const audit of [binding, raw, phase]) assert.equal(audit.status, "PASS", JSON.stringify(audit.issues));
  assert.equal(decode(rawFiles["execution.json"]).status, row.expected_execution_status);
  let ciReplay = null, ciRaw = null;
  if (row.axis === "E") {
    const destination = path.join(directory, "ci-replay");
    run(process.execPath, [path.join(repository, "packages/voice-ui/acceptance/replay-candidates.mjs"), built.artifact, within(row.raw_dir), destination]);
    const ciReplayBytes = fs.readFileSync(path.join(destination, "receipt.json"));
    ciReplay = auditRequirementReplayJoin({ replayBytes: ciReplayBytes, rawFiles, artifactManifestBytes: built.manifestBytes, assessGoal, assessEdge });
    assert.equal(ciReplay.status, "PASS", JSON.stringify(ciReplay.issues));
    ciRaw = await auditRequirementRaw({ projectionBytes: read(row.input), oracleBytes: read(row.oracle), rawFiles, bundleBytes,
      protocol, stdoutBytes, assessGoal, assessEdge, replayBytes: ciReplayBytes, artifactManifestBytes: built.manifestBytes,
      phaseKind: row.phase_kind === "final" ? "fresh" : row.phase_kind,
      parentProjectionBytes: row.parent_input ? read(row.parent_input) : null });
    assert.equal(ciRaw.status, "PASS", JSON.stringify(ciRaw.issues));
    assert.deepEqual(ciRaw.semantic, raw.semantic, "CI independently restores and grades the same recorded outputs");
  }
  const classification = classifyRequirementAxis({ phaseKind: row.phase_kind, axis: row.axis, binding, raw, phase, ciReplay, ciRaw });
  const report = { id: row.id, phase_kind: row.phase_kind, axis: row.axis, classification, binding, raw, phase, ciReplay, ciRaw };
  write(path.join(directory, "audit.json"), report); reports.push(report);
  processRecords.push({ index: row, config: decode(configBytes), input: decode(read(row.input)), report });
}
const cumulative = joinJournalSnapshots(snapshots); assert.deepEqual(cumulative, index.expected_cumulative);
assert.ok(cumulative.jev <= 989 && cumulative.typellm <= 80);
const commitmentBytes = read(index.commitment), addendumBytes = read(index.addendum), addendum = decode(addendumBytes);
const publicNames = [...new Set(["original", "corrected"].flatMap(v => ["input", "oracle"].map(r => addendum[v][r])))];
const publicFiles = Object.fromEntries(publicNames.map(name => [name,
  read(path.relative(base, path.join(path.dirname(within(index.commitment)), name)))]));
const journalBytes = snapshots.reduce((a, b) => a.bytes.length > b.bytes.length ? a : b).bytes;
const processGraph = auditRequirementsProcess({ records: processRecords, journalBytes, commitmentBytes, addendumBytes, publicFiles });
assert.equal(processGraph.status, "PASS", JSON.stringify(processGraph.issues));
write(path.join(out, "receipt.json"), { schema: "voice-ui.requirements-cycle-ci/1", integrity: "PASS", cumulative, reports, representation, processGraph,
  quality: reports.map(row => ({ id: row.id, axis: row.axis, classification: row.classification })),
  CI_LIVE_EXECUTION: "UNPROVEN", currency: "COST_NOT_MEASURED" });
console.log(JSON.stringify({ integrity: "PASS", phases: reports.length, cumulative,
  results: reports.map(row => ({ id: row.id, axis: row.axis, classification: row.classification, semantic: row.raw.semantic })) }));


