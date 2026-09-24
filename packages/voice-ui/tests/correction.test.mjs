import assert from "node:assert/strict";
import path from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";
import { DecisionRefused } from "../src/decision/graph-edge.mjs";
import {
  ACTION_ADD,
  ACTION_NONE,
  ACTION_REMOVE,
  ACTION_REVERSE,
  ACTION_REVERT,
  ACTION_UNDO_REQUEST,
  DRAFT_MAX,
  OPTION_NONE,
  OUTCOME_NO_CHANGE,
  OUTCOME_STEP,
  appendStep,
  correctionCriteria,
  edgesOf,
  focusFor,
  planStep,
  revertStep,
} from "../src/decision/correction.mjs";
import { statesOf } from "../src/decision/history.mjs";

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

// Answers shaped exactly like the questions a working graph gets asked: the
// edge question exists only when there is an edge.
const answersFor = (graph, { action, source = "node-a", target = "node-b", edge, confidence = 0.9 }) => {
  const answers = {
    action: choice(action, confidence),
    source: choice(source, confidence),
    target: choice(target, confidence),
  };
  if (edgesOf(graph.records).length > 0) answers.edge = choice(edge ?? edgesOf(graph.records)[0].id, confidence);
  return answers;
};

const plan = (working, spec, revision = working.head) =>
  planStep({ working, revision, answers: answersFor(working, spec), protocol });

const edges = graph => edgesOf(graph.records).map(edge => `${edge.from}->${edge.to}`);

// One working step, planned and appended exactly as the page does it.
const step = async (working, spec) => {
  const planned = await plan(working, spec);
  assert.equal(planned.outcome, OUTCOME_STEP);
  return appendStep({ working, step: planned.step, protocol });
};

const verifyDecisionLog = protocol.verifyDecisionLog;

test("an edgeless working graph is offered add, undo-request or no change, and every slot offers none", async () => {
  const criteria = correctionCriteria((await baseGraph()).records);
  assert.deepEqual(criteria.actions, [ACTION_ADD, ACTION_UNDO_REQUEST, ACTION_NONE]);
  assert.deepEqual(criteria.edges, []);
  assert.deepEqual(criteria.regions, ["node-a", "node-b", "node-c", OPTION_NONE]);
});

test("a working graph with an edge is also offered removing or reversing it, or no edge", async () => {
  const working = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const criteria = correctionCriteria(working.records);
  assert.deepEqual(criteria.actions, [ACTION_ADD, ACTION_REMOVE, ACTION_REVERSE, ACTION_UNDO_REQUEST, ACTION_NONE]);
  assert.deepEqual(criteria.edges, ["voice-node-c-to-node-a", OPTION_NONE]);
});

test("planning builds a provider Decision on the working head and appends nothing", async () => {
  const working = await baseGraph();
  const planned = await plan(working, { action: ACTION_ADD, source: "node-c", target: "node-a" });

  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.revision, working.head);
  assert.equal(planned.step.decision.parent, working.head);
  assert.deepEqual(planned.step.changes, [{ change: "added", from: "node-c", to: "node-a" }]);
  assert.equal((await verifyDecisionLog(working.log)).head, working.head, "planning must not append");
  assert.deepEqual(edges(working), []);
});

test("appending a step adds exactly one Decision to the working log", async () => {
  const base = await baseGraph();
  const working = await step(base, { action: ACTION_ADD, source: "node-c", target: "node-a" });
  assert.deepEqual(edges(working), ["node-c->node-a"]);
  assert.equal(working.decisions.length, base.decisions.length + 1);
  assert.ok(working.log.startsWith(base.log), "the earlier log must be an exact prefix");
});

test("undo-request, none, a none slot and low confidence are neutral no-changes", async () => {
  const empty = await baseGraph();
  const working = await step(empty, { action: ACTION_ADD, source: "node-c", target: "node-a" });

  const undo = await plan(working, { action: ACTION_UNDO_REQUEST });
  assert.equal(undo.outcome, OUTCOME_NO_CHANGE);
  assert.equal(undo.undoRequest, true);
  assert.match(undo.reason, /元に戻す/u);
  assert.equal(undo.step, undefined, "a spoken undo must never become a graph change");

  for (const [label, spec, pattern] of [
    ["none", { action: ACTION_NONE }, /no graph change/u],
    ["no start node", { action: ACTION_ADD, source: OPTION_NONE, target: "node-b" }, /did not name two/u],
    ["no end node", { action: ACTION_ADD, source: "node-a", target: OPTION_NONE }, /did not name two/u],
    ["no edge", { action: ACTION_REMOVE, edge: OPTION_NONE }, /did not name an existing edge/u],
    ["unsure", { action: ACTION_ADD, source: "node-a", target: "node-b", confidence: 0.3 }, /not confident/u],
  ]) {
    const answer = await plan(working, spec);
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE, label);
    assert.match(answer.reason, pattern, label);
    assert.equal(answer.step, undefined, label);
  }
});

test("a change the working graph cannot carry out is refused", async () => {
  const working = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });

  await assert.rejects(
    plan(working, { action: ACTION_ADD, source: "node-b", target: "node-b" }),
    error => error instanceof DecisionRefused && /same region/u.test(error.message),
  );
  await assert.rejects(
    plan(working, { action: ACTION_ADD, source: "node-c", target: "node-a" }),
    error => error instanceof DecisionRefused && /already exists/u.test(error.message),
  );
  await assert.rejects(
    plan(working, { action: ACTION_REMOVE, edge: "voice-node-a-to-node-b" }),
    error => error instanceof DecisionRefused && /outside the offered criteria/u.test(error.message),
  );
});

test("an edgeless working graph refuses remove, reverse and an edge answer", async () => {
  const working = await baseGraph();
  await assert.rejects(
    planStep({ working, revision: working.head, answers: { ...answersFor(working, { action: ACTION_ADD }), action: choice(ACTION_REMOVE) }, protocol }),
    /action\.choice is outside the offered criteria/u,
  );
  await assert.rejects(
    planStep({ working, revision: working.head, answers: { ...answersFor(working, { action: ACTION_ADD }), edge: choice("x") }, protocol }),
    /answers\.edge is not allowed/u,
  );
});

test("removing and reversing are steps; a reverse is one Decision holding both halves", async () => {
  const added = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });

  const removal = await plan(added, { action: ACTION_REMOVE, edge: "voice-node-c-to-node-a" });
  assert.deepEqual(removal.step.changes, [{ change: "removed", from: "node-c", to: "node-a" }]);
  assert.deepEqual(edges(await appendStep({ working: added, step: removal.step, protocol })), []);

  const reversal = await plan(added, { action: ACTION_REVERSE, edge: "voice-node-c-to-node-a" });
  assert.equal(reversal.step.action, ACTION_REVERSE);
  assert.deepEqual(reversal.step.decision.operations.map(operation => operation.type), ["RemoveSelection", "ConnectRegions"]);
  assert.deepEqual(reversal.step.changes, [
    { change: "removed", from: "node-c", to: "node-a" },
    { change: "added", from: "node-a", to: "node-c" },
  ]);
  const reversed = await appendStep({ working: added, step: reversal.step, protocol });
  assert.deepEqual(edgesOf(reversed.records), [{ id: "voice-node-a-to-node-c", from: "node-a", to: "node-c" }]);
  assert.equal(reversed.decisions.length, added.decisions.length + 1, "a reverse is one Decision, not two");

  // The id follows the direction, so the original direction can be added back.
  const readded = await step(reversed, { action: ACTION_ADD, source: "node-c", target: "node-a" });
  assert.deepEqual(edges(readded).sort(), ["node-a->node-c", "node-c->node-a"]);
});

test("reversing onto an edge that already exists is refused", async () => {
  const one = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const both = await step(one, { action: ACTION_ADD, source: "node-a", target: "node-c", edge: "voice-node-c-to-node-a" });
  await assert.rejects(
    plan(both, { action: ACTION_REVERSE, edge: "voice-node-c-to-node-a" }),
    error => error instanceof DecisionRefused && /reversed edge already exists/u.test(error.message),
  );
});

test("an answer about a working revision that has since moved is refused as stale", async () => {
  const asked = await baseGraph();
  const moved = await step(asked, { action: ACTION_ADD, source: "node-a", target: "node-b" });

  // The answer was requested against `asked`; the working graph is now `moved`.
  await assert.rejects(
    plan(moved, { action: ACTION_ADD, source: "node-c", target: "node-a" }, asked.head),
    error => error instanceof DecisionRefused && /stale/u.test(error.message),
  );

  // A step planned on the old head cannot be appended to the new one.
  const planned = await plan(asked, { action: ACTION_ADD, source: "node-c", target: "node-a" });
  await assert.rejects(
    appendStep({ working: moved, step: planned.step, protocol }),
    error => error instanceof DecisionRefused && /stale/u.test(error.message),
  );
  // Even with the revision relabelled, the provider refuses the append.
  await assert.rejects(
    appendStep({ working: moved, step: { ...planned.step, revision: moved.head }, protocol }),
    error => error instanceof DecisionRefused && /provider refused/u.test(error.message),
  );
  assert.deepEqual(edges(moved), ["node-a->node-b"]);
});

// A saved log of several entries, and the provider states on either side of
// each, exactly as the page reads them for 取り消しを作業図に追加.
const savedWith = async specs => {
  let graph = await baseGraph();
  for (const spec of specs) graph = await step(graph, spec);
  return { graph, states: await statesOf(graph.log, verifyDecisionLog) };
};

test("reverting an added edge adds its removal to the working graph", async () => {
  const { graph, states } = await savedWith([{ action: ACTION_ADD, source: "node-c", target: "node-a" }]);
  const revert = await revertStep({ before: states[0], after: states[1], working: graph, protocol });

  assert.equal(revert.action, ACTION_REVERT);
  assert.equal(revert.revision, graph.head);
  assert.deepEqual(revert.changes, [{ change: "removed", from: "node-c", to: "node-a" }]);
  const working = await appendStep({ working: graph, step: revert, protocol });
  assert.deepEqual(edges(working), []);
  assert.equal(working.decisions.length, graph.decisions.length + 1, "a revert adds a Decision; it removes none");
  assert.ok(working.log.startsWith(graph.log));
});

test("reverting a removal puts the edge back with its id, kind and label", async () => {
  const { graph, states } = await savedWith([
    { action: ACTION_ADD, source: "node-c", target: "node-a" },
    { action: ACTION_REMOVE, edge: "voice-node-c-to-node-a" },
  ]);
  const revert = await revertStep({ before: states[1], after: states[2], working: graph, protocol });
  assert.deepEqual(revert.changes, [{ change: "added", from: "node-c", to: "node-a" }]);

  const working = await appendStep({ working: graph, step: revert, protocol });
  const restored = working.records.find(record => record.type === "relation");
  const original = states[1].find(record => record.type === "relation");
  assert.deepEqual(restored, original);
});

test("reverting a reverse turns the edge back in one Decision", async () => {
  const { graph, states } = await savedWith([
    { action: ACTION_ADD, source: "node-c", target: "node-a" },
    { action: ACTION_REVERSE, edge: "voice-node-c-to-node-a" },
  ]);
  const revert = await revertStep({ before: states[1], after: states[2], working: graph, protocol });
  assert.deepEqual(revert.changes, [
    { change: "removed", from: "node-a", to: "node-c" },
    { change: "added", from: "node-c", to: "node-a" },
  ]);
  const working = await appendStep({ working: graph, step: revert, protocol });
  assert.deepEqual(edges(working), ["node-c->node-a"]);
});

test("a revert that a later change has overtaken is refused, and nothing changes", async () => {
  const { graph, states } = await savedWith([{ action: ACTION_ADD, source: "node-c", target: "node-a" }]);
  const later = await step(graph, { action: ACTION_REVERSE, edge: "voice-node-c-to-node-a" });

  await assert.rejects(
    revertStep({ before: states[0], after: states[1], working: later, protocol }),
    error => error instanceof DecisionRefused && /later change/u.test(error.message),
  );
  assert.deepEqual(edges(later), ["node-a->node-c"]);
});

test("only edge changes can be reverted", async () => {
  const graph = await baseGraph();
  const withRegion = [...graph.records, { ...graph.records.find(record => record.id === "node-a"), id: "node-d" }];
  await assert.rejects(
    revertStep({ before: graph.records, after: withRegion, working: graph, protocol }),
    /only edge changes can be reverted/u,
  );
});

test("the focus is the latest working step, else the latest applied change, else nothing", () => {
  const first = [{ change: "added", from: "node-c", to: "node-a" }];
  const latest = [{ change: "added", from: "node-a", to: "node-b" }];
  assert.deepEqual(focusFor({ draft: [{ changes: first }, { changes: latest }] }), { kind: "draft", changes: latest });
  assert.deepEqual(focusFor({ lastApplied: first }), { kind: "applied", changes: first });
  assert.equal(focusFor({ draft: [{ changes: latest }], lastApplied: first }).kind, "draft");
  assert.deepEqual(focusFor({}), { kind: "none", changes: [] });
  assert.equal(DRAFT_MAX, 8);
});

// The Pages Function side of v5: which questions are put to Jev for a given
// working graph, draft, focus and recent conversation, and what shape comes
// back. Only the request moved to v5; the answer is still decision.v4.

const postJev = body =>
  onRequestPost({
    request: new Request("http://localhost/api/jev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env: { JEV_API_KEY: "test-key" },
  });

const withProvider = async (answers, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ model: "jev-test", answers }), {
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

const providerChoice = (value, keys, confidence = 0.8) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: Object.fromEntries(keys.map(key => [key, key === value ? confidence : 0.1])),
});

const REGIONS = ["node-a", "node-b", "node-c"];
const NODE_KEYS = [...REGIONS, "none"];
const EDGE = { id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" };
const ADDED = { change: "added", from: "node-c", to: "node-a" };

const v5 = ({
  utterance = "reverse that edge",
  edges = [],
  draft = [],
  focus = { kind: "none", changes: [] },
  recent = [],
} = {}) => ({
  kind: "voice-ui.jev.request.v5",
  state: { utterance, working: { regions: REGIONS, edges }, draft, focus, context: { recent } },
});

// Earlier utterances as the page sends them: one per outcome.
const HEARD = [
  { seq: 1, source: "typed", text: "b is the database", outcome: "no-change" },
  { seq: 2, source: "voice", text: "ADD AN EDGE FROM C TO A", outcome: "step", effect: { changes: [ADDED] } },
  { seq: 4, source: "typed", text: "undo that", outcome: "undo-request" },
  { seq: 5, source: "typed", text: "add an edge from c to c", outcome: "refused" },
  { seq: 7, source: "voice", text: "ADD AN EDGE FROM A TO B", outcome: "undone" },
];

test("v5 on an edgeless working graph asks only about adding, and forwards the named state object", async () => {
  const request = v5({ utterance: "add an edge from c to a" });
  const { result, calls } = await withProvider({
    action: providerChoice("add-edge", ["add-edge", "undo-request", "none"]),
    source: providerChoice("node-c", NODE_KEYS),
    target: providerChoice("node-a", NODE_KEYS),
  }, () => postJev(request));

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v4");
  assert.deepEqual(Object.keys(body.answers), ["action", "source", "target"]);

  const [call] = calls;
  assert.deepEqual(call.state, request.state, "Jev gets the page's state object, unchanged");
  assert.deepEqual(Object.keys(call.questions), ["action", "source", "target"]);
  assert.deepEqual(Object.keys(call.questions.action.criteria), ["add-edge", "undo-request", "none"]);
  assert.deepEqual(Object.keys(call.questions.source.criteria), NODE_KEYS);
  assert.deepEqual(Object.keys(call.questions.target.criteria), NODE_KEYS);
});

test("v5 with a working edge offers remove, reverse, that edge or none, and feeds planStep", async () => {
  const actions = ["add-edge", "remove-edge", "reverse-edge", "undo-request", "none"];
  const request = v5({ edges: [EDGE], draft: [{ changes: [ADDED] }], focus: { kind: "draft", changes: [ADDED] } });
  const { result, calls } = await withProvider({
    action: providerChoice("reverse-edge", actions),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    edge: providerChoice(EDGE.id, [EDGE.id, "none"]),
  }, () => postJev(request));

  const body = await result.json();
  assert.equal(body.answers.edge.choice, EDGE.id);
  const [call] = calls;
  assert.deepEqual(call.state, request.state);
  assert.deepEqual(Object.keys(call.questions.action.criteria), actions);
  assert.deepEqual(Object.keys(call.questions.edge.criteria), [EDGE.id, "none"]);
  assert.match(call.questions.edge.criteria[EDGE.id], /node-c to node-a/u);

  // The answer feeds straight into the step code, on the revision it was asked about.
  const working = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const planned = await planStep({ working, revision: working.head, answers: body.answers, protocol });
  assert.equal(planned.step.action, ACTION_REVERSE);
});

test("v5 passes an undo-request through; the step code turns it into no change", async () => {
  const actions = ["add-edge", "remove-edge", "reverse-edge", "undo-request", "none"];
  const { result } = await withProvider({
    action: providerChoice("undo-request", actions),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    edge: providerChoice(EDGE.id, [EDGE.id, "none"]),
  }, () => postJev(v5({ utterance: "undo that", edges: [EDGE], draft: [{ changes: [ADDED] }], focus: { kind: "draft", changes: [ADDED] } })));

  const body = await result.json();
  const working = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const planned = await planStep({ working, revision: working.head, answers: body.answers, protocol });
  assert.equal(planned.outcome, OUTCOME_NO_CHANGE);
  assert.equal(planned.undoRequest, true);
});

test("v5 rejects malformed requests and off-criteria answers", async () => {
  const nine = Array.from({ length: 9 }, () => ({ changes: [ADDED] }));
  const bad = [
    { ...v5(), extra: true },
    { kind: "voice-ui.jev.request.v5", state: { ...v5().state, extra: 1 } },
    { kind: "voice-ui.jev.request.v5", state: { ...v5().state, utterance: "  " } },
    { kind: "voice-ui.jev.request.v5", state: { ...v5().state, working: { regions: [...REGIONS, "none"], edges: [] } } },
    v5({ edges: [{ ...EDGE, id: "none" }] }),
    v5({ edges: [{ ...EDGE, from: "node-z" }] }),
    v5({ edges: [EDGE, EDGE] }),
    v5({ draft: nine }),
    v5({ draft: [{ changes: [] }] }),
    v5({ focus: { kind: "none", changes: [ADDED] } }),
    v5({ focus: { kind: "draft", changes: [] } }),
    v5({ focus: { kind: "proposal", changes: [ADDED] } }),
    { kind: "voice-ui.jev.request.v3", text: "x", graph: { regions: REGIONS, edges: [] }, focus: { kind: "none", changes: [] } },
  ];
  for (const body of bad) assert.equal((await postJev(body)).status, 422, JSON.stringify(body));

  const { result } = await withProvider({
    action: providerChoice("remove-edge", ["add-edge", "remove-edge", "undo-request", "none"]),
    source: providerChoice("node-a", NODE_KEYS),
    target: providerChoice("node-b", NODE_KEYS),
  }, () => postJev(v5()));
  assert.equal(result.status, 502, "remove offered to nobody must not come back");
});

test("v5 forwards the recent conversation unchanged and tells every question it is unverified", async () => {
  const request = v5({ utterance: "connect a to the database", recent: HEARD });
  const { result, calls } = await withProvider({
    action: providerChoice("add-edge", ["add-edge", "undo-request", "none"]),
    source: providerChoice("node-a", NODE_KEYS),
    target: providerChoice("node-b", NODE_KEYS),
  }, () => postJev(request));

  assert.equal(result.status, 200);
  assert.equal((await result.json()).kind, "voice-ui.jev.decision.v4", "the answer's contract is unchanged");
  const [call] = calls;
  assert.deepEqual(call.state, request.state, "the context reaches Jev exactly as the page sent it");
  for (const [name, question] of Object.entries(call.questions)) {
    assert.match(question.instructions, /unverified/u, `${name} must say the context is unverified`);
    assert.match(question.instructions, /the current utterance, the working graph and the focus are the facts/u, name);
  }
});

test("v5 refuses a malformed recent conversation, and a v4 request is no longer served", async () => {
  const [noChange, stepEntry] = HEARD;
  const bad = [
    // A v4 request, exactly as the previous page sent it.
    { kind: "voice-ui.jev.request.v4", state: { utterance: "x", working: { regions: REGIONS, edges: [] }, draft: [], focus: { kind: "none", changes: [] } } },
    // v5 without the context, or with a different shape.
    { kind: "voice-ui.jev.request.v5", state: { utterance: "x", working: { regions: REGIONS, edges: [] }, draft: [], focus: { kind: "none", changes: [] } } },
    { ...v5(), state: { ...v5().state, context: [] } },
    { ...v5(), state: { ...v5().state, context: { recent: [], extra: 1 } } },
    v5({ recent: [...HEARD, { ...noChange, seq: 9 }] }),
    v5({ recent: [{ ...noChange, text: "x".repeat(201) }] }),
    v5({ recent: [{ ...noChange, text: "  " }] }),
    v5({ recent: [{ ...noChange, seq: 0 }] }),
    v5({ recent: [{ ...noChange, seq: 1.5 }] }),
    v5({ recent: [{ ...noChange, source: "said" }] }),
    v5({ recent: [{ ...noChange, outcome: "applied" }] }),
    v5({ recent: [{ ...noChange, extra: true }] }),
    v5({ recent: [{ ...noChange, effect: stepEntry.effect }] }),
    v5({ recent: [{ seq: 2, source: "voice", text: "x", outcome: "step" }] }),
    v5({ recent: [{ ...stepEntry, effect: { changes: [] } }] }),
    v5({ recent: [{ ...stepEntry, seq: 3 }, { ...noChange, seq: 3 }] }),
    v5({ recent: [{ ...stepEntry, seq: 3 }, { ...noChange, seq: 2 }] }),
  ];
  for (const body of bad) assert.equal((await postJev(body)).status, 422, JSON.stringify(body));

  const exactlyFull = v5({ recent: HEARD.map(entry => ({ ...entry, text: entry.text.padEnd(200, ".") })) });
  const { result } = await withProvider({
    action: providerChoice("none", ["add-edge", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
  }, () => postJev(exactlyFull));
  assert.equal(result.status, 200, "five entries of 200 characters are accepted");
});

// A provider that never answers. With `headers`, the status arrives but the body
// never ends. Either way it gives up only when the Function aborts the request.
// `called` resolves once the Function has sent the request, and so has started
// its clock.
const hangingProvider = ({ headers = false, called }) => async (url, init) => {
  called();
  const aborted = new Promise((resolve, reject) =>
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  if (!headers) return aborted;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"model":'));
      aborted.catch(reason => controller.error(reason));
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const settledAfter = async (pending, ms) => {
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  mock.timers.tick(ms);
  await new Promise(resolve => setImmediate(resolve));
  return settled;
};

for (const headers of [false, true]) {
  test(`a provider that ${headers ? "never finishes its body" : "never answers"} fails as 504 after 10 s, and a retry is answered`, async () => {
    const original = globalThis.fetch;
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let called;
      const sent = new Promise(resolve => { called = resolve; });
      globalThis.fetch = hangingProvider({ headers, called });
      const pending = postJev(v5({ utterance: "add an edge from c to a" }));
      await sent;
      assert.equal(await settledAfter(pending, 9999), false, "still waiting just before the limit");
      assert.equal(await settledAfter(pending, 1), true, "given up exactly at the limit");
      const result = await pending;
      assert.equal(result.status, 504);
      assert.deepEqual(await result.json(), { error: "provider_timeout" });
    } finally {
      mock.timers.reset();
      globalThis.fetch = original;
    }

    // Nothing is left behind: the next request is answered as usual.
    const { result } = await withProvider({
      action: providerChoice("add-edge", ["add-edge", "undo-request", "none"]),
      source: providerChoice("node-c", NODE_KEYS),
      target: providerChoice("node-a", NODE_KEYS),
    }, () => postJev(v5({ utterance: "add an edge from c to a" })));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).answers.action.choice, "add-edge");
  });
}

test("a provider that refuses the connection is still unreachable, not a timeout", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const result = await postJev(v5());
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: "provider_unreachable" });
  } finally {
    globalThis.fetch = original;
  }
});
