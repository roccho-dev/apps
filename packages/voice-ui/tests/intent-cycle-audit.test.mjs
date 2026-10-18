import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {auditIntentRaw,auditIntentProviderPhase,auditIntentProducerBinding,auditIntentReplayJoin,auditIntentProcess,INTENT_SOURCE_NAMES,sha256} from './intent-cycle-audit.mjs';
import {stockDifference,verifierDecision,intentSchedule as requirementsSchedule,normalizeInitialIntent,INTENT_METHODS,INTENT_POLICIES,INTENT_SEALED_COMMITMENTS} from './intent-cycle-score.mjs';
// Public and synthetic receipts only; no sealed payload, real fetch or key read.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = process.env.POC_INTENT_PREREG_ROOT ?? here;
const parentFixtures = process.env.POC_INTENT_PARENT_ROOT ?? fixtures;
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
  assert.equal(axis, 'E'); const prefix = 'intent-cycle-public-E-2';
  const oldPrefix = 'dependency-cycle-public-E2';
  const parentProjectionBytes = fs.readFileSync(path.join(parentFixtures, oldPrefix + '.inputs.json'));
  const parentOracleBytes = fs.readFileSync(path.join(parentFixtures, oldPrefix + '.oracle.json'));
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
    const stage = (name, x) => stdout.push({ kind: 'voice-ui.parts.stage.v2', request_id, stage: name, ...x, ...(name === 'TYPE_REQUIRED' ? { generation: p.generation_policy } : {}) });
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
      result = post('/api/parts/requirements?generation=' + p.generation_policy, inv, { schema: 'voice-ui.parts.requirements/2', request_id, ...proposal });
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
    const working = session.working, raw = { schema: 'voice-ui.intent-cycle-cell/1', ...p, replay_suffix_scope: 'compatibility only',
      fixture: item.fixture, utterance: item.utterance, parts: bundle.parts, valid_execution: true, elapsedMs: 20,
      result, calls, initial_head: graph.head, initial_log: graph.log, initial_log_sha256: sha256(graph.log), initial_records: graph.records,
      final_head: working.head, final_log: working.log, final_records: working.records,
      ...(axis === 'E' ? { frames: framesFor(working.records), lifecycle: { target: { log: working.log, records: working.records, goal: result },
        applied: { stored: working.log }, reloaded: { log: working.log, records: working.records, stored: working.log },
        persistence: 'PASS', apply_enabled: working.log !== graph.log, undo: 'separate completed-artifact keyless mechanics; no second live Goal' } } : {}) };
    rawFiles[p.id + '-' + p.arm + '.json'] = enc(raw);
    summary.push({ axis, id: p.id, arm: p.arm, method: p.method, generation_policy: p.generation_policy, valid_execution: true, calls: calls.length });
    event({ kind: 'cell-end', ...summary.at(-1), final_head: working.head });
  }
  rawFiles['identity.json'] = enc({ schema: 'voice-ui.intent-cycle-execution/1', axis,
    source: { scope: 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE' }, inputs_sha256: sha256(projectionBytes), bundle_sha256: sha256(bundleBytes),
    source_sha256: Object.fromEntries(INTENT_SOURCE_NAMES.map(n => [n, '0'.repeat(64)])), case_order: input.cases.map(c => c.id),
    arm_order: requirementsSchedule(input).map(({ id, arm }) => ({ id, arm })), methods: INTENT_METHODS, generation_policies: INTENT_POLICIES });
  rawFiles['execution.json'] = enc({ schema: 'voice-ui.intent-cycle-phase/1', axis, status: 'RECORDED', summary, invalid_cells: 0, expected_cells: summary.length });
  rawFiles['events.jsonl'] = lines(events);
  return { projectionBytes, oracleBytes, parentProjectionBytes, parentOracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes: lines(stdout), assessGoal, assessEdge };
}
const edit = (a, name, fn) => { const value = json(a.rawFiles[name]); fn(value); a.rawFiles[name] = enc(value); };
const editEvents = (a, fn) => { const values = jsonLines(a.rawFiles['events.jsonl']); fn(values); a.rawFiles['events.jsonl'] = lines(values); };
const editStages = (a, fn) => { const values = jsonLines(a.stdoutBytes); fn(values); a.stdoutBytes = lines(values); };
const refuse = async a => { try { return (await auditIntentRaw(a)).status !== 'PASS'; } catch { return true; } };
function synchronize(a, row) {
  a.rawFiles[row.id + '-' + row.arm + '.json'] = enc(row);
  editEvents(a, events => {
    for (const c of row.calls) {
      const begin = events.find(e => e.kind === 'http-start' && e.id === row.id && e.arm === row.arm && e.n === c.n);
      if (begin) { begin.request = c.request; begin.route = c.route; if (c.upstream_route) begin.upstream_route = c.upstream_route; }
      const end = events.find(e => e.kind === 'http-end' && e.id === row.id && e.arm === row.arm && e.n === c.n);
      if (end) Object.assign(end, { status: c.status, response: c.response, elapsedMs: c.elapsedMs, ...(c.error ? { error: c.error } : {}) });
    }
    const e = events.find(e => e.kind === 'cell-end' && e.id === row.id && e.arm === row.arm);
    Object.assign(e, { valid_execution: row.valid_execution, calls: row.calls.length, final_head: row.final_head });
  });
  edit(a, 'execution.json', e => { const s = e.summary.find(s => s.id === row.id && s.arm === row.arm);
    Object.assign(s, { valid_execution: row.valid_execution, calls: row.calls.length });
    e.invalid_cells = e.summary.filter(s => !s.valid_execution).length; e.status = e.invalid_cells ? 'INVALID' : 'RECORDED'; });
}

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
test('coordinated G0 stdout, HTTP, result and event edits still need independent normalization from raw factors', async () => {
  const a = await synthetic('E'), row = json(a.rawFiles['PE01-B.json']);
  const changed = { choice: 'sufficient', confidence: .9 };
  Object.assign(row.calls[0].response, changed); row.calls[0].response.inspection.initial.decision = changed;
  row.result.inventory.coverage = row.calls[0].response; row.lifecycle.target.goal = row.result; synchronize(a, row);
  const id = row.calls[0].response.inspection.request_id;
  editStages(a, s => { s.find(x => x.request_id === id && x.stage === 'G0').initial.decision = changed;
    s.find(x => x.request_id === id && x.stage === 'STOCK_DIFF').decision = changed; });
  assert.ok((await auditIntentRaw(a)).issues.includes('unjoined or inconsistent stage stdout'));
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

test('failed check before G0, after G0, after Type or verifier is auditable without inventing missing stages', async () => {
  for (const kept of [0, 1, 2, 3]) {
    const a = await synthetic('E'); failCheck(a, 'PE01-C.json', kept);
    const report = await auditIntentRaw(a);
    assert.equal(report.status, 'PASS', kept + ':' + JSON.stringify(report.issues)); assert.equal(report.admissible_for_semantic_claim, false);
    assert.equal(report.all_valid_execution, false); assert.equal(report.rows.find(r => r.id === 'PE01' && r.arm === 'C').paint_status, 'PASS');
  }
  const a = await synthetic('E'); failCheck(a, 'PE01-C.json', 2);
  editStages(a, s => { const r = s.find(x => x.stage === 'TYPE_REQUIRED'); r.proposal.required[0].quantity = 1; });
  assert.equal(await refuse(a), true);
});

test('replay and direct DOM associations are independently regraded per cell; UNMET is not an integrity error', async () => {
  const a = addReplay(await synthetic('E'), (frames, raw) => { if (raw.id === 'PE01' && raw.arm === 'C') frames[1].observation.title.box = [-1, -1, 100, 16]; });
  const report = await auditIntentRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  assert.equal(report.replay.recorded_paint_status, 'UNMET');
  assert.equal(report.rows.find(r => r.id === 'PE01' && r.arm === 'C').paint_status, 'UNMET');
  assert.ok(report.rows.filter(r => r.id !== 'PE01' || r.arm !== 'C').every(r => r.paint_status === 'PASS'));
  assert.equal(report.semantic.missing_gains, 1); assert.equal(report.semantic.effect_criteria, 'UNMET');
  const replay = json(a.replayBytes); replay.rows[0].frames[1].observation.container.id = 'wrong identity'; a.replayBytes = enc(replay);
  assert.equal(auditIntentReplayJoin(a).status, 'FAIL');
});

test('actual Apply/reload equality and Goal deadline are distinct from whole-cell wall time', async () => {
  const a = await synthetic('E'), row = json(a.rawFiles['PE01-C.json']);
  row.elapsedMs = 900000; row.result.elapsedMs = 180001; row.lifecycle.target.goal = row.result; synchronize(a, row);
  const report = await auditIntentRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  const r = report.rows.find(r => r.id === row.id && r.arm === row.arm);
  assert.equal(r.cell_wall_elapsedMs, 900000); assert.equal(r.goal_deadline_status, 'UNMET');
  row.lifecycle.reloaded.stored += ' '; synchronize(a, row); assert.equal(await refuse(a), true);
});

async function producerFixture() {
  const a = await syntheticG0(), bytes = stoppedFixture(sha256(a.projectionBytes)), config = json(bytes.configBytes), process = json(bytes.processBytes);
  const workerBytes = Buffer.from('completed worker bytes\n'), providerBytes = Buffer.from('admitted provider bytes\n'), protocolEntryBytes = Buffer.from('immutable protocol entry\n');
  const artifactManifestBytes = enc({ sources: { apps: config.heads.apps, ui: config.heads.ui, 'jev-provider': { entry_sha256: sha256(providerBytes) } } });
  const runtime = { apps_sha: config.heads.apps, worker: { path: '/nix/store/worker/worker.mjs', sha256: sha256(workerBytes) },
    manifest: { sha256: sha256(artifactManifestBytes) }, artifact_root: '/nix/store/dist', provider: { path: '/nix/store/provider/batch.mjs', sha256: sha256(providerBytes) },
    semantic_map: { root: '/nix/store/semantic', protocol: { sha256: sha256(protocolEntryBytes) } }, dev_program: { path: '/nix/store/dev/bin/dev' } };
  const runtimeAuditBytes = enc(runtime), identity = json(a.rawFiles['identity.json']);
  const sourceFiles = Object.fromEntries(INTENT_SOURCE_NAMES.map(n => [n, Buffer.from('test built bytes for ' + n)]));
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
  const producer = { schema: 'voice-ui.intent-cycle-producer/1', axis: 'G0', arm_order: identity.arm_order, generation_policies: INTENT_POLICIES, heads: config.heads, inputs_sha256: identity.inputs_sha256,
    phase_id: config.phase_id, bundle_sha256: sha256(a.bundleBytes), parent_inputs_sha256: null, replay_sha256: null,
    source_sha256: identity.source_sha256, raw_sha256: Object.fromEntries(Object.entries(a.rawFiles).map(([n, b]) => [n, sha256(b)])),
    independent_audit_sha256: Object.fromEntries(Object.entries(auditReferences).map(([n, b]) => [n, sha256(b)])) };
  for (const [n, b] of Object.entries({ raw_identity_sha256: args.identityBytes, runtime_audit_sha256: runtimeAuditBytes, config_sha256: args.configBytes,
    process_sha256: args.processBytes, artifact_manifest_sha256: artifactManifestBytes, worker_sha256: workerBytes, provider_sha256: providerBytes,
    protocol_sha256: protocolEntryBytes, stdout_sha256: args.stdoutBytes, stderr_sha256: args.stderrBytes, journal_sha256: args.journalBytes })) producer[n] = sha256(b);
  return { args, producer };
}
test('fixed producer digests join all twenty-two built inputs, actual runtime tuple and independent audit references', async () => {
  const { args, producer } = await producerFixture(); assert.equal(auditIntentProducerBinding(args, producer).status, 'PASS');
  for (const mutate of [
    a => { a.workerBytes = Buffer.from('different worker'); }, a => { a.providerBytes = Buffer.from('different provider'); },
    a => { a.protocolEntryBytes = Buffer.from('different protocol'); }, a => { a.journalBytes = Buffer.concat([a.journalBytes, Buffer.from('\n')]); },
    a => { a.rawFiles['PG01-G0.json'] = Buffer.concat([a.rawFiles['PG01-G0.json'], Buffer.from(' ')]); },
    a => { a.sourceFiles['src/completion.mjs'] = Buffer.from('different semantics'); },
    a => { delete a.sourceFiles['tests/requirements-cycle-http.mjs']; },
    a => { a.auditReferences['independent-zero-stop-source.json'] = enc({ altered: true }); },
    a => { a.replayBytes = enc({ invented: 'replay' }); },
  ]) { const a = structuredClone(args); mutate(a); assert.equal(auditIntentProducerBinding(a, producer).status, 'FAIL'); }
});

test('coordinated synthetic marker and runtime changes cannot be laundered into live producer binding', async () => {
  const { args, producer } = await producerFixture(), identity = json(args.identityBytes);
  identity.source.scope = 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE';
  identity.source.provider_entry.scope = 'bundled provider with synthetic fetch only';
  args.identityBytes = enc(identity); args.rawFiles['identity.json'] = args.identityBytes;
  producer.raw_identity_sha256 = sha256(args.identityBytes); producer.raw_sha256['identity.json'] = sha256(args.identityBytes);
  assert.equal(auditIntentProducerBinding(args, producer).status, 'FAIL');
  delete identity.source.scope; delete identity.source.provider_entry.scope;
  identity.source.launcher.start_ticks++; args.identityBytes = enc(identity); args.rawFiles['identity.json'] = args.identityBytes;
  producer.raw_identity_sha256 = sha256(args.identityBytes); producer.raw_sha256['identity.json'] = sha256(args.identityBytes);
  assert.equal(auditIntentProducerBinding(args, producer).status, 'FAIL');
});

test('producer and raw input commitment must also match the actual reserved config input', async () => {
  const a = await syntheticG0(), raw = await auditIntentRaw(a);
  assert.equal(raw.inputs_sha256, sha256(a.projectionBytes));
  const { args, producer } = await producerFixture(), id = json(args.identityBytes);
  id.inputs_sha256 = '8'.repeat(64); producer.inputs_sha256 = id.inputs_sha256;
  args.identityBytes = enc(id); args.rawFiles['identity.json'] = args.identityBytes;
  producer.raw_identity_sha256 = sha256(args.identityBytes); producer.raw_sha256['identity.json'] = sha256(args.identityBytes);
  assert.equal(auditIntentProducerBinding(args, producer).status, 'FAIL');
});

async function syntheticG0() {
  const projectionBytes=fs.readFileSync(path.join(fixtures,'intent-cycle-public-G0-10.inputs.json'));
  const oracleBytes=fs.readFileSync(path.join(fixtures,'intent-cycle-public-G0-10.oracle.json'));
  const pre=json(fs.readFileSync(path.join(fixtures,'intent-cycle-public-literal-preflight.json'))),input=json(projectionBytes),oracle=json(oracleBytes);
  const rawFiles={},summary=[],events=[],stdout=[];let tick=0;
  const event=x=>events.push({at:new Date(Date.UTC(2026,9,18)+tick++).toISOString(),...x});
  for(const [i,p] of requirementsSchedule(input).entries()) {
    const item=input.cases.find(c=>c.id===p.id),o=oracle.cases.find(c=>c.id===p.id),f=input.fixture_contract,chosen=f.fixtures[item.fixture];
    const made=await protocol.createDecisionLog([...f.base_records,...chosen.extra_records],f.map_id);
    const pin=await protocol.createDecision(made.head,[{type:'PinRegions',items:[...f.base_pins,...chosen.extra_pins]}],made.records);
    const graph=(await protocol.appendDecision(made.log,pin.decision)).verified;
    const actual=structuredClone(pre.G0.find(c=>c.id===item.id)),request_id='00000000-0000-4000-8000-'+String(i+1).padStart(12,'0');
    const factors={intent:{choice:o.expected_intent,confidence:.9},labels:{choice:'available',confidence:.9},capacity:{choice:'within',confidence:.9},completeness:{choice:o.expected_completeness??'complete',confidence:.9}};
    const initial={factors,literal:{recognized:actual.recognized,required:actual.required,spans:actual.spans},observation:{valid:actual.valid,status:actual.status}};
    initial.decision=normalizeInitialIntent(initial,item.utterance,bundle.parts,graph.records);
    const missing=stockDifference(initial.literal.required,bundle.parts),inspection={schema:'voice-ui.parts.inspection/2',request_id,mode:'literal-v2',initial,proposal:null,verification:null,required:initial.literal.required,missing};
    const result={...initial.decision,inspection},request={kind:'voice-ui.goal.inventory.v1',state:{utterance:item.utterance,head:graph.head,
      regions:graph.records.filter(r=>r.type==='region').map(({id,label,kind,parent})=>({id,label,kind,parent})),edges:[],parts:bundle.parts}};
    const call={id:p.id,arm:p.arm,n:1,route:'/api/parts/check?method=literal-v2',request,status:200,response:result,elapsedMs:1};
    stdout.push({kind:'voice-ui.parts.stage.v2',request_id,stage:'G0',valid:true,initial},{kind:'voice-ui.parts.stage.v2',request_id,stage:'STOCK_DIFF',required:initial.literal.required,missing,decision:initial.decision});
    const raw={schema:'voice-ui.intent-cycle-cell/1',...p,replay_suffix_scope:'compatibility only',fixture:item.fixture,utterance:item.utterance,parts:bundle.parts,
      valid_execution:true,elapsedMs:3,result,calls:[call],initial_head:graph.head,initial_log:graph.log,initial_log_sha256:sha256(graph.log),initial_records:graph.records,
      final_head:graph.head,final_log:graph.log,final_records:graph.records};
    rawFiles[p.id+'-'+p.arm+'.json']=enc(raw);const row={...p,valid_execution:true,calls:1};summary.push(row);
    event({kind:'cell-start',...p,initial_head:graph.head,initial_log_sha256:sha256(graph.log)});
    event({kind:'http-start',axis:'G0',method:p.method,id:p.id,arm:p.arm,n:1,route:call.route,request});
    event({kind:'http-end',id:p.id,arm:p.arm,n:1,status:200,response:result,elapsedMs:1});event({kind:'cell-end',...row,final_head:graph.head});
  }
  rawFiles['identity.json']=enc({schema:'voice-ui.intent-cycle-execution/1',axis:'G0',source:{scope:'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE'},
    inputs_sha256:sha256(projectionBytes),bundle_sha256:sha256(bundleBytes),source_sha256:Object.fromEntries(INTENT_SOURCE_NAMES.map(n=>[n,'0'.repeat(64)])),
    case_order:input.cases.map(c=>c.id),arm_order:requirementsSchedule(input).map(({id,arm})=>({id,arm})),methods:INTENT_METHODS,generation_policies:INTENT_POLICIES});
  rawFiles['execution.json']=enc({schema:'voice-ui.intent-cycle-phase/1',axis:'G0',status:'RECORDED',summary,invalid_cells:0,expected_cells:10});rawFiles['events.jsonl']=lines(events);
  return{projectionBytes,oracleBytes,rawFiles,bundleBytes,protocol,stdoutBytes:lines(stdout),phaseKind:'public'};
}

test('new public G0 exact fixture protocol, closed normalization, source22 and stage joins pass only as synthetic evidence',async()=>{
  const a=await syntheticG0(),r=await auditIntentRaw(a);assert.equal(r.status,'PASS',JSON.stringify(r.issues));
  assert.equal(r.semantic.intent_criteria,'PASS');assert.equal(r.consumed,10);assert.equal(r.proofs.length,10);
  assert.deepEqual(r.external_provider_attempt_bounds,{jev:{min:10,max:10},typellm:{min:0,max:0}});assert.equal(r.admissible_for_semantic_claim,false);
  const e=await auditIntentRaw(await synthetic('E'));assert.equal(e.status,'PASS',JSON.stringify(e.issues));assert.equal(e.semantic.missing_gains,2);assert.equal(e.semantic.effect_criteria,'PASS');
});
test('G0 altered normalization cannot be laundered through matching stdout, HTTP, result and terminal events',async()=>{
  const a=await syntheticG0(),row=json(a.rawFiles['PG01-G0.json']),changed={choice:'sufficient',confidence:.9};
  Object.assign(row.result,changed);row.result.inspection.initial.decision=changed;row.calls[0].response=row.result;synchronize(a,row);
  const id=row.result.inspection.request_id;editStages(a,s=>{s.find(x=>x.request_id===id&&x.stage==='G0').initial.decision=changed;s.find(x=>x.request_id===id&&x.stage==='STOCK_DIFF').decision=changed;});
  assert.equal(await refuse(a),true);
});
test('G0 explicit method/null policy/no Type and unchanged proof cannot be replaced by inherited E adoption targets',async()=>{
  for(const change of[r=>{r.generation_policy='dependent';},r=>{r.method='adaptive-v2';},r=>{r.calls[0].route='/api/parts/check?method=adaptive-v2';},r=>{r.calls[0].route+='&method=literal-v2';},
    r=>{r.calls[0].request.state.utterance+=' changed';},r=>{r.final_log+='{}\n';},r=>{r.final_records.push({type:'region',id:'new',parent:'container',label:'API',kind:'step',summary:''});},r=>{r.result.inspection.missing=[];}]){
    const a=await syntheticG0(),name=change.toString().includes('missing=[]')?'PG04-G0.json':'PG01-G0.json',r=json(a.rawFiles[name]);change(r);synchronize(a,r);assert.equal(await refuse(a),true);
  }
  const a=await syntheticG0();editStages(a,s=>s.splice(1,0,{kind:'voice-ui.parts.stage.v2',request_id:s[0].request_id,stage:'TYPE_REQUIRED',generation:'dependent',valid:false}));assert.equal(await refuse(a),true);
});
test('G0 failures retain exactly one closed terminal, fallback and bounded real sends without semantic promotion',async()=>{
  for(const kept of[0,1]){const a=await syntheticG0(),r=json(a.rawFiles['PG01-G0.json']),id=r.result.inspection.request_id;
    r.calls[0].status=kept?502:503;r.calls[0].error='http_or_contract_unknown';r.calls[0].response={error:kept?'parts_contract':'parts_unavailable'};
    r.result={reason:'evaluation-operation-unknown'};r.valid_execution=false;synchronize(a,r);
    editStages(a,s=>{const at=s.findIndex(x=>x.request_id===id),n=s.filter(x=>x.request_id===id).length;
      s.splice(at,n,...kept?[{kind:'voice-ui.parts.stage.v2',request_id:id,stage:'G0',valid:false}]:[]);});
    const out=await auditIntentRaw(a);assert.equal(out.status,'PASS',JSON.stringify(out.issues));assert.equal(out.all_valid_execution,false);assert.equal(out.admissible_for_semantic_claim,false);
    assert.deepEqual(out.external_provider_attempt_bounds.jev,{min:kept?10:9,max:10});
    editEvents(a,e=>{e.find(x=>x.kind==='http-end').response={error:'invented'};});assert.equal(await refuse(a),true);
  }
});
test('a consistent weak G0 model answer is retained as quality UNMET, not mislabeled as corrupt evidence',async()=>{
 const a=await syntheticG0(),r=json(a.rawFiles['PG01-G0.json']);r.result.inspection.initial.factors.intent.confidence=.49;
 const n=normalizeInitialIntent(r.result.inspection.initial,r.utterance,r.parts,r.initial_records);r.result.inspection.initial.decision=n;r.result.choice=n.choice;r.result.confidence=n.confidence;r.calls[0].response=r.result;synchronize(a,r);
 const id=r.result.inspection.request_id;editStages(a,s=>{s.find(x=>x.request_id===id&&x.stage==='G0').initial=r.result.inspection.initial;s.find(x=>x.request_id===id&&x.stage==='STOCK_DIFF').decision=n;});
 const out=await auditIntentRaw(a);assert.equal(out.status,'PASS',JSON.stringify(out.issues));assert.equal(out.all_valid_execution,true);assert.equal(out.semantic.intent_criteria,'UNMET');assert.equal(out.semantic.correct,9);
});
test('new exact public commitments, source inventory, raw schedule and retained denominator reject substitutions',async()=>{
  for(const mutate of[a=>edit(a,'identity.json',r=>{r.schema='voice-ui.dependency-cycle-execution/1';}),a=>edit(a,'identity.json',r=>{delete r.source_sha256['tests/intent-cycle-eval.mjs'];}),
    a=>edit(a,'execution.json',r=>{r.summary.reverse();}),a=>edit(a,'execution.json',r=>{r.expected_cells=1;}),a=>{delete a.rawFiles['PG01-G0.json'];},a=>{a.rawFiles.extra=enc({});},
    a=>{const o=json(a.oracleBytes);o.cases[0].minimum_intent_confidence=.1;a.oracleBytes=enc(o);const i=json(a.projectionBytes);i.oracle_sha256=sha256(a.oracleBytes);a.projectionBytes=enc(i);},
    a=>{const i=json(a.projectionBytes);i.cases[0].utterance+=' altered';a.projectionBytes=enc(i);},a=>{a.phaseKind='fresh';}]){const a=await syntheticG0();mutate(a);assert.equal(await refuse(a),true);}
});

function stoppedFixture(input_sha256='f'.repeat(64)){
 const heads=Object.fromEntries(['apps','ops','envs','windows','ui'].map((n,i)=>[n,String(i+1).repeat(40)]));
 const config={phase_id:'test-intent-G0',stage:'public',axis:'G0',case_count:10,heads,input_sha256,program:'/nix/store/test-launcher/bin/dev',allowances:{jev:10,typellm:0}},configBytes=enc(config);
 const process={phase_id:config.phase_id,heads,program:config.program,allowances:config.allowances,pid:1234,pgid:1234,start_ticks:'5678',config_sha256:sha256(configBytes)};
 const stderrBytes=Buffer.from(Array.from({length:10},(_,i)=>'provider-send:jev:'+(i+1)).join('\n')+'\n'),stdoutBytes=Buffer.from('stopped\n'),j=[];let charged={jev:0,typellm:0};
 for(const[i,sent]of[{jev:300,typellm:40},{jev:300,typellm:18},{jev:115,typellm:13}].entries()){
  j.push({kind:'phase-reserve',id:'history-'+i,allowances:sent,prior_charged:{...charged}},{kind:'phase-reconcile',id:'history-'+i,sent});charged={jev:charged.jev+sent.jev,typellm:charged.typellm+sent.typellm};}
 j.push({kind:'phase-reserve',id:config.phase_id,allowances:config.allowances,prior_charged:charged,config_sha256:sha256(configBytes),heads,program:config.program},
 {kind:'phase-reconcile',id:config.phase_id,sent:config.allowances,pid:process.pid,start_ticks:process.start_ticks,stopped_group_empty:true,stdout_sha256:sha256(stdoutBytes),stderr_sha256:sha256(stderrBytes)});
 return{configBytes,processBytes:enc(process),stdoutBytes,stderrBytes,journalBytes:lines(j)};
}
const stoppedAudit=a=>auditIntentProviderPhase(a,{jev:{min:9,max:10},typellm:0},{axis:'G0',caseCount:10});
test('new phase accounting binds715/71 baseline, ten-Jev cap, exact sequences, finally stop and inherited conservative charge',()=>{
 const r=stoppedAudit(stoppedFixture());assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.deepEqual(r.prior_charged,{jev:715,typellm:71});assert.deepEqual(r.charged_at_cutoff,{jev:725,typellm:71});assert.deepEqual(r.cycle_remaining,{jev:238,typellm:20});
 for(const mutate of[a=>{a.stderrBytes=Buffer.from('provider-send:jev:2\n');},a=>{a.stdoutBytes=Buffer.concat([a.stdoutBytes,Buffer.from('late')]);},
  a=>{const j=jsonLines(a.journalBytes);j.at(-1).stopped_group_empty=false;a.journalBytes=lines(j);},a=>{const c=json(a.configBytes);c.allowances.jev=11;a.configBytes=enc(c);},
  a=>{const p=json(a.processBytes);p.pgid++;a.processBytes=enc(p);},a=>{const j=jsonLines(a.journalBytes);j.splice(-1,0,j.at(-2));a.journalBytes=lines(j);}]){const a=stoppedFixture();mutate(a);assert.ok((()=>{try{return stoppedAudit(a).status!=='PASS';}catch{return true;}})());}
 assert.throws(()=>auditIntentProviderPhase(stoppedFixture(),{jev:10,typellm:0},{axis:'G0',caseCount:10,phaseKind:'final'}));
 assert.throws(()=>auditIntentProviderPhase(stoppedFixture(),{jev:10,typellm:0},{axis:'V',caseCount:6,phaseKind:'public'}));
});

const baselinePath=process.env.POC_INTENT_OLD_JOURNAL??path.resolve(source,'../../docs/voice-ui/dependency-cycle-20261018/evidence/public-E/dependency-public-E-20261018.journal.jsonl');
function processFixture(count=0){
 const commitmentBytes=fs.readFileSync(path.join(fixtures,'intent-cycle-commitment.v3.json')),freezeBytes=fs.readFileSync(path.join(fixtures,'intent-cycle-freeze.v3.json'));
 const commitment=json(commitmentBytes),freeze=json(freezeBytes),publicFiles=Object.fromEntries(freeze.copy_allowlist.map(r=>[r.name,fs.readFileSync(path.join(fixtures,r.name))]));
 const base=fs.readFileSync(baselinePath);assert.equal(sha256(base),'9b5582798122208f1d36968e4646de46573f414739a239f0ea1195a692a5b6ba');
 const records=[],tail=[],charged={jev:715,typellm:71},head='a'.repeat(40),f=json(fs.readFileSync(path.join(fixtures,'intent-cycle-public-G0-10.inputs.json'))).fixture_contract;
 for(const st of commitment.stages.slice(0,count)){const kind=st.id.startsWith('public')?'public':'final',stamp=commitment.files.find(r=>r.axis===st.axis&&r.visibility===(kind==='public'?'public':'sealed'));
  const input=kind==='public'?json(fs.readFileSync(path.join(fixtures,stamp.input.path))):{schema:'voice-ui.intent-cycle-input/1',axis:st.axis,oracle_sha256:stamp.oracle.sha256,parent_inputs_sha256:null,fixture_contract:f,
   cases:Array.from({length:st.cases},(_,i)=>({id:'SYN'+i,fixture:'empty',utterance:'synthetic graph-only case '+i,...st.axis==='V'?{required:[]}: {},arms:st.axis==='V'?['V']:st.axis==='F'?['D']:i%2===0?['B','C']:['C','B']}))};
  // Synthetic report stubs test graph gating only, never raw/source admission.
  const config={phase_id:'synthetic-'+st.id,stage:kind,axis:st.axis,case_count:st.cases,heads:{apps:head},input_sha256:stamp.input.sha256,allowances:{jev:st.jev,typellm:st.typellm}},prior={...charged};
  charged.jev+=st.jev;charged.typellm+=st.typellm;
  const semantic=st.axis==='G0'?{intent_criteria:'PASS'}:st.axis==='E'?{enabled_criteria:'PASS',effect_criteria:'PASS'}:{verification_criteria:'UNMET',requirements_criteria:'UNMET'};
  const report={binding:{status:'PASS'},phase:{status:'PASS',phase:config.phase_id,prior_charged:prior,charged_at_cutoff:{...charged},sent:{jev:st.jev,typellm:st.typellm}},
   raw:{status:'PASS',complete:true,planned:st.cells,consumed:st.cells,all_valid_execution:kind==='public',inputs_sha256:stamp.input.sha256,semantic}};
  records.push({index:{id:st.id,axis:st.axis,phase_kind:kind,apps_sha:head},config,input,report});
  tail.push({kind:'phase-reserve',id:config.phase_id,prior_charged:prior,allowances:config.allowances},{kind:'phase-reconcile',id:config.phase_id,sent:report.phase.sent});
 }
 return{records,journalBytes:Buffer.concat([base,lines(tail)]),commitmentBytes,freezeBytes,publicFiles};
}
test('exact new empty graph is NOT_MEASURED; all five bounded stages join with separate fresh quality failures retained',()=>{
 const empty=auditIntentProcess(processFixture());assert.equal(empty.status,'PASS',JSON.stringify(empty.issues));assert.equal(empty.state,'NOT_MEASURED');assert.deepEqual(empty.charged_at_cutoff,{jev:715,typellm:71});
 const r=auditIntentProcess(processFixture(5));assert.equal(r.status,'PASS',JSON.stringify(r.issues));assert.equal(r.releases.length,3);assert.ok(r.releases.every(x=>x.admitted&&x.prior_fresh_quality_required===false));assert.deepEqual(r.charged_at_cutoff,{jev:963,typellm:91});
});
test('failed public gates, incomplete prior evidence, source changes, unindexed retries and altered budget cannot promote blind release',()=>{
 const reject=a=>{try{return auditIntentProcess(a).status!=='PASS';}catch{return true;}};
 for(const mutate of[a=>{a.records[0].report.raw.semantic.intent_criteria='UNMET';},a=>{a.records[1].report.raw.semantic.effect_criteria='UNMET';},
  a=>{a.records[2].report.raw.complete=false;},a=>{a.records[2].report.binding.status='FAIL';},a=>{a.records[3].index.apps_sha='b'.repeat(40);},
  a=>{a.records[0].config.correction_batch=1;},a=>{a.records[0].config.allowances.jev=11;},a=>{a.journalBytes=Buffer.concat([a.journalBytes,lines([{kind:'phase-reserve',id:'unindexed',allowances:{jev:1,typellm:0}}])]);},
  a=>{a.publicFiles['intent-cycle-G0-oracle-contract.json']=enc({changed:true});}]){const a=processFixture(5);mutate(a);assert.equal(reject(a),true);}
});
