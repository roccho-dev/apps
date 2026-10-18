// src/typellm.mjs
var ENDPOINT = "https://api.typellm.ai/v1/generate";
var MAX_REQUEST = 128 * 1024;
var MAX_RESPONSE = 1024 * 1024;
var encoder = new TextEncoder();
var object = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
var name = (x) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(x) && !["__proto__", "constructor", "prototype"].includes(x);
var keys = (x, allowed) => object(x) && Object.keys(x).every((k) => allowed.includes(k));
var TypedProviderError = class extends Error {
  constructor(code, status) {
    super(code);
    this.name = "TypedProviderError";
    this.code = code;
    if (code === "provider_http_error" && Number.isInteger(status) && status >= 300 && status <= 599)
      this.upstreamStatus = status;
  }
};
var fail = (code, status) => {
  throw new TypedProviderError(code, status);
};
function validateDependencies(questions) {
  const leaves = [];
  const walk = (definitions, inherited) => {
    const scope = new Map(Object.entries(definitions).map(([key, field]) => [key, { field, leaves: [] }]));
    for (const entry of scope.values()) {
      const { field } = entry;
      let rules = inherited;
      if (field.depends_on !== void 0) {
        const names = field.depends_on;
        if (!Array.isArray(names) || names.length > 64 || new Set(names).size !== names.length || names.some((key) => typeof key !== "string" || !scope.has(key) || scope.get(key).field.type === "array"))
          fail("input_invalid");
        rules = [...inherited, { scope, names }];
      }
      if (field.type === "object") entry.leaves.push(...walk(field.properties, rules));
      else if (field.type !== "array") {
        const leaf = { rules, dependencies: /* @__PURE__ */ new Set() };
        entry.leaves.push(leaf);
        leaves.push(leaf);
      }
    }
    return [...scope.values()].flatMap((entry) => entry.leaves);
  };
  walk(questions, []);
  for (const leaf of leaves)
    for (const { scope, names } of leaf.rules)
      for (const key of names)
        for (const dependency of scope.get(key).leaves) leaf.dependencies.add(dependency);
  const pending = new Set(leaves);
  while (pending.size) {
    const ready = [...pending].filter((leaf) => [...leaf.dependencies].every((dependency) => !pending.has(dependency)));
    if (!ready.length) fail("input_invalid");
    for (const leaf of ready) pending.delete(leaf);
  }
}
function validateRequest(request) {
  if (!keys(request, ["context", "questions"]) || typeof request.context !== "string" || !request.context.trim() || !object(request.questions)) fail("input_invalid");
  let count = 0;
  const fields = (definitions, depth, inArray = false) => {
    if (!object(definitions) || !Object.keys(definitions).length) fail("input_invalid");
    for (const [key, field] of Object.entries(definitions)) {
      if (!name(key) || ++count > 64) fail("input_invalid");
      schema(field, depth, inArray);
    }
  };
  const schema = (s, depth, inArray) => {
    if (depth > 6 || !keys(s, ["type", "instructions", "enum", "properties", "items", "minItems", "maxItems", "depends_on", "thinking", "thinking_budget"]))
      fail("input_invalid");
    if (s.depends_on !== void 0 && (inArray || s.type === "array")) fail("input_invalid");
    if (s.instructions !== void 0 && (typeof s.instructions !== "string" || s.instructions.length > 8192))
      fail("input_invalid");
    if (!["string", "boolean", "integer", "number", "object", "array"].includes(s.type)) fail("input_invalid");
    if (s.thinking !== void 0 || s.thinking_budget !== void 0) {
      if (depth !== 0 || inArray || ["object", "array"].includes(s.type) || typeof s.thinking !== "boolean") fail("input_invalid");
      if (s.thinking ? !Number.isInteger(s.thinking_budget) || s.thinking_budget < 1 || s.thinking_budget > 4096 : s.thinking_budget !== void 0) fail("input_invalid");
    }
    if (s.enum !== void 0 && (s.type !== "string" || !Array.isArray(s.enum) || s.enum.length < 2 || s.enum.length > (inArray ? 26 : 64) || s.enum.some((x) => typeof x !== "string" || !x.length || x.length > 2048) || new Set(s.enum).size !== s.enum.length)) fail("input_invalid");
    if (s.type === "object") fields(s.properties, depth + 1, inArray);
    else if (s.properties !== void 0) fail("input_invalid");
    if (s.type === "array") {
      if (depth !== 0 || inArray || !Number.isInteger(s.maxItems) || s.maxItems < 1 || s.maxItems > 32 || !Number.isInteger(s.minItems) || s.minItems < 0 || s.minItems > s.maxItems) fail("input_invalid");
      schema(s.items, depth + 1, true);
    } else if (["items", "minItems", "maxItems"].some((k) => s[k] !== void 0)) fail("input_invalid");
  };
  fields(request.questions, 0);
  validateDependencies(request.questions);
  let body;
  try {
    body = JSON.stringify({
      context: request.context,
      // Containers keep the hosted default off. Only top-level scalars may
      // explicitly opt in, with a validated budget; existing requests stay off.
      questions: Object.fromEntries(Object.entries(request.questions).map(([key, s]) => [
        key,
        ["object", "array"].includes(s.type) ? s : { ...s, thinking: s.thinking ?? false }
      ])),
      model: "typellm-latest",
      options: { temperature: 0 },
      timeout: 30
    });
  } catch {
    fail("input_invalid");
  }
  if (encoder.encode(body).byteLength > MAX_REQUEST) fail("input_invalid");
  return { body, questions: JSON.parse(body).questions };
}
function answer(s, value) {
  switch (s.type) {
    case "string":
      if (typeof value !== "string" || value.length > 2048 || s.enum && !s.enum.includes(value)) fail("provider_contract_error");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail("provider_contract_error");
      break;
    case "integer":
      if (!Number.isSafeInteger(value)) fail("provider_contract_error");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("provider_contract_error");
      break;
    case "object":
      return answers(s.properties, value);
    case "array":
      if (!Array.isArray(value) || value.length < s.minItems || value.length > s.maxItems) fail("provider_contract_error");
      return value.map((x) => answer(s.items, x));
  }
  return value;
}
function answers(questions, result) {
  if (!object(result) || Object.keys(result).length !== Object.keys(questions).length || !Object.keys(result).every((k) => Object.hasOwn(questions, k))) fail("provider_contract_error");
  return Object.fromEntries(Object.entries(questions).map(([key, s]) => [key, answer(s, result[key])]));
}
function bindTypeLLM({ apiKey, fetch: fetchFn = globalThis.fetch, deadlineMs = 35e3 } = {}) {
  const available = typeof apiKey === "string" && apiKey.length > 0;
  return Object.freeze({
    available,
    async post(body, { signal } = {}) {
      if (!available) fail("auth_missing");
      if (typeof fetchFn !== "function") fail("provider_unavailable");
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 95e3) fail("input_invalid");
      if (signal?.aborted) fail("cancelled");
      const controller = new AbortController();
      let timer, abort, reader, complete = false;
      const stopped = new Promise((_, reject) => {
        const stop = (code) => {
          controller.abort();
          try {
            Promise.resolve(reader?.cancel()).catch(() => {
            });
          } catch {
          }
          reject(new TypedProviderError(code));
        };
        timer = setTimeout(() => stop("provider_timeout"), deadlineMs);
        abort = () => stop("cancelled");
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      const call = (async () => {
        let response;
        try {
          response = await fetchFn(ENDPOINT, {
            method: "POST",
            redirect: "error",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body,
            signal: controller.signal
          });
        } catch {
          fail("provider_unavailable");
        }
        if (controller.signal.aborted) {
          try {
            Promise.resolve(response?.body?.cancel()).catch(() => {
            });
          } catch {
          }
          fail("cancelled");
        }
        if (!response?.ok) {
          controller.abort();
          fail("provider_http_error", response?.status);
        }
        try {
          reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) {
              complete = true;
              break;
            }
            if (!(value instanceof Uint8Array) || !value.byteLength || (size += value.byteLength) > MAX_RESPONSE)
              fail("provider_invalid_response");
            chunks.push(value);
          }
          if (!complete) fail("provider_invalid_response");
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          fail("provider_invalid_response");
        }
      })();
      try {
        return await Promise.race([call, stopped]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!complete) {
          try {
            Promise.resolve(reader?.cancel()).catch(() => {
            });
          } catch {
          }
        }
        try {
          reader?.releaseLock();
        } catch {
        }
      }
    }
  });
}
async function generateTyped({ request, provider, signal } = {}) {
  const { body, questions } = validateRequest(request);
  if (!provider?.available) fail("auth_missing");
  const raw = await provider.post(body, { signal });
  if (!object(raw) || raw.status !== void 0 && raw.status !== "completed" || raw.skipped !== void 0 && (!Array.isArray(raw.skipped) || raw.skipped.length)) fail("provider_contract_error");
  const normalized = { result: answers(questions, raw.result) };
  if (raw.usage !== void 0) {
    if (!object(raw.usage) || ![raw.usage.input_tokens, raw.usage.thinking_tokens].every((x) => Number.isSafeInteger(x) && x >= 0))
      fail("provider_contract_error");
    normalized.usage = { input_tokens: raw.usage.input_tokens, thinking_tokens: raw.usage.thinking_tokens };
  }
  if (raw.elapsed !== void 0) {
    if (typeof raw.elapsed !== "number" || !Number.isFinite(raw.elapsed) || raw.elapsed < 0) fail("provider_contract_error");
    normalized.elapsed = raw.elapsed;
  }
  return normalized;
}
export {
  TypedProviderError,
  bindTypeLLM,
  generateTyped
};
