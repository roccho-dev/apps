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
let child, formal;
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
  // A separate controlled grade, on the actual artifact-owned formal entry.
  // The child's explicit env has no key, and the scenario intercepts judgments.
  const architectureHome = path.join(work, "arch"); mkdirSync(architectureHome);
  formal = spawn(runtime, [path.join(root, manifest.e2e.local_serve_entrypoint), "--formal"], {
    cwd: architectureHome, env: { PATH: process.env.PATH, HOME: architectureHome, TMPDIR: architectureHome,
      LANG: "C.UTF-8", PORT: "0", HOST: "127.0.0.1" }, detached: true,
  });
  const formalOrigin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("formal architecture server readiness timed out")), 15000);
    formal.once("error", error => { clearTimeout(timer); reject(error); });
    formal.once("exit", () => { clearTimeout(timer); reject(new Error("formal architecture server exited")); });
    formal.stdout.on("data", chunk => {
      output += chunk;
      const found = /listening on 127\.0\.0\.1:(\d+)/u.exec(output);
      if (found) { clearTimeout(timer); resolve("http://127.0.0.1:" + found[1]); }
    });
  });
  const architecture = await runChild([path.join(root, manifest.e2e.architecture_entrypoint),
    "--mode", "fixture", "--scenario", "natural", formalOrigin], architectureHome);
  assert.equal(architecture.code, 0, architecture.stderr);
  assert.match(architecture.stdout, /PASS mechanics only \(crafted answers\)/u);
  const reverseControls = [];
  for (const [index, mode] of ["fixture", "fixture-stop", "fixture-semantic-stop"].entries()) {
    const home = path.join(work, `rv${index}`); mkdirSync(home);
    const output = await runChild([path.join(root, manifest.e2e.architecture_entrypoint),
      "--mode", mode, "--scenario", "contextual-reverse", formalOrigin], home);
    assert.equal(output.code, 0, output.stderr + output.stdout);
    const summary = output.stdout.split("\n").filter(line => line.startsWith("{"))
      .map(line => JSON.parse(line)).find(row => row.event === "summary");
    assert.ok(summary, "the actual reverse run emits a summary");
    assert.equal(summary.mode, mode);
    assert.equal(summary.scenario, "contextual-reverse");
    assert.equal(summary.source, manifest.sources.apps);
    assert.deepEqual(summary.viewport, { width: 1280, height: 720 });
    assert.equal(summary.cleanup, null);
    assert.equal(summary.error, null);
    assert.equal(summary.actions.new, 1);
    assert.equal(summary.actions.apply, 0);
    assert.equal(summary.actions.reload, 0);
    assert.equal(summary.actions.discard, 0);
    assert.equal(summary.providerIdentity, "UNKNOWN");
    assert.deepEqual(summary.unreported, []);
    if (mode === "fixture") {
      assert.deepEqual(summary.reached, ["open", "app", "reverse", "reverse-undo"]);
      assert.deepEqual(summary.notRun, []);
      assert.deepEqual(summary.verdicts, []);
      assert.equal(summary.protocolFailure, null);
      assert.equal(summary.stoppedAt, null);
      assert.equal(summary.actions.send, 2);
      assert.equal(summary.actions.undo, 1);
      assert.equal(summary.contextEvidence.source, manifest.sources.apps);
      assert.ok(Number.isSafeInteger(summary.contextEvidence.priorSequence));
      assert.ok(summary.contextEvidence.priorFocus.includes("web-app-mjs"));
      assert.equal(summary.contextEvidence.workingEdge, "arch-calls-web-app-mjs-to-web-adapters-judgment-mjs");
      assert.equal(summary.contextEvidence.reversedEdge, "voice-arch-web-adapters-judgment-mjs-to-arch-web-app-mjs");
      assert.notEqual(summary.contextEvidence.graphBefore, summary.contextEvidence.graphAfter);
      assert.equal(summary.contextEvidence.undoRestored, true);
      assert.equal(summary.contextEvidence.noSave, true);
      assert.equal(summary.contextEvidence.acceptedIntegration, "NOT_PROVEN");
    } else {
      assert.deepEqual(summary.reached, ["open", "app"]);
      assert.deepEqual(summary.notRun, ["reverse", "reverse-undo"]);
      assert.equal(summary.stoppedAt, "app");
      assert.equal(summary.actions.send, 1);
      assert.equal(summary.actions.undo, 0);
      assert.equal(summary.contextEvidence, null);
      if (mode === "fixture-stop") {
        assert.equal(summary.protocolFailure.stage, "app");
        assert.equal(summary.requests, 1);
        assert.equal(summary.non200, 1);
        assert.deepEqual(summary.verdicts, []);
      } else {
        assert.equal(summary.protocolFailure, null);
        assert.equal(summary.non200, 0);
        assert.equal(summary.answered, summary.requests);
        assert.deepEqual(summary.verdicts, ["the page's file is judged jev-boundary"]);
      }
    }
    reverseControls.push({ mode, scenario: summary.scenario, source: summary.source,
      reached: summary.reached, notRun: summary.notRun, actions: summary.actions,
      contextEvidence: summary.contextEvidence, verdicts: summary.verdicts, cleanup: summary.cleanup });
  }
  process.stdout.write(JSON.stringify({ kind: "voice-ui.contextualReverseControls.v1", status: "PASS",
    artifactManifestSha256: digest, liveProviderCalls: 0, controls: reverseControls }) + "\n");
  const goalControls = [];
  for (const [index, mode] of ["fixture", "fixture-stop"].entries()) {
    const home = path.join(work, `goal${index}`); mkdirSync(home);
    const output = await runChild([path.join(root, manifest.e2e.architecture_entrypoint),
      "--mode", mode, "--scenario", "goal-addition", formalOrigin], home);
    assert.equal(output.code, 0, output.stderr + output.stdout);
    const summary = output.stdout.split("\n").filter(line => line.startsWith("{"))
      .map(JSON.parse).find(row => row.event === "summary");
    assert.equal(summary.source, manifest.sources.apps);
    assert.equal(summary.scenario, "goal-addition"); assert.equal(summary.mode, mode);
    assert.equal(summary.cleanup, null); assert.equal(summary.error, null);
    assert.deepEqual(summary.viewport, { width: 1280, height: 720 });
    assert.deepEqual(summary.verdicts, []);
    assert.equal(summary.actions.goal, 1); assert.equal(summary.actions.send, 1);
    assert.equal(summary.actions.new, 1); assert.equal(summary.actions.apply, 0);
    assert.equal(summary.actions.reload, 0); assert.equal(summary.actions.discard, 0);
    const proof = summary.goalEvidence;
    assert.equal(proof.setupRequests, 1); assert.equal(proof.noSave, true);
    assert.equal(proof.providerIdentity, "UNKNOWN"); assert.equal(proof.acceptedIntegration, "NOT_PROVEN");
    if (mode === "fixture") {
      assert.deepEqual(summary.reached, ["open", "prepare", "goal", "goal-undo"]);
      assert.deepEqual(summary.notRun, []);
      assert.equal(summary.actions.undo, 1); assert.equal(summary.requests, 3);
      assert.equal(proof.requests, 2); assert.equal(proof.reason, "no-room-for-part");
      assert.equal(proof.goalMet, true); assert.equal(proof.undoRestored, true);
      assert.deepEqual(proof.labelsVisible, [true, true]); assert.equal(proof.timeBudgetMet, true);
      assert.equal(proof.painted.complete, true); assert.equal(proof.painted.contained, true);
      assert.equal(proof.painted.nonoverlap, true);
      assert.equal(proof.rawAdded.length, 2); assert.equal(proof.newPins.length, 2);
      assert.deepEqual(proof.rawAdded.map(record => record.label.replace(/ [1-9]\d*$/u, "")), ["API", "DB"]);
      assert.equal(proof.newPins.every(pin => proof.rawAdded.some(record => record.id === pin.regionId)), true);
      assert.ok(Number.isFinite(proof.elapsed.productMs) && proof.elapsed.productMs >= 0);
      assert.ok(Number.isFinite(proof.elapsed.baselineMs) && proof.elapsed.baselineMs >= 0);
      assert.equal(proof.elapsed.productScope, "HTTP+planning+draw");
      assert.equal(proof.elapsed.baselineScope, "literal-selection-CPU-only");
      assert.equal(proof.internalModelExecutions, "UNKNOWN"); assert.equal(proof.providerCost, "UNKNOWN");
      assert.equal(proof.baselineMet, true); assert.equal(proof.addedValue, "NOT_PROVEN");
      assert.deepEqual(proof.selected.map(item => item.key), ["api", "db"]);
      assert.deepEqual(proof.requestHistories.map(history => history.map(item => item.key)), [[], ["api"]]);
      assert.equal(proof.exchanges.every(exchange => exchange.status === 200 && exchange.answers !== null), true);
    } else {
      assert.deepEqual(summary.reached, ["open", "prepare", "goal"]);
      assert.deepEqual(summary.notRun, ["goal-undo"]);
      assert.equal(summary.actions.undo, 0); assert.equal(summary.requests, 2);
      assert.equal(proof.requests, 1); assert.equal(proof.reason, "judge-failed");
      assert.equal(proof.goalMet, false); assert.equal(proof.undoRestored, false);
      assert.deepEqual(proof.selected, []); assert.equal(proof.graphBefore, proof.graphAfter);
      assert.equal(proof.exchanges[0].status, 502);
    }
    goalControls.push({ mode, source: summary.source, actions: summary.actions, reached: summary.reached, proof });
  }
  process.stdout.write(JSON.stringify({ kind: "voice-ui.goalAdditionControls.v1", status: "PASS",
    artifactManifestSha256: digest, liveProviderCalls: 0, controls: goalControls }) + "\n");
  process.stdout.write(JSON.stringify({ kind: "voice-ui.architectureShapeCheck.v1", status: "PASS",
    scope: "artifact-shape/controlled-mechanics", artifactManifestSha256: digest, source: manifest.sources.architecture,
    entry: manifest.e2e.architecture_entrypoint, liveProviderCalls: 0, acceptedIntegration: "NOT_PROVEN" }) + "\n");
  console.log(JSON.stringify({ kind: "voice-ui.acceptanceBoundaryCheck.v1", status: "PASS",
    independentStarts: starts.length, controlledProviderCalls: apiRequests.length, callOrigin: "chromium-same-origin",
    applicationVerdict: "RED_EXPECTED", applicationReason: "per-start", liveProviderCalls: 0, starts }));
} finally {
  if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  if (formal?.pid) {
    try { process.kill(-formal.pid, "SIGTERM"); } catch {}
    await new Promise(resolve => formal.exitCode !== null || formal.signalCode !== null ? resolve() : formal.once("exit", resolve));
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
