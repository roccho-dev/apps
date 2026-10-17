// Independent new intent-cycle scope. Frozen V/F/E meanings are reused unchanged.
import { createHash } from 'node:crypto';
import { exactKeys, sameValue, validateRequirementInput as validateV2Input, validRequirements, validDecision,
  validFactors, readRequirementInspection, sameRequirements, stockDifference } from './requirements-cycle-score.mjs';
import { summarizeDependencyAxis } from './dependency-cycle-score.mjs';
export { exactKeys, sameValue, validRequirements, validStock, stockDifference, sameRequirements, validFactors,
  verifierDecision, decodeRequiredSlots, validDecision, validLiteral, readRequirementInspection,
  gradeFullRequired, gradeVerification, gradeRequirementGoal } from './requirements-cycle-score.mjs';
export const INTENT_METHODS = Object.freeze({ G0: 'literal-v2', V: 'verify', D: 'full-required', B: 'literal-v2', C: 'adaptive-v2' });
export const INTENT_POLICIES = Object.freeze({ G0: null, V: null, D: 'dependent', B: null, C: 'dependent' });
export const INTENT_PUBLIC = Object.freeze({
  G0: Object.freeze({ input: 'bb2e090c218ef9be4db85416a87b60bf85a9d2d10a3156c4994bc1e6fd4bc4ba', oracle: 'a5f08d8d2ed57b802870c76f4a86b9481400325d9c6342e8a0d66f58b5fb8653', parentInput: null, parentOracle: null }),
  E: Object.freeze({ input: '6ed1692b94371faef36475e08a221926b96cbc783f15f5d230ebb118a28b0afa', oracle: '9f5418a40cef083ff4119b0553c5f58a35451dbbec6147ea53db0e5b97d79ee5',
    parentInput: 'e359929b095783603949044e74a2b4720f7697aeb9466858279f69440f5b5d84', parentOracle: 'b642512e31115a4e2ef7c85d316d3f095f8e12fff8b1feadfa762ce7b08b04e6' }),
});
export const INTENT_SEALED_COMMITMENTS = Object.freeze({
  V: Object.freeze({ input: '81600ac51565a65379a8708165b3d2e4a4165d6b3ebd2787b2203bc784f5c23a', oracle: '6e7ab3601840f3635741da0db14b5c21f2e192f97df0e05db7a64e12b3608859' }),
  F: Object.freeze({ input: '26a757ce49cc857c4efcd035611e62796bc6d7e271c2addf93f2a24247353dd4', oracle: 'ac5e00eccf914c8c9f4fa699526f039786b0f7a6756c3150248399340b4cafb8' }),
  E: Object.freeze({ input: '128aabf814162b512fd205d65c0069fe8b5e4b441bce24704fea269b0b4e3c4b', oracle: '2fc19095df7c84fda0bf32630bd236ae0fa03fb2b6fbf25d85eef1d709c488a9' }),
});
const hash = b => createHash('sha256').update(b).digest('hex');
const decode = b => JSON.parse(Buffer.from(b).toString('utf8'));
export function validateIntentInput(input, { phaseKind = null, parentProjectionBytes = null } = {}) {
  if (!exactKeys(input, ['schema', 'axis', 'oracle_sha256', 'parent_inputs_sha256', 'fixture_contract', 'cases'])
      || input.schema !== 'voice-ui.intent-cycle-input/1' || !['G0', 'V', 'F', 'E'].includes(input.axis)) throw Error('intent input identity');
  const kind = phaseKind ?? (input.axis === 'G0' || input.axis === 'E' && input.parent_inputs_sha256 !== null ? 'public' : 'fresh');
  if (!['public', 'fresh'].includes(kind) || kind === 'public' && !['G0', 'E'].includes(input.axis)
      || kind === 'fresh' && input.axis === 'G0') throw Error('intent unregistered phase');
  const count = kind === 'public' ? input.axis === 'G0' ? 10 : 2 : ({ V: 10, F: 8, E: 10 })[input.axis];
  if (!Array.isArray(input.cases) || input.cases.length !== count) throw Error('intent preregistered denominator');
  const parent = kind === 'public' && input.axis === 'E' ? INTENT_PUBLIC.E.parentInput : null;
  if (input.parent_inputs_sha256 !== parent) throw Error('intent immutable parent');
  const old = { schema: 'voice-ui.requirements-cycle-input/1', axis: input.axis === 'G0' ? 'F' : input.axis,
    oracle_sha256: input.oracle_sha256, fixture_contract: input.fixture_contract, cases: input.cases.map((c, i) => {
      if (!exactKeys(c, ['id', 'fixture', 'utterance', ...(input.axis === 'V' ? ['required'] : []), 'arms'])) throw Error('intent case fields');
      const wanted = input.axis === 'G0' ? ['G0'] : input.axis === 'V' ? ['V'] : input.axis === 'F' ? ['D'] : i % 2 === 0 ? ['B', 'C'] : ['C', 'B'];
      if (!sameValue(c.arms, wanted)) throw Error('intent explicit arm order');
      const { arms, ...value } = c; return value;
    }) };
  validateV2Input(old);
  if (parentProjectionBytes !== null) {
    if (parent === null || hash(parentProjectionBytes) !== parent) throw Error('intent parent bytes');
    const previous = decode(parentProjectionBytes);
    if (previous.schema !== 'voice-ui.dependency-cycle-input/1' || previous.axis !== 'E'
        || !sameValue(previous.fixture_contract, input.fixture_contract) || !sameValue(previous.cases, input.cases)) throw Error('intent changed public semantics');
  }
  return true;
}
export function intentSchedule(input, options) {
  validateIntentInput(input, options);
  return input.cases.flatMap(c => c.arms.map(arm => ({ axis: input.axis, id: c.id, arm,
    method: INTENT_METHODS[arm], generation_policy: INTENT_POLICIES[arm] })));
}
// Same algebra as the frozen G0 contract, derived independently from factor
// evidence and actual graph references. Matching tampered stdout/HTTP cannot
// replace this derivation.
export function normalizeInitialIntent(initial, utterance, parts, initialRecords) {
  if (!validFactors(initial?.factors) || !Array.isArray(initialRecords)) return null;
  let missing; try { missing = stockDifference(initial.literal.required, parts); } catch { return null; }
  const references = new Set(initialRecords.filter(r => r.type === 'region' && !['group', 'boundary'].includes(r.kind)
    && typeof r.label === 'string' && utterance.includes(r.label)).map(r => r.label));
  const ready = initial.observation?.valid === true && (initial.observation.status === 'transcribed'
    || initial.literal.required.length === 0 && references.size >= 2);
  const f = initial.factors, choice = f.intent.choice !== 'change' ? f.intent.choice
    : ready && f.completeness.choice === 'complete' && f.completeness.confidence >= .5 ? missing.length ? 'missing' : 'sufficient' : 'unknown';
  return { choice, confidence: choice === 'unknown' ? null : f.intent.choice !== 'change' ? f.intent.confidence : Math.min(f.intent.confidence, f.completeness.confidence) };
}
export function gradeInitialIntent(response, oracle, parts, observation = {}) {
  if (oracle.minimum_intent_confidence !== .5 || !['change', 'ambiguous', 'no-change', 'unsupported'].includes(oracle.expected_intent)
      || ![null, 'complete', 'incomplete'].includes(oracle.expected_completeness)
      || ![null, true, false].includes(oracle.expected_interpretation_eligible)) throw Error('G0 fixed oracle contract');
  const inspected = readRequirementInspection(response?.inspection, oracle.utterance, parts);
  const initial = inspected?.value.initial, f = initial?.factors;
  const normalized = initial ? normalizeInitialIntent(initial, oracle.utterance, parts, observation.initial_records) : null;
  const contract = exactKeys(response, ['choice', 'confidence', 'inspection']) && inspected !== null
    && inspected.value.mode === 'literal-v2' && inspected.value.proposal === null && inspected.value.verification === null
    && validDecision({ choice: response.choice, confidence: response.confidence }) && normalized !== null
    && sameValue(initial.decision, normalized) && sameValue({ choice: response.choice, confidence: response.confidence }, normalized);
  const eligible = inspected?.eligible ?? false;
  const intentCorrect = contract && f.intent.choice === oracle.expected_intent && f.intent.confidence >= oracle.minimum_intent_confidence;
  const completenessCorrect = contract && (oracle.expected_completeness === null
    || f.completeness.choice === oracle.expected_completeness && f.completeness.confidence >= .5);
  const eligibilityCorrect = contract && (oracle.expected_interpretation_eligible === null || eligible === oracle.expected_interpretation_eligible);
  const unchanged = typeof observation.initial_log === 'string' && observation.initial_log === observation.final_log
    && typeof observation.initial_head === 'string' && observation.initial_head === observation.final_head && Array.isArray(observation.initial_records)
    && sameValue(observation.initial_records, observation.final_records);
  const noType = observation.typellm_sends === 0;
  return { contract_valid: contract, correct: intentCorrect && completenessCorrect && eligibilityCorrect && unchanged && noType,
    expected_intent: oracle.expected_intent, actual_intent: f?.intent ?? null, intent_correct_confident: intentCorrect,
    expected_completeness: oracle.expected_completeness, actual_completeness: f?.completeness ?? null, completeness_condition: completenessCorrect,
    expected_interpretation_eligible: oracle.expected_interpretation_eligible, interpretation_eligible: eligible, eligibility_condition: eligibilityCorrect,
    raw_unchanged: unchanged, type_zero: noType, normalized, literal_required_exact: inspected !== null && sameRequirements(inspected.full_required, oracle.required),
    scope: 'G0 intent/eligibility only; inherited E target fields are provenance, never adoption authority' };
}
export function summarizeIntentAxis(axis, rows, oracles, { phaseKind = 'fresh' } = {}) {
  if (!['public', 'fresh'].includes(phaseKind) || !['G0', 'V', 'F', 'E'].includes(axis)) throw Error('intent summary scope');
  if (axis !== 'G0') return summarizeDependencyAxis(axis, rows, oracles, { phaseKind });
  if (phaseKind !== 'public' || oracles.length !== 10) throw Error('G0 public ten only');
  const complete = rows.length === 10 && new Set(rows.map(r => r.id)).size === 10
    && rows.every(r => oracles.some(o => o.id === r.id) && r.arm === 'G0' && r.method === 'literal-v2' && r.generation_policy === null);
  const valid = rows.filter(r => r.valid_execution === true && r.grade?.contract_valid === true);
  const correct = valid.filter(r => r.grade.correct === true);
  return { complete, total: 10, valid: valid.length, correct: correct.length,
    positive: oracles.filter(o => o.expected_intent === 'change').length, negative_control: oracles.filter(o => o.expected_intent !== 'change').length,
    intent_correct_confident: valid.filter(r => r.grade.intent_correct_confident).length,
    actual_type_eligible: valid.filter(r => r.grade.interpretation_eligible).map(r => r.id),
    intent_criteria: complete && correct.length === 10 ? 'PASS' : 'UNMET',
    scope: 'public G0 regression only; direct literal route does not prove actual adaptive Type execution' };
}
