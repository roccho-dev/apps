import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readBundle } from "../src/bundle.mjs";
import { ACTION_ADD_EDGE, ARCHITECTURE_INTENT_KIND, GOAL_REQUEST_KIND, NONE, isRequest, slotsFor } from "../src/contract.mjs";
import { regionIdOf, withArchitecture } from "../src/architecture.mjs";
import { runGoal } from "../src/goal.mjs";
import { createSession, undo, draftUsed, proposeArchitecture, draftForJudgment, recentConversation } from "../src/session.mjs";
import { currentClaims } from "../src/document.mjs";
import { MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { legalLocalDeltas as legalAdditions, proveLocalDelta as proveAddition, legalLocalDeltas, proveLocalDelta,
  appendStep, OUTCOME_REFUSED, focusFor, requestFor } from "../src/turn.mjs";

if (!process.env.SEMANTIC_MAP) throw new Error("SEMANTIC_MAP is required");
const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP, "packages/semantic-map/protocol/index.js")).href);
const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("../web/data/bundle.v1.json", import.meta.url), "utf8")));
const utterance = "OCIの中にAPIとDBを追加して";
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

// The two seed groups are pinned through the verified log; a test may pin one
// to a tiny painted frame instead, so the log itself says it is full.
const ROOMY = Object.freeze({ container: [0, 0, 2000, 500], other: [0, 600, 2000, 500] });
const opened = async (frames = ROOMY) => {
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "goal fixture" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 900, 400], summary: "" },
    { type: "region", id: "container", parent: "root", label: "OCI", kind: "group", bounds: [0, 0, 700, 200], summary: "" },
    { type: "region", id: "other", parent: "root", label: "Other", kind: "group", bounds: [0, 230, 700, 160], summary: "" },
  ], MAP_ID);
  const pinned = await protocol.createDecision(graph.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: frames.container },
    { regionId: "other", bounds: frames.other },
  ] }], graph.records);
  const prepared = (await protocol.appendDecision(graph.log, pinned.decision)).verified;
  return createSession({ accepted: prepared, stored: prepared.log });
};
const TINY = [0, 0, 24, 18];
const answer = (request, part, parent = "container") => ({ kind: "answered", decision: { answers: {
  delta: { type: "choice", choice: part === NONE ? NONE
    : request.state.candidates.find(candidate => candidate.part === part && candidate.parent === parent)?.id ?? "unknown", confidence: 1 },
} } });
// Two helpers in one group and one existing helper in OCI: both helper-to-existing
// arrows are legal, so only an earlier utterance can say which one is meant.
const helpers = async () => {
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "goal history fixture" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 900, 400], summary: "" },
    { type: "region", id: "container", parent: "root", label: "OCI", kind: "group", bounds: [0, 0, 700, 200], summary: "" },
    { type: "region", id: "other", parent: "root", label: "Auxiliary", kind: "group", bounds: [0, 230, 700, 160], summary: "" },
    { type: "region", id: "aux-1", parent: "other", label: "Helper left", kind: "step", bounds: [20, 250, 140, 64], summary: "" },
    { type: "region", id: "aux-2", parent: "other", label: "Helper right", kind: "step", bounds: [200, 250, 140, 64], summary: "" },
    { type: "region", id: "oci-1", parent: "container", label: "Existing helper", kind: "step", bounds: [20, 20, 140, 64], summary: "" },
  ], MAP_ID);
  const pinned = await protocol.createDecision(graph.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: [0, 0, 2000, 500] },
    { regionId: "other", bounds: [0, 600, 2000, 500] },
  ] }], graph.records);
  const prepared = (await protocol.appendDecision(graph.log, pinned.decision)).verified;
  return createSession({ accepted: prepared, stored: prepared.log });
};

// A source-grounded Working at the observed scale: 42 file parts, 69 relations
// and a remembered focus said before six later utterances. With 11 parts in
// focus the pairs touching it are far over one Goal request's candidates; with
// one part they fit, but the whole Working's edges are over one request's graph.
const sourced = async focusCount => {
  const part = index => `part-${String(index).padStart(2, "0")}`;
  const id = index => regionIdOf(part(index));
  const parts = Array.from({ length: 42 }, (_, index) => part(index));
  const source = Object.freeze({ handle: "fixture", commit: "0".repeat(40) });
  const manifest = Object.freeze({ status: "available", source,
    entities: Object.freeze(parts.map(key => Object.freeze({ id: key, label: `src/${key}.mjs` }))) });
  const regions = parts.map((key, index) => ({ type: "region", id: id(index), parent: "container", label: `src/${key}.mjs`,
    kind: "step", bounds: [20 + (index % 7) * 160, 20 + Math.floor(index / 7) * 80, 140, 64], summary: "" }));
  const pairs = [];
  for (let from = 11; from <= 41 && pairs.length < 67; from += 1) {
    for (let step = 1; step <= 3 && pairs.length < 67; step += 1) pairs.push([from, 11 + (from - 11 + step) % 31]);
  }
  const relations = [...pairs.map(([from, to]) => ({ id: `rel-${from}-${to}`, from: id(from), to: id(to) })),
    { id: "rel-back", from: id(20), to: id(0) }, { id: "rel-side", from: id(0), to: id(30) }]
    .map(relation => ({ type: "relation", ...relation, kind: "flow", label: "" }));
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "goal source fixture" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 4200, 2200], summary: "" },
    { type: "region", id: "container", parent: "root", label: "Source", kind: "group", bounds: [0, 0, 1200, 560], summary: "" },
    ...regions, ...relations,
  ], MAP_ID);
  const pinned = await protocol.createDecision(graph.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: [0, 0, 4000, 2000] },
  ] }], graph.records);
  const prepared = (await protocol.appendDecision(graph.log, pinned.decision)).verified;
  const reference = Object.freeze({ source, focus: Object.freeze(parts.slice(0, focusCount)) });
  const said = (seq, extra = {}) => Object.freeze({ seq, source: "typed", text: `utterance ${seq}`, outcome: "no-change", ...extra });
  const base = createSession({ accepted: prepared, stored: prepared.log });
  return { id, reference, manifest, session: Object.freeze({ ...base, nextSeq: 8,
    conversation: Object.freeze([said(1, { reference }), ...[2, 3, 4, 5, 6, 7].map(seq => said(seq))]) }) };
};
// The page's intent of the latest session, built as decide() builds it from the
// existing exports: the plain request with no layout, frame or pending placement,
// the snapshot's parts beside it, and the recent conversation with references.
const intentFor = (manifest, utterance) => latest => {
  const draft = draftForJudgment(latest);
  const bound = withArchitecture(requestFor({ working: latest.working, utterance, bundle, layout: null, offeredFrame: null,
    draft, focus: focusFor({ draft, lastApplied: [] }), pending: null, recent: recentConversation(latest).recent }), manifest);
  return Object.freeze({ turn: bound.turn, request: Object.freeze({ kind: bound.request.kind, state: Object.freeze({
    ...bound.request.state, context: Object.freeze({ recent: recentConversation(latest, { architecture: true }).recent }) }) }) });
};
const intentAnswer = (request, action, from, to, confidence = 1) => ({ kind: "answered", decision: { answers:
  Object.fromEntries(Object.keys(slotsFor(request.state)).map(name => [name, { type: "choice", confidence,
    choice: name === "action" ? action : name === "source" ? from : name === "target" ? to : NONE }])) } });
// The intent of a session is the actual existing request and offers the pair.
const intentHolds = (intent, from, to) => {
  assert.equal(intent.request.kind, ARCHITECTURE_INTENT_KIND);
  assert.equal(isRequest(intent.request), true, "the existing intent request of the latest session");
  const slots = slotsFor(intent.request.state);
  assert.ok(slots.action.includes(ACTION_ADD_EDGE) && slots.source.includes(from) && slots.target.includes(to));
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const exactPairChain = async focusCount => {
  const { session: before, id, reference, manifest } = await sourced(focusCount);
  assert.equal(before.working.records.filter(record => record.type === "region" && record.kind === "step").length, 42);
  const relationCount = before.working.records.filter(record => record.type === "relation").length;
  assert.equal(relationCount, 69); assert.ok(relationCount > 64, "over one Goal request's graph");
  const offered = legalLocalDeltas(before.working, { bundle, protocol, reserved: before.issuedPartIds, selected: [],
    scope: new Set(reference.focus.map(regionIdOf)) }).candidates.length;
  assert.ok(focusCount === 11 ? offered > 254 : offered <= 254, `the whole catalogue touching the focus is ${offered}`);
  const utterance = "focus の src/part-00.mjs から src/part-20.mjs へ矢印をつないで";
  const intentOf = intentFor(manifest, utterance);
  const [from, to] = [id(0), id(20)];
  intentHolds(intentOf(before), from, to);
  let session = before; const resolved = []; const asked = [];
  const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
    adopt: async next => { session = next; },
    resolveIntent: latest => {
      const built = intentOf(latest);
      assert.equal(isRequest(built.request), true);
      resolved.push({ latest, built });
      return built;
    },
    ask: async request => {
      asked.push(request);
      return request.kind === ARCHITECTURE_INTENT_KIND ? intentAnswer(request, ACTION_ADD_EDGE, from, to)
        : { kind: "answered", decision: { answers: { delta: { type: "choice", choice: request.state.candidates[0].id, confidence: 1 } } } };
    } });
  assert.equal(result.reason, "no-executable-delta", "the resolved pair is drawn, so nothing executable remains");
  assert.equal(result.requests, 3);
  assert.deepEqual(asked.map(request => request.kind), [ARCHITECTURE_INTENT_KIND, GOAL_REQUEST_KIND, ARCHITECTURE_INTENT_KIND]);
  assert.equal(resolved.length, 2); assert.equal(resolved[0].latest, before); assert.equal(resolved[1].latest, session);
  assert.equal(asked[0], resolved[0].built.request); assert.equal(asked[2], resolved[1].built.request);
  const goal = asked[1];
  assert.equal(isRequest(goal), true);
  assert.deepEqual(goal.state.graph.map(region => region.id).sort(), ["container", from, "root", to].sort());
  assert.deepEqual(goal.state.edges, [{ id: "rel-back", from: to, to: from }], "relations between the pair, either way, and no other");
  assert.deepEqual(goal.state.parents, [{ id: "container", label: "Source", kind: "group", parent: "root" }]);
  assert.deepEqual(goal.state.candidates.map(({ action, from, to }) => ({ action, from, to })), [{ action: ACTION_ADD_EDGE, from, to }]);
  assert.deepEqual(goal.state.scope, { source: { handle: "fixture", commit: "0".repeat(40) }, focus: [...reference.focus] });
  assert.deepEqual(goal.state.context.recent.map(entry => entry.seq), [3, 4, 5, 6, 7]);
  assert.deepEqual(session.working.records.filter(record => before.working.records.some(old => same(old, record))),
    before.working.records, "every old record of the full Working is kept");
  const added = session.working.records.filter(record => !before.working.records.some(old => same(old, record)));
  assert.deepEqual(added.map(({ type, from, to, kind, label }) => ({ type, from, to, kind, label })),
    [{ type: "relation", from, to, kind: "flow", label: "" }]);
  assert.deepEqual(result.selected, []);
  const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(reverted.working.records, before.working.records);
  assert.deepEqual(reverted.draft, before.draft); assert.equal(reverted.stored, before.stored);
};

test("mixed Goal uses one held ADD/Connect alphabet and strictly restores the whole group", async () => {
  const before = await opened(); let session = before; let calls = 0;
  const result = await runGoal({ utterance: "add two offered parts and connect the first to the second", bundle, protocol,
    current: () => session, cancelled: () => false, ask: async request => {
      calls += 1;
      if (calls <= 2) return answer(request, calls === 1 ? "api" : "db");
      const [from, to] = request.state.selected.map(item => item.region);
      const candidate = request.state.candidates.find(item => item.action === "add-edge" && item.from === from && item.to === to);
      assert.equal(isRequest(request), true);
      return { kind: "answered", decision: { answers: { delta: { type: "choice", choice: calls === 3 ? candidate.id : NONE, confidence: 1 } } } };
    }, adopt: async next => { session = next; } });
  assert.equal(result.reason, "none"); assert.equal(result.requests, 4);
  const [from, to] = result.selected.map(item => item.region);
  assert.deepEqual(session.working.records.filter(item => item.type === "relation").map(({ from, to, kind, label }) => ({ from, to, kind, label })),
    [{ from, to, kind: "flow", label: "" }]);
  const held = legalLocalDeltas(session.working, { bundle, protocol, selected: result.selected });
  assert.equal(held.candidates.some(item => item.from === from && item.to === to), false);
  assert.equal(held.candidates.some(item => item.from === to && item.to === from), true);
  assert.equal(held.candidates.every(item => item.from === undefined || item.from !== item.to), true);
  const connection = held.candidates.find(item => item.from !== undefined);
  const proved = await proveLocalDelta({ working: session.working, held, candidateId: connection.id,
    confidence: 1, bundle, protocol, selected: result.selected });
  assert.deepEqual(proved.step.decision.operations, connection.operations);
  const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(reverted.working.records, before.working.records);
  assert.deepEqual(reverted.draft, before.draft); assert.equal(reverted.stored, before.stored);
});

test("one Goal adopts two real AddRegions and whole-group Undo without claiming NONE is goal success", async () => {
  for (const order of [["api", "db"], ["db", "api"]]) {
  const before = await opened();
  let session = before;
  const requests = [];
  const choices = [...order, NONE];
  const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
    ask: async request => { requests.push(request); return answer(request, choices.shift()); },
    adopt: async next => { session = next; },
  });
  assert.equal(result.reason, "none");
  assert.equal(result.requests, 3);
  assert.equal(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0, true);
  assert.equal(requests.every(request => request.kind === GOAL_REQUEST_KIND && isRequest(request)), true);
  assert.equal(requests.every(request => request.state.utterance === utterance && request.state.offers.parts.length === 8), true);
  assert.equal(requests[1].state.candidates.some(candidate => candidate.part === order[0]), false);
  assert.equal(requests[1].state.selected[0].key, order[0]);
  const added = session.working.records.filter(record => record.type === "region" && !before.working.records.some(old => old.id === record.id));
  assert.deepEqual(added.map(({ label, kind, parent }) => ({ label: label.replace(/ [1-9]\d*$/u, ""), kind, parent }))
    .sort((left, right) => left.label.localeCompare(right.label)), [
    { label: "API", kind: "step", parent: "container" }, { label: "DB", kind: "data", parent: "container" },
  ]);
  assert.equal(session.accepted, before.accepted);
  assert.equal(session.stored, before.stored);
  assert.equal(draftUsed(session), 1);
  assert.equal(session.conversation.length, 1);
  const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(reverted.working.records, before.working.records);
  assert.deepEqual(reverted.draft, before.draft);
  assert.equal(reverted.stored, before.stored);
  assert.equal(reverted.conversation[0].outcome, "undone");
  }
});

test("paired histories with the same Working, utterance and catalogue differ only in the explicit Goal context", async () => {
  const base = await helpers();
  const idOf = label => base.working.records.find(record => record.type === "region" && record.label === label).id;
  const said = text => Object.freeze({ seq: 1, source: "typed", text, outcome: "no-change" });
  const requests = [];
  for (const text of ["Helper left は何の役？", "Helper right は何の役？"]) {
    const session = Object.freeze({ ...base, conversation: Object.freeze([said(text)]), nextSeq: 2 });
    const result = await runGoal({ utterance: "さっき話題にした部品から Existing helper へ矢印をつないで。他は変えない", bundle, protocol,
      current: () => session, cancelled: () => false, adopt: async () => { throw new Error("NONE adopts nothing"); },
      ask: async request => { requests.push(request); return answer(request, NONE); } });
    assert.equal(result.reason, "none");
  }
  const [left, right] = requests;
  assert.equal(isRequest(left) && isRequest(right), true);
  assert.deepEqual(left.state.candidates, right.state.candidates);
  for (const from of [idOf("Helper left"), idOf("Helper right")]) {
    assert.equal(left.state.candidates.some(candidate => candidate.action === "add-edge"
      && candidate.from === from && candidate.to === idOf("Existing helper")), true);
  }
  const { context: leftContext, ...leftRest } = left.state;
  const { context: rightContext, ...rightRest } = right.state;
  assert.deepEqual(leftRest, rightRest);
  assert.deepEqual(leftContext, { recent: [said("Helper left は何の役？")] });
  assert.deepEqual(rightContext, { recent: [said("Helper right は何の役？")] });
});

test("an 11-part focus resolves the exact pair each iteration instead of offering every pair touching it", async () => {
  await exactPairChain(11);
});

test("a one-part focus asks a bounded local view, not all 69 relations of the Working", async () => {
  await exactPairChain(1);
});

test("a scoped Goal refuses a weak, absent or out-of-focus resolution after one counted request, with no Goal request or adoption", async () => {
  const { session: before, id, manifest } = await sourced(11);
  const intentOf = intentFor(manifest, "connect them");
  for (const [label, action, [from, to], confidence, reason] of [
    ["weak", ACTION_ADD_EDGE, [0, 20], 0.49, "not-confident"],
    ["none", NONE, [0, 20], 1, "none"],
    ["outside the focus", ACTION_ADD_EDGE, [30, 40], 1, "no-executable-delta"],
  ]) {
    intentHolds(intentOf(before), id(from), id(to));
    const asked = [];
    const result = await runGoal({ utterance: "connect them", bundle, protocol, current: () => before, cancelled: () => false,
      adopt: async () => { throw new Error("unexpected adoption"); },
      resolveIntent: latest => { const built = intentOf(latest); assert.equal(isRequest(built.request), true); return built; },
      ask: async request => { asked.push(request); return intentAnswer(request, action, id(from), id(to), confidence); } });
    assert.equal(result.reason, reason, label);
    assert.equal(result.requests, 1, label);
    assert.deepEqual(asked.map(request => request.kind), [ARCHITECTURE_INTENT_KIND], label);
    assert.deepEqual(result.selected, [], label);
  }
});

test("a scoped Goal without an intent resolver asks nothing rather than the whole catalogue", async () => {
  const base = await helpers();
  const reference = Object.freeze({ source: Object.freeze({ handle: "fixture", commit: "0".repeat(40) }), focus: Object.freeze(["focus-part"]) });
  const session = Object.freeze({ ...base, nextSeq: 2,
    conversation: Object.freeze([Object.freeze({ seq: 1, source: "typed", text: "utterance 1", outcome: "no-change", reference })]) });
  let calls = 0;
  const result = await runGoal({ utterance: "connect it", bundle, protocol, current: () => session, cancelled: () => false,
    adopt: async () => { throw new Error("unexpected adoption"); }, ask: async sent => { calls += 1; return answer(sent, NONE); } });
  assert.equal(result.reason, "invalid-goal-request");
  assert.equal(calls, 0); assert.equal(result.requests, 0); assert.deepEqual(result.selected, []);
});

test("legal wrong parent is retained; independent expected graph rejects it rather than repairing it", async () => {
  const before = await opened(); let session = before; let calls = 0;
  const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
    ask: async request => answer(request, calls++ === 0 ? "api" : NONE, "other"), adopt: async next => { session = next; },
  });
  assert.equal(result.reason, "none");
  assert.equal(result.selected[0].parent, "other");
  assert.equal(session.working.records.find(record => record.id === result.selected[0].region).parent === "container", false);
});

test("closed Goal validation rejects cycles, unknown history and repeated choices before another effect", async () => {
  const before = await opened(); let request;
  await runGoal({ utterance, bundle, protocol, current: () => before, cancelled: () => false,
    ask: async value => { request = value; return answer(value, NONE); }, adopt: async () => { throw new Error("unexpected"); },
  });
  for (const mutate of [
    state => { state.graph[0].parent = "container"; },
    state => { state.graph[1].parent = "container"; },
    state => { state.selected = [{ key: "absent", region: "container", parent: "root" }]; },
    state => { state.parents[0].kind = "step"; },
  ]) { const bad = structuredClone(request); mutate(bad.state); assert.equal(isRequest(bad), false); }
  assert.equal(new Set(legalAdditions(before.working, { bundle, protocol }).candidates.map(candidate => candidate.parent)).size, 2);
});

test("cancel, stale response, protocol failure and draw unknown stop without selected history advance", async () => {
  for (const reason of ["cancelled", "stale-goal", "judge-failed", "adoption-unknown"]) {
    const before = await opened(); let session = before; let cancelled = false;
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => cancelled,
      ask: async request => {
        if (reason === "cancelled") cancelled = true;
        if (reason === "stale-goal") session = { ...session };
        return reason === "judge-failed" ? { kind: "failed", reason: "judge-contract" } : answer(request, "api");
      },
      adopt: async () => { throw new Error("draw failed"); },
    });
    assert.equal(result.reason, reason);
    assert.deepEqual(result.selected, []);
    assert.equal(result.requests, 1);
    assert.equal(session.working, before.working);
  }
});

test("thrown judgment counts the started call and preserves only previously adopted history", async () => {
  for (const successful of [0, 1]) {
    const before = await opened(); let session = before; let calls = 0;
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
      ask: async request => { if (calls++ === successful) throw new Error("not public"); return answer(request, "api"); },
      adopt: async next => { session = next; },
    });
    assert.equal(result.reason, "judge-unknown");
    assert.equal(result.requests, successful + 1);
    assert.equal(result.selected.length, successful);
    assert.equal(result.trace.at(-1).failure, "judge-unknown");
    if (successful) {
      const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
      assert.deepEqual(reverted.working.records, before.working.records);
    } else assert.equal(session, before);
  }
});

test("malformed resolved judgment is a counted contract stop, not a thrown-call UNKNOWN", async () => {
  for (const value of [null, undefined, {}, { kind: "answered" }]) {
    const session = await opened();
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
      ask: async request => value, adopt: async () => { throw new Error("unexpected adoption"); },
    });
    assert.equal(result.reason, "judge-failed"); assert.equal(result.requests, 1);
    assert.equal(result.trace[0].failure, "judge-contract"); assert.deepEqual(result.selected, []);
  }
});

test("addition rechecks stale head, non-group parent, confidence and full group before provider mutation", async () => {
  const session = await opened();
  const base = { working: session.working, head: session.working.head, partKey: "api", parentId: "container", confidence: 1, bundle, protocol };
  assert.equal((await planAddition({ ...base, head: "old" })).reason, "stale-head");
  assert.equal((await planAddition({ ...base, parentId: "root" })).reason, "invalid-addition");
  assert.equal((await planAddition({ ...base, partKey: "absent" })).reason, "invalid-addition");
  assert.equal((await planAddition({ ...base, confidence: 0.49 })).reason, "not-confident");
  // A group whose verified painted frame is full offers no addition.
  const full = (await opened({ ...ROOMY, container: TINY })).working;
  assert.equal((await planAddition({ ...base, working: full, head: full.head })).reason, "no-room-for-part");
  assert.equal(legalAdditions(full, { bundle, protocol }).candidates.some(candidate => candidate.parent === "container"), false);
  // Records edited apart from their log are refused by the provider on append:
  // the catalogue may offer and prove a step, but nothing is adopted.
  const tampered = { ...session.working, records: session.working.records.map(record => record.id === "container"
    ? { ...record, bounds: TINY } : record) };
  const held = legalAdditions(tampered, { bundle, protocol });
  const candidate = held.candidates.find(item => item.part === "api" && item.parent === "container");
  const proved = await proveAddition({ working: tampered, held, candidateId: candidate.id, confidence: 1, bundle, protocol });
  const appended = await appendStep({ working: tampered, step: proved.step, protocol });
  assert.equal(appended.outcome, OUTCOME_REFUSED); assert.equal(appended.reason, "provider-rejected");
  assert.match(appended.detail, /stateHash/u);
  assert.equal(session.working.log, tampered.log);
});

test("early NONE, no room and elapsed budget stop at their actual request count", async () => {
  for (const reason of ["none", "no-executable-delta", "budget-time"]) {
    const session = reason !== "no-executable-delta" ? await opened() : await opened({ container: TINY, other: [0, 600, 24, 18] });
    let calls = 0;
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
      now: () => reason === "budget-time" && calls > 0 ? 180000 : 0,
      ask: async request => { calls += 1; return answer(request, reason === "none" ? NONE : "api"); },
      adopt: async () => { throw new Error("unexpected adoption"); },
    });
    assert.equal(result.reason, reason);
    assert.equal(result.requests, reason === "no-executable-delta" ? 0 : 1);
    assert.equal(result.elapsedMs, reason === "budget-time" ? 180000 : 0);
    assert.equal(calls, result.requests); assert.deepEqual(result.selected, []);
  }
  // A Goal over records edited apart from their log asks, but the provider
  // refuses the append: nothing is adopted and the session stays as it was.
  const before = await opened();
  const tampered = { ...before, working: { ...before.working,
    records: before.working.records.map(record => record.kind === "group" ? { ...record, bounds: TINY } : record) } };
  const result = await runGoal({ utterance, bundle, protocol, current: () => tampered, cancelled: () => false, now: () => 0,
    ask: async request => answer(request, "api"), adopt: async () => { throw new Error("unexpected adoption"); } });
  assert.equal(result.reason, "provider-rejected"); assert.equal(result.requests, 1); assert.deepEqual(result.selected, []);
  assert.equal(tampered.working.log, before.working.log); assert.equal(tampered.draft.length, before.draft.length);
});

test("partial successful Goal keeps one grouped edit when a later cancel, stale or weak answer stops", async () => {
  for (const reason of ["cancelled", "stale-goal", "not-confident"]) {
    const original = await opened();
    const prepared = await planAddition({ working: original.working, head: original.working.head,
      partKey: "step", parentId: "other", confidence: 1, bundle, protocol });
    const claims = [{ record: { type: "region", id: prepared.step.changes[0].id }, origin: "user-asserted", basis: [] }];
    const prior = await proposeArchitecture(original, { planned: { outcome: "step", steps: [{ step: prepared.step, claims }] },
      input: { source: "typed", text: "an earlier independent edit" }, protocol });
    const before = prior.session; let session = before; let calls = 0; let cancelled = false;
    const visibleClaims = currentClaims(before.draft.filter(item => item.claims !== undefined), before.working.records);
    assert.equal(visibleClaims.length, 1);
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => cancelled,
      ask: async request => {
        calls += 1;
        if (calls === 1) return answer(request, "api");
        if (reason === "cancelled") cancelled = true;
        if (reason === "stale-goal") session = { ...session };
        const value = answer(request, "db"); if (reason === "not-confident") value.decision.answers.delta.confidence = 0.49;
        return value;
      }, adopt: async next => { session = next; },
    });
    assert.equal(result.reason, reason); assert.equal(result.requests, 2);
    assert.deepEqual(result.selected.map(item => item.key), ["api"]);
    assert.equal(draftUsed(session), draftUsed(before) + 1);
    const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
    assert.deepEqual(reverted.working.records, before.working.records); assert.equal(reverted.stored, before.stored);
    assert.deepEqual(reverted.draft, before.draft);
    assert.equal(reverted.accepted, before.accepted);
    assert.deepEqual(currentClaims(reverted.draft.filter(item => item.claims !== undefined), reverted.working.records), visibleClaims);
  }
});

test("ADD/Connect candidates remain bounded by eight requests, never a ninth", async () => {
  for (const count of [7, 8]) {
    const before = await opened(); let session = before; let calls = 0;
    const offered = count === 8 ? bundle : { ...bundle, parts: bundle.parts.filter(part => part.key !== "group") };
    const result = await runGoal({ utterance: "add all offered parts", bundle: offered, protocol,
      current: () => session, cancelled: () => false,
      ask: async request => { calls += 1; return { kind: "answered", decision: { answers: {
        delta: { type: "choice", choice: request.state.candidates[0].id, confidence: 1 },
      } } }; },
      adopt: async next => { session = next; },
    });
    assert.equal(result.reason, "budget-requests");
    assert.equal(result.requests, 8); assert.equal(calls, 8); assert.equal(result.selected.length, count);
    const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
    assert.deepEqual(reverted.working.records, before.working.records);
  }
});

test("a Goal nests an offered group, grows it for its child, connects into it and Undo restores every old pin", async () => {
  const before = await opened(); let session = before; let group = null; let calls = 0;
  const result = await runGoal({ utterance: "OCIの中にグループを作り、その中にDB、OCIにAPIを置いてAPIからDBへつないで", bundle, protocol,
    current: () => session, cancelled: () => false, ask: async request => {
      calls += 1;
      if (calls === 1) return answer(request, "group");
      if (calls === 2) {
        group = request.state.selected[0].region;
        assert.equal(request.state.candidates.some(candidate => candidate.part === "db" && candidate.parent === group), true);
        return answer(request, "db", group);
      }
      if (calls === 3) return answer(request, "api");
      const db = request.state.selected[1].region, api = request.state.selected[2].region;
      const edge = request.state.candidates.find(item => item.action === "add-edge" && item.from === api && item.to === db);
      return { kind: "answered", decision: { answers: { delta: { type: "choice", choice: calls === 4 ? edge.id : NONE, confidence: 1 } } } };
    }, adopt: async next => { session = next; } });
  assert.equal(result.reason, "none"); assert.equal(result.requests, 5);
  assert.deepEqual(result.selected.map(item => [item.key, item.parent]), [["group", "container"], ["db", group], ["api", "container"]]);
  const regions = session.working.records.filter(record => record.type === "region");
  assert.equal(regions.find(record => record.id === group).kind, "group");
  assert.equal(regions.find(record => record.id === result.selected[1].region).parent, group);
  assert.deepEqual(session.working.records.filter(item => item.type === "relation").map(({ from, to }) => [from, to]),
    [[result.selected[2].region, result.selected[1].region]]);
  const layout = protocol.layoutBoundsFor(session.working.records, { pattern: protocol.GRAPH_PATTERN }).bounds;
  const inside = (outer, inner) => inner[0] >= outer[0] && inner[1] >= outer[1]
    && inner[0] + inner[2] <= outer[0] + outer[2] && inner[1] + inner[3] <= outer[1] + outer[3];
  assert.ok(inside(layout.container, layout[group]) && inside(layout[group], layout[result.selected[1].region]));
  assert.equal(draftUsed(session), 1);
  const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(reverted.working.records, before.working.records);
  assert.deepEqual(protocol.layoutBoundsFor(reverted.working.records, { pattern: protocol.GRAPH_PATTERN }).bounds,
    protocol.layoutBoundsFor(before.working.records, { pattern: protocol.GRAPH_PATTERN }).bounds);
});

test("held additions reject unknown IDs, changed placement inputs and silent replanning", async () => {
  const before = await opened();
  const options = { bundle, protocol, reserved: before.issuedPartIds, selected: [] };
  const held = legalAdditions(before.working, options);
  const candidate = held.candidates[0];
  assert.throws(() => { candidate.operations[0].bounds[0] += 1; }, TypeError);
  assert.throws(() => { candidate.operations[1].items[0].bounds[0] += 1; }, TypeError);
  const base = { working: before.working, held, candidateId: candidate.id, confidence: 1, ...options };
  assert.equal((await proveAddition({ ...base, candidateId: "unknown" })).reason, "invalid-addition");
  for (const changed of [
    { bundle: { ...bundle, parts: [...bundle.parts].reverse() } },
    { reserved: [...before.issuedPartIds, "part-90"] },
    { selected: [{ key: "api", region: "part-90", parent: "container" }] },
    { working: { ...before.working, records: before.working.records.map(record => record.type === "layout"
      ? { ...record, bounds: [1, ...record.bounds.slice(1)] } : record) } },
  ]) assert.equal((await proveAddition({ ...base, ...changed })).reason, "stale-addition");
  const changedProjection = { ...protocol, layoutBoundsFor: (records, view) => {
    const layout = protocol.layoutBoundsFor(records, view);
    return { ...layout, bounds: Object.fromEntries(Object.entries(layout.bounds).map(([id, box]) => [id, [box[0] + 1, ...box.slice(1)]])) };
  } };
  assert.equal((await proveAddition({ ...base, protocol: changedProjection })).reason, "stale-addition");
  const proved = await proveAddition(base);
  assert.equal(proved.outcome, "step");
  assert.deepEqual(proved.step.decision.operations, candidate.operations);
});

test("a smaller-only fit is an executable single choice without claiming model quality", async () => {
  const original = await opened();
  const pinned = await protocol.createDecision(original.working.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: [0, 0, 220, 160] },
    { regionId: "other", bounds: [0, 200, 40, 40] },
  ] }], original.working.records);
  const graph = (await protocol.appendDecision(original.working.log, pinned.decision)).verified;
  const before = createSession({ accepted: graph, stored: graph.log });
  let session = before;
  const offered = { ...bundle, parts: [bundle.parts.find(part => part.key === "api"),
    { key: "wide", purpose: "wide fixture", label: "a deliberately long offered label", kind: "step" }] };
  let calls = 0;
  const held = legalAdditions(graph, { bundle: offered, protocol });
  assert.deepEqual(held.candidates.map(({ part, parent }) => ({ part, parent })), [{ part: "api", parent: "container" }]);
  const result = await runGoal({ utterance: "OCIにAPIをひとつ追加して。他は変えない", bundle: offered, protocol, current: () => session,
    cancelled: () => false, ask: async request => { calls += 1; assert.equal(Object.keys(slotsFor(request.state)).length, 1);
      return answer(request, "api"); }, adopt: async next => { session = next; } });
  assert.equal(result.reason, "no-executable-delta"); assert.equal(result.requests, 1); assert.equal(calls, 1);
  assert.deepEqual(result.selected.map(item => [item.key, item.parent]), [["api", "container"]]);
  const added = session.working.records.filter(record => record.type === "region" && !graph.records.some(old => old.id === record.id));
  assert.deepEqual(added.map(record => [record.kind, record.parent, record.label.replace(/ [1-9]\d*$/u, "")]), [["step", "container", "API"]]);
  assert.deepEqual(session.working.records.filter(record => graph.records.some(old => JSON.stringify(old) === JSON.stringify(record))), graph.records);
  const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(reverted.working.records, graph.records); assert.deepEqual(reverted.draft, before.draft);
  assert.equal(reverted.stored, before.stored); assert.equal(reverted.accepted, before.accepted);
  const invalidPreview = { ...protocol, layoutBoundsFor: () => { throw new Error("invalid projection"); } };
  assert.deepEqual(legalAdditions(graph, { bundle: offered, protocol: invalidPreview }).candidates, []);
  assert.equal((await planAddition({ working: graph, head: graph.head, partKey: "api", parentId: "container",
    confidence: 1, bundle: offered, protocol: invalidPreview })).reason, "no-room-for-part");
  for (const phase of [1, 2, 3]) {
    let reads = 0;
    const invalidBounds = { ...protocol, layoutBoundsFor: (records, view) => {
      const layout = protocol.layoutBoundsFor(records, view);
      if (++reads !== phase) return layout;
      const id = phase === 1 ? "container" : records.find(record => record.type === "region" && record.parent === "container").id;
      return { ...layout, bounds: { ...layout.bounds, [id]: [0, 0, NaN, 92] } };
    } };
    assert.equal((await planAddition({ working: graph, head: graph.head, partKey: "api", parentId: "container",
      confidence: 1, bundle: offered, protocol: invalidBounds })).reason, "no-room-for-part");
  }
});
