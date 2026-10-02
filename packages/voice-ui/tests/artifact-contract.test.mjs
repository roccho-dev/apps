import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTranscription } from "../web/adapters/transcription.mjs";
import { ARCHITECTURE_INTENT_KIND, DECISION_KIND, ERRORS, isRequest } from "../src/contract.mjs";
import { intentSectionOf } from "../src/architecture.mjs";

// One browser URL mapping, not a substitute implementation: import the exact
// authored adapter with its sole absolute application import resolved for Node.
const judgmentSource = await readFile(new URL("../web/adapters/judgment.mjs", import.meta.url), "utf8");
assert.equal(judgmentSource.split('"/app/src/contract.mjs"').length, 2);
const mapped = judgmentSource.replace('"/app/src/contract.mjs"', JSON.stringify(new URL("../src/contract.mjs", import.meta.url).href));
const { createJudgment } = await import("data:text/javascript;base64," + Buffer.from(mapped).toString("base64"));

const path = new URL("../artifact.jsonl", import.meta.url);

async function loadContract() {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, "artifact auth contract must contain exactly one record");
  return JSON.parse(lines[0]);
}

test("voice-ui artifact declares only its auth requirement", async () => {
  const value = await loadContract();

  assert.deepEqual(Object.keys(value).sort(), [
    "artifact",
    "kind",
    "requiredCapabilities",
  ]);
  assert.equal(value.kind, "artifact.auth.v1");
  assert.equal(value.artifact, "voice-ui");
  assert.deepEqual(value.requiredCapabilities, ["jev-api"]);
});

test("artifact auth capabilities are non-empty unique ids", async () => {
  const value = await loadContract();
  const capabilities = value.requiredCapabilities;

  assert.ok(Array.isArray(capabilities));
  assert.ok(capabilities.length > 0);
  assert.equal(new Set(capabilities).size, capabilities.length);
  for (const capability of capabilities) {
    assert.match(capability, /^[a-z0-9][a-z0-9-]*$/);
  }
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const recognizer = (start = async () => {}) => {
  const value = { onText: null, stops: 0, closes: 0, start,
    async stop() { value.stops += 1; }, close() { value.closes += 1; } };
  return value;
};
test("selected transcription binding owns normal completion and closed callback failure cleanup", async () => {
  for (const fails of [false, true]) {
    const owned = recognizer();
    const capture = createTranscription({ prepare: async () => {}, loadRecognizer: async () => owned });
    const pending = capture({ onListening: () => { if (fails) throw new Error("synthetic-private-body"); } });
    const outcome = fails ? assert.rejects(pending, { code: "transcription_failed" }) : pending;
    await flush();
    if (!fails) owned.onText("fixture words");
    assert.equal(await outcome, fails ? undefined : "fixture words");
    assert.equal(owned.stops, 1); assert.equal(owned.closes, 1); assert.equal(owned.onText, null);
  }
});
test("cancelled late start cannot clean up a subsequent attempt's recognizer", async () => {
  let release;
  const first = recognizer(() => new Promise(resolve => { release = resolve; }));
  const second = recognizer();
  const offered = [first, second];
  const capture = createTranscription({ prepare: async () => {}, loadRecognizer: async () => offered.shift() });
  const controller = new AbortController();
  const a = capture({ signal: controller.signal });
  const rejected = assert.rejects(a, { code: "transcription_cancelled" });
  await flush(); const stale = first.onText; controller.abort(); await rejected;
  const b = capture(); await flush(); const active = second.onText;
  release(); await flush(); stale("late text"); await flush();
  assert.equal(first.stops, 2); assert.equal(first.closes, 2);
  assert.equal(second.stops, 0); assert.equal(second.closes, 0); assert.equal(second.onText, active);
  second.onText("second words"); assert.equal(await b, "second words");
  assert.equal(second.stops, 1); assert.equal(second.closes, 1);
});
test("the 300 second transcription timeout closes owned resources and ignores late startup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const owned = recognizer(() => new Promise(resolve => { release = resolve; }));
  const capture = createTranscription({ prepare: async () => {}, loadRecognizer: async () => owned });
  const pending = capture(); const rejected = assert.rejects(pending, { code: "transcription_timeout" });
  await flush(); t.mock.timers.tick(299999); assert.equal(owned.stops, 0);
  t.mock.timers.tick(1); await rejected;
  release(); await flush(); assert.equal(owned.stops, 2); assert.equal(owned.closes, 2); assert.equal(owned.onText, null);
});
test("transcription stop errors remain closed while close is still called", async () => {
  for (const closeFails of [false, true]) {
    const owned = recognizer();
    if (closeFails) owned.close = async () => { owned.closes += 1; throw new Error("synthetic-private-body"); };
    else owned.stop = async () => { throw new Error("synthetic-private-body"); };
    const capture = createTranscription({ prepare: async () => {}, loadRecognizer: async () => owned });
    const pending = capture(); const rejected = assert.rejects(pending, { code: "transcription_stop_failed", message: "transcription_stop_failed" });
    await flush(); owned.onText("fixture"); await rejected; assert.equal(owned.closes, 1);
  }
});

test("HTTP judgment closes raw error/body/model surfaces without losing valid typed answers", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new Error("synthetic-private-body"); }, { kind: "failed", reason: "judge-failed", detail: "network_error" }],
    [async () => new Response(JSON.stringify({ error: "synthetic-private-body" }), { status: 502 }), { kind: "failed", reason: "judge-failed", detail: "http_error" }],
    [async () => new Response(JSON.stringify({ kind: DECISION_KIND, answers: {}, model: "synthetic-private-body" })), { kind: "failed", reason: "judge-contract", detail: null }],
    [async () => new Response(JSON.stringify({ kind: DECISION_KIND, answers: {} })), { kind: "answered", decision: { kind: DECISION_KIND, answers: {} } }],
  ]) {
    let calls = 0;
    const binding = createJudgment({ fetchImpl: (...args) => { calls += 1; assert.equal(args[0], "/api/judge"); return fetchImpl(...args); } });
    assert.deepEqual(await binding({}), expected); assert.equal(calls, 1);
  }
});
test("HTTP judgment bounds hung headers and body even when a fixture ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const body of [false, true]) {
    const hung = () => new Promise(() => {});
    let calls = 0, settled = false;
    const binding = createJudgment({ fetchImpl: () => { calls += 1; return body ? { ok: true, json: hung } : hung(); } });
    const pending = binding({}).then(value => { settled = true; return value; });
    await flush(); t.mock.timers.tick(14999); await flush(); assert.equal(settled, false);
    t.mock.timers.tick(1); assert.deepEqual(await pending, { kind: "failed", reason: "judge-timeout", detail: "15 s" });
    assert.equal(calls, 1);
  }
});

const withFormalServer = async (t, env, check) => {
  assert.ok(process.env.VOICE_UI_WORKER, "the actual produced Worker is required");
  const root = dirname(dirname(process.env.VOICE_UI_WORKER));
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.e2e.local_serve_entrypoint, "e2e/serve.mjs");
  // Exercise the exact shipped entry, but forbid all provider network calls in this control.
  const child = spawn(process.execPath, ["--input-type=module", "--eval",
    'globalThis.fetch = async () => { throw new Error("provider invocation forbidden"); }; await import(process.argv[1]);',
    join(root, manifest.e2e.local_serve_entrypoint), "--formal"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", PORT: "0", HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  try {
    const origin = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("formal server exited before readiness")));
      child.stdout.on("data", chunk => {
        output += chunk;
        const found = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
        if (found) resolve("http://127.0.0.1:" + found[1]);
      });
    });
    await check({ origin, root, manifest });
  } finally {
    child.kill();
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
  }
};

test("the supplied fixed formal server serves the same site and compiled auth gate", { timeout: 15000 }, async t => {
  await withFormalServer(t, {}, async ({ origin, root }) => {
    const staticResponse = await fetch(origin + "/app.mjs");
    assert.equal(staticResponse.status, 200);
    assert.deepEqual(Buffer.from(await staticResponse.arrayBuffer()), await readFile(join(root, "site/app.mjs")));
    const refused = await fetch(origin + "/api/judge", { method: "POST", body: "{" });
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: ERRORS.unavailable });
  });
});

test("formal architecture serves exact public bytes and binds private source before the provider", { timeout: 15000 }, async t => {
  await withFormalServer(t, { JEV_API_KEY: "test-only-value" }, async ({ origin, root, manifest }) => {
    assert.equal(manifest.e2e.architecture_entrypoint, "e2e/architecture-e2e.mjs");
    for (const [url, file] of [
      ["/architecture/", "site/index.html"],
      ["/architecture/data/config.v1.json", "site/architecture/data/config.v1.json"],
      ["/architecture/data/source.v1.json", "site/architecture/data/source.v1.json"],
    ]) {
      const response = await fetch(origin + url);
      assert.equal(response.status, 200, url);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(root, file)), url);
    }
    const source = JSON.parse(await readFile(join(root, "site/architecture/data/source.v1.json"), "utf8"));
    assert.equal(source.status, "available", "an exact committed artifact snapshot is required");
    assert.deepEqual(manifest.sources.architecture.source, source.source);
    assert.equal(source.source.commit, manifest.sources.apps);
    for (const url of ["/architecture/evidence.json", "/evidence.json", "/architecture/../architecture/evidence.json"]) {
      assert.equal((await fetch(origin + url)).status, 404, "private source is outside the public site");
    }
    const architecture = JSON.parse(JSON.stringify(intentSectionOf(source)));
    architecture.source.commit = "f".repeat(40);
    const body = { kind: ARCHITECTURE_INTENT_KIND, state: {
      utterance: "show this code", graph: { regions: [], edges: [], placeable: [] },
      draft: [], focus: null, pending: null, context: { recent: [] },
      offers: { parts: [], diagrams: [] }, architecture,
    } };
    assert.equal(isRequest(body), true, "a valid wire with another source identity");
    const refused = await fetch(origin + "/api/judge", { method: "POST", body: JSON.stringify(body) });
    assert.equal(refused.status, 422, "bound source rejects mismatch, not architecture-unavailable");
    assert.deepEqual(await refused.json(), { error: ERRORS.architectureMismatch });
  });
});
