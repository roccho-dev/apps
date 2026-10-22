import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pRecords, pSeries } from '../collect/precord.mjs';

// P's series list (p-series-v1, hq:p-series.json, P c6349797904; adrs#647 W c6349826755, R c6349841686) as one P record
// `p.series` (entries = its series) on the road of P's records (apps#159, ui#389), and P's replacement `p.supersede`.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const fixture = relative => file('./fixtures/step/' + relative);
const RUN = '2026-10-22T20:00:00Z';
const LIST = { schema: 'p-series-v1', at: '2026-10-22T19:46:58Z', series: [
  { id: 'atlas', canon: 'roccho-dev/adrs#647', goal: 'roccho-dev/adrs#647#c6313788372', R: 'c5a2ea56-b82c-4e41-8d7d-4d019196a602', W: 'ce92f7a1-3905-476a-9177-e7a817138b91', host: 'versapro', state: 'open' },
  { id: 'codex', canon: 'roccho-dev/adrs#666', goal: null, R: 'codex-cli', W: null, host: 'local', state: 'open' },
  { id: 'nixos', canon: 'yksr-melt/Meltype#26', goal: null, R: null, W: null, host: 'local', state: 'waiting' }] };
const text = value => JSON.stringify(value, null, 4);
const reasons = result => result.held.map(item => item.reason);

test('the declaration becomes one p.series record: id p-series@<at>, its series in entries, P\'s claim, from hq:p-series.json', () => {
  const { record, held } = pSeries(text(LIST), RUN);
  assert.deepEqual(held, []);
  assert.equal(record.id, 'p-series@2026-10-22T19:46:58Z');
  assert.deepEqual([record.kind, record.at, record.series, record.ref, record.authority, record.source.ref, record.source.line], ['p.series', LIST.at, null, null, false, 'hq:p-series.json', 1]);
  assert.deepEqual(record.entries, LIST.series);
  // The shape ui#389 reads: the common six, entries, authority and source; nothing else.
  assert.deepEqual(Object.keys(record).sort(), ['at', 'authority', 'entries', 'id', 'kind', 'ref', 'schema', 'series', 'source']);
});

test('anything but the agreed form is held whole (p-series: …), never partly read', () => {
  const held = value => reasons(pSeries(typeof value === 'string' ? value : text(value), RUN));
  assert.deepEqual(held('{not json'), ['p-series: invalid-json']);
  assert.deepEqual(held({ ...LIST, schema: 'p-series-v2' }), ['p-series: schema']);
  assert.deepEqual(held({ ...LIST, note: 'x' }), ['p-series: fields']);
  assert.deepEqual(held({ ...LIST, at: '2026-10-22T20:00:01Z' }), ['p-series: at']);
  assert.deepEqual(held({ ...LIST, series: [{ ...LIST.series[0], token: 'x' }] }), ['p-series: value']);
  assert.deepEqual(held({ ...LIST, series: [LIST.series[0], { ...LIST.series[1], id: 'atlas' }] }), ['p-series: value']);
  assert.deepEqual(held({ ...LIST, series: [{ ...LIST.series[0], canon: 'adrs#647' }] }), ['p-series: value']);
  assert.deepEqual(held({ ...LIST, series: [{ ...LIST.series[0], state: 'paused' }] }), ['p-series: value']);
});

test('p.supersede is a kind of P\'s records: replaces is required, by may be null', () => {
  const line = fields => JSON.stringify({ schema: 'p-record-v1', id: 'p-21', kind: 'p.supersede', at: '2026-10-22T19:47:00Z', series: 'voice', ref: null, ...fields });
  assert.deepEqual(pRecords(line({ replaces: 'p-20261022-006', by: 'p-20261022-020' }) + '\n', RUN).records.map(record => [record.replaces, record.by]), [['p-20261022-006', 'p-20261022-020']]);
  assert.deepEqual(reasons(pRecords(line({ replaces: '', by: null }) + '\n', RUN)), ['p-record: value']);
  assert.deepEqual(reasons(pRecords(line({ replaces: 'x' }) + '\n', RUN)), ['p-record: fields']);
});

// Through the step and run.mjs, on the step fixture.
const loaded = await import('../step.mjs');
const snapshots = readdirSync(fixture('snapshots')).map(name => ({ name, snapshot: JSON.parse(readFileSync(fixture('snapshots/' + name), 'utf8')) }));
const ownerComments = JSON.parse(readFileSync(fixture('owner.comments.json'), 'utf8'));
const reading = Object.freeze({ snapshots: async () => snapshots.map(value => structuredClone(value)),
  owner: async repo => (repo === 'roccho-dev/atlas-owner' ? structuredClone(ownerComments) : null) });
const controlText = readFileSync(fixture('control.jsonl'), 'utf8');
const AT = '2026-10-22T20:00:00Z';
const input = extra => ({ sources: { worklogAuthors: ['P'] }, at: AT, ledgerText: '', controlText, ...extra });
const listsIn = world => world.frames.flatMap(frame => frame.p_records ?? []).filter(item => item.kind === 'p.series');

test('step: the list enters the ledger once; read again it adds nothing; a new declaration (new at) is a new row', async () => {
  const first = await loaded.step(input({ pSeriesText: text(LIST) }), reading);
  assert.deepEqual(first.appended.filter(row => row.event.kind === 'p.record').map(row => row.event.record.id), ['p-series@2026-10-22T19:46:58Z']);
  assert.deepEqual(listsIn(first.world).map(item => item.entries.map(entry => entry.id)), [['atlas', 'codex', 'nixos']]);
  const again = await loaded.step(input({ ledgerText: first.ledgerText, at: '2026-10-22T20:10:00Z', pSeriesText: text(LIST) }), reading);
  assert.equal(again.appended.length, 0);
  const next = { ...LIST, at: '2026-10-22T20:05:00Z', series: [...LIST.series.slice(0, 2), { ...LIST.series[2], state: 'closed' }] };
  const later = await loaded.step(input({ ledgerText: again.ledgerText, at: '2026-10-22T20:20:00Z', pSeriesText: text(next) }), reading);
  assert.deepEqual(later.appended.filter(row => row.event.kind === 'p.record').map(row => row.event.record.id), ['p-series@2026-10-22T20:05:00Z']);
});

test('step: a list that is not the agreed form is held to the World at the step\'s time; no p.series row', async () => {
  const result = await loaded.step(input({ pSeriesText: text({ ...LIST, note: 'x' }) }), reading);
  assert.ok(!result.ledgerText.includes('"p.series"'));
  assert.ok(result.world.frames.flatMap(frame => frame.held ?? []).some(item => item.reason === 'p-series: fields'));
});

test('run.mjs --p-series reads P\'s file whole; without it nothing is read; a missing file is nothing declared', async () => {
  const run = await import('../run.mjs');
  const dir = mkdtempSync(file('./p-series-out-'));
  try {
    const at = name => path.join(dir, name);
    writeFileSync(at('p-series.json'), text(LIST));
    const go = (name, extra) => run.run({ sources: { worklogAuthors: ['P'] }, ledger: at(name + '.ledger.jsonl'), world: at(name + '.world.json'), control: fixture('control.jsonl'), at: AT, ...extra }, reading);
    await go('with', { pSeries: at('p-series.json') });
    await go('without', {});
    await go('missing', { pSeries: at('none.json') });
    const worldOf = name => JSON.parse(readFileSync(at(name + '.world.json'), 'utf8'));
    assert.equal(listsIn(worldOf('with')).length, 1);
    assert.deepEqual(worldOf('missing'), worldOf('without'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
