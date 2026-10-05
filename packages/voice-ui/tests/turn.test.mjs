import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readBundle } from "../src/bundle.mjs";
import { runGoal } from "../src/goal.mjs";
import { createSession } from "../src/session.mjs";
import {
  ACTION_ADD_EDGE,
  ACTION_ADD_PART,
  ACTION_COMPOSE,
  ACTION_PLACE_PART,
  ACTION_REMOVE_EDGE,
  ACTION_REVERSE_EDGE,
  ACTION_UNDO_REQUEST,
  DIRECTIONS,
  NONE,
  REQUEST_KIND,
  isRequest,
} from "../src/contract.mjs";
import { MAP_ID, STATE_SCHEMA, restoreLog, statesOf, truncateLog } from "../src/log.mjs";
import { drawGraph, frameFor, renderWorkingNotice } from "../src/render.mjs";

test("local camera uses declared layout without changing records or assuming every label fits", () => {
  const records = [{ id: "a" }];
  const graph = { records };
  const protocol = { GRAPH_PATTERN: "graph/1", layoutBoundsFor: actual => {
    assert.equal(actual, records);
    return { rootBounds: [0, 0, 1804, 2462], bounds: { a: [100, 200, 140, 64] } };
  } };
  assert.deepEqual(frameFor({ graph, width: 619, height: 541, protocol }), { bbox: [0, 0, 1804, 2462], viewport: [619, 541] });
  assert.deepEqual(frameFor({ graph, width: 619, height: 541, protocol, part: "a" }), { bbox: [-139.5, -38.5, 619, 541], viewport: [619, 541] });
  assert.equal(frameFor({ graph, width: 619, height: 541, protocol, part: "missing" }), null);
  assert.equal(frameFor({ graph, width: 0, height: 541, protocol }), null);
  assert.deepEqual(records, [{ id: "a" }]);
});

test("working notice distinguishes storage evidence from display failure and draft emptiness", () => {
  const notice = {};
  const show = values => { renderWorkingNotice(notice, { working: true, draftLength: 0, displayFailed: false, ...values }); return notice.textContent; };
  assert.match(show({ storage: "verified" }), /保存済み/u);
  assert.match(show({ storage: "verified", draftLength: 1 }), /未反映/u);
  assert.match(show({ storage: "absent" }), /未反映/u);
  assert.match(show({ storage: "absent", working: false }), /保存済みの図もありません/u);
  assert.match(show({ storage: "verified", displayFailed: true }), /保存内容は確認済み.*表示を確認できません/u);
  assert.match(show({ storage: "absent", displayFailed: true }), /保存済みの図はありません/u);
  assert.match(show({ storage: "invalid" }), /復元できません/u);
  assert.match(show({ storage: "unverified" }), /書き込み後/u);
  assert.match(show({ storage: "unread" }), /まだ読み取っていません/u);
  assert.throws(() => show({ storage: "unknown" }), /unknown storage evidence/u);
});
import {
  ACTION_NEW,
  OUTCOME_NO_CHANGE,
  OUTCOME_REFUSED,
  OUTCOME_STEP,
  appendStep,
  legalLocalDeltas as legalAdditions,
  proveLocalDelta as proveAddition,
  legalLocalDeltas,
  proveLocalDelta,
  changesForJudgment,
  focusFor,
  newMap,
  pendingForJudgment,
  pendingHolds,
  placeableIds,
  planStep,
  repairStep,
  requestFor,
  revertStep,
  revertable,
} from "../src/turn.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href);
const verifyDecisionLog = protocol.verifyDecisionLog;

// The shipped DataBundle, read the way the page reads it.
const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = readBundle(JSON.parse(fs.readFileSync(path.join(here, "../web/data/bundle.v1.json"), "utf8")));
const NO_BUNDLE = readBundle(null);
// Test fixture convenience delegates to the production catalogue/prove path.
const planAddition = async ({ working, head, partKey, parentId, confidence, bundle, reserved = [], protocol }) => {
  if (working.head !== head) return { reason: "stale-head" };
  const parent = working.records.find(record => record.type === "region" && record.id === parentId && record.kind === "group" && record.parent !== null);
  if (!parent || !bundle.parts.some(part => part.key === partKey)) return { reason: "invalid-addition" };
  const held = legalAdditions(working, { bundle, reserved, protocol });
  const candidate = held.candidates.find(item => item.part === partKey && item.parent === parentId);
  if (!candidate) return { reason: "no-room-for-part" };
  return proveAddition({ working, held, candidateId: candidate.id, confidence, bundle, reserved, protocol });
};


// A fixture graph of three plain nodes, built through this app's own map
// namespace and state schema.
const node = (id, x) => ({ type: "region", id, parent: "root", label: id, kind: "node", bounds: [x, 90, 140, 64], summary: "" });
const baseGraph = () => protocol.createDecisionLog([
  { type: "meta", schema: STATE_SCHEMA, root: "root", title: "fixture" },
  { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  node("node-a", 40),
  node("node-b", 250),
  node("node-c", 460),
], MAP_ID);

test("mixed catalogue supplies the existing directed flow family and proves the original held effect", async () => {
  const graph = await baseGraph();
  const options = { bundle: BUNDLE, protocol, reserved: [], selected: [] };
  // This graph has no group: its ADD subset is empty, while Connect is legal.
  assert.equal(legalAdditions(graph, options).candidates.filter(item => item.part !== undefined).length, 0);
  const held = legalLocalDeltas(graph, options);
  assert.equal(held.candidates.length, 6);
  assert.equal(new Set(held.candidates.map(item => JSON.stringify([item.from, item.to]))).size, 6);
  assert.equal(held.candidates.every(item => item.from !== item.to && item.operations.length === 1
    && item.operations[0].type === "ConnectRegions" && item.operations[0].kind === "flow" && item.operations[0].label === ""), true);
  const candidate = held.candidates.find(item => item.from === "node-a" && item.to === "node-b");
  assert.throws(() => { candidate.operations[0].to = "node-c"; }, TypeError);
  const input = { working: graph, held, candidateId: candidate.id, confidence: 1, ...options };
  const proved = await proveLocalDelta(input);
  assert.equal(proved.outcome, OUTCOME_STEP);
  assert.deepEqual(proved.step.decision.operations, candidate.operations);
  assert.equal((await proveLocalDelta({ ...input, candidateId: "unknown" })).reason, "invalid-addition");
  assert.equal((await proveLocalDelta({ ...input, confidence: 0.49 })).reason, "not-confident");
  assert.equal((await proveLocalDelta({ ...input, reserved: ["future-id"] })).reason, "stale-addition");
  const adopted = await appendStep({ working: graph, step: proved.step, protocol });
  assert.equal(adopted.outcome, OUTCOME_STEP);
  const next = legalLocalDeltas(adopted.graph, options);
  assert.equal(next.candidates.length, 5);
  assert.equal(next.candidates.some(item => item.from === "node-a" && item.to === "node-b"), false);
  assert.equal(next.candidates.some(item => item.from === "node-b" && item.to === "node-a"), true);
  assert.equal((await proveLocalDelta({ ...input, working: adopted.graph })).reason, "stale-addition");
});

test("legal addition catalogue is finite, complete for the deterministic pairs and empty without groups", async () => {
  assert.deepEqual(legalAdditions(await baseGraph(), { bundle: BUNDLE, protocol }).candidates.filter(item => item.part !== undefined), []);
  const groups = Array.from({ length: 32 }, (_, index) => ({ type: "region", id: `group-${index}`,
    parent: "root", label: `Fixture group ${index}`, kind: "group", summary: "", bounds: [0, index * 300, 700, 200] }));
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "finite catalogue" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 3000, 20000], summary: "" },
    ...groups,
  ], MAP_ID);
  const decision = await protocol.createDecision(graph.head, [{ type: "PinRegions",
    items: groups.map((group, index) => ({ regionId: group.id, bounds: [0, index * 600, 2000, 500] })) }], graph.records);
  const prepared = (await protocol.appendDecision(graph.log, decision.decision)).verified;
  const offered = BUNDLE;
  assert.equal(offered.parts.length, 8);
  const held = legalAdditions(prepared, { bundle: offered, protocol });
  assert.equal(held.candidates.length, 256);
  assert.equal(new Set(held.candidates.map(candidate => candidate.id)).size, 256);
  assert.equal(new Set(held.candidates.map(candidate => JSON.stringify([candidate.part, candidate.parent]))).size, 256);
  assert.equal(held.candidates.every(candidate => candidate.operations.length === 2
    && candidate.operations[0].type === "AddRegion" && candidate.operations[1].type === "PinRegions"), true);
  const session = createSession({ accepted: prepared, stored: prepared.log });
  let calls = 0;
  const result = await runGoal({ utterance: "add an offered part", bundle: offered, protocol,
    current: () => session, cancelled: () => false, ask: async () => { calls += 1; assert.fail("overflow must not ask"); },
    adopt: async () => assert.fail("overflow must not adopt") });
  assert.equal(result.reason, "candidate-overflow"); assert.equal(result.requests, 0); assert.equal(calls, 0);
  assert.deepEqual(result.selected, []);
});

test("public seed mixed catalogues report actual reachable counts separately from the conservative bound", async () => {
  const initial = (await newMap({ title: "mixed public seed", protocol })).graph;
  const composition = await plan(initial, { action: ACTION_COMPOSE, diagram: "container-example" });
  assert.equal(composition.outcome, OUTCOME_STEP);
  let working = (await appendStep({ working: initial, step: composition.step, protocol })).graph;
  const selected = [];
  const counts = [];
  for (const key of ["api", "db", null]) {
    const held = legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected });
    const endpoints = working.records.filter(record => record.type === "region" && record.parent !== null && record.kind !== "group").length;
    const add = held.candidates.filter(candidate => candidate.part !== undefined).length;
    const connect = held.candidates.length - add;
    counts.push({ endpoints, add, connect, total: held.candidates.length });
    assert.equal(BUNDLE.parts.length, 8);
    assert.equal(working.records.filter(record => record.type === "region" && record.kind === "group").length, 2);
    assert.ok(endpoints <= 10 && add <= 16 && connect <= 90 && held.candidates.length <= 106);
    assert.equal(connect, endpoints * (endpoints - 1)); // This trace has no edge yet.
    if (key === null) break;
    const container = working.records.find(record => record.type === "region" && record.label === "OCI" && record.kind === "group");
    const candidate = held.candidates.find(item => item.part === key && item.parent === container.id);
    assert.ok(candidate, "the public seed actually supplies the requested pair");
    const proved = await proveLocalDelta({ working, held, candidateId: candidate.id, confidence: 1, bundle: BUNDLE, protocol, selected });
    assert.equal(proved.outcome, OUTCOME_STEP);
    working = (await appendStep({ working, step: proved.step, protocol })).graph;
    selected.push({ key, region: candidate.operations[0].regionId, parent: container.id });
  }
  assert.deepEqual(counts.map(row => [row.endpoints, row.connect]), [[3, 6], [4, 12], [5, 20]]);
  process.stdout.write(JSON.stringify({ kind: "voice-ui.publicSeedCatalogueCounts.v1", counts,
    conservativeBound: 106, scope: "this reachable trace, not all-state coverage" }) + "\n");
});

const boxOf = (graph, id) => protocol.layoutBoundsFor(graph.records, { pattern: protocol.GRAPH_PATTERN }).bounds[id];
const within = (outer, inner) => inner[0] >= outer[0] && inner[1] >= outer[1]
  && inner[0] + inner[2] <= outer[0] + outer[2] && inner[1] + inner[3] <= outer[1] + outer[3];
const apart = (a, b) => a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];

test("only a group this Goal adopted grows to take a child; a direct seed Add stays fit-or-none", async () => {
  const initial = (await newMap({ title: "nested public seed", protocol })).graph;
  const composition = await plan(initial, { action: ACTION_COMPOSE, diagram: "container-example" });
  let working = (await appendStep({ working: initial, step: composition.step, protocol })).graph;
  const regions = () => working.records.filter(record => record.type === "region");
  const root = regions().find(record => record.parent === null);
  const container = regions().find(record => record.label === "OCI" && record.kind === "group");
  const auxiliary = regions().find(record => record.kind === "group" && record.id !== container.id);
  const selected = [];
  const add = async (key, parent) => {
    const held = legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected });
    const candidate = held.candidates.find(item => item.part === key && item.parent === parent);
    assert.ok(candidate, `${key} into ${parent} is offered`);
    const proved = await proveLocalDelta({ working, held, candidateId: candidate.id, confidence: 1, bundle: BUNDLE, protocol, selected });
    assert.equal(proved.outcome, OUTCOME_STEP);
    const before = working;
    working = (await appendStep({ working, step: proved.step, protocol })).graph;
    selected.push({ key, region: candidate.operations[0].regionId, parent });
    return { before, candidate, held };
  };

  const seedBefore = { container: boxOf(working, container.id), auxiliary: boxOf(working, auxiliary.id) };
  const containerPins = () => working.records.filter(record => record.type === "layout" && record.regionId === container.id);
  const seedPins = containerPins();
  const grouped = await add("group", container.id);
  const group = grouped.candidate.operations[0].regionId;
  assert.equal(regions().find(record => record.id === group).kind, "group");
  assert.deepEqual(grouped.candidate.operations[1].items.map(item => item.regionId), [group]);
  // The same added group is not adopted history without its selected entry.
  assert.equal(legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected: [] }).candidates
    .some(candidate => candidate.parent === group), false);

  const groupBefore = boxOf(working, group);
  const nested = await add("db", group);
  const db = nested.candidate.operations[0].regionId;
  const pins = nested.candidate.operations[1].items;
  assert.deepEqual(pins.map(item => item.regionId), [db, group, container.id]);
  const grown = Object.fromEntries(pins.map(item => [item.regionId, item.bounds]));
  for (const [id, old] of [[group, groupBefore], [container.id, seedBefore.container]]) {
    assert.deepEqual(grown[id].slice(0, 2), old.slice(0, 2), "origin kept");
    assert.ok(grown[id][2] >= old[2] && grown[id][3] >= old[3], "never shrinks");
  }
  for (const item of pins) assert.deepEqual(boxOf(working, item.regionId), [...item.bounds]);
  assert.deepEqual(boxOf(working, auxiliary.id), seedBefore.auxiliary);

  const api = (await add("api", container.id)).candidate;
  assert.deepEqual(api.operations[1].items.map(item => item.regionId), [api.operations[0].regionId], "a direct seed Add never grows");
  const held = legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected });
  const edge = held.candidates.find(item => item.from === api.operations[0].regionId && item.to === db);
  const proved = await proveLocalDelta({ working, held, candidateId: edge.id, confidence: 1, bundle: BUNDLE, protocol, selected });
  assert.equal(proved.outcome, OUTCOME_STEP);
  working = (await appendStep({ working, step: proved.step, protocol })).graph;

  const parentOf = id => regions().find(record => record.id === id).parent;
  for (const record of regions().filter(record => record.parent !== null)) {
    assert.ok(within(boxOf(working, record.parent), boxOf(working, record.id)), `${record.id} is painted inside its parent`);
    for (const sibling of regions().filter(other => other.parent === record.parent && other.id !== record.id))
      assert.ok(apart(boxOf(working, record.id), boxOf(working, sibling.id)), `${record.id} and ${sibling.id} do not overlap`);
  }
  assert.equal(parentOf(parentOf(db)), container.id);
  assert.equal(parentOf(container.id), root.id);
  process.stdout.write(JSON.stringify({ kind: "voice-ui.nestedGroupTrace.v1",
    containerPins: { before: seedPins, after: containerPins() },
    pins: Object.fromEntries(pins.map(item => [regions().find(record => record.id === item.regionId).label, item.bounds])) }) + "\n");

  // A held catalogue from before the group took its child is stale afterwards.
  assert.equal((await proveLocalDelta({ working: nested.before, held: nested.held, candidateId: nested.candidate.id, confidence: 1,
    bundle: BUNDLE, protocol, selected: selected.slice(0, 1).concat([{ key: "api", region: "part-90", parent: container.id }]) })).reason, "stale-addition");
  assert.equal((await proveLocalDelta({ working, held: nested.held, candidateId: nested.candidate.id, confidence: 1,
    bundle: BUNDLE, protocol, selected: selected.slice(0, 1) })).outcome === OUTCOME_STEP, false);
});

test("a Goal-added group takes a second child one step gap below the first", async () => {
  const initial = (await newMap({ title: "second nested child", protocol })).graph;
  const composition = await plan(initial, { action: ACTION_COMPOSE, diagram: "container-example" });
  let working = (await appendStep({ working: initial, step: composition.step, protocol })).graph;
  const regions = () => working.records.filter(record => record.type === "region");
  const container = regions().find(record => record.label === "OCI" && record.kind === "group");
  const selected = [];
  const add = async (key, parent) => {
    const held = legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected });
    const candidate = held.candidates.find(item => item.part === key && item.parent === parent);
    assert.ok(candidate, `${key} into ${parent} is offered`);
    const proved = await proveLocalDelta({ working, held, candidateId: candidate.id, confidence: 1, bundle: BUNDLE, protocol, selected });
    assert.equal(proved.outcome, OUTCOME_STEP);
    working = (await appendStep({ working, step: proved.step, protocol })).graph;
    selected.push({ key, region: candidate.operations[0].regionId, parent });
    return candidate.operations[0].regionId;
  };
  const ociBefore = boxOf(working, container.id);
  const group = await add("group", container.id);
  const groupBefore = boxOf(working, group);
  const db = await add("db", group);
  const api = await add("api", group);
  const [dbBox, apiBox] = [boxOf(working, db), boxOf(working, api)];
  assert.deepEqual([apiBox[0], apiBox[1]], [dbBox[0], dbBox[1] + dbBox[3] + 24], "the second child goes one step gap below the first");
  for (const [id, old] of [[group, groupBefore], [container.id, ociBefore]]) {
    const now = boxOf(working, id);
    assert.deepEqual(now.slice(0, 2), old.slice(0, 2), "origin kept");
    assert.ok(now[2] >= old[2] && now[3] >= old[3], "never shrinks");
  }
  for (const record of regions().filter(record => record.parent !== null)) {
    assert.ok(within(boxOf(working, record.parent), boxOf(working, record.id)), `${record.id} is inside its parent`);
    for (const sibling of regions().filter(other => other.parent === record.parent && other.id !== record.id))
      assert.ok(apart(boxOf(working, record.id), boxOf(working, sibling.id)), `${record.id} and ${sibling.id} do not overlap`);
  }
});

test("a seed group whose raw grid is full still offers its one painted slot, proved and appended by the provider", async () => {
  // The seed lanes put their steps where the raw grid looks full, while the
  // painted Auxiliary frame still has room for exactly one more part.
  const initial = (await newMap({ title: "seed capacity", protocol })).graph;
  const composition = await plan(initial, { action: ACTION_COMPOSE, diagram: "container-example" });
  let working = (await appendStep({ working: initial, step: composition.step, protocol })).graph;
  const regions = () => working.records.filter(record => record.type === "region");
  const auxiliary = regions().find(record => record.label === "Auxiliary");
  const ociBefore = legalLocalDeltas(working, { bundle: BUNDLE, protocol }).candidates.filter(item => item.part !== undefined && item.parent !== auxiliary.id);
  const held = legalLocalDeltas(working, { bundle: BUNDLE, protocol });
  const intoAux = held.candidates.filter(item => item.part !== undefined && item.parent === auxiliary.id);
  assert.deepEqual(intoAux.map(item => item.part).sort(), BUNDLE.parts.map(part => part.key).sort(), "every offered part may take the one slot");
  const db = intoAux.find(item => item.part === "db");
  const proved = await proveLocalDelta({ working, held, candidateId: db.id, confidence: 1, bundle: BUNDLE, protocol });
  assert.equal(proved.outcome, OUTCOME_STEP);
  working = (await appendStep({ working, step: proved.step, protocol })).graph;
  const added = db.operations[0].regionId;
  assert.ok(within(boxOf(working, auxiliary.id), boxOf(working, added)));
  for (const sibling of regions().filter(record => record.parent === auxiliary.id && record.id !== added))
    assert.ok(apart(boxOf(working, added), boxOf(working, sibling.id)));
  // The full g2 (db, api) and d1 (step, data) sequences need two parts there;
  // the frame has one painted slot, so the second is honestly not offered.
  const selected = [{ key: "db", region: added, parent: auxiliary.id }];
  assert.equal(legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected }).candidates
    .some(item => item.part !== undefined && item.parent === auxiliary.id), false);
  // OCI offers are unchanged by the correction.
  assert.deepEqual(ociBefore.map(item => [item.part, item.parent]),
    held.candidates.filter(item => item.part !== undefined && item.parent !== auxiliary.id).map(item => [item.part, item.parent]));
});

test("a growing group refuses when an ancestor would grow into its sibling", async () => {
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "tight siblings" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 900, 900], summary: "" },
    { type: "region", id: "upper", parent: "root", label: "Upper", kind: "group", bounds: [0, 0, 500, 200], summary: "" },
    { type: "region", id: "lower", parent: "root", label: "Lower", kind: "group", bounds: [0, 300, 500, 100], summary: "" },
  ], MAP_ID);
  const decision = await protocol.createDecision(graph.head, [{ type: "PinRegions", items: [
    { regionId: "upper", bounds: [0, 0, 500, 200] }, { regionId: "lower", bounds: [0, 210, 500, 100] },
  ] }], graph.records);
  let working = (await protocol.appendDecision(graph.log, decision.decision)).verified;
  const selected = [];
  const add = async (key, parent) => {
    const held = legalLocalDeltas(working, { bundle: BUNDLE, protocol, selected });
    const candidate = held.candidates.find(item => item.part === key && item.parent === parent);
    if (!candidate) return null;
    const proved = await proveLocalDelta({ working, held, candidateId: candidate.id, confidence: 1, bundle: BUNDLE, protocol, selected });
    working = (await appendStep({ working, step: proved.step, protocol })).graph;
    selected.push({ key, region: candidate.operations[0].regionId, parent });
    return candidate.operations[0].regionId;
  };
  const group = await add("group", "upper");
  assert.ok(group);
  assert.ok(await add("db", group), "the first child fits inside the unmoved upper group");
  const lower = boxOf(working, "lower");
  assert.equal(await add("api", group), null, "a second child would grow upper into lower");
  assert.deepEqual(boxOf(working, "lower"), lower);
});

const layoutOf = graph => protocol.layoutBoundsFor(graph.records, { pattern: protocol.GRAPH_PATTERN });
const WIDE = [-400, -400, 2000, 2000];
const frameOf = (graph, frame = WIDE) => Object.freeze({ head: graph.head, frame: Object.freeze([...frame]) });

// One turn as the page builds it, and an answer shaped exactly like the
// questions it asked: every slot "none" unless the test says otherwise.
const ask = (working, { bundle = BUNDLE, layout = null, offeredFrame = null, draft = [], focus = null, pending = null } = {}) =>
  requestFor({ working, utterance: "test utterance", bundle, layout, offeredFrame, draft, focus, pending, recent: [] });
const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence });
const answer = (turn, picks = {}, confidence = 0.9) => Object.fromEntries(Object.keys(turn.slots).map(name => [
  name,
  picks[name] === undefined ? choice(NONE, confidence) : typeof picks[name] === "string" ? choice(picks[name], confidence) : picks[name],
]));

const plan = async (working, picks, options = {}) => {
  const layout = options.layout ?? null;
  const { turn } = ask(working, { layout, offeredFrame: options.offeredFrame ?? null, bundle: options.bundle ?? BUNDLE });
  return planStep({
    working,
    turn,
    answers: answer(turn, picks, options.confidence),
    protocol,
    bundle: options.bundle ?? BUNDLE,
    reserved: options.reserved ?? [],
    layout,
    visibleFrame: options.visibleFrame ?? null,
  });
};

const step = async (working, picks, options) => {
  const planned = await plan(working, picks, options);
  assert.equal(planned.outcome, OUTCOME_STEP, JSON.stringify(planned));
  const appended = await appendStep({ working, step: planned.step, protocol });
  assert.equal(appended.outcome, OUTCOME_STEP);
  return appended.graph;
};

const edges = graph => graph.records.filter(record => record.type === "relation").map(record => `${record.from}->${record.to}`).sort();
const partIds = graph => graph.records.filter(record => record.type === "region" && record.parent !== null).map(record => record.id);

test("Goal additions are painted inside the pinned composed parent, not merely parented in records", async () => {
  for (const order of [["api", "db"], ["db", "api"]]) {
    const seed = await step(await baseGraph(), { action: ACTION_COMPOSE, diagram: "container-example" });
    const parent = seed.records.find(record => record.type === "region" && record.label === "OCI");
    let graph = seed;
    for (const partKey of order) {
      const result = await planAddition({ working: graph, head: graph.head, parentId: parent.id,
        partKey, confidence: 1, bundle: BUNDLE, protocol });
      assert.equal(result.outcome, OUTCOME_STEP, JSON.stringify(result));
      graph = (await appendStep({ working: graph, step: result.step, protocol })).graph;
      const regionId = result.step.decision.operations.find(operation => operation.type === "AddRegion").regionId;
      const layout = layoutOf(graph), box = layout.bounds[regionId], frame = layout.bounds[parent.id];
      assert.equal(box[0] >= frame[0] && box[1] >= frame[1]
        && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3], true);
      assert.equal(result.step.decision.operations.filter(operation => operation.type === "PinRegions").length, 1);
      for (const sibling of graph.records.filter(record => record.type === "region" && record.parent === parent.id && record.id !== regionId)) {
        const other = layout.bounds[sibling.id];
        assert.equal(box[0] < other[0] + other[2] && other[0] < box[0] + box[2]
          && box[1] < other[1] + other[3] && other[1] < box[1] + box[3], false);
      }
      assert.equal(seed.records.every(record => graph.records.some(next => JSON.stringify(record) === JSON.stringify(next))), true);
    }
  }
});

test("a request is exactly the declared read set, and the Function's own check accepts it", async () => {
  const graph = await baseGraph();
  const { request, turn } = ask(graph, { layout: layoutOf(graph), offeredFrame: WIDE });
  assert.equal(request.kind, REQUEST_KIND);
  assert.deepEqual(Object.keys(request.state).sort(), ["context", "draft", "focus", "graph", "offers", "pending", "utterance"]);
  assert.deepEqual(request.state.graph.regions, [
    { id: "node-a", label: "node-a" }, { id: "node-b", label: "node-b" }, { id: "node-c", label: "node-c" },
  ], "every part by id and label; never the boundary");
  assert.deepEqual(request.state.offers, {
    parts: BUNDLE.parts.map(({ key, purpose }) => ({ key, purpose })),
    diagrams: BUNDLE.diagrams.map(({ key, purpose }) => ({ key, purpose })),
  }, "offers carry keys and purposes only");
  const body = JSON.stringify(request);
  for (const hidden of [graph.head, "bounds", "sha256", "lanes", "steps", ...BUNDLE.parts.map(part => part.label)]) {
    assert.equal(body.includes(hidden), false, `${hidden} never reaches Jev`);
  }
  assert.ok(isRequest(request));
  assert.deepEqual(turn.bundle, { version: BUNDLE.version, sections: ["parts", "diagrams"] });
  assert.equal(turn.head, graph.head);
});

test("each action is offered only when this graph can carry it out", async () => {
  const graph = await baseGraph();
  const edgeless = ask(graph).turn.slots;
  assert.deepEqual(edgeless.action, [ACTION_ADD_EDGE, ACTION_ADD_PART, ACTION_COMPOSE, ACTION_UNDO_REQUEST, NONE]);
  assert.deepEqual(edgeless.source, ["node-a", "node-b", "node-c", NONE]);
  assert.equal(edgeless.edge, undefined, "no edge, no edge question");
  assert.equal(edgeless.move, undefined, "no layout, no placement");

  const joined = await step(graph, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  const withEdge = ask(joined, { layout: layoutOf(joined), offeredFrame: WIDE }).turn.slots;
  assert.deepEqual(withEdge.action, [
    ACTION_ADD_EDGE, ACTION_ADD_PART, ACTION_PLACE_PART, ACTION_REMOVE_EDGE, ACTION_REVERSE_EDGE, ACTION_COMPOSE, ACTION_UNDO_REQUEST, NONE,
  ]);
  assert.deepEqual(withEdge.edge, ["voice-node-c-to-node-a", NONE]);
  assert.deepEqual(withEdge.direction, [...DIRECTIONS, NONE]);
});

test("without a bundle only the graph's own edits are offered, and T binds no bundle", async () => {
  const graph = await baseGraph();
  const { turn, request } = ask(graph, { bundle: NO_BUNDLE });
  assert.deepEqual(turn.slots.action, [ACTION_ADD_EDGE, ACTION_UNDO_REQUEST, NONE]);
  assert.deepEqual(request.state.offers, { parts: [], diagrams: [] });
  assert.equal(turn.bundle, null);

  const partsOnly = readBundle({ ...JSON.parse(fs.readFileSync(path.join(here, "../web/data/bundle.v1.json"), "utf8")), diagrams: [] });
  assert.deepEqual(ask(graph, { bundle: partsOnly }).turn.bundle, { version: partsOnly.version, sections: ["parts"] });
});

test("a new map is named by the person and holds nothing else; it restores as this app's", async () => {
  assert.deepEqual(await newMap({ title: "   ", protocol }), { outcome: OUTCOME_NO_CHANGE, reason: "no-title" });
  assert.deepEqual(await newMap({ title: "x".repeat(121), protocol }), { outcome: OUTCOME_REFUSED, reason: "title-too-long" });

  const made = await newMap({ title: " 業務の図 ", protocol });
  assert.equal(made.outcome, OUTCOME_STEP);
  assert.equal(made.step.action, ACTION_NEW);
  assert.deepEqual(made.step.changes, [{ change: "added", kind: "region", id: "root", label: "業務の図" }]);
  assert.equal(made.graph.mapId, MAP_ID);
  assert.deepEqual(partIds(made.graph), [], "no starter parts");
  assert.equal((await restoreLog({ key: "turn test key", read: async () => made.graph.log, verifyDecisionLog })).status, "restored");

  // On an empty map a part can be asked for and nothing needs two nodes.
  const { turn } = ask(made.graph);
  assert.deepEqual(turn.slots.action, [ACTION_ADD_PART, ACTION_COMPOSE, ACTION_UNDO_REQUEST, NONE]);
  assert.equal(turn.slots.source, undefined);
  const first = await step(made.graph, { action: ACTION_ADD_PART, part: "step" });
  assert.deepEqual(partIds(first), ["part-1"]);
});

test("planning builds a provider Decision on the working head and appends nothing", async () => {
  const working = await baseGraph();
  const planned = await plan(working, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.revision, working.head);
  assert.equal(planned.step.decision.parent, working.head);
  assert.deepEqual(planned.step.changes, [{ change: "added", from: "node-c", to: "node-a" }]);
  assert.deepEqual(edges(working), []);

  const appended = await appendStep({ working, step: planned.step, protocol });
  assert.equal(appended.graph.decisions.length, working.decisions.length + 1);
  assert.ok(appended.graph.log.startsWith(working.log));
});

test("undo-request, none, a none slot and low confidence are ordinary no-changes", async () => {
  const working = await step(await baseGraph(), { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  const undo = await plan(working, { action: ACTION_UNDO_REQUEST });
  assert.deepEqual(undo, { outcome: OUTCOME_NO_CHANGE, reason: "undo-by-button", undoRequest: true });
  for (const [picks, reason, confidence] of [
    [{ action: NONE }, "none-requested"],
    [{ action: ACTION_ADD_EDGE, target: "node-b" }, "no-two-nodes"],
    [{ action: ACTION_REMOVE_EDGE }, "no-edge-named"],
    [{ action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" }, "not-confident", 0.3],
    [{ action: ACTION_ADD_PART }, "no-part-named"],
  ]) {
    assert.deepEqual(await plan(working, picks, { confidence }), { outcome: OUTCOME_NO_CHANGE, reason }, reason);
  }
});

test("a change this graph cannot carry out, an answer off the questions, or a stale answer is refused", async () => {
  const working = await step(await baseGraph(), { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  assert.deepEqual(await plan(working, { action: ACTION_ADD_EDGE, source: "node-b", target: "node-b" }), { outcome: OUTCOME_REFUSED, reason: "same-region" });
  assert.deepEqual(await plan(working, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" }), { outcome: OUTCOME_REFUSED, reason: "edge-exists" });
  assert.deepEqual(await plan(working, { action: ACTION_REMOVE_EDGE, edge: "voice-node-a-to-node-b" }), { outcome: OUTCOME_REFUSED, reason: "answer-invalid" });

  const { turn } = ask(working);
  const extra = { ...answer(turn, { action: NONE }), diagramish: choice(NONE) };
  const missing = answer(turn, { action: NONE });
  delete missing.part;
  for (const answers of [extra, missing]) {
    assert.deepEqual(await planStep({ working, turn, answers, protocol, bundle: BUNDLE }), { outcome: OUTCOME_REFUSED, reason: "answer-invalid" });
  }

  const moved = await step(working, { action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" });
  assert.deepEqual(await planStep({ working: moved, turn, answers: answer(turn, { action: NONE }), protocol, bundle: BUNDLE }),
    { outcome: OUTCOME_REFUSED, reason: "stale" });
  const planned = await plan(working, { action: ACTION_ADD_EDGE, source: "node-b", target: "node-c" });
  assert.deepEqual(await appendStep({ working: moved, step: planned.step, protocol }), { outcome: OUTCOME_REFUSED, reason: "stale" });
  const relabelled = await appendStep({ working: moved, step: { ...planned.step, revision: moved.head }, protocol });
  assert.equal(relabelled.reason, "provider-rejected");
  assert.equal(typeof relabelled.detail, "string");
});

test("removing and reversing are steps; a reverse is one Decision holding both halves", async () => {
  const added = await step(await baseGraph(), { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  const removal = await plan(added, { action: ACTION_REMOVE_EDGE, edge: "voice-node-c-to-node-a" });
  assert.deepEqual(removal.step.changes, [{ change: "removed", from: "node-c", to: "node-a" }]);

  const reversal = await plan(added, { action: ACTION_REVERSE_EDGE, edge: "voice-node-c-to-node-a" });
  assert.deepEqual(reversal.step.decision.operations.map(operation => operation.type), ["RemoveSelection", "ConnectRegions"]);
  const reversed = (await appendStep({ working: added, step: reversal.step, protocol })).graph;
  assert.deepEqual(edges(reversed), ["node-a->node-c"]);
  const readded = await step(reversed, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  assert.deepEqual(edges(readded), ["node-a->node-c", "node-c->node-a"]);
  assert.deepEqual(await plan(readded, { action: ACTION_REVERSE_EDGE, edge: "voice-node-c-to-node-a" }), { outcome: OUTCOME_REFUSED, reason: "reversed-exists" });
});

test("a part takes its kind and label from the bundle, and its name and place from the app", async () => {
  let working = await baseGraph();
  const planned = await plan(working, { action: ACTION_ADD_PART, part: "decision" });
  const decision = BUNDLE.parts.find(part => part.key === "decision");
  assert.deepEqual(planned.step.decision.operations, [{
    type: "AddRegion", regionId: "part-1", parentId: "root", label: `${decision.label} 1`, kind: decision.kind, summary: "", bounds: [20, 20, 140, 64],
  }]);
  for (const part of BUNDLE.parts) {
    const made = await plan(working, { action: ACTION_ADD_PART, part: part.key });
    assert.equal(made.step.decision.operations[0].kind, part.kind);
    working = (await appendStep({ working, step: made.step, protocol })).graph;
  }
  assert.equal(partIds(working).length, 3 + BUNDLE.parts.length);
  for (let count = BUNDLE.parts.length; count < 8; count += 1) {
    working = await step(working, { action: ACTION_ADD_PART, part: "step" });
  }
  assert.deepEqual(await plan(working, { action: ACTION_ADD_PART, part: "step" }), { outcome: OUTCOME_NO_CHANGE, reason: "no-room-for-part" });
});

test("a part name is never reused, not after a revert and not after an undo", async () => {
  const graph = await baseGraph();
  const withPart = await step(graph, { action: ACTION_ADD_PART, part: "step" });
  const undone = await truncateLog(withPart, { count: 1, floor: 1, verifyDecisionLog });
  const nameOf = planned => planned.step.decision.operations[0].regionId;
  assert.equal(nameOf(await plan(undone, { action: ACTION_ADD_PART, part: "step" })), "part-1",
    "the log alone cannot know the name was used");
  assert.equal(nameOf(await plan(undone, { action: ACTION_ADD_PART, part: "step" }, { reserved: ["part-1"] })), "part-2");

  const states = await statesOf(withPart.log, verifyDecisionLog);
  const revert = await revertStep({ before: states[0], after: states[1], working: withPart, protocol });
  const removed = (await appendStep({ working: withPart, step: revert.step, protocol })).graph;
  assert.equal(nameOf(await plan(removed, { action: ACTION_ADD_PART, part: "step" })), "part-2");
});

// Placement: the view says where parts are; Jev chooses only parts and a side.
const place = (graph, picks, visibleFrame = frameOf(graph), offeredFrame = WIDE) =>
  plan(graph, { action: ACTION_PLACE_PART, ...picks }, { layout: layoutOf(graph), offeredFrame, visibleFrame });
const beside = (layout, move, anchor, direction) => {
  const [ax, ay, aw, ah] = layout.bounds[anchor];
  const [, , tw, th] = layout.bounds[move];
  return direction === "left" ? [ax - tw - 24, ay, tw, th]
    : direction === "right" ? [ax + aw + 24, ay, tw, th]
      : direction === "above" ? [ax, ay - th - 24, tw, th]
        : [ax, ay + ah + 24, tw, th];
};

test("placing a part builds one PinRegions at the spot beside its anchor, as the view measures it", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const planned = await place(graph, { move: "node-c", anchor: "node-a", direction: "right" });
  assert.deepEqual(planned.step.decision.operations, [{ type: "PinRegions", items: [{ regionId: "node-c", bounds: beside(layout, "node-c", "node-a", "right") }] }]);
  assert.deepEqual(planned.step.changes, [{ change: "placed", kind: "region", id: "node-c", anchor: "node-a", direction: "right" }]);
  const moved = (await appendStep({ working: graph, step: planned.step, protocol })).graph;
  assert.deepEqual(layoutOf(moved).bounds["node-c"], beside(layout, "node-c", "node-a", "right"));
  assert.deepEqual(await place(moved, { move: "node-c", anchor: "node-a", direction: "right" }), { outcome: OUTCOME_NO_CHANGE, reason: "already-there" });
});

test("every way of not placing is its own reason, and a part beside itself is refused", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const spec = { move: "node-c", anchor: "node-a", direction: "right" };
  const spot = beside(layout, "node-c", "node-a", "right");
  assert.deepEqual(await place(graph, spec, null), { outcome: OUTCOME_NO_CHANGE, reason: "frame-unreadable" });
  assert.deepEqual(await place(graph, spec, { head: "sha256:another", frame: WIDE }), { outcome: OUTCOME_NO_CHANGE, reason: "frame-behind" });
  assert.deepEqual(await place(graph, spec, frameOf(graph, [0, 0, 10, 10])), { outcome: OUTCOME_NO_CHANGE, reason: "spot-off-pane" });
  const anchorCut = [spot[0] - 1, spot[1] - 1, spot[2] + 2, spot[3] + 2];
  assert.deepEqual(await place(graph, spec, frameOf(graph, anchorCut)), { outcome: OUTCOME_NO_CHANGE, reason: "anchor-off-pane" });
  const a = layout.bounds["node-a"];
  const both = [Math.min(a[0], spot[0]) - 1, Math.min(a[1], spot[1]) - 1, spot[0] + spot[2] - a[0] + 2, Math.max(a[3], spot[3]) + 2];
  assert.deepEqual(await place(graph, spec, frameOf(graph, both)), { outcome: OUTCOME_NO_CHANGE, reason: "mover-off-pane" });
  assert.deepEqual(await place(graph, { move: "node-c", anchor: "node-b", direction: "above" }), { outcome: OUTCOME_NO_CHANGE, reason: "spot-taken" });
  assert.deepEqual(await place(graph, { move: "node-c", anchor: "node-c", direction: "right" }), { outcome: OUTCOME_REFUSED, reason: "beside-itself" });
  assert.deepEqual(await place(graph, { move: NONE, anchor: "node-a", direction: "right" }), { outcome: OUTCOME_NO_CHANGE, reason: "placement-restate" });
});

test("only the parts wholly on the pane are offered", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const onlyA = [...layout.bounds["node-a"]];
  assert.deepEqual(placeableIds(layout, graph.records, onlyA), ["node-a"]);
  const { turn, request } = ask(graph, { layout, offeredFrame: onlyA });
  assert.equal(turn.slots.move, undefined, "fewer than two parts on the pane offers no placement");
  assert.deepEqual(request.state.graph.placeable, ["node-a"]);
});

test("one unsure placement piece is held, bound to the exact picture, and never carries text", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const near = await plan(graph, {
    action: ACTION_PLACE_PART, move: "node-c", anchor: choice("node-a", 0.39), direction: "right",
  }, { layout, offeredFrame: WIDE, visibleFrame: frameOf(graph) });
  assert.equal(near.reason, "placement-missing-anchor");
  assert.equal(near.pending.missing, "anchor");
  assert.equal(near.pending.head, graph.head);
  assert.deepEqual(near.pending.offered, ["node-a", "node-b", "node-c"]);
  assert.deepEqual(pendingForJudgment(near.pending), { missing: "anchor", move: "node-c", anchor: null, direction: "right" });
  assert.ok(pendingHolds(near.pending, { head: graph.head, frame: WIDE, offered: ["node-a", "node-b", "node-c"] }));
  assert.equal(pendingHolds(near.pending, { head: graph.head, frame: [0, 0, 1, 1], offered: ["node-a", "node-b", "node-c"] }), false);

  // Nothing is held when the pane moved during the turn, or two pieces were unsure.
  const moved = await plan(graph, { action: ACTION_PLACE_PART, move: "node-c", anchor: choice("node-a", 0.39), direction: "right" },
    { layout, offeredFrame: WIDE, visibleFrame: frameOf(graph, [-399, -400, 2000, 2000]) });
  assert.equal(moved.pending, undefined);
  const two = await place(graph, { move: choice("node-c", 0.3), anchor: choice("node-a", 0.3), direction: "right" });
  assert.deepEqual(two, { outcome: OUTCOME_NO_CHANGE, reason: "placement-restate" });
});

test("the one repair completes the held placement, and only when the reply says nothing else", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const near = await plan(graph, { action: ACTION_PLACE_PART, move: "node-c", anchor: choice("node-a", 0.39), direction: "right" },
    { layout, offeredFrame: WIDE, visibleFrame: frameOf(graph) });
  const pending = near.pending;
  const reply = async (picks, visibleFrame = frameOf(graph)) => {
    const { turn } = ask(graph, { layout, offeredFrame: WIDE, pending: pendingForJudgment(pending) });
    return repairStep({ working: graph, turn, answers: answer(turn, picks), protocol, bundle: BUNDLE, layout, visibleFrame, pending });
  };
  const repaired = await reply({ action: NONE, anchor: "node-a" });
  assert.equal(repaired.outcome, OUTCOME_STEP);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.step.changes, [{ change: "placed", kind: "region", id: "node-c", anchor: "node-a", direction: "right" }]);

  // "ノードAです" heard as node-a beside itself still names the missing piece.
  assert.equal((await reply({ action: ACTION_PLACE_PART, move: "node-a", anchor: "node-a" })).outcome, OUTCOME_STEP);
  // A complete, different instruction wins and is judged as itself.
  const other = await reply({ action: ACTION_PLACE_PART, move: "node-b", anchor: "node-a", direction: "right" });
  assert.equal(other.outcome, OUTCOME_STEP);
  assert.equal(other.repaired, undefined);
  assert.deepEqual(await reply({ action: NONE }), { outcome: OUTCOME_NO_CHANGE, reason: "repair-failed" });
  assert.deepEqual(await reply({ action: NONE, anchor: "node-c" }), { outcome: OUTCOME_NO_CHANGE, reason: "repair-self" });
  assert.deepEqual(await reply({ action: NONE, anchor: "node-a" }, frameOf(graph, [0, 0, 5000, 5000])),
    { outcome: OUTCOME_NO_CHANGE, reason: "repair-context-changed" });
  // A repair turn never promises a one-word follow-up it cannot keep.
  assert.deepEqual(await reply({ action: ACTION_PLACE_PART, move: "node-b", anchor: choice("node-a", 0.3), direction: "left" }),
    { outcome: OUTCOME_NO_CHANGE, reason: "placement-restate" });
});

test("a bundle diagram is composed whole, as one Decision, with its key as provenance", async () => {
  const graph = await baseGraph();
  const diagram = BUNDLE.diagrams[0];
  const planned = await plan(graph, { action: ACTION_COMPOSE, diagram: diagram.key });
  assert.equal(planned.outcome, OUTCOME_STEP);
  assert.equal(planned.step.template, diagram.key, "the step carries the chosen key; nothing re-derives it from labels");
  const regions = planned.step.changes.filter(change => change.kind === "region");
  assert.deepEqual(regions.map(change => change.label), [...diagram.lanes, ...diagram.steps].map(entry => entry.label));
  assert.equal(planned.step.changes.length - regions.length, diagram.links.length);
  assert.deepEqual(planned.step.decision.operations.map(operation => operation.type).at(-1), "PinRegions");
  const composed = (await appendStep({ working: graph, step: planned.step, protocol })).graph;
  assert.equal(partIds(composed).length, 3 + regions.length);
  // Lanes are containers: never an endpoint, never offered for placement.
  const lanes = regions.slice(0, diagram.lanes.length).map(change => change.id);
  const next = ask(composed, { layout: layoutOf(composed), offeredFrame: WIDE }).request.state.graph;
  for (const lane of lanes) {
    assert.equal(next.regions.some(region => region.id === lane), false);
    assert.equal(next.placeable.includes(lane), false);
  }

  assert.deepEqual(await plan(graph, { action: ACTION_COMPOSE }), { outcome: OUTCOME_NO_CHANGE, reason: "diagram-not-offered" });
  assert.deepEqual(await plan(graph, { action: ACTION_COMPOSE, diagram: diagram.key }, { confidence: 0.3 }),
    { outcome: OUTCOME_NO_CHANGE, reason: "diagram-restate" });
});

test("a diagram is never drawn over a part the person placed", async () => {
  const graph = await baseGraph();
  const layout = layoutOf(graph);
  const moved = await step(graph, { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "right" },
    { layout, offeredFrame: WIDE, visibleFrame: frameOf(graph) });
  assert.deepEqual(await plan(moved, { action: ACTION_COMPOSE, diagram: BUNDLE.diagrams[0].key }),
    { outcome: OUTCOME_NO_CHANGE, reason: "diagram-no-room" });
});

test("reverts add the opposite of an entry, and a later change makes them a refused conflict", async () => {
  const graph = await baseGraph();
  const added = await step(graph, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" });
  const removed = await step(added, { action: ACTION_REMOVE_EDGE, edge: "voice-node-c-to-node-a" });
  const states = await statesOf(removed.log, verifyDecisionLog);

  const undoAdd = await revertStep({ before: states[0], after: states[1], working: added, protocol });
  assert.equal(undoAdd.step.action, "revert");
  assert.deepEqual(undoAdd.step.changes, [{ change: "removed", from: "node-c", to: "node-a" }]);
  const putBack = await revertStep({ before: states[1], after: states[2], working: removed, protocol });
  assert.deepEqual(putBack.step.changes, [{ change: "added", from: "node-c", to: "node-a" }]);
  const restored = (await appendStep({ working: removed, step: putBack.step, protocol })).graph;
  assert.deepEqual(restored.records.find(record => record.type === "relation"), states[1].find(record => record.type === "relation"));

  assert.deepEqual(await revertStep({ before: states[0], after: states[1], working: removed, protocol }), { outcome: OUTCOME_REFUSED, reason: "revert-altered" });
  assert.deepEqual(await revertStep({ before: graph.records, after: graph.records.filter(record => record.id !== "node-a"), working: graph, protocol }),
    { outcome: OUTCOME_REFUSED, reason: "revert-unsupported" });
  assert.deepEqual(await revertStep({ before: graph.records, after: graph.records, working: graph, protocol }), { outcome: OUTCOME_REFUSED, reason: "revert-nothing" });
});

test("an added part can be reverted only while it stands alone; a placement is put back", async () => {
  const graph = await baseGraph();
  const withPart = await step(graph, { action: ACTION_ADD_PART, part: "data" });
  const states = await statesOf(withPart.log, verifyDecisionLog);
  const attached = await step(withPart, { action: ACTION_ADD_EDGE, source: "part-1", target: "node-a" });
  assert.deepEqual(await revertStep({ before: states[0], after: states[1], working: attached, protocol }), { outcome: OUTCOME_REFUSED, reason: "revert-has-edge" });
  const alone = await revertStep({ before: states[0], after: states[1], working: withPart, protocol });
  const data = BUNDLE.parts.find(part => part.key === "data");
  assert.deepEqual(alone.step.changes, [{ change: "removed", kind: "region", id: "part-1", label: `${data.label} 1` }]);

  const layout = layoutOf(graph);
  const placed = await step(graph, { action: ACTION_PLACE_PART, move: "node-c", anchor: "node-a", direction: "right" },
    { layout, offeredFrame: WIDE, visibleFrame: frameOf(graph) });
  const placedStates = await statesOf(placed.log, verifyDecisionLog);
  const back = await revertStep({ before: placedStates[0], after: placedStates[1], working: placed, protocol });
  assert.deepEqual(back.step.changes, [{ change: "placed", kind: "region", id: "node-c", anchor: NONE, direction: NONE }]);
  const unpinned = (await appendStep({ working: placed, step: back.step, protocol })).graph;
  assert.deepEqual(layoutOf(unpinned).bounds["node-c"], layout.bounds["node-c"]);
});

test("an entry is offered for revert only when its opposite is one safe change", () => {
  const projection = { regions: ["node-a", "part-1", "part-2"], relations: [{ id: "e", from: "part-2", to: "node-a" }] };
  assert.equal(revertable({ facts: [{ kind: "relation", change: "added" }] }, projection), true);
  assert.equal(revertable({ facts: [{ kind: "layout", change: "added" }] }, projection), true);
  assert.equal(revertable({ facts: [{ kind: "region", change: "added", id: "part-1" }] }, projection), true);
  assert.equal(revertable({ facts: [{ kind: "region", change: "added", id: "part-2" }] }, projection), false, "it has an edge now");
  assert.equal(revertable({ facts: [{ kind: "region", change: "added", id: "x" }, { kind: "relation", change: "added" }] }, projection), false);
});

test("changes reach Jev in their own shape, and the focus is the latest step, else the latest applied, else null", () => {
  const region = { change: "added", kind: "region", id: "part-1", label: "L", extra: 1 };
  const edge = { change: "removed", from: "node-a", to: "node-b", extra: 1 };
  assert.deepEqual(changesForJudgment([region, edge]), [
    { change: "added", kind: "region", id: "part-1", label: "L" },
    { change: "removed", from: "node-a", to: "node-b" },
  ]);
  assert.deepEqual(focusFor({ draft: [{ changes: [edge] }], lastApplied: [region] }).kind, "draft");
  assert.deepEqual(focusFor({ draft: [], lastApplied: [edge] }), { kind: "applied", changes: [{ change: "removed", from: "node-a", to: "node-b" }] });
  assert.equal(focusFor({ draft: [], lastApplied: [] }), null);
});

// A stand-in for the few DOM members drawGraph uses, made of plain closures.
// Every element records its parent and how often it was inserted, so a move -
// which would reload a real iframe - is counted rather than assumed.
const fakeStyle = () => {
  const style = { position: "" };
  Object.defineProperty(style, "cssText", {
    set: text => {
      for (const rule of text.split(";").filter(Boolean)) {
        const [name, value] = rule.split(":");
        style[name.trim().replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value.trim();
      }
    },
  });
  return style;
};
const detach = child => {
  if (child.parent !== null) child.parent.childList.splice(child.parent.childList.indexOf(child), 1);
  child.parent = null;
};
const fakeElement = tag => {
  const element = { tag, parent: null, inserted: 0, childList: [], style: fakeStyle() };
  element.append = child => {
    detach(child);
    child.parent = element;
    child.inserted += 1;
    element.childList.push(child);
  };
  element.replaceChildren = (...children) => {
    for (const child of [...element.childList]) detach(child);
    for (const child of children) element.append(child);
  };
  element.remove = () => detach(element);
  Object.defineProperty(element, "children", { get: () => [...element.childList] });
  return element;
};
const fakeDocument = Object.freeze({
  createElement: fakeElement,
  defaultView: { getComputedStyle: element => ({ position: element.style.position || "static" }) },
});
const fakeProtocol = Object.freeze({ GRAPH_PATTERN: "graph/1", createEnvelope: async (log, _, options) => ({ log, options }) });
// A pane already showing a map: one wrapper holding one embed.
const shownPane = () => {
  const mount = fakeElement("section");
  const wrapper = fakeElement("div");
  const frame = fakeElement("iframe");
  wrapper.append(frame);
  mount.append(wrapper);
  return { mount, wrapper, frame };
};
// Like the provider: the new embed goes into the mount it is given.
const embedInto = frames => async ({ surfaceMount }) => {
  const frame = fakeElement("iframe");
  frames.push(frame);
  surfaceMount.replaceChildren(frame);
};
const drawInto = (mount, renderProjection, graph = { log: "log" }) =>
  drawGraph({ graph, frame: null, mount, protocol: fakeProtocol, renderProjection, document: fakeDocument });

test("a drawing replaces the shown map only once it is ready, in place: one wrapper, one embed, never moved", async () => {
  const { mount, wrapper: old } = shownPane();
  const frames = [];
  await drawInto(mount, embedInto(frames));
  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.equal(mount.children.length, 1, "exactly one child is left in the pane");
  const [shown] = mount.children;
  assert.deepEqual(shown.children, [frame], "the wrapper holds the embed and is not empty");
  assert.equal(frame.parent, shown);
  assert.equal(frame.inserted, 1, "the embed was inserted once and never moved");
  assert.equal(shown.inserted, 1, "the wrapper was inserted once and never moved");
  assert.equal(old.parent, null, "the map shown before is gone");
  assert.deepEqual([shown.style.position, shown.style.inset, shown.style.visibility, shown.style.pointerEvents],
    ["absolute", "0", "", ""], "the wrapper covers the pane and is shown");
  assert.equal(mount.style.position, "relative", "a static pane becomes the wrapper's containing block");

  const kept = fakeElement("section");
  kept.style.position = "absolute";
  await drawInto(kept, embedInto([]));
  assert.equal(kept.style.position, "absolute", "a pane that is already positioned keeps its position");
});

test("a drawing that fails removes only its own candidate and rethrows: the shown map is untouched", async () => {
  const { mount, wrapper, frame } = shownPane();
  const failure = new Error("embedded semantic map ready timed out");
  const failing = async ({ surfaceMount }) => {
    surfaceMount.replaceChildren(fakeElement("iframe"));
    throw failure;
  };
  await assert.rejects(drawInto(mount, failing), error => error === failure, "the renderer's own error, not a new one");
  assert.equal(mount.children.length, 1, "no candidate is left");
  assert.equal(mount.children[0], wrapper, "the shown map is the very same element");
  assert.deepEqual(wrapper.children, [frame]);
  assert.equal(frame.inserted, 1, "the shown embed was never moved");
  assert.equal(frame.parent, wrapper);
});

test("no graph clears the pane", async () => {
  const { mount } = shownPane();
  await drawInto(mount, embedInto([]), null);
  assert.deepEqual(mount.children, []);
});

test("an independent projection renderer shares the accepted world kernel, not the original renderer", async () => {
  const graph = await step(await baseGraph(), { action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" });
  const before = graph.log;
  let seen;
  const projection = async ({ input, surfaceMount }) => {
    const inspected = await protocol.inspectEnvelope(input.envelope);
    seen = inspected.base.records.filter(record => record.type === "relation").map(record => record.from + "->" + record.to).sort();
    const list = fakeElement("ol");
    for (const edge of seen) { const item = fakeElement("li"); item.textContent = edge; list.append(item); }
    surfaceMount.replaceChildren(list);
  };
  const mount = fakeElement("section");
  await drawGraph({ graph, frame: null, mount, protocol, renderProjection: projection, document: fakeDocument });
  assert.deepEqual(seen, edges(graph)); assert.deepEqual(seen, ["node-a->node-b"]);
  assert.equal(mount.children[0].children[0].tag, "ol");
  assert.equal(mount.children[0].children[0].children[0].textContent, "node-a->node-b");
  assert.equal(graph.log, before); assert.equal((await verifyDecisionLog(before)).head, graph.head);
});
