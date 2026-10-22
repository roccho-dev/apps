// 🔁 one collection step (adrs#647 v3 c6329883005; PR 1 c6329938666, R's conditions c6329948739):
// sources → G → verify → ledger append → D → World, with the reading and the storage given by the runtime.
// No file system, process or network here: `read` reads (gh, files, …) and the caller writes what is returned.
// One time `at` is the collection's: G's recordedAt and the ledger's ledgerAt.
// v4 (c6335921034): no G/current; the work log is read only in the adrs#654 form (worklog-v1 sections of comments).
import { normalize } from './collect/adapter.mjs';
import { collect, toJsonl } from './collect/collect-core.mjs';
import { ownerEvents } from './collect/owner.mjs';
import { pRecords, pRecordsInComments, pSeries } from './collect/precord.mjs';
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
// P's records (p-record-v1; adrs#647 c6346827237, R c6346841107): each kept line of P's file is a `p.record` event,
// dated by P's `at` (the fact's time; the ledger's time cuts the frame, as for a declaration). Held lines, and the
// same form found in a comment, go to the World's held at this step's time.
const recordEvent = ({ authority, source, ...record }) => ({ kind: 'p.record', record, source, recordedAt: record.at });
const threadDocuments = records => records.filter(record => record.kind === 'thread')
  .flatMap(record => (record.documents ?? []).map(doc => ({ ...doc, repo: record.repo, number: record.number, source: record.source ? { ...record.source, ...(doc.source ?? {}) } : doc.source })));

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
// The step's own reading of P's files (adrs#647 W c6352434256, R c6352457408): that the HQ read P's file with this
// digest, at this step — the value and the source's sha256 are the digest, nothing of the text. It changes only when
// P's file does, so a run where only P wrote makes one frame, where P's records are then placed (as route:current
// retired, above, is the step's own fact). No file, no observation. No condition reads these targets.
export const P_FILE_TARGETS = Object.freeze({ records: 'hq:p-records.jsonl', series: 'hq:p-series.json' });
const fileRead = (target, text, at) => text === null || text === '' ? []
  : [{ kind: 'observation', target, value: sha256(text), source: { ref: target, sha256: sha256(text) }, observedAt: at, recordedAt: at }];

/**
 * `readSources` false (run.mjs --records-only) reads no outside source (no snapshots): only P's files, the step's own
 * facts and the owner source (C5: an owner evaluation counts only when this step reads it, so it is read as always and
 * the judgment does not change with the kind of run). Facts already in the ledger stay as they were read.
 */
export const step = async ({ sources, at, ledgerText: before = '', controlText = NO_CONTROL, purposeText = '', pRecordsText = null, pSeriesText = null,
  readSources = true }, read) => {
  const authors = sources.worklogAuthors ?? [];
  const authority = parseAuthority(controlText);
  const owners = [...new Map([...authority.values()].filter(value => value.owner).map(value => [`${value.owner.repo} ${value.owner.login}`, value.owner])).values()];
  const owned = [];
  for (const owner of owners) owned.push(ownerEvents(read.owner ? await read.owner(owner.repo) : null, owner, at));
  // The snapshots in the order the CLI reads a snapshot directory (by name), so the same snapshots give the same events.
  const records = readSources ? [...await read.snapshots(sources)].sort(compare).flatMap(({ snapshot }) => normalize(snapshot)) : [];
  const rows = readLedger(before);
  const mine = pRecordsText === null ? { records: [], held: [] } : pRecords(pRecordsText, at);
  // P's series list (p-series-v1) is one more P record (`p.series`, id p-series@<at>): a new declaration is a new row.
  const list = pSeriesText === null || pSeriesText === '' ? { record: null, held: [] } : pSeries(pSeriesText, at);
  const events = [...collect(records, at, { worklogAuthors: authors }), ...owned.flatMap(value => value.events), ...currentRetired(rows, at),
    ...mine.records.map(recordEvent), ...(list.record ? [recordEvent(list.record)] : []),
    ...fileRead(P_FILE_TARGETS.records, pRecordsText, at), ...fileRead(P_FILE_TARGETS.series, pSeriesText, at)];
  const appended = appendEvents(rows, toJsonl(events), at);
  const after = before ? before + appended.appended.map(row => JSON.stringify(row) + '\n').join('') : ledgerText(appended.rows);
  const { log, held, unbound, pRecords: recorded } = joinLog(purposeText, [ledgerEvents(after)], 'supplied',
    { authority, owner: { repos: owners.map(owner => owner.repo), present: owned.flatMap(value => value.present) } });
  const pHeld = [...mine.held, ...list.held, ...pRecordsInComments(threadDocuments(records), at)].map(value => ({ reason: value.reason, journal: value }))
    .concat(appended.held.filter(value => value.reason === 'p-record-rewritten')
      .map(value => ({ reason: value.reason, journal: { kind: 'p.record', recordedAt: at, source: value.event.source } })));
  const world = contractWorld(deriveAtlas(log, controlText), { unbound, held: [...held, ...owned.flatMap(value => value.held), ...pHeld].filter(value => value.journal),
    pRecords: recorded });
  return { ledgerText: after, appended: appended.appended, held: appended.held, world };
};
