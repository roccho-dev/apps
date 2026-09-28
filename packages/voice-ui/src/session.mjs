import {
  DRAFT_MAX,
  OUTCOME_NO_CHANGE,
  appendStep,
  planStep,
  repairStep,
} from "./decision/correction.mjs";
import { truncateLog } from "./decision/history.mjs";

export const SESSION_READY = "ready";
export const SESSION_DRAFTED = "drafted";
export const SESSION_NO_CHANGE = "no-change";
export const SESSION_UNDO_REQUEST = "undo-request";
export const SESSION_DRAFT_FULL = "draft-full";
export const SESSION_APPLIED = "applied";
export const SESSION_UNDONE = "undone";
export const SESSION_DISCARDED = "discarded";

const demand = (condition, reason) => {
  if (!condition) throw new TypeError(`voice-ui session: ${reason}`);
};

const requireGraph = (name, graph) => {
  demand(typeof graph?.log === "string" && graph.log.length > 0, `${name}.log is required`);
  demand(typeof graph?.head === "string" && graph.head.length > 0, `${name}.head is required`);
  demand(Array.isArray(graph?.records), `${name}.records is required`);
  demand(Array.isArray(graph?.decisions), `${name}.decisions is required`);
};

const freezeList = values => Object.freeze([...values]);

const freezeSession = value => Object.freeze({
  ...value,
  draft: freezeList(value.draft),
  issuedPartIds: freezeList(value.issuedPartIds),
});

export function createSession({ accepted, stored = null } = {}) {
  requireGraph("accepted", accepted);
  demand(stored === null || typeof stored === "string", "stored must be null or a string");
  return freezeSession({
    accepted,
    working: accepted,
    draft: [],
    pending: null,
    issuedPartIds: [],
    stored,
    status: SESSION_READY,
  });
}

const issuedBy = step => (step?.changes ?? [])
  .filter(change => change?.change === "added" && change?.kind === "region" && typeof change.id === "string")
  .map(change => change.id);

const withStatus = (session, status, extra = {}) => freezeSession({
  ...session,
  ...extra,
  status,
});

export function clearPendingSession(session) {
  requireGraph("session.accepted", session?.accepted);
  requireGraph("session.working", session?.working);
  return freezeSession({ ...session, pending: null });
}

export async function appendSessionStep({ session, step, protocol } = {}) {
  requireGraph("session.accepted", session?.accepted);
  requireGraph("session.working", session?.working);
  demand(Array.isArray(session?.draft), "session.draft is required");
  demand(Array.isArray(session?.issuedPartIds), "session.issuedPartIds is required");

  const working = await appendStep({ working: session.working, step, protocol });
  const issuedPartIds = new Set([...session.issuedPartIds, ...issuedBy(step)]);
  return withStatus(session, SESSION_DRAFTED, {
    working,
    draft: [...session.draft, step],
    pending: null,
    issuedPartIds: [...issuedPartIds],
  });
}

// One typed interaction against the current working world. This is the same
// state transition the browser uses: decision rules produce a provider
// Decision, the provider appends and verifies it, then the working state and
// draft advance together. Nothing here renders, persists or touches a browser.
export async function proposeSession({
  session,
  answers,
  protocol,
  layout = null,
  visibleFrame = null,
  offeredFrame = null,
  candidates = [],
  input = null,
} = {}) {
  requireGraph("session.accepted", session?.accepted);
  requireGraph("session.working", session?.working);
  demand(Array.isArray(session?.draft), "session.draft is required");
  demand(Array.isArray(session?.issuedPartIds), "session.issuedPartIds is required");

  if (session.draft.length >= DRAFT_MAX) {
    return Object.freeze({
      session: withStatus(session, SESSION_DRAFT_FULL),
      result: Object.freeze({ kind: SESSION_NO_CHANGE, reason: SESSION_DRAFT_FULL }),
    });
  }

  const options = {
    working: session.working,
    revision: session.working.head,
    answers,
    protocol,
    reserved: session.issuedPartIds,
    layout,
    visibleFrame,
    offeredFrame,
    candidates,
  };
  const planned = session.pending === null
    ? await planStep(options)
    : await repairStep({ ...options, pending: session.pending.intent });

  if (planned.outcome === OUTCOME_NO_CHANGE) {
    const pending = session.pending === null && planned.pending !== undefined
      ? Object.freeze({ intent: planned.pending, input })
      : null;
    const status = planned.undoRequest === true ? SESSION_UNDO_REQUEST : SESSION_NO_CHANGE;
    return Object.freeze({
      session: withStatus(session, status, { pending }),
      result: Object.freeze({
        kind: SESSION_NO_CHANGE,
        reason: planned.reason,
        undoRequest: planned.undoRequest === true,
      }),
    });
  }

  const next = await appendSessionStep({ session, step: planned.step, protocol });

  return Object.freeze({
    session: next,
    result: Object.freeze({
      kind: SESSION_DRAFTED,
      step: planned.step,
      repaired: planned.repaired === true,
    }),
  });
}

// Apply is deliberately a port: production binds it to history.persistHistory
// and localStorage, while integration scenarios bind it to isolated memory.
// State advances only after the port confirms the write.
export async function applySession({ session, persist } = {}) {
  requireGraph("session.accepted", session?.accepted);
  requireGraph("session.working", session?.working);
  demand(typeof persist === "function", "persist is required");
  if (session.draft.length === 0) return session;

  await persist({ graph: session.working, expected: session.stored });
  return withStatus(session, SESSION_APPLIED, {
    accepted: session.working,
    draft: [],
    pending: null,
    stored: session.working.log,
  });
}

export async function undoSession({ session, verifyDecisionLog } = {}) {
  requireGraph("session.accepted", session?.accepted);
  requireGraph("session.working", session?.working);
  demand(typeof verifyDecisionLog === "function", "verifyDecisionLog is required");
  if (session.draft.length === 0) return session;

  const working = await truncateLog(session.working, {
    count: session.working.decisions.length - 1,
    floor: session.accepted.decisions.length,
    verifyDecisionLog,
  });
  return withStatus(session, SESSION_UNDONE, {
    working,
    draft: session.draft.slice(0, -1),
    pending: null,
  });
}

export function discardSession(session) {
  requireGraph("session.accepted", session?.accepted);
  requireGraph("session.working", session?.working);
  if (session.draft.length === 0) return session;
  return withStatus(session, SESSION_DISCARDED, {
    working: session.accepted,
    draft: [],
    pending: null,
  });
}
