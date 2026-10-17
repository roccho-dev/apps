import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

// adrs#647 contract v5: before_ideal, current-unmatchable, and the Agent heading from session observations.
const read = name => readFileSync(new URL('../fixtures/v5/' + name, import.meta.url), 'utf8');
const world = contractWorld(deriveAtlas(read('events.jsonl'), read('control.jsonl')));
const causes = frame => Object.fromEntries((frame.gap.parts ?? []).map(part => [part.condition, part.cause.join('+')]));

test('right after a Purpose change, a match made only of older observations is counted in before_ideal', () => {
  const [f0, f1, f2, f3] = world.frames;
  assert.deepEqual(world.frames.slice(0, 3).map(frame => frame.phase), ['matched', 'matched', 'approximating']);
  // f0: X is satisfied by an observation made at the ideal.set itself: not before it.
  assert.equal(f0.gap.summary.before_ideal, 0);
  // f1: P2 is matched at once, but only by the observation from P1's time.
  assert.deepEqual(f1.gap.summary, { open: 0, by_cause: {}, conditions: 1, satisfied: 1, before_ideal: 1 });
  assert.equal(f2.gap.summary.before_ideal, 0, 'only satisfied conditions are counted');
  assert.equal(f3.phase, 'approximating');
});

test('an observation that arrived but cannot be compared is current-unmatchable, not current-unobserved', () => {
  const [, , f2, f3] = world.frames;
  assert.deepEqual(causes(f2), { X: 'current-unmatchable', Y: 'ideal-added' });
  // f3: X obtained no value (null) and Y has never been observed: both are current-unobserved.
  assert.deepEqual(causes(f3), { X: 'current-unobserved', Y: 'current-unobserved' });
  assert.deepEqual(f3.gap.summary.by_cause, { 'current-unobserved': 2 });
});

test('the Agent heading follows session observations of declared owners, even when their condition is no Scope', () => {
  assert.equal(world.presentation.areas[2].label, 'Agent：宣言された担当（合成・一部観測）');
  const agent = frame => frame.entities.find(value => value.ref.kind === 'agent' && value.ref.id === 'w.x');
  // f1: X is satisfied (no Scope), yet w.x is its declared owner and its session is observed.
  assert.equal(world.frames[1].gap.parts.length, 0);
  assert.deepEqual(agent(world.frames[1]).flags, ['synthetic', 'declared', 'session-observed']);
  assert.match(agent(world.frames[1]).label, /^w\.x\n担当$/u);
  assert.equal(agent(world.frames[0]), undefined, 'P1 declares no owner for X');
});
