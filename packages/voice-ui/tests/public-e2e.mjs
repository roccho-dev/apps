import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

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

const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await page.waitForFunction(() => window.voiceUiReady === true);
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// The v1 HTTP contract is kept even though the screen no longer drives it, so it
// is checked directly against the deployed function rather than through #send.
const v1 = await fetch(new URL("/api/jev", url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "voice-ui.jev.request.v1", text: "public v1 contract proof" }),
});
assert.equal(v1.status, 200);
const v1Ir = await v1.json();
assert.equal(v1Ir.kind, "ui.ir.v1");
assert.equal(v1Ir.capability, "a2ui-browser");
assert.equal(v1Ir.payloadKind, "a2ui.surface.v1");

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
  assert.equal(await storedLog(), null, `${label}: nothing may be stored before Apply`);
  assert.deepEqual(await appliedFacts(), [], `${label}: 確定図 must have no entry before Apply`);
  assert.deepEqual((await drawnEdges("confirmed")).edges, [], `${label}: 確定図 must draw no edge before Apply`);
};

assert.equal(await page.evaluate(() => document.body.dataset.state), "initial");
assert.deepEqual((await drawnEdges("confirmed")).edges, [], "a first visit must draw no edge");
assert.deepEqual((await drawnEdges("working")).edges, [], "a first visit must draw no edge");

// Send takes the typed graph decision. A rendered string is not evidence of
// anything; a step drawn on 作業図 and then applied to 確定図 is.
await page.locator("#text").fill("add an edge from a to b");
const typeResponsePromise = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 120000 },
);
await page.locator("#send").click();
const typeResponse = await typeResponsePromise;
assert.equal(typeResponse.status(), 200);
const typeDecision = await typeResponse.json();
assert.equal(typeDecision.kind, "voice-ui.jev.decision.v4");
await waitForState("drafted");
const typedEdge = `${typeDecision.answers.source.choice}->${typeDecision.answers.target.choice}`;
assert.deepEqual(await draftSteps(), [`+${typedEdge}`]);
assert.deepEqual((await drawnEdges("working")).edges, [typedEdge]);
await assertSavedUntouched("typed step");

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const clip = golden.clips.find(value => value.wav === path.basename(wav));
assert.ok(clip, "voice golden fixture is missing");

const voiceResponsePromise = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 360000 },
);
await page.locator("#mic").click();
const voiceResponse = await voiceResponsePromise;
assert.equal(voiceResponse.status(), 200);
const voiceDecision = await voiceResponse.json();
assert.equal(voiceDecision.kind, "voice-ui.jev.decision.v4");
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
assert.equal(saved.split("\n").length - 1, 3, "the initial graph plus exactly the two applied Decisions");

const drawn = await drawnEdges("confirmed");
assert.equal(drawn.pattern, "graph/1");
assert.equal(drawn.svg, true);
assert.deepEqual(drawn.edges, bothEdges, "確定図 must draw exactly the applied edges");

// Both entries come back from this origin's storage after a reload.
await page.reload({ waitUntil: "commit" });
await page.waitForFunction(() => window.voiceUiReady === true, null, { timeout: 120000 });
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
  `public-e2e: PASS v1 contract direct | typed edge=${typedEdge} + voice edge=${voiceEdge} `
  + "drawn on 作業図 only, applied together to 確定図, restored after reload\n",
);
