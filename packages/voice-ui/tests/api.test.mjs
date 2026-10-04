import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onRequestPost } from "../functions/api/judge.mjs";
if (!process.env.JUDGE_PROVIDER_ENTRY || !process.env.VOICE_UI_WORKER) throw new Error("actual provider and produced Worker entries are required");
const { bindJev, judgeNamedChoices } = await import(process.env.JUDGE_PROVIDER_ENTRY);
const { default: worker } = await import(process.env.VOICE_UI_WORKER);
const judgeFor = provider => (request, { signal }) => judgeNamedChoices({ request, provider, signal });
import { focusedEvidence, intentSectionOf, judgeRequestsOf, judgeSectionOf, locateRequestsOf, readManifest } from "../src/architecture.mjs";
import {
  ACTION_ARCHITECTURE,
  ARCHITECTURE_INTENT_KIND,
  DECISION_KIND,
  GOAL_REQUEST_KIND,
  ERRORS,
  NONE,
  REQUEST_KIND,
  WHOLE,
  YES,
  isJudgeRequest,
  isLocateRequest,
  isRequest,
  judgeFramesFor,
  judgeSlotsFor,
  locateSlotsFor,
  relationSlot,
  relevantSlot,
  roleSlot,
  slotsFor,
} from "../src/contract.mjs";



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
test("Goal v2 boundary asks one executable delta and refuses extra answers without architecture fanout", async () => {
  const body = { kind: GOAL_REQUEST_KIND, state: {
    utterance: "add the offered service inside the existing container",
    graph: [{ id: "root", label: "world", parent: null }, { id: "container", label: "container", parent: "root" }],
    parents: [{ id: "container", label: "container", kind: "group", parent: "root" }],
    offers: { parts: [{ key: "service", purpose: "a service" }] }, selected: [],
    candidates: [{ id: "delta-1", part: "service", parent: "container" }],
  } };
  let calls = 0;
  const invoke = async (input, extra = false) => onRequestPost({ available: true,
    request: new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(input) }),
  }, async ({ state, questions }) => {
    calls += 1;
    assert.deepEqual(state, body.state);
    assert.deepEqual(Object.keys(questions), ["delta"]);
    return { answers: { delta: { choice: "delta-1", confidence: 1 },
      ...(extra ? { action: { choice: NONE, confidence: 1 } } : {}) } };
  });
  assert.equal((await invoke(body)).status, 200);
  assert.equal((await invoke(body, true)).status, 502);
  const invalid = structuredClone(body); invalid.state.parents[0].kind = "step";
  assert.equal((await invoke(invalid)).status, 422);
  assert.equal((await invoke({ ...body, kind: "voice-ui.judge.goal-addition.v1" })).status, 422);
  for (const candidates of [[], Array.from({ length: 255 }, (_, index) => ({ id: `delta-${index + 1}`, part: "service", parent: "container" })),
    [{ id: "delta-1", part: "absent", parent: "container" }], [{ id: "delta-1", part: "service", parent: "root" }]]) {
    assert.equal((await invoke({ ...body, state: { ...body.state, candidates } })).status, 422);
  }
  assert.equal(calls, 2);
});

test("Goal candidate cap accepts 254 unique pairs and refuses 255 before provider invocation", async () => {
  const parents = Array.from({ length: 32 }, (_, index) => ({ id: `group-${index}`, label: `Group ${index}`, kind: "group", parent: "root" }));
  const parts = Array.from({ length: 8 }, (_, index) => ({ key: `part-${index}`, purpose: `Offered part ${index}` }));
  const pairs = parents.flatMap(parent => parts.map(part => ({ part: part.key, parent: parent.id })))
    .map((pair, index) => ({ id: `delta-${index + 1}`, ...pair }));
  let calls = 0;
  for (const count of [254, 255]) {
    const body = { kind: GOAL_REQUEST_KIND, state: { utterance: "one offered addition",
      graph: [{ id: "root", label: "World", parent: null }, ...parents.map(({ id, label, parent }) => ({ id, label, parent }))],
      parents, offers: { parts }, selected: [], candidates: pairs.slice(0, count),
    } };
    assert.equal(isRequest(body), count === 254);
    const response = await onRequestPost({ available: true,
      request: new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(body) }),
    }, async ({ questions }) => { calls += 1;
      assert.equal(Object.keys(questions.delta.options).length, 255);
      return { answers: { delta: { choice: NONE, confidence: 1 } } };
    });
    assert.equal(response.status, count === 254 ? 200 : 422);
  }
  assert.equal(calls, 1);
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

test("a pending placement retains its base question before adding repair context", async () => {
  const body = request({
    graph: { ...request().state.graph, placeable: ["node-a", "node-b"] },
    pending: { missing: "direction", move: "node-a", anchor: "node-b", direction: null },
  });
  assert.ok(isRequest(body));
  const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(body));
  assert.equal(result.status, 200);
  assert.match(call.questions.direction.instructions, /^If the utterance asks to move a part next to another one, which side of that part does it go\?/u);
  assert.match(call.questions.direction.instructions, /state\.pending is a placement/u);
  assert.equal(call.questions.direction.instructions.includes("undefined"), false);
  assert.match(call.questions.move.instructions, /which part is being moved/u);
  assert.equal(call.questions.move.instructions.includes("state.pending is a placement"), false);
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
    ["provider refused", async () => new Response("denied", { status: 401 }), 502, ERRORS.providerError, 401],
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
  for (const [label, respond, status, code, upstreamStatus] of providerCases) {
    const { result } = await withProvider(respond, () => post(request()));
    assert.equal(result.status, status, label);
    assert.deepEqual(await result.json(), upstreamStatus === undefined ? { error: code } : { error: code, upstreamStatus }, label);
  }
});

test("only the typed HTTP error can expose an allowlisted status, never raw detail", async () => {
  const invoke = error => onRequestPost({ request: new Request("http://localhost/api/judge", {
    method: "POST", body: JSON.stringify(request()),
  }), available: true }, async () => { throw error; });
  for (const upstreamStatus of [300,401,429,500,599,undefined,null,"401",200,299,600,-1,NaN,Infinity,401.5,true,{}]) {
    const result = await invoke({ code: "provider_http_error", upstreamStatus, message: "private-canary", body: "private-canary", headers: { secret: "private-canary" }, model: "private-canary" });
    assert.equal(result.status, 502);
    const allowed = Number.isInteger(upstreamStatus) && upstreamStatus >= 300 && upstreamStatus <= 599;
    assert.deepEqual(await result.json(), allowed ? { error: ERRORS.providerError, upstreamStatus } : { error: ERRORS.providerError });
  }
  for (const code of ["provider_timeout","provider_unavailable","provider_contract_error","auth_missing","unknown"]) {
    const result = await invoke({ code, upstreamStatus: 401 });
    assert.equal(Object.hasOwn(await result.json(), "upstreamStatus"), false);
  }
  const unreadable = { code: "provider_http_error", get upstreamStatus() { throw Error("private-canary"); } };
  assert.deepEqual(await (await invoke(unreadable)).json(), { error: ERRORS.providerError });
});

test("only the exact typed400 diagnostic constant escapes the API trust boundary", async () => {
  const invoke = error => onRequestPost({ request: new Request("http://localhost/api/judge", { method: "POST", body: JSON.stringify(request()) }), available: true }, async () => { throw error; });
  const flag="context-limit-vocabulary-observed";
  for(const diagnostic of [flag,undefined,null,"private-canary",{},[flag],400,true]){
    const response=await invoke({code:"provider_http_error",upstreamStatus:400,diagnostic,message:"private-canary",body:"private-canary"});
    assert.equal(response.status,502);const body=await response.json();
    assert.deepEqual(body,diagnostic===flag?{error:ERRORS.providerError,upstreamStatus:400,diagnostic:flag}:{error:ERRORS.providerError,upstreamStatus:400});
    assert.ok(!JSON.stringify(body).includes("private-canary"));
  }
  for(const error of [{code:"provider_http_error",upstreamStatus:401,diagnostic:flag},{code:"provider_timeout",upstreamStatus:400,diagnostic:flag},{code:"provider_http_error",upstreamStatus:"400",diagnostic:flag},{code:"provider_http_error",upstreamStatus:400,get diagnostic(){throw Error("private-canary");}}]){
    assert.equal(Object.hasOwn(await(await invoke(error)).json(),"diagnostic"),false);
  }
});
test("produced Worker and admitted provider expose only fixed400 vocabulary observation", async () => {
  const flag="context-limit-vocabulary-observed";
  for(const [value,expected]of [[{detail:"private-canary context length"},true],[{message:"not a context limit private-canary"},true],[{error:{message:"context limit private-canary"}},true],[{detail:"context",message:"length"},false],[{input:{message:"context limit private-canary"}},false],[{detail:{message:"context limit private-canary"}},false],[{detail:"unrecognized private-canary"},false]]){
    let reads=0,streamReads=0,releases=0;const bytes=Buffer.from(JSON.stringify(value));
    const reader={read:async()=>streamReads++===0?{done:false,value:bytes}:{done:true},cancel(){throw Error("unexpected cancel");},releaseLock(){releases++;}};
    const {result,calls}=await withProvider(async()=>({ok:false,status:400,body:{getReader:()=>reader},json(){reads++;throw Error("private-canary");},text(){reads++;throw Error("private-canary");},get headers(){reads++;throw Error("private-canary");}}),()=>post(request()));
    assert.equal(streamReads,2);assert.equal(releases,1);
    assert.equal(calls.length,1);assert.equal(reads,0);assert.equal(result.status,502);const body=await result.json();
    assert.deepEqual(body,expected?{error:ERRORS.providerError,upstreamStatus:400,diagnostic:flag}:{error:ERRORS.providerError,upstreamStatus:400});assert.ok(!JSON.stringify(body).includes("private-canary"));
  }
});
test("produced Worker and admitted provider retain HTTP status without reading error content or retrying", async () => {
  for (const upstreamStatus of [429, 503]) {
    let reads = 0;
    const { result, calls } = await withProvider(async () => ({
      ok: false, status: upstreamStatus,
      json: () => { reads++; throw Error("private-canary"); },
      text: () => { reads++; throw Error("private-canary"); },
      get headers() { reads++; throw Error("private-canary"); },
    }), () => post(request()));
    assert.equal(calls.length, 1, "one controlled upstream call, no retry");
    assert.equal(reads, 0, "error body and headers are not read");
    assert.equal(result.status, 502, "neutral response status remains unchanged");
    const body = await result.json();
    assert.deepEqual(body, { error: ERRORS.providerError, upstreamStatus });
    assert.ok(!JSON.stringify(body).includes("private-canary"));
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
const MANIFEST = readManifest(prepared.manifest);
const intentRequest = (architecture = intentSectionOf(MANIFEST)) => ({ ...request({ architecture }), kind: ARCHITECTURE_INTENT_KIND });

test("architecture references are required nullable keys reopened canonically before judgment", async () => {
  const entry = { seq: 1, source: "typed", text: "show storage", outcome: "no-change", reference: null };
  const body = intentRequest();
  body.state.context = { recent: [entry] };
  assert.equal(isRequest(body), true);
  const reference = { source: MANIFEST.source, focus: ["ext-localstorage"] };
  entry.reference = reference;
  body.state.graph = {
    regions: [{ id: "one", label: "one" }, { id: "two", label: "two" }, { id: "three", label: "three" }],
    edges: [{ id: "edge-one", from: "one", to: "two" }, { id: "edge-two", from: "two", to: "three" }],
    placeable: [],
  };
  const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0].state.context.recent[0].reference, judgeSectionOf(MANIFEST, reference.focus));
  assert.match(calls[0].questions.action.instructions, /association.*unverified/u);
  assert.match(calls[0].questions.edge.instructions, /Do not replace an explicit endpoint or semantic qualification/u);
  assert.match(calls[0].questions.edge.instructions, /Match against all current edges/u);
  assert.match(calls[0].questions.edge.instructions, /does not identify one unique edge, answer none/u);
  assert.deepEqual(Object.keys(calls[0].questions.edge.criteria).sort(), [NONE, "edge-one", "edge-two"].sort(),
    "the reference subset cannot prune globally explicit edges");
  for (const altered of [
    { ...entry, reference: undefined },
    { ...entry, reference: { ...reference, focus: ["missing"] } },
    { ...entry, reference: { ...reference, source: { ...reference.source, commit: "f".repeat(40) } } },
    { ...entry, reference: { ...reference, descriptors: [] } },
    { ...entry, outcome: "refused" },
  ]) {
    const malformed = { ...body, state: { ...body.state, context: { recent: [altered] } } };
    const checked = await withProvider(answering(noneTo), () => post(malformed, ARCHITECTURE_ENV));
    assert.equal(checked.result.status, 422);
    assert.equal(checked.calls.length, 0);
  }
  assert.equal(isRequest(request({ context: { recent: [entry] } })), false);
  assert.equal(isRequest({ ...body, kind: "voice-ui.judge.architecture-intent.v1" }), false);
});
// Every judge frame of a focus, as the page sends them; and the first of them.
const judgeRequests = focus => JSON.parse(JSON.stringify(judgeRequestsOf(MANIFEST, Array.isArray(focus) ? focus : [focus], "show me that part")));
const judgeRequest = focus => judgeRequests(focus)[0];
// Every locate frame of an intent, as the page sends them; and the one for a part.
const locateRequests = () => JSON.parse(JSON.stringify(locateRequestsOf(MANIFEST, intentRequest())));
const locateRequest = (part = "web-app-mjs") => locateRequests().find(frame => frame.state.architecture.focus[0] === part);

test("locate references use the same canonical authority and cannot enter the plain wire", async () => {
  const reference = { source: MANIFEST.source, focus: ["ext-localstorage"] };
  const entry = { seq: 1, source: "typed", text: "show storage", outcome: "no-change", reference };
  const body = locateRequest();
  body.state.context = { recent: [entry] };
  const accepted = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(accepted.result.status, 200);
  assert.deepEqual(accepted.calls[0].state.context.recent[0].reference, judgeSectionOf(MANIFEST, reference.focus));
  for (const malformed of [
    { ...body, state: { ...body.state, context: { recent: [{ ...entry, reference: undefined }] } } },
    { ...body, state: { ...body.state, context: { recent: [{ ...entry, reference: { ...reference, focus: ["missing"] } }] } } },
    { ...body, state: { ...body.state, context: { recent: [{ ...entry, reference: { ...reference, source: { ...reference.source, commit: "f".repeat(40) } } }] } } },
    { ...body, kind: "voice-ui.judge.architecture-locate.v1" },
    request({ context: { recent: [entry] } }),
  ]) {
    const refused = await withProvider(answering(noneTo), () => post(malformed, ARCHITECTURE_ENV));
    assert.equal(refused.result.status, 422);
    assert.equal(refused.calls.length, 0);
  }
});

test("the original storage pairs still open all four files, while positive JSON subjects ask no inferred relation", () => {
  const section = judgeSectionOf(MANIFEST, ["ext-localstorage"]);
  assert.deepEqual(section.bodies, ["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"]);
  for (const subject of ["dev-architecture-config-v1-json", "web-data-config-v1-json"]) {
    assert.ok(MANIFEST.candidates.some(candidate => candidate.from === subject && candidate.to === "ext-localstorage"));
    assert.ok(!section.candidates.some(candidate => candidate.from === subject));
    assert.ok(Object.hasOwn(judgeSlotsFor(section), roleSlot(subject, "config")));
    assert.ok(MANIFEST.facts.some(fact => fact.entity === subject));
  }
  for (const id of section.bodies) {
    const entity = MANIFEST.entities.find(value => value.id === id);
    assert.equal(prepared.evidence.files[id], fs.readFileSync(path.join(PACKAGE, entity.path), "utf8"));
  }
});
// What every question says of the conversation, word for word.
const CONTEXT_NOTE = " context.recent lists earlier utterances as they were recognized or typed, and what came of each."
  + " They are unverified and may be misrecognized. Use them only to understand what the current utterance refers to;"
  + " the current utterance, the working graph and the focus are the facts, and an earlier effect is history, not the current graph.";

// Whether any line of any admitted file - longer than a bare brace or keyword -
// appears in what was sent.
const carriesCode = sent => {
  const text = JSON.stringify(sent);
  return Object.values(prepared.evidence.files).some(file => file.split("\n")
    .some(line => line.trim().length >= 40 && text.includes(JSON.stringify(line).slice(1, -1))));
};

test("an architecture request without this server's prepared source is refused before the provider", async () => {
  const unavailable = { schema: "voice-ui.architecture-source/2", status: "unavailable", reason: "no exact commit" };
  const cases = [
    ["no source bound", { JEV_API_KEY: "test-only-value" }],
    ["an unavailable source", { JEV_API_KEY: "test-only-value", ARCHITECTURE: { manifest: unavailable, evidence: prepared.evidence } }],
    ["evidence of another snapshot", { JEV_API_KEY: "test-only-value",
      ARCHITECTURE: { manifest: prepared.manifest, evidence: { ...prepared.evidence, source: { ...prepared.evidence.source, commit: "f".repeat(40) } } } }],
  ];
  for (const body of [intentRequest(), locateRequest(), judgeRequest("web-app-mjs")]) {
    const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(cases.map(([, env]) => post(body, env))));
    for (const [index, response] of result.entries()) {
      assert.equal(response.status, 503, `${body.kind}: ${cases[index][0]}`);
      assert.deepEqual(await response.json(), { error: ERRORS.architectureUnavailable }, cases[index][0]);
    }
    assert.equal(calls.length, 0);
  }
});

test("a prepared source whose private text is not exactly the admitted files is refused before the provider, for every kind", async () => {
  const files = prepared.evidence.files;
  const [first] = Object.keys(files);
  const { [first]: dropped, ...missing } = files;
  assert.equal(typeof dropped, "string");
  const broken = [
    ["a file's text missing", missing],
    ["an extra file", { ...files, "not-admitted": "text" }],
    ["a text that is not a string", { ...files, [first]: null }],
    ["no files at all", null],
    ["files as a list", Object.values(files)],
  ];
  for (const [label, value] of broken) {
    const env = { JEV_API_KEY: "test-only-value", ARCHITECTURE: { manifest: prepared.manifest, evidence: { ...prepared.evidence, files: value } } };
    for (const body of [intentRequest(), locateRequest(), judgeRequest("web-app-mjs")]) {
      const { result, calls } = await withProvider(answering(noneTo), () => post(body, env));
      assert.equal(result.status, 503, `${label}: ${body.kind}`);
      assert.deepEqual(await result.json(), { error: ERRORS.architectureUnavailable }, `${label}: ${body.kind}`);
      assert.equal(calls.length, 0, `${label}: ${body.kind} never reaches the provider`);
    }
  }
  // An admitted file may be empty: its text is then the empty string, still sent.
  const empty = { ...files, [first]: "" };
  const { result, calls } = await withProvider(answering(noneTo), () => post(locateRequest(first),
    { JEV_API_KEY: "test-only-value", ARCHITECTURE: { manifest: prepared.manifest, evidence: { ...prepared.evidence, files: empty } } }));
  assert.equal(result.status, 200);
  const emptyPath = MANIFEST.entities.find(entity => entity.id === first).path;
  assert.equal(calls[0].state.architecture.evidence.bodies.find(body => body.path === emptyPath)?.text, "");
});

test("malformed syntax facts and broken source/entity links refuse every architecture kind before the provider", async () => {
  const changes = [
    value => { delete value.files.find(file => file.class === "admitted").jsonSyntax; },
    value => { value.files.find(file => file.class === "admitted").jsonSyntax = null; },
    value => { value.files = value.files.filter(file => file.entity !== "web-app-mjs"); },
    value => { value.files.find(file => file.entity === "web-app-mjs").entity = "ext-localstorage"; },
    value => { value.files.push({ ...value.files.find(file => file.class === "admitted") }); },
  ];
  for (const change of changes) {
    const manifest = structuredClone(prepared.manifest); change(manifest);
    const env = { JEV_API_KEY: "test-only-value", ARCHITECTURE: { manifest, evidence: prepared.evidence } };
    for (const body of [intentRequest(), locateRequest(), judgeRequest("web-app-mjs")]) {
      const { result, calls } = await withProvider(answering(noneTo), () => post(body, env));
      assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), { error: ERRORS.architectureUnavailable });
      assert.equal(calls.length, 0);
    }
  }
});

test("an architecture section that is not exactly this server's snapshot is refused before the provider", async () => {
  const own = intentSectionOf(MANIFEST);
  const judge = judgeRequest("src-log-mjs");
  // Two body files with no pair between them: a frame of this shape that the
  // section's own plan does not hold.
  const credential = judgeRequest("ext-jev-api-key");
  assert.deepEqual([...credential.state.architecture.bodies].sort(), ["dev-serve-mjs", "functions-pages-worker-mjs"]);
  const unplannedSection = judgeSectionOf(MANIFEST, ["dev-architecture-config-v1-json", "web-data-config-v1-json"]);
  const unplanned = { ...credential, state: { ...credential.state, architecture: unplannedSection, frame: [...unplannedSection.bodies].sort() } };
  assert.ok(isJudgeRequest(unplanned));
  const altered = [
    intentRequest({ ...own, source: { ...own.source, commit: "f".repeat(40) } }),
    intentRequest({ ...own, entities: own.entities.map((entity, index) => (index === 0 ? { ...entity, label: "renamed" } : entity)) }),
    intentRequest({ ...own, entities: own.entities.slice(1) }),
    { ...judge, state: { ...judge.state, architecture: { ...judge.state.architecture, bodies: ["web-app-mjs"] }, frame: ["web-app-mjs"] } },
    { ...judge, state: { ...judge.state, architecture: { ...judge.state.architecture, candidates: judge.state.architecture.candidates.slice(1) } } },
    { ...judge, state: { ...judge.state, architecture: { ...judge.state.architecture, focus: ["src-session-mjs"] } } },
    unplanned,
    { ...locateRequest(), state: { ...locateRequest().state, architecture: { ...locateRequest().state.architecture, source: { ...own.source, commit: "f".repeat(40) } } } },
    { ...locateRequest(), state: { ...locateRequest().state, architecture: { ...locateRequest().state.architecture, focus: ["not-a-part"] } } },
  ];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(altered.map(body => post(body, ARCHITECTURE_ENV))));
  for (const [index, response] of result.entries()) {
    assert.equal(response.status, 422, `case ${index}`);
    assert.deepEqual(await response.json(), { error: ERRORS.architectureMismatch });
  }
  assert.equal(calls.length, 0);
  // A plain request stays exactly the plain request: no architecture in it.
  const { result: plain } = await withProvider(answering(noneTo), () => post(request({ architecture: own }), ARCHITECTURE_ENV));
  assert.equal(plain.status, 422);
  assert.deepEqual(await plain.json(), { error: ERRORS.invalidRequest });
});

test("a plain request and an intent carry no code; an intent adds one closed question, which part", async () => {
  const bodies = [request(), intentRequest()];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(bodies.map(body => post(body, ARCHITECTURE_ENV))));
  assert.deepEqual(result.map(response => response.status), [200, 200]);
  for (const [index, call] of calls.entries()) {
    assert.equal(carriesCode(call), false, `${bodies[index].kind} sends no line of code`);
    assert.equal(JSON.stringify(call).includes("\"evidence\""), false);
    assert.deepEqual(call.state, bodies[index].state, "sent as it came");
  }
  const [plain, intent] = calls;
  assert.deepEqual(Object.keys(intent.questions).filter(name => !Object.hasOwn(plain.questions, name)), ["focus"]);
  assert.deepEqual(Object.keys(intent.questions.focus.criteria), [...MANIFEST.entities.map(entity => entity.id), WHOLE, NONE]);
  // The whole and none are told apart by what they mean, with no example words.
  assert.equal(intent.questions.focus.criteria[WHOLE], "the code as a whole");
  assert.equal(intent.questions.focus.criteria[NONE], "neither one part nor the whole is clear, or it asks for neither");
  assert.ok(Object.keys(intent.questions.action.criteria).includes(ACTION_ARCHITECTURE));
  assert.match(intent.questions.focus.criteria["web-app-mjs"], /web\/app\.mjs/u);
});

test("an intent tells each edge the snapshot defines by its kind; any other edge, and every plain edge, by its two ends only", async () => {
  const labelOf = id => MANIFEST.entities.find(entity => entity.id === id).label;
  const region = id => ({ id: `arch-${id}`, label: labelOf(id) });
  const end = id => `arch-${id} (shown as "${labelOf(id)}")`;
  const purposeOf = key => MANIFEST.relations.find(relation => relation.key === key).purpose;
  const regions = ["web-app-mjs", "web-data-config-v1-json", "ext-localstorage", "functions-pages-worker-mjs", "functions-api-judge-mjs"].map(region);
  const stores = { id: "arch-stores-in-web-app-mjs-to-ext-localstorage", from: "arch-web-app-mjs", to: "arch-ext-localstorage" };
  const configures = { id: "arch-configures-web-data-config-v1-json-to-ext-localstorage", from: "arch-web-data-config-v1-json", to: "arch-ext-localstorage" };
  const imports = { id: "arch-import-functions-pages-worker-mjs-to-functions-api-judge-mjs", from: "arch-functions-pages-worker-mjs", to: "arch-functions-api-judge-mjs" };
  const user = { id: "voice-arch-web-app-mjs-to-arch-ext-localstorage", from: "arch-web-app-mjs", to: "arch-ext-localstorage" };
  const edgeCriteria = async (body, env = ARCHITECTURE_ENV) => {
    const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(body, env));
    assert.equal(result.status, 200);
    return call.questions.edge.criteria;
  };
  const intent = edges => ({ ...request({ graph: { regions, edges, placeable: [] }, architecture: intentSectionOf(MANIFEST) }), kind: ARCHITECTURE_INTENT_KIND });
  const ends = edge => `the edge from ${end(edge.from.slice("arch-".length))} to ${end(edge.to.slice("arch-".length))}`;

  // Two edges into one part, told apart by what the snapshot defines each as:
  // a relation of the vocabulary with its own purpose, a reserved kind by its
  // kind alone, and an edge the person made by its two ends only.
  const criteria = await edgeCriteria(intent([stores, configures, imports, user]));
  assert.equal(criteria[stores.id], `${ends(stores)}, which this snapshot defines as stores-in: ${purposeOf("stores-in")}`);
  assert.equal(criteria[configures.id], ends(configures), "the JSON-subject inference is deliberately not analyzed; only the endpoints are known");
  assert.equal(criteria[imports.id], `${ends(imports)}, which this snapshot defines as imports`);
  assert.equal(criteria[user.id], ends(user));

  // An id the snapshot knows, but not with these ends, borrows no kind: other
  // ends, the ends swapped, another pair's id.
  for (const forged of [
    { ...stores, from: "arch-web-data-config-v1-json" },
    { ...stores, from: stores.to, to: stores.from },
    { ...configures, from: "arch-web-app-mjs" },
  ]) {
    assert.equal((await edgeCriteria(intent([forged])))[forged.id], ends(forged), JSON.stringify(forged));
  }

  // The plain request has no snapshot: every edge by its two ends, as before.
  const plain = await edgeCriteria(request({ graph: { regions, edges: [stores, configures, imports, user], placeable: [] } }));
  for (const edge of [stores, configures, imports, user]) assert.equal(plain[edge.id], ends(edge), edge.id);
});

test("qualified edge references precede unrelated edit focus; only bare references use it", async () => {
  const region = id => ({ id: 'arch-' + id, label: MANIFEST.entities.find(entity => entity.id === id).label });
  const regions = ['web-app-mjs', 'ext-localstorage', 'src-session-mjs'].map(region);
  regions.push({ id: 'arch-role-persistence', label: 'stores, restores or verifies saved data' });
  const stored = { id: 'arch-stores-in-web-app-mjs-to-ext-localstorage', from: 'arch-web-app-mjs', to: 'arch-ext-localstorage' };
  const focused = { id: 'arch-has-role-src-session-mjs-to-persistence', from: 'arch-src-session-mjs', to: 'arch-role-persistence' };
  const focus = { kind: 'draft', changes: [{ change: 'added', from: focused.from, to: focused.to }] };
  const cases = [
    ['explicit endpoints', 'remove the edge from web/app.mjs to localStorage', 'remove-edge', stored.id],
    ['semantic qualification', 'remove that saving relation', 'remove-edge', stored.id],
    ['explicit role endpoints', 'remove the edge from src/session.mjs to stores, restores or verifies saved data', 'remove-edge', focused.id],
    ['unmatched qualification', 'remove that scheduling relation', 'remove-edge', NONE],
    ['bare reference', 'reverse that edge', 'reverse-edge', focused.id],
  ];
  for (const [label, utterance, action, edge] of cases) {
    const body = { ...request({ utterance, graph: { regions, edges: [stored, focused], placeable: [] }, focus,
      architecture: intentSectionOf(MANIFEST) }), kind: ARCHITECTURE_INTENT_KIND };
    const { result, calls: [call] } = await withProvider(answering(call => ({ ...noneTo(call),
      action: { type: 'choice', choice: action, confidence: .9 }, edge: { type: 'choice', choice: edge, confidence: .9 },
    })), () => post(body, ARCHITECTURE_ENV));
    assert.equal(result.status, 200, label);
    assert.deepEqual(call.state.focus, focus, 'the honest edit focus is not changed');
    assert.match(call.questions.action.instructions, /Only a bare, unqualified reference/u, label);
    assert.match(call.questions.action.instructions, /qualified by endpoints or semantic description refers to matching current graph candidates, not the focus/u, label);
    assert.match(call.questions.action.instructions, /clear remove or reverse request still names that action when its edge is unresolved; answer none for the edge/u, label);
    assert.match(call.questions.edge.instructions, /endpoints or its semantic description/u, label);
    assert.match(call.questions.edge.instructions, /no edge or more than one edge matches.*none/u, label);
    assert.match(call.questions.edge.instructions, /never use focus to override a qualification/u, label);
    assert.match(call.questions.edge.instructions, /compare the relationship itself, not merely a related endpoint label/u, label);
    assert.match(call.questions.edge.instructions, /membership in a role and interaction with another part are different relationships/u, label);
    assert.match(call.questions.edge.instructions, /explicit identification by endpoints remains valid.*displayed labels/u, label);
    assert.match(call.questions.edge.criteria[stored.id], /stores-in: /u);
    assert.match(call.questions.edge.criteria[focused.id], /which this snapshot defines as has-role$/u);
    assert.match(call.questions.edge.criteria[stored.id], /web\/app\.mjs.*localStorage/u);
    assert.deepEqual(Object.keys(call.questions.edge.criteria), [...slotsFor(body.state).edge]);
    const decision = await result.json();
    assert.equal(decision.answers.action.choice, action, label);
    assert.equal(decision.answers.edge.choice, edge, label);
  }
});

test("an ambiguous qualified edge reference offers NONE without arbitrary sole-edge or focus fallback", async () => {
  const graph = {
    regions: [{ id: 'node-a', label: 'sender' }, { id: 'node-b', label: 'receiver' }, { id: 'node-c', label: 'receiver' }],
    edges: [{ id: 'edge-ab', from: 'node-a', to: 'node-b' }, { id: 'edge-ac', from: 'node-a', to: 'node-c' }], placeable: [],
  };
  for (const [label, utterance, edges] of [
    ['ambiguous candidates', 'remove that transfer relation', graph.edges],
    ['single unmatched candidate', 'remove that scheduling relation', graph.edges.slice(0, 1)],
  ]) {
    const body = request({ utterance, graph: { ...graph, edges },
      focus: { kind: 'applied', changes: [{ change: 'added', from: 'node-a', to: 'node-b' }] } });
    const { result, calls: [call] } = await withProvider(answering(call => ({ ...noneTo(call),
      action: { type: 'choice', choice: 'remove-edge', confidence: .9 }, edge: { type: 'choice', choice: NONE, confidence: .9 },
    })), () => post(body));
    assert.equal(result.status, 200, label);
    assert.match(call.questions.edge.instructions, /no edge or more than one edge matches.*none/u, label);
    assert.match(call.questions.edge.instructions, /never use focus to override a qualification/u, label);
    assert.match(call.questions.edge.instructions, /Do not pick an edge just because it is the only edge/u, label);
    assert.deepEqual(Object.keys(call.questions.edge.criteria), [...slotsFor(body.state).edge], label);
    assert.equal(call.questions.edge.criteria[NONE], 'no unique edge matches the qualified reference, or no unqualified reference identifies a current edge');
    const decision = await result.json();
    assert.equal(decision.answers.action.choice, 'remove-edge', label);
    assert.equal(decision.answers.edge.choice, NONE, 'a clear action can retain an unresolved target');
  }
});

// The judge's one kind, by its own name: the section whole and, beside it, the
// frame this request asks. The kind before it, which had no frame, is gone.
test("a judge under the neutral current kind, its section whole and its frame beside it, is answered by one provider call", async () => {
  const section = JSON.parse(JSON.stringify(judgeSectionOf(MANIFEST, ["src-log-mjs"])));
  const body = { kind: "voice-ui.judge.architecture-judge.v1", state: { utterance: "show me that part", architecture: section, frame: ["src-log-mjs"] } };
  const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
});

test("a judge under the v2 kind, a section and no frame, is refused before the provider", async () => {
  const section = JSON.parse(JSON.stringify(judgeSectionOf(MANIFEST, ["src-log-mjs"])));
  const body = { kind: "voice-ui.jev.architecture-judge.v2", state: { utterance: "show me that part", architecture: section } };
  const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(result.status, 422);
  assert.deepEqual(await result.json(), { error: ERRORS.invalidRequest });
  assert.equal(calls.length, 0);
});

// What a judge says of its text, and a judge's questions for a section, word
// for word, in the order they are asked.
const EVIDENCE_NOTE = " state.architecture.evidence.bodies holds whole files, each with its path;"
  + " state.architecture.evidence.lines holds single lines of other files, each with its path and line number, and nothing around them."
  + " A part with no text there is known only by its name. Judge only from that text; if it does not show the answer, answer none.";
const judgeQuestionsOf = section => {
  const labelOf = id => section.entities.find(entity => entity.id === id).label;
  return {
    ...Object.fromEntries(section.bodies.flatMap(body => section.roles.map(role => [roleSlot(body, role.key), {
      type: "choice",
      instructions: `Does the file ${labelOf(body)}, whose whole text is in state.architecture.evidence.bodies, ${role.purpose}?${EVIDENCE_NOTE}`,
      criteria: { [YES]: `yes: its own text shows that it ${role.purpose}`, [NONE]: "no, or its text does not show it" },
    }]))),
    ...Object.fromEntries(section.candidates.map(candidate => [relationSlot(candidate.id), {
      type: "choice",
      instructions: `From ${labelOf(candidate.from)} to ${labelOf(candidate.to)} (a candidate pair because of: ${candidate.reasons.join(", ")}):`
        + ` which relation holds at run time from the first to the second? Being a candidate is not evidence of any relation.${EVIDENCE_NOTE}`,
      criteria: {
        ...Object.fromEntries(section.relations.map(relation => [relation.key, relation.purpose])),
        [NONE]: "no relation of these kinds holds, or the text does not show one",
      },
    }])),
  };
};
// Exactly what the provider is sent for one part of a section: the utterance,
// that part with its own text, and its questions - and nothing else.
const providerBodyOf = (utterance, section) => ({
  model: "jev-latest",
  state: { utterance, architecture: { ...section, evidence: focusedEvidence(section, MANIFEST, prepared.evidence.files) } },
  questions: Object.fromEntries(Object.entries(judgeQuestionsOf(section)).map(([name, question]) => [name, { type: question.type, criteria: question.criteria, instructions: question.instructions }])),
});

test("a judge frame is asked from exactly its own text: its body files whole, other files by matching line, and never which frame it is", async () => {
  const bodies = judgeRequests("ext-jev-api-key");
  const section = judgeSectionOf(MANIFEST, ["ext-jev-api-key"]);
  const plan = judgeFramesFor(section);
  assert.deepEqual(bodies.map(body => body.state.frame), [["dev-serve-mjs"], ["functions-pages-worker-mjs"], ["dev-serve-mjs", "functions-pages-worker-mjs"]], "each credential body and the actual shared-route pair has its frame");
  const asked = [];
  for (const [index, body] of bodies.entries()) {
    assert.ok(isJudgeRequest(body));
    assert.deepEqual(body.state.architecture, JSON.parse(JSON.stringify(section)), "the page sends the section whole");
    assert.equal(carriesCode(body), false, "and no line of code");
    const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(Object.keys(call), ["model", "state", "questions"]);
    assert.deepEqual(Object.keys(call.state), ["utterance", "architecture"], "the frame's name stays between the page and this Function");
    assert.equal(JSON.stringify(call).includes("\"frame\""), false);
    const { evidence, ...sent } = call.state.architecture;
    assert.deepEqual(sent, JSON.parse(JSON.stringify(plan[index].section)), "the frame's own part of the section");
    assert.deepEqual(evidence.bodies.map(file => file.path), body.state.frame.map(id => MANIFEST.entities.find(entity => entity.id === id).path),
      "that frame's files whole, and no other");
    for (const file of evidence.bodies) assert.equal(file.text, fs.readFileSync(path.join(PACKAGE, file.path), "utf8"));
    for (const { path: file, line, text } of evidence.lines) {
      assert.equal(fs.readFileSync(path.join(PACKAGE, file), "utf8").split("\n")[line - 1], text, `${file}:${line} is that very line`);
    }
    assert.equal(JSON.stringify(call), JSON.stringify(providerBodyOf(body.state.utterance, plan[index].section)), "word for word, byte for byte");
    const slots = judgeSlotsFor(plan[index].section);
    assert.deepEqual(Object.keys(call.questions), Object.keys(slots));
    for (const [name, question] of Object.entries(call.questions)) assert.deepEqual(Object.keys(question.criteria), slots[name], name);
    const answered = await result.text();
    assert.equal(answered.includes(evidence.bodies[0].text.slice(0, 200)), false, "no admitted text in the answer");
    assert.deepEqual(Object.keys(JSON.parse(answered).answers), Object.keys(slots), "answered on exactly that frame's questions");
    asked.push(call);
  }
  const questions = Object.assign({}, ...asked.map(call => call.questions));
  assert.deepEqual(Object.keys(questions).sort(), Object.keys(judgeSlotsFor(section)).sort(), "the frames together ask every question of the section, once");
  assert.equal(asked.reduce((sum, call) => sum + Object.keys(call.questions).length, 0), Object.keys(questions).length);
  assert.deepEqual(judgeSlotsFor(section)[roleSlot("functions-pages-worker-mjs", "auth")], [YES, NONE]);
  assert.match(questions[relationSlot("c-functions-pages-worker-mjs--ext-jev-api-key")].instructions, /identifier:JEV_API_KEY/u);
  assert.ok(asked.some(call => call.state.architecture.evidence.lines.length > 0), "a file its pairs name is shown by line");
});

test("a section asked in one frame is sent the provider exactly as the section whole would be, on the same input", async () => {
  const single = MANIFEST.entities.map(entity => entity.id).filter(id => judgeRequests(id).length === 1);
  assert.ok(single.includes("web-app-mjs") && single.includes("src-log-mjs"), "the page's own file and the decision log among them");
  for (const id of single) {
    const section = judgeSectionOf(MANIFEST, [id]);
    const [body] = judgeRequests(id);
    const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
    assert.equal(result.status, 200, id);
    assert.equal(JSON.stringify(call), JSON.stringify(providerBodyOf(body.state.utterance, section)), `${id}: state and questions, byte for byte`);
  }
});

test("a locate frame carries no code from the page; the server adds exactly that part's own section text and asks one question naming it", async () => {
  const frames = locateRequests();
  assert.deepEqual(frames.map(frame => frame.state.architecture.focus), MANIFEST.entities.map(entity => [entity.id]),
    "one frame per part the snapshot knows, in its order");
  for (const body of frames) {
    const [part] = body.state.architecture.focus;
    assert.ok(isLocateRequest(body), part);
    assert.equal(carriesCode(body), false, `${part}: the page sends no line of code`);
    const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
    assert.equal(result.status, 200, part);
    const [call] = calls;
    // Only the utterance, the conversation, the snapshot, the part and its text:
    // none of the section's parts, pairs or vocabulary.
    assert.deepEqual(Object.keys(call.state), ["utterance", "context", "architecture"], part);
    assert.deepEqual(Object.keys(call.state.architecture), ["source", "focus", "evidence"], part);
    const { evidence, ...sent } = call.state.architecture;
    assert.deepEqual({ ...call.state, architecture: sent }, body.state, `${part}: the page's state is forwarded unchanged`);
    assert.deepEqual(evidence, JSON.parse(JSON.stringify(focusedEvidence(judgeSectionOf(MANIFEST, [part]), MANIFEST, prepared.evidence.files))),
      `${part}: exactly the text of the section it opens`);
    assert.deepEqual(Object.keys(call.questions), [relevantSlot(part)], part);
    const question = call.questions[relevantSlot(part)];
    assert.deepEqual(Object.keys(question.criteria), locateSlotsFor([part])[relevantSlot(part)], part);
    // The provider never sees the question's name: the words name the part and its text.
    const entity = MANIFEST.entities.find(item => item.id === part);
    assert.ok(question.instructions.includes(entity.label), `${part}: the question names its part`);
    assert.match(question.instructions, entity.kind === "file" ? /the file /u : /outside the source/u, part);
    for (const file of evidence.bodies) assert.ok(question.instructions.includes(file.path), `${part}: the question names ${file.path}`);
    // The whole question, word for word: what this part's own text does for a
    // file, how the shown code uses it for a part outside the source.
    const lined = [...new Set(evidence.lines.map(line => line.path))];
    const shown = ` state.architecture.evidence.bodies holds ${evidence.bodies.map(file => file.path).join(", ")} whole`
      + (lined.length === 0 ? "." : `; state.architecture.evidence.lines holds single lines of ${lined.join(", ")}, each with its path and line number.`)
      + " Judge only from that text and the utterance." + CONTEXT_NOTE;
    assert.ok(question.instructions.startsWith((entity.kind === "file"
      ? `Does the original text of the file ${entity.label} implement behaviour, or declare data, that the current utterance asks about or refers to?`
      : `Does the shown original code use ${entity.label}, which lies outside the source, for behaviour or data that the current utterance asks about or refers to?`)
      + shown), part);
    assert.match(question.instructions, /association.*unverified/u, part);
    assert.match(question.instructions, /Do not replace an explicit endpoint or semantic qualification/u, part);
    assert.match(question.instructions, /Match against all current edges/u, part);
    assert.match(question.instructions, /does not identify one unique edge, answer none/u, part);
    assert.deepEqual(question.criteria, entity.kind === "file"
      ? {
        [YES]: "its own text implements that behaviour or declares that data, whether or not the utterance names the file",
        [NONE]: "its text does not, even if it mentions or imports another part that does",
      }
      : {
        [YES]: "the shown code uses it for that behaviour or data, whether or not the utterance names it",
        [NONE]: "the shown code does not use it for that, or only names it",
      }, part);
    const answered = await result.text();
    assert.equal(answered.includes(evidence.bodies[0].text.slice(0, 200)), false, `${part}: no admitted text in the answer`);
  }
  // A part outside the source is shown the files that name it, whole.
  const { calls: [storage] } = await withProvider(answering(noneTo), () => post(locateRequest("ext-localstorage"), ARCHITECTURE_ENV));
  assert.deepEqual(storage.state.architecture.evidence.bodies.map(file => file.path).sort(),
    ["dev/architecture-config.v1.json", "src/config.mjs", "web/app.mjs", "web/data/config.v1.json"]);
  for (const file of storage.state.architecture.evidence.bodies) {
    assert.equal(file.text, fs.readFileSync(path.join(PACKAGE, file.path), "utf8"), `${file.path} is that very file`);
  }
});

test("a locate or judge the page shapes otherwise, or the provider answers incompletely, is refused", async () => {
  const locate = locateRequest();
  const shaped = [
    { ...locate, state: { ...locate.state, architecture: { ...locate.state.architecture, evidence: { bodies: [] } } } },
    { ...locate, state: { ...locate.state, graph: { regions: [], edges: [], placeable: [] } } },
    { ...locate, state: { ...locate.state, architecture: { ...locate.state.architecture, focus: ["web-app-mjs", "src-log-mjs"] } } },
    { ...locate, state: { ...locate.state, architecture: { source: locate.state.architecture.source } } },
    { ...judgeRequest("src-log-mjs"), state: { ...judgeRequest("src-log-mjs").state, architecture: { ...judgeRequest("src-log-mjs").state.architecture, focus: "src-log-mjs" } } },
    { ...judgeRequest("web-app-mjs"), state: { ...judgeRequest("web-app-mjs").state, architecture: { ...judgeRequest("web-app-mjs").state.architecture, focus: ["web-app-mjs", "src-log-mjs"] } } },
    { ...judgeRequest("web-app-mjs"), state: { ...judgeRequest("web-app-mjs").state, frame: [] } },
    { ...judgeRequest("web-app-mjs"), state: { ...judgeRequest("web-app-mjs").state, frame: ["src-log-mjs"] } },
    { ...judgeRequest("ext-jev-api-key"), state: { ...judgeRequest("ext-jev-api-key").state, frame: ["functions-api-judge-mjs", "dev-serve-mjs"] } },
  ];
  const { result, calls } = await withProvider(answering(noneTo), () => Promise.all(shaped.map(body => post(body, ARCHITECTURE_ENV))));
  for (const [index, response] of result.entries()) {
    assert.equal(response.status, 422, `case ${index}`);
    assert.deepEqual(await response.json(), { error: ERRORS.invalidRequest });
  }
  assert.equal(calls.length, 0);

  // A provider answer missing one part's question is no answer at all.
  const dropOne = body => { const answers = noneTo(body); delete answers[relevantSlot("web-app-mjs")]; return answers; };
  const { result: incomplete } = await withProvider(answering(dropOne), () => post(locate, ARCHITECTURE_ENV));
  assert.equal(incomplete.status, 502);
  assert.deepEqual(await incomplete.json(), { error: ERRORS.providerContract });
  // Nor is a judge frame's answer missing one of that frame's questions, or
  // carrying a question of another frame.
  const [first, second] = judgeRequests("ext-jev-api-key");
  assert.deepEqual([first.state.frame, second.state.frame], [["dev-serve-mjs"], ["functions-pages-worker-mjs"]]);
  const dropRole = body => { const answers = noneTo(body); delete answers[roleSlot("dev-serve-mjs", "auth")]; return answers; };
  const addOther = body => ({ ...noneTo(body), [roleSlot("functions-api-judge-mjs", "auth")]: { type: "choice", choice: NONE, confidence: 0.9 } });
  for (const answersFor of [dropRole, addOther]) {
    const { result: partial } = await withProvider(answering(answersFor), () => post(first, ARCHITECTURE_ENV));
    assert.equal(partial.status, 502);
    assert.deepEqual(await partial.json(), { error: ERRORS.providerContract });
  }
  assert.equal((await withProvider(answering(noneTo), () => post(second, ARCHITECTURE_ENV))).result.status, 200);
});

test("a judge of several parts is one section, the server's own, asked in frames that together open every file they open", async () => {
  const focus = ["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"];
  const union = judgeRequests(focus);
  const section = judgeSectionOf(MANIFEST, focus);
  const opened = new Set();
  const questions = [];
  for (const body of union) {
    assert.ok(isJudgeRequest(body));
    const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
    assert.equal(result.status, 200, `${body.state.frame}`);
    assert.deepEqual(call.state.architecture.focus, focus, "every frame says the whole focus");
    assert.equal(call.state.architecture.evidence.bodies.length, body.state.frame.length, `${body.state.frame}: its own files and no other`);
    for (const file of call.state.architecture.evidence.bodies) opened.add(file.path);
    questions.push(...Object.keys(call.questions));
  }
  assert.deepEqual([...opened].sort(), ["dev/architecture-config.v1.json", "src/config.mjs", "web/app.mjs", "web/data/config.v1.json"]);
  assert.deepEqual([...questions].sort(), Object.keys(judgeSlotsFor(section)).sort(), "every question of the section, once");
  assert.ok(union.some(body => body.state.frame.length === 2), "a pair of two body files is asked with both whole");
  // One named part outside the source opens the same four files.
  assert.deepEqual([...judgeRequest("ext-localstorage").state.architecture.bodies].sort(),
    ["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"]);
});

test("measured, not assumed: what each focus sends the provider, by the Function's own builder", async t => {
  const { calls } = await withProvider(answering(noneTo), () => Promise.all([request(), intentRequest()].map(body => post(body, ARCHITECTURE_ENV))));
  for (const [index, call] of calls.entries()) {
    t.diagnostic(`${index === 0 ? "plain" : "intent"}: ${Buffer.byteLength(JSON.stringify(call))} bytes, `
      + `${Object.keys(call.questions).length} questions, code bytes 0`);
  }
  // Offline: this builder with the bound snapshot's own files, a stubbed provider,
  // no key - every locate frame the page would send, as the provider would get it.
  const sizes = [];
  for (const frame of locateRequests()) {
    const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(frame, ARCHITECTURE_ENV));
    assert.equal(result.status, 200, frame.state.architecture.focus[0]);
    const { bodies, lines } = call.state.architecture.evidence;
    sizes.push(Buffer.byteLength(JSON.stringify(call)));
    t.diagnostic(`locate ${frame.state.architecture.focus[0]} (offline): ${sizes.at(-1)} bytes, ${Object.keys(call.questions).length} question, `
      + `bodies [${bodies.map(file => `${file.path} ${Buffer.byteLength(file.text)}B`).join("; ")}], ${lines.length} neighbour lines`);
  }
  t.diagnostic(`locate frames (offline): ${sizes.length}, ${sizes.reduce((sum, size) => sum + size, 0)} bytes in all, largest ${Math.max(...sizes)} bytes`);
  // Every judge frame the page could send, likewise: each part alone - four of
  // them the scenario's named parts - and every part together, which holds
  // every pair of body files. Bytes as measured here, not tokens, and no limit.
  const ids = MANIFEST.entities.map(entity => entity.id);
  const named = ["web-app-mjs", "ext-jev-api-key", "ext-localstorage", "src-log-mjs"];
  for (const [label, focus] of [...ids.map(id => [named.includes(id) ? `${id} (scenario)` : id, [id]]), ["every-part", [...ids].sort()]]) {
    const frames = judgeRequests(focus);
    const totals = { payload: 0, text: 0, questions: 0 };
    for (const frame of frames) {
      const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(frame, ARCHITECTURE_ENV));
      assert.equal(result.status, 200, `${label} ${frame.state.frame}`);
      const { bodies, lines } = call.state.architecture.evidence;
      const measured = {
        payload: Buffer.byteLength(JSON.stringify(call)),
        state: Buffer.byteLength(JSON.stringify(call.state)),
        text: bodies.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
        questions: Object.keys(call.questions).length,
        longest: Math.max(...Object.values(call.questions).map(question => Buffer.byteLength(JSON.stringify(question)))),
      };
      for (const name of Object.keys(totals)) totals[name] += measured[name];
      t.diagnostic(`judge ${label} frame ${frame.state.frame.join("+")} (offline): payload ${measured.payload} bytes, state ${measured.state} bytes, `
        + `whole-file text ${measured.text} bytes, ${measured.questions} questions, longest question ${measured.longest} bytes, ${lines.length} neighbour lines`);
    }
    t.diagnostic(`judge ${label} (offline): ${frames.length} frames, ${totals.questions} questions, payload ${totals.payload} bytes in all, `
      + `whole-file text ${totals.text} bytes in all`);
  }
});
