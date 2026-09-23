import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) throw new Error("localhost URL is required");

const wav = process.env.VOICE_WAV;
const goldenPath = process.env.VOICE_GOLDEN;
if (!wav || !goldenPath) throw new Error("VOICE_WAV and VOICE_GOLDEN are required");

// The spoken correction. Chromium's fake microphone plays one file per browser
// process, so the correction is heard by a second browser.
const correctionWav = process.env.VOICE_CORRECTION_WAV;
const correctionGoldenPath = process.env.VOICE_CORRECTION_GOLDEN;
if (!correctionWav || !correctionGoldenPath) {
  throw new Error("VOICE_CORRECTION_WAV and VOICE_CORRECTION_GOLDEN are required");
}

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

const errors = [];
const failedResponses = [];

const watch = target => {
  target.on("pageerror", error => errors.push(String(error)));
  target.on("response", response => {
    if (response.status() >= 400) {
      failedResponses.push(response.status() + " " + response.url());
    }
  });
  return target;
};

// One browser process per spoken file. `storageState` carries this origin's
// storage - bytes the app itself wrote - from one process to the next in
// memory, the way a restarted browser would find it on disk.
const openBrowser = async (audio, storageState) => {
  const opened = await chromium.launch({
    headless: true,
    // The full browser, not the reduced `chrome-headless-shell` that `headless:
    // true` selects on its own. The shell cannot load this page - it loses the
    // renderer during module load, on the unmodified page as well as this one -
    // and the full build is what a person actually runs anyway.
    channel: "chromium",
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-audio-capture=" + path.resolve(audio),
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await opened.newContext(storageState ? { storageState } : {});
  await context.grantPermissions(["microphone"], { origin: new URL(url).origin });
  return { browser: opened, context, page: watch(await context.newPage()) };
};

const readGolden = (file, audio) => {
  const golden = JSON.parse(fs.readFileSync(file, "utf8"));
  const clip = golden.clips.find(value => value.wav === path.basename(audio));
  assert.ok(clip, `voice golden fixture is missing for ${audio}`);
  return { reference: clip.reference, tolerance: Number(golden._cer_tolerance) };
};

const assertHeard = (text, { reference, tolerance }) => {
  assert.ok(text.trim().length > 0, "no recognised text reached Jev");
  const cer = distance(normalize(text), normalize(reference)) / Math.max(1, normalize(reference).length);
  assert.ok(cer <= tolerance, `voice CER ${cer} exceeded pinned tolerance: heard "${text}", expected "${reference}"`);
};

const ready = target =>
  target.waitForFunction(() => window.voiceUiReady === true, null, { timeout: 120000 });

// An action has settled once the page leaves `pending`. Every input and every
// button sets `pending` synchronously when clicked.
const settle = target =>
  target.waitForFunction(() => document.body.dataset.state !== "pending", null, { timeout: 360000 });

// Everything the screen claims, read in one pass. `state` is the authority the
// app sets on the body; the rest is what a person would actually see.
const screen = target => target.evaluate(key => ({
  state: document.body.dataset.state,
  status: document.querySelector("#status").textContent,
  initialLine: document.querySelector("[data-history=initial]")?.textContent ?? null,
  confirmed: [...document.querySelectorAll("[data-history=confirmed] li")]
    .map(item => item.dataset.facts),
  failure: document.querySelector("[data-history=failure]")?.textContent ?? null,
  proposal: document.querySelector("#proposal").hidden
    ? null
    : [...document.querySelectorAll("#proposal-changes li")].map(item => item.dataset.change),
  sendDisabled: document.querySelector("#send").disabled,
  micDisabled: document.querySelector("#mic").disabled,
  confirmDisabled: document.querySelector("#confirm").disabled,
  frames: document.querySelectorAll('iframe[data-package="semantic-map"]').length,
  stored: localStorage.getItem(key),
}), STORAGE_KEY);

// The live maxGraph adapter inside the mounted iframe. Its edges are the only
// committed-edge evidence that counts: not the envelope, not the status text.
// A proposal is drawn as a review overlay on top of them, never into them.
const drawn = target => target.evaluate(async () => {
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
    edges: [...adapter.edgesByProjectionKey.values()]
      .map(edge => `${edge.semantic.from}->${edge.semantic.to}`)
      .sort(),
    proposal: Boolean(win.semanticMapSite.runtime.proposal),
    svg: Boolean(box && box.width > 0 && box.height > 0),
  };
});

const jevExchange = target => ({
  request: target.waitForRequest(
    value => new URL(value.url()).pathname === "/api/jev" && value.method() === "POST",
    { timeout: 360000 },
  ),
  response: target.waitForResponse(
    value => new URL(value.url()).pathname === "/api/jev" && value.request().method() === "POST",
    { timeout: 360000 },
  ),
});

// Speak or type, and return what was sent and what Jev answered once the page
// has settled.
const ask = async (target, act) => {
  const exchange = jevExchange(target);
  await act();
  const request = await exchange.request;
  const response = await exchange.response;
  assert.equal(response.status(), 200);
  await settle(target);
  return { sent: JSON.parse(request.postData()), decision: await response.json() };
};

const speak = target => ask(target, () => target.locator("#mic").click());
const type = (target, value) => ask(target, async () => {
  await target.locator("#text").fill(value);
  await target.locator("#send").click();
});
const press = async (target, selector) => {
  await target.locator(selector).click();
  await settle(target);
};

const edgeOf = answers => `${answers.source.choice}->${answers.target.choice}`;

const addGolden = readGolden(goldenPath, wav);
const correctionGolden = readGolden(correctionGoldenPath, correctionWav);

const first = await openBrowser(wav);
let page = first.page;

const navigation = await page.goto(url, { waitUntil: "commit", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await ready(page);
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// (i) A first visit starts from the bounded initial graph. It is drawn, so the
// screen shows where this session began - and it carries no confirmed fact and
// no edge, so nothing about it can be mistaken for a decision.
const opening = await screen(page);
assert.equal(opening.state, "initial");
assert.equal(opening.stored, null, "a first visit must not have a stored log");
assert.deepEqual(opening.confirmed, [], "a first visit must have no confirmed facts");
assert.equal(opening.proposal, null, "a first visit must have no proposal");
assert.equal(opening.frames, 1, "the initial graph must be drawn");
assert.equal(opening.sendDisabled, false);
assert.equal(opening.micDisabled, false);
assert.equal(opening.confirmDisabled, true, "there is nothing to confirm yet");

const beforeVoice = await drawn(page);
assert.equal(beforeVoice.pattern, "graph/1");
assert.equal(beforeVoice.cells, 4, "expected root boundary plus three initial regions");
assert.deepEqual(beforeVoice.edges, [], "the initial graph must have no edges");

// (ii) The spoken utterance becomes a proposal - drawn, but not applied. Nothing
// is written and the committed graph has no edge yet.
const voiceAdd = await speak(page);
assert.equal(voiceAdd.sent.kind, "voice-ui.jev.request.v3");
assert.deepEqual(voiceAdd.sent.graph, { regions: ["node-a", "node-b", "node-c"], edges: [] });
assert.deepEqual(voiceAdd.sent.focus, { kind: "none", changes: [] });
assertHeard(voiceAdd.sent.text, addGolden);

assert.equal(voiceAdd.decision.kind, "voice-ui.jev.decision.v3");
assert.equal(voiceAdd.decision.answers.action.choice, "add-edge");
const voiceEdge = edgeOf(voiceAdd.decision.answers);

const proposedAdd = await screen(page);
assert.equal(proposedAdd.state, "proposed");
assert.deepEqual(proposedAdd.proposal, [`+${voiceEdge}`]);
assert.equal(proposedAdd.stored, null, "a proposal must not be saved");
assert.deepEqual(proposedAdd.confirmed, [], "a proposal is not a fact");
assert.equal(proposedAdd.confirmDisabled, false);

const proposedDrawing = await drawn(page);
assert.equal(proposedDrawing.proposal, true, "the proposal must be drawn over the graph");
assert.deepEqual(proposedDrawing.edges, [], "a proposal must not be drawn as a committed edge");
assert.equal(proposedDrawing.svg, true);

// (ii-b) The map's own review Accept has no authority. Whether it is shown
// enabled or not, activating it must not save, confirm or draw anything.
const frameAccept = await page.evaluate(() => {
  const button = document.querySelector('iframe[data-package="semantic-map"]')
    ?.contentDocument?.querySelector("#review-accept");
  if (!button) return { present: false };
  const disabled = button.disabled;
  button.click();
  return { present: true, disabled };
});
await page.waitForTimeout(500);
const afterFrameAccept = await screen(page);
assert.equal(afterFrameAccept.stored, null, "the frame's Accept must not save anything");
assert.deepEqual(afterFrameAccept.confirmed, [], "the frame's Accept must not confirm anything");
assert.deepEqual(afterFrameAccept.proposal, [`+${voiceEdge}`], "the app's proposal must still be pending");
assert.deepEqual((await drawn(page)).edges, [], "the frame's Accept must not commit an edge");

// (iii) Confirm is the only way in: the proposal is applied exactly as shown,
// saved, and drawn as a committed edge.
await press(page, "#confirm");
const committed = await screen(page);
assert.equal(committed.state, "confirmed");
assert.equal(committed.proposal, null);
assert.deepEqual(committed.confirmed, [`+${voiceEdge}`]);
assert.equal(committed.failure, null);
assert.ok(committed.stored, "the confirmed decision must have been persisted");
const savedLog = committed.stored;

const afterConfirm = await drawn(page);
assert.deepEqual(afterConfirm.edges, [voiceEdge]);
assert.equal(afterConfirm.proposal, false);
assert.equal(afterConfirm.cells, 4);

// (iv) Reload. The same graph and the same history come back from storage, with
// no second utterance and no second decision: this is restore, not a replay.
await page.reload({ waitUntil: "commit" });
await ready(page);
const restored = await screen(page);
assert.equal(restored.state, "confirmed");
assert.equal(restored.stored, savedLog, "reload must not rewrite the stored log");
assert.deepEqual(restored.confirmed, [`+${voiceEdge}`]);
assert.equal(restored.frames, 1);
assert.match(restored.initialLine, /\(0 edges\)/u, "the initial graph must still read as edgeless");
assert.deepEqual((await drawn(page)).edges, [voiceEdge]);

// What the second browser starts from: exactly what this one saved.
const afterVoiceAdd = await first.context.storageState();

// (v) A stored log the provider rejects is damage. The app fails closed, keeps
// the bytes exactly as they are, and refuses both inputs.
await page.evaluate(([key, value]) => localStorage.setItem(key, value), [STORAGE_KEY, CORRUPT_LOG]);
await page.reload({ waitUntil: "commit" });
await ready(page);
const corrupt = await screen(page);
assert.equal(corrupt.state, "failed");
assert.equal(corrupt.stored, CORRUPT_LOG, "a rejected log must not be deleted or overwritten");
assert.deepEqual(corrupt.confirmed, [], "a rejected log must not restore any fact");
assert.ok(corrupt.failure, "a rejected log must be reported on screen");
assert.equal(corrupt.sendDisabled, true, "typing must be refused while the stored log is unreadable");
assert.equal(corrupt.micDisabled, true, "voice must be refused while the stored log is unreadable");
assert.deepEqual((await drawn(page)).edges, [], "a rejected log must not draw an edge");

// (vi) It is not transient. Reloading alone does not clear it, which is the
// whole point: there is no in-app reset that could quietly discard the evidence.
await page.reload({ waitUntil: "commit" });
await ready(page);
const stillCorrupt = await screen(page);
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
await ready(page);
const foreign = await screen(page);
assert.equal(foreign.state, "failed", "a foreign but valid log must fail closed");
assert.equal(foreign.stored, foreignLog, "a foreign log must not be deleted or overwritten");
assert.deepEqual(foreign.confirmed, [], "a foreign log must not present any fact");
assert.match(foreign.failure ?? "", /genesis/u);
assert.doesNotMatch(foreign.initialLine, /node-z/u, "a foreign map must not be shown as the initial graph");
assert.equal(foreign.sendDisabled, true);
assert.equal(foreign.micDisabled, true);
assert.deepEqual((await drawn(page)).edges, [], "a foreign log must not draw an edge");

// (vii) Clearing this origin's storage from outside the app is the documented
// way out, and it works: the app comes back to a first visit.
await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY);
await page.reload({ waitUntil: "commit" });
await ready(page);
const recovered = await screen(page);
assert.equal(recovered.state, "initial");
assert.equal(recovered.stored, null);
assert.deepEqual(recovered.confirmed, []);
assert.equal(recovered.sendDisabled, false);
assert.equal(recovered.micDisabled, false);

// (viii) Typed input takes the same proposal path as voice. It runs on the
// recovered, edgeless graph, so it cannot borrow the utterance's result.
const typedFirst = await type(page, "add an edge from a to b");
assert.equal(typedFirst.sent.kind, "voice-ui.jev.request.v3", "Send must use the typed graph decision");
assert.equal(typedFirst.decision.answers.action.choice, "add-edge");
const dismissedEdge = edgeOf(typedFirst.decision.answers);
assert.deepEqual((await screen(page)).proposal, [`+${dismissedEdge}`]);

// Dismiss drops it without writing anything.
await press(page, "#dismiss");
const dismissed = await screen(page);
assert.equal(dismissed.state, "dismissed");
assert.equal(dismissed.proposal, null);
assert.equal(dismissed.stored, null, "a dismissed proposal must not be saved");
assert.deepEqual(dismissed.confirmed, []);
const afterDismiss = await drawn(page);
assert.deepEqual(afterDismiss.edges, []);
assert.equal(afterDismiss.proposal, false);

// A new input replaces the proposal on screen; only the latest is confirmed.
await type(page, "add an edge from a to b");
const replacing = await type(page, "add an edge from b to c");
assert.equal(replacing.decision.answers.action.choice, "add-edge");
const typedEdge = edgeOf(replacing.decision.answers);
assert.notEqual(typedEdge, dismissedEdge, "precondition: Jev must choose the new pair");
assert.deepEqual((await screen(page)).proposal, [`+${typedEdge}`], "the newer proposal must replace the older one");

await press(page, "#confirm");
const afterTyped = await screen(page);
assert.equal(afterTyped.state, "confirmed");
assert.deepEqual(afterTyped.confirmed, [`+${typedEdge}`], "only the replacing proposal may be applied");
assert.ok(afterTyped.stored, "a typed decision must be persisted like a spoken one");
assert.deepEqual((await drawn(page)).edges, [typedEdge]);

// (ix) And it survives a reload the same way.
await page.reload({ waitUntil: "commit" });
await ready(page);
const typedRestored = await screen(page);
assert.equal(typedRestored.state, "confirmed");
assert.deepEqual(typedRestored.confirmed, [`+${typedEdge}`]);
assert.deepEqual((await drawn(page)).edges, [typedEdge]);

// The negatives below each start from this confirmed state and must leave it
// exactly as it is: no new fact, no new edge, not one stored byte changed.
const assertUnchanged = async (label, state, pattern) => {
  const now = await screen(page);
  assert.equal(now.state, state, `${label} must end as ${state}`);
  if (pattern) assert.match(now.failure ?? "", pattern, `${label} must fail for its own reason`);
  else assert.equal(now.failure, null, `${label} is not an error`);
  assert.deepEqual(now.confirmed, typedRestored.confirmed, `${label} must add no fact`);
  assert.equal(now.stored, typedRestored.stored, `${label} must not change the stored log`);
  assert.deepEqual((await drawn(page)).edges, [typedEdge], `${label} must draw no new edge`);
  assert.equal(now.sendDisabled, false, `${label} must not block the app`);
  return now;
};

// (x) Duplicate: the confirmed request again. Jev choosing the same pair is the
// precondition; the proposal code must then refuse it.
const duplicate = await type(page, "add an edge from b to c");
assert.equal(duplicate.decision.answers.action.choice, "add-edge");
assert.equal(edgeOf(duplicate.decision.answers), typedEdge, "precondition: Jev must choose the confirmed pair");
const afterDuplicate = await assertUnchanged("a duplicate", "failed", /relation already exists/u);
assert.equal(afterDuplicate.proposal, null, "a refusal must not produce a proposal");

// (xi) No change: text that asks for nothing. This is a neutral answer, not an
// error, and it proposes nothing.
const nothing = await type(page, "what is the weather like today");
assert.equal(nothing.decision.answers.action.choice, "none", "precondition: Jev must answer with no action");
await assertUnchanged("no change", "no-change", null);

// (xi-b) And a no-change answer leaves a pending proposal exactly where it was.
const pending = await type(page, "add an edge from a to b");
let pendingEdge = edgeOf(pending.decision.answers);
assert.deepEqual((await screen(page)).proposal, [`+${pendingEdge}`]);
await type(page, "what is the weather like today");
const stillPending = await screen(page);
assert.equal(stillPending.state, "no-change");
assert.deepEqual(stillPending.proposal, [`+${pendingEdge}`], "no change must not discard the pending proposal");
assert.equal(stillPending.stored, typedRestored.stored);

// (xi-c) Empty input asks for nothing: no request reaches Jev at all, the
// answer is a neutral no-change, and the pending proposal stays.
let jevRequests = 0;
const countJev = request => {
  if (new URL(request.url()).pathname === "/api/jev") jevRequests += 1;
};
page.on("request", countJev);
for (const blank of ["", "   "]) {
  await page.locator("#text").fill(blank);
  await page.locator("#send").click();
  await settle(page);
  const afterBlank = await screen(page);
  assert.equal(afterBlank.state, "no-change", `${JSON.stringify(blank)} must be a no-change`);
  assert.equal(afterBlank.failure, null, `${JSON.stringify(blank)} is not an error`);
  assert.deepEqual(afterBlank.proposal, [`+${pendingEdge}`], `${JSON.stringify(blank)} must keep the pending proposal`);
}
page.off("request", countJev);
assert.equal(jevRequests, 0, "empty input must send no request to Jev");

// (xi-d) While a proposal is pending, "reverse that" is about the proposal. The
// page must never answer it by reversing or removing some other, committed
// edge and silently discarding the user's proposal. Jev may answer with a
// replacing addition (a new proposal) or pick a committed edge (then it is a
// no-change and the proposal stays); either way nothing is removed or saved.
const aboutPending = await type(page, "reverse that");
const afterAboutPending = await screen(page);
assert.equal(afterAboutPending.stored, typedRestored.stored, "nothing may be saved");
assert.ok(
  (afterAboutPending.proposal ?? []).every(change => change.startsWith("+")),
  `a pending addition must not turn into a removal of a committed edge: ${JSON.stringify(afterAboutPending.proposal)}`,
);
assert.deepEqual((await drawn(page)).edges, [typedEdge], "no committed edge may move");
const pendingOutcome = afterAboutPending.state === "no-change"
  ? `no-change (Jev chose ${aboutPending.decision.answers.action.choice})`
  : `replaced by ${JSON.stringify(afterAboutPending.proposal)}`;
if (afterAboutPending.state === "no-change") {
  assert.match(afterAboutPending.status, /a proposal is pending/u);
  assert.deepEqual(afterAboutPending.proposal, [`+${pendingEdge}`], "the pending proposal must stay");
} else {
  assert.equal(afterAboutPending.state, "proposed");
  assert.equal(aboutPending.decision.answers.action.choice, "add-edge");
  assert.equal(afterAboutPending.proposal.length, 1);
  pendingEdge = afterAboutPending.proposal[0].slice(1);
}

// (xii) Storage write failure: a real quota exhaustion, not a stub. Every byte
// this origin may still store is taken by filler keys, then the pending sound
// proposal is confirmed. Only the write can fail it - and a write that does not
// land must leave the graph, the history and the screen untouched, with the
// proposal still there to retry.
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

await press(page, "#confirm");
const afterFailedWrite = await assertUnchanged("a failed write", "failed", /not persisted/u);
assert.deepEqual(afterFailedWrite.proposal, [`+${pendingEdge}`], "an unsaved proposal must stay available to retry");

await page.evaluate(count => {
  for (let index = 0; index < count; index += 1) localStorage.removeItem(`quota-filler-${index}`);
}, fillers);
await press(page, "#dismiss");

// (xiii) Two tabs of one origin. Each proposes; the other tab confirms first.
// This tab's Confirm must then be refused rather than overwrite the history the
// other tab just saved, and this tab stops until a reload.
const otherTab = watch(await first.context.newPage());
await otherTab.goto(url, { waitUntil: "commit", timeout: 120000 });
await ready(otherTab);
const mine = await type(page, "add an edge from a to b");
assert.equal((await screen(page)).state, "proposed", `precondition: this tab must hold a proposal (${edgeOf(mine.decision.answers)})`);
const theirs = await type(otherTab, "add an edge from c to a");
const theirEdge = edgeOf(theirs.decision.answers);
await press(otherTab, "#confirm");
const theirSaved = (await screen(otherTab)).stored;
assert.notEqual(theirSaved, typedRestored.stored, "precondition: the other tab must have saved");

await press(page, "#confirm");
const conflicted = await screen(page);
assert.equal(conflicted.state, "failed");
assert.match(conflicted.failure ?? "", /changed elsewhere/u);
assert.equal(conflicted.stored, theirSaved, "the other tab's history must not be overwritten");
assert.equal(conflicted.sendDisabled, true, "a page behind storage must stop until reloaded");
assert.equal(conflicted.proposal, null);
await otherTab.close();

// And storage agrees: after a reload, nothing from the failures exists and the
// other tab's confirmed change is what this tab now sees.
await page.reload({ waitUntil: "commit" });
await ready(page);
const afterNegatives = await screen(page);
assert.equal(afterNegatives.state, "confirmed");
assert.equal(afterNegatives.stored, theirSaved);
assert.deepEqual(afterNegatives.confirmed, [`+${typedEdge}`, `+${theirEdge}`]);
assert.deepEqual((await drawn(page)).edges, [typedEdge, theirEdge].sort());

// (xiii-b) Saved, but not displayed. The decision is confirmed and its write
// lands; only the drawing that follows fails - the semantic-map frame document
// is refused for exactly that one render, so the frame never becomes ready and
// the runtime gives up. Storage now leads the screen, so the page must say so,
// block every further action, and a reload must draw what was saved.
const beforeUndrawn = afterNegatives.stored;
const undrawnRequest = await type(page, "add an edge from a to b");
const undrawnEdge = edgeOf(undrawnRequest.decision.answers);
assert.deepEqual((await screen(page)).proposal, [`+${undrawnEdge}`]);

const frameDocument = new URL("/ui/semantic-map/authoring/pages/embed.html", url).href;
const injected = [];
const noteInjected = request => {
  if (request.url() === frameDocument) injected.push(request.failure()?.errorText ?? "failed");
};
page.on("requestfailed", noteInjected);
await page.route(frameDocument, route => route.abort("failed"), { times: 1 });

await press(page, "#confirm");
const undrawn = await screen(page);
page.off("requestfailed", noteInjected);
assert.equal(undrawn.state, "saved-display-failed");
assert.match(undrawn.failure ?? "", /display failed/u);
assert.notEqual(undrawn.stored, beforeUndrawn, "the write must have landed before the drawing failed");
assert.equal(undrawn.stored.split("\n").length, beforeUndrawn.split("\n").length + 1, "exactly one Decision must be added");
assert.equal(undrawn.sendDisabled, true, "typing must stop while the screen is behind storage");
assert.equal(undrawn.micDisabled, true, "voice must stop while the screen is behind storage");
assert.equal(undrawn.confirmDisabled, true, "confirming must stop while the screen is behind storage");
assert.deepEqual(injected, ["net::ERR_FAILED"], "the only refused request must be the injected frame document");

await page.reload({ waitUntil: "commit" });
await ready(page);
const redrawn = await screen(page);
assert.equal(redrawn.state, "confirmed");
assert.equal(redrawn.stored, undrawn.stored, "reload must draw what was saved, not rewrite it");
assert.deepEqual(redrawn.confirmed, [`+${typedEdge}`, `+${theirEdge}`, `+${undrawnEdge}`]);
assert.deepEqual((await drawn(page)).edges, [typedEdge, theirEdge, undrawnEdge].sort());
assert.equal(redrawn.sendDisabled, false);

await first.browser.close();

// (xiv) The spoken correction, heard by browsers that hear only the correction
// file and start from exactly what the first browser saved after the spoken
// add. The utterance names no node: which edge it means comes from the focus
// the page sends with it.
//
// Each hearing gets its own browser process. The fake microphone loops its
// file from process start, so a second capture in the same process can begin
// part-way through the utterance and hear it clipped; a fresh process always
// hears it from the beginning.
const openCorrection = async storageState => {
  const opened = await openBrowser(correctionWav, storageState);
  page = opened.page;
  await page.goto(url, { waitUntil: "commit", timeout: 120000 });
  await ready(page);
  const carried = await screen(page);
  assert.equal(carried.state, "confirmed");
  assert.equal(carried.stored, savedLog, "a correction browser must start from the saved spoken add");
  assert.deepEqual(carried.confirmed, [`+${voiceEdge}`]);
  assert.deepEqual((await drawn(page)).edges, [voiceEdge]);
  return opened;
};

const second = await openCorrection(afterVoiceAdd);

const [voiceFrom, voiceTo] = voiceEdge.split("->");
const reversedEdge = `${voiceTo}->${voiceFrom}`;

const hearCorrection = async () => {
  const heard = await speak(page);
  assert.equal(heard.sent.kind, "voice-ui.jev.request.v3");
  assert.deepEqual(heard.sent.graph.edges.map(edge => `${edge.from}->${edge.to}`), [voiceEdge]);
  assert.deepEqual(heard.sent.focus, { kind: "confirmed", changes: [{ change: "added", from: voiceFrom, to: voiceTo }] });
  assertHeard(heard.sent.text, correctionGolden);
  assert.equal(heard.decision.answers.action.choice, "reverse-edge");
  assert.equal(heard.decision.answers.edge.choice, heard.sent.graph.edges[0].id);

  const now = await screen(page);
  assert.equal(now.state, "proposed");
  assert.deepEqual(now.proposal, [`-${voiceEdge}`, `+${reversedEdge}`]);
  assert.equal(now.stored, savedLog, "a spoken correction is only a proposal until confirmed");
  const drawing = await drawn(page);
  assert.deepEqual(drawing.edges, [voiceEdge], "the committed edge must not move before Confirm");
  assert.equal(drawing.proposal, true);
  return heard.sent.text;
};

const firstHearing = await hearCorrection();

// Dismissed: nothing changes.
await press(page, "#dismiss");
const afterCorrectionDismiss = await screen(page);
assert.equal(afterCorrectionDismiss.state, "dismissed");
assert.equal(afterCorrectionDismiss.stored, savedLog);
assert.deepEqual((await drawn(page)).edges, [voiceEdge]);

// Dismissing wrote nothing, so the next browser starts from the same saved add.
const afterDismissState = await second.context.storageState();
await second.browser.close();

// Spoken again, proposed again, and this time confirmed: the reverse applies as
// one Decision.
const third = await openCorrection(afterDismissState);
const secondHearing = await hearCorrection();
await press(page, "#confirm");
const corrected = await screen(page);
assert.equal(corrected.state, "confirmed");
assert.deepEqual(corrected.confirmed, [`+${voiceEdge}`, `-${voiceEdge} +${reversedEdge}`]);
assert.notEqual(corrected.stored, savedLog);
assert.deepEqual((await drawn(page)).edges, [reversedEdge]);

// (xv) Reload in the same browser: the final graph and both history entries
// come back from storage.
await page.reload({ waitUntil: "commit" });
await ready(page);
const final = await screen(page);
assert.equal(final.state, "confirmed");
assert.equal(final.stored, corrected.stored);
assert.deepEqual(final.confirmed, [`+${voiceEdge}`, `-${voiceEdge} +${reversedEdge}`]);
assert.deepEqual((await drawn(page)).edges, [reversedEdge]);

await third.browser.close();

assert.deepEqual(errors, []);
assert.deepEqual(failedResponses, []);

process.stdout.write(
  `local-voice-graph-e2e: PASS voice add proposed then confirmed edge=${voiceEdge} `
  + `(frame Accept ${frameAccept.present ? (frameAccept.disabled ? "present, disabled" : "present, enabled, inert") : "absent"}) `
  + `| restored after reload | corrupt and foreign logs fail closed | typed dismiss, replace, confirm edge=${typedEdge} `
  + `| duplicate, no-change, empty input (0 Jev requests), failed write and cross-tab conflict leave storage unchanged `
  + `| "reverse that" over a pending proposal: ${pendingOutcome} `
  + `| saved-but-undrawn ${undrawnEdge} blocks, then reload draws it `
  + `| spoken correction heard as "${firstHearing}" / "${secondHearing}" -> reverse proposed, dismissed, re-proposed, `
  + `confirmed edge=${reversedEdge} | restored after reload\n`,
);
