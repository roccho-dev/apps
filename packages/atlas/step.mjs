// 🔁 one collection step (adrs#647 v3 c6329883005; PR 1 c6329938666, R's conditions c6329948739):
// sources → G → verify → ledger append → D → World, with the reading and the storage given by the runtime.
// No file system, process or network here: `read` reads (gh, files, …) and the caller writes what is returned.
// One time `at` is the collection's: G's recordedAt and the ledger's ledgerAt.
// v4 (c6335921034): no G/current; the work log is read only in the adrs#654 form (worklog-v1 sections of comments).
import { normalize } from './collect/adapter.mjs';
import { collect, toJsonl } from './collect/collect-core.mjs';
import { ownerEvents } from './collect/owner.mjs';
import { sha256 } from './collect/plan.mjs';
import { appendEvents, ledgerEvents, ledgerText, readLedger } from './ledger-core.mjs';
import { joinLog } from './live-core.mjs';
import { deriveAtlas, parseAuthority } from './events.mjs';
import { contractWorld } from './contract.mjs';

const NO_CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';

// v4 removed G/current (apps#139, #153): claims a ledger holds from `current:<author>#L<n>` can no longer change.
// The step says so once, as a fact about its own reading — `route:current` = `retired` at the first step over such
// a ledger — so a reader can tell from then on that those claims are the last ones of a stopped route (R,
// adrs#647 c6339644103). The ledger adds it once (the same content again is no change); the rows stay as read.
// Its source is the statement itself (`step:route`, the sha256 of its text), not a document read from outside.
const RETIRED_TEXT = 'route:current retired: G/current removed in adrs#647 v4 (c6335921034)';
export const ROUTE_RETIRED = Object.freeze({ target: 'route:current', value: 'retired', ref: 'step:route', sha256: sha256(RETIRED_TEXT) });
const currentRetired = (rows, at) => rows.some(({ event }) => String(event.source?.ref ?? '').startsWith('current:'))
  ? [{ kind: 'observation', target: ROUTE_RETIRED.target, value: ROUTE_RETIRED.value, source: { ref: ROUTE_RETIRED.ref, sha256: ROUTE_RETIRED.sha256 }, observedAt: at, recordedAt: at }]
  : [];
const compare = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * `input`: { sources, at, ledgerText, controlText, purposeText }. `sources` is what to collect (the fetch
 * config, plus `worklogAuthors`); `ledgerText` the ledger so far ('' for none).
 * `read`: { snapshots(sources) → [{ name, snapshot }] (as fetch.mjs writes them), owner(repo) → the owner
 * repo's Issue comments as the REST API returns them, or null when unreadable }. The owner source (C5 stage 1,
 * v4) is each `owner.repo` the control's authority names. Its accepted evaluations are recorded in the ledger
 * once (an unchanged one adds no row), but count only when this step's read accepts them again: one that is
 * gone or unreadable is not counted, whatever the ledger holds.
 * Returns the ledger after the append (it starts with `ledgerText`), the rows appended, the rows the ledger
 * held, and the World. Nothing else (no closure, semantic-scope or plan-projection files).
 */
export const step = async ({ sources, at, ledgerText: before = '', controlText = NO_CONTROL, purposeText = '' }, read) => {
  const authors = sources.worklogAuthors ?? [];
  const authority = parseAuthority(controlText);
  const owners = [...new Map([...authority.values()].filter(value => value.owner).map(value => [`${value.owner.repo} ${value.owner.login}`, value.owner])).values()];
  const owned = [];
  for (const owner of owners) owned.push(ownerEvents(read.owner ? await read.owner(owner.repo) : null, owner, at));
  // The snapshots in the order the CLI reads a snapshot directory (by name), so the same snapshots give the same events.
  const records = [...await read.snapshots(sources)].sort(compare).flatMap(({ snapshot }) => normalize(snapshot));
  const rows = readLedger(before);
  const events = [...collect(records, at, { worklogAuthors: authors }), ...owned.flatMap(value => value.events), ...currentRetired(rows, at)];
  const appended = appendEvents(rows, toJsonl(events), at);
  const after = before ? before + appended.appended.map(row => JSON.stringify(row) + '\n').join('') : ledgerText(appended.rows);
  const { log, held, unbound } = joinLog(purposeText, [ledgerEvents(after)], 'supplied',
    { authority, owner: { repos: owners.map(owner => owner.repo), present: owned.flatMap(value => value.present) } });
  const world = contractWorld(deriveAtlas(log, controlText), { unbound, held: [...held, ...owned.flatMap(value => value.held)].filter(value => value.journal) });
  return { ledgerText: after, appended: appended.appended, held: appended.held, world };
};
