import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) throw new Error("localhost URL is required");

const wav = process.env.VOICE_WAV;
const goldenPath = process.env.VOICE_GOLDEN;
if (!wav || !goldenPath) throw new Error("VOICE_WAV and VOICE_GOLDEN are required");

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

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--use-file-for-fake-audio-capture=" + path.resolve(wav),
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin: new URL(url).origin });
const page = await context.newPage();

const errors = [];
const failedResponses = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("response", response => {
  if (response.status() >= 400) {
    failedResponses.push(response.status() + " " + response.url());
  }
});

const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await page.waitForFunction(() => window.voiceUiReady === true);
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// (i) The edge does not exist yet: nothing is rendered on the surface at all.
const surfaceBefore = await page.evaluate(() => ({
  html: document.querySelector("#surface").innerHTML.trim(),
  frames: document.querySelectorAll('iframe[data-package="semantic-map"]').length,
}));
assert.equal(surfaceBefore.frames, 0, "a semantic map was already mounted before the utterance");
assert.equal(surfaceBefore.html, "", "the surface was not empty before the utterance");

const jevCall = page.waitForRequest(
  request => new URL(request.url()).pathname === "/api/jev" && request.method() === "POST",
  { timeout: 360000 },
);
const jevResponse = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 360000 },
);

await page.locator("#mic").click();

const request = await jevCall;
const response = await jevResponse;
assert.equal(response.status(), 200);

await page.waitForFunction(
  () => document.querySelector("#status")?.textContent === "voice: rendered",
  null,
  { timeout: 360000 },
);

// (ii) The request carried the recognised text and the graph it was decided against.
const sent = JSON.parse(request.postData());
assert.equal(sent.kind, "voice-ui.jev.request.v2");
assert.deepEqual(sent.graph.regions, ["node-a", "node-b", "node-c"]);
assert.ok(sent.text.trim().length > 0, "no recognised text reached Jev");

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const clip = golden.clips.find(value => value.wav === path.basename(wav));
assert.ok(clip, "voice golden fixture is missing");
const cer = distance(normalize(sent.text), normalize(clip.reference))
  / Math.max(1, normalize(clip.reference).length);
assert.ok(cer <= Number(golden._cer_tolerance), `voice CER ${cer} exceeded pinned tolerance`);

// (iii) Jev answered with typed choices, read straight from the response body.
const decision = await response.json();
assert.equal(decision.kind, "voice-ui.jev.decision.v2");
assert.equal(decision.answers.action.choice, "add-edge");
const chosenSource = decision.answers.source.choice;
const chosenTarget = decision.answers.target.choice;
assert.ok(sent.graph.regions.includes(chosenSource));
assert.ok(sent.graph.regions.includes(chosenTarget));

// (iv) The live maxGraph adapter now holds exactly that edge. The expectation
// comes from the Jev response payload, never from the compiler under test.
const rendered = await page.evaluate(async () => {
  const frame = document.querySelector('iframe[data-package="semantic-map"]');
  if (!frame) throw new Error("semantic map iframe missing");

  const started = performance.now();
  while (frame.contentWindow?.semanticMapSite?.ready !== true) {
    if (performance.now() - started > 60000) throw new Error("semantic map ready timeout");
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const win = frame.contentWindow;
  const adapter = win.semanticMapApp.adapter;
  const svg = frame.contentDocument.querySelector("#graph-container svg");
  const box = svg?.getBoundingClientRect();
  return {
    pattern: win.semanticMapRuntime.view.pattern,
    cells: adapter.cellsByRegionId.size,
    edges: [...adapter.edgesByProjectionKey.values()].map(edge => ({
      from: edge.semantic.from,
      to: edge.semantic.to,
    })),
    svg: Boolean(box && box.width > 0 && box.height > 0),
  };
});

assert.equal(rendered.pattern, "graph/1");
assert.equal(rendered.cells, sent.graph.regions.length + 1, "expected root boundary plus one cell per graph region");
assert.equal(rendered.svg, true);
assert.equal(rendered.edges.length, 1, "expected exactly one edge after one add-edge decision");
assert.equal(rendered.edges[0].from, chosenSource);
assert.equal(rendered.edges[0].to, chosenTarget);

assert.deepEqual(errors, []);
assert.deepEqual(failedResponses, []);

await browser.close();
process.stdout.write(
  `local-voice-graph-e2e: PASS causal voice->hayamimi->jev->semantic-map->maxGraph `
  + `edge=${chosenSource}->${chosenTarget}\n`,
);
