// Independent stopped-receipt integrity. This never sends a provider request,
// observes credentials, or promotes recorded testimony to CI-origin execution.
import { canonical } from './semantic-score.mjs';
import { auditGoalCompletionReceipt, auditGoalCompletionTrace, isGoalCompletionCall, readGoalCompletionAnswers } from './goal-completion-audit.mjs';
import { validateAxisInput, axisSchedule, gradeGateAxes, gradeSupply, gradeReady, gradeOrdinary,
  summarizeGate, summarizeSupply, summarizeReady, summarizeOrdinary } from './component-axis-score.mjs';
import { sha256, jsonLines, combineFactors, auditProviderPhase, auditReplayJoin } from './receipt-admissibility.mjs';
export { auditProviderPhase, auditReplayJoin };

export function auditAxisProviderPhase(bytes, expectedSends, { axis, caseCount }) {
  if (!['G', 'R', 'F', 'E'].includes(axis) || !Number.isInteger(caseCount) || caseCount < 1 || caseCount > 10) throw Error('axis phase budget shape');
  const bounds = Object.fromEntries(['jev', 'typellm'].map(p => {
    const v = expectedSends[p], b = typeof v === 'number' ? { min: v, max: v } : v;
    if (!b || Object.keys(b).sort().join() !== 'max,min' || !Number.isInteger(b.min) || !Number.isInteger(b.max)
        || b.min < 0 || b.max < b.min || b.max > 300) throw Error('external send bounds');
    return [p, b];
  }));
  const actual = { jev: 0, typellm: 0 };
  for (const line of Buffer.from(bytes.stderrBytes).toString('utf8').split('\n')) {
    const m = /^provider-send:(jev|typellm):([1-9][0-9]*)$/.exec(line); if (m) actual[m[1]]++;
  }
  // Generic admission checks the complete sequence, journal and stopped cutoff;
  // local failed HTTP alone cannot reveal whether upstream was reached.
  const report = auditProviderPhase(bytes, actual), config = decode(bytes.configBytes), issues = [...report.issues];
  const max = axis === 'F' ? { jev: 0, typellm: caseCount }
    : { jev: caseCount * (axis === 'R' ? 8 : axis === 'E' ? 9 : 1), typellm: 0 };
  const start = { jev: 564, typellm: 29 }, limit = { jev: 290, typellm: 11 }, remaining = {};
  for (const p of ['jev', 'typellm']) {
    if (report.sent[p] < bounds[p].min || report.sent[p] > bounds[p].max) issues.push('actual send outside raw bounds ' + p);
    if (config.allowances[p] > max[p] || bounds[p].max > max[p] || report.prior_charged?.[p] < start[p]
        || report.prior_charged?.[p] + config.allowances[p] > start[p] + limit[p]
        || report.charged_at_cutoff[p] > start[p] + limit[p]) issues.push('axis/cycle budget ' + p);
    remaining[p] = start[p] + limit[p] - report.charged_at_cutoff[p];
  }
  return { ...report, status: issues.length ? 'FAIL' : 'PASS', issues, expected_external_bounds: bounds,
    cycle_start: start, cycle_limit: limit, cycle_remaining: remaining };
}

const decode = b => JSON.parse(Buffer.from(b).toString('utf8'));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const pair = row => row.id + '/' + row.method;
const endFields = c => ({ status: c.status ?? null, elapsedMs: c.elapsedMs,
  ...(Object.hasOwn(c, 'response') ? { response: c.response } : {}), ...(Object.hasOwn(c, 'error') ? { error: c.error } : {}) });
const reasons = new Set(['none', 'not-confident', 'no-executable-delta', 'candidate-overflow', 'budget-requests', 'budget-time',
  'inventory-not-confident', 'inventory-ambiguous', 'inventory-no-change', 'inventory-unsupported', 'inventory-unresolved', 'completion-empty']);
const sourceNames = ['src/completion.mjs', 'src/literal-inventory.mjs', 'src/goal.mjs', 'src/contract.mjs', 'src/turn.mjs', 'src/session.mjs',
  'functions/api/parts.mjs', 'functions/pages-worker.mjs', 'web/app.mjs', 'web/adapters/completion.mjs',
  'tests/component-axes-eval.mjs', 'tests/component-axis-score.mjs', 'tests/evaluation-http.mjs', 'tests/painted-goal.mjs'];
const inventoryOf = (item, initial, parts) => ({ kind: 'voice-ui.goal.inventory.v1', state: {
  utterance: item.utterance, head: initial.head,
  regions: initial.records.filter(r => r.type === 'region').map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
  edges: initial.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })), parts,
} });
const offersOf = parts => parts.map(({ key, purpose, label }) => ({ key, purpose, label }));
function suppliedParts(parts, missing) {
  if (!gradeSupply(missing, missing).contract_valid) throw Error('completion row shape');
  const keys = new Set(parts.map(p => p.key)); let next = 0;
  return [...parts, ...missing.map(x => {
    let key; do { key = 'goal-extra-' + ++next; } while (keys.has(key)); keys.add(key);
    return { key, label: x.label, kind: x.kind,
      purpose: `one requested part named ${x.label}, kind ${x.kind}, missing instance ${x.occurrence}` };
  })];
}

function readGoalAnswers(call) {
  if (isGoalCompletionCall(call)) return readGoalCompletionAnswers(call);
  const state = call?.request?.state, response = call?.response;
  if (response?.kind !== 'voice-ui.judge.decision.v1' || !response.answers || Array.isArray(response.answers)
      || Object.keys(response.answers).join() !== 'delta') return null;
  const answer = response.answers.delta;
  const options = state?.placing === null
    ? [...new Set((state.candidates ?? []).filter(c => c.action === 'add-part').map(c => 'part:' + c.part)),
      ...(state.candidates ?? []).filter(c => c.action === 'add-edge').map(c => c.id), 'none']
    : [...(state?.candidates ?? []).filter(c => c.action === 'add-part' && c.part === state?.placing).map(c => c.id), 'none'];
  if (answer?.type !== 'choice' || !options.includes(answer.choice) || !Number.isFinite(answer.confidence)
      || answer.confidence < 0 || answer.confidence > 1
      || Object.keys(answer).some(k => !['type', 'choice', 'confidence', 'probabilities'].includes(k))) return null;
  if (answer.probabilities !== undefined && (!answer.probabilities || Array.isArray(answer.probabilities)
      || typeof answer.probabilities !== 'object' || Object.entries(answer.probabilities)
        .some(([k, v]) => !options.includes(k) || typeof v !== 'number' || !Number.isFinite(v)))) return null;
  return { delta: { type: 'choice', choice: answer.choice, confidence: answer.confidence } };
}

function traceMatches(trace, call, axis) {
  const browserEnvelope = call?.response && Object.keys(call.response).every(k => ['kind', 'answers'].includes(k));
  const answers = axis === 'E' && !browserEnvelope ? null : readGoalAnswers(call), ok = call?.status === 200 && !Object.hasOwn(call ?? {}, 'error');
  if (trace.answers !== null) return ok && answers !== null && same(trace.answers, answers) && trace.failure === null;
  if (answers !== null && ok) return false;
  if (axis === 'R') {
    const answered = ok && call.response?.kind === 'voice-ui.judge.decision.v1';
    return trace.failure === (answered ? 'judge-contract' : 'judge-unknown');
  }
  if (ok) return trace.failure === 'judge-contract';
  // The browser timer starts before interception, so its interval cannot be
  // inferred from the interceptor's later, separate elapsed clock.
  return trace.failure === 'judge-failed' || trace.failure === 'judge-timeout' && Object.hasOwn(call ?? {}, 'error');
}

function auditAddedRecords(row, initial, effectiveParts, judges) {
  const oldIds = new Set(initial.records.map(r => r.id)), added = row.final_records.filter(r => !oldIds.has(r.id));
  const regions = added.filter(r => r.type === 'region'), edges = added.filter(r => r.type === 'relation');
  const selected = row.result?.selected;
  if (!Array.isArray(selected)) { if (row.valid_execution || added.length) throw Error('missing selected proof'); return; }
  if (selected.length !== regions.length || new Set(selected.map(s => s.key)).size !== selected.length
      || new Set(selected.map(s => s.region)).size !== selected.length) throw Error('selected/new region multiplicity');
  for (const s of selected) {
    const r = regions.find(r => r.id === s.region), part = effectiveParts.find(p => p.key === s.key);
    if (!s || Object.keys(s).sort().join() !== 'key,parent,region' || !r || !part
        || r.parent !== s.parent || r.label !== part.label || r.kind !== part.kind) throw Error('adopted part binding');
    const supported = judges.some((call, i) => {
      const where = readGoalAnswers(call)?.delta, before = judges[i - 1], what = readGoalAnswers(before)?.delta;
      return call.request.state.placing === s.key && where?.confidence >= 0.5 && what?.confidence >= 0.5 && what.choice === 'part:' + s.key
        && before.request.state.placing === null && row.result.trace[i].head === row.result.trace[i - 1].head
        && call.request.state.candidates.some(c => c.id === where.choice && c.action === 'add-part' && c.part === s.key && c.parent === s.parent);
    });
    if (!supported) throw Error('adopted part without chosen offered delta');
  }
  for (const edge of edges) if (!judges.some(call => {
    const a = readGoalAnswers(call)?.delta;
    return call.request.state.placing === null && a?.confidence >= 0.5 && call.request.state.candidates
      .some(c => c.id === a.choice && c.action === 'add-edge' && c.from === edge.from && c.to === edge.to);
  })) throw Error('adopted edge without chosen offered delta');
}

function parseRoute(route) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) throw Error('route shape');
  const url = new URL(route, 'http://fixture.invalid'), keys = [...url.searchParams.keys()];
  if (keys.some(k => k !== 'method') || url.searchParams.getAll('method').length > 1 || url.hash) throw Error('route query');
  const method = url.searchParams.get('method') ?? 'literal';
  if (!['literal', 'typed'].includes(method)) throw Error('route method');
  return { path: url.pathname, method };
}

function auditEvents(bytes, rows, summary) {
  const events = jsonLines(bytes), issues = []; let at = 0, previous = -Infinity;
  for (const e of events) { const time = Date.parse(e.at); if (!Number.isFinite(time) || time < previous) issues.push('event time order'); previous = time; }
  const take = kind => { const e = events[at++]; if (e?.kind !== kind) issues.push('event sequence ' + kind); return e; };
  for (const [index, row] of rows.entries()) {
    const start = take('cell-start');
    if (start?.axis !== row.axis || start?.id !== row.id || start?.method !== row.method || start?.arm !== row.arm
        || start?.initial_head !== row.initial_head || start?.initial_log_sha256 !== sha256(row.initial_log)) issues.push('cell start');
    for (const c of row.calls) {
      const a = take('http-start'), b = take('http-end');
      if (a?.axis !== row.axis || a?.method !== row.method || a?.id !== row.id || a?.arm !== row.arm || a?.n !== c.n
          || a?.route !== c.route || !same(a?.request, c.request) || b?.id !== row.id || b?.arm !== row.arm || b?.n !== c.n
          || !same(endFields(b ?? {}), endFields(c))) issues.push('HTTP start/end/call join');
    }
    const end = take('cell-end');
    const wanted = summary[index];
    if (!same({ axis: end?.axis, id: end?.id, method: end?.method, valid_execution: end?.valid_execution, calls: end?.calls }, wanted)
        || end?.final_head !== row.final_head) issues.push('cell end');
  }
  if (at !== events.length) issues.push('unjoined events');
  return issues;
}

function literalLogs(stdoutBytes) {
  const rows = [];
  for (const line of Buffer.from(stdoutBytes).toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let value; try { value = JSON.parse(line); } catch { if (line.includes('voice-ui.parts.')) throw Error('malformed factor JSON'); continue; }
    if (['voice-ui.parts.factors.v1', 'voice-ui.parts.literal.v1'].includes(value?.kind)) rows.push(value);
  }
  return rows;
}

function partitionFactorLogs(logs, calls) {
  const validFactor = (row, call) => {
    try { combineFactors(row); return row.head === call.request?.state?.head; } catch { return false; }
  };
  const validLiteral = (row, call, factor) => row?.kind === 'voice-ui.parts.literal.v1' && row.head === call.request?.state?.head
    && typeof row.recognized === 'boolean' && Number.isInteger(row.required_count) && row.required_count >= 0 && row.required_count <= 3
    && ['complete', 'incomplete'].includes(row.completeness?.choice) && Number.isFinite(row.completeness?.confidence)
    && row.completeness.confidence >= 0 && row.completeness.confidence <= 1
    && (row.choice === 'unknown' ? row.confidence === null : ['sufficient', 'missing', 'ambiguous', 'no-change', 'unsupported'].includes(row.choice)
      && row.confidence === (factor.factors.intent.choice === 'change'
        ? Math.min(factor.factors.intent.confidence, row.completeness.confidence) : factor.factors.intent.confidence));
  const memo = new Map();
  const visit = (at, pos) => {
    const key = at + '/' + pos; if (memo.has(key)) return memo.get(key);
    if (at === calls.length) return { ways: pos === logs.length ? 1 : 0, plan: [] };
    const call = calls[at], sizes = [];
    if (call.status === 200) {
      try { recomputeLiteral(logs[pos], logs[pos + 1], call); sizes.push(2); } catch { /* no matching successful factor pair */ }
    } else {
      sizes.push(0);
      if (validFactor(logs[pos], call)) { sizes.push(1); if (validLiteral(logs[pos + 1], call, logs[pos])) sizes.push(2); }
    }
    let ways = 0, plan = null;
    for (const n of sizes) {
      const next = visit(at + 1, pos + n);
      if (next.ways) { plan ??= [logs.slice(pos, pos + n), ...next.plan]; ways = Math.min(2, ways + next.ways); }
    }
    const result = { ways, plan }; memo.set(key, result); return result;
  };
  return visit(0, 0);
}

function recomputeLiteral(factor, literal, call) {
  combineFactors(factor); // validate the retained three factors, not their old coverage formula
  const s = call.request.state, response = call.response, inspection = response?.inspection;
  if (factor.head !== s.head || literal?.head !== s.head || literal?.kind !== 'voice-ui.parts.literal.v1'
      || inspection?.source !== 'literal+jev' || !same(literal.completeness, inspection.completeness)
      || literal.recognized !== inspection.recognized || !Array.isArray(inspection.required)
      || literal.required_count !== inspection.required.reduce((n, r) => n + r.quantity, 0)) throw Error('literal log/body join');
  const c = inspection.completeness, intent = factor.factors.intent;
  if (!c || !['complete', 'incomplete'].includes(c.choice) || typeof c.confidence !== 'number'
      || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) throw Error('completeness factor');
  const references = s.regions.filter(r => r.kind !== 'group' && r.kind !== 'boundary' && s.utterance.includes(r.label));
  const required = inspection.required;
  const validRequired = required.length <= 3 && required.every(r => r && Object.keys(r).sort().join() === 'kind,label,quantity'
    && typeof r.label === 'string' && r.label.trim().length && r.label.length <= 120
    && ['step', 'decision', 'data', 'start', 'end', 'group'].includes(r.kind)
    && Number.isInteger(r.quantity) && r.quantity >= 1 && r.quantity <= 3)
    && new Set(required.map(r => JSON.stringify([r.label, r.kind]))).size === required.length
    && required.reduce((n, r) => n + r.quantity, 0) <= 3;
  if (!validRequired || !Array.isArray(inspection.spans) || typeof inspection.recognized !== 'boolean'
      || inspection.recognized !== (inspection.spans.length > 0)) throw Error('literal extraction shape');
  const totals = new Map(), seenSpans = new Set();
  for (const span of inspection.spans) {
    if (!span || Object.keys(span).sort().join() !== 'end,kind,label,quantity,source,start'
        || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start
        || span.end > s.utterance.length || span.source !== s.utterance.slice(span.start, span.end)
        || span.source !== span.label || !required.some(r => r.label === span.label && r.kind === span.kind)
        || !Number.isInteger(span.quantity) || span.quantity < 1 || span.quantity > 3) throw Error('literal source span');
    const interval = JSON.stringify([span.start, span.end]);
    if (seenSpans.has(interval)) throw Error('repeated literal source span'); seenSpans.add(interval);
    const k = JSON.stringify([span.label, span.kind]); totals.set(k, (totals.get(k) ?? 0) + span.quantity);
  }
  if (required.some(r => totals.get(JSON.stringify([r.label, r.kind])) !== r.quantity)) throw Error('literal span multiplicity');
  const expectedMissing = required.flatMap(r => Array.from({ length: Math.max(0,
    r.quantity - s.parts.filter(p => p.label === r.label && p.kind === r.kind).length) }, (_, i) =>
    ({ label: r.label, kind: r.kind, occurrence: i + 1 })));
  if (!gradeSupply(inspection.missing, expectedMissing).exact) throw Error('literal inventory difference');
  const ready = validRequired && (inspection.recognized || required.length === 0 && new Set(references.map(r => r.label)).size >= 2);
  const choice = intent.choice !== 'change' ? intent.choice : ready && c.choice === 'complete' && c.confidence >= 0.5
    ? inspection.missing.length ? 'missing' : 'sufficient' : 'unknown';
  const confidence = choice === 'unknown' ? null : intent.choice !== 'change' ? intent.confidence : Math.min(intent.confidence, c.confidence);
  if (!same({ choice, confidence }, { choice: response.choice, confidence: response.confidence })
      || !same({ choice, confidence }, { choice: literal.choice, confidence: literal.confidence })) throw Error('literal factor recomputation');
  return { decision: { choice, confidence }, inspection, intent, completeness: c };
}

function auditFrames(frames, raw, assessGoal, assessEdge) {
  const issues = [], regions = raw.final_records.filter(r => r.type === 'region'), edges = raw.final_records.filter(r => r.type === 'relation');
  const groups = regions.filter(r => r.kind === 'group' && r.parent !== null);
  const cameras = ['overview', ...groups.map(r => r.id), ...edges.map(r => r.id)];
  const failures = [];
  if (!Array.isArray(frames) || !same(frames.map(f => f.camera), cameras)) return { status: 'FAIL', issues: ['required E cameras'], paint: 'UNPROVEN' };
  for (const frame of frames.slice(1)) {
    const group = groups.find(r => r.id === frame.camera), edge = edges.find(r => r.id === frame.camera), o = frame.observation;
    const expected = group ? regions.filter(r => r.parent === group.id) : [edge.from, edge.to].map(id => regions.find(r => r.id === id));
    if (o?.identity !== true || o?.association !== 'render-owned-semantic-id' || group && o.container?.id !== group.id
        || edge && (o.edge?.from !== edge.from || o.edge?.to !== edge.to)
        || !same(o?.shapes?.map(s => ({ id: s.id, label: s.rawLabel })), expected.map(s => ({ id: s.id, label: s.label })))) issues.push('E semantic paint association');
    const result = group ? assessGoal(o) : assessEdge(o);
    if (!same(result, frame.assessment)) issues.push('E paint recomputation');
    if (result.status !== 'PASS') failures.push(result.status);
  }
  return { status: issues.length ? 'FAIL' : 'PASS', issues,
    paint: frames.length <= 1 || failures.includes('UNPROVEN') ? 'UNPROVEN' : failures.length ? 'UNMET' : 'PASS' };
}

// One axis per stopped provider phase. The full stdout is consumed exactly;
// callers must not slice away another axis's factors to obtain an axis PASS.
export async function auditAxisRaw({ projectionBytes, oracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes,
  assessGoal, assessEdge, replayBytes = null, artifactManifestBytes = null, phaseKind = 'public', parentProjectionBytes = null }) {
  const input = decode(projectionBytes), oracle = decode(oracleBytes), bundle = decode(bundleBytes), issues = [];
  validateAxisInput(input);
  if (oracle.schema !== 'voice-ui.component-axes-oracle/1' || oracle.axis !== input.axis || input.oracle_sha256 !== sha256(oracleBytes)
      || !same(input.fixture_contract, oracle.fixture_contract) || !same(bundle.parts, oracle.stock_parts)) throw Error('axis input/oracle/stock binding');
  if (!['public', 'fresh', 'correction'].includes(phaseKind)) throw Error('axis phase kind');
  const publicCount = { G: 4, R: 2, F: 3, E: 4 }[input.axis], freshCount = { G: 10, R: 8, F: 8, E: 10 }[input.axis];
  if (phaseKind === 'public' && input.cases.length !== publicCount
      || phaseKind === 'fresh' && input.cases.length !== freshCount
      || phaseKind === 'correction' && oracle.cases.length !== publicCount) throw Error('preregistered axis denominator');
  if (phaseKind === 'fresh' && ['G', 'E'].includes(input.axis)) {
    const sufficient = oracle.cases.filter(c => c.expected_gate === 'sufficient').length;
    const missing = oracle.cases.filter(c => c.expected_gate === 'missing').length;
    const controls = oracle.cases.filter(c => ['ambiguous', 'no-change', 'unsupported'].includes(c.expected_gate)).length;
    if (sufficient !== 4 || missing !== 4 || controls !== 2) throw Error('fresh gate/ordinary strata');
  }
  if (phaseKind === 'fresh' && input.axis === 'F'
      && !oracle.cases.every(c => c.expected_gate === 'missing' && c.expected_missing?.length > 0)) throw Error('fresh supply missing denominator');
  const parent = parentProjectionBytes === null ? null : decode(parentProjectionBytes);
  if (phaseKind === 'correction') {
    if (parent === null) throw Error('correction parent required');
    validateAxisInput(parent);
    if (parent.axis !== input.axis || parent.oracle_sha256 !== input.oracle_sha256 || !same(parent.fixture_contract, input.fixture_contract)
        || parent.cases.length !== oracle.cases.length
        || parent.cases.some((c, i) => !same(c, { id: oracle.cases[i].id, fixture: oracle.cases[i].fixture,
          utterance: oracle.cases[i].utterance, ...(input.axis === 'R' ? { parts: oracle.cases[i].parts } : {}) }))
        || input.cases.some(c => !same(c, parent.cases.find(p => p.id === c.id)))) throw Error('correction faithful parent subset');
  } else if (parent !== null || input.cases.length !== oracle.cases.length) throw Error('full axis panel cannot be subset');
  for (const [i, c] of input.cases.entries()) {
    const o = phaseKind === 'correction' ? oracle.cases.find(o => o.id === c.id) : oracle.cases[i];
    if (!same(c, { id: o.id, fixture: o.fixture, utterance: o.utterance, ...(input.axis === 'R' ? { parts: o.parts } : {}) })) throw Error('axis oracle case order');
  }
  const identity = decode(rawFiles['identity.json']), execution = decode(rawFiles['execution.json']), planned = axisSchedule(input), summary = execution.summary;
  if (identity.schema !== 'voice-ui.component-axes-execution/1' || identity.axis !== input.axis
      || identity.inputs_sha256 !== sha256(projectionBytes) || identity.bundle_sha256 !== sha256(bundleBytes)
      || !same(identity.case_order, input.cases.map(c => c.id))
      || !same(Object.keys(identity.source_sha256 ?? {}).sort(), [...sourceNames].sort())) issues.push('axis execution identity');
  if (execution.schema !== 'voice-ui.component-axes-phase/1' || execution.axis !== input.axis || execution.expected_cells !== planned.length
      || !Array.isArray(summary) || summary.length > planned.length) throw Error('axis terminal plan');
  if (summary.some((r, i) => r.axis !== input.axis || pair(r) !== pair(planned[i]))) throw Error('axis consumed order');
  const names = ['identity.json', 'execution.json', 'events.jsonl', ...summary.map(r => r.id + '-' + (r.method === 'ready' ? 'A' : r.method === 'typed' ? 'C' : 'B') + '.json')].sort();
  if (!same(Object.keys(rawFiles).sort(), names)) issues.push('axis exact raw inventory');
  const initials = new Map(), rows = [], graded = [], proofs = [], checks = [], sends = { jev: 0, typellm: 0 }, lowerSends = { jev: 0, typellm: 0 };
  const logRows = literalLogs(stdoutBytes);
  const gateStream = summary.flatMap(s => decode(rawFiles[s.id + '-' + (s.method === 'ready' ? 'A' : s.method === 'typed' ? 'C' : 'B') + '.json'])
    .calls.filter(c => parseRoute(c.route).path === '/api/parts/check'));
  const factorPartition = partitionFactorLogs(logRows, gateStream); let gateAt = 0;
  if (!factorPartition.ways) issues.push('unjoined or inconsistent factor stdout');
  let replay = null;
  if (replayBytes !== null) {
    if (!['R', 'E'].includes(input.axis) || artifactManifestBytes === null
        || typeof assessGoal !== 'function' || typeof assessEdge !== 'function') throw Error('unexpected replay scope');
    replay = auditReplayJoin({ replayBytes, rawFiles, artifactManifestBytes, assessGoal, assessEdge });
    if (replay.status !== 'PASS') issues.push('ready completed-artifact replay join');
  }
  for (const [index, itemSummary] of summary.entries()) {
    const p = planned[index], arm = p.compatibility_arm, row = decode(rawFiles[p.id + '-' + arm + '.json']); rows.push(row);
    const item = input.cases.find(c => c.id === p.id), o = oracle.cases.find(c => c.id === p.id);
    if (row.schema !== 'voice-ui.component-axes-cell/1' || row.axis !== input.axis || row.id !== p.id || row.method !== p.method
        || row.arm !== arm || row.fixture !== item.fixture || row.utterance !== item.utterance
        || !same(row.parts, input.axis === 'R' ? item.parts : bundle.parts)
        || !same(itemSummary, { axis: row.axis, id: row.id, method: row.method, valid_execution: row.valid_execution, calls: row.calls?.length })) issues.push('raw cell/input/summary');
    if (!Array.isArray(row.calls)) throw Error('raw calls');
    if (!initials.has(row.id)) {
      const f = input.fixture_contract, sub = f.fixtures[item.fixture];
      const made = await protocol.createDecisionLog([...f.base_records, ...sub.extra_records], f.map_id);
      const pin = await protocol.createDecision(made.head, [{ type: 'PinRegions', items: [...f.base_pins, ...sub.extra_pins] }], made.records);
      initials.set(row.id, (await protocol.appendDecision(made.log, pin.decision)).verified);
    }
    const initial = initials.get(row.id); let proofIssue = false;
    try {
      const final = await protocol.verifyDecisionLog(row.final_log);
      if (row.initial_log !== initial.log || row.initial_log_sha256 !== sha256(initial.log) || row.initial_head !== initial.head
          || !same(row.initial_records, initial.records) || !row.final_log.startsWith(initial.log)
          || final.head !== row.final_head || !same(final.records, row.final_records)) throw Error('log projection');
      if (['G', 'F'].includes(input.axis) && (row.final_log !== initial.log || row.final_head !== initial.head || !same(row.final_records, initial.records))) throw Error('isolated axis adopted graph');
      const judges = row.calls.filter(c => parseRoute(c.route).path === '/api/judge');
      auditGoalCompletionReceipt(row, judges);
      if (['R', 'E'].includes(input.axis)) {
        const completed = row.calls.find(c => parseRoute(c.route).path === '/api/parts/complete' && c.status === 200);
        const effectiveParts = input.axis === 'R' ? item.parts : completed ? suppliedParts(bundle.parts, completed.response?.missing) : bundle.parts;
        const prefixes = new Map(), lines = row.final_log.trimEnd().split('\n');
        for (let n = initial.decisions.length; n <= lines.length; n++) {
          const v = await protocol.verifyDecisionLog(lines.slice(0, n).join('\n') + '\n'); prefixes.set(v.head, { n, verified: v });
        }
        if (row.valid_execution && judges.length !== row.result?.trace?.length) throw Error('trace count');
        let previous = initial.decisions.length;
        for (const [n, trace] of (row.result?.trace ?? []).entries()) {
          const prefix = prefixes.get(trace.head), call = judges[n], state = call?.request?.state;
          if (auditGoalCompletionTrace({ row, initial, prefix, judges, n, previous })) { previous = prefix.n; continue; }
          if (call?.request?.kind !== 'voice-ui.judge.goal-local-delta.v7' || !prefix || prefix.n < previous || !traceMatches(trace, call, input.axis) || state?.utterance !== item.utterance
              || !same(state.graph, prefix.verified.records.filter(r => r.type === 'region').map(({ id, label, parent }) => ({ id, label, parent })))
              || !same(state.edges, prefix.verified.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })))
              || !same(state.offers, { parts: offersOf(effectiveParts) })) throw Error('trace snapshot/offered inventory');
          previous = prefix.n;
        }
        auditAddedRecords(row, initial, effectiveParts, judges);
      }
    } catch { proofIssue = true; issues.push('axis protocol/prefix/trace ' + pair(row)); }
    proofs.push({ id: row.id, method: row.method, status: proofIssue ? 'FAIL' : 'PASS', initial_head: initial.head, final_head: row.final_head });
    const inv = inventoryOf(item, initial, bundle.parts), typedCalls = [], prepCalls = [], gateCalls = [], judges = [];
    for (const [n, call] of row.calls.entries()) {
      const route = parseRoute(call.route);
      if (call.id !== row.id || call.arm !== arm || call.n !== n + 1) issues.push('HTTP cell identity');
      if (route.path === '/api/parts/check') { sends.jev++; gateCalls.push(call); checks.push(call);
        if (call.status === 200) lowerSends.jev++;
        if (route.method !== 'literal' || !same(call.request, inv)) issues.push('G/E original inventory request');
      } else if (route.path === '/api/parts/complete') { prepCalls.push(call);
        if (!same(call.request, inv) || route.method !== (input.axis === 'F' ? row.method : 'literal')) issues.push('F/E original completion request');
        if (route.method === 'typed') { sends.typellm++; typedCalls.push(call); if (call.status === 200) lowerSends.typellm++; }
      } else if (route.path === '/api/judge') { sends.jev++; judges.push(call); if (call.status === 200) lowerSends.jev++; }
      else issues.push('unknown API path');
      if (!Object.hasOwn(call, 'status') || !Number.isFinite(call.elapsedMs) || call.elapsedMs < 0) issues.push('HTTP terminal fields');
    }
    const httpValid = row.calls.every(c => c.status === 200 && !Object.hasOwn(c, 'error') && Object.hasOwn(c, 'response'));
    if (row.valid_execution && !httpValid) issues.push('valid cell with failed HTTP');
    let gateGrade = null;
    if (['G', 'E'].includes(input.axis)) {
      if (gateCalls.length !== 1 || row.calls[0] !== gateCalls[0]) issues.push('one initial literal gate');
      const allocated = factorPartition.plan?.[gateAt++] ?? [];
      if (gateCalls[0]?.status === 200) {
        try {
          const observation = recomputeLiteral(allocated[0], allocated[1], gateCalls[0]);
          if (input.axis === 'G' && !same(row.result, gateCalls[0].response)
              || input.axis === 'E' && !same(row.result?.inventory?.coverage, gateCalls[0].response)) issues.push('raw gate/result equality');
          gateGrade = gradeGateAxes(observation, o, bundle.parts);
        } catch { issues.push('literal factor/body recomputation ' + pair(row)); }
      }
    }
    if (input.axis === 'G') {
      if (row.calls.length !== 1 || prepCalls.length || judges.length) issues.push('G isolation');
      if (!httpValid && !same(row.result, { reason: 'evaluation-operation-unknown' })) issues.push('G closed failed result');
      graded.push({ id: row.id, method: row.method, expected_intent: o.expected_intent, expected_gate: o.expected_gate, grade: gateGrade });
    } else if (input.axis === 'F') {
      if (row.calls.length !== 1 || prepCalls.length !== 1 || gateCalls.length || judges.length
          || httpValid && !same(row.result, prepCalls[0]?.response)
          || !httpValid && !same(row.result, { reason: 'evaluation-operation-unknown' })) issues.push('F isolation/result equality');
      graded.push({ id: row.id, method: row.method, grade: gradeSupply(row.result?.missing, o.expected_missing) });
    } else if (input.axis === 'R') {
      if (gateCalls.length || prepCalls.length || judges.length > 8 || row.result?.inventory !== undefined
          || row.result?.requests !== judges.length || row.valid_execution && row.result?.reason === 'none' && judges.length === 0) issues.push('R isolated production Goal');
      const replayCell = replayBytes === null ? null : decode(replayBytes).rows.find(r => r.id === row.id && r.arm === row.arm);
      const paint = replayCell && typeof assessGoal === 'function' && typeof assessEdge === 'function'
        ? auditFrames(replayCell.frames, row, assessGoal, assessEdge) : null;
      if (paint && paint.status !== 'PASS') issues.push(...paint.issues);
      graded.push({ id: row.id, method: row.method, grade: gradeReady(row.initial_records, row.final_records, o, row.parts),
        paint_status: paint?.paint ?? 'UNPROVEN', cell_wall_elapsedMs: row.elapsedMs,
        goal_elapsedMs: Number.isFinite(row.result?.elapsedMs) ? row.result.elapsedMs : null });
    } else {
      if (prepCalls.length > 1 || typedCalls.length || judges.length > 8 || row.result?.requests !== gateCalls.length + judges.length
          || row.result?.inventory?.checks !== 1 || row.result?.inventory?.completions !== prepCalls.length
          || prepCalls.length && !same(row.result.inventory.missing, prepCalls[0].response?.missing)) issues.push('ordinary method/accounting');
      const coverage = row.result?.inventory?.coverage;
      const permitsGoal = ['sufficient', 'missing'].includes(coverage?.choice) && coverage.confidence >= 0.5;
      if ((!permitsGoal && (prepCalls.length || judges.length))
          || prepCalls.length && (coverage?.choice !== 'missing' || row.calls[1] !== prepCalls[0])) issues.push('ordinary dispatch ordering');
      let paint = { status: 'FAIL', issues: ['missing E paint'], paint: 'UNPROVEN' };
      if (typeof assessGoal === 'function' && typeof assessEdge === 'function') paint = auditFrames(row.frames, row, assessGoal, assessEdge);
      if (paint.status !== 'PASS') issues.push(...paint.issues);
      const l = row.lifecycle, targetEqual = l?.target?.log === row.final_log && same(l?.target?.records, row.final_records) && same(l?.target?.goal, row.result);
      const saved = targetEqual && l?.applied?.stored === row.final_log && l?.reloaded?.log === row.final_log
        && l?.reloaded?.stored === row.final_log && same(l?.reloaded?.records, row.final_records);
      if (row.valid_execution && (!targetEqual || !saved || l?.persistence !== 'PASS')) issues.push('E actual Apply/reload target binding');
      const decision = row.result?.inventory?.coverage;
      const replayCell = replayBytes === null ? null : decode(replayBytes).rows.find(r => r.id === row.id && r.arm === row.arm);
      const replayPaint = replayCell ? auditFrames(replayCell.frames, row, assessGoal, assessEdge) : null;
      if (replayPaint && replayPaint.status !== 'PASS') issues.push(...replayPaint.issues);
      graded.push({ id: row.id, method: row.method, grade: gradeOrdinary({ decision: decision && { choice: decision.choice, confidence: decision.confidence },
        initial_records: row.initial_records, final_records: row.final_records, initial_log: row.initial_log, final_log: row.final_log,
        initial_head: row.initial_head, final_head: row.final_head, missing: row.result?.inventory?.missing,
        preparations: prepCalls.length, typellm_sends: typedCalls.length, elapsedMs: row.result?.elapsedMs }, o),
        paint_status: replayPaint === null ? paint.paint : paint.paint === 'UNPROVEN' || replayPaint.paint === 'UNPROVEN'
          ? 'UNPROVEN' : paint.paint === 'PASS' && replayPaint.paint === 'PASS' ? 'PASS' : 'UNMET', persisted_raw_equal: saved,
        cell_wall_elapsedMs: row.elapsedMs, goal_elapsedMs: Number.isFinite(row.result?.elapsedMs) ? row.result.elapsedMs : null,
        goal_deadline_status: Number.isFinite(row.result?.elapsedMs) && row.result.elapsedMs >= 0
          ? row.result.elapsedMs <= 180000 ? 'PASS' : 'UNMET' : 'UNPROVEN' });
    }
    if (['R', 'E'].includes(input.axis) && row.valid_execution && !reasons.has(row.result?.reason)) issues.push('invalid stop reason admitted');
  }
  if (gateAt !== gateStream.length) issues.push('unjoined gate calls');
  issues.push(...auditEvents(rawFiles['events.jsonl'], rows, summary));
  const complete = rows.length === planned.length, allValid = rows.every(r => r.valid_execution === true);
  if (!['RECORDED', 'INVALID'].includes(execution.status) || (execution.status === 'RECORDED') !== (complete && allValid)
      || execution.invalid_cells !== rows.filter(r => !r.valid_execution).length) issues.push('axis terminal validity');
  let semantic = null;
  if (graded.every(r => r.grade !== null)) semantic = input.axis === 'G' ? summarizeGate(graded)
    : input.axis === 'F' ? summarizeSupply(graded, input.cases.map(c => c.id))
    : input.axis === 'R' ? summarizeReady(graded, input.cases.map(c => c.id)) : summarizeOrdinary(graded, oracle.cases);
  return { schema: 'voice-ui.component-axes-raw-audit/1', axis: input.axis, status: issues.length ? 'FAIL' : 'PASS', issues,
    complete, all_valid_execution: allValid, phase_kind: phaseKind,
    parent_inputs_sha256: parentProjectionBytes === null ? null : sha256(parentProjectionBytes),
    runtime_scope: identity.source?.scope ?? 'LIVE_BINDING_REQUIRED',
    admissible_for_semantic_claim: issues.length === 0 && complete && allValid
      && identity.source?.scope !== 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE',
    consumed: rows.length, planned: planned.length,
    external_provider_attempts: Object.fromEntries(['jev', 'typellm'].map(p => [p, sends[p] === lowerSends[p] ? sends[p] : null])),
    external_provider_attempt_bounds: Object.fromEntries(['jev', 'typellm'].map(p => [p, { min: lowerSends[p], max: sends[p] }])),
    factor_rows: logRows.length, factor_alignment: !factorPartition.ways ? 'FAIL'
      : factorPartition.ways > 1 ? 'AMBIGUOUS_FAILED_CALLS_NO_CELL_FACTOR_CLAIM' : 'UNIQUE',
    proofs, rows: graded, semantic, replay,
    raw_sha256: Object.fromEntries(Object.entries(rawFiles).map(([name, b]) => [name, sha256(b)])),
    scope: 'raw-axis locality only; source/producer/provider/independent physical PID and any required paint gates remain separate',
    CI_LIVE_EXECUTION: 'UNPROVEN', currency: 'COST_NOT_MEASURED' };
}

// Expectations are authored independently after source/process observation and
// frozen before CI verification. Never generate these digests inside CI.
export function auditAxisProducerBinding({ identityBytes, runtimeAuditBytes, configBytes, processBytes,
  artifactManifestBytes, workerBytes, providerBytes, protocolEntryBytes, bundleBytes, sourceFiles, auditReferences,
  rawFiles, stdoutBytes, stderrBytes, journalBytes, replayBytes = null }, producer) {
  if (producer.schema !== 'voice-ui.component-axes-producer/1') throw Error('axis producer schema');
  const identity = decode(identityBytes), runtime = decode(runtimeAuditBytes), config = decode(configBytes), process = decode(processBytes), manifest = decode(artifactManifestBytes);
  const source = identity.source, issues = [];
  if (source?.scope === 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE'
      || source?.provider_entry?.scope === 'bundled provider with synthetic fetch only') issues.push('synthetic runtime is not live producer evidence');
  const items = { raw_identity_sha256: identityBytes, runtime_audit_sha256: runtimeAuditBytes, config_sha256: configBytes,
    process_sha256: processBytes, artifact_manifest_sha256: artifactManifestBytes, worker_sha256: workerBytes,
    provider_sha256: providerBytes, protocol_sha256: protocolEntryBytes, stdout_sha256: stdoutBytes, stderr_sha256: stderrBytes,
    journal_sha256: journalBytes };
  for (const [name, b] of Object.entries(items)) if (producer[name] !== sha256(b)) issues.push('axis producer digest ' + name);
  if (producer.replay_sha256 !== (replayBytes === null ? null : sha256(replayBytes))) issues.push('axis replay digest');
  if (!same(Object.keys(rawFiles).sort(), Object.keys(producer.raw_sha256 ?? {}).sort())) issues.push('fixed raw snapshot inventory');
  else for (const [name, digest] of Object.entries(producer.raw_sha256)) if (sha256(rawFiles[name]) !== digest) issues.push('fixed raw digest ' + name);
  if (!Buffer.from(rawFiles['identity.json']).equals(Buffer.from(identityBytes)) || identity.schema !== 'voice-ui.component-axes-execution/1'
      || identity.axis !== producer.axis || !same(source.heads, producer.heads) || identity.inputs_sha256 !== producer.inputs_sha256
      || identity.bundle_sha256 !== producer.bundle_sha256 || sha256(bundleBytes) !== producer.bundle_sha256
      || producer.phase_id !== config.phase_id || config.phase_id !== source.launcher.phase_id
      || config.heads.apps !== runtime.apps_sha || runtime.apps_sha !== source.heads.apps || manifest.sources.apps !== runtime.apps_sha
      || manifest.sources.ui !== source.heads.ui || source.audit_sha256 !== sha256(runtimeAuditBytes)
      || runtime.worker.sha256 !== sha256(workerBytes) || source.worker_entry.sha256 !== sha256(workerBytes)
      || runtime.worker.path !== source.worker_entry.path || runtime.manifest.sha256 !== sha256(artifactManifestBytes)
      || runtime.artifact_root !== source.artifact.root || source.artifact.manifest_sha256 !== sha256(artifactManifestBytes)
      || runtime.provider.sha256 !== sha256(providerBytes) || source.provider_entry.sha256 !== sha256(providerBytes)
      || runtime.provider.path !== source.provider_entry.path || manifest.sources['jev-provider'].entry_sha256 !== sha256(providerBytes)
      || runtime.semantic_map.protocol.sha256 !== sha256(protocolEntryBytes) || source.semantic_map.protocol_sha256 !== sha256(protocolEntryBytes)
      || runtime.semantic_map.root !== source.semantic_map.root || runtime.dev_program.path !== source.launcher.dev_program
      || process.pid !== source.launcher.pid || process.start_ticks !== source.launcher.start_ticks
      || !same(process.allowances, source.launcher.allowances) || !same(config.heads, process.heads)
      || process.program !== config.program || source.launcher.program !== process.program
      || process.config_sha256 !== sha256(configBytes)) issues.push('axis source/runtime/process joins');
  if (!same(identity.source_sha256, producer.source_sha256)
      || !same(Object.keys(sourceFiles).sort(), [...sourceNames].sort()) || !same(Object.keys(sourceFiles).sort(), Object.keys(producer.source_sha256).sort())) issues.push('built source inventory');
  else for (const [name, digest] of Object.entries(producer.source_sha256)) if (sha256(sourceFiles[name]) !== digest) issues.push('built source digest ' + name);
  if (!Object.keys(producer.independent_audit_sha256 ?? {}).length
      || !same(Object.keys(auditReferences).sort(), Object.keys(producer.independent_audit_sha256 ?? {}).sort())) issues.push('independent audit inventory');
  else for (const [name, digest] of Object.entries(producer.independent_audit_sha256)) if (sha256(auditReferences[name]) !== digest) issues.push('independent audit digest ' + name);
  return { status: issues.length ? 'FAIL' : 'PASS', issues, scope: 'fixed exact-byte producer/source testimony joins, not live observation', CI_LIVE_EXECUTION: 'UNPROVEN' };
}
