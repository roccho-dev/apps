// src/core.mjs
var ENDPOINT = "https://api.typesafe.ai/v1/systemone";
async function postJevQuestions(provider, { model, state, questions }, options) {
  let body, expected;
  try {
    body = JSON.parse(JSON.stringify({ model, state, questions }));
    expected = JSON.parse(JSON.stringify(body.questions));
  } catch {
    throw new JevTransportError("input_invalid");
  }
  const data = await provider.post(body, options);
  return { data, questions: expected };
}
var JevTransportError = class extends Error {
  constructor(code, status, diagnostic) {
    super(code);
    this.name = "JevTransportError";
    this.code = code;
    this.status = status;
    if (code === "provider_http_error" && status === 400 && diagnostic === "context-limit-vocabulary-observed") this.diagnostic = diagnostic;
  }
};
function bindJev({ apiKey, fetch: fetchFn = globalThis.fetch } = {}) {
  const available = typeof apiKey === "string" && apiKey.length > 0;
  return Object.freeze({
    available,
    async post(body, { signal, deadlineMs, diagnoseRejection } = {}) {
      const fail2 = (code, status, diagnostic) => {
        throw new JevTransportError(code, status, diagnostic);
      };
      if (!available) fail2("auth_missing");
      if (typeof fetchFn !== "function") fail2("provider_unavailable");
      if (signal?.aborted) fail2("cancelled");
      const controller = new AbortController();
      let timer, abort;
      const stopped = new Promise((_, reject) => {
        if (deadlineMs !== void 0) timer = setTimeout(() => {
          controller.abort();
          reject(new JevTransportError("provider_timeout"));
        }, deadlineMs);
        abort = () => {
          controller.abort();
          reject(new JevTransportError("cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      const call = (async () => {
        let response;
        try {
          response = await fetchFn(ENDPOINT, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } catch {
          fail2("provider_unavailable");
        }
        if (!response?.ok) {
          let diagnostic;
          if (response?.status === 400 && diagnoseRejection === true && deadlineMs !== void 0) {
            let reader, cancel, complete = false;
            try {
              reader = response.body?.getReader();
              if (reader) {
                let interrupt;
                let cancelled = false;
                const interrupted = new Promise((resolve) => {
                  interrupt = resolve;
                });
                cancel = () => {
                  if (cancelled) return;
                  cancelled = true;
                  interrupt({ interrupted: true });
                  try {
                    Promise.resolve(reader.cancel()).catch(() => {
                    });
                  } catch {
                  }
                };
                controller.signal.addEventListener("abort", cancel, { once: true });
                if (controller.signal.aborted) cancel();
                const chunks = [];
                let size = 0;
                while (!controller.signal.aborted) {
                  const { done, value, interrupted: stopped2 } = await Promise.race([reader.read(), interrupted]);
                  if (stopped2) break;
                  if (done) {
                    complete = true;
                    break;
                  }
                  if (!(value instanceof Uint8Array) || value.byteLength === 0 || size + value.byteLength > 4096) {
                    cancel();
                    break;
                  }
                  size += value.byteLength;
                  chunks.push(value);
                }
                if (complete && !controller.signal.aborted) {
                  const bytes = new Uint8Array(size);
                  let offset = 0;
                  for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                  }
                  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                  const object2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
                  if (object2(parsed)) {
                    const texts = [parsed.detail, parsed.message, object2(parsed.error) ? parsed.error.message : void 0];
                    if (texts.some((text) => {
                      if (typeof text !== "string") return false;
                      const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
                      return words.includes("context") && (words.includes("length") || words.includes("limit"));
                    })) diagnostic = "context-limit-vocabulary-observed";
                  }
                }
              }
            } catch {
            } finally {
              if (!complete) cancel?.();
              if (cancel) controller.signal.removeEventListener("abort", cancel);
              try {
                reader?.releaseLock();
              } catch {
              }
            }
          }
          fail2("provider_http_error", response?.status, diagnostic);
        }
        try {
          return await response.json();
        } catch {
          fail2("provider_invalid_response");
        }
      })();
      try {
        return await Promise.race([stopped, call]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
  });
}

// src/client.mjs
var JEV_MODEL = "jev-latest";
var JevError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "JevError";
  }
};
var JevContractError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "JevContractError";
  }
};
function validateModel(value) {
  if (typeof value !== "string") throw new JevContractError("model must be string");
  return value;
}
async function fetchAndParseResponse(body, provider) {
  let result;
  try {
    result = await postJevQuestions(provider, body);
  } catch (error) {
    if (error instanceof JevTransportError) {
      if (error.code === "provider_http_error") throw new JevError("provider_error", `Provider returned ${error.status}`);
      if (error.code === "provider_invalid_response") throw new JevError("provider_invalid_response", "Failed to parse provider response");
      throw new JevError("provider_unreachable", "Failed to reach provider");
    }
    throw error;
  }
  if (!result.data || typeof result.data !== "object") throw new JevContractError("provider response must be object");
  return result;
}
function validateNoulAnswer(answer) {
  if (answer?.type !== "noul") throw new JevContractError("noul answer type required");
  if (typeof answer?.noul !== "number") throw new JevContractError("noul must be number");
  if (!Number.isFinite(answer.noul)) throw new JevContractError("noul must be finite");
  if (answer.noul < 0 || answer.noul > 1) throw new JevContractError("noul must be in [0,1]");
  return answer.noul;
}
function validateChoiceAnswer(answer, expectedOptions) {
  if (answer?.type !== "choice") throw new JevContractError("choice answer type required");
  if (typeof answer?.choice !== "string") throw new JevContractError("choice must be string");
  if (!expectedOptions.includes(answer.choice)) throw new JevContractError("choice key must be in options");
  if (!answer?.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw new JevContractError("probabilities must be object map");
  }
  const probKeys = Object.keys(answer.probabilities).sort();
  const expectedKeys = expectedOptions.slice().sort();
  if (probKeys.length !== expectedKeys.length || !probKeys.every((k, i) => k === expectedKeys[i])) {
    throw new JevContractError("probabilities keys must match options");
  }
  for (const [key, value] of Object.entries(answer.probabilities)) {
    if (typeof value !== "number") throw new JevContractError("probabilities values must be number");
    if (!Number.isFinite(value)) throw new JevContractError("probabilities values must be finite");
    if (value < 0 || value > 1) throw new JevContractError("probabilities values must be in [0,1]");
  }
  if (typeof answer?.confidence !== "number") throw new JevContractError("confidence must be number");
  if (!Number.isFinite(answer.confidence)) throw new JevContractError("confidence must be finite");
  if (answer.confidence < 0 || answer.confidence > 1) throw new JevContractError("confidence must be in [0,1]");
  return answer;
}
function validateScoreAnswer(answer, numLevels, criteria) {
  if (answer?.type !== "score") throw new JevContractError("score answer type required");
  if (typeof answer?.score !== "number") throw new JevContractError("score must be number");
  if (!Number.isFinite(answer.score)) throw new JevContractError("score must be finite");
  if (answer.score < 0 || answer.score > numLevels - 1) {
    throw new JevContractError("score must be in [0, levels-1]");
  }
  if (!answer?.legend || typeof answer.legend !== "object" || Array.isArray(answer.legend)) {
    throw new JevContractError("legend must be object map");
  }
  const expectedKeyStrings = Array.from({ length: numLevels }, (_, i) => String(i));
  const legendKeySet = new Set(Object.keys(answer.legend));
  const expectedKeySet = new Set(expectedKeyStrings);
  if (legendKeySet.size !== expectedKeySet.size || !expectedKeyStrings.every((k) => legendKeySet.has(k))) {
    throw new JevContractError("legend keys must be exactly '0' to 'N-1'");
  }
  for (const [key, value] of Object.entries(answer.legend)) {
    if (typeof value !== "string") throw new JevContractError("legend values must be string");
    const idx = parseInt(key, 10);
    if (String(idx) !== key) throw new JevContractError("legend keys must be canonical string integers");
    if (criteria && criteria[idx] !== value) {
      throw new JevContractError("legend values must match criteria strings");
    }
  }
  if (!answer?.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw new JevContractError("probabilities must be object map");
  }
  const probKeySet = new Set(Object.keys(answer.probabilities));
  if (probKeySet.size !== expectedKeySet.size || !expectedKeyStrings.every((k) => probKeySet.has(k))) {
    throw new JevContractError("probabilities keys must be exactly '0' to 'N-1'");
  }
  for (const [key, value] of Object.entries(answer.probabilities)) {
    if (typeof value !== "number") throw new JevContractError("probabilities values must be number");
    if (!Number.isFinite(value)) throw new JevContractError("probabilities values must be finite");
    if (value < 0 || value > 1) throw new JevContractError("probabilities values must be in [0,1]");
    const idx = parseInt(key, 10);
    if (String(idx) !== key) throw new JevContractError("probabilities keys must be canonical string integers");
  }
  if (typeof answer?.confidence !== "number") throw new JevContractError("confidence must be number");
  if (!Number.isFinite(answer.confidence)) throw new JevContractError("confidence must be finite");
  if (answer.confidence < 0 || answer.confidence > 1) throw new JevContractError("confidence must be in [0,1]");
  return answer;
}
async function askJevNoul({ text, question, apiKey, fetch: injectedFetch, provider }) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new JevError("input_invalid", "text must be non-empty string");
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new JevError("input_invalid", "question must be non-empty string");
  }
  provider ??= bindJev({ apiKey, fetch: injectedFetch || globalThis.fetch });
  if (!provider.available) {
    throw new JevError("auth_missing", "JEV_API_KEY not provided or empty");
  }
  const body = {
    model: JEV_MODEL,
    state: text,
    questions: {
      live: {
        type: "noul",
        instructions: question
      }
    }
  };
  const { data } = await fetchAndParseResponse(body, provider);
  const model = validateModel(data.model);
  const noul = validateNoulAnswer(data.answers?.live);
  return { model, noul };
}
async function askJevChoice({ text, criteria, instructions, apiKey, fetch: injectedFetch, provider }) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new JevError("input_invalid", "text must be non-empty string");
  }
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new JevError("input_invalid", "criteria must be object");
  }
  const optionKeys = Object.keys(criteria);
  if (optionKeys.length < 2 || optionKeys.length > 255) {
    throw new JevError("input_invalid", "criteria must contain 2-255 options");
  }
  for (const [key, value] of Object.entries(criteria)) {
    if (typeof value !== "string") {
      throw new JevError("input_invalid", "criteria values must be strings");
    }
  }
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    throw new JevError("input_invalid", "instructions must be non-empty string");
  }
  provider ??= bindJev({ apiKey, fetch: injectedFetch || globalThis.fetch });
  if (!provider.available) {
    throw new JevError("auth_missing", "JEV_API_KEY not provided or empty");
  }
  const body = {
    model: JEV_MODEL,
    state: text,
    questions: {
      live: {
        type: "choice",
        criteria,
        instructions
      }
    }
  };
  const { data, questions } = await fetchAndParseResponse(body, provider);
  const model = validateModel(data.model);
  const choice = validateChoiceAnswer(data.answers?.live, Object.keys(questions.live.criteria));
  return { model, choice };
}
async function askJevScore({ text, criteria, instructions, apiKey, fetch: injectedFetch, provider }) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new JevError("input_invalid", "text must be non-empty string");
  }
  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
    throw new JevError("input_invalid", "criteria must be array with 2-10 levels");
  }
  for (let i = 0; i < criteria.length; i++) {
    if (typeof criteria[i] !== "string") {
      throw new JevError("input_invalid", "criteria values must be strings");
    }
  }
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    throw new JevError("input_invalid", "instructions must be non-empty string");
  }
  provider ??= bindJev({ apiKey, fetch: injectedFetch || globalThis.fetch });
  if (!provider.available) {
    throw new JevError("auth_missing", "JEV_API_KEY not provided or empty");
  }
  const body = {
    model: JEV_MODEL,
    state: text,
    questions: {
      live: {
        type: "score",
        criteria,
        instructions
      }
    }
  };
  const { data, questions } = await fetchAndParseResponse(body, provider);
  const model = validateModel(data.model);
  const score = validateScoreAnswer(data.answers?.live, questions.live.criteria.length, questions.live.criteria);
  return { model, score };
}
async function askJevQuestions({ state, questions, provider, signal, deadlineMs } = {}) {
  const object2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const inputInvalid = () => {
    throw new JevError("input_invalid", "Invalid named questions");
  };
  let request;
  try {
    request = JSON.parse(JSON.stringify({ state, questions }));
  } catch {
    inputInvalid();
  }
  if (!(typeof request.state === "string" ? request.state.trim().length > 0 : object2(request.state)) || !object2(request.questions) || !Object.keys(request.questions).length || deadlineMs !== void 0 && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2147483647)) inputInvalid();
  for (const [id, q] of Object.entries(request.questions)) {
    if (!id || !object2(q) || !["noul", "choice", "score"].includes(q.type) || Object.keys(q).some((key) => !["type", "instructions", "criteria"].includes(key)) || typeof q.instructions !== "string" || !q.instructions.trim()) inputInvalid();
    if (q.type === "noul") {
      if (q.criteria !== void 0) inputInvalid();
    } else if (q.type === "choice") {
      if (!object2(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255 || Object.entries(q.criteria).some(([key, value]) => !key || typeof value !== "string")) inputInvalid();
    } else if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || q.criteria.some((value) => typeof value !== "string")) inputInvalid();
  }
  if (!provider?.available) throw new JevError("auth_missing", "JEV_API_KEY not provided or empty");
  const { data, questions: expected } = await postJevQuestions(
    provider,
    { model: JEV_MODEL, ...request },
    { signal, deadlineMs }
  );
  if (!object2(data)) throw new JevContractError("provider response must be object");
  const model = validateModel(data.model);
  if (!object2(data.answers) || Object.keys(data.answers).length !== Object.keys(expected).length || Object.keys(expected).some((id) => !Object.hasOwn(data.answers, id))) {
    throw new JevContractError("answers must match question names");
  }
  const answers = Object.fromEntries(Object.entries(expected).map(([id, q]) => {
    const a = data.answers[id];
    if (q.type === "noul") return [id, { type: "noul", noul: validateNoulAnswer(a) }];
    if (q.type === "choice") {
      validateChoiceAnswer(a, Object.keys(q.criteria));
      return [id, { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: { ...a.probabilities } }];
    }
    validateScoreAnswer(a, q.criteria.length, q.criteria);
    return [id, {
      type: "score",
      score: a.score,
      legend: { ...a.legend },
      confidence: a.confidence,
      probabilities: { ...a.probabilities }
    }];
  }));
  const result = { model, answers };
  if (object2(data.usage)) result.usage = Object.fromEntries(
    ["input_tokens", "output_tokens", "total_tokens"].filter((key) => Number.isFinite(data.usage[key]) && data.usage[key] >= 0).map((key) => [key, data.usage[key]])
  );
  return result;
}

// src/batch.mjs
var MODEL = "jev-latest";
var DEADLINE_MS = 1e4;
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var own = (value, key) => Object.hasOwn(value, key);
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var JudgeProviderError = class extends Error {
  constructor(code, upstreamStatus, diagnostic) {
    super(code);
    this.name = "JudgeProviderError";
    this.code = code;
    if (code === "provider_http_error" && Number.isInteger(upstreamStatus) && upstreamStatus >= 300 && upstreamStatus <= 599) {
      this.upstreamStatus = upstreamStatus;
      if (upstreamStatus === 400 && diagnostic === "context-limit-vocabulary-observed") this.diagnostic = diagnostic;
    }
  }
};
var fail = (code, upstreamStatus, diagnostic) => {
  throw new JudgeProviderError(code, upstreamStatus, diagnostic);
};
function requestBody(request) {
  try {
    if (!object(request) || Object.keys(request).some((k) => !["state", "questions"].includes(k)) || !object(request.state) || !object(request.questions)) fail("input_invalid");
    const names = Object.keys(request.questions);
    if (!names.length) fail("input_invalid");
    const questions = Object.fromEntries(names.map((name) => {
      const q = request.questions[name];
      if (!name || !object(q) || Object.keys(q).some((k) => !["instruction", "options"].includes(k)) || typeof q.instruction !== "string" || !q.instruction.trim() || !object(q.options)) fail("input_invalid");
      const keys = Object.keys(q.options);
      if (keys.length < 2 || keys.length > 255 || keys.some((k) => !k || typeof q.options[k] !== "string")) fail("input_invalid");
      return [name, { type: "choice", criteria: { ...q.options }, instructions: q.instruction }];
    }));
    const body = JSON.stringify({ model: MODEL, state: request.state, questions });
    if (!object(JSON.parse(body).state)) fail("input_invalid");
    return body;
  } catch {
    fail("input_invalid");
  }
}
function normalize(data, questions) {
  try {
    if (!object(data) || typeof data.model !== "string" || !object(data.answers)) fail("provider_contract_error");
    const names = Object.keys(questions);
    if (Object.keys(data.answers).length !== names.length || names.some((k) => !own(data.answers, k))) fail("provider_contract_error");
    const answers = Object.fromEntries(names.map((name) => {
      const a = data.answers[name], options = questions[name].criteria;
      if (!object(a) || Object.keys(a).some((k) => !["type", "choice", "confidence", "probabilities"].includes(k)) || a.type !== "choice" || typeof a.choice !== "string" || !own(options, a.choice) || !finite(a.confidence) || a.confidence < 0 || a.confidence > 1) fail("provider_contract_error");
      const normalized = { choice: a.choice, confidence: a.confidence };
      if (a.probabilities !== void 0) {
        if (!object(a.probabilities) || Object.entries(a.probabilities).some(([key, value]) => !own(options, key) || !finite(value))) fail("provider_contract_error");
        normalized.probabilities = { ...a.probabilities };
      }
      return [name, normalized];
    }));
    return { answers };
  } catch {
    fail("provider_contract_error");
  }
}
async function judgeNamedChoices({ request, provider, signal } = {}) {
  if (!provider?.available) fail("auth_missing");
  const body = requestBody(request);
  try {
    const { data, questions } = await postJevQuestions(
      provider,
      JSON.parse(body),
      { signal, deadlineMs: DEADLINE_MS, diagnoseRejection: true }
    );
    return normalize(data, questions);
  } catch (error) {
    if (error instanceof JudgeProviderError) throw error;
    if (error instanceof JevTransportError) fail(error.code, error.status, error.diagnostic);
    fail("provider_contract_error");
  }
}
export {
  JevContractError,
  JevError,
  JudgeProviderError,
  askJevChoice,
  askJevNoul,
  askJevQuestions,
  askJevScore,
  bindJev,
  judgeNamedChoices
};
