import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ACTION_ADD_EDGE, compileCommittedDecision } from "../src/decision/graph-edge.mjs";
import {
  HISTORY_KEY,
  HistoryConflict,
  HistoryPersistFailed,
  RESTORE_CORRUPT,
  RESTORE_EMPTY,
  RESTORE_RESTORED,
  persistHistory,
  projectHistory,
  restoreHistory,
} from "../src/decision/history.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");

// The pinned provider codec, not a stand-in. Corruption is detected by the same
// verifier the browser uses, so these tests prove the provider's guarantee
// rather than a re-implementation of it.
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

const answersFor = (source, target, confidence = 0.9) => ({
  action: { type: "choice", choice: ACTION_ADD_EDGE, confidence },
  source: { type: "choice", choice: source, confidence },
  target: { type: "choice", choice: target, confidence },
});

// The real committed path the browser takes, so the stored bytes under test are
// the bytes the app would actually write.
const withEdge = (graph, source, target) =>
  compileCommittedDecision({
    graph,
    answers: answersFor(source, target),
    protocol: {
      appendDecision: protocol.appendDecision,
      createDecision: protocol.createDecision,
      createEnvelope: protocol.createEnvelope,
    },
  }).then(committed => committed.graph);

// A storage double that records every call, so a test can assert what was NOT
// written as firmly as what was.
const fakeStorage = (initial = new Map()) => {
  const values = new Map(initial);
  const writes = [];
  return {
    values,
    writes,
    read: key => (values.has(key) ? values.get(key) : null),
    write: (key, value) => {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
};

const verifyDecisionLog = protocol.verifyDecisionLog;

// The CreateMap Decision every history of this app starts from. The initial
// graph is fixed, so its id is fixed too, and the browser derives it the same way.
const genesis = (await baseGraph()).head;
const restore = storage => restoreHistory({ read: storage.read, verifyDecisionLog, genesis });

// A well-formed history of some other map: it verifies, but it is not ours.
const foreignGraph = () => protocol.createDecisionLog([
  { type: "meta", schema: "semantic-map-state/1", root: "root", title: "other graph" },
  { type: "region", id: "root", parent: null, label: "other graph", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  node("node-z", 40),
  node("node-a", 250),
], "some-other-map");

test("an origin with nothing stored restores as empty, not as corrupt", async () => {
  const storage = fakeStorage();
  const restored = await restore(storage);

  assert.equal(restored.status, RESTORE_EMPTY);
  assert.equal(restored.graph, undefined);
  assert.equal(storage.writes.length, 0);
});

test("a persisted fresh graph restores with the initial graph and no confirmed facts", async () => {
  const graph = await baseGraph();
  const storage = fakeStorage();
  await persistHistory({ write: storage.write, graph });

  assert.deepEqual(storage.writes, [[HISTORY_KEY, graph.log]]);

  const restored = await restore(storage);
  assert.equal(restored.status, RESTORE_RESTORED);
  assert.equal(restored.graph.head, graph.head);
  assert.deepEqual(restored.projection.initial.regions, ["node-a", "node-b", "node-c"]);
  assert.deepEqual(restored.projection.initial.relations, []);
  assert.deepEqual(restored.projection.entries, []);
  assert.deepEqual(restored.projection.relations, []);
});

test("a persisted committed edge restores as one confirmed fact over an unchanged initial graph", async () => {
  const graph = await withEdge(await baseGraph(), "node-c", "node-a");
  const storage = fakeStorage();
  await persistHistory({ write: storage.write, graph });

  const restored = await restore(storage);
  assert.equal(restored.status, RESTORE_RESTORED);

  // The initial graph is still edgeless: the screen can tell "where we started"
  // from "what has been confirmed since".
  assert.deepEqual(restored.projection.initial.relations, []);
  assert.equal(restored.projection.entries.length, 1);
  assert.deepEqual(restored.projection.entries[0].facts, [{
    change: "added",
    kind: "relation",
    id: "voice-node-c-to-node-a",
    from: "node-c",
    to: "node-a",
  }]);
  assert.equal(restored.projection.entries[0].id, restored.graph.ids[1]);
  assert.deepEqual(
    restored.projection.relations.map(relation => [relation.from, relation.to]),
    [["node-c", "node-a"]],
  );
});

test("confirmed facts restore in the order they were committed", async () => {
  const first = await withEdge(await baseGraph(), "node-c", "node-a");
  const graph = await withEdge(first, "node-a", "node-b");
  const storage = fakeStorage();
  await persistHistory({ write: storage.write, graph });

  const restored = await restore(storage);
  assert.deepEqual(
    restored.projection.entries.map(entry => entry.facts[0]).map(fact => [fact.from, fact.to]),
    [["node-c", "node-a"], ["node-a", "node-b"]],
  );
  assert.deepEqual(restored.projection.entries.map(entry => entry.id), restored.graph.ids.slice(1));
});

// Every way a stored log can be wrong must land in exactly one place: corrupt,
// with the stored bytes untouched. None of these may restore a graph.
const corruptions = log => [
  ["an empty value", ""],
  ["a truncated log", log.slice(0, -5)],
  ["a log with no trailing LF", log.slice(0, -1)],
  ["a log with a blank line", `${log}\n`],
  ["a non-JSON line", `${log}not json\n`],
  ["a replayed Decision", `${log}${log.split("\n")[0]}\n`],
  // Canonical JSON sorts keys, so every line starts with "operations".
  ["a non-canonical line", log.replace('{"operations"', '{ "operations"')],
  ["a tampered region id", log.replace('"node-a"', '"node-z"')],
];

test("every corrupt stored log fails closed and is left exactly as it is", async () => {
  const graph = await withEdge(await baseGraph(), "node-c", "node-a");

  for (const [label, bytes] of corruptions(graph.log)) {
    assert.notEqual(bytes, graph.log, `${label} must actually differ from the good log`);

    const storage = fakeStorage(new Map([[HISTORY_KEY, bytes]]));
    const restored = await restore(storage);

    assert.equal(restored.status, RESTORE_CORRUPT, `${label} must restore as corrupt`);
    assert.equal(restored.graph, undefined, `${label} must not restore a graph`);
    assert.equal(restored.projection, undefined, `${label} must not restore a projection`);
    assert.equal(typeof restored.reason, "string", `${label} must carry a reason`);

    // Fail-closed never deletes or overwrites: the bytes stay for inspection and
    // only an explicit out-of-app clear can remove them.
    assert.equal(storage.writes.length, 0, `${label} must not write to storage`);
    assert.equal(storage.values.get(HISTORY_KEY), bytes, `${label} must leave the stored value`);
  }
});

test("a provider-valid log that is not this app's history fails closed", async () => {
  const sameShapeOtherMap = await protocol.createDecisionLog(
    (await baseGraph()).records,
    "some-other-map",
  );
  const foreign = [
    ["a foreign map with its own regions and a decision", (await withEdge(await foreignGraph(), "node-z", "node-a")).log],
    ["a foreign map with no decisions", (await foreignGraph()).log],
    ["this app's records under another map id", sameShapeOtherMap.log],
  ];

  for (const [label, bytes] of foreign) {
    // Precondition: the provider accepts it. Only the genesis binding refuses it.
    assert.ok((await verifyDecisionLog(bytes)).ids.length > 0, `${label} must verify on its own`);

    const storage = fakeStorage(new Map([[HISTORY_KEY, bytes]]));
    const restored = await restore(storage);

    assert.equal(restored.status, RESTORE_CORRUPT, `${label} must restore as corrupt`);
    assert.equal(restored.graph, undefined, `${label} must not restore a graph`);
    assert.equal(restored.projection, undefined, `${label} must not present facts`);
    assert.match(restored.reason, /genesis/u, `${label} must say why`);
    assert.equal(storage.writes.length, 0, `${label} must not write to storage`);
    assert.equal(storage.values.get(HISTORY_KEY), bytes, `${label} must leave the stored value`);
  }
});

test("restore refuses to run without the genesis it must bind to", async () => {
  const storage = fakeStorage();
  await assert.rejects(
    restoreHistory({ read: storage.read, verifyDecisionLog }),
    /genesis must be a non-empty string/u,
  );
});

test("a write that fails throws before anything can be bound or rendered", async () => {
  const graph = await baseGraph();
  const failure = new Error("quota exceeded");

  await assert.rejects(
    persistHistory({
      write: () => { throw failure; },
      graph,
    }),
    error => error instanceof HistoryPersistFailed && error.cause === failure,
  );
});

test("persist refuses a graph that carries no canonical log", async () => {
  const storage = fakeStorage();
  await assert.rejects(
    persistHistory({ write: storage.write, graph: { log: "" } }),
    /graph\.log must be a non-empty string/u,
  );
  assert.equal(storage.writes.length, 0);
});

test("projection refuses a verified log it cannot describe", async () => {
  await assert.rejects(projectHistory(null, { verifyDecisionLog }), /verified log is required/u);
  await assert.rejects(projectHistory({ decisions: [] }, { verifyDecisionLog }), /verified log has no Decisions/u);
  await assert.rejects(projectHistory(await baseGraph()), /verifyDecisionLog is required/u);
});

// Removals and reversals, committed through the provider exactly as the
// correction loop does it.
const commitOperations = async (graph, operations) => {
  const { decision } = await protocol.createDecision(graph.head, operations, graph.records);
  return (await protocol.appendDecision(graph.log, decision)).verified;
};

test("a removal is described with the endpoints the edge had before it", async () => {
  const added = await withEdge(await baseGraph(), "node-c", "node-a");
  const removed = await commitOperations(added, [
    { type: "RemoveSelection", regionIds: [], relationIds: ["voice-node-c-to-node-a"] },
  ]);

  const projection = await projectHistory(removed, { verifyDecisionLog });
  assert.deepEqual(projection.entries.map(entry => entry.facts), [
    [{ change: "added", kind: "relation", id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" }],
    [{ change: "removed", kind: "relation", id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" }],
  ]);
  assert.deepEqual(projection.relations, []);
});

test("a reversal is one entry: the old direction removed, the new one added", async () => {
  const added = await withEdge(await baseGraph(), "node-c", "node-a");
  const reversed = await commitOperations(added, [
    { type: "RemoveSelection", regionIds: [], relationIds: ["voice-node-c-to-node-a"] },
    { type: "ConnectRegions", relationId: "voice-node-a-to-node-c", from: "node-a", to: "node-c", kind: "flow", label: "" },
  ]);

  const storage = fakeStorage();
  await persistHistory({ write: storage.write, graph: reversed });
  const restored = await restore(storage);
  assert.equal(restored.status, RESTORE_RESTORED);
  assert.equal(restored.projection.entries.length, 2);
  assert.deepEqual(restored.projection.entries[1].facts, [
    { change: "removed", kind: "relation", id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" },
    { change: "added", kind: "relation", id: "voice-node-a-to-node-c", from: "node-a", to: "node-c" },
  ]);
  assert.deepEqual(restored.projection.initial.relations, []);
  assert.deepEqual(restored.projection.relations.map(relation => [relation.from, relation.to]), [["node-a", "node-c"]]);
});

test("a write is refused when another tab changed the stored log in between", async () => {
  const first = await withEdge(await baseGraph(), "node-c", "node-a");
  const other = await withEdge(await baseGraph(), "node-a", "node-b");
  const storage = fakeStorage();

  // Nothing stored yet: a page that expects nothing may write.
  await persistHistory({ write: storage.write, read: storage.read, expected: null, graph: first });
  assert.equal(storage.values.get(HISTORY_KEY), first.log);

  // A page that still believes storage is empty must not overwrite it.
  await assert.rejects(
    persistHistory({ write: storage.write, read: storage.read, expected: null, graph: other }),
    error => error instanceof HistoryConflict,
  );
  assert.equal(storage.values.get(HISTORY_KEY), first.log, "the other tab's history must survive");
  assert.equal(storage.writes.length, 1);

  // The page that read what is stored may write on top of it.
  const next = await withEdge(first, "node-a", "node-b");
  await persistHistory({ write: storage.write, read: storage.read, expected: first.log, graph: next });
  assert.equal(storage.values.get(HISTORY_KEY), next.log);
});
