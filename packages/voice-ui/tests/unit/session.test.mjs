import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  SESSION_APPLIED,
  SESSION_DISCARDED,
  SESSION_DRAFTED,
  SESSION_UNDONE,
  applySession,
  createSession,
  discardSession,
  proposeSession,
  undoSession,
} from "../../src/session.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
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

const choice = value => ({ type: "choice", choice: value, confidence: 0.99 });
const addEdge = Object.freeze({
  action: choice("add-edge"),
  source: choice("node-a"),
  target: choice("node-b"),
  part: choice("none"),
});

const draftOne = session => proposeSession({ session, answers: addEdge, protocol }).then(result => result.session);

test("a session drafts, undoes, discards and applies without a browser", async () => {
  const accepted = await baseGraph();
  const initial = createSession({ accepted });

  const drafted = await draftOne(initial);
  assert.equal(drafted.status, SESSION_DRAFTED);
  assert.equal(drafted.accepted.log, accepted.log, "a proposal does not change accepted state");
  assert.notEqual(drafted.working.log, accepted.log);
  assert.equal(drafted.draft.length, 1);

  const undone = await undoSession({ session: drafted, verifyDecisionLog: protocol.verifyDecisionLog });
  assert.equal(undone.status, SESSION_UNDONE);
  assert.equal(undone.working.log, accepted.log);
  assert.deepEqual(undone.draft, []);

  const discarded = discardSession(await draftOne(initial));
  assert.equal(discarded.status, SESSION_DISCARDED);
  assert.equal(discarded.working.log, accepted.log);
  assert.deepEqual(discarded.draft, []);

  let stored = null;
  const beforeApply = await draftOne(initial);
  const applied = await applySession({
    session: beforeApply,
    persist: async ({ graph, expected }) => {
      assert.equal(expected, null);
      assert.equal(stored, expected);
      stored = graph.log;
    },
  });
  assert.equal(applied.status, SESSION_APPLIED);
  assert.equal(applied.accepted.log, beforeApply.working.log);
  assert.equal(applied.working.log, beforeApply.working.log);
  assert.equal(applied.stored, stored);
  assert.deepEqual(applied.draft, []);
});

test("a failed persistence leaves the session unchanged", async () => {
  const before = await draftOne(createSession({ accepted: await baseGraph() }));
  await assert.rejects(
    applySession({
      session: before,
      persist: async () => { throw new Error("disk full"); },
    }),
    /disk full/u,
  );
  assert.equal(before.status, SESSION_DRAFTED);
  assert.equal(before.draft.length, 1);
});
