import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost } from "../functions/api/judge.mjs";
if (!process.env.JUDGE_PROVIDER_ENTRY || !process.env.VOICE_UI_WORKER) throw new Error("actual provider and produced Worker entries are required");
const { bindJev, judgeNamedChoices } = await import(process.env.JUDGE_PROVIDER_ENTRY);
const { default: worker } = await import(process.env.VOICE_UI_WORKER);
const judgeFor = provider => (request, { signal }) => judgeNamedChoices({ request, provider, signal });
import { DECISION_KIND, ERRORS, NONE, REQUEST_KIND, isRequest, slotsFor } from "../src/contract.mjs";

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

const post = (body, env = { JEV_API_KEY: "test-only-value" }) => worker.fetch(new Request("http://localhost/api/judge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env);

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
    { kind: "voice-ui.jev.request.v10", state: request().state },
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
  assert.equal("model" in answer, false);
  assert.deepEqual(Object.keys(answer).sort(), ["answers", "kind"]);
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
    ["model is not a string", async () => new Response(JSON.stringify({ model: 1, answers: {} }), { status: 200 }), 502, ERRORS.providerContract],
    ["unknown answer field", answering(body => ({ ...noneTo(body), action: { ...noneTo(body).action, privateField: "synthetic-canary" } })), 502, ERRORS.providerContract],
    ["extra answered slot", answering(body => ({ ...noneTo(body), unknown: { type: "choice", choice: NONE, confidence: 0.9 } })), 502, ERRORS.providerContract],
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

test("the compiled binding has one ten second deadline for headers and body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["headers", "body"]) {
    const hung = () => new Promise(() => {});
    const { result, calls } = await withProvider(() => phase === "headers" ? hung() : { ok: true, json: hung }, async () => {
      let settled = false;
      const pending = post(request()).then(value => { settled = true; return value; });
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(9999); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
      t.mock.timers.tick(1); return pending;
    });
    assert.equal(result.status, 504); assert.equal(calls.length, 1);
    assert.deepEqual(await result.json(), { error: ERRORS.providerTimeout });
  }
});
test("the compiled binding forwards pre-aborted and active cancellation", async () => {
  for (const active of [false, true]) {
    const controller = new AbortController(); if (!active) controller.abort();
    const { result, calls } = await withProvider(() => ({ ok: true, json: () => new Promise(() => {}) }), async () => {
      const pending = worker.fetch(new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(request()), signal: controller.signal }), { JEV_API_KEY: "fixture" });
      await new Promise(resolve => setImmediate(resolve)); if (active) controller.abort(); return pending;
    });
    assert.equal(result.status, 502); assert.equal(calls.length, active ? 1 : 0);
    assert.deepEqual(await result.json(), { error: ERRORS.providerUnreachable });
  }
});

test("the Advanced Mode Worker routes /api/judge to this Function and everything else to its assets", async () => {
  const unavailable = await worker.fetch(new Request("https://voice-ui.invalid/api/judge", { method: "POST", body: "{}" }), {});
  assert.equal(unavailable.status, 503);
  const wrongMethod = await worker.fetch(new Request("https://voice-ui.invalid/api/judge"), {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  let assets = 0;
  const asset = await worker.fetch(new Request("https://voice-ui.invalid/data/bundle.v1.json"), {
    ASSETS: { fetch: async () => { assets += 1; return new Response("{}"); } },
  });
  assert.equal(await asset.text(), "{}");
  assert.equal(assets, 1);
});

test("key precedence preserves the original nonempty-string domain", async () => {
  for (const key of [undefined, null, 0, ""]) {
    const { result, calls } = await withProvider(answering(noneTo), () => post("{", { JEV_API_KEY: key }));
    assert.equal(result.status, 503); assert.equal(calls.length, 0);
  }
});
test("unknown and prototype error codes remain closed failures", async () => {
  for (const error of [{ code: "toString" }, { code: "constructor" }, { code: "unknown" }, { get code() { throw new Error("synthetic-canary"); } }]) {
    const result = await onRequestPost({ request: new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(request()) }), available: true }, async () => { throw error; });
    assert.equal(result.status, 502); assert.deepEqual(await result.json(), { error: ERRORS.providerUnreachable });
  }
});
test("compatible extras and finite subset probabilities do not change the low-confidence decision", async () => {
  for (const probabilities of [undefined, { [NONE]: 2 }]) {
    const { result, calls } = await withProvider(async body => new Response(JSON.stringify({ model: "synthetic-model-canary", extra: true, answers: Object.fromEntries(Object.entries(noneTo(body)).map(([name, answer]) => [name, { ...answer, confidence: 0.49, probabilities }])) })), () => post(request()));
    assert.equal(result.status, 200); assert.equal(calls.length, 1);
    const value = await result.json(); assert.equal("model" in value, false);
    assert.ok(Object.values(value.answers).every(answer => answer.confidence === 0.49));
  }
});
test("the actual produced Worker binds the actual admitted provider entry", async () => {
  const { result, calls } = await withProvider(answering(noneTo), () => worker.fetch(new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(request()) }), { JEV_API_KEY: "fixture" }));
  assert.equal(result.status, 200); assert.equal(calls.length, 1);
  const value = await result.json(); assert.equal(value.kind, DECISION_KIND); assert.equal("model" in value, false);
});

test("the app operation receives a bound provider, not a credential", async () => {
  const { result, calls } = await withProvider(answering(noneTo), () => {
    const provider = bindJev({ apiKey: "fixture" });
    return onRequestPost({ request: new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(request()) }), available: provider.available }, judgeFor(provider));
  });
  assert.equal(result.status, 200); assert.equal(calls.length, 1);
  const unavailable = await onRequestPost({ request: new Request("http://localhost/api/judge", { method: "POST", body: "{" }), available: false }, () => { throw new Error("must not call"); });
  assert.equal(unavailable.status, 503);
});
