import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";
import {
  ACTION_ADD_EDGE,
  DecisionRefused,
  buildCriteria,
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

const answersFor = (source, target, noul = 0.9) => ({
  action: { type: "choice", choice: ACTION_ADD_EDGE },
  source: { type: "choice", choice: source },
  target: { type: "choice", choice: target },
  confidence: { type: "noul", noul },
});

const compile = (graph, answers) =>
  compileDecision({
    graph,
    answers,
    protocol: { createDecision: protocol.createDecision, createEnvelope: protocol.createEnvelope },
  });

const relationsOf = async envelope => {
  const inspected = await protocol.inspectEnvelope(envelope);
  return {
    before: inspected.base.records.filter(record => record.type === "relation"),
    after: inspected.preview.records.filter(record => record.type === "relation"),
  };
};

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
    ["declined action", { ...answersFor("node-a", "node-b"), action: { type: "choice", choice: "none" } }],
    ["untyped answer", { ...answersFor("node-a", "node-b"), source: { type: "noul", noul: 1 } }],
    ["extra key", { ...answersFor("node-a", "node-b"), extra: 1 }],
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

test("v2 requests enforce their own exact key set and return typed answers", async () => {
  const { result, calls } = await withProviderResponse(
    {
      model: "jev-1",
      answers: {
        action: { type: "choice", choice: "add-edge" },
        source: { type: "choice", choice: "node-a" },
        target: { type: "choice", choice: "node-b" },
        confidence: { type: "noul", noul: 0.8 },
      },
    },
    () => postJev({
      kind: "voice-ui.jev.request.v2",
      text: "connect a to b",
      graph: { regions: ["node-a", "node-b", "node-c"] },
    }),
  );

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v2");
  assert.equal(body.answers.source.choice, "node-a");
  assert.equal(body.answers.target.choice, "node-b");
  assert.deepEqual(calls[0].questions.source.options, ["node-a", "node-b", "node-c"]);

  for (const bad of [
    { kind: "voice-ui.jev.request.v2", text: "x" },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["only-one"] } },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "a"] } },
    { kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "b"], extra: 1 } },
  ]) {
    assert.equal((await postJev(bad)).status, 422);
  }
});

test("a provider answer outside the offered regions fails closed", async () => {
  const { result } = await withProviderResponse(
    {
      model: "jev-1",
      answers: {
        action: { type: "choice", choice: "add-edge" },
        source: { type: "choice", choice: "node-z" },
        target: { type: "choice", choice: "node-b" },
        confidence: { type: "noul", noul: 0.8 },
      },
    },
    () => postJev({
      kind: "voice-ui.jev.request.v2",
      text: "connect",
      graph: { regions: ["node-a", "node-b"] },
    }),
  );

  assert.equal(result.status, 502);
  assert.equal((await result.json()).error, "provider_contract_error");
});

test("no key means no provider call at all", async () => {
  const response = await postJev({ kind: "voice-ui.jev.request.v2", text: "x", graph: { regions: ["a", "b"] } }, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "jev_unavailable");
});
