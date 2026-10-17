import { COVERAGE, inventoryQuestion, isInventory, readLiteralInspection, readTypedMissing, typedMissingRequest,
  acceptedRequirements, readRequired, readRequiredSlots, readRequirementFactors, readRequirementInspection,
  requirementDecision, requiredDifference, requiredQuestion, requiredRequest, requiresInterpretation } from "../../src/completion.mjs";
import { LABEL_MAX, PART_KINDS } from "../../src/contract.mjs";
import { literalInventory, literalQuestion } from "../../src/literal-inventory.mjs";
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const inventoryChoices = ["sufficient", "missing"];
const intentChoices = ["change", ...COVERAGE.filter(choice => !inventoryChoices.includes(choice))];
const labelChoices = ["available", "missing"], capacityChoices = ["within", "exceeded"];
const validAnswer = (answer, choices) => answer && choices.includes(answer.choice)
  && typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
  && answer.confidence >= 0 && answer.confidence <= 1;
const failures = {
  auth_missing: [503, "parts_unavailable"], provider_timeout: [504, "parts_timeout"],
  provider_http_error: [502, "parts_provider_error"], provider_unavailable: [502, "parts_provider_error"],
  provider_invalid_response: [502, "parts_contract"], provider_contract_error: [502, "parts_contract"],
  input_invalid: [422, "parts_contract"], cancelled: [502, "parts_cancelled"],
};

// Bound operations and availability only; the request composition owns credentials and transport.
export async function onParts({ request, mode, available, method = "typed" }, { judge, generate }) {
  if (!["literal", "typed"].includes(method)) return json({ error: "parts_invalid_method" }, 422);
  if (available !== true) return json({ error: "parts_unavailable" }, 503);
  let input;
  try { input = await request.json(); } catch { return json({ error: "parts_invalid_json" }, 400); }
  if (!isInventory(input) || !["check", "complete"].includes(mode)) return json({ error: "parts_invalid_request" }, 422);
  try {
    const literal = method === "literal" ? literalInventory(input.state) : null;
    if (mode === "complete" && literal !== null) return json({ missing: literal.missing,
      extraction: { source: "literal", recognized: literal.recognized, required: literal.required, spans: literal.spans } });
    if (mode === "check") {
      const value = await judge(literal === null ? inventoryQuestion(input.state) : literalQuestion(input.state, literal), { signal: request.signal });
      const intent = value?.answers?.intent, labels = value?.answers?.labels, capacity = value?.answers?.capacity;
      if (!validAnswer(intent, intentChoices) || !validAnswer(labels, labelChoices) || !validAnswer(capacity, capacityChoices))
        return json({ error: "parts_contract" }, 502);
      // Keep finite factor evidence, never arbitrary head text or raw provider objects.
      console.info(JSON.stringify({ kind: "voice-ui.parts.factors.v1",
        head: /^sha256:[a-f0-9]{64}$/.test(input.state.head) ? input.state.head : null,
        factors: Object.fromEntries(Object.entries({ intent, labels, capacity }).map(([name, answer]) =>
          [name, { choice: answer.choice, confidence: answer.confidence }])) }));
      if (literal !== null) {
        const completeness = value?.answers?.completeness;
        if (!validAnswer(completeness, ["complete", "incomplete"])) return json({ error: "parts_contract" }, 502);
        const referenced = input.state.regions.filter(region => region.kind !== "group" && region.kind !== "boundary"
          && input.state.utterance.includes(region.label));
        const ready = literal.valid && (literal.status === "transcribed"
          || literal.required.length === 0 && new Set(referenced.map(region => region.label)).size >= 2);
        const inspection = { source: "literal+jev", recognized: literal.recognized, required: literal.required,
          missing: literal.missing, spans: literal.spans, completeness: { choice: completeness.choice, confidence: completeness.confidence } };
        if (readLiteralInspection(inspection, input.state.utterance) === null) return json({ error: "parts_contract" }, 502);
        const choice = intent.choice !== "change" ? intent.choice
          : ready && completeness.choice === "complete" && completeness.confidence >= 0.5
            ? literal.missing.length ? "missing" : "sufficient" : "unknown";
        const confidence = choice === "unknown" ? null : intent.choice !== "change" ? intent.confidence
          : Math.min(intent.confidence, completeness.confidence);
        console.info(JSON.stringify({ kind: "voice-ui.parts.literal.v1", head: /^sha256:[a-f0-9]{64}$/.test(input.state.head) ? input.state.head : null,
          recognized: literal.recognized, required_count: literal.required.reduce((n, item) => n + item.quantity, 0),
          completeness: inspection.completeness, choice, confidence }));
        return json({ choice, confidence, inspection });
      }
      // Either positive fact proves something is missing. A confident negative
      // cannot lift a weak positive; sufficient needs both negative facts.
      const witnesses = [labels.choice === "missing" ? labels.confidence : null,
        capacity.choice === "exceeded" ? capacity.confidence : null].filter(confidence => confidence !== null);
      const coverage = witnesses.length
        ? { choice: "missing", confidence: Math.max(...witnesses) }
        : { choice: "sufficient", confidence: Math.min(labels.confidence, capacity.confidence) };
      return json(intent.choice === "change"
        ? { choice: coverage.choice, confidence: Math.min(intent.confidence, coverage.confidence) }
        : { choice: intent.choice, confidence: intent.confidence });
    }
    const value = await generate(typedMissingRequest(input.state), { signal: request.signal });
    const missing = readTypedMissing(value?.result);
    if (missing === null) {
      const result = value?.result, object = x => x !== null && typeof x === "object" && !Array.isArray(x);
      // Fixed structural facts only. Never log names, context or arbitrary provider output.
      console.info(JSON.stringify({ kind: "voice-ui.parts.contract.v1", stage: "local-result",
        rootExact: object(result) && Object.keys(result).length === 3
          && ["missing1", "missing2", "missing3"].every(key => Object.hasOwn(result, key)),
        slots: ["missing1", "missing2", "missing3"].map(key => {
          const row = result?.[key];
          return { exact: object(row) && Object.keys(row).length === 3
              && ["label", "kind", "quantity"].every(field => Object.hasOwn(row, field)),
            label: typeof row?.label !== "string" ? "not-string" : row.label === "" ? "empty"
              : row.label.trim().length === 0 ? "blank" : row.label.length > LABEL_MAX ? "too-long" : "nonempty",
            kind: row?.kind === "none" ? "none" : PART_KINDS.includes(row?.kind) ? row.kind : "invalid",
            quantity: ["0", "1", "2", "3"].includes(row?.quantity) ? Number(row.quantity) : "invalid" };
        }), duplicatePair: object(result) && ["missing1", "missing2", "missing3"].some((key, i, keys) =>
          PART_KINDS.includes(result[key]?.kind) && keys.slice(0, i).some(prior =>
            result[prior]?.kind === result[key].kind && result[prior]?.label === result[key].label)) }));
      return json({ error: "parts_contract" }, 502);
    }
    return json({ missing });
  } catch (error) {
    if (mode === "complete") console.info(JSON.stringify({ kind: "voice-ui.parts.contract.v1", stage: "provider",
      code: Object.hasOwn(failures, error?.code) ? error.code : "unknown" }));
    const [status, code] = Object.hasOwn(failures, error?.code) ? failures[error.code] : [502, "parts_provider_error"];
    return json({ error: code }, status);
  }
}

const exact = (x, keys) => x !== null && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const failure = code => Object.assign(new Error("parts operation stopped"), { code });

// One shared deadline covers every stage of the request, including fallback.
export async function onRequirements({ request, mode, method, available, generation = "dependent" }, { judge, generate }) {
  if (!["check", "requirements", "verify"].includes(mode)
      || !["literal-v2", "adaptive-v2"].includes(method)
      || !["independent", "dependent"].includes(generation)
      || mode !== "requirements" && generation !== "dependent") return json({ error: "parts_invalid_method" }, 422);
  if (!available) return json({ error: "parts_unavailable" }, 503);
  let input;
  try { input = await request.json(); } catch { return json({ error: "parts_invalid_json" }, 400); }
  const inventory = mode === "verify" ? input?.inventory : input;
  if (!isInventory(inventory) || mode === "verify" && (!exact(input, ["schema", "inventory", "required"])
      || input.schema !== "voice-ui.parts.verify/2" || readRequired(input.required) === null))
    return json({ error: "parts_invalid_request" }, 422);
  const request_id = crypto.randomUUID(), controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timer = setTimeout(cancel, 40000), signal = controller.signal;
  const stage = (name, values) => console.info(JSON.stringify({ kind: "voice-ui.parts.stage.v2", request_id, stage: name, ...values }));
  const send = async (call, body) => {
    if (signal.aborted) throw failure("provider_timeout");
    let stop;
    const deadline = new Promise((_, reject) => {
      stop = () => reject(failure("provider_timeout")); signal.addEventListener("abort", stop, { once: true });
    });
    try { return await Promise.race([call(body, { signal }), deadline]); }
    finally { signal.removeEventListener("abort", stop); }
  };
  const full = async () => {
    const value = await send(generate, requiredRequest(inventoryQuestion(inventory.state).state, { generation }));
    const required = readRequiredSlots(value?.result);
    if (required === null) {
      stage("TYPE_REQUIRED", { valid: false, generation });
      throw failure("provider_contract_error");
    }
    const proposal = { slots: structuredClone(value.result), required };
    stage("TYPE_REQUIRED", { valid: true, generation, proposal });
    return proposal;
  };
  const verify = async required => {
    const result = await send(judge, requiredQuestion(inventoryQuestion(inventory.state), required));
    const factors = readRequirementFactors(result?.answers);
    if (factors === null) { stage("VERIFY_REQUIRED", { valid: false }); throw failure("provider_contract_error"); }
    stage("VERIFY_REQUIRED", { valid: true, required, factors });
    return factors;
  };
  try {
    if (mode === "requirements") return json({ schema: "voice-ui.parts.requirements/2", request_id, ...await full() });
    if (mode === "verify") {
      const factors = await verify(input.required);
      return json({ schema: "voice-ui.parts.verification/2", request_id, required: input.required, factors,
        accepted: acceptedRequirements(factors), confidence: Math.min(factors.intent.confidence, factors.completeness.confidence) });
    }
    const observed = literalInventory(inventory.state);
    const literal = observed.valid ? observed : { ...observed, recognized: false, required: [], missing: [], spans: [] };
    const result = await send(judge, literalQuestion(inventory.state, literal));
    const factors = readRequirementFactors(result?.answers);
    if (factors === null) { stage("G0", { valid: false }); throw failure("provider_contract_error"); }
    const references = new Set(inventory.state.regions.filter(r => !["group", "boundary"].includes(r.kind)
      && inventory.state.utterance.includes(r.label)).map(r => r.label));
    const ready = literal.valid && (literal.status === "transcribed" || literal.required.length === 0 && references.size >= 2);
    const initial = { decision: requirementDecision(factors, ready, literal.missing), factors,
      literal: { recognized: literal.recognized, required: literal.required, spans: literal.spans },
      observation: { valid: observed.valid, status: observed.status } };
    stage("G0", { valid: true, initial });
    const proposal = method === "adaptive-v2" && requiresInterpretation(factors) ? await full() : null;
    const verification = proposal === null ? null : await verify(proposal.required);
    const required = proposal?.required ?? literal.required, missing = requiredDifference(required, inventory.state.parts);
    const inspection = { schema: "voice-ui.parts.inspection/2", request_id, mode: method, initial, proposal, verification, required, missing };
    const checked = readRequirementInspection(inspection, inventory.state, readLiteralInspection);
    if (checked === null) throw failure("provider_contract_error");
    stage("STOCK_DIFF", { required, missing, decision: checked.decision });
    return json({ ...checked.decision, inspection });
  } catch (error) {
    const time = signal.aborted || error?.code === "provider_timeout";
    const contract = ["provider_contract_error", "provider_invalid_response"].includes(error?.code);
    return json({ error: time ? "parts_timeout" : contract ? "parts_contract" : error?.code === "auth_missing"
      ? "parts_unavailable" : "parts_provider_error" }, time ? 504 : contract ? 502 : error?.code === "auth_missing" ? 503 : 502);
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", cancel); }
}
