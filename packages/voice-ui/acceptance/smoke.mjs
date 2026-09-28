import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// Real packaged entry + real Chromium; only the endpoint is a controlled negative.
// Never emits an application PASS or contacts Jev/Cloudflare.
const [runtime, root] = process.argv.slice(2);
assert.ok(path.isAbsolute(runtime) && path.isAbsolute(root));
const bytes = readFileSync(path.join(root, "manifest.json"));
const manifest = JSON.parse(bytes);
const digest = createHash("sha256").update(bytes).digest("hex");
let providerCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/api/jev" && req.method === "POST") {
    providerCalls++;
    req.resume();
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "jev_unavailable" }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><script>window.voiceUiReady=true</script>");
  }
});
const work = mkdtempSync(path.join(tmpdir(), "voice-ui-boundary-"));
let child;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${server.address().port}/`;
  for (let run = 1; run <= 2; run++) {
    const home = path.join(work, `run-${run}`);
    mkdirSync(home);
    const receipt = path.join(home, "receipt.json");
    const before = providerCalls;
    const output = await new Promise((resolve, reject) => {
      child = spawn(runtime, [path.join(root, manifest.e2e.runtime_entrypoint),
        "--artifact-root", root, "--url", target, "--expected-apps-sha", manifest.sources.apps,
        "--expected-manifest-sha256", digest, "--handoff-id", `ci-boundary/${run}`, "--receipt", receipt],
      { cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: "C.UTF-8" }, detached: true });
      let stderr = "", stdout = "";
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        reject(new Error("acceptance boundary timed out"));
      }, 60000);
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, stderr, stdout }); });
    });
    assert.equal(output.code, 1, output.stderr);
    assert.equal(providerCalls - before, 1, output.stderr);
    assert.doesNotMatch(output.stderr, /ERR_MODULE_NOT_FOUND|Executable doesn't exist|browserType.launch:/);
    const result = JSON.parse(readFileSync(receipt));
    assert.equal(result.status, "RED");
    assert.equal(result.stage, "application-e2e");
    assert.equal(result.sources.artifactManifestSha256, digest);
    assert.equal(result.checks.find(row => row.id === "public-application-e2e").status, "RED");
    assert.deepEqual(result.dependencies.secretInputs, []);
  }
  console.log(JSON.stringify({ kind: "voice-ui.acceptanceBoundaryCheck.v1", status: "PASS",
    independentStarts: 2, controlledProviderCalls: providerCalls, applicationVerdict: "RED_EXPECTED", liveProviderCalls: 0 }));
} finally {
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
