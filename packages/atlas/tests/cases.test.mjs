import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { deriveAtlas, parseAuthority } from '../events.mjs';
import { contractWorld, heldEntries, unboundPlans } from '../contract.mjs';
import { joinLog } from '../live.mjs';

// The 31 difference cases agreed in adrs#647 (S1–S4; contract v12): each JSONL goes through the real
// derive (via joinLog when the case starts from G events) and every frame is checked against the flow's end.
const dir = new URL('./fixtures/cases/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const cases = readdirSync(dir).filter(name => /^case-\d+\.jsonl$/u.test(name)).map(name => name.slice(5, 7)).sort();

const build = n => {
  const expect = JSON.parse(read(`case-${n}.expect.json`)), control = read(`case-${n}.control.jsonl`);
  let text = read(`case-${n}.jsonl`), held = [], unbound = [];
  if (expect.via === 'joinLog') {
    const joined = joinLog('', [text], 'supplied', { authority: parseAuthority(control) });
    // As live.mjs writes them: held declarations only (held plans are not declarations; unbound plans are the journal's).
    ({ log: text, unbound } = joined);
    held = joined.held.filter(value => value.journal);
  }
  const result = deriveAtlas(text, control);
  return { expect, result, held, unbound, world: contractWorld(result, { unbound, held }) };
};
const project = (frame, derived) => ({
  stage: derived.stage, phase: frame.phase, iv: frame.gap.basis.ideal_version, before_ideal: frame.gap.summary.before_ideal,
  parts: frame.gap.parts && frame.gap.parts.map(p => ({ c: p.condition, s: p.state, ci: p.cause.ideal, cc: p.cause.current, since: p.since, scope: p.scope,
    obi: p.observed_before_ideal ?? false, lo: p.last_observed })),
  closed: frame.gap.closed.map(c => c.condition + ':' + c.by), journal: frame.journal.map(entry => entry.kind + (entry.unbound ? ':unbound' : '')),
  owners: derived.conditions.map(c => c.id + ':' + c.responsibility.state), purpose: frame.gap.basis.purpose_id,
  pkgs: frame.entities.filter(e => e.ref.kind === 'package').map(e => e.ref.id),
  relations: frame.relations.filter(r => r.ref.id.startsWith('physical:')).map(r => `${r.to.kind}:${r.context.condition}:${r.context.lifetime}`).sort(),
  adequacy: { state: frame.adequacy.state, reason: frame.adequacy.reason }, held: frame.held, matched_until: frame.matched_until,
  plans: 'plans' in frame, upkeep: frame.upkeep,
});
const check = (actual, expected, at) => {
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'asOf') continue;
    if (key === 'parts' && value !== null) {
      assert.equal(actual.parts?.length, value.length, `${at} parts ${JSON.stringify(actual.parts)}`);
      value.forEach((part, i) => Object.entries(part).forEach(([k, v]) => assert.deepEqual(actual.parts[i][k], v, `${at} part ${part.c}.${k}`)));
    } else if (key === 'held') {
      assert.equal(actual.held.length, value.length, `${at} held ${JSON.stringify(actual.held)}`);
      // A held reason is a stable word, compared exactly (no line number, no parser message).
      value.forEach((item, i) => Object.entries(item).forEach(([k, v]) => assert.deepEqual(actual.held[i][k], v, `${at} held[${i}].${k}`)));
    } else assert.deepEqual(actual[key], value, `${at} ${key}`);
  }
};

for (const n of cases) test(`case ${n}: the flow's end, frame by frame`, () => {
  const { expect, result, held, unbound, world } = build(n);
  const frames = world.frames.map((frame, i) => ({ asOf: frame.asOf, ...project(frame, result.derived.frames[i]) }));
  for (const e of expect.frames) {
    const actual = frames.find(f => f.asOf === e.asOf);
    assert.ok(actual, `case ${n}: frame ${e.asOf} missing; frames ${frames.map(f => f.asOf)}`);
    check(actual, e, `case ${n} ${e.asOf}`);
  }
  if (expect.times) assert.deepEqual(frames.map(f => f.asOf), expect.times, `case ${n}: exactly these frames`);
  if (expect.receipt?.held) assert.deepEqual({ count: held.length, unplaced: heldEntries(world.frames, held).unplaced }, expect.receipt.held);
  if (expect.receipt?.unbound) assert.deepEqual({ count: unbound.length, unplaced: unboundPlans(world.frames, unbound).unplaced }, expect.receipt.unbound);
});

test('every frame carries adequacy and held in the contract v12 shape', () => {
  const EVIDENCE = ['recordedAt', 'actor', 'source', 'purpose_id', 'purpose_rev', 'ideal_version', 'verdict'];
  for (const n of cases) for (const frame of build(n).world.frames) {
    const { adequacy, held, gap } = frame;
    assert.deepEqual(Object.keys(adequacy), ['basis', 'state', 'reason', 'evidence']);
    assert.deepEqual(adequacy.basis, { purpose_id: gap.basis.purpose_id, purpose_rev: gap.basis.purpose_rev, ideal_version: gap.basis.ideal_version });
    assert.equal(adequacy.state === 'unmet', adequacy.reason === 'evaluated', `case ${n}: unmet exactly when evaluated`);
    if (adequacy.evidence) {
      assert.ok(EVIDENCE.every(key => key in adequacy.evidence), `case ${n}: evidence keys`);
      assert.ok(Object.keys(adequacy.evidence).every(key => [...EVIDENCE, 'declaredAt', 'note'].includes(key)), `case ${n}: no kind/frame/past in evidence`);
      assert.deepEqual(Object.keys(adequacy.evidence.source).filter(key => key !== 'admission'), ['ref', 'commentId', 'sha256']);
    }
    assert.ok(Array.isArray(held) && held.every(item => JSON.stringify(Object.keys(item)) === '["reason","kind","recordedAt","source"]'
      && JSON.stringify(Object.keys(item.source)) === '["ref","commentId","sha256"]'), `case ${n}: held shape`);
  }
});

// S5 (adrs#647 6305441262): upkeep lists, on a matched frame, each met condition with the observation the
// judge chose and when it goes stale (observedAt + maxAge, still fresh at that instant); matched_until is its
// minimum. Every part names the last observation the judge saw, or null.
test('upkeep, matched_until and last_observed in the contract shape on every frame', () => {
  for (const n of cases) {
    const { world, result } = build(n);
    world.frames.forEach((frame, i) => {
      const derived = result.derived.frames[i];
      if (frame.phase !== 'matched') assert.deepEqual([frame.upkeep, frame.matched_until], [[], null], `case ${n} ${frame.asOf}`);
      else {
        assert.deepEqual(frame.upkeep.map(item => item.condition), derived.conditions.map(c => c.id), `case ${n}: every condition of a matched frame`);
        assert.ok(frame.upkeep.every(item => JSON.stringify(Object.keys(item)) === '["condition","observedAt","stale_at"]'));
        assert.equal(frame.matched_until, frame.upkeep.map(item => item.stale_at).sort()[0], `case ${n}: matched_until is the minimum stale_at`);
      }
      for (const part of frame.gap.parts ?? []) assert.ok(part.last_observed === null
        || JSON.stringify(Object.keys(part.last_observed)) === '["observedAt","source","actor"]' && JSON.stringify(Object.keys(part.last_observed.source)) === '["ref"]',
      `case ${n}: last_observed shape`);
    });
  }
});

// R's HQ readback (apps#133 6ccc62d): G writes an observation source as "<ref> sha256:<hex>" and the ref itself has
// spaces ("gh api graphql roccho-dev/Meltype#38 pullRequest"); the first word alone ("gh") loses what was observed.
test('last_observed.source.ref is the observation source without its trailing sha256', () => {
  const hex = 'a'.repeat(64), digest = 'sha256:' + '0'.repeat(64);
  const condition = (id, target, value) => ({ id, label: id, predicate: { target: { kind: 'state', id: target }, op: 'equals', value }, maxAge: 'PT24H', norm: 'n.' + id });
  const observed = (target, value, source) => ({ kind: 'observation', recordedAt: '2026-10-21T01:00:00Z', target: { kind: 'state', id: target }, value, source,
    observedAt: '2026-10-21T01:00:00Z' });
  const events = [{ schema: 'atlas.events/1', authority: false, source_mode: 'supplied' },
    { kind: 'purpose.set', recordedAt: '2026-10-21T01:00:00Z', purpose: { id: 'p', label: 'P' }, rev: 'r1', source: { ref: 'hq:decl', digest } },
    { kind: 'ideal.set', recordedAt: '2026-10-21T01:00:00Z', purpose_id: 'p', purpose_rev: 'r1', version: 'v1', source: { ref: 'hq:decl', digest },
      requires: [condition('A', 'roccho-dev/Meltype#38:pr.merged', 'true'), condition('B', 'dev.atlas.hq:port', 'responding'), condition('C', 's.c', 'ok')] },
    observed('roccho-dev/Meltype#38:pr.merged', 'false', `gh api graphql roccho-dev/Meltype#38 pullRequest sha256:${hex}`),
    observed('dev.atlas.hq:port', 'down', `tcp 127.0.0.1:52162 sha256:${hex}`),
    observed('s.c', 'ng', 's3:obs')].map(value => JSON.stringify(value)).join('\n') + '\n';
  const world = contractWorld(deriveAtlas(events, '{"schema":"atlas.control-norms/1","authority":false}\n'));
  assert.deepEqual(world.frames.at(-1).gap.parts.map(part => [part.condition, part.last_observed.source.ref]),
    [['A', 'gh api graphql roccho-dev/Meltype#38 pullRequest'], ['B', 'tcp 127.0.0.1:52162'], ['C', 's3:obs']]);
});

test('GapA reasons: all eight are reached by the cases', () => {
  const reasons = new Set(cases.flatMap(n => build(n).world.frames.map(frame => frame.adequacy.reason)));
  assert.deepEqual([...reasons].sort(), ['achieved-while-open', 'evaluated', 'no-adequacy-verdict', 'no-evaluation', 'no-ideal',
    'not-yet-while-matched', 'past', 'purpose-ended']);
});
