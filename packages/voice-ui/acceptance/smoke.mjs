import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// The packaged runtime and public E2E entrypoints, real Chromium, and the
// artifact's exact site bytes served unmodified with the isolation headers the
// page needs. In the first two starts, /api/judge is controlled: every request
// gets a 503 judge_unavailable, and each must make exactly one - from the page
// itself, same-origin - and end as an explicit NOT_RUN with that reason and a
// RED receipt. The third start serves the unchanged entry module as HTML and
// must end RED before any application call. Never emits an application PASS
// or contacts Jev/Cloudflare.
const [runtime, root] = process.argv.slice(2);
assert.ok(path.isAbsolute(runtime) && path.isAbsolute(root));
const bytes = readFileSync(path.join(root, "manifest.json"));
const manifest = JSON.parse(bytes);
const digest = createHash("sha256").update(bytes).digest("hex");
const site = path.join(root, "site");

const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".md": "text/plain; charset=utf-8",
}));
const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

// A site path to a file under the site root, or null. Traversal is refused.
const fileFor = pathname => {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(site, relative);
  if (!resolved.startsWith(site + path.sep)) return null;
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
};

const apiRequests = [];
const misdeliveredResponses = [];
let htmlMisdelivery = false;
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  if (pathname === "/api/judge") {
    apiRequests.push({
      method: req.method,
      origin: req.headers.origin ?? null,
      fetchSite: req.headers["sec-fetch-site"] ?? null,
    });
    req.resume();
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "judge_unavailable" }));
    return;
  }
  const file = fileFor(pathname);
  if (file === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...ISOLATION });
    res.end("not found");
    return;
  }
  const body = readFileSync(file);
  const misdelivered = htmlMisdelivery && pathname === "/app.mjs";
  const contentType = misdelivered ? "text/html; charset=utf-8"
    : TYPES.get(path.extname(file)) ?? "application/octet-stream";
  if (misdelivered) {
    misdeliveredResponses.push({ pathname, status: 200, contentType,
      sha256: createHash("sha256").update(body).digest("hex") });
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": body.byteLength,
    "cache-control": "no-store",
    ...ISOLATION,
  });
  res.end(body);
});

// Each start gets a fresh workspace inside this unique directory. It is left
// in place: the check runs in an ephemeral build sandbox, and nothing here
// deletes recursively. The names are short because Chromium keeps a Unix
// socket under each start's TMPDIR, and a socket path has a hard length limit
// that a long build directory prefix otherwise exceeds.
const work = mkdtempSync(path.join(tmpdir(), "vub-"));
let child;
const runChild = (args, home) => new Promise((resolve, reject) => {
  child = spawn(runtime, args, { cwd: home, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: "C.UTF-8" }, detached: true });
  let stderr = "", stdout = "";
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    reject(new Error("acceptance boundary timed out"));
  }, 300000);
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", code => { clearTimeout(timer); resolve({ code, stderr, stdout }); });
});
const starts = [];
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = `${origin}/`;
  for (let run = 1; run <= 3; run++) {
    htmlMisdelivery = run === 3;
    const home = path.join(work, `r${run}`);
    mkdirSync(home);
    const receipt = path.join(home, "receipt.json");
    const before = apiRequests.length;
    const beforeMisdelivery = misdeliveredResponses.length;
    const output = await runChild([path.join(root, manifest.e2e.runtime_entrypoint),
      "--artifact-root", root, "--url", target, "--expected-apps-sha", manifest.sources.apps,
      "--expected-manifest-sha256", digest, "--handoff-id", "ci-boundary/" + run, "--receipt", receipt], home);
    const requests = apiRequests.slice(before);
    assert.equal(output.code, 1, output.stderr);
    assert.doesNotMatch(output.stderr, /ERR_MODULE_NOT_FOUND|Executable doesn't exist|browserType.launch:/);
    if (htmlMisdelivery) {
      assert.deepEqual(misdeliveredResponses.slice(beforeMisdelivery), [{
        pathname: "/app.mjs", status: 200, contentType: "text/html; charset=utf-8",
        sha256: createHash("sha256").update(readFileSync(path.join(site, "app.mjs"))).digest("hex"),
      }], "the entry module must actually be served unchanged as 200 text/html");
      assert.deepEqual(requests, [], "HTML entry misdelivery must fail before /api/judge");
      assert.doesNotMatch(output.stderr, /NOT_RUN: judge_unavailable/u, output.stderr);
      const result = JSON.parse(readFileSync(receipt));
      assert.equal(result.status, "RED");
      assert.equal(result.stage, "application-e2e");
      assert.equal(result.sources.artifactManifestSha256, digest);
      assert.equal(result.checks.find(row => row.id === "public-application-e2e").status, "RED");
      assert.deepEqual(result.dependencies.secretInputs, []);
      starts.push({ run, receipt: result.status, reason: "entry-module-html-misdelivery",
        moduleResponse: misdeliveredResponses[beforeMisdelivery], applicationCalls: requests.length });
      continue;
    }
    // Exactly one /api/judge request in this start, and it is the page's own.
    assert.deepEqual(requests, [{ method: "POST", origin, fetchSite: "same-origin" }],
      `start ${run} must make exactly one same-origin page request to /api/judge: ${JSON.stringify(requests)}\n${output.stderr}`);
    // The run ended on that controlled 503, as an explicit NOT_RUN - not on
    // some later or unrelated failure.
    assert.match(output.stderr, /NOT_RUN: judge_unavailable/u, output.stderr);
    const result = JSON.parse(readFileSync(receipt));
    assert.equal(result.status, "RED");
    assert.equal(result.stage, "application-e2e");
    assert.equal(result.sources.artifactManifestSha256, digest);
    assert.equal(result.checks.find(row => row.id === "public-application-e2e").status, "RED");
    assert.deepEqual(result.dependencies.secretInputs, []);
    starts.push({ run, request: requests[0], receipt: result.status, reason: "NOT_RUN: judge_unavailable" });
  }
  htmlMisdelivery = false;
  const bindingHome = path.join(work, "bindings"); mkdirSync(bindingHome);
  const beforeBindings = apiRequests.length;
  const bindings = await runChild([path.join(root, manifest.e2e.public_entrypoint), target, "--binding-contract"], bindingHome);
  assert.equal(bindings.code, 0, bindings.stderr);
  assert.match(bindings.stdout, /binding-contract: PASS actual app/u);
  assert.equal(apiRequests.length, beforeBindings, "alternate judgment must not reach the API");
  process.stdout.write(bindings.stdout);
  console.log(JSON.stringify({ kind: "voice-ui.acceptanceBoundaryCheck.v1", status: "PASS",
    independentStarts: starts.length, controlledProviderCalls: apiRequests.length, callOrigin: "chromium-same-origin",
    applicationVerdict: "RED_EXPECTED", applicationReason: "per-start", liveProviderCalls: 0, starts }));
} finally {
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
