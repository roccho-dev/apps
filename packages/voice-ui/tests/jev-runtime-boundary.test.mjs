import assert from "node:assert/strict";
import test from "node:test";

import { onRequestPost } from "../functions/api/jev.mjs";

const input = {
  kind: "voice-ui.jev.request.v1",
  text: "runtime boundary proof",
};

function request() {
  return new Request("https://voice-ui.example.test/api/jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function withProvider(provider, run) {
  const original = globalThis.fetch;
  globalThis.fetch = provider;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("missing target-native capability fails closed with 503", async () => {
  const response = await onRequestPost({ request: request(), env: {} });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "jev_unavailable" });
});

test("provider rejection is RED rather than a local or mock fallback", async () => {
  const response = await withProvider(
    async () => new Response("denied", { status: 401 }),
    () => onRequestPost({ request: request(), env: { JEV_API_KEY: "test-only-value" } }),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider_error" });
});

test("provider contract mismatch is RED rather than HTTP-200 success", async () => {
  const response = await withProvider(
    async () => new Response(JSON.stringify({ model: "jev-test", answers: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    () => onRequestPost({ request: request(), env: { JEV_API_KEY: "test-only-value" } }),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "provider_contract_error" });
});
