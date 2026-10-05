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
  // Evaluation data is separate from the fixed, explicitly controlled answers.
  // No expected result selects a response or filters a product candidate.
  const evaluationBase = { version: "voice-ui.goal-evaluation.v1", id: "controlled-order", goal: "OCIの中にAPIとDBを追加して", order: "reverse",
    expected: { kind: "change", regions: [{ partKey: "api", parentLabel: "OCI" }, { partKey: "db", parentLabel: "OCI" }], flows: [] } };
  // A nested oracle names an added group as a parent; it is resolved against
  // the actual graph, and never passes a flat one.
  const nestedBase = { ...evaluationBase, id: "controlled-nest", order: "normal",
    goal: "OCIの中にグループを作ってその中にDBを置き、OCIにAPIを追加してAPIからDBへ矢印をつないで",
    expected: { kind: "change", regions: [{ partKey: "group", parentLabel: "OCI" }, { partKey: "db", parent: { addedPart: "group" } },
      { partKey: "api", parentLabel: "OCI" }], flows: [{ from: { addedPart: "api" }, to: { addedPart: "db" } }] } };
  const evaluationCases = [
    { data: { ...nestedBase, id: "controlled-nest-on-flat" }, mode: "fixture", scenario: "goal-flow", semantic: "NOT_MET" },
    { data: nestedBase, mode: "fixture", scenario: "goal-nest", semantic: "PASS" },
    { data: evaluationBase, mode: "fixture", scenario: "goal-addition", semantic: "PASS" },
    { data: { ...evaluationBase, id: "controlled-mixed-order", expected: { ...evaluationBase.expected,
      flows: [{ from: { addedPart: "api" }, to: { addedPart: "db" } }] } }, mode: "fixture", scenario: "goal-flow", semantic: "PASS" },
    { data: { ...evaluationBase, id: "controlled-none", goal: "図は変更せず、そのままにして", order: "normal",
      expected: { kind: "none", regions: [], flows: [] } }, mode: "fixture-none", scenario: "goal-addition", semantic: "PASS" },
    { data: { ...evaluationBase, id: "controlled-wrong-expected", order: "normal",
      expected: { ...evaluationBase.expected, regions: [evaluationBase.expected.regions[0]] } }, mode: "fixture", scenario: "goal-addition", semantic: "NOT_MET" },
  ];
  // PR #60 byte-fixed non-heldout calibrations. The scripted product arm is
  // controlled mechanics; only the replayed deterministic lexical baseline is
  // graded against the expected outcome fixed before any result.
  const flowExpected = { kind: "change", regions: [{ partKey: "api", parentLabel: "OCI" }, { partKey: "db", parentLabel: "OCI" }],
    flows: [{ from: { addedPart: "api" }, to: { addedPart: "db" } }] };
  const calibration = (id, goal, expected, scenario, baseline) => ({ mode: "fixture", scenario, semantic: "PASS", baseline,
    data: { version: "voice-ui.goal-evaluation.v1", id, goal, order: "normal", expected } });
  evaluationCases.push(
    calibration("calibration-a", "OCIにapiとdbを追加し、apiからdbへつないで", flowExpected, "goal-flow", "PASS"),
    calibration("calibration-b", "OCIにapiとdbを追加し、dbへapiからつないで", flowExpected, "goal-flow", "NOT_MET"),
    calibration("calibration-c", "OCIにgroupを追加し、groupにdbを追加し、OCIにapiを追加し、apiからdbへつないで",
      nestedBase.expected, "goal-nest", "PASS"));
  const evaluationControls = [];
  for (const [index, entry] of evaluationCases.entries()) {
    const home = path.join(work, `e${index}`); mkdirSync(home);
    const output = await runChild([path.join(root, manifest.e2e.architecture_entrypoint), "--mode", entry.mode,
      "--scenario", entry.scenario, formalOrigin, "--goal-case", JSON.stringify(entry.data)], home);
    const summary = output.stdout.split("\n").filter(line => line.startsWith("{"))
      .map(JSON.parse).find(row => row.event === "summary");
    assert.ok(summary, `complete evaluator summary for ${entry.data.id}: ${output.stderr.slice(-600)}`);
    assert.equal(summary.source, manifest.sources.apps); assert.equal(summary.error, null); assert.equal(summary.cleanup, null);
    const proof = summary.goalEvidence;
    assert.equal(proof.evaluation.semanticGrade, entry.semantic);
    assert.equal(proof.noSave, true); assert.equal(summary.actions.apply, 0); assert.equal(summary.actions.reload, 0);
    assert.equal(proof.exchanges.every(exchange => exchange.status === 200 && exchange.answers !== null), true);
    if (entry.data.order === "reverse") {
      assert.equal(proof.evaluation.orderInterventions.length, proof.requests);
      for (const order of proof.evaluation.orderInterventions) {
        assert.deepEqual(order.after, [...order.before].reverse()); assert.equal(order.sameEntriesAndOtherState, true);
      }
    }
    if (entry.mode === "fixture-none") {
      assert.equal(proof.evaluation.firstNone, true); assert.equal(proof.requests, 1);
      assert.deepEqual(proof.rawAdded, []); assert.deepEqual(proof.newEdges, []); assert.deepEqual(proof.newPins, []);
      assert.equal(proof.graphBefore, proof.graphAfter); assert.equal(summary.actions.undo, 0);
      assert.deepEqual(summary.notRun, []); assert.equal(output.code, 0, output.stderr);
    } else assert.equal(proof.undoRestored, true);
    // Every evaluated Goal replays the same served core from the same actual
    // start; its first request must equal the product actual first request.
    const fair = proof.fairBaseline;
    assert.equal(fair.replay.sameStart, true, entry.data.id + ": replay starts from the actual pre-Goal Working");
    assert.equal(fair.replay.preparedEqual, true, entry.data.id + ": served constructors rebuild each actual preparation request");
    assert.equal(fair.replay.firstRequestEqual, true, entry.data.id + ": replayed first request equals the actual one");
    assert.equal(fair.replay.modulesLoadedByPage, true);
    if (entry.baseline !== undefined) {
      assert.equal(fair.grade, entry.baseline, entry.data.id + ": preregistered baseline outcome");
      assert.equal(fair.reason, "none"); assert.ok(fair.requests >= 1 && fair.requests <= 8);
    }
    if (entry.scenario === "goal-nest") {
      assert.equal(output.code, 0, output.stderr + output.stdout);
      assert.deepEqual(proof.selected.map(item => item.key), ["group", "db", "api"]);
      assert.equal(proof.evaluation.baselinePreserved, true); assert.equal(proof.pinsExact, true);
      assert.equal(proof.evaluation.paintGrade, "PASS");
      assert.equal(proof.rawAdded.length, 3); assert.equal(proof.newPins.length, 4);
      assert.equal(proof.newEdges.length, 1);
      // The overview closes the small added group (provider scene state); the
      // existing camera control opens it and proves the child and the arrow.
      const [group, db] = proof.selected.map(item => item.region);
      assert.equal(proof.nest.overview.closed, true); assert.deepEqual(proof.nest.overview.childrenRepresented, [false]);
      const camera = proof.nest.camera;
      assert.equal(camera.part, group); assert.equal(camera.state, "camera");
      assert.equal(camera.groupOpen, true); assert.deepEqual(camera.childrenRepresented, [true]);
      assert.deepEqual(camera.labelsVisible, [true, true, true]); assert.deepEqual(camera.groupLabels, [true, true, true]);
      assert.deepEqual(camera.groupPaint.shapes.map(shape => shape.id), [db]);
      assert.equal(camera.groupPaint.contained && camera.groupPaint.nonoverlap && camera.groupPaint.complete, true);
      assert.equal(camera.edges.length, 1); assert.equal(camera.edges[0].met, true);
      assert.equal(camera.edges[0].frame.camera, group, "the group camera shows this arrow whole");
      assert.equal(camera.edges[0].frame.edge.matches.length, 1);
      assert.equal(camera.edges[0].frame.reverse.complete, false);
      assert.notEqual(camera.edges[0].frame.disconnected, null, "a disconnected counter-paint in view is measured");
      assert.equal(camera.edges[0].frame.disconnected.complete, false);
      assert.equal(camera.recordsUnchanged && camera.storedUnchanged && camera.overviewRestored, true);
      assert.equal(proof.nest.cameraMet, true);
    }
    if (entry.semantic === "NOT_MET") assert.notEqual(output.code, 0, "wrong oracle cannot turn into PASS");
    // Existing arrow FAIL remains an independent overall FAIL, not a semantic waiver.
    evaluationControls.push({ id: entry.data.id, scenario: entry.scenario, mode: entry.mode, code: output.code,
      semantic: proof.evaluation.semanticGrade, paint: proof.evaluation.paintGrade, proof });
  }
  // Seen real-case regressions and controlled negatives, never Jev evidence.
  // r29-g1-nest (issue #58, sealed before the first attempt, now seen) runs in
  // fixture-baseline: the one public lexical selector answers in Node and must
  // equal the in-page replay; changing only the expected flow changes grades,
  // never answers. fixture-weak answers a first offered choice below the floor.
  const g1 = { version: "voice-ui.goal-evaluation.v1", id: "r29-g1-nest", goal: "OCIの中にグループを作って、そのグループの中にデータを置き、OCIに開始も置いて、開始からデータへ矢印をつないで", order: "normal",
    expected: { kind: "change", regions: [{ partKey: "group", parentLabel: "OCI" }, { partKey: "data", parent: { addedPart: "group" } },
      { partKey: "start", parentLabel: "OCI" }], flows: [{ from: { addedPart: "start" }, to: { addedPart: "data" } }] } };
  const regressionCases = [
    { id: "seen-g1", mode: "fixture-baseline", scenario: "goal-nest", data: g1 },
    { id: "seen-g1-altered-expected", mode: "fixture-baseline", scenario: "goal-nest",
      data: { ...g1, id: "r29-g1-altered-expected", expected: { ...g1.expected, flows: [{ from: { addedPart: "data" }, to: { addedPart: "start" } }] } } },
    { id: "connect-only", mode: "fixture-baseline", scenario: "goal-flow",
      data: { ...evaluationBase, id: "connect-only", order: "normal", goal: "Existing helperからHelper rightへ矢印をつないで",
        expected: { kind: "change", regions: [], flows: [{ from: { baselineRegion: "existing-helper" }, to: { baselineRegion: "helper-right" } }] } } },
    { id: "first-weak", mode: "fixture-weak", scenario: "goal-flow", data: { ...evaluationBase, id: "first-weak", order: "normal" } },
    // r31-f1-nest-out (seen when its keyless preflight exposed the observer
    // gap): an arrow from a part inside an added group to a seed part outside.
    { id: "seen-f1", mode: "fixture-baseline", scenario: "goal-nest",
      data: { version: "voice-ui.goal-evaluation.v1", id: "r31-f1-nest-out", goal: "OCIにグループを作り、そのグループの中にDBを置いて、DBからExisting helperへ矢印をつないで", order: "normal",
        expected: { kind: "change", regions: [{ partKey: "group", parentLabel: "OCI" }, { partKey: "db", parent: { addedPart: "group" } }],
          flows: [{ from: { addedPart: "db" }, to: { baselineRegion: "existing-helper" } }] } } },
  ];
  const regressions = {};
  for (const [index, entry] of regressionCases.entries()) {
    const home = path.join(work, "x" + index); mkdirSync(home);
    const output = await runChild([path.join(root, manifest.e2e.architecture_entrypoint), "--mode", entry.mode,
      "--scenario", entry.scenario, formalOrigin, "--goal-case", JSON.stringify(entry.data)], home);
    const summary = output.stdout.split("\n").filter(line => line.startsWith("{")).map(JSON.parse).find(row => row.event === "summary");
    assert.ok(summary, entry.id + ": " + output.stderr.slice(-600));
    assert.equal(summary.source, manifest.sources.apps); assert.equal(summary.error, null); assert.equal(summary.cleanup, null);
    regressions[entry.id] = { code: output.code, summary, proof: summary.goalEvidence };
  }
  {
    const seen = regressions["seen-g1"], altered = regressions["seen-g1-altered-expected"];
    assert.equal(seen.code, 0, JSON.stringify(seen.summary.verdicts));
    assert.equal(seen.proof.evaluation.semanticGrade, "PASS"); assert.equal(seen.proof.evaluation.paintGrade, "PASS");
    assert.equal(seen.proof.fairBaseline.craftEqual, true); assert.equal(seen.proof.goalEffect, "adopted"); assert.equal(seen.proof.undoRestored, true);
    assert.deepEqual(seen.proof.selected.map(item => item.key), ["group", "data", "start"]);
    assert.deepEqual(altered.proof.exchanges.map(item => item.answers), seen.proof.exchanges.map(item => item.answers), "expected data never changes answers");
    assert.equal(altered.proof.fairBaseline.craftEqual, true); assert.equal(altered.proof.evaluation.semanticGrade, "NOT_MET");
    const connect = regressions["connect-only"];
    assert.equal(connect.code, 0, JSON.stringify(connect.summary.verdicts)); assert.deepEqual(connect.proof.selected, []);
    assert.equal(connect.proof.newEdges.length, 1); assert.equal(connect.proof.goalEffect, "adopted"); assert.equal(connect.proof.undoRestored, true);
    const weak = regressions["first-weak"];
    assert.notEqual(weak.code, 0); assert.equal(weak.proof.reason, "not-confident"); assert.equal(weak.proof.requests, 1);
    assert.equal(weak.proof.goalEffect, "none"); assert.equal(weak.proof.graphBefore, weak.proof.graphAfter);
    assert.deepEqual(weak.summary.notRun, ["goal-undo"]); assert.equal(weak.summary.actions.undo, 0);
    const f1 = regressions["seen-f1"];
    assert.equal(f1.code, 0, JSON.stringify(f1.summary.verdicts));
    assert.equal(f1.proof.evaluation.semanticGrade, "PASS"); assert.equal(f1.proof.evaluation.paintGrade, "PASS");
    assert.equal(f1.proof.fairBaseline.craftEqual, true); assert.equal(f1.proof.undoRestored, true);
    const crossing = f1.proof.nest.camera.edges[0];
    assert.equal(crossing.met, true); assert.equal(crossing.frame.inView, true);
    assert.equal(crossing.frame.edge.matches.length, 1); assert.equal(crossing.frame.reverse.complete, false);
    assert.notEqual(crossing.frame.disconnected, null); assert.equal(crossing.frame.disconnected.complete, false);
  }
  process.stdout.write(JSON.stringify({ kind: "voice-ui.goalRegressionControls.v1", status: "PASS", liveProviderCalls: 0,
    scope: "seen regressions and controlled negatives; not Jev quality", artifactManifestSha256: digest,
    controls: Object.fromEntries(Object.entries(regressions).map(([id, item]) => [id, { code: item.code, reason: item.proof.reason,
      semantic: item.proof.evaluation.semanticGrade, paint: item.proof.evaluation.paintGrade, goalEffect: item.proof.goalEffect,
      answers: item.proof.exchanges.map(exchange => exchange.answers) }])) }) + "\n");
  for (const [index, data] of [null, { ...evaluationBase, extra: true },
    { ...evaluationBase, expected: { ...evaluationBase.expected, regions: [null] } },
    { ...evaluationBase, expected: { ...evaluationBase.expected, regions: [{ partKey: "unknown", parentLabel: "OCI" }] } },
    { ...evaluationBase, expected: { ...evaluationBase.expected, flows: [{ from: { baselineRegion: "oci" }, to: { addedPart: "api" } }] } },
    { ...evaluationBase, expected: { ...evaluationBase.expected, regions: [evaluationBase.expected.regions[0], evaluationBase.expected.regions[0]] } },
    { ...evaluationBase, expected: { ...evaluationBase.expected, flows: [
      { from: { addedPart: "api" }, to: { addedPart: "db" } },
      { to: { addedPart: "db" }, from: { addedPart: "api" } },
    ] } },
    ...[
      { partKey: "db", parent: { addedPart: "absent" } },
      { partKey: "db", parent: { addedPart: "api" } },
      { partKey: "db", parent: { addedPart: "group" }, parentLabel: "OCI" },
      { partKey: "db" },
      { partKey: "db", parent: { addedPart: "group", extra: 1 } },
    ].map(region => ({ ...nestedBase, expected: { ...nestedBase.expected, regions: [nestedBase.expected.regions[0], region,
      nestedBase.expected.regions[2]] } })),
    { ...nestedBase, expected: { ...nestedBase.expected, regions: [{ partKey: "group", parent: { addedPart: "group" } },
      ...nestedBase.expected.regions.slice(1)] } },
    { ...nestedBase, expected: { ...nestedBase.expected, regions: [{ partKey: "group", parent: { addedPart: "db" } },
      ...nestedBase.expected.regions.slice(1)] } },
    { ...nestedBase, expected: { ...nestedBase.expected, regions: nestedBase.expected.regions.slice(1) } },
  ].entries()) {
    const home = path.join(work, `i${index}`); mkdirSync(home);
    const output = await runChild([path.join(root, manifest.e2e.architecture_entrypoint), "--mode", "fixture", "--scenario", "goal-addition",
      formalOrigin, "--goal-case", JSON.stringify(data)], home);
    assert.notEqual(output.code, 0); assert.equal(output.stdout.includes('"event":"summary"'), false, "invalid input rejected before browser scenario");
    assert.doesNotMatch(output.stderr, /browserType\.launch|Target page, context or browser/);
  }
  process.stdout.write(JSON.stringify({ kind: "voice-ui.goalEvaluationControls.v1", status: "PASS",
    scope: "controlled evaluator only; not real selection or overall arrow PASS", liveProviderCalls: 0,
    artifactManifestSha256: digest, controls: evaluationControls }) + "\n");
  const goalControls = [];
  for (const scenario of ["goal-addition", "goal-flow"]) for (const [index, mode] of ["fixture", "fixture-stop"].entries()) {
    const flow = scenario === "goal-flow";
    // Keep Chromium's Unix socket pathname short, as for the existing starts.
    const home = path.join(work, `${flow ? "f" : "g"}${index}`); mkdirSync(home);
    const output = await runChild([path.join(root, manifest.e2e.architecture_entrypoint),
      "--mode", mode, "--scenario", scenario, formalOrigin], home);
    assert.equal(output.code, 0, output.stderr + output.stdout);
    const summary = output.stdout.split("\n").filter(line => line.startsWith("{"))
      .map(JSON.parse).find(row => row.event === "summary");
    assert.equal(summary.source, manifest.sources.apps);
    assert.equal(summary.scenario, scenario); assert.equal(summary.mode, mode);
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
      assert.equal(summary.actions.undo, 1); assert.equal(summary.requests, flow ? 5 : 4);
      assert.equal(proof.requests, flow ? 4 : 3); assert.deepEqual(proof.questionCounts, Array(flow ? 4 : 3).fill(1)); assert.equal(proof.reason, "none");
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
      assert.equal(proof.baselineMet, !flow); assert.equal(proof.addedValue, "NOT_PROVEN");
      assert.deepEqual(proof.selected.map(item => item.key), ["api", "db"]);
      assert.deepEqual(proof.requestHistories.map(history => history.map(item => item.key)), flow
        ? [[], ["api"], ["api", "db"], ["api", "db"]] : [[], ["api"], ["api", "db"]]);
      assert.equal(proof.newEdges.length, flow ? 1 : 0);
      if (flow) {
        assert.equal(proof.painted.edge.complete, true);
        assert.equal(proof.painted.edge.matches.length, 1);
        assert.equal(proof.reversedPaint.edge.complete, false);
        assert.equal(proof.disconnectedPaint.edge.complete, false);
      }
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
    goalControls.push({ scenario, mode, source: summary.source, actions: summary.actions, reached: summary.reached, proof });
  }
  process.stdout.write(JSON.stringify({ kind: "voice-ui.goalAdditionControls.v1", status: "PASS",
    artifactManifestSha256: digest, liveProviderCalls: 0, controls: goalControls }) + "\n");
  // One composed same-page source Goal: whole, app focus, then a Goal scoped by
  // that remembered focus draws one new arrow; Undo, clear and the same
  // utterance without the reference. Controlled mechanics, not understanding.
  const sourceHome = path.join(work, "s0"); mkdirSync(sourceHome);
  const sourceRun = await runChild([path.join(root, manifest.e2e.architecture_entrypoint),
    "--mode", "fixture", "--scenario", "goal-source", formalOrigin], sourceHome);
  assert.equal(sourceRun.code, 0, sourceRun.stderr + sourceRun.stdout);
  const sourceSummary = sourceRun.stdout.split("\n").filter(line => line.startsWith("{"))
    .map(JSON.parse).find(row => row.event === "summary");
  assert.equal(sourceSummary.source, manifest.sources.apps); assert.equal(sourceSummary.error, null);
  assert.deepEqual(sourceSummary.reached, ["open", "whole", "app", "source-goal", "source-undo", "clear", "unscoped"]);
  assert.deepEqual(sourceSummary.verdicts, []);
  const sourceProof = sourceSummary.sourceEvidence;
  assert.equal(sourceProof.scopeMatchesReference, true); assert.equal(sourceProof.contextMatches, true);
  assert.ok(sourceProof.candidates >= 1 && sourceProof.candidates <= 254); assert.equal(sourceProof.edgesTouchFocus, true);
  assert.equal(sourceProof.reason, "none"); assert.equal(sourceProof.requests, 2);
  assert.equal(sourceProof.eligible, true); assert.equal(sourceProof.newEdgeDrawn, true);
  assert.equal(sourceProof.paint.met, true); assert.equal(sourceProof.paint.inView, true);
  assert.equal(sourceProof.paint.edge.matches.length, 1); assert.equal(sourceProof.paint.viewport.length, 4);
  assert.equal(sourceProof.paint.reverse.complete, false);
  assert.notEqual(sourceProof.paint.disconnected, null); assert.equal(sourceProof.paint.disconnected.complete, false);
  assert.equal(sourceProof.undoRestored, true); assert.equal(sourceProof.clearKeepsGraphs, true);
  assert.deepEqual(sourceProof.unscoped, { reason: "candidate-overflow", requests: 0, newExchanges: 0 });
  assert.equal(sourceProof.understanding, "NOT_PROVEN");
  // Live goal-source needs closed evaluator data naming served manifest
  // entities; anything else is refused before any browser start.
  const sourceCase = expected => JSON.stringify({ version: "voice-ui.goal-evaluation.v1", id: "source-input", goal: "x", order: "normal", expected });
  const arrow = (from, to) => ({ kind: "change", regions: [], flows: [{ from: { baselineRegion: from }, to: { baselineRegion: to } }] });
  const sourceInputs = [["live"], ["live", "--goal-case", sourceCase(arrow("web-app-mjs", "unknown-entity"))],
    ["live", "--goal-case", sourceCase(arrow("web-app-mjs", "web-app-mjs"))],
    ["live", "--goal-case", sourceCase({ ...arrow("web-app-mjs", "src-log-mjs"), regions: [{ partKey: "api", parentLabel: "OCI" }] })],
    ["live", "--goal-case", JSON.stringify({ ...JSON.parse(sourceCase(arrow("artifact-jsonl", "web-app-mjs"))), order: "reverse" })],
    ["fixture", "--goal-case", sourceCase(arrow("artifact-jsonl", "web-app-mjs"))]];
  for (const [index, [inputMode, ...extra]] of sourceInputs.entries()) {
    const home = path.join(work, "j" + index); mkdirSync(home);
    const refused = await runChild([path.join(root, manifest.e2e.architecture_entrypoint), "--mode", inputMode, "--scenario", "goal-source", formalOrigin, ...extra], home);
    assert.notEqual(refused.code, 0); assert.equal(refused.stdout.includes("\"event\":\"summary\""), false);
    assert.doesNotMatch(refused.stderr, /browserType\.launch|Target page, context or browser/);
  }
  process.stdout.write(JSON.stringify({ kind: "voice-ui.sourceGoalControl.v1", status: "PASS",
    artifactManifestSha256: digest, liveProviderCalls: 0, proof: sourceProof }) + "\n");
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
