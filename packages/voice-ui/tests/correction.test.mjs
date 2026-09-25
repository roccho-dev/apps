import assert from "node:assert/strict";
import path from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import { onRequestPost } from "../functions/api/jev.mjs";
import { DecisionRefused } from "../src/decision/graph-edge.mjs";
import {
  ACTION_ADD,
  ACTION_ADD_PART,
  ACTION_NONE,
  ACTION_PLACE_PART,
  ACTION_REMOVE,
  ACTION_REVERSE,
  ACTION_REVERT,
  ACTION_UNDO_REQUEST,
  DIRECTIONS,
  DRAFT_MAX,
  OPTION_NONE,
  OUTCOME_NO_CHANGE,
  OUTCOME_STEP,
  PART_PALETTE,
  PLACEMENT_RESTATE,
  PLACEMENT_SLOTS,
  PLACEMENT_SLOT_GUIDANCE,
  REPAIR_CONTEXT_CHANGED,
  REPAIR_FAILED,
  REPAIR_SELF,
  pendingForJev,
  pendingHolds,
  ACTION_COMPOSE,
  DIAGRAM_CATALOG,
  DIAGRAM_NOT_OFFERED,
  DIAGRAM_RESTATE,
  diagramCandidatesForJev,
  repairStep,
  weakPlacementSlot,
  appendStep,
  changesForJev,
  correctionCriteria,
  edgesOf,
  focusFor,
  freeSlot,
  neighbourBounds,
  nextPartId,
  placeableIds,
  spotIsFree,
  planStep,
  revertStep,
} from "../src/decision/correction.mjs";
import { projectHistory, statesOf, truncateLog } from "../src/decision/history.mjs";

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
const answersFor = (graph, { action, source = "node-a", target = "node-b", part = OPTION_NONE, edge, confidence = 0.9 }) => {
  const answers = {
    action: choice(action, confidence),
    source: choice(source, confidence),
    target: choice(target, confidence),
    part: choice(part, confidence),
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
  assert.deepEqual(criteria.actions, [ACTION_ADD, ACTION_ADD_PART, ACTION_UNDO_REQUEST, ACTION_NONE]);
  assert.deepEqual(criteria.edges, []);
  assert.deepEqual(criteria.parts, [...PART_PALETTE.map(part => part.key), OPTION_NONE]);
  assert.deepEqual(criteria.regions, ["node-a", "node-b", "node-c", OPTION_NONE]);
});

test("a working graph with an edge is also offered removing or reversing it, or no edge", async () => {
  const working = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const criteria = correctionCriteria(working.records);
  assert.deepEqual(criteria.actions, [ACTION_ADD, ACTION_ADD_PART, ACTION_REMOVE, ACTION_REVERSE, ACTION_UNDO_REQUEST, ACTION_NONE]);
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

test("a removed region cannot be reverted", async () => {
  const graph = await baseGraph();
  const withoutOne = graph.records.filter(record => record.id !== "node-a");
  await assert.rejects(
    revertStep({ before: graph.records, after: withoutOne, working: graph, protocol }),
    /only an added part can be reverted/u,
  );
});

// Parts: Jev chooses only which kind of part was asked for. The app names it,
// places it and refuses when there is nowhere to put it.

const addPart = (working, part, confidence = 0.9) =>
  planStep({ working, revision: working.head, answers: answersFor(working, { action: ACTION_ADD_PART, part, confidence }), protocol });

const regionsOf = graph => graph.records.filter(record => record.type === "region" && record.parent !== null);

test("adding a part builds one AddRegion with an app-issued name, kind and free slot", async () => {
  const graph = await baseGraph();
  const planned = await addPart(graph, "decision");

  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.action, ACTION_ADD_PART);
  assert.deepEqual(planned.step.decision.operations, [{
    type: "AddRegion",
    regionId: "part-1",
    parentId: "root",
    label: "判断 1",
    kind: "decision",
    summary: "",
    bounds: [20, 20, 140, 64],
  }]);
  assert.deepEqual(planned.step.changes, [{ change: "added", kind: "region", id: "part-1", label: "判断 1" }]);

  const working = await appendStep({ working: graph, step: planned.step, protocol });
  const part = regionsOf(working).find(record => record.id === "part-1");
  assert.equal(part.label, "判断 1");
  assert.equal(part.kind, "decision");
  assert.deepEqual(edges(working), [], "a part is not an edge");
});

test("every palette key is offered, builds its own kind, and nothing else is accepted", async () => {
  let working = await baseGraph();
  for (const entry of PART_PALETTE) {
    const planned = await addPart(working, entry.key);
    assert.equal(planned.outcome, OUTCOME_STEP, entry.key);
    const [operation] = planned.step.decision.operations;
    assert.equal(operation.kind, entry.kind, entry.key);
    assert.match(operation.label, new RegExp(`^${entry.label} \\d+$`, "u"), entry.key);
    working = await appendStep({ working, step: planned.step, protocol });
  }
  assert.equal(regionsOf(working).length, 3 + PART_PALETTE.length);

  const answers = answersFor(working, { action: ACTION_ADD_PART, part: OPTION_NONE });
  await assert.rejects(
    planStep({ working, revision: working.head, answers: { ...answers, part: choice("group") }, protocol }),
    error => error instanceof DecisionRefused && /outside the offered criteria/u.test(error.message),
  );
});

test("a part name is never reused, not even after the part is reverted away", async () => {
  const graph = await baseGraph();
  const first = await addPart(graph, "step");
  const withPart = await appendStep({ working: graph, step: first.step, protocol });
  assert.equal(nextPartId(withPart), "part-2");

  // Take part-1 away again, exactly as a revert of that entry does.
  const states = await statesOf(withPart.log, verifyDecisionLog);
  const revert = await revertStep({ before: states[0], after: states[1], working: withPart, protocol });
  const removed = await appendStep({ working: withPart, step: revert.step ?? revert, protocol });
  assert.deepEqual(regionsOf(removed).map(record => record.id), ["node-a", "node-b", "node-c"]);

  // The name is spent: the next part is part-2, so an earlier utterance about
  // part-1 can never come to mean a different part.
  assert.equal(nextPartId(removed), "part-2");
  const next = await addPart(removed, "step");
  assert.equal(next.step.decision.operations[0].regionId, "part-2");
});

test("a name the page has handed out is spent even when undo cut it out of the log", async () => {
  const graph = await baseGraph();
  const first = await addPart(graph, "step");
  const withPart = await appendStep({ working: graph, step: first.step, protocol });

  // Undo is a truncation: the log no longer mentions part-1 at all.
  const undone = await truncateLog(withPart, {
    count: graph.decisions.length,
    floor: graph.decisions.length,
    verifyDecisionLog,
  });
  assert.equal(nextPartId(undone), "part-1", "the log alone cannot know the name was used");

  // The page remembers it, because its conversation still refers to it.
  assert.equal(nextPartId(undone, ["part-1"]), "part-2");
  const planned = await planStep({
    working: undone,
    revision: undone.head,
    answers: answersFor(undone, { action: ACTION_ADD_PART, part: "step" }),
    protocol,
    reserved: ["part-1"],
  });
  assert.equal(planned.step.decision.operations[0].regionId, "part-2");
});

test("an added part can be reverted only while it stands alone", async () => {
  const graph = await baseGraph();
  const planned = await addPart(graph, "data");
  const withPart = await appendStep({ working: graph, step: planned.step, protocol });
  const states = await statesOf(withPart.log, verifyDecisionLog);

  const attached = await step(withPart, { action: ACTION_ADD, source: "part-1", target: "node-a" });
  await assert.rejects(
    revertStep({ before: states[0], after: states[1], working: attached, protocol }),
    error => error instanceof DecisionRefused && /now has an edge/u.test(error.message),
  );
  assert.deepEqual(regionsOf(attached).map(record => record.id).sort(), ["node-a", "node-b", "node-c", "part-1"]);

  const revert = await revertStep({ before: states[0], after: states[1], working: withPart, protocol });
  assert.deepEqual(revert.changes, [{ change: "removed", kind: "region", id: "part-1", label: "データ 1" }]);
  const undone = await appendStep({ working: withPart, step: revert, protocol });
  assert.deepEqual(regionsOf(undone).map(record => record.id), ["node-a", "node-b", "node-c"]);
});

test("slots fill in reading order, never overlap, and a full graph is a no-change", async () => {
  let working = await baseGraph();
  const placed = [];
  for (let count = 0; count < 8; count += 1) {
    const planned = await addPart(working, "step");
    assert.equal(planned.outcome, OUTCOME_STEP, `part ${count + 1}`);
    placed.push(planned.step.decision.operations[0].bounds);
    working = await appendStep({ working, step: planned.step, protocol });
  }
  // Inside the boundary, and no two parts on the same spot.
  for (const [x, y, w, h] of placed) {
    assert.ok(x >= 0 && y >= 0 && x + w <= 720 && y + h <= 260, `${x},${y} is outside the boundary`);
  }
  assert.equal(new Set(placed.map(bounds => bounds.join(","))).size, placed.length);
  assert.deepEqual(placed[0], [20, 20, 140, 64]);
  assert.deepEqual(placed[1], [180, 20, 140, 64]);

  const full = await addPart(working, "step");
  assert.equal(full.outcome, OUTCOME_NO_CHANGE);
  assert.match(full.reason, /場所がありません/u);
  assert.equal(freeSlot(working.records), null);
});

test("a part nobody asked for, or one asked for too vaguely, changes nothing", async () => {
  const graph = await baseGraph();
  const none = await addPart(graph, OPTION_NONE);
  assert.equal(none.outcome, OUTCOME_NO_CHANGE);
  assert.match(none.reason, /did not name a part/u);

  const unsure = await addPart(graph, "step", 0.4);
  assert.equal(unsure.outcome, OUTCOME_NO_CHANGE);
  assert.match(unsure.reason, /not confident enough/u);
  assert.deepEqual(regionsOf(graph).map(record => record.id), ["node-a", "node-b", "node-c"]);
});

test("a part change reaches Jev as its id and label; an edge change as its two ends", () => {
  const region = { change: "added", kind: "region", id: "part-1", label: "判断 1", decision: "ignored" };
  const edge = { change: "removed", from: "node-a", to: "node-b", extra: 1 };
  assert.deepEqual(changesForJev([region, edge]), [
    { change: "added", kind: "region", id: "part-1", label: "判断 1" },
    { change: "removed", from: "node-a", to: "node-b" },
  ]);
  assert.deepEqual(focusFor({ draft: [{ changes: [region] }] }), {
    kind: "draft",
    changes: [{ change: "added", kind: "region", id: "part-1", label: "判断 1" }],
  });
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

// Placement: the app asks the provider where the graph is drawn, and offers
// Jev only parts and sides. Jev never sees or returns a coordinate.

const layoutOf = graph => protocol.layoutBoundsFor(graph.records, { pattern: "graph/1" });

// `confidence` sets every slot; `sure` overrides single slots, so a test can say
// exactly which piece Jev was unsure of.
const placeAnswers = (graph, layout, { move, anchor, direction, confidence = 0.9, sure = {} }) => {
  const criteria = correctionCriteria(graph.records, layout);
  const at = slot => sure[slot] ?? confidence;
  const answers = {
    action: choice(ACTION_PLACE_PART, at("action")),
    source: choice(OPTION_NONE, confidence),
    target: choice(OPTION_NONE, confidence),
    part: choice(OPTION_NONE, confidence),
    move: choice(move, at("move")),
    anchor: choice(anchor, at("anchor")),
    direction: choice(direction, at("direction")),
  };
  if (criteria.edges.length > 0) answers.edge = choice(criteria.edges[0], confidence);
  return answers;
};

// What 作業図 is showing, as the provider's visible-frame contract reports it.
// The default is a window wide enough for this graph, so a test says what it is
// about by narrowing it rather than by working around it.
const frameOf = (graph, frame = [-400, -400, 2000, 2000]) => Object.freeze({
  schema: "semantic-map-visible-frame/1",
  pattern: "graph/1",
  head: graph.head,
  frame: Object.freeze([...frame]),
});

const place = (graph, spec, visibleFrame = frameOf(graph)) => {
  const layout = layoutOf(graph);
  return planStep({
    working: graph,
    revision: graph.head,
    answers: placeAnswers(graph, layout, spec),
    protocol,
    layout,
    visibleFrame,
  });
};

test("the parts offered for placement are the ones the view actually draws", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  assert.deepEqual(placeableIds(layout, graph.records), ["node-a", "node-b", "node-c"]);
  assert.equal(Object.hasOwn(layout.bounds, "root"), true, "the view places the boundary");
  assert.equal(placeableIds(layout, graph.records).includes("root"), false, "the boundary is never offered");

  const criteria = correctionCriteria(graph.records, layout);
  assert.ok(criteria.actions.includes(ACTION_PLACE_PART));
  assert.deepEqual(criteria.placeable, ["node-a", "node-b", "node-c", OPTION_NONE]);
  assert.deepEqual(criteria.directions, [...DIRECTIONS, OPTION_NONE]);

  const blind = correctionCriteria(graph.records);
  assert.equal(blind.actions.includes(ACTION_PLACE_PART), false, "no layout, no placement offered");
  assert.deepEqual(blind.placeable, []);
});

test("a neighbouring spot takes its size and position from the view, not from us", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const [ax, ay, aw, ah] = layout.bounds["node-a"];
  const [, , tw, th] = layout.bounds["node-c"];
  assert.equal(tw, 180, "precondition: the view sizes parts itself");
  assert.equal(th, 92);

  assert.deepEqual(neighbourBounds(layout, "node-c", "node-a", "right"), [ax + aw + 24, ay, tw, th]);
  assert.deepEqual(neighbourBounds(layout, "node-c", "node-a", "left"), [ax - tw - 24, ay, tw, th]);
  assert.deepEqual(neighbourBounds(layout, "node-c", "node-a", "above"), [ax, ay - th - 24, tw, th]);
  assert.deepEqual(neighbourBounds(layout, "node-c", "node-a", "below"), [ax, ay + ah + 24, tw, th]);
  assert.throws(() => neighbourBounds(layout, "node-c", "node-a", "diagonal"), /unknown direction/u);
  assert.throws(() => neighbourBounds(layout, "node-c", "missing", "right"), /anchor is not placed/u);
});

test("placing a part builds one PinRegions at the spot beside its anchor", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const planned = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" });

  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.action, ACTION_PLACE_PART);
  const expected = neighbourBounds(layout, "node-c", "node-a", "right");
  assert.deepEqual(planned.step.decision.operations, [{
    type: "PinRegions",
    items: [{ regionId: "node-c", bounds: [...expected] }],
  }]);
  assert.deepEqual(planned.step.changes, [{
    change: "placed", kind: "region", id: "node-c", anchor: "node-a", direction: "right",
  }]);

  const working = await appendStep({ working: graph, step: planned.step, protocol });
  const after = layoutOf(working);
  assert.deepEqual(after.bounds["node-c"], [...expected], "the view places it where the pin says");
  assert.deepEqual(after.pinned, ["node-c"]);
  assert.notDeepEqual(after.bounds["node-c"], layout.bounds["node-c"], "and that is not where it was");
  for (const id of ["node-a", "node-b"]) {
    assert.deepEqual(after.bounds[id], layout.bounds[id], id + " keeps its automatic position");
  }
});

test("an anchor that has already been placed is used where it is now", async () => {
  const graph = await baseGraph();
  const first = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" });
  const moved = await appendStep({ working: graph, step: first.step, protocol });

  const layout = layoutOf(moved);
  assert.deepEqual(layout.pinned, ["node-c"]);
  const second = await place(moved, { move: "node-b", anchor: "node-c", direction: "below" });
  assert.equal(second.outcome, OUTCOME_STEP);
  assert.deepEqual(
    second.step.decision.operations[0].items[0].bounds,
    [...neighbourBounds(layout, "node-b", "node-c", "below")],
    "computed against node-c's pinned position, not the one it used to have",
  );
});

test("a taken spot, a part beside itself, or the same move twice changes nothing", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);

  // The view stacks this graph a, b, c downwards, so the spot just above b is
  // the one a already occupies.
  assert.equal(spotIsFree(layout, graph.records, "node-c", neighbourBounds(layout, "node-c", "node-b", "above")), false);
  const taken = await place(graph, { move: "node-c", anchor: "node-b", direction: "above" });
  assert.equal(taken.outcome, OUTCOME_NO_CHANGE);
  assert.match(taken.reason, /別の部品があります/u);

  // ...while the spot beside b is empty, so the same check says yes there.
  assert.equal(spotIsFree(layout, graph.records, "node-c", neighbourBounds(layout, "node-c", "node-b", "right")), true);

  await assert.rejects(
    place(graph, { move: "node-c", anchor: "node-c", direction: "right" }),
    error => error instanceof DecisionRefused && /beside itself/u.test(error.message),
  );

  const first = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" });
  const moved = await appendStep({ working: graph, step: first.step, protocol });
  const again = await place(moved, { move: "node-c", anchor: "node-a", direction: "right" });
  assert.equal(again.outcome, OUTCOME_NO_CHANGE);
  assert.match(again.reason, /すでにそこにあります/u);
});

// R's counterexample on apps#19 @4f76c70, measured in a real browser: chained
// placements walk a part off the right of the picture. The view grows the
// boundary to contain every pin, so the part stays "inside root" and the
// contract still reports its bounds - and the browser draws nothing, because
// the camera does not follow. The frame before the pin is the only one that
// answers the question the person is asking.
// What the pane is showing decides, and the enclosing boundary does not. Both
// halves of that were measured in a real browser: a spot inside the boundary can
// be off screen, and a spot outside it can be plainly visible.
test("the visible frame decides, not the enclosing boundary", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const root = layout.rootBounds;
  const spot = neighbourBounds(layout, "node-c", "node-a", "right");

  // Inside the boundary, outside the pane: a no-change, however much room the
  // boundary has.
  assert.ok(spot[0] >= root[0] && spot[0] + spot[2] <= root[0] + root[2],
    "precondition: this spot is inside the enclosing boundary");
  const offPane = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" },
    frameOf(graph, [0, 0, spot[0] + spot[2] - 1, root[3]]));
  assert.equal(offPane.outcome, OUTCOME_NO_CHANGE, "one pixel short of the spot is still short");
  assert.match(offPane.reason, /今の表示の外/u);

  // Outside the boundary, inside the pane: a step. The view grows the boundary
  // around the pin, so nothing is orphaned by this.
  const above = neighbourBounds(layout, "node-c", "node-a", "above");
  assert.ok(above[1] < root[1], "precondition: this spot is above the enclosing boundary");
  const onPane = await place(graph, { move: "node-c", anchor: "node-a", direction: "above" });
  assert.equal(onPane.outcome, OUTCOME_STEP, "outside the boundary but inside the pane is placeable");
  const moved = await appendStep({ working: graph, step: onPane.step, protocol });
  assert.deepEqual(layoutOf(moved).bounds["node-c"], [...above], "and the view draws it there");
  assert.ok(layoutOf(moved).rootBounds[1] <= above[1], "the boundary grew to hold it");
});

// The three ways of having no answer are different facts for the person, so they
// are different sentences. "I cannot see the picture" is not "that spot is off
// the picture", and neither is an error about what was said.
test("no frame, a pane that has not caught up, and a spot off the pane read differently", async () => {
  const graph = await baseGraph();
  const spec = { move: "node-c", anchor: "node-a", direction: "right" };

  const blind = await place(graph, spec, null);
  assert.equal(blind.outcome, OUTCOME_NO_CHANGE);
  assert.match(blind.reason, /読み取れない/u);

  const behind = await place(graph, spec, { ...frameOf(graph), head: "sha256:stale" });
  assert.equal(behind.outcome, OUTCOME_NO_CHANGE);
  assert.match(behind.reason, /追いついていない/u);

  const outside = await place(graph, spec, frameOf(graph, [0, 0, 10, 10]));
  assert.equal(outside.outcome, OUTCOME_NO_CHANGE);
  assert.match(outside.reason, /今の表示の外/u);

  const reasons = new Set([blind.reason, behind.reason, outside.reason]);
  assert.equal(reasons.size, 3, "three conditions, three sentences");
  for (const answer of [blind, behind, outside]) {
    assert.equal(answer.step, undefined, "none of them proposes a change");
    assert.equal(answer.undoRequest, undefined, "and none of them is heard as an undo");
  }
});

// Partly on the pane is not on the pane: a part the person can only half see is
// not a part they can see.
test("a spot only partly on the pane is a no-change", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const spot = neighbourBounds(layout, "node-c", "node-a", "right");
  for (const [label, frame] of [
    ["cut on the right", [spot[0] - 40, spot[1] - 40, spot[2] + 20, spot[3] + 80]],
    ["cut on the bottom", [spot[0] - 40, spot[1] - 40, spot[2] + 80, spot[3] + 20]],
    ["cut on the left", [spot[0] + 20, spot[1] - 40, spot[2] + 80, spot[3] + 80]],
    ["cut on the top", [spot[0] - 40, spot[1] + 20, spot[2] + 80, spot[3] + 80]],
  ]) {
    const answer = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" },
      frameOf(graph, frame));
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE, label);
    assert.match(answer.reason, /今の表示の外/u, label);
  }
  // Exactly containing it - with the anchor and the moving part, which must be
  // on the pane as well - is enough.
  const boxes = [spot, layout.bounds["node-a"], layout.bounds["node-c"]];
  const left = Math.min(...boxes.map(box => box[0]));
  const top = Math.min(...boxes.map(box => box[1]));
  const right = Math.max(...boxes.map(box => box[0] + box[2]));
  const bottom = Math.max(...boxes.map(box => box[1] + box[3]));
  const exact = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" },
    frameOf(graph, [left, top, right - left, bottom - top]));
  assert.equal(exact.outcome, OUTCOME_STEP, "a frame that exactly contains spot, anchor and part is enough");
});

// R's counterexample (D) on apps#19: the view's bounds are pre-culling, so with
// ten parts stacked down a pane that shows the top of them, every part still has
// bounds - and Jev used to be offered all ten, and a spot beside a part nobody
// could see was accepted. The pane decides what can be named, and what is
// judged. The frame is R's measured viewport height.
const tenParts = async () => {
  let graph = await baseGraph();
  for (let index = 0; index < 7; index += 1) {
    graph = await appendStep({ working: graph, step: (await addPart(graph, "decision")).step, protocol });
  }
  return graph;
};
const TOP_OF_TEN = [0, 0, 640, 562];
const wholly = (frame, box) => box[0] >= frame[0] && box[1] >= frame[1]
  && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3];

test("only the parts wholly on the pane are offered, and every part still blocks its spot", async () => {
  const graph = await tenParts();
  const layout = layoutOf(graph);
  const all = placeableIds(layout, graph.records);
  assert.equal(all.length, 10, "precondition: the view has bounds for all ten, on screen or not");
  assert.deepEqual([...layout.rootBounds], [0, 0, 640, 1288], "precondition: R's measured layout");

  const onPane = placeableIds(layout, graph.records, TOP_OF_TEN);
  assert.deepEqual(onPane, all.filter(id => wholly(TOP_OF_TEN, layout.bounds[id])));
  assert.deepEqual(onPane, ["node-a", "node-b", "node-c", "part-1"]);
  assert.equal(onPane.includes("part-2"), false, "part-2 shows 2 px of itself and is not offered");

  const criteria = correctionCriteria(graph.records, layout, TOP_OF_TEN);
  assert.deepEqual(criteria.placeable, [...onPane, OPTION_NONE]);

  // A part off the pane is not offered, but it still occupies its spot.
  const underPart3 = [...layout.bounds["part-3"]];
  assert.equal(onPane.includes("part-3"), false);
  assert.equal(spotIsFree(layout, graph.records, "node-a", underPart3), false);
});

test("an answer naming a part that was not on the pane when asked is refused", async () => {
  const graph = await tenParts();
  const layout = layoutOf(graph);
  await assert.rejects(
    planStep({
      working: graph,
      revision: graph.head,
      answers: placeAnswers(graph, layout, { move: "part-1", anchor: "part-2", direction: "above" }),
      protocol,
      layout,
      visibleFrame: frameOf(graph, TOP_OF_TEN),
      offeredFrame: TOP_OF_TEN,
    }),
    error => error instanceof DecisionRefused && /outside the offered criteria/u.test(error.message),
  );
});

test("a spot beside a part off the pane is a no-change, even when the spot is on it", async () => {
  const graph = await tenParts();
  const layout = layoutOf(graph);
  const spot = neighbourBounds(layout, "part-1", "part-2", "above");
  assert.ok(wholly(TOP_OF_TEN, spot), "precondition: the spot itself is on the pane");
  assert.equal(wholly(TOP_OF_TEN, layout.bounds["part-2"]), false, "precondition: the anchor is not");

  // Judged against the frame read after the answer, whatever was offered.
  const answer = await place(graph, { move: "part-1", anchor: "part-2", direction: "above" },
    frameOf(graph, TOP_OF_TEN));
  assert.equal(answer.outcome, OUTCOME_NO_CHANGE, "at apps#19 8d63d4b5 this was a step");
  assert.match(answer.reason, /基準の部品が今の表示の外/u);
  assert.equal(answer.step, undefined);
});

test("moving a part that is off the pane is a no-change, even to a spot on it", async () => {
  const graph = await tenParts();
  const layout = layoutOf(graph);
  const spot = neighbourBounds(layout, "part-5", "node-a", "right");
  assert.ok(wholly(TOP_OF_TEN, spot) && wholly(TOP_OF_TEN, layout.bounds["node-a"]),
    "precondition: the spot and the anchor are on the pane");
  assert.equal(wholly(TOP_OF_TEN, layout.bounds["part-5"]), false, "precondition: the part is not");

  const answer = await place(graph, { move: "part-5", anchor: "node-a", direction: "right" },
    frameOf(graph, TOP_OF_TEN));
  assert.equal(answer.outcome, OUTCOME_NO_CHANGE);
  assert.match(answer.reason, /動かす部品が今の表示の外/u);

  // The same move with everything on the pane is a step.
  const wide = await place(graph, { move: "part-5", anchor: "node-a", direction: "right" });
  assert.equal(wide.outcome, OUTCOME_STEP);
});

test("a pane that moved after Jev was asked is judged as it is now", async () => {
  const graph = await tenParts();
  const layout = layoutOf(graph);
  // Offered from the top of the picture; by the answer the pane has scrolled
  // down past the top of node-a, while the spot below it is still on the pane.
  const moved = [0, 120, 640, 562];
  assert.ok(wholly(moved, neighbourBounds(layout, "part-1", "node-a", "below")), "precondition: the spot is on it");
  assert.equal(wholly(moved, layout.bounds["node-a"]), false, "precondition: the anchor no longer is");
  const answer = await planStep({
    working: graph,
    revision: graph.head,
    answers: placeAnswers(graph, layout, { move: "part-1", anchor: "node-a", direction: "below" }),
    protocol,
    layout,
    visibleFrame: frameOf(graph, moved),
    offeredFrame: TOP_OF_TEN,
  });
  assert.equal(answer.outcome, OUTCOME_NO_CHANGE);
  assert.match(answer.reason, /基準の部品が今の表示の外/u);
});

test("fewer than two parts on the pane offers no placement at all", async () => {
  const graph = await tenParts();
  const layout = layoutOf(graph);
  const onlyA = [...layout.bounds["node-a"]];
  assert.deepEqual(placeableIds(layout, graph.records, onlyA), ["node-a"]);
  const criteria = correctionCriteria(graph.records, layout, onlyA);
  assert.equal(criteria.actions.includes(ACTION_PLACE_PART), false);
  assert.deepEqual(criteria.placeable, []);
  assert.deepEqual(criteria.directions, []);
});

test("every way of not placing reads as its own sentence", async () => {
  const graph = await tenParts();
  const reasons = new Set();
  const spec = { move: "part-1", anchor: "node-a", direction: "right" };
  reasons.add((await place(graph, spec, null)).reason);
  reasons.add((await place(graph, spec, { ...frameOf(graph), head: "sha256:stale" })).reason);
  reasons.add((await place(graph, spec, frameOf(graph, [0, 0, 10, 10]))).reason);
  reasons.add((await place(graph, { move: "part-1", anchor: "part-2", direction: "above" }, frameOf(graph, TOP_OF_TEN))).reason);
  reasons.add((await place(graph, { move: "part-5", anchor: "node-a", direction: "right" }, frameOf(graph, TOP_OF_TEN))).reason);
  assert.equal(reasons.size, 5, [...reasons].join(" / "));
});

test("none in any placement slot, or low confidence, changes nothing", async () => {
  const graph = await baseGraph();
  for (const spec of [
    { move: OPTION_NONE, anchor: "node-a", direction: "right" },
    { move: "node-c", anchor: OPTION_NONE, direction: "right" },
    { move: "node-c", anchor: "node-a", direction: OPTION_NONE },
  ]) {
    const answer = await place(graph, spec);
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE, JSON.stringify(spec));
    assert.equal(answer.reason, PLACEMENT_RESTATE, "a none slot asks for the whole instruction again");
  }
  const unsure = await place(graph, { move: "node-c", anchor: "node-a", direction: "right", confidence: 0.3 });
  assert.equal(unsure.outcome, OUTCOME_NO_CHANGE);
  assert.equal(unsure.reason, PLACEMENT_RESTATE, "everything unsure asks for the whole instruction again");
});

// The measured real turn: action 0.94, move 0.86, anchor 0.39, direction 0.97.
// Everything came through but the neighbour, so the person is told that - and
// only when it is exactly one piece of a confident placement.
test("exactly one unsure placement piece is named; nothing else is", async () => {
  const graph = await baseGraph();
  const spec = { move: "node-c", anchor: "node-a", direction: "right" };

  for (const slot of PLACEMENT_SLOTS) {
    const answer = await place(graph, { ...spec, sure: { action: 0.94, [slot]: 0.39 } });
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE, slot);
    assert.equal(answer.reason, PLACEMENT_SLOT_GUIDANCE[slot], `${slot} alone is named`);
    assert.equal(answer.step, undefined, `${slot}: nothing is proposed`);
    assert.equal(answer.undoRequest, undefined, `${slot}: not heard as an undo`);
  }
  const measured = await place(graph, { ...spec, sure: { action: 0.94, move: 0.86, anchor: 0.39, direction: 0.97 } });
  assert.equal(measured.reason, PLACEMENT_SLOT_GUIDANCE.anchor, "the measured turn asks for the neighbour");

  // Not eligible: an unsure action, two unsure pieces, or a none - all ask for
  // the whole instruction, never for one word.
  for (const [label, sure] of [
    ["unsure action", { action: 0.41 }],
    ["unsure action and one piece", { action: 0.41, anchor: 0.39 }],
    ["two unsure pieces", { anchor: 0.39, direction: 0.4 }],
    ["three unsure pieces", { move: 0.3, anchor: 0.3, direction: 0.3 }],
  ]) {
    const answer = await place(graph, { ...spec, sure });
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE, label);
    assert.equal(answer.reason, PLACEMENT_RESTATE, label);
  }
  const noneAndUnsure = await place(graph, { move: "node-c", anchor: OPTION_NONE, direction: "right", sure: { direction: 0.3 } });
  assert.equal(noneAndUnsure.reason, PLACEMENT_RESTATE, "a none is never narrowed to one word");

  // A part named as its own neighbour: supplying the missing side would only
  // reach "cannot be placed beside itself", so it is never narrowed to one word
  // - whichever piece was the unsure one.
  for (const slot of PLACEMENT_SLOTS) {
    const self = await place(graph, { move: "node-c", anchor: "node-c", direction: "right", sure: { [slot]: 0.39 } });
    assert.equal(self.outcome, OUTCOME_NO_CHANGE, `self-anchor, ${slot} unsure`);
    assert.equal(self.reason, PLACEMENT_RESTATE, `self-anchor, ${slot} unsure: whole instruction`);
  }
  // A confident self-anchor is unchanged from v7: still refused.
  await assert.rejects(
    place(graph, { move: "node-c", anchor: "node-c", direction: "right" }),
    error => error instanceof DecisionRefused && /beside itself/u.test(error.message),
    "confident self-anchor keeps its v7 refusal",
  );

  // The floor is where it was: 0.5 exactly is enough.
  const atFloor = await place(graph, { ...spec, sure: { anchor: 0.5 } });
  assert.equal(atFloor.outcome, OUTCOME_STEP, "0.5 still passes");

  // The three sentences are distinct, and none of them reads out a part id.
  const sentences = [PLACEMENT_RESTATE, ...Object.values(PLACEMENT_SLOT_GUIDANCE)];
  assert.equal(new Set(sentences).size, 4);
  for (const sentence of sentences) {
    assert.equal(/node-|part-/u.test(sentence), false, `no id is read out: ${sentence}`);
  }
});

test("the weak-slot rule is the same function the step code uses", () => {
  const read = (confidences, overrides = {}) => Object.fromEntries(
    ["action", "move", "anchor", "direction"].map(slot => [slot, {
      choice: overrides[slot] ?? { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "left" }[slot],
      confidence: confidences[slot] ?? 0.9,
    }]),
  );
  assert.equal(weakPlacementSlot(read({ anchor: 0.39 })), "anchor");
  assert.equal(weakPlacementSlot(read({ move: 0.2 })), "move");
  assert.equal(weakPlacementSlot(read({})), null, "nothing weak");
  assert.equal(weakPlacementSlot(read({ action: 0.49, anchor: 0.39 })), null);
  assert.equal(weakPlacementSlot(read({ anchor: 0.39, move: 0.4 })), null);
  assert.equal(weakPlacementSlot(read({ anchor: 0.39 }, { direction: OPTION_NONE })), null);
  assert.equal(weakPlacementSlot(read({ anchor: 0.39 }, { action: ACTION_ADD })), null, "only placements");
  assert.equal(weakPlacementSlot(read({ direction: 0.39 }, { move: "node-a", anchor: "node-a" })), null, "never for self-anchor");
  assert.equal(weakPlacementSlot(undefined), null);
});

// One-slot repair. The first utterance is the measured real turn: sure it is a
// placement, sure of the part and the side, unsure of the neighbour. The second
// is whatever the person says next - judged by Jev, and completed only here.

// Answers with any action, shaped exactly as the page's reader expects.
const answersWith = (graph, layout, {
  action = OPTION_NONE, move = OPTION_NONE, anchor = OPTION_NONE, direction = OPTION_NONE,
  source = OPTION_NONE, target = OPTION_NONE, part = OPTION_NONE, sure = {},
}) => {
  const criteria = correctionCriteria(graph.records, layout);
  const at = slot => sure[slot] ?? 0.9;
  const answers = {
    action: choice(action, at("action")),
    source: choice(source, at("source")),
    target: choice(target, at("target")),
    part: choice(part, at("part")),
    move: choice(move, at("move")),
    anchor: choice(anchor, at("anchor")),
    direction: choice(direction, at("direction")),
  };
  if (criteria.edges.length > 0) answers.edge = choice(OPTION_NONE, 0.9);
  return answers;
};

const MEASURED = { action: 0.94, move: 0.86, anchor: 0.39, direction: 0.97 };

const nearPlacement = async graph => {
  const layout = layoutOf(graph);
  return planStep({
    working: graph,
    revision: graph.head,
    answers: answersWith(graph, layout, {
      action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "right", sure: MEASURED,
    }),
    protocol,
    layout,
    visibleFrame: frameOf(graph),
    // The page offers from the frame it read before asking; here the pane did
    // not move, so it is the same frame.
    offeredFrame: frameOf(graph).frame,
  });
};

// A reply as the page makes it: offered from the frame it read before asking,
// when that frame shows the working head, and judged against `visibleFrame`.
const reply = (graph, pending, spec, visibleFrame = frameOf(graph),
  offeredFrame = visibleFrame !== null && visibleFrame.head === graph.head ? visibleFrame.frame : null) => {
  const layout = layoutOf(graph);
  return repairStep({
    working: graph, revision: graph.head, answers: answersWith(graph, layout, spec), protocol, layout, visibleFrame, offeredFrame, pending,
  });
};

test("a near-placement leaves one pending piece, with no text in it", async () => {
  const graph = await baseGraph();
  const near = await nearPlacement(graph);
  assert.equal(near.outcome, OUTCOME_NO_CHANGE);
  assert.equal(near.reason, PLACEMENT_SLOT_GUIDANCE.anchor);
  assert.equal(near.pending.missing, "anchor");
  assert.equal(near.pending.head, graph.head, "bound to the head it was said against");
  assert.equal(near.pending.anchor, null);
  assert.deepEqual([near.pending.move.choice, near.pending.direction.choice], ["node-c", "right"]);
  assert.deepEqual(pendingForJev(near.pending), { missing: "anchor", move: "node-c", anchor: null, direction: "right" },
    "the request carries ids and a side only");
  assert.equal(pendingForJev(null), null);

  // Nothing else leaves a pending piece.
  const layout = layoutOf(graph);
  for (const [label, spec] of [
    ["unsure action", { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "right", sure: { action: 0.41, anchor: 0.39 } }],
    ["two unsure pieces", { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "right", sure: { anchor: 0.39, direction: 0.4 } }],
    ["a none", { action: ACTION_PLACE_PART, move: "node-c", anchor: OPTION_NONE, direction: "right", sure: { direction: 0.3 } }],
    ["self-anchor", { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-c", direction: "right", sure: { direction: 0.39 } }],
    ["unsure edge", { action: ACTION_ADD, source: "node-a", target: "node-b", sure: { action: 0.3 } }],
  ]) {
    const answer = await planStep({
      working: graph, revision: graph.head, answers: answersWith(graph, layout, spec), protocol, layout,
      visibleFrame: frameOf(graph), offeredFrame: frameOf(graph).frame,
    });
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE, label);
    assert.equal(answer.pending, undefined, `${label}: nothing is held`);
  }
});

test("naming just the missing piece completes the placement, at the unchanged floor", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);

  // "相手はノードAです": Jev hears no change of its own, but names the neighbour.
  const repaired = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a", sure: { action: 0.91 } });
  assert.equal(repaired.outcome, OUTCOME_STEP);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.step.action, ACTION_PLACE_PART);
  assert.deepEqual(repaired.step.changes, [{ change: "placed", kind: "region", id: "node-c", anchor: "node-a", direction: "right" }]);
  assert.deepEqual(repaired.step.decision.operations[0].items[0].bounds,
    [...neighbourBounds(layoutOf(graph), "node-c", "node-a", "right")]);

  // Exactly the floor is enough; just under is not.
  const atFloor = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a", sure: { anchor: 0.5 } });
  assert.equal(atFloor.outcome, OUTCOME_STEP);
  const under = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a", sure: { anchor: 0.49 } });
  assert.equal(under.outcome, OUTCOME_NO_CHANGE);
  assert.equal(under.reason, REPAIR_FAILED);

  // Heard as the part beside itself, the reply still names the neighbour.
  const heardAsSelf = await reply(graph, pending, {
    action: ACTION_PLACE_PART, move: "node-a", anchor: "node-a", direction: "right",
  });
  assert.equal(heardAsSelf.outcome, OUTCOME_STEP, "only the missing piece is taken from the reply");
  assert.equal(heardAsSelf.step.changes[0].id, "node-c");
});

test("a complete or unrelated instruction wins over the pending piece", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);

  const other = await reply(graph, pending, { action: ACTION_PLACE_PART, move: "node-b", anchor: "node-a", direction: "right" });
  assert.equal(other.outcome, OUTCOME_STEP);
  assert.equal(other.repaired, undefined, "judged as itself");
  assert.equal(other.step.changes[0].id, "node-b");

  const edge = await reply(graph, pending, { action: ACTION_ADD, source: "node-a", target: "node-b", anchor: "node-b" });
  assert.equal(edge.outcome, OUTCOME_STEP);
  assert.deepEqual(edge.step.changes, [{ change: "added", from: "node-a", to: "node-b" }], "an edge, not a repair");

  const unsureEdge = await reply(graph, pending, { action: ACTION_ADD, source: "node-a", target: "node-b", anchor: "node-b", sure: { action: 0.3 } });
  assert.equal(unsureEdge.outcome, OUTCOME_NO_CHANGE);
  assert.match(unsureEdge.reason, /not confident enough/u, "an unsure edge is an unsure edge, not a repair");

  const undo = await reply(graph, pending, { action: ACTION_UNDO_REQUEST, anchor: "node-a" });
  assert.equal(undo.outcome, OUTCOME_NO_CHANGE);
  assert.equal(undo.undoRequest, true, "a spoken undo is still an undo request");
});

// R's RED on 15cf4ba: a complete instruction that did not itself make a step
// was mined for the one missing piece and turned into a placement nobody asked
// for. A reply is a repair only if everything else it says is none, the same as
// what is held, or an echo of the part it names. Anything else is its own
// instruction and gets its own answer.
test("a complete instruction that is blocked is answered as itself, never mined for the missing piece", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);

  // "node-a を node-b の下に": the spot is taken, so it is a no change of its
  // own - and must stay one.
  const occupied = await reply(graph, pending, {
    action: ACTION_PLACE_PART, move: "node-a", anchor: "node-b", direction: "below", sure: { action: 0.93, move: 0.92, anchor: 0.92, direction: 0.92 },
  });
  assert.equal(occupied.outcome, OUTCOME_NO_CHANGE);
  assert.match(occupied.reason, /別の部品があります/u, "the instruction's own reason");
  assert.equal(occupied.step, undefined, "no placement is proposed");
  assert.equal(occupied.repaired, undefined);

  // "node-b を node-b の上に": a different part beside itself, with a side that
  // contradicts the held one - the existing refusal, not a repair.
  await assert.rejects(
    reply(graph, pending, { action: ACTION_PLACE_PART, move: "node-b", anchor: "node-b", direction: "above" }),
    error => error instanceof DecisionRefused && /beside itself/u.test(error.message),
    "a different part beside itself keeps its own refusal",
  );

  // A confident side that contradicts the held one, with no placement of its
  // own: it is not a repair, and is answered as what it is.
  const contradicting = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a", direction: "left" });
  assert.equal(contradicting.outcome, OUTCOME_NO_CHANGE);
  assert.equal(contradicting.step, undefined);
  assert.match(contradicting.reason, /no graph change/u, "answered as the no change it was heard as");

  // An unsure contradiction is ambiguity: a no change, never a guess.
  const unsure = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a", direction: "left", sure: { direction: 0.3 } });
  assert.equal(unsure.outcome, OUTCOME_NO_CHANGE);
  assert.equal(unsure.reason, REPAIR_FAILED);

  // Truly slot-only replies still repair: the other pieces none, the same as
  // held, or an echo of the part named.
  for (const [label, spec] of [
    ["others none", { action: ACTION_NONE, anchor: "node-b" }],
    // Agreeing with what is held - even unsure of it - is not a contradiction.
    ["others as held", { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-b", direction: "right", sure: { move: 0.3 } }],
    ["echo of the named part", { action: ACTION_NONE, move: "node-b", anchor: "node-b" }],
  ]) {
    const ok = await reply(graph, pending, spec);
    assert.equal(ok.outcome, OUTCOME_STEP, label);
    assert.equal(ok.repaired, true, label);
    assert.deepEqual(ok.step.changes, [{ change: "placed", kind: "region", id: "node-c", anchor: "node-b", direction: "right" }], label);
  }
});

// R's finding on d58ebb4: a repair turn whose own answer is a new near-placement
// used to say "部品の名前だけでも" - a follow-up that cannot work, because a
// repair turn never holds another piece. It now asks for the whole instruction,
// and a bare name afterwards completes nothing.
test("a repair turn never offers a one-word follow-up it cannot keep", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);

  const newNear = await reply(graph, pending, {
    action: ACTION_PLACE_PART, move: "node-b", anchor: "node-a", direction: "right",
    sure: { action: 0.93, move: 0.92, anchor: 0.3, direction: 0.92 },
  });
  assert.equal(newNear.outcome, OUTCOME_NO_CHANGE);
  assert.equal(newNear.reason, PLACEMENT_RESTATE, "the whole instruction, not one word");
  assert.equal(newNear.pending, undefined, "nothing is held after a repair turn");
  assert.equal(newNear.step, undefined);
  for (const sentence of Object.values(PLACEMENT_SLOT_GUIDANCE)) {
    assert.notEqual(newNear.reason, sentence);
  }

  // The bare name that follows is an ordinary utterance with nothing held: it
  // completes nothing.
  const bareName = await place(graph, { move: OPTION_NONE, anchor: "node-a", direction: OPTION_NONE });
  assert.equal(bareName.outcome, OUTCOME_NO_CHANGE);
  assert.equal(bareName.step, undefined);

  // Outside a repair the one-word guidance is unchanged.
  const ordinary = await nearPlacement(graph);
  assert.equal(ordinary.reason, PLACEMENT_SLOT_GUIDANCE.anchor);
  assert.notEqual(ordinary.pending, undefined);
});

test("every way a repair can fail is a reasoned no change, and never holds another", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);

  const none = await reply(graph, pending, { action: ACTION_NONE, anchor: OPTION_NONE, sure: { anchor: 0.99 } });
  assert.equal(none.reason, REPAIR_FAILED, "a confident none is not an answer");

  const self = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-c" });
  assert.equal(self.outcome, OUTCOME_NO_CHANGE);
  assert.equal(self.reason, REPAIR_SELF, "the moved part beside itself is a no change, not a failure");

  const moved = await appendStep({
    working: graph,
    step: (await place(graph, { move: "node-b", anchor: "node-a", direction: "right" })).step,
    protocol,
  });
  const afterMove = await reply(moved, pending, { action: ACTION_NONE, anchor: "node-a" });
  assert.equal(afterMove.reason, REPAIR_CONTEXT_CHANGED, "a different working head");

  const stale = await reply(graph, { ...pending, move: { type: "choice", choice: "node-z", confidence: 0.9 } },
    { action: ACTION_NONE, anchor: "node-a" });
  assert.equal(stale.reason, REPAIR_CONTEXT_CHANGED, "a piece no longer among the candidates");

  // The held piece belongs to the exact picture it was said against, so a
  // reply whose pane cannot be read, shows another head, or shows a different
  // frame is told the picture changed - not the ordinary placement reasons,
  // which would suggest the piece itself had been judged.
  const blind = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a" }, null);
  assert.equal(blind.reason, REPAIR_CONTEXT_CHANGED, "no frame: the held picture cannot be confirmed");
  const behind = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a" }, { ...frameOf(graph), head: "sha256:stale" });
  assert.equal(behind.reason, REPAIR_CONTEXT_CHANGED, "a frame behind the working head");
  // Offered from the held frame; by the answer the pane shows almost nothing.
  const offPane = await reply(graph, pending, { action: ACTION_NONE, anchor: "node-a" },
    frameOf(graph, [0, 0, 10, 10]), frameOf(graph).frame);
  assert.equal(offPane.reason, REPAIR_CONTEXT_CHANGED, "a different frame");

  // A reply that is itself a near-placement short of the very same piece fails
  // the repair, and is not held in turn: one repair only.
  const again = await reply(graph, pending, {
    action: ACTION_PLACE_PART, move: "node-c", anchor: "node-b", direction: "right", sure: { anchor: 0.3 },
  });
  assert.equal(again.outcome, OUTCOME_NO_CHANGE);
  assert.equal(again.reason, REPAIR_FAILED);
  assert.equal(again.pending, undefined, "a repair never holds another");

  for (const answer of [none, self, afterMove, stale, blind, behind, offPane, again]) {
    assert.equal(answer.step, undefined);
  }
  await assert.rejects(
    repairStep({ working: graph, revision: graph.head, answers: {}, protocol, pending: null }),
    /no pending placement/u,
  );
});

test("outside a repair, a confident part beside itself is still refused as in v7", async () => {
  const graph = await baseGraph();
  await assert.rejects(
    place(graph, { move: "node-c", anchor: "node-c", direction: "right" }),
    error => error instanceof DecisionRefused && /beside itself/u.test(error.message),
  );
  // And a stale answer is refused during a repair exactly as it is outside one.
  const { pending } = await nearPlacement(graph);
  const layout = layoutOf(graph);
  await assert.rejects(
    repairStep({
      working: graph, revision: "sha256:old", answers: answersWith(graph, layout, { action: ACTION_NONE, anchor: "node-a" }),
      protocol, layout, visibleFrame: frameOf(graph), pending,
    }),
    /stale/u,
  );
});

// The held piece is bound to the exact picture it was said against: the working
// head, the frame to the unit, and the parts offered from it. It is kept in
// the page's memory only, and Jev is only ever told the ids and the side.
test("a held piece records its head, frame and offered parts, and Jev sees none of the geometry", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const { pending } = await nearPlacement(graph);
  assert.equal(pending.head, graph.head);
  assert.deepEqual([...pending.frame], [...frameOf(graph).frame]);
  assert.deepEqual([...pending.offered], [...placeableIds(layout, graph.records, frameOf(graph).frame)]);
  assert.deepEqual(Object.keys(pendingForJev(pending)).sort(), ["anchor", "direction", "missing", "move"],
    "no frame, head or offered list goes to Jev");
  assert.equal(pendingHolds(pending, { head: graph.head, frame: frameOf(graph).frame, offered: pending.offered }), true);
});

test("any change to the frame, the head or the parts on offer drops the held piece", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);
  const spec = { action: ACTION_NONE, anchor: "node-a" };
  const held = frameOf(graph);
  const shifted = frameOf(graph, [held.frame[0] + 1, ...held.frame.slice(1)]);

  // Same picture: the bare neighbour completes it.
  const same = await reply(graph, pending, spec);
  assert.equal(same.outcome, OUTCOME_STEP, "precondition: unchanged, the repair completes");

  // Offered from a frame one unit off, judged against the held one.
  const offeredMoved = await reply(graph, pending, spec, held, shifted.frame);
  assert.equal(offeredMoved.reason, REPAIR_CONTEXT_CHANGED, "the frame the reply was offered from moved");

  // Offered from the held frame, but the pane moved one unit before judging.
  const judgedMoved = await reply(graph, pending, spec, shifted, held.frame);
  assert.equal(judgedMoved.reason, REPAIR_CONTEXT_CHANGED, "the frame the reply was judged against moved");

  // The same frame and head, but a different list of parts on offer.
  const otherOffer = await reply(graph, { ...pending, offered: Object.freeze(pending.offered.slice(1)) }, spec);
  assert.equal(otherOffer.reason, REPAIR_CONTEXT_CHANGED, "the parts on offer changed");

  // The pane could not be read when the reply was asked.
  const unoffered = await reply(graph, pending, spec, held, null);
  assert.equal(unoffered.reason, REPAIR_CONTEXT_CHANGED, "no offered frame to compare");

  for (const answer of [offeredMoved, judgedMoved, otherOffer, unoffered]) {
    assert.equal(answer.outcome, OUTCOME_NO_CHANGE);
    assert.equal(answer.step, undefined);
    assert.equal(answer.pending, undefined, "and nothing is held in its place");
  }
});

test("a complete new instruction still wins after the picture changed", async () => {
  const graph = await baseGraph();
  const { pending } = await nearPlacement(graph);
  const held = frameOf(graph);
  const shifted = frameOf(graph, [held.frame[0] + 1, ...held.frame.slice(1)]);
  const complete = await reply(graph, pending,
    { action: ACTION_PLACE_PART, move: "node-b", anchor: "node-a", direction: "right" }, shifted, shifted.frame);
  assert.equal(complete.outcome, OUTCOME_STEP, "a complete placement is judged as itself");
  assert.equal(complete.repaired, undefined, "and is not a repair");
});

test("nothing is held when the pane could not be read, showed another head, or moved during the turn", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const answers = answersWith(graph, layout, {
    action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "right", sure: MEASURED,
  });
  const held = frameOf(graph);
  for (const [label, visibleFrame, offeredFrame] of [
    ["no frame when judging", null, held.frame],
    ["no frame when asking", held, null],
    ["another head", { ...held, head: "sha256:stale" }, held.frame],
    ["moved between asking and judging", held, [held.frame[0] + 1, ...held.frame.slice(1)]],
  ]) {
    const near = await planStep({ working: graph, revision: graph.head, answers, protocol, layout, visibleFrame, offeredFrame });
    assert.equal(near.outcome, OUTCOME_NO_CHANGE, label);
    assert.equal(near.pending, undefined, `${label}: nothing is held`);
  }
});

test("a placement is a history fact, and reverting it puts the part back", async () => {
  const graph = await baseGraph();
  const planned = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" });
  const moved = await appendStep({ working: graph, step: planned.step, protocol });
  const states = await statesOf(moved.log, verifyDecisionLog);

  const projected = await projectHistory(moved, { verifyDecisionLog });
  const facts = projected.entries.at(-1).facts;
  assert.equal(facts.length, 1, "a placement must leave exactly one fact");
  assert.equal(facts[0].kind, "layout");
  assert.equal(facts[0].id, "node-c");

  const revert = await revertStep({ before: states[0], after: states[1], working: moved, protocol });
  assert.deepEqual(revert.decision.operations, [{ type: "UnpinRegions", regionIds: ["node-c"] }]);
  const back = await appendStep({ working: moved, step: revert, protocol });
  const layout = layoutOf(back);
  assert.deepEqual(layout.pinned, [], "the part is back under automatic layout");
  assert.deepEqual(layout.bounds["node-c"], layoutOf(graph).bounds["node-c"], "and back where it was");
});

test("a second placement restores the first position, and a later move refuses the revert", async () => {
  const graph = await baseGraph();
  const first = await appendStep({ working: graph, step: (await place(graph, { move: "node-c", anchor: "node-a", direction: "right" })).step, protocol });
  const second = await appendStep({ working: first, step: (await place(first, { move: "node-c", anchor: "node-b", direction: "below" })).step, protocol });
  const states = await statesOf(second.log, verifyDecisionLog);

  const revert = await revertStep({ before: states[1], after: states[2], working: second, protocol });
  assert.equal(revert.decision.operations[0].type, "PinRegions", "the earlier pin is restored, not removed");
  assert.deepEqual(revert.decision.operations[0].items[0].bounds, [...layoutOf(first).bounds["node-c"]]);

  const third = await appendStep({ working: second, step: (await place(second, { move: "node-c", anchor: "node-b", direction: "right" })).step, protocol });
  await assert.rejects(
    revertStep({ before: states[1], after: states[2], working: third, protocol }),
    error => error instanceof DecisionRefused && /already moved this part/u.test(error.message),
  );
});

// The Pages Function side of v7: which questions are put to Jev for a given
// working graph, draft, focus, recent conversation and placeable parts, and
// what shape comes back. Only the request moved to v7; the answer is still
// decision.v4.

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
const PART_KEYS = [...PART_PALETTE.map(part => part.key), "none"];
const EDGE = { id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" };
const ADDED = { change: "added", from: "node-c", to: "node-a" };
const PART_ADDED = { change: "added", kind: "region", id: "part-1", label: "判断 1" };

const v5 = ({
  utterance = "reverse that edge",
  edges = [],
  draft = [],
  focus = { kind: "none", changes: [] },
  recent = [],
} = {}) => ({
  kind: "voice-ui.jev.request.v7",
  state: { utterance, working: { regions: REGIONS, edges, placeable: [] }, draft, focus, context: { recent } },
});

// Earlier utterances as the page sends them: one per outcome.
const HEARD = [
  { seq: 1, source: "typed", text: "b is the database", outcome: "no-change" },
  { seq: 2, source: "voice", text: "ADD AN EDGE FROM C TO A", outcome: "step", effect: { changes: [ADDED] } },
  { seq: 4, source: "typed", text: "undo that", outcome: "undo-request" },
  { seq: 5, source: "typed", text: "add an edge from c to c", outcome: "refused" },
  { seq: 7, source: "voice", text: "ADD AN EDGE FROM A TO B", outcome: "undone" },
];

test("v7 on an edgeless working graph asks only about adding, and forwards the named state object", async () => {
  const request = v5({ utterance: "add an edge from c to a" });
  const { result, calls } = await withProvider({
    action: providerChoice("add-edge", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("node-c", NODE_KEYS),
    target: providerChoice("node-a", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(request));

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v4");
  assert.deepEqual(Object.keys(body.answers), ["action", "source", "target", "part"]);

  const [call] = calls;
  assert.deepEqual(call.state, request.state, "Jev gets the page's state object, unchanged");
  assert.deepEqual(Object.keys(call.questions), ["action", "source", "target", "part"]);
  assert.deepEqual(Object.keys(call.questions.action.criteria), ["add-edge", "add-part", "undo-request", "none"]);
  assert.deepEqual(Object.keys(call.questions.source.criteria), NODE_KEYS);
  assert.deepEqual(Object.keys(call.questions.target.criteria), NODE_KEYS);
});

test("v7 with a working edge offers remove, reverse, that edge or none, and feeds planStep", async () => {
  const actions = ["add-edge", "add-part", "remove-edge", "reverse-edge", "undo-request", "none"];
  const request = v5({ edges: [EDGE], draft: [{ changes: [ADDED] }], focus: { kind: "draft", changes: [ADDED] } });
  const { result, calls } = await withProvider({
    action: providerChoice("reverse-edge", actions),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
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

test("v7 passes an undo-request through; the step code turns it into no change", async () => {
  const actions = ["add-edge", "add-part", "remove-edge", "reverse-edge", "undo-request", "none"];
  const { result } = await withProvider({
    action: providerChoice("undo-request", actions),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
    edge: providerChoice(EDGE.id, [EDGE.id, "none"]),
  }, () => postJev(v5({ utterance: "undo that", edges: [EDGE], draft: [{ changes: [ADDED] }], focus: { kind: "draft", changes: [ADDED] } })));

  const body = await result.json();
  const working = await step(await baseGraph(), { action: ACTION_ADD, source: "node-c", target: "node-a" });
  const planned = await planStep({ working, revision: working.head, answers: body.answers, protocol });
  assert.equal(planned.outcome, OUTCOME_NO_CHANGE);
  assert.equal(planned.undoRequest, true);
});

test("v7 rejects malformed requests and off-criteria answers", async () => {
  const nine = Array.from({ length: 9 }, () => ({ changes: [ADDED] }));
  const bad = [
    { ...v5(), extra: true },
    { kind: "voice-ui.jev.request.v7", state: { ...v5().state, extra: 1 } },
    { kind: "voice-ui.jev.request.v7", state: { ...v5().state, utterance: "  " } },
    { kind: "voice-ui.jev.request.v7", state: { ...v5().state, working: { regions: [...REGIONS, "none"], edges: [], placeable: [] } } },
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
    action: providerChoice("remove-edge", ["add-edge", "add-part", "remove-edge", "undo-request", "none"]),
    source: providerChoice("node-a", NODE_KEYS),
    target: providerChoice("node-b", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(v5()));
  assert.equal(result.status, 502, "remove offered to nobody must not come back");
});

test("v7 forwards the recent conversation unchanged and tells every question it is unverified", async () => {
  const request = v5({ utterance: "connect a to the database", recent: HEARD });
  const { result, calls } = await withProvider({
    action: providerChoice("add-edge", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("node-a", NODE_KEYS),
    target: providerChoice("node-b", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
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

test("v7 refuses a malformed recent conversation, and a v4 request is no longer served", async () => {
  const [noChange, stepEntry] = HEARD;
  const bad = [
    // A v4 request, exactly as the previous page sent it.
    { kind: "voice-ui.jev.request.v4", state: { utterance: "x", working: { regions: REGIONS, edges: [] }, draft: [], focus: { kind: "none", changes: [] } } },
    // v5 without the context, or with a different shape.
    { kind: "voice-ui.jev.request.v7", state: { utterance: "x", working: { regions: REGIONS, edges: [] }, draft: [], focus: { kind: "none", changes: [] } } },
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
    action: providerChoice("none", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(exactlyFull));
  assert.equal(result.status, 200, "five entries of 200 characters are accepted");
});

test("v7 carries part effects in the draft, focus and conversation, and offers the palette", async () => {
  const request = v5({
    utterance: "add a decision",
    draft: [{ changes: [PART_ADDED] }],
    focus: { kind: "draft", changes: [PART_ADDED] },
    recent: [{ seq: 1, source: "typed", text: "add a decision", outcome: "step", effect: { changes: [PART_ADDED] } }],
  });
  const { result, calls } = await withProvider({
    action: providerChoice("add-part", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("decision", PART_KEYS),
  }, () => postJev(request));

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v4", "the answer's contract is unchanged");
  assert.equal(body.answers.part.choice, "decision");

  const [call] = calls;
  assert.deepEqual(call.state, request.state, "a part effect reaches Jev exactly as the page sent it");
  assert.deepEqual(Object.keys(call.questions.part.criteria), PART_KEYS);
  assert.deepEqual(Object.keys(call.questions.action.criteria), ["add-edge", "add-part", "undo-request", "none"]);
  assert.match(call.questions.part.instructions, /which kind of part/u);

  // The step code takes that answer and makes exactly one part.
  const planned = await planStep({
    working: await baseGraph(),
    revision: (await baseGraph()).head,
    answers: body.answers,
    protocol,
  });
  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.action, ACTION_ADD_PART);
});

test("v7 refuses a malformed part effect, and a v5 request is no longer served", async () => {
  const bad = [
    // The previous contract, exactly as the earlier page sent it.
    {
      kind: "voice-ui.jev.request.v5",
      state: { ...v5().state },
    },
    v5({ draft: [{ changes: [{ ...PART_ADDED, kind: "relation" }] }] }),
    v5({ draft: [{ changes: [{ change: "added", kind: "region", id: "part-1" }] }] }),
    v5({ draft: [{ changes: [{ ...PART_ADDED, label: "" }] }] }),
    v5({ draft: [{ changes: [{ ...PART_ADDED, label: "x".repeat(121) }] }] }),
    v5({ draft: [{ changes: [{ ...PART_ADDED, extra: true }] }] }),
    v5({ draft: [{ changes: [{ ...PART_ADDED, change: "moved" }] }] }),
    v5({ focus: { kind: "draft", changes: [{ ...PART_ADDED, from: "node-a" }] } }),
    v5({ recent: [{ seq: 1, source: "typed", text: "x", outcome: "step", effect: { changes: [{ ...PART_ADDED, id: "" }] } }] }),
  ];
  for (const body of bad) assert.equal((await postJev(body)).status, 422, JSON.stringify(body));
});

test("the palette the page validates against is exactly the one Jev is offered", async () => {
  const { calls } = await withProvider({
    action: providerChoice("none", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(v5()));
  const offered = Object.keys(calls[0].questions.part.criteria);
  assert.deepEqual(offered, correctionCriteria((await baseGraph()).records).parts,
    "the worker's part options and the app's palette must not drift apart");
});

const PLACED = { change: "placed", kind: "region", id: "node-c", anchor: "node-a", direction: "right" };

test("v7 offers placement only when the view placed two parts, and never a coordinate", async () => {
  const actions = ["add-edge", "add-part", "place-part", "undo-request", "none"];
  const request = v5({ utterance: "put c to the right of a" });
  request.state.working = { ...request.state.working, placeable: REGIONS };
  const { result, calls } = await withProvider({
    action: providerChoice("place-part", actions),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
    move: providerChoice("node-c", NODE_KEYS),
    anchor: providerChoice("node-a", NODE_KEYS),
    direction: providerChoice("right", [...DIRECTIONS, "none"]),
  }, () => postJev(request));

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v4", "the answer's contract is unchanged");
  assert.deepEqual(Object.keys(body.answers), ["action", "source", "target", "part", "move", "anchor", "direction"]);

  const [call] = calls;
  assert.deepEqual(call.state, request.state, "Jev gets the page's state object, unchanged");
  assert.deepEqual(Object.keys(call.questions.action.criteria), actions);
  assert.deepEqual(Object.keys(call.questions.move.criteria), NODE_KEYS);
  assert.deepEqual(Object.keys(call.questions.anchor.criteria), NODE_KEYS);
  assert.deepEqual(Object.keys(call.questions.direction.criteria), [...DIRECTIONS, "none"]);
  assert.equal(JSON.stringify(call).includes("bounds"), false, "Jev is never told where anything is drawn");

  // One part on screen is nobody to stand beside.
  const alone = v5({ utterance: "put c to the right of a" });
  alone.state.working = { ...alone.state.working, placeable: ["node-a"] };
  const { calls: lonely } = await withProvider({
    action: providerChoice("none", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(alone));
  assert.deepEqual(Object.keys(lonely[0].questions.action.criteria), ["add-edge", "add-part", "undo-request", "none"]);
  assert.deepEqual(Object.keys(lonely[0].questions).filter(name => ["move", "anchor", "direction"].includes(name)), []);
});

test("v7 refuses an unplaceable part, a placement answer nobody was offered, and a malformed placement effect", async () => {
  const bad = [
    { kind: "voice-ui.jev.request.v7", state: { ...v5().state, working: { regions: REGIONS, edges: [] } } },
    { kind: "voice-ui.jev.request.v7", state: { ...v5().state, working: { regions: REGIONS, edges: [], placeable: ["node-z"] } } },
    { kind: "voice-ui.jev.request.v7", state: { ...v5().state, working: { regions: REGIONS, edges: [], placeable: ["node-a", "node-a"] } } },
    v5({ draft: [{ changes: [{ ...PLACED, direction: "diagonal" }] }] }),
    v5({ draft: [{ changes: [{ ...PLACED, anchor: "node-c" }] }] }),
    v5({ draft: [{ changes: [{ ...PLACED, kind: "relation" }] }] }),
    v5({ draft: [{ changes: [{ ...PLACED, bounds: [0, 0, 1, 1] }] }] }),
    v5({ draft: [{ changes: [{ change: "placed", from: "node-a", to: "node-c" }] }] }),
    // Half-undone: a neighbour with no side, or a side with no neighbour.
    v5({ focus: { kind: "draft", changes: [{ ...PLACED, anchor: "none" }] } }),
    v5({ focus: { kind: "draft", changes: [{ ...PLACED, direction: "none" }] } }),
  ];
  for (const body of bad) assert.equal((await postJev(body)).status, 422, JSON.stringify(body));

  // A revert says a part went back: no neighbour and no side, which is the one
  // shape the step code produces for undoing a placement.
  const graph = await baseGraph();
  const moved = await appendStep({
    working: graph,
    step: (await place(graph, { move: "node-c", anchor: "node-a", direction: "right" })).step,
    protocol,
  });
  const states = await statesOf(moved.log, verifyDecisionLog);
  const undo = await revertStep({ before: states[0], after: states[1], working: moved, protocol });
  const [restored] = changesForJev(undo.changes);
  assert.deepEqual(restored, { change: "placed", kind: "region", id: "node-c", anchor: "none", direction: "none" });
  const { result: accepted } = await withProvider({
    action: providerChoice("none", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(v5({ draft: [{ changes: [restored] }], focus: { kind: "draft", changes: [restored] } })));
  assert.equal(accepted.status, 200);

  // Placement offered to nobody must not come back as an answer.
  const { result } = await withProvider({
    action: providerChoice("place-part", ["add-edge", "add-part", "place-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(v5()));
  assert.equal(result.status, 502);
});

test("v7 carries a placement effect back to Jev, and its answer feeds the step code", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const request = v5({
    utterance: "now put b to the left of c",
    draft: [{ changes: [PLACED] }],
    focus: { kind: "draft", changes: [PLACED] },
    recent: [{ seq: 1, source: "typed", text: "put c right of a", outcome: "step", effect: { changes: [PLACED] } }],
  });
  request.state.working = { ...request.state.working, placeable: [...placeableIds(layout, graph.records)] };

  const { result, calls } = await withProvider({
    action: providerChoice("place-part", ["add-edge", "add-part", "place-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
    move: providerChoice("node-b", NODE_KEYS),
    anchor: providerChoice("node-c", NODE_KEYS),
    direction: providerChoice("left", [...DIRECTIONS, "none"]),
  }, () => postJev(request));

  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(calls[0].state, request.state, "a placement effect reaches Jev exactly as the page sent it");

  const planned = await planStep({
    working: graph, revision: graph.head, answers: body.answers, protocol, layout,
    visibleFrame: frameOf(graph),
  });
  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.action, ACTION_PLACE_PART);
  assert.deepEqual(
    planned.step.decision.operations[0].items[0].bounds,
    [...neighbourBounds(layout, "node-b", "node-c", "left")],
  );
});

// v8 is v7 plus the pending placement. The questions are the same, so a
// complete or unrelated instruction is judged as without it; only the missing
// piece's question says that a reply may supply just that piece.
const v8 = (pending, overrides = {}) => {
  const base = v5({ utterance: "相手はノードAです", ...overrides });
  return {
    kind: "voice-ui.jev.request.v8",
    state: { ...base.state, working: { ...base.state.working, placeable: REGIONS }, pending },
  };
};
const PENDING = { missing: "anchor", move: "node-c", anchor: null, direction: "left" };
const V8_ANSWERS = {
  action: providerChoice("none", ["add-edge", "add-part", "place-part", "undo-request", "none"]),
  source: providerChoice("none", NODE_KEYS),
  target: providerChoice("none", NODE_KEYS),
  part: providerChoice("none", PART_KEYS),
  move: providerChoice("none", NODE_KEYS),
  anchor: providerChoice("node-a", NODE_KEYS),
  direction: providerChoice("none", [...DIRECTIONS, "none"]),
};

test("v8 carries the pending placement to Jev and asks the same questions", async () => {
  const request = v8(PENDING);
  const { result, calls } = await withProvider(V8_ANSWERS, () => postJev(request));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v4", "the answer's contract is unchanged");
  assert.equal(body.answers.anchor.choice, "node-a");

  const [call] = calls;
  assert.deepEqual(call.state, request.state, "the pending placement reaches Jev exactly as sent");
  assert.deepEqual(Object.keys(call.questions), ["action", "source", "target", "part", "move", "anchor", "direction"]);
  assert.match(call.questions.anchor.instructions, /state\.pending/u, "the missing piece's question says so");
  for (const name of ["action", "move", "direction", "source", "target", "part"]) {
    assert.equal(call.questions[name].instructions.includes("state.pending"), false, `${name} is asked as usual`);
  }
  assert.deepEqual(Object.keys(call.questions.anchor.criteria), NODE_KEYS, "the same finite choices");
  assert.equal(JSON.stringify(call).includes("bounds"), false, "still no coordinate");

  // With nothing pending the questions are exactly v7's.
  const { calls: plain } = await withProvider(V8_ANSWERS, () => postJev(v8(null)));
  const v7Request = v5({ utterance: "相手はノードAです" });
  v7Request.state.working = { ...v7Request.state.working, placeable: REGIONS };
  const { calls: old } = await withProvider(V8_ANSWERS, () => postJev(v7Request));
  assert.deepEqual(plain[0].questions, old[0].questions, "v8 with nothing pending asks what v7 asks");
});

test("v8 refuses a malformed pending placement, and v7 is still served", async () => {
  const bad = [
    v8({ ...PENDING, anchor: "node-a" }),
    v8({ ...PENDING, move: null }),
    v8({ ...PENDING, missing: "action" }),
    v8({ ...PENDING, move: "node-z" }),
    v8({ ...PENDING, direction: "diagonal" }),
    v8({ missing: "direction", move: "node-a", anchor: "node-a", direction: null }),
    v8({ ...PENDING, text: "相手はノードAです" }),
    v8({ ...PENDING, confidence: 0.39 }),
    { ...v8(PENDING), state: { ...v8(PENDING).state, working: { regions: REGIONS, edges: [], placeable: ["node-a"] } } },
    { kind: "voice-ui.jev.request.v8", state: v5().state },
    { kind: "voice-ui.jev.request.v7", state: v8(PENDING).state },
  ];
  for (const body of bad) assert.equal((await postJev(body)).status, 422, JSON.stringify(body));

  const { result } = await withProvider({
    action: providerChoice("none", ["add-edge", "add-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
  }, () => postJev(v5()));
  assert.equal(result.status, 200, "v7 is still served");
});

test("the parts the page offers for placement are exactly the ones Jev is asked about", async () => {
  const graph = await baseGraph();
  const offered = correctionCriteria(graph.records, layoutOf(graph)).placeable;
  const request = v5();
  request.state.working = { ...request.state.working, placeable: offered.filter(key => key !== OPTION_NONE) };
  const { calls } = await withProvider({
    action: providerChoice("none", ["add-edge", "add-part", "place-part", "undo-request", "none"]),
    source: providerChoice("none", NODE_KEYS),
    target: providerChoice("none", NODE_KEYS),
    part: providerChoice("none", PART_KEYS),
    move: providerChoice("none", NODE_KEYS),
    anchor: providerChoice("none", NODE_KEYS),
    direction: providerChoice("none", [...DIRECTIONS, "none"]),
  }, () => postJev(request));
  assert.deepEqual(Object.keys(calls[0].questions.move.criteria), offered,
    "the worker's placement options and the app's must not drift apart");
  assert.deepEqual(Object.keys(calls[0].questions.direction.criteria),
    correctionCriteria(graph.records, layoutOf(graph)).directions);
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
      action: providerChoice("add-edge", ["add-edge", "add-part", "undo-request", "none"]),
      source: providerChoice("node-c", NODE_KEYS),
      target: providerChoice("node-a", NODE_KEYS),
      part: providerChoice("none", PART_KEYS),
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

// Whole diagrams by purpose. Jev chooses only a catalogue key; the app composes
// that candidate - its roles, steps, labels and links - as one Decision.

const CATALOG_KEYS = DIAGRAM_CATALOG.map(entry => entry.key);
const APPROVAL = DIAGRAM_CATALOG.find(entry => entry.key === "request-approval-flow");
const composeAnswers = (graph, { action = ACTION_COMPOSE, diagram = APPROVAL.key, confidence = 0.9, diagramConfidence = confidence, ...rest } = {}) => ({
  ...answersFor(graph, { action, confidence, ...rest }),
  diagram: choice(diagram, diagramConfidence),
});
const compose = (graph, spec = {}, reserved = []) => planStep({
  working: graph, revision: graph.head, answers: composeAnswers(graph, spec), protocol, reserved, candidates: CATALOG_KEYS,
});

test("every catalogue diagram fits one step and tells Jev only its key and purpose", () => {
  assert.ok(DIAGRAM_CATALOG.length >= 1);
  const kinds = new Set(PART_PALETTE.map(part => part.kind));
  for (const entry of DIAGRAM_CATALOG) {
    assert.ok(entry.lanes.length + entry.steps.length + entry.links.length <= 8,
      `${entry.key} must fit the eight changes one step may carry`);
    const laneRefs = new Set(entry.lanes.map(lane => lane.ref));
    const stepLane = new Map(entry.steps.map(step => [step.ref, step.lane]));
    for (const step of entry.steps) {
      assert.ok(laneRefs.has(step.lane), `${step.ref} sits in a lane of the diagram`);
      assert.ok(kinds.has(step.kind), `${step.ref} is a kind the view already draws`);
    }
    for (const [from, to] of entry.links) assert.ok(stepLane.has(from) && stepLane.has(to));
    assert.ok(entry.links.some(([from, to]) => stepLane.get(from) !== stepLane.get(to)),
      "a cross-functional flow crosses between roles");
  }
  assert.deepEqual(diagramCandidatesForJev().map(candidate => Object.keys(candidate).sort()),
    DIAGRAM_CATALOG.map(() => ["key", "purpose"]), "Jev is told the key and the purpose, never the structure");
});

test("a chosen diagram is composed whole, as one Decision, beside what was already there", async () => {
  const graph = await baseGraph();
  const planned = await compose(graph);
  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.action, ACTION_COMPOSE);

  const operations = planned.step.decision.operations;
  const laneIds = ["part-1", "part-2"];
  const stepIds = ["part-3", "part-4", "part-5"];
  assert.deepEqual(operations.map(operation => operation.type),
    ["AddRegion", "AddRegion", "AddRegion", "AddRegion", "AddRegion", "ConnectRegions", "ConnectRegions"],
    "every lane, step and link is in the one Decision");
  operations.slice(0, 2).forEach((operation, index) => {
    assert.equal(operation.regionId, laneIds[index]);
    assert.equal(operation.parentId, "root");
    assert.equal(operation.kind, "group", "a group, which the view opens at pane size");
    assert.equal(operation.label, APPROVAL.lanes[index].label, "the label is the catalogue's, never Jev's");
    assert.equal(operation.order, index);
  });
  const laneOf = { submit: "part-1", review: "part-2", receive: "part-1" };
  operations.slice(2, 5).forEach((operation, index) => {
    const spec = APPROVAL.steps[index];
    assert.equal(operation.regionId, stepIds[index]);
    assert.equal(operation.parentId, laneOf[spec.ref], `${spec.ref} is inside its role's lane`);
    assert.equal(operation.label, spec.label);
    assert.equal(operation.kind, spec.kind);
  });
  assert.deepEqual(operations.slice(5).map(operation => `${operation.from}->${operation.to}`),
    ["part-3->part-4", "part-4->part-5"], "directed links, each crossing between the two roles");
  assert.equal(planned.step.changes.length, 7);

  const working = await appendStep({ working: graph, step: planned.step, protocol });
  const region = id => working.records.find(record => record.type === "region" && record.id === id);
  for (const id of ["node-a", "node-b", "node-c"]) {
    assert.deepEqual(region(id), graph.records.find(record => record.id === id), `${id} is kept as it was`);
  }
  assert.deepEqual(edges(working), ["part-3->part-4", "part-4->part-5"]);
  for (const [from, to] of [["part-3", "part-4"], ["part-4", "part-5"]]) {
    assert.notEqual(region(from).parent, region(to).parent, `${from}->${to} crosses roles`);
  }

  // The view nests each step inside its lane, beside the parts already there.
  const layout = layoutOf(working);
  const inside = (outer, inner) => inner[0] >= outer[0] && inner[1] >= outer[1]
    && inner[0] + inner[2] <= outer[0] + outer[2] && inner[1] + inner[3] <= outer[1] + outer[3];
  for (const id of stepIds) {
    assert.ok(inside(layout.bounds[region(id).parent], layout.bounds[id]), `${id} is drawn inside its lane`);
  }
  for (const id of ["node-a", "node-b", "node-c", ...laneIds]) assert.ok(layout.bounds[id], `${id} is placed`);
  assert.equal(graph.head === working.head, false, "only the working graph moved");
});

test("an unsupported or unsure diagram request changes nothing", async () => {
  const graph = await baseGraph();
  const notOffered = await compose(graph, { diagram: "none" });
  assert.equal(notOffered.outcome, OUTCOME_NO_CHANGE);
  assert.equal(notOffered.reason, DIAGRAM_NOT_OFFERED);
  const unsure = await compose(graph, { diagramConfidence: 0.4 });
  assert.equal(unsure.outcome, OUTCOME_NO_CHANGE);
  assert.equal(unsure.reason, DIAGRAM_RESTATE);
  const nothing = await compose(graph, { action: "none", diagram: "none" });
  assert.equal(nothing.outcome, OUTCOME_NO_CHANGE);
  for (const answer of [notOffered, unsure, nothing]) assert.equal(answer.step, undefined);
});

test("a diagram answer must be exactly what was offered", async () => {
  const graph = await baseGraph();
  const base = { working: graph, revision: graph.head, protocol };
  await assert.rejects(planStep({ ...base, answers: answersFor(graph, { action: "none" }), candidates: CATALOG_KEYS }),
    /answers\.diagram is required/u);
  await assert.rejects(planStep({ ...base, answers: composeAnswers(graph), candidates: [] }),
    /answers\.diagram is not allowed/u, "no candidates offered, so no diagram answer");
  await assert.rejects(planStep({ ...base, answers: composeAnswers(graph, { diagram: "aws-architecture" }), candidates: CATALOG_KEYS }),
    /outside the offered criteria/u);
  await assert.rejects(planStep({ ...base, answers: composeAnswers(graph), candidates: ["aws-architecture"] }),
    /not in the diagram catalogue/u);
});

test("a composed diagram is undone whole, and is not offered as a revert", async () => {
  const graph = await baseGraph();
  const working = await appendStep({ working: graph, step: (await compose(graph)).step, protocol });
  const undone = await truncateLog(working, { count: working.decisions.length - 1, floor: graph.decisions.length, verifyDecisionLog });
  assert.equal(undone.log, graph.log, "one Undo takes every lane, step and link away together");

  const states = await statesOf(working.log, verifyDecisionLog);
  await assert.rejects(revertStep({ before: states[0], after: states[1], working, protocol }),
    error => error instanceof DecisionRefused, "reverting a whole diagram is not supported");
});

test("a composed draft is refined like any other graph, and its names are never reused", async () => {
  const graph = await baseGraph();
  const working = await appendStep({ working: graph, step: (await compose(graph)).step, protocol });
  const refine = await planStep({
    working,
    revision: working.head,
    answers: { ...answersFor(working, { action: "add-edge", source: "part-4", target: "part-3" }), diagram: choice("none") },
    protocol,
    candidates: CATALOG_KEYS,
  });
  assert.equal(refine.outcome, OUTCOME_STEP);
  const refined = await appendStep({ working, step: refine.step, protocol });
  assert.deepEqual(edges(refined).sort(), ["part-3->part-4", "part-4->part-3", "part-4->part-5"]);

  const again = await compose(refined, {}, ["part-9"]);
  assert.deepEqual(again.step.decision.operations.filter(operation => operation.type === "AddRegion").map(operation => operation.regionId),
    ["part-10", "part-11", "part-12", "part-13", "part-14"], "a second diagram takes new names after every one handed out");
});

// v9: v8 plus the candidates, by key and purpose only.
const v9 = (overrides = {}) => {
  const base = v8(null, { utterance: "申請して承認してもらう流れを図にして" });
  return {
    kind: "voice-ui.jev.request.v9",
    state: { ...base.state, candidates: diagramCandidatesForJev().map(({ key, purpose }) => ({ key, purpose })), ...overrides },
  };
};
const V9_ACTIONS = ["add-edge", "add-part", "place-part", "compose-diagram", "undo-request", "none"];
const DIAGRAM_KEYS = [...CATALOG_KEYS, "none"];
const V9_ANSWERS = {
  action: providerChoice("compose-diagram", V9_ACTIONS),
  source: providerChoice("none", NODE_KEYS),
  target: providerChoice("none", NODE_KEYS),
  part: providerChoice("none", PART_KEYS),
  move: providerChoice("none", NODE_KEYS),
  anchor: providerChoice("none", NODE_KEYS),
  direction: providerChoice("none", [...DIRECTIONS, "none"]),
  diagram: providerChoice(APPROVAL.key, DIAGRAM_KEYS),
};

test("v9 offers Jev the diagrams by key and purpose, and a diagram answer comes back as a key", async () => {
  const request = v9();
  const { result, calls } = await withProvider(V9_ANSWERS, () => postJev(request));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "voice-ui.jev.decision.v4");
  assert.equal(body.answers.action.choice, "compose-diagram");
  assert.equal(body.answers.diagram.choice, APPROVAL.key);

  const [call] = calls;
  assert.deepEqual(call.state, request.state, "the candidates reach Jev exactly as sent");
  assert.deepEqual(Object.keys(call.questions.action.criteria), V9_ACTIONS);
  assert.deepEqual(Object.keys(call.questions.diagram.criteria), DIAGRAM_KEYS, "a finite choice, with none");
  assert.match(call.questions.diagram.criteria[APPROVAL.key], /two roles/u, "each choice says what the diagram is for");
  for (const label of [...APPROVAL.lanes, ...APPROVAL.steps].map(spec => spec.label)) {
    assert.equal(JSON.stringify(call).includes(label), false, `${label} stays with the page`);
  }

  // Without candidates nothing about diagrams is asked.
  const { calls: plain } = await withProvider(V8_ANSWERS, () => postJev(v8(null)));
  assert.equal(Object.hasOwn(plain[0].questions, "diagram"), false);
  assert.equal(Object.keys(plain[0].questions.action.criteria).includes("compose-diagram"), false);

  // An answer that leaves out the diagram is the provider breaking the contract.
  const { diagram, ...missing } = V9_ANSWERS;
  const { result: broken } = await withProvider(missing, () => postJev(v9()));
  assert.equal(broken.status, 502);
  assert.deepEqual(await broken.json(), { error: "provider_contract_error" });
});

test("v9 refuses malformed candidates", async () => {
  const one = diagramCandidatesForJev()[0];
  const bad = [
    v9({ candidates: [] }),
    v9({ candidates: [{ ...one, lanes: ["申請者"] }] }),
    v9({ candidates: [{ ...one, key: "none" }] }),
    v9({ candidates: [{ ...one, key: "Request Flow" }] }),
    v9({ candidates: [one, one] }),
    v9({ candidates: [{ ...one, purpose: "x".repeat(301) }] }),
    v9({ candidates: [{ ...one, purpose: " " }] }),
    { kind: "voice-ui.jev.request.v9", state: v8(null).state },
    { kind: "voice-ui.jev.request.v8", state: v9().state },
  ];
  for (const body of bad) assert.equal((await postJev(body)).status, 422, JSON.stringify(body).slice(0, 200));
});
