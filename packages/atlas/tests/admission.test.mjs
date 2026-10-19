import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../collect/adapter.mjs';
import { collect, toJsonl } from '../collect/collect.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';
import { appendEvents } from '../ledger.mjs';

// A3 (apps#120, adrs#647 comment 6265881722): a journal entry shows its source's admission (observed_not_admitted)
// for display only. Capture is not admission (adrs#607); the judgment never reads it.
const CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';
const text = readFileSync(new URL('../collect/fixtures/cold/decisions.jsonl', import.meta.url), 'utf8');
const cold = normalize({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: 'decisions/x.jsonl', committedAt: '2026-10-18T06:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null, text });
const events = collect(cold, '2026-10-18T06:00:00Z');
const worldOf = list => contractWorld(deriveAtlas(joinLog('', [toJsonl(list)]).log, CONTROL));
const journal = world => world.frames.flatMap(frame => frame.journal).filter(entry => entry.kind !== 'observation');

test('a journal entry from a cold row carries its admission: observed_not_admitted', () => {
  const entries = journal(worldOf(events));
  assert.deepEqual(entries.map(entry => [entry.kind, entry.source.admission]), [['purpose.set', 'observed_not_admitted'], ['ideal.set', 'observed_not_admitted']]);
});

test('a source without an admission (hot, a declaration file) has no admission field', () => {
  const hot = events.map(event => event.source?.admission ? { ...event, source: { ...event.source, admission: undefined, capture: undefined } } : event)
    .map(event => JSON.parse(JSON.stringify(event)));
  assert.ok(journal(worldOf(hot)).every(entry => !('admission' in entry.source)));
});

// A3b (R): admission is for journal display only. Cold rows already in the ledger before A3 (without admission),
// read again after A3, are no change: nothing is appended (no plan update at a time when nothing happened).
test('cold rows in the ledger from before A3, read again, append nothing', () => {
  const before = events.map(event => JSON.parse(JSON.stringify({ ...event, source: Array.isArray(event.source) ? event.source : { ...event.source, admission: undefined } })));
  assert.ok(before.some(event => event.kind === 'plan.set') && !JSON.stringify(before).includes('"admission"'));
  const first = appendEvents([], toJsonl(before), '2026-10-18T07:00:00Z');
  const again = appendEvents(first.rows, toJsonl(events), '2026-10-19T07:00:00Z');
  assert.deepEqual(again.appended.map(row => row.event.kind), []);
});

test('the judgment does not change: the same input with or without admission gives the same gap and conditions', () => {
  const stripped = events.map(event => event.source?.admission ? JSON.parse(JSON.stringify({ ...event, source: { ...event.source, admission: undefined } })) : event);
  assert.ok(events.some(event => event.source?.admission), 'the input carries admission');
  const a = worldOf(events), b = worldOf(stripped);
  assert.deepEqual(a.frames.map(frame => [frame.gap, frame.phase, frame.matched_until]), b.frames.map(frame => [frame.gap, frame.phase, frame.matched_until]));
  const derive = list => deriveAtlas(joinLog('', [toJsonl(list)]).log, CONTROL).derived.frames.map(frame => frame.conditions.map(value => value.judgment.state));
  assert.deepEqual(derive(events), derive(stripped));
});
