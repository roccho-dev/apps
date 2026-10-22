// Completed-artifact frontier mechanics, stable G0/F and the registered V question change.
// All answers are synthetic; no external provider is contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoSecretInputs, loadAcceptanceArtifact, assertCompactVerifierWire } from "../tests/runtime-acceptance.mjs";
import { gradeInitialPolicy, readFrontierInspection, validRequirements, validFactors, decodeRequiredSlots, sameRequirements, verifierDecision } from "../tests/frontier-cycle-score.mjs";
import { FRONTIER_SOURCE_NAMES } from "../tests/frontier-cycle-audit.mjs";
import { historicalBundleControl } from "./historical-bundle-control.mjs";
import { amendBaselineG0Wire, G0_WIRE_AMENDMENT_SHA256 } from "./frontier-g0-wire-amendment.mjs";
assertNoSecretInputs();
const [artifact, out, baselineArtifact, ...comparisonArguments] = process.argv.slice(2);
assert.ok(process.argv.length === 5 || process.argv.length === 7);
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
assert.equal(manifests[1].value.sources.apps, "664c8a8d4598471327a8b330afd416b3f9eb86e0");
const comparisonBundle = historicalBundleControl(artifact, baselineArtifact, comparisonArguments);
const workerPath = path.join(artifact, "worker/worker.mjs");
const { default: worker } = await import(pathToFileURL(workerPath));
const { default: baselineWorker } = await import(pathToFileURL(path.join(baselineArtifact, "worker/worker.mjs")));
const protocolPath = path.join(artifact, "site/ui/semantic-map/protocol/index.js");
const protocol = await import(pathToFileURL(protocolPath));
assert.equal(hash(fs.readFileSync(protocolPath)), hash(fs.readFileSync(path.join(baselineArtifact, "site/ui/semantic-map/protocol/index.js"))));
const semanticRoot = path.join(out, "semantic-map-root");
fs.mkdirSync(path.join(semanticRoot, "packages"), { recursive: true });
fs.symlinkSync(path.join(artifact, "site/ui/semantic-map"), path.join(semanticRoot, "packages/semantic-map"), "dir");
const prereg = path.join(base, "docs/voice-ui/frontier-cycle-20261018/preregistered");
const publicInput = read(path.join(prereg, "frontier-cycle-public-G0-10.inputs.json"));
const publicOracle = read(path.join(prereg, "frontier-cycle-public-G0-10.oracle.json"));
const stock = JSON.parse(comparisonBundle.bytes).parts;
const fPart = stock.find(part => part.kind === "step"); assert.ok(fPart);
const env = { JEV_API_KEY: "fixture-jev-only", TYPELLM_API_KEY: "fixture-type-only",
  ASSETS: { fetch: () => assert.fail("unexpected asset") } };
const savedFetch = globalThis.fetch, savedInfo = console.info;
const upstream = [], stageRows = [], api = [], errors = [], summaries = [], wireEquality = [], receiptFaults = [];
let failure = false, mode = "G0", currentRequest = null, boundary = null, activeAbort = null, boundaryStarted = null;
console.info = line => stageRows.push(JSON.parse(line));
const namedReply = (wire, factors) => Response.json({ model: "synthetic-frontier-fixture",
  answers: Object.fromEntries(Object.entries(wire.questions).map(([name, question]) => {
    const { choice, confidence } = factors[name], keys = Object.keys(question.criteria);
    assert.ok(keys.includes(choice));
    return [name, { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? confidence : (1 - confidence) / (keys.length - 1)])) }];
  })) });
const factors = (intent = "change", confidence = .9, completeness = "complete", certainty = .9) => ({
  intent: { choice: intent, confidence }, labels: { choice: "missing", confidence: .9 },
  capacity: { choice: "within", confidence: .9 }, completeness: { choice: completeness, confidence: certainty },
});
const typedResult = (wire, rows) => Object.hasOwn(wire.questions, "required1_label")
  ? Object.fromEntries(Object.entries(rows).flatMap(([name, row]) => Object.entries(row).map(([key, value]) => [name + "_" + key, value]))) : rows;
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
  if (mode === "boundary") {
    const call = upstream.at(-1), started = boundaryStarted;
    call.start_elapsed_ms = performance.now() - started;
    init.signal.addEventListener("abort", () => { call.abort_elapsed_ms = performance.now() - started; }, { once: true });
    if (boundary.deadline === "provider-G0" || boundary.deadline === "shared" && provider === "typellm")
      return new Promise(() => {});
    // G0 finishes before Jev's 10s cap. The Type 35s cap would end at 42s,
    // so the unchanged app-wide 40s deadline must cancel it first.
    if (boundary.deadline === "shared") await new Promise(resolve => setTimeout(resolve, 7000));
    const verifying = provider === "jev" && Object.hasOwn(wire.state, "required");
    const point = provider === "typellm" ? "Type" : verifying ? "V" : "G0";
    if (boundary.fail === point + "-http") return Response.json({}, { status: 503 });
    if (boundary.abort_after === point) activeAbort.abort();
    if (provider === "typellm") return Response.json({ status: "completed", result: boundary.fail === "Type-contract" ? {} : typedResult(wire, {
      required1: { label: "FixtureNode", kind: "step", quantity: "1" },
      required2: { label: "", kind: "none", quantity: "0" }, required3: { label: "", kind: "none", quantity: "0" },
    }) });
    if (boundary.fail === point + "-contract") return Response.json({ model: "synthetic-frontier-fixture", answers: {} });
    return namedReply(wire, verifying ? boundary.verified ?? factors() : boundary.initial);
  }
  if (provider === "typellm") {
    assert.ok(mode === "F" || mode.startsWith("E"));
    return Response.json({ status: "completed", result: typedResult(wire, {
      required1: { label: mode === "F" ? fPart.label : "FixtureNode", kind: "step", quantity: "1" },
      required2: { label: "", kind: "none", quantity: "0" },
      required3: { label: "", kind: "none", quantity: "0" },
    }) });
  }
  if (wire.questions.completion) return namedReply(wire, { completion: { choice: "unknown", confidence: .9 } });
  if (!wire.questions.intent) {
    assert.ok(mode.startsWith("E"));
    const state = currentRequest.state, added = state.graph.some(r => r.label === "FixtureNode");
    const offered = state.offers.parts.find(p => p.label === "FixtureNode"); assert.ok(offered);
    const choice = added ? "none" : state.placing === null ? "part:" + offered.key
      : state.candidates.find(c => c.part === offered.key && c.parent === "container")?.id;
    assert.ok(Object.hasOwn(wire.questions.delta.criteria, choice));
    const keys = Object.keys(wire.questions.delta.criteria);
    return Response.json({ model: "synthetic-frontier-fixture", answers: { delta: { type: "choice", choice, confidence: .9,
      probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? .9 : .1 / (keys.length - 1)])) } } });
  }
  assert.ok(wire.questions.completeness);
  const oracle = mode === "G0" ? publicOracle.cases.find(o => o.utterance === currentRequest.state.utterance) : null;
  if (mode === "G0") assert.ok(oracle);
  if (mode.startsWith("E")) {
    if (wire.state.required) {
      if (mode === "E-invalid") return Response.json({ model: "synthetic-frontier-fixture", answers: {} });
      return namedReply(wire, factors("change", mode === "E-weak" ? .49 : .9, mode === "E-reject" ? "incomplete" : "complete"));
    }
    return namedReply(wire, factors(currentRequest.state.utterance.endsWith("PE01") ? "ambiguous" : "change", .49, "incomplete"));
  }
  return namedReply(wire, factors(oracle?.expected_intent ?? "change", .9, oracle?.expected_completeness ?? "complete"));
};
const headers = { "cache-control": "no-store", "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
const mime = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".md": "text/plain" }, site = path.join(artifact, "site");
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, "http://127.0.0.1");
    if (!parsed.pathname.startsWith("/api/")) {
      if (parsed.pathname === "/data/bundle.v1.json") {
        res.writeHead(200, { ...headers, "content-type": "application/json" }); res.end(comparisonBundle.bytes); return;
      }
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
      let text = await response.text();
      if (mode === "E-alias" && parsed.searchParams.get("method") === "adaptive-v3" && response.ok) {
        const original = JSON.parse(text), mutated = structuredClone(original);
        assert.equal(original.inspection.schema, "voice-ui.parts.inspection/3");
        mutated.inspection.schema = "voice-ui.parts.inspection/2";
        receiptFaults.push({ scope: "SYNTHETIC_HTTP_FAULT_INJECTION_ONLY", route: req.url, original, mutated });
        text = JSON.stringify(mutated);
      }
      res.writeHead(response.status, { ...headers, "content-type": "application/json" }); res.end(text);
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
const boundaryRows = [];
const direct = async (settings = {}) => {
  mode = "boundary";
  boundary = { initial: factors("ambiguous", .49, "incomplete"), ...settings };
  const before = upstream.length, stageBefore = stageRows.length, started = performance.now();
  boundaryStarted = started;
  const known = settings.known_sufficient ? publicInput.cases.find(item => item.id === "PG03") : null;
  const records = [...publicInput.fixture_contract.base_records, ...publicInput.fixture_contract.fixtures[known?.fixture ?? "empty"].extra_records];
  currentRequest = { kind: "voice-ui.goal.inventory.v1", state: { utterance: known?.utterance ?? 'OCIに「FixtureNode」という工程を追加して。',
    head: "synthetic-boundary", regions: records.filter(r => r.type === "region").map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
    edges: records.filter(r => r.type === "relation").map(({ id, from, to }) => ({ id, from, to })), parts: stock } };
  activeAbort = new AbortController();
  if (settings.already_aborted) activeAbort.abort();
  try {
    const response = await worker.fetch(new Request("http://localhost/api/parts/check",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(currentRequest), signal: activeAbort.signal }), env);
    const value = await response.json(), calls = upstream.slice(before), stages = stageRows.slice(stageBefore);
    const row = { settings, status: response.status, response: value, elapsedMs: performance.now() - started,
      synthetic_upstream_calls: calls, stages, request: currentRequest };
    boundaryRows.push(row);
    fs.writeFileSync(path.join(out, "boundary-" + String(boundaryRows.length).padStart(2, "0") + ".json"),
      JSON.stringify(row, null, 2) + "\n", { flag: "wx" });
    return row;
  } finally { currentRequest = null; boundary = null; activeAbort = null; boundaryStarted = null; }
};
try {
  for (const stage of ["G0", "G0-unknown"]) {
    mode = "G0"; failure = stage.endsWith("-unknown");
    const rawDir = path.join(out, stage), before = upstream.length;
    const child = spawn(process.execPath, [path.join(base, "packages/voice-ui/tests/frontier-cycle-eval.mjs"),
      "--inputs", path.join(prereg, "frontier-cycle-public-G0-10.inputs.json"), "--origin", origin, "--semantic-map", semanticRoot,
      "--identities", identityFile, "--out", rawDir, "--artifact", artifact], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(exit, 0, stdout + stderr);
    const execution = read(path.join(rawDir, "execution.json")), identity = read(path.join(rawDir, "identity.json"));
    assert.equal(execution.status, failure ? "INVALID" : "RECORDED"); assert.equal(execution.summary.length, 10);
    assert.equal(execution.invalid_cells, failure ? 10 : 0);
    assert.deepEqual(Object.keys(identity.source_sha256).sort(), [...FRONTIER_SOURCE_NAMES].sort());
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
        const grade = gradeInitialPolicy(raw.result, publicOracle.cases.find(o => o.id === item.id), raw.parts,
          { ...raw, typellm_sends: 0 });
        assert.equal(grade.contract_valid, true); assert.equal(grade.correct, true, item.id + JSON.stringify(grade));
      }
    }
    assert.equal(upstream.length - before, failure ? 0 : 10);
    assert.equal(upstream.slice(before).some(row => row.provider === "typellm"), false);
    summaries.push({ stage, cells: 10, invalid_retained: failure ? 10 : 0, status: "PASS" });
  }
  failure = false;
  for (const stage of ["E", "E-reject", "E-weak", "E-invalid", "E-alias"]) {
    mode = stage;
    const eInput = read(path.join(prereg, "frontier-cycle-public-E-2.inputs.json"));
    eInput.oracle_sha256 = "0".repeat(64);
    for (const item of eInput.cases) item.utterance = 'OCIに「FixtureNode」という工程を追加して。 ' + item.id;
    const eFile = path.join(out, stage + ".inputs.json"), eRaw = path.join(out, stage), eBefore = upstream.length;
    fs.writeFileSync(eFile, JSON.stringify(eInput));
    const eChild = spawn(process.execPath, [path.join(base, "packages/voice-ui/tests/frontier-cycle-eval.mjs"),
      "--inputs", eFile, "--origin", origin, "--semantic-map", semanticRoot,
      "--identities", identityFile, "--out", eRaw, "--artifact", artifact], { stdio: ["ignore", "pipe", "pipe"] });
    let eStdout = "", eStderr = "";
    eChild.stdout.on("data", b => { eStdout += b; }); eChild.stderr.on("data", b => { eStderr += b; });
    const eExit = await new Promise((resolve, reject) => { eChild.on("error", reject); eChild.on("close", resolve); });
    assert.equal(eExit, 0, eStdout + eStderr);
    const eExecution = read(path.join(eRaw, "execution.json"));
    const invalid = ["E-invalid", "E-alias"].includes(stage);
    assert.equal(eExecution.status, invalid ? "INVALID" : "RECORDED", JSON.stringify(eExecution));
    assert.equal(eExecution.summary.length, 4);
    assert.equal(eExecution.invalid_cells, invalid ? 2 : 0);
    for (const item of eInput.cases) for (const arm of item.arms) {
      const raw = read(path.join(eRaw, item.id + "-" + arm + ".json")), gained = stage === "E" && arm === "C";
      assert.equal(raw.method, arm === "B" ? "literal-v2" : "adaptive-v3");
      assert.equal(raw.generation_policy, arm === "B" ? null : "dependent");
      assert.equal(raw.valid_execution, !(invalid && arm === "C"));
      assert.equal(raw.lifecycle.persistence, "PASS");
      assert.equal(raw.final_records.filter(r => r.type === "region" && r.label === "FixtureNode").length, gained ? 1 : 0);
      assert.ok(raw.frames.filter(f => f.assessment).every(f => f.assessment.status === "PASS"));
      assert.equal(raw.result.inventory.completions, 0);
      assert.equal(raw.result.inventory.preparations, gained ? 1 : 0);
      if (!gained) {
        assert.equal(raw.final_log, raw.initial_log); assert.equal(raw.final_head, raw.initial_head);
        assert.deepEqual(raw.final_records, raw.initial_records);
      }
      const check = raw.calls.find(c => c.route === "/api/parts/check"); assert.ok(check);
      assert.equal(check.upstream_route, "/api/parts/check?method=" + raw.method);
      if (stage === "E-invalid" && arm === "C") {
        assert.equal(check.status, 502); assert.ok(check.error);
      } else if (stage === "E-alias" && arm === "C") {
        assert.equal(check.status, 200); assert.equal(raw.result.reason, "inventory-contract");
        assert.equal(readFrontierInspection(check.response.inspection, raw.utterance, raw.parts, raw.initial_records), null);
      } else {
        assert.equal(check.response.inspection.proposal === null, arm === "B");
        if (arm === "C") {
          const x = check.response.inspection;
          assert.equal(x.schema, "voice-ui.parts.inspection/3");
          assert.equal(x.initial.factors.intent.confidence, .49);
          assert.equal(x.initial.factors.intent.choice, item.id === "PE01" ? "ambiguous" : "change");
          assert.equal(x.initial.decision.choice, item.id === "PE01" ? "ambiguous" : "unknown");
          assert.deepEqual(x.proposal_policy, { id: "uncertainty-frontier-v1", eligible: true, reason: "uncertain-intent-incomplete" });
          assert.ok(readFrontierInspection(x, raw.utterance, raw.parts, raw.initial_records));
          const matching = stageRows.filter(r => r.request_id === x.request_id);
          assert.equal(matching.length, 4); assert.ok(matching.every(r => r.kind === "voice-ui.parts.stage.v3"));
          assert.deepEqual(matching.find(r => r.stage === "G0").proposal_policy, x.proposal_policy);
        }
      }
    }
    assert.equal(upstream.slice(eBefore).filter(row => row.provider === "typellm").length, 2);
    summaries.push({ stage, cells: 4, invalid_retained: invalid ? 2 : 0,
      paint_apply_reload: "PASS", unsafe_materializations: 0, weak_frontier_gains: stage === "E" ? 2 : 0, status: "PASS" });
  }
  const oldPrereg = path.join(base, "docs/voice-ui/dependency-cycle-20261018/preregistered");
  for (const axis of ["G0", "F", "V"]) {
    mode = axis;
    const sourceBytes = fs.readFileSync(axis === "G0" ? path.join(prereg, "frontier-cycle-public-G0-10.inputs.json")
      : path.join(oldPrereg, "dependency-cycle-public-" + axis + "6.inputs.json"));
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
      const route = axis === "G0" ? "/api/parts/check?method=literal-v2" : axis === "V" ? "/api/parts/verify"
        : "/api/parts/requirements?generation=dependent", pair = [];
      for (const actualWorker of [baselineWorker, worker]) {
        currentRequest = inventory;
        try {
          const before = upstream.length, response = await actualWorker.fetch(new Request("http://localhost" + route,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);
          assert.equal(response.status, 200); assert.equal(upstream.length - before, 1);
          pair.push({ wire: upstream.at(-1), response: await response.json() });
        } finally { currentRequest = null; }
      }
      if (axis === "V") assertCompactVerifierWire(pair[0].wire, pair[1].wire);
      else if (axis === "G0") assert.deepEqual(pair[1].wire, amendBaselineG0Wire(pair[0].wire),
        "completed G0 exact upstream bytes after the registered r12 amendment " + axis + "/" + item.id);
      else assert.deepEqual(pair[1].wire, pair[0].wire, "completed G0/F exact upstream bytes " + axis + "/" + item.id);
      if (axis === "G0") {
        for (const { response } of pair) {
          const grade = gradeInitialPolicy(response, publicOracle.cases.find(o => o.id === item.id), stock,
            { initial_records: graph.records, final_records: graph.records, initial_head: graph.head, final_head: graph.head,
              initial_log: "synthetic-wire-only\n", final_log: "synthetic-wire-only\n", typellm_sends: 0 });
          assert.equal(grade.contract_valid, true); assert.equal(grade.correct, true);
          assert.match(response.inspection.request_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
        }
        assert.notEqual(pair[0].response.inspection.request_id, pair[1].response.inspection.request_id);
        wireEquality.push({ axis, id: item.id, inputs_sha256: hash(sourceBytes), wire_sha256: hash(JSON.stringify(pair[0].wire)),
          request_body_sha256: hash(pair[0].wire.body_utf8), current_request_body_sha256: hash(pair[1].wire.body_utf8),
          amendment_sha256: G0_WIRE_AMENDMENT_SHA256, response_nonces: pair.map(p => p.response.inspection.request_id),
          original_captures: pair.map((p, i) => ({ apps_sha: manifests[1 - i].value.sources.apps, ...p })),
          response_comparison: "both original G0 HTTP contracts independently graded; no response equality or normalization claim",
          status: "UPSTREAM_BYTES_EQUAL_AFTER_REGISTERED_AMENDMENT" });
        continue;
      }
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
        wire_sha256: hash(JSON.stringify(pair[1].wire)), request_body_sha256: hash(pair[1].wire.body_utf8),
        previous_request_body_sha256: hash(pair[0].wire.body_utf8),
        original_captures: pair.map((p, i) => ({ apps_sha: manifests[1 - i].value.sources.apps, ...p })),
        response_nonces: pair.map(p => p.response.request_id), response_semantics_sha256: hash(JSON.stringify(semantics[0])),
        response_nonce_scope: "only top-level per-call request_id omitted from response semantic comparison",
        status: axis === "V" ? "REGISTERED_COMPLETENESS_QUESTION_ONLY" : "UPSTREAM_BYTES_EQUAL" });
    }
  }
  const gridStart = boundaryRows.length;
  for (const intent of ["change", "ambiguous", "no-change", "unsupported"]) {
    for (const confidence of [.49, .5, .9]) for (const completeness of ["complete", "incomplete"]) {
      for (const certainty of [.49, .5]) {
        const initial = factors(intent, confidence, completeness, certainty);
        const expected = completeness === "incomplete" && certainty >= .5 && (intent === "change" || intent === "ambiguous" && confidence < .5);
        const row = await direct({ initial });
        assert.equal(row.status, 200);
        assert.equal(row.response.inspection.schema, "voice-ui.parts.inspection/3");
        assert.equal(row.response.inspection.mode, "adaptive-v3", "ordinary no-query route defaults to v3");
        assert.deepEqual(row.response.inspection.initial.factors, initial);
        assert.deepEqual(row.response.inspection.proposal_policy, { id: "uncertainty-frontier-v1", eligible: expected,
          reason: !expected ? null : intent === "change" && confidence >= .5 ? "confident-change-incomplete" : "uncertain-intent-incomplete" });
        assert.equal(row.synthetic_upstream_calls.filter(r => r.provider === "typellm").length, expected ? 1 : 0);
        assert.equal(row.synthetic_upstream_calls.filter(r => r.provider === "jev").length, expected ? 2 : 1);
        assert.ok(row.stages.every(r => r.kind === "voice-ui.parts.stage.v3"));
        assert.deepEqual(row.stages.find(r => r.stage === "G0").proposal_policy, row.response.inspection.proposal_policy);
        assert.ok(readFrontierInspection(row.response.inspection, row.request.state.utterance, row.request.state.parts,
          row.request.state.regions.map(r => ({ type: "region", ...r }))));
      }
    }
  }
  const gridCells = boundaryRows.length - gridStart;
  assert.equal(gridCells, 48);
  assert.equal(receiptFaults.length, 2);
  const sufficient = await direct({ known_sufficient: true, initial: factors("change", .9, "complete") });
  assert.equal(sufficient.status, 200); assert.equal(sufficient.response.choice, "sufficient");
  assert.deepEqual(sufficient.response.inspection.missing, []);
  assert.equal(sufficient.response.inspection.proposal, null);
  assert.deepEqual(sufficient.synthetic_upstream_calls.map(row => row.provider), ["jev"]);
  for (const fail of ["G0-http", "G0-contract", "Type-http", "Type-contract", "V-http", "V-contract"]) {
    const row = await direct({ fail });
    assert.ok(row.status >= 500);
    assert.equal(row.synthetic_upstream_calls.filter(r => r.provider === "typellm").length, fail.startsWith("G0") ? 0 : 1);
    assert.equal(row.synthetic_upstream_calls.filter(r => r.provider === "jev").length, fail.startsWith("V") ? 2 : 1);
  }
  for (const settings of [{ already_aborted: true }, { abort_after: "G0" }, { abort_after: "Type" }]) {
    const row = await direct(settings); assert.equal(row.status, 504);
    assert.equal(row.synthetic_upstream_calls.filter(r => r.provider === "typellm").length, settings.abort_after === "Type" ? 1 : 0);
    assert.equal(row.synthetic_upstream_calls.filter(r => r.provider === "jev").length, settings.already_aborted ? 0 : 1);
  }
  const providerTimeout = await direct({ deadline: "provider-G0" });
  assert.equal(providerTimeout.status, 504); assert.deepEqual(providerTimeout.response, { error: "parts_timeout" });
  assert.ok(providerTimeout.elapsedMs >= 9000 && providerTimeout.elapsedMs < 15000);
  assert.deepEqual(providerTimeout.synthetic_upstream_calls.map(r => r.provider), ["jev"]);
  assert.ok(providerTimeout.synthetic_upstream_calls[0].abort_elapsed_ms >= 9000);
  assert.deepEqual(providerTimeout.stages, []);
  const timeout = await direct({ deadline: "shared" });
  assert.equal(timeout.status, 504); assert.ok(timeout.elapsedMs >= 39000 && timeout.elapsedMs < 45000);
  assert.deepEqual(timeout.response, { error: "parts_timeout" });
  assert.deepEqual(timeout.synthetic_upstream_calls.map(r => r.provider), ["jev", "typellm"]);
  assert.ok(timeout.synthetic_upstream_calls[1].start_elapsed_ms >= 6900
    && timeout.synthetic_upstream_calls[1].start_elapsed_ms < 10000);
  assert.ok(timeout.synthetic_upstream_calls[1].abort_elapsed_ms >= 39000
    && timeout.synthetic_upstream_calls[1].abort_elapsed_ms < 45000);
  assert.ok(timeout.synthetic_upstream_calls[1].abort_elapsed_ms - timeout.synthetic_upstream_calls[1].start_elapsed_ms < 34000,
    "shared deadline must cancel Type before its own 35s cap");
  assert.deepEqual(timeout.stages.map(r => r.stage), ["G0"]);
  summaries.push({ stage: "default-v3-boundary-grid", cells: gridCells, failed_contracts: 6, aborts: 3,
    actual_Jev_provider_deadline_ms: providerTimeout.elapsedMs, actual_shared_deadline_ms: timeout.elapsedMs,
    single_Type_and_V_maximum: "PASS", external_provider_sends: 0, status: "PASS" });
  assert.deepEqual(errors, []);
} finally {
  globalThis.fetch = savedFetch; console.info = savedInfo;
  await new Promise(resolve => server.close(resolve));
}
fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ schema: "voice-ui.frontier-cycle-keyless/1",
  status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", external_provider_sends: { jev: 0, typellm: 0 },
  comparison_bundle: comparisonBundle.proof,
  artifact_sources: manifests[0].value.sources, artifact_manifest_sha256: hash(manifests[0].bytes),
  baseline_completed_head: manifests[1].value.sources.apps, baseline_manifest_sha256: hash(manifests[1].bytes),
  source_inventory: FRONTIER_SOURCE_NAMES.length, summaries, api, wireEquality,
  wire_equality_scope: "G0/F raw equal; V exact three registered completeness scalars only; original captures retained; synthetic only",
  boundaryRows, receiptFaults, stageRows }, null, 2) + "\n");
console.log(JSON.stringify({ status: "PASS", scope: "SYNTHETIC_MECHANICS_ONLY", summaries, wire_pairs: wireEquality.length }));
