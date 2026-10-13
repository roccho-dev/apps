// Application interpretation of explicit domain declarations. No semantic oracle,
// effect, ledger, renderer or admission authority is introduced here.
export const SEMANTIC_SCOPE_SCHEMA = 'atlas.semantic-scopes/1';
const fail = message => { throw new Error('atlas-semantic-scopes: ' + message); };
const demand = (condition, message) => { if (!condition) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const strings = (values, empty = false) => Array.isArray(values) && (empty || values.length > 0)
  && values.every(text) && new Set(values).size === values.length;
const ref = value => object(value) && ['space', 'revision', 'id'].every(key => text(value[key]));
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const copy = value => structuredClone(value);

const evidenceState = (values, required, observed, target, writer) => {
  if (!Array.isArray(values) || values.length === 0) return 'unknown';
  const covered = new Set();
  let unknown = false, conflict = false;
  for (const value of values) {
    if (!object(value) || !strings(value.requirements) || !ref(value.ref)
      || !equal(value.observed_ref, observed) || !equal(value.target_ref, target)
      || !text(value.evaluator) || value.evaluator === writer || value.fresh !== true) unknown = true;
    else if (value.state === 'conflict') conflict = true;
    else if (value.state !== 'known') unknown = true;
    else value.requirements.forEach(id => covered.add(id));
  }
  return conflict ? 'conflict' : unknown || [...required].some(id => !covered.has(id)) ? 'unknown' : 'known';
};

const closure = (scopes, pair, observation) => {
  const missing = reason => ({ scope_status: 'unknown', purpose_status: 'unknown', status: 'unknown',
    residual: [], unknown: [], conflicts: [], reason });
  if (!object(observation) || !ref(observation.observed_ref)
    || observation.purpose_id !== pair.purpose_id || !equal(observation.target_ref, pair.target_ref))
    return missing('post-observation missing or for another selected target');
  if (!text(observation.evaluator) || !text(observation.writer) || observation.evaluator === observation.writer)
    return missing('independent post evaluator required');
  demand(Array.isArray(observation.criteria), 'post scope criteria must be an array');
  const expected = new Map();
  for (const scope of scopes) for (const values of Object.values(scope.criteria)) for (const criterion of values) {
    if (!expected.has(criterion)) expected.set(criterion, new Set());
    scope.required_evidence.forEach(id => expected.get(criterion).add(id));
  }
  const ids = observation.criteria.map(value => value?.id);
  demand(strings(ids, true), 'duplicate or invalid observed criterion');
  if (ids.length !== expected.size || ids.some(id => !expected.has(id))) return missing('scope criterion coverage missing or extraneous');
  const residual = [], unknown = [], conflicts = [];
  for (const criterion of observation.criteria) {
    demand(['satisfied', 'unmet', 'unknown', 'conflict'].includes(criterion.state), 'unknown scope criterion state');
    const support = evidenceState(criterion.evidence, expected.get(criterion.id), observation.observed_ref, pair.target_ref, observation.writer);
    if (support === 'conflict' || criterion.state === 'conflict') conflicts.push(criterion.id);
    else if (support === 'unknown' || criterion.fresh !== true || criterion.state === 'unknown') unknown.push(criterion.id);
    else if (criterion.state === 'unmet') residual.push(criterion.id);
  }
  const scope_status = conflicts.length ? 'conflict' : unknown.length ? 'unknown' : residual.length ? 'unmet'
    : expected.size ? 'declared_satisfied' : 'not_applicable';
  let purpose_status = 'unknown';
  const whole = observation.purpose_evaluation;
  if (object(whole) && whole.coverage === 'whole-selected-target' && whole.fresh === true
    && equal(whole.observed_ref, observation.observed_ref) && equal(whole.target_ref, pair.target_ref)
    && text(whole.evaluator) && whole.evaluator !== observation.writer) {
    demand(['satisfied', 'unmet', 'unknown', 'conflict'].includes(whole.state), 'unknown whole-target state');
    const support = evidenceState(whole.evidence, new Set(['whole-target-independent-evaluation']), observation.observed_ref, pair.target_ref, observation.writer);
    if (support === 'conflict' || whole.state === 'conflict') purpose_status = 'conflict';
    else if (support === 'known' && whole.state === 'satisfied') {
      if (Array.isArray(whole.residual) && whole.residual.length === 0) purpose_status = 'declared_satisfied';
      else if (strings(whole.residual)) { purpose_status = 'conflict'; residual.push(...whole.residual); }
    } else if (support === 'known' && whole.state === 'unmet' && strings(whole.residual)) {
      purpose_status = 'unmet'; residual.push(...whole.residual);
    }
  }
  if (purpose_status === 'declared_satisfied' && ['unmet', 'conflict'].includes(scope_status)) purpose_status = 'conflict';
  else if (purpose_status === 'declared_satisfied' && scope_status === 'unknown') purpose_status = 'unknown';
  return { scope_status, purpose_status, status: scope_status === 'conflict' ? 'conflict' : purpose_status,
    residual: [...new Set(residual)].sort(), unknown: unknown.sort(), conflicts: conflicts.sort(),
    work_done: observation.work_done === true, observation: copy(observation) };
};

/**
 * The owning domain supplies the meaning comparison and justified partition.
 * This validates the application port and preserves responsibility/evidence;
 * field equality, words, dates or work completion never compute semantic truth.
 */
export const normalizeSemanticScopes = input => {
  demand(object(input) && input.schema === SEMANTIC_SCOPE_SCHEMA && input.authority === false, 'unsupported schema/authority');
  const comparison = input.comparison;
  demand(object(comparison) && text(comparison.purpose_id) && comparison.direction === 'current-to-target', 'explicit Purpose/direction required');
  demand(Array.isArray(input.history), 'prior obligations/history must be supplied explicitly');
  demand(input.history.every(value => object(value) && text(value.id))
    && new Set(input.history.map(value => value.id)).size === input.history.length, 'historical obligation identity required');
  const pair = Object.fromEntries(['purpose_id', 'current_ref', 'target_ref'].map(key => [key, copy(comparison[key] ?? null)]));
  const base = { schema: SEMANTIC_SCOPE_SCHEMA, authority: false, semantic_truth: 'domain-declared-not-verified',
    pair, comparison: copy(comparison), observation: copy(input.observation ?? null), history: copy(input.history), bindings: copy(input.bindings ?? null) };
  const held = (status, reason, uncovered = []) => ({ ...base, status, scopes: null, uncovered,
    closure: { status: 'unknown', scope_status: 'unknown', purpose_status: 'unknown', residual: [], reason }, reason });
  if (![pair.current_ref, pair.target_ref].every(ref)) return held('unknown', 'exact current/target references missing');
  const basis = comparison.basis;
  if (!object(basis) || !strings(basis.evidence) || !equal(basis.current_ref, pair.current_ref) || !equal(basis.target_ref, pair.target_ref))
    return held('unknown', 'comparison basis missing or for another revision');
  demand(['known', 'unknown', 'conflict'].includes(comparison.availability), 'comparison availability required');
  if (comparison.availability !== 'known') return held(comparison.availability, 'comparison ' + comparison.availability);
  demand(Array.isArray(comparison.parts), 'declared semantic part universe required');
  const parts = new Map();
  for (const part of comparison.parts) {
    demand(object(part) && text(part.id) && !parts.has(part.id) && strings(part.basis), 'unique part/meaning basis required');
    demand(['equivalent', 'change', 'unknown', 'conflict'].includes(part.verdict), 'unknown semantic part verdict');
    parts.set(part.id, part);
  }
  if ([...parts.values()].some(part => part.verdict === 'conflict')) return held('conflict', 'semantic part conflict');
  const coverage = comparison.semantic_coverage;
  if ([...parts.values()].some(part => part.verdict === 'unknown') || !object(coverage)
    || coverage.assessment !== 'declared-complete' || !strings(coverage.basis)) return held('unknown', 'semantic comparison coverage unknown');
  const changed = new Set([...parts.values()].filter(part => part.verdict === 'change').map(part => part.id));
  if ((input.partition === null || input.partition === undefined) && changed.size) return held('undecomposed', 'responsibility partition not supplied', [...changed].sort());
  const partition = input.partition ?? [];
  demand(Array.isArray(partition), 'partition must be an array/null');
  const assigned = new Set(), ids = new Set(), scopes = [];
  for (const scope of partition) {
    demand(object(scope) && text(scope.id) && !ids.has(scope.id), 'unique Scope identity required');
    ids.add(scope.id);
    demand(strings(scope.parts) && scope.parts.every(id => changed.has(id) && !assigned.has(id)), 'ambiguous or invented Scope responsibility');
    demand(['owner_role', 'owner_actor', 'residual_policy', 'rationale'].every(key => text(scope[key])), 'Scope responsibility/closure declaration missing');
    demand(strings(scope.required_evidence), 'explicit required evidence set required');
    demand(object(scope.criteria) && equal(Object.keys(scope.criteria).sort(), [...scope.parts].sort())
      && Object.values(scope.criteria).every(value => strings(value)), 'criteria must cover each responsible part');
    scope.parts.forEach(id => assigned.add(id));
    scopes.push({ ...copy(scope), pair: copy(pair), transformations: scope.parts.map(id => copy(parts.get(id))) });
  }
  const uncovered = [...changed].filter(id => !assigned.has(id)).sort();
  const status = uncovered.length ? 'incomplete' : changed.size ? 'declared_partition' : 'declared_equivalent';
  return { ...base, status, scopes, uncovered, semantic_coverage: copy(coverage),
    closure: uncovered.length ? { status: 'unknown', scope_status: 'unknown', purpose_status: 'unknown', residual: uncovered, reason: 'uncovered responsibility' }
      : closure(scopes, pair, input.observation) };
};
