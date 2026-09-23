import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { DecisionRefused } from "../src/decision/graph-edge.mjs";
import {
  ACTION_ADD,
  ACTION_NONE,
  ACTION_REMOVE,
  ACTION_REVERSE,
  OUTCOME_NO_CHANGE,
  OUTCOME_PROPOSED,
  confirmProposal,
  correctionCriteria,
  edgesOf,
  focusFor,
  proposeCorrection,
} from "../src/decision/correction.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");

// The pinned provider codec, not a stand-in.
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

const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence });

// Answers shaped exactly like the questions a graph gets asked: the edge
// question exists only when there is an edge.
const answersFor = (graph, { action, source = "node-a", target = "node-b", edge, confidence = 0.9 }) => {
  const answers = {
    action: choice(action, confidence),
    source: choice(source, confidence),
    target: choice(target, confidence),
  };
  if (edgesOf(graph.records).length > 0) answers.edge = choice(edge ?? edgesOf(graph.records)[0].id, confidence);
  return answers;
};

const propose = (graph, spec) =>
  proposeCorrection({ graph, answers: answersFor(graph, spec), protocol });

const confirm = (graph, proposal) => confirmProposal({ graph, proposal, protocol });

const edges = graph => edgesOf(graph.records).map(edge => `${edge.from}->${edge.to}`);

const commit = async (graph, spec) => {
  const proposed = await propose(graph, spec);
  assert.equal(proposed.outcome, OUTCOME_PROPOSED);
  return (await confirm(graph, proposed.proposal)).graph;
};

const inspected = async ir => {
  const view = await protocol.inspectEnvelope(ir.payload);
  const pairs = records => records.filter(r => r.type === "relation").map(r => `${r.from}->${r.to}`);
  return { base: pairs(view.base.records), preview: view.preview ? pairs(view.preview.records) : null };
};

test("an edgeless graph is only offered add or no change", async () => {
  const criteria = correctionCriteria((await baseGraph()).records);
  assert.deepEqual(criteria.actions, [ACTION_ADD, ACTION_NONE]);
  assert.deepEqual(criteria.edges, []);
  assert.deepEqual(criteria.regions, ["node-a", "node-b", "node-c"]);
});

test("a graph with an edge is also offered removing or reversing it", async () => {
  const graph = await commit(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const criteria = correctionCriteria(graph.records);
  assert.deepEqual(criteria.actions, [ACTION_ADD, ACTION_REMOVE, ACTION_REVERSE, ACTION_NONE]);
  assert.deepEqual(criteria.edges, ["voice-node-c-to-node-a"]);
});

test("a proposal is shown but not applied: the log and graph are untouched", async () => {
  const graph = await baseGraph();
  const proposed = await propose(graph, { action: ACTION_ADD, source: "node-c", target: "node-a" });

  assert.equal(proposed.outcome, OUTCOME_PROPOSED);
  assert.equal(proposed.proposal.head, graph.head);
  assert.deepEqual(proposed.proposal.changes, [{ change: "added", from: "node-c", to: "node-a" }]);
  assert.deepEqual(await inspected(proposed.ir), { base: [], preview: ["node-c->node-a"] });

  const again = await protocol.verifyDecisionLog(graph.log);
  assert.equal(again.head, graph.head, "proposing must not append");
  assert.deepEqual(edges(graph), []);
});

test("confirming applies exactly the proposed change", async () => {
  const graph = await baseGraph();
  const proposed = await propose(graph, { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const confirmed = await confirm(graph, proposed.proposal);

  assert.deepEqual(edges(confirmed.graph), ["node-c->node-a"]);
  assert.equal(confirmed.graph.decisions.length, 2);
  assert.deepEqual(await inspected(confirmed.ir), { base: ["node-c->node-a"], preview: null });
});

test("no action and low confidence are a neutral no-change, not an error", async () => {
  const graph = await baseGraph();
  const none = await propose(graph, { action: ACTION_NONE });
  assert.equal(none.outcome, OUTCOME_NO_CHANGE);
  assert.match(none.reason, /no graph change/u);

  const unsure = await propose(graph, { action: ACTION_ADD, source: "node-c", target: "node-a", confidence: 0.3 });
  assert.equal(unsure.outcome, OUTCOME_NO_CHANGE);
  assert.match(unsure.reason, /not confident/u);
  assert.equal(unsure.proposal, undefined);
});

test("a change the graph cannot carry out is refused", async () => {
  const graph = await commit(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });

  await assert.rejects(
    propose(graph, { action: ACTION_ADD, source: "node-b", target: "node-b" }),
    error => error instanceof DecisionRefused && /same region/u.test(error.message),
  );
  await assert.rejects(
    propose(graph, { action: ACTION_ADD, source: "node-c", target: "node-a" }),
    error => error instanceof DecisionRefused && /already exists/u.test(error.message),
  );
  await assert.rejects(
    propose(graph, { action: ACTION_REMOVE, edge: "voice-node-a-to-node-b" }),
    error => error instanceof DecisionRefused && /outside the offered criteria/u.test(error.message),
  );
});

test("an edgeless graph refuses remove, reverse and an edge answer", async () => {
  const graph = await baseGraph();
  await assert.rejects(
    proposeCorrection({ graph, answers: { ...answersFor(graph, { action: ACTION_ADD }), action: choice(ACTION_REMOVE) }, protocol }),
    /action\.choice is outside the offered criteria/u,
  );
  await assert.rejects(
    proposeCorrection({ graph, answers: { ...answersFor(graph, { action: ACTION_ADD }), edge: choice("x") }, protocol }),
    /answers\.edge is not allowed/u,
  );
});

test("removing an edge is proposed, then applied on confirmation", async () => {
  const graph = await commit(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const proposed = await propose(graph, { action: ACTION_REMOVE, edge: "voice-node-c-to-node-a" });

  assert.deepEqual(proposed.proposal.changes, [{ change: "removed", from: "node-c", to: "node-a" }]);
  assert.deepEqual(await inspected(proposed.ir), { base: ["node-c->node-a"], preview: [] });
  assert.deepEqual(edges((await confirm(graph, proposed.proposal)).graph), []);
});

test("reversing is one atomic Decision: a removal and an addition", async () => {
  const graph = await commit(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const proposed = await propose(graph, { action: ACTION_REVERSE, edge: "voice-node-c-to-node-a" });

  assert.equal(proposed.proposal.action, ACTION_REVERSE);
  assert.deepEqual(proposed.proposal.decision.operations.map(operation => operation.type), ["RemoveSelection", "ConnectRegions"]);
  assert.deepEqual(proposed.proposal.changes, [
    { change: "removed", from: "node-c", to: "node-a" },
    { change: "added", from: "node-a", to: "node-c" },
  ]);
  assert.deepEqual(await inspected(proposed.ir), { base: ["node-c->node-a"], preview: ["node-a->node-c"] });

  const reversed = (await confirm(graph, proposed.proposal)).graph;
  assert.deepEqual(edgesOf(reversed.records), [{ id: "voice-node-a-to-node-c", from: "node-a", to: "node-c" }]);
  assert.equal(reversed.decisions.length, 3, "a reverse is one Decision, not two");

  // The id follows the direction, so the original direction can be added back.
  const readded = await commit(reversed, { action: ACTION_ADD, source: "node-c", target: "node-a" });
  assert.deepEqual(edges(readded).sort(), ["node-a->node-c", "node-c->node-a"]);
});

test("reversing onto an edge that already exists is refused", async () => {
  const one = await commit(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const both = await commit(one, { action: ACTION_ADD, source: "node-a", target: "node-c", edge: "voice-node-c-to-node-a" });
  await assert.rejects(
    propose(both, { action: ACTION_REVERSE, edge: "voice-node-c-to-node-a" }),
    error => error instanceof DecisionRefused && /reversed edge already exists/u.test(error.message),
  );
});

test("a proposal made on a graph that has since moved on is refused as stale", async () => {
  const graph = await baseGraph();
  const first = await propose(graph, { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const second = await propose(graph, { action: ACTION_ADD, source: "node-a", target: "node-b" });
  const moved = (await confirm(graph, second.proposal)).graph;

  await assert.rejects(
    confirm(moved, first.proposal),
    error => error instanceof DecisionRefused && /stale/u.test(error.message),
  );
  // Even if a caller skipped the head check, the provider refuses to append it.
  await assert.rejects(
    confirmProposal({ graph: moved, proposal: { ...first.proposal, head: moved.head }, protocol }),
    error => error instanceof DecisionRefused && /provider refused/u.test(error.message),
  );
  assert.deepEqual(edges(moved), ["node-a->node-b"]);
});

test("confirming without a proposal is refused", async () => {
  await assert.rejects(confirm(await baseGraph(), null), /there is no proposal/u);
});

test("the focus is the pending proposal, else the last confirmed change, else nothing", () => {
  const changes = [{ change: "added", from: "node-c", to: "node-a" }];
  assert.deepEqual(focusFor({ proposal: { changes } }), { kind: "proposal", changes });
  assert.deepEqual(focusFor({ lastConfirmed: changes }), { kind: "confirmed", changes });
  assert.deepEqual(focusFor({ proposal: { changes }, lastConfirmed: [] }).kind, "proposal");
  assert.deepEqual(focusFor({}), { kind: "none", changes: [] });
});
