// Independent terminal-receipt join, shared by the existing raw readers.
// This checks evidence integrity only; a model verdict never replaces an oracle.
import { isDeepStrictEqual as same } from 'node:util';
const kind = 'voice-ui.judge.goal-completion.v1';
const exact = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const graphOf = records => ({
  regions: records.filter(r => r.type === 'region').map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
  edges: records.filter(r => r.type === 'relation').map(({ id, from, to, kind, label }) => ({ id, from, to, kind, label })),
});
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 240 && x !== 'none';
const label = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 120;
const key = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(x);
const graphValid = g => exact(g, ['regions', 'edges']) && Array.isArray(g.regions) && Array.isArray(g.edges)
  && g.regions.length >= 1 && g.regions.length <= 64 && g.edges.length <= 64
  && g.regions.every(r => exact(r, ['id', 'label', 'kind', 'parent']) && id(r.id) && label(r.label)
    && key(r.kind) && (r.parent === null || id(r.parent)))
  && g.edges.every(e => exact(e, ['id', 'from', 'to', 'kind', 'label']) && id(e.id) && id(e.from) && id(e.to)
    && e.from !== e.to && key(e.kind) && typeof e.label === 'string' && e.label.length <= 120);
const changeValid = c => c?.kind === 'region'
  ? c.change === 'placed'
    ? exact(c, ['change', 'kind', 'id', 'anchor', 'direction']) && id(c.id)
      && (c.anchor === 'none' || id(c.anchor)) && ['left', 'right', 'above', 'below', 'none'].includes(c.direction)
      && c.anchor !== c.id && (c.anchor === 'none') === (c.direction === 'none')
    : exact(c, ['change', 'kind', 'id', 'label']) && ['added', 'removed'].includes(c.change) && id(c.id) && label(c.label)
  : exact(c, ['change', 'from', 'to']) && ['added', 'removed'].includes(c.change) && id(c.from) && id(c.to);
export const isGoalCompletionCall = call => call?.request?.kind === kind;
export function readGoalCompletionAnswers(call) {
  const response = call?.response, options = ['complete', 'incomplete', 'unknown'];
  if (!exact(response, ['kind', 'answers']) || response.kind !== 'voice-ui.judge.decision.v1'
    || !exact(response.answers, ['completion'])) return null;
  const a = response.answers.completion;
  if (!a || typeof a !== 'object' || Array.isArray(a)
    || Object.keys(a).some(k => !['type', 'choice', 'confidence', 'probabilities'].includes(k))
    || a.type !== 'choice' || !options.includes(a.choice) || !Number.isFinite(a.confidence)
    || a.confidence < 0 || a.confidence > 1) return null;
  if (a.probabilities !== undefined && (!a.probabilities || typeof a.probabilities !== 'object'
    || Array.isArray(a.probabilities) || Object.entries(a.probabilities).some(([k, v]) =>
      !options.includes(k) || typeof v !== 'number' || !Number.isFinite(v)))) return null;
  return { completion: { type: 'choice', choice: a.choice, confidence: a.confidence } };
}
const contextValid = context => exact(context, ['recent']) && Array.isArray(context.recent) && context.recent.length <= 5
  && context.recent.every((e, i, all) => e && Number.isSafeInteger(e.seq) && e.seq >= 1
    && (!i || e.seq > all[i - 1].seq) && ['voice', 'typed'].includes(e.source)
    && typeof e.text === 'string' && e.text.trim().length > 0 && e.text.length <= 200
    && ['step', 'no-change', 'undo-request', 'refused', 'undone'].includes(e.outcome)
    && exact(e, e.outcome === 'step' ? ['seq', 'source', 'text', 'outcome', 'effect'] : ['seq', 'source', 'text', 'outcome'])
    && (e.outcome !== 'step' || exact(e.effect, ['changes']) && Array.isArray(e.effect.changes)
      && e.effect.changes.length >= 1 && e.effect.changes.length <= 256 && e.effect.changes.every(changeValid)));

export function auditGoalCompletionReceipt(row, judges) {
  if (judges.some(isGoalCompletionCall) || !Object.hasOwn(row.result ?? {}, 'completion')) return;
  const c = row.result.completion;
  if (!exact(c, ['status', 'head', 'confidence', 'basis']) || c.status !== 'unknown' || c.head !== row.final_head
    || c.confidence !== null || c.basis !== 'not-judged') throw Error('terminal-free receipt cannot claim completion');
}

export function auditGoalCompletionTrace({ row, initial, prefix, judges, n, previous }) {
  const call = judges[n];
  if (!isGoalCompletionCall(call)) return false;
  const state = call.request.state, trace = row.result?.trace?.[n], receipt = row.result?.completion;
  const fail = message => { throw Error('terminal completion ' + message); };
  if (!exact(call.request, ['kind', 'state']) || !exact(state, ['utterance', 'initial', 'graph', 'context'])
    || state.utterance !== row.utterance || !contextValid(state.context)) fail('closed request');
  if (!prefix || prefix.n < previous || prefix.verified.head !== row.final_head || trace?.head !== row.final_head
    || initial.head !== row.initial_head || !same(state.initial, graphOf(initial.records))
    || !same(state.graph, graphOf(prefix.verified.records))) fail('whole initial/final graph and head');
  if (![state.initial, state.graph].every(graphValid)) fail('whole graph bounds/schema');
  if (n !== judges.length - 1 || row.calls.at(-1) !== call || judges.filter(isGoalCompletionCall).length !== 1
    || judges.length > 8 || row.result.trace.length !== judges.length
    || row.result.requests !== judges.length + (row.result.inventory?.checks ?? 0)
    || !['none', 'no-executable-delta'].includes(row.result.reason)) fail('last read-only bounded call');
  if (!exact(trace, ['head', 'answers', 'failure'])) fail('closed trace');
  // A NONE from a placement frame or a weak answer never authorizes this check.
  const preceding = judges[n - 1], a = preceding?.response?.answers?.delta;
  if (row.result.reason === 'none' && (preceding?.request?.kind !== 'voice-ui.judge.goal-local-delta.v7'
    || preceding.request.state.placing !== null || a?.choice !== 'none' || !Number.isFinite(a.confidence) || a.confidence < .5)) fail('terminal trigger');
  if (row.result.reason === 'no-executable-delta' && (n === 0
    ? prefix.verified.head !== initial.head
    : preceding?.request?.kind !== 'voice-ui.judge.goal-local-delta.v7' || !a || a.choice === 'none'
      || !Number.isFinite(a.confidence) || a.confidence < .5 || row.result.trace[n - 1].head === row.final_head)) fail('exhaustion trigger');
  const answers = readGoalCompletionAnswers(call), ok = call.status === 200 && !Object.hasOwn(call, 'error');
  if (trace.answers !== null) {
    if (!ok || !answers || !same(trace.answers, answers) || trace.failure !== null) fail('answer/trace');
  } else {
    if (answers && ok || !['judge-contract', 'judge-unknown', 'judge-failed', 'judge-timeout'].includes(trace.failure)) fail('failed trace');
  }
  if (row.valid_execution && (!ok || !answers || trace.failure !== null)) fail('invalid execution promoted');
  if (!exact(receipt, ['status', 'head', 'confidence', 'basis']) || receipt.head !== row.final_head) fail('receipt/head');
  if (receipt.basis === 'not-judged') {
    if (receipt.status !== 'unknown' || receipt.confidence !== null) fail('unconfirmed receipt');
  } else if (receipt.basis === 'jev-judgment') {
    if (!answers || trace.failure !== null || !ok) fail('unsupported verdict');
    const a = answers.completion, expected = a.confidence >= .5 ? a.choice : 'unknown';
    if (receipt.status !== expected || receipt.confidence !== a.confidence) fail('verdict/threshold');
    if (receipt.status !== 'unknown' && (!Number.isFinite(row.result.elapsedMs) || row.result.elapsedMs < 0
      || row.result.elapsedMs >= 180000)) fail('elapsed budget');
  } else fail('receipt basis');
  return true;
}
