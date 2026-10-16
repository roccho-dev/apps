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
  const receipt = JSON.parse(run('../live.mjs', ['--out-dir=' + dir, '--purpose=' + file('../fixtures/live/purpose.jsonl'),
    '--control=' + file('../fixtures/live/control.jsonl'), gEvents]));
  assert.equal(receipt.status, 'PASS');
  const world = JSON.parse(readFileSync(path.join(dir, 'world.json'), 'utf8'));
  assert.equal(world.kind, 'ui.atlasWorldInput.v1');
  assert.deepEqual(world.frames.map(frame => frame.asOf), ['2026-10-16T03:00:00.000Z', '2026-10-16T20:40:00.000Z']);
  // States come from D on exact G targets only.
  const derived = deriveFrames(parseEvents(readFileSync(path.join(dir, 'events.jsonl'), 'utf8')),
    parseControl(readFileSync(file('../fixtures/live/control.jsonl'), 'utf8')));
  const now = derived.frames.at(-1);
  const states = Object.fromEntries(now.conditions.map(value => [value.id, [value.judgment.state, value.judgment.reason]]));
  assert.deepEqual(states, {
    merged: ['satisfied', 'observed'],
    'adrs-ci': ['unknown', 'unmatchable'], // G's literal UNKNOWN is never a value to compare
    'reviewer-running': ['satisfied', 'observed'],
    'worker-running': ['unmet', 'observed'], // transcript-only means a past transcript exists, not activity
    'ui-serving': ['unknown', 'stale'],
    lookalike: ['unknown', 'no-observation'], // 'apps#92' is not 'apps#92:pr.state'
  });
  // Only the declared Norm assigns; the rest stays unassigned rather than guessed from names.
  assert.deepEqual(now.conditions.filter(value => value.responsibility.state === 'assigned').map(value => [value.id, value.responsibility.actor]),
    [['merged', 'atlas.W']]);
  assert.equal(world.frames.at(-1).entities.filter(value => value.ref.kind === 'unassigned-change').length, 5);
  // Agent activity: G <target>:session reaches the Agent with exactly the same declared id, value as observed.
  const agent = world.frames.at(-1).entities.find(value => value.ref.kind === 'agent' && value.ref.id === 'atlas.W');
  assert.deepEqual(agent.flags, ['supplied', 'declared', 'activity-observed']);
  assert.match(agent.summary, /活動観測: "transcript-only"/u);
  assert.equal(world.presentation.areas[2].label, 'Agent：宣言された担当（供給・一部観測）');
  assert.deepEqual(Object.keys(now.sessions), ['atlas.R', 'atlas.W', 'atlas.W2']);
  // A plan declared in requires[].plans enters D (UNKNOWN content kept, not "no plan"); the other is held.
  const plans = JSON.parse(readFileSync(path.join(dir, 'plan-projection.json'), 'utf8'));
  assert.deepEqual([plans.frames[0].status, plans.frames[0].plans], ['unknown', null]);
  const [plan, ...others] = plans.frames.at(-1).plans;
  assert.equal(others.length, 0);
  assert.deepEqual([plan.plan, plan.ref, plan.version, plan.serves, plan.nodes, plan.unknown, plan.premise],
    ['resources#25:windows-retirement-migration-20261016', 'resources#25', '3', ['merged'], null, ['flowchart-absent', 'exit-table-absent'], 'current']);
  const gPlan = rows(readFileSync(gEvents, 'utf8')).find(event => event.plan === 'resources#25:windows-migration-preparation-scope-20261017');
  assert.deepEqual(rows(readFileSync(path.join(dir, 'g-plans.jsonl'), 'utf8')),
    [{ reason: 'no purpose.set declares this plan in requires[].plans', plan: gPlan }]);
  assert.equal(receipt.held_plans.count, 1);
  // The whole-Purpose UNKNOWN unit names its source and the conditions that keep it open.
  // (Before any observation every condition is unknown, so the whole evaluation is unknown.)
  assert.equal(world.frames.at(-1).entities.filter(value => value.ref.kind === 'unresolved-change').length, 0, 'known unmet: no UNKNOWN unit');
  const unit = world.frames[0].entities.find(value => value.ref.kind === 'unresolved-change');
  assert.equal(unit.label, '全体評価\n未確認');
  assert.match(unit.summary, /adrs-ci/u);
});

test('fromG keeps targets opaque, passes <target>:session as Agent activity, and fails closed', () => {
  const event = { kind: 'observation', target: 'x#1:pr.state', value: 'OPEN', source: { ref: 'gh', sha256: 'sha256:' + '0'.repeat(64) },
    observedAt: '2026-10-16T00:00:00Z', recordedAt: '2026-10-16T00:00:00Z' };
  assert.deepEqual(fromG(event).events.map(value => value.target), [{ kind: 'state', id: 'x#1:pr.state' }]);
  assert.deepEqual(fromG({ ...event, value: 'UNKNOWN' }).events[0].value, { G: 'UNKNOWN' });
  assert.deepEqual(fromG({ ...event, target: 'atlas.W:session', value: 'transcript-only' }).events.map(value => [value.target, value.value]),
    [[{ kind: 'state', id: 'atlas.W:session' }, 'transcript-only'], [{ kind: 'session', id: 'atlas.W' }, 'transcript-only']]);
  assert.equal(fromG({ ...event, target: ':session' }).events.length, 1);
  // A declared plan that D's parser rejects is held with D's reason, never forced in.
  const purposes = rows(readFileSync(file('../fixtures/live/purpose.jsonl'), 'utf8'));
  const bad = { kind: 'plan.set', plan: 'resources#25:windows-retirement-migration-20261016', version: 1, recordedAt: '2026-10-16T20:40:00Z',
    source: { repo: 'resources#25', commentId: null, updatedAt: '2026-10-16T20:00:00Z', sha256: 'sha256:' + '1'.repeat(64) },
    nodes: [{ id: 'resources#25:A', label: 'A', shape: 'rect', groups: [], owner: 'UNKNOWN', exit: 'UNKNOWN', predicate: 'UNKNOWN', requires: 'UNKNOWN' }],
    edges: [], exits: 'UNKNOWN', unknown: [] };
  assert.match(fromG(bad, purposes).held.reason, /outside v1/u);
  assert.throws(() => fromG({ ...event, extra: 1 }), /unsupported G event/u);
  assert.throws(() => fromG({ kind: 'purpose.set' }), /unsupported G event/u);
});
