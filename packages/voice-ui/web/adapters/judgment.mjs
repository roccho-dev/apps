import { DECISION_KIND, ERRORS } from "/app/src/contract.mjs";
const TIMEOUT_MS = 15000;
const failed = (reason, detail = null) => Object.freeze({ kind: "failed", reason, detail });
// HTTP is one concrete binding, not application meaning. No provider wire or key.
export const createJudgment = ({ fetchImpl = globalThis.fetch } = {}) => async request => {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(failed("judge-timeout", "15 s")); }, TIMEOUT_MS);
  });
  const operation = (async () => {
   try {
    const response = await fetchImpl("/api/judge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(request), signal: controller.signal,
    });
    if (!response.ok) {
      const code = (await response.json().catch(() => null))?.error;
      return failed("judge-failed", Object.values(ERRORS).includes(code) ? code : "http_error");
    }
    const value = await response.json().catch(() => null);
    if (value?.kind !== DECISION_KIND || value.answers === null || typeof value.answers !== "object" || Array.isArray(value.answers)
      || Object.keys(value).some(key => !["kind", "answers"].includes(key))) return failed("judge-contract");
    return Object.freeze({ kind: "answered", decision: value });
  } catch {
    return controller.signal.aborted ? failed("judge-timeout", "15 s") : failed("judge-failed", "network_error");
   }
  })();
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
};
