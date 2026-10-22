// 🔁 one collection step (adrs#647 v3 c6329883005; PR 1 c6329938666, R's conditions c6329948739):
// sources → G → verify → ledger append → D → World, with the reading and the storage given by the runtime.
// No file system, process or network here: `read` reads (gh, files, …) and the caller writes what is returned.
// One time `at` is the collection's: G's recordedAt and the ledger's ledgerAt.
// v4 (c6335921034): no G/current; the work log is read only in the adrs#654 form (worklog-v1 sections of comments).
import { normalize } from './collect/adapter.mjs';
import { collect, toJsonl } from './collect/collect-core.mjs';
import { appendEvents, ledgerEvents, ledgerText, readLedger } from './ledger-core.mjs';
import { joinLog } from './live-core.mjs';
import { deriveAtlas, parseAuthority } from './events.mjs';
import { contractWorld } from './contract.mjs';

const NO_CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';
const compare = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * `input`: { sources, at, ledgerText, controlText, purposeText }. `sources` is what to collect (the fetch
 * config, plus `worklogAuthors`); `ledgerText` the ledger so far ('' for none).
 * `read`: { snapshots(sources) → [{ name, snapshot }] (as fetch.mjs writes them) }.
 * Returns the ledger after the append (it starts with `ledgerText`), the rows appended, the rows the ledger
 * held, and the World. Nothing else (no closure, semantic-scope or plan-projection files).
 */
export const step = async ({ sources, at, ledgerText: before = '', controlText = NO_CONTROL, purposeText = '' }, read) => {
  const authors = sources.worklogAuthors ?? [];
  // The snapshots in the order the CLI reads a snapshot directory (by name), so the same snapshots give the same events.
  const records = [...await read.snapshots(sources)].sort(compare).flatMap(({ snapshot }) => normalize(snapshot));
  const events = collect(records, at, { worklogAuthors: authors });
  const rows = readLedger(before);
  const appended = appendEvents(rows, toJsonl(events), at);
  const after = before ? before + appended.appended.map(row => JSON.stringify(row) + '\n').join('') : ledgerText(appended.rows);
  const { log, held, unbound } = joinLog(purposeText, [ledgerEvents(after)], 'supplied', { authority: parseAuthority(controlText) });
  const world = contractWorld(deriveAtlas(log, controlText), { unbound, held: held.filter(value => value.journal) });
  return { ledgerText: after, appended: appended.appended, held: appended.held, world };
};
