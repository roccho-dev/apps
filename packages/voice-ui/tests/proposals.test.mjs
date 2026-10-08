import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const bin = process.env.VOICE_UI_SEMCMP_BIN;
const dist = process.env.VOICE_UI_DIST;
const pkg = fileURLToPath(new URL("../", import.meta.url));
if (!bin || !path.isAbsolute(bin) || !dist || !path.isAbsolute(dist))
  throw new Error("installed semcmp binary and formal artifact must be provided by the Nix check");

const q = input => ({ input, state: { current: null, working: input, context: null }, focus: { caret: 1 } });
const candidates = [
  { id: "p1", meaning: { kind: "text", value: "A" }, representation: "同じ表示" },
  { id: "p2", meaning: { kind: "relation", from: "API", to: "DB" }, representation: "同じ表示" },
];

test("real dev host/installed CLI and shipped formal host: controlled positive and closed failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-proposal-host-"));
  const proposer = path.join(root, "proposer.mjs");
  const upstream = createServer();
  const seen = [];
  const active = [];
  const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endHost = async entry => {
    if (!entry || entry.process.exitCode !== null) return;
    const stopped = new Promise(resolve => entry.process.once("exit", resolve));
    entry.process.kill("SIGTERM");
    await stopped;
  };
  const startHost = async (formal, options = {}) => {
    const file = formal ? path.join(dist, "e2e/serve.mjs") : path.join(pkg, "dev/serve.mjs");
    const env = { ...process.env, PORT: "0", HOST: "127.0.0.1", JEV_API_KEY: "ambient-worker-only" };
    for (const name of [
      "VOICE_UI_PROPOSAL_MODULE", "VOICE_UI_PROPOSAL_JEV_URL",
      "VOICE_UI_PROPOSAL_TEST_KEY", "VOICE_UI_PROPOSAL_B", "VOICE_UI_PROPOSAL_TIMEOUT_MS",
      "VOICE_UI_MELTYPE_FIXTURE",
    ]) delete env[name];
    Object.assign(env, options);
    const child = spawn(process.execPath, formal ? [file, "--formal"] : [file], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    const entry = { process: child, url: null };
    active.push(entry);
    const port = await new Promise((resolve, reject) => {
      let output = "";
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        reject(new Error("host startup timeout"));
      }, 10000);
      child.stdout.on("data", data => {
        output += data.toString("utf8");
        const match = output.match(/voice-ui dev: listening on 127\.0\.0\.1:(\d+)/u);
        if (!match || finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      child.stderr.on("data", () => {});
      child.once("error", err => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", code => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(new Error("host exited before listen: " + code));
      });
    });
    entry.url = "http://127.0.0.1:" + port;
    return entry;
  };
  const post = (host, body, method = "POST", type = "application/json") =>
    fetch(host.url + "/api/proposals", {
      method, headers: { "content-type": type },
      body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  try {
    fs.writeFileSync(proposer, [
      "const all = " + JSON.stringify(candidates) + ";",
      "export function propose({input}) {",
      " if (process.env.VOICE_UI_PROPOSAL_B !== 'opaque-source-locator') throw Error('missing opaque locator');",
      " if (input === 'duplicate') return [all[0], all[0]];",
      " if (input === 'invalid') return [{id:'bad'}];",
      " if (input === 'throw') throw Error('private proposer error');",
      " if (input === 'hang') { setInterval(()=>{},10000); return new Promise(()=>{}); }",
      " if (input === 'u') return [];",
      " if (input === 'ux') return all;",
      " return [all[1]];",
      "}",
    ].join("\n"));
    upstream.on("request", async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString("utf8");
      let payload;
      try { payload = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
      seen.push({ auth: request.headers.authorization, payload });
      if (payload.state?.query?.input === "provider-error") {
        response.writeHead(503).end(); return;
      }
      const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, question]) => [
        key, { type: "noul", noul: question.instructions.includes('["proposal","p2"]') ? 0.95 : 0.2 },
      ]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: payload.model, answers }));
    });
    await listen(upstream);
    const endpoint = "http://127.0.0.1:" + upstream.address().port + "/test-only";
    const disabled = await startHost(false);
    assert.equal((await post(disabled, { query: q("ux") })).status, 404);
    assert.equal((await fetch(disabled.url + "/api/judge", { method: "GET" })).status, 405);
    assert.equal(seen.length, 0, "disabled capability performs no provider calls");

    const enabled = await startHost(false, {
      VOICE_UI_PROPOSAL_MODULE: proposer,
      VOICE_UI_PROPOSAL_JEV_URL: endpoint,
      VOICE_UI_PROPOSAL_TEST_KEY: "owned-synthetic-only",
      VOICE_UI_PROPOSAL_B: "opaque-source-locator",
      VOICE_UI_PROPOSAL_TIMEOUT_MS: "5000",
    });
    const first = await post(enabled, { query: q("u") });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { query: q("u"), proposals: [] });
    assert.equal(seen.length, 0, "empty is ordinary but not a provider call");
    const second = await post(enabled, { query: q("ux") });
    assert.equal(second.status, 200);
    const ranked = await second.json();
    assert.deepEqual(ranked.query, q("ux"));
    assert.deepEqual(ranked.proposals.map(p => p.id), ["p2", "p1"]);
    assert.deepEqual(ranked.proposals.map(({ evidence, ...raw }) => raw)
      .sort((a, b) => a.id.localeCompare(b.id)), candidates);
    assert.ok(ranked.proposals.every(p => p.evidence.theme === "intent-fit" && Number.isFinite(p.evidence.noul)));
    const changed = await post(enabled, { query: q("changed") });
    assert.equal(changed.status, 200);
    assert.deepEqual((await changed.json()).proposals.map(p => p.id), ["p2"]);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].payload.state.query, q("ux"));
    assert.deepEqual(seen[0].payload.state.proposals, candidates);
    assert.ok(seen.every(r => r.payload.model === "jev-1.13.0"
      && !JSON.stringify(r).includes("ambient-worker-only")
      && String(r.auth).includes("owned-synthetic-only")), "the installed CLI has only its owned test credential");

    for (const [body, expected] of [
      [{ query: q("duplicate") }, 502],
      [{ query: q("invalid") }, 502],
      [{ query: q("throw") }, 502],
      [{ query: { input: "x" } }, 400],
      [{ query: q("ux"), extra: true }, 400],
      ["{", 400],
    ]) {
      const result = await post(enabled, body);
      assert.equal(result.status, expected);
      assert.ok((await result.json()).error);
    }
    assert.equal((await post(enabled, { query: q("ux") }, "GET")).status, 405);
    assert.equal((await post(enabled, { query: q("ux") }, "POST", "text/plain")).status, 415);
    assert.equal((await post(enabled, "x".repeat(33000))).status, 413);
    const refused = await post(enabled, { query: q("provider-error") });
    assert.equal(refused.status, 502);
    assert.deepEqual(await refused.json(), { error: "PROPOSAL_FAILED" });

    const slow = await startHost(false, {
      VOICE_UI_PROPOSAL_MODULE: proposer, VOICE_UI_PROPOSAL_JEV_URL: endpoint,
      VOICE_UI_PROPOSAL_TEST_KEY: "owned-synthetic-only",
      VOICE_UI_PROPOSAL_B: "opaque-source-locator", VOICE_UI_PROPOSAL_TIMEOUT_MS: "250",
    });
    const expired = await post(slow, { query: q("hang") });
    assert.equal(expired.status, 504);
    assert.deepEqual(await expired.json(), { error: "PROPOSAL_TIMEOUT" });

    // Force a UTF-8 character to straddle two real child stdout writes.
    // This supplements (never replaces) the installed CLI/Jev path above.
    const splitProgram = path.join(root, "split-stdout.mjs");
    const splitBinary = path.join(root, "split-binary");
    const unicode = "橋🍣";
    const synthetic = {
      query: q("ux"),
      proposals: [{ id: "unicode", meaning: { kind: "text", value: unicode },
        representation: unicode, evidence: { theme: "intent-fit", noul: 0.9 } }],
    };
    const syntheticBody = JSON.stringify(synthetic);
    fs.writeFileSync(splitProgram, [
      "const bytes = Buffer.from(" + JSON.stringify(syntheticBody) + ", 'utf8');",
      "const marker = Buffer.from('🍣', 'utf8');",
      "const at = bytes.indexOf(marker);",
      "if (at < 0) throw Error('missing UTF-8 split marker');",
      "process.stdout.write(bytes.subarray(0, at + 1));",
      "setTimeout(() => process.stdout.write(bytes.subarray(at + 1)), 75);",
    ].join("\n"));
    fs.writeFileSync(splitBinary, "#!/bin/sh\nexec " + JSON.stringify(process.execPath)
      + " " + JSON.stringify(splitProgram) + ' "$@"\n', { mode: 0o700 });
    fs.chmodSync(splitBinary, 0o700);
    const fragmented = await startHost(false, {
      VOICE_UI_SEMCMP_BIN: splitBinary, VOICE_UI_PROPOSAL_MODULE: proposer,
      VOICE_UI_PROPOSAL_JEV_URL: endpoint,
      VOICE_UI_PROPOSAL_TEST_KEY: "owned-synthetic-only",
      VOICE_UI_PROPOSAL_B: "opaque-source-locator",
    });
    const unicodeResponse = await post(fragmented, { query: q("ux") });
    assert.equal(unicodeResponse.status, 200);
    assert.deepEqual(await unicodeResponse.json(), {
      query: q("ux"), proposals: synthetic.proposals,
    }, "a split inside one emoji must preserve both typed meaning and representation");
    const beforeFixtureProviderCalls = seen.length;
    // A separate real HTTP route speaks the existing Windows Meltype wire.
    // The source fixture is explicit, not a catalog, Jev output, or B/current.
    const fixturePath = path.join(pkg, "tests/fixtures/proposals.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.equal(fixture.schema, "voice-ui.meltype-fixture/1");
    assert.deepEqual(fixture.scenes.map(scene => scene.id), [
      "partial", "append-delete", "compare-identity", "multiline-native", "none-delay-cancel",
    ]);
    assert.equal(fixture.scenes.flatMap(scene => scene.steps).length, 11);
    const fixtureCase = raw => fixture.scenes.flatMap(scene => scene.steps).find(step => step.raw === raw);
    const postFixture = (server, body, method = "POST", type = "application/json", signal) =>
      fetch(server.url + "/api/meltype-fixture", {
        method, headers: { "content-type": type }, signal,
        body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    assert.equal((await postFixture(disabled, { generation: 1, raw: "か" })).status, 404);
    assert.equal((await postFixture(enabled, { generation: 1, raw: "か" })).status, 404);

    const fixtureHost = await startHost(false, { VOICE_UI_MELTYPE_FIXTURE: fixturePath });
    const fetchCase = async (generation, raw) => {
      const result = await postFixture(fixtureHost, { generation, raw });
      assert.equal(result.status, 200, "fixture scene must be explicitly declared: " + raw);
      const response = await result.json();
      assert.deepEqual(response, {
        generation, raw, proposals: fixtureCase(raw).proposals,
      }, "Meltype round-trip must retain source typed payload");
      return response;
    };
    const partial = await fetchCase(1, "か");
    assert.deepEqual(partial.proposals.map(p => p.id), [
      "fixture:partial:draft", "fixture:partial:task",
    ], "a single incomplete character is eligible");
    const added = await fetchCase(2, "かく");
    assert.deepEqual(added.proposals.map(p => p.id), ["fixture:partial:draft"]);
    const diagram = await fetchCase(3, "図");
    assert.deepEqual(diagram.proposals.map(p => p.id), ["fixture:diagram:outline"]);
    const append = await fetchCase(4, "図に");
    assert.deepEqual(append.proposals.map(p => p.id), [
      "fixture:diagram:edge", "fixture:diagram:note",
    ]);
    assert.deepEqual((await fetchCase(5, "図に矢")).proposals.map(p => p.id), ["fixture:diagram:edge"]);
    assert.deepEqual(await fetchCase(6, "図に"), {
      generation: 6, raw: "図に", proposals: append.proposals,
    }, "deleting input recreates exactly the same offered choice, not an older generation");
    const compared = await fetchCase(7, "依頼");
    assert.equal(compared.proposals.length, 2);
    assert.equal(compared.proposals[0].representation, compared.proposals[1].representation);
    assert.notEqual(compared.proposals[0].id, compared.proposals[1].id);
    assert.notDeepEqual(compared.proposals[0].meaning, compared.proposals[1].meaning);
    assert.ok(compared.proposals.every(p => p.evidence.source === "fixture"), "manual reasons are not Jev");
    const multiline = await fetchCase(8, "議事録");
    assert.equal(multiline.proposals[0].representation, "件名：検討 🍣\n- 案A\n- 案B\n");
    assert.deepEqual(multiline.proposals[0].meaning.lines, [
      "件名：検討 🍣", "- 案A", "- 案B", "",
    ]);
    assert.deepEqual((await fetchCase(9, "候補なし")).proposals, []);
    assert.deepEqual((await fetchCase(10, "取消")).proposals, []);

    const arrivals = [];
    const older = postFixture(fixtureHost, { generation: 41, raw: "遅" })
      .then(async response => {
        assert.equal(response.status, 200);
        arrivals.push("old");
        return response.json();
      });
    await new Promise(resolve => setTimeout(resolve, 30));
    const newer = postFixture(fixtureHost, { generation: 42, raw: "遅延後" })
      .then(async response => {
        assert.equal(response.status, 200);
        arrivals.push("new");
        return response.json();
      });
    const [oldResponse, newResponse] = await Promise.all([older, newer]);
    assert.deepEqual(arrivals, ["new", "old"], "server exposes reverse completion without overriding current UI generation");
    assert.deepEqual(oldResponse, {
      generation: 41, raw: "遅", proposals: fixtureCase("遅").proposals,
    });
    assert.deepEqual(newResponse, {
      generation: 42, raw: "遅延後", proposals: fixtureCase("遅延後").proposals,
    });
    for (const [body, status] of [
      [{ raw: "か" }, 400],
      [{ generation: 0, raw: "か" }, 400],
      [{ generation: -1, raw: "か" }, 400],
      [{ generation: 1.5, raw: "か" }, 400],
      [{ generation: Number.MAX_SAFE_INTEGER + 1, raw: "か" }, 400],
      [{ generation: "1", raw: "か" }, 400],
      [{ generation: 1, raw: "" }, 400],
      [{ generation: 1, raw: "か", extra: true }, 400],
      ["{", 400],
      [{ generation: 1, raw: "missing from fixture" }, 404],
    ]) {
      const result = await postFixture(fixtureHost, body);
      assert.equal(result.status, status);
      assert.ok((await result.json()).error, "rejected case must not impersonate an empty success");
    }
    assert.equal((await postFixture(fixtureHost, { generation: 1, raw: "か" }, "GET")).status, 405);
    assert.equal((await postFixture(fixtureHost, { generation: 1, raw: "か" }, "POST", "text/plain")).status, 415);
    assert.equal((await postFixture(fixtureHost, "a".repeat(17000))).status, 413);
    assert.equal((await post(fixtureHost, { query: q("ux") })).status, 404);
    assert.equal((await fetch(fixtureHost.url + "/api/judge", { method: "GET" })).status, 405);
    assert.equal(seen.length, beforeFixtureProviderCalls,
      "fixture route may never invoke controlled Jev/provider");
    // Invalid operator fixture dies at startup, before any TCP listener.
    const damaged = path.join(root, "invalid-fixture.json");
    fs.writeFileSync(damaged, JSON.stringify({
      ...fixture, scenes: [{
        ...fixture.scenes[2],
        steps: [{
          ...fixture.scenes[2].steps[0],
          proposals: [fixture.scenes[2].steps[0].proposals[0],
            fixture.scenes[2].steps[0].proposals[0]],
        }],
      }],
    }));
    await assert.rejects(startHost(false, { VOICE_UI_MELTYPE_FIXTURE: damaged }),
      /host exited before listen/);
    // The provided formal PRODUCT has no fixture JSON or dev-only route.
    // Source-fixture success MUST NOT be promoted to supplied-artifact readiness.
    assert.equal(fs.existsSync(path.join(dist, "e2e/fixtures/proposals.json")), false,
      "missing delivery is an explicit boundary, not a synthesized attachment");
    // This exact PRODUCT source has e2e/serve.mjs but no dev sibling.
    assert.equal(fs.existsSync(path.join(dist, "e2e/proposals.mjs")), false);
    const formal = await startHost(true, {
      VOICE_UI_MELTYPE_FIXTURE: fixturePath,
      VOICE_UI_PROPOSAL_MODULE: proposer, VOICE_UI_PROPOSAL_JEV_URL: endpoint,
      VOICE_UI_PROPOSAL_TEST_KEY: "owned-synthetic-only",
    });
    assert.equal((await postFixture(formal, { generation: 1, raw: "か" })).status, 404);
    assert.equal((await post(formal, { query: q("ux") })).status, 404);
    assert.equal((await fetch(formal.url + "/api/judge", { method: "GET" })).status, 405);
  } finally {
    for (const server of active.reverse()) await endHost(server);
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
