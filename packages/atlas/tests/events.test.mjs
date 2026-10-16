import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAtlas, closureDocument } from '../events.mjs';
import { reduceClosure } from '../closure.mjs';
import { semanticScopeWorld } from '../semantic-scope-world.mjs';
import { frameCrossings as crossingPairs, worldCrossings } from './crossings.mjs';

const frameCrossings = (world, frame) => crossingPairs(world, frame).length;

const read = name => readFileSync(new URL('../fixtures/events/' + name, import.meta.url), 'utf8');
const EVENTS = read('events.jsonl'), CONTROL = read('control.jsonl');
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';
const base = () => rows(EVENTS);
const derive = (list = base(), control = CONTROL) => deriveAtlas(jsonl(list), typeof control === 'string' ? control : jsonl(control));
const rejects = (list, pattern, control = CONTROL) => assert.throws(() => derive(list, control), pattern);
const last = result => result.world.frames.at(-1);
const at = (result, iso) => result.world.frames.find(frame => frame.asOf === iso);
const entity = (frame, kind, id) => frame.entities.find(value => value.ref.kind === kind && value.ref.id === id);
const ofKind = (frame, kind) => frame.entities.filter(value => value.ref.kind === kind);
const condition = (result, id, index = -1) => result.derived.frames.at(index).conditions.find(value => value.id === id);
const scopeStatus = (frame, id) => entity(frame, 'semantic-scope', 'scope.' + id)?.flags.find(flag => flag.startsWith('scope_status='));
const v2 = list => list.find(event => event.version === 'v2');
const obs = (t, kind, id, value, observedAt = t) => ({ kind: 'observation', recordedAt: t, target: { kind, id }, value, source: 'test:obs', observedAt });
const T5 = '2026-10-16T05:00:00.000Z';
const planFrame = (result, iso) => result.plans.frames.find(frame => frame.asOf === iso);
const node = (result, iso, id) => planFrame(result, iso).plans.flatMap(plan => plan.nodes).find(value => value.id === id);
const withoutPlans = list => list.filter(event => event.kind !== 'plan.set');
// The Gap of one frame. Closure history rows differ only because a plan-only t is itself a frame coordinate.
const gapView = frame => ({ coverage: frame.coverage, entities: frame.entities,
  relations: frame.relations.map(value => value.context?.closureRecords ? { ...value, context: { ...value.context, closureRecords: null } } : value) });

// Fixed World hash of the committed synthetic fixture (CLI world.json bytes). Inputs are
// unchanged; it moved from c3d26682… when captions became full text and the Current -> unit
// relations became visible:false behind one drawn gap:current-target relation; then from ac64eef7…
// when the UNKNOWN evaluation unit named its source (全体評価/比較・分解/対応付け) and open conditions.
const WORLD_SHA256 = 'sha256:e8b707fd0d15443e2162a19fe41b4d1239c5f2dbf7b1d2c561120c2d96287deb';

test('parser fails closed on schema, shape, duplicate keys, order and graph errors', () => {
  const list = base();
  assert.throws(() => deriveAtlas(EVENTS.replace('"source_mode":"synthetic"', '"source_mode":"real"'), CONTROL), /source_mode/u);
  rejects([...list, { kind: 'observation.extra', recordedAt: T5 }], /unknown event kind/u);
  rejects(list.map((event, index) => index === 2 ? { ...event, extra: 1 } : event), /expected exactly/u);
  assert.throws(() => deriveAtlas(EVENTS.replace('"kind":"observation","recordedAt"', '"kind":"observation","kind":"observation","recordedAt"'), CONTROL), /duplicate JSON key/u);
  rejects([...list, obs('2026-10-16T04:59:00Z', 'state', 'x', 'y')], /backwards/u);
  rejects(list.map(event => event.version === 'v1' ? { ...event, requires: [{ ...event.requires[0], maxAge: '72h' }] } : event), /maxAge/u);
  const plan = structuredClone(list.find(event => event.source?.ref === 'apps#95'));
  rejects(list.map(event => event.source?.ref === 'apps#95' ? { ...plan, nodes: [{ ...plan.nodes[0], id: 'K' }] } : event), /qualified/u);
  rejects(list.map(event => event.source?.ref === 'apps#95' ? { ...plan, edges: [...plan.edges, { from: 'apps#95:R', to: 'apps#95:K', kind: 'dep' }] } : event), /acyclic/u);
  rejects(list.map(event => event.source?.ref === 'apps#95' ? { ...plan, purposeRef: { ...plan.purposeRef, version: 'v9' } } : event), /purposeRef/u);
  rejects(list.map(event => event.source?.ref === 'apps#95' ? { ...plan, nodes: plan.nodes.map((value, index) => index ? value : { ...value, predicateRefs: ['g6i3-fork'] }) } : event), /outside v2/u);
  rejects(list, /unique norm id/u, CONTROL + CONTROL.split('\n')[1] + '\n');
  rejects(list, /control schema/u, CONTROL.replace('atlas.control-norms/1', 'atlas.control/9'));
});

test('future facts are rejected: observedAt or plan body updatedAt after recordedAt', () => {
  rejects([...base(), obs(T5, 'state', 'windows.repo', 'windows archived', '2026-10-16T05:00:01Z')], /future fact/u);
  const list = base(), plan = list.find(event => event.source?.ref === 'apps#95');
  plan.source.updatedAt = '2026-10-16T04:00:01Z';
  rejects(list, /future fact/u);
});

test('one frame per recordedAt t up to now; every frame passes the existing adapter, also as one whole input', () => {
  const result = derive();
  const times = [...new Set(base().slice(1).map(event => new Date(event.recordedAt).toISOString()))];
  assert.deepEqual(result.world.frames.map(frame => frame.asOf), times);
  assert.equal(result.derived.now, times.at(-1));
  assert.equal(result.world.kind, 'ui.atlasWorldInput.v1');
  for (const frame of result.world.frames) assert.equal(ofKind(frame, 'purpose-state-current').length, 1, 'one Current per frame');
  // The existing adapter also accepts the whole derived input with the full reduced Closure.
  const whole = semanticScopeWorld(result.input, reduceClosure(result.closure));
  assert.equal(whole.frames.length, times.length);
  // Per-frame Closure is a prefix: past frames never carry later Current/Ideal rows.
  const firstRows = reduceClosure(closureDocument(result.derived, 0));
  assert.ok(!firstRows.includes('ideal.v2') && !firstRows.includes('current@' + T5));
});

test('changing only the Purpose: Scopes and responsibility follow; observed record is unchanged', () => {
  const list = base(), purpose = v2(list);
  purpose.requires = [...purpose.requires.filter(value => value.id !== 'voice-perf'), structuredClone(list[1].requires[0])];
  const before = derive(), after = derive(list);
  const scopes = frame => ofKind(frame, 'semantic-scope').map(value => value.ref.id);
  assert.ok(scopes(last(after)).includes('scope.g6i3-fork') && !scopes(last(before)).includes('scope.g6i3-fork'));
  assert.equal(relationOwner(last(after), 'scope.g6i3-fork'), 'nixos.W');
  assert.equal(ofKind(last(before), 'unassigned-change').length, 1);
  assert.equal(ofKind(last(after), 'unassigned-change').length, 0);
  for (const id of ['nixos', 'refactor', 'atlas', 'input', 'envs']) assert.deepEqual(condition(after, id).judgment, condition(before, id).judgment);
  assert.deepEqual(after.input.frames.at(-1).agent_activity, before.input.frames.at(-1).agent_activity);
  assert.deepEqual(after.derived.frames.at(-1).history, before.derived.frames.at(-1).history);
});
const relationOwner = (frame, scopeId) => frame.relations.find(value => value.ref.id === 'owner:' + scopeId)?.context.declared_id;

test('changing only an observation changes the Gap, not Scopes or owners', () => {
  const list = base().map(event => event.target?.id === 'windows.repo' ? { ...event, value: 'windows archived' } : event);
  const before = last(derive()), after = last(derive(list));
  assert.equal(scopeStatus(before, 'refactor'), 'scope_status=unmet');
  assert.equal(scopeStatus(after, 'refactor'), 'scope_status=declared_satisfied');
  assert.ok(entity(after, 'semantic-scope', 'scope.refactor').flags.includes('standing=completed-history'));
  assert.deepEqual(ofKind(after, 'semantic-scope').map(value => value.ref.id), ofKind(before, 'semantic-scope').map(value => value.ref.id));
  assert.equal(relationOwner(after, 'scope.refactor'), relationOwner(before, 'scope.refactor'));
});

test('no observation is UNKNOWN; an observation older than maxAge is UNKNOWN', () => {
  const result = derive();
  assert.deepEqual([condition(result, 'envs').judgment.state, condition(result, 'envs').judgment.reason], ['unknown', 'no-observation']);
  assert.equal(scopeStatus(last(result), 'envs'), 'scope_status=unknown');
  const fresh = [...base(), obs('2026-10-16T06:00:00Z', 'state', 'envs.scope', 'scope claimed')];
  assert.equal(condition(derive(fresh), 'envs').judgment.state, 'satisfied');
  const stale = [...fresh, obs('2026-10-17T06:00:01Z', 'session', 'envs.W', '待機')]; // PT24H window passed
  assert.deepEqual([condition(derive(stale), 'envs').judgment.state, condition(derive(stale), 'envs').judgment.reason], ['unknown', 'stale']);
  assert.equal(scopeStatus(last(derive(stale)), 'envs'), 'scope_status=unknown');
  const unmatchable = [...base(), obs('2026-10-16T06:00:00Z', 'state', 'envs.scope', 1)];
  assert.equal(condition(derive(unmatchable), 'envs').judgment.reason, 'unmatchable');
});

test('reachability alone never satisfies a condition or a plan node', () => {
  const list = base(), plan = list.find(event => event.source?.ref === 'apps#95');
  // A satisfied contributor and completed predecessors do not make atlas or R satisfied.
  plan.nodes.push({ id: 'apps#95:X', label: 'X', norm: 'norm.atlas', exit: 'nixos 済み', predicateRefs: ['nixos'], contributesTo: ['atlas'] });
  plan.nodes.push({ id: 'apps#95:Y', label: 'Y', norm: 'norm.atlas', exit: '自然文', contributesTo: ['atlas'] });
  plan.edges.push({ from: 'apps#95:X', to: 'apps#95:Y', kind: 'dep' });
  const result = derive(list), iso = '2026-10-16T04:00:00.000Z';
  assert.equal(node(result, iso, 'apps#95:X').state, 'satisfied');
  assert.deepEqual([node(result, iso, 'apps#95:Y').state, node(result, iso, 'apps#95:Y').blockedBy.deps], ['unknown', []]);
  assert.equal(result.derived.frames.find(frame => frame.asOf === iso).conditions.find(value => value.id === 'atlas').judgment.state, 'unknown');
});

test('no name/prefix inference: lookalike ids, targets and actors derive nothing (0 cases)', () => {
  const list = [...base(),
    obs('2026-10-16T06:00:00Z', 'state', 'envs', 'scope claimed'), // condition id, not its declared target
    obs('2026-10-16T06:00:00Z', 'state', 'envs.scope:extra', 'scope claimed'), // prefix of the declared target
    obs('2026-10-16T06:00:00Z', 'session', 'voice-perf.W', '実行中'), // actor named like the unowned condition
    obs('2026-10-16T06:00:00Z', 'owner', 'voice-perf', 'voice-perf.W')]; // a claim without a Norm basis
  const before = derive(), after = derive(list);
  const inferred = ['envs', 'voice-perf'].filter(id => condition(after, id).judgment.state !== condition(before, id).judgment.state
    || condition(after, id).responsibility.state !== condition(before, id).responsibility.state);
  assert.deepEqual(inferred, []);
  assert.equal(condition(after, 'voice-perf').responsibility.reason, 'norm-not-found');
  assert.equal(entity(last(after), 'agent', 'voice-perf.W'), undefined);
});

test('superseded obligations keep the value frozen at archive time (v1 satisfied stays satisfied)', () => {
  const list = [...base(), obs('2026-10-19T00:00:00Z', 'state', 'meltype.fork-release', 'revoked'), obs('2026-10-20T00:00:00Z', 'state', 'resources#29', 'reverted')];
  const result = derive(list);
  for (const frame of result.derived.frames.filter(value => value.purpose.version === 'v2'))
    assert.deepEqual(frame.history.map(value => [value.id, value.state, value.archivedAt]),
      [['v1:g6i3-fork', 'satisfied', '2026-10-16T03:00:00.000Z'], ['v1:nixos-console', 'satisfied', '2026-10-16T03:00:00.000Z']]);
  const duty = entity(last(result), 'obligation', 'v1:g6i3-fork');
  assert.equal(JSON.parse(duty.summary).state, 'satisfied');
  assert.equal(condition(result, 'nixos').judgment.state, 'unmet', 'the live condition follows the new observation');
});

test('loop re-entry carries an iteration number; it is not a new node', () => {
  const list = [...base(), obs('2026-10-16T06:00:00Z', 'state', 'atlas.hq-loop', 'HQ loop PASS'),
    obs('2026-10-16T07:00:00Z', 'state', 'atlas.hq-loop', 'R rejected')];
  const result = derive(list);
  assert.deepEqual(['05', '06', '07'].map(h => node(result, `2026-10-16T${h}:00:00.000Z`, 'apps#95:D')).map(value => [value.instance, value.state, value.reentry]),
    [['apps#95:D#1', 'unmet', false], ['apps#95:D#1', 'satisfied', false], ['apps#95:D#2', 'unmet', true]]);
  assert.equal(node(result, '2026-10-16T07:00:00.000Z', 'apps#95:R').iteration, 2);
  assert.equal(node(result, '2026-10-16T07:00:00.000Z', 'apps#95:K').iteration, 1);
  const loop = planFrame(result, '2026-10-16T07:00:00.000Z').plans.find(plan => plan.ref === 'apps#95').loops[0];
  assert.deepEqual([loop.from, loop.to, loop.iteration, loop.reentries], ['apps#95:R', 'apps#95:D', 2, 1]);
});

test('no plan is UNKNOWN, never an empty plan list', () => {
  const frames = derive(withoutPlans(base())).plans.frames;
  assert.ok(frames.every(frame => frame.status === 'unknown' && frame.plans === null && frame.reason));
  assert.equal(planFrame(derive(), '2026-10-15T09:00:00.000Z').plans, null);
});

test('a past t uses the plan version recorded at that t; revising a plan never changes the Gap', () => {
  const list = base(), revised = structuredClone(list.find(event => event.source?.ref === 'apps#95'));
  Object.assign(revised, { recordedAt: '2026-10-16T06:00:00Z', version: 'p2' });
  revised.source = { ...revised.source, updatedAt: '2026-10-16T05:30:00Z', digest: 'sha256:' + 'b'.repeat(64) };
  revised.nodes = revised.nodes.filter(value => value.id !== 'apps#95:V');
  revised.edges = revised.edges.filter(edge => edge.from !== 'apps#95:V');
  const result = derive([...list, revised]);
  const version = iso => planFrame(result, iso).plans.find(plan => plan.ref === 'apps#95').version;
  assert.deepEqual([version(T5), version('2026-10-16T06:00:00.000Z')], ['p1', 'p2']);
  assert.ok(node(result, T5, 'apps#95:V') && !node(result, '2026-10-16T06:00:00.000Z', 'apps#95:V'));
  // Same t, with and without any plan.set: identical Current, Gap and coverage.
  const bare = derive(withoutPlans(base()));
  for (const frame of bare.world.frames) assert.deepEqual(gapView(at(result, frame.asOf)), gapView(frame), frame.asOf);
  // A plan-only t repeats the previous Gap; only the frame coordinate differs.
  assert.equal(JSON.stringify(gapView(at(result, '2026-10-16T06:00:00.000Z'))).replaceAll('2026-10-16T06:00:00.000Z', T5), JSON.stringify(gapView(last(bare))));
  assert.deepEqual(v2(base()).requires, v2([...list, revised]).requires);
});

test('premise version mismatch is detected; natural-language-only nodes are UNKNOWN', () => {
  const result = derive();
  const premise = iso => planFrame(result, iso).plans.find(plan => plan.ref === 'apps#93').premise;
  assert.deepEqual([premise('2026-10-16T02:00:00.000Z'), premise(T5)], ['current', 'premise-version-mismatch']);
  assert.deepEqual([node(result, T5, 'apps#95:K').state, node(result, T5, 'apps#95:K').reason], ['unknown', 'natural-language-only']);
  const d = node(result, T5, 'apps#95:D');
  assert.deepEqual([d.state, d.blockedBy, d.overdue], ['unmet', { predicates: ['atlas'], deps: ['apps#95:K'] }, false]);
  assert.equal(node(result, T5, 'apps#95:K').overdue, null, 'no due, no overdue verdict');
  assert.equal(node(derive([...base(), obs('2026-10-17T00:00:01Z', 'session', 'atlas.W', '実行中')]), '2026-10-17T00:00:01.000Z', 'apps#95:D').overdue, true);
});

test('future plan nodes never enter the Current, the Gap or coverage', () => {
  const world = JSON.stringify(derive().world);
  for (const id of ['apps#95:', 'apps#93:', 'K：イベント']) assert.ok(!world.includes(id), id);
});

test('unassigned units merge only for the same meaning', () => {
  const one = last(derive([...base(), obs('2026-10-16T06:00:00Z', 'state', 'voice-perf.baseline', 'slow')]));
  assert.deepEqual(ofKind(one, 'unassigned-change').map(value => value.ref.id), ['voice-perf'], 'uncovered part and residual are one unit');
  const list = base(), purpose = v2(list);
  purpose.requires.push({ ...structuredClone(purpose.requires.find(value => value.id === 'voice-perf')), id: 'voice-perf-2' });
  assert.deepEqual(ofKind(last(derive(list)), 'unassigned-change').map(value => value.ref.id), ['voice-perf', 'voice-perf-2'], 'same label, different condition');
});

test('responsibility conflict from Norm or observation stays an explicit unassigned conflict', () => {
  const control = rows(CONTROL).map(row => row.id === 'norm.envs' ? { ...row, W: ['envs.W', 'envs.W2'] } : row);
  const frame = last(derive(base(), control));
  assert.ok(entity(frame, 'unassigned-change', 'envs').flags.includes('source=owner-conflict'));
  assert.match(entity(frame, 'unassigned-change', 'envs').label, /未割当・矛盾/u);
  const claimed = derive([...base(), obs('2026-10-16T06:00:00Z', 'owner', 'atlas', 'refactor.W')]);
  assert.deepEqual(condition(claimed, 'atlas').responsibility.candidates, ['atlas.W', 'refactor.W']);
  const confirmed = derive([...base(), obs('2026-10-16T06:00:00Z', 'owner', 'atlas', 'atlas.W')]);
  assert.equal(condition(confirmed, 'atlas').responsibility.reason, 'norm-and-observation');
});

test('Agent heading and flags come from the declared source mode and session observations', () => {
  const result = derive();
  assert.equal(result.world.presentation.areas[2].label, 'Agent：宣言された担当（合成・一部観測）');
  const agent = entity(last(result), 'agent', 'atlas.W');
  assert.deepEqual(agent.flags, ['synthetic', 'declared', 'activity-observed']);
  assert.equal(agent.time.observedAt, T5.replace('.000', ''));
  assert.match(agent.summary, /実行中.*host:g6i3-own/u);
  assert.deepEqual(entity(last(result), 'agent', 'atlas.D:derive').flags, ['synthetic', 'declared-only', 'activity-unobserved']);
  const supplied = deriveAtlas(jsonl(base().filter(event => event.target?.kind !== 'session')).replace('"synthetic"', '"supplied"'), CONTROL);
  assert.equal(supplied.world.presentation.areas[2].label, 'Agent：宣言された担当（供給・未観測）');
  assert.ok(ofKind(last(supplied), 'agent').every(value => value.flags[0] === 'supplied'));
});

test('overview crossings: 0 in every frame; the omitted Current -> unit relations are what would cross', () => {
  const result = derive();
  assert.deepEqual(worldCrossings(result.world).map(value => value.crossings), result.world.frames.map(() => 0));
  // Interleaved owners (A, B, A) are grouped by owner, so owner relations stay uncrossed.
  const control = rows(CONTROL).map(row => row.id === 'norm.atlas' ? { ...row, binding: { ...row.binding, conditions: ['atlas'] } }
    : row.id === 'norm.refactor' ? { ...row, binding: { ...row.binding, conditions: ['refactor', 'input'] } } : row);
  const list = base(); v2(list).requires.find(value => value.id === 'input').norm = 'norm.refactor';
  const interleaved = derive(list, control);
  assert.deepEqual(ofKind(last(interleaved), 'semantic-scope').map(value => value.ref.id), ['scope.nixos', 'scope.refactor', 'scope.input', 'scope.atlas', 'scope.envs']);
  assert.equal(frameCrossings(interleaved.world, last(interleaved)), 0);
  // Drawing every Current -> unit relation again restores the fan that crossed (the previous contract).
  const redrawn = structuredClone(result.world);
  for (const frame of redrawn.frames) for (const value of frame.relations) if (value.ref.id.startsWith('change:')) delete value.visible;
  assert.ok(frameCrossings(redrawn, redrawn.frames.at(-1)) > 0);
  for (const frame of result.world.frames) assert.ok(frame.entities.every(value => !value.label.includes('…')), frame.id);
});

test('committed synthetic fixture World hash is fixed; CLI writes the same bytes', () => {
  const world = JSON.stringify(derive().world, null, 2) + '\n';
  assert.equal('sha256:' + createHash('sha256').update(world).digest('hex'), WORLD_SHA256);
  const out = mkdtempSync(path.join(tmpdir(), 'atlas-derive-'));
  const cli = fileURLToPath(new URL('../derive.mjs', import.meta.url));
  const receipt = JSON.parse(execFileSync(process.execPath, [cli, '--out-dir=' + out,
    fileURLToPath(new URL('../fixtures/events/events.jsonl', import.meta.url)), fileURLToPath(new URL('../fixtures/events/control.jsonl', import.meta.url))], { encoding: 'utf8' }));
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.outputs.find(value => path.basename(value.path) === 'world.json').sha256, WORLD_SHA256);
  assert.equal(readFileSync(path.join(out, 'world.json'), 'utf8'), world);
  assert.equal(JSON.parse(readFileSync(path.join(out, 'plan-projection.json'), 'utf8')).schema, 'atlas.plan-projection/1');
  assert.throws(() => execFileSync(process.execPath, [cli, '--out-dir=' + out, cli, cli], { stdio: 'pipe' }));
  assert.equal(readFileSync(path.join(out, 'world.json'), 'utf8'), world, 'invalid input never replaces output');
});
