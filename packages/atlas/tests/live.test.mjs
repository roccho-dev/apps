import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deriveAtlas, deriveFrames, parseEvents, parseControl } from '../events.mjs';
import { fromG } from '../live.mjs';
import { plansOf } from '../contract.mjs';
const causeText = cause => [cause.ideal, cause.current].filter(Boolean).join('+') || 'carried'; // v6: both sides, carried when neither

const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const run = (script, args) => execFileSync(process.execPath, [file(script), ...args], { encoding: 'utf8' });
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const gPlans = file => rows(readFileSync(file, 'utf8')).filter(event => event.kind === 'plan.set');

test('World plans: absent without a declaration, never a plan recorded after the frame asOf', () => {
  const plan = { ref: 'r#1', plan: 'r#1:p', version: '2', recordedAt: '2026-10-16T02:00:00.000Z', serves: ['c'], nodes: [{ id: 'r#1:a', label: 'A', norm: 'n' }],
    edges: [], source: { ref: 'r#1', commentId: null, updatedAt: '2026-10-16T01:00:00Z', digest: 'sha256:' + '2'.repeat(64) } };
  const declared = { requires: [{ id: 'c', plans: ['r#1:p'] }] };
  const frames = ['2026-10-16T01:00:00.000Z', '2026-10-16T02:00:00.000Z'].map(asOf => ({ asOf, ideal: declared }));
  // Even if a projection carried it, a plan recorded after asOf is not attached to that frame.
  const projection = { frames: frames.map(frame => ({ asOf: frame.asOf, plans: [plan] })) };
  const [early, late] = frames.map(frame => plansOf(frame, projection));
  assert.deepEqual(early, []);
  assert.deepEqual(late.map(value => [value.plan, value.version, value.nodes, value.edges, value.unknown]), [['r#1:p', 2, [{ id: 'r#1:a', label: 'A' }], [], []]]);
  assert.equal(plansOf({ ...frames[1], ideal: { requires: [{ id: 'c' }] } }, projection), undefined, 'absent = 計画未宣言');
  assert.equal(plansOf({ ...frames[1], ideal: null }, projection), undefined, 'no ideal state: no plan declaration');
});

test('end to end: G fixture snapshots → G events → live.mjs → D → World', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-live-'));
  const gEvents = path.join(dir, 'g-events.jsonl');
  run('../collect/collect.mjs', [file('../collect/fixtures/snapshots'), '--recorded-at', '2026-10-16T20:40:00Z', '--out', gEvents]);
  const receipt = JSON.parse(run('../live.mjs', ['--out-dir=' + dir, '--purpose=' + file('../fixtures/live/purpose.jsonl'),
    '--control=' + file('../fixtures/live/control.jsonl'), gEvents]));
  assert.equal(receipt.status, 'PASS');
  const world = JSON.parse(readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.equal(world.kind, 'ui.atlasWorldInput.v1');
  // K6c: the journal carries G's observations (contract 3), each G fact once — the session view
  // fromG adds for the Agent is a projection, not a second observation.
  const gObservations = rows(readFileSync(gEvents, 'utf8')).filter(event => event.kind === 'observation');
  const journalObservations = world.frames.at(-1).journal.filter(entry => entry.kind === 'observation');
  assert.ok(gObservations.length > 0);
  assert.equal(journalObservations.length, gObservations.length);
  assert.deepEqual(journalObservations.map(entry => entry.target.id).sort(), gObservations.map(event => event.target).sort());
  assert.deepEqual(world.frames.map(frame => frame.asOf), ['2026-10-16T03:00:00.000Z', '2026-10-16T20:40:00.000Z']);
  // States come from D on exact G targets only.
  const derived = deriveFrames(parseEvents(readFileSync(path.join(dir, 'events.jsonl'), 'utf8')),
    parseControl(readFileSync(file('../fixtures/live/control.jsonl'), 'utf8')));
  const now = derived.frames.at(-1);
  const states = Object.fromEntries(now.conditions.map(value => [value.id, [value.judgment.state, value.judgment.reason]]));
  assert.deepEqual(states, {
    merged: ['satisfied', 'observed'],
    'adrs-ci': ['unknown', 'no-value'], // G's literal UNKNOWN is no value obtained (D null), never compared
    'reviewer-running': ['satisfied', 'observed'],
    'worker-running': ['unmet', 'observed'], // transcript-only means a past transcript exists, not activity
    'ui-serving': ['unknown', 'stale'],
    lookalike: ['unknown', 'no-observation'], // 'roccho-dev/apps#92' is not 'roccho-dev/apps#92:pr.state'
  });
  // Only the declared Norm assigns; the rest stays unassigned rather than guessed from names.
  assert.deepEqual(now.conditions.filter(value => value.responsibility.state === 'assigned').map(value => [value.id, value.responsibility.actor]),
    [['merged', 'atlas.W'], ['worker-running', 'atlas.W']]);
  // Open, unowned conditions are Scopes without an owner; the satisfied reviewer-running is no Scope.
  assert.deepEqual(world.frames.at(-1).entities.filter(value => value.ref.kind === 'unassigned-change').map(value => value.ref.id),
    ['adrs-ci', 'lookalike', 'ui-serving']);
  // Agent activity: G <target>:session reaches the Agent with exactly the same declared id, value as observed.
  const agent = world.frames.at(-1).entities.find(value => value.ref.kind === 'agent' && value.ref.id === 'atlas.W');
  assert.deepEqual(agent.flags, ['supplied', 'declared', 'session-observed']);
  assert.match(agent.summary, /session 観測: "transcript-only"/u);
  assert.equal(world.presentation.areas[2].label, 'Agent：宣言された担当（供給・一部観測）');
  assert.deepEqual(Object.keys(now.sessions), ['atlas.R', 'atlas.W', 'atlas.W2']);
  // A plan declared in requires[].plans enters D (UNKNOWN content kept, not "no plan"); the other is held.
  const plans = JSON.parse(readFileSync(path.join(dir, 'plan-projection.json'), 'utf8'));
  assert.deepEqual([plans.frames[0].status, plans.frames[0].plans], ['unknown', null]);
  const [plan, ...others] = plans.frames.at(-1).plans;
  assert.equal(others.length, 0);
  assert.deepEqual([plan.plan, plan.ref, plan.version, plan.serves, plan.nodes, plan.unknown, plan.premise],
    ['roccho-dev/resources#25:windows-retirement-migration-20261016', 'roccho-dev/resources#25', '3', ['merged'], null, ['flowchart-absent', 'exit-table-absent'], 'current']);
  const gPlan = rows(readFileSync(gEvents, 'utf8')).find(event => event.plan === 'roccho-dev/resources#25:windows-migration-preparation-scope-20261017');
  assert.deepEqual(rows(readFileSync(path.join(dir, 'g-plans.jsonl'), 'utf8')),
    [{ reason: 'no ideal state declares this plan in requires[].plans', plan: gPlan }]);
  assert.equal(receipt.held_plans.count, 1);
  // World plan contract (ui reads only this): [] = declared but none recorded at t, nodes:null = content UNKNOWN.
  assert.deepEqual(world.frames[0].plans, []);
  assert.deepEqual(world.frames.at(-1).plans, [{ ref: 'roccho-dev/resources#25', plan: 'roccho-dev/resources#25:windows-retirement-migration-20261016', version: 3,
    label: 'roccho-dev/resources#25:windows-retirement-migration-20261016 v3 · roccho-dev/resources#25 comment 6208252115', serves: ['merged'], nodes: null, edges: null,
    unknown: ['flowchart-absent', 'exit-table-absent'],
    source: { repo: 'roccho-dev/resources#25', commentId: 6208252115, updatedAt: gPlans(gEvents)[1].source.updatedAt, sha256: gPlans(gEvents)[1].source.sha256 } }]);
  // Plans, gap, phase, journal and matched_until are edge contracts: without them the World is exactly D's.
  const bare = deriveAtlas(readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), readFileSync(file('../fixtures/live/control.jsonl'), 'utf8')).world;
  assert.deepEqual({ ...world, frames: world.frames.map(({ plans, gap, phase, journal, matched_until, ...frame }) => frame) }, bare);
  const sha = 'sha256:' + createHash('sha256').update(readFileSync(path.join(dir, 'world.json'))).digest('hex');
  assert.equal(receipt.outputs.find(value => path.basename(value.path) === 'world.json').sha256, sha);
  // Gap by cause: the first frame opens everything; the observation frame closes or explains each.
  const gap = frame => Object.fromEntries(frame.gap.parts.map(part => [part.condition, [part.state, causeText(part.cause), part.scope]]));
  assert.ok(Object.values(gap(world.frames[0])).every(([, cause]) => cause.startsWith('initial')));
  assert.deepEqual(gap(world.frames.at(-1)), { 'adrs-ci': ['unknown', 'current-unobserved', null], 'worker-running': ['unmet', 'current-confirmed-unmet', 'scope.worker-running'],
    'ui-serving': ['unknown', 'current-stale', null], lookalike: ['unknown', 'current-unobserved', null] });
  assert.deepEqual(world.frames.at(-1).gap.closed.map(value => [value.condition, value.by]), [['merged', 'current-satisfied'], ['reviewer-running', 'current-satisfied']]);
  // The declared-unknown whole evaluation is explained by those Scopes: no extra 全体評価 unit.
  assert.ok(world.frames.every(frame => frame.entities.every(value => value.ref.kind !== 'unresolved-change')));
});

test('fromG keeps targets opaque, passes <target>:session as Agent activity, and fails closed', () => {
  const event = { kind: 'observation', target: 'x#1:pr.state', value: 'OPEN', source: { ref: 'gh', sha256: 'sha256:' + '0'.repeat(64) },
    observedAt: '2026-10-16T00:00:00Z', recordedAt: '2026-10-16T00:00:00Z' };
  assert.deepEqual(fromG(event).events.map(value => value.target), [{ kind: 'state', id: 'x#1:pr.state' }]);
  assert.equal(fromG({ ...event, value: 'UNKNOWN' }).events[0].value, null);
  assert.deepEqual(fromG({ ...event, target: 'atlas.W:session', value: 'transcript-only' }).events.map(value => [value.target, value.value]),
    [[{ kind: 'state', id: 'atlas.W:session' }, 'transcript-only'], [{ kind: 'session', id: 'atlas.W' }, 'transcript-only']]);
  assert.equal(fromG({ ...event, target: ':session' }).events.length, 1);
  // A declared plan that D's parser rejects is held with D's reason, never forced in.
  const purposes = rows(readFileSync(file('../fixtures/live/purpose.jsonl'), 'utf8'));
  const bad = { kind: 'plan.set', plan: 'roccho-dev/resources#25:windows-retirement-migration-20261016', version: 1, recordedAt: '2026-10-16T20:40:00Z',
    source: { repo: 'roccho-dev/resources#25', commentId: null, updatedAt: '2026-10-16T20:00:00Z', sha256: 'sha256:' + '1'.repeat(64) },
    nodes: [{ id: 'roccho-dev/resources#25:A', label: 'A', shape: 'rect', groups: [], owner: 'UNKNOWN', exit: 'UNKNOWN', predicate: 'UNKNOWN', requires: 'UNKNOWN' }],
    edges: [], exits: 'UNKNOWN', unknown: [] };
  assert.match(fromG(bad, purposes).held.reason, /outside v1/u);
  assert.throws(() => fromG({ ...event, extra: 1 }), /unsupported G event/u);
  assert.throws(() => fromG({ kind: 'purpose.set' }), /unsupported G event/u);
});
