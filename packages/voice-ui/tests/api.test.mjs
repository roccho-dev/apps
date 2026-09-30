import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";
import worker from "../functions/pages-worker.mjs";
import { intentSectionOf, judgeRequestOf, locateRequestOf, readManifest } from "../src/architecture.mjs";
import {
  ACTION_ARCHITECTURE,
  ARCHITECTURE_INTENT_KIND,
  DECISION_KIND,
  ERRORS,
  NONE,
  REQUEST_KIND,
  WHOLE,
  YES,
  isJudgeRequest,
  isLocateRequest,
  isRequest,
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

test("every failure is one of a closed set of codes and carries no Jev content", async t => {
  // The refusal below logs its status; kept here, not printed with the results.
  t.mock.method(console, "warn", () => {});
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

test("a provider refusal logs only its numeric status, and the page still sees the same closed code", async t => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const status of [401, 429]) {
    warn.mock.resetCalls();
    const refusal = new Response("denied", { status });
    const clone = t.mock.method(refusal, "clone");
    const { result } = await withProvider(async () => refusal, () => post(request()));
    assert.equal(result.status, 502, `${status}`);
    assert.deepEqual(await result.json(), { error: ERRORS.providerError }, `${status}`);
    assert.deepEqual(warn.mock.calls.map(call => call.arguments), [[`{"event":"provider-status","status":${status}}`]]);
    assert.equal(JSON.stringify(warn.mock.calls).includes("denied"), false);
    assert.equal(refusal.bodyUsed, false, "the refusal's body is never read");
    assert.equal(clone.mock.callCount(), 0, "nor cloned");
  }

  warn.mock.resetCalls();
  assert.equal((await withProvider(answering(noneTo), () => post(request()))).result.status, 200);
  assert.equal((await withProvider(async () => { throw new TypeError("fetch failed"); }, () => post(request()))).result.status, 502);
  assert.equal(warn.mock.callCount(), 0, "an answer or an unreachable provider logs nothing");
});

test("a provider that never answers is a timeout after ten seconds, never a hang", async t => {
  const warn = t.mock.method(console, "warn", () => {});
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
  assert.equal(warn.mock.callCount(), 0, "a timeout logs nothing");
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
const MANIFEST = readManifest(prepared.manifest);
const intentRequest = (architecture = intentSectionOf(MANIFEST)) => ({ ...request({ architecture }), kind: ARCHITECTURE_INTENT_KIND });
const judgeRequest = focus => JSON.parse(JSON.stringify(judgeRequestOf(MANIFEST, Array.isArray(focus) ? focus : [focus], "show me that part")));
const locateRequest = () => JSON.parse(JSON.stringify(locateRequestOf(MANIFEST, intentRequest())));

// Whether any line of any admitted file - longer than a bare brace or keyword -
// appears in what was sent.
const carriesCode = sent => {
  const text = JSON.stringify(sent);
  return Object.values(prepared.evidence.files).some(file => file.split("\n")
    .some(line => line.trim().length >= 40 && text.includes(JSON.stringify(line).slice(1, -1))));
};

test("an architecture request without this server's prepared source is refused before the provider", async () => {
  const unavailable = { schema: "voice-ui.architecture-source/1", status: "unavailable", reason: "no exact commit" };
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
  const { result, calls } = await withProvider(answering(noneTo), () => post(locateRequest(),
    { JEV_API_KEY: "test-only-value", ARCHITECTURE: { manifest: prepared.manifest, evidence: { ...prepared.evidence, files: empty } } }));
  assert.equal(result.status, 200);
  assert.ok(calls[0].state.architecture.evidence.bodies.every(body => typeof body.text === "string"));
});

test("an architecture section that is not exactly this server's snapshot is refused before the provider", async () => {
  const own = intentSectionOf(MANIFEST);
  const judge = judgeRequest("src-log-mjs");
  const altered = [
    intentRequest({ ...own, source: { ...own.source, commit: "f".repeat(40) } }),
    intentRequest({ ...own, entities: own.entities.map((entity, index) => (index === 0 ? { ...entity, label: "renamed" } : entity)) }),
    intentRequest({ ...own, entities: own.entities.slice(1) }),
    { ...judge, state: { ...judge.state, architecture: { ...judge.state.architecture, bodies: ["web-app-mjs"] } } },
    { ...judge, state: { ...judge.state, architecture: { ...judge.state.architecture, candidates: judge.state.architecture.candidates.slice(1) } } },
    { ...judge, state: { ...judge.state, architecture: { ...judge.state.architecture, focus: ["src-session-mjs"] } } },
    { ...locateRequest(), state: { ...locateRequest().state, architecture: { source: { ...own.source, commit: "f".repeat(40) } } } },
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

test("a judge is asked from exactly its section's text: body files whole, other files by matching line", async () => {
  const body = judgeRequest("ext-jev-api-key");
  assert.ok(isJudgeRequest(body));
  const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(result.status, 200);
  const [call] = calls;
  const { evidence, ...sent } = call.state.architecture;
  assert.deepEqual(sent, body.state.architecture, "the page's section is forwarded unchanged");
  assert.deepEqual(evidence.bodies.map(file => file.path), ["functions/api/jev.mjs", "dev/serve.mjs"].sort(),
    "every admitted file that names the credential, whole");
  for (const file of evidence.bodies) assert.equal(file.text, fs.readFileSync(path.join(PACKAGE, file.path), "utf8"));
  assert.ok(evidence.lines.length > 0);
  for (const { path: file, line, text } of evidence.lines) {
    assert.equal(fs.readFileSync(path.join(PACKAGE, file), "utf8").split("\n")[line - 1], text, `${file}:${line} is that very line`);
  }
  const slots = judgeSlotsFor(body.state.architecture);
  assert.deepEqual(Object.keys(call.questions), Object.keys(slots));
  for (const [name, question] of Object.entries(call.questions)) assert.deepEqual(Object.keys(question.criteria), slots[name], name);
  assert.deepEqual(slots[roleSlot("functions-api-jev-mjs", "auth")], [YES, NONE]);
  assert.match(call.questions[relationSlot("c-functions-api-jev-mjs--ext-jev-api-key")].instructions, /identifier:JEV_API_KEY/u);
  const answered = await result.text();
  assert.equal(answered.includes(evidence.bodies[0].text.slice(0, 200)), false, "no admitted text in the answer");
});

test("a locate carries no code from the page; the server adds every admitted file whole and asks of every part", async () => {
  const body = locateRequest();
  assert.ok(isLocateRequest(body));
  assert.equal(carriesCode(body), false, "the page sends no line of code");
  const { result, calls } = await withProvider(answering(noneTo), () => post(body, ARCHITECTURE_ENV));
  assert.equal(result.status, 200);
  const [call] = calls;
  const { evidence, ...sent } = call.state.architecture;
  assert.deepEqual({ ...call.state, architecture: sent }, body.state, "the page's state is forwarded unchanged");
  const files = MANIFEST.entities.filter(entity => entity.kind === "file");
  assert.deepEqual(Object.keys(evidence), ["bodies"]);
  assert.deepEqual(evidence.bodies.map(file => file.path), files.map(entity => entity.path), "exactly the admitted files, no stand-in for an outside part");
  for (const file of evidence.bodies) assert.equal(file.text, fs.readFileSync(path.join(PACKAGE, file.path), "utf8"), `${file.path} is that very file`);
  const slots = locateSlotsFor(MANIFEST.entities.map(entity => entity.id));
  assert.deepEqual(Object.keys(call.questions), Object.keys(slots), "one question per part the snapshot knows");
  for (const [name, question] of Object.entries(call.questions)) assert.deepEqual(Object.keys(question.criteria), [YES, NONE], name);
  assert.match(call.questions[relevantSlot("ext-localstorage")].instructions, /outside the source/u);
  const answered = await result.text();
  assert.equal(answered.includes(evidence.bodies[0].text.slice(0, 200)), false, "no admitted text in the answer");
});

test("a locate or judge the page shapes otherwise, or the provider answers incompletely, is refused", async () => {
  const locate = locateRequest();
  const shaped = [
    { ...locate, state: { ...locate.state, architecture: { ...locate.state.architecture, evidence: { bodies: [] } } } },
    { ...locate, state: { ...locate.state, graph: { regions: [], edges: [], placeable: [] } } },
    { ...judgeRequest("src-log-mjs"), state: { ...judgeRequest("src-log-mjs").state, architecture: { ...judgeRequest("src-log-mjs").state.architecture, focus: "src-log-mjs" } } },
    { ...judgeRequest("web-app-mjs"), state: { ...judgeRequest("web-app-mjs").state, architecture: { ...judgeRequest("web-app-mjs").state.architecture, focus: ["web-app-mjs", "src-log-mjs"] } } },
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
});

test("a judge of several parts is one section, the server's own, with every file they open", async () => {
  const union = judgeRequest(["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"]);
  assert.ok(isJudgeRequest(union));
  const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(union, ARCHITECTURE_ENV));
  assert.equal(result.status, 200);
  assert.deepEqual(call.state.architecture.evidence.bodies.map(file => file.path).sort(),
    ["dev/architecture-config.v1.json", "src/config.mjs", "web/app.mjs", "web/data/config.v1.json"]);
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
  // Offline: this builder with the bound snapshot's own files, a stubbed provider, no key.
  const { calls: [locate] } = await withProvider(answering(noneTo), () => post(locateRequest(), ARCHITECTURE_ENV));
  t.diagnostic(`locate (offline): ${Buffer.byteLength(JSON.stringify(locate))} bytes, ${Object.keys(locate.questions).length} questions, `
    + `${locate.state.architecture.evidence.bodies.length} bodies (${locate.state.architecture.evidence.bodies.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0)}B of text)`);
  for (const focus of ["web-app-mjs", "ext-jev-api-key", "ext-localstorage", "src-log-mjs",
    ["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"]]) {
    const { result, calls: [call] } = await withProvider(answering(noneTo), () => post(judgeRequest(focus), ARCHITECTURE_ENV));
    assert.equal(result.status, 200, focus);
    const { bodies, lines } = call.state.architecture.evidence;
    const ranges = Object.entries(Object.groupBy(lines, entry => entry.path)).map(([file, entries]) => `${file}:${entries.map(entry => entry.line).join(",")}`);
    t.diagnostic(`judge ${focus}: ${Buffer.byteLength(JSON.stringify(call))} bytes, ${Object.keys(call.questions).length} questions, `
      + `bodies [${bodies.map(file => `${file.path} ${Buffer.byteLength(file.text)}B`).join("; ")}], `
      + `neighbour lines [${ranges.join("; ")}] (${lines.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)}B)`);
  }
});
