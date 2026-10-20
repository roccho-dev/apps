import { savedHistoryPorts } from './saved-history-ports.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// One existing source execution; ports below are not real browser pixels or
// production storage. Fixed expected records are separate from model choices.
const source = process.env.PINNED_HISTORY_SOURCE_ROOT ?? new URL('..', import.meta.url).pathname;
const load = relative => import(pathToFileURL(path.join(source, relative)));
const { revertStep, revertable, appendStep } = await load('src/turn.mjs');
const { apply, undo } = await load('src/session.mjs');
const { restoreLog } = await load('src/log.mjs');
const { renderHistory } = await load('src/render.mjs');
const protocol = await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL));
const rows = name => fs.readFileSync(new URL('./fixtures/pinned-addition-history/' + name + '.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(JSON.parse);
const inputs = rows('inputs'), gold = rows('expected');
const stable = value => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const bag = records => records.map(record => JSON.stringify(stable(record))).sort();
const sourceHashes = Object.fromEntries(['src/turn.mjs', 'src/session.mjs', 'src/log.mjs', 'src/render.mjs', 'src/goal.mjs', 'web/app.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex')]));
const emit = record => { if (process.env.PINNED_HISTORY_EVIDENCE) fs.appendFileSync(process.env.PINNED_HISTORY_EVIDENCE, JSON.stringify(record) + '\n'); };
emit({ kind: 'source-identity', source, sourceHashes, real_api: 'NOT_RUN', real_browser: 'NOT_RUN' });
globalThis.fetch = async () => { throw new Error('external network forbidden in saved-creation source tests'); };
const ports = await savedHistoryPorts({ source, protocol });
const { append, domPort, controls, view, clickInverse } = ports;
const created = input => ports.created(input, gold.find(row => row.id === input.id));

for (const input of inputs) {
  test('normal Goal saved creation has an atomic inverse / ' + input.id, async () => {
    const data = await created(input);
    const result = await revertStep({ before: data.before.records, after: data.after.records, working: data.session.working, protocol });
    emit({ kind: 'inverse-baseline', fixture: input.id, source, outcome: result.outcome, reason: result.reason ?? null,
      detail: result.detail ?? null, historyAllowed: revertable(data.entry, data.history), live_api: 0 });
    assert.equal(result.outcome, 'step', 'an unchanged saved creation must be cancellable');
    const operations = result.step.decision.operations;
    assert.equal(operations.length, 2);
    assert.equal(operations[0].type, 'UnpinRegions'); assert.equal(operations[1].type, 'RemoveSelection');
    const removed = await appendStep({ working: data.session.working, step: result.step, protocol });
    assert.equal(removed.outcome, 'step'); assert.deepEqual(bag(removed.graph.records), bag(data.expected.afterCancelRecords));
  });
  test('normal history button cancels the saved creation, Undo and persistence / ' + input.id, async () => {
    const data = await created(input), stages = [];
    const capture = async (stage, graph, wanted, stored) => {
      const reread = await protocol.verifyDecisionLog(graph.log);
      assert.deepEqual(bag(reread.records), bag(wanted)); assert.equal(reread.head, graph.head);
      await protocol.verifyDecisionLog(stored);
      stages.push({ stage, head: graph.head, log: graph.log, stored, records: reread.records, expected: wanted, envelope: await view(reread) });
    };
    await capture('initial', data.before, data.expected.initialRecords, data.before.log);
    await capture('goal-draft', data.after, data.after.records, data.before.log);
    await capture('saved-creation', data.session.working, data.after.records, data.stored());
    const panel = domPort();
    renderHistory(panel, { projection: data.history, revertable: data.history.entries.map(entry => revertable(entry, data.history)) });
    controls(panel, data.session);
    const button = panel.querySelectorAll('button[data-revert]').at(-1);
    emit({ kind: 'history-button', fixture: input.id, source, enabled: !button.disabled, facts: data.entry.facts });
    assert.equal(button.disabled, false, 'normal mixed AddRegion/PinRegions entry must expose its safe inverse');
    const first = await clickInverse(data.session, button); assert.equal(first.refusal, null);
    await capture('cancel-draft', first.session.working, data.expected.afterCancelRecords, data.stored());
    assert.equal(data.stored(), data.after.log, 'draft cancellation never writes saved state');
    const undone = await undo(first.session, { verifyDecisionLog: protocol.verifyDecisionLog });
    await capture('undo-cancel', undone.working, data.after.records, data.stored());
    const second = await clickInverse(undone, button); assert.equal(second.refusal, null);
    await capture('cancel-again', second.session.working, data.expected.afterCancelRecords, data.stored());
    const saved = await apply(second.session, { commit: data.commit }); assert.equal(saved.result.status, 'committed');
    assert.ok(data.stored().startsWith(data.after.log), 'saved cancellation is a new verified decision, never a truncated history');
    await capture('apply-cancel', saved.session.working, data.expected.afterCancelRecords, data.stored());
    const restored = await restoreLog({ key: 'fixed-history', read: async () => data.stored(), verifyDecisionLog: protocol.verifyDecisionLog });
    assert.equal(restored.status, 'restored');
    await capture('reload-cancel', restored.graph, data.expected.afterCancelRecords, data.stored());
    emit({ kind: 'saved-creation-lifecycle', fixture: input.id, source, stages,
      judgment: 'SYNTHETIC', browser: 'NOT_RUN', port: 'actual source handler / DOM double / envelope / memory store' });
  });
}

if (!process.env.PINNED_HISTORY_BASELINE_ONLY) {
  const identity = input => created(inputs.find(row => row.id === input));
  const preserved = async (data, operations, reason) => {
    const later = await append(data.after, operations), before = later.log;
    const result = await revertStep({ before: data.before.records, after: data.after.records, working: later, protocol });
    assert.equal(result.outcome, 'refused'); if (reason) assert.equal(result.reason, reason);
    assert.equal(later.log, before); assert.equal(result.step, undefined);
    await view(later); return result;
  };
  for (const [name, transform] of [
    ['move', bounds => [bounds[0] + 210, bounds[1], bounds[2], bounds[3]]],
    ['resize', bounds => [bounds[0], bounds[1], bounds[2] + 10, bounds[3]]],
  ]) test('later target ' + name + ' is not erased by the old creation inverse', async () => {
    const data = await identity('data'), own = data.after.records.find(row => row.type === 'layout' && row.regionId === 'part-1');
    await preserved(data, [{ type: 'PinRegions', items: [{ regionId: 'part-1', bounds: transform(own.bounds) }] }], 'revert-moved');
  });
  test('later explicit unpin is an edit too', async () => {
    await preserved(await identity('data'), [{ type: 'UnpinRegions', regionIds: ['part-1'] }], 'revert-moved');
  });
  for (const [name, operation, reason] of [
    ['rename', { type: 'RenameRegion', regionId: 'part-1', label: 'Keep this correction' }, 'revert-part-altered'],
    ['order', { type: 'SetRegionOrder', regionId: 'part-1', order: 4 }, 'revert-part-altered'],
    ['new edge', { type: 'ConnectRegions', relationId: 'later-edge', from: 'part-1', to: 'keeper', kind: 'flow', label: 'keep' }, 'revert-has-edge'],
  ]) test('later ' + name + ' stays protected', async () => { await preserved(await identity('data'), [operation], reason); });
  test('a group that now owns a child cannot be removed as a leaf', async () => {
    const data = await identity('empty-group'), group = data.after.records.find(row => row.id === 'part-1');
    await preserved(data, [{ type: 'AddRegion', regionId: 'child', parentId: 'part-1', label: 'Child', kind: 'data', summary: '',
      bounds: [group.bounds[0] + 1, group.bounds[1] + 1, 40, 24] }], 'revert-holds-parts');
  });
  for (const [name, operation] of [
    ['unrelated rename', { type: 'RenameRegion', regionId: 'keeper', label: 'Corrected kept item' }],
    ['unrelated move', { type: 'PinRegions', items: [{ regionId: 'keeper', bounds: [1100, 480, 180, 92] }] }],
    ['parent rename', { type: 'RenameRegion', regionId: 'container', label: 'Renamed Cloud' }],
  ]) test(name + ' does not unnecessarily block a valid inverse', async () => {
    const data = await identity('step');
    const current = await append(data.after, [operation]), independent = await append(data.before, [operation]);
    const result = await revertStep({ before: data.before.records, after: data.after.records, working: current, protocol });
    assert.equal(result.outcome, 'step');
    const next = await appendStep({ working: current, step: result.step, protocol });
    assert.equal(next.outcome, 'step'); assert.deepEqual(bag(next.graph.records), bag(independent.records));
  });
  test('returning to the original layout permits the original inverse', async () => {
    const data = await identity('step'), pin = data.after.records.find(row => row.type === 'layout' && row.regionId === 'part-1');
    const moved = await append(data.after, [{ type: 'PinRegions', items: [{ regionId: 'part-1', bounds: [500, 200, 180, 92] }] }]);
    const restored = await append(moved, [{ type: 'PinRegions', items: [{ regionId: 'part-1', bounds: pin.bounds }] }]);
    assert.equal((await revertStep({ before: data.before.records, after: data.after.records, working: restored, protocol })).outcome, 'step');
  });
  test('an unchanged unpinned creation retains its one-operation legacy inverse', async () => {
    const data = await identity('step');
    const raw = await append(data.before, [{ type: 'AddRegion', regionId: 'raw', parentId: 'container', label: 'Raw', kind: 'step', bounds: [20,20,140,64], summary: '' }]);
    const result = await revertStep({ before: data.before.records, after: raw.records, working: raw, protocol });
    assert.equal(result.outcome, 'step'); assert.equal(result.step.decision.operations.length, 1);
    assert.equal(result.step.decision.operations[0].type, 'RemoveSelection');
  });
  for (const [name, other] of [
    ['parent resize', { type: 'PinRegions', items: [{ regionId: 'container', bounds: [0,0,2100,1000] }] }],
    ['another name change', { type: 'RenameRegion', regionId: 'keeper', label: 'Same-entry correction' }],
  ]) test('a mixed creation and ' + name + ' is never partially reverted', async () => {
    const data = await identity('step');
    const operations = data.after.decisions.at(-1).operations;
    const mixed = await append(data.before, [...operations, other]);
    const result = await revertStep({ before: data.before.records, after: mixed.records, working: mixed, protocol });
    assert.equal(result.outcome, 'refused'); assert.equal(result.reason, 'revert-unsupported');
  });
  test('the fixed reducer still rejects orphaned layout references', async () => {
    const data = await identity('data');
    await assert.rejects(() => protocol.createDecision(data.after.head,
      [{ type: 'RemoveSelection', regionIds: ['part-1'], relationIds: [] }], data.after.records), /layout region not found/);
  });
  test('old pure-edge and placement eligibility is unchanged', () => {
    const projection = { regions: ['x', 'y'], relations: [] };
    assert.equal(revertable({ facts: [{ kind: 'relation', change: 'added', id: 'e' }] }, projection), true);
    assert.equal(revertable({ facts: [{ kind: 'layout', change: 'added', id: 'x' }] }, projection), true);
    assert.equal(revertable({ facts: [{ kind: 'region', change: 'added', id: 'x' }] }, projection), true);
    assert.equal(revertable({ facts: [{ kind: 'region', change: 'added', id: 'x' }, { kind: 'layout', change: 'added', id: 'y' }] }, projection), false);
    assert.equal(revertable({ facts: [{ kind: 'region', change: 'added', id: 'x' }, { kind: 'layout', change: 'removed', id: 'x' }] }, projection), false);
  });
}
