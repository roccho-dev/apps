import test from 'node:test';
import assert from 'node:assert/strict';
import { pRecords, pRecordsInComments, P_RECORD_KINDS } from '../collect/precord.mjs';

// P's records (p-record-v1, adrs#647 W c6346498633, R GO c6346515735): one JSON line per record in
// hq:p-records.jsonl, written by P only. Synthetic minimal inputs in the agreed form.
const RUN = '2026-10-22T18:00:00Z';
const base = (kind, id, fields, at = '2026-10-22T17:00:00Z') => ({ schema: 'p-record-v1', id, kind, at, series: 'atlas', ref: 'roccho-dev/adrs#647#c6346417466', ...fields });
const ONE_OF_EACH = [
  base('user.decision.requested', 'p-1', { question: '試験の値', options: ['a', 'b'], recommended: 'a', since: '2026-10-22T16:20:00Z', reask_due: '2026-10-29T16:20:00Z' }),
  base('user.decision.recorded', 'p-2', { request: 'p-1', words: 'atlas go ahead', changes: 'C5 段 1 を採る' }),
  base('p.position', 'p-3', { position: 'self-correction', about: 'c6342376490 の逸脱 1' }),
  base('review.pasted', 'p-4', { reviewer: null, readback: 'roccho-dev/adrs#647#c6335481832' }),
  base('user.criterion', 'p-5', { words: '偽陽性がなく迷わずシンプル', binds: '鍵の選び方' }),
  base('loop.stopped', 'p-6', { role: 'sys1.W', round: 3, next: 'USER', reason: '確認のため', needed: false, action: 'P が再開' }),
  base('p.receipt', 'p-7', { action: 'hq-refresh', target: 'v3', sha256: '1e6dec799ea5dffaa182744e9909e36ce0b06f0b3e375bca2215b941df2a703c', result: 'PASS', reverted: false }),
  base('heartbeat', 'p-8', { run: 'alive', tunnel: 'alive', hq_loop: 'unknown', reaped: 0, rebuilt: 1 }),
];
const file = lines => lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n';
const reasons = result => result.held.map(item => item.reason);

test('the eight kinds are kept as P\'s claims, with the file\'s digest and the line', () => {
  assert.deepEqual(P_RECORD_KINDS, ONE_OF_EACH.map(line => line.kind));
  const result = pRecords(file(ONE_OF_EACH), RUN);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.records.map(record => record.id), ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7', 'p-8']);
  assert.ok(result.records.every((record, index) => record.authority === false && record.source.ref === 'hq:p-records.jsonl'
    && /^sha256:[0-9a-f]{64}$/u.test(record.source.sha256) && record.source.line === index + 1));
  assert.ok(Object.isFrozen(result.records[0]));
});

test('a line dated after this run is held (R c6346515735: the run\'s time, never the copy\'s mtime)', () => {
  const late = base('p.position', 'late', { position: 'claim', about: 'x' }, '2026-10-22T18:00:01Z');
  const edge = base('p.position', 'edge', { position: 'claim', about: 'x' }, RUN);
  const result = pRecords(file([late, edge]), RUN);
  assert.deepEqual(reasons(result), ['p-record: at']);
  assert.deepEqual(result.records.map(record => record.id), ['edge']);
  assert.throws(() => pRecords(file([edge]), 'not a time'), /recordedAt/u);
});

test('fields are closed: a missing or an extra field, a wrong schema or kind, a bad id or value is held', () => {
  const { question, ...noQuestion } = ONE_OF_EACH[0];
  const result = pRecords(file([
    noQuestion,
    { ...ONE_OF_EACH[1], note: 'extra' },
    { ...ONE_OF_EACH[2], schema: 'p-record-v2' },
    { ...ONE_OF_EACH[3], kind: 'user.decision.guessed' },
    { ...ONE_OF_EACH[4], id: 'has space' },
    { ...ONE_OF_EACH[5], needed: 'no' },
    { ...ONE_OF_EACH[6], result: 'OK' },
    { ...ONE_OF_EACH[7], reaped: -1 },
    { ...ONE_OF_EACH[0], id: 'q2', series: 3 },
    '{not json',
  ]), RUN);
  assert.deepEqual(reasons(result), ['fields', 'fields', 'schema', 'kind', 'id', 'value', 'value', 'value', 'value', 'invalid-json'].map(reason => 'p-record: ' + reason));
  assert.deepEqual(result.records, []);
  assert.ok(result.held.every(item => item.kind === 'journal.held' && item.recordedAt === RUN && item.source.ref === 'hq:p-records.jsonl'));
});

test('an id written twice holds both lines; a rewrite is a new id\'s correction', () => {
  const again = { ...ONE_OF_EACH[1], words: 'atlas ok' };
  const correction = base('p.position', 'p-2b', { position: 'correction', about: 'p-2 の言葉を直す' });
  const result = pRecords(file([ONE_OF_EACH[1], again, correction]), RUN);
  assert.deepEqual(reasons(result), ['p-record: duplicate-id', 'p-record: duplicate-id']);
  assert.deepEqual(result.records.map(record => record.id), ['p-2b']);
});

test('the same form in a comment is held, whoever wrote it (R c6346239088: the author cannot tell P)', () => {
  const doc = { repo: 'roccho-dev/adrs', number: 647, commentId: 6346498633,
    text: 'P の記録\n```jsonl\n' + JSON.stringify(ONE_OF_EACH[1]) + '\n```\n{"kind":"work.created","work_id":"x"}\n' };
  const held = pRecordsInComments([doc], RUN);
  assert.deepEqual(held.map(item => [item.reason, item.source.ref, item.source.commentId]), [['p-record: p-record-in-comment', 'roccho-dev/adrs#647', 6346498633]]);
});

test('blank lines and CRLF are read as P wrote them; the line number is the file\'s', () => {
  const result = pRecords('\r\n' + JSON.stringify(ONE_OF_EACH[7]) + '\r\n\r\n', RUN);
  assert.deepEqual(result.records.map(record => record.source.line), [2]);
});
