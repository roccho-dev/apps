import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

// adrs#647 contract v6: two-sided causes, and a journal that carries only what is new in each frame.
const read = name => readFileSync(new URL('../fixtures/v6/' + name, import.meta.url), 'utf8');
const world = contractWorld(deriveAtlas(read('events.jsonl'), read('control.jsonl')));
const cause = (frame, id) => frame.gap.parts.find(part => part.condition === id)?.cause;

test("R's false negative: an added condition with no observation shows both sides (ideal-added and current-unobserved)", () => {
  const [, f1] = world.frames;
  assert.deepEqual(cause(f1, 'B'), { ideal: 'ideal-added', current: 'current-unobserved' });
  // The gap row's 未観測 count comes from by_cause: it must not be 0.
  assert.deepEqual(f1.gap.summary.by_cause, { 'ideal-added': 1, 'current-unobserved': 1 });
});

test('carried only when neither side has a reason; a confirmed unmet is the current side', () => {
  const [, , f2, f3] = world.frames;
  assert.deepEqual(cause(f2, 'B'), { ideal: null, current: 'current-confirmed-unmet' });
  assert.deepEqual(cause(f3, 'B'), { ideal: null, current: null });
  assert.deepEqual(f3.gap.summary.by_cause, { carried: 1 });
});

test('journal is the delta of each frame: every record exactly once, in the frame that recorded it', () => {
  assert.deepEqual(world.frames.map(frame => frame.journal.map(entry => entry.kind)),
    [['purpose.set', 'ideal.set', 'observation'], ['ideal.set'], ['observation'], ['observation']]);
  for (const frame of world.frames) assert.ok(frame.journal.every(entry => Date.parse(entry.recordedAt) <= Date.parse(frame.asOf)));
});

// A synthetic log with n frames and k observations per frame; World bytes per (frame × observation).
const sized = (n, k) => {
  const at = i => new Date(Date.UTC(2026, 9, 17) + i * 60_000).toISOString();
  const sha = 'sha256:' + '0'.repeat(64);
  const lines = [{ schema: 'atlas.events/1', authority: false, source_mode: 'synthetic' },
    { kind: 'purpose.set', recordedAt: at(0), purpose: { id: 'p', label: 'P' }, rev: 'r1', source: { ref: 'hq:size', digest: sha } },
    { kind: 'ideal.set', recordedAt: at(0), purpose_id: 'p', purpose_rev: 'r1', version: 'v1', source: { ref: 'hq:size', digest: sha },
      requires: [{ id: 'A', label: 'A', predicate: { target: { kind: 'state', id: 's.0' }, op: 'equals', value: 'ok' }, maxAge: 'P30D', norm: 'n' }] }];
  for (let i = 0; i < n; i += 1) for (let j = 0; j < k; j += 1)
    lines.push({ kind: 'observation', recordedAt: at(i), target: { kind: 'state', id: `s.${j}` }, value: 'ok', source: 'synthetic:size', observedAt: at(i) });
  const text = lines.map(value => JSON.stringify(value)).join('\n') + '\n';
  const out = contractWorld(deriveAtlas(text, '{"schema":"atlas.control-norms/1","authority":false}\n'));
  return { frames: out.frames.length, journal: out.frames.reduce((sum, frame) => sum + frame.journal.length, 0), bytes: JSON.stringify(out).length };
};

test('World size grows about linearly with frames and observations, not with their square', () => {
  const small = sized(10, 10), frames4 = sized(40, 10), obs4 = sized(10, 40);
  // Each observation is in exactly one frame's journal.
  assert.deepEqual([small.journal, frames4.journal, obs4.journal], [10 * 10 + 2, 40 * 10 + 2, 10 * 40 + 2]);
  // ×4 frames or ×4 observations per frame: about ×4 at most (a square would be ×16).
  for (const [name, bigger] of [['frames', frames4], ['observations', obs4]]) {
    const ratio = bigger.bytes / small.bytes;
    assert.ok(ratio <= 4.4, `${name} ×4 → World ×${ratio.toFixed(2)}`);
  }
});
