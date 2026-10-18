// Every v2 stage shares a bounded server deadline; this caller allows transport margin.
export async function evaluationPost({ url, event, record, fetchFn = globalThis.fetch, now = () => performance.now() }) {
  const started = now(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetchFn(url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify(event.request), signal: controller.signal });
    event.status = response.status; event.response = await response.json();
    if (!response.ok) throw new Error("evaluation_http");
    return event.response;
  } catch {
    event.error = "http_or_contract_unknown";
    throw new Error("evaluation_http");
  } finally {
    clearTimeout(timer); event.status ??= null; event.elapsedMs = now() - started;
    record({ kind: "http-end", id: event.id, arm: event.arm, n: event.n, status: event.status,
      ...(Object.hasOwn(event, "response") ? { response: event.response } : {}),
      ...(event.error ? { error: event.error } : {}), elapsedMs: event.elapsedMs });
  }
}
