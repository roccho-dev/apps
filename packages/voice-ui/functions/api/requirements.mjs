import { inventoryQuestion, isInventory, readLiteralInspection } from "../../src/completion.mjs";
import { literalInventory, literalQuestion } from "../../src/literal-inventory.mjs";
import { acceptedRequirements, readRequired, readRequiredSlots, readRequirementFactors, readRequirementInspection,
  requirementDecision, requiredDifference, requiredQuestion, requiredRequest, requiresInterpretation } from "../../src/requirements.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const exact = (x, keys) => x !== null && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const failure = code => Object.assign(new Error("parts operation stopped"), { code });

// One shared deadline covers every stage of the request, including fallback.
export async function onRequirements({ request, mode, method, available }, { judge, generate }) {
  if (!["check", "requirements", "verify"].includes(mode)
      || !["literal-v2", "adaptive-v2"].includes(method)) return json({ error: "parts_invalid_method" }, 422);
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
    const value = await send(generate, requiredRequest(inventoryQuestion(inventory.state).state));
    const required = readRequiredSlots(value?.result);
    if (required === null) {
      stage("TYPE_REQUIRED", { valid: false });
      throw failure("provider_contract_error");
    }
    const proposal = { slots: structuredClone(value.result), required };
    stage("TYPE_REQUIRED", { valid: true, proposal });
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
