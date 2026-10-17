import assert from "node:assert/strict";
import test from "node:test";
import { evaluationPost } from "./evaluation-http.mjs";

test("HTTP receipts retain failed status/body and finalize matching call fields exactly once", async () => {
  for (const [status, mode] of [[200, "json"], [502, "json"], [503, "invalid-json"], [null, "transport"]]) {
    const event = { id: "sample", arm: "C", n: 1, route: "/api/parts/complete", request: { fixture: true } };
    const records = []; let tick = 0;
    const execute = evaluationPost({ url: "http://127.0.0.1:18845/api/parts/complete", event,
      record: value => records.push(structuredClone(value)), now: () => ++tick,
      fetchFn: async () => {
        if (mode === "transport") throw Error("private failure");
        return { status, ok: status === 200, json: async () => {
          if (mode === "invalid-json") throw Error("private body");
          return { error: "parts_contract" };
        } };
      } });
    if (status === 200) assert.deepEqual(await execute, { error: "parts_contract" });
    else await assert.rejects(execute, /evaluation_http/u);
    assert.equal(records.length, 1);
    const { request, route, ...fields } = event;
    assert.deepEqual(records[0], { kind: "http-end", ...fields, status });
    assert.equal(event.elapsedMs, 1);
    assert.equal(Object.hasOwn(event, "response"), mode === "json");
    assert.equal(event.error, status === 200 ? undefined : "http_or_contract_unknown");
  }
});
