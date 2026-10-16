#!/usr/bin/env node
// G transform: normalized records → observation / plan.set JSONL.
// collect() is pure and format-free; the CLI reads the snapshot directory through adapter.mjs. No network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './adapter.mjs';
import { planEvents } from './plan.mjs';
import { observation, prObservations, sessionObservations, portObservations } from './observe.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function collect(records, recordedAt) {
  return records.flatMap(record => {
    switch (record.kind) {
      case 'thread': return record.documents
        ? planEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt)
        // The thread could not be read: UNKNOWN, not "no plan".
        : [observation(`${record.repo}#${record.number}:plan.source`, null, record.source, record.fetchedAt, recordedAt)];
      case 'pr': return prObservations(record, recordedAt);
      case 'sessions': return sessionObservations(record, recordedAt);
      case 'ports': return portObservations(record, recordedAt);
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
  if (!dir) { console.error('usage: collect.mjs <snapshot-dir> [--recorded-at ISO] [--out events.jsonl]'); process.exit(2); }
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const recordedAt = flag('--recorded-at') ?? new Date().toISOString();
  const output = toJsonl(collect(readRecords(dir), recordedAt));
  const out = flag('--out');
  if (out) fs.writeFileSync(out, output); else process.stdout.write(output);
}
