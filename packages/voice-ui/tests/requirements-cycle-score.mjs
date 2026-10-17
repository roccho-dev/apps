// Independent v2 meaning and closed-value scoring. Never calls a provider or
// derives an expected answer from production code. Integrity is a separate gate.
import { canonical, gradeGraph } from './semantic-score.mjs';

const kinds = ['step', 'decision', 'data', 'start', 'end', 'group'];
const modes = ['literal-v2', 'adaptive-v2'];
export const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
export const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const text = (s, n) => typeof s === 'string' && s.trim().length > 0 && s.length <= n;
const unit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const pair = x => JSON.stringify([x.label, x.kind]);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(s);
const accepted = x => x.confidence >= 0.5;
export function validRequirements(rows) {
  return Array.isArray(rows) && rows.length <= 3 && rows.every(r => exactKeys(r, ['label', 'kind', 'quantity'])
    && text(r.label, 120) && kinds.includes(r.kind) && Number.isSafeInteger(r.quantity) && r.quantity >= 1 && r.quantity <= 3)
    && new Set(rows.map(pair)).size === rows.length && rows.reduce((n, r) => n + r.quantity, 0) <= 3;
}
export function validStock(parts) {
  return Array.isArray(parts) && parts.length === 8 && parts.every(p => exactKeys(p, ['key', 'purpose', 'label', 'kind'])
    && typeof p.key === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(p.key) && p.key !== 'none'
    && text(p.purpose, 300) && text(p.label, 120) && kinds.includes(p.kind)) && new Set(parts.map(p => p.key)).size === 8;
}
export function stockDifference(required, parts) {
  if (!validRequirements(required) || !validStock(parts)) throw Error('requirements/stock contract');
  return required.flatMap(r => Array.from({ length: Math.max(0, r.quantity - parts.filter(p => pair(p) === pair(r)).length) },
    (_, i) => ({ label: r.label, kind: r.kind, occurrence: i + 1 })));
}
export function sameRequirements(a, b) {
  return validRequirements(a) && validRequirements(b)
    && sameValue(a.map(r => [pair(r), r.quantity]).sort(), b.map(r => [pair(r), r.quantity]).sort());
}
export function validateRequirementInput(input) {
  if (!exactKeys(input, ['schema', 'axis', 'oracle_sha256', 'fixture_contract', 'cases'])
      || input.schema !== 'voice-ui.requirements-cycle-input/1' || !['V', 'F', 'E'].includes(input.axis)
      || !/^[a-f0-9]{64}$/u.test(input.oracle_sha256)) throw Error('requirements input identity');
  const f = input.fixture_contract;
  if (!exactKeys(f, ['map_id', 'base_records', 'base_pins', 'fixtures', 'recent_conversation', 'scope'])
      || !text(f.map_id, 240) || !Array.isArray(f.base_records) || !Array.isArray(f.base_pins)
      || !f.fixtures || typeof f.fixtures !== 'object' || Array.isArray(f.fixtures)
      || !Array.isArray(f.recent_conversation) || f.scope !== null) throw Error('fixture contract');
  if (Object.values(f.fixtures).some(chosen => !exactKeys(chosen, ['extra_records', 'extra_pins'])
      || !Array.isArray(chosen.extra_records) || !Array.isArray(chosen.extra_pins))) throw Error('fixture inventory');
  if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 10
      || new Set(input.cases.map(c => c?.id)).size !== input.cases.length) throw Error('case inventory');
  for (const c of input.cases) {
    if (!exactKeys(c, input.axis === 'V' ? ['id', 'fixture', 'utterance', 'required'] : ['id', 'fixture', 'utterance'])
        || typeof c.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(c.id)
        || !Object.hasOwn(f.fixtures, c.fixture) || !text(c.utterance, 8000)
        || input.axis === 'V' && !validRequirements(c.required)) throw Error('case contract');
    const chosen = f.fixtures[c.fixture];
    if (!exactKeys(chosen, ['extra_records', 'extra_pins']) || !Array.isArray(chosen.extra_records)
        || !Array.isArray(chosen.extra_pins)) throw Error('chosen fixture contract');
  }
  return true;
}
export function requirementsSchedule(input) {
  validateRequirementInput(input);
  return input.cases.flatMap((c, i) => (input.axis === 'E'
    ? i % 2 === 0 ? modes : [...modes].reverse() : [input.axis === 'V' ? 'verify' : 'full-required'])
    .map(method => ({ axis: input.axis, id: c.id, method, arm: method === 'verify' ? 'V'
      : method === 'full-required' ? 'F' : method === 'literal-v2' ? 'B' : 'C' })));
}
export function validFactors(f) {
  const choices = { intent: ['change', 'ambiguous', 'no-change', 'unsupported'], labels: ['available', 'missing'],
    capacity: ['within', 'exceeded'], completeness: ['complete', 'incomplete'] };
  return exactKeys(f, Object.keys(choices)) && Object.entries(choices).every(([k, allowed]) =>
    exactKeys(f[k], ['choice', 'confidence']) && allowed.includes(f[k].choice) && unit(f[k].confidence));
}
export function verifierDecision(factors) {
  if (!validFactors(factors)) return null;
  const { intent, completeness } = factors, confidence = Math.min(intent.confidence, completeness.confidence);
  return { accepted: intent.choice === 'change' && completeness.choice === 'complete' && confidence >= 0.5, confidence };
}
export function decodeRequiredSlots(slots) {
  if (!exactKeys(slots, ['required1', 'required2', 'required3'])) return null;
  const rows = []; let padding = false;
  for (const name of ['required1', 'required2', 'required3']) {
    const r = slots[name];
    if (!exactKeys(r, ['label', 'kind', 'quantity']) || typeof r.label !== 'string' || r.label.length > 120
        || ![...kinds, 'none'].includes(r.kind) || !['0', '1', '2', '3'].includes(r.quantity)) return null;
    if (r.kind === 'none') { padding = true; continue; }
    if (padding || !text(r.label, 120) || r.quantity === '0') return null;
    rows.push({ label: r.label, kind: r.kind, quantity: Number(r.quantity) });
  }
  return validRequirements(rows) ? rows : null;
}
export function validDecision(d) {
  return exactKeys(d, ['choice', 'confidence']) && (d.choice === 'unknown' ? d.confidence === null
    : ['sufficient', 'missing', 'ambiguous', 'no-change', 'unsupported'].includes(d.choice) && unit(d.confidence));
}
export function validLiteral(literal, utterance) {
  if (!exactKeys(literal, ['recognized', 'required', 'spans']) || typeof literal.recognized !== 'boolean'
      || !validRequirements(literal.required) || !Array.isArray(literal.spans) || literal.spans.length > 3) return false;
  const totals = new Map(), intervals = new Set();
  for (const s of literal.spans) {
    if (!exactKeys(s, ['start', 'end', 'source', 'label', 'kind', 'quantity']) || !Number.isSafeInteger(s.start)
        || !Number.isSafeInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > utterance.length
        || utterance.slice(s.start, s.end) !== s.source || s.source !== s.label || !validRequirements([{ label: s.label, kind: s.kind, quantity: s.quantity }])) return false;
    const interval = JSON.stringify([s.start, s.end, s.label]);
    if (intervals.has(interval)) return false;
    intervals.add(interval); totals.set(pair(s), (totals.get(pair(s)) ?? 0) + s.quantity);
  }
  return literal.recognized === (literal.spans.length > 0)
    && sameValue([...totals].sort(), literal.required.map(r => [pair(r), r.quantity]).sort());
}
export function readRequirementInspection(x, utterance, parts) {
  if (!exactKeys(x, ['schema', 'request_id', 'mode', 'initial', 'proposal', 'verification', 'required', 'missing'])
      || x.schema !== 'voice-ui.parts.inspection/2' || !uuid(x.request_id) || !modes.includes(x.mode)
      || !exactKeys(x.initial, ['decision', 'factors', 'literal', 'observation']) || !validDecision(x.initial.decision)
      || !validFactors(x.initial.factors) || !validLiteral(x.initial.literal, utterance)
      || !exactKeys(x.initial.observation, ['valid', 'status']) || typeof x.initial.observation.valid !== 'boolean'
      || !['transcribed', 'unsupported-syntax'].includes(x.initial.observation.status) || !validRequirements(x.required)) return null;
  if (!x.initial.observation.valid && (x.initial.literal.recognized || x.initial.literal.required.length || x.initial.literal.spans.length)) return null;
  const f = x.initial.factors, eligible = f.intent.choice === 'change' && accepted(f.intent)
    && f.completeness.choice === 'incomplete' && accepted(f.completeness);
  if (x.proposal === null) {
    if (x.verification !== null || !sameValue(x.required, x.initial.literal.required)
        || x.mode === 'adaptive-v2' && eligible) return null;
  } else {
    const decoded = decodeRequiredSlots(x.proposal?.slots);
    if (!exactKeys(x.proposal, ['slots', 'required']) || decoded === null || !sameValue(decoded, x.proposal.required)
        || !sameValue(x.required, decoded) || !validFactors(x.verification) || x.mode !== 'adaptive-v2' || !eligible) return null;
  }
  const expectedMissing = stockDifference(x.required, parts);
  if (!sameValue(x.missing, expectedMissing)) return null;
  const verification = x.verification === null ? null : verifierDecision(x.verification);
  const vf = x.verification;
  const vChoice = vf === null ? null : vf.intent.choice !== 'change' ? vf.intent.choice
    : vf.completeness.choice === 'complete' && accepted(vf.completeness) ? expectedMissing.length ? 'missing' : 'sufficient' : 'unknown';
  const normalized = x.proposal === null ? x.initial.decision : { choice: vChoice,
    confidence: vChoice === 'unknown' ? null : vf.intent.choice !== 'change' ? vf.intent.confidence : verification.confidence };
  return { value: x, eligible, verification, normalized,
    full_required: x.required, projected_missing: expectedMissing };
}
function gradeRequired(actual, wanted) {
  if (!validRequirements(wanted)) throw Error('independent required oracle');
  const contract = validRequirements(actual), target = new Map(wanted.map(r => [pair(r), r.quantity]));
  const got = new Map(contract ? actual.map(r => [pair(r), r.quantity]) : []);
  const matched = [...target].reduce((n, [k, count]) => n + Math.min(count, got.get(k) ?? 0), 0);
  const expected = wanted.reduce((n, r) => n + r.quantity, 0), count = contract ? actual.reduce((n, r) => n + r.quantity, 0) : null;
  return { contract_valid: contract, exact: contract && matched === expected && count === expected,
    minimal: contract && matched === expected && count === expected, expected_instances: expected, actual_instances: count,
    matched_instances: matched, omitted_instances: expected - matched, extra_instances: contract ? count - matched : null };
}
export function gradeFullRequired(response, oracle, parts) {
  const decoded = decodeRequiredSlots(response?.slots), supply = gradeRequired(response?.required, oracle.required);
  const contract = exactKeys(response, ['schema', 'request_id', 'slots', 'required'])
    && response.schema === 'voice-ui.parts.requirements/2' && uuid(response.request_id) && decoded !== null
    && sameValue(decoded, response.required);
  return { ...supply, contract_valid: contract && supply.contract_valid, exact: contract && supply.exact,
    minimal: contract && supply.minimal, stock_difference: supply.contract_valid ? stockDifference(response.required, parts) : null,
    true_sufficient: oracle.expected_gate === 'sufficient', scope: 'full NEW requirements, never model-computed missing counts' };
}
export function gradeVerification(response, oracle, proposed) {
  const derived = verifierDecision(response?.factors);
  const contract = exactKeys(response, ['schema', 'request_id', 'required', 'factors', 'accepted', 'confidence'])
    && response.schema === 'voice-ui.parts.verification/2' && uuid(response.request_id) && validRequirements(proposed)
    && sameValue(response.required, proposed) && derived !== null && response.accepted === derived.accepted
    && response.confidence === derived.confidence;
  return { contract_valid: contract, correct: contract && response.accepted === oracle.expected_accept,
    expected_accept: oracle.expected_accept, actual_accept: contract ? response.accepted : null,
    false_acceptance: contract && !oracle.expected_accept && response.accepted,
    intent_raw_correct: validFactors(response?.factors) && response.factors.intent.choice === oracle.expected_intent,
    proposal_exact: oracle.required !== null && sameRequirements(proposed, oracle.required),
    scope: 'operational accept/reject quality; raw factor correctness is separately visible' };
}
export function gradeRequirementGoal(o, oracle, parts) {
  const inspection = readRequirementInspection(o.inspection, oracle.utterance, parts), decisionValid = validDecision(o.decision);
  const graph = gradeGraph(o.initial_records, o.final_records, oracle);
  const control = oracle.expected_intent !== 'change', sufficient = oracle.expected_gate === 'sufficient';
  const unchanged = o.initial_log === o.final_log && o.initial_head === o.final_head && sameValue(o.initial_records, o.final_records);
  const subset = (got, expected) => {
    const remaining = expected.map(x => JSON.stringify(canonical(x)));
    return got.every(x => { const i = remaining.indexOf(JSON.stringify(canonical(x))); if (i < 0) return false; remaining.splice(i, 1); return true; });
  };
  const noFalse = graph.existing_semantics_preserved && graph.no_other_new_semantics && graph.clean_new_regions && graph.clean_new_edges
    && subset(graph.actual_added_regions, oracle.expected_added_regions) && subset(graph.actual_added_edges, oracle.expected_added_edges);
  const fullExact = !control && inspection !== null && sameRequirements(inspection.full_required, oracle.required);
  const differenceExact = inspection !== null && sameValue(inspection.projected_missing, oracle.expected_missing);
  const materializationValid = Number.isSafeInteger(o.preparations) && o.preparations >= 0 && o.preparations <= 1;
  const typeCountValid = Number.isSafeInteger(o.typellm_sends) && o.typellm_sends >= 0 && o.typellm_sends <= 1;
  const f = inspection?.value.initial.factors;
  const completeB = f?.intent.choice === 'change' && accepted(f.intent) && f.completeness.choice === 'complete' && accepted(f.completeness);
  const weakIntent = !f || f.intent.choice !== 'change' || !accepted(f.intent);
  const typePolicy = typeCountValid && (!inspection || inspection.value.mode === 'literal-v2' || completeB || weakIntent ? o.typellm_sends === 0 : true);
  const knownCost = oracle.syntax_stratum === 'B-known' ? o.typellm_sends === 0 : true;
  // A rejected proposal's projected shortage is not a materialized candidate.
  // The raw auditor binds this actual list to the coordinator and offered stock.
  const materialized = o.materialized_missing ?? (o.preparations === 1 ? o.inspection?.missing : []);
  const zeroCandidates = Array.isArray(materialized) && materialized.length === 0 && materializationValid && o.preparations === 0;
  const finalAuthorized = decisionValid && ['sufficient', 'missing'].includes(o.decision.choice) && o.decision.confidence >= 0.5
    && (inspection?.value.proposal === null || inspection?.verification?.accepted === true);
  const stoppedWithoutAdoption = finalAuthorized || unchanged && o.preparations === 0;
  const guarded = materializationValid && typePolicy && knownCost && noFalse
    && stoppedWithoutAdoption
    && (control ? zeroCandidates && o.typellm_sends === 0 && unchanged : sufficient ? zeroCandidates : true);
  return { contract_valid: decisionValid && inspection !== null && sameValue(o.decision, inspection.normalized)
      && materializationValid && typeCountValid,
    expected_gate: oracle.expected_gate, gate_correct: decisionValid && o.decision.choice === oracle.expected_gate
      && o.decision.choice !== 'unknown' && o.decision.confidence >= 0.5,
    full_required_exact: control ? null : fullExact, missing_exact_minimal: differenceExact,
    graph_exact: graph.graph_exact, graph, no_false_adoption: noFalse, raw_unchanged: unchanged,
    non_regression_guards: guarded, type_policy_guard: typePolicy, known_syntax_type_free: knownCost,
    stop_authorization_guard: stoppedWithoutAdoption,
    true_sufficient_zero_candidates: sufficient ? zeroCandidates : null,
    interpretation_type_calls: sufficient ? o.typellm_sends : 0,
    eligible: inspection?.eligible ?? false, proposal_present: o.inspection?.proposal !== null && o.inspection?.proposal !== undefined,
    verification_accepted: inspection?.verification?.accepted ?? false,
    initial_literal: o.inspection?.initial?.literal ?? null,
    deadline: Number.isFinite(o.elapsedMs) && o.elapsedMs >= 0 && o.elapsedMs <= 180000,
    scope: 'semantic observations only; exact source/proof/provider/raw/browser integrity is mandatory separately' };
}
const fullCellSuccess = r => r?.valid_execution === true && r.grade?.contract_valid === true && r.grade.gate_correct
  && r.grade.graph_exact && r.grade.non_regression_guards && r.grade.deadline && r.paint_status === 'PASS'
  && r.persisted_raw_equal === true && (r.grade.expected_gate === 'ambiguous' || r.grade.expected_gate === 'no-change'
    || r.grade.full_required_exact && r.grade.missing_exact_minimal);
export function summarizeRequirementAxis(axis, rows, oracles, { phaseKind = 'fresh' } = {}) {
  const ids = oracles.map(o => o.id), methods = axis === 'V' ? ['verify'] : axis === 'F' ? ['full-required'] : modes;
  const complete = rows.length === ids.length * methods.length && new Set(rows.map(r => JSON.stringify([r.id, r.method]))).size === rows.length
    && ids.every(id => methods.every(method => rows.some(r => r.id === id && r.method === method)))
    && rows.every(r => ids.includes(r.id) && methods.includes(r.method));
  const allValid = complete && rows.every(r => r.valid_execution === true && r.grade?.contract_valid === true);
  if (axis === 'V') return { complete, total: ids.length, correct: rows.filter(r => r.grade?.correct).length,
    false_acceptance: rows.filter(r => r.grade?.false_acceptance).length,
    verification_criteria: allValid && ids.length === (phaseKind === 'fresh' ? 10 : 6) && rows.every(r => r.grade.correct) ? 'PASS' : 'UNMET' };
  if (axis === 'F') return { complete, total: ids.length, exact_minimal: rows.filter(r => r.grade?.exact && r.grade.minimal).length,
    true_sufficient: { total: oracles.filter(o => o.expected_gate === 'sufficient').length,
      zero_missing: rows.filter(r => r.grade?.true_sufficient && r.grade.stock_difference?.length === 0).length },
    requirements_criteria: allValid && ids.length === (phaseKind === 'fresh' ? 8 : 6)
      && (phaseKind === 'fresh' ? rows.every(r => r.grade.exact && r.grade.minimal) : rows.filter(r => r.grade.exact && r.grade.minimal).length >= 4) ? 'PASS' : 'UNMET' };
  if (axis !== 'E') throw Error('summary axis');
  const pairs = ids.map(id => {
    const base = rows.find(r => r.id === id && r.method === 'literal-v2'), enabled = rows.find(r => r.id === id && r.method === 'adaptive-v2');
    const oracle = oracles.find(o => o.id === id), eligible = base?.valid_execution === true && enabled?.valid_execution === true
      && base.grade?.eligible === true && enabled.grade?.eligible === true
      && sameValue(base.grade.initial_literal, enabled.grade.initial_literal);
    const a = fullCellSuccess(base), b = fullCellSuccess(enabled);
    return { id, eligible, baseline_success: a, enabled_success: b,
      missing_gain: oracle.expected_gate === 'missing' && eligible && !a && base.grade.raw_unchanged
        && b && enabled.grade.proposal_present && enabled.grade.verification_accepted,
      regression: a && !b, excluded_from_causal_only: !eligible };
  });
  const enabled = rows.filter(r => r.method === 'adaptive-v2'), baseline = rows.filter(r => r.method === 'literal-v2');
  const counts = own => Object.fromEntries(['sufficient', 'missing', 'ambiguous', 'no-change'].map(s =>
    [s, { correct: own.filter(r => r.grade?.expected_gate === s && fullCellSuccess(r)).length,
      total: oracles.filter(o => o.expected_gate === s).length }]));
  const shape = phaseKind === 'fresh' ? ids.length === 10 && oracles.filter(o => o.expected_gate === 'sufficient').length === 4
    && oracles.filter(o => o.expected_gate === 'missing').length === 4 && oracles.filter(o => o.expected_intent !== 'change').length === 2 : ids.length === 2;
  const gains = pairs.filter(p => p.missing_gain).length, regressions = pairs.filter(p => p.regression).length;
  const noFalse = rows.every(r => r.grade?.no_false_adoption === true), guards = rows.every(r => r.grade?.non_regression_guards === true);
  return { complete, total_pairs: ids.length, baseline: counts(baseline), enabled: counts(enabled), pairs,
    eligible_pairs: pairs.filter(p => p.eligible).length, missing_gains: gains, regressions, no_false_adoption: noFalse,
    all_arm_guards: guards, interpretation_type_calls: enabled.reduce((n, r) => n + (r.grade?.interpretation_type_calls ?? 0), 0),
    enabled_criteria: allValid && shape && enabled.every(fullCellSuccess) && guards ? 'PASS' : 'UNMET',
    effect_criteria: allValid && shape && gains >= 2 && regressions === 0 && noFalse && guards ? 'PASS' : 'UNMET',
    scope: 'all fixed E cases stay in each performance denominator; only measured G0 eligibility controls causal comparison' };
}
