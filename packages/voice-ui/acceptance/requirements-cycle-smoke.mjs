// Keyless mechanics of the conditional requirements producer against the completed Worker/UI.
// All upstream answers are synthetic. These receipts are never live evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoSecretInputs, loadAcceptanceArtifact } from "../tests/runtime-acceptance.mjs";
assertNoSecretInputs();
const [artifact, out] = process.argv.slice(2), base = fileURLToPath(new URL("../../../", import.meta.url));
assert.ok(path.isAbsolute(artifact) && path.isAbsolute(out));
fs.mkdirSync(out);
const hash = b => createHash("sha256").update(b).digest("hex"), read = p => JSON.parse(fs.readFileSync(p));
const manifestBytes = fs.readFileSync(path.join(artifact, "manifest.json")), manifest = JSON.parse(manifestBytes);
loadAcceptanceArtifact({ artifactRoot: artifact, expectedAppsSha: manifest.sources.apps, expectedManifestSha256: hash(manifestBytes) });
const workerPath = path.join(artifact, "worker/worker.mjs"), protocolPath = path.join(artifact, "site/ui/semantic-map/protocol/index.js");
const semanticRoot = path.join(out, "semantic-map-root");
fs.mkdirSync(path.join(semanticRoot, "packages"), { recursive: true });
fs.symlinkSync(path.join(artifact, "site/ui/semantic-map"), path.join(semanticRoot, "packages/semantic-map"), "dir");
const { default: worker } = await import(pathToFileURL(workerPath));
const pub = path.join(base, "docs/voice-ui/requirements-cycle-20261017/preregistered");
const contract = read(path.join(pub, "requirements-cycle-public-F6.inputs.json")).fixture_contract;
const stock = read(path.join(artifact, "site/data/bundle.v1.json")).parts;
const name = "FixtureNode", utterance = 'OCIに「FixtureNode」という工程を追加して。';
const api = [], upstream = [], errors = [];
let input = null, failure = false, currentStage = null;
const savedFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.ok(input);
  const provider = init.headers.authorization === "Bearer fixture-type-only" ? "typellm"
    : init.headers.authorization === "Bearer fixture-jev-only" ? "jev" : null;
  assert.ok(provider);
  assert.equal(String(url), provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.typellm.ai/v1/generate");
  assert.equal(init.method, "POST");
  upstream.push({ provider, route: String(url) });
  if (provider === "typellm") {
    if (currentStage === "E-contract") return Response.json({ status: "completed", result: { required1: { label: name, kind: "step", quantity: "1", parent: "container" } } });
    return Response.json({ status: "completed", result: Object.fromEntries([1, 2, 3].map(n =>
      ["required" + n, n === 1 ? { label: name, kind: "step", quantity: "1" } : { label: "", kind: "none", quantity: "0" }])) });
  }
  const wire = JSON.parse(init.body);
  let picks;
  if (wire.questions.intent) picks = { intent: currentStage === "E-control" ? "ambiguous" : "change", labels: "missing", capacity: "within",
    completeness: wire.state.required ? currentStage === "E-reject" ? "incomplete" : "complete"
      : currentStage === "E-complete" ? "complete" : "incomplete" };
  else if (wire.questions.completion) picks = { completion: "unknown" };
  else {
    const state = input.state, added = state.graph.some(r => r.label === name);
    const offered = state.offers.parts.find(p => p.label === name);
    assert.ok(offered);
    const choice = added ? "none" : state.placing === null ? "part:" + offered.key
      : state.candidates.find(c => c.part === offered.key && c.parent === "container")?.id;
    picks = { delta: choice };
  }
  return Response.json({ model: "synthetic-axis-fixture", answers: Object.fromEntries(Object.entries(wire.questions).map(([key, q]) => {
    const choice = picks[key], keys = Object.keys(q.criteria); assert.ok(keys.includes(choice));
    return [key, { type: "choice", choice, confidence: .9,
      probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? .9 : .1 / (keys.length - 1)])) }];
  })) });
};
const headers = { "cache-control": "no-store", "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
const mime = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".md": "text/plain" }, site = path.join(artifact, "site");
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://127.0.0.1");
    if (parsed.pathname.startsWith("/api/")) {
      assert.equal(input, null);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks); input = JSON.parse(body);
      try {
        const response = failure ? Response.json({ error: "synthetic_unavailable" }, { status: 503 }) : await worker.fetch(new Request("http://localhost" + req.url,
          { method: req.method, headers: { "content-type": "application/json" }, body }),
          { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only", ASSETS: { fetch: () => assert.fail("unexpected asset") } });
        const text = await response.text();
        api.push({ route: req.url, status: response.status, synthetic_failure: failure });
        res.writeHead(response.status, { ...headers, "content-type": "application/json" }); res.end(text);
      } finally { input = null; }
      return;
    }
    if (parsed.pathname === "/hayamimi/sherpa/data.parts.json") { res.writeHead(204, headers); res.end(); return; }
    const file = path.resolve(site, parsed.pathname === "/" ? "index.html" : decodeURIComponent(parsed.pathname.slice(1)));
    assert.ok(file.startsWith(site + path.sep));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, headers); res.end(); return; }
    res.writeHead(200, { ...headers, "content-type": mime[path.extname(file)] ?? "application/octet-stream" }); res.end(fs.readFileSync(file));
  } catch (e) { errors.push(String(e)); res.writeHead(500, headers); res.end("{}"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const identityFile = path.join(out, "keyless-only.runtime.json");
fs.writeFileSync(identityFile, JSON.stringify({ schema: "voice-ui.poc.runtime/1", origin,
  scope: "SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE", heads: { apps: manifest.sources.apps, ui: manifest.sources.ui,
    ops: "cab432ef717cbde9ebd0197ae006c0efe75269bf", envs: "063e685b8b21a97fc8658879da93fa858552bcd6",
    windows: "6aef693c0946903d8b87c2348039de1420acd61b" },
  semantic_map: { root: semanticRoot, protocol_sha256: hash(fs.readFileSync(protocolPath)) },
  worker_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)) },
  provider_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)), scope: "bundled provider with synthetic fetch only" },
  artifact: { root: artifact, manifest_sha256: hash(manifestBytes) } }));
const summaries = [];
try {
  for (const stage of ["V", "F", "E", "E-complete", "E-control", "E-reject", "E-contract", "V-unknown", "F-unknown", "E-unknown"]) {
    const axis = stage[0]; currentStage = stage; failure = stage.endsWith("-unknown");
    const cell = { id: "SYN-" + stage, fixture: "empty", utterance,
      ...(axis === "V" ? { required: [{ label: name, kind: "step", quantity: 1 }] } : {}) };
    const inputs = { schema: "voice-ui.requirements-cycle-input/1", axis, oracle_sha256: "0".repeat(64), fixture_contract: contract, cases: [cell] };
    const inputFile = path.join(out, stage + ".inputs.json"), raw = path.join(out, stage);
    fs.writeFileSync(inputFile, JSON.stringify(inputs));
    const before = upstream.length;
    const child = spawn(process.execPath, [path.join(base, "packages/voice-ui/tests/requirements-cycle-eval.mjs"),
      "--inputs", inputFile, "--origin", origin, "--semantic-map", semanticRoot,
      "--identities", identityFile, "--out", raw, "--artifact", artifact], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, stderr + stdout);
    const execution = read(path.join(raw, "execution.json"));
    assert.equal(execution.status, failure || stage === "E-contract" ? "INVALID" : "RECORDED", JSON.stringify(execution));
    assert.equal(execution.invalid_cells, failure ? execution.summary.length : stage === "E-contract" ? 1 : 0);
    for (const file of fs.readdirSync(raw).filter(n => /-[VFBC][.]json$/u.test(n))) {
      const row = read(path.join(raw, file)); assert.equal(row.valid_execution, !failure && !(stage === "E-contract" && row.arm === "C"));
      if (failure) {
        assert.equal(row.calls.length, 1); assert.equal(row.calls[0].status, 503);
        assert.ok(row.calls[0].error);
        assert.equal(row.final_log, row.initial_log);
        const events = fs.readFileSync(path.join(raw, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
          .filter(e => e.id === row.id && e.arm === row.arm);
        assert.equal(events.filter(e => e.kind === "http-start").length, 1);
        assert.equal(events.filter(e => e.kind === "http-end").length, 1);
        continue;
      }
      if (axis === "V") assert.equal(row.result.accepted, true);
      if (axis === "F") assert.deepEqual(row.result.required, [{ label: name, kind: "step", quantity: 1 }]);
      if (axis === "E") {
        const changed = stage === "E-complete" || stage === "E" && row.arm === "C";
        assert.equal(row.final_records.filter(r => r.type === "region" && r.label === name).length, changed ? 1 : 0);
        assert.equal(row.lifecycle.persistence, "PASS");
        assert.ok(row.frames.filter(f => f.assessment).every(f => f.assessment.status === "PASS"));
        assert.equal(row.result.inventory.completions, 0);
        assert.equal(row.result.inventory.preparations, changed ? 1 : 0);
        if (stage !== "E-contract" || row.arm !== "C") assert.equal(row.result.reason,
          changed ? "no-executable-delta" : stage === "E-control" ? "inventory-ambiguous" : "inventory-unresolved");
      }
    }
    const actual = upstream.slice(before);
    assert.equal(actual.filter(x => x.provider === "typellm").length,
      !failure && (axis === "F" || ["E", "E-reject", "E-contract"].includes(stage)) ? 1 : 0);
    if (failure) assert.equal(actual.length, 0);
    summaries.push({ axis, stage, cells: execution.summary.length, synthetic_calls: actual.length,
      execution_status: execution.status, status: "PASS" });
  }
  assert.deepEqual(errors, []);
  assert.ok(api.some(row => row.route === "/api/parts/requirements"));
  assert.equal(api.some(row => row.route.startsWith("/api/parts/complete")), false);
  assert.ok(api.every(row => [200, 502, 503].includes(row.status)));
} finally { globalThis.fetch = savedFetch; await new Promise(resolve => server.close(resolve)); }
fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ schema: "voice-ui.requirements-cycle-keyless/1",
  scope: "SYNTHETIC_MECHANICS_ONLY", external_provider_sends: { jev: 0, typellm: 0 }, status: "PASS",
  artifact_sources: manifest.sources, artifact_manifest_sha256: hash(manifestBytes), summaries, api }, null, 2) + "\n");
console.log(JSON.stringify({ status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", axes: summaries }));


