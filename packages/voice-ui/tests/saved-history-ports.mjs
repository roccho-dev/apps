import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Test ports only: the actual source handler/render/session/protocol are used,
// but DOM, drawing delivery and storage here are deliberately test doubles.
export async function savedHistoryPorts({ source, protocol }) {
  const load = relative => import(pathToFileURL(path.join(source, relative)));
  const { runGoal } = await load('src/goal.mjs');
  const { readBundle } = await load('src/bundle.mjs');
  const { revertStep, revertable, OUTCOME_STEP } = await load('src/turn.mjs');
  const { createSession, apply, appendRevert } = await load('src/session.mjs');
  const { commitLog, projectHistory, statesOf } = await load('src/log.mjs');
  const { renderControls, drawGraph } = await load('src/render.mjs');
const append = async (graph, operations) => (await protocol.appendDecision(graph.log,
  (await protocol.createDecision(graph.head, operations, graph.records)).decision)).verified;

async function created(input, expected) {
  const initial = await protocol.createDecisionLog(input.initialRecords, 'voice-graph');
  const before = await append(initial, [{ type: 'PinRegions', items: input.pins }]);
  let session = createSession({ accepted: before, stored: before.log }), stored = before.log, calls = 0;
  const bundle = readBundle(input.bundle), bundleBefore = JSON.stringify(bundle);
  const result = await runGoal({ utterance: input.utterance, bundle, protocol, current: () => session,
    cancelled: () => false, adopt: async next => { session = next; }, ask: async request => {
      calls++;
      if (!request.state.candidates) return { kind: 'answered', decision: { answers: {
        completion: { type: 'choice', choice: 'unknown', confidence: 1 },
      } } };
      const intent = input.syntheticIntent;
      const chosen = request.state.selected.some(item => item.key === intent.key) ? null
        : request.state.candidates.find(item => item.part === intent.key && item.parent === intent.parent);
      return { kind: 'answered', decision: { answers: { delta: {
        type: 'choice', choice: chosen?.id ?? 'none', confidence: 1,
      } } } };
    } });
  const after = session.working, draft = session;
  assert.equal(result.selected.length, expected.addedCount);
  const added = after.records.filter(record => record.type === 'region' && !before.records.some(old => old.id === record.id));
  assert.equal(added.length, 1);
  for (const [key, value] of Object.entries(expected.added)) assert.deepEqual(added[0][key], value);
  assert.deepEqual(after.records.filter(row => row.type === 'layout').map(row => row.regionId).sort(), expected.layoutIds.slice().sort());
  assert.equal(JSON.stringify(bundle), bundleBefore, 'the ready candidate catalogue is untouched');
  assert.equal(result.completion.status, 'unknown', 'model complete is not the independent expected result');
  assert.ok(calls <= 8);
  const commit = ({ graph, expected }) => commitLog({ graph, expected, key: 'fixed-history',
    read: async () => stored, write: async (_, value) => { stored = value; },
    lock: async (_, run) => run(), verifyDecisionLog: protocol.verifyDecisionLog });
  const saved = await apply(session, { commit }); assert.equal(saved.result.status, 'committed');
  session = saved.session;
  const history = await projectHistory(session.accepted, { verifyDecisionLog: protocol.verifyDecisionLog });
  const entry = history.entries.at(-1);
  assert.ok(entry.facts.some(fact => fact.kind === 'region') && entry.facts.some(fact => fact.kind === 'layout'));
  return { before, after, draft, session, history, entry, expected, commit, stored: () => stored, calls };
}

function domPort() {
  const document = { createElement: tag => element(tag), createTextNode: text => ({ textContent: text }) };
  function element(tag) {
    return { tag, ownerDocument: document, dataset: {}, style: {}, children: [], disabled: false, textContent: '',
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      get childElementCount() { return this.children.length; },
      querySelectorAll(selector) {
        assert.equal(selector, 'button[data-revert]');
        const all = node => [node, ...(node.children ?? []).flatMap(all)];
        return all(this).filter(node => node.tag === 'button' && node.dataset.revert !== undefined);
      },
    };
  }
  return document.createElement('section');
}
function controls(panel, session) {
  const result = Object.fromEntries(['send', 'mic', 'newMap', 'undo', 'discard', 'apply', 'contextClear'].map(key => [key, {}]));
  result.history = panel;
  renderControls(result, { idle: true, capturing: false, noLog: false, working: true,
    draftLength: session.draft.length, conversationLength: session.conversation.length });
  return result;
}
async function view(graph) {
  let envelope = null;
  const mount = { style: {}, children: [], append(node) { this.children.push(node); }, replaceChildren() { this.children = []; } };
  const document = { defaultView: { getComputedStyle: () => ({ position: 'relative' }) }, createElement: () => {
    const node = { style: {}, remove() { mount.children = mount.children.filter(child => child !== node); } }; return node;
  } };
  await drawGraph({ graph, frame: null, mount, document, protocol,
    renderProjection: async ({ input }) => { envelope = input.envelope; } });
  const projection = await protocol.inspectEnvelope(envelope);
  assert.equal(projection.base.head, graph.head); assert.deepEqual(projection.base.records, graph.records);
  return envelope;
}

// Use the actual current web click handler, not a reimplementation of its
// inverse flow. withSurface/DOM/drawing remain explicit local test ports.
const app = fs.readFileSync(path.join(source, 'web/app.mjs'), 'utf8');
const handlerStart = app.indexOf('historyPanel.addEventListener("click", event => {');
const handlerEnd = app.indexOf('\n});', handlerStart) + 4;
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
async function clickInverse(session, button) {
  let callback, pending = Promise.resolve(), refusal = null;
  const globals = { session, protocol, verifyDecisionLog: protocol.verifyDecisionLog, statesOf, revertStep, appendRevert, OUTCOME_STEP,
    historyPanel: { addEventListener(name, handler) { assert.equal(name, 'click'); callback = handler; } },
    withSurface(_label, run) { pending = run(); },
    refusedBy(_label, result) { refusal = result; },
    async showWorking(next) { await view(next.working); globals.session = next; },
  };
  vm.runInNewContext(app.slice(handlerStart, handlerEnd), globals);
  callback({ target: { closest: () => button } }); await pending;
  return { session: globals.session, refusal };
}

  return { append, created, domPort, controls, view, clickInverse };
}
