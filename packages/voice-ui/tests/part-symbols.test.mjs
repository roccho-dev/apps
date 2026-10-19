import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle } from '../src/bundle.mjs';
import { runGoal } from '../src/goal.mjs';
import { createSession, undo, apply } from '../src/session.mjs';
import { MAP_ID, STATE_SCHEMA, commitLog, restoreLog } from '../src/log.mjs';
import { drawGraph } from '../src/render.mjs';
import { legalLocalDeltas, proveLocalDelta } from '../src/turn.mjs';

const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP,
  'packages/semantic-map/protocol/index.js')).href);
const symbol = { href: '/assets/sql.svg', alt: 'SQL service', provenanceRef: 'catalog:sql:v1' };
const sourcePart = { key: 'sql-primary', label: 'SQL', kind: 'data', purpose: 'primary database', symbol };
const catalogue = parts => readBundle({ schema: 'voice-ui.bundle/2', version: 'symbol-contract-test', parts, diagrams: [] });
const seed = async () => {
  const initial = await protocol.createDecisionLog([
    { type: 'meta', schema: STATE_SCHEMA, root: 'root', title: 'symbol propagation' },
    { type: 'region', id: 'root', label: 'World', parent: null, kind: 'boundary', bounds: [0, 0, 3000, 2000], summary: '' },
    { type: 'region', id: 'cloud', label: 'Cloud', parent: 'root', kind: 'group', bounds: [0, 0, 1600, 700], summary: '' },
  ], MAP_ID);
  const pin = await protocol.createDecision(initial.head,
    [{ type: 'PinRegions', items: [{ regionId: 'cloud', bounds: [0, 0, 1600, 700] }] }], initial.records);
  return (await protocol.appendDecision(initial.log, pin.decision)).verified;
};
// These two ports are deliberately not a browser or a painted-image assertion.
const documentPort = { defaultView: { getComputedStyle: () => ({ position: 'relative' }) }, createElement: () => {
  const element = { style: {} };
  element.remove = () => { element.parent.children = element.parent.children.filter(child => child !== element); };
  return element;
} };
const mountPort = () => {
  const mount = { style: {}, children: [] };
  mount.append = child => { child.parent = mount; mount.children.push(child); };
  mount.replaceChildren = () => { mount.children = []; };
  return mount;
};
async function projected(graph) {
  let inspected;
  await drawGraph({ graph, frame: null, mount: mountPort(), document: documentPort, protocol,
    renderProjection: async ({ input }) => { inspected = await protocol.inspectEnvelope(input.envelope); } });
  assert.equal(inspected.base.head, graph.head);
  assert.deepEqual(inspected.base.records, graph.records);
  return inspected.envelope.view;
}
async function execute(parts) {
  const original = await seed(), before = createSession({ accepted: original, stored: original.log });
  let session = before;
  const bundle = catalogue(parts), originalBundle = JSON.stringify(bundle);
  const result = await runGoal({ utterance: 'Cloud内にSQLを必要数追加', bundle, protocol,
    current: () => session, cancelled: () => false,
    ask: async request => {
      if (request.kind === 'voice-ui.judge.goal-completion.v1') return { kind: 'answered',
        decision: { answers: { completion: { type: 'choice', choice: 'unknown', confidence: 1 } } } };
      const candidate = request.state.candidates.find(item => item.part !== undefined && item.parent === 'cloud');
      return { kind: 'answered', decision: { answers: { delta: {
        type: 'choice', choice: candidate?.id ?? 'none', confidence: 1,
      } } } };
    },
    adopt: async next => { await projected(next.working); session = next; },
  });
  assert.equal(JSON.stringify(bundle), originalBundle);
  assert.equal(session.stored, before.stored);
  return { before, session, result, bundle };
}

test('supplied symbol and instance identity survive the actual decision log and image/1 projection', async () => {
  const { session, result } = await execute([sourcePart]);
  const region = session.working.records.find(row => row.type === 'region' && row.label === 'SQL');
  assert.ok(region);
  assert.deepEqual(JSON.parse(region.summary), { schema: 'voice-ui.part-description/1', key: sourcePart.key,
    purpose: sourcePart.purpose, symbol });
  const view = await projected(session.working);
  assert.deepEqual(view.resourceComposition, {
    schema: 'typed-resource-composition/1',
    resources: [{ id: 'part-image-1', contract: 'image/1', source: { type: 'url', href: symbol.href }, provenanceRef: symbol.provenanceRef }],
    placements: [{ id: 'part-placement-1', resourceRef: 'part-image-1', targetRef: 'node:' + region.id,
      slot: 'content', view: { alt: symbol.alt, fit: 'contain', opacity: 1 } }],
  });
  assert.equal(result.completion.status, 'unknown', 'projection facts do not require a model complete answer');
});

test('same-name instances keep distinct identities; one shared image survives Undo, save and log readback', async () => {
  const second = { ...sourcePart, key: 'sql-secondary', purpose: 'secondary database' };
  const { before, session } = await execute([sourcePart, second]);
  const regions = session.working.records.filter(row => row.type === 'region' && row.label === 'SQL');
  assert.equal(regions.length, 2);
  assert.deepEqual(regions.map(row => JSON.parse(row.summary).key).sort(), ['sql-primary', 'sql-secondary']);
  const view = await projected(session.working);
  assert.equal(view.resourceComposition.resources.length, 1);
  assert.deepEqual(view.resourceComposition.placements.map(row => row.targetRef).sort(), regions.map(row => 'node:' + row.id).sort());
  const undone = await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(undone.working.records, before.working.records);
  assert.equal(Object.hasOwn(await projected(undone.working), 'resourceComposition'), false);
  let stored = before.stored;
  const saved = await apply(session, { commit: ({ graph, expected }) => commitLog({ graph, expected,
    key: 'test-only', read: async () => stored, write: async (_key, value) => { stored = value; },
    lock: async (_key, call) => call(), verifyDecisionLog: protocol.verifyDecisionLog }) });
  assert.equal(saved.result.status, 'committed');
  assert.equal(stored, session.working.log, 'no separate metadata store or wrapper around the provider log');
  const restored = await restoreLog({ key: 'test-only', read: async () => stored, verifyDecisionLog: protocol.verifyDecisionLog });
  assert.equal(restored.status, 'restored');
  assert.deepEqual(restored.graph.records, session.working.records);
  assert.deepEqual(await projected(restored.graph), view);
});

test('a changed symbol cannot reuse an earlier held candidate', async () => {
  const working = await seed(), bundle = structuredClone(catalogue([sourcePart]));
  const held = legalLocalDeltas(working, { bundle, protocol, expressive: true });
  const candidate = held.candidates.find(row => row.part === sourcePart.key && row.parent === 'cloud');
  assert.ok(candidate);
  bundle.parts[0].symbol.alt = 'changed description';
  const result = await proveLocalDelta({ working, held, candidateId: candidate.id, confidence: 1,
    bundle, protocol, expressive: true });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'stale-addition');
});

test('ordinary parts keep the old empty summary and no resource composition', async () => {
  const { symbol: unused, ...ordinary } = sourcePart;
  const { session } = await execute([ordinary]);
  const region = session.working.records.find(row => row.type === 'region' && row.label === 'SQL');
  assert.equal(region.summary, '');
  assert.equal(Object.hasOwn(await projected(session.working), 'resourceComposition'), false);
});

test('conflicting provenance of one image source stops the new adoption instead of silently choosing', async () => {
  const other = { ...sourcePart, key: 'sql-other', symbol: { ...symbol, provenanceRef: 'conflicting:origin' } };
  const { before, session, result } = await execute([sourcePart, other]);
  assert.equal(session.working.records.filter(row => row.type === 'region' && row.label === 'SQL').length, 1);
  assert.equal(session.stored, before.stored);
  assert.equal(result.reason, 'adoption-unknown');
});

test('stored app descriptions reject unsafe resources, duplicate keys and unknown fields', async () => {
  const base = await seed();
  const valid = { schema: 'voice-ui.part-description/1', key: sourcePart.key, purpose: sourcePart.purpose, symbol };
  for (const summary of [
    JSON.stringify({ ...valid, symbol: { ...symbol, href: 'https://untrusted.invalid/sql.svg' } }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify(valid).replace('"key":"sql-primary"', '"key":"ignored","key":"sql-primary"'),
  ]) {
    const graph = await protocol.createDecisionLog(base.records.filter(row => row.type !== 'layout').map(row =>
      row.id === 'cloud' ? { ...row, summary } : row), MAP_ID);
    await assert.rejects(() => projected(graph), /invalid stored part description/);
  }
});

test('ordinary descriptions and unrelated JSON do not manufacture image resources', async () => {
  const base = await seed();
  for (const summary of ['human readable description', '{"schema":"another/1","symbol":"not an image"}']) {
    const graph = await protocol.createDecisionLog(base.records.filter(row => row.type !== 'layout').map(row =>
      row.id === 'cloud' ? { ...row, summary } : row), MAP_ID);
    assert.equal(Object.hasOwn(await projected(graph), 'resourceComposition'), false);
  }
});
