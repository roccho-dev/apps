import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas, parsePhysicalScopes } from '../events.mjs';

const read = name => readFileSync(new URL('../fixtures/gap/' + name, import.meta.url), 'utf8');
const EVENTS = read('events.jsonl'), CONTROL = read('control.jsonl');
const header = '{"schema":"atlas.control-norms/1","authority":false}\n';
const record = overrides => ({ kind: 'physical-scope', id: 'physical.p1.apps', purposeId: 'purpose.p1',
  gaps: ['ideal-current'], conditions: ['A'], repo: 'roccho-dev/apps', package: 'packages/atlas', ...overrides });
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
const links = (world, asOf, gap) => frame(world, asOf).relations
  .filter(value => value.ref.id.startsWith('physical:') && value.context?.gap === gap);
const T2 = '2026-10-17T02:00:00.000Z', T4 = '2026-10-17T04:00:00.000Z', T5 = '2026-10-17T05:00:00.000Z';

test('physical-scope accepts explicit repo/package and rejects invalid paths or gaps', () => {
  const valid = parsePhysicalScopes(control([record({}), record({ id: 'physical.p1.ui', repo: 'roccho-dev/ui', package: 'packages/control', conditions: ['B'] }),
    record({ id: 'physical.p1.purpose', gaps: ['purpose-ideal'], conditions: [] })]));
  assert.deepEqual([...valid.keys()], ['physical.p1.apps', 'physical.p1.ui', 'physical.p1.purpose']);
  assert.deepEqual(valid.get('physical.p1.apps'), { kind: 'physical-scope', id: 'physical.p1.apps', purposeId: 'purpose.p1',
    gaps: ['ideal-current'], conditions: ['A'], repo: 'roccho-dev/apps', package: 'packages/atlas' });
  for (const repo of ['apps', 'roccho-dev/apps/extra', 'roccho-dev apps', '/apps', 'roccho-dev/'])
    reject({ repo }, /repo must be owner\/name/u);
  for (const packagePath of ['../apps', '/packages/atlas', 'packages//atlas', 'packages/', 'packages\\atlas', 'packages/../atlas', '.'])
    reject({ package: packagePath }, /package must be a repo-relative package path/u);
  reject({ gaps: [] }, /gaps/u);
  reject({ gaps: ['other'] }, /gaps must be/u);
  reject({ gaps: ['ideal-current'], conditions: [] }, /conditions must name/u);
  assert.throws(() => parsePhysicalScopes(control([record({}), record({})])), /unique physical-scope id/u);
});

test('actual derive emits one deduped physical package linking GapA and GapB, with containment and declaration provenance', () => {
  const physical = [
    record({ id: 'physical.p1.apps', gaps: ['purpose-ideal', 'ideal-current'], conditions: ['A', 'B'] }),
    record({ id: 'physical.p1.audit', gaps: ['ideal-current'], conditions: ['C'] }),
    record({ id: 'physical.p1.ui', repo: 'roccho-dev/ui', package: 'packages/control', gaps: ['ideal-current'], conditions: ['A'] }),
  ];
  const result = derive(physical, evaluated());
  const t2 = frame(result.world, T2);
  // One package entity per physical repo/package even across two declarations.
  assert.deepEqual(ofKind(result.world, T2, 'package').map(value => value.ref.id).sort(),
    ['roccho-dev/apps:packages/atlas', 'roccho-dev/ui:packages/control']);
  assert.deepEqual(ofKind(result.world, T2, 'repository').map(value => value.ref.id).sort(), ['roccho-dev/apps', 'roccho-dev/ui']);
  // Containment: repository contains the declared package (the ui's existing shape).
  const contains = relation(result.world, T2, 'contains:roccho-dev/apps:packages/atlas');
  assert.equal(contains.containment, 'from-contains-to');
  assert.equal(contains.label, '含む');
  assert.equal(contains.context.declared_by, 'physical-scope');
  assert.deepEqual(contains.context.declaration_ids, ['physical.p1.apps', 'physical.p1.audit']);
  // GapA is the real human evaluation, not CI or a match: current ideal-insufficient.
  const adequacy = ofKind(result.world, T2, 'purpose-adequacy');
  assert.equal(adequacy.length, 1);
  assert.equal(adequacy[0].ref.id, 'purpose.p1');
  assert.ok(adequacy[0].flags.includes('purpose_adequacy=insufficient'));
  assert.match(adequacy[0].summary, /verdict=ideal-insufficient/u);
  // One package addresses several parts and both gaps without duplicate entities.
  const apps = relation(result.world, T2, 'physical:roccho-dev/apps:packages/atlas:purpose-ideal');
  assert.equal(apps.to.kind, 'purpose-adequacy');
  assert.equal(apps.context.gap, 'purpose-ideal');
  const gapB = links(result.world, T2, 'ideal-current').filter(value => value.from.kind === 'package' && value.from.id === 'roccho-dev/apps:packages/atlas');
  assert.deepEqual(gapB.map(value => value.context.condition).sort(), ['A', 'B'], 'C is satisfied at t2, so no link');
  assert.ok(gapB.every(value => value.label === 'この差を埋める対象'));
  // The same package is one entity, not one per part/gap.
  assert.equal(ofKind(result.world, T2, 'package').filter(value => value.ref.id === 'roccho-dev/apps:packages/atlas').length, 1);
  // Source provenance is the explicit declaration, never a label/URL inference.
  const pkg = ofKind(result.world, T2, 'package').find(value => value.ref.id === 'roccho-dev/apps:packages/atlas');
  assert.equal(pkg.source.sourceRef, 'atlas.control-norms/1#physical.p1.apps+physical.p1.audit');
  assert.equal(pkg.source.kind, 'declared');
  assert.ok(pkg.flags.includes('repo=roccho-dev/apps') && pkg.flags.includes('package=packages/atlas'));
  // Stable: the same input derives the same World.
  assert.deepEqual(derive(physical, evaluated()).world, result.world);
  // Past frames do not get the later evaluation: t1 has GapA unassessed, not insufficient.
  const t1Adequacy = ofKind(result.world, '2026-10-17T01:00:00.000Z', 'purpose-adequacy');
  assert.equal(t1Adequacy.length, 1);
  assert.ok(t1Adequacy[0].flags.includes('purpose_adequacy=unassessed'));
  assert.equal(links(result.world, '2026-10-17T01:00:00.000Z', 'purpose-ideal').length, 1);
  assert.deepEqual(links(result.world, '2026-10-17T01:00:00.000Z', 'ideal-current').map(value => value.context.condition), ['B', 'C']);
});

test('GapA distinguishes a current ideal-insufficient from achieved, past and mismatched', () => {
  const physical = [record({ gaps: ['purpose-ideal'], conditions: [] })];
  const state = evaluation => ofKind(derive(physical, evaluation).world, T2, 'purpose-adequacy')[0]?.flags ?? [];
  assert.ok(state(evaluated()).includes('purpose_adequacy=insufficient'));
  assert.ok(state(evaluated({ verdict: 'achieved' })).includes('purpose_adequacy=unassessed'), 'achieved purpose does not prove ideal adequacy');
  assert.ok(state(evaluated({ ideal_version: 'v1' })).includes('purpose_adequacy=unassessed'), 'version mismatch is unassessed');
  assert.ok(state(null).includes('purpose_adequacy=unassessed'), 'no evaluation is unassessed, not absent and not satisfied');
});

// adrs#647 comment 6265881722: admission is shown only, never part of a judgment.
test('GapA admission is display only: the same evaluation with or without admission gives the same state', () => {
  const physical = [record({ gaps: ['purpose-ideal'], conditions: [] })];
  const adequacy = evaluation => ofKind(derive(physical, evaluation).world, T2, 'purpose-adequacy')[0];
  const unadmitted = adequacy(evaluated({ source: { ref: 'synthetic:gap-evaluation', digest: 'sha256:' + 'e'.repeat(64), admission: 'observed_not_admitted' } }));
  assert.deepEqual(unadmitted.flags, adequacy(evaluated()).flags);
  assert.match(unadmitted.summary, /admission=observed_not_admitted/u);
});

test('a repository with several declared packages carries every declaration as its provenance', () => {
  const physical = [record({ id: 'd.one', package: 'packages/one' }), record({ id: 'd.two', package: 'packages/two', conditions: ['B'] }),
    record({ id: 'd.parts', conditions: ['A', 'B'] })];
  const [repo] = ofKind(derive(physical, null).world, T2, 'repository');
  assert.equal(repo.source.sourceRef, 'atlas.control-norms/1#d.one+d.parts+d.two');
});

test('undeclared parts stay unbound and old control input emits no physical Scope', () => {
  const physical = [record({ conditions: ['A'] })];
  const mapped = derive(physical, null).world;
  assert.deepEqual(ofKind(mapped, T2, 'package').map(value => value.ref.id), ['roccho-dev/apps:packages/atlas']);
  assert.deepEqual(links(mapped, T2, 'ideal-current').map(value => value.context.condition), ['A']);
  // E at t4/t5 is open and unassigned (no Norm.e, no physical declaration): no inferred package.
  const t4 = frame(mapped, T4);
  assert.ok(t4.entities.some(value => value.ref.kind === 'unassigned-change' && value.ref.id === 'E'));
  assert.ok(!t4.entities.some(value => value.ref.kind === 'package' && value.ref.id.includes('E')));
  assert.ok(!t4.relations.some(value => value.ref.id.startsWith('physical:') && value.context?.condition === 'E'));
  // The old control input (no physical-scope records) has no physical entities.
  const old = deriveAtlas(EVENTS, CONTROL).world;
  for (const asOf of old.frames.map(value => value.asOf)) {
    assert.deepEqual(ofKind(old, asOf, 'package'), []);
    assert.deepEqual(ofKind(old, asOf, 'repository'), []);
  }
});

// GapA is a difference of its own, not a physical Scope: the ui reads it only from the producer.
test('GapA is supplied without any physical declaration or with GapB declarations only', () => {
  const states = world => ofKind(world, T2, 'purpose-adequacy').map(value => value.flags.find(flag => flag.startsWith('purpose_adequacy=')));
  assert.deepEqual(states(deriveAtlas(EVENTS, CONTROL).world), ['purpose_adequacy=unassessed']);
  assert.deepEqual(states(derive([], evaluated()).world), ['purpose_adequacy=insufficient']);
  const gapBOnly = derive([record({})], null).world;
  assert.deepEqual(states(gapBOnly), ['purpose_adequacy=unassessed']);
  assert.deepEqual(links(gapBOnly, T2, 'purpose-ideal'), [], 'no package is linked to GapA without a purpose-ideal declaration');
});
