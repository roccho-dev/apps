import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readBundle } from "../src/bundle.mjs";
import { ACTION_ADD_EDGE, ACTION_ADD_PART, ACTION_PLACE_PART, ACTION_UNDO_REQUEST, DRAFT_MAX, NONE } from "../src/contract.mjs";
import { COMMIT_COMMITTED, MAP_ID, STATE_SCHEMA, commitLog, statesOf } from "../src/log.mjs";
import {
  appendRevert,
  apply,
  clearConversation,
  createSession,
  discard,
  draftFull,
  noteRefused,
  propose,
  recentConversation,
  spendPending,
  startNew,
  undo,
} from "../src/session.mjs";
import { OUTCOME_NO_CHANGE, OUTCOME_REFUSED, OUTCOME_STEP, pendingForJev, requestFor, revertStep } from "../src/turn.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href);
const verifyDecisionLog = protocol.verifyDecisionLog;
// A storage key of this test's own; the page passes the one its config declares.
const HISTORY_KEY = "session test key";
const COMMIT_CONFLICT = "conflict";
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = readBundle(JSON.parse(fs.readFileSync(path.join(here, "../web/data/bundle.v1.json"), "utf8")));

const node = (id, x) => ({ type: "region", id, parent: "root", label: id, kind: "node", bounds: [x, 90, 140, 64], summary: "" });
const saved = () => protocol.createDecisionLog([
  { type: "meta", schema: STATE_SCHEMA, root: "root", title: "fixture" },
  { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  node("node-a", 40),
  node("node-b", 250),
  node("node-c", 460),
], MAP_ID);
const opened = async () => {
  const graph = await saved();
  return createSession({ accepted: graph, stored: graph.log });
};

const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence });
const WIDE = [-400, -400, 2000, 2000];

// One utterance judged against the session's working graph, the way the page
// does it: spend any held piece, ask, then propose with what was held.
const say = async (session, picks, { text = "said", source = "typed", layout = false, confidence } = {}) => {
  const { session: spent, held } = spendPending(session);
  const working = spent.working;
  const layoutNow = layout ? protocol.layoutBoundsFor(working.records, { pattern: protocol.GRAPH_PATTERN }) : null;
  const { turn } = requestFor({
    working,
    utterance: text,
    bundle,
    layout: layoutNow,
    offeredFrame: layout ? WIDE : null,
    draft: spent.draft.map(item => item.step),
    focus: null,
    pending: held === null ? null : pendingForJev(held.intent),
    recent: recentConversation(spent).recent,
  });
  const answers = Object.fromEntries(Object.keys(turn.slots).map(name => [
    name, picks[name] === undefined ? choice(NONE, confidence) : typeof picks[name] === "string" ? choice(picks[name], confidence) : picks[name],
  ]));
  return propose(spent, {
    turn, answers, protocol, bundle, layout: layoutNow,
    visibleFrame: layout ? { head: working.head, frame: WIDE } : null,
    input: { source, text }, repair: held,
  });
};

const storage = initial => {
  const values = new Map(initial === null ? [] : [[HISTORY_KEY, initial]]);
  return {
    values,
    commit: ({ graph, expected }) => commitLog({
      graph,
      expected,
      key: HISTORY_KEY,
      read: async key => values.get(key) ?? null,
      write: async (key, value) => { values.set(key, value); },
      lock: (name, run) => run(),
      verifyDecisionLog,
    }),
  };
};

test("NO_LOG has no graph at all until the person makes one, and nothing is stored until Apply", async () => {
  const empty = createSession({ accepted: null, stored: null });
  assert.equal(empty.accepted, null);
  assert.equal(empty.working, null);
  assert.throws(() => createSession({ accepted: null, stored: "log" }), /come together/u);

  const unnamed = await startNew(empty, { title: "", protocol });
  assert.equal(unnamed.session, empty);
  assert.deepEqual(unnamed.result, { outcome: OUTCOME_NO_CHANGE, reason: "no-title" });

  const { session: made, result } = await startNew(empty, { title: "計画", protocol });
  assert.equal(result.outcome, OUTCOME_STEP);
  assert.equal(made.accepted, null, "a new map is a draft");
  assert.equal(made.draft.length, 1);
  assert.equal(made.draft[0].input, null);
  await assert.rejects(() => startNew(made, { title: "again", protocol }), /no log/u);

  // Undoing the new map returns to NO_LOG.
  const back = await undo(made, { verifyDecisionLog });
  assert.equal(back.working, null);
  assert.deepEqual(back.draft, []);

  // Apply stores it where nothing was stored, and it is then the saved graph.
  const origin = storage(null);
  const { session: appliedSession, result: committed } = await apply(made, { commit: origin.commit });
  assert.equal(committed.status, COMMIT_COMMITTED);
  assert.equal(appliedSession.accepted, made.working);
  assert.equal(appliedSession.stored, made.working.log);
  assert.equal(origin.values.get(HISTORY_KEY), made.working.log);

  // Parts can be asked for on the empty map straight away.
  const part = await say(appliedSession, { action: ACTION_ADD_PART, part: "step" });
  assert.equal(part.result.outcome, OUTCOME_STEP);
});

test("a step joins the draft with the input it was judged from, and the conversation with its effect", async () => {
  const session = await opened();
  const { session: next, result } = await say(session, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" }, { text: "c to a" });
  assert.equal(result.outcome, OUTCOME_STEP);
  assert.deepEqual(next.draft[0].input, { source: "typed", text: "c to a", seq: 1 });
  assert.deepEqual(next.conversation, [{
    seq: 1, source: "typed", text: "c to a", outcome: "step",
    effect: { changes: [{ change: "added", from: "node-c", to: "node-a" }] },
  }]);
  assert.equal(next.accepted, session.accepted, "the saved graph never moves before Apply");
  assert.equal(next.stored, session.stored);
});

test("no-change, undo-request and refusal are remembered as what they were; a failure Jev never judged is not", async () => {
  let session = await opened();
  session = (await say(session, { action: NONE }, { text: "weather" })).session;
  session = (await say(session, { action: ACTION_UNDO_REQUEST }, { text: "undo that" })).session;
  const refused = await say(session, { action: ACTION_ADD_EDGE, source: "node-a", target: "node-a" }, { text: "a to a" });
  assert.equal(refused.result.outcome, OUTCOME_REFUSED);
  session = noteRefused(refused.session, { source: "voice", text: "drawn badly" });
  assert.deepEqual(session.conversation.map(entry => [entry.seq, entry.outcome]),
    [[1, "no-change"], [2, "undo-request"], [3, "refused"], [4, "refused"]]);
  assert.deepEqual(session.draft, []);
});

test("undo and discard drop steps and mark their utterances undone, never below what is saved", async () => {
  let session = await opened();
  session = (await say(session, { action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" }, { text: "one" })).session;
  session = (await say(session, { action: ACTION_ADD_EDGE, source: "node-b", target: "node-c" }, { text: "two" })).session;
  const undone = await undo(session, { verifyDecisionLog });
  assert.equal(undone.draft.length, 1);
  assert.deepEqual(undone.conversation.map(entry => entry.outcome), ["step", "undone"]);
  assert.equal(undone.conversation[1].effect, undefined);
  const discarded = discard(undone);
  assert.equal(discarded.working, session.accepted);
  assert.deepEqual(discarded.conversation.map(entry => entry.outcome), ["undone", "undone"]);
  assert.equal(await undo(discarded, { verifyDecisionLog }), discarded, "nothing to undo is no change");
});

test("a near-placement is held for exactly one utterance, and the repair shows both texts", async () => {
  const session = await opened();
  const near = await say(session, {
    action: ACTION_PLACE_PART, move: "node-c", anchor: choice("node-a", 0.39), direction: "right",
  }, { text: "put it left", layout: true });
  assert.equal(near.result.reason, "placement-missing-anchor");
  assert.equal(near.session.pending.intent.missing, "anchor");
  assert.deepEqual(near.session.pending.input, { source: "typed", text: "put it left" });

  const repaired = await say(near.session, { action: NONE, anchor: "node-a" }, { text: "node-a", layout: true });
  assert.equal(repaired.result.outcome, OUTCOME_STEP);
  assert.equal(repaired.session.pending, null, "the one repair is spent");
  assert.deepEqual(repaired.session.draft[0].input.origin, { source: "typed", text: "put it left" });

  // Whatever the next utterance is, the held piece is gone after it.
  const other = await say(near.session, { action: NONE }, { text: "never mind", layout: true });
  assert.equal(other.session.pending, null);
  assert.equal(clearConversation(near.session).pending, null);
});

test("the draft cap holds for every append, including a revert", async () => {
  let session = await opened();
  for (let index = 0; index < DRAFT_MAX / 2; index += 1) {
    session = (await say(session, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" })).session;
    session = (await say(session, { action: "remove-edge", edge: "voice-node-c-to-node-a" })).session;
  }
  assert.ok(draftFull(session));
  const refused = await say(session, { action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" });
  assert.deepEqual(refused.result, { outcome: OUTCOME_NO_CHANGE, reason: "draft-full" });

  const origin = storage(session.stored);
  const oneApplied = (await apply(
    (await say(await opened(), { action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" })).session,
    { commit: origin.commit },
  )).session;
  const states = await statesOf(oneApplied.accepted.log, verifyDecisionLog);
  let full = oneApplied;
  for (let index = 0; index < DRAFT_MAX / 2; index += 1) {
    full = (await say(full, { action: ACTION_ADD_EDGE, source: "node-c", target: "node-a" })).session;
    full = (await say(full, { action: "remove-edge", edge: "voice-node-c-to-node-a" })).session;
  }
  const built = await revertStep({ before: states[0], after: states[1], working: full.working, protocol });
  assert.deepEqual((await appendRevert(full, { step: built.step, protocol })).result, { outcome: OUTCOME_NO_CHANGE, reason: "draft-full" });
});

test("a refused Apply leaves every step in place; a committed one saves them all at once", async () => {
  const session = (await say(await opened(), { action: ACTION_ADD_EDGE, source: "node-a", target: "node-b" })).session;
  const moved = storage("another tab's log");
  const conflict = await apply(session, { commit: moved.commit });
  assert.deepEqual(conflict.result, { status: COMMIT_CONFLICT });
  assert.equal(conflict.session, session);

  const origin = storage(session.stored);
  const committed = await apply(session, { commit: origin.commit });
  assert.equal(committed.session.accepted, session.working);
  assert.deepEqual(committed.session.draft, []);
  assert.deepEqual(committed.session.conversation, session.conversation, "Apply keeps the conversation");
});

test("the conversation window is the last five short enough to send; longer ones are counted, never cut", async () => {
  let session = await opened();
  for (let index = 1; index <= 6; index += 1) session = (await say(session, { action: NONE }, { text: `t${index}` })).session;
  session = (await say(session, { action: NONE }, { text: "x".repeat(201) })).session;
  const { recent, skipped } = recentConversation(session);
  assert.deepEqual(recent.map(entry => entry.text), ["t2", "t3", "t4", "t5", "t6"]);
  assert.equal(skipped, 1);
  assert.deepEqual(recentConversation(clearConversation(session)), { recent: [], skipped: 0 });
});
