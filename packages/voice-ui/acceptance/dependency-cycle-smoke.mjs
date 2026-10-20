// Keyless dependency-policy/driver mechanics against the completed Worker/UI.
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
const pub = path.join(base, "docs/voice-ui/dependency-cycle-20261018/preregistered");
const stock = read(path.join(artifact, "site/data/bundle.v1.json")).parts;
const name = "FixtureNode", utterance = 'OCIに「FixtureNode」という工程を追加して。';
const api = [], upstream = [], errors = [], stageRows = [], pairs = new Map();
let input = null, failure = false, currentStage = null, currentPolicy = null;
const stripped = value => !value || typeof value !== "object" ? value : Array.isArray(value) ? value.map(stripped)
  : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "depends_on").map(([key, child]) => [key, stripped(child)]));
const refCount = value => !value || typeof value !== "object" ? 0 : Object.entries(value).reduce((n, [key, child]) =>
  n + (key === "depends_on" ? child.length : refCount(child)), 0);
const savedFetch = globalThis.fetch;
const savedInfo = console.info;
console.info = line => stageRows.push(JSON.parse(line));
globalThis.fetch = async (url, init) => {
  assert.ok(input);
  const provider = init.headers.authorization === "Bearer fixture-type-only" ? "typellm"
    : init.headers.authorization === "Bearer fixture-jev-only" ? "jev" : null;
  assert.ok(provider);
  assert.equal(String(url), provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.typellm.ai/v1/generate");
  assert.equal(init.method, "POST");
  upstream.push({ provider, route: String(url), generation_policy: provider === "typellm" ? currentPolicy : null });
  if (provider === "typellm") {
    const wire = JSON.parse(init.body);
    const capacity = currentStage.startsWith("E") ? 16 : 3;
    assert.deepEqual(Object.keys(wire.questions), Array.from({ length: capacity }, (_, i) => "required" + (i + 1)));
    assert.ok(["independent", "dependent"].includes(currentPolicy));
    assert.equal(refCount(wire), currentPolicy === "dependent" ? capacity === 16 ? 168 : 12 : 0);
    assert.equal(wire.model, "typellm-latest"); assert.deepEqual(wire.options, { temperature: 0 });
    assert.equal(wire.timeout, 30);
    if (currentStage === "F") {
      const key = hash(wire.context), pair = pairs.get(key) ?? {};
      pair[currentPolicy] = wire; pairs.set(key, pair);
    }
    // Preserve the original semantic duplicate negative inside a complete
    // response shape. A truncated3-slot response to16 questions is rejected
    // by the transport before the TYPE_REQUIRED semantic audit can run.
    if (currentStage === "E-contract") return Response.json({ status: "completed", result:
      Object.fromEntries(Array.from({ length: capacity }, (_, i) => i + 1).map(n =>
        ["required" + n, n <= 2 ? { label: name, kind: "step", quantity: "1" }
          : { label: "", kind: "none", quantity: "0" }])) });
    return Response.json({ status: "completed", result: Object.fromEntries(Array.from({ length: capacity }, (_, i) => i + 1).map(n =>
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
      currentPolicy = parsed.pathname === "/api/parts/requirements" ? parsed.searchParams.get("generation") ?? "dependent"
        : parsed.pathname === "/api/parts/check" ? "dependent" : null;
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
    ops: "b4f611cac9e13fbef178469796cbc3b6d4a76b23", envs: "063e685b8b21a97fc8658879da93fa858552bcd6",
    windows: "6aef693c0946903d8b87c2348039de1420acd61b" },
  semantic_map: { root: semanticRoot, protocol_sha256: hash(fs.readFileSync(protocolPath)) },
  worker_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)) },
  provider_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)), scope: "bundled provider with synthetic fetch only" },
  artifact: { root: artifact, manifest_sha256: hash(manifestBytes) } }));
const summaries = [];
try {
  for (const stage of ["V", "F", "E", "E-complete", "E-control", "E-reject", "E-contract", "V-unknown", "F-unknown", "E-unknown"]) {
    const axis = stage[0]; currentStage = stage; failure = stage.endsWith("-unknown");
    const inputs = read(path.join(pub, "dependency-cycle-public-" + axis + (axis === "E" ? "2" : "6") + ".inputs.json"));
    inputs.oracle_sha256 = "0".repeat(64);
    for (const cell of inputs.cases) {
      cell.utterance = utterance + " " + cell.id;
      if (axis === "V") cell.required = [{ label: name, kind: "step", quantity: 1 }];
    }
    const inputFile = path.join(out, stage + ".inputs.json"), raw = path.join(out, stage);
    fs.writeFileSync(inputFile, JSON.stringify(inputs));
    const before = upstream.length;
    const child = spawn(process.execPath, [path.join(base, "packages/voice-ui/tests/dependency-cycle-eval.mjs"),
      "--inputs", inputFile, "--origin", origin, "--semantic-map", semanticRoot,
      "--identities", identityFile, "--out", raw, "--artifact", artifact], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, stderr + stdout);
    const execution = read(path.join(raw, "execution.json"));
    assert.equal(execution.status, failure || stage === "E-contract" ? "INVALID" : "RECORDED", JSON.stringify(execution));
    assert.equal(execution.summary.length, axis === "F" ? 12 : axis === "V" ? 6 : 4);
    assert.equal(execution.invalid_cells, failure ? execution.summary.length : stage === "E-contract" ? 2 : 0);
    for (const file of fs.readdirSync(raw).filter(n => /-[VIDBC][.]json$/u.test(n))) {
      const row = read(path.join(raw, file)); assert.equal(row.valid_execution, !failure && !(stage === "E-contract" && row.arm === "C"));
      assert.equal(row.generation_policy, ({ I: "independent", D: "dependent", V: null, B: null, C: "dependent" })[row.arm]);
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
      failure ? 0 : axis === "F" ? 12 : ["E", "E-reject", "E-contract"].includes(stage) ? 2 : 0);
    if (failure) assert.equal(actual.length, 0);
    summaries.push({ axis, stage, cells: execution.summary.length, synthetic_calls: actual.length,
      execution_status: execution.status, status: "PASS" });
  }
  assert.deepEqual(errors, []);
  assert.equal(pairs.size, 6);
  for (const pair of pairs.values()) { assert.ok(pair.independent && pair.dependent); assert.deepEqual(stripped(pair.dependent), pair.independent); }
  assert.ok(api.some(row => row.route === "/api/parts/requirements?generation=independent"));
  assert.ok(api.some(row => row.route === "/api/parts/requirements?generation=dependent"));
  assert.equal(api.some(row => row.route.startsWith("/api/parts/complete")), false);
  assert.ok(api.every(row => [200, 502, 503].includes(row.status)));
  for (const row of stageRows.filter(row => row.stage === "TYPE_REQUIRED")) assert.ok(["independent", "dependent"].includes(row.generation));
  assert.ok(stageRows.some(row => row.stage === "TYPE_REQUIRED" && !row.valid && row.generation === "dependent"));
  const beforeInvalid = upstream.length;
  for (const route of ["requirements?generation=repair", "requirements?generation=", "requirements?generation=dependent&generation=dependent",
    "requirements?method=adaptive-v2", "requirements?generation=dependent&extra=1", "check?generation=independent", "verify?generation=dependent"]) {
    const response = await worker.fetch(new Request("http://localhost/api/parts/" + route,
      { method: "POST", body: "{}" }), { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only" });
    assert.equal(response.status, 422);
  }
  assert.equal(upstream.length, beforeInvalid);
  const first = read(path.join(out, "F", "PF01-I.json"));
  input = first.calls[0].request; currentPolicy = "dependent"; currentStage = "default";
  const defaultResponse = await worker.fetch(new Request("http://localhost/api/parts/requirements", { method: "POST", body: JSON.stringify(input) }),
    { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only" });
  input = null; assert.equal(defaultResponse.status, 200);
  assert.equal(upstream.length, beforeInvalid + 1);
} finally { globalThis.fetch = savedFetch; console.info = savedInfo; await new Promise(resolve => server.close(resolve)); }
fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ schema: "voice-ui.dependency-cycle-keyless/1",
  scope: "SYNTHETIC_MECHANICS_ONLY", external_provider_sends: { jev: 0, typellm: 0 }, status: "PASS",
  artifact_sources: manifest.sources, artifact_manifest_sha256: hash(manifestBytes), summaries, api,
  paired_wire_equality: pairs.size, invalid_queries_without_send: 7, default_generation: "dependent", stageRows }, null, 2) + "\n");
console.log(JSON.stringify({ status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", axes: summaries }));


