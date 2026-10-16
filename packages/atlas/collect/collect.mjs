#!/usr/bin/env node
// G transform: snapshot files (written by fetch.mjs) → observation / plan.set JSONL.
// collect() is pure; the CLI only reads the snapshot directory and writes JSONL. No network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNKNOWN, planEvents } from './plan.mjs';
import { prObservations, sessionObservations, portObservations } from './observe.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// `gh api --paginate --slurp` yields one array per page.
const flat = data => Array.isArray(data) && data.every(Array.isArray) ? data.flat() : data;

function documents(snapshot) {
  const issue = snapshot.responses?.issue?.data, comments = flat(snapshot.responses?.comments?.data);
  if (!issue || !Array.isArray(comments)) return null;
  const base = { repo: snapshot.repo, number: snapshot.number };
  return [
    { ...base, commentId: null, updatedAt: issue.updated_at, text: issue.body ?? '' },
    ...comments.map(comment => ({ ...base, commentId: comment.id, updatedAt: comment.updated_at, text: comment.body ?? '' })),
  ];
}

export function collect(snapshots, recordedAt) {
  const events = [];
  for (const snapshot of snapshots) {
    switch (snapshot.type) {
      case 'issue':
      case 'pr': {
        if (snapshot.type === 'pr') {
          const response = snapshot.responses?.pr ?? {};
          events.push(...prObservations({ repo: snapshot.repo, number: snapshot.number, fetchedAt: snapshot.fetchedAt,
            sha256: response.sha256 ?? UNKNOWN, pr: response.data?.data?.repository?.pullRequest ?? null }, recordedAt));
        }
        const docs = documents(snapshot);
        if (docs) events.push(...planEvents(docs, recordedAt));
        else events.push({ kind: 'observation', target: `${snapshot.repo}#${snapshot.number}:plan.source`, value: UNKNOWN,
          source: { ref: `gh api issues ${snapshot.repo}#${snapshot.number}`, sha256: snapshot.responses?.issue?.sha256 ?? UNKNOWN },
          observedAt: snapshot.fetchedAt, recordedAt });
        break;
      }
      case 'sessions': events.push(...sessionObservations(snapshot, recordedAt)); break;
      case 'ports': events.push(...portObservations(snapshot, recordedAt)); break;
      default: throw new Error(`atlas-collect: unknown snapshot type ${JSON.stringify(snapshot.type)}`);
    }
  }
  return events;
}

export const toJsonl = events => events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');

export function readSnapshots(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort(compare)
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) { console.error('usage: collect.mjs <snapshot-dir> [--recorded-at ISO] [--out events.jsonl]'); process.exit(2); }
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const recordedAt = flag('--recorded-at') ?? new Date().toISOString();
  const output = toJsonl(collect(readSnapshots(dir), recordedAt));
  const out = flag('--out');
  if (out) fs.writeFileSync(out, output); else process.stdout.write(output);
}
