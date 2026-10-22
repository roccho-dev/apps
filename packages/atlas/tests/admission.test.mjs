import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../collect/adapter.mjs';
import { collect, toJsonl } from '../collect/collect.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';
import { appendEvents } from '../ledger.mjs';

// A3 (apps#120, adrs#647 comment 6265881722): a journal entry shows its source's admission for display only;
// Capture is not admission (adrs#607) and the judgment never reads it. Since v4 (c6335921034, #6・#9;
// the consequence for A1・A3 in c6338759407) a decision comes only from P's declaration (`hq:`), so a Git Cold
// row — a captured comment — is never a decision: it is held as decision-from-comment, admission or not. The
// admission a journal entry still shows is the owner source's `owner-unverified` (C5 stage 1, step.test.mjs).
const CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';
const text = readFileSync(new URL('../collect/fixtures/cold/decisions.jsonl', import.meta.url), 'utf8');
const cold = normalize({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: 'decisions/x.jsonl', committedAt: '2026-10-18T06:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null, text });
const events = collect(cold, '2026-10-18T06:00:00Z');
const DECISION = ['purpose.set', 'ideal.drafting', 'ideal.set', 'purpose.ended'];
// The same decisions as P's declaration file would give them (no capture, no admission).
const declared = list => list.map(event => DECISION.includes(event.kind)
  ? JSON.parse(JSON.stringify({ ...event, source: { ref: 'hq:decl/purpose.jsonl', sha256: event.source.sha256 } })) : event);
const worldOf = list => contractWorld(deriveAtlas(joinLog('', [toJsonl(list)]).log, CONTROL));
const journal = world => world.frames.flatMap(frame => frame.journal).filter(entry => entry.kind !== 'observation');
const heldOf = list => joinLog('', [toJsonl(list)]).held.filter(value => value.journal && DECISION.includes(value.journal.kind)).map(value => [value.journal.kind, value.reason]);

test('a decision in a cold row is held as decision-from-comment, with or without its admission: Capture is not a decision', () => {
  assert.ok(events.some(event => event.source?.admission === 'observed_not_admitted'), 'the cold rows carry their admission');
  assert.deepEqual(heldOf(events), [['purpose.set', 'decision-from-comment'], ['ideal.set', 'decision-from-comment']]);
  const stripped = events.map(event => JSON.parse(JSON.stringify(event.source?.admission ? { ...event, source: { ...event.source, admission: undefined } } : event)));
  assert.deepEqual(heldOf(stripped), heldOf(events), 'the admission changes nothing');
});

test('the same decisions from P\'s declaration are accepted and carry no admission field', () => {
  const entries = journal(worldOf(declared(events)));
  assert.deepEqual(entries.filter(entry => DECISION.includes(entry.kind)).map(entry => entry.kind), ['purpose.set', 'ideal.set']);
  assert.ok(entries.every(entry => !('admission' in entry.source)));
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

test('the judgment does not change: the cold plans with or without admission give the same gap and conditions', () => {
  // The decisions from P's declaration; the plans and observations as cold gave them, with and without admission.
  const withAdmission = declared(events);
  const stripped = withAdmission.map(event => event.source?.admission ? JSON.parse(JSON.stringify({ ...event, source: { ...event.source, admission: undefined } })) : event);
  const a = worldOf(withAdmission), b = worldOf(stripped);
  assert.deepEqual(a.frames.map(frame => [frame.gap, frame.phase, frame.matched_until]), b.frames.map(frame => [frame.gap, frame.phase, frame.matched_until]));
  const derive = list => deriveAtlas(joinLog('', [toJsonl(list)]).log, CONTROL).derived.frames.map(frame => frame.conditions.map(value => value.judgment.state));
  assert.deepEqual(derive(withAdmission), derive(stripped));
});
