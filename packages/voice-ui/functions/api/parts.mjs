import { COVERAGE, inventoryQuestion, isInventory, readTypedMissing, typedMissingRequest } from "../../src/completion.mjs";
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const inventoryChoices = ["sufficient", "missing"];
const intentChoices = ["change", ...COVERAGE.filter(choice => !inventoryChoices.includes(choice))];
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
export async function onParts({ request, mode, available }, { judge, generate }) {
  if (available !== true) return json({ error: "parts_unavailable" }, 503);
  let input;
  try { input = await request.json(); } catch { return json({ error: "parts_invalid_json" }, 400); }
  if (!isInventory(input) || !["check", "complete"].includes(mode)) return json({ error: "parts_invalid_request" }, 422);
  try {
    if (mode === "check") {
      const value = await judge(inventoryQuestion(input.state), { signal: request.signal });
      const intent = value?.answers?.intent, coverage = value?.answers?.coverage;
      if (!validAnswer(intent, intentChoices) || !validAnswer(coverage, inventoryChoices))
        return json({ error: "parts_contract" }, 502);
      return json(intent.choice === "change"
        ? { choice: coverage.choice, confidence: Math.min(intent.confidence, coverage.confidence) }
        : { choice: intent.choice, confidence: intent.confidence });
    }
    const value = await generate(typedMissingRequest(input.state), { signal: request.signal });
    const missing = readTypedMissing(value?.result?.missing);
    if (missing === null) return json({ error: "parts_contract" }, 502);
    return json({ missing });
  } catch (error) {
    const [status, code] = Object.hasOwn(failures, error?.code) ? failures[error.code] : [502, "parts_provider_error"];
    return json({ error: code }, status);
  }
}
