// Completed-artifact quota mechanics. Every provider answer is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoSecretInputs, loadAcceptanceArtifact } from "../tests/runtime-acceptance.mjs";
import { QUOTA_SOURCE_NAMES } from "../tests/quota-cycle-audit.mjs";
import { QUOTA_METHODS, QUOTA_GENERATIONS, QUOTA_GOAL_POLICIES } from "../tests/quota-cycle-score.mjs";
assertNoSecretInputs();
const [artifact, out, previousArtifact] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.ok([artifact, out, previousArtifact].every(path.isAbsolute));
fs.mkdirSync(out);
const root = fileURLToPath(new URL("../../../", import.meta.url)), hash = b => createHash("sha256").update(b).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file)), enc = x => JSON.stringify(x, null, 2) + "\n";
const manifests = [artifact, previousArtifact].map(dir => {
  const bytes = fs.readFileSync(path.join(dir, "manifest.json")), value = JSON.parse(bytes);
  loadAcceptanceArtifact({ artifactRoot: dir, expectedAppsSha: value.sources.apps, expectedManifestSha256: hash(bytes) });
  return { value, bytes };
});
assert.equal(manifests[1].value.sources.apps, "0aa3c4b90519a1c18c217753698806507ccff3c0");
const workerPath = path.join(artifact, "worker/worker.mjs");
const { default: worker } = await import(pathToFileURL(workerPath));
const { default: previousWorker } = await import(pathToFileURL(path.join(previousArtifact, "worker/worker.mjs")));
const protocolPath = path.join(artifact, "site/ui/semantic-map/protocol/index.js");
const protocol = await import(pathToFileURL(protocolPath));
assert.equal(hash(fs.readFileSync(protocolPath)), hash(fs.readFileSync(path.join(previousArtifact, "site/ui/semantic-map/protocol/index.js"))));
const bundleBytes = fs.readFileSync(path.join(artifact, "site/data/bundle.v1.json")), stock = JSON.parse(bundleBytes).parts;
assert.equal(hash(bundleBytes), hash(fs.readFileSync(path.join(previousArtifact, "site/data/bundle.v1.json"))));
const semanticRoot = path.join(out, "semantic-map-root");
fs.mkdirSync(path.join(semanticRoot, "packages"), { recursive: true });
fs.symlinkSync(path.join(artifact, "site/ui/semantic-map"), path.join(semanticRoot, "packages/semantic-map"), "dir");
const prereg = path.join(root, "docs/voice-ui/quota-cycle-20261018/preregistered");
const inputs = Object.fromEntries(["R", "E"].map(axis => [axis, read(path.join(prereg, "quota-cycle-public-" + axis + "-1.v2.inputs.json"))]));
const env = { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only", ASSETS: { fetch: () => assert.fail("unexpected asset") } };
const upstream = [], stages = [], errors = [], api = [], summaries = [], wireEquality = [];
const savedFetch = globalThis.fetch, savedInfo = console.info;
let currentRequest = null, mode = "R", failure = false;
console.info = line => stages.push(JSON.parse(line));
const factors = confidence => ({ intent: { choice: "change", confidence }, labels: { choice: "missing", confidence: .9 },
  capacity: { choice: "within", confidence: .9 }, completeness: { choice: confidence < .5 ? "incomplete" : "complete", confidence: .9 } });
const slots = label => ({ required1: { label, kind: "decision", quantity: "1" },
  required2: { label: "", kind: "none", quantity: "0" }, required3: { label: "", kind: "none", quantity: "0" } });
const wantedLabel = () => mode === "R" ? inputs.R.cases[0].required[0].label
  : mode === "E" ? "棚卸承認" : "WireFixture";
const namedReply = (wire, answers) => Response.json({ model: "synthetic-quota-fixture", answers: Object.fromEntries(
  Object.entries(wire.questions).map(([name, question]) => {
    const { choice, confidence } = answers[name], keys = Object.keys(question.criteria);
    assert.ok(keys.includes(choice));
    return [name, { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? confidence : (1 - confidence) / (keys.length - 1)])) }];
  })) });
globalThis.fetch = async (url, init) => {
  assert.ok(currentRequest); assert.equal(init.method, "POST"); assert.equal(typeof init.body, "string");
  const provider = init.headers.authorization === "Bearer fixture-type-only" ? "typellm"
    : init.headers.authorization === "Bearer fixture-jev-only" ? "jev" : null;
  assert.ok(provider);
  assert.equal(String(url), provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.typellm.ai/v1/generate");
  const wire = JSON.parse(init.body);
  upstream.push({ mode, provider, route: String(url), method: init.method, content_type: init.headers["content-type"], body_utf8: init.body, wire });
  if (provider === "typellm") return Response.json({ status: "completed", result: slots(wantedLabel()) });
  if (wire.questions.intent) return namedReply(wire, factors(mode === "E" && !wire.state.required ? .49 : .9));
  const state = currentRequest.state;
  let choice = "none";
  if (mode === "R-edge") {
    if (!state.edges.some(e => e.from === "initial-api" && e.to === "initial-db"))
      choice = state.candidates.find(c => c.action === "add-edge" && c.from === "initial-api" && c.to === "initial-db")?.id ?? "none";
  } else if (mode !== "R-empty") {
    const label = wantedLabel(), hasWanted = state.graph.some(r => r.label === label);
    const wanted = !hasWanted ? state.offers.parts.find(p => p.label === label)
      : !state.graph.some(r => r.label === "判断") ? state.offers.parts.find(p => p.label === "判断") : null;
    if (wanted) choice = state.placing === null ? "part:" + wanted.key
      : state.candidates.find(c => c.part === wanted.key && c.parent === "container")?.id ?? "none";
  }
  return namedReply(wire, { delta: { choice, confidence: .9 } });
};
const headers = { "cache-control": "no-store", "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
const mime = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".md": "text/plain" }, site = path.join(artifact, "site");
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://127.0.0.1");
    if (!parsed.pathname.startsWith("/api/")) {
      if (parsed.pathname === "/hayamimi/sherpa/data.parts.json") { res.writeHead(204, headers); res.end(); return; }
      const file = path.resolve(site, parsed.pathname === "/" ? "index.html" : decodeURIComponent(parsed.pathname.slice(1)));
      assert.ok(file.startsWith(site + path.sep));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, headers); res.end(); return; }
      res.writeHead(200, { ...headers, "content-type": mime[path.extname(file)] ?? "application/octet-stream" });
      res.end(fs.readFileSync(file)); return;
    }
    const chunks = []; for await (const b of req) chunks.push(b);
    assert.equal(currentRequest, null); currentRequest = JSON.parse(Buffer.concat(chunks));
    try {
      const response = failure ? Response.json({ error: "synthetic_unavailable" }, { status: 503 })
        : await worker.fetch(new Request("http://localhost" + req.url,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(currentRequest) }), env);
      const text = await response.text(); api.push({ mode, route: req.url, status: response.status, response: JSON.parse(text) });
      res.writeHead(response.status, { ...headers, "content-type": "application/json" }); res.end(text);
    } finally { currentRequest = null; }
  } catch (e) { errors.push(String(e)); res.writeHead(500, headers); res.end("{}"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port, identityFile = path.join(out, "keyless-only.runtime.json");
fs.writeFileSync(identityFile, enc({ schema: "voice-ui.poc.runtime/1", origin, scope: "SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE",
  heads: { apps: manifests[0].value.sources.apps, ui: manifests[0].value.sources.ui, ops: "b4f611cac9e13fbef178469796cbc3b6d4a76b23",
    envs: "063e685b8b21a97fc8658879da93fa858552bcd6", windows: "6aef693c0946903d8b87c2348039de1420acd61b" },
  semantic_map: { root: semanticRoot, protocol_sha256: hash(fs.readFileSync(protocolPath)) },
  worker_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)) },
  provider_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)), scope: "bundled synthetic provider" },
  artifact: { root: artifact, manifest_sha256: hash(manifests[0].bytes) } }));
const run = async args => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exit, 0, stdout + stderr); return { stdout, stderr };
};
try {
  for (const stage of ["R", "E", "R-unknown", "E-unknown", "R-edge", "R-empty"]) {
    mode = stage.replace("-unknown", ""); failure = stage.endsWith("-unknown");
    const axis = mode.startsWith("R") ? "R" : "E", input = structuredClone(inputs[axis]);
    if (mode === "R-edge" || mode === "R-empty") {
      input.oracle_sha256 = "0".repeat(64);
      Object.assign(input.cases[0], { required: [], fixture: mode === "R-edge" ? "pair" : "empty",
        utterance: mode === "R-edge" ? "作業区にある API から DB に矢印を一つ追加。" : "現在の図を保持。" });
    }
    const inputFile = path.join(out, stage + ".inputs.json"), rawDir = path.join(out, stage), before = upstream.length;
    fs.writeFileSync(inputFile, enc(input));
    const child = await run([path.join(root, "packages/voice-ui/tests/quota-cycle-eval.mjs"),
      "--inputs", inputFile, "--origin", origin, "--semantic-map", semanticRoot,
      "--identities", identityFile, "--out", rawDir, "--artifact", artifact]);
    fs.writeFileSync(path.join(out, stage + ".stdout.log"), child.stdout);
    fs.writeFileSync(path.join(out, stage + ".stderr.log"), child.stderr);
    const execution = read(path.join(rawDir, "execution.json")), identity = read(path.join(rawDir, "identity.json"));
    assert.equal(execution.status, failure ? "INVALID" : "RECORDED"); assert.equal(execution.expected_cells, 2);
    assert.equal(execution.invalid_cells, failure ? 2 : 0);
    assert.deepEqual(Object.keys(identity.source_sha256).sort(), [...QUOTA_SOURCE_NAMES].sort());
    assert.deepEqual(identity.methods, QUOTA_METHODS); assert.deepEqual(identity.generation_policies, QUOTA_GENERATIONS);
    assert.deepEqual(identity.goal_parts_policies, QUOTA_GOAL_POLICIES);
    for (const arm of input.cases[0].arms) {
      const raw = read(path.join(rawDir, input.cases[0].id + "-" + arm + ".json"));
      assert.equal(raw.valid_execution, !failure); assert.equal(raw.method, QUOTA_METHODS[arm]);
      assert.equal(raw.goal_parts_policy, QUOTA_GOAL_POLICIES[arm]); assert.equal(raw.generation_policy, QUOTA_GENERATIONS[arm]);
      assert.equal(raw.lifecycle.persistence, "PASS"); assert.equal(raw.lifecycle.reloaded.log, raw.final_log);
      assert.ok(raw.frames.filter(f => f.assessment).length >= 2);
      assert.ok(raw.frames.filter(f => f.assessment).every(f => f.assessment.status === "PASS"));
      assert.deepEqual(raw.supplied_required, axis === "R" ? input.cases[0].required : null);
      if (failure) { assert.equal(raw.calls.length, 1); assert.equal(raw.calls[0].status, 503); assert.ok(raw.calls[0].error); assert.equal(raw.final_log, raw.initial_log); continue; }
      const added = raw.final_records.filter(r => r.type === "region" && !raw.initial_records.some(old => old.type === "region" && old.id === r.id));
      if (stage === "R") {
        assert.equal(added.length, arm === "O" ? 2 : 1);
        assert.ok(added.some(r => r.label === wantedLabel() && r.kind === "decision" && r.parent === "container"));
        const expected = arm === "O" ? input.cases[0].parts : input.cases[0].parts.filter(p => p.label === wantedLabel() && p.kind === "decision");
        assert.ok(raw.calls.every(c => JSON.stringify(c.request.state.offers.parts) === JSON.stringify(expected.map(({ key, purpose, label }) => ({ key, purpose, label })))));
        assert.equal(raw.lifecycle.scope, "NATIVE_SESSION_APPLY_RESTORE_NOT_BROWSER_GOAL");
        assert.equal(raw.lifecycle.browser_restore.scope, "KEYLESS_COMPLETED_UI_RESTORE_NOT_BROWSER_GOAL");
        assert.equal(raw.lifecycle.browser_restore.persistence, "PASS");
        assert.equal(raw.lifecycle.browser_restore.reloaded.log, raw.final_log);
      } else if (stage === "E") {
        assert.equal(added.length, arm === "C" ? 1 : 0);
        if (arm === "C") { assert.equal(added[0].label, wantedLabel()); assert.equal(added[0].kind, "decision"); }
        assert.ok(raw.calls.filter(c => c.route === "/api/judge").every(c => c.request.state.offers.parts.length === 1));
      } else if (stage === "R-edge") {
        assert.equal(added.length, 0); assert.ok(raw.final_records.some(r => r.type === "relation" && r.from === "initial-api" && r.to === "initial-db"));
        if (arm === "Q") assert.ok(raw.calls.every(c => c.request.state.offers.parts.length === 0));
      } else if (stage === "R-empty") {
        assert.equal(raw.final_log, raw.initial_log);
        if (arm === "Q") { assert.equal(raw.calls.length, 0); assert.equal(raw.result.reason, "no-executable-delta"); }
      }
    }
    const actual = upstream.slice(before);
    assert.equal(actual.filter(c => c.provider === "typellm").length, stage === "E" ? 1 : 0);
    if (failure) assert.equal(actual.length, 0);
    const replayDir = path.join(out, stage + "-replay");
    await run([path.join(root, "packages/voice-ui/acceptance/replay-candidates.mjs"), artifact, rawDir, replayDir]);
    const replay = read(path.join(replayDir, "receipt.json"));
    assert.equal(replay.status, "PASS"); assert.equal(replay.rows.length, 2);
    assert.deepEqual(replay.rows.map(r => r.arm).sort(), [...input.cases[0].arms].sort());
    summaries.push({ stage, cells: 2, invalid_retained: failure ? 2 : 0, actual_named_paint_restore: "PASS", recorded_replay: "PASS" });
  }
  failure = false;
  const fixture = inputs.E.fixture_contract, item = inputs.E.cases[0];
  const records = [...fixture.base_records, ...fixture.fixtures[item.fixture].extra_records];
  const inventory = { kind: "voice-ui.goal.inventory.v1", state: { utterance: item.utterance, head: "quota-wire-fixture",
    regions: records.filter(r => r.type === "region").map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
    edges: records.filter(r => r.type === "relation").map(({ id, from, to }) => ({ id, from, to })), parts: stock } };
  for (const axis of ["G0", "F", "V"]) {
    mode = "wire-" + axis;
    const body = axis === "V" ? { schema: "voice-ui.parts.verify/2", inventory, required: [{ label: "WireFixture", kind: "decision", quantity: 1 }] } : inventory;
    const route = axis === "G0" ? "/api/parts/check?method=literal-v2" : axis === "F" ? "/api/parts/requirements?generation=dependent" : "/api/parts/verify";
    const pair = [];
    for (const actualWorker of [previousWorker, worker]) {
      currentRequest = inventory;
      try {
        const before = upstream.length, response = await actualWorker.fetch(new Request("http://localhost" + route,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);
        assert.equal(response.status, 200); assert.equal(upstream.length - before, 1);
        pair.push({ capture: upstream.at(-1), response: await response.json() });
      } finally { currentRequest = null; }
    }
    assert.deepEqual(pair[1].capture, pair[0].capture);
    wireEquality.push({ axis, status: "UPSTREAM_BYTES_EQUAL", request_body_sha256: hash(pair[0].capture.body_utf8),
      original_captures: pair.map((p, i) => ({ apps_sha: manifests[1 - i].value.sources.apps, ...p })) });
  }
  assert.deepEqual(errors, []);
} finally { globalThis.fetch = savedFetch; console.info = savedInfo; await new Promise(resolve => server.close(resolve)); }
fs.writeFileSync(path.join(out, "receipt.json"), enc({ schema: "voice-ui.quota-cycle-keyless/1", status: "PASS",
  scope: "SYNTHETIC_MECHANICS_ONLY", external_provider_sends: { jev: 0, typellm: 0 },
  artifact_sources: manifests[0].value.sources, artifact_manifest_sha256: hash(manifests[0].bytes),
  previous_sources: manifests[1].value.sources, source_inventory: QUOTA_SOURCE_NAMES.length, summaries, wireEquality, upstream, api, stages }));
console.log(JSON.stringify({ status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", cells: summaries.reduce((n, s) => n + s.cells, 0), wire_pairs: wireEquality.length }));
