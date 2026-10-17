// Completed-artifact G0 caller mechanics and unchanged direct F/V wire checks.
// All answers are synthetic; no external provider is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoSecretInputs, loadAcceptanceArtifact } from "../tests/runtime-acceptance.mjs";
import { gradeInitialIntent, validRequirements, validFactors, decodeRequiredSlots, sameRequirements, verifierDecision } from "../tests/intent-cycle-score.mjs";
import { INTENT_SOURCE_NAMES } from "../tests/intent-cycle-audit.mjs";
assertNoSecretInputs();
const [artifact, out, baselineArtifact] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
for (const dir of [artifact, out, baselineArtifact]) assert.ok(path.isAbsolute(dir));
fs.mkdirSync(out);
const base = fileURLToPath(new URL("../../../", import.meta.url));
const hash = b => createHash("sha256").update(b).digest("hex");
const read = p => JSON.parse(fs.readFileSync(p));
const manifests = [artifact, baselineArtifact].map(dir => {
  const bytes = fs.readFileSync(path.join(dir, "manifest.json")), value = JSON.parse(bytes);
  loadAcceptanceArtifact({ artifactRoot: dir, expectedAppsSha: value.sources.apps, expectedManifestSha256: hash(bytes) });
  return { bytes, value };
});
assert.equal(manifests[1].value.sources.apps, "ae816ec23a5e4c397c8a4893e127fb24134afda8");
assert.equal(hash(fs.readFileSync(path.join(artifact, "site/data/bundle.v1.json"))),
  hash(fs.readFileSync(path.join(baselineArtifact, "site/data/bundle.v1.json"))));
const workerPath = path.join(artifact, "worker/worker.mjs");
const { default: worker } = await import(pathToFileURL(workerPath));
const { default: baselineWorker } = await import(pathToFileURL(path.join(baselineArtifact, "worker/worker.mjs")));
const protocolPath = path.join(artifact, "site/ui/semantic-map/protocol/index.js");
const protocol = await import(pathToFileURL(protocolPath));
assert.equal(hash(fs.readFileSync(protocolPath)), hash(fs.readFileSync(path.join(baselineArtifact, "site/ui/semantic-map/protocol/index.js"))));
const semanticRoot = path.join(out, "semantic-map-root");
fs.mkdirSync(path.join(semanticRoot, "packages"), { recursive: true });
fs.symlinkSync(path.join(artifact, "site/ui/semantic-map"), path.join(semanticRoot, "packages/semantic-map"), "dir");
const prereg = path.join(base, "docs/voice-ui/intent-cycle-20261018/preregistered");
const publicInput = read(path.join(prereg, "intent-cycle-public-G0-10.inputs.json"));
const publicOracle = read(path.join(prereg, "intent-cycle-public-G0-10.oracle.json"));
const stock = read(path.join(artifact, "site/data/bundle.v1.json")).parts;
const env = { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only",
  ASSETS: { fetch: () => assert.fail("unexpected asset") } };
const savedFetch = globalThis.fetch, savedInfo = console.info;
const upstream = [], stageRows = [], api = [], errors = [], summaries = [], wireEquality = [];
let failure = false, mode = "G0", currentRequest = null;
console.info = line => stageRows.push(JSON.parse(line));
globalThis.fetch = async (url, init) => {
  assert.ok(currentRequest);
  const provider = init.headers.authorization === "Bearer fixture-type-only" ? "typellm"
    : init.headers.authorization === "Bearer fixture-jev-only" ? "jev" : null;
  assert.ok(provider); assert.equal(init.method, "POST");
  assert.equal(String(url), provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.typellm.ai/v1/generate");
  assert.equal(typeof init.body, "string");
  const wire = JSON.parse(init.body);
  upstream.push({ mode, provider, route: String(url), method: init.method,
    content_type: init.headers["content-type"], body_utf8: init.body, wire });
  if (provider === "typellm") {
    assert.ok(["F", "E"].includes(mode));
    return Response.json({ status: "completed", result: {
      required1: { label: "FixtureNode", kind: "step", quantity: "1" },
      required2: { label: "", kind: "none", quantity: "0" },
      required3: { label: "", kind: "none", quantity: "0" },
    } });
  }
  if (!wire.questions.intent) {
    assert.equal(mode, "E");
    const state = currentRequest.state, added = state.graph.some(r => r.label === "FixtureNode");
    const offered = state.offers.parts.find(p => p.label === "FixtureNode"); assert.ok(offered);
    const choice = added ? "none" : state.placing === null ? "part:" + offered.key
      : state.candidates.find(c => c.part === offered.key && c.parent === "container")?.id;
    assert.ok(Object.hasOwn(wire.questions.delta.criteria, choice));
    const keys = Object.keys(wire.questions.delta.criteria);
    return Response.json({ model: "synthetic-intent-fixture", answers: { delta: { type: "choice", choice, confidence: .9,
      probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? .9 : .1 / (keys.length - 1)])) } } });
  }
  assert.ok(wire.questions.completeness);
  const oracle = mode === "G0" ? publicOracle.cases.find(o => o.utterance === currentRequest.state.utterance) : null;
  if (mode === "G0") assert.ok(oracle);
  const picks = { intent: oracle?.expected_intent ?? "change", labels: "missing", capacity: "within",
    completeness: mode === "E" ? wire.state.required ? "complete" : "incomplete" : oracle?.expected_completeness ?? "complete" };
  return Response.json({ model: "synthetic-intent-fixture", answers: Object.fromEntries(Object.entries(wire.questions).map(([key, q]) => {
    const choice = picks[key], keys = Object.keys(q.criteria);
    assert.ok(keys.includes(choice));
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
    if (!parsed.pathname.startsWith("/api/")) {
      if (parsed.pathname === "/hayamimi/sherpa/data.parts.json") { res.writeHead(204, headers); res.end(); return; }
      const file = path.resolve(site, parsed.pathname === "/" ? "index.html" : decodeURIComponent(parsed.pathname.slice(1)));
      assert.ok(file.startsWith(site + path.sep));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, headers); res.end(); return; }
      res.writeHead(200, { ...headers, "content-type": mime[path.extname(file)] ?? "application/octet-stream" });
      res.end(fs.readFileSync(file)); return;
    }
    assert.ok(["/api/parts/check", "/api/judge", "/api/parts/complete"].includes(parsed.pathname));
    assert.equal(currentRequest, null);
    const chunks = []; for await (const b of req) chunks.push(b);
    currentRequest = JSON.parse(Buffer.concat(chunks));
    try {
      const response = failure ? Response.json({ error: "synthetic_unavailable" }, { status: 503 })
        : await worker.fetch(new Request("http://localhost" + req.url,
          { method: req.method, headers: { "content-type": "application/json" }, body: JSON.stringify(currentRequest) }), env);
      api.push({ route: req.url, status: response.status, synthetic_failure: failure });
      res.writeHead(response.status, { ...headers, "content-type": "application/json" }); res.end(await response.text());
    } finally { currentRequest = null; }
  } catch (e) { errors.push(String(e)); res.writeHead(500, { "content-type": "application/json" }); res.end("{}"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const identityFile = path.join(out, "keyless-only.runtime.json");
fs.writeFileSync(identityFile, JSON.stringify({ schema: "voice-ui.poc.runtime/1", origin,
  scope: "SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE",
  heads: { apps: manifests[0].value.sources.apps, ui: manifests[0].value.sources.ui,
    ops: "b4f611cac9e13fbef178469796cbc3b6d4a76b23", envs: "063e685b8b21a97fc8658879da93fa858552bcd6",
    windows: "6aef693c0946903d8b87c2348039de1420acd61b" },
  semantic_map: { root: semanticRoot, protocol_sha256: hash(fs.readFileSync(protocolPath)) },
  worker_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)) },
  provider_entry: { path: workerPath, sha256: hash(fs.readFileSync(workerPath)), scope: "bundled synthetic provider" },
  artifact: { root: artifact, manifest_sha256: hash(manifests[0].bytes) } }));
try {
  for (const stage of ["G0", "G0-unknown"]) {
    mode = "G0"; failure = stage.endsWith("-unknown");
    const rawDir = path.join(out, stage), before = upstream.length;
    const child = spawn(process.execPath, [path.join(base, "packages/voice-ui/tests/intent-cycle-eval.mjs"),
      "--inputs", path.join(prereg, "intent-cycle-public-G0-10.inputs.json"), "--origin", origin, "--semantic-map", semanticRoot,
      "--identities", identityFile, "--out", rawDir, "--artifact", artifact], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(exit, 0, stdout + stderr);
    const execution = read(path.join(rawDir, "execution.json")), identity = read(path.join(rawDir, "identity.json"));
    assert.equal(execution.status, failure ? "INVALID" : "RECORDED"); assert.equal(execution.summary.length, 10);
    assert.equal(execution.invalid_cells, failure ? 10 : 0);
    assert.deepEqual(Object.keys(identity.source_sha256).sort(), [...INTENT_SOURCE_NAMES].sort());
    const events = fs.readFileSync(path.join(rawDir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    for (const item of publicInput.cases) {
      const raw = read(path.join(rawDir, item.id + "-G0.json")), calls = events.filter(e => e.id === item.id);
      assert.equal(raw.arm, "G0"); assert.equal(raw.method, "literal-v2"); assert.equal(raw.generation_policy, null);
      assert.equal(raw.valid_execution, !failure); assert.equal(raw.calls.length, 1);
      assert.equal(raw.calls[0].route, "/api/parts/check?method=literal-v2");
      assert.equal(raw.final_log, raw.initial_log); assert.equal(raw.final_head, raw.initial_head);
      assert.deepEqual(raw.final_records, raw.initial_records);
      assert.equal(calls.filter(e => e.kind === "http-start").length, 1);
      assert.equal(calls.filter(e => e.kind === "http-end").length, 1);
      if (failure) { assert.equal(raw.calls[0].status, 503); assert.ok(raw.calls[0].error); }
      else {
        const grade = gradeInitialIntent(raw.result, publicOracle.cases.find(o => o.id === item.id), raw.parts,
          { ...raw, typellm_sends: 0 });
        assert.equal(grade.contract_valid, true); assert.equal(grade.correct, true, item.id + JSON.stringify(grade));
      }
    }
    assert.equal(upstream.length - before, failure ? 0 : 10);
    assert.equal(upstream.slice(before).some(row => row.provider === "typellm"), false);
    summaries.push({ stage, cells: 10, invalid_retained: failure ? 10 : 0, status: "PASS" });
  }
  failure = false; mode = "E";
  const eInput = read(path.join(prereg, "intent-cycle-public-E-2.inputs.json"));
  eInput.oracle_sha256 = "0".repeat(64);
  for (const item of eInput.cases) item.utterance = 'OCIに「FixtureNode」という工程を追加して。 ' + item.id;
  const eFile = path.join(out, "E.inputs.json"), eRaw = path.join(out, "E"), eBefore = upstream.length;
  fs.writeFileSync(eFile, JSON.stringify(eInput));
  const eChild = spawn(process.execPath, [path.join(base, "packages/voice-ui/tests/intent-cycle-eval.mjs"),
    "--inputs", eFile, "--origin", origin, "--semantic-map", semanticRoot,
    "--identities", identityFile, "--out", eRaw, "--artifact", artifact], { stdio: ["ignore", "pipe", "pipe"] });
  let eStdout = "", eStderr = "";
  eChild.stdout.on("data", b => { eStdout += b; }); eChild.stderr.on("data", b => { eStderr += b; });
  const eExit = await new Promise((resolve, reject) => { eChild.on("error", reject); eChild.on("close", resolve); });
  assert.equal(eExit, 0, eStdout + eStderr);
  const eExecution = read(path.join(eRaw, "execution.json"));
  assert.equal(eExecution.status, "RECORDED", JSON.stringify(eExecution));
  assert.equal(eExecution.summary.length, 4); assert.equal(eExecution.invalid_cells, 0);
  for (const item of eInput.cases) for (const arm of item.arms) {
    const raw = read(path.join(eRaw, item.id + "-" + arm + ".json"));
    assert.equal(raw.method, arm === "B" ? "literal-v2" : "adaptive-v2");
    assert.equal(raw.generation_policy, arm === "B" ? null : "dependent");
    assert.equal(raw.valid_execution, true); assert.equal(raw.lifecycle.persistence, "PASS");
    assert.equal(raw.final_records.filter(r => r.type === "region" && r.label === "FixtureNode").length, arm === "C" ? 1 : 0);
    assert.ok(raw.frames.filter(f => f.assessment).every(f => f.assessment.status === "PASS"));
    assert.equal(raw.result.reason, arm === "C" ? "no-executable-delta" : "inventory-unresolved");
    assert.equal(raw.result.inventory.completions, 0); assert.equal(raw.result.inventory.preparations, arm === "C" ? 1 : 0);
    const check = raw.calls.find(c => c.route === "/api/parts/check"); assert.ok(check);
    assert.equal(check.upstream_route, "/api/parts/check?method=" + raw.method);
    assert.equal(check.response.inspection.proposal === null, arm === "B");
  }
  assert.equal(upstream.slice(eBefore).filter(row => row.provider === "typellm").length, 2);
  summaries.push({ stage: "E", cells: 4, invalid_retained: 0, paint_apply_reload: "PASS", status: "PASS" });
  const oldPrereg = path.join(base, "docs/voice-ui/dependency-cycle-20261018/preregistered");
  for (const axis of ["F", "V"]) {
    mode = axis;
    const sourceBytes = fs.readFileSync(path.join(oldPrereg, "dependency-cycle-public-" + axis + "6.inputs.json"));
    const inputs = JSON.parse(sourceBytes), fixture = inputs.fixture_contract;
    for (const item of inputs.cases) {
      const f = fixture.fixtures[item.fixture];
      const made = await protocol.createDecisionLog([...fixture.base_records, ...f.extra_records], fixture.map_id);
      const pin = await protocol.createDecision(made.head, [{ type: "PinRegions", items: [...fixture.base_pins, ...f.extra_pins] }], made.records);
      const graph = (await protocol.appendDecision(made.log, pin.decision)).verified;
      const inventory = { kind: "voice-ui.goal.inventory.v1", state: { utterance: item.utterance, head: graph.head,
        regions: graph.records.filter(r => r.type === "region").map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
        edges: graph.records.filter(r => r.type === "relation").map(({ id, from, to }) => ({ id, from, to })), parts: stock } };
      const body = axis === "V" ? { schema: "voice-ui.parts.verify/2", inventory, required: item.required } : inventory;
      const route = axis === "V" ? "/api/parts/verify" : "/api/parts/requirements?generation=dependent", pair = [];
      for (const actualWorker of [baselineWorker, worker]) {
        currentRequest = inventory;
        try {
          const before = upstream.length, response = await actualWorker.fetch(new Request("http://localhost" + route,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);
          assert.equal(response.status, 200); assert.equal(upstream.length - before, 1);
          pair.push({ wire: upstream.at(-1), response: await response.json() });
        } finally { currentRequest = null; }
      }
      assert.deepEqual(pair[1].wire, pair[0].wire, "completed F/V exact upstream bytes " + axis + "/" + item.id);
      const semantics = pair.map(({ response }) => {
        const { request_id, ...value } = response;
        assert.match(request_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
        assert.deepEqual(Object.keys(response).sort(), (axis === "F" ? ["schema", "request_id", "slots", "required"]
          : ["schema", "request_id", "required", "factors", "accepted", "confidence"]).sort());
        assert.ok(validRequirements(value.required));
        if (axis === "F") { assert.equal(value.schema, "voice-ui.parts.requirements/2");
          assert.ok(sameRequirements(decodeRequiredSlots(value.slots), value.required)); }
        else { assert.equal(value.schema, "voice-ui.parts.verification/2"); assert.ok(validFactors(value.factors));
          assert.equal(value.accepted, verifierDecision(value.factors).accepted); }
        return value;
      });
      assert.notEqual(pair[0].response.request_id, pair[1].response.request_id);
      assert.deepEqual(semantics[1], semantics[0], "only declared response nonce differs");
      wireEquality.push({ axis, id: item.id, inputs_sha256: hash(sourceBytes),
        wire_sha256: hash(JSON.stringify(pair[0].wire)), request_body_sha256: hash(pair[0].wire.body_utf8),
        response_nonces: pair.map(p => p.response.request_id), response_semantics_sha256: hash(JSON.stringify(semantics[0])),
        response_nonce_scope: "only top-level per-call request_id omitted from response semantic comparison",
        status: "UPSTREAM_BYTES_EQUAL" });
    }
  }
  assert.deepEqual(errors, []);
} finally {
  globalThis.fetch = savedFetch; console.info = savedInfo;
  await new Promise(resolve => server.close(resolve));
}
fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ schema: "voice-ui.intent-cycle-keyless/1",
  status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", external_provider_sends: { jev: 0, typellm: 0 },
  artifact_sources: manifests[0].value.sources, artifact_manifest_sha256: hash(manifests[0].bytes),
  carried_observation_head: manifests[1].value.sources.apps, baseline_manifest_sha256: hash(manifests[1].bytes),
  source_inventory: INTENT_SOURCE_NAMES.length, summaries, api, wireEquality,
  wire_equality_scope: "completed Worker under identical public input and synthetic provider; no new real F/V measurement",
  stageRows }, null, 2) + "\n");
console.log(JSON.stringify({ status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", summaries, wire_pairs: wireEquality.length }));
