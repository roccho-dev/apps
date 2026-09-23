import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";
import {
  ACTION_ADD_EDGE,
  DecisionRefused,
  buildCriteria,
  compileCommittedDecision,
  compileDecision,
  relationIdFor,
  selectableRegionIds,
} from "../src/decision/graph-edge.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");

// The pinned provider codec, not a stand-in: the projection is proven against
// the same semantic-map build the browser loads.
const protocol = await import(
  pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href
);

const node = (id, x) => ({
  type: "region",
  id,
  parent: "root",
  label: id,
  kind: "node",
  bounds: [x, 90, 140, 64],
  summary: "",
});

const baseGraph = () => protocol.createDecisionLog([
  { type: "meta", schema: "semantic-map-state/1", root: "root", title: "voice graph" },
  { type: "region", id: "root", parent: null, label: "voice graph", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  node("node-a", 40),
  node("node-b", 250),
  node("node-c", 460),
], "voice-graph");

// Authoritative answer shape: each choice carries its own confidence.
const answersFor = (source, target, confidence = 0.9) => ({
  action: { type: "choice", choice: ACTION_ADD_EDGE, confidence },
  source: { type: "choice", choice: source, confidence },
  target: { type: "choice", choice: target, confidence },
});

const compile = (graph, answers) =>
  compileDecision({
    graph,
    answers,
    protocol: { createDecision: protocol.createDecision, createEnvelope: protocol.createEnvelope },
  });

const compileCommitted = (graph, answers) =>
  compileCommittedDecision({
    graph,
    answers,
    protocol: {
      appendDecision: protocol.appendDecision,
      createDecision: protocol.createDecision,
      createEnvelope: protocol.createEnvelope,
    },
  });

// `relationsOf` reads the Proposal surface: base is what the runtime mounts,
// preview is what the Proposal would produce if accepted. It describes a
// proposal envelope correctly and must never be used to judge a committed one.
const relationsOf = async envelope => {
  const inspected = await protocol.inspectEnvelope(envelope);
  return {
    before: inspected.base.records.filter(record => record.type === "relation"),
    after: inspected.preview.records.filter(record => record.type === "relation"),
  };
};

// The committed surface is the one the runtime actually mounts. Asserting
// through `preview` here would pass for a Proposal too, which is exactly the
// confusion this helper exists to prevent.
const committedRelationsOf = async envelope => {
  const inspected = await protocol.inspectEnvelope(envelope);
  assert.equal(inspected.envelope.proposal, null, "a committed envelope carries no Proposal");
  assert.equal(inspected.preview, null, "a committed envelope has no preview");
  return inspected.base.records.filter(record => record.type === "relation");
};

const decisionLines = log => log.split("\n").filter(line => line.trim().length > 0);

test("criteria offer the graph's own regions verbatim and exclude the boundary", async () => {
  const graph = await baseGraph();
  assert.deepEqual(selectableRegionIds(graph.records), ["node-a", "node-b", "node-c"]);
  assert.deepEqual(buildCriteria(graph.records).regions, ["node-a", "node-b", "node-c"]);
});

test("a typed choice compiles to an envelope whose edge is absent before and present after", async () => {
  const graph = await baseGraph();
  const ir = await compile(graph, answersFor("node-a", "node-b"));

  assert.equal(ir.kind, "ui.ir.v1");
  assert.equal(ir.capability, "render.semantic-map");
  assert.equal(ir.payloadKind, "semantic-map-envelope/3");
  assert.equal(ir.payload.schema, "semantic-map-envelope/3");

  const { before, after } = await relationsOf(ir.payload);
  assert.deepEqual(before, []);
  assert.equal(after.length, 1);
  assert.equal(after[0].from, "node-a");
  assert.equal(after[0].to, "node-b");
  assert.equal(after[0].id, relationIdFor("node-a", "node-b"));
});

// The control that kills a constant compiler: only the answers change.
test("mutating only the typed answers moves the edge", async () => {
  const graph = await baseGraph();
  const seen = new Map();

  for (const [source, target] of [
    ["node-a", "node-b"],
    ["node-b", "node-a"],
    ["node-a", "node-c"],
    ["node-c", "node-b"],
  ]) {
    const ir = await compile(graph, answersFor(source, target));
    const { after } = await relationsOf(ir.payload);
    assert.equal(after.length, 1);
    seen.set(`${source}->${target}`, `${after[0].from}->${after[0].to}`);
  }

  assert.deepEqual([...seen.entries()], [
    ["node-a->node-b", "node-a->node-b"],
    ["node-b->node-a", "node-b->node-a"],
    ["node-a->node-c", "node-a->node-c"],
    ["node-c->node-b", "node-c->node-b"],
  ]);
  assert.equal(new Set(seen.values()).size, 4, "a constant compiler would collapse these");
});

test("the compiler refuses every answer it cannot ground, leaving the graph untouched", async () => {
  const graph = await baseGraph();
  const before = graph.records.filter(record => record.type === "relation");

  const refusals = [
    ["unknown region", answersFor("node-a", "node-z")],
    ["self loop", answersFor("node-a", "node-a")],
    ["low confidence", answersFor("node-a", "node-b", 0.1)],
    ["one weak answer", {
      ...answersFor("node-a", "node-b"),
      target: { type: "choice", choice: "node-b", confidence: 0.1 },
    }],
    ["missing per-answer confidence", {
      ...answersFor("node-a", "node-b"),
      source: { type: "choice", choice: "node-a" },
    }],
    ["declined action", {
      ...answersFor("node-a", "node-b"),
      action: { type: "choice", choice: "none", confidence: 0.9 },
    }],
    ["untyped answer", { ...answersFor("node-a", "node-b"), source: { type: "noul", noul: 1 } }],
    ["extra key", { ...answersFor("node-a", "node-b"), extra: 1 }],
    ["separate confidence answer", {
      ...answersFor("node-a", "node-b"),
      confidence: { type: "noul", noul: 0.9 },
    }],
  ];

  for (const [name, answers] of refusals) {
    await assert.rejects(compile(graph, answers), DecisionRefused, name);
  }

  assert.deepEqual(graph.records.filter(record => record.type === "relation"), before);
});

test("an edge that already exists is refused instead of duplicated", async () => {
  const graph = await baseGraph();
  const ir = await compile(graph, answersFor("node-a", "node-b"));
  const inspected = await protocol.inspectEnvelope(ir.payload);
  const applied = { ...graph, log: inspected.preview.log, head: inspected.preview.head, records: inspected.preview.records };

  await assert.rejects(compile(applied, answersFor("node-a", "node-b")), DecisionRefused);
});

// The two siblings differ in exactly one respect: which surface carries the
// edge. Proving both against the same pinned codec is what keeps the direct
// mode from quietly becoming the only mode.
test("the proposal sibling still leaves the mounted records untouched", async () => {
  const graph = await baseGraph();
  const ir = await compile(graph, answersFor("node-a", "node-b"));
  const inspected = await protocol.inspectEnvelope(ir.payload);

  assert.notEqual(inspected.envelope.proposal, null);
  assert.equal(inspected.envelope.log, graph.log, "a Proposal must not advance the log");
  assert.deepEqual(inspected.base.records.filter(record => record.type === "relation"), []);
  assert.equal(inspected.preview.records.filter(record => record.type === "relation").length, 1);
});

test("the committed sibling puts the edge in the records the runtime mounts", async () => {
  const graph = await baseGraph();
  const { ir } = await compileCommitted(graph, answersFor("node-c", "node-a"));

  assert.equal(ir.kind, "ui.ir.v1");
  assert.equal(ir.capability, "render.semantic-map");
  assert.equal(ir.payloadKind, "semantic-map-envelope/3");
  assert.equal(ir.payload.schema, "semantic-map-envelope/3");

  const relations = await committedRelationsOf(ir.payload);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].from, "node-c");
  assert.equal(relations[0].to, "node-a");
  assert.equal(relations[0].id, relationIdFor("node-c", "node-a"));
});

test("the committed log grows by exactly one Decision and the head is that Decision", async () => {
  const graph = await baseGraph();
  const { ir, graph: next } = await compileCommitted(graph, answersFor("node-c", "node-a"));

  assert.equal(decisionLines(next.log).length, decisionLines(graph.log).length + 1);
  assert.equal(next.log.slice(0, graph.log.length), graph.log, "the existing log is a prefix");
  assert.equal(ir.payload.log, next.log, "the envelope carries the appended log");
  assert.notEqual(next.head, graph.head);

  // `graph` is the provider's own verified state, not a hand-assembled object.
  const verified = await protocol.verifyDecisionLog(next.log);
  assert.equal(next.head, verified.head);
  assert.equal(next.stateHash, verified.stateHash);
});

test("the committed sibling refuses every answer it cannot ground and appends nothing", async () => {
  const graph = await baseGraph();
  const before = decisionLines(graph.log).length;

  const rejected = [
    { action: { type: "choice", choice: "none", confidence: 0.9 }, source: { type: "choice", choice: "node-a", confidence: 0.9 }, target: { type: "choice", choice: "node-b", confidence: 0.9 } },
    answersFor("node-a", "node-a"),
    answersFor("node-a", "node-b", 0.4),
    answersFor("node-a", "node-z"),
  ];

  for (const answers of rejected) {
    await assert.rejects(compileCommitted(graph, answers), DecisionRefused);
  }

  assert.equal(decisionLines(graph.log).length, before, "a refusal must not touch the input graph");
  assert.deepEqual(graph.records.filter(record => record.type === "relation"), []);
});

test("a committed path without the provider append primitive fails closed", async () => {
  const graph = await baseGraph();

  await assert.rejects(
    compileCommittedDecision({
      graph,
      answers: answersFor("node-c", "node-a"),
      protocol: { createDecision: protocol.createDecision, createEnvelope: protocol.createEnvelope },
    }),
    DecisionRefused,
  );
});

// The control that kills a constant compiler on the committed path too.
test("mutating only the typed answers moves the committed edge", async () => {
  const graph = await baseGraph();
  const seen = new Map();

  for (const [source, target] of [
    ["node-a", "node-b"],
    ["node-b", "node-a"],
    ["node-a", "node-c"],
    ["node-c", "node-b"],
  ]) {
    const { ir } = await compileCommitted(graph, answersFor(source, target));
    const relations = await committedRelationsOf(ir.payload);
    assert.equal(relations.length, 1);
    seen.set(`${source}->${target}`, `${relations[0].from}->${relations[0].to}`);
  }

  assert.deepEqual([...seen.entries()], [
    ["node-a->node-b", "node-a->node-b"],
    ["node-b->node-a", "node-b->node-a"],
    ["node-a->node-c", "node-a->node-c"],
    ["node-c->node-b", "node-c->node-b"],
  ]);
  assert.equal(new Set(seen.values()).size, 4, "a constant compiler would collapse these");
});

// The real version of the duplicate control: the second call reads the state
// the provider actually produced, not a hand-applied preview.
test("the real committed next graph refuses the same edge twice", async () => {
  const graph = await baseGraph();
  const { graph: next } = await compileCommitted(graph, answersFor("node-c", "node-a"));

  assert.deepEqual(
    next.records.filter(record => record.type === "relation").map(record => [record.from, record.to]),
    [["node-c", "node-a"]],
  );
  await assert.rejects(compileCommitted(next, answersFor("node-c", "node-a")), DecisionRefused);

  // A different edge on top of the committed state still compiles, and the log
  // grows again by exactly one.
  const { graph: third } = await compileCommitted(next, answersFor("node-a", "node-b"));
  assert.equal(decisionLines(third.log).length, decisionLines(next.log).length + 1);
});

const postJev = (body, env = { JEV_API_KEY: "test-key" }) =>
  onRequestPost({
    request: new Request("http://localhost/api/jev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  });

const withProviderResponse = async (payload, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
};

test("v1 requests keep their exact key set and a2ui response shape", async () => {
  const { result, calls } = await withProviderResponse(
    { model: "jev-1", answers: { live: { type: "noul", noul: 0.5 } } },
    () => postJev({ kind: "voice-ui.jev.request.v1", text: "hello" }),
  );

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "ui.ir.v1");
  assert.equal(body.capability, "a2ui-browser");
  assert.equal(body.payloadKind, "a2ui.surface.v1");
  assert.equal(body.payload.dataModel.score, "Jev Noul: 0.500");
  assert.deepEqual(Object.keys(calls[0].questions), ["live"]);

  const extraKey = await postJev({ kind: "voice-ui.jev.request.v1", text: "hello", graph: {} });
  assert.equal(extraKey.status, 422);
});

const providerAnswer = (choice, keys, confidence = 0.8) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? confidence : 0.1])),
});

const REGIONS = ["node-a", "node-b", "node-c"];

test("v2 requests enforce their own exact key set and return typed answers", async () => {
  const { result, calls } = await withProviderResponse(
    {
      model: "jev-1",
      answers: {
        action: providerAnswer("add-edge", ["add-edge", "none"]),
        source: providerAnswer("node-a", REGIONS),
        target: providerAnswer("node-b", REGIONS),
      },
    },
    () => postJev({
      kind: "voice-ui.jev.request.v2",
      text: "connect a to b",
      graph: { regions: REGIONS },
    }),
  );

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v2");
  assert.equal(body.answers.source.choice, "node-a");
  assert.equal(body.answers.target.choice, "node-b");
  assert.equal(body.answers.source.confidence, 0.8);

  // Choice questions offer a criteria map, never an options array, and the
  // redundant noul confidence question is gone.
  const questions = calls[0].questions;
  assert.deepEqual(Object.keys(questions), ["action", "source", "target"]);
  assert.deepEqual(Object.keys(questions.source.criteria), REGIONS);
  assert.deepEqual(Object.keys(questions.action.criteria), ["add-edge", "none"]);
  for (const name of ["action", "source", "target"]) {
    assert.equal(questions[name].type, "choice");
    assert.equal(questions[name].options, undefined);
    assert.ok(Object.values(questions[name].criteria).every(v => typeof v === "string"));
  }

  for (const bad of [
    { kind: "voice-ui.jev.request.v2", text: "x" },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["only-one"] } },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "a"] } },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "b"], extra: 1 } },
  ]) {
    assert.equal((await postJev(bad)).status, 422);
  }
});

test("a provider answer that breaks the typed contract fails closed", async () => {
  const offered = ["node-a", "node-b"];
  const wellFormed = {
    action: providerAnswer("add-edge", ["add-edge", "none"]),
    source: providerAnswer("node-a", offered),
    target: providerAnswer("node-b", offered),
  };

  const broken = {
    "choice outside the criteria": { ...wellFormed, source: providerAnswer("node-z", ["node-z"]) },
    "missing confidence": {
      ...wellFormed,
      source: { type: "choice", choice: "node-a", probabilities: { "node-a": 0.9 } },
    },
    "confidence outside [0,1]": {
      ...wellFormed,
      source: { ...wellFormed.source, confidence: 1.5 },
    },
    "probabilities key outside the criteria": {
      ...wellFormed,
      source: { ...wellFormed.source, probabilities: { "node-z": 0.9 } },
    },
    "non-numeric probability": {
      ...wellFormed,
      source: { ...wellFormed.source, probabilities: { "node-a": "high" } },
    },
    "missing probabilities": {
      ...wellFormed,
      source: { type: "choice", choice: "node-a", confidence: 0.8 },
    },
  };

  for (const [name, answers] of Object.entries(broken)) {
    const { result } = await withProviderResponse(
      { model: "jev-1", answers },
      () => postJev({
        kind: "voice-ui.jev.request.v2",
        text: "connect",
        graph: { regions: offered },
      }),
    );
    assert.equal(result.status, 502, name);
    assert.equal((await result.json()).error, "provider_contract_error", name);
  }
});

test("no key means no provider call at all", async () => {
  const response = await postJev({ kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "b"] } }, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "jev_unavailable");
});
