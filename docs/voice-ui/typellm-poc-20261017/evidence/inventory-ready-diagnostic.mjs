// Posthoc oracle-assisted library diagnosis; never a TypeLLM/main/fresh quality score.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = "/work/repos/voice-ui-typellm-20261016";
const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ["--preflight", "--run"].includes(mode));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = name => JSON.parse(fs.readFileSync(path.join(root, name)));
const fixtureBytes = fs.readFileSync(path.join(root, "inventory-ready-fixtures.json"));
assert.equal(hash(fixtureBytes), "2091b8180120d27a62098a94c98c536a3f5feed5b4a609353482abdc9b9b8b30");
const fixture = JSON.parse(fixtureBytes), build = read("runtime-build-e4a2.json");
assert.equal(fixture.schema, "voice-ui.poc.oracle-inventory-fixture/1");
assert.equal(fixture.source, "e4a2af1efe9278996391f0374d4546a51aa98736");
assert.equal(build.heads.apps, fixture.source);
assert.deepEqual(fixture.case_order, ["H06", "H08"]);
assert.equal(fixture.completion, false);
assert.equal(fixture.maximum_jev_per_case, 9); assert.equal(fixture.maximum_jev_total, 18);
assert.equal(fixture.maximum_typellm_total, 0);
for (const name of ["worker_entry", "provider_entry"])
  assert.equal(hash(fs.readFileSync(build[name].path)), build[name].sha256);
const packageRoot = build.source + "/packages/voice-ui";
const load = file => import(pathToFileURL(packageRoot + "/" + file));
const [{ readBundle }, { runInventoryGoal }, { createSession }, { DECISION_KIND }, protocol] = await Promise.all([
  load("src/bundle.mjs"), load("src/completion.mjs"), load("src/session.mjs"), load("src/contract.mjs"),
  import(pathToFileURL(build.semantic_map.root + "/packages/semantic-map/protocol/index.js")),
]);
const canonicalBytes = fs.readFileSync(packageRoot + "/web/data/bundle.v1.json");
const canonical = JSON.parse(canonicalBytes);
assert.equal(canonical.parts.length, 8);
const prepared = [];
for (const id of fixture.case_order) {
  const input = fixture.cases.find(item => item.id === id);
  const original = read("paired-main-e4a2/" + id + "-B.json");
  assert.equal(input.utterance, original.utterance); assert.equal(input.fixture, original.fixture);
  assert.equal(input.initial_head, original.initial_head);
  assert.equal(input.initial_log_sha256, original.initial_log_sha256);
  assert.equal(hash(input.initial_log), original.initial_log_sha256);
  assert.deepEqual(input.initial_records, original.initial_records);
  const graph = await protocol.verifyDecisionLog(input.initial_log);
  assert.equal(graph.head, input.initial_head); assert.equal(graph.log, input.initial_log);
  assert.deepEqual(graph.records, input.initial_records);
  assert.equal(input.slot_replacements.length, 3);
  assert.deepEqual(input.slot_replacements.map(p => p.key).sort(), ["data", "group", "step"]);
  const raw = structuredClone(canonical);
  for (const replacement of input.slot_replacements) {
    assert.deepEqual(Object.keys(replacement).sort(), ["key", "kind", "label", "purpose"]);
    assert.equal(replacement.purpose, "one " + replacement.kind + " part named " + replacement.label);
    const index = raw.parts.findIndex(p => p.key === replacement.key);
    assert.ok(index >= 0); raw.parts[index] = structuredClone(replacement);
  }
  const bundle = readBundle(raw);
  assert.equal(bundle.parts?.length, 8);
  assert.deepEqual(bundle.parts.filter(p => !["step", "data", "group"].includes(p.key)),
    canonical.parts.filter(p => !["step", "data", "group"].includes(p.key)));
  prepared.push({ input, graph, bundle });
}
const driverSha256 = hash(fs.readFileSync(fileURLToPath(import.meta.url)));
const preflight = { schema: "voice-ui.poc.inventory-ready-preflight/1", source: fixture.source,
  fixture_sha256: hash(fixtureBytes), driver_sha256: driverSha256, canonical_bundle_sha256: hash(canonicalBytes),
  case_order: fixture.case_order, completion: false, maximum_jev_total: 18, maximum_typellm_total: 0,
  same_initial_heads: prepared.map(p => ({ id: p.input.id, head: p.graph.head, log_sha256: hash(p.graph.log) })),
  provider_calls: 0, scope: fixture.scope };
if (mode === "--preflight") { console.log(JSON.stringify(preflight)); process.exit(0); }

const identity = read("poc-ready-8.identities.json");
assert.deepEqual(identity.heads, build.heads);
assert.equal(identity.launcher.phase_id, "poc-ready-8");
assert.deepEqual(identity.launcher.allowances, { jev: 18, typellm: 0 });
assert.deepEqual(identity.worker_entry, build.worker_entry);
assert.deepEqual(identity.provider_entry, build.provider_entry);
const out = path.join(root, "inventory-ready-e4a2");
fs.mkdirSync(out, { mode: 0o700 });
const write = (name, value) => {
  const fd = fs.openSync(path.join(out, name), "wx", 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
write("identity.json", { ...preflight, runtime: identity, created: new Date().toISOString() });
const journal = fs.openSync(path.join(out, "events.jsonl"), "wx", 0o600);
const record = event => { fs.writeSync(journal, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); fs.fsyncSync(journal); };
const validReasons = new Set(["none", "not-confident", "no-executable-delta", "candidate-overflow", "budget-requests", "budget-time",
  "inventory-not-confident", "inventory-ambiguous", "inventory-no-change", "inventory-unsupported"]);
const summary = [];
let invalid = false, total = 0;
try {
  for (const { input, graph, bundle } of prepared) {
    let session = createSession({ accepted: graph, stored: graph.log }), failed = false;
    const calls = [], started = performance.now();
    const post = async (route, request) => {
      assert.ok(["/api/parts/check", "/api/judge"].includes(route));
      assert.ok(calls.length < 9 && total < 18); total++;
      const event = { id: input.id, arm: "READY", n: calls.length + 1, route, request };
      calls.push(event); record({ kind: "http-start", ...event });
      try {
        const response = await fetch(identity.origin + route, { method: "POST", redirect: "error",
          headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("diagnostic_http");
        Object.assign(event, { status: response.status, response: await response.json() });
        record({ kind: "http-end", id: input.id, arm: "READY", n: event.n, status: event.status, response: event.response });
        return event.response;
      } catch {
        failed = true; event.error = "http_or_contract_unknown";
        record({ kind: "http-end", id: input.id, arm: "READY", n: event.n, error: event.error });
        throw new Error("diagnostic_http");
      }
    };
    record({ kind: "arm-start", id: input.id, arm: "READY", head: graph.head, initial_log_sha256: hash(graph.log) });
    let result;
    try {
      result = await runInventoryGoal({ utterance: input.utterance, bundle, protocol, completion: false,
        current: () => session, cancelled: () => false, check: request => post("/api/parts/check", request),
        complete: async () => { throw new Error("unexpected_completion"); },
        ask: async request => { const decision = await post("/api/judge", request);
          if (decision?.kind !== DECISION_KIND) { failed = true; throw new Error("diagnostic_decision"); }
          return { kind: "answered", decision }; }, adopt: async next => { session = next; } });
    } catch { failed = true; result = { reason: "diagnostic_operation_unknown" }; }
    if (!validReasons.has(result.reason)) failed = true;
    const output = { id: input.id, arm: "READY", utterance: input.utterance, fixture: input.fixture,
      condition: "oracle-assisted inventory-ready", completion: false, valid_execution: !failed,
      initial_head: graph.head, initial_log_sha256: hash(graph.log), initial_records: graph.records,
      library: bundle.parts, result, calls, elapsedMs: performance.now() - started,
      final_head: session.working.head, final_records: session.working.records, final_log: session.working.log };
    write(input.id + "-READY.json", output);
    const row = { id: input.id, arm: "READY", valid_execution: !failed, reason: result.reason, httpCalls: calls.length, elapsedMs: output.elapsedMs };
    summary.push(row); record({ kind: "arm-end", ...row });
    if (failed) { invalid = true; break; }
  }
} finally {
  fs.closeSync(journal); if (summary.length !== 2) invalid = true;
  write("execution.json", { status: invalid ? "INVALID" : "RECORDED", total_jev: total, typellm: 0, summary });
  const fd = fs.openSync(out, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
console.log(JSON.stringify({ status: invalid ? "INVALID" : "RECORDED", out, jev: total, typellm: 0 }));
process.exitCode = invalid ? 1 : 0;
