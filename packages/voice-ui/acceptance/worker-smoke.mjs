import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const workerPath = process.argv[2];
assert.ok(workerPath, "compiled worker path is required");
const worker = (await import(pathToFileURL(workerPath))).default;
assert.equal(typeof worker.fetch, "function");
let providerCalls = 0;
const original = globalThis.fetch;
globalThis.fetch = () => { providerCalls++; throw new Error("unexpected external request"); };
try {
  const missing = await worker.fetch(new Request("https://voice-ui.invalid/api/judge", {method:"POST",body:"{}"}), {});
  assert.equal(missing.status,503);
  assert.equal((await missing.json()).error,"judge_unavailable");
  const invalid = await worker.fetch(new Request("https://voice-ui.invalid/api/judge", {method:"POST",body:"not json"}), {JEV_API_KEY:"nonsecret-fixture-never-used"});
  assert.equal(invalid.status,400);
  const method = await worker.fetch(new Request("https://voice-ui.invalid/api/judge"), {});
  assert.equal(method.status,405);
  let staticCalls=0;
  const request=new Request("https://voice-ui.invalid/app.mjs");
  const asset=await worker.fetch(request,{ASSETS:{fetch(r){assert.equal(r,request);staticCalls++;return new Response("exact asset");}}});
  assert.equal(await asset.text(),"exact asset");
  assert.equal(staticCalls,1);
  assert.equal(providerCalls,0);
  console.log("compiled app Worker: routing, missing-auth and bad-input boundaries PASS; live calls 0");
} finally { globalThis.fetch=original; }
