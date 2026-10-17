// Live comparison runner, never a node:test or a semantic success oracle.
// The independent reviewer supplies sealed fixtures/utterances and judges the resulting records separately.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBundle } from "../src/bundle.mjs";
import { runInventoryGoal } from "../src/completion.mjs";
import { createSession } from "../src/session.mjs";
import { DECISION_KIND } from "../src/contract.mjs";
import { literalCandidates } from "./literal-candidates.mjs";

const args = process.argv.slice(2), settings = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if (!["--inputs", "--origin", "--semantic-map", "--identities", "--out"].includes(key) || Object.hasOwn(settings, key) || !args[i + 1])
    throw new Error("evaluation_arguments");
  settings[key] = args[i + 1];
}
if (Object.keys(settings).length !== 5 || !/^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{3,4}$/.test(settings["--origin"]))
  throw new Error("evaluation_arguments");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = fs.readFileSync(settings["--inputs"]), inputs = JSON.parse(bytes);
const fixtures = inputs.fixture_contract, cases = inputs.cases, order = inputs.comparison?.case_order;
const threeMethods = inputs.schema === "voice-ui.poc.input-projection/2";
const methods = threeMethods ? ["A", "B", "C"] : ["A", "B"];
if (!fixtures || !Array.isArray(cases) || ![4, 8, 10].includes(cases.length) || !Array.isArray(order) || order.length !== cases.length
    || new Set(order).size !== cases.length || !order.every(id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
      && cases.filter(item => item.id === id).length === 1)
    || fixtures.scope !== null || !Array.isArray(fixtures.recent_conversation) || fixtures.recent_conversation.length)
  throw new Error("evaluation_input_shape");
const armOrder = (id, index) => {
  const raw = inputs.comparison.arm_order;
  const selected = Array.isArray(raw) && raw.length === methods.length && raw.every(x => methods.includes(x)) ? raw
    : Array.isArray(raw) ? raw[index] : raw?.[id];
  const arms = typeof selected === "string" ? [...selected] : selected;
  if (!Array.isArray(arms) || arms.length !== methods.length || new Set(arms).size !== methods.length || !arms.every(x => methods.includes(x)))
    throw new Error("evaluation_arm_order");
  return arms;
};
for (const [index, id] of order.entries()) armOrder(id, index);
const protocol = await import(pathToFileURL(path.join(settings["--semantic-map"], "packages/semantic-map/protocol/index.js")));
const root = fileURLToPath(new URL("../", import.meta.url));
const bundleBytes = fs.readFileSync(path.join(root, "web/data/bundle.v1.json"));
const bundle = readBundle(JSON.parse(bundleBytes));
if (bundle.parts?.length !== 8) throw new Error("evaluation_library");
const sourceFiles = ["src/completion.mjs", "src/goal.mjs", "src/turn.mjs", "src/contract.mjs", "src/judgment.mjs", "tests/paired-inventory-eval.mjs", "tests/literal-candidates.mjs"];
const sourceIdentity = JSON.parse(fs.readFileSync(settings["--identities"]));
const storePath = value => typeof value === "string" && /^\/nix\/store\/[a-z0-9]{32}-[^\s]+$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
if (sourceIdentity.schema !== "voice-ui.poc.runtime/1" || sourceIdentity.origin !== settings["--origin"]
    || !["apps", "ops", "windows", "envs"].every(repo => /^[a-f0-9]{40}$/.test(sourceIdentity.heads?.[repo] ?? ""))
    || !digest(sourceIdentity.sealed_inputs_sha256)
    || !["worker_entry", "provider_entry"].every(name => storePath(sourceIdentity[name]?.path)
      && digest(sourceIdentity[name]?.sha256) && hash(fs.readFileSync(sourceIdentity[name].path)) === sourceIdentity[name].sha256)
    || sourceIdentity.semantic_map?.root !== settings["--semantic-map"] || !storePath(settings["--semantic-map"])
    || !digest(sourceIdentity.semantic_map?.protocol_sha256)
    || hash(fs.readFileSync(path.join(settings["--semantic-map"], "packages/semantic-map/protocol/index.js"))) !== sourceIdentity.semantic_map.protocol_sha256
    || !storePath(sourceIdentity.launcher?.program) || !storePath(sourceIdentity.launcher?.dev_program)
    || !Number.isSafeInteger(sourceIdentity.launcher?.pid) || sourceIdentity.launcher.pid < 1
    || !/^[0-9]+$/.test(sourceIdentity.launcher?.start_ticks ?? "")
    || !/^[A-Za-z0-9_-]{1,64}$/.test(sourceIdentity.launcher?.phase_id ?? "")
    || !["jev", "typellm"].every(provider => Number.isInteger(sourceIdentity.launcher?.allowances?.[provider])
      && sourceIdentity.launcher.allowances[provider] >= 0 && sourceIdentity.launcher.allowances[provider] <= 300))
  throw new Error("evaluation_source_identity");
const identity = { schema: threeMethods ? "voice-ui.poc.candidate-panel/1" : "voice-ui.poc.paired/1", created: new Date().toISOString(), inputs_sha256: hash(bytes),
  source: sourceIdentity, bundle_sha256: hash(bundleBytes),
  source_sha256: Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
  origin: settings["--origin"], semantic_map: settings["--semantic-map"],
  evidence_scope: "exact semantic records and actual Worker HTTP; normal browser rendering/lifecycle is a separate evidence record",
};
fs.mkdirSync(settings["--out"], { mode: 0o700 });
const writeJson = (name, value) => {
  const fd = fs.openSync(path.join(settings["--out"], name), "wx", 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
writeJson("identity.json", identity);
const journal = fs.openSync(path.join(settings["--out"], "events.jsonl"), "wx", 0o600);
const record = item => { fs.writeSync(journal, JSON.stringify({ at: new Date().toISOString(), ...item }) + "\n"); fs.fsyncSync(journal); };
const summary = [];
// Only documented semantic/budget stops are performance evidence. Any proof,
// append, contract, stale, impossible cancellation or unknown reason is INVALID.
const validReasons = new Set(["inventory-not-confident", "inventory-ambiguous", "inventory-no-change", "inventory-unsupported", "completion-empty",
  "none", "not-confident", "no-executable-delta", "candidate-overflow", "budget-requests", "budget-time"]);
let invalid = false;
try {
  for (const [index, id] of order.entries()) {
    // Only these three case fields can reach graph construction or app/provider inputs. No oracle field is read.
    const input = cases.find(item => item.id === id);
    const { fixture: fixtureName, utterance } = input;
    const fixture = fixtures.fixtures?.[fixtureName];
    if (!fixture || typeof utterance !== "string") throw new Error("evaluation_fixture");
    const made = await protocol.createDecisionLog([...fixtures.base_records, ...fixture.extra_records], fixtures.map_id);
    const pinned = await protocol.createDecision(made.head, [{ type: "PinRegions", items: [...fixtures.base_pins, ...fixture.extra_pins] }], made.records);
    const graph = (await protocol.appendDecision(made.log, pinned.decision)).verified;
    for (const arm of armOrder(id, index)) {
      // Both arms start with the SAME exact graph/log bytes, not independently timestamped reconstructions.
      let session = createSession({ accepted: graph, stored: graph.log }), failed = false;
      const calls = [], started = performance.now();
      const preparation = [];
      const post = async (route, request) => {
        const n = calls.length + 1, callStarted = performance.now();
        const event = { id, arm, n, route, request };
        calls.push(event); record({ kind: "http-start", ...event });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), route === "/api/parts/complete" ? 40000 : 15000);
        try {
          const response = await fetch(settings["--origin"] + route, { method: "POST", redirect: "error",
            headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
          if (!response.ok) throw new Error("evaluation_http");
          const value = await response.json();
          Object.assign(event, { status: response.status, response: value, elapsedMs: performance.now() - callStarted });
          record({ kind: "http-end", id, arm, n, status: event.status, response: value, elapsedMs: event.elapsedMs });
          return value;
        } catch {
          failed = true; Object.assign(event, { error: "http_or_contract_unknown", elapsedMs: performance.now() - callStarted });
          record({ kind: "http-end", id, arm, n, error: event.error, elapsedMs: event.elapsedMs });
          throw new Error("evaluation_http");
        } finally { clearTimeout(timer); }
      };
      record({ kind: "arm-start", id, arm, head: graph.head, initial_log_sha256: hash(graph.log) });
      let result;
      try {
        result = await runInventoryGoal({ utterance, bundle, protocol, completion: arm !== "A", current: () => session,
          cancelled: () => false, check: request => post("/api/parts/check", request),
          complete: request => {
            if (!threeMethods || arm === "C") return post("/api/parts/complete", request);
            const value = literalCandidates(request.state);
            preparation.push(value); record({ kind: "literal-preparation", id, arm, value });
            return value;
          },
          ask: async request => {
            const decision = await post("/api/judge", request);
            if (decision?.kind !== DECISION_KIND) { failed = true; throw new Error("evaluation_decision"); }
            return { kind: "answered", decision };
          }, adopt: async next => { session = next; },
        });
      } catch { failed = true; result = { reason: "evaluation_operation_unknown" }; }
      if (!validReasons.has(result.reason)) failed = true;
      const output = { id, arm, fixture: fixtureName, utterance, valid_execution: !failed,
        elapsedMs: performance.now() - started, result, calls, preparation, initial_head: graph.head,
        initial_log_sha256: hash(graph.log), initial_records: graph.records, final_head: session.working.head,
        final_records: session.working.records, final_log: session.working.log };
      writeJson(id + "-" + arm + ".json", output);
      const row = { id, arm, valid_execution: !failed, reason: result.reason, httpCalls: calls.length, elapsedMs: output.elapsedMs };
      summary.push(row); record({ kind: "arm-end", ...row });
      if (failed) { invalid = true; break; }
    }
    if (invalid) break;
  }
} catch {
  invalid = true;
  record({ kind: "runner-failed", error: "fixture_protocol_or_evidence_unknown" });
} finally {
  if (summary.length !== order.length * methods.length) invalid = true;
  fs.closeSync(journal);
  writeJson("execution.json", { status: invalid ? "INVALID" : "RECORDED", summary });
  const directory = fs.openSync(settings["--out"], "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
console.log(JSON.stringify({ status: invalid ? "INVALID" : "RECORDED", out: settings["--out"], arms: summary.length }));
process.exitCode = invalid ? 1 : 0;
