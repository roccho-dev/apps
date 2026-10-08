import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createAcquisition, proposalHttp } from "../dev/proposals.mjs";

const binary = process.env.VOICE_UI_SEMCMP_BIN;
if (!binary || !path.isAbsolute(binary)) throw new Error("installed semcmp binary required");
const q = input => ({ input, state: { current: null, working: input, context: null }, focus: { caret: 1 } });
const originals = [
  { id: "p1", meaning: { kind: "text", value: "A" }, representation: "同じ表示" },
  { id: "p2", meaning: { kind: "relation", from: "API", to: "DB" }, representation: "同じ表示" },
];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-proposals-"));
const proposer = path.join(root, "propose.mjs");
const trace = path.join(root, "fetch.jsonl");
const preload = path.join(root, "preload.mjs");
const wrapper = path.join(root, "semcmp-wrapper");
const invalid = path.join(root, "invalid-wrapper");
const url = "http://127.0.0.1:9/test-only";
const project = [
  "const all = " + JSON.stringify(originals) + ";",
  "export function propose({input}) {",
  "  if(input==='bad') return [all[0], all[0]];",
  "  if(input==='broken') throw new Error('private proposer detail');",
  "  return input==='u' ? [] : input==='ux' ? all : [all[1]];",
  "}",
].join("\n");
fs.writeFileSync(proposer, project);
fs.writeFileSync(preload, [
  'import fs from "node:fs";',
  "globalThis.fetch = async (url, options) => {",
  " const payload = JSON.parse(options.body);",
  " fs.appendFileSync(" + JSON.stringify(trace) + ', JSON.stringify({url: String(url), payload})+"\\n");',
  ' const answers=Object.fromEntries(Object.entries(payload.questions).map(([id,q])=>[id,{type:"noul",noul:q.instructions.includes(\'["proposal","p2"]\')?0.95:0.2}]));',
  " return {ok:true,json:async()=>({model:payload.model,answers})};",
  "};",
].join("\n"));
fs.writeFileSync(wrapper,
  "#!/bin/sh\nNODE_OPTIONS=" + JSON.stringify("--import=" + preload)
    + " exec " + JSON.stringify(binary) + ' "$@"\n', { mode: 0o700 });
fs.chmodSync(wrapper, 0o700);
fs.writeFileSync(invalid, "#!/bin/sh\nprintf invalid\n", { mode: 0o700 });
fs.chmodSync(invalid, 0o700);

const env = {
  JEV_API_KEY: "owned-synthetic-key", JEV_API_URL: url, JEV_TIMEOUT_MS: "3000",
};
const acquire = createAcquisition({ binary: wrapper, proposer, url, controlledEnv: env, timeoutMs: 5000 });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("real installed CLI: one character, changed query, original opaque typed records and order", async () => {
  const first = await acquire(q("u"));
  assert.deepEqual(first, { query: q("u"), proposals: [] });
  assert.equal(fs.existsSync(trace), false, "empty must not call Jev");
  const second = await acquire(q("ux"));
  assert.deepEqual(second.query, q("ux"));
  assert.deepEqual(second.proposals.map(({ evidence, ...rest }) => rest).sort((a,b) => a.id.localeCompare(b.id)), originals);
  assert.deepEqual(second.proposals.map(p => p.id), ["p2", "p1"]);
  assert.ok(second.proposals.every(p => p.evidence.theme === "intent-fit" && Number.isFinite(p.evidence.noul)));
  const third = await acquire(q("x"));
  assert.deepEqual(third.query, q("x"));
  assert.deepEqual(third.proposals.map(p => p.id), ["p2"]);
  const recorded = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(recorded.length, 2, "only controlled positive evaluations made provider requests");
  assert.ok(recorded.every(r => r.url === url && r.payload.model === "jev-1.13.0"));
  assert.deepEqual(recorded[0].payload.state.query, q("ux"));
  assert.deepEqual(recorded[0].payload.state.proposals, originals);
});

test("malformed/duplicate/proposer failure, invalid key/endpoint, bounded child failure/timeout", async () => {
  await assert.rejects(acquire({ input: "bad" }), { code: "INVALID_QUERY" });
  await assert.rejects(acquire(q("bad")), { code: "PROPOSAL_FAILED" });
  await assert.rejects(acquire(q("broken")), { code: "PROPOSAL_FAILED" });
  const malformed = createAcquisition({ binary: invalid, proposer, url, controlledEnv: env });
  await assert.rejects(malformed(q("x")), { code: "PROPOSAL_FAILED" });
  assert.throws(() => createAcquisition({ binary, proposer, url, controlledEnv: { ...env, JEV_API_KEY: "" } }), {code:"PROPOSAL_CONFIG_INVALID"});
  assert.throws(() => createAcquisition({ binary, proposer, url:"https://api.typesafe.ai/v1/systemone", controlledEnv: env }),{code:"PROPOSAL_CONFIG_INVALID"});
  const sleeper = path.join(root, "sleeper");
  fs.writeFileSync(sleeper, "#!" + process.execPath + "\nsetTimeout(()=>{},10000);\n", {mode:0o700});
  fs.chmodSync(sleeper, 0o700);
  const timed = createAcquisition({ binary:sleeper, proposer, url, controlledEnv: env, timeoutMs:80 });
  await assert.rejects(timed(q("ux")), { code:"PROPOSAL_TIMEOUT" });
});

test("bounded HTTP adapter: exact query, method/shape/content/size, failure closed", async () => {
  const req = (body, method="POST", type="application/json") =>
    Object.assign(Readable.from([typeof body === "string" ? body : JSON.stringify(body)]),
      { method, headers: { "content-type": type } });
  const ok = await proposalHttp(req({query:q("ux")}), acquire);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.query, q("ux"));
  assert.deepEqual(ok.body.proposals.map(p=>p.id), ["p2","p1"]);
  assert.equal((await proposalHttp(req({query:{raw:"ux"}}),acquire)).status, 400);
  assert.equal((await proposalHttp(req({query:q("ux"),proposals:[]}),acquire)).status, 400);
  assert.equal((await proposalHttp(req("{"),acquire)).status, 400);
  assert.equal((await proposalHttp(req({query:q("ux")},"GET"),acquire)).status, 405);
  assert.equal((await proposalHttp(req({query:q("ux")},"POST","text/plain"),acquire)).status, 415);
  assert.equal((await proposalHttp(req("a".repeat(33000)),acquire)).status, 413);
  assert.deepEqual(await proposalHttp(req({query:q("broken")}),acquire),
    { status:502, body:{error:"PROPOSAL_FAILED"} });
});

test("formal copy contains no dev proposer; optional import remains guarded by formalRoot", () => {
  const serve = fs.readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "dev/serve.mjs"),"utf8");
  assert.match(serve,/!formalRoot && process\.env\.VOICE_UI_PROPOSAL_MODULE/);
  assert.match(serve,/await import\("\.\/proposals\.mjs"\)/);
  const dist = fs.readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "dist.py"),"utf8");
  assert.match(dist,/copy_file\(app \/ "dev\/serve\.mjs", out \/ "e2e\/serve\.mjs"\)/);
  assert.doesNotMatch(dist,/copy_file\(app \/ "dev\/proposals\.mjs"/);
});
