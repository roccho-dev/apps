import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditRequirementRaw, auditRequirementProviderPhase, auditRequirementProducerBinding,
  auditRequirementReplayJoin, REQUIREMENTS_SOURCE_NAMES, sha256 } from './requirements-cycle-audit.mjs';
import { stockDifference, verifierDecision, requirementsSchedule } from './requirements-cycle-score.mjs';

// Public/synthetic fixtures only. No sealed pool is opened and no fetch occurs.
// The real immutable protocol and Goal generate proofs; expected meaning below
// comes from R's preregistered public oracles, never production interpretation.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = process.env.POC_REQUIREMENTS_FIXTURES ?? here;
const source = process.env.POC_SOURCE_ROOT ?? path.resolve(here, '../../typellm-ci-20261017/packages/voice-ui');
const protocolPath = process.env.POC_PROTOCOL_ENTRY ?? path.resolve(here, '../../../../ui.git/.worktrees/voice-ui-render-identity-20261017/packages/semantic-map/protocol/index.js');
const protocol = await import(pathToFileURL(protocolPath));
const { runInventoryGoal } = await import(pathToFileURL(path.join(source, 'src/completion.mjs')));
const { createSession } = await import(pathToFileURL(path.join(source, 'src/session.mjs')));
const { readBundle } = await import(pathToFileURL(path.join(source, 'src/bundle.mjs')));
const { assessPaintedGoal: assessGoal, assessPaintedEdge: assessEdge } = await import(pathToFileURL(path.join(source, 'tests/painted-goal.mjs')));
const bundleBytes = fs.readFileSync(path.join(source, 'web/data/bundle.v1.json')), bundleValue = JSON.parse(bundleBytes), bundle = readBundle(bundleValue);
const enc = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const json = b => JSON.parse(Buffer.from(b).toString('utf8'));
const lines = rows => rows.length ? Buffer.from(rows.map(x => JSON.stringify(x)).join('\n') + '\n') : Buffer.alloc(0);
const jsonLines = b => Buffer.from(b).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const f = (complete = 'complete', intent = 'change', confidence = 0.9) => ({ intent: { choice: intent, confidence },
  labels: { choice: 'missing', confidence }, capacity: { choice: 'within', confidence }, completeness: { choice: complete, confidence } });
const slots = required => Object.fromEntries([1, 2, 3].map((n, i) => ['required' + n, required[i]
  ? { ...required[i], quantity: String(required[i].quantity) } : { label: 'bounded padding', kind: 'none', quantity: '2' }]));
function framesFor(records) {
  const regions = records.filter(r => r.type === 'region'), groups = regions.filter(r => r.kind === 'group' && r.parent !== null);
  const text = box => ({ box, clips: [], svg: [0, 0, 2000, 1000], unmet: null });
  return [{ camera: 'overview' }, ...groups.map(group => {
    const observation = { identity: true, association: 'render-owned-semantic-id', complete: true, contained: true, nonoverlap: true,
      viewport: [0, 0, 2000, 1000], container: { id: group.id, bounds: [0, 0, 2000, 1000] }, title: text([10, 10, 100, 16]), edge: null,
      shapes: regions.filter(r => r.parent === group.id).map((r, i) => ({ id: r.id, rawLabel: r.label,
        bounds: [10 + i * 200, 50, 140, 70], name: text([20 + i * 200, 70, 100, 16]) })) };
    return { camera: group.id, observation, assessment: assessGoal(observation) };
  })];
}
async function synthetic(axis) {
  const prefix = `requirements-cycle-public-${axis}${axis === 'E' ? '2.v2' : '6'}`;
  const projectionBytes = fs.readFileSync(path.join(fixtures, prefix + '.inputs.json'));
  const oracleBytes = fs.readFileSync(path.join(fixtures, prefix + '.oracle.json'));
  const input = json(projectionBytes), oracle = json(oracleBytes), rawFiles = {}, summary = [], events = [], stdout = [];
  let tick = 0, seq = 0;
  const event = x => events.push({ at: new Date(Date.UTC(2026, 9, 17) + tick++).toISOString(), ...x });
  const graphs = new Map();
  for (const p of requirementsSchedule(input)) {
    const item = input.cases.find(x => x.id === p.id), o = oracle.cases.find(x => x.id === p.id);
    if (!graphs.has(item.id)) {
      const c = input.fixture_contract, sub = c.fixtures[item.fixture];
      const made = await protocol.createDecisionLog([...c.base_records, ...sub.extra_records], c.map_id);
      const pin = await protocol.createDecision(made.head, [{ type: 'PinRegions', items: [...c.base_pins, ...sub.extra_pins] }], made.records);
      graphs.set(item.id, (await protocol.appendDecision(made.log, pin.decision)).verified);
    }
    const graph = graphs.get(item.id), calls = [], request_id = '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
    const stage = (name, x) => stdout.push({ kind: 'voice-ui.parts.stage.v2', request_id, stage: name, ...x });
    let session = createSession({ accepted: graph, stored: graph.log });
    const inv = { kind: 'voice-ui.goal.inventory.v1', state: { utterance: item.utterance, head: graph.head,
      regions: graph.records.filter(r => r.type === 'region').map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
      edges: graph.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })), parts: bundle.parts } };
    event({ kind: 'cell-start', ...p, initial_head: graph.head, initial_log_sha256: sha256(graph.log) });
    const post = (route, request, response) => {
      const call = { id: p.id, arm: p.arm, n: calls.length + 1, route, request, status: 200, response, elapsedMs: 1,
        ...(axis === 'E' ? { upstream_route: route === '/api/parts/check' ? route + '?method=' + p.method : route } : {}) };
      calls.push(call); event({ kind: 'http-start', axis, method: p.method, id: p.id, arm: p.arm, n: call.n, route, request,
        ...(axis === 'E' ? { upstream_route: call.upstream_route } : {}) });
      event({ kind: 'http-end', id: p.id, arm: p.arm, n: call.n, status: 200, response, elapsedMs: 1 }); return response;
    };
    let result;
    if (axis === 'V') {
      const factors = f(o.expected_accept ? 'complete' : 'incomplete', o.expected_intent);
      stage('VERIFY_REQUIRED', { valid: true, required: item.required, factors });
      result = post('/api/parts/verify', { schema: 'voice-ui.parts.verify/2', inventory: inv, required: item.required },
        { schema: 'voice-ui.parts.verification/2', request_id, required: item.required, factors, ...verifierDecision(factors) });
    } else if (axis === 'F') {
      const proposal = { slots: slots(o.required), required: o.required };
      stage('TYPE_REQUIRED', { valid: true, proposal });
      result = post('/api/parts/requirements', inv, { schema: 'voice-ui.parts.requirements/2', request_id, ...proposal });
    } else {
      const initial = { decision: { choice: 'unknown', confidence: null }, factors: f('incomplete'),
        literal: { recognized: false, required: [], spans: [] }, observation: { valid: true, status: 'unsupported-syntax' } };
      stage('G0', { valid: true, initial });
      const enabled = p.method === 'adaptive-v2', required = enabled ? o.required : [], missing = stockDifference(required, bundle.parts);
      const proposal = enabled ? { slots: slots(required), required } : null, verification = enabled ? f() : null;
      if (enabled) { stage('TYPE_REQUIRED', { valid: true, proposal }); stage('VERIFY_REQUIRED', { valid: true, required, factors: verification }); }
      const decision = enabled ? { choice: missing.length ? 'missing' : 'sufficient', confidence: .9 } : initial.decision;
      stage('STOCK_DIFF', { required, missing, decision });
      const inspection = { schema: 'voice-ui.parts.inspection/2', request_id, mode: p.method, initial, proposal, verification, required, missing };
      result = await runInventoryGoal({ utterance: item.utterance, bundle, protocol, current: () => session,
        cancelled: () => false, adopt: async next => { session = next; }, check: request => post('/api/parts/check', request, { ...decision, inspection }),
        complete: () => assert.fail('v2 may not make a second completion request'), ask: async request => {
          const state = request.state;
          const old = new Set(graph.records.filter(r => r.type === 'region').map(r => r.id));
          const added = session.working.records.filter(r => r.type === 'region' && !old.has(r.id));
          const next = o.required.find(r => added.filter(a => a.label === r.label && a.kind === r.kind).length < r.quantity);
          // Goal itself limits one use of a key. Choose only its actually offered
          // candidate; this fake answer is not an interpretation implementation.
          const candidate = next && state.candidates.find(c => c.action === 'add-part' && c.parent === 'container'
            && state.offers.parts.find(a => a.key === c.part)?.label === next.label);
          const choice = !next || !candidate ? 'none' : state.placing === null ? 'part:' + candidate.part : candidate.id;
          const response = post('/api/judge', request, { kind: 'voice-ui.judge.decision.v1', answers: { delta: { type: 'choice', choice, confidence: .9 } } });
          return { kind: 'answered', decision: response };
        } });
    }
    const working = session.working, raw = { schema: 'voice-ui.requirements-cycle-cell/1', ...p, replay_suffix_scope: 'compatibility only',
      fixture: item.fixture, utterance: item.utterance, parts: bundle.parts, valid_execution: true, elapsedMs: 20,
      result, calls, initial_head: graph.head, initial_log: graph.log, initial_log_sha256: sha256(graph.log), initial_records: graph.records,
      final_head: working.head, final_log: working.log, final_records: working.records,
      ...(axis === 'E' ? { frames: framesFor(working.records), lifecycle: { target: { log: working.log, records: working.records, goal: result },
        applied: { stored: working.log }, reloaded: { log: working.log, records: working.records, stored: working.log },
        persistence: 'PASS', apply_enabled: working.log !== graph.log, undo: 'separate completed-artifact keyless mechanics; no second live Goal' } } : {}) };
    rawFiles[p.id + '-' + p.arm + '.json'] = enc(raw);
    summary.push({ axis, id: p.id, method: p.method, valid_execution: true, calls: calls.length });
    event({ kind: 'cell-end', ...summary.at(-1), final_head: working.head });
  }
  rawFiles['identity.json'] = enc({ schema: 'voice-ui.requirements-cycle-execution/1', axis,
    source: { scope: 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE' }, inputs_sha256: sha256(projectionBytes), bundle_sha256: sha256(bundleBytes),
    source_sha256: Object.fromEntries(REQUIREMENTS_SOURCE_NAMES.map(n => [n, '0'.repeat(64)])), case_order: input.cases.map(c => c.id),
    methods: axis === 'E' ? 'alternating literal-v2/adaptive-v2 and adaptive-v2/literal-v2' : axis === 'F' ? 'full-required' : 'verify' });
  rawFiles['execution.json'] = enc({ schema: 'voice-ui.requirements-cycle-phase/1', axis, status: 'RECORDED', summary, invalid_cells: 0, expected_cells: summary.length });
  rawFiles['events.jsonl'] = lines(events);
  return { projectionBytes, oracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes: lines(stdout), assessGoal, assessEdge };
}
const edit = (a, name, fn) => { const value = json(a.rawFiles[name]); fn(value); a.rawFiles[name] = enc(value); };
const editEvents = (a, fn) => { const values = jsonLines(a.rawFiles['events.jsonl']); fn(values); a.rawFiles['events.jsonl'] = lines(values); };
const editStages = (a, fn) => { const values = jsonLines(a.stdoutBytes); fn(values); a.stdoutBytes = lines(values); };
const refuse = async a => { try { return (await auditRequirementRaw(a)).status !== 'PASS'; } catch { return true; } };
function synchronize(a, row) {
  a.rawFiles[row.id + '-' + row.arm + '.json'] = enc(row);
  editEvents(a, events => {
    for (const c of row.calls) {
      const begin = events.find(e => e.kind === 'http-start' && e.id === row.id && e.arm === row.arm && e.n === c.n);
      if (begin) { begin.request = c.request; begin.route = c.route; if (c.upstream_route) begin.upstream_route = c.upstream_route; }
      const end = events.find(e => e.kind === 'http-end' && e.id === row.id && e.arm === row.arm && e.n === c.n);
      if (end) Object.assign(end, { status: c.status, response: c.response, elapsedMs: c.elapsedMs, ...(c.error ? { error: c.error } : {}) });
    }
    const e = events.find(e => e.kind === 'cell-end' && e.id === row.id && e.method === row.method);
    Object.assign(e, { valid_execution: row.valid_execution, calls: row.calls.length, final_head: row.final_head });
  });
  edit(a, 'execution.json', e => { const s = e.summary.find(s => s.id === row.id && s.method === row.method);
    Object.assign(s, { valid_execution: row.valid_execution, calls: row.calls.length });
    e.invalid_cells = e.summary.filter(s => !s.valid_execution).length; e.status = e.invalid_cells ? 'INVALID' : 'RECORDED'; });
}

test('V/F/E real-protocol synthetic receipts join and stay inadmissible as live', async () => {
  for (const axis of ['V', 'F', 'E']) {
    const a = await synthetic(axis), r = await auditRequirementRaw(a);
    assert.equal(r.status, 'PASS', axis + ':' + JSON.stringify(r.issues)); assert.equal(r.complete, true);
    assert.equal(r.all_valid_execution, true); assert.equal(r.admissible_for_semantic_claim, false);
    assert.ok(r.proofs.every(p => p.status === 'PASS')); assert.equal(r.stage_alignment, 'UNIQUE');
    if (axis === 'V') assert.deepEqual(r.external_provider_attempts, { jev: 6, typellm: 0 });
    if (axis === 'F') assert.deepEqual(r.external_provider_attempts, { jev: 0, typellm: 6 });
    if (axis === 'E') { assert.equal(r.semantic.missing_gains, 2); assert.equal(r.semantic.effect_criteria, 'PASS'); }
  }
});

test('raw protocol, source input, stock, identity, exact files, schedule and terminal mutations cannot pass', async () => {
  const mutations = [
    a => edit(a, 'PV01-V.json', r => { r.initial_log += ' '; }),
    a => edit(a, 'PV01-V.json', r => { r.final_records[0].title = 'wrong projection'; }),
    a => edit(a, 'PV01-V.json', r => { r.parts[0].purpose = 'new stock'; }),
    a => edit(a, 'PV01-V.json', r => { r.calls[0].request.inventory.state.parts.pop(); }),
    a => edit(a, 'PV01-V.json', r => { r.calls[0].request.required[0].quantity = 1; }),
    a => edit(a, 'identity.json', r => { delete r.source_sha256['dev/serve.mjs']; }),
    a => edit(a, 'identity.json', r => { r.inputs_sha256 = 'a'.repeat(64); }),
    a => edit(a, 'execution.json', r => { r.summary.reverse(); }),
    a => edit(a, 'execution.json', r => { r.expected_cells = 1; }),
    a => edit(a, 'execution.json', r => { r.status = 'INVALID'; }),
    a => { a.rawFiles['unlisted.json'] = enc({}); },
    a => { delete a.rawFiles['PV01-V.json']; },
    a => { const p = json(a.projectionBytes); p.schema = 'voice-ui.component-axes-input/1'; a.projectionBytes = enc(p); },
    a => { const p = json(a.projectionBytes); p.arm_order = ['C']; a.projectionBytes = enc(p); },
  ];
  for (const mutate of mutations) { const a = await synthetic('V'); mutate(a); assert.equal(await refuse(a), true); }
});

test('stdout is closed, ordered, original-proposal-bound and completely consumed', async () => {
  for (const mutate of [
    a => editStages(a, s => { s[0].factors.completeness.confidence = 1.2; }),
    a => editStages(a, s => { s[0].required[0].quantity = 1; }),
    a => editStages(a, s => { s[0].model_text = 'unapproved field'; }),
    a => editStages(a, s => { s[0].request_id = 'not a UUID'; }),
    a => editStages(a, s => { s.push(s[0]); }),
    a => editStages(a, s => { s.shift(); }),
    a => editStages(a, s => { [s[0], s[1]] = [s[1], s[0]]; }),
    a => { a.stdoutBytes = Buffer.concat([a.stdoutBytes, Buffer.from('{"kind":"voice-ui.parts.raw.v2","secret":"canary"}\n')]); },
  ]) { const a = await synthetic('V'); mutate(a); assert.equal(await refuse(a), true); }
  for (const mutate of [
    a => editStages(a, s => { s[0].proposal.slots.required1.parent = 'container'; }),
    a => editStages(a, s => { s[0].proposal.slots.required1.quantity = 1; }),
    a => editStages(a, s => { s[0].proposal.slots.required2 = s[0].proposal.slots.required1; }),
    a => editStages(a, s => { const slot = s[0].proposal.slots; slot.required2 = slot.required1; slot.required1 = { label: '', kind: 'none', quantity: '0' }; }),
  ]) { const a = await synthetic('F'); mutate(a); assert.equal(await refuse(a), true); }
});

test('coordinated G0 stdout, HTTP, result and event edits still need independent normalization from raw factors', async () => {
  const a = await synthetic('E'), row = json(a.rawFiles['PE01-B.json']);
  const changed = { choice: 'sufficient', confidence: .9 };
  Object.assign(row.calls[0].response, changed); row.calls[0].response.inspection.initial.decision = changed;
  row.result.inventory.coverage = row.calls[0].response; row.lifecycle.target.goal = row.result; synchronize(a, row);
  const id = row.calls[0].response.inspection.request_id;
  editStages(a, s => { s.find(x => x.request_id === id && x.stage === 'G0').initial.decision = changed;
    s.find(x => x.request_id === id && x.stage === 'STOCK_DIFF').decision = changed; });
  assert.ok((await auditRequirementRaw(a)).issues.includes('unjoined or inconsistent stage stdout'));
});

test('V accepted and confidence are independently recomputed even when stdout, body and result agree', async () => {
  for (const change of [r => { r.accepted = false; }, r => { r.confidence = .99; }]) {
    const a = await synthetic('V'), row = json(a.rawFiles['PV01-V.json']);
    change(row.result); row.calls[0].response = row.result; synchronize(a, row);
    assert.equal(await refuse(a), true);
  }
});

test('E original request mode, stock difference and materialization remain independently bound', async () => {
  for (const change of [
    r => { r.calls[0].upstream_route = '/api/parts/check?method=literal-v2'; },
    r => { r.calls[0].request.state.utterance += ' altered'; },
    r => { r.calls[0].request.state.regions[0].label = 'wrong state'; },
    r => { r.result.inventory.completions = 1; },
    r => { r.result.inventory.preparations = 0; },
    r => { r.result.inventory.missing.pop(); },
    r => { r.result.inventory.coverage.inspection.required[0].quantity = 2; },
    r => { r.result.inventory.coverage.inspection.missing[1].occurrence = 3; },
  ]) {
    const a = await synthetic('E'), row = json(a.rawFiles['PE01-C.json']); change(row); row.lifecycle.target.goal = row.result; synchronize(a, row);
    assert.equal(await refuse(a), true);
  }
});

test('E selected legal proof, effective offered keys and all verified prefix snapshots are mandatory', async () => {
  for (const change of [
    r => { r.result.selected[0].key = 'goal-extra-999'; },
    r => { r.result.selected[0].parent = 'other'; },
    r => { r.result.trace[1].head = r.final_head; },
    r => { r.result.trace[1].answers.delta.choice = 'none'; },
    r => { r.calls[1].request.state.offers.parts.at(-1).label = 'forged offer'; },
    r => { r.calls[1].request.state.graph[0].label = 'forged prefix'; },
  ]) { const a = await synthetic('E'), row = json(a.rawFiles['PE01-C.json']); change(row); row.lifecycle.target.goal = row.result; synchronize(a, row);
    assert.equal(await refuse(a), true); }
});

test('v2 stdout cannot skip Type, insert a foreign verifier, duplicate stages or execute Type on disabled baseline', async () => {
  for (const change of [
    (s, id) => { s.splice(s.findIndex(x => x.request_id === id && x.stage === 'TYPE_REQUIRED'), 1); },
    (s, id) => { s.find(x => x.request_id === id && x.stage === 'VERIFY_REQUIRED').required = []; },
    (s, id) => { const at = s.findIndex(x => x.request_id === id && x.stage === 'TYPE_REQUIRED'); s.splice(at, 0, s[at]); },
    (s, id) => { const at = s.findIndex(x => x.request_id === id && x.stage === 'STOCK_DIFF'); const t = s[at]; s.splice(at, 0, { ...t, stage: 'VERIFY_REQUIRED', valid: false }); },
  ]) { const a = await synthetic('E'), id = json(a.rawFiles['PE01-C.json']).calls[0].response.inspection.request_id;
    editStages(a, s => change(s, id)); assert.equal(await refuse(a), true); }
  const a = await synthetic('E'), b = json(a.rawFiles['PE01-B.json']), c = json(a.rawFiles['PE01-C.json']);
  editStages(a, s => { const before = s.findIndex(x => x.request_id === b.result.inventory.coverage.inspection.request_id && x.stage === 'STOCK_DIFF');
    s.splice(before, 0, { ...s.find(x => x.stage === 'TYPE_REQUIRED'), request_id: b.result.inventory.coverage.inspection.request_id }); });
  assert.equal(await refuse(a), true);
});

test('events require single exact terminals, upstream route and monotonic case order', async () => {
  for (const change of [
    e => { e.splice(2, 1); }, e => { e.splice(2, 0, e[2]); }, e => { e[2].status = 503; },
    e => { e[1].upstream_route = '/api/parts/check?method=adaptive-v2'; },
    e => { e[0].initial_log_sha256 = '0'.repeat(64); }, e => { e.at(-1).at = '2000-01-01T00:00:00.000Z'; },
  ]) { const a = await synthetic('E'); editEvents(a, change); assert.equal(await refuse(a), true); }
});

function failDirect(a, name, contract = false) {
  const row = json(a.rawFiles[name]), call = row.calls[0], id = row.result.request_id;
  call.status = contract ? 502 : 503; call.error = 'http_or_contract_unknown'; call.response = { error: contract ? 'parts_contract' : 'parts_unavailable' };
  row.valid_execution = false; row.result = { reason: 'evaluation-operation-unknown' }; synchronize(a, row);
  editStages(a, s => { const at = s.findIndex(x => x.request_id === id);
    if (contract) s[at] = { kind: 'voice-ui.parts.stage.v2', request_id: id, stage: s[at].stage, valid: false }; else s.splice(at, 1); });
  return row;
}
test('failed direct V/F calls preserve closed response and fallback with bounded sends and no semantic admission', async () => {
  for (const axis of ['V', 'F']) for (const contract of [false, true]) {
    const a = await synthetic(axis), name = axis === 'V' ? 'PV01-V.json' : 'PF01-F.json';
    const row = failDirect(a, name, contract), report = await auditRequirementRaw(a);
    assert.equal(report.status, 'PASS', JSON.stringify(report.issues)); assert.equal(report.all_valid_execution, false);
    assert.equal(report.admissible_for_semantic_claim, false);
    const p = axis === 'V' ? 'jev' : 'typellm'; assert.deepEqual(report.external_provider_attempt_bounds[p], { min: contract ? 6 : 5, max: 6 });
    row.result = row.calls[0].response; synchronize(a, row); assert.equal(await refuse(a), true);
  }
});

function failCheck(a, name, kept) {
  const row = json(a.rawFiles[name]), call = row.calls[0], id = call.response.inspection.request_id;
  call.status = 502; call.response = { error: 'parts_contract' }; call.error = 'http_or_contract_unknown';
  row.calls = [call]; row.valid_execution = false; row.final_log = row.initial_log; row.final_head = row.initial_head; row.final_records = row.initial_records;
  row.result = { reason: 'inventory-unknown', requests: 1, elapsedMs: 2, selected: [], trace: [],
    inventory: { checks: 1, completions: 0, preparations: 0, coverage: null, missing: [] } };
  row.frames = framesFor(row.final_records); row.lifecycle = null;
  editEvents(a, e => { for (let n = e.length - 1; n >= 0; n--) if (e[n].id === row.id && e[n].arm === row.arm
    && ['http-start', 'http-end'].includes(e[n].kind) && e[n].n > 1) e.splice(n, 1); });
  synchronize(a, row);
  editStages(a, s => { const at = s.findIndex(x => x.request_id === id), group = s.filter(x => x.request_id === id);
    s.splice(at, group.length, ...group.slice(0, kept)); });
  return row;
}
test('failed check before G0, after G0, after Type or verifier is auditable without inventing missing stages', async () => {
  for (const kept of [0, 1, 2, 3]) {
    const a = await synthetic('E'); failCheck(a, 'PE01-C.json', kept);
    const report = await auditRequirementRaw(a);
    assert.equal(report.status, 'PASS', kept + ':' + JSON.stringify(report.issues)); assert.equal(report.admissible_for_semantic_claim, false);
    assert.equal(report.all_valid_execution, false); assert.equal(report.rows.find(r => r.id === 'PE01' && r.arm === 'C').paint_status, 'PASS');
  }
  const a = await synthetic('E'); failCheck(a, 'PE01-C.json', 2);
  editStages(a, s => { const r = s.find(x => x.stage === 'TYPE_REQUIRED'); r.proposal.required[0].quantity = 1; });
  assert.equal(await refuse(a), true);
});

function addReplay(a, mutate = () => {}) {
  a.artifactManifestBytes = enc({ sources: { apps: 'a'.repeat(40), ui: 'b'.repeat(40) } });
  const rows = [], failures = [];
  for (const [name, bytes] of Object.entries(a.rawFiles)) if (/-[BC][.]json$/u.test(name)) {
    const raw = json(bytes), frames = framesFor(raw.final_records); mutate(frames, raw);
    for (const frame of frames.slice(1)) { frame.assessment = assessGoal(frame.observation);
      if (frame.assessment.status !== 'PASS') failures.push({ id: raw.id, arm: raw.arm, camera: frame.camera, assessment: frame.assessment }); }
    rows.push({ id: raw.id, arm: raw.arm, raw_sha256: sha256(bytes), log_sha256: sha256(raw.final_log), frames });
  }
  a.replayBytes = enc({ schema: 'voice-ui.closed-live-log-browser/1', scope: 'KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY', ci_live_execution: 'UNPROVEN',
    viewport: [1280, 720], deviceScaleFactor: 1, artifact_manifest_sha256: sha256(a.artifactManifestBytes), artifact_sources: json(a.artifactManifestBytes).sources,
    rows, failures, status: failures.length ? 'UNMET' : 'PASS' }); return a;
}
test('replay and direct DOM associations are independently regraded per cell; UNMET is not an integrity error', async () => {
  const a = addReplay(await synthetic('E'), (frames, raw) => { if (raw.id === 'PE01' && raw.arm === 'C') frames[1].observation.title.box = [-1, -1, 100, 16]; });
  const report = await auditRequirementRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  assert.equal(report.replay.recorded_paint_status, 'UNMET');
  assert.equal(report.rows.find(r => r.id === 'PE01' && r.arm === 'C').paint_status, 'UNMET');
  assert.ok(report.rows.filter(r => r.id !== 'PE01' || r.arm !== 'C').every(r => r.paint_status === 'PASS'));
  assert.equal(report.semantic.missing_gains, 1); assert.equal(report.semantic.effect_criteria, 'UNMET');
  const replay = json(a.replayBytes); replay.rows[0].frames[1].observation.container.id = 'wrong identity'; a.replayBytes = enc(replay);
  assert.equal(auditRequirementReplayJoin(a).status, 'FAIL');
});

test('actual Apply/reload equality and Goal deadline are distinct from whole-cell wall time', async () => {
  const a = await synthetic('E'), row = json(a.rawFiles['PE01-C.json']);
  row.elapsedMs = 900000; row.result.elapsedMs = 180001; row.lifecycle.target.goal = row.result; synchronize(a, row);
  const report = await auditRequirementRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  const r = report.rows.find(r => r.id === row.id && r.arm === row.arm);
  assert.equal(r.cell_wall_elapsedMs, 900000); assert.equal(r.goal_deadline_status, 'UNMET');
  row.lifecycle.reloaded.stored += ' '; synchronize(a, row); assert.equal(await refuse(a), true);
});

test('fresh cannot reuse public counts, and corrections require the byte-faithful public parent', async () => {
  for (const axis of ['V', 'F', 'E']) {
    const a = await synthetic(axis); a.phaseKind = 'fresh'; assert.equal(await refuse(a), true);
    a.phaseKind = 'correction'; assert.equal(await refuse(a), true);
    if (axis !== 'E') { a.parentProjectionBytes = a.projectionBytes; assert.equal((await auditRequirementRaw(a)).status, 'PASS');
      const parent = json(a.parentProjectionBytes); parent.cases[0].utterance += ' hidden change'; a.parentProjectionBytes = enc(parent); assert.equal(await refuse(a), true); }
  }
});

test('pre-live E oracle omission remains rejected even with a self-consistent replacement commitment', async () => {
  const a = await synthetic('E'), oracle = json(a.oracleBytes), input = json(a.projectionBytes);
  oracle.cases[0].expected_added_regions = []; a.oracleBytes = enc(oracle); input.oracle_sha256 = sha256(a.oracleBytes); a.projectionBytes = enc(input);
  edit(a, 'identity.json', id => { id.inputs_sha256 = sha256(a.projectionBytes); });
  assert.equal(await refuse(a), true);
});

function stoppedFixture(input_sha256 = 'f'.repeat(64)) {
  const heads = Object.fromEntries(['apps', 'ops', 'envs', 'windows', 'ui'].map((n, i) => [n, String(i + 1).repeat(40)]));
  const config = { phase_id: 'test-requirements-F', stage: 'public', heads, input_sha256, program: '/nix/store/test-launcher/bin/dev',
    allowances: { jev: 0, typellm: 6 } }, configBytes = enc(config);
  const process = { phase_id: config.phase_id, heads, program: config.program, allowances: config.allowances,
    pid: 1234, pgid: 1234, start_ticks: 5678, config_sha256: sha256(configBytes) };
  const stderrBytes = Buffer.from(Array.from({ length: 6 }, (_, i) => 'provider-send:typellm:' + (i + 1)).join('\n') + '\n');
  const stdoutBytes = Buffer.from('server stopped\n'), journal = [];
  let charged = { jev: 0, typellm: 0 };
  for (const [i, sent] of [{ jev: 300, typellm: 40 }, { jev: 300, typellm: 0 }, { jev: 89, typellm: 0 }].entries()) {
    journal.push({ kind: 'phase-reserve', id: 'history-' + i, allowances: sent, prior_charged: { ...charged } });
    journal.push({ kind: 'phase-reconcile', id: 'history-' + i, sent });
    for (const p of ['jev', 'typellm']) charged[p] += sent[p];
  }
  journal.push({ kind: 'phase-reserve', id: config.phase_id, allowances: config.allowances, prior_charged: charged,
    config_sha256: sha256(configBytes), heads, program: config.program });
  journal.push({ kind: 'phase-reconcile', id: config.phase_id, sent: config.allowances, pid: process.pid,
    start_ticks: process.start_ticks, stopped_group_empty: true, stdout_sha256: sha256(stdoutBytes), stderr_sha256: sha256(stderrBytes) });
  return { configBytes, processBytes: enc(process), stdoutBytes, stderrBytes, journalBytes: lines(journal) };
}
const stoppedAudit = bytes => auditRequirementProviderPhase(bytes, { jev: 0, typellm: { min: 5, max: 6 } }, { axis: 'F', caseCount: 6 });
test('stopped provider phase joins actual numbered sends, exact reservation/log cutoffs and inherited charges', () => {
  const a = stoppedFixture(), r = stoppedAudit(a); assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
  assert.deepEqual(r.sent, { jev: 0, typellm: 6 }); assert.deepEqual(r.prior_charged, { jev: 689, typellm: 40 });
  assert.deepEqual(r.charged_at_cutoff, { jev: 689, typellm: 46 }); assert.deepEqual(r.cycle_remaining, { jev: 300, typellm: 34 });
  assert.equal(r.stop_scope.includes('independent live PID'), true);
});
test('budget caps, false empty-group claims, duplicate reservation, send sequence and changed final logs are refused', () => {
  const reject = a => { try { return stoppedAudit(a).status !== 'PASS'; } catch { return true; } };
  for (const mutate of [
    a => { a.stderrBytes = Buffer.from('provider-send:typellm:2\n'); },
    a => { a.stdoutBytes = Buffer.concat([a.stdoutBytes, Buffer.from('late write\n')]); },
    a => { const p = json(a.processBytes); p.start_ticks++; a.processBytes = enc(p); },
    a => { const p = json(a.processBytes); p.pgid++; a.processBytes = enc(p); },
    a => { const j = jsonLines(a.journalBytes); j.at(-1).stopped_group_empty = false; a.journalBytes = lines(j); },
    a => { const j = jsonLines(a.journalBytes); j.at(-1).sent.typellm = 0; a.journalBytes = lines(j); },
    a => { const j = jsonLines(a.journalBytes); j.splice(-1, 0, j.at(-2)); a.journalBytes = lines(j); },
    a => { const j = jsonLines(a.journalBytes); j.at(-2).prior_charged.jev = 688; a.journalBytes = lines(j); },
    a => { const c = json(a.configBytes); c.allowances.typellm = 7; a.configBytes = enc(c); },
    a => { const c = json(a.configBytes); c.stage = 'final'; a.configBytes = enc(c); },
  ]) { const a = stoppedFixture(); mutate(a); assert.equal(reject(a), true); }
  assert.throws(() => auditRequirementProviderPhase(stoppedFixture(), { jev: 0, typellm: { min: 7, max: 6 } }, { axis: 'F', caseCount: 6 }));
  assert.equal(auditRequirementProviderPhase(stoppedFixture(), { jev: 0, typellm: 6 }, { axis: 'F', caseCount: 8 }).status, 'FAIL');
});

async function producerFixture() {
  const a = await synthetic('F'), bytes = stoppedFixture(sha256(a.projectionBytes)), config = json(bytes.configBytes), process = json(bytes.processBytes);
  const workerBytes = Buffer.from('completed worker bytes\n'), providerBytes = Buffer.from('admitted provider bytes\n'), protocolEntryBytes = Buffer.from('immutable protocol entry\n');
  const artifactManifestBytes = enc({ sources: { apps: config.heads.apps, ui: config.heads.ui, 'jev-provider': { entry_sha256: sha256(providerBytes) } } });
  const runtime = { apps_sha: config.heads.apps, worker: { path: '/nix/store/worker/worker.mjs', sha256: sha256(workerBytes) },
    manifest: { sha256: sha256(artifactManifestBytes) }, artifact_root: '/nix/store/dist', provider: { path: '/nix/store/provider/batch.mjs', sha256: sha256(providerBytes) },
    semantic_map: { root: '/nix/store/semantic', protocol: { sha256: sha256(protocolEntryBytes) } }, dev_program: { path: '/nix/store/dev/bin/dev' } };
  const runtimeAuditBytes = enc(runtime), identity = json(a.rawFiles['identity.json']);
  const sourceFiles = Object.fromEntries(REQUIREMENTS_SOURCE_NAMES.map(n => [n, Buffer.from('test built bytes for ' + n)]));
  identity.source_sha256 = Object.fromEntries(Object.entries(sourceFiles).map(([n, b]) => [n, sha256(b)]));
  identity.source = { schema: 'voice-ui.poc.runtime/1', heads: config.heads, audit_sha256: sha256(runtimeAuditBytes),
    worker_entry: runtime.worker, provider_entry: runtime.provider, artifact: { root: runtime.artifact_root, manifest_sha256: runtime.manifest.sha256 },
    semantic_map: { root: runtime.semantic_map.root, protocol_sha256: runtime.semantic_map.protocol.sha256 },
    launcher: { phase_id: config.phase_id, pid: process.pid, start_ticks: process.start_ticks, allowances: config.allowances,
      dev_program: runtime.dev_program.path, program: config.program } };
  a.rawFiles['identity.json'] = enc(identity);
  const auditReferences = { 'independent-zero-stop-source.json': enc({ scope: 'synthetic unit testimony only' }) };
  const args = { ...bytes, identityBytes: a.rawFiles['identity.json'], runtimeAuditBytes, artifactManifestBytes, workerBytes, providerBytes,
    protocolEntryBytes, bundleBytes: a.bundleBytes, sourceFiles, auditReferences, rawFiles: a.rawFiles, replayBytes: null };
  const producer = { schema: 'voice-ui.requirements-cycle-producer/1', axis: 'F', heads: config.heads, inputs_sha256: identity.inputs_sha256,
    phase_id: config.phase_id, bundle_sha256: sha256(a.bundleBytes), parent_inputs_sha256: null, replay_sha256: null,
    source_sha256: identity.source_sha256, raw_sha256: Object.fromEntries(Object.entries(a.rawFiles).map(([n, b]) => [n, sha256(b)])),
    independent_audit_sha256: Object.fromEntries(Object.entries(auditReferences).map(([n, b]) => [n, sha256(b)])) };
  for (const [n, b] of Object.entries({ raw_identity_sha256: args.identityBytes, runtime_audit_sha256: runtimeAuditBytes, config_sha256: args.configBytes,
    process_sha256: args.processBytes, artifact_manifest_sha256: artifactManifestBytes, worker_sha256: workerBytes, provider_sha256: providerBytes,
    protocol_sha256: protocolEntryBytes, stdout_sha256: args.stdoutBytes, stderr_sha256: args.stderrBytes, journal_sha256: args.journalBytes })) producer[n] = sha256(b);
  return { args, producer };
}
test('fixed producer digests join all seventeen built inputs, actual runtime tuple and independent audit references', async () => {
  const { args, producer } = await producerFixture(); assert.equal(auditRequirementProducerBinding(args, producer).status, 'PASS');
  for (const mutate of [
    a => { a.workerBytes = Buffer.from('different worker'); }, a => { a.providerBytes = Buffer.from('different provider'); },
    a => { a.protocolEntryBytes = Buffer.from('different protocol'); }, a => { a.journalBytes = Buffer.concat([a.journalBytes, Buffer.from('\n')]); },
    a => { a.rawFiles['PF01-F.json'] = Buffer.concat([a.rawFiles['PF01-F.json'], Buffer.from(' ')]); },
    a => { a.sourceFiles['src/completion.mjs'] = Buffer.from('different semantics'); },
    a => { delete a.sourceFiles['tests/requirements-cycle-http.mjs']; },
    a => { a.auditReferences['independent-zero-stop-source.json'] = enc({ altered: true }); },
    a => { a.replayBytes = enc({ invented: 'replay' }); },
  ]) { const a = structuredClone(args); mutate(a); assert.equal(auditRequirementProducerBinding(a, producer).status, 'FAIL'); }
});
test('coordinated synthetic marker and runtime changes cannot be laundered into live producer binding', async () => {
  const { args, producer } = await producerFixture(), identity = json(args.identityBytes);
  identity.source.scope = 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE';
  identity.source.provider_entry.scope = 'bundled provider with synthetic fetch only';
  args.identityBytes = enc(identity); args.rawFiles['identity.json'] = args.identityBytes;
  producer.raw_identity_sha256 = sha256(args.identityBytes); producer.raw_sha256['identity.json'] = sha256(args.identityBytes);
  assert.equal(auditRequirementProducerBinding(args, producer).status, 'FAIL');
  delete identity.source.scope; delete identity.source.provider_entry.scope;
  identity.source.launcher.start_ticks++; args.identityBytes = enc(identity); args.rawFiles['identity.json'] = args.identityBytes;
  producer.raw_identity_sha256 = sha256(args.identityBytes); producer.raw_sha256['identity.json'] = sha256(args.identityBytes);
  assert.equal(auditRequirementProducerBinding(args, producer).status, 'FAIL');
});

test('producer and raw input commitment must also match the actual reserved config input', async () => {
  const a = await synthetic('F'), raw = await auditRequirementRaw(a);
  assert.equal(raw.inputs_sha256, sha256(a.projectionBytes));
  const { args, producer } = await producerFixture(), id = json(args.identityBytes);
  id.inputs_sha256 = '8'.repeat(64); producer.inputs_sha256 = id.inputs_sha256;
  args.identityBytes = enc(id); args.rawFiles['identity.json'] = args.identityBytes;
  producer.raw_identity_sha256 = sha256(args.identityBytes); producer.raw_sha256['identity.json'] = sha256(args.identityBytes);
  assert.equal(auditRequirementProducerBinding(args, producer).status, 'FAIL');
});
