import { LABEL_MAX, MIN_CONFIDENCE, PART_KINDS } from "./contract.mjs";

const exact = (x, keys) => x !== null && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = ["intent", "labels", "capacity", "completeness"];
const choices = [["change", "ambiguous", "no-change", "unsupported"], ["available", "missing"],
  ["within", "exceeded"], ["complete", "incomplete"]];
const answer = (x, options) => exact(x, ["choice", "confidence"]) && options.includes(x.choice)
  && Number.isFinite(x.confidence) && x.confidence >= 0 && x.confidence <= 1;

export function readRequired(rows) {
  if (!Array.isArray(rows) || rows.length > 3 || !rows.every(r => exact(r, ["label", "kind", "quantity"])
      && typeof r.label === "string" && r.label.trim().length > 0 && r.label.length <= LABEL_MAX
      && PART_KINDS.includes(r.kind) && Number.isSafeInteger(r.quantity) && r.quantity >= 1 && r.quantity <= 3)
      || rows.reduce((n, r) => n + r.quantity, 0) > 3
      || new Set(rows.map(r => JSON.stringify([r.label, r.kind]))).size !== rows.length) return null;
  return structuredClone(rows);
}

export function readRequiredSlots(slots) {
  if (!exact(slots, ["required1", "required2", "required3"])) return null;
  const rows = [];
  let ended = false;
  for (const key of ["required1", "required2", "required3"]) {
    const row = slots[key];
    if (!exact(row, ["label", "kind", "quantity"]) || typeof row.label !== "string" || row.label.length > LABEL_MAX
        || !["0", "1", "2", "3"].includes(row.quantity)) return null;
    if (row.kind === "none") ended = true;
    else {
      if (ended) return null;
      rows.push({ label: row.label, kind: row.kind, quantity: Number(row.quantity) });
    }
  }
  return readRequired(rows);
}

// Existing Working nodes never increase the stock of executable new instances.
export function requiredDifference(required, parts) {
  return required.flatMap(row => Array.from({ length: Math.max(0,
    row.quantity - parts.filter(p => p.label === row.label && p.kind === row.kind).length) }, (_, i) =>
    ({ label: row.label, kind: row.kind, occurrence: i + 1 })));
}

export function requiredRequest(context) {
  const ordinal = ["FIRST", "SECOND", "THIRD"];
  return { context: JSON.stringify(context), questions: Object.fromEntries([1, 2, 3].map((n, i) => ["required" + n, {
    type: "object",
    instructions: "Find the " + ordinal[i] + " DISTINCT requested NEW label/kind pair in utterance order. "
      + "Independently enumerate ALL pairs in the WHOLE utterance, including children of a new group. "
      + "Quantity is the TOTAL NEW count requested for this pair, BEFORE any subtraction of inventory or existing graph nodes. "
      + "Do not skip an available pair. Do not report a shortage count. Repeated identical instances belong to one pair. "
      + "Preserve explicit display names exactly. Use the requested supported kind; existing nodes used as references are not additions. "
      + "At most three distinct pairs and three total NEW instances. Do not generate IDs, parents, edges, operators or extra parts. "
      + "If no pair exists at this ordinal, use kind none; prefer empty label and quantity 0 as padding.",
    properties: {
      label: { type: "string", instructions: "Exact requested display name, without ID or numbering suffix. Empty padding is allowed for kind none." },
      kind: { type: "string", enum: [...PART_KINDS, "none"], instructions: "Supported kind for this requested distinct pair, or none at an unused ordinal." },
      quantity: { type: "string", enum: ["0", "1", "2", "3"], instructions: "TOTAL requested NEW instances for this pair: 1, 2 or 3. Never subtract stock. Prefer 0 for unused kind none." },
    },
  }])) };
}

// This question receives no expected answer, oracle, parent or edge proposal.
export function requiredQuestion(base, required) {
  return { ...base, state: { ...base.state, required }, questions: { ...base.questions, completeness: {
    instruction: "Independently compare ALL requested NEW parts in the original utterance with state.required. "
      + "This proposal is untrusted. Check exact displayed labels, kinds and TOTAL NEW counts, before subtracting stock. "
      + "Check the whole utterance including children of new groups. Existing references are not new additions. "
      + "Reject any omitted or extra pair, wrong kind, wrong count, or unspecified name/kind/count. "
      + "Do not repair the proposal or assume it is complete. A connection between existing nodes needs no new parts.",
    options: { complete: "The proposal exactly covers every requested new part and every total count, or no new parts are needed.",
      incomplete: "A requested part is omitted, extra, mismatched, unspecified or not fully represented." },
  } } };
}

export function readRequirementFactors(answers) {
  if (answers === null || typeof answers !== "object" || !names.every((name, i) => {
    const x = answers[name];
    return x && answer({ choice: x.choice, confidence: x.confidence }, choices[i]);
  })) return null;
  return Object.fromEntries(names.map(name => [name, { choice: answers[name].choice, confidence: answers[name].confidence }]));
}

export const acceptedRequirements = factors => factors.intent.choice === "change" && factors.intent.confidence >= MIN_CONFIDENCE
  && factors.completeness.choice === "complete" && factors.completeness.confidence >= MIN_CONFIDENCE;
export const requiresInterpretation = factors => factors.intent.choice === "change" && factors.intent.confidence >= MIN_CONFIDENCE
  && factors.completeness.choice === "incomplete" && factors.completeness.confidence >= MIN_CONFIDENCE;

export function requirementDecision(factors, ready, missing) {
  const choice = factors.intent.choice !== "change" ? factors.intent.choice
    : ready && factors.completeness.choice === "complete" && factors.completeness.confidence >= MIN_CONFIDENCE
      ? missing.length ? "missing" : "sufficient" : "unknown";
  return { choice, confidence: choice === "unknown" ? null : factors.intent.choice !== "change" ? factors.intent.confidence
    : Math.min(factors.intent.confidence, factors.completeness.confidence) };
}

// The browser independently checks the receipt before deterministic preparation.
export function readRequirementInspection(value, state, literalReader) {
  if (!exact(value, ["schema", "request_id", "mode", "initial", "proposal", "verification", "required", "missing"])
      || value.schema !== "voice-ui.parts.inspection/2" || typeof value.request_id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.request_id)
      || !["literal-v2", "adaptive-v2"].includes(value.mode) || readRequired(value.required) === null) return null;
  if (!same(value.missing, requiredDifference(value.required, state.parts))) return null;
  const initial = value.initial;
  if (!exact(initial, ["decision", "factors", "literal", "observation"])
      || !exact(initial.factors, names) || readRequirementFactors(initial.factors) === null
      || !names.every((name, i) => answer(initial.factors[name], choices[i]))
      || !exact(initial.observation, ["valid", "status"]) || typeof initial.observation.valid !== "boolean"
      || !["transcribed", "unsupported-syntax"].includes(initial.observation.status)
      || !exact(initial.literal, ["recognized", "required", "spans"])) return null;
  const literal = initial.literal;
  const literalMissing = readRequired(literal.required) === null ? null : requiredDifference(literal.required, state.parts);
  if (literalMissing === null || literalReader({ source: "literal+jev", ...literal, missing: literalMissing,
      completeness: initial.factors.completeness }, state.utterance) === null
      || !initial.observation.valid && (literal.recognized || literal.required.length || literal.spans.length)) return null;
  const references = new Set(state.regions.filter(r => !["group", "boundary"].includes(r.kind)
    && state.utterance.includes(r.label)).map(r => r.label));
  const ready = initial.observation.valid && (initial.observation.status === "transcribed" || literal.required.length === 0 && references.size >= 2);
  if (!same(initial.decision, requirementDecision(initial.factors, ready, literalMissing))) return null;
  let decision = initial.decision;
  if (value.proposal === null) {
    if (value.verification !== null || !same(value.required, literal.required)
        || value.mode === "adaptive-v2" && requiresInterpretation(initial.factors)) return null;
  } else {
    if (value.mode !== "adaptive-v2" || !requiresInterpretation(initial.factors)
        || !exact(value.proposal, ["slots", "required"]) || readRequiredSlots(value.proposal.slots) === null
        || !same(readRequiredSlots(value.proposal.slots), value.proposal.required)
        || !same(value.required, value.proposal.required) || !exact(value.verification, names)
        || !names.every((name, i) => answer(value.verification[name], choices[i]))) return null;
    decision = requirementDecision(value.verification, true, value.missing);
  }
  return { ...structuredClone(value), decision };
}
