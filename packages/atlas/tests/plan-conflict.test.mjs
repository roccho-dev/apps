import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';
import { ledgerEvents } from '../ledger.mjs';
import { joinLog } from '../live.mjs';

// C3: a plan body edited in place (the same version, other content; resources#25 v3 on the HQ) must not stop the
// whole World. That plan is held as a conflict from then on (neither definition is used as its content);
// everything else derives as before. The same content again stays accepted (idempotent).
const read = name => readFileSync(new URL('../fixtures/events/' + name, import.meta.url), 'utf8');
const EVENTS = read('events.jsonl'), CONTROL = read('control.jsonl');
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';
const T6 = '2026-10-16T06:00:00.000Z', T7 = '2026-10-16T07:00:00.000Z';
const original = () => structuredClone(rows(EVENTS).find(event => event.source?.ref === 'apps#95'));
const again = (at, change = plan => plan) => change({ ...original(), recordedAt: at, source: { ...original().source, updatedAt: at } });
const edited = plan => ({ ...plan, nodes: plan.nodes.map((node, index) => index ? node : { ...node, label: node.label + '（編集）' }),
  source: { ...plan.source, digest: 'sha256:' + 'e'.repeat(64) } });
const derive = extra => deriveAtlas(jsonl([...rows(EVENTS), ...extra]), CONTROL);
const plansAt = (result, iso) => result.plans.frames.find(frame => frame.asOf === iso).plans;
const byRef = (plans, ref) => plans.find(plan => plan.ref === ref);

test('the same version redefined with other content: the World is built and only that plan is held as a conflict', () => {
  const result = derive([again(T6, edited)]);
  const world = contractWorld(result);
  assert.ok(world.frames.length > 0);
  const plan = byRef(plansAt(result, T6), 'apps#95');
  // Neither the first nor the later definition is the plan's content: UNKNOWN, with the reason.
  assert.deepEqual([plan.version, plan.nodes, plan.edges], ['p1', null, null]);
  assert.ok(plan.unknown.some(reason => reason.startsWith('conflicting-redefinition')), JSON.stringify(plan.unknown));
  // Before the edit, the frame knew only the first definition.
  assert.equal(byRef(plansAt(result, '2026-10-16T05:00:00.000Z'), 'apps#95').nodes.length, 4);
  // Once in conflict, the same version stays held, even when the first content comes back.
  const later = derive([again(T6, edited), again(T7)]);
  assert.equal(byRef(plansAt(later, T7), 'apps#95').nodes, null);
});

test('the same content again (idempotent) is accepted as before', () => {
  const result = derive([again(T6)]);
  assert.equal(byRef(plansAt(result, T6), 'apps#95').nodes.length, 4);
  assert.deepEqual(byRef(plansAt(result, T6), 'apps#95').unknown ?? [], []);
});

// C3b: the HQ ledger (rows verbatim, seq renumbered) has resources#25 plan v3 twice from comment 6208252115 with
// the same updatedAt and the same parsed plan, but two section digests: GitHub returned the body with "#28"
// rewritten to "roccho-dev/windows#28" without moving updated_at. One source, one plan: not a conflict.
const LEDGER = readFileSync(new URL('../fixtures/ledger/resources-25-same-time.jsonl', import.meta.url), 'utf8');
const PLAN = 'roccho-dev/resources#25:windows-retirement-migration-20261016';

test('HQ form: the same comment and time, the same plan, another digest — the World is built with the plan', () => {
  const rowsOf = ledgerEvents(LEDGER).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'plan.set');
  assert.deepEqual(rowsOf.map(event => [event.source.commentId, event.source.updatedAt, event.version]), [[6208252115, '2026-10-16T04:43:00Z', 3], [6208252115, '2026-10-16T04:43:00Z', 3]]);
  assert.notEqual(rowsOf[0].source.sha256, rowsOf[1].source.sha256);
  const result = deriveAtlas(joinLog('', [ledgerEvents(LEDGER)]).log, '{"schema":"atlas.control-norms/1","authority":false}\n');
  assert.ok(contractWorld(result).frames.length > 0);
  const plan = result.plans.frames.at(-1).plans.find(value => value.plan === PLAN);
  // v3 carries no graph G could read (G gives UNKNOWN): the plan keeps G's own reasons, not a conflict.
  assert.deepEqual([rowsOf[1].nodes, plan.nodes], ['UNKNOWN', null]);
  assert.deepEqual(plan.unknown, rowsOf[1].unknown);
  assert.ok(!plan.unknown.some(reason => reason.startsWith('conflicting-redefinition')));
  // The provenance is the latest read: its digest.
  assert.equal(plan.source.digest, rowsOf[1].source.sha256);
});

test('the same body time with other plan content is held as a conflict, not thrown', () => {
  const sameTime = plan => edited({ ...plan, recordedAt: T6 });
  const result = derive([sameTime(original())]);
  const plan = byRef(plansAt(result, T6), 'apps#95');
  assert.deepEqual([plan.nodes, plan.edges], [null, null]);
  assert.ok(plan.unknown[0].startsWith('conflicting-redefinition'));
});

test('other plans, declarations and conditions are not affected by the conflict', () => {
  const conflict = derive([again(T6, edited)]), idempotent = derive([again(T6)]);
  const strip = plans => plans.filter(plan => plan.ref !== 'apps#95');
  assert.deepEqual(strip(plansAt(conflict, T6)), strip(plansAt(idempotent, T6)));
  assert.ok(strip(plansAt(conflict, T6)).length > 0);
  assert.deepEqual(conflict.derived.frames.at(-1).conditions, idempotent.derived.frames.at(-1).conditions);
  assert.deepEqual(contractWorld(conflict).frames.at(-1).gap, contractWorld(idempotent).frames.at(-1).gap);
});
