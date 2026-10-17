// Independent new-cycle schedule/aggregate. Frozen v2 per-cell meanings stay unchanged.
import { createHash } from 'node:crypto';
import { exactKeys, sameValue, validateRequirementInput as validateV2Input, summarizeRequirementAxis } from './requirements-cycle-score.mjs';
export { exactKeys, sameValue, validRequirements, validStock, stockDifference, sameRequirements, validFactors, verifierDecision,
  decodeRequiredSlots, validDecision, validLiteral, readRequirementInspection, gradeFullRequired, gradeVerification,
  gradeRequirementGoal } from './requirements-cycle-score.mjs';
export const DEPENDENCY_METHODS = Object.freeze({ I: 'full-required', D: 'full-required', V: 'verify', B: 'literal-v2', C: 'adaptive-v2' });
export const DEPENDENCY_POLICIES = Object.freeze({ I: 'independent', D: 'dependent', V: null, B: null, C: 'dependent' });
export const DEPENDENCY_PUBLIC_PARENTS = Object.freeze({
  F: Object.freeze({ input: 'fecbe1eb3945cdb9e450742e26ba5fbb56bc1f3d852b1deebf292d09d922b6ec', oracle: 'd01e7cdd4ef0fabd0b0befeab1e39026a235c88f02046e8eee58d56840aaa36e' }),
  V: Object.freeze({ input: '633a1b3cc8c47a6fcb4d548d127bdb05b2696bc99ffbfae0467211236e36ce97', oracle: '884dde0deb27b76d7f269eee989ffeedc1759493402b77a4cf4d9efb0d4344e5' }),
  E: Object.freeze({ input: 'dddd6843284c39e7aa1862cd2b9debd0548a6b503d892c18d68863205387380c', oracle: '723bc974b22fc45da2f19b6c8580f7280e7497d474d5a9f33d35d3f1ce385dea' }),
});
const hash = b => createHash('sha256').update(b).digest('hex');
const parse = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
export function validateDependencyInput(input, { phaseKind = null, parentProjectionBytes = null } = {}) {
  if (!exactKeys(input, ['schema', 'axis', 'oracle_sha256', 'parent_inputs_sha256', 'fixture_contract', 'cases'])
      || input.schema !== 'voice-ui.dependency-cycle-input/1' || !['V', 'F', 'E'].includes(input.axis)) throw Error('dependency input identity');
  const kind = phaseKind ?? (input.parent_inputs_sha256 === null ? 'fresh' : 'public');
  if (!['public', 'fresh'].includes(kind)) throw Error('dependency phase kind; corrections not registered');
  const count = (kind === 'public' ? { V: 6, F: 6, E: 2 } : { V: 10, F: 8, E: 10 })[input.axis];
  if (!Array.isArray(input.cases) || input.cases.length !== count) throw Error('dependency preregistered denominator');
  if (kind === 'public' ? input.parent_inputs_sha256 !== DEPENDENCY_PUBLIC_PARENTS[input.axis].input
    : input.parent_inputs_sha256 !== null) throw Error('dependency immutable parent');
  const old = { schema: 'voice-ui.requirements-cycle-input/1', axis: input.axis, oracle_sha256: input.oracle_sha256,
    fixture_contract: input.fixture_contract, cases: input.cases.map((c, index) => {
      if (!exactKeys(c, ['id', 'fixture', 'utterance', ...(input.axis === 'V' ? ['required'] : []), 'arms'])) throw Error('dependency case fields');
      const wanted = input.axis === 'V' ? ['V'] : input.axis === 'E' ? index % 2 === 0 ? ['B', 'C'] : ['C', 'B']
        : kind === 'public' ? index % 2 === 0 ? ['I', 'D'] : ['D', 'I'] : ['D'];
      if (!sameValue(c.arms, wanted)) throw Error('dependency explicit arm order');
      const { arms, ...legacy } = c; return legacy;
    }) };
  validateV2Input(old);
  if (parentProjectionBytes !== null) {
    if (kind !== 'public' || hash(parentProjectionBytes) !== input.parent_inputs_sha256) throw Error('dependency parent bytes');
    const parent = parse(parentProjectionBytes); validateV2Input(parent);
    if (parent.axis !== input.axis || !sameValue(old.fixture_contract, parent.fixture_contract) || !sameValue(old.cases, parent.cases)) throw Error('dependency changed public semantics');
  }
  return true;
}
export function dependencySchedule(input, options) {
  validateDependencyInput(input, options);
  return input.cases.flatMap(c => c.arms.map(arm => ({ axis: input.axis, id: c.id, arm,
    method: DEPENDENCY_METHODS[arm], generation_policy: DEPENDENCY_POLICIES[arm] })));
}
const valid = r => r?.valid_execution === true && r.grade?.contract_valid === true;
const exact = r => valid(r) && r.grade.exact === true && r.grade.minimal === true;
export function summarizeDependencyAxis(axis, rows, oracles, { phaseKind = 'fresh' } = {}) {
  if (!['public', 'fresh'].includes(phaseKind) || !['F', 'V', 'E'].includes(axis)) throw Error('dependency summary scope');
  const expectedArms = axis === 'F' ? phaseKind === 'public' ? ['I', 'D'] : ['D'] : axis === 'V' ? ['V'] : ['B', 'C'];
  const keys = rows.map(r => JSON.stringify([r.id, r.arm]));
  const complete = rows.length === oracles.length * expectedArms.length && new Set(keys).size === rows.length
    && oracles.every(o => expectedArms.every(arm => rows.some(r => r.id === o.id && r.arm === arm)))
    && rows.every(r => oracles.some(o => o.id === r.id) && expectedArms.includes(r.arm)
      && r.method === DEPENDENCY_METHODS[r.arm] && r.generation_policy === DEPENDENCY_POLICIES[r.arm]);
  if (axis !== 'F') {
    const semantic = summarizeRequirementAxis(axis, rows, oracles, { phaseKind });
    if (axis === 'V') return { ...semantic, complete: complete && semantic.complete,
      verification_criteria: complete && semantic.verification_criteria === 'PASS' ? 'PASS' : 'UNMET' };
    const missing = oracles.filter(o => o.expected_gate === 'missing');
    const noEffect = complete && phaseKind === 'fresh' && missing.length === 4 && rows.every(valid)
      && semantic.all_arm_guards && semantic.no_false_adoption && semantic.regressions === 0 && semantic.missing_gains === 0
      && missing.every(o => semantic.pairs.find(p => p.id === o.id)?.eligible === true);
    return { ...semantic, complete: complete && semantic.complete,
      enabled_criteria: complete && semantic.enabled_criteria === 'PASS' ? 'PASS' : 'UNMET',
      effect_criteria: complete && semantic.effect_criteria === 'PASS' ? 'PASS' : 'UNMET',
      no_effect_criteria_pending_integrity: noEffect ? 'PASS' : 'UNPROVEN',
      no_effect_scope: 'all four registered missing pairs actually eligible, zero gains, full evidence admission required separately' };
  }
  const byArm = Object.fromEntries(expectedArms.map(arm => {
    const own = rows.filter(r => r.arm === arm);
    return [arm, { ...summarizeRequirementAxis('F', own, oracles, { phaseKind }),
      valid: own.filter(valid).length, invalid: own.filter(r => !valid(r)).length,
      exact_valid: own.filter(exact).length, denominator: oracles.length }];
  }));
  const paired = phaseKind !== 'public' ? [] : oracles.map(o => {
    const independent = rows.find(r => r.id === o.id && r.arm === 'I'), dependent = rows.find(r => r.id === o.id && r.arm === 'D');
    const eligible = valid(independent) && valid(dependent);
    return { id: o.id, independent_valid: valid(independent), dependent_valid: valid(dependent),
      admissible_semantic_pair: eligible, validity_gain: !valid(independent) && valid(dependent),
      semantic_gain: eligible && !exact(independent) && exact(dependent),
      semantic_regression: eligible && exact(independent) && !exact(dependent),
      excluded_from_semantic_only: !eligible };
  });
  return { complete, total: oracles.length, by_arm: byArm, pairs: paired,
    candidate_requirements_criteria: complete && byArm.D.requirements_criteria === 'PASS' ? 'PASS' : 'UNMET',
    requirements_criteria: complete && byArm.D.requirements_criteria === 'PASS' ? 'PASS' : 'UNMET',
    admissible_semantic_pairs: paired.filter(p => p.admissible_semantic_pair).length,
    validity_gains: paired.filter(p => p.validity_gain).length, semantic_gains: paired.filter(p => p.semantic_gain).length,
    semantic_regressions: paired.filter(p => p.semantic_regression).length,
    scope: 'fixed full per-arm denominators; validity changes never promoted into admissible semantic wins' };
}
