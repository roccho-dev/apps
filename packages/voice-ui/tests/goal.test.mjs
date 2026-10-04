import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readBundle } from "../src/bundle.mjs";
import { GOAL_REQUEST_KIND, NONE, isRequest, slotsFor } from "../src/contract.mjs";
import { runGoal } from "../src/goal.mjs";
import { createSession, undo, draftUsed, proposeArchitecture } from "../src/session.mjs";
import { currentClaims } from "../src/document.mjs";
import { MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { legalAdditions, proveAddition, legalLocalDeltas, proveLocalDelta } from "../src/turn.mjs";

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

const opened = async () => {
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "goal fixture" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 900, 400], summary: "" },
    { type: "region", id: "container", parent: "root", label: "OCI", kind: "group", bounds: [0, 0, 700, 200], summary: "" },
    { type: "region", id: "other", parent: "root", label: "Other", kind: "group", bounds: [0, 230, 700, 160], summary: "" },
  ], MAP_ID);
  const pinned = await protocol.createDecision(graph.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: [0, 0, 2000, 500] },
    { regionId: "other", bounds: [0, 600, 2000, 500] },
  ] }], graph.records);
  const prepared = (await protocol.appendDecision(graph.log, pinned.decision)).verified;
  return createSession({ accepted: prepared, stored: prepared.log });
};
const answer = (request, part, parent = "container") => ({ kind: "answered", decision: { answers: {
  delta: { type: "choice", choice: part === NONE ? NONE
    : request.state.candidates.find(candidate => candidate.part === part && candidate.parent === parent)?.id ?? "unknown", confidence: 1 },
} } });

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
  const legacy = legalAdditions(session.working, { bundle, protocol, selected: result.selected });
  assert.equal(legacy.candidates.some(item => item.operations.some(op => op.type === "ConnectRegions")), false,
    "canonical add-only catalogue cannot supply the mixed Goal's edge");
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
  assert.equal(requests.every(request => request.state.utterance === utterance && request.state.offers.parts.length === 7), true);
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
  const full = { ...session.working, records: session.working.records.map(record => record.id === "container"
    ? { ...record, bounds: [0, 0, 24, 18] } : record) };
  assert.equal((await planAddition({ ...base, working: full })).reason, "no-room-for-part");
  assert.equal(legalAdditions(full, { bundle, protocol }).candidates.some(candidate => candidate.parent === "container"), false);
});

test("early NONE, no room and elapsed budget stop at their actual request count", async () => {
  for (const reason of ["none", "no-executable-delta", "budget-time"]) {
    const before = await opened();
    const session = reason !== "no-executable-delta" ? before : { ...before, working: { ...before.working,
      records: before.working.records.map(record => record.kind === "group" ? { ...record, bounds: [0, 0, 24, 18] } : record),
    } };
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
    const offered = count === 7 ? bundle : { ...bundle, parts: [...bundle.parts,
      { key: "extra", purpose: "another bounded fixture offer", label: "Extra", kind: "step" }],
    };
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
