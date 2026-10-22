import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// P's records through the step (adrs#647 W c6346827237, R c6346841107; PR B after ui#387): the records of P's file
// enter the ledger once each, as `p.record` (P's time kept as declaredAt, the ledger's time cuts the frame), and
// each frame's p_records holds those that entered at it; held lines go to the frame's held. Without the file,
// nothing changes (no p_records field at all, so an older ui still reads the World).
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const fixture = relative => file('./fixtures/step/' + relative);
const loaded = await import('../step.mjs').catch(error => ({ error }));
const need = module => assert.ok(!module.error, String(module.error?.message ?? ''));
const snapshots = readdirSync(fixture('snapshots')).map(name => ({ name, snapshot: JSON.parse(readFileSync(fixture('snapshots/' + name), 'utf8')) }));
const ownerComments = JSON.parse(readFileSync(fixture('owner.comments.json'), 'utf8'));
const reading = (extraComment = null) => Object.freeze({
  snapshots: async () => snapshots.map(value => {
    const copy = structuredClone(value);
    if (extraComment && copy.name === 'issue-roccho-dev-adrs-647.json') {
      const data = copy.snapshot.responses.comments.data;
      (Array.isArray(data[0]) ? data[0] : data).push(extraComment);
    }
    return copy;
  }),
  owner: async repo => (repo === 'roccho-dev/atlas-owner' ? structuredClone(ownerComments) : null) });
const controlText = readFileSync(fixture('control.jsonl'), 'utf8');
const AT = '2026-10-21T03:00:00Z', LATER = '2026-10-21T03:10:00Z';
const input = extra => ({ sources: { worklogAuthors: ['P'] }, at: AT, ledgerText: '', controlText, ...extra });

const record = (id, kind, fields, at = '2026-10-21T02:50:00Z') => JSON.stringify({ schema: 'p-record-v1', id, kind, at, series: 'atlas', ref: 'roccho-dev/adrs#647', ...fields });
const ASKED = record('p-1', 'user.decision.requested', { question: '試験の値', options: [], recommended: null, since: '2026-10-21T02:00:00Z', reask_due: null });
const RECEIPT = record('p-2', 'p.receipt', { action: 'hq-refresh', target: 'v3', sha256: null, result: 'PASS', reverted: false });
const BAD = JSON.stringify({ schema: 'p-record-v1', id: 'p-3', kind: 'p.position', at: '2026-10-21T02:50:00Z', series: null, ref: null, position: 'claim' });
const records = world => world.frames.flatMap(frame => frame.p_records ?? []);
const held = world => world.frames.flatMap(frame => frame.held ?? []).map(item => item.reason);

test('without P\'s file nothing changes: no p.record row, no p_records field', async () => {
  need(loaded);
  const before = await loaded.step(input(), reading());
  assert.ok(!before.ledgerText.includes('"p.record"'));
  assert.ok(before.world.frames.every(frame => !Object.hasOwn(frame, 'p_records')));
});

test('the records enter the ledger once each and the frame at the step carries them, as ui#387 reads them', async () => {
  need(loaded);
  const result = await loaded.step(input({ pRecordsText: [ASKED, RECEIPT, BAD].join('\n') + '\n' }), reading());
  const rows = result.appended.filter(row => row.event.kind === 'p.record');
  assert.deepEqual(rows.map(row => row.event.record.id), ['p-1', 'p-2']);
  // P's time is the fact's, the ledger's time cuts the frame (R c6346841107 note 1).
  assert.ok(rows.every(row => row.ledgerAt === AT && row.event.recordedAt === '2026-10-21T02:50:00Z'));
  const frame = result.world.frames.at(-1);
  assert.deepEqual(frame.p_records.map(item => [item.id, item.kind, item.at, item.authority, item.source.ref, item.source.line]),
    [['p-1', 'user.decision.requested', '2026-10-21T02:50:00Z', false, 'hq:p-records.jsonl', 1], ['p-2', 'p.receipt', '2026-10-21T02:50:00Z', false, 'hq:p-records.jsonl', 2]]);
  // The shape ui#387 accepts: the record's own fields, authority false and source {ref, sha256, line}, nothing else.
  assert.deepEqual(Object.keys(frame.p_records[1]).sort(), ['action', 'at', 'authority', 'id', 'kind', 'ref', 'result', 'reverted', 'schema', 'series', 'sha256', 'source', 'target'].sort());
  assert.deepEqual(Object.keys(frame.p_records[1].source).sort(), ['line', 'ref', 'sha256']);
  assert.ok(result.world.frames.slice(0, -1).every(item => !Object.hasOwn(item, 'p_records')), 'only the frame they entered at');
  assert.ok(held(result.world).includes('p-record: fields'), held(result.world).join(' '));
});

test('read again (P added a line, the file\'s sha256 moved): only the new record is added; no past frame changes', async () => {
  need(loaded);
  const first = await loaded.step(input({ pRecordsText: ASKED + '\n' }), reading());
  const again = await loaded.step(input({ ledgerText: first.ledgerText, at: LATER, pRecordsText: ASKED + '\n' + RECEIPT + '\n' }), reading());
  assert.deepEqual(again.appended.filter(row => row.event.kind === 'p.record').map(row => row.event.record.id), ['p-2']);
  // The step's own reading of P's file (its digest moved) is a fact D reads, so this run makes one frame and p-2 is
  // placed there (adrs#647 W c6352434256, R c6352457408: reversed from "waits for the next frame"); earlier frames
  // are as they were.
  assert.equal(again.world.frames.length, first.world.frames.length + 1);
  assert.deepEqual(again.world.frames.at(-1).p_records.map(item => item.id), ['p-2']);
  assert.deepEqual(again.world.frames.slice(0, first.world.frames.length), first.world.frames);
  const same = await loaded.step(input({ ledgerText: again.ledgerText, at: '2026-10-21T03:20:00Z', pRecordsText: ASKED + '\n' + RECEIPT + '\n' }), reading());
  assert.equal(same.appended.length, 0, 'the same file again adds nothing');
});

test('a record that entered after the last frame is placed in the first frame at or after it, never before', async () => {
  need(loaded);
  const { contractWorld } = await import('../contract.mjs');
  const frames = [{ asOf: '2026-10-21T03:00:00Z' }, { asOf: '2026-10-21T03:30:00Z' }];
  const { pRecordsAt } = await import('../contract.mjs');
  assert.equal(typeof pRecordsAt, 'function');
  const event = (id, recordedAt) => ({ kind: 'p.record', recordedAt, declaredAt: '2026-10-21T02:50:00Z',
    record: JSON.parse(record(id, 'p.position', { position: 'claim', about: 'x' })), source: { ref: 'hq:p-records.jsonl', sha256: 'sha256:' + '0'.repeat(64), line: 1 } });
  const { placed, unplaced } = pRecordsAt(frames, [event('a', '2026-10-21T03:00:00Z'), event('b', '2026-10-21T03:10:00Z'), event('c', '2026-10-21T03:40:00Z')]);
  assert.deepEqual(placed.map(list => list.map(item => item.id)), [['a'], ['b']]);
  assert.equal(unplaced, 1);
  assert.equal(typeof contractWorld, 'function');
});

test('the same id with other content later is held as p-record-rewritten; the ledger keeps what P wrote first', async () => {
  need(loaded);
  const first = await loaded.step(input({ pRecordsText: ASKED + '\n' }), reading());
  const rewritten = ASKED.replace('試験の値', '別の問い');
  const again = await loaded.step(input({ ledgerText: first.ledgerText, at: LATER, pRecordsText: rewritten + '\n' }), reading());
  // No p.record row (the file's digest moved, so the step's reading of it is a row: c6352457408).
  assert.deepEqual(again.appended.filter(row => row.event.kind === 'p.record'), []);
  // (the fixture's cold rows are held by G at every step; only P's records are looked at here)
  assert.deepEqual(again.held.filter(item => item.event?.kind === 'p.record').map(item => item.reason), ['p-record-rewritten']);
  assert.deepEqual(records(again.world).map(item => item.question), ['試験の値']);
});

test('run.mjs --p-records reads P\'s file whole; without it nothing is read; a missing file is read as empty', async () => {
  const run = await import('../run.mjs').catch(error => ({ error }));
  need(run);
  const dir = mkdtempSync(file('./p-record-out-'));
  try {
    const at = name => path.join(dir, name);
    writeFileSync(at('p-records.jsonl'), ASKED + '\n');
    const go = (name, extra) => run.run({ sources: { worklogAuthors: ['P'] }, ledger: at(name + '.ledger.jsonl'), world: at(name + '.world.json'), control: fixture('control.jsonl'), at: AT, ...extra }, reading());
    await go('with', { pRecords: at('p-records.jsonl') });
    await go('without', {});
    await go('missing', { pRecords: at('none.jsonl') });
    const worldOf = name => JSON.parse(readFileSync(at(name + '.world.json'), 'utf8'));
    assert.deepEqual(records(worldOf('with')).map(item => item.id), ['p-1']);
    assert.deepEqual([records(worldOf('without')), records(worldOf('missing'))], [[], []]);
    assert.deepEqual(worldOf('missing'), worldOf('without'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a p-record line in a comment is held (p-record-in-comment), whoever wrote it; it never becomes a record', async () => {
  need(loaded);
  const comment = { id: 9900001, updated_at: '2026-10-21T02:40:00Z', user: { login: 'roccho-dev' }, body: 'P の記録\n```jsonl\n' + RECEIPT + '\n```\n' };
  const result = await loaded.step(input(), reading(comment));
  assert.deepEqual(records(result.world), []);
  assert.ok(held(result.world).includes('p-record: p-record-in-comment'), held(result.world).join(' '));
});
