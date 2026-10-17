// Finalize once so the append-only receipt and the arm's call record agree.
export async function evaluationPost({ url, event, record, fetchFn = globalThis.fetch, now = () => performance.now() }) {
  const started = now(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), event.route === "/api/parts/complete" ? 40000 : 15000);
  try {
    const response = await fetchFn(url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify(event.request), signal: controller.signal });
    event.status = response.status;
    event.response = await response.json();
    if (!response.ok) throw new Error("evaluation_http");
    return event.response;
  } catch {
    event.error = "http_or_contract_unknown";
    throw new Error("evaluation_http");
  } finally {
    clearTimeout(timer);
    event.elapsedMs = now() - started;
    const { id, arm, n, status = null, response, error, elapsedMs } = event;
    record({ kind: "http-end", id, arm, n, status,
      ...(Object.hasOwn(event, "response") ? { response } : {}), ...(error ? { error } : {}), elapsedMs });
  }
}
