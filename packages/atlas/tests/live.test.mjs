import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveFrames, parseEvents, parseControl } from '../events.mjs';
import { fromG } from '../live.mjs';

const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const run = (script, args) => execFileSync(process.execPath, [file(script), ...args], { encoding: 'utf8' });
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));

test('end to end: G fixture snapshots → G events → live.mjs → D → World', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-live-'));
  const gEvents = path.join(dir, 'g-events.jsonl');
  run('../collect/collect.mjs', [file('../collect/fixtures/snapshots'), '--recorded-at', '2026-10-16T20:40:00Z', '--out', gEvents]);
  const receipt = JSON.parse(run('../live.mjs', ['--out-dir=' + dir, '--purpose=' + file('../fixtures/live/purpose.jsonl'), gEvents]));
  assert.equal(receipt.status, 'PASS');
  const world = JSON.parse(readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.equal(world.kind, 'ui.atlasWorldInput.v1');
  assert.deepEqual(world.frames.map(frame => frame.asOf), ['2026-10-16T03:00:00.000Z', '2026-10-16T20:40:00.000Z']);
  // States come from D on exact G targets only.
  const derived = deriveFrames(parseEvents(readFileSync(path.join(dir, 'events.jsonl'), 'utf8')), parseControl(readFileSync(path.join(dir, 'control.jsonl'), 'utf8')));
  const states = Object.fromEntries(derived.frames.at(-1).conditions.map(value => [value.id, [value.judgment.state, value.judgment.reason]]));
  assert.deepEqual(states, {
    merged: ['satisfied', 'observed'],
    'adrs-ci': ['unknown', 'unmatchable'], // G's literal UNKNOWN is never a value to compare
    'reviewer-running': ['satisfied', 'observed'],
    'worker-running': ['unmet', 'observed'], // waiting only means a past transcript exists
    'ui-serving': ['unknown', 'stale'],
    lookalike: ['unknown', 'no-observation'], // 'apps#92' is not 'apps#92:pr.state'
  });
  // No control: no Norm, so every condition is unassigned rather than guessed from names.
  assert.ok(derived.frames.at(-1).conditions.every(value => value.responsibility.state === 'unassigned'));
  assert.equal(world.frames.at(-1).entities.filter(value => value.ref.kind === 'unassigned-change').length, 6);
  // G plan.set has no purposeRef: held verbatim for the next stage; D's plan field stays UNKNOWN, not empty.
  const gPlans = rows(readFileSync(gEvents, 'utf8')).filter(event => event.kind === 'plan.set');
  assert.deepEqual(rows(readFileSync(path.join(dir, 'g-plans.jsonl'), 'utf8')), gPlans);
  assert.equal(receipt.held_plans.count, 2);
  const plans = JSON.parse(readFileSync(path.join(dir, 'plan-projection.json'), 'utf8'));
  assert.ok(plans.frames.every(frame => frame.status === 'unknown' && frame.plans === null));
});

test('fromG keeps targets opaque and fails closed on unknown shapes', () => {
  const event = { kind: 'observation', target: 'x#1:pr.state', value: 'OPEN', source: { ref: 'gh', sha256: 'sha256:' + '0'.repeat(64) },
    observedAt: '2026-10-16T00:00:00Z', recordedAt: '2026-10-16T00:00:00Z' };
  assert.deepEqual(fromG(event).event.target, { kind: 'state', id: 'x#1:pr.state' });
  assert.deepEqual(fromG({ ...event, value: 'UNKNOWN' }).event.value, { G: 'UNKNOWN' });
  assert.throws(() => fromG({ ...event, extra: 1 }), /unsupported G event/u);
  assert.throws(() => fromG({ kind: 'purpose.set' }), /unsupported G event/u);
});
