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
  assert.deepEqual([open(frames[0]), closed(frames[0]), frames[0].gap.summary], [{}, [], { open: 0, by_cause: {} }]);
  // t1: only the ideal moves (B revised, C added); the current is unchanged, so no current-* cause.
  assert.deepEqual(open(frames[1]), { B: ['unmet', 'ideal-revised', t(1), 'scope.B'], C: ['unknown', 'ideal-added', t(1), 'scope.C'] });
  assert.ok(frames[1].gap.parts.every(part => part.cause.every(cause => !cause.startsWith('current-'))));
  // t2: C observed → closed; A regresses; B continues.
  assert.deepEqual(open(frames[2]), { A: ['unmet', 'current-regressed', t(2), 'scope.A'], B: ['unmet', 'carried', t(1), 'scope.B'] });
  assert.deepEqual(closed(frames[2]), [['C', 'current-satisfied', t(2)]]);
  // t3: A's observation is not usable (G UNKNOWN); B's observation is outside its PT2H window. Both stay open since earlier.
  assert.deepEqual(open(frames[3]), { A: ['unknown', 'current-unobserved', t(2), 'scope.A'], B: ['unknown', 'current-stale', t(1), 'scope.B'] });
  // t4: the Purpose changes: everything open closes by purpose-changed; E opens without an owner.
  assert.deepEqual(open(frames[4]), { E: ['unknown', 'purpose-changed', t(4), null] });
  assert.deepEqual(closed(frames[4]), [['A', 'purpose-changed', t(4)], ['B', 'purpose-changed', t(4)]]);
  // t5: nothing about E changed.
  assert.deepEqual(open(frames[5]), { E: ['unknown', 'carried', t(4), null] });
  assert.deepEqual(frames.map(frame => frame.gap.summary.open), [0, 2, 2, 2, 1, 1]);
  assert.deepEqual(frames[3].gap.summary.by_cause, { 'current-unobserved': 1, 'current-stale': 1 });
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

test('ideal-removed and reversed transitions by id comparison only', () => {
  const condition = (id, state, reason = 'observed', extra = {}) => ({ id, predicate: { target: { kind: 'state', id: 's.' + id }, op: 'equals', value: 'ok' },
    maxAge: 'PT1H', judgment: { state, reason }, responsibility: { state: 'unassigned' }, ...extra });
  const frame = (asOf, conditions, version = 'v1') => ({ asOf, purpose: { purpose: { id: 'p', label: 'P' }, version }, conditions, plans: [] });
  const t0 = frame('2026-10-17T00:00:00.000Z', [condition('X', 'unmet'), condition('Y', 'unmet')]);
  const t1 = frame('2026-10-17T01:00:00.000Z', [condition('Y', 'unmet')], 'v2');
  const g0 = gapOf(t0, null), g1 = gapOf(t1, t0, g0);
  assert.deepEqual(g0.parts.map(part => part.cause[0]), ['initial', 'initial']);
  assert.deepEqual(g1.closed, [{ condition: 'X', at: 't@2026-10-17T01:00:00.000Z', by: 'ideal-removed' }]);
  assert.deepEqual(g1.parts.map(part => [part.condition, part.cause[0], part.since]), [['Y', 'carried', 't@2026-10-17T00:00:00.000Z']]);
  // A label/norm change is not an ideal revision; a changed maxAge is.
  const t2 = frame('2026-10-17T02:00:00.000Z', [condition('Y', 'unmet', 'observed', { label: 'renamed', norm: 'n2' })], 'v3');
  assert.equal(gapOf(t2, t1, g1).parts[0].cause[0], 'carried');
  const t3 = frame('2026-10-17T03:00:00.000Z', [condition('Y', 'unmet', 'observed', { maxAge: 'PT2H' })], 'v4');
  assert.deepEqual([gapOf(t3, t2, gapOf(t2, t1, g1)).parts[0].cause[0], gapOf(t3, t2, gapOf(t2, t1, g1)).parts[0].since], ['ideal-revised', 't@2026-10-17T03:00:00.000Z']);
});
