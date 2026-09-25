import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) throw new Error("localhost URL is required");

const wav = process.env.VOICE_WAV;
const goldenPath = process.env.VOICE_GOLDEN;
if (!wav || !goldenPath) throw new Error("VOICE_WAV and VOICE_GOLDEN are required");

const STORAGE_KEY = "voice-ui.decision-log.v1";
const CORRUPT_LOG = '{"not":"a decision"}\n';

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
  // The full browser, not the reduced `chrome-headless-shell` that `headless:
  // true` selects on its own. The shell cannot load this page - it loses the
  // renderer during module load, on the unmodified page as well as this one -
  // and the full build is what a person actually runs anyway.
  channel: "chromium",
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

const ready = () =>
  page.waitForFunction(() => window.voiceUiReady === true, null, { timeout: 120000 });

// Everything the screen claims, read in one pass. `state` is the authority the
// app sets on the body; the rest is what a person would actually see.
const screen = () => page.evaluate(key => ({
  state: document.body.dataset.state,
  status: document.querySelector("#status").textContent,
  initialLine: document.querySelector("[data-history=initial]")?.textContent ?? null,
  confirmed: [...document.querySelectorAll("[data-history=confirmed] li")]
    .map(item => item.dataset.fact),
  failure: document.querySelector("[data-history=failure]")?.textContent ?? null,
  sendDisabled: document.querySelector("#send").disabled,
  micDisabled: document.querySelector("#mic").disabled,
  frames: document.querySelectorAll('iframe[data-package="semantic-map"]').length,
  stored: localStorage.getItem(key),
}), STORAGE_KEY);

// The live maxGraph adapter inside the mounted iframe. This is the only edge
// evidence that counts: not the envelope, not the status text.
const drawn = () => page.evaluate(async () => {
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

const jevExchange = () => ({
  request: page.waitForRequest(
    value => new URL(value.url()).pathname === "/api/jev" && value.method() === "POST",
    { timeout: 360000 },
  ),
  response: page.waitForResponse(
    value => new URL(value.url()).pathname === "/api/jev" && value.request().method() === "POST",
    { timeout: 360000 },
  ),
});

const navigation = await page.goto(url, { waitUntil: "commit", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await ready();
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// (i) A first visit starts from the bounded initial graph. It is drawn, so the
// screen shows where this session began - and it carries no confirmed fact and
// no edge, so nothing about it can be mistaken for a decision.
const first = await screen();
assert.equal(first.state, "initial");
assert.equal(first.stored, null, "a first visit must not have a stored log");
assert.deepEqual(first.confirmed, [], "a first visit must have no confirmed facts");
assert.equal(first.frames, 1, "the initial graph must be drawn");
assert.equal(first.sendDisabled, false);
assert.equal(first.micDisabled, false);

const beforeVoice = await drawn();
assert.equal(beforeVoice.pattern, "graph/1");
assert.equal(beforeVoice.cells, 4, "expected root boundary plus three initial regions");
assert.deepEqual(beforeVoice.edges, [], "the initial graph must have no edges");

// (ii) The spoken utterance drives a real decision all the way to a drawn edge.
const voice = jevExchange();
await page.locator("#mic").click();
const voiceRequest = await voice.request;
const voiceResponse = await voice.response;
assert.equal(voiceResponse.status(), 200);

await page.waitForFunction(
  () => document.body.dataset.state === "confirmed",
  null,
  { timeout: 360000 },
);

const sent = JSON.parse(voiceRequest.postData());
assert.equal(sent.kind, "voice-ui.jev.request.v2");
assert.deepEqual(sent.graph.regions, ["node-a", "node-b", "node-c"]);
assert.ok(sent.text.trim().length > 0, "no recognised text reached Jev");

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const clip = golden.clips.find(value => value.wav === path.basename(wav));
assert.ok(clip, "voice golden fixture is missing");
const cer = distance(normalize(sent.text), normalize(clip.reference))
  / Math.max(1, normalize(clip.reference).length);
assert.ok(cer <= Number(golden._cer_tolerance), `voice CER ${cer} exceeded pinned tolerance`);

const decision = await voiceResponse.json();
assert.equal(decision.kind, "voice-ui.jev.decision.v2");
assert.equal(decision.answers.action.choice, "add-edge");
const voiceSource = decision.answers.source.choice;
const voiceTarget = decision.answers.target.choice;
assert.ok(sent.graph.regions.includes(voiceSource));
assert.ok(sent.graph.regions.includes(voiceTarget));

const afterVoice = await drawn();
assert.equal(afterVoice.cells, sent.graph.regions.length + 1, "expected root boundary plus one cell per graph region");
assert.equal(afterVoice.svg, true);
assert.equal(afterVoice.edges.length, 1, "expected exactly one edge after one add-edge decision");
assert.equal(afterVoice.edges[0].from, voiceSource);
assert.equal(afterVoice.edges[0].to, voiceTarget);

// (iii) The decision was saved before it was shown, and it is shown as a fact.
const committed = await screen();
assert.equal(committed.state, "confirmed");
assert.deepEqual(committed.confirmed, [`${voiceSource}->${voiceTarget}`]);
assert.equal(committed.failure, null);
assert.ok(committed.stored, "the confirmed decision must have been persisted");
const savedLog = committed.stored;

// (iv) Reload. The same graph and the same history come back from storage, with
// no second utterance and no second decision: this is restore, not a replay.
await page.reload({ waitUntil: "commit" });
await ready();
const restored = await screen();
assert.equal(restored.state, "confirmed");
assert.equal(restored.stored, savedLog, "reload must not rewrite the stored log");
assert.deepEqual(restored.confirmed, [`${voiceSource}->${voiceTarget}`]);
assert.equal(restored.frames, 1);
assert.match(restored.initialLine, /\(0 edges\)/u, "the initial graph must still read as edgeless");

const afterReload = await drawn();
assert.deepEqual(afterReload.edges, [{ from: voiceSource, to: voiceTarget }]);
assert.equal(afterReload.cells, 4);

// (v) A stored log the provider rejects is damage. The app fails closed, keeps
// the bytes exactly as they are, and refuses both inputs.
await page.evaluate(([key, value]) => localStorage.setItem(key, value), [STORAGE_KEY, CORRUPT_LOG]);
await page.reload({ waitUntil: "commit" });
await ready();
const corrupt = await screen();
assert.equal(corrupt.state, "failed");
assert.equal(corrupt.stored, CORRUPT_LOG, "a rejected log must not be deleted or overwritten");
assert.deepEqual(corrupt.confirmed, [], "a rejected log must not restore any fact");
assert.ok(corrupt.failure, "a rejected log must be reported on screen");
assert.equal(corrupt.sendDisabled, true, "typing must be refused while the stored log is unreadable");
assert.equal(corrupt.micDisabled, true, "voice must be refused while the stored log is unreadable");
assert.deepEqual((await drawn()).edges, [], "a rejected log must not draw an edge");

// (vi) It is not transient. Reloading alone does not clear it, which is the
// whole point: there is no in-app reset that could quietly discard the evidence.
await page.reload({ waitUntil: "commit" });
await ready();
const stillCorrupt = await screen();
assert.equal(stillCorrupt.state, "failed");
assert.equal(stillCorrupt.stored, CORRUPT_LOG);
assert.equal(stillCorrupt.sendDisabled, true);
assert.equal(stillCorrupt.micDisabled, true);

// (vi-b) A log the provider accepts is still not ours if it does not start from
// this app's initial graph. Its bytes are built by the pinned provider in the
// page - input setup, like the corrupt bytes above - and must be refused the
// same way: its regions are not the initial graph and its decision is no fact.
const foreignLog = await page.evaluate(async () => {
  const protocol = await import("/ui/semantic-map/protocol/index.js");
  const region = (id, x) => ({
    type: "region", id, parent: "root", label: id, kind: "node", bounds: [x, 90, 140, 64], summary: "",
  });
  const base = await protocol.createDecisionLog([
    { type: "meta", schema: "semantic-map-state/1", root: "root", title: "other graph" },
    { type: "region", id: "root", parent: null, label: "other graph", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
    region("node-z", 40),
    region("node-a", 250),
  ], "some-other-map");
  const { decision } = await protocol.createDecision(base.head, [{
    type: "ConnectRegions", relationId: "foreign-z-to-a", from: "node-z", to: "node-a", kind: "flow", label: "",
  }], base.records);
  const appended = await protocol.appendDecision(base.log, decision);
  await protocol.verifyDecisionLog(appended.log);
  return appended.log;
});
await page.evaluate(([key, value]) => localStorage.setItem(key, value), [STORAGE_KEY, foreignLog]);
await page.reload({ waitUntil: "commit" });
await ready();
const foreign = await screen();
assert.equal(foreign.state, "failed", "a foreign but valid log must fail closed");
assert.equal(foreign.stored, foreignLog, "a foreign log must not be deleted or overwritten");
assert.deepEqual(foreign.confirmed, [], "a foreign log must not present any fact");
assert.match(foreign.failure ?? "", /genesis/u);
assert.doesNotMatch(foreign.initialLine, /node-z/u, "a foreign map must not be shown as the initial graph");
assert.equal(foreign.sendDisabled, true);
assert.equal(foreign.micDisabled, true);
assert.deepEqual((await drawn()).edges, [], "a foreign log must not draw an edge");

// (vii) Clearing this origin's storage from outside the app is the documented
// way out, and it works: the app comes back to a first visit.
await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY);
await page.reload({ waitUntil: "commit" });
await ready();
const recovered = await screen();
assert.equal(recovered.state, "initial");
assert.equal(recovered.stored, null);
assert.deepEqual(recovered.confirmed, []);
assert.equal(recovered.sendDisabled, false);
assert.equal(recovered.micDisabled, false);

// (viii) Typed input takes the same committed path as voice. Running it on the
// recovered, edgeless graph keeps it independent of whatever the utterance
// chose, so neither proof can borrow the other's result.
const typed = jevExchange();
await page.locator("#text").fill("add an edge from a to b");
await page.locator("#send").click();
const typedRequest = await typed.request;
const typedResponse = await typed.response;
assert.equal(typedResponse.status(), 200);
await page.waitForFunction(
  () => document.body.dataset.state === "confirmed",
  null,
  { timeout: 360000 },
);

const typedSent = JSON.parse(typedRequest.postData());
assert.equal(typedSent.kind, "voice-ui.jev.request.v2", "Send must use the typed graph decision, not the v1 surface");
const typedDecision = await typedResponse.json();
assert.equal(typedDecision.kind, "voice-ui.jev.decision.v2");
const typedSource = typedDecision.answers.source.choice;
const typedTarget = typedDecision.answers.target.choice;

const afterTyped = await screen();
assert.equal(afterTyped.state, "confirmed");
assert.deepEqual(afterTyped.confirmed, [`${typedSource}->${typedTarget}`]);
assert.ok(afterTyped.stored, "a typed decision must be persisted like a spoken one");
assert.deepEqual((await drawn()).edges, [{ from: typedSource, to: typedTarget }]);

// (ix) And it survives a reload the same way.
await page.reload({ waitUntil: "commit" });
await ready();
const typedRestored = await screen();
assert.equal(typedRestored.state, "confirmed");
assert.deepEqual(typedRestored.confirmed, [`${typedSource}->${typedTarget}`]);
assert.deepEqual((await drawn()).edges, [{ from: typedSource, to: typedTarget }]);

// The negatives below each start from this confirmed state and must leave it
// exactly as it is: no new fact, no new edge, not one stored byte changed.
const settledTyped = async value => {
  const exchange = jevExchange();
  await page.locator("#text").fill(value);
  await page.locator("#send").click();
  const response = await exchange.response;
  await exchange.request;
  await page.waitForFunction(
    () => document.body.dataset.state !== "pending",
    null,
    { timeout: 360000 },
  );
  assert.equal(response.status(), 200);
  return response.json();
};

const assertUnchanged = async (label, pattern) => {
  const now = await screen();
  assert.equal(now.state, "failed", `${label} must end as failed`);
  assert.match(now.failure ?? "", pattern, `${label} must fail for its own reason`);
  assert.deepEqual(now.confirmed, typedRestored.confirmed, `${label} must add no fact`);
  assert.equal(now.stored, typedRestored.stored, `${label} must not change the stored log`);
  assert.deepEqual((await drawn()).edges, [{ from: typedSource, to: typedTarget }], `${label} must draw no edge`);
  assert.equal(now.sendDisabled, false, `${label} is an ordinary failure and must not block the app`);
};

// (x) Duplicate: the same request again. Jev choosing the same pair is the
// precondition; the committed path must then refuse it.
const duplicate = await settledTyped("add an edge from a to b");
assert.equal(duplicate.answers.action.choice, "add-edge");
assert.deepEqual(
  [duplicate.answers.source.choice, duplicate.answers.target.choice],
  [typedSource, typedTarget],
  "precondition: Jev must choose the already-confirmed pair",
);
await assertUnchanged("a duplicate", /relation already exists/u);

// (xi) Refusal: text that asks for no graph change.
const refusal = await settledTyped("what is the weather like today");
assert.equal(refusal.answers.action.choice, "none", "precondition: Jev must answer with no action");
await assertUnchanged("a refusal", /action is not add-edge/u);

// (xii) Storage write failure: a real quota exhaustion, not a stub. Every byte
// this origin may still store is taken by filler keys, then a new, valid edge is
// requested. The decision is sound, so only the write can fail it - and a write
// that does not land must leave the graph, the history and the screen untouched.
const fillers = await page.evaluate(() => {
  let size = 1 << 20;
  let count = 0;
  while (size >= 1) {
    try {
      localStorage.setItem(`quota-filler-${count}`, "x".repeat(size));
      count += 1;
    } catch {
      size = Math.floor(size / 2);
    }
  }
  return count;
});
assert.ok(fillers > 0, "storage quota could not be exhausted");

const unsaved = await settledTyped("add an edge from b to c");
assert.equal(unsaved.answers.action.choice, "add-edge");
const unsavedEdge = `${unsaved.answers.source.choice}->${unsaved.answers.target.choice}`;
assert.notEqual(unsavedEdge, `${typedSource}->${typedTarget}`, "precondition: Jev must choose a new pair");
await assertUnchanged("a failed write", /not persisted/u);

await page.evaluate(count => {
  for (let index = 0; index < count; index += 1) localStorage.removeItem(`quota-filler-${index}`);
}, fillers);

// And storage agrees: after a reload nothing from the three failures exists.
await page.reload({ waitUntil: "commit" });
await ready();
const afterNegatives = await screen();
assert.equal(afterNegatives.state, "confirmed");
assert.equal(afterNegatives.stored, typedRestored.stored);
assert.deepEqual(afterNegatives.confirmed, typedRestored.confirmed);
assert.deepEqual((await drawn()).edges, [{ from: typedSource, to: typedTarget }]);

assert.deepEqual(errors, []);
assert.deepEqual(failedResponses, []);

await browser.close();
process.stdout.write(
  `local-voice-graph-e2e: PASS causal voice->hayamimi->jev->semantic-map->maxGraph `
  + `edge=${voiceSource}->${voiceTarget} | restored after reload | corrupt and foreign logs fail `
  + `closed and recover only after an out-of-app clear | typed edge=${typedSource}->${typedTarget} `
  + `| duplicate, refusal and failed write (${unsavedEdge}) leave graph, history and storage unchanged\n`,
);
