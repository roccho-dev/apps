import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../collect/plan.mjs';

// The display delay (User c6351593265: at most 5 minutes; adrs#647 W c6352434256, R c6352457408). The step records
// that the HQ read P's file with a digest, so a run where only P wrote makes a frame and P's record shows; the run
// hq-refresh starts on P's change reads no outside source (--records-only) and the judgment stays the same.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const fixture = relative => file('./fixtures/step/' + relative);
const loaded = await import('../step.mjs');
const snapshots = readdirSync(fixture('snapshots')).map(name => ({ name, snapshot: JSON.parse(readFileSync(fixture('snapshots/' + name), 'utf8')) }));
const ownerComments = JSON.parse(readFileSync(fixture('owner.comments.json'), 'utf8'));
const reading = Object.freeze({ snapshots: async () => snapshots.map(value => structuredClone(value)),
  owner: async repo => (repo === 'roccho-dev/atlas-owner' ? structuredClone(ownerComments) : null) });
// A light run must not read the snapshots: one that tries fails the test.
const light = Object.freeze({ ...reading, snapshots: async () => { throw new Error('a light run read the snapshots'); } });
const controlText = readFileSync(fixture('control.jsonl'), 'utf8');
const AT = '2026-10-23T00:00:00Z', LATER = '2026-10-23T00:03:00Z';
const input = extra => ({ sources: { worklogAuthors: ['P'] }, at: AT, ledgerText: '', controlText, ...extra });
const line = (id, at = '2026-10-22T23:59:00Z') => JSON.stringify({ schema: 'p-record-v1', id, kind: 'p.position', at, series: 'atlas', ref: null, position: 'claim', about: id });
const fileReads = rows => rows.filter(row => row.event.kind === 'observation' && row.event.target.startsWith('hq:p-'));

test('the step records its reading of P\'s file: the digest as value and source sha256, nothing of the text; no file, none', async () => {
  const text = line('p-1') + '\n';
  const result = await loaded.step(input({ pRecordsText: text }), reading);
  assert.deepEqual(fileReads(result.appended).map(row => [row.event.target, row.event.value, row.event.source.ref, row.event.source.sha256, row.event.observedAt]),
    [['hq:p-records.jsonl', sha256(text), 'hq:p-records.jsonl', sha256(text), AT]]);
  assert.deepEqual(fileReads((await loaded.step(input({ pRecordsText: '' }), reading)).appended), []);
  assert.deepEqual(fileReads((await loaded.step(input(), reading)).appended), []);
});

test('a light run where only P wrote: no snapshot read, one frame, the record placed there, earlier frames unchanged', async () => {
  const first = await loaded.step(input({ pRecordsText: line('p-1') + '\n' }), reading);
  const next = await loaded.step(input({ ledgerText: first.ledgerText, at: LATER, pRecordsText: line('p-1') + '\n' + line('p-2', '2026-10-23T00:02:00Z') + '\n', readSources: false }), light);
  assert.equal(next.world.frames.length, first.world.frames.length + 1);
  assert.equal(Date.parse(next.world.frames.at(-1).asOf), Date.parse(LATER));
  assert.deepEqual(next.world.frames.at(-1).p_records.map(item => item.id), ['p-2']);
  assert.deepEqual(next.world.frames.slice(0, -1), first.world.frames);
  // The same file again: no row, no frame.
  const same = await loaded.step(input({ ledgerText: next.ledgerText, at: '2026-10-23T00:04:00Z', pRecordsText: line('p-1') + '\n' + line('p-2', '2026-10-23T00:02:00Z') + '\n', readSources: false }), light);
  assert.deepEqual([same.appended.length, same.world.frames.length], [0, next.world.frames.length]);
});

test('the judgment does not change with a light run: GapA, the conditions and the owner evaluation are the previous frame\'s', async () => {
  const first = await loaded.step(input({ pRecordsText: line('p-1') + '\n' }), reading);
  const next = await loaded.step(input({ ledgerText: first.ledgerText, at: LATER, pRecordsText: line('p-1') + '\n' + line('p-2', '2026-10-23T00:02:00Z') + '\n', readSources: false }), light);
  const [before, after] = [first.world.frames.at(-1), next.world.frames.at(-1)];
  assert.deepEqual({ ...after.adequacy }, { ...before.adequacy });
  assert.ok(before.adequacy.evidence, 'the fixture has an owner evaluation that counts');
  assert.deepEqual((after.gap.parts ?? []).map(part => [part.condition, part.state]), (before.gap.parts ?? []).map(part => [part.condition, part.state]));
  assert.deepEqual([after.phase, after.gap.summary.satisfied, after.gap.summary.conditions], [before.phase, before.gap.summary.satisfied, before.gap.summary.conditions]);
});

test('run.mjs --records-only reads no snapshot and still reads the owner source', async () => {
  const run = await import('../run.mjs');
  const dir = mkdtempSync(file('./p-file-read-out-'));
  try {
    const at = name => path.join(dir, name);
    writeFileSync(at('p-records.jsonl'), line('p-1') + '\n');
    // A light run follows full ones on the HQ (the purpose and the facts are already in the ledger).
    await run.run({ sources: { worklogAuthors: ['P'] }, ledger: at('ledger.jsonl'), world: at('world.json'), control: fixture('control.jsonl'), at: AT }, reading);
    let owner = 0;
    const counting = { ...light, owner: async repo => { owner += 1; return reading.owner(repo); } };
    const receipt = await run.run({ sources: { worklogAuthors: ['P'] }, ledger: at('ledger.jsonl'), world: at('world.json'), control: fixture('control.jsonl'), at: LATER,
      pRecords: at('p-records.jsonl'), recordsOnly: true }, counting);
    assert.equal(owner, 1);
    assert.equal(receipt.status, 'PASS');
    assert.ok(readFileSync(at('ledger.jsonl'), 'utf8').includes('"hq:p-records.jsonl"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
