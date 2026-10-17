// Independent v2 stopped-receipt auditor, under development until mutation admission.
// No provider calls, environment reads, private identity reads or product imports.
import { createHash } from 'node:crypto';
import { canonical } from './semantic-score.mjs';
import { exactKeys as exact, sameValue as same, validateRequirementInput, requirementsSchedule, validRequirements,
  validFactors, validDecision, readRequirementInspection, decodeRequiredSlots, stockDifference, verifierDecision,
  gradeFullRequired, gradeVerification, gradeRequirementGoal, summarizeRequirementAxis } from './requirements-cycle-score.mjs';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const providers = ['jev', 'typellm'], counts = () => ({ jev: 0, typellm: 0 });
const countShape = x => exact(x, providers) && providers.every(p => Number.isSafeInteger(x[p]) && x[p] >= 0);
const pair = row => row.id + '/' + row.arm;
const endFields = c => ({ status: c.status ?? null, elapsedMs: c.elapsedMs,
  ...(Object.hasOwn(c, 'response') ? { response: c.response } : {}), ...(Object.hasOwn(c, 'error') ? { error: c.error } : {}) });
const offersOf = parts => parts.map(({ key, purpose, label }) => ({ key, purpose, label }));
const validMissing = rows => Array.isArray(rows) && rows.length <= 3 && rows.every(r => exact(r, ['label', 'kind', 'occurrence'])
  && typeof r.label === 'string' && r.label.trim().length > 0 && r.label.length <= 120
  && ['step', 'decision', 'data', 'start', 'end', 'group'].includes(r.kind) && Number.isSafeInteger(r.occurrence)
  && r.occurrence >= 1 && r.occurrence <= 3) && new Set(rows.map(r => JSON.stringify(r))).size === rows.length
  && rows.every(r => rows.filter(x => x.label === r.label && x.kind === r.kind).map(x => x.occurrence).sort().every((n, i) => n === i + 1));
function jsonLines(bytes) {
  const value = Buffer.from(bytes).toString('utf8');
  if (!value.endsWith('\n') || value.includes('\r') || value.slice(0, -1).split('\n').some(s => !s)) throw Error('JSONL framing');
  return value.slice(0, -1).split('\n').map(s => JSON.parse(s));
}
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(x);
function routeOf(call) {
  const route = call.upstream_route ?? call.route;
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) throw Error('HTTP route');
  const url = new URL(route, 'http://fixture.invalid');
  if (url.hash || [...url.searchParams.keys()].some(k => k !== 'method') || url.searchParams.getAll('method').length > 1) throw Error('query contract');
  const method = url.searchParams.get('method');
  if (url.pathname === '/api/parts/check' ? !['literal-v2', 'adaptive-v2'].includes(method) : url.search) throw Error('v2 route mode');
  if (!['/api/parts/check', '/api/parts/requirements', '/api/parts/verify', '/api/judge'].includes(url.pathname)) throw Error('unexpected API route');
  return { path: url.pathname, method };
}
const inventoryOf = (item, initial, parts) => ({ kind: 'voice-ui.goal.inventory.v1', state: {
  utterance: item.utterance, head: initial.head,
  regions: initial.records.filter(r => r.type === 'region').map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
  edges: initial.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })), parts,
} });
function stageRows(stdoutBytes) {
  const rows = [];
  for (const line of Buffer.from(stdoutBytes).toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let value; try { value = JSON.parse(line); } catch { if (line.includes('voice-ui.parts.')) throw Error('malformed stage JSON'); continue; }
    if (value?.kind === 'voice-ui.parts.stage.v2') rows.push(value);
    else if (value?.kind?.startsWith('voice-ui.parts.')) throw Error('unjoined foreign parts stdout');
  }
  const groups = [], ids = new Set();
  for (const row of rows) {
    if (!uuid(row.request_id) || !['G0', 'TYPE_REQUIRED', 'VERIFY_REQUIRED', 'STOCK_DIFF'].includes(row.stage)) throw Error('stage identity');
    const prefix = ['kind', 'request_id', 'stage'];
    const tail = row.stage === 'STOCK_DIFF' ? ['required', 'missing', 'decision']
      : row.valid === false ? ['valid'] : row.stage === 'G0' ? ['valid', 'initial']
      : row.stage === 'TYPE_REQUIRED' ? ['valid', 'proposal'] : ['valid', 'required', 'factors'];
    if (!exact(row, [...prefix, ...tail]) || row.stage !== 'STOCK_DIFF' && ![true, false].includes(row.valid)) throw Error('closed stage fields');
    if (!groups.length || groups.at(-1)[0].request_id !== row.request_id) {
      if (ids.has(row.request_id)) throw Error('noncontiguous request stages'); ids.add(row.request_id); groups.push([]);
    }
    groups.at(-1).push(row);
  }
  return { rows, groups };
}
function validateG0(initial, inventory, id) {
  const state = inventory.state, required = initial?.literal?.required;
  if (!validRequirements(required)) throw Error('G0 required');
  const shape = { schema: 'voice-ui.parts.inspection/2', request_id: id, mode: 'literal-v2', initial,
    proposal: null, verification: null, required, missing: stockDifference(required, state.parts) };
  if (!readRequirementInspection(shape, state.utterance, state.parts)) throw Error('G0 closed factors/literal');
  const refs = new Set(state.regions.filter(r => !['group', 'boundary'].includes(r.kind) && state.utterance.includes(r.label)).map(r => r.label));
  const ready = initial.observation.valid && (initial.observation.status === 'transcribed' || required.length === 0 && refs.size >= 2);
  const { intent, completeness } = initial.factors;
  const choice = intent.choice !== 'change' ? intent.choice : ready && completeness.choice === 'complete' && completeness.confidence >= 0.5
    ? shape.missing.length ? 'missing' : 'sufficient' : 'unknown';
  const confidence = choice === 'unknown' ? null : intent.choice !== 'change' ? intent.confidence : Math.min(intent.confidence, completeness.confidence);
  if (!same(initial.decision, { choice, confidence })) throw Error('independent G0 decision equation');
  return intent.choice === 'change' && intent.confidence >= 0.5 && completeness.choice === 'incomplete' && completeness.confidence >= 0.5;
}
function stageCall(call, group) {
  const route = routeOf(call), ok = call.status === 200 && !Object.hasOwn(call, 'error');
  const state = route.path === '/api/parts/verify' ? call.request.inventory : call.request;
  const stages = group.map(x => x.stage), expected = route.path === '/api/parts/requirements' ? ['TYPE_REQUIRED']
    : route.path === '/api/parts/verify' ? ['VERIFY_REQUIRED'] : ['G0', 'TYPE_REQUIRED', 'VERIFY_REQUIRED', 'STOCK_DIFF'];
  if (group.some((x, i) => x.valid === false && i !== group.length - 1)) throw Error('stage after rejected contract');
  if (route.path !== '/api/parts/check') {
    if (group.length > 1 || group.length && stages[0] !== expected[0]) throw Error('direct stage isolation');
  } else if (group.length) {
    if (stages[0] !== 'G0' || new Set(stages).size !== stages.length
        || stages.some((s, i) => i && expected.indexOf(s) <= expected.indexOf(stages[i - 1]))) throw Error('check stage order');
  }
  const g0 = group.find(x => x.stage === 'G0'), typed = group.find(x => x.stage === 'TYPE_REQUIRED'), verified = group.find(x => x.stage === 'VERIFY_REQUIRED');
  const stock = group.find(x => x.stage === 'STOCK_DIFF');
  let eligible = false;
  if (g0?.valid) eligible = validateG0(g0.initial, state, g0.request_id);
  if (route.path === '/api/parts/check' && typed && (route.method !== 'adaptive-v2' || !eligible)) throw Error('unauthorized Type stage');
  if (route.path === '/api/parts/check' && verified && !typed?.valid) throw Error('verification without approved Type stage');
  if (typed?.valid) {
    const decoded = decodeRequiredSlots(typed.proposal?.slots);
    if (!exact(typed.proposal, ['slots', 'required']) || decoded === null || !same(decoded, typed.proposal.required)) throw Error('approved Type slot join');
  }
  if (verified?.valid) {
    if (!validRequirements(verified.required) || !validFactors(verified.factors)) throw Error('verification stage fields');
    if (route.path === '/api/parts/check' && (!typed?.valid || !same(verified.required, typed.proposal.required))) throw Error('verify original full proposal');
    if (route.path === '/api/parts/verify' && !same(verified.required, call.request.required)) throw Error('direct verify proposal');
  }
  if (stock) {
    if (!g0?.valid || typed && !typed.valid || verified && !verified.valid || typed?.valid && !verified) throw Error('stock stage prerequisites');
    const required = typed?.proposal.required ?? g0.initial.literal.required;
    if (!same(stock.required, required) || !same(stock.missing, stockDifference(required, state.state.parts)) || !validDecision(stock.decision)) throw Error('deterministic stock stage');
  }
  if (ok) {
    const response = call.response;
    if (!group.length || !uuid(response?.request_id ?? response?.inspection?.request_id)
        || group[0].request_id !== (response.request_id ?? response.inspection.request_id)) throw Error('successful response/request-id join');
    if (route.path === '/api/parts/requirements') {
      if (!typed?.valid || !exact(response, ['schema', 'request_id', 'slots', 'required']) || response.schema !== 'voice-ui.parts.requirements/2'
          || !same({ slots: response.slots, required: response.required }, typed.proposal)) throw Error('direct required response');
    } else if (route.path === '/api/parts/verify') {
      const derived = verifierDecision(response?.factors);
      if (!verified?.valid || !exact(response, ['schema', 'request_id', 'required', 'factors', 'accepted', 'confidence'])
          || response.schema !== 'voice-ui.parts.verification/2' || !same(response.required, verified.required)
          || !same(response.factors, verified.factors) || !derived || response.accepted !== derived.accepted || response.confidence !== derived.confidence)
        throw Error('direct verification response');
    } else {
      const inspection = readRequirementInspection(response?.inspection, state.state.utterance, state.state.parts);
      if (!exact(response, ['choice', 'confidence', 'inspection']) || !inspection || response.inspection.mode !== route.method || !stock
          || !same(response.inspection.initial, g0.initial) || !same(response.inspection.proposal, typed?.proposal ?? null)
          || !same(response.inspection.verification, verified?.factors ?? null)
          || !same(stock.decision, { choice: response.choice, confidence: response.confidence })
          || !same(stock.decision, inspection.normalized)) throw Error('check all-stage/body equation');
      if (eligible && route.method === 'adaptive-v2' && (!typed || !verified)) throw Error('missing conditional Type/verifier');
    }
  }
  const min = { jev: Number(Boolean(g0)) + Number(Boolean(verified)), typellm: Number(Boolean(typed)) }, max = { ...min };
  if (!ok) {
    if (!group.length) { if (route.path === '/api/parts/requirements') max.typellm++; else max.jev++; }
    else if (route.path === '/api/parts/check' && !stock && group.at(-1).valid !== false) {
      if (typed?.valid && !verified) max.jev++;
      else if (g0?.valid && !typed && route.method === 'adaptive-v2' && eligible) max.typellm++;
    }
  }
  return Object.fromEntries(providers.map(p => [p, { min: min[p], max: max[p] }]));
}
function partitionStages(groups, calls) {
  const memo = new Map();
  const visit = (at, pos) => {
    const key = at + '/' + pos; if (memo.has(key)) return memo.get(key);
    if (at === calls.length) return { ways: pos === groups.length ? 1 : 0, plan: [], bounds: Object.fromEntries(providers.map(p => [p, { min: 0, max: 0 }])) };
    const call = calls[at], options = call.status === 200 && !call.error ? [1] : [0, 1];
    let answer = null;
    for (const size of options) {
      if (pos + size > groups.length) continue;
      const group = size ? groups[pos] : [];
      let bounds; try { bounds = stageCall(call, group); } catch { continue; }
      const rest = visit(at + 1, pos + size); if (!rest.ways) continue;
      const total = Object.fromEntries(providers.map(p => [p, { min: bounds[p].min + rest.bounds[p].min, max: bounds[p].max + rest.bounds[p].max }]));
      if (!answer) answer = { ways: rest.ways, plan: [group, ...rest.plan], bounds: total };
      else { answer.ways = Math.min(2, answer.ways + rest.ways); for (const p of providers) {
        answer.bounds[p].min = Math.min(answer.bounds[p].min, total[p].min); answer.bounds[p].max = Math.max(answer.bounds[p].max, total[p].max);
      } }
    }
    answer ??= { ways: 0, plan: [], bounds: null }; memo.set(key, answer); return answer;
  };
  return visit(0, 0);
}
export const REQUIREMENTS_SOURCE_NAMES = Object.freeze([
  'src/completion.mjs', 'src/literal-inventory.mjs', 'src/goal.mjs', 'src/contract.mjs', 'src/turn.mjs', 'src/session.mjs',
  'functions/api/parts.mjs', 'functions/pages-worker.mjs', 'web/app.mjs', 'web/adapters/completion.mjs',
  'dev/serve.mjs',
  'tests/requirements-cycle-eval.mjs', 'tests/requirements-cycle-score.mjs', 'tests/requirements-cycle-audit.mjs',
  'tests/semantic-score.mjs', 'tests/requirements-cycle-http.mjs', 'tests/painted-goal.mjs',
]);
export async function auditRequirementRaw({ projectionBytes, oracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes,
  assessGoal, assessEdge, replayBytes = null, artifactManifestBytes = null, phaseKind = 'public', parentProjectionBytes = null }) {
  const input = decode(projectionBytes), oracle = decode(oracleBytes), bundle = decode(bundleBytes), issues = [];
  validateRequirementInput(input);
  if (oracle.schema !== 'voice-ui.requirements-cycle-oracle/1' || oracle.axis !== input.axis
      || input.oracle_sha256 !== sha256(oracleBytes) || !same(input.fixture_contract, oracle.fixture_contract)
      || !same(bundle.parts, oracle.stock_parts) || !Array.isArray(oracle.cases)
      || new Set(oracle.cases.map(o => o.id)).size !== oracle.cases.length) throw Error('requirements input/oracle/stock binding');
  if (!['public', 'fresh', 'correction'].includes(phaseKind)) throw Error('requirements phase kind');
  const publicCount = { V: 6, F: 6, E: 2 }[input.axis], freshCount = { V: 10, F: 8, E: 10 }[input.axis];
  if (phaseKind === 'public' && input.cases.length !== publicCount || phaseKind === 'fresh' && input.cases.length !== freshCount
      || phaseKind === 'correction' && (oracle.cases.length !== publicCount || input.cases.length !== (input.axis === 'E' ? 1 : publicCount)))
    throw Error('preregistered requirements denominator');
  const projectedCase = o => ({ id: o.id, fixture: o.fixture, utterance: o.utterance,
    ...(input.axis === 'V' ? { required: o.proposed_required } : {}) });
  const parent = parentProjectionBytes === null ? null : decode(parentProjectionBytes);
  if (phaseKind === 'correction') {
    if (parent === null) throw Error('correction parent required'); validateRequirementInput(parent);
    if (parent.axis !== input.axis || parent.oracle_sha256 !== input.oracle_sha256 || !same(parent.fixture_contract, input.fixture_contract)
        || !same(parent.cases, oracle.cases.map(projectedCase)) || input.cases.some(c => !same(c, parent.cases.find(p => p.id === c.id))))
      throw Error('correction faithful public subset');
  } else if (parent !== null || !same(input.cases, oracle.cases.map(projectedCase))) throw Error('full panel order/projection');
  const oracles = input.cases.map(c => oracle.cases.find(o => o.id === c.id));
  for (const o of oracles) {
    if (!o || !same(input.cases.find(c => c.id === o.id), projectedCase(o))
        || !['change', 'ambiguous', 'no-change', 'unsupported'].includes(o.expected_intent)
        || !['sufficient', 'missing', 'ambiguous', 'no-change', 'unsupported'].includes(o.expected_gate)
        || !Array.isArray(o.expected_added_regions) || !Array.isArray(o.expected_added_edges)) throw Error('oracle case contract');
    const control = o.expected_intent !== 'change';
    if (o.required !== null && (!validRequirements(o.required) || !same(o.expected_missing, stockDifference(o.required, bundle.parts)))
        || o.required === null && (!control || !same(o.expected_missing, []))
        || input.axis === 'V' && (!validRequirements(o.proposed_required) || typeof o.expected_accept !== 'boolean'))
      throw Error('oracle full NEW/difference contract');
    // An oracle for E must actually describe the whole requested graph. This
    // catches the pre-live public E omission without deriving meaning from code.
    if (input.axis === 'E') {
      const bag = rows => rows.map(x => JSON.stringify([x.label, x.kind])).sort();
      const wanted = o.required === null ? [] : o.required.flatMap(r => Array.from({ length: r.quantity }, () => r));
      if (!same(bag(o.expected_added_regions), bag(wanted)) || control && (o.expected_added_regions.length || o.expected_added_edges.length))
        throw Error('E oracle required/target multiset');
    }
  }
  if (phaseKind === 'fresh') {
    if (input.axis === 'V' && (oracles.filter(o => o.expected_accept).length !== 5 || oracles.filter(o => !o.expected_accept).length !== 5))
      throw Error('fresh V five/five strata');
    if (input.axis === 'F' && oracles.filter(o => o.expected_gate === 'sufficient').length !== 2) throw Error('fresh F true S denominator');
    if (input.axis === 'E' && (oracles.filter(o => o.expected_gate === 'sufficient').length !== 4
        || oracles.filter(o => o.expected_gate === 'missing').length !== 4 || oracles.filter(o => o.expected_intent !== 'change').length !== 2
        || ['sufficient', 'missing'].some(g => ['B-known', 'natural-alternate'].some(s =>
          oracles.filter(o => o.expected_gate === g && o.syntax_stratum === s).length !== 2)))) throw Error('fresh E four/four/two syntax strata');
  }
  const identity = decode(rawFiles['identity.json']), execution = decode(rawFiles['execution.json']);
  const planned = requirementsSchedule(input), summary = execution.summary;
  if (identity.schema !== 'voice-ui.requirements-cycle-execution/1' || identity.axis !== input.axis
      || identity.inputs_sha256 !== sha256(projectionBytes) || identity.bundle_sha256 !== sha256(bundleBytes)
      || !same(identity.case_order, input.cases.map(c => c.id))
      || identity.methods !== (input.axis === 'E' ? 'alternating literal-v2/adaptive-v2 and adaptive-v2/literal-v2' : input.axis === 'F' ? 'full-required' : 'verify')
      || !same(Object.keys(identity.source_sha256 ?? {}).sort(), [...REQUIREMENTS_SOURCE_NAMES].sort())) issues.push('requirements execution identity');
  if (execution.schema !== 'voice-ui.requirements-cycle-phase/1' || execution.axis !== input.axis
      || execution.expected_cells !== planned.length || !Array.isArray(summary) || summary.length > planned.length) throw Error('requirements terminal plan');
  if (summary.some((s, i) => !same({ axis: s.axis, id: s.id, method: s.method },
    { axis: planned[i].axis, id: planned[i].id, method: planned[i].method }))) throw Error('consumed method/case order');
  const names = ['identity.json', 'execution.json', 'events.jsonl', ...planned.slice(0, summary.length).map(p => p.id + '-' + p.arm + '.json')];
  if (!same(Object.keys(rawFiles).sort(), names.sort())) issues.push('exact raw snapshot inventory');
  const rows = planned.slice(0, summary.length).map(p => decode(rawFiles[p.id + '-' + p.arm + '.json']));
  const operationCalls = rows.flatMap(r => r.calls.filter(c => routeOf(c).path !== '/api/judge'));
  const log = stageRows(stdoutBytes), partition = partitionStages(log.groups, operationCalls);
  if (!partition.ways) issues.push('unjoined or inconsistent stage stdout');
  let replay = null;
  if (replayBytes !== null) {
    if (input.axis !== 'E' || artifactManifestBytes === null || typeof assessGoal !== 'function' || typeof assessEdge !== 'function') throw Error('unexpected replay scope');
    replay = auditRequirementReplayJoin({ replayBytes, rawFiles, artifactManifestBytes, assessGoal, assessEdge });
    if (replay.status !== 'PASS') issues.push('completed artifact replay join');
  }
  const initials = new Map(), proofs = [], graded = [];
  let at = 0;
  const external = partition.ways ? structuredClone(partition.bounds)
    : Object.fromEntries(providers.map(p => [p, { min: 0, max: 0 }]));
  const reasons = new Set(['none', 'not-confident', 'no-executable-delta', 'candidate-overflow', 'budget-requests', 'budget-time',
    'inventory-not-confident', 'inventory-ambiguous', 'inventory-no-change', 'inventory-unsupported', 'inventory-unresolved', 'completion-empty']);
  for (const [index, row] of rows.entries()) {
    const plan = planned[index], item = input.cases.find(c => c.id === plan.id), o = oracles.find(c => c.id === plan.id);
    const fixed = ['schema', 'axis', 'id', 'method', 'arm', 'replay_suffix_scope', 'fixture', 'utterance', 'parts', 'valid_execution', 'elapsedMs',
      'result', 'calls', 'initial_head', 'initial_log', 'initial_log_sha256', 'initial_records', 'final_head', 'final_log', 'final_records'];
    if (!exact(row, [...fixed, ...(input.axis === 'E' ? ['frames', 'lifecycle'] : [])])
        || row.schema !== 'voice-ui.requirements-cycle-cell/1' || row.axis !== input.axis || row.id !== plan.id
        || row.method !== plan.method || row.arm !== plan.arm || row.fixture !== item.fixture || row.utterance !== item.utterance
        || typeof row.valid_execution !== 'boolean' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 || !same(row.parts, bundle.parts)
        || !same(summary[index], { axis: row.axis, id: row.id, method: row.method, valid_execution: row.valid_execution, calls: row.calls?.length }))
      issues.push('cell/input/terminal binding ' + pair(row));
    if (!Array.isArray(row.calls)) throw Error('calls array');
    if (!initials.has(row.id)) {
      const f = input.fixture_contract, sub = f.fixtures[item.fixture];
      const made = await protocol.createDecisionLog([...f.base_records, ...sub.extra_records], f.map_id);
      const pin = await protocol.createDecision(made.head, [{ type: 'PinRegions', items: [...f.base_pins, ...sub.extra_pins] }], made.records);
      initials.set(row.id, (await protocol.appendDecision(made.log, pin.decision)).verified);
    }
    const initial = initials.get(row.id), inventory = inventoryOf(item, initial, bundle.parts);
    const op = [], judges = [];
    for (const [n, call] of row.calls.entries()) {
      const route = routeOf(call), fields = ['id', 'arm', 'n', 'route', 'request', 'status', 'elapsedMs',
        ...(Object.hasOwn(call, 'upstream_route') ? ['upstream_route'] : []), ...(Object.hasOwn(call, 'response') ? ['response'] : []),
        ...(Object.hasOwn(call, 'error') ? ['error'] : [])];
      if (!exact(call, fields) || call.id !== row.id || call.arm !== row.arm || call.n !== n + 1
          || !Number.isFinite(call.elapsedMs) || call.elapsedMs < 0 || call.status !== null && (!Number.isSafeInteger(call.status) || call.status < 100 || call.status > 599)
          || Object.hasOwn(call, 'error') && call.error !== 'http_or_contract_unknown') issues.push('closed HTTP terminal/cell ' + pair(row));
      if (route.path === '/api/judge') {
        judges.push(call); external.jev.max++; if (call.status === 200 && !call.error) external.jev.min++;
        if (input.axis !== 'E' || call.route !== '/api/judge' || call.upstream_route !== '/api/judge') issues.push('judge locality');
      } else {
        op.push(call); at++;
        const expectedRoute = input.axis === 'E' ? '/api/parts/check' : '/api/parts/' + (input.axis === 'F' ? 'requirements' : 'verify');
        const body = input.axis === 'V' ? { schema: 'voice-ui.parts.verify/2', inventory, required: item.required } : inventory;
        if (route.path !== expectedRoute || !same(call.request, body) || input.axis === 'E' && (call.route !== expectedRoute
          || call.upstream_route !== expectedRoute + '?method=' + row.method)) issues.push('original utterance/initial inventory/operation ' + pair(row));
      }
    }
    const httpValid = row.calls.every(c => c.status === 200 && !Object.hasOwn(c, 'error') && Object.hasOwn(c, 'response'));
    if (row.valid_execution && !httpValid) issues.push('valid cell with failed HTTP');
    const check = op[0], checkOk = check?.status === 200 && !check.error;
    let actualMissing = [], preparations = 0, coverage = row.result?.inventory?.coverage;
    if (input.axis === 'E') {
      if (op.length !== 1 || row.calls[0] !== check || judges.length > 8 || row.result?.requests !== 1 + judges.length
          || row.result?.inventory?.checks !== 1 || row.result?.inventory?.completions !== 0) issues.push('one v2 check/no completion/finite Goal accounting');
      if (checkOk && !same(coverage, check.response) || !checkOk && coverage !== null) issues.push('actual check/result equality');
      preparations = row.result?.inventory?.preparations; actualMissing = row.result?.inventory?.missing;
      const inspected = checkOk ? readRequirementInspection(check.response?.inspection, item.utterance, bundle.parts) : null;
      const authorized = inspected !== null && ['sufficient', 'missing'].includes(coverage?.choice) && coverage.confidence >= 0.5;
      const expectedMissing = authorized && coverage.choice === 'missing' ? inspected.projected_missing : [];
      const expectedPreparation = expectedMissing.length ? 1 : 0;
      if (!same(actualMissing, expectedMissing) || preparations !== expectedPreparation || !authorized && judges.length)
        issues.push('verified deterministic materialization/authorization');
      if (row.valid_execution && !reasons.has(row.result?.reason)) issues.push('invalid stop reason admitted');
      if (checkOk && row.result?.reason?.startsWith('inventory-')) {
        const expectedStop = coverage.choice === 'unknown' ? 'inventory-unresolved' : coverage.confidence < 0.5 ? 'inventory-not-confident'
          : ['sufficient', 'missing'].includes(coverage.choice) ? null : 'inventory-' + coverage.choice;
        if (row.result.reason !== expectedStop) issues.push('inventory stop/decision equation');
      }
    } else if (op.length !== 1 || judges.length || row.calls.length !== 1 || checkOk && !same(row.result, check.response)
        || !checkOk && !same(row.result, { reason: 'evaluation-operation-unknown' })) issues.push('direct isolated result/HTTP join');
    let proofIssue = false;
    try {
      const final = await protocol.verifyDecisionLog(row.final_log);
      if (row.initial_log !== initial.log || row.initial_log_sha256 !== sha256(initial.log) || row.initial_head !== initial.head
          || !same(row.initial_records, initial.records) || !row.final_log.startsWith(initial.log)
          || final.head !== row.final_head || !same(final.records, row.final_records)) throw Error('log projection');
      if (input.axis !== 'E' && (row.final_log !== initial.log || row.final_head !== initial.head || !same(row.final_records, initial.records))) throw Error('isolated operation changed graph');
      if (input.axis === 'E') {
        const effectiveParts = suppliedParts(bundle.parts, actualMissing), prefixes = new Map(), lines = row.final_log.trimEnd().split('\n');
        for (let n = initial.decisions.length; n <= lines.length; n++) {
          const v = await protocol.verifyDecisionLog(lines.slice(0, n).join('\n') + '\n'); prefixes.set(v.head, { n, verified: v });
        }
        if (!Array.isArray(row.result?.trace) || judges.length !== row.result.trace.length) throw Error('trace count');
        let previous = initial.decisions.length;
        for (const [n, trace] of row.result.trace.entries()) {
          const prefix = prefixes.get(trace.head), call = judges[n], state = call?.request?.state;
          if (!prefix || prefix.n < previous || !traceMatches(trace, call, 'E') || state?.utterance !== item.utterance
              || !same(state.graph, prefix.verified.records.filter(r => r.type === 'region').map(({ id, label, parent }) => ({ id, label, parent })))
              || !same(state.edges, prefix.verified.records.filter(r => r.type === 'relation').map(({ id, from, to }) => ({ id, from, to })))
              || !same(state.offers, { parts: offersOf(effectiveParts) })) throw Error('trace state/answers/offers');
          previous = prefix.n;
        }
        auditAddedRecords(row, initial, effectiveParts, judges);
      }
    } catch { proofIssue = true; issues.push('protocol/prefix/trace ' + pair(row)); }
    proofs.push({ id: row.id, method: row.method, status: proofIssue ? 'FAIL' : 'PASS', initial_head: initial.head, final_head: row.final_head });
    const allocatedIndex = operationCalls.indexOf(check), allocated = partition.plan?.[allocatedIndex] ?? [];
    const typeCount = allocated.filter(s => s.stage === 'TYPE_REQUIRED').length;
    if (input.axis === 'V' || input.axis === 'F') {
      const grade = input.axis === 'V' ? gradeVerification(row.result, o, item.required) : gradeFullRequired(row.result, o, bundle.parts);
      graded.push({ id: row.id, method: row.method, arm: row.arm, valid_execution: row.valid_execution, grade,
        cell_wall_elapsedMs: row.elapsedMs });
    } else {
      let paint = { status: 'PASS', issues: [], paint: 'UNPROVEN' };
      if (typeof assessGoal === 'function' && typeof assessEdge === 'function' && row.frames.length)
        paint = auditFrames(row.frames, row, assessGoal, assessEdge);
      else if (row.valid_execution) issues.push('missing actual E paint');
      if (paint.status !== 'PASS') issues.push(...paint.issues);
      const l = row.lifecycle, targetEqual = l?.target?.log === row.final_log && same(l?.target?.records, row.final_records) && same(l?.target?.goal, row.result);
      const saved = targetEqual && l?.applied?.stored === row.final_log && l?.reloaded?.log === row.final_log
        && l?.reloaded?.stored === row.final_log && same(l?.reloaded?.records, row.final_records) && l?.persistence === 'PASS';
      if (row.valid_execution && !saved) issues.push('actual Apply/reload target equality');
      const replayCell = replayBytes === null ? null : decode(replayBytes).rows.find(r => r.id === row.id && r.arm === row.arm);
      const replayPaint = replayCell ? auditFrames(replayCell.frames, row, assessGoal, assessEdge) : null;
      if (replayPaint && replayPaint.status !== 'PASS') issues.push(...replayPaint.issues);
      const grade = gradeRequirementGoal({ inspection: coverage?.inspection, decision: coverage && { choice: coverage.choice, confidence: coverage.confidence },
        initial_records: row.initial_records, final_records: row.final_records, initial_log: row.initial_log, final_log: row.final_log,
        initial_head: row.initial_head, final_head: row.final_head, preparations, materialized_missing: actualMissing,
        typellm_sends: typeCount, elapsedMs: row.result?.elapsedMs }, o, bundle.parts);
      graded.push({ id: row.id, method: row.method, arm: row.arm, valid_execution: row.valid_execution, grade,
        paint_status: replayPaint === null ? paint.paint : [paint.paint, replayPaint.paint].includes('UNPROVEN') ? 'UNPROVEN'
          : paint.paint === 'PASS' && replayPaint.paint === 'PASS' ? 'PASS' : 'UNMET', persisted_raw_equal: saved,
        cell_wall_elapsedMs: row.elapsedMs, goal_elapsedMs: Number.isFinite(row.result?.elapsedMs) ? row.result.elapsedMs : null,
        goal_deadline_status: Number.isFinite(row.result?.elapsedMs) && row.result.elapsedMs >= 0
          ? row.result.elapsedMs <= 180000 ? 'PASS' : 'UNMET' : 'UNPROVEN' });
    }
  }
  if (at !== operationCalls.length) issues.push('unjoined API operations');
  issues.push(...auditEvents(rawFiles['events.jsonl'], rows, summary));
  const complete = rows.length === planned.length, allValid = complete && rows.every(r => r.valid_execution === true);
  if (!['RECORDED', 'INVALID'].includes(execution.status) || (execution.status === 'RECORDED') !== allValid
      || execution.invalid_cells !== rows.filter(r => !r.valid_execution).length) issues.push('terminal validity/denominator');
  const semantic = summarizeRequirementAxis(input.axis, graded, oracles, { phaseKind });
  return { schema: 'voice-ui.requirements-cycle-raw-audit/1', axis: input.axis, status: issues.length ? 'FAIL' : 'PASS', issues,
    complete, all_valid_execution: allValid, consumed: rows.length, planned: planned.length, rows: graded, semantic,
    phase_kind: phaseKind, inputs_sha256: sha256(projectionBytes),
    parent_inputs_sha256: parentProjectionBytes === null ? null : sha256(parentProjectionBytes),
    admissible_for_semantic_claim: issues.length === 0 && allValid && identity.source?.scope !== 'SYNTHETIC_KEYLESS_ONLY_NOT_ADMISSIBLE_AS_LIVE',
    external_provider_attempts: Object.fromEntries(providers.map(p => [p, external[p].min === external[p].max ? external[p].min : null])),
    external_provider_attempt_bounds: external, stage_rows: log.rows.length, stage_alignment: !partition.ways ? 'FAIL'
      : partition.ways === 1 ? 'UNIQUE' : 'AMBIGUOUS_FAILED_OPERATIONS_NO_CELL_STAGE_CLAIM', proofs, replay,
    raw_sha256: Object.fromEntries(Object.entries(rawFiles).map(([name, b]) => [name, sha256(b)])),
    scope: 'raw locality only; exact producer/source/provider/physical PID and required paint admission remain separate',
    CI_LIVE_EXECUTION: 'UNPROVEN', currency: 'COST_NOT_MEASURED' };
}
export function auditRequirementProviderPhase(bytes, expectedSends, { axis, caseCount, phaseKind = 'public' }) {
  if (!['V', 'F', 'E'].includes(axis) || !['public', 'correction', 'final'].includes(phaseKind)
      || !Number.isSafeInteger(caseCount) || caseCount < 1 || caseCount > 10) throw Error('requirements phase scope');
  const bounds = Object.fromEntries(providers.map(p => {
    const value = expectedSends[p], bound = typeof value === 'number' ? { min: value, max: value } : value;
    if (!exact(bound, ['min', 'max']) || !Number.isSafeInteger(bound.min) || !Number.isSafeInteger(bound.max)
        || bound.min < 0 || bound.max < bound.min || bound.max > 300) throw Error('provider bounds');
    return [p, bound];
  }));
  const actual = counts();
  for (const line of Buffer.from(bytes.stderrBytes).toString('utf8').split('\n')) {
    const m = /^provider-send:(jev|typellm):([1-9][0-9]*)$/u.exec(line); if (m) actual[m[1]]++;
  }
  const report = genericProviderPhase(bytes, actual), config = decode(bytes.configBytes), issues = [...report.issues];
  const wantedCount = phaseKind === 'final' ? { V: 10, F: 8, E: 10 }[axis]
    : phaseKind === 'correction' ? { V: 6, F: 6, E: 1 }[axis] : { V: 6, F: 6, E: 2 }[axis];
  if (caseCount !== wantedCount || config.stage !== phaseKind) issues.push('registered phase/count');
  const cap = axis === 'V' ? { jev: caseCount, typellm: 0 }
    : axis === 'F' ? { jev: 0, typellm: caseCount } : { jev: 19 * caseCount, typellm: caseCount };
  const start = { jev: 689, typellm: 40 }, limit = { jev: 300, typellm: 40 }, remaining = {};
  for (const p of providers) {
    if (report.sent[p] < bounds[p].min || report.sent[p] > bounds[p].max) issues.push('provider outside raw bounds ' + p);
    if (config.allowances[p] > cap[p] || bounds[p].max > cap[p] || report.prior_charged?.[p] < start[p]
        || report.prior_charged?.[p] + config.allowances[p] > start[p] + limit[p]
        || report.charged_at_cutoff[p] > start[p] + limit[p]) issues.push('phase/cycle allowance ' + p);
    remaining[p] = start[p] + limit[p] - report.charged_at_cutoff[p];
  }
  return { ...report, status: issues.length ? 'FAIL' : 'PASS', issues, expected_external_bounds: bounds,
    cycle_start: start, cycle_limit: limit, cycle_remaining: remaining };
}
// These expectations are authored by R after actual source/process/stop review,
// then frozen. CI never manufactures them from the receipts it is checking.
export function auditRequirementProducerBinding({ identityBytes, runtimeAuditBytes, configBytes, processBytes,
  artifactManifestBytes, workerBytes, providerBytes, protocolEntryBytes, bundleBytes, sourceFiles, auditReferences,
  rawFiles, stdoutBytes, stderrBytes, journalBytes, replayBytes = null }, producer) {
  if (producer.schema !== 'voice-ui.requirements-cycle-producer/1' || !['V', 'F', 'E'].includes(producer.axis)) throw Error('requirements producer schema/axis');
  const identity = decode(identityBytes), runtime = decode(runtimeAuditBytes), config = decode(configBytes);
  const process = decode(processBytes), manifest = decode(artifactManifestBytes), source = identity.source, issues = [];
  if (source?.schema !== 'voice-ui.poc.runtime/1' || source.scope !== undefined
      || source?.provider_entry?.scope !== undefined) issues.push('synthetic or unrecognized scope is not live producer evidence');
  const items = { raw_identity_sha256: identityBytes, runtime_audit_sha256: runtimeAuditBytes, config_sha256: configBytes,
    process_sha256: processBytes, artifact_manifest_sha256: artifactManifestBytes, worker_sha256: workerBytes,
    provider_sha256: providerBytes, protocol_sha256: protocolEntryBytes, stdout_sha256: stdoutBytes, stderr_sha256: stderrBytes,
    journal_sha256: journalBytes };
  for (const [name, b] of Object.entries(items)) if (producer[name] !== sha256(b)) issues.push('producer digest ' + name);
  if (producer.replay_sha256 !== (replayBytes === null ? null : sha256(replayBytes))) issues.push('replay fixed digest');
  if (!same(Object.keys(rawFiles).sort(), Object.keys(producer.raw_sha256 ?? {}).sort())) issues.push('fixed raw inventory');
  else for (const [name, digest] of Object.entries(producer.raw_sha256)) if (sha256(rawFiles[name]) !== digest) issues.push('fixed raw digest ' + name);
  if (!Buffer.from(rawFiles['identity.json']).equals(Buffer.from(identityBytes)) || identity.schema !== 'voice-ui.requirements-cycle-execution/1'
      || identity.axis !== producer.axis || !same(source.heads, producer.heads) || !same(config.heads, source.heads)
      || identity.inputs_sha256 !== producer.inputs_sha256 || producer.inputs_sha256 !== config.input_sha256
      || identity.bundle_sha256 !== producer.bundle_sha256
      || sha256(bundleBytes) !== producer.bundle_sha256 || producer.phase_id !== config.phase_id || config.phase_id !== source.launcher.phase_id
      || config.heads.apps !== runtime.apps_sha || runtime.apps_sha !== source.heads.apps || manifest.sources.apps !== runtime.apps_sha
      || manifest.sources.ui !== source.heads.ui || source.audit_sha256 !== sha256(runtimeAuditBytes)
      || runtime.worker.sha256 !== sha256(workerBytes) || source.worker_entry.sha256 !== sha256(workerBytes)
      || runtime.worker.path !== source.worker_entry.path || runtime.manifest.sha256 !== sha256(artifactManifestBytes)
      || runtime.artifact_root !== source.artifact.root || source.artifact.manifest_sha256 !== sha256(artifactManifestBytes)
      || runtime.provider.sha256 !== sha256(providerBytes) || source.provider_entry.sha256 !== sha256(providerBytes)
      || runtime.provider.path !== source.provider_entry.path || manifest.sources['jev-provider'].entry_sha256 !== sha256(providerBytes)
      || runtime.semantic_map.protocol.sha256 !== sha256(protocolEntryBytes) || source.semantic_map.protocol_sha256 !== sha256(protocolEntryBytes)
      || runtime.semantic_map.root !== source.semantic_map.root || runtime.dev_program.path !== source.launcher.dev_program
      || process.pid !== source.launcher.pid || process.start_ticks !== source.launcher.start_ticks || process.pgid !== process.pid
      || !same(process.allowances, source.launcher.allowances) || !same(config.heads, process.heads) || !same(process.allowances, config.allowances)
      || process.program !== config.program || source.launcher.program !== process.program
      || process.config_sha256 !== sha256(configBytes)) issues.push('source/runtime/process joins');
  if (!same(identity.source_sha256, producer.source_sha256)
      || !same(Object.keys(sourceFiles).sort(), [...REQUIREMENTS_SOURCE_NAMES].sort())
      || !same(Object.keys(sourceFiles).sort(), Object.keys(producer.source_sha256 ?? {}).sort())) issues.push('built source inventory');
  else for (const [name, digest] of Object.entries(producer.source_sha256)) if (sha256(sourceFiles[name]) !== digest) issues.push('built source digest ' + name);
  if (!Object.keys(producer.independent_audit_sha256 ?? {}).length
      || !same(Object.keys(auditReferences).sort(), Object.keys(producer.independent_audit_sha256).sort())) issues.push('independent audit inventory');
  else for (const [name, digest] of Object.entries(producer.independent_audit_sha256)) if (sha256(auditReferences[name]) !== digest) issues.push('independent audit digest ' + name);
  return { status: issues.length ? 'FAIL' : 'PASS', issues,
    scope: 'fixed exact-byte producer/source testimony joins; physical observation remains independently referenced', CI_LIVE_EXECUTION: 'UNPROVEN' };
}

// Unchanged generic stopped-journal join from the previously reviewed R receipt auditor.
function genericProviderPhase({ configBytes, processBytes, stderrBytes, stdoutBytes, journalBytes }, expectedSends) {
  const issues = [], config = decode(configBytes), process = decode(processBytes), events = jsonLines(journalBytes);
  const charged = counts(), pending = new Map(), reservedIds = new Set();
  let ownReserve, ownReconcile, before;
  for (const event of events) {
    if (event.kind === "reserve") {
      if (!providers.includes(event.provider) || event.charge !== 1) throw Error("one_off_charge");
      charged[event.provider]++;
    } else if (event.kind === "phase-reserve") {
      if (!countShape(event.allowances) || providers.some(p => event.allowances[p] > 300)
          || reservedIds.has(event.id) || pending.size || !same(event.prior_charged, charged)
          || providers.some(p => charged[p] + event.allowances[p] > 1000)) throw Error("phase_reservation");
      reservedIds.add(event.id); pending.set(event.id, event.allowances);
      if (event.id === config.phase_id) { ownReserve = event; before = { ...charged }; }
    } else if (event.kind === "phase-reconcile") {
      const limit = pending.get(event.id);
      if (!limit || !countShape(event.sent) || providers.some(p => event.sent[p] > limit[p])) throw Error("phase_reconciliation");
      for (const p of providers) charged[p] += event.sent[p];
      pending.delete(event.id);
      if (event.id === config.phase_id) { if (ownReconcile) throw Error("duplicate_reconciliation"); ownReconcile = event; }
    } else if (event.kind !== "outcome") throw Error("journal_event");
    if (providers.some(p => charged[p] > 1000)) throw Error("whole_run_limit");
  }
  const sent = counts();
  for (const line of Buffer.from(stderrBytes).toString("utf8").split("\n")) {
    const match = /^provider-send:(jev|typellm):([1-9][0-9]*)$/.exec(line);
    if (match) { if (+match[2] !== ++sent[match[1]]) throw Error("provider_send_sequence"); }
    else if (line.startsWith("provider-send:")) throw Error("provider_send_format");
  }
  if (!ownReserve || !ownReconcile || pending.size) issues.push("phase not finally reconciled");
  if (!same(config.allowances, process.allowances) || !same(config.heads, process.heads)
      || config.program !== process.program || config.phase_id !== process.phase_id || process.pgid !== process.pid
      || ownReserve?.config_sha256 !== sha256(configBytes) || process.config_sha256 !== sha256(configBytes)
      || !same(ownReserve?.heads, config.heads) || !same(ownReserve?.allowances, config.allowances)
      || ownReserve?.program !== config.program) issues.push("reservation/config/process binding");
  if (!same(ownReconcile?.sent, sent) || !same(sent, expectedSends) || ownReconcile?.pid !== process.pid
      || ownReconcile?.start_ticks !== process.start_ticks || ownReconcile?.stopped_group_empty !== true
      || ownReconcile?.stderr_sha256 !== sha256(stderrBytes) || ownReconcile?.stdout_sha256 !== sha256(stdoutBytes)
      || providers.some(p => sent[p] > config.allowances[p])) issues.push("send/stop/log binding");
  return { status: issues.length ? "FAIL" : "PASS", issues, phase: config.phase_id, sent, prior_charged: before,
    charged_at_cutoff: charged, journal_sha256: sha256(journalBytes), config_sha256: sha256(configBytes),
    stop_scope: "recorded reconciliation only; independent live PID observation remains an explicit audit reference" };
}


// Source-independent generic Goal proof/event/paint joins retained from R v1 helpers.
function suppliedParts(parts, missing) {
  if (!validMissing(missing)) throw Error('completion row shape');
  const keys = new Set(parts.map(p => p.key)); let next = 0;
  return [...parts, ...missing.map(x => {
    let key; do { key = 'goal-extra-' + ++next; } while (keys.has(key)); keys.add(key);
    return { key, label: x.label, kind: x.kind,
      purpose: `one requested part named ${x.label}, kind ${x.kind}, missing instance ${x.occurrence}` };
  })];
}

function readGoalAnswers(call) {
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
          || a?.route !== c.route || a?.upstream_route !== c.upstream_route || !same(a?.request, c.request)
          || b?.id !== row.id || b?.arm !== row.arm || b?.n !== c.n
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


export function auditRequirementReplayJoin({ replayBytes, rawFiles, artifactManifestBytes, assessGoal, assessEdge }) {
  const receipt = decode(replayBytes), manifest = decode(artifactManifestBytes), issues = [], failures = [];
  const rawNames = Object.keys(rawFiles).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]*-[ABC][.]json$/.test(name)).sort();
  const expectedPairs = rawNames.map(name => pair(decode(rawFiles[name]))).sort();
  if (receipt.schema !== "voice-ui.closed-live-log-browser/1" || receipt.scope !== "KEYLESS_CLOSED_LIVE_EVIDENCE_REPLAY"
      || receipt.ci_live_execution !== "UNPROVEN" || !same(receipt.viewport, [1280, 720]) || receipt.deviceScaleFactor !== 1
      || receipt.artifact_manifest_sha256 !== sha256(artifactManifestBytes) || !same(receipt.artifact_sources, manifest.sources)
      || !Array.isArray(receipt.rows) || !same(receipt.rows.map(pair).sort(), expectedPairs)
      || new Set(receipt.rows.map(pair)).size !== expectedPairs.length || !rawNames.length) throw Error("replay_identity_coverage");
  let frames = 0, assessed = 0;
  for (const row of receipt.rows) {
    const name = row.id + "-" + row.arm + ".json", raw = decode(rawFiles[name]);
    if (row.raw_sha256 !== sha256(rawFiles[name]) || row.log_sha256 !== sha256(raw.final_log)) issues.push("replay/raw byte join");
    const regions = raw.final_records.filter(r => r.type === "region"), edges = raw.final_records.filter(r => r.type === "relation");
    const groups = regions.filter(r => r.kind === "group" && r.parent !== null);
    const cameras = ["overview", ...groups.map(r => r.id), ...edges.map(r => r.id)];
    if (!Array.isArray(row.frames) || !same(row.frames.map(f => f.camera), cameras)) { issues.push("replay required cameras"); continue; }
    frames += row.frames.length;
    for (const frame of row.frames.slice(1)) {
      const group = groups.find(r => r.id === frame.camera), edge = edges.find(r => r.id === frame.camera), observation = frame.observation;
      const expectedShapes = group ? regions.filter(r => r.parent === group.id)
        : [edge?.from, edge?.to].map(id => regions.find(r => r.id === id));
      if (observation?.identity !== true || observation?.association !== "render-owned-semantic-id"
          || group && observation.container?.id !== group.id
          || edge && (observation.edge?.from !== edge.from || observation.edge?.to !== edge.to)
          || !same(observation?.shapes?.map(s => ({ id: s.id, label: s.rawLabel })), expectedShapes.map(s => ({ id:s?.id, label:s?.label }))))
        issues.push("replay semantic ID/label join");
      const result = group ? assessGoal(observation) : assessEdge(observation); assessed++;
      if (!same(result, frame.assessment)) issues.push("replay assessment recomputation");
      if (result.status !== "PASS") failures.push({ id: row.id, arm: row.arm, camera: frame.camera, assessment: result });
    }
  }
  const product = failures.some(row => row.assessment.status === "UNPROVEN") ? "UNPROVEN" : failures.length ? "UNMET" : "PASS";
  if (!same(receipt.failures, failures) || receipt.status !== product) issues.push("replay product status join");
  return { status: issues.length ? "FAIL" : "PASS", issues, consumed: receipt.rows.length, frames, assessed_frames: assessed,
    recorded_paint_status: product, replay_sha256: sha256(replayBytes), model_quality_scope: "NONE", CI_LIVE_EXECUTION: "UNPROVEN" };
}
