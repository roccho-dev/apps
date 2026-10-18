// Live caller only. Inputs carry no success oracle; independent scoring is a later operation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBundle } from "../src/bundle.mjs";
import { createSession, apply } from "../src/session.mjs";
import { commitLog, restoreLog, COMMIT_COMMITTED, RESTORE_RESTORED, MAP_ID } from "../src/log.mjs";
import { runGoal } from "../src/goal.mjs";
import { quotaGoalBundle } from "../src/completion.mjs";
import { DECISION_KIND } from "../src/contract.mjs";
import { evaluationPost } from "./requirements-cycle-http.mjs";
import { observePaintedGoal, assessPaintedGoal, assessPaintedEdge } from "./painted-goal.mjs";
import { validateQuotaInput, quotaSchedule, QUOTA_METHODS, QUOTA_GENERATIONS, QUOTA_GOAL_POLICIES, quotaRepeatProfile } from "./quota-cycle-score.mjs";
import { QUOTA_SOURCE_NAMES } from "./quota-cycle-audit.mjs";

const settings = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--inputs", "--origin", "--semantic-map", "--identities", "--out", "--artifact"].includes(args[i])
    && !Object.hasOwn(settings, args[i]) && args[i + 1]);
  settings[args[i]] = args[i + 1];
}
assert.equal(Object.keys(settings).length, 6);
assert.match(settings["--origin"], /^http:\/\/127[.]0[.]0[.]1:[1-9][0-9]{3,4}$/u);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = fileURLToPath(new URL("../", import.meta.url)), inputBytes = fs.readFileSync(settings["--inputs"]);
const input = JSON.parse(inputBytes), axis = input.axis, fixtures = input.fixture_contract;
validateQuotaInput(input);
assert.equal(fixtures.map_id, MAP_ID, "registered fixture must satisfy the app's existing storage identity");
const schedule = quotaSchedule(input);
const methodFor = QUOTA_METHODS, policyFor = QUOTA_GENERATIONS, goalPolicyFor = QUOTA_GOAL_POLICIES;
assert.equal(input.schema, "voice-ui.quota-cycle-input/1");
assert.ok(["R", "E"].includes(axis) && /^[a-f0-9]{64}$/u.test(input.oracle_sha256));
assert.ok(Array.isArray(input.cases) && input.cases.length >= 1 && input.cases.length <= 10);
assert.equal(new Set(input.cases.map(item => item.id)).size, input.cases.length);
assert.equal(fixtures.scope, null); assert.deepEqual(fixtures.recent_conversation, []);
const bundleBytes = fs.readFileSync(path.join(root, "web/data/bundle.v1.json")), bundleValue = JSON.parse(bundleBytes), bundle = readBundle(bundleValue);
assert.equal(bundle.parts.length, 8);
for (const item of input.cases) {
  assert.match(item.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
  assert.deepEqual(Object.keys(item).sort(), (axis === "R" ? ["id", "fixture", "utterance", "parts", "required", "arms"] : ["id", "fixture", "utterance", "arms"]).sort());
  assert.ok(fixtures.fixtures[item.fixture] && typeof item.utterance === "string" && item.utterance.trim().length && item.utterance.length <= 8000);
  if (axis === "R") assert.deepEqual(readBundle({ ...bundleValue, parts: item.parts }).parts, item.parts);
}
const sourceBytes = fs.readFileSync(settings["--identities"]), source = JSON.parse(sourceBytes);
assert.equal(source.schema, "voice-ui.poc.runtime/1"); assert.equal(source.origin, settings["--origin"]);
for (const repo of ["apps", "ops", "envs", "windows", "ui"]) assert.match(source.heads[repo], /^[a-f0-9]{40}$/u);
assert.equal(source.semantic_map.root, settings["--semantic-map"]);
for (const name of ["worker_entry", "provider_entry"]) assert.equal(hash(fs.readFileSync(source[name].path)), source[name].sha256);
assert.equal(hash(fs.readFileSync(path.join(settings["--semantic-map"], "packages/semantic-map/protocol/index.js"))), source.semantic_map.protocol_sha256);
const artifact = JSON.parse(fs.readFileSync(path.join(settings["--artifact"], "manifest.json")));
assert.equal(artifact.sources.apps, source.heads.apps);
assert.equal(hash(fs.readFileSync(path.join(settings["--artifact"], "manifest.json"))), source.artifact.manifest_sha256);
assert.equal(hash(fs.readFileSync(path.join(settings["--artifact"], "worker/worker.mjs"))), source.worker_entry.sha256);
const repeat = quotaRepeatProfile(source.repeat_profile ?? null);
if (repeat) {
  assert.equal(axis, "E"); assert.equal(source.extraction_profile, repeat.extraction_profile);
  assert.equal(hash(fs.readFileSync(source.typed_provider_entry.path)), source.typed_provider_entry.sha256);
  assert.equal(source.typed_provider_entry.sha256, repeat.provider_sources.typellm.entry_sha256);
  for (const [name, pin] of Object.entries(repeat.provider_sources)) assert.deepEqual(artifact.sources[name + "-provider"], pin);
}
const protocol = await import(pathToFileURL(path.join(settings["--semantic-map"], "packages/semantic-map/protocol/index.js")));
const sourceNames = QUOTA_SOURCE_NAMES;
fs.mkdirSync(settings["--out"], { mode: 0o700 });
const write = (name, value) => { const fd = fs.openSync(path.join(settings["--out"], name), "wx", 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
write("identity.json", { schema: "voice-ui.quota-cycle-execution/1", axis, source, inputs_sha256: hash(inputBytes),
  bundle_sha256: hash(bundleBytes), source_sha256: Object.fromEntries(sourceNames.map(name => [name, hash(fs.readFileSync(path.join(root, name)))])),
  case_order: input.cases.map(item => item.id), arm_order: schedule.map(({ id, arm }) => ({ id, arm })),
  methods: methodFor, generation_policies: policyFor, goal_parts_policies: goalPolicyFor,
  oracle_policy: "hash for commitment only; no oracle is read or forwarded", replay_suffix: "compatibility only; scoring dispatches by axis" });
const journal = fs.openSync(path.join(settings["--out"], "events.jsonl"), "wx", 0o600);
const record = value => { fs.writeSync(journal, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n"); fs.fsyncSync(journal); };
const { chromium } = createRequire(import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, channel: "chromium" });
const summary = [];
try {
  for (const item of input.cases) {
    const fixture = fixtures.fixtures[item.fixture];
    const made = await protocol.createDecisionLog([...fixtures.base_records, ...fixture.extra_records], fixtures.map_id);
    const pin = await protocol.createDecision(made.head, [{ type: "PinRegions", items: [...fixtures.base_pins, ...fixture.extra_pins] }], made.records);
    const graph = (await protocol.appendDecision(made.log, pin.decision)).verified;
    for (const arm of item.arms) {
      const method = methodFor[arm], generation_policy = policyFor[arm], goal_parts_policy = goalPolicyFor[arm], calls = [], started = performance.now();
      let session = createSession({ accepted: graph, stored: graph.log }), result = null, valid = true, frames = [], lifecycle = null;
      const post = async (route, request) => {
        const event = { id: item.id, arm, n: calls.length + 1, route, request };
        calls.push(event); record({ kind: "http-start", axis, method, ...event });
        return evaluationPost({ url: settings["--origin"] + route, event, record });
      };
      record({ kind: "cell-start", axis, id: item.id, method, arm, generation_policy, goal_parts_policy, initial_head: graph.head, initial_log_sha256: hash(graph.log) });
      try {
        if (axis === "R") {
          const supplied = readBundle({ ...bundleValue, parts: item.parts });
          const goalBundle = arm === "O" ? supplied : quotaGoalBundle(supplied, item.required);
          assert.ok(goalBundle);
          result = await runGoal({ utterance: item.utterance, bundle: goalBundle, protocol,
            current: () => session, cancelled: () => false, adopt: async next => { session = next; },
            ask: async request => { const decision = await post("/api/judge", request);
              assert.equal(decision.kind, DECISION_KIND); return { kind: "answered", decision }; } });
          const snapshot = value => ({ log: value.working.log, records: value.working.records, stored: value.stored, goal: result });
          const target = snapshot(session), applyEnabled = session.draft.length > 0;
          let stored = graph.log;
          const applied = await apply(session, { commit: ({ graph: value, expected }) => commitLog({
            graph: value, expected, key: "quota-native-" + item.id + "-" + arm, read: async () => stored,
            write: async (_key, value) => { stored = value; }, lock: async (_key, action) => action(),
            verifyDecisionLog: protocol.verifyDecisionLog }) });
          if (applyEnabled) assert.equal(applied.result.status, COMMIT_COMMITTED);
          session = applied.session;
          const restored = await restoreLog({ key: "quota-native-" + item.id + "-" + arm, read: async () => stored,
            verifyDecisionLog: protocol.verifyDecisionLog });
          assert.equal(restored.status, RESTORE_RESTORED);
          const reloaded = createSession({ accepted: restored.graph, stored });
          assert.equal(reloaded.working.log, target.log); assert.deepEqual(reloaded.working.records, target.records);
          lifecycle = { target, applied: snapshot(session), reloaded: snapshot(reloaded), apply_enabled: applyEnabled,
            persistence: "PASS", scope: "NATIVE_SESSION_APPLY_RESTORE_NOT_BROWSER_GOAL" };
        }
        {
          const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
          const page = await context.newPage(), errors = [];
          page.on("pageerror", error => errors.push(String(error)));
          await context.route("**/*", route => new URL(route.request().url()).origin === settings["--origin"] ? route.continue() : route.abort());
          await page.route("**/api/**", async route => {
            const req = route.request(), parsed = new URL(req.url()), name = parsed.pathname + parsed.search;
            const upstream_route = name === "/api/parts/check" ? name + "?method=" + method : name;
            const event = { id: item.id, arm, n: calls.length + 1, route: name, upstream_route, request: req.postDataJSON() }, began = performance.now();
            calls.push(event); record({ kind: "http-start", axis, method, ...event });
            try {
              assert.equal(axis, "E", "native R paint/restore never calls model routes");
              assert.ok(["/api/judge", "/api/parts/check", "/api/parts/complete"].includes(name));
              const response = await route.fetch({ url: settings["--origin"] + upstream_route, maxRedirects: 0, maxRetries: 0, timeout: 45000 });
              const text = await response.text(); event.status = response.status(); event.response = JSON.parse(text);
              if (!response.ok()) { event.error = "http_or_contract_unknown"; valid = false; }
              await route.fulfill({ response, body: text });
            } catch { event.error = "http_or_contract_unknown"; valid = false; await route.abort(); }
            finally {
              event.status ??= null; event.elapsedMs = performance.now() - began;
              record({ kind: "http-end", id: item.id, arm, n: event.n, status: event.status,
                ...(Object.hasOwn(event, "response") ? { response: event.response } : {}), ...(event.error ? { error: event.error } : {}), elapsedMs: event.elapsedMs });
            }
          });
          try {
            const opened = axis === "R" ? session.working : graph;
            await page.addInitScript(log => { if (!localStorage.getItem("voice-ui.decision-log.v1"))
              localStorage.setItem("voice-ui.decision-log.v1", log); }, opened.log);
            const settle = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending"
              && document.querySelector("#goal-cancel").hidden, null, { timeout: 180000 });
            const snapshot = () => page.evaluate(() => {
              const runtime = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
              return { log: runtime?.log ?? null, records: runtime?.records ?? null, stored: localStorage.getItem("voice-ui.decision-log.v1"),
                goal: document.body.dataset.goal ? JSON.parse(document.body.dataset.goal) : null };
            });
            await page.goto(settings["--origin"]); await settle(); const before = await snapshot();
            assert.equal(before.log, opened.log); assert.deepEqual(before.records, opened.records);
            if (axis === "E") { await page.locator("#text").fill(item.utterance); await page.locator("#goal").click(); await settle(); }
            const target = await snapshot(), verified = await protocol.verifyDecisionLog(target.log);
            assert.deepEqual(target.records, verified.records);
            if (axis === "E") { result = target.goal; session = { working: verified }; }
            else { assert.equal(verified.log, session.working.log); assert.deepEqual(verified.records, session.working.records); }
            const regions = verified.records.filter(r => r.type === "region");
            frames.push({ camera: "overview", scope: "restore equality only; hidden children do not imply paint" });
            for (const container of regions.filter(r => r.kind === "group" && r.parent !== null)) {
              await page.locator("#camera-part").selectOption(container.id); await settle();
              const observation = await page.evaluate(observePaintedGoal, { container, records: regions.filter(r => r.parent === container.id), identity: true });
              frames.push({ camera: container.id, observation, assessment: assessPaintedGoal(observation) });
            }
            for (const edge of verified.records.filter(r => r.type === "relation")) {
              await page.locator("#camera-part").selectOption(edge.id); await settle();
              const observation = await page.evaluate(observePaintedGoal, { container: regions.find(r => r.kind === "group"),
                records: [edge.from, edge.to].map(id => regions.find(r => r.id === id)), edge, identity: true });
              frames.push({ camera: edge.id, observation, assessment: assessPaintedEdge(observation) });
            }
            assert.equal((await snapshot()).log, target.log);
            const applyEnabled = await page.locator("#apply").isEnabled();
            if (applyEnabled) { await page.locator("#apply").click(); await settle(); }
            const applied = await snapshot(); assert.equal(applied.stored, target.log);
            await page.reload(); await settle(); const reloaded = await snapshot();
            assert.equal(reloaded.log, target.log); assert.equal(reloaded.stored, target.log); assert.deepEqual(reloaded.records, target.records);
            if (axis === "E") lifecycle = { target, applied, reloaded, apply_enabled: applyEnabled, persistence: "PASS",
              undo: "separate completed-artifact keyless mechanics; no second live Goal" };
            else lifecycle = { ...lifecycle, browser_restore: { target, applied, reloaded, apply_enabled: applyEnabled,
              persistence: "PASS", scope: "KEYLESS_COMPLETED_UI_RESTORE_NOT_BROWSER_GOAL" } };
            assert.deepEqual(errors, []);
          } finally { await context.close(); }
        }
      } catch { valid = false; result ??= { reason: "evaluation-operation-unknown" }; }
      if (calls.some(call => call.error || call.status !== 200)) valid = false;
      if (![ "none", "not-confident", "no-executable-delta", "candidate-overflow", "budget-requests", "budget-time",
        "inventory-not-confident", "inventory-ambiguous", "inventory-no-change", "inventory-unsupported", "inventory-unresolved", "completion-empty"].includes(result?.reason)) valid = false;
      const raw = { schema: "voice-ui.quota-cycle-cell/1", axis, id: item.id, method, arm, generation_policy, goal_parts_policy, supplied_required: axis === "R" ? item.required : null, replay_suffix_scope: "compatibility only",
        fixture: item.fixture, utterance: item.utterance, parts: axis === "R" ? item.parts : bundle.parts, valid_execution: valid,
        elapsedMs: performance.now() - started, result, calls, initial_head: graph.head, initial_log: graph.log, initial_log_sha256: hash(graph.log),
        initial_records: graph.records, final_head: session.working.head, final_log: session.working.log, final_records: session.working.records,
        frames, lifecycle };
      write(item.id + "-" + arm + ".json", raw);
      summary.push({ axis, id: item.id, arm, method, generation_policy, goal_parts_policy, valid_execution: valid, calls: calls.length });
      record({ kind: "cell-end", ...summary.at(-1), final_head: raw.final_head });
    }
  }
} finally {
  if (browser) await browser.close(); fs.fsyncSync(journal); fs.closeSync(journal);
  write("execution.json", { schema: "voice-ui.quota-cycle-phase/1", axis,
    status: summary.length === schedule.length && summary.every(cell => cell.valid_execution)
      ? "RECORDED" : "INVALID", summary,
    invalid_cells: summary.filter(cell => !cell.valid_execution).length, expected_cells: schedule.length });
}
console.log(JSON.stringify({ axis, cells: summary.length, invalid: summary.filter(cell => !cell.valid_execution).length }));
