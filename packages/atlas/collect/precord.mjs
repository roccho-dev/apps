// P's records (p-record-v1, adrs#647 W c6346498633, R c6346515735): one JSON line per record in P's file
// `hq:p-records.jsonl`, which hq-refresh ships whole each run. Pure, no I/O, no verdicts. Every record is P's
// claim (authority false): it never becomes an evaluation, a purpose or an ideal decision (C5, apps#151).
// A line is kept only when its fields are exactly the common six plus its kind's own; anything else, a line
// dated after this run's recordedAt (ledger-core's rule; the copy's mtime is the copy's), or an id written twice
// (both lines) is held with the reason. The same form in a comment is held (`p-record-in-comment`): a comment's
// author cannot tell P from another agent (R c6346239088).
import { sha256 } from './plan.mjs';

export const P_RECORD_SCHEMA = 'p-record-v1';
export const P_RECORD_REF = 'hq:p-records.jsonl';
const COMMON = ['schema', 'id', 'kind', 'at', 'series', 'ref'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/u;
const ID = /^[A-Za-z0-9._:-]+$/u;
const text = v => typeof v === 'string' && v.length > 0;
const orNull = check => v => v === null || check(v);
const iso = v => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));
const count = v => Number.isSafeInteger(v) && v >= 0;
const oneOf = (...values) => v => values.includes(v);
const LIFE = oneOf('alive', 'dead', 'unknown');
// Each kind's own fields and their checks (W c6346498633 §1).
const KINDS = Object.freeze({
  'user.decision.requested': { question: text, options: v => Array.isArray(v) && v.every(text), recommended: orNull(text), since: iso, reask_due: orNull(iso) },
  'user.decision.recorded': { request: orNull(text), words: text, changes: text },
  'p.position': { position: oneOf('claim', 'withdrawal', 'correction', 'self-correction'), about: text },
  'review.pasted': { reviewer: orNull(text), readback: orNull(text) },
  'user.criterion': { words: text, binds: text },
  'loop.stopped': { role: text, round: orNull(count), next: text, reason: text, needed: orNull(v => typeof v === 'boolean'), action: orNull(text) },
  'p.receipt': { action: text, target: text, sha256: orNull(v => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v)), result: oneOf('PASS', 'FAIL'), reverted: v => typeof v === 'boolean' },
  heartbeat: { run: LIFE, tunnel: LIFE, hq_loop: LIFE, reaped: count, rebuilt: count },
});
export const P_RECORD_KINDS = Object.freeze(Object.keys(KINDS));

function check(entry, recordedAt) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.schema !== P_RECORD_SCHEMA) return 'schema';
  if (!Object.hasOwn(KINDS, entry.kind)) return 'kind';
  const own = KINDS[entry.kind], keys = Object.keys(entry), fields = [...COMMON, ...Object.keys(own)];
  if (keys.length !== fields.length || !fields.every(key => keys.includes(key))) return 'fields';
  if (typeof entry.id !== 'string' || !ID.test(entry.id)) return 'id';
  if (!iso(entry.at) || Date.parse(entry.at) > Date.parse(recordedAt)) return 'at';
  if (!orNull(text)(entry.series) || !orNull(text)(entry.ref)) return 'value';
  return Object.entries(own).every(([key, ok]) => ok(entry[key])) ? null : 'value';
}

/**
 * The text of P's file → { records, held }. `recordedAt`: this run's time (the step's), which no record may follow.
 * records: the line's fields, frozen, with `authority: false` and `source {ref, sha256 of the file, line}`.
 * held: `journal.held` with `reason: 'p-record: <why>'` and the line as written.
 */
export function pRecords(fileText, recordedAt, ref = P_RECORD_REF) {
  if (!iso(recordedAt)) throw new Error('p-record: recordedAt must be an ISO UTC time');
  const digest = sha256(fileText);
  const lines = fileText.split(/\r?\n/u).map((line, index) => ({ line: line.trim(), number: index + 1 })).filter(item => item.line);
  const source = number => ({ ref, sha256: digest, line: number });
  const held = (reason, item) => ({ kind: 'journal.held', reason: 'p-record: ' + reason, line: item.line, source: source(item.number), recordedAt });
  const parsed = lines.map(item => {
    let entry;
    try { entry = JSON.parse(item.line); } catch { return { item, reason: 'invalid-json' }; }
    return { item, entry, reason: check(entry, recordedAt) };
  });
  // An id written twice holds both lines: which one P meant cannot be told (a rewrite is a new id's correction).
  const ids = new Map();
  for (const row of parsed) if (!row.reason) ids.set(row.entry.id, (ids.get(row.entry.id) ?? 0) + 1);
  const records = [], heldLines = [];
  for (const row of parsed) {
    const reason = row.reason ?? (ids.get(row.entry.id) > 1 ? 'duplicate-id' : null);
    if (reason) heldLines.push(held(reason, row.item));
    else records.push(Object.freeze({ ...row.entry, authority: false, source: Object.freeze(source(row.item.number)) }));
  }
  return { records, held: heldLines };
}

/** Thread documents [{repo, number, commentId, text, source?}] → the p-record-v1 lines they carry, each held. */
export function pRecordsInComments(documents, recordedAt) {
  return documents.flatMap(doc => doc.text.split(/\r?\n/u).map(line => line.trim()).filter(line => line.startsWith('{')).filter(line => {
    try { return JSON.parse(line)?.schema === P_RECORD_SCHEMA; } catch { return false; }
  }).map(line => ({ kind: 'journal.held', reason: 'p-record: p-record-in-comment', line,
    source: { ref: doc.source?.ref ?? `${doc.repo}#${doc.number}`, sha256: doc.source?.sha256 ?? sha256(doc.text), commentId: doc.commentId }, recordedAt })));
}
