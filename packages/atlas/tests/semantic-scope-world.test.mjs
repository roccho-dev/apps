import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { semanticScopeWorld } from '../semantic-scope-world.mjs';

// The override is only for artifact-only preliminary checks against the actual
// captured dependency. Published-source tests use the owning package by default.
const closureRoot = process.env.ATLAS_CLOSURE_INPUT_ROOT
  ? pathToFileURL(process.env.ATLAS_CLOSURE_INPUT_ROOT.replaceAll('\\', '/') + '/')
  : new URL('../', import.meta.url);
const { reduceClosure } = await import(new URL('closure.mjs', closureRoot));
const reduced = reduceClosure(...['purpose.jsonl', 'current.jsonl'].map(name => readFileSync(new URL('fixtures/' + name, closureRoot), 'utf8')));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/semantic-scopes.json', import.meta.url), 'utf8'));
const build = value => semanticScopeWorld(value, reduced);
const relation = (frame, id) => frame.relations.find(value => value.ref.id === id);
const targetContext = frame => relation(frame, 'target-purpose').context;
const ofKind = (frame, kind) => frame.entities.filter(value => value.ref.kind === kind);
const current = frame => { const all = ofKind(frame, 'purpose-state-current'); assert.equal(all.length, 1); return all[0]; };
const scope = (frame, id = 'scope.delivery') => frame.entities.find(value => value.ref.kind === 'semantic-scope' && value.ref.id === id);
const unresolvedUnit = (frame, id = 'unknown-evaluation') => frame.entities.find(value => value.ref.kind === 'unresolved-change' && value.ref.id === id);
const breakObservedBinding = semantic => { semantic.bindings.observed.state_ref = { ...semantic.bindings.observed.state_ref, revision: 'old-observed' }; };
// The current Gap: active Scopes plus explicit unassigned/unresolved units.
const currentGap = frame => frame.entities.filter(value => value.flags.includes('standing=active')
  || ['unassigned-change', 'unresolved-change'].includes(value.ref.kind)).map(value => value.ref.kind + ':' + value.ref.id);
// Uncertain units: unassigned, unresolved/unknown/conflict units, and Scopes whose own
// status is unknown/conflict or whose standing is unresolved (read from the flags).
const uncertainUnits = frame => frame.entities.filter(value => ['unassigned-change', 'unresolved-change'].includes(value.ref.kind)
  || (value.ref.kind === 'semantic-scope' && ['scope_status=unknown', 'scope_status=conflict', 'standing=unresolved'].some(flag => value.flags.includes(flag))))
  .map(value => value.ref.kind + ':' + value.ref.id);
// A second Scope owning the regressed part, built within the existing contract.
const twoScopes = () => {
  const input = structuredClone(fixture), semantic = input.frames[1].semantic;
  semantic.comparison.parts.find(part => part.id === 'recovery').verdict = 'change';
  semantic.partition.push({ ...structuredClone(semantic.partition[0]), id: 'scope.recovery', label: '回復の責任', parts: ['recovery'],
    owner_actor: 'counter-W2', criteria: { recovery: ['criterion.recovery'] } });
  semantic.observation.criteria.push({ ...structuredClone(semantic.observation.criteria[0]), id: 'criterion.recovery', state: 'unmet' });
  return input;
};

test('same actual reducer output and semantic input produce deterministic authority=false World', () => {
  const saved = structuredClone(fixture), a = build(fixture), b = build(fixture);
  assert.deepEqual(a, b); assert.deepEqual(fixture, saved);
  assert.equal(a.kind, 'ui.atlasWorldInput.v1'); assert.equal(a.authority, false);
  assert.equal(a.frames.length, 2);
  const binding = targetContext(a.frames[1]).binding;
  assert.equal(binding.state, 'declared-bound');
  assert.deepEqual([binding.purpose.id, binding.current.id, ...binding.target.map(value => value.id), binding.observed.id],
    ['purpose.operations', 'current.before', 'ideal.extraction', 'ideal.source', 'current.after']);
});

test('exactly three areas Purpose / Scopes / Agents; no delta, second Current or legacy pane', () => {
  const world = build(fixture);
  assert.deepEqual(world.presentation.areas.map(area => [area.id, area.order]), [['purpose', 0], ['scopes', 1], ['agents', 2]]);
  for (const frame of world.frames) {
    assert.ok(frame.entities.every(value => ['purpose', 'scopes', 'agents'].includes(value.area)));
    for (const kind of ['semantic-delta', 'purpose-state-observed']) assert.equal(ofKind(frame, kind).length, 0, kind);
    assert.equal(frame.entities.filter(value => value.ref.space === 'atlas.purpose-closure/1').length, 0);
    assert.ok(frame.relations.every(value => value.containment === null), 'no containment is invented');
  }
});

test('one Current per frame: same identity, frame-selected revision, original comparison kept as history', () => {
  const world = build(fixture);
  const [before, after] = world.frames.map(current);
  assert.deepEqual(before.ref, after.ref);
  assert.ok(before.flags.includes('revision=current-before@1'));
  assert.ok(after.flags.includes('revision=post-observation@2'));
  assert.match(before.summary, /^現状 current-before@1 · observed-bound · /u);
  assert.match(after.summary, /^現状 post-observation@2 · observed-bound · /u);
  assert.match(after.summary, /元の比較の現状: current-before@1/u);
  for (const [index, frame] of world.frames.entries()) {
    const context = targetContext(frame);
    assert.deepEqual(context.original_current_ref, fixture.frames[index].semantic.comparison.current_ref);
    assert.deepEqual(context.current_revision, fixture.frames[index].semantic.observation.observed_ref);
    assert.ok(current(frame).flags.includes('standing=observed-bound'));
  }
});

test('overview captions are two full lines, never shortened; every supplied label, id and revision stays in the record', () => {
  for (const [index, frame] of build(fixture).frames.entries()) {
    const supplied = fixture.frames[index];
    for (const value of frame.entities) {
      const lines = value.label.split('\n');
      assert.ok(lines.length === 2 && lines.every(line => line.trim()) && !value.label.includes('…'), value.label);
    }
    // The second line is the full supplied text (the UI wraps; no ellipsis or id-tail elision).
    assert.equal(ofKind(frame, 'purpose')[0].label, '目的\n' + supplied.purpose_label);
    assert.equal(current(frame).label, '現状\n' + supplied.semantic.observation.observed_ref.revision);
    assert.equal(scope(frame).label.split('\n')[0], supplied.semantic.partition[0].label);
    for (const unit of ofKind(frame, 'unassigned-change')) assert.equal(unit.label.split('\n')[1], unit.ref.id);
    for (const agent of ofKind(frame, 'agent')) assert.equal(agent.label.split('\n')[0], agent.ref.id);
    // Overview order: Target next to Purpose; old obligations before the current
    // units; the owner Agent before the evaluator.
    const ordered = area => frame.entities.filter(value => value.area === area).sort((a, b) => a.order - b.order).map(value => value.ref.kind + ':' + value.ref.id);
    assert.deepEqual(ordered('purpose'), ['purpose:purpose.operations', 'purpose-state-target:purpose.operations:target', 'purpose-state-current:purpose.operations:current']);
    assert.deepEqual(ordered('scopes'), ['obligation:old-source-duty', 'semantic-scope:scope.delivery',
      ...(index === 1 ? ['unassigned-change:criterion.recovery'] : [])]);
    assert.deepEqual(ordered('agents'), ['agent:fixture-W', 'agent:fixture-independent-R']);
    assert.ok(ofKind(frame, 'purpose')[0].summary.startsWith(supplied.purpose_label));
    assert.ok(ofKind(frame, 'purpose-state-target')[0].summary.startsWith(supplied.target_label));
    assert.ok(current(frame).summary.includes(supplied.post_label));
    assert.ok(scope(frame).summary.startsWith(supplied.semantic.partition[0].label));
    for (const agent of ofKind(frame, 'agent')) assert.ok(agent.summary.startsWith(agent.ref.id + ' · '));
    for (const unit of ofKind(frame, 'unassigned-change')) assert.ok(unit.summary.startsWith('未割当: ' + unit.ref.id));
    for (const duty of ofKind(frame, 'obligation')) assert.deepEqual(JSON.parse(duty.summary), supplied.semantic.history.find(value => value.id === duty.ref.id));
  }
  assert.match(current(build(fixture).frames[1]).summary, /current-before@1 t0\/t1比較は同じ選択版を維持/u);
});

test('target is a role in each observation frame, never a later actual observation', () => {
  const world = build(fixture);
  assert.deepEqual(world.frames.map(frame => [frame.id, frame.rev, frame.asOf]), fixture.frames.map(frame => [frame.id, frame.rev, frame.asOf]));
  for (const frame of world.frames) {
    const target = ofKind(frame, 'purpose-state-target');
    assert.equal(target.length, 1);
    assert.equal(target[0].time.effectiveAt, null); assert.equal(target[0].time.observedAt, null);
  }
});

test('later captures never mint or freshen times; only an explicit observed_at times the Current', () => {
  const input = structuredClone(fixture);
  input.frames[1].asOf = '2026-01-02T20:00:00Z';
  const world = build(input);
  for (const frame of world.frames) {
    for (const kind of ['purpose-state-target', 'semantic-scope', 'obligation']) {
      const entity = ofKind(frame, kind)[0];
      assert.equal(entity.time.observedAt, null, kind);
      assert.equal(entity.time.effectiveAt, null, kind);
    }
    for (const id of ['target-purpose', 'scope:scope.delivery']) assert.equal(relation(frame, id).time.observedAt, null);
  }
  assert.equal(current(world.frames[0]).time.observedAt, fixture.frames[0].semantic.observation.observed_at);
  assert.equal(current(world.frames[1]).time.observedAt, fixture.frames[1].semantic.observation.observed_at);
  assert.notEqual(current(world.frames[1]).time.observedAt, world.frames[1].asOf);
  delete input.frames[1].semantic.observation.observed_at;
  assert.equal(current(build(input).frames[1]).time.observedAt, null);
});

test('Scope trace preserves exact pair, semantic basis, responsibility, criteria, evidence, residual, history and standing', () => {
  const world = build(fixture), frame = world.frames[1];
  const context = relation(frame, 'scope:scope.delivery').context;
  assert.deepEqual(context.scope.pair, fixture.frames[1].semantic.bindings.pair);
  assert.equal(context.scope.owner_actor, 'fixture-W');
  assert.equal(context.scope.owner_role, 'apps/Atlas');
  assert.deepEqual(context.scope.criteria.delivery, ['criterion.delivery']);
  assert.deepEqual(context.scope.required_evidence, ['independent-post-state']);
  assert.equal(context.closure.scope_status, 'declared_satisfied');
  assert.equal(context.closure.purpose_status, 'unmet');
  assert.deepEqual(context.closure.residual, ['criterion.recovery']);
  assert.deepEqual(context.history, fixture.frames[1].semantic.history);
  assert.equal(context.binding.state, 'declared-bound');
  assert.equal(context.standing, 'completed-history');
  assert.equal(context.scope_status, 'declared_satisfied');
  assert.equal(context.disagreement, undefined);
});

test('current Gap after re-observation: completed initial Scope is history, regression is an explicit unassigned unit', () => {
  const [before, after] = build(fixture).frames;
  // Before: the owned unmet criterion stays on its active Scope; nothing is unassigned.
  assert.ok(scope(before).flags.includes('standing=active'));
  assert.ok(scope(before).flags.includes('scope_status=unmet'));
  assert.deepEqual(currentGap(before), ['semantic-scope:scope.delivery']);
  assert.equal(relation(before, 'change:scope:scope.delivery').label, '変化');
  // After: delivery is a completed checkpoint, not current needed change; Purpose is not achieved.
  assert.ok(scope(after).flags.includes('standing=completed-history'));
  assert.equal(relation(after, 'change:scope:scope.delivery'), undefined);
  assert.ok(ofKind(after, 'purpose')[0].flags.includes('purpose_standing=unmet'));
  assert.deepEqual(currentGap(after), ['unassigned-change:criterion.recovery']);
  const units = ofKind(after, 'unassigned-change');
  assert.equal(units[0].area, 'scopes');
  assert.ok(units[0].flags.includes('owner-unassigned'));
  assert.equal(after.entities.filter(value => value.ref.id === 'recovery').length, 0, 'no name mapping to part recovery');
  const unitKey = JSON.stringify(units[0].ref), scopeKey = JSON.stringify(scope(after).ref);
  for (const value of after.relations) {
    const ends = [JSON.stringify(value.from), JSON.stringify(value.to)];
    assert.ok(!(ends.includes(unitKey) && ends.includes(scopeKey)), 'regression not attached to the completed duty');
    if (ends.includes(unitKey)) assert.notEqual(value.from.kind, 'agent', 'unassigned unit has no Agent edge');
  }
});

test('criterion-satisfied Scope named in the whole-Purpose residual stays a visible disagreement, not history', () => {
  const input = structuredClone(fixture);
  input.frames[1].semantic.observation.purpose_evaluation.residual = ['criterion.delivery'];
  const frame = build(input).frames[1];
  const context = relation(frame, 'scope:scope.delivery').context;
  assert.ok(scope(frame).flags.includes('standing=active'));
  assert.ok(scope(frame).flags.includes('scope_status=conflict'));
  assert.ok(scope(frame).flags.includes('evaluation-disagreement'));
  assert.equal(context.scope_status, 'conflict');
  assert.deepEqual(context.disagreement.criterion_level, [{ id: 'criterion.delivery', state: 'satisfied' }]);
  assert.deepEqual(context.disagreement.whole_purpose_residual, ['criterion.delivery']);
  // Both source declarations stay readable unchanged.
  assert.equal(context.closure.scope_status, 'declared_satisfied');
  assert.equal(context.closure.observation.criteria[0].state, 'satisfied');
  assert.deepEqual(context.closure.observation.purpose_evaluation.residual, ['criterion.delivery']);
  assert.equal(ofKind(frame, 'unassigned-change').length, 0);
  assert.deepEqual(currentGap(frame), ['semantic-scope:scope.delivery']);
});

test('a Purpose that is not declared satisfied never shows an empty current Gap; both declarations stay readable', () => {
  const whole = change => { const input = structuredClone(fixture); Object.assign(input.frames[1].semantic.observation.purpose_evaluation, change); return input; };
  const unknownBinding = structuredClone(fixture); breakObservedBinding(unknownBinding.frames[1].semantic);
  // [name, input, frame, Purpose standing, Scope standing, current Gap, coverage.unknown composition]
  const cases = [
    ['fixture Before', structuredClone(fixture), 0, 'unmet', 'active', ['semantic-scope:scope.delivery'], []],
    ['fixture After', structuredClone(fixture), 1, 'unmet', 'completed-history', ['unassigned-change:criterion.recovery'],
      ['unassigned-change:criterion.recovery']],
    ['P1 owned whole residual', whole({ residual: ['criterion.delivery'] }), 1, 'unmet', 'active', ['semantic-scope:scope.delivery'],
      ['semantic-scope:scope.delivery']],
    ['P2 conflict, no residual', whole({ state: 'conflict', residual: [] }), 1, 'conflict', 'completed-history',
      ['unresolved-change:purpose-evaluation-conflict'], ['unresolved-change:purpose-evaluation-conflict']],
    ['unmet, no residual', whole({ residual: [] }), 1, 'unknown', 'completed-history', ['unresolved-change:unknown-evaluation'],
      ['unresolved-change:unknown-evaluation']],
    ['unknown', whole({ state: 'unknown' }), 1, 'unknown', 'completed-history', ['unresolved-change:unknown-evaluation'],
      ['unresolved-change:unknown-evaluation']],
    ['satisfied, no residual', whole({ state: 'satisfied', residual: [] }), 1, 'declared_satisfied', 'completed-history', [], []],
    ['satisfied with unowned residual', whole({ state: 'satisfied', residual: ['criterion.recovery'] }), 1, 'conflict', 'completed-history',
      ['unassigned-change:criterion.recovery', 'unresolved-change:purpose-evaluation-conflict'],
      ['unassigned-change:criterion.recovery', 'unresolved-change:purpose-evaluation-conflict']],
    ['unknown binding', unknownBinding, 1, 'unknown', 'unresolved', ['unassigned-change:criterion.recovery', 'unresolved-change:unknown-evaluation'],
      ['semantic-scope:scope.delivery', 'unassigned-change:criterion.recovery', 'unresolved-change:unknown-evaluation']],
  ];
  for (const [name, input, index, purpose, standing, gap, uncertain] of cases) {
    const frame = build(input).frames[index];
    assert.equal(targetContext(frame).purpose_standing, purpose, name);
    assert.ok(scope(frame).flags.includes('standing=' + standing), name + ': the Scope checkpoint is kept, not relabelled');
    assert.deepEqual(currentGap(frame), gap, name);
    if (purpose !== 'declared_satisfied') assert.ok(gap.length > 0, name + ': no empty Gap');
    // coverage.unknown is not the whole current Gap: a known owned unmet Scope is not unknown.
    assert.deepEqual(uncertainUnits(frame), uncertain, name);
    assert.equal(frame.coverage.unknown, uncertain.length, name);
    const context = relation(frame, 'scope:scope.delivery').context;
    assert.deepEqual(context.closure.observation.purpose_evaluation, input.frames[index].semantic.observation.purpose_evaluation, name);
    assert.ok(context.closure.observation.criteria[0].evidence.length > 0, name);
    for (const id of ['purpose-evaluation-conflict', 'unknown-evaluation']) {
      if (!unresolvedUnit(frame, id)) continue;
      assert.equal(relation(frame, 'change:unresolved:' + id).path, false, name);
      assert.deepEqual(relation(frame, 'residual:unresolved:' + id).context.closure.observation.purpose_evaluation,
        input.frames[1].semantic.observation.purpose_evaluation, name);
    }
  }
  // Units derived from a conflicting whole evaluation say conflict, not plain unmet.
  const unit = ofKind(build(cases.find(([name]) => name === 'satisfied with unowned residual')[1]).frames[1], 'unassigned-change')[0];
  assert.ok(unit.flags.includes('source=whole-purpose-conflict'));
  assert.match(unit.label, /^未割当・矛盾\n/u);
});

test('several Scopes: each unit keeps its own standing and Gap membership', () => {
  // (a) Bound mapping: A is a completed checkpoint, B is the current needed change.
  const bound = build(twoScopes()).frames[1];
  assert.equal(targetContext(bound).closure.scope_status, 'unmet');
  assert.ok(scope(bound).flags.includes('standing=completed-history'));
  assert.equal(relation(bound, 'change:scope:scope.delivery'), undefined);
  assert.ok(scope(bound, 'scope.recovery').flags.includes('standing=active'));
  assert.ok(scope(bound, 'scope.recovery').flags.includes('scope_status=unmet'));
  assert.equal(relation(bound, 'change:scope:scope.recovery').path, true);
  assert.deepEqual(currentGap(bound), ['semantic-scope:scope.recovery']);
  assert.deepEqual(uncertainUnits(bound), [], 'a known owned unmet Scope is in the Gap but not unknown');
  assert.equal(bound.coverage.unknown, 0);
  assert.deepEqual(ofKind(bound, 'agent').map(value => value.ref.id), ['fixture-W', 'counter-W2', 'fixture-independent-R']);
  // (b) Unknown mapping: A stays unresolved with its evidence and declared status; B stays active.
  const unknown = twoScopes(); breakObservedBinding(unknown.frames[1].semantic);
  const unbound = build(unknown).frames[1];
  assert.ok(scope(unbound).flags.includes('standing=unresolved'));
  const evidence = relation(unbound, 'scope:scope.delivery').context;
  assert.equal(evidence.scope_status, 'declared_satisfied');
  assert.ok(evidence.closure.observation.criteria.find(value => value.id === 'criterion.delivery').evidence.length > 0);
  assert.ok(scope(unbound, 'scope.recovery').flags.includes('standing=active'));
  assert.ok(unresolvedUnit(unbound));
  assert.deepEqual(uncertainUnits(unbound), ['semantic-scope:scope.delivery', 'unresolved-change:unknown-evaluation']);
  assert.equal(unbound.coverage.unknown, 2);
  // (c) B's evidence unknown: A keeps its completed checkpoint, B is active and unknown.
  const stale = twoScopes();
  stale.frames[1].semantic.observation.criteria.find(value => value.id === 'criterion.recovery').evidence[0].fresh = false;
  const unknownB = build(stale).frames[1];
  assert.ok(scope(unknownB).flags.includes('standing=completed-history'));
  assert.ok(scope(unknownB, 'scope.recovery').flags.includes('standing=active'));
  assert.ok(scope(unknownB, 'scope.recovery').flags.includes('scope_status=unknown'));
  assert.deepEqual(uncertainUnits(unknownB), ['semantic-scope:scope.recovery']);
  assert.equal(unknownB.coverage.unknown, 1);
});

test('frame-bound text: Before rows never mention the After-only residual; the Scope relation exists in both frames', () => {
  const [before, after] = build(fixture).frames;
  assert.equal([...before.entities, ...before.relations].filter(value => JSON.stringify(value).includes('criterion.recovery')).length, 0);
  assert.ok([...after.entities, ...after.relations].some(value => JSON.stringify(value).includes('criterion.recovery')));
  const beforeContext = JSON.stringify(relation(before, 'scope:scope.delivery').context);
  assert.ok(beforeContext.includes('"residual":["criterion.delivery"]'));
  assert.ok(!beforeContext.includes('"residual":["criterion.recovery"]'));
  assert.ok(JSON.stringify(relation(after, 'scope:scope.delivery').context).includes('"residual":["criterion.recovery"]'));
});

test('Agents are only declared ids with declared roles, synthetic and activity-unobserved; missing is explicit', () => {
  for (const frame of build(fixture).frames) {
    const agents = frame.entities.filter(value => value.area === 'agents');
    assert.deepEqual(agents.map(value => [value.ref.kind, value.ref.id]), [['agent', 'fixture-W'], ['agent', 'fixture-independent-R']]);
    for (const agent of agents) {
      assert.deepEqual(agent.flags, ['synthetic', 'declared-only', 'activity-unobserved']);
      assert.equal(agent.activity, 'none');
    }
    assert.match(agents[0].summary, /owner_actor, writer/u);
    assert.equal(frame.entities.filter(value => value.ref.id === 'apps/Atlas').length, 0, 'owner_role is an attribute, not an Agent');
    assert.equal(relation(frame, 'owner:scope.delivery').context.owner_role, 'apps/Atlas');
    assert.deepEqual(relation(frame, 'observation-evaluator:fixture-independent-R').to, current(frame).ref);
    // Not drawn: the Current -> unit relations (summarised by one drawn Current -> Target
    // relation) and the two writer/evaluator role relations; their records stay complete.
    const notDrawn = frame.relations.filter(value => value.visible === false).map(value => value.ref.id);
    const changes = frame.id === 'before-work' ? ['change:scope:scope.delivery'] : ['change:unassigned:criterion.recovery'];
    assert.deepEqual(notDrawn, [...changes, 'observation-writer:fixture-W', 'observation-evaluator:fixture-independent-R']);
    const gap = relation(frame, 'gap:current-target');
    assert.deepEqual([gap.from, gap.to, gap.label, gap.path, gap.context.change_relations], [current(frame).ref,
      ofKind(frame, 'purpose-state-target')[0].ref, '変化 1 件', false, changes]);
    for (const id of changes) assert.equal(relation(frame, id).path, true, 'Direction keeps the omitted relation');
    // visible:false is the only representation change: each declared context is exactly the role declaration.
    const observation = fixture.frames.find(value => value.id === frame.id).semantic.observation;
    assert.deepEqual(relation(frame, 'observation-writer:fixture-W').context,
      { declared_id: 'fixture-W', role: 'writer', synthetic: true, activity: 'unobserved', observed_ref: observation.observed_ref });
    assert.deepEqual(relation(frame, 'observation-evaluator:fixture-independent-R').context,
      { declared_id: 'fixture-independent-R', role: 'evaluator', synthetic: true, activity: 'unobserved', observed_ref: observation.observed_ref });
    assert.ok(frame.relations.filter(value => !notDrawn.includes(value.ref.id)).every(value => !('visible' in value)),
      'owner, Current -> Target, Scope/Target/Purpose and history relations stay drawn');
    assert.match(agents[0].label, /\n担当・作業$/u);
    assert.match(agents[1].label, /\n評価$/u);
  }
  const input = structuredClone(fixture);
  input.frames[1].semantic.comparison.availability = 'unknown';
  input.frames[1].semantic.observation = null;
  const frame = build(input).frames[1];
  assert.equal(ofKind(frame, 'agent').length, 0);
  assert.deepEqual(ofKind(frame, 'agent-declaration').map(value => [value.ref.id, value.area, value.flags]), [['missing', 'agents', ['missing']]]);
});

test('unknown observed binding: Current unresolved, Purpose unknown, Scope evidence and declared status kept readable', () => {
  const input = structuredClone(fixture); breakObservedBinding(input.frames[1].semantic);
  const frame = build(input).frames[1];
  // 1. Declared but unbound: no fresh verified Current, and no fallback to the old revision.
  const now = current(frame);
  assert.ok(now.flags.includes('standing=unresolved'));
  assert.ok(now.flags.includes('revision=post-observation@2'));
  assert.equal(now.time.observedAt, null);
  // 2. Purpose cannot read achieved and the satisfied Scope is not promoted to history.
  assert.equal(targetContext(frame).purpose_standing, 'unknown');
  assert.ok(ofKind(frame, 'purpose')[0].flags.includes('purpose_standing=unknown'));
  assert.ok(unresolvedUnit(frame));
  assert.ok(scope(frame).flags.includes('standing=unresolved'));
  // 3. The bounded evidence checkpoint stays verbatim in Record context.
  const context = relation(frame, 'scope:scope.delivery').context;
  assert.equal(context.scope_status, 'declared_satisfied');
  assert.equal(context.closure.scope_status, 'declared_satisfied');
  assert.deepEqual(context.closure.observation, fixture.frames[1].semantic.observation);
  assert.ok(context.closure.observation.criteria[0].evidence.length > 0);
  // The unresolved Scope's relation states its standing, not current necessity.
  const unresolved = relation(frame, 'change:scope:scope.delivery');
  assert.equal(unresolved.label, '未確定');
  assert.equal(unresolved.context.necessity, 'unresolved');
  assert.equal(unresolved.context.standing, 'unresolved');
  assert.equal(unresolved.path, false);
});

test('missing or wrong-pair bindings stay unbound, no name/owner/ID-prefix inference', () => {
  for (const change of [semantic => { semantic.bindings = null; },
    semantic => { semantic.bindings.pair.target_ref = { ...semantic.bindings.pair.target_ref, revision: 'another-target' }; },
    semantic => { semantic.bindings.current.state_ref = { ...semantic.bindings.current.state_ref, revision: 'wrong-current' }; },
    breakObservedBinding]) {
    const input = structuredClone(fixture); change(input.frames[1].semantic);
    const frame = build(input).frames[1];
    assert.equal(targetContext(frame).binding.state, 'unknown');
    assert.equal(targetContext(frame).purpose_standing, 'unknown');
    assert.ok(unresolvedUnit(frame));
    assert.ok(!frame.entities.some(value => value.flags.includes('standing=completed-history')));
  }
});

test('same source ID at another revision or another Purpose does not join as the same state pair', () => {
  for (const change of [binding => { binding.current.sources[0].sourceDigest = 'sha256:' + '0'.repeat(64); },
    binding => { binding.current.sources[0].sourceRef = 'fixture:current@old'; },
    binding => { binding.purpose.id = 'purpose.reuse'; binding.purpose.sources = JSON.parse(reduced.split('\n').find(line => line.includes('"id":"purpose.reuse"'))).sources; },
    binding => { binding.target[1].state_ref = { ...binding.target[1].state_ref, revision: 'old-target' }; }]) {
    const input = structuredClone(fixture); change(input.frames[1].semantic.bindings);
    assert.equal(targetContext(build(input).frames[1]).binding.state, 'unknown');
  }
});

test('existing Closure rows survive verbatim as recoverable history; original contract is not rewritten', () => {
  const rows = reduced.trim().split('\n').slice(1).map(JSON.parse);
  for (const frame of build(fixture).frames) {
    const history = targetContext(frame).closureRecords;
    assert.equal(history.length, rows.length);
    for (const row of rows) assert.deepEqual(history.find(value => value.id === row.id), row);
    assert.equal(JSON.stringify(relation(frame, 'scope:scope.delivery').context).includes('closureRecords'), false);
  }
});

test('comparison status stays recoverable for partition, incomplete, undecomposed and unknown', () => {
  const variants = [['declared_partition', () => {}],
    ['incomplete', semantic => { semantic.partition = []; }],
    ['undecomposed', semantic => { semantic.partition = null; }],
    ['unknown', semantic => { semantic.comparison.availability = 'unknown'; }]];
  for (const [status, change] of variants) {
    const input = structuredClone(fixture); change(input.frames[1].semantic);
    const frame = build(input).frames[1];
    assert.equal(targetContext(frame).comparison_status.status, status);
    if (unresolvedUnit(frame)) assert.equal(relation(frame, 'residual:unresolved:unknown-evaluation').context.comparison_status, status);
    if (status === 'incomplete' || status === 'undecomposed') {
      const unit = ofKind(frame, 'unassigned-change').find(value => value.ref.id === 'delivery');
      assert.ok(unit && unit.flags.includes('source=uncovered-part'), status);
    }
    assert.ok(currentGap(frame).length > 0, status);
  }
});

test('unknown comparison remains an explicit UNKNOWN unit, not deletion/completion or an empty Scopes area', () => {
  const input = structuredClone(fixture); input.frames[1].semantic.comparison.availability = 'unknown';
  const frame = build(input).frames[1];
  assert.equal(ofKind(frame, 'semantic-scope').length, 0);
  assert.equal(unresolvedUnit(frame).area, 'scopes');
  assert.equal(targetContext(frame).closure.purpose_status, 'unknown');
  assert.ok(ofKind(frame, 'obligation').length > 0);
});

test('a later observation/target change cannot silently erase previous obligations', () => {
  const input = structuredClone(fixture); input.frames[1].semantic.history = [];
  assert.throws(() => build(input), /prior obligation omitted/);
  const retained = structuredClone(fixture);
  retained.frames[1].semantic.history[0].state = 'declared-retired';
  retained.frames[1].semantic.history[0].authority = 'fixture-only-disposition-not-authenticated';
  const obligation = ofKind(build(retained).frames[1], 'obligation');
  assert.equal(obligation.length, 1); assert.equal(obligation[0].area, 'scopes');
  assert.ok(obligation[0].flags.includes('history-preserved'));
});

test('normalized World has qualified identities and only the public generic entity/relation fields', () => {
  const entityFields = new Set(['ref', 'label', 'area', 'order', 'visible', 'activity', 'summary', 'source', 'time', 'flags']);
  const relationFields = new Set(['ref', 'from', 'to', 'kind', 'label', 'context', 'source', 'time', 'flags', 'containment', 'path', 'visible']);
  const sameId = structuredClone(fixture);
  sameId.frames[1].semantic.partition[0].id = 'criterion.recovery';
  for (const frame of [...build(fixture).frames, build(sameId).frames[1]]) {
    const ids = frame.entities.map(value => JSON.stringify(value.ref));
    assert.equal(new Set(ids).size, ids.length);
    const relationIds = frame.relations.map(value => JSON.stringify(value.ref));
    assert.equal(new Set(relationIds).size, relationIds.length, 'Scope and unassigned ids never share a relation id');
    frame.entities.forEach(value => Object.keys(value).forEach(field => assert.ok(entityFields.has(field))));
    frame.relations.forEach(value => Object.keys(value).forEach(field => assert.ok(relationFields.has(field))));
    frame.relations.forEach(value => { assert.ok(ids.includes(JSON.stringify(value.from))); assert.ok(ids.includes(JSON.stringify(value.to))); });
  }
});

test('Direction: Current -> needed unit -> Target -> Purpose; history and Agent edges are not promoted', () => {
  const [before, after] = build(fixture).frames;
  const chain = (frame, ids) => {
    const route = ids.map(id => relation(frame, id));
    assert.ok(route.every(value => value && value.path === true), ids.join(' > '));
    route.slice(1).forEach((value, index) => assert.deepEqual(route[index].to, value.from));
    assert.deepEqual(route[0].from, current(frame).ref);
    assert.equal(route.at(-1).to.kind, 'purpose');
  };
  chain(before, ['change:scope:scope.delivery', 'scope:scope.delivery', 'target-purpose']);
  chain(after, ['change:unassigned:criterion.recovery', 'residual:unassigned:criterion.recovery', 'target-purpose']);
  assert.equal(relation(after, 'scope:scope.delivery').path, true, 'the completed Scope keeps its declared direction');
  for (const frame of [before, after]) {
    assert.ok(frame.relations.filter(value => value.ref.id.startsWith('history:') || value.from.kind === 'agent').every(value => value.path === false));
  }
});

test('unknown comparison does not manufacture semantic direction; unknown binding stays unbridged', () => {
  const input = structuredClone(fixture); input.frames[1].semantic.comparison.availability = 'unknown';
  const frame = build(input).frames[1];
  for (const id of ['target-purpose', 'change:unresolved:unknown-evaluation', 'residual:unresolved:unknown-evaluation']) assert.equal(relation(frame, id).path, false);
  const unmapped = structuredClone(fixture); unmapped.frames[1].semantic.bindings = null;
  assert.equal(targetContext(build(unmapped).frames[1]).binding.state, 'unknown');
});
