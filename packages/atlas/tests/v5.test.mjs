import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';
const causeText = cause => [cause.ideal, cause.current].filter(Boolean).join('+') || 'carried'; // v6: both sides, carried when neither

// adrs#647 contract v5: before_ideal, current-unmatchable, and the Agent heading from session observations.
const read = name => readFileSync(new URL('../fixtures/v5/' + name, import.meta.url), 'utf8');
const world = contractWorld(deriveAtlas(read('events.jsonl'), read('control.jsonl')));
const causes = frame => Object.fromEntries((frame.gap.parts ?? []).map(part => [part.condition, causeText(part.cause)]));

test('right after a Purpose change, a match made only of older observations is counted in before_ideal', () => {
  const [f0, f1, f2, f3] = world.frames;
  assert.deepEqual(world.frames.slice(0, 3).map(frame => frame.phase), ['matched', 'matched', 'approximating']);
  // f0: X is satisfied by an observation made at the ideal.set itself: not before it.
  assert.equal(f0.gap.summary.before_ideal, 0);
  // f1: P2 is matched at once, but only by the observation from P1's time.
  // X rests on P1's observation; W is observed at the ideal.set itself, so it is not counted.
  assert.deepEqual(f1.gap.summary, { open: 0, by_cause: {}, conditions: 2, satisfied: 2, before_ideal: 1 });
  assert.equal(f2.gap.summary.before_ideal, 0, 'only satisfied conditions are counted');
  assert.equal(f3.phase, 'approximating');
});

test('an observation that arrived but cannot be compared is current-unmatchable, not current-unobserved', () => {
  const [, , f2, f3] = world.frames;
  assert.deepEqual(causes(f2), { X: 'current-unmatchable', Y: 'ideal-added+current-unobserved' });
  // f3: X arrived with no value (null): it arrived, so it is current-unmatchable (contract v12), not
  // current-unobserved; Y has never been observed: current-unobserved.
  assert.deepEqual(causes(f3), { X: 'current-unmatchable', Y: 'current-unobserved' });
  assert.deepEqual(f3.gap.summary.by_cause, { 'current-unmatchable': 1, 'current-unobserved': 1 });
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

test('one owner of several satisfied conditions: one Agent, no per-condition relation, unique refs (K6b)', () => {
  const f1 = world.frames[1], key = value => JSON.stringify(value.ref);
  assert.deepEqual(f1.entities.filter(value => value.ref.kind === 'agent' && value.ref.id === 'w.x').length, 1);
  // A declared owner of a satisfied condition is no observation role: no relation from w.x at all.
  assert.deepEqual(f1.relations.filter(value => value.from.kind === 'agent' && value.from.id === 'w.x').map(value => value.ref.id), []);
  for (const fixture of ['v5', 'journal', 'gap', 'events']) {
    const at = name => readFileSync(new URL(`../fixtures/${fixture}/${name}`, import.meta.url), 'utf8');
    for (const frame of contractWorld(deriveAtlas(at('events.jsonl'), at('control.jsonl'))).frames) {
      for (const list of [frame.entities, frame.relations])
        assert.equal(new Set(list.map(key)).size, list.length, `${fixture} ${frame.id}: duplicate qualified ref`);
    }
  }
});
