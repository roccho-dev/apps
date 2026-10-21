import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditAxisRaw, auditAxisProviderPhase, auditAxisProducerBinding } from './component-axis-audit.mjs';
import { sha256, jsonLines } from './receipt-admissibility.mjs';

// Unit receipts below are synthetic mechanics, not provider measurements.
// Real immutable protocol and production Goal code are used; no fetch occurs.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = process.env.POC_AXIS_FIXTURES ?? here;
const source = process.env.POC_SOURCE_ROOT ?? path.resolve(here, '../../typellm-ci-20261017/packages/voice-ui');
const protocolPath = process.env.POC_PROTOCOL_ENTRY ?? path.resolve(here, '../../../../ui.git/.worktrees/voice-ui-render-identity-20261017/packages/semantic-map/protocol/index.js');
const protocol = await import(pathToFileURL(protocolPath));
const { runGoal } = await import(pathToFileURL(path.join(source, 'src/goal.mjs')));
const { runInventoryGoal } = await import(pathToFileURL(path.join(source, 'src/completion.mjs')));
const { readBundle } = await import(pathToFileURL(path.join(source, 'src/bundle.mjs')));
const { createSession } = await import(pathToFileURL(path.join(source, 'src/session.mjs')));
const { DECISION_KIND } = await import(pathToFileURL(path.join(source, 'src/contract.mjs')));
const { assessPaintedGoal: assessGoal, assessPaintedEdge: assessEdge } = await import(pathToFileURL(path.join(source, 'tests/painted-goal.mjs')));
const enc = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const lines = x => Buffer.from(x.map(r => JSON.stringify(r)).join('\n') + '\n');
const bundleBytes = fs.readFileSync(path.join(source, 'web/data/bundle.v1.json'));
const bundleValue = JSON.parse(bundleBytes), bundle = readBundle(bundleValue);
const names = ['src/completion.mjs', 'src/literal-inventory.mjs', 'src/goal.mjs', 'src/contract.mjs', 'src/turn.mjs', 'src/session.mjs',
  'functions/api/parts.mjs', 'functions/pages-worker.mjs', 'web/app.mjs', 'web/adapters/completion.mjs',
  'tests/component-axes-eval.mjs', 'tests/component-axis-score.mjs', 'tests/evaluation-http.mjs', 'tests/painted-goal.mjs'];

function syntheticFrames(records) {
  const regions = records.filter(r => r.type === 'region'), groups = regions.filter(r => r.kind === 'group' && r.parent !== null);
  const name = box => ({ box, clips: [], svg: [0, 0, 2000, 1000], unmet: null });
  return [{ camera: 'overview' }, ...groups.map(group => {
    const observation = { identity: true, association: 'render-owned-semantic-id', complete: true, contained: true, nonoverlap: true,
      viewport: [0, 0, 2000, 1000], container: { id: group.id, bounds: [0, 0, 2000, 1000] }, title: name([10, 10, 100, 16]), edge: null,
      shapes: regions.filter(r => r.parent === group.id).map((r, i) => ({ id: r.id, rawLabel: r.label,
        bounds: [10 + i * 200, 50, 140, 70], name: name([20 + i * 200, 70, 100, 16]) })) };
    return { camera: group.id, observation, assessment: assessGoal(observation) };
  })];
}

function addReplay(args, change = () => {}) {
  const manifest = { sources: { apps: 'a'.repeat(40), ui: 'b'.repeat(40) } }, rows = [], failures = [];
  for (const [name, bytes] of Object.entries(args.rawFiles)) {
    if (!/-[ABC][.]json$/.test(name)) continue;
    const raw = JSON.parse(bytes), frames = syntheticFrames(raw.final_records); change(frames, raw);
    for (const f of frames.slice(1)) {
      f.assessment = assessGoal(f.observation);
      if (f.assessment.status !== 'PASS') failures.push({ id: raw.id, arm: raw.arm, camera: f.camera, assessment: f.assessment });
    }
    rows.push({ id: raw.id, arm: raw.arm, raw_sha256: sha256(bytes), log_sha256: sha256(raw.final_log), frames });
  }
  args.artifactManifestBytes = enc(manifest); args.assessGoal = assessGoal; args.assessEdge = assessEdge;
  args.replayBytes = enc({ schema: 'voice-ui.closed-live-log-browser/1', scope: 'KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY', ci_live_execution: 'UNPROVEN',
    viewport: [1280, 720], deviceScaleFactor: 1, artifact_manifest_sha256: sha256(args.artifactManifestBytes), artifact_sources: manifest.sources,
    rows, failures, status: failures.some(f => f.assessment.status === 'UNPROVEN') ? 'UNPROVEN' : failures.length ? 'UNMET' : 'PASS' });
  return args;
}

async function synthetic(axis, { adoptOne = false } = {}) {
  const counts = { G: 4, R: 2, F: 3, E: 4 }, stem = 'component-axes-public-' + axis + counts[axis];
  const projectionBytes = fs.readFileSync(path.join(fixtures, stem + '.inputs.public.json'));
  const oracleBytes = fs.readFileSync(path.join(fixtures, stem + '.oracle.public.json'));
  const input = JSON.parse(projectionBytes), oracle = JSON.parse(oracleBytes), rawFiles = {}, summary = [], events = [], stdout = [];
  let tick = 0;
  const event = x => events.push({ at: new Date(Date.UTC(2026, 9, 17) + tick++).toISOString(), ...x });
  for (const [index, item] of input.cases.entries()) {
    const o = oracle.cases[index], f = input.fixture_contract, sub = f.fixtures[item.fixture];
    const made = await protocol.createDecisionLog([...f.base_records, ...sub.extra_records], f.map_id);
    const pinned = await protocol.createDecision(made.head, [{ type: 'PinRegions', items: [...f.base_pins, ...sub.extra_pins] }], made.records);
    const graph = (await protocol.appendDecision(made.log, pinned.decision)).verified;
    const methods = axis === 'F' ? index % 2 ? ['typed', 'literal'] : ['literal', 'typed'] : [axis === 'R' ? 'ready' : 'literal'];
    for (const method of methods) {
      const arm = method === 'ready' ? 'A' : method === 'typed' ? 'C' : 'B', calls = [];
      event({ kind: 'cell-start', axis, id: item.id, method, arm, initial_head: graph.head, initial_log_sha256: sha256(graph.log) });
      const post = (route, request, response) => {
        const c = { id: item.id, arm, n: calls.length + 1, route, request, status: 200, response, elapsedMs: 1 };
        calls.push(c); event({ kind: 'http-start', axis, method, id: c.id, arm, n: c.n, route, request });
        event({ kind: 'http-end', id: c.id, arm, n: c.n, status: 200, response, elapsedMs: 1 }); return response;
      };
      const inventory = { kind: 'voice-ui.goal.inventory.v1', state: { utterance: item.utterance, head: graph.head,
        regions: graph.records.filter(r => r.type === 'region').map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
        edges: graph.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })), parts: bundle.parts } };
      let result, session = createSession({ accepted: graph, stored: graph.log });
      const check = request => {
        const required = o.required ?? [], spans = required.map(r => {
          const start = item.utterance.indexOf(r.label); assert.ok(start >= 0);
          return { start, end: start + r.label.length, source: r.label, label: r.label, kind: r.kind, quantity: r.quantity };
        });
        const completeness = { choice: 'complete', confidence: 0.9 }, intent = { choice: o.expected_intent, confidence: 0.9 };
        const response = post('/api/parts/check', request, { choice: o.expected_gate, confidence: 0.9,
          inspection: { source: 'literal+jev', recognized: required.length > 0, required, missing: o.expected_missing, spans, completeness } });
        stdout.push({ kind: 'voice-ui.parts.factors.v1', head: graph.head, factors: { intent,
          labels: { choice: o.expected_gate === 'missing' ? 'missing' : 'available', confidence: 0.9 },
          capacity: { choice: 'within', confidence: 0.9 } } });
        stdout.push({ kind: 'voice-ui.parts.literal.v1', head: graph.head, recognized: required.length > 0,
          required_count: required.reduce((n, r) => n + r.quantity, 0), completeness, choice: o.expected_gate, confidence: 0.9 });
        return response;
      };
      if (axis === 'G') result = check(inventory);
      else if (axis === 'E') result = await runInventoryGoal({ utterance: item.utterance, bundle, protocol,
        current: () => session, cancelled: () => false, adopt: async next => { session = next; }, check,
        complete: async r => post('/api/parts/complete', r, { missing: o.expected_missing }),
        ask: async request => ({ kind: 'answered', decision: post('/api/judge', request,
          { kind: DECISION_KIND, answers: request.kind === 'voice-ui.judge.goal-completion.v1'
            ? { completion: { type: 'choice', choice: 'unknown', confidence: 0.9 } }
            : { delta: { type: 'choice', choice: 'none', confidence: 0.9 } } }) }) });
      else if (axis === 'F') result = post('/api/parts/complete' + (method === 'typed' ? '?method=typed' : ''), inventory, { missing: o.expected_missing });
      else result = await runGoal({ utterance: item.utterance, bundle: readBundle({ ...bundleValue, parts: item.parts }), protocol,
        current: () => session, cancelled: () => false, adopt: async next => { session = next; },
        ask: async request => {
          if (request.kind === 'voice-ui.judge.goal-completion.v1') return { kind: 'answered', decision: post('/api/judge', request,
            { kind: DECISION_KIND, answers: { completion: { type: 'choice', choice: 'unknown', confidence: 0.9 } } }) };
          const c = request.state.candidates.find(c => c.action === 'add-part');
          const choice = adoptOne && index === 0 && calls.length < 2 ? request.state.placing === null ? 'part:' + c.part : c.id : 'none';
          return { kind: 'answered', decision: post('/api/judge', request,
            { kind: DECISION_KIND, answers: { delta: { type: 'choice', choice, confidence: 0.9 } } }) };
        } });
      const raw = { schema: 'voice-ui.component-axes-cell/1', axis, id: item.id, fixture: item.fixture, utterance: item.utterance,
        method, arm, parts: axis === 'R' ? item.parts : bundle.parts, valid_execution: true, elapsedMs: 2,
        initial_log: graph.log, initial_log_sha256: sha256(graph.log), initial_head: graph.head, initial_records: graph.records,
        final_log: session.working.log, final_head: session.working.head, final_records: session.working.records, result, calls,
        ...(axis === 'E' ? { frames: syntheticFrames(session.working.records), lifecycle: {
          target: { log: session.working.log, records: session.working.records, goal: result }, applied: { stored: session.working.log },
          reloaded: { log: session.working.log, stored: session.working.log, records: session.working.records }, persistence: 'PASS' } } : {}) };
      rawFiles[item.id + '-' + arm + '.json'] = enc(raw);
      summary.push({ axis, id: item.id, method, valid_execution: true, calls: calls.length });
      event({ kind: 'cell-end', ...summary.at(-1), final_head: raw.final_head });
    }
  }
  rawFiles['identity.json'] = enc({ schema: 'voice-ui.component-axes-execution/1', axis,
    source: { scope: 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE' }, inputs_sha256: sha256(projectionBytes), bundle_sha256: sha256(bundleBytes),
    case_order: input.cases.map(c => c.id), source_sha256: Object.fromEntries(names.map(n => [n, '0'.repeat(64)])) });
  rawFiles['execution.json'] = enc({ schema: 'voice-ui.component-axes-phase/1', axis, status: 'RECORDED', summary, invalid_cells: 0, expected_cells: summary.length });
  rawFiles['events.jsonl'] = lines(events);
  return { projectionBytes, oracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes: stdout.length ? lines(stdout) : Buffer.alloc(0), assessGoal, assessEdge };
}
const edit = (args, name, fn) => { const v = JSON.parse(args.rawFiles[name]); fn(v); args.rawFiles[name] = enc(v); };
const refuse = async args => { try { return (await auditAxisRaw(args)).status !== 'PASS'; } catch { return true; } };
const editEvents = (args, fn) => { const events = jsonLines(args.rawFiles['events.jsonl']); fn(events); args.rawFiles['events.jsonl'] = lines(events); };

test('real protocol synthetic G receipts join while explicit synthetic marker blocks live admissibility', async () => {
  const report = await auditAxisRaw(await synthetic('G'));
  assert.equal(report.status, 'PASS', JSON.stringify(report.issues)); assert.equal(report.complete, true);
  assert.equal(report.admissible_for_semantic_claim, false); assert.deepEqual(report.external_provider_attempts, { jev: 4, typellm: 0 });
  assert.ok(report.proofs.every(p => p.status === 'PASS'));
});

test('G protocol, input, factor, span, event, order, file and terminal mutations are refused', async () => {
  const mutations = [
    a => edit(a, 'H01-B.json', r => { r.final_records[0].title = 'wrong'; }),
    a => edit(a, 'H01-B.json', r => { r.initial_log += ' '; }),
    a => edit(a, 'H01-B.json', r => { r.calls[0].request.state.parts.pop(); }),
    a => edit(a, 'H01-B.json', r => { r.calls[0].response.confidence = 0.99; }),
    a => { const rows = jsonLines(a.stdoutBytes); rows[1].completeness.confidence = 0.1; a.stdoutBytes = lines(rows); },
    a => { const rows = jsonLines(a.rawFiles['events.jsonl']); rows.splice(2, 1); a.rawFiles['events.jsonl'] = lines(rows); },
    a => edit(a, 'execution.json', r => { r.summary.reverse(); }),
    a => { a.projectionBytes = Buffer.concat([a.projectionBytes, Buffer.from(' ')]); },
    a => { delete a.rawFiles['H01-B.json']; },
    a => { a.rawFiles['unexpected.json'] = enc({}); },
    a => edit(a, 'execution.json', r => { r.status = 'INVALID'; }),
    a => { const row = JSON.parse(a.rawFiles['H01-B.json']); row.result.inspection.spans[0].start = 999;
      row.calls[0].response = row.result; a.rawFiles['H01-B.json'] = enc(row);
      editEvents(a, events => { events.find(e => e.kind === 'http-end' && e.id === 'H01').response = row.result; }); },
  ];
  for (const mutate of mutations) { const a = await synthetic('G'); mutate(a); assert.equal(await refuse(a), true); }
});

test('coordinated HTTP/event edits still need independent factor and supplied-offer agreement', async () => {
  const g = await synthetic('G'), row = JSON.parse(g.rawFiles['H01-B.json']); row.result.confidence = 0.99;
  row.calls[0].response = row.result; g.rawFiles['H01-B.json'] = enc(row);
  editEvents(g, events => { events.find(e => e.kind === 'http-end' && e.id === 'H01').response = row.result; });
  assert.ok((await auditAxisRaw(g)).issues.some(s => s.startsWith('literal factor/body')));
  for (const axis of ['R', 'E']) {
    const a = await synthetic(axis), id = axis === 'R' ? 'H06' : 'H05', arm = axis === 'R' ? 'A' : 'B', name = id + '-' + arm + '.json';
    const r = JSON.parse(a.rawFiles[name]), call = r.calls.find(c => c.route === '/api/judge');
    call.request.state.offers.parts.at(-1).label = 'wrong-offer'; a.rawFiles[name] = enc(r);
    editEvents(a, events => { events.find(e => e.kind === 'http-start' && e.id === id && e.n === call.n).request = call.request; });
    assert.ok((await auditAxisRaw(a)).issues.some(s => s.startsWith('axis protocol/prefix/trace')));
  }
});

test('paint is recomputed per raw cell after global artifact join, never spread to other cells', async () => {
  const a = addReplay(await synthetic('R'), (frames, raw) => { if (raw.id === 'H06') frames[1].observation.title.box = [-1, -1, 100, 16]; });
  const report = await auditAxisRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  assert.equal(report.replay.recorded_paint_status, 'UNMET');
  assert.equal(report.rows.find(r => r.id === 'H06').paint_status, 'UNMET');
  assert.equal(report.rows.find(r => r.id === 'H08').paint_status, 'PASS');
  assert.equal(report.semantic.paint_pass, 1);
  const e = await synthetic('E'), er = await auditAxisRaw(e); assert.equal(er.status, 'PASS', JSON.stringify(er.issues));
  assert.ok(er.rows.every(r => r.paint_status === 'PASS'));
  addReplay(e, (frames, raw) => { if (raw.id === 'H05') frames[1].observation.title.box = [-1, -1, 100, 16]; });
  const joined = await auditAxisRaw(e); assert.equal(joined.status, 'PASS', JSON.stringify(joined.issues));
  assert.equal(joined.rows.find(r => r.id === 'H05').paint_status, 'UNMET');
  assert.ok(joined.rows.filter(r => r.id !== 'H05').every(r => r.paint_status === 'PASS'));
  e.replayBytes = null;
  const target = JSON.parse(e.rawFiles['H05-B.json']); target.result.elapsedMs = 180001;
  target.lifecycle.target.goal = target.result; target.elapsedMs = 999999; e.rawFiles['H05-B.json'] = enc(target);
  const timing = await auditAxisRaw(e); assert.equal(timing.status, 'PASS');
  const t = timing.rows.find(r => r.id === 'H05'); assert.equal(t.goal_deadline_status, 'UNMET');
  assert.equal(t.cell_wall_elapsedMs, 999999); assert.equal(t.goal_elapsedMs, 180001);
  delete target.result.elapsedMs; target.lifecycle.target.goal = target.result; e.rawFiles['H05-B.json'] = enc(target);
  assert.equal((await auditAxisRaw(e)).rows.find(r => r.id === 'H05').goal_deadline_status, 'UNPROVEN');
});

test('closed failed Goal calls remain integrity-auditable INVALID without a quality claim', async () => {
  const a = await synthetic('R'), row = JSON.parse(a.rawFiles['H06-A.json']), call = row.calls[0];
  call.status = 503; call.response = { error: 'judge_unavailable' }; call.error = 'http_or_contract_unknown';
  row.valid_execution = false; row.result.reason = 'judge-unknown'; row.result.trace[0].answers = null; row.result.trace[0].failure = 'judge-unknown';
  row.calls = [call]; row.result.trace = [row.result.trace[0]]; row.result.requests = 1;
  row.result.completion = { status: 'unknown', head: row.final_head, confidence: null, basis: 'not-judged' };
  a.rawFiles['H06-A.json'] = enc(row);
  edit(a, 'execution.json', r => { r.summary[0].valid_execution = false; r.summary[0].calls = 1; r.status = 'INVALID'; r.invalid_cells = 1; });
  editEvents(a, events => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].id === 'H06' && ['http-start', 'http-end'].includes(events[i].kind) && events[i].n > 1) events.splice(i, 1);
    const e = events.find(e => e.kind === 'http-end' && e.id === 'H06'); Object.assign(e, {
      status: call.status, response: call.response, error: call.error });
    Object.assign(events.find(e => e.kind === 'cell-end' && e.id === 'H06'), { valid_execution: false, calls: 1 }); });
  const report = await auditAxisRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  assert.equal(report.all_valid_execution, false); assert.equal(report.admissible_for_semantic_claim, false);
  assert.deepEqual(report.external_provider_attempt_bounds, { jev: { min: 2, max: 3 }, typellm: { min: 0, max: 0 } });
  assert.equal(report.external_provider_attempts.jev, null);
  edit(a, 'H06-A.json', r => { r.result.trace[0].failure = 'judge-contract'; }); assert.equal(await refuse(a), true);
});

test('G/F closed 503 body stays in the call while the failed producer result stays a closed fallback', async () => {
  for (const axis of ['G', 'F']) {
    const a = await synthetic(axis), row = JSON.parse(a.rawFiles['H01-B.json'] ?? a.rawFiles['H05-B.json']), call = row.calls[0];
    call.status = 503; call.response = { error: 'parts_unavailable' }; call.error = 'http_or_contract_unknown';
    row.valid_execution = false; row.result = { reason: 'evaluation-operation-unknown' }; a.rawFiles[row.id + '-B.json'] = enc(row);
    edit(a, 'execution.json', r => { r.summary[0].valid_execution = false; r.status = 'INVALID'; r.invalid_cells = 1; });
    editEvents(a, events => { Object.assign(events.find(e => e.kind === 'http-end' && e.id === row.id && e.arm === row.arm),
      { status: call.status, response: call.response, error: call.error });
      events.find(e => e.kind === 'cell-end' && e.id === row.id && e.method === row.method).valid_execution = false; });
    if (axis === 'G') a.stdoutBytes = lines(jsonLines(a.stdoutBytes).slice(2));
    const r = await auditAxisRaw(a); assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.equal(r.admissible_for_semantic_claim, false);
    if (axis === 'G') {
      const partialFactors = await synthetic('G');
      for (const keep of [1, 2]) {
        a.stdoutBytes = lines([...jsonLines(partialFactors.stdoutBytes).slice(0, keep), ...jsonLines(partialFactors.stdoutBytes).slice(2)]);
        const f = await auditAxisRaw(a); assert.equal(f.status, 'PASS', JSON.stringify(f.issues)); assert.equal(f.admissible_for_semantic_claim, false);
      }
    }
    edit(a, row.id + '-B.json', r => { r.result = call.response; }); assert.equal(await refuse(a), true);
  }
});

test('ordinary UI inventory-unknown has one failed call and null coverage without graph adoption', async () => {
  const a = await synthetic('E'), row = JSON.parse(a.rawFiles['H01-B.json']), call = row.calls[0];
  call.status = 503; call.response = { error: 'parts_unavailable' }; call.error = 'http_or_contract_unknown';
  row.calls = [call]; row.valid_execution = false; row.result = { reason: 'inventory-unknown', requests: 1, elapsedMs: 1,
    selected: [], trace: [], inventory: { checks: 1, completions: 0, coverage: null, missing: [] } };
  row.lifecycle.target.goal = row.result; a.rawFiles['H01-B.json'] = enc(row);
  edit(a, 'execution.json', r => { r.summary[0].valid_execution = false; r.summary[0].calls = 1; r.status = 'INVALID'; r.invalid_cells = 1; });
  const events = jsonLines(a.rawFiles['events.jsonl']).filter(e => e.id !== 'H01' || !['http-start', 'http-end'].includes(e.kind) || e.n === 1);
  Object.assign(events.find(e => e.id === 'H01' && e.kind === 'http-end'), { status: call.status, response: call.response, error: call.error });
  Object.assign(events.find(e => e.id === 'H01' && e.kind === 'cell-end'), { valid_execution: false, calls: 1 });
  a.rawFiles['events.jsonl'] = lines(events); a.stdoutBytes = lines(jsonLines(a.stdoutBytes).slice(2));
  const report = await auditAxisRaw(a); assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  assert.equal(report.admissible_for_semantic_claim, false); assert.equal(report.all_valid_execution, false);
});

test('F literal local HTTP does not count as Type; methods have fixed equal-state order and isolation', async () => {
  const a = await synthetic('F'), report = await auditAxisRaw(a);
  assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  assert.deepEqual(report.external_provider_attempts, { jev: 0, typellm: 3 });
  for (const mutate of [
    x => edit(x, 'H05-C.json', r => { r.calls[0].route = '/api/parts/complete'; }),
    x => edit(x, 'H05-B.json', r => { r.calls[0].request.state.oracle = { label: 'hint' }; }),
    x => edit(x, 'H05-B.json', r => { r.final_head = 'sha256:' + 'b'.repeat(64); }),
    x => edit(x, 'execution.json', r => { [r.summary[0], r.summary[1]] = [r.summary[1], r.summary[0]]; }),
  ]) { const x = await synthetic('F'); mutate(x); assert.equal(await refuse(x), true); }
});

test('R uses real production Goal with supplied inventory; a valid wrong graph remains semantic UNMET', async () => {
  const a = await synthetic('R'), report = await auditAxisRaw(a);
  assert.equal(report.status, 'PASS', JSON.stringify(report.issues)); assert.deepEqual(report.external_provider_attempts, { jev: 4, typellm: 0 });
  assert.equal(report.semantic.representation_criteria, 'UNMET');
  for (const mutate of [
    x => edit(x, 'H06-A.json', r => { r.parts[0].label = 'wrong'; }),
    x => edit(x, 'H06-A.json', r => { r.calls[0].request.state.graph[0].label = 'wrong'; }),
    x => edit(x, 'H06-A.json', r => { r.result.trace[0].answers.delta.confidence = 0.2; }),
    x => edit(x, 'H06-A.json', r => { r.calls[0].route = '/api/parts/check'; }),
  ]) { const x = await synthetic('R'); mutate(x); assert.equal(await refuse(x), true); }
});

test('actual chosen candidate adoption joins selected/new records, not merely a valid arbitrary final log', async () => {
  const a = await synthetic('R', { adoptOne: true }), report = await auditAxisRaw(a);
  assert.equal(report.status, 'PASS', JSON.stringify(report.issues));
  const row = JSON.parse(a.rawFiles['H06-A.json']); assert.equal(row.result.selected.length, 1);
  edit(a, 'H06-A.json', r => { r.result.selected = []; }); assert.equal(await refuse(a), true);
  const b = await synthetic('R'), prior = JSON.parse(b.rawFiles['H06-A.json']);
  Object.assign(prior, { final_log: row.final_log, final_head: row.final_head, final_records: row.final_records });
  b.rawFiles['H06-A.json'] = enc(prior); editEvents(b, events => { events.find(e => e.kind === 'cell-end' && e.id === 'H06').final_head = row.final_head; });
  assert.equal(await refuse(b), true);
});

test('a correction needs its faithful public parent; fresh cannot shrink to a selected subset', async () => {
  const a = await synthetic('G');
  assert.equal(await refuse({ ...a, phaseKind: 'correction' }), true);
  assert.equal(await refuse({ ...a, phaseKind: 'fresh', parentProjectionBytes: a.projectionBytes }), true);
  for (const axis of ['G', 'R', 'F', 'E']) assert.equal(await refuse({ ...await synthetic(axis), phaseKind: 'fresh' }), true);
  const parent = JSON.parse(a.projectionBytes); parent.cases[0].utterance += ' changed';
  assert.equal(await refuse({ ...a, phaseKind: 'correction', parentProjectionBytes: enc(parent) }), true);
  const subset = await synthetic('G'), original = subset.projectionBytes, selected = JSON.parse(original); selected.cases = selected.cases.slice(0, 1);
  subset.projectionBytes = enc(selected); edit(subset, 'identity.json', r => { r.case_order = ['H01']; r.inputs_sha256 = sha256(subset.projectionBytes); });
  edit(subset, 'execution.json', r => { r.expected_cells = 1; r.summary = r.summary.slice(0, 1); });
  subset.rawFiles = Object.fromEntries(Object.entries(subset.rawFiles).filter(([n]) => !/-[ABC][.]json$/.test(n) || n === 'H01-B.json'));
  subset.rawFiles['events.jsonl'] = lines(jsonLines(subset.rawFiles['events.jsonl']).filter(e => e.id === 'H01'));
  subset.stdoutBytes = lines(jsonLines(subset.stdoutBytes).slice(0, 2));
  assert.equal((await auditAxisRaw({ ...subset, phaseKind: 'correction', parentProjectionBytes: original })).status, 'PASS');
  const wrongUnusedParent = JSON.parse(original); wrongUnusedParent.cases[3].utterance += ' changed-unused';
  assert.equal(await refuse({ ...subset, phaseKind: 'correction', parentProjectionBytes: enc(wrongUnusedParent) }), true);
});

function budgetFixture(priorJev = 564, allowances = { jev: 4, typellm: 0 }, actual = { jev: 4, typellm: 0 }) {
  const heads = { apps: 'a'.repeat(40), envs: 'b'.repeat(40) }, program = '/test/launcher';
  const config = { phase_id: 'unit-own', heads, program, allowances }, configBytes = enc(config);
  const process = { ...config, config_sha256: sha256(configBytes), pid: 42, pgid: 42, start_ticks: '5' };
  const stderrBytes = Buffer.from([...Array(actual.jev)].map((_, i) => 'provider-send:jev:' + (i + 1)).concat(
    [...Array(actual.typellm)].map((_, i) => 'provider-send:typellm:' + (i + 1))).join('\n') + '\n');
  const stdoutBytes = Buffer.from('unit-no-keys\n'), events = []; let charged = { jev: 0, typellm: 0 }, chunk = 0;
  while (charged.jev < priorJev || charged.typellm < 29) {
    const amount = { jev: Math.min(300, priorJev - charged.jev), typellm: 29 - charged.typellm }, id = 'prior-' + chunk++;
    events.push({ kind: 'phase-reserve', id, prior_charged: { ...charged }, allowances: amount });
    events.push({ kind: 'phase-reconcile', id, sent: amount }); charged.jev += amount.jev; charged.typellm += amount.typellm;
  }
  events.push({ kind: 'phase-reserve', id: config.phase_id, prior_charged: { ...charged }, allowances, heads, program, config_sha256: sha256(configBytes) });
  events.push({ kind: 'phase-reconcile', id: config.phase_id, sent: actual, pid: process.pid, start_ticks: process.start_ticks,
    stopped_group_empty: true, stderr_sha256: sha256(stderrBytes), stdout_sha256: sha256(stdoutBytes) });
  return { configBytes, processBytes: enc(process), stderrBytes, stdoutBytes, journalBytes: lines(events) };
}

test('axis budget binds exact counts, within-input caps and cycle reservation cap rather than global slack', () => {
  assert.equal(auditAxisProviderPhase(budgetFixture(), { jev: 4, typellm: 0 }, { axis: 'G', caseCount: 4 }).status, 'PASS');
  assert.equal(auditAxisProviderPhase(budgetFixture(564, { jev: 5, typellm: 0 }), { jev: 4, typellm: 0 }, { axis: 'G', caseCount: 4 }).status, 'FAIL');
  assert.equal(auditAxisProviderPhase(budgetFixture(853, { jev: 4, typellm: 0 }, { jev: 1, typellm: 0 }), { jev: 1, typellm: 0 }, { axis: 'G', caseCount: 4 }).status, 'FAIL');
  const a = budgetFixture(); a.stderrBytes = Buffer.from(a.stderrBytes.toString().replace('provider-send:jev:2', 'provider-send:jev:3'));
  assert.throws(() => auditAxisProviderPhase(a, { jev: 4, typellm: 0 }, { axis: 'G', caseCount: 4 }));
  const b = budgetFixture(564, { jev: 4, typellm: 0 }, { jev: 3, typellm: 0 });
  assert.equal(auditAxisProviderPhase(b, { jev: { min: 3, max: 4 }, typellm: { min: 0, max: 0 } }, { axis: 'G', caseCount: 4 }).status, 'PASS');
  assert.equal(auditAxisProviderPhase(b, { jev: 4, typellm: 0 }, { axis: 'G', caseCount: 4 }).status, 'FAIL');
});

test('keyless smoke runtime missing live launcher/PID/preload binding cannot become live producer evidence', () => {
  let refused = false;
  try { const report = auditAxisProducerBinding({ identityBytes: enc({ schema: 'voice-ui.component-axes-execution/1',
      source: { scope: 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE', provider_entry: { scope: 'bundled provider with synthetic fetch only' } } }),
    runtimeAuditBytes: enc({}), configBytes: enc({}), processBytes: enc({}), artifactManifestBytes: enc({}),
    workerBytes: Buffer.from('synthetic'), providerBytes: Buffer.from('synthetic'), protocolEntryBytes: Buffer.from('synthetic'),
    bundleBytes, sourceFiles: {}, auditReferences: {}, rawFiles: {}, stdoutBytes: Buffer.alloc(0), stderrBytes: Buffer.alloc(0), journalBytes: Buffer.alloc(0) },
    { schema: 'voice-ui.component-axes-producer/1' }); refused = report.status !== 'PASS'; } catch { refused = true; }
  assert.equal(refused, true);
});
