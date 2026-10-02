import { CONTEXT_MAX, CONTEXT_TEXT_MAX, DRAFT_MAX } from "./contract.mjs";
import { COMMIT_COMMITTED, truncateLog } from "./log.mjs";
import {
  OUTCOME_NO_CHANGE,
  OUTCOME_REFUSED,
  OUTCOME_STEP,
  appendStep,
  changesForJudgment,
  newMap,
  planStep,
  repairStep,
} from "./turn.mjs";

// The page's whole in-memory state, as one frozen value that only these
// transitions replace:
//   accepted      the saved graph, or null while there is no log (NO_LOG)
//   working       the saved graph plus every unapplied step, or null
//   stored        the log this page last read or wrote, or null
//   draft         each unapplied step with the input it was judged from
//   pending       a placement held for exactly one more utterance, or null
//   issuedPartIds every part name this page has handed out, never reused
//   conversation  every utterance the judgment binding judged here, and what came of it
// Nothing here renders, stores or touches a browser; Apply is handed the one
// durable write as a function.

const demand = (condition, reason) => {
  if (!condition) throw new TypeError(`voice-ui session: ${reason}`);
};

const freeze = value => Object.freeze({
  ...value,
  draft: Object.freeze([...value.draft]),
  issuedPartIds: Object.freeze([...value.issuedPartIds]),
  conversation: Object.freeze([...value.conversation]),
});

const noChange = reason => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason });

export function createSession({ accepted, stored }) {
  demand((accepted === null) === (stored === null), "a saved graph and its stored log come together");
  return freeze({
    accepted,
    working: accepted,
    stored,
    draft: [],
    pending: null,
    issuedPartIds: [],
    conversation: [],
    nextSeq: 1,
  });
}

// The draft as utterances: the steps of one architecture utterance share its
// seq as their group and are counted, sent and undone as one; any other step
// stands alone. This is in memory only; what is saved is each Decision.
const unitsOf = draft => draft.reduce((units, item) => {
  if (item.group !== undefined && units.at(-1)?.[0].group === item.group) units.at(-1).push(item);
  else units.push([item]);
  return units;
}, []);

export const draftUsed = session => unitsOf(session.draft).length;
export const draftFull = session => draftUsed(session) >= DRAFT_MAX;

// The draft as the next request carries it: one entry per utterance, with
// every change it made.
export const draftForJudgment = session => unitsOf(session.draft)
  .map(unit => Object.freeze({ changes: unit.flatMap(item => item.step.changes) }));

// What the next request sends and the panel shows: the most recent entries
// short enough to send whole, and how many were left out for being longer.
export function recentConversation(session) {
  return Object.freeze({
    recent: Object.freeze(session.conversation.filter(entry => entry.text.length <= CONTEXT_TEXT_MAX).slice(-CONTEXT_MAX)),
    skipped: session.conversation.filter(entry => entry.text.length > CONTEXT_TEXT_MAX).length,
  });
}

const remember = (session, { source, text }, outcome, changes = null) => {
  const entry = Object.freeze({
    seq: session.nextSeq,
    source,
    text,
    outcome,
    ...(changes === null ? {} : { effect: Object.freeze({ changes: changesForJudgment(changes) }) }),
  });
  return freeze({ ...session, conversation: [...session.conversation, entry], nextSeq: session.nextSeq + 1 });
};

// A step that leaves the draft by Undo or Discard is marked undone in place,
// and no longer carries an effect.
const markUndone = (session, items) => {
  const seqs = new Set(items.map(item => item.input?.seq).filter(seq => seq !== undefined));
  return freeze({
    ...session,
    conversation: session.conversation.map(entry => seqs.has(entry.seq)
      ? Object.freeze({ seq: entry.seq, source: entry.source, text: entry.text, outcome: "undone" })
      : entry),
  });
};

// A held placement is spent by the utterance that follows it, whatever that
// utterance's result; the caller passes what was held to `propose`.
export function spendPending(session) {
  return Object.freeze({ session: freeze({ ...session, pending: null }), held: session.pending });
}

export const clearPending = session => freeze({ ...session, pending: null });

// Forget the recent conversation; the next request sends none.
export const clearConversation = session => freeze({ ...session, pending: null, conversation: [] });

// One more step on the working graph, never past the cap - which a later step
// of the same utterance does not count against again. The provider appends and
// verifies it; its input, if any, travels with it, and so do an architecture
// step's claims about where each of its records comes from, and its group.
async function appendItem(session, step, input, protocol, claims = undefined, group = undefined) {
  const continues = group !== undefined && session.draft.at(-1)?.group === group;
  if (draftFull(session) && !continues) return Object.freeze({ session, result: noChange("draft-full") });
  const appended = await appendStep({ working: session.working, step, protocol });
  if (appended.outcome !== OUTCOME_STEP) return Object.freeze({ session, result: appended });
  const issued = step.changes
    .filter(change => change.change === "added" && change.kind === "region")
    .map(change => change.id);
  return Object.freeze({
    session: freeze({
      ...session,
      working: appended.graph,
      draft: [...session.draft, Object.freeze(claims === undefined ? { step, input } : { step, input, claims, group })],
      pending: null,
      issuedPartIds: [...new Set([...session.issuedPartIds, ...issued])],
    }),
    result: Object.freeze({ outcome: OUTCOME_STEP, step }),
  });
}

// NO_LOG only: a new, empty map named by the person becomes the first
// unapplied step. There is no other way a graph comes into being here.
export async function startNew(session, { title, protocol }) {
  demand(session.accepted === null && session.working === null, "a new map starts only where there is no log");
  const made = await newMap({ title, protocol });
  if (made.outcome !== OUTCOME_STEP) return Object.freeze({ session, result: made });
  return Object.freeze({
    session: freeze({ ...session, working: made.graph, draft: [Object.freeze({ step: made.step, input: null })], pending: null }),
    result: Object.freeze({ outcome: OUTCOME_STEP, step: made.step }),
  });
}

// One judged utterance against the working graph. A step joins the draft with
// its input; a near-placement is held for the next utterance, unless this one
// was itself the repair; and the utterance joins the conversation with what
// came of it.
export async function propose(session, { turn, answers, protocol, bundle, layout, visibleFrame, input, repair }) {
  const options = { working: session.working, turn, answers, protocol, bundle, reserved: session.issuedPartIds, layout, visibleFrame };
  const planned = repair === null
    ? await planStep(options)
    : await repairStep({ ...options, pending: repair.intent });

  if (planned.outcome === OUTCOME_NO_CHANGE) {
    const pending = repair === null && planned.pending !== undefined ? Object.freeze({ intent: planned.pending, input }) : null;
    const next = remember(freeze({ ...session, pending }), input, planned.undoRequest === true ? "undo-request" : "no-change");
    return Object.freeze({ session: next, result: planned });
  }
  if (planned.outcome === OUTCOME_REFUSED) return Object.freeze({ session: noteRefused(session, input), result: planned });

  const judged = remember(session, input, "step", planned.step.changes);
  const withOrigin = planned.repaired === true
    ? { ...input, origin: repair.input, seq: session.nextSeq }
    : { ...input, seq: session.nextSeq };
  const appended = await appendItem(judged, planned.step, Object.freeze(withOrigin), protocol);
  if (appended.result.outcome !== OUTCOME_STEP) {
    return Object.freeze({ session: noteRefused(session, input), result: appended.result });
  }
  return appended;
}

// An utterance Jev judged as an architecture view, already planned against the
// prepared source as consecutive steps: it joins the conversation like any
// other judged utterance, and its steps join the draft in order, each with its
// claims and all in the utterance's group - all of them or none. Only the
// first carries the utterance; Undo takes the whole group back at once.
export async function proposeArchitecture(session, { planned, input, protocol }) {
  if (planned.outcome !== OUTCOME_STEP) {
    const next = planned.outcome === OUTCOME_NO_CHANGE ? remember(session, input, "no-change") : noteRefused(session, input);
    return Object.freeze({ session: next, result: planned });
  }
  if (draftFull(session)) return Object.freeze({ session: noteRefused(session, input), result: noChange("draft-full") });
  const group = session.nextSeq;
  let next = remember(session, input, "step", planned.steps.flatMap(item => item.step.changes));
  for (const [index, item] of planned.steps.entries()) {
    const stepInput = index === 0 ? Object.freeze({ ...input, seq: group }) : null;
    const appended = await appendItem(next, item.step, stepInput, protocol, item.claims, group);
    if (appended.result.outcome !== OUTCOME_STEP) {
      return Object.freeze({ session: noteRefused(session, input), result: appended.result });
    }
    next = appended.session;
  }
  return Object.freeze({ session: next, result: Object.freeze({ outcome: OUTCOME_STEP, steps: planned.steps.map(item => item.step) }) });
}

// An utterance the judgment binding judged whose step could not be kept.
export const noteRefused = (session, input) => remember(session, input, "refused");

// A revert of a saved entry: one more unapplied step, with no input.
export const appendRevert = (session, { step, protocol }) => appendItem(session, step, null, protocol);

// Drop the last unapplied utterance - every step it added - and nothing else,
// never below what is saved. Undoing a new map returns to NO_LOG.
export async function undo(session, { verifyDecisionLog }) {
  if (session.draft.length === 0) return session;
  const removed = unitsOf(session.draft).at(-1);
  const floor = session.accepted?.decisions.length ?? 1;
  const count = session.working.decisions.length - removed.length;
  const working = count < floor ? null : await truncateLog(session.working, { count, floor, verifyDecisionLog });
  return markUndone(freeze({ ...session, working, draft: session.draft.slice(0, -removed.length), pending: null }), removed);
}

export function discard(session) {
  if (session.draft.length === 0) return session;
  return markUndone(freeze({ ...session, working: session.accepted, draft: [], pending: null }), session.draft);
}

// Apply hands the working log - and the unapplied steps it grew by, for a
// format that records where each came from - to the one durable write, and
// advances only when it reports the value committed. Anything else leaves
// every step in place.
export async function apply(session, { commit }) {
  if (session.draft.length === 0) return Object.freeze({ session, result: null });
  const result = await commit({ graph: session.working, expected: session.stored, draft: session.draft });
  if (result.status !== COMMIT_COMMITTED) return Object.freeze({ session, result });
  return Object.freeze({
    session: freeze({ ...session, accepted: session.working, stored: result.stored, draft: [], pending: null }),
    result,
  });
}
