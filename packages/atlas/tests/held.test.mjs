import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { HELD_REASONS, contractWorld, heldEntries } from '../contract.mjs';
import { joinLog } from '../live.mjs';

// R's HQ readback (apps#132): frames[i].held is the declarations held back, each with a stable reason word.
// A raw parser message carries its line number ("events:3: ideal version v1 already set"), so the same reason
// was counted apart; a work claim the collector held as overwritten (current: / worklog:) is an L2 observation,
// not a declaration, and is not held here.
const zero = 'sha256:' + '0'.repeat(64), src = { ref: 's3:decl', sha256: zero };
const req = value => ({ id: 'A', label: 'A', predicate: { target: { kind: 'state', id: 's.a' }, op: 'equals', value }, maxAge: 'PT24H', norm: 'n.a' });
const T = h => `2026-10-21T0${h}:00:00Z`;
const ideal = (h, version, value) => ({ kind: 'ideal.set', recordedAt: T(h), purpose_id: 'p', purpose_rev: 'r1', version, requires: [req(value)], source: src });
const G = [
  { kind: 'purpose.set', recordedAt: T(1), purpose: { id: 'p', label: 'P' }, rev: 'r1', source: src },
  ideal(1, 'v1', 'ok'),
  { kind: 'observation', recordedAt: T(1), target: 's.a', value: 'ok', source: src, observedAt: T(1) },
  ideal(2, 'v1', 'ok2'), ideal(2, 'v3', 'ok'), ideal(2, 'v3', 'ok3'),
  { kind: 'journal.held', reason: 'current: overwritten', line: '{"kind":"work.created","work_id":"c2"}', source: { ref: 'current:P', sha256: zero }, recordedAt: T(2) },
  { kind: 'journal.held', reason: 'worklog: overwritten', line: '{"kind":"artifact.observed"}', source: { ref: 'o/r#1', sha256: zero }, recordedAt: T(2) },
  { kind: 'observation', recordedAt: T(3), target: 's.a', value: 'ok', source: src, observedAt: T(3) },
].map(value => JSON.stringify(value)).join('\n') + '\n';
const CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';

test('held reasons are stable words without line numbers, and work claims are not held declarations', () => {
  const joined = joinLog('', [G]);
  const held = joined.held.filter(value => value.journal);
  const world = contractWorld(deriveAtlas(joined.log, CONTROL), { held });
  const reasons = world.frames.flatMap(frame => frame.held.map(item => item.reason));
  assert.deepEqual(reasons, ['ideal-version-already-set', 'ideal-version-already-set']);
  assert.ok(reasons.every(reason => HELD_REASONS.includes(reason)), 'every reason is a contract value');
  assert.deepEqual({ count: heldEntries(world.frames, held).count, unplaced: heldEntries(world.frames, held).unplaced }, { count: 2, unplaced: 0 });
});

test('the contract lists every held reason the producer can give', () => {
  for (const reason of ['ideal-version-already-set', 'ideal-purpose-rev-mismatch', 'purpose-not-active', 'purpose-rev-redefined',
    'purpose-rev-already-active', 'evaluation-not-declared', 'recorded-at-backwards', 'invalid-declaration', 'proposal', 'actor-not-authorized',
    'superseded-by-cold', 'worklog-target-in-predicate', 'actor-mismatch', 'author-unknown', 'invalid-json', 'unknown-kind',
    'recordedAt-invalid', 'recordedAt-after-source', 'declaration-unreadable', 'cold: schema'])
    assert.ok(HELD_REASONS.includes(reason), reason);
  assert.ok(HELD_REASONS.every(reason => !/:\d|atlas-events|events:/u.test(reason)), 'no line number or parser prefix');
});
