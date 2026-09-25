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

// Every edge the live adapter holds, read from inside the mounted iframe. This
// is the graph the page actually drew, not an envelope handed to it.
const drawnEdges = () => page.evaluate(async () => {
  const frame = document.querySelector('iframe[data-package="semantic-map"]');
  if (!frame) throw new Error("semantic map iframe missing");

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
});

const confirmedFacts = () => page.evaluate(() =>
  [...document.querySelectorAll("[data-history=confirmed] li")].map(item => item.dataset.fact).sort()
);

const waitForState = state => page.waitForFunction(
  value => document.body.dataset.state === value,
  state,
  { timeout: 360000 },
);

assert.equal(await page.evaluate(() => document.body.dataset.state), "initial");
assert.deepEqual((await drawnEdges()).edges, [], "a first visit must draw no edge");

// Send now takes the typed graph decision. A rendered string is no longer
// evidence of anything; a confirmed, drawn edge is.
await page.locator("#text").fill("add an edge from a to b");
const typeResponsePromise = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 120000 },
);
await page.locator("#send").click();
const typeResponse = await typeResponsePromise;
assert.equal(typeResponse.status(), 200);
const typeDecision = await typeResponse.json();
assert.equal(typeDecision.kind, "voice-ui.jev.decision.v2");
await waitForState("confirmed");
const typedEdge = `${typeDecision.answers.source.choice}->${typeDecision.answers.target.choice}`;
assert.deepEqual(await confirmedFacts(), [typedEdge]);
assert.deepEqual((await drawnEdges()).edges, [typedEdge]);

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
assert.equal(voiceDecision.kind, "voice-ui.jev.decision.v2");
await waitForState("confirmed");

const actual = normalize(await page.locator("#text").inputValue());
const expected = normalize(clip.reference);
const cer = distance(actual, expected) / Math.max(1, expected.length);
assert.ok(cer <= Number(golden._cer_tolerance), "voice CER exceeded pinned tolerance");

const voiceEdge = `${voiceDecision.answers.source.choice}->${voiceDecision.answers.target.choice}`;
const bothEdges = [typedEdge, voiceEdge].sort();
assert.deepEqual(await confirmedFacts(), bothEdges);

const drawn = await drawnEdges();
assert.equal(drawn.pattern, "graph/1");
assert.equal(drawn.svg, true);
assert.deepEqual(drawn.edges, bothEdges, "the drawn graph must hold exactly the confirmed edges");

// Both decisions come back from this origin's storage after a reload.
const saved = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
assert.ok(saved, "confirmed decisions must be persisted");
await page.reload({ waitUntil: "commit" });
await page.waitForFunction(() => window.voiceUiReady === true, null, { timeout: 120000 });
assert.equal(await page.evaluate(() => document.body.dataset.state), "confirmed");
assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), saved);
assert.deepEqual(await confirmedFacts(), bothEdges);
assert.deepEqual((await drawnEdges()).edges, bothEdges);

assert.deepEqual(errors, []);
assert.deepEqual(failedRequests, []);
assert.deepEqual(failedResponses, []);

await browser.close();
process.stdout.write(
  `public-e2e: PASS v1 contract direct | typed edge=${typedEdge} + voice edge=${voiceEdge} `
  + "confirmed, drawn and restored after reload\n",
);
