import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas, parsePhysicalScopes } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

const read = name => readFileSync(new URL('../fixtures/gap/' + name, import.meta.url), 'utf8');
const EVENTS = read('events.jsonl'), CONTROL = read('control.jsonl');
const header = '{"schema":"atlas.control-norms/1","authority":false}\n';
const pkg = (repo = 'roccho-dev/apps', path = 'packages/atlas') => ({ kind: 'package', repo, package: path });
const record = overrides => ({ kind: 'physical-scope', id: 'physical.p1.apps', purposeId: 'purpose.p1', lifetime: 'development',
  ref: pkg(), conditions: ['A'], ...overrides });
const control = records => header + records.map(value => JSON.stringify(value)).join('\n') + '\n';
const reject = (overrides, pattern) => assert.throws(() => parsePhysicalScopes(control([record(overrides)])), pattern);
const derive = (physical, evaluation) => {
  const events = EVENTS.trimEnd().split('\n').map(line => JSON.parse(line));
  if (evaluation) events.push(evaluation);
  events.sort((a, b) => Date.parse(a.recordedAt ?? 0) - Date.parse(b.recordedAt ?? 0));
  const text = events.map(value => JSON.stringify(value)).join('\n') + '\n';
  return deriveAtlas(text, CONTROL.trimEnd() + '\n' + physical.map(value => JSON.stringify(value)).join('\n') + '\n');
};
const evaluated = (overrides = {}) => ({ kind: 'purpose.evaluated', recordedAt: '2026-10-17T01:30:00Z', actor: 'User',
  purpose_id: 'purpose.p1', purpose_rev: 'v1', ideal_version: 'v2', verdict: 'ideal-insufficient',
  source: { ref: 'synthetic:gap-evaluation', digest: 'sha256:' + 'e'.repeat(64) }, ...overrides });
const frame = (world, asOf) => world.frames.find(value => value.asOf === asOf);
const ofKind = (world, asOf, kind) => frame(world, asOf).entities.filter(value => value.ref.kind === kind);
const relation = (world, asOf, id) => frame(world, asOf).relations.find(value => value.ref.id === id);
const links = (world, asOf) => frame(world, asOf).relations.filter(value => value.ref.id.startsWith('physical:'));
const T1 = '2026-10-17T01:00:00.000Z', T2 = '2026-10-17T02:00:00.000Z', T4 = '2026-10-17T04:00:00.000Z';

test('physical-scope accepts a package or service with a lifetime and condition ids, and rejects anything else', () => {
  const valid = parsePhysicalScopes(control([record({}), record({ id: 'physical.p1.serve', lifetime: 'operation',
    ref: { kind: 'service', host: 'native', name: 'serve-static' }, conditions: ['B'] })]));
  assert.deepEqual([...valid.keys()], ['physical.p1.apps', 'physical.p1.serve']);
  assert.deepEqual(valid.get('physical.p1.apps'), { kind: 'physical-scope', id: 'physical.p1.apps', purposeId: 'purpose.p1',
    lifetime: 'development', ref: pkg(), conditions: ['A'] });
  for (const repo of ['apps', 'roccho-dev/apps/extra', 'roccho-dev apps', '/apps', 'roccho-dev/'])
    reject({ ref: pkg(repo) }, /repo must be owner\/name/u);
  for (const path of ['../apps', '/packages/atlas', 'packages//atlas', 'packages/', 'packages\\atlas', 'packages/../atlas', '.'])
    reject({ ref: pkg('roccho-dev/apps', path) }, /package must be a repo-relative package path/u);
  reject({ lifetime: 'forever' }, /lifetime must be development\|operation/u);
  reject({ lifetime: undefined }, /lifetime/u);
  reject({ ref: { kind: 'host', id: 'x' } }, /must be a package or service ref/u);
  reject({ ref: { kind: 'service', host: 'native' } }, /expected exactly kind, host, name/u);
  reject({ conditions: [] }, /conditions/u);
  // The v11 form (gaps, repo/package on the record) is no longer accepted: GapA has no physical relation.
  assert.throws(() => parsePhysicalScopes(control([{ kind: 'physical-scope', id: 'old', purposeId: 'purpose.p1', gaps: ['ideal-current'],
    conditions: ['A'], repo: 'roccho-dev/apps', package: 'packages/atlas' }])), /physical-scope|gaps|lifetime/u);
  assert.throws(() => parsePhysicalScopes(control([record({}), record({})])), /unique physical-scope id/u);
});

test('one entity per package, deduped across declarations, with containment and every declaration as provenance', () => {
  const physical = [record({ id: 'physical.p1.apps', conditions: ['A', 'B'] }), record({ id: 'physical.p1.audit', conditions: ['C'] }),
    record({ id: 'physical.p1.ui', ref: pkg('roccho-dev/ui', 'packages/control'), conditions: ['A'] })];
  const { world } = derive(physical, null);
  assert.deepEqual(ofKind(world, T2, 'package').map(value => value.ref.id).sort(), ['roccho-dev/apps:packages/atlas', 'roccho-dev/ui:packages/control']);
  assert.deepEqual(ofKind(world, T2, 'repository').map(value => value.ref.id).sort(), ['roccho-dev/apps', 'roccho-dev/ui']);
  const contains = relation(world, T2, 'contains:roccho-dev/apps:packages/atlas');
  assert.deepEqual([contains.containment, contains.label, contains.context.declared_by, contains.context.declaration_ids],
    ['from-contains-to', '含む', 'physical-scope', ['physical.p1.apps', 'physical.p1.audit']]);
  // development: only the open parts (C is satisfied at t2), labelled この差を埋める対象, nothing to GapA.
  const apps = links(world, T2).filter(value => value.from.id === 'roccho-dev/apps:packages/atlas');
  assert.deepEqual(apps.map(value => [value.context.condition, value.context.lifetime, value.label]).sort(),
    [['A', 'development', 'この差を埋める対象'], ['B', 'development', 'この差を埋める対象']]);
  const one = ofKind(world, T2, 'package').find(value => value.ref.id === 'roccho-dev/apps:packages/atlas');
  assert.equal(one.source.sourceRef, 'atlas.control-norms/1#physical.p1.apps+physical.p1.audit');
  assert.ok(['physical-scope', 'repo=roccho-dev/apps', 'package=packages/atlas', 'lifetime=development'].every(flag => one.flags.includes(flag)));
  assert.deepEqual(derive(physical, null).world, world, 'the same input derives the same World');
  // A repository's provenance is every declaration of its linked packages.
  const many = derive([record({ id: 'd.one', ref: pkg('roccho-dev/apps', 'packages/one') }),
    record({ id: 'd.two', ref: pkg('roccho-dev/apps', 'packages/two'), conditions: ['B'] }), record({ id: 'd.parts', conditions: ['A', 'B'] })], null).world;
  assert.equal(ofKind(many, T2, 'repository')[0].source.sourceRef, 'atlas.control-norms/1#d.one+d.parts+d.two');
});

test('operation keeps its condition: drawn to the purpose-state-target while the condition is in the ideal, and to the open part too', () => {
  const serve = { kind: 'service', host: 'native', name: 'serve-static' };
  const { world } = derive([record({ id: 'physical.p1.serve', lifetime: 'operation', ref: serve, conditions: ['C'] })], null);
  // t1: C is open; t2: C is satisfied (kept), still drawn to the ideal state.
  const kept = asOf => links(world, asOf).map(value => [value.to.kind, value.context.condition, value.context.lifetime, value.label]).sort();
  assert.deepEqual(kept(T1), [['purpose-state-target', 'C', 'operation', 'この条件を保つもの'], ['semantic-scope', 'C', 'operation', 'この条件を保つもの']]);
  assert.deepEqual(kept(T2), [['purpose-state-target', 'C', 'operation', 'この条件を保つもの']]);
  const service = ofKind(world, T2, 'service')[0];
  assert.deepEqual([service.ref.id, service.flags], ['native:serve-static', ['physical-scope', 'host=native', 'name=serve-static', 'lifetime=operation']]);
  assert.deepEqual(ofKind(world, T2, 'repository'), [], 'a service has no repository');
});

test('undeclared parts stay unbound, GapA has no entity and no physical relation, old control input emits no physical Scope', () => {
  const mapped = derive([record({ conditions: ['A'] })], evaluated()).world;
  assert.deepEqual(links(mapped, T2).map(value => value.context.condition), ['A']);
  const t4 = frame(mapped, T4);
  assert.ok(t4.entities.some(value => value.ref.kind === 'unassigned-change' && value.ref.id === 'E'));
  assert.ok(!t4.relations.some(value => value.ref.id.startsWith('physical:') && value.context?.condition === 'E'));
  for (const item of mapped.frames) {
    assert.ok(!item.entities.some(value => value.ref.kind === 'purpose-adequacy'), 'GapA is frames[i].adequacy, not an entity');
    assert.ok(!item.relations.some(value => value.to.kind === 'purpose-adequacy' || value.context?.gap), 'nothing points at GapA');
  }
  const old = deriveAtlas(EVENTS, CONTROL).world;
  for (const asOf of old.frames.map(value => value.asOf)) assert.deepEqual([...ofKind(old, asOf, 'package'), ...ofKind(old, asOf, 'repository')], []);
});

// adrs#647 comment 6265881722: admission is shown only, never part of a judgment.
test('GapA admission is display only: the same evaluation with or without admission gives the same state and reason', () => {
  const adequacy = evaluation => frame(contractWorld(derive([], evaluation)), T2).adequacy;
  const unadmitted = adequacy(evaluated({ source: { ref: 'synthetic:gap-evaluation', digest: 'sha256:' + 'e'.repeat(64), admission: 'observed_not_admitted' } }));
  const admitted = adequacy(evaluated());
  assert.deepEqual([unadmitted.state, unadmitted.reason], [admitted.state, admitted.reason]);
  assert.deepEqual([admitted.state, admitted.reason], ['unmet', 'evaluated']);
  assert.equal(unadmitted.evidence.source.admission, 'observed_not_admitted');
  assert.equal(adequacy(evaluated({ ideal_version: 'v1' })).reason, 'past', 'versions are compared as written');
});
