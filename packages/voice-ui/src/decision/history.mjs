// Restore, verify and project the committed DecisionLog that one browser origin
// keeps for this app. Pure: reading storage, writing storage and the provider
// verification are all injected, the same way app.mjs, render.mjs and
// graph-edge.mjs take their collaborators. Nothing here touches a browser
// global, so `web/index.html` stays the only holder of `localStorage` and the
// whole restore contract is provable under `node --test`.
//
// What is stored is the provider's own canonical DecisionLog string, not a
// derived projection, so restoring is a provider verification rather than a
// bespoke parse.

export const HISTORY_KEY = "voice-ui.decision-log.v1";

// Three honest outcomes of a restore, and only three. `empty` is the ordinary
// first visit; `corrupt` is fail-closed; neither is an exception.
export const RESTORE_EMPTY = "empty";
export const RESTORE_RESTORED = "restored";
export const RESTORE_CORRUPT = "corrupt";

// A failed write is different in kind: it must abort the sequence before the
// in-memory graph advances, so it throws rather than returning a status the
// caller could forget to read.
export class HistoryPersistFailed extends Error {
  constructor(cause) {
    super(`decision log was not persisted: ${cause?.message ?? cause}`);
    this.name = "HistoryPersistFailed";
    this.cause = cause;
  }
}

const demand = (condition, reason) => {
  if (!condition) throw new Error(`decision history: ${reason}`);
};

const regionIdsOf = records =>
  Object.freeze(
    (records ?? [])
      .filter(record => record?.type === "region" && record.parent !== null)
      .map(record => record.id),
  );

const relationsOf = records =>
  Object.freeze(
    (records ?? [])
      .filter(record => record?.type === "relation")
      .map(record => Object.freeze({ id: record.id, from: record.from, to: record.to })),
  );

// One committed operation described for display. ConnectRegions is the only
// shape this app can produce today, but an unknown operation is reported by its
// type rather than dropped, so a projection can never quietly under-report what
// the verified log actually contains.
const factOf = operation =>
  operation.type === "ConnectRegions"
    ? Object.freeze({
      type: operation.type,
      relationId: operation.relationId,
      from: operation.from,
      to: operation.to,
    })
    : Object.freeze({ type: operation.type });

// Project a provider-verified log into what the screen has to distinguish: the
// initial graph, the accumulated confirmed facts in log order, and the current
// state. Every value here is entailed by the verified log; nothing is inferred
// from the DOM or from anything the user typed.
export function projectHistory(verified) {
  demand(verified !== null && typeof verified === "object", "verified log is required");
  const decisions = verified.decisions;
  demand(Array.isArray(decisions) && decisions.length > 0, "verified log has no Decisions");

  const created = decisions[0];
  const create = created.operations.find(operation => operation.type === "CreateMap");
  demand(create !== undefined, "first Decision must carry CreateMap");

  const entries = decisions.slice(1).map((decision, index) => Object.freeze({
    // ids[0] belongs to the CreateMap Decision, so applied entry n is ids[n+1].
    id: verified.ids[index + 1],
    facts: Object.freeze(decision.operations.map(factOf)),
  }));

  return Object.freeze({
    mapId: verified.mapId,
    head: verified.head,
    stateHash: verified.stateHash,
    initial: Object.freeze({
      regions: regionIdsOf(create.records),
      relations: relationsOf(create.records),
    }),
    entries: Object.freeze(entries),
    regions: regionIdsOf(verified.records),
    relations: relationsOf(verified.records),
  });
}

// Read whatever this origin has stored and decide which of the three outcomes
// holds. An absent key is a first visit and must not be confused with a corrupt
// one: the provider rejects an empty string, so only a genuine `null` from
// storage counts as absent. A stored value that fails verification is reported
// as corrupt and left exactly as it is - never deleted, never overwritten.
export async function restoreHistory({ read, verifyDecisionLog } = {}) {
  demand(typeof read === "function", "read is required");
  demand(typeof verifyDecisionLog === "function", "verifyDecisionLog is required");

  const stored = await read(HISTORY_KEY);
  if (stored === null || stored === undefined) {
    return Object.freeze({ status: RESTORE_EMPTY });
  }

  let verified;
  try {
    verified = await verifyDecisionLog(stored);
  } catch (error) {
    return Object.freeze({ status: RESTORE_CORRUPT, reason: error.message });
  }

  // A log the provider accepts can still be unprojectable, and that is the same
  // class of failure as a broken chain: fail closed rather than mount a graph
  // the history panel cannot describe.
  try {
    return Object.freeze({
      status: RESTORE_RESTORED,
      graph: verified,
      projection: projectHistory(verified),
    });
  } catch (error) {
    return Object.freeze({ status: RESTORE_CORRUPT, reason: error.message });
  }
}

// Write the verified canonical log before the caller binds it in memory or
// renders it. Storage is the authority, so a write that does not land must stop
// the sequence: "displayed but not saved" is unrecoverable and lies, while
// "saved but not displayed" is recoverable by reload and can be labelled.
export async function persistHistory({ write, graph } = {}) {
  demand(typeof write === "function", "write is required");
  demand(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");

  try {
    await write(HISTORY_KEY, graph.log);
  } catch (error) {
    throw new HistoryPersistFailed(error);
  }
  return graph;
}
