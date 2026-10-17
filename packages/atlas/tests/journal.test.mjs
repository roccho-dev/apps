import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas, parseEvents } from '../events.mjs';
import { contractWorld } from '../contract.mjs';
const causeText = cause => [cause.ideal, cause.current].filter(Boolean).join('+') || 'carried'; // v6: both sides, carried when neither

const read = name => readFileSync(new URL('../fixtures/journal/' + name, import.meta.url), 'utf8');
const EVENTS = read('events.jsonl'), CONTROL = read('control.jsonl');
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';
const world = contractWorld(deriveAtlas(EVENTS, CONTROL));
const t = hm => `t@2026-10-17T${hm}:00.000Z`;
const open = frame => frame.gap.parts && frame.gap.parts.map(part => [part.condition, part.state, causeText(part.cause), part.since.slice(13, 18)]);
const closed = frame => frame.gap.closed.map(value => [value.condition, value.by]);
const HOURS = ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '06:30', '07:00'];

test('one cycle by phase: Purpose change → defining → approximating → matched (maintained) → stale → ended', () => {
  assert.deepEqual(world.frames.map(frame => frame.id), HOURS.map(t));
  assert.deepEqual(world.frames.map(frame => frame.phase),
    ['approximating', 'purpose-changed', 'defining', 'approximating', 'approximating', 'matched', 'matched', 'approximating', 'ended']);
  const [f0, f1, f2, f3, f4, f5, f6, f7, f8] = world.frames;
  assert.deepEqual(open(f0), [['Z', 'unknown', 'initial+current-unobserved', '00:00']]);
  // No ideal state to compare with: UNKNOWN (null), not an empty Gap. The previous Purpose's difference closes.
  assert.deepEqual([f1.gap.parts, f1.gap.summary, closed(f1)], [null, { open: null, by_cause: {}, conditions: null, satisfied: null, before_ideal: null }, [['Z', 'purpose-changed']]]);
  assert.deepEqual([f2.gap.parts, closed(f2)], [null, []]);
  // Causes compare with the latest frame that has a gap (f0, another Purpose), not with the null frames.
  assert.deepEqual([f3.gap.basis.prev_frame, open(f3)], [t('00:00'), [['A', 'unknown', 'purpose-changed+current-unobserved', '03:00'], ['B', 'unmet', 'purpose-changed', '03:00']]]);
  assert.deepEqual(f3.gap.parts.map(part => part.observed_before_ideal ?? false), [false, true], 'B was observed at 02:30, before ideal.set');
  assert.deepEqual([open(f4), closed(f4)], [[['B', 'unmet', 'carried', '03:00']], [['A', 'current-satisfied']]]);
  // Matched: no open difference; only keeping the observations fresh remains. 06:00 is exactly A's PT2H: still fresh (≦).
  assert.deepEqual([open(f5), closed(f5), f5.gap.summary], [[], [['B', 'current-satisfied']], { open: 0, by_cause: {}, conditions: 2, satisfied: 2, before_ideal: 0 }]);
  assert.deepEqual([f5.matched_until, f6.matched_until, open(f6)], ['2026-10-17T06:00:00.000Z', '2026-10-17T06:00:00.000Z', []]);
  assert.deepEqual([open(f7), f7.matched_until], [[['A', 'unknown', 'current-stale', '06:30']], null]);
  assert.deepEqual([f8.gap.parts, closed(f8), f8.gap.basis.ideal_version], [null, [['A', 'purpose-ended']], null]);
  assert.deepEqual(world.frames.map(frame => frame.gap.basis.purpose_rev), ['r1', 'r1', 'r1', 'r1', 'r1', 'r1', 'r1', 'r1', 'r1']);
  assert.deepEqual(world.frames.map(frame => frame.gap.basis.purpose_label), ['P0：旧い目的', ...Array(8).fill('P：配布を委ねる')]);
});

test('journal: the decisions and observations newly recorded in each frame (v6 delta), in time order', () => {
  const decisions = frame => frame.journal.filter(entry => entry.kind !== 'observation');
  const observations = frame => frame.journal.filter(entry => entry.kind === 'observation');
  assert.deepEqual(world.frames.map(frame => decisions(frame).length), [2, 1, 1, 1, 0, 0, 1, 0, 1]);
  // Contract 3: observations are facts in the same book, in time order, not thinned; v6: each in its own frame.
  assert.deepEqual(world.frames.map(frame => observations(frame).length), [0, 0, 0, 1, 1, 1, 0, 1, 0]);
  const all = world.frames.flatMap(frame => frame.journal);
  const recorded = all.map(entry => Date.parse(entry.recordedAt));
  assert.deepEqual(recorded, [...recorded].sort((a, b) => a - b));
  assert.deepEqual(observations(world.frames[3])[0], { kind: 'observation', recordedAt: '2026-10-17T03:00:00Z', observedAt: '2026-10-17T02:30:00Z',
    actor: null, source: { ref: 'synthetic:svc.b', commentId: null, sha256: null }, target: { kind: 'state', id: 'svc.b' } });
  const last = all.filter(entry => entry.kind !== 'observation');
  assert.deepEqual(last.map(entry => [entry.kind, entry.actor]), [['purpose.set', 'P'], ['ideal.set', 'P'], ['purpose.set', 'P'], ['ideal.drafting', 'P'],
    ['ideal.set', 'P'], ['purpose.evaluated', 'User'], ['purpose.ended', 'P']]);
  assert.ok(last.every(entry => entry.source.ref === 'hq:fixtures/journal' && /^sha256:/u.test(entry.source.sha256) && entry.recordedAt));
  const evaluation = frame => frame.journal.find(entry => entry.kind === 'purpose.evaluated');
  assert.deepEqual({ ...evaluation(world.frames[6]), source: null }, { kind: 'purpose.evaluated', recordedAt: '2026-10-17T06:00:00Z', actor: 'User', source: null,
    purpose_id: 'purpose.k5', purpose_rev: 'r1', ideal_version: 'v1', verdict: 'achieved', note: '人による評価', frame: t('06:00'), past: false });
  // The evaluation is recorded once (frame 6); later frames compare its rev/version with gap.basis.
  assert.deepEqual(world.frames.map(frame => Boolean(evaluation(frame))), [false, false, false, false, false, false, true, false, false]);
  assert.notEqual(world.frames[8].gap.basis.ideal_version, evaluation(world.frames[6]).ideal_version, 'after purpose.ended it is a past one');
});

test('the World shows the Purpose label on the Purpose node and requires labels on Scopes; ids stay in detail', () => {
  const f3 = world.frames[3], label = kind => f3.entities.find(value => value.ref.kind === kind).label;
  assert.equal(label('purpose'), '目的\nP：配布を委ねる');
  assert.match(label('purpose-state-target'), /^理想状態\n理想状態 v1：理想状態 v1：A と B/u);
  assert.deepEqual(f3.gap.parts.map(part => [part.condition, part.label]), [['A', 'A：配布が応答する'], ['B', 'B：CI が成功']]);
  assert.deepEqual(f3.entities.filter(value => value.ref.kind === 'semantic-scope').map(value => value.label.split('\n')[0]), ['A：配布が応答する', 'B：CI が成功']);
  // No ideal state: the World keeps one explicit UNKNOWN unit (not an empty Scopes area).
  assert.deepEqual(world.frames[1].entities.filter(value => value.area === 'scopes' && value.ref.kind !== 'obligation').map(value => value.ref.kind), ['unresolved-change']);
});

test('journal parsing fails closed; a label change of the same Purpose id is a new rev, not a rejection', () => {
  const base = rows(EVENTS);
  const at = (kind, change) => jsonl(base.map(event => event.kind === kind ? change(structuredClone(event)) : event));
  assert.throws(() => parseEvents(at('ideal.set', event => ({ ...event, requires: [] }))), /requires must be nonempty/u);
  assert.throws(() => parseEvents(jsonl(base.map(event => event.version === 'v1' && event.kind === 'ideal.set' ? { ...event, purpose_rev: 'r9' } : event))), /purpose_rev r9/u);
  assert.throws(() => parseEvents(jsonl(base.map(event => event.kind === 'ideal.drafting' ? { ...event, purpose_id: 'purpose.k5-old' } : event))), /not the active Purpose/u);
  assert.throws(() => parseEvents(at('purpose.evaluated', event => ({ ...event, verdict: 'done' }))), /verdict/u);
  assert.throws(() => parseEvents(at('purpose.evaluated', event => ({ ...event, ideal_version: 'v9' }))), /not declared before/u);
  assert.throws(() => parseEvents(jsonl([...base, { ...base.at(-1), recordedAt: '2026-10-17T08:00:00Z' }])), /not the active Purpose/u, 'ended twice');
  // Same (id, rev) with another label is a redefinition; a new rev with the new label is a revision.
  const relabel = rev => jsonl([...base.slice(0, 4), { ...base[3], purpose: { ...base[3].purpose, label: 'P：改訂' }, rev, recordedAt: '2026-10-17T01:30:00Z' }, ...base.slice(4)]);
  assert.throws(() => parseEvents(relabel('r1')), /rev r1 redefined/u);
  // The ideal state set after the revision must name the new rev.
  assert.throws(() => parseEvents(relabel('r2')), /purpose_rev r1, active is r2/u);
  const revised = relabel('r2').split('"purpose_id":"purpose.k5","purpose_rev":"r1"').join('"purpose_id":"purpose.k5","purpose_rev":"r2"');
  assert.equal(parseEvents(revised).events.filter(event => event.kind === 'purpose.set').length, 3);
  const frames = contractWorld(deriveAtlas(revised, CONTROL)).frames;
  assert.deepEqual(frames.filter(frame => frame.gap.parts).map(frame => frame.gap.basis.purpose_rev), ['r1', 'r2', 'r2', 'r2', 'r2', 'r2']);
});
