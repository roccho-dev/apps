import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const git = process.env.VOICE_UI_REFERENCE_GIT;
const proposer = process.env.VOICE_UI_REFERENCE_PROPOSER;
const bin = process.env.VOICE_UI_SEMCMP_BIN, dist = process.env.VOICE_UI_DIST;
if (![git, proposer, bin, dist].every(p => typeof p === "string" && path.isAbsolute(p)))
  throw new Error("installed Git/proposer/semcmp and formal PRODUCT required by the Nix check");

test("same installed calculation + packaged readonly proposer + existing host port, controlled only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-reference-host-"));
  const sourcePath = "decisions/synthetic-source.jsonl";
  const gitRun = args => execFileSync(git, ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: "Synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" },
  }).toString("utf8").trim();
  gitRun(["init", "--quiet"]); fs.mkdirSync(path.join(root, "decisions"));
  const version = status => {
    const bytes = Buffer.from(JSON.stringify({ schema: "adr_raw_event.v1", raw_id: "synthetic-id", status,
      decision: { body: "SYNTHETIC_PRIVATE_BODY_NOT_SENT" } }) + "\n");
    fs.writeFileSync(path.join(root, sourcePath), bytes);
    gitRun(["add", "--", sourcePath]); gitRun(["commit", "--quiet", "-m", "synthetic source version"]);
    return { repository: "roccho-dev/adrs", directory: root, revision: gitRun(["rev-parse", "HEAD"]),
      path: sourcePath, blob: gitRun(["rev-parse", "HEAD:" + sourcePath]),
      sha256: createHash("sha256").update(bytes).digest("hex"), rawId: "synthetic-id" };
  };
  const r0 = version("proposed");
  const calls = [], hosts = [];
  const upstream = createServer(async (request, response) => {
    let text = ""; for await (const part of request) text += part;
    const input = JSON.parse(text); calls.push({ auth: request.headers.authorization, input });
    assert.equal(text.includes("SYNTHETIC_PRIVATE_BODY_NOT_SENT"), false);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: input.model,
      answers: Object.fromEntries(Object.keys(input.questions).map(k => [k, { type: "noul", noul: 0.9 }])) }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const endpoint = "http://127.0.0.1:" + upstream.address().port + "/controlled";
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  };
  const start = async (binding, options = {}, formal = false) => {
    const env = { ...process.env, PORT: "0", HOST: "127.0.0.1", JEV_API_KEY: "ambient-not-the-proposal-key" };
    for (const name of ["VOICE_UI_PROPOSAL_MODULE", "VOICE_UI_PROPOSAL_B", "VOICE_UI_PROPOSAL_JEV_URL",
      "VOICE_UI_PROPOSAL_TEST_KEY", "VOICE_UI_MELTYPE_PROPOSALS", "VOICE_UI_MELTYPE_FIXTURE"])
      delete env[name];
    if (binding) Object.assign(env, { VOICE_UI_PROPOSAL_MODULE: proposer, VOICE_UI_PROPOSAL_B: JSON.stringify(binding),
      VOICE_UI_PROPOSAL_JEV_URL: endpoint, VOICE_UI_PROPOSAL_TEST_KEY: "owned-controlled-only",
      VOICE_UI_MELTYPE_PROPOSALS: "1" });
    Object.assign(env, options);
    const entry = formal ? path.join(dist, "e2e/serve.mjs") : fileURLToPath(new URL("../dev/serve.mjs", import.meta.url));
    const child = spawn(process.execPath, formal ? [entry, "--formal"] : [entry],
      { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    hosts.push(child);
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error("host startup timeout")); }, 10000);
      let output = "", done = false;
      child.stdout.on("data", bytes => {
        output += bytes; const match = output.match(/voice-ui dev: listening on 127\.0\.0\.1:(\d+)/u);
        if (match && !done) { done = true; clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.stderr.on("data", () => {});
      child.on("error", () => { if (!done) { done = true; clearTimeout(timer); reject(Error("host failed")); } });
      child.on("exit", () => { if (!done) { done = true; clearTimeout(timer); reject(Error("host failed")); } });
    });
    return { child, url: "http://127.0.0.1:" + port };
  };
  const post = (host, value) => fetch(host.url + "/api/meltype-proposals", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  try {
    const disabled = await start(null);
    assert.equal((await post(disabled, { generation: 1, raw: "ref" })).status, 404);
    const fixed = await start(r0);
    const reply = await post(fixed, { generation: 1, raw: "ref" });
    assert.equal(reply.status, 200);
    const first = await reply.json();
    assert.equal(first.generation, 1); assert.equal(first.raw, "ref"); assert.equal(first.proposals.length, 1);
    assert.equal(first.proposals[0].representation,
      `https://github.com/roccho-dev/adrs/blob/${r0.revision}/${sourcePath}#L1`);
    assert.equal(first.proposals[0].meaning.text, first.proposals[0].representation);
    assert.equal(first.proposals[0].meaning.source.rawId, "synthetic-id");
    assert.equal(first.proposals[0].meaning.source.status, "proposed");
    assert.deepEqual(first.proposals[0].evidence, { theme: "intent-fit", noul: 0.9 });
    const r1 = version("accepted_for_proposal");
    assert.deepEqual(await (await post(fixed, { generation: 1, raw: "ref" })).json(), first,
      "host remains on the bound immutable revision, not mutable HEAD");
    await stop(fixed.child);
    const rebound = await start(r1);
    const next = await (await post(rebound, { generation: 1, raw: "ref" })).json();
    assert.notEqual(next.proposals[0].id, first.proposals[0].id);
    assert.equal(next.proposals[0].meaning.source.status, "accepted_for_proposal");
    assert.equal(next.proposals[0].meaning.authority, "reference-only");
    for (const bad of [{ generation: true, raw: "ref" }, { generation: 1, raw: "" },
      { generation: 1, raw: "ref", source: "operator-cannot-rebind-via-HTTP" }])
      assert.equal((await post(rebound, bad)).status, 400);
    const wrong = await start({ ...r1, sha256: "0".repeat(64) });
    assert.equal((await post(wrong, { generation: 2, raw: "ref" })).status, 502);
    const mixedPath = path.join(root, "synthetic-mixed-proposer.mjs");
    fs.writeFileSync(mixedPath, 'export const propose = () => [\n'
      + '{id:"text",representation:"safe",meaning:{kind:"text",text:"safe"}},\n'
      + '{id:"action",representation:"action",meaning:{kind:"action",command:"never-run"}}];\n');
    const mixed = await start(r1, { VOICE_UI_PROPOSAL_MODULE: mixedPath });
    const mixedReply = await post(mixed, { generation: 3, raw: "ref" });
    assert.equal(mixedReply.status, 502);
    assert.deepEqual(await mixedReply.json(), { error: "PROPOSAL_FAILED" }, "no text subset of a mixed response");
    const formal = await start(r1, {}, true);
    assert.equal((await post(formal, { generation: 2, raw: "ref" })).status, 404);
    await assert.rejects(start(r1, { HOST: "0.0.0.0" }), /host failed/u);
    assert.ok(calls.length >= 3);
    assert.ok(calls.every(c => c.auth === "Bearer owned-controlled-only"));
    // This proves the real installed composition with controlled ranking. It
    // is not an actual B/Native target, actual private ADR or real Provider trial.
  } finally {
    for (const child of hosts) await stop(child);
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
