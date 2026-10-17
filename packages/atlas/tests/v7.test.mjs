import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

// adrs#647 contract v7: the Scopes area is nested by declared frames (containment), nothing is inferred.
const build = fixture => {
  const read = name => readFileSync(new URL(`../fixtures/${fixture}/${name}`, import.meta.url), 'utf8');
  return contractWorld(deriveAtlas(read('events.jsonl'), read('control.jsonl')));
};
const FIXTURES = ['events', 'gap', 'journal', 'v5', 'v6'];
const UNITS = ['semantic-scope', 'unassigned-change', 'unresolved-change', 'obligation', 'closed-change'];
const key = value => JSON.stringify(value);
const parentOf = frame => new Map(frame.relations.filter(value => value.containment === 'from-contains-to').map(value => [key(value.to), value.from]));

test('every Scopes unit is in exactly one declared frame: its Norm owner, 担当なし, or 閉じた差（履歴）', () => {
  for (const fixture of FIXTURES) for (const frame of build(fixture).frames) {
    const parents = parentOf(frame), containing = frame.relations.filter(value => value.containment);
    assert.equal(new Set(containing.map(value => key(value.to))).size, containing.length, `${fixture} ${frame.id}: one frame per unit`);
    const owners = Object.fromEntries((frame.gap.parts ?? []).map(part => [part.condition, part.scope]));
    for (const unit of frame.entities.filter(value => UNITS.includes(value.ref.kind))) {
      const parent = parents.get(key(unit.ref));
      assert.equal(parent?.kind, 'scope-group', `${fixture} ${frame.id}: ${unit.ref.kind}:${unit.ref.id} is in a frame`);
      const expected = ['obligation', 'closed-change'].includes(unit.ref.kind) || unit.flags.includes('standing=completed-history') ? 'history'
        : unit.ref.kind === 'semantic-scope' ? 'owner:' + /\/ ([^ ]+) · /u.exec(unit.summary)[1] : 'owner:none';
      assert.equal(parent.id, expected, `${fixture} ${frame.id}: ${unit.ref.id}`);
      if (unit.ref.kind === 'unassigned-change') assert.equal(owners[unit.ref.id], null, 'an unassigned unit is a Scope without owner');
    }
    // Frames hold only Scopes units, inside the Scopes area; there are no empty frames.
    for (const group of frame.entities.filter(value => value.ref.kind === 'scope-group')) {
      assert.equal(group.area, 'scopes');
      assert.ok(containing.some(value => key(value.from) === key(group.ref)), `${fixture} ${frame.id}: ${group.ref.id} is not empty`);
    }
    assert.ok(containing.every(value => value.path === false && UNITS.includes(value.to.kind)));
  }
});

test('nesting loses or duplicates no relation: Scope → difference and owner → Scope stay, once each', () => {
  for (const fixture of FIXTURES) for (const frame of build(fixture).frames) {
    const ids = frame.relations.map(value => value.ref.id);
    assert.equal(new Set(ids).size, ids.length, `${fixture} ${frame.id}: unique relation refs`);
    const count = id => ids.filter(value => value === id).length;
    for (const scope of frame.entities.filter(value => value.ref.kind === 'semantic-scope')) {
      assert.equal(count('scope:' + scope.ref.id), 1, `${fixture} ${frame.id}: Scope → ideal state`);
      assert.equal(count('owner:' + scope.ref.id), 1, `${fixture} ${frame.id}: owner → Scope`);
      if (scope.flags.includes('standing=active')) assert.equal(count('change:scope:' + scope.ref.id), 1, `${fixture} ${frame.id}: Current → Scope`);
    }
    for (const unit of frame.entities.filter(value => value.ref.kind === 'unassigned-change'))
      assert.deepEqual([count('change:unassigned:' + unit.ref.id), count('residual:unassigned:' + unit.ref.id)], [1, 1]);
    // Containment is an addition only: the non-containment relations still join only the same entities as before.
    assert.ok(frame.relations.filter(value => !value.containment).every(value => value.from.kind !== 'scope-group' && value.to.kind !== 'scope-group'));
  }
});

test('the real-data shaped frame: owners by Norm id, 担当なし for the unowned one', () => {
  const frame = build('events').frames.at(-1);
  const groups = frame.entities.filter(value => value.ref.kind === 'scope-group').map(value => [value.ref.id, value.label]);
  assert.deepEqual(groups, [['owner:refactor.W', '担当\nrefactor.W'], ['owner:atlas.W', '担当\natlas.W'], ['owner:envs.W', '担当\nenvs.W'],
    ['owner:none', '担当なし\n未割当・未確定'], ['history', '閉じた差\n履歴']]);
  // The history frame holds what is closed now (satisfied conditions) and the frozen old obligations; no lines.
  const history = frame.relations.filter(value => value.containment && value.from.id === 'history').map(value => value.to.kind + ':' + value.to.id);
  assert.deepEqual(history, ['obligation:v1:g6i3-fork', 'obligation:v1:nixos-console', 'closed-change:nixos']);
  assert.ok(frame.relations.filter(value => !value.containment).every(value => value.from.kind !== 'closed-change' && value.to.kind !== 'closed-change'));
});

// K8b (R's readback of K7/K8): the same record twice in one frame was listed twice, and ui refuses a World
// whose journal repeats an entry. fixtures/dup = fixtures/v6 + that input (and rows that only look alike).
test('an exactly repeated record is one journal row; rows that differ in value or source stay; judgments unchanged', () => {
  const dup = build('dup'), v6 = build('v6');
  const observations = frame => frame.journal.filter(entry => entry.kind === 'observation').map(entry => [entry.target.id, entry.value, entry.source.ref]);
  assert.deepEqual(observations(dup.frames[2]), [['svc.b', 'bad', 'synthetic:svc.b'], ['svc.b', 'bad', 'synthetic:svc.b-mirror']]);
  assert.deepEqual(observations(dup.frames[3]), [['svc.a', 'ok', 'synthetic:svc.a'], ['svc.c', 'x', 'synthetic:svc.c'], ['svc.c', 'y', 'synthetic:svc.c']]);
  // The ui rule: no journal entry may appear twice anywhere in the World; every cause names a side.
  const keys = dup.frames.flatMap(frame => frame.journal.map(entry => JSON.stringify(entry)));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(dup.frames.every(frame => (frame.gap.parts ?? []).every(part => part.cause.ideal || part.cause.current)));
  // Merging the repeat changes no phase, gap or judgment.
  assert.deepEqual(dup.frames.map(frame => [frame.phase, frame.gap]), v6.frames.map(frame => [frame.phase, frame.gap]));
});
