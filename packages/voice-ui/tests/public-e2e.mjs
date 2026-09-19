import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) throw new Error("public URL is required");

const wav = process.env.VOICE_WAV;
const goldenPath = process.env.VOICE_GOLDEN;

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

const args = [];
if (wav) {
  args.push(
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--use-file-for-fake-audio-capture=" + path.resolve(wav),
    "--autoplay-policy=no-user-gesture-required",
  );
}

const browser = await chromium.launch({ headless: true, args });
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

await page.locator("#text").fill("public typed input proof");
const typeResponsePromise = page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/jev" && response.request().method() === "POST",
  { timeout: 120000 },
);
await page.locator("#send").click();
const typeResponse = await typeResponsePromise;
assert.equal(typeResponse.status(), 200);
const typeIr = await typeResponse.json();
assert.equal(typeIr.kind, "ui.ir.v1");
assert.equal(typeIr.capability, "a2ui-browser");
assert.equal(typeIr.payloadKind, "a2ui.surface.v1");
await page.waitForFunction(() => document.querySelector("#status")?.textContent === "type: rendered");
assert.ok(await page.locator('[data-a2ui-component="Text"]').count());
assert.match(await page.locator("#surface").innerText(), /Jev Noul:/u);

if (wav && goldenPath) {
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
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "voice: rendered", null, {
    timeout: 360000,
  });

  const actual = normalize(await page.locator("#text").inputValue());
  const expected = normalize(clip.reference);
  const cer = distance(actual, expected) / Math.max(1, expected.length);
  assert.ok(cer <= Number(golden._cer_tolerance), "voice CER exceeded pinned tolerance");
}

assert.deepEqual(errors, []);
assert.deepEqual(failedRequests, []);
assert.deepEqual(failedResponses, []);

await browser.close();
process.stdout.write("public-e2e: PASS\n");
