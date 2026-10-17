import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld, gapOf } from '../contract.mjs';

const read = name => readFileSync(new URL('../fixtures/gap/' + name, import.meta.url), 'utf8');
const EVENTS = read('events.jsonl'), CONTROL = read('control.jsonl');
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';
const build = (events = EVENTS) => contractWorld(deriveAtlas(events, CONTROL));
const t = hour => `t@2026-10-17T0${hour}:00:00.000Z`;
// condition → [state, causes, since, scope]
const open = frame => Object.fromEntries(frame.gap.parts.map(part => [part.condition, [part.state, part.cause.join('+'), part.since, part.scope]]));
const closed = frame => frame.gap.closed.map(value => [value.condition, value.by, value.at]);

test('gap by cause, frame by frame, against the previous frame by id only', () => {
  const frames = build().frames;
  assert.deepEqual(frames.map(frame => frame.id), [0, 1, 2, 3, 4, 5].map(t));
  assert.deepEqual(frames.map(frame => frame.gap.basis.prev_frame), [null, ...[0, 1, 2, 3, 4].map(t)]);
  assert.deepEqual(frames.map(frame => [frame.gap.basis.purpose_id, frame.gap.basis.ideal_version]),
    [['purpose.p1', 'v1'], ['purpose.p1', 'v2'], ['purpose.p1', 'v2'], ['purpose.p1', 'v2'], ['purpose.p2', 'v3'], ['purpose.p2', 'v3']]);
  // t0: current = ideal. No open difference.
  assert.deepEqual([open(frames[0]), closed(frames[0]), frames[0].gap.summary], [{}, [], { open: 0, by_cause: {}, conditions: 2, satisfied: 2 }]);
  assert.deepEqual([frames[0].phase, frames[0].matched_until], ['matched', '2026-10-17T02:00:00.000Z']);
  // A legacy purpose.set is the Purpose plus its ideal state: rev is the version that first declared the label.
  assert.deepEqual(frames.map(frame => frame.gap.basis.purpose_rev), ['v1', 'v1', 'v1', 'v1', 'v3', 'v3']);
  // t1: only the ideal moves (B revised, C added); the current is unchanged, so no current-* cause.
  assert.deepEqual(open(frames[1]), { B: ['unmet', 'ideal-revised', t(1), 'scope.B'], C: ['unknown', 'ideal-added', t(1), 'scope.C'] });
  assert.ok(frames[1].gap.parts.every(part => part.cause.every(cause => !cause.startsWith('current-'))));
  // B is judged on an observation made before ideal v2 was set: a display mark, not a cause.
  assert.deepEqual(frames[1].gap.parts.map(part => [part.condition, part.observed_before_ideal ?? false]), [['B', true], ['C', false]]);
  // t2: C observed → closed; A regresses; B continues.
  assert.deepEqual(open(frames[2]), { A: ['unmet', 'current-regressed', t(2), 'scope.A'], B: ['unmet', 'carried', t(1), 'scope.B'] });
  assert.deepEqual(closed(frames[2]), [['C', 'current-satisfied', t(2)]]);
  // t3: A's observation is not usable (G UNKNOWN); B's observation is outside its PT2H window. Both stay open since earlier.
  assert.deepEqual(open(frames[3]), { A: ['unknown', 'current-unobserved', t(2), 'scope.A'], B: ['unknown', 'current-stale', t(1), 'scope.B'] });
  // t4: the Purpose changes: everything open closes by purpose-changed; E opens without an owner.
  assert.deepEqual(open(frames[4]), { E: ['unknown', 'purpose-changed', t(4), null] });
  assert.deepEqual(closed(frames[4]), [['A', 'purpose-changed', t(4)], ['B', 'purpose-changed', t(4)]]);
  // t5: still no observation of E: current-unobserved applies, so it is not carried (carried only when nothing else applies).
  assert.deepEqual(open(frames[5]), { E: ['unknown', 'current-unobserved', t(4), null] });
  assert.deepEqual(frames.map(frame => frame.gap.summary.open), [0, 2, 2, 2, 1, 1]);
  assert.deepEqual(frames[3].gap.summary, { open: 2, by_cause: { 'current-unobserved': 1, 'current-stale': 1 }, conditions: 3, satisfied: 1 });
  assert.deepEqual(frames.map(frame => frame.phase), ['matched', 'approximating', 'approximating', 'approximating', 'approximating', 'approximating']);
});

test('Scopes are the open conditions only: satisfied ones are history, unowned ones stay as Scopes', () => {
  for (const frame of build().frames) {
    const units = frame.entities.filter(value => ['semantic-scope', 'unassigned-change', 'unresolved-change'].includes(value.ref.kind));
    const expected = frame.gap.parts.map(part => part.scope ?? part.condition).sort();
    assert.deepEqual(units.map(value => value.ref.id).sort(), expected, frame.id);
    const label = frame.relations.find(value => value.ref.id === 'gap:current-target')?.label;
    assert.equal(label, frame.gap.parts.length ? `差 ${frame.gap.parts.length} 件` : undefined, frame.id);
  }
});

test('past gaps are never rewritten; plans never enter the gap', () => {
  const extended = [...rows(EVENTS), { kind: 'observation', recordedAt: '2026-10-17T06:00:00Z', target: { kind: 'state', id: 'svc.e' }, value: 'ok',
    source: 'synthetic:later', observedAt: '2026-10-17T06:00:00Z' }];
  const before = build().frames, after = build(jsonl(extended)).frames;
  before.forEach((frame, index) => assert.deepEqual(after[index].gap, frame.gap, frame.id));
  assert.deepEqual(closed(after.at(-1)), [['E', 'current-satisfied', 't@2026-10-17T06:00:00.000Z']]);
  // A declared plan with a source: only its repo#n appears as a ref; the plan itself never does.
  const withPlan = rows(EVENTS);
  withPlan.find(event => event.version === 'v3').requires[0].plans = ['ops#7:handover'];
  withPlan.push({ kind: 'plan.set', recordedAt: '2026-10-17T05:00:00Z', plan: 'ops#7:handover', purposeRef: { purposeId: 'purpose.p2', version: 'v3' },
    source: { ref: 'ops#7', commentId: null, updatedAt: '2026-10-17T04:30:00Z', digest: 'sha256:' + '3'.repeat(64) }, version: '1', nodes: null, edges: null, unknown: ['flowchart-absent'] });
  withPlan.sort((a, b) => Date.parse(a.recordedAt ?? 0) - Date.parse(b.recordedAt ?? 0));
  const planned = build(jsonl(withPlan)).frames;
  assert.deepEqual(planned.at(-1).gap.parts[0].refs, ['ops#7']);
  assert.deepEqual(planned[4].gap.parts[0].refs, [], 'not recorded yet at t4');
  const strip = gap => ({ ...gap, parts: gap.parts.map(({ refs, ...part }) => part) });
  planned.forEach((frame, index) => assert.deepEqual(strip(frame.gap), strip(before[index].gap), frame.id));
  assert.ok(!JSON.stringify(planned.map(frame => frame.gap)).includes('ops#7:handover'));
});

test('cause exclusivity and transitions by id comparison only', () => {
  const condition = (id, state, reason = 'observed', extra = {}) => ({ id, label: id + ' label', predicate: { target: { kind: 'state', id: 's.' + id }, op: 'equals', value: 'ok' },
    maxAge: 'PT1H', judgment: { state, reason }, responsibility: { state: 'unassigned' }, ...extra });
  const frame = (hour, conditions, version = 'v1', rev = 'r1', label = 'P') => ({ asOf: `2026-10-17T0${hour}:00:00.000Z`, stage: 'ideal',
    purpose: { purpose: { id: 'p', label }, rev }, ideal: { version, recordedAt: '2026-10-17T00:00:00.000Z' }, conditions, plans: [] });
  const step = frames => frames.reduce((acc, value) => { const gap = gapOf(value, acc.last, acc.previous); const next = { frame: value, gap };
    return { last: gap.parts ? next : acc.last, previous: next, gaps: [...acc.gaps, gap] }; }, { last: null, previous: null, gaps: [] }).gaps;
  const causes = gap => gap.parts.map(part => [part.condition, ...part.cause]);
  const [g0, g1] = step([frame(0, [condition('X', 'unmet'), condition('Y', 'unmet')]), frame(1, [condition('Y', 'unmet')], 'v2')]);
  assert.deepEqual(causes(g0), [['X', 'initial'], ['Y', 'initial']]);
  assert.deepEqual(g1.closed, [{ condition: 'X', at: 't@2026-10-17T01:00:00.000Z', by: 'ideal-removed' }]);
  assert.deepEqual([causes(g1), g1.parts[0].since, g1.parts[0].label], [[['Y', 'carried']], 't@2026-10-17T00:00:00.000Z', 'Y label']);
  // unknown → unmet is a confirmation, conflict is its own cause, unobserved and stale never together.
  const g = step([frame(0, [condition('A', 'unknown', 'no-observation'), condition('B', 'unmet'), condition('C', 'satisfied')]),
    frame(1, [condition('A', 'unmet'), condition('B', 'conflict', 'conflicting-observations'), condition('C', 'unknown', 'stale')])]);
  assert.deepEqual(causes(g[1]), [['A', 'current-confirmed-unmet'], ['B', 'current-conflict'], ['C', 'current-stale']]);
  assert.ok(g[1].parts.every(part => part.cause.length === 1));
  // A label/norm change is no revision; a changed maxAge is. A new label of the same Purpose id is a new rev: purpose-changed.
  const h = step([frame(0, [condition('Y', 'unmet')]), frame(1, [condition('Y', 'unmet', 'observed', { label: 'renamed', norm: 'n2' })], 'v2'),
    frame(2, [condition('Y', 'unmet', 'observed', { maxAge: 'PT2H' })], 'v3'), frame(3, [condition('Y', 'unmet', 'observed', { maxAge: 'PT2H' })], 'v4', 'r2', 'P renamed')]);
  assert.deepEqual(h.map(gap => gap.parts[0].cause[0]), ['initial', 'carried', 'ideal-revised', 'purpose-changed']);
  assert.deepEqual(h.map(gap => gap.parts[0].since.slice(13, 18)), ['00:00', '00:00', '02:00', '02:00'], 'declared again under the new rev: continues');
  assert.deepEqual(h[3].closed, []);
});
