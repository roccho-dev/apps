import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";
import worker from "../functions/pages-worker.mjs";
import { architectureOf, readManifest } from "../src/architecture.mjs";
import { ACTION_ARCHITECTURE, DECISION_KIND, ERRORS, NONE, REQUEST_KIND, isRequest, slotsFor } from "../src/contract.mjs";

// A request as the page sends it: the declared read set and nothing more.
const request = (state = {}) => ({
  kind: REQUEST_KIND,
  state: {
    utterance: "add an edge from a to b",
    graph: {
      regions: [{ id: "node-a", label: "受付" }, { id: "node-b", label: "node-b" }],
      edges: [],
      placeable: [],
    },
    draft: [],
    focus: null,
    pending: null,
    context: { recent: [] },
    offers: {
      parts: [{ key: "step", purpose: "an ordinary step" }],
      diagrams: [{ key: "flow", purpose: "a flow between two roles" }],
    },
    ...state,
  },
});

const post = (body, env = { JEV_API_KEY: "test-only-value" }) => onRequestPost({
  request: new Request("http://localhost/api/jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }),
  env,
});

// The provider as the network presents it. Every call is counted, and nothing
// here can be mistaken for the real provider: its model is "jev-test".
const withProvider = async (respond, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return respond(calls.at(-1), init);
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
};
const answering = answersFor => async body => new Response(JSON.stringify({ model: "jev-test", answers: answersFor(body) }), { status: 200 });
const noneTo = body => Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [
  name,
  { type: "choice", choice: NONE, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, 0.1])) },
]));

test("every legacy or unknown request kind is 422 and never reaches the provider", async () => {
  const legacy = [
    { kind: "voice-ui.jev.request.v1", text: "hello" },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "b"] } },
    { kind: "voice-ui.jev.request.v7", state: request().state },
    { kind: "voice-ui.jev.request.v8", state: request().state },
    { kind: "voice-ui.jev.request.v9", state: request().state },
    { kind: "voice-ui.jev.request.v11", state: request().state },
    { ...request(), extra: 1 },
    {},
  ];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(legacy.map(body => post(body))));
  for (const response of result) {
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: ERRORS.invalidRequest });
  }
  assert.equal(calls.length, 0);
});

test("malformed parts of the one current request are refused before the provider", async () => {
  const bad = [
    { utterance: "  " },
    { graph: { regions: [{ id: NONE, label: "x" }], edges: [], placeable: [] } },
    { graph: { regions: [{ id: "a", label: "" }], edges: [], placeable: [] } },
    { graph: { regions: [{ id: "a", label: "a" }], edges: [{ id: "e", from: "a", to: "z" }], placeable: [] } },
    { graph: { regions: [{ id: "a", label: "a" }], edges: [], placeable: ["z"] } },
    { focus: { kind: "none", changes: [] } },
    { pending: { missing: "move", move: null, anchor: "node-a", direction: "left" } },
    { context: { recent: [{ seq: 1, source: "typed", text: "x".repeat(201), outcome: "no-change" }] } },
    { offers: { parts: [{ key: "none", purpose: "x" }], diagrams: [] } },
    { offers: { parts: [], diagrams: [{ key: "a", purpose: "x", label: "leaked" }] } },
    { draft: [{ changes: [{ change: "added", from: "a", to: "b" }], extra: 1 }] },
  ];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(bad.map(state => post(request(state)))));
  for (const [index, response] of result.entries()) assert.equal(response.status, 422, JSON.stringify(bad[index]));
  assert.equal(calls.length, 0);
});

test("the current request makes one provider call with exactly the offered questions", async () => {
  const body = request();
  assert.ok(isRequest(body));
  const { result, calls } = await withProvider(answering(noneTo), () => post(body));
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.model, "jev-latest");
  assert.deepEqual(call.state, body.state, "the state is forwarded as the named object it arrived as");
  const slots = slotsFor(body.state);
  assert.deepEqual(Object.keys(call.questions).sort(), Object.keys(slots).sort());
  for (const [name, question] of Object.entries(call.questions)) {
    assert.deepEqual(Object.keys(question.criteria), slots[name], name);
    assert.match(question.instructions, /unverified/u, `${name} is told the conversation is unverified`);
  }
  assert.match(call.questions.part.criteria.step, /an ordinary step/u, "a part's words come from the request's offers");
  assert.match(call.questions.diagram.criteria.flow, /a flow between two roles/u);
  assert.match(call.questions.source.criteria["node-a"], /受付/u, "a node is described by the label it is shown by");
  assert.equal(JSON.stringify(call).includes("bounds"), false);
});

test("a success is one kind carrying only choice and confidence per offered slot", async () => {
  const { result } = await withProvider(answering(noneTo), () => post(request()));
  const answer = await result.json();
  assert.equal(answer.kind, DECISION_KIND);
  assert.equal(answer.model, "jev-test");
  assert.deepEqual(Object.keys(answer).sort(), ["answers", "kind", "model"]);
  for (const value of Object.values(answer.answers)) {
    assert.deepEqual(Object.keys(value).sort(), ["choice", "confidence", "type"], "probabilities never leave the Function");
  }
});

test("every failure is one of a closed set of codes and carries no Jev content", async () => {
  const cases = [
    ["no credential", () => post(request(), {}), 503, ERRORS.unavailable],
    ["not JSON", () => post("{"), 400, ERRORS.invalidJson],
  ];
  for (const [label, run, status, code] of cases) {
    const response = await run();
    assert.equal(response.status, status, label);
    assert.deepEqual(await response.json(), { error: code }, label);
  }

  const providerCases = [
    ["provider refused", async () => new Response("denied", { status: 401 }), 502, ERRORS.providerError],
    ["provider unreachable", async () => { throw new TypeError("fetch failed"); }, 502, ERRORS.providerUnreachable],
    ["not JSON", async () => new Response("<html>", { status: 200 }), 502, ERRORS.providerContract],
    ["no model", async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }), 502, ERRORS.providerContract],
    ["a slot missing", answering(body => { const answers = noneTo(body); delete answers.action; return answers; }), 502, ERRORS.providerContract],
    ["an option not offered", answering(body => ({ ...noneTo(body), action: { type: "choice", choice: "delete-all", confidence: 0.9 } })), 502, ERRORS.providerContract],
    ["confidence outside [0,1]", answering(body => ({ ...noneTo(body), action: { type: "choice", choice: NONE, confidence: 2 } })), 502, ERRORS.providerContract],
    ["a probability for another key", answering(body => ({ ...noneTo(body), action: { type: "choice", choice: NONE, confidence: 0.9, probabilities: { other: 1 } } })), 502, ERRORS.providerContract],
  ];
  for (const [label, respond, status, code] of providerCases) {
    const { result } = await withProvider(respond, () => post(request()));
    assert.equal(result.status, status, label);
    assert.deepEqual(await result.json(), { error: code }, label);
  }
});

test("a provider that never answers is a timeout after ten seconds, never a hang", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { result } = await withProvider((body, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }), async () => {
    const pending = post(request());
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10000);
    return pending;
  });
  assert.equal(result.status, 504);
  assert.deepEqual(await result.json(), { error: ERRORS.providerTimeout });
});

test("the Advanced Mode Worker routes /api/jev to this Function and everything else to its assets", async () => {
  const unavailable = await worker.fetch(new Request("https://voice-ui.invalid/api/jev", { method: "POST", body: "{}" }), {});
  assert.equal(unavailable.status, 503);
  const wrongMethod = await worker.fetch(new Request("https://voice-ui.invalid/api/jev"), {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  let assets = 0;
  const asset = await worker.fetch(new Request("https://voice-ui.invalid/data/bundle.v1.json"), {
    ASSETS: { fetch: async () => { assets += 1; return new Response("{}"); } },
  });
  assert.equal(await asset.text(), "{}");
  assert.equal(assets, 1);
});

// The architecture page's requests, against this package's own source,
// prepared exactly as the build prepares it, into a scratch directory.
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepared = (() => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ui-api-"));
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", path.join(PACKAGE, "architecture/prepare.mjs"),
    "--scope", path.join(PACKAGE, "architecture/scope.v1.json"), "--root", PACKAGE,
    "--commit", "0123456789abcdef0123456789abcdef01234567", "--out", out,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const readOut = name => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
  return Object.freeze({ manifest: readOut("manifest.json"), evidence: readOut("evidence.json") });
})();
const ARCHITECTURE_ENV = Object.freeze({ JEV_API_KEY: "test-only-value", ARCHITECTURE: prepared });
const architectureRequest = (architecture = architectureOf(readManifest(prepared.manifest))) => request({ architecture });

test("an architecture request without this server's prepared source is refused before the provider", async () => {
  const unavailable = { schema: "voice-ui.architecture-source/1", status: "unavailable", reason: "no exact commit" };
  const cases = [
    ["no source bound", { JEV_API_KEY: "test-only-value" }],
    ["an unavailable source", { JEV_API_KEY: "test-only-value", ARCHITECTURE: { manifest: unavailable, evidence: prepared.evidence } }],
    ["evidence of another snapshot", { JEV_API_KEY: "test-only-value",
      ARCHITECTURE: { manifest: prepared.manifest, evidence: { ...prepared.evidence, source: { ...prepared.evidence.source, commit: "f".repeat(40) } } } }],
  ];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(cases.map(([, env]) => post(architectureRequest(), env))));
  for (const [index, response] of result.entries()) {
    assert.equal(response.status, 503, cases[index][0]);
    assert.deepEqual(await response.json(), { error: ERRORS.architectureUnavailable }, cases[index][0]);
  }
  assert.equal(calls.length, 0);
});

test("an architecture section that is not exactly this server's snapshot is refused before the provider", async () => {
  const own = architectureOf(readManifest(prepared.manifest));
  const altered = [
    { ...own, source: { ...own.source, commit: "f".repeat(40) } },
    { ...own, entities: own.entities.map((entity, index) => (index === 0 ? { ...entity, label: "renamed" } : entity)) },
    { ...own, candidates: own.candidates.slice(1) },
  ];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(altered.map(architecture => post(architectureRequest(architecture), ARCHITECTURE_ENV))));
  for (const response of result) {
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: ERRORS.architectureMismatch });
  }
  assert.equal(calls.length, 0);
});

test("the provider is asked with the admitted text and closed architecture questions, and none of the text comes back", async t => {
  const body = architectureRequest();
  assert.ok(isRequest(body));
  const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(result.status, 200);
  const [call] = calls;
  const slots = slotsFor(body.state);
  assert.deepEqual(Object.keys(call.questions).sort(), Object.keys(slots).sort());
  for (const [name, question] of Object.entries(call.questions)) assert.deepEqual(Object.keys(question.criteria), slots[name], name);
  assert.ok(slots.action.includes(ACTION_ARCHITECTURE));
  assert.match(call.questions["role-jev-function"].instructions, /Judge only from that text/u);
  assert.match(call.questions["relation-c-jev-function--jev-credential"].instructions, /cooccurrence:JEV_API_KEY/u);

  // The evidence is exactly the admitted files of the snapshot, added here.
  const admitted = prepared.manifest.entities.filter(entity => entity.kind === "file").map(entity => entity.id).sort();
  assert.deepEqual(Object.keys(call.state.architecture.evidence).sort(), admitted);
  for (const id of admitted) assert.equal(call.state.architecture.evidence[id], prepared.evidence.files[id]);
  const { evidence, facts, ...sent } = call.state.architecture;
  assert.deepEqual(sent, body.state.architecture, "the page's section is forwarded unchanged");
  assert.deepEqual(facts.map(fact => fact.pointer), prepared.manifest.facts.map(fact => fact.pointer));
  const answered = await result.text();
  assert.equal(answered.includes(prepared.evidence.files["jev-function"].slice(0, 200)), false, "no admitted text in the answer");

  // Measured, not assumed: what one architecture request sends the provider.
  t.diagnostic(`architecture provider request: ${Buffer.byteLength(JSON.stringify(call))} bytes, `
    + `${Object.keys(call.questions).length} questions, ${Object.keys(evidence).length} evidence files `
    + `(${Object.values(evidence).reduce((sum, value) => sum + Buffer.byteLength(value), 0)} bytes of text)`);
});
