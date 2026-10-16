import { COVERAGE, inventoryQuestion, isInventory, readMissing, typedMissingRequest } from "../../src/completion.mjs";
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
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
      const answer = value?.answers?.coverage;
      if (!answer || !COVERAGE.includes(answer.choice) || typeof answer.confidence !== "number"
          || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)
        return json({ error: "parts_contract" }, 502);
      return json({ choice: answer.choice, confidence: answer.confidence });
    }
    const value = await generate(typedMissingRequest(input.state), { signal: request.signal });
    const missing = readMissing(value?.result?.missing);
    if (missing === null) return json({ error: "parts_contract" }, 502);
    return json({ missing });
  } catch (error) {
    const [status, code] = Object.hasOwn(failures, error?.code) ? failures[error.code] : [502, "parts_provider_error"];
    return json({ error: code }, status);
  }
}
