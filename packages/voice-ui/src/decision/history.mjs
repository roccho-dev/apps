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

// The stored log is not the one this page last read or wrote: another tab of
// the same origin has committed since. Writing now would silently discard that
// history, so the write is refused instead.
export class HistoryConflict extends Error {
  constructor() {
    super("decision log was changed elsewhere since this page read it; reload to continue");
    this.name = "HistoryConflict";
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

// A part as the history has to name it: its id, and the label it is shown by.
const regionsOf = records =>
  Object.freeze(
    (records ?? [])
      .filter(record => record?.type === "region" && record.parent !== null)
      .map(record => Object.freeze({ id: record.id, label: record.label })),
  );

const relationsOf = records =>
  Object.freeze(
    (records ?? [])
      .filter(record => record?.type === "relation")
      .map(record => Object.freeze({ id: record.id, from: record.from, to: record.to })),
  );

// What one Decision changed, read off the states the provider itself computes
// before and after it. A removal names only a relation id; the endpoints it had
// exist only in the earlier state, and reading them out of the id string would
// be guessing. So every change is a difference between two provider states.
// Where a part has been pinned. A placement changes no region and no relation,
// so without this a Decision that moved something would leave no fact behind:
// the history would show only an operation name, and it could never be undone.
const layoutOf = records =>
  Object.freeze(
    (records ?? [])
      .filter(record => record?.type === "layout")
      .map(record => Object.freeze({ id: record.regionId, bounds: Object.freeze([...record.bounds]) })),
  );

const keyed = records => new Map([
  ...regionsOf(records).map(region => [`region ${region.id}`, Object.freeze({ kind: "region", ...region })]),
  ...layoutOf(records).map(entry => [
    `layout ${entry.id} ${entry.bounds.join(",")}`,
    Object.freeze({ kind: "layout", id: entry.id, bounds: entry.bounds }),
  ]),
  ...relationsOf(records).map(relation => [
    `relation ${relation.id} ${relation.from} ${relation.to}`,
    Object.freeze({ kind: "relation", ...relation }),
  ]),
]);

const changesBetween = (before, after, operations) => {
  const previous = keyed(before);
  const next = keyed(after);
  const facts = [
    ...[...previous].filter(([key]) => !next.has(key)).map(([, item]) => Object.freeze({ change: "removed", ...item })),
    ...[...next].filter(([key]) => !previous.has(key)).map(([, item]) => Object.freeze({ change: "added", ...item })),
  ];
  // A Decision that moved no region or relation (a layout pin, say) is still
  // reported by its operation types, so the history never under-reports a log.
  return facts.length > 0
    ? facts
    : operations.map(operation => Object.freeze({ change: "other", kind: operation.type }));
};

// The provider state after each Decision, obtained by verifying each prefix of
// the log. Every prefix of a valid log is itself a valid log. Exported because
// a revert of a saved entry is read off the states on either side of it.
export const statesOf = async (log, verifyDecisionLog) => {
  const lines = log.split("\n").slice(0, -1);
  const states = [];
  for (let count = 1; count <= lines.length; count += 1) {
    states.push((await verifyDecisionLog(`${lines.slice(0, count).join("\n")}\n`)).records);
  }
  return states;
};

// The same log cut back to its first `count` Decisions, verified again by the
// provider. This is what the working graph's Undo is: the last unapplied step
// is dropped, and nothing compensating is added. `floor` is the number of
// Decisions already saved, below which a working log may never be cut.
export async function truncateLog(graph, { count, floor, verifyDecisionLog } = {}) {
  demand(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  demand(typeof verifyDecisionLog === "function", "verifyDecisionLog is required");
  const lines = graph.log.split("\n").slice(0, -1);
  demand(Number.isInteger(count) && count >= 1 && count <= lines.length, "count is outside the log");
  demand(Number.isInteger(floor) && count >= floor, "a working log cannot be cut below what is saved");
  return verifyDecisionLog(`${lines.slice(0, count).join("\n")}\n`);
}

// Project a provider-verified log into what the screen has to distinguish: the
// initial graph, the accumulated confirmed facts in log order, and the current
// state. Every value here is entailed by the verified log; nothing is inferred
// from the DOM or from anything the user typed.
export async function projectHistory(verified, { verifyDecisionLog } = {}) {
  demand(verified !== null && typeof verified === "object", "verified log is required");
  demand(typeof verifyDecisionLog === "function", "verifyDecisionLog is required");
  const decisions = verified.decisions;
  demand(Array.isArray(decisions) && decisions.length > 0, "verified log has no Decisions");

  const created = decisions[0];
  const create = created.operations.find(operation => operation.type === "CreateMap");
  demand(create !== undefined, "first Decision must carry CreateMap");

  const states = await statesOf(verified.log, verifyDecisionLog);
  demand(states.length === decisions.length, "log prefixes do not match its Decisions");

  const entries = decisions.slice(1).map((decision, index) => Object.freeze({
    // ids[0] belongs to the CreateMap Decision, so applied entry n is ids[n+1].
    id: verified.ids[index + 1],
    facts: Object.freeze(changesBetween(states[index], states[index + 1], decision.operations)),
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
//
// Verification proves a log is internally consistent, not that it is this
// app's history: any well-formed log for some other map verifies too. So the
// log must also start from `genesis`, the id of the CreateMap Decision the app
// itself begins with. A consistent log that starts anywhere else is foreign and
// fails closed exactly like a broken one, rather than presenting its regions as
// the initial graph and its decisions as confirmed facts.
export async function restoreHistory({ read, verifyDecisionLog, genesis } = {}) {
  demand(typeof read === "function", "read is required");
  demand(typeof verifyDecisionLog === "function", "verifyDecisionLog is required");
  demand(typeof genesis === "string" && genesis.length > 0, "genesis must be a non-empty string");

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

  if (verified.ids?.[0] !== genesis) {
    return Object.freeze({
      status: RESTORE_CORRUPT,
      reason: `stored log starts from ${verified.ids?.[0]}, not this app's genesis ${genesis}`,
    });
  }

  // A log the provider accepts can still be unprojectable, and that is the same
  // class of failure as a broken chain: fail closed rather than mount a graph
  // the history panel cannot describe.
  try {
    return Object.freeze({
      status: RESTORE_RESTORED,
      graph: verified,
      projection: await projectHistory(verified, { verifyDecisionLog }),
    });
  } catch (error) {
    return Object.freeze({ status: RESTORE_CORRUPT, reason: error.message });
  }
}

// Write the verified canonical log before the caller binds it in memory or
// renders it. Storage is the authority, so a write that does not land must stop
// the sequence: "displayed but not saved" is unrecoverable and lies, while
// "saved but not displayed" is recoverable by reload and can be labelled.
//
// When `read` is given, the write only happens if storage still holds
// `expected` - the log this page last read or wrote, or null if it has none.
// Anything else means another tab committed in between, and the write is
// refused rather than overwriting that tab's history.
export async function persistHistory({ write, graph, read, expected = null } = {}) {
  demand(typeof write === "function", "write is required");
  demand(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");

  if (read !== undefined) {
    demand(typeof read === "function", "read must be a function");
    const current = await read(HISTORY_KEY);
    if ((current ?? null) !== expected) throw new HistoryConflict();
  }

  try {
    await write(HISTORY_KEY, graph.log);
  } catch (error) {
    throw new HistoryPersistFailed(error);
  }
  return graph;
}
