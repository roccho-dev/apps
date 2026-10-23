import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoSecretInputs } from "../tests/runtime-acceptance.mjs";

// 14a, the part that needs no provider credential (apps#94; R 3/200): a recorded file is fed to the
// completed distribution's own recognizer through Chromium's fake audio capture, and the time from the
// end of the speech in the file to the transcript is measured. The page's own voice phases are timed in
// the page (document.body.dataset.voice: preparing -> listening -> deciding). Provider calls are answered
// 503 here, so nothing after transcription is measured; that half stays UNKNOWN until a live run.
//
// node asr-timing.mjs --dist <dir> --out <dir> --runs N --clip <wav>=<golden.json> [--clip ...]
//
// Speech end in the file = capture start ("listening") + leading pad + raw speech duration, both read
// from the clip's golden (_audio.pad[0] and _audio.raw.duration_s). This assumes Chromium starts the
// file at capture start; the raw times are kept so the assumption can be re-read.

assertNoSecretInputs();
const argv = process.argv.slice(2), clips = [];
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i].replace(/^--/u, ""), value = argv[i + 1];
  if (name === "clip") clips.push(value); else args[name] = value;
}
for (const name of ["dist", "out", "runs"]) assert.ok(typeof args[name] === "string", `--${name} is required`);
assert.ok(path.isAbsolute(args.dist) && path.isAbsolute(args.out) && clips.length > 0);
const runs = Number(args.runs);
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20, "--runs is 1..20");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = args.dist, site = path.join(root, "site"), key = "voice-ui.decision-log.v1";
const manifestBytes = fs.readFileSync(path.join(root, "manifest.json")), manifest = JSON.parse(manifestBytes);
for (const row of manifest.files) {
  const bytes = fs.readFileSync(path.resolve(root, row.path));
  assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256, row.path);
}
const protocol = await import(pathToFileURL(path.join(site, "ui/semantic-map/protocol/index.js")));
const { chromium } = createRequire(import.meta.url)("playwright-core");

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".md": "text/plain", ".svg": "image/svg+xml" };
const isolation = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin", "cache-control": "no-store" };
const api = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  // No provider here: every product API answers 503, the same as a server without a credential.
  if (pathname.startsWith("/api/")) { api.push(pathname); res.writeHead(503, { "content-type": "application/json", ...isolation }); res.end("{}"); return; }
  const file = path.resolve(site, pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
  if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, isolation); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", ...isolation });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const initial = await protocol.createDecisionLog([{ type: "meta", schema: "semantic-map-state/1", root: "root", title: "asr timing" },
  { type: "region", id: "root", label: "World", parent: null, kind: "boundary", bounds: [0, 0, 1000, 700], summary: "" },
  { type: "region", id: "canvas", label: "図", parent: "root", kind: "group", bounds: [0, 0, 1000, 700], summary: "" }], "voice-graph");

const normalize = value => value.normalize("NFKC").replace(/[\s。、．，,.!?！？・]/gu, "").toUpperCase();
const distance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + Number(a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
};
const quantile = (values, q) => {
  const sorted = [...values].sort((x, y) => x - y), at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

fs.mkdirSync(args.out, { recursive: true });
const samples = [];
try {
  for (const pair of clips) {
    const [wav, goldenPath] = pair.split("=");
    assert.ok(path.isAbsolute(wav) && path.isAbsolute(goldenPath), "--clip <abs wav>=<abs golden>");
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    const clip = golden.clips.find(c => c.wav === path.basename(wav));
    assert.ok(clip, "the golden names this wav");
    const wavBytes = fs.readFileSync(wav);
    assert.equal(hash(wavBytes), golden._audio.final.sha256, "the wav is the golden's final audio");
    const speechEndMs = (golden._audio.pad[0] + golden._audio.raw.duration_s) * 1000;
    for (let run = 1; run <= runs; run++) {
      const browser = await chromium.launch({ headless: true, channel: "chromium", args: [
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + wav,
        "--autoplay-policy=no-user-gesture-required"] });
      try {
        const context = await browser.newContext();
        await context.grantPermissions(["microphone"], { origin });
        const page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(String(error)));
        await page.addInitScript(([storageKey, log]) => {
          if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, log);
          // The page's own voice phases, timed where they happen.
          globalThis.__voicePhases = [];
          new MutationObserver(() => {
            const phase = document.body?.dataset.voice ?? null, last = globalThis.__voicePhases.at(-1);
            if (phase !== (last?.phase ?? null)) globalThis.__voicePhases.push({ phase, at: performance.now(), text: document.querySelector("#text")?.value ?? null });
          }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-voice"] });
        }, [key, initial.log]);
        await page.goto(origin);
        await page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending", null, { timeout: 120000 });
        // The first press after load also includes model preparation; it is kept and labelled.
        const click = await page.evaluate(() => { const at = performance.now(); document.querySelector("#mic").click(); return at; });
        await page.waitForFunction(() => globalThis.__voicePhases.some(p => p.phase === "deciding") || globalThis.__voicePhases.some(p => p.phase === null && p.at > 0)
          || document.body.dataset.state === "voice-failed", null, { timeout: 300000 });
        const phases = await page.evaluate(() => globalThis.__voicePhases);
        const text = await page.locator("#text").inputValue();
        const at = name => phases.find(p => p.phase === name)?.at ?? null;
        const listening = at("listening"), deciding = at("deciding");
        const cer = distance(normalize(text), normalize(clip.reference)) / Math.max(1, normalize(clip.reference).length);
        samples.push({ wav: path.basename(wav), run, click_ms: click, listening_ms: listening, deciding_ms: deciding,
          press_to_listening_ms: listening === null ? null : listening - click,
          speech_end_to_transcript_ms: listening === null || deciding === null ? null : deciding - (listening + speechEndMs),
          press_to_transcript_ms: deciding === null ? null : deciding - click, transcript: text, cer, phases, errors });
        await context.close();
      } finally { await browser.close(); }
    }
  }
} finally { await new Promise(resolve => server.close(resolve)); }

const valid = samples.filter(s => s.speech_end_to_transcript_ms !== null);
const stats = values => values.length ? { n: values.length, p50: quantile(values, .5), p95: quantile(values, .95), min: Math.min(...values), max: Math.max(...values) } : { n: 0 };
const byWav = Object.fromEntries([...new Set(samples.map(s => s.wav))].map(wav => [wav,
  stats(valid.filter(s => s.wav === wav).map(s => s.speech_end_to_transcript_ms))]));
const receipt = { schema: "voice-ui.asr-timing/1", scope: "14a recorded file -> local recognizer -> transcript; no provider, no real microphone, no human speech",
  sources: manifest.sources, manifest_sha256: hash(manifestBytes), runs_per_clip: runs,
  speech_end_assumption: "listening + golden _audio.pad[0] + _audio.raw.duration_s (Chromium starts the file at capture start)",
  speech_end_to_transcript_ms: { all: stats(valid.map(s => s.speech_end_to_transcript_ms)), byWav },
  press_to_transcript_ms: stats(samples.filter(s => s.press_to_transcript_ms !== null).map(s => s.press_to_transcript_ms)),
  transcripts_exact: samples.filter(s => s.cer === 0).length, samples_total: samples.length, missing_transcript: samples.length - valid.length,
  provider_after_transcript: "UNKNOWN (API answered 503 here)", api_calls_answered_503: api.length, samples };
fs.writeFileSync(path.join(args.out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ status: "DONE", all: receipt.speech_end_to_transcript_ms.all, byWav, exact: receipt.transcripts_exact, total: samples.length }));
