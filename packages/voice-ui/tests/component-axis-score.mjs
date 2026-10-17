// Independent semantic/input scoring only. Runtime/protocol/journal/paint
// admissibility is separate and cannot be promoted by this module.
import { canonical, gradeGraph } from './semantic-score.mjs';

const kinds = new Set(['step', 'decision', 'data', 'start', 'end', 'group']);
const axes = new Set(['G', 'R', 'F', 'E']);
const exact = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const text = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const key = s => typeof s === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(s) && s !== 'none';
const pair = r => JSON.stringify([r.label, r.kind]);
const unit = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const factor = (x, choices) => exact(x, ['choice', 'confidence']) && choices.includes(x.choice) && unit(x.confidence);
const accepted = x => x.confidence >= 0.5;

export function validateAxisInput(value) {
  if (!exact(value, ['schema', 'axis', 'oracle_sha256', 'fixture_contract', 'cases'])
      || value.schema !== 'voice-ui.component-axes-input/1' || !axes.has(value.axis)
      || !/^[a-f0-9]{64}$/u.test(value.oracle_sha256)) throw Error('input identity');
  const f = value.fixture_contract;
  if (!exact(f, ['map_id', 'base_records', 'base_pins', 'fixtures', 'recent_conversation', 'scope'])
      || !text(f.map_id, 240) || !Array.isArray(f.base_records) || !Array.isArray(f.base_pins)
      || !f.fixtures || typeof f.fixtures !== 'object' || Array.isArray(f.fixtures)
      || !Array.isArray(f.recent_conversation) || f.scope !== null) throw Error('fixture contract');
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 10
      || new Set(value.cases.map(c => c?.id)).size !== value.cases.length) throw Error('case list');
  for (const c of value.cases) {
    if (!exact(c, value.axis === 'R' ? ['id', 'fixture', 'utterance', 'parts'] : ['id', 'fixture', 'utterance'])
        || !text(c.id, 64) || !Object.hasOwn(f.fixtures, c.fixture) || !text(c.utterance, 8000)) throw Error('case shape');
    const chosen = f.fixtures[c.fixture];
    if (!exact(chosen, ['extra_records', 'extra_pins']) || !Array.isArray(chosen.extra_records)
        || !Array.isArray(chosen.extra_pins)) throw Error('fixture choice');
    if (value.axis === 'R' && (!validParts(c.parts) || c.parts.length !== 8)) throw Error('R parts');
  }
  return true;
}

export function validParts(parts) {
  return Array.isArray(parts) && parts.length >= 1 && parts.length <= 8
    && parts.every(p => exact(p, ['key', 'purpose', 'label', 'kind'])
      && key(p.key) && text(p.purpose, 300) && text(p.label, 120) && kinds.has(p.kind))
    && new Set(parts.map(p => p.key)).size === parts.length;
}

export function axisSchedule(input) {
  validateAxisInput(input);
  return input.cases.flatMap((c, i) => (input.axis === 'F'
    ? i % 2 === 0 ? ['literal', 'typed'] : ['typed', 'literal']
    : [input.axis === 'R' ? 'ready' : 'literal'])
    .map(method => ({ axis: input.axis, id: c.id, method,
      compatibility_arm: method === 'ready' ? 'A' : method === 'typed' ? 'C' : 'B' })));
}

export function validRequired(rows) {
  return Array.isArray(rows) && rows.length <= 3
    && rows.every(r => exact(r, ['label', 'kind', 'quantity']) && text(r.label, 120) && kinds.has(r.kind)
      && Number.isSafeInteger(r.quantity) && r.quantity >= 1 && r.quantity <= 3)
    && new Set(rows.map(pair)).size === rows.length && rows.reduce((s, r) => s + r.quantity, 0) <= 3;
}

const requiredMap = rows => new Map(rows.map(r => [pair(r), r.quantity]));
const sameRequired = (a, b) => validRequired(a) && validRequired(b)
  && same([...requiredMap(a)].sort(), [...requiredMap(b)].sort());

export function missingFromRequired(required, parts) {
  if (!validRequired(required) || !validParts(parts)) throw Error('inventory projection');
  return required.flatMap(r => Array.from({ length: Math.max(0,
    r.quantity - parts.filter(p => pair(p) === pair(r)).length) }, (_, i) =>
    ({ label: r.label, kind: r.kind, occurrence: i + 1 })));
}

export function gradeSupply(actual, expected) {
  const validate = rows => Array.isArray(rows) && rows.length <= 3
    && rows.every(r => exact(r, ['label', 'kind', 'occurrence']) && text(r.label, 120) && kinds.has(r.kind)
      && Number.isSafeInteger(r.occurrence) && r.occurrence >= 1 && r.occurrence <= 3)
    && new Set(rows.map(r => JSON.stringify([pair(r), r.occurrence]))).size === rows.length
    && [...new Set(rows.map(pair))].every(k => same(rows.filter(r => pair(r) === k).map(r => r.occurrence).sort(),
      Array.from({ length: rows.filter(r => pair(r) === k).length }, (_, i) => i + 1)));
  if (!validate(expected)) throw Error('invalid independent missing oracle');
  const contract = validate(actual);
  const counts = rows => { const m = new Map(); for (const r of rows) m.set(pair(r), (m.get(pair(r)) ?? 0) + 1); return m; };
  const wanted = counts(expected), got = contract ? counts(actual) : new Map();
  const matched = [...wanted].reduce((s, [k, n]) => s + Math.min(n, got.get(k) ?? 0), 0);
  const actualCount = contract ? actual.length : 0;
  return { contract_valid: contract, exact: contract && actualCount === expected.length && matched === expected.length,
    minimal: contract && actualCount === expected.length && matched === expected.length,
    expected_instances: expected.length, actual_instances: contract ? actualCount : null,
    matched_instances: matched, omitted_instances: expected.length - matched,
    extra_instances: contract ? actualCount - matched : null,
    precision: contract ? actualCount ? matched / actualCount : expected.length ? 0 : 1 : null,
    recall: expected.length ? matched / expected.length : contract ? 1 : 0 };
}

// decision and the two factors are projections of the actual closed check
// response/stdout. The raw-receipt adapter must independently bind that projection.
export function gradeGateAxes({ decision, inspection, intent, completeness }, oracle, parts) {
  const clear = oracle.expected_intent === 'change';
  const intentValid = factor(intent, ['change', 'ambiguous', 'no-change', 'unsupported']);
  const completeValid = factor(completeness, ['complete', 'incomplete']);
  const known = ['sufficient', 'missing', 'ambiguous', 'no-change', 'unsupported'];
  const decisionValid = exact(decision, ['choice', 'confidence'])
    && (decision.choice === 'unknown' ? decision.confidence === null
      : known.includes(decision.choice) && unit(decision.confidence));
  const actualRequiredValid = validRequired(inspection?.required);
  const extractionExact = clear && actualRequiredValid && sameRequired(inspection.required, oracle.required);
  const expectedComplete = clear ? extractionExact ? 'complete' : 'incomplete' : null;
  const projectedMissing = actualRequiredValid ? missingFromRequired(inspection.required, parts) : null;
  const missingReceipt = projectedMissing === null ? null : gradeSupply(inspection?.missing, projectedMissing);
  const computedAvailability = projectedMissing === null ? null : projectedMissing.length ? 'missing' : 'sufficient';
  const ready = inspection?.recognized === true || clear && oracle.required?.length === 0;
  return {
    scope: 'semantic axes only; actual source/protocol/HTTP/journal/paint admissibility required separately',
    contract_valid: decisionValid && intentValid && completeValid && actualRequiredValid && typeof inspection?.recognized === 'boolean',
    intent_raw_correct: intentValid && intent.choice === oracle.expected_intent,
    intent_accepted_correct: intentValid && intent.choice === oracle.expected_intent && accepted(intent),
    extraction_exact: clear ? extractionExact : null,
    completeness_expected: expectedComplete,
    completeness_raw_correct: clear ? completeValid && completeness.choice === expectedComplete : null,
    completeness_accepted_correct: clear ? completeValid && completeness.choice === expectedComplete && accepted(completeness) : null,
    difference_mechanism_correct: missingReceipt?.exact ?? false,
    availability_raw_correct: clear ? computedAvailability === oracle.expected_gate : null,
    availability_accepted_correct: clear ? extractionExact && ready && completeValid
      && completeness.choice === 'complete' && accepted(completeness)
      && missingReceipt?.exact === true && computedAvailability === oracle.expected_gate : null,
    normalized_raw_correct: decisionValid && decision.choice === oracle.expected_gate,
    normalized_accepted_correct: decisionValid && decision.choice === oracle.expected_gate
      && decision.choice !== 'unknown' && accepted(decision),
    unknown: decisionValid && decision.choice === 'unknown',
  };
}

export function gradeReady(initial, final, oracle, parts) {
  if (!validRequired(oracle.required)) throw Error('R oracle requirements');
  const inventorySufficient = validParts(parts) && missingFromRequired(oracle.required, parts).length === 0;
  return { oracle_inventory_sufficient: inventorySufficient,
    graph: gradeGraph(initial, final, oracle),
    scope: 'representation conditional on supplied inventory; paint and actual Goal-path admissibility separate' };
}

export function summarizeGate(rows) {
  const clear = rows.filter(r => r.expected_intent === 'change');
  const sum = (rs, prop) => rs.filter(r => r.grade[prop] === true).length;
  const shape = rows.length === 10 && new Set(rows.map(r => r.id)).size === 10 && clear.length === 8
    && rows.filter(r => r.expected_gate === 'sufficient').length === 4
    && rows.filter(r => r.expected_gate === 'missing').length === 4;
  return { total: rows.length, intent: { correct: sum(rows, 'intent_accepted_correct'), total: rows.length },
    availability: { correct: sum(clear, 'availability_accepted_correct'), total: clear.length },
    normalized: { correct: sum(rows, 'normalized_accepted_correct'), total: rows.length },
    completeness: { correct: sum(clear, 'completeness_accepted_correct'), total: clear.length },
    unknown: rows.filter(r => r.grade.unknown).length,
    semantic_criteria: shape && rows.every(r => r.grade.contract_valid)
      && sum(rows, 'intent_accepted_correct') === 10 && sum(clear, 'availability_accepted_correct') === 8
      && sum(rows, 'normalized_accepted_correct') === 10 ? 'PASS' : 'UNMET' };
}

export function gradeOrdinary(observation, oracle) {
  const { decision, initial_records, final_records, initial_log, final_log, initial_head, final_head,
    missing, preparations, typellm_sends, elapsedMs } = observation;
  const known = ['sufficient', 'missing', 'ambiguous', 'no-change', 'unsupported'];
  const validDecision = exact(decision, ['choice', 'confidence'])
    && (decision.choice === 'unknown' ? decision.confidence === null
      : known.includes(decision.choice) && unit(decision.confidence));
  const control = ['ambiguous', 'no-change', 'unsupported'].includes(oracle.expected_gate);
  const graph = gradeGraph(initial_records, final_records, oracle);
  const rawUnchanged = typeof initial_log === 'string' && initial_log === final_log
    && initial_head === final_head && same(initial_records, final_records);
  const supply = gradeSupply(missing, oracle.expected_missing);
  const preparationValid = Number.isSafeInteger(preparations) && preparations >= 0 && preparations <= 1;
  const typeFree = typellm_sends === 0;
  const subset = (got, wanted) => {
    const remaining = wanted.map(x => JSON.stringify(canonical(x)));
    return got.every(x => { const at = remaining.indexOf(JSON.stringify(canonical(x)));
      if (at < 0) return false; remaining.splice(at, 1); return true; });
  };
  const noFalseAdoption = graph.existing_semantics_preserved && graph.no_other_new_semantics
    && graph.clean_new_regions && graph.clean_new_edges
    && subset(graph.actual_added_regions, oracle.expected_added_regions)
    && subset(graph.actual_added_edges, oracle.expected_added_edges);
  const generationFree = preparationValid && preparations === 0 && Array.isArray(missing)
    && missing.length === 0 && typeFree;
  return { expected_gate: oracle.expected_gate, decision_contract_valid: validDecision,
    gate_correct: validDecision && decision.choice === oracle.expected_gate && decision.choice !== 'unknown' && accepted(decision),
    graph_exact: graph.graph_exact, graph, missing_exact_minimal: supply.exact && supply.minimal, supply,
    control_correct: control ? validDecision && decision.choice === oracle.expected_gate && accepted(decision) && rawUnchanged : null,
    raw_unchanged: rawUnchanged, generation_free: generationFree, type_free: typeFree, no_false_adoption: noFalseAdoption,
    ordinary_non_regression: preparationValid && typeFree
      && (control || oracle.expected_gate === 'sufficient' ? generationFree && noFalseAdoption && (!control || rawUnchanged) : true),
    deadline: typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 180000,
    scope: 'ordinary literal semantic observation only; source/proof/HTTP/provider/paint/persistence binding remains mandatory' };
}

const completeRows = (rows, ids, methods) => Array.isArray(ids) && new Set(ids).size === ids.length
  && rows.length === ids.length * methods.length
  && new Set(rows.map(r => JSON.stringify([r.id, r.method]))).size === rows.length
  && ids.every(id => methods.every(method => rows.some(r => r.id === id && r.method === method)))
  && rows.every(r => ids.includes(r.id) && methods.includes(r.method));

export function summarizeSupply(rows, ids) {
  const complete = completeRows(rows, ids, ['literal', 'typed']);
  return { complete, per_method: Object.fromEntries(['literal', 'typed'].map(method => {
    const own = rows.filter(r => r.method === method);
    return [method, { total: own.length, exact_minimal: own.filter(r => r.grade.exact && r.grade.minimal).length,
      contract_valid: own.every(r => r.grade.contract_valid),
      semantic_criteria: complete && ids.length === 8 && own.every(r => r.grade.exact && r.grade.minimal) ? 'PASS' : 'UNMET' }];
  })) };
}

export function summarizeReady(rows, ids) {
  const complete = completeRows(rows, ids, ['ready']);
  return { complete, total: rows.length, inventory_sufficient: rows.filter(r => r.grade.oracle_inventory_sufficient).length,
    graph_exact: rows.filter(r => r.grade.graph.graph_exact).length,
    paint_pass: rows.filter(r => r.paint_status === 'PASS').length,
    representation_criteria: complete && ids.length === 8 && rows.every(r => r.grade.oracle_inventory_sufficient
      && r.grade.graph.graph_exact && r.paint_status === 'PASS') ? 'PASS' : 'UNMET',
    scope: 'finite representation with oracle inventory; raw paint/Goal binding is separately required' };
}

export function summarizeOrdinary(rows, oracles) {
  const ids = oracles.map(o => o.id), complete = completeRows(rows, ids, ['literal']);
  const sufficient = rows.filter(r => r.grade.expected_gate === 'sufficient');
  const missing = rows.filter(r => r.grade.expected_gate === 'missing');
  const controls = rows.filter(r => ['ambiguous', 'no-change', 'unsupported'].includes(r.grade.expected_gate));
  const shape = ids.length === 10 && sufficient.length === 4 && missing.length === 4 && controls.length === 2;
  return { complete, gate_correct: rows.filter(r => r.grade.gate_correct).length,
    sufficient: { exact: sufficient.filter(r => r.grade.graph_exact).length, total: sufficient.length },
    missing: { exact_minimal: missing.filter(r => r.grade.graph_exact && r.grade.missing_exact_minimal).length, total: missing.length },
    controls: { correct_unchanged: controls.filter(r => r.grade.control_correct).length, total: controls.length },
    ordinary_criteria: complete && shape && rows.every(r => r.grade.gate_correct && r.grade.ordinary_non_regression
      && r.grade.deadline && r.grade.graph_exact && r.paint_status === 'PASS' && r.persisted_raw_equal === true)
      && missing.every(r => r.grade.missing_exact_minimal) && controls.every(r => r.grade.control_correct) ? 'PASS' : 'UNMET',
    Undo_scope: 'separate completed-artifact keyless mechanics, not another live Goal on these inputs' };
}
