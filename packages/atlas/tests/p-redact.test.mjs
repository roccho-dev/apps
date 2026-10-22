import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pRecordsAt } from '../contract.mjs';

// A record P replaced leaves the World's data without its text (adrs#647 W c6350841730, R c6350853997), at the run the
// replacement enters the ledger, though the replacement itself waits for the next frame; the ledger keeps every row.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const fixture = relative => file('./fixtures/step/' + relative);
const SECRET = '/work/repos/.auth/x/age/key-file';
const recordOf = (id, kind, fields, at = '2026-10-22T19:43:57Z') => ({ schema: 'p-record-v1', id, kind, at, series: 'voice', ref: null, ...fields });
const event = (record, recordedAt) => ({ kind: 'p.record', recordedAt, declaredAt: record.at, record, source: { ref: 'hq:p-records.jsonl', sha256: 'sha256:' + '0'.repeat(64), line: 1 } });
const ASKED = recordOf('p-6', 'user.decision.requested', { question: 'voice の鍵 ' + SECRET + ' を置く', options: [], recommended: null, since: '2026-10-22T19:00:00Z', reask_due: null });
const REPLACE = recordOf('p-23', 'p.supersede', { replaces: 'p-6', by: 'p-20' }, '2026-10-22T20:33:00Z');
const frames = [{ asOf: '2026-10-22T19:44:37Z' }, { asOf: '2026-10-22T20:00:00Z' }];

test('the replaced record goes out in the closed form only, though the replacement is in no frame yet', () => {
  const { placed, unplaced } = pRecordsAt(frames, [event(ASKED, '2026-10-22T19:44:37Z'), event(REPLACE, '2026-10-22T20:33:29Z')]);
  assert.equal(unplaced, 1, 'the replacement waits for the next frame');
  assert.deepEqual(placed[0], [{ schema: 'p-record-v1', id: 'p-6', kind: 'user.decision.requested', at: '2026-10-22T19:43:57Z', series: 'voice', ref: null,
    authority: false, source: { ref: 'hq:p-records.jsonl', sha256: 'sha256:' + '0'.repeat(64), line: 1 }, superseded_by: 'p-20' }]);
  assert.ok(!JSON.stringify(placed).includes(SECRET));
});

test('a replacement that is itself replaced keeps its effect: the text never comes back', () => {
  const undo = recordOf('p-24', 'p.supersede', { replaces: 'p-23', by: null }, '2026-10-22T20:40:00Z');
  const { placed } = pRecordsAt([...frames, { asOf: '2026-10-22T21:00:00Z' }],
    [event(ASKED, '2026-10-22T19:44:37Z'), event(REPLACE, '2026-10-22T20:33:29Z'), event(undo, '2026-10-22T20:41:00Z')]);
  assert.ok(!JSON.stringify(placed).includes(SECRET));
  assert.equal(placed[0][0].superseded_by, 'p-20');
  // The replacement itself is replaced: it too goes out without its own fields.
  assert.deepEqual(Object.keys(placed[2].find(item => item.id === 'p-23')).sort(), ['at', 'authority', 'id', 'kind', 'ref', 'schema', 'series', 'source', 'superseded_by']);
});

test('a record nobody replaced goes out whole, as before', () => {
  const { placed } = pRecordsAt(frames, [event(ASKED, '2026-10-22T19:44:37Z')]);
  assert.equal(placed[0][0].question, ASKED.question);
  assert.ok(!Object.hasOwn(placed[0][0], 'superseded_by'));
});

// Through the step: the run that ledgers the replacement already sends a World without the text; the ledger keeps it.
const loaded = await import('../step.mjs');
const snapshots = readdirSync(fixture('snapshots')).map(name => ({ name, snapshot: JSON.parse(readFileSync(fixture('snapshots/' + name), 'utf8')) }));
const ownerComments = JSON.parse(readFileSync(fixture('owner.comments.json'), 'utf8'));
const reading = Object.freeze({ snapshots: async () => snapshots.map(value => structuredClone(value)),
  owner: async repo => (repo === 'roccho-dev/atlas-owner' ? structuredClone(ownerComments) : null) });
const controlText = readFileSync(fixture('control.jsonl'), 'utf8');
const input = extra => ({ sources: { worklogAuthors: ['P'] }, at: '2026-10-22T20:00:00Z', ledgerText: '', controlText, ...extra });

test('step: the World of the run that ledgers the replacement has no text; the ledger still has it', async () => {
  const first = await loaded.step(input({ pRecordsText: JSON.stringify(ASKED) + '\n' }), reading);
  assert.ok(JSON.stringify(first.world).includes(SECRET), 'before the replacement the record is whole');
  const second = await loaded.step(input({ ledgerText: first.ledgerText, at: '2026-10-22T20:35:00Z',
    pRecordsText: JSON.stringify(ASKED) + '\n' + JSON.stringify(REPLACE) + '\n' }), reading);
  assert.deepEqual(second.appended.filter(row => row.event.kind === 'p.record').map(row => row.event.record.id), ['p-23']);
  // The step's reading of P's file makes a frame at this run (c6352457408), where the replacement is placed.
  assert.equal(second.world.frames.length, first.world.frames.length + 1);
  assert.ok(!JSON.stringify(second.world).includes(SECRET), 'the text left the World at this run');
  assert.ok(second.ledgerText.includes(SECRET), 'the ledger keeps every row as written');
});
