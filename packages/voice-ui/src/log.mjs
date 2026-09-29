// The DecisionLog one browser origin keeps for this app: the sole durable
// authority for graph state. Restore, identity, projection and the one write
// all live here. Pure: reading, writing, locking and the provider's
// verification are all passed in, so `web/app.mjs` stays the only holder of
// browser storage and every rule here is provable under `node --test`.
//
// What is stored is the provider's own canonical log string, so restoring is a
// provider verification rather than a bespoke parse.

const HISTORY_KEY = "voice-ui.decision-log.v1";

// This app's identity inside a log: the map namespace its CreateMap names and
// the state schema its meta record declares. Together with the storage key and
// provider verification that is the whole identity - never a content hash, so
// any graph the person made here, whatever it holds, is recognised as ours.
export const MAP_ID = "voice-graph";
export const STATE_SCHEMA = "semantic-map-state/1";

export const RESTORE_NO_LOG = "no-log";
export const RESTORE_RESTORED = "restored";
const RESTORE_CORRUPT = "corrupt";
const RESTORE_FOREIGN = "foreign";

export const COMMIT_COMMITTED = "committed";
const COMMIT_CONFLICT = "conflict";
const COMMIT_REJECTED = "rejected";
const COMMIT_NOT_PERSISTED = "not-persisted";
export const COMMIT_UNVERIFIED = "unverified";

const demand = (condition, reason) => {
  if (!condition) throw new TypeError(`decision log: ${reason}`);
};

const message = error => String(error?.message ?? error);

// Why a provider-verified log is not this app's, or null when it is.
function foreignReason(verified) {
  if (verified.mapId !== MAP_ID) return `stored log is foreign: map ${verified.mapId}, not this app's map ${MAP_ID}`;
  const meta = verified.records.find(record => record?.type === "meta");
  if (meta?.schema !== STATE_SCHEMA) return `stored log is foreign: state schema ${meta?.schema}, not ${STATE_SCHEMA}`;
  return null;
}

const regionIdsOf = records => Object.freeze((records ?? [])
  .filter(record => record?.type === "region" && record.parent !== null)
  .map(record => record.id));

const regionsOf = records => Object.freeze((records ?? [])
  .filter(record => record?.type === "region" && record.parent !== null)
  .map(record => Object.freeze({ id: record.id, label: record.label })));

const relationsOf = records => Object.freeze((records ?? [])
  .filter(record => record?.type === "relation")
  .map(record => Object.freeze({ id: record.id, from: record.from, to: record.to })));

// Where a part has been pinned. A placement changes no region and no relation,
// so without this a Decision that moved something would leave no fact behind.
const layoutOf = records => Object.freeze((records ?? [])
  .filter(record => record?.type === "layout")
  .map(record => Object.freeze({ id: record.regionId, bounds: Object.freeze([...record.bounds]) })));

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

// What one Decision changed, read off the states the provider computes before
// and after it. A removal names only a relation id; the endpoints it had exist
// only in the earlier state, so every change is a difference of two states.
const changesBetween = (before, after, operations) => {
  const previous = keyed(before);
  const next = keyed(after);
  const facts = [
    ...[...previous].filter(([entryKey]) => !next.has(entryKey)).map(([, item]) => Object.freeze({ change: "removed", ...item })),
    ...[...next].filter(([entryKey]) => !previous.has(entryKey)).map(([, item]) => Object.freeze({ change: "added", ...item })),
  ];
  return facts.length > 0
    ? facts
    : operations.map(operation => Object.freeze({ change: "other", kind: operation.type }));
};

// The provider state after each Decision, obtained by verifying each prefix of
// the log. Every prefix of a valid log is itself a valid log.
export async function statesOf(log, verifyDecisionLog) {
  const lines = log.split("\n").slice(0, -1);
  const states = [];
  for (let count = 1; count <= lines.length; count += 1) {
    states.push((await verifyDecisionLog(`${lines.slice(0, count).join("\n")}\n`)).records);
  }
  return states;
}

// The same log cut back to its first `count` Decisions and verified again.
// `floor` is how many Decisions are already saved; a working log never goes
// below it.
export async function truncateLog(graph, { count, floor, verifyDecisionLog }) {
  demand(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  const lines = graph.log.split("\n").slice(0, -1);
  demand(Number.isInteger(count) && count >= 1 && count <= lines.length, "count is outside the log");
  demand(Number.isInteger(floor) && count >= floor, "a working log cannot be cut below what is saved");
  return verifyDecisionLog(`${lines.slice(0, count).join("\n")}\n`);
}

// A provider-verified log as the history has to show it: the initial graph,
// every later Decision's facts in log order, and the current state.
export async function projectHistory(verified, { verifyDecisionLog }) {
  const decisions = verified.decisions;
  demand(Array.isArray(decisions) && decisions.length > 0, "verified log has no Decisions");
  const create = decisions[0].operations.find(operation => operation.type === "CreateMap");
  demand(create !== undefined, "first Decision must carry CreateMap");

  const states = await statesOf(verified.log, verifyDecisionLog);
  demand(states.length === decisions.length, "log prefixes do not match its Decisions");

  return Object.freeze({
    head: verified.head,
    initial: Object.freeze({ regions: regionIdsOf(create.records), relations: relationsOf(create.records) }),
    entries: Object.freeze(decisions.slice(1).map((decision, index) => Object.freeze({
      // ids[0] belongs to the CreateMap Decision, so applied entry n is ids[n+1].
      id: verified.ids[index + 1],
      facts: Object.freeze(changesBetween(states[index], states[index + 1], decision.operations)),
    }))),
    regions: regionIdsOf(verified.records),
    relations: relationsOf(verified.records),
  });
}

// What this origin has stored, as exactly one of four outcomes. An absent key
// is NO_LOG: there is no graph until the person makes one. A value the
// provider rejects is corrupt, and a valid log that is not this app's is
// foreign; both are left exactly as they are - never deleted, never
// overwritten - and neither is ever replaced by a graph of the app's own.
export async function restoreLog({ read, verifyDecisionLog }) {
  const stored = await read(HISTORY_KEY);
  if (stored === null || stored === undefined) return Object.freeze({ status: RESTORE_NO_LOG });

  let verified;
  try {
    verified = await verifyDecisionLog(stored);
  } catch (error) {
    return Object.freeze({ status: RESTORE_CORRUPT, reason: message(error) });
  }
  const foreign = foreignReason(verified);
  if (foreign !== null) return Object.freeze({ status: RESTORE_FOREIGN, reason: foreign });

  // A log the provider accepts can still be unprojectable; that fails closed
  // exactly like a broken chain.
  try {
    return Object.freeze({
      status: RESTORE_RESTORED,
      graph: verified,
      projection: await projectHistory(verified, { verifyDecisionLog }),
    });
  } catch (error) {
    return Object.freeze({ status: RESTORE_CORRUPT, reason: message(error) });
  }
}

// The one durable write. Under the origin-wide lock it succeeds only when
// storage still holds `expected` - the log this page last read or wrote - and
// the new log is a provider-verified, identity-checked strict extension of it.
// The bytes are then written and read back. A conflict or a rejection writes
// nothing; a write that fails is read back too, and is `not-persisted` only
// when storage still holds exactly what it held before. When the bytes in
// storage cannot be vouched for - the write failed and they changed, or they
// read back as something else, or cannot be read - the result is `unverified`,
// and the page must stop speaking for storage. A committed Decision is never
// lost.
export async function commitLog({ graph, expected, read, write, lock, verifyDecisionLog }) {
  demand(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  demand(expected === null || typeof expected === "string", "expected must be null or a string");
  const next = graph.log;
  return lock(HISTORY_KEY, async () => {
    const current = (await read(HISTORY_KEY)) ?? null;
    if (current !== expected) return Object.freeze({ status: COMMIT_CONFLICT });
    if (current !== null && !(next.length > current.length && next.startsWith(current))) {
      return Object.freeze({ status: COMMIT_REJECTED, reason: "the new log does not strictly extend the stored one" });
    }
    try {
      const foreign = foreignReason(await verifyDecisionLog(next));
      if (foreign !== null) return Object.freeze({ status: COMMIT_REJECTED, reason: foreign });
    } catch (error) {
      return Object.freeze({ status: COMMIT_REJECTED, reason: message(error) });
    }
    let failed = null;
    try {
      await write(HISTORY_KEY, next);
    } catch (error) {
      failed = message(error);
    }
    let readBack;
    try {
      readBack = (await read(HISTORY_KEY)) ?? null;
    } catch (error) {
      return Object.freeze({ status: COMMIT_UNVERIFIED, reason: `the stored bytes cannot be read back: ${message(error)}` });
    }
    if (failed !== null) {
      return readBack === current
        ? Object.freeze({ status: COMMIT_NOT_PERSISTED, reason: failed })
        : Object.freeze({ status: COMMIT_UNVERIFIED, reason: `the write failed (${failed}) and storage changed` });
    }
    if (readBack !== next) {
      return Object.freeze({ status: COMMIT_UNVERIFIED, reason: "the stored bytes read back differently" });
    }
    return Object.freeze({ status: COMMIT_COMMITTED, stored: next });
  });
}
