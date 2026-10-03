import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readBundle } from "../src/bundle.mjs";
import { GOAL_REQUEST_KIND, NONE, isRequest, slotsFor } from "../src/contract.mjs";
import { runGoal } from "../src/goal.mjs";
import { createSession, undo, draftUsed } from "../src/session.mjs";
import { MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { additionParents } from "../src/turn.mjs";

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
  return createSession({ accepted: graph, stored: graph.log });
};
const answer = (part, parent = "container") => ({ kind: "answered", decision: { answers: {
  part: { type: "choice", choice: part, confidence: 1 }, parent: { type: "choice", choice: parent, confidence: 1 },
} } });

test("one Goal adopts two real AddRegions and whole-group Undo without claiming NONE is goal success", async () => {
  const before = await opened();
  let session = before;
  const requests = [];
  const choices = ["api", "db", NONE];
  const result = await runGoal({ utterance, bundle, protocol, current: () => session, cancelled: () => false,
    ask: async request => { requests.push(request); return answer(choices.shift()); },
    adopt: async next => { session = next; },
  });
  assert.equal(result.reason, "none");
  assert.equal(result.requests, 3);
  assert.equal(requests.every(request => request.kind === GOAL_REQUEST_KIND && isRequest(request)), true);
  assert.equal(requests.every(request => request.state.utterance === utterance && request.state.offers.parts.length === 7), true);
  assert.equal(slotsFor(requests[1].state).part.includes("api"), false);
  assert.equal(requests[1].state.selected[0].key, "api");
  const added = session.working.records.filter(record => !before.working.records.some(old => old.id === record.id));
  assert.deepEqual(added.map(({ label, kind, parent }) => ({ label: label.replace(/ \d+$/u, ""), kind, parent })), [
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
  assert.equal(additionParents(before.working).length, 2);
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
