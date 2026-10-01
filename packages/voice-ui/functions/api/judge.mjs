import { DECISION_KIND, ERRORS, isRequest, readAnswers, slotsFor } from "../../src/contract.mjs";
import { questionsFor } from "../../src/judgment.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const failures = Object.freeze({
  provider_timeout: [504, ERRORS.providerTimeout],
  provider_http_error: [502, ERRORS.providerError],
  provider_unavailable: [502, ERRORS.providerUnreachable],
  provider_invalid_response: [502, ERRORS.providerContract],
  provider_contract_error: [502, ERRORS.providerContract],
  input_invalid: [502, ERRORS.providerContract],
  cancelled: [502, ERRORS.providerUnreachable],
  auth_missing: [503, ERRORS.unavailable],
});

// A single call injection: the composition supplies verified ESM and an opaque
// key. There is no provider endpoint, header, model or dynamic loader here.
export async function onRequestPost({ request, key }, judge) {
  if (typeof key !== "string" || key.length === 0) return json({ error: ERRORS.unavailable }, 503);
  let input;
  try { input = await request.json(); }
  catch { return json({ error: ERRORS.invalidJson }, 400); }
  if (!isRequest(input)) return json({ error: ERRORS.invalidRequest }, 422);
  const slots = slotsFor(input.state);
  let result;
  try {
    result = await judge({ state: input.state, questions: questionsFor(input.state, slots) }, { key, signal: request.signal });
  } catch (error) {
    let failureCode;
    try { failureCode = error?.code; } catch {}
    const [status, code] = typeof failureCode === "string" && Object.hasOwn(failures, failureCode)
      ? failures[failureCode] : [502, ERRORS.providerUnreachable];
    return json({ error: code }, status);
  }
  // Application slots are checked again independently of generic provider
  // validation. Action thresholds remain in turn/application, never HTTP 502.
  const normalized = result?.answers;
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) return json({ error: ERRORS.providerContract }, 502);
  if (Object.values(normalized).some(answer => answer === null || typeof answer !== "object" || Array.isArray(answer)
    || Object.keys(answer).some(name => !["choice", "confidence", "probabilities"].includes(name)))) return json({ error: ERRORS.providerContract }, 502);
  const typed = Object.fromEntries(Object.entries(normalized).map(([name, answer]) => [name, { ...answer, type: "choice" }]));
  const answers = readAnswers(typed, slots);
  if (answers === null) return json({ error: ERRORS.providerContract }, 502);
  return json({ kind: DECISION_KIND, answers });
}
