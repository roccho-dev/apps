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
const bindingEdges = frame => frame.relations.filter(value => value.ref.id.startsWith('binding:'));
const targetContext = frame => frame.relations.find(value => value.ref.id === 'target-purpose').context;

test('same actual reducer output and semantic input produce deterministic authority=false World', () => {
  const saved = structuredClone(fixture), a = build(fixture), b = build(fixture);
  assert.deepEqual(a, b); assert.deepEqual(fixture, saved);
  assert.equal(a.kind, 'ui.atlasWorldInput.v1'); assert.equal(a.authority, false);
  assert.equal(a.frames.length, 2);
  assert.equal(bindingEdges(a.frames[1]).length, 5);
});

test('current/target are roles in each observation frame, not invented chronological target frames', () => {
  const world = build(fixture);
  assert.deepEqual(world.frames.map(frame => [frame.id, frame.rev, frame.asOf]), fixture.frames.map(frame => [frame.id, frame.rev, frame.asOf]));
  for (const frame of world.frames) {
    const target = frame.entities.find(value => value.ref.kind === 'purpose-state-target');
    assert.equal(target.time.effectiveAt, null);
    assert.ok(frame.entities.some(value => value.ref.kind === 'purpose-state-current'));
    assert.ok(frame.entities.some(value => value.ref.kind === 'purpose-state-observed'));
  }
});

test('later captures never mint or freshen t0/target/comparison observation times', () => {
  const input = structuredClone(fixture);
  input.frames[1].asOf = '2026-01-02T20:00:00Z';
  const world = build(input);
  for (const frame of world.frames) {
    for (const kind of ['purpose-state-current', 'purpose-state-target', 'semantic-delta', 'semantic-scope', 'obligation']) {
      const entity = frame.entities.find(value => value.ref.kind === kind);
      assert.equal(entity.time.observedAt, null, kind);
      assert.equal(entity.time.effectiveAt, null, kind);
    }
    for (const id of ['current-delta', 'delta-target', 'target-purpose', 'scope:scope.delivery'])
      assert.equal(frame.relations.find(value => value.ref.id === id).time.observedAt, null);
  }
  const post = world.frames[1].entities.find(value => value.ref.kind === 'purpose-state-observed');
  assert.equal(post.time.observedAt, fixture.frames[1].semantic.observation.observed_at);
  assert.notEqual(post.time.observedAt, world.frames[1].asOf);
  delete input.frames[1].semantic.observation.observed_at;
  assert.equal(build(input).frames[1].entities.find(value => value.ref.kind === 'purpose-state-observed').time.observedAt, null);
});

test('Scope trace preserves exact pair, semantic basis, responsibility, criteria, evidence and residual/history', () => {
  const world = build(fixture), frame = world.frames[1];
  const context = frame.relations.find(value => value.ref.id === 'scope:scope.delivery').context;
  assert.deepEqual(context.scope.pair, fixture.frames[1].semantic.bindings.pair);
  assert.equal(context.scope.owner_actor, 'fixture-W');
  assert.deepEqual(context.scope.criteria.delivery, ['criterion.delivery']);
  assert.equal(context.closure.scope_status, 'declared_satisfied');
  assert.equal(context.closure.purpose_status, 'unmet');
  assert.deepEqual(context.closure.residual, ['criterion.recovery']);
  assert.deepEqual(context.history, fixture.frames[1].semantic.history);
  assert.equal(context.binding.state, 'declared-bound');
});

test('missing or wrong-pair bindings keep graphs unlinked, no name/owner/ID-prefix inference', () => {
  for (const change of [semantic => { semantic.bindings = null; },
    semantic => { semantic.bindings.pair.target_ref = { ...semantic.bindings.pair.target_ref, revision: 'another-target' }; },
    semantic => { semantic.bindings.current.state_ref = { ...semantic.bindings.current.state_ref, revision: 'wrong-current' }; },
    semantic => { semantic.bindings.observed.state_ref = { ...semantic.bindings.observed.state_ref, revision: 'old-observed' }; }]) {
    const input = structuredClone(fixture); change(input.frames[1].semantic);
    const frame = build(input).frames[1];
    assert.equal(bindingEdges(frame).length, 0);
    assert.equal(targetContext(frame).binding.state, 'unknown');
    assert.ok(frame.entities.some(value => value.ref.id === 'unknown-evaluation'));
  }
});

test('same source ID at another revision or another Purpose does not join as the same state pair', () => {
  for (const change of [binding => { binding.current.sources[0].sourceDigest = 'sha256:' + '0'.repeat(64); },
    binding => { binding.current.sources[0].sourceRef = 'fixture:current@old'; },
    binding => { binding.purpose.id = 'purpose.reuse'; binding.purpose.sources = JSON.parse(reduced.split('\n').find(line => line.includes('"id":"purpose.reuse"'))).sources; },
    binding => { binding.target[1].state_ref = { ...binding.target[1].state_ref, revision: 'old-target' }; }]) {
    const input = structuredClone(fixture); change(input.frames[1].semantic.bindings);
    assert.equal(bindingEdges(build(input).frames[1]).length, 0);
  }
});

test('existing Closure source provenance and absent time survive; original contract is not rewritten', () => {
  const frame = build(fixture).frames[1];
  const legacy = frame.entities.filter(value => value.ref.space === 'atlas.purpose-closure/1');
  const rows = reduced.trim().split('\n').slice(1).map(JSON.parse);
  assert.equal(legacy.length, rows.length);
  for (const row of rows) {
    const displayed = legacy.find(value => value.ref.id === row.id);
    assert.deepEqual(JSON.parse(displayed.summary), row);
    assert.equal(displayed.source.sourceRef, row.sources[0].sourceRef);
    assert.equal(displayed.source.sourceDigest, row.sources[0].sourceDigest);
    assert.equal(displayed.time.observedAt, null); assert.equal(displayed.time.effectiveAt, null);
  }
});

test('unknown comparison remains an explicit UNKNOWN entity, not deletion/completion', () => {
  const input = structuredClone(fixture); input.frames[1].semantic.comparison.availability = 'unknown';
  const frame = build(input).frames[1];
  assert.equal(frame.entities.filter(value => value.ref.kind === 'semantic-scope').length, 0);
  assert.ok(frame.entities.some(value => value.ref.id === 'unknown-evaluation'));
  assert.equal(targetContext(frame).closure.purpose_status, 'unknown');
  assert.ok(frame.entities.some(value => value.ref.kind === 'obligation'));
});

test('a later observation/target change cannot silently erase previous obligations', () => {
  const input = structuredClone(fixture); input.frames[1].semantic.history = [];
  assert.throws(() => build(input), /prior obligation omitted/);
  const retained = structuredClone(fixture);
  retained.frames[1].semantic.history[0].state = 'declared-retired';
  retained.frames[1].semantic.history[0].authority = 'fixture-only-disposition-not-authenticated';
  assert.ok(build(retained).frames[1].entities.some(value => value.ref.kind === 'obligation'));
});

test('normalized World has qualified identities and only the public generic entity/relation fields', () => {
  const entityFields = new Set(['ref', 'label', 'area', 'order', 'visible', 'activity', 'summary', 'source', 'time', 'flags']);
  const relationFields = new Set(['ref', 'from', 'to', 'kind', 'label', 'context', 'source', 'time', 'flags', 'containment', 'path']);
  for (const frame of build(fixture).frames) {
    const ids = frame.entities.map(value => JSON.stringify(value.ref));
    assert.equal(new Set(ids).size, ids.length);
    frame.entities.forEach(value => Object.keys(value).forEach(field => assert.ok(entityFields.has(field))));
    frame.relations.forEach(value => Object.keys(value).forEach(field => assert.ok(relationFields.has(field))));
    frame.relations.forEach(value => { assert.ok(ids.includes(JSON.stringify(value.from))); assert.ok(ids.includes(JSON.stringify(value.to))); });
  }
});

test('source-declared Scope direction reaches Purpose; display-only residual/history edges are not promoted', () => {
  const frame = build(fixture).frames[1];
  const route = ['scope:scope.delivery', 'delta-target', 'target-purpose'].map(id => frame.relations.find(value => value.ref.id === id));
  assert.ok(route.every(value => value.path === true));
  assert.deepEqual(route[0].to, route[1].from);
  assert.deepEqual(route[1].to, route[2].from);
  assert.equal(route[2].to.kind, 'purpose');
  assert.ok(frame.relations.filter(value => value.ref.id.startsWith('residual:') || value.ref.id.startsWith('history:')).every(value => value.path === false));
  const legacyOrigin = frame.relations.find(value => value.kind === 'closure-reference' && value.from.id === 'current.before' && value.to.id === 'gap.extraction');
  assert.equal(legacyOrigin.path, true);
  assert.equal(legacyOrigin.context.declaredFieldDirection, 'current-to-gap');
});

test('unknown comparison does not manufacture semantic direction; unknown binding stays unbridged', () => {
  const input = structuredClone(fixture); input.frames[1].semantic.comparison.availability = 'unknown';
  const frame = build(input).frames[1];
  for (const id of ['current-delta', 'delta-target', 'target-purpose']) assert.equal(frame.relations.find(value => value.ref.id === id).path, false);
  const unmapped = structuredClone(fixture); unmapped.frames[1].semantic.bindings = null;
  assert.equal(bindingEdges(build(unmapped).frames[1]).length, 0);
});
