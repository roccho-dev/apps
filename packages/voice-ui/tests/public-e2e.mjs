import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// The approved acceptance runtime supplies this pinned dependency, never npm at run time.
const { chromium } = createRequire(import.meta.url)("playwright-core");

const url = process.argv[2];
if (!url) throw new Error("public URL is required");

const wav = process.env.VOICE_WAV;
const goldenPath = process.env.VOICE_GOLDEN;
if (!wav || !goldenPath) throw new Error("VOICE_WAV and VOICE_GOLDEN are required");

const STORAGE_KEY = "voice-ui.decision-log.v1";

const normalize = value =>
  value.normalize("NFKC").replace(/[\s。、．，,.!?！？・]/gu, "");

const distance = (left, right) => {
  if (left.length < right.length) [left, right] = [right, left];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(left[i - 1] !== right[j - 1]),
      );
    }
    previous = current;
  }
  return previous[right.length];
};

const args = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--use-file-for-fake-audio-capture=" + path.resolve(wav),
  "--autoplay-policy=no-user-gesture-required",
];

// The full browser rather than the reduced headless shell, which loses its
// renderer while loading this page.
const browser = await chromium.launch({ headless: true, channel: "chromium", args });
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin: new URL(url).origin });
const page = await context.newPage();

const errors = [];
const failedRequests = [];
const failedResponses = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("requestfailed", request =>
  failedRequests.push(request.method() + " " + request.url() + " " + request.failure()?.errorText)
);
page.on("response", response => {
  if (response.status() >= 400) {
    failedResponses.push(response.status() + " " + response.request().method() + " " + response.url());
  }
});

// The one current Jev contract; this file ships alone in the artifact.
const REQUEST_KIND = "voice-ui.jev.request.v10";
const DECISION_KIND = "voice-ui.jev.decision.v5";

// The page sets its body state last, once every control is in place.
const ready = () => page.waitForFunction(
  () => document.body.dataset.state !== undefined && document.body.dataset.state !== "pending",
  null,
  { timeout: 120000 },
);

const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await ready();
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// A first visit is NO_LOG: nothing stored, nothing drawn, nothing to speak to.
assert.equal(await page.evaluate(() => document.body.dataset.state), "no-log");
assert.equal(await page.locator('iframe[data-package="semantic-map"]').count(), 0);
assert.equal(await page.locator("#send").isDisabled(), true);

// A fixture of three plain nodes, built by the pinned provider in the page and
// stored in this app's namespace, then loaded the way a saved log is.
const fixtureLog = await page.evaluate(async key => {
  const protocol = await import("/ui/semantic-map/protocol/index.js");
  const node = (id, x) => ({ type: "region", id, parent: "root", label: id, kind: "node", bounds: [x, 90, 140, 64], summary: "" });
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: "semantic-map-state/1", root: "root", title: "public fixture" },
    { type: "region", id: "root", parent: null, label: "public fixture", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
    node("node-a", 40),
    node("node-b", 250),
    node("node-c", 460),
  ], "voice-graph");
  localStorage.setItem(key, graph.log);
  return graph.log;
}, STORAGE_KEY);
await page.reload({ waitUntil: "commit" });
await ready();
assert.equal(await page.evaluate(() => document.body.dataset.state), "restored");

// Every edge one pane's live adapter holds, read from inside that pane's own
// frame. This is the graph the page actually drew, not an envelope handed to it.
const drawnEdges = pane => page.evaluate(async pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  if (!frame) throw new Error(`${pane} semantic map iframe missing`);

  const started = performance.now();
  while (frame.contentWindow?.semanticMapSite?.ready !== true) {
    if (performance.now() - started > 60000) throw new Error("semantic map ready timeout");
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const win = frame.contentWindow;
  const svg = frame.contentDocument.querySelector("#graph-container svg");
  const box = svg?.getBoundingClientRect();
  return {
    pattern: win.semanticMapRuntime.view.pattern,
    svg: Boolean(box && box.width > 0 && box.height > 0),
    edges: [...win.semanticMapApp.adapter.edgesByProjectionKey.values()]
      .map(edge => `${edge.semantic.from}->${edge.semantic.to}`)
      .sort(),
  };
}, pane);

const appliedFacts = () => page.evaluate(() =>
  [...document.querySelectorAll("[data-history=confirmed] li")].map(item => item.dataset.facts).sort()
);
const draftSteps = () => page.evaluate(() =>
  [...document.querySelectorAll("#draft li")].map(item => item.dataset.changes)
);
const storedLog = () => page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);

const waitForState = state => page.waitForFunction(
  value => document.body.dataset.state === value,
  state,
  { timeout: 360000 },
);

// Speaking and typing change 作業図 only. Until 確定図に反映, 確定図 and the
// stored bytes must not move.
const assertSavedUntouched = async label => {
  assert.equal(await storedLog(), fixtureLog, `${label}: nothing may be stored before Apply`);
  assert.deepEqual(await appliedFacts(), [], `${label}: 確定図 must have no entry before Apply`);
  assert.deepEqual((await drawnEdges("confirmed")).edges, [], `${label}: 確定図 must draw no edge before Apply`);
};

assert.deepEqual((await drawnEdges("confirmed")).edges, [], "the fixture has no edge");
assert.deepEqual((await drawnEdges("working")).edges, [], "the fixture has no edge");

// No credential or no provider is not a result: the run stops as NOT_RUN,
// which is RED, and names the reason the service gave.
const requireAnswered = async response => {
  if (response.status() === 503) {
    throw new Error(`NOT_RUN: jev_unavailable - the Jev service or its credential is unavailable (${await response.text()}); this run is RED, not PASS`);
  }
  assert.equal(response.status(), 200);
};

// Send takes the typed graph decision. A rendered string is not evidence of
// anything; a step drawn on 作業図 and then applied to 確定図 is. This is the
// first request the page makes to /api/jev, and it comes from Chromium itself.
await page.locator("#text").fill("add an edge from a to b");
const typeResponsePromise = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 120000 },
);
await page.locator("#send").click();
const typeResponse = await typeResponsePromise;
assert.equal(JSON.parse(typeResponse.request().postData()).kind, REQUEST_KIND);
await requireAnswered(typeResponse);
const typeDecision = await typeResponse.json();
assert.equal(typeDecision.kind, DECISION_KIND);
await waitForState("drafted");
const typedEdge = `${typeDecision.answers.source.choice}->${typeDecision.answers.target.choice}`;
assert.deepEqual(await draftSteps(), [`+${typedEdge}`]);
assert.deepEqual((await drawnEdges("working")).edges, [typedEdge]);
await assertSavedUntouched("typed step");

// The deployed Function serves only the current request kind: a legacy kind is
// refused before any provider call. Checked after the page's own first call.
const legacy = await fetch(new URL("/api/jev", url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "voice-ui.jev.request.v1", text: "public legacy refusal proof" }),
});
assert.equal(legacy.status, 422);
assert.deepEqual(await legacy.json(), { error: "invalid_request" });

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const clip = golden.clips.find(value => value.wav === path.basename(wav));
assert.ok(clip, "voice golden fixture is missing");

const voiceResponsePromise = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 360000 },
);
await page.locator("#mic").click();
const voiceResponse = await voiceResponsePromise;
await requireAnswered(voiceResponse);
const voiceDecision = await voiceResponse.json();
assert.equal(voiceDecision.kind, DECISION_KIND);
await page.waitForFunction(() => document.body.dataset.state !== "pending", null, { timeout: 360000 });
assert.equal(await page.evaluate(() => document.body.dataset.state), "drafted");

const actual = normalize(await page.locator("#text").inputValue());
const expected = normalize(clip.reference);
const cer = distance(actual, expected) / Math.max(1, expected.length);
assert.ok(cer <= Number(golden._cer_tolerance), "voice CER exceeded pinned tolerance");

const voiceEdge = `${voiceDecision.answers.source.choice}->${voiceDecision.answers.target.choice}`;
const bothEdges = [typedEdge, voiceEdge].sort();
assert.deepEqual(await draftSteps(), [`+${typedEdge}`, `+${voiceEdge}`]);
assert.deepEqual((await drawnEdges("working")).edges, bothEdges);
await assertSavedUntouched("spoken step");

// 確定図に反映 writes both steps at once and 確定図 then draws exactly them.
await page.locator("#apply").click();
await waitForState("applied");
assert.deepEqual(await draftSteps(), []);
assert.deepEqual(await appliedFacts(), bothEdges.map(edge => `+${edge}`).sort());
const saved = await storedLog();
assert.ok(saved, "applied steps must be persisted");
assert.equal(saved.split("\n").length - 1, 3, "the fixture plus exactly the two applied Decisions");
assert.ok(saved.startsWith(fixtureLog), "Apply adds to the stored log; it rewrites nothing");

const drawn = await drawnEdges("confirmed");
assert.equal(drawn.pattern, "graph/1");
assert.equal(drawn.svg, true);
assert.deepEqual(drawn.edges, bothEdges, "確定図 must draw exactly the applied edges");

// Both entries come back from this origin's storage after a reload.
await page.reload({ waitUntil: "commit" });
await ready();
assert.equal(await page.evaluate(() => document.body.dataset.state), "restored");
assert.equal(await storedLog(), saved);
assert.deepEqual(await appliedFacts(), bothEdges.map(edge => `+${edge}`).sort());
assert.deepEqual((await drawnEdges("confirmed")).edges, bothEdges);
assert.deepEqual((await drawnEdges("working")).edges, bothEdges);

assert.deepEqual(errors, []);
assert.deepEqual(failedRequests, []);
assert.deepEqual(failedResponses, []);

await browser.close();
process.stdout.write(
  `public-e2e: PASS NO_LOG first visit, legacy kind refused | typed edge=${typedEdge} + voice edge=${voiceEdge} `
  + "drawn on 作業図 only, applied together to 確定図, restored after reload\n",
);
