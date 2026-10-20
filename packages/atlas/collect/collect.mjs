#!/usr/bin/env node
// G transform: normalized records → observation / plan.set JSONL.
// collect() is pure and format-free; the CLI reads the snapshot directory through adapter.mjs. No network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './adapter.mjs';
import { planEvents } from './plan.mjs';
import { journalEvents, declarationEvents } from './journal.mjs';
import { currentEvents, worklogEvents } from './worklog.mjs';
import { observation, prObservations, sessionObservations, portObservations } from './observe.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// `worklogAuthors`: logins allowed to write worklog-v1 lines (declared by P, passed in; absent → all held).
export function collect(records, recordedAt, { worklogAuthors } = {}) {
  return records.flatMap(record => {
    switch (record.kind) {
      case 'thread': return record.documents
        ? [...planEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt),
          ...journalEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt),
          ...worklogEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt, worklogAuthors)]
        // The thread could not be read: UNKNOWN, not "no plan".
        : [observation(`${record.repo}#${record.number}:plan.source`, null, record.source, record.fetchedAt, recordedAt)];
      case 'pr': return prObservations(record, recordedAt);
      case 'sessions': return sessionObservations(record, recordedAt);
      case 'ports': return portObservations(record, recordedAt);
      case 'declaration': return declarationEvents(record, recordedAt);
      case 'fact':
        if (record.availableAt !== undefined && (!Number.isFinite(Date.parse(record.availableAt))
          || !Number.isFinite(Date.parse(recordedAt)) || Date.parse(recordedAt) < Date.parse(record.availableAt)))
          throw new Error('atlas-collect: fact recordedAt must be at or after availableAt');
        return [observation(record.target, record.value, record.source, record.observedAt, recordedAt)];
      // A Cold row the adapter refused: kept with its reason, never a fact or a decision.
      case 'held': return [{ kind: 'journal.held', reason: 'cold: ' + record.reason, line: record.raw_id ?? record.line, source: record.source, recordedAt }];
      default: throw new Error(`atlas-collect: unknown record kind ${JSON.stringify(record.kind)}`);
    }
  });
}

export const toJsonl = events => events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');

export function readRecords(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort(compare)
    .flatMap(name => normalize(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...rest] = process.argv.slice(2);
  const usage = 'usage: collect.mjs <snapshot-dir> [--recorded-at ISO] [--out events.jsonl] [--worklog-author login]... [--current <author>=<path>]...';
  if (!dir) { console.error(usage); process.exit(2); }
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const all = name => rest.flatMap((value, i) => value === name ? [rest[i + 1] ?? ''] : []);
  const worklogAuthors = all('--worklog-author').filter(Boolean);
  // current: each file comes with the author who records it; no default author.
  const current = all('--current').map(pair => /^([^=]+)=(.+)$/u.exec(pair));
  if (current.some(match => !match)) { console.error(`collect: --current <author>=<path> needs both an author and a path\n${usage}`); process.exit(2); }
  // Read time is the claims' time; --recorded-at pins it, so the same files give the same events.
  const readAt = flag('--recorded-at') ?? new Date().toISOString();
  const files = current.map(([, author, file]) => ({ author, text: fs.readFileSync(file, 'utf8') }));
  const records = readRecords(dir);
  // A Git Cold collection is dated by its commit (the latest committedAt), so the same commit gives the same events.
  const committed = records.map(record => record.committedAt).filter(Boolean).sort().at(-1);
  const recordedAt = flag('--recorded-at') ?? committed ?? new Date().toISOString();
  // The read time goes to the current events only; the rest keeps its own time (cold: its commit).
  const output = toJsonl([...collect(records, recordedAt, { worklogAuthors }), ...currentEvents(files, readAt, readAt, worklogAuthors)]);
  const out = flag('--out');
  if (out) fs.writeFileSync(out, output); else process.stdout.write(output);
}
