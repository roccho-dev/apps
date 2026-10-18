import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGoalCompletionReceipt, auditGoalCompletionTrace, readGoalCompletionAnswers } from './goal-completion-audit.mjs';
const initialRecords = [{ type: 'region', id: 'root', parent: null, label: 'Root', kind: 'boundary' }];
const finalRecords = [...initialRecords, { type: 'region', id: 'part', parent: 'root', label: 'API', kind: 'step' }];
const graph = records => ({ regions: records.map(({ id, parent, label, kind }) => ({ id, label, kind, parent })), edges: [] });
function fixture(choice = 'unknown', confidence = .9) {
  const initial = { head: 'before', records: structuredClone(initialRecords) };
  const prefix = { n: 2, verified: { head: 'after', records: structuredClone(finalRecords) } };
  const prior = { request: { kind: 'voice-ui.judge.goal-local-delta.v7', state: { placing: null } },
    response: { answers: { delta: { choice: 'none', confidence: .9 } } } };
  const call = { request: { kind: 'voice-ui.judge.goal-completion.v1', state: {
    utterance: 'APIを追加', initial: graph(initial.records), graph: graph(prefix.verified.records), context: { recent: [] },
  } }, status: 200, response: { kind: 'voice-ui.judge.decision.v1', answers: {
    completion: { type: 'choice', choice, confidence },
  } } };
  const answers = readGoalCompletionAnswers(call), row = { utterance: 'APIを追加', initial_head: 'before', final_head: 'after',
    valid_execution: true, calls: [prior, call], result: { reason: 'none', requests: 2, elapsedMs: 20,
      trace: [{ head: 'after', answers: { delta: { type: 'choice', choice: 'none', confidence: .9 } }, failure: null },
        { head: 'after', answers, failure: null }], completion: {
        status: confidence >= .5 ? choice : 'unknown', head: 'after', confidence, basis: 'jev-judgment',
      } } };
  return { row, initial, prefix, judges: row.calls, n: 1, previous: 2 };
}
test('unknown is a valid terminal observation and does not become a semantic success', () => {
  const a = fixture(); assert.equal(auditGoalCompletionTrace(a), true);
  assert.equal(a.row.result.completion.status, 'unknown');
  for (const choice of ['complete', 'incomplete']) for (const confidence of [.49, .5, 1]) {
    const a = fixture(choice, confidence); assert.equal(auditGoalCompletionTrace(a), true);
    assert.equal(a.row.result.completion.status, confidence >= .5 ? choice : 'unknown');
  }
});
test('terminal schema, graph, head, order, verdict and shared budget cannot be substituted', () => {
  for (const change of [
    a => { a.judges[1].request.state.extra = 'oracle'; },
    a => { a.judges[1].request.kind += '-forged'; },
    a => { a.judges[1].request.state.graph.regions[1].parent = 'elsewhere'; },
    a => { a.judges[1].request.state.initial.regions = []; },
    a => { a.prefix.verified.head = 'other'; },
    a => { a.row.result.trace[1].head = 'before'; },
    a => { a.row.result.completion.head = 'before'; },
    a => { a.row.calls.push({ route: 'later' }); },
    a => { a.judges.unshift(a.judges[1]); a.n++; },
    a => { while (a.judges.length < 9) a.judges.unshift(a.judges[0]); a.n = 8; },
    a => { a.judges[0].request.state.placing = 'api'; },
    a => { a.judges[0].response.answers.delta.confidence = .49; },
    a => { a.row.result.completion.status = 'complete'; },
    a => { a.row.result.completion.confidence = 1; },
    a => { a.row.result.reason = 'budget-requests'; },
    a => { a.row.result.reason = 'no-executable-delta'; },
    a => { a.row.result.requests = 9; },
    a => { a.judges[1].request.state.context.recent = [{ seq: 1, source: 'typed', text: 'prior', outcome: 'step', effect: { changes: [{ change: 'added', kind: 'region', id: 'part', label: 'API', extra: true }] } }]; },
    a => { a.judges[1].request.state.context.recent = [{ seq: 1, source: 'typed', text: 'prior', outcome: 'step', effect: { changes: [{ change: 'placed', kind: 'region', id: 'part', anchor: 'none', direction: 'left' }] } }]; },
  ]) {
    const a = fixture(); change(a);
    assert.notEqual((() => { try { return auditGoalCompletionTrace(a); } catch { return 'rejected'; } })(), true);
  }
  const late = fixture('complete'); late.row.result.elapsedMs = 180000;
  assert.throws(() => auditGoalCompletionTrace(late));
});
test('exhaustion needs an unchanged start or an actually advanced adopted prefix; no terminal means no positive receipt', () => {
  const start = fixture(); start.row.result.reason = 'no-executable-delta';
  start.row.calls.shift(); start.row.result.trace.shift(); start.row.result.requests = 1; start.n = 0;
  start.initial.head = 'after'; start.initial.records = structuredClone(finalRecords); start.row.initial_head = 'after';
  start.judges[0].request.state.initial = graph(start.initial.records);
  assert.equal(auditGoalCompletionTrace(start), true);
  const advanced = fixture(); advanced.row.result.reason = 'no-executable-delta';
  advanced.judges[0].response.answers.delta.choice = 'delta-1'; advanced.row.result.trace[0].head = 'before';
  assert.equal(auditGoalCompletionTrace(advanced), true);
  const noTerminal = fixture(); noTerminal.row.calls.pop(); noTerminal.row.result.trace.pop(); noTerminal.row.result.requests--;
  noTerminal.row.result.completion = { status: 'unknown', head: 'after', confidence: null, basis: 'not-judged' };
  assert.doesNotThrow(() => auditGoalCompletionReceipt(noTerminal.row, noTerminal.judges));
  noTerminal.row.result.completion.status = 'complete';
  assert.throws(() => auditGoalCompletionReceipt(noTerminal.row, noTerminal.judges));
  delete noTerminal.row.result.completion;
  assert.doesNotThrow(() => auditGoalCompletionReceipt(noTerminal.row, noTerminal.judges), 'legacy has no terminal receipt');
});
test('a failed or malformed terminal stays retained and invalid rather than being promoted', () => {
  for (const mode of ['http', 'malformed']) {
    const a = fixture(), call = a.judges[1];
    if (mode === 'http') { call.status = 503; call.error = 'http_or_contract_unknown'; call.response = { error: 'unavailable' }; }
    else call.response.answers = { completion: { type: 'choice', choice: 'invented', confidence: 1 } };
    a.row.result.trace[1] = { head: 'after', answers: null, failure: mode === 'http' ? 'judge-unknown' : 'judge-contract' };
    a.row.result.completion = { status: 'unknown', head: 'after', confidence: null, basis: 'not-judged' };
    assert.throws(() => auditGoalCompletionTrace(a), 'valid_execution cannot cover failed evidence');
    a.row.valid_execution = false; assert.equal(auditGoalCompletionTrace(a), true);
    assert.equal(a.row.calls.length, 2); assert.equal(a.row.result.trace.length, 2);
    a.row.result.completion = { status: 'complete', head: 'after', confidence: 1, basis: 'jev-judgment' };
    assert.throws(() => auditGoalCompletionTrace(a));
  }
});
