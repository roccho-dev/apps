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
import { additionParents, planAddition } from "../src/turn.mjs";

if (!process.env.SEMANTIC_MAP) throw new Error("SEMANTIC_MAP is required");
const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP, "packages/semantic-map/protocol/index.js")).href);
const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("../web/data/bundle.v1.json", import.meta.url), "utf8")));
const utterance = "OCIの中にAPIとDBを追加して";
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
const answer = (part, parent = "container") => ({ kind: "answered", decision: { answers: {
  part: { type: "choice", choice: part, confidence: 1 }, parent: { type: "choice", choice: parent, confidence: 1 },
} } });

test("one Goal adopts two real AddRegions and whole-group Undo without claiming NONE is goal success", async () => {
  for (const order of [["api", "db"], ["db", "api"]]) {
  const before = await opened();
  let session = before;
  const requests = [];
  const choices = [...order, NONE];
  const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
    ask: async request => { requests.push(request); return answer(choices.shift()); },
    adopt: async next => { session = next; },
  });
  assert.equal(result.reason, "none");
  assert.equal(result.requests, 3);
  assert.equal(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0, true);
  assert.equal(requests.every(request => request.kind === GOAL_REQUEST_KIND && isRequest(request)), true);
  assert.equal(requests.every(request => request.state.utterance === utterance && request.state.offers.parts.length === 7), true);
  assert.equal(slotsFor(requests[1].state).part.includes(order[0]), false);
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
    ask: async () => answer(calls++ === 0 ? "api" : NONE, "other"), adopt: async next => { session = next; },
  });
  assert.equal(result.reason, "none");
  assert.equal(result.selected[0].parent, "other");
  assert.equal(session.working.records.find(record => record.id === result.selected[0].region).parent === "container", false);
});

test("closed Goal validation rejects cycles, unknown history and repeated choices before another effect", async () => {
  const before = await opened(); let request;
  await runGoal({ utterance, bundle, protocol, current: () => before, cancelled: () => false,
    ask: async value => { request = value; return answer(NONE); }, adopt: async () => { throw new Error("unexpected"); },
  });
  for (const mutate of [
    state => { state.graph[0].parent = "container"; },
    state => { state.graph[1].parent = "container"; },
    state => { state.selected = [{ key: "absent", region: "container", parent: "root" }]; },
    state => { state.parents[0].kind = "step"; },
  ]) { const bad = structuredClone(request); mutate(bad.state); assert.equal(isRequest(bad), false); }
  assert.equal(additionParents(before.working, { bundle, protocol }).length, 2);
});

test("cancel, stale response, protocol failure and draw unknown stop without selected history advance", async () => {
  for (const reason of ["cancelled", "stale-goal", "judge-failed", "adoption-unknown"]) {
    const before = await opened(); let session = before; let cancelled = false;
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => cancelled,
      ask: async () => {
        if (reason === "cancelled") cancelled = true;
        if (reason === "stale-goal") session = { ...session };
        return reason === "judge-failed" ? { kind: "failed", reason: "judge-contract" } : answer("api");
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
      ask: async () => { if (calls++ === successful) throw new Error("not public"); return answer("api"); },
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
      ask: async () => value, adopt: async () => { throw new Error("unexpected adoption"); },
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
  assert.equal(additionParents(full, { bundle, protocol }).some(parent => parent.id === "container"), false);
});

test("early NONE, no room and elapsed budget stop at their actual request count", async () => {
  for (const reason of ["none", "no-room-for-part", "budget-time"]) {
    const before = await opened();
    const session = reason !== "no-room-for-part" ? before : { ...before, working: { ...before.working,
      records: before.working.records.map(record => record.kind === "group" ? { ...record, bounds: [0, 0, 24, 18] } : record),
    } };
    let calls = 0;
    const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
      now: () => reason === "budget-time" && calls > 0 ? 180000 : 0,
      ask: async () => { calls += 1; return answer(reason === "none" ? NONE : "api"); },
      adopt: async () => { throw new Error("unexpected adoption"); },
    });
    assert.equal(result.reason, reason);
    assert.equal(result.requests, reason === "no-room-for-part" ? 0 : 1);
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
      ask: async () => {
        calls += 1;
        if (calls === 1) return answer("api");
        if (reason === "cancelled") cancelled = true;
        if (reason === "stale-goal") session = { ...session };
        const value = answer("db"); if (reason === "not-confident") value.decision.answers.part.confidence = 0.49;
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

test("seven actual offers exhaust before eight, while the admitted eight-offer maximum proves no ninth request", async () => {
  for (const count of [7, 8]) {
    const before = await opened(); let session = before; let calls = 0;
    const offered = count === 7 ? bundle : { ...bundle, parts: [...bundle.parts,
      { key: "extra", purpose: "another bounded fixture offer", label: "Extra", kind: "step" }],
    };
    const result = await runGoal({ utterance: "add all offered parts", bundle: offered, protocol,
      current: () => session, cancelled: () => false,
      ask: async request => { calls += 1; return answer(slotsFor(request.state).part[0]); },
      adopt: async next => { session = next; },
    });
    assert.equal(result.reason, count === 7 ? "offers-exhausted" : "budget-requests");
    assert.equal(result.requests, count); assert.equal(calls, count); assert.equal(result.selected.length, count);
    const reverted = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
    assert.deepEqual(reverted.working.records, before.working.records);
  }
});

test("conservative parent capacity excludes smaller-only fit without asking or claiming full reachability", async () => {
  const original = await opened();
  const pinned = await protocol.createDecision(original.working.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: [0, 0, 220, 160] },
    { regionId: "other", bounds: [0, 200, 40, 40] },
  ] }], original.working.records);
  const graph = (await protocol.appendDecision(original.working.log, pinned.decision)).verified;
  const session = createSession({ accepted: graph, stored: graph.log });
  const offered = { ...bundle, parts: [bundle.parts.find(part => part.key === "api"),
    { key: "wide", purpose: "wide fixture", label: "a deliberately long offered label", kind: "step" }] };
  assert.deepEqual(additionParents(graph, { bundle: offered, protocol }), []);
  assert.equal(additionParents(graph, { bundle: offered, protocol, selected: [{ key: "wide" }] })[0].id, "container");
  let calls = 0;
  const result = await runGoal({ utterance, bundle: offered, protocol, current: () => session,
    cancelled: () => false, ask: async () => { calls += 1; return answer("api"); }, adopt: async () => assert.fail("no adoption") });
  assert.equal(result.reason, "no-room-for-part"); assert.equal(result.requests, 0); assert.equal(calls, 0);
  assert.deepEqual(result.selected, []);
  const invalidPreview = { ...protocol, layoutBoundsFor: () => { throw new Error("invalid projection"); } };
  assert.deepEqual(additionParents(graph, { bundle: offered, protocol: invalidPreview }), []);
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
