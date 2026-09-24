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
// app sets on the body; the rest is what a person would actually see in the
// two panes, plus the exact bytes this origin has stored.
const screen = target => target.evaluate(key => ({
  state: document.body.dataset.state,
  status: document.querySelector("#status").textContent,
  initialLine: document.querySelector("[data-history=initial]")?.textContent ?? null,
  // 確定図's applied entries.
  confirmed: [...document.querySelectorAll("[data-history=confirmed] li")]
    .map(item => item.dataset.facts),
  failure: document.querySelector("[data-history=failure]")?.textContent ?? null,
  // 作業図's unapplied steps.
  draft: [...document.querySelectorAll("#draft li")].map(item => item.dataset.changes),
  draftCount: document.querySelector("#draft-count").textContent,
  notice: document.querySelector("#working-notice")?.textContent ?? null,
  sendDisabled: document.querySelector("#send").disabled,
  micDisabled: document.querySelector("#mic").disabled,
  undoDisabled: document.querySelector("#undo").disabled,
  discardDisabled: document.querySelector("#discard").disabled,
  applyDisabled: document.querySelector("#apply").disabled,
  revertDisabled: [...document.querySelectorAll("button[data-revert]")].map(button => button.disabled),
  frames: {
    confirmed: document.querySelectorAll('#confirmed-surface iframe[data-package="semantic-map"]').length,
    working: document.querySelectorAll('#working-surface iframe[data-package="semantic-map"]').length,
    total: document.querySelectorAll('iframe[data-package="semantic-map"]').length,
  },
  stored: localStorage.getItem(key),
  storageKeys: Object.keys(localStorage).sort(),
}), STORAGE_KEY);

// The live maxGraph adapter inside one pane's own frame - selected by the
// pane, never "the first frame on the page". Its edges are the only drawn-edge
// evidence that counts: not the envelope, not the status text.
const drawn = (target, pane) => target.evaluate(async pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  if (!frame) throw new Error(`${pane} semantic map iframe missing`);

  const started = performance.now();
  while (frame.contentWindow?.semanticMapSite?.ready !== true) {
    if (performance.now() - started > 60000) throw new Error(`${pane} semantic map ready timeout`);
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
}, pane);

// Both panes' drawn edges.
const panes = async target => ({
  confirmed: (await drawn(target, "confirmed")).edges,
  working: (await drawn(target, "working")).edges,
});

// The embedded map's own review Accept has no authority in either pane.
// Whether it is shown enabled or not, activating it must change nothing.
const pressEmbeddedAccepts = target => target.evaluate(() =>
  ["confirmed", "working"].map(pane => {
    const button = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`)
      ?.contentDocument?.querySelector("#review-accept");
    if (!button) return `${pane}: absent`;
    const disabled = button.disabled;
    button.click();
    return `${pane}: present, ${disabled ? "disabled" : "enabled, inert"}`;
  }));

const sortedEdges = edges => edges.map(edge => `${edge.from}->${edge.to}`).sort();
const lineCount = log => log.split("\n").length - 1;

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
const flip = edge => edge.split("->").reverse().join("->");

// Every request this page sends to Jev, counted, so "no request at all" can be
// asserted rather than assumed.
const countJev = target => {
  const counter = { count: 0 };
  const listener = request => {
    if (new URL(request.url()).pathname === "/api/jev") counter.count += 1;
  };
  target.on("request", listener);
  counter.stop = () => target.off("request", listener);
  return counter;
};

const addGolden = readGolden(goldenPath, wav);
const correctionGolden = readGolden(correctionGoldenPath, correctionWav);

const first = await openBrowser(wav);
let page = first.page;

const navigation = await page.goto(url, { waitUntil: "commit", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await ready(page);
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// (i) A first visit: both panes are drawn from the same bounded initial graph,
// each in its own frame, nothing is stored, and 作業図 says it is not saved.
const opening = await screen(page);
assert.equal(opening.state, "initial");
assert.equal(opening.stored, null, "a first visit must not have a stored log");
assert.deepEqual(opening.confirmed, [], "a first visit must have no applied entries");
assert.deepEqual(opening.draft, [], "a first visit must have no unapplied steps");
assert.deepEqual(opening.frames, { confirmed: 1, working: 1, total: 2 }, "each pane must draw its own frame");
assert.match(opening.notice ?? "", /保存されていません/u);
assert.equal(opening.sendDisabled, false);
assert.equal(opening.micDisabled, false);
assert.equal(opening.undoDisabled, true, "there is nothing to undo yet");
assert.equal(opening.applyDisabled, true, "there is nothing to apply yet");

const beforeVoice = await drawn(page, "working");
assert.equal(beforeVoice.pattern, "graph/1");
assert.equal(beforeVoice.cells, 4, "expected root boundary plus three initial regions");
assert.deepEqual(await panes(page), { confirmed: [], working: [] });

// (ii) The spoken add changes 作業図 only. The request carries the utterance
// Hayamimi heard and the working graph it was spoken into; the answer is Jev's
// typed choice; the edge appears on the right and nowhere else.
const voiceAdd = await speak(page);
assert.equal(voiceAdd.sent.kind, "voice-ui.jev.request.v4");
assert.deepEqual(voiceAdd.sent.state.working, { regions: ["node-a", "node-b", "node-c"], edges: [] });
assert.deepEqual(voiceAdd.sent.state.draft, []);
assert.deepEqual(voiceAdd.sent.state.focus, { kind: "none", changes: [] });
assertHeard(voiceAdd.sent.state.utterance, addGolden);

assert.equal(voiceAdd.decision.kind, "voice-ui.jev.decision.v4");
assert.equal(voiceAdd.decision.answers.action.choice, "add-edge");
const voiceEdge = edgeOf(voiceAdd.decision.answers);

const drafted = await screen(page);
assert.equal(drafted.state, "drafted");
assert.deepEqual(drafted.draft, [`+${voiceEdge}`]);
assert.equal(drafted.stored, null, "a working step must not be saved");
assert.deepEqual(drafted.confirmed, [], "a working step is not an applied entry");
assert.deepEqual(await panes(page), { confirmed: [], working: [voiceEdge] });

// (ii-b) Neither pane's embedded Accept can apply or save anything.
const embeddedAccepts = await pressEmbeddedAccepts(page);
await page.waitForTimeout(500);
const afterAccepts = await screen(page);
assert.equal(afterAccepts.stored, null, "an embedded Accept must not save anything");
assert.deepEqual(afterAccepts.confirmed, []);
assert.deepEqual(afterAccepts.draft, [`+${voiceEdge}`]);
assert.deepEqual(await panes(page), { confirmed: [], working: [voiceEdge] });

// (iii) 確定図に反映 is the only way into 確定図 and storage.
await press(page, "#apply");
const applied = await screen(page);
assert.equal(applied.state, "applied");
assert.deepEqual(applied.draft, [], "Apply empties the working steps");
assert.deepEqual(applied.confirmed, [`+${voiceEdge}`]);
assert.equal(applied.failure, null);
assert.ok(applied.stored, "the applied step must have been persisted");
assert.equal(lineCount(applied.stored), 2, "the initial graph plus exactly one applied Decision");
const savedLog = applied.stored;
assert.deepEqual(await panes(page), { confirmed: [voiceEdge], working: [voiceEdge] });

// (iv) Reload restores 確定図 from storage without rewriting it; 作業図 starts
// again from the saved graph.
await page.reload({ waitUntil: "commit" });
await ready(page);
const restored = await screen(page);
assert.equal(restored.state, "restored");
assert.equal(restored.stored, savedLog, "reload must not rewrite the stored log");
assert.deepEqual(restored.confirmed, [`+${voiceEdge}`]);
assert.deepEqual(restored.draft, []);
assert.match(restored.initialLine, /\(0 edges\)/u, "the initial graph must still read as edgeless");
assert.deepEqual(await panes(page), { confirmed: [voiceEdge], working: [voiceEdge] });

// What the second browser starts from: exactly the bytes this one saved. The
// working graph is never carried across - it lives in memory only.
const afterVoiceApply = await first.context.storageState();

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
assert.deepEqual((await drawn(page, "confirmed")).edges, [], "a rejected log must not draw an edge");

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
assert.deepEqual((await drawn(page, "confirmed")).edges, [], "a foreign log must not draw an edge");

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

// From here on this browser works on the recovered, edgeless graph, so none of
// the typed proofs below can borrow the spoken add.

// (viii) Typed steps change 作業図 only; each one is sent with every earlier
// step and the latest as the focus. 元に戻す pops exactly one step at a time,
// and 確定図に反映 writes all of them at once.
const assertSavedUntouched = async (label, expectedStored, expectedApplied, expectedLeft) => {
  const now = await screen(page);
  assert.equal(now.stored, expectedStored, `${label}: the stored bytes must not change`);
  assert.deepEqual(now.confirmed, expectedApplied, `${label}: 確定図's entries must not change`);
  assert.deepEqual((await drawn(page, "confirmed")).edges, expectedLeft, `${label}: 確定図 must not change`);
  return now;
};

const typedA = await type(page, "add an edge from a to b");
assert.equal(typedA.sent.kind, "voice-ui.jev.request.v4", "Send must use the typed graph decision");
assert.equal(typedA.decision.answers.action.choice, "add-edge");
const edgeA = edgeOf(typedA.decision.answers);
await assertSavedUntouched("first typed step", null, [], []);
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA]);

const typedB = await type(page, "add an edge from b to c");
const edgeB = edgeOf(typedB.decision.answers);
assert.notEqual(edgeB, edgeA, "precondition: Jev must choose the new pair");
const [aFrom, aTo] = edgeA.split("->");
assert.deepEqual(typedB.sent.state.draft, [{ changes: [{ change: "added", from: aFrom, to: aTo }] }]);
assert.deepEqual(typedB.sent.state.focus, { kind: "draft", changes: [{ change: "added", from: aFrom, to: aTo }] });
await assertSavedUntouched("second typed step", null, [], []);
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`, `+${edgeB}`]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeB].sort());

await press(page, "#undo");
assert.equal((await screen(page)).state, "undone");
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA]);
await press(page, "#undo");
const undoneAll = await assertSavedUntouched("two undos", null, [], []);
assert.deepEqual(undoneAll.draft, []);
assert.equal(undoneAll.undoDisabled, true, "undo never goes below what is saved");
assert.deepEqual((await drawn(page, "working")).edges, []);

await type(page, "add an edge from a to b");
await type(page, "add an edge from b to c");
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`, `+${edgeB}`]);
await press(page, "#apply");
const appliedTwo = await screen(page);
assert.equal(appliedTwo.state, "applied");
assert.deepEqual(appliedTwo.draft, []);
assert.deepEqual(appliedTwo.confirmed, [`+${edgeA}`, `+${edgeB}`], "Apply writes every step as its own entry");
assert.equal(lineCount(appliedTwo.stored), 3, "the initial graph plus exactly the two applied Decisions");
const savedTwo = appliedTwo.stored;
assert.deepEqual(await panes(page), { confirmed: [edgeA, edgeB].sort(), working: [edgeA, edgeB].sort() });

// (ix) Things that ask for no change leave both panes and storage untouched:
// empty input sends no request at all; "undo that" is a neutral undo-request
// that points at the button and never pops a step; "none" is neutral too.
const typedC = await type(page, "add an edge from c to a");
const edgeC = edgeOf(typedC.decision.answers);
const withOneStep = await screen(page);
assert.deepEqual(withOneStep.draft, [`+${edgeC}`]);

const blanks = countJev(page);
for (const blank of ["", "   "]) {
  await page.locator("#text").fill(blank);
  await page.locator("#send").click();
  await settle(page);
  const afterBlank = await screen(page);
  assert.equal(afterBlank.state, "no-change", `${JSON.stringify(blank)} must be a no-change`);
  assert.equal(afterBlank.failure, null, `${JSON.stringify(blank)} is not an error`);
  assert.deepEqual(afterBlank.draft, withOneStep.draft, `${JSON.stringify(blank)} must keep the working steps`);
}
blanks.stop();
assert.equal(blanks.count, 0, "empty input must send no request to Jev");

const spokenUndo = await type(page, "undo that");
assert.equal(spokenUndo.decision.answers.action.choice, "undo-request", "precondition: Jev must answer undo-request");
const afterSpokenUndo = await assertSavedUntouched("undo by text", savedTwo, [`+${edgeA}`, `+${edgeB}`], [edgeA, edgeB].sort());
assert.equal(afterSpokenUndo.state, "undo-request");
assert.match(afterSpokenUndo.status, /元に戻す/u);
assert.deepEqual(afterSpokenUndo.draft, withOneStep.draft, "an undo-request must never pop a step");
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeB, edgeC].sort());

const nothing = await type(page, "what is the weather like today");
assert.equal(nothing.decision.answers.action.choice, "none", "precondition: Jev must answer with no action");
const afterNothing = await assertSavedUntouched("no change", savedTwo, [`+${edgeA}`, `+${edgeB}`], [edgeA, edgeB].sort());
assert.equal(afterNothing.state, "no-change");
assert.deepEqual(afterNothing.draft, withOneStep.draft);

await press(page, "#discard");
assert.equal((await screen(page)).state, "discarded");
assert.deepEqual((await screen(page)).draft, []);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeB].sort());

// (x) Revert: an applied entry's opposite is added to 作業図 - never to 確定図 -
// and reaches storage only through Apply, as one more Decision after the rest.
await page.locator('button[data-revert="1"]').click();
await settle(page);
const reverting = await assertSavedUntouched("revert", savedTwo, [`+${edgeA}`, `+${edgeB}`], [edgeA, edgeB].sort());
assert.equal(reverting.state, "drafted");
assert.deepEqual(reverting.draft, [`-${edgeB}`]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA]);

await press(page, "#apply");
const appliedRevert = await screen(page);
assert.deepEqual(appliedRevert.confirmed, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`]);
assert.ok(appliedRevert.stored.startsWith(savedTwo), "a revert adds to the saved log; it rewrites nothing");
assert.equal(lineCount(appliedRevert.stored), lineCount(savedTwo) + 1);
const savedThree = appliedRevert.stored;
assert.deepEqual(await panes(page), { confirmed: [edgeA], working: [edgeA] });

// (x-b) A revert overtaken by a later working step is a refused conflict.
const removeA = await type(page, "remove the edge from a to b");
assert.equal(removeA.decision.answers.action.choice, "remove-edge", "precondition: Jev must answer remove-edge");
assert.deepEqual((await screen(page)).draft, [`-${edgeA}`]);
await page.locator('button[data-revert="0"]').click();
await settle(page);
const conflict = await assertSavedUntouched("revert conflict", savedThree, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`], [edgeA]);
assert.equal(conflict.state, "failed");
assert.match(conflict.failure ?? "", /later change/u);
assert.deepEqual(conflict.draft, [`-${edgeA}`], "a refused revert must not change the working steps");
assert.deepEqual((await drawn(page, "working")).edges, []);
await press(page, "#discard");

// (xi) While a request is in flight every control that could move 作業図 is
// disabled, and the answer lands on the working graph it was asked about. The
// Jev request is held at the network until the controls have been read.
await type(page, "add an edge from c to a");
assert.deepEqual((await screen(page)).draft, [`+${edgeC}`]);
const jevUrl = new URL("/api/jev", url).href;
let releaseJev;
const heldJev = new Promise(resolve => { releaseJev = resolve; });
await page.route(jevUrl, async route => {
  await heldJev;
  await route.continue();
}, { times: 1 });
const held = jevExchange(page);
await page.locator("#text").fill("add an edge from b to c");
await page.locator("#send").click();
const heldRequest = await held.request;
const locked = await screen(page);
assert.equal(locked.state, "pending");
for (const control of ["sendDisabled", "micDisabled", "undoDisabled", "discardDisabled", "applyDisabled"]) {
  assert.equal(locked[control], true, `${control} while a request is in flight`);
}
assert.ok(locked.revertDisabled.length > 0 && locked.revertDisabled.every(Boolean), "every revert while a request is in flight");
const heldSent = JSON.parse(heldRequest.postData());
assert.deepEqual(sortedEdges(heldSent.state.working.edges), [edgeA, edgeC].sort());
assert.deepEqual(heldSent.state.draft.length, 1);
releaseJev();
const heldResponse = await held.response;
await settle(page);
const heldEdge = edgeOf((await heldResponse.json()).answers);
const afterHeld = await assertSavedUntouched("held request", savedThree, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`], [edgeA]);
assert.deepEqual(afterHeld.draft, [`+${edgeC}`, `+${heldEdge}`], "the answer lands on the revision it was asked about");
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeC, heldEdge].sort());
await press(page, "#discard");

// (xi-b) Jev never answers. The page gives up after 15 s by its own clock,
// says so, and hands every control back exactly as it was; both panes, the
// working steps and the stored bytes are untouched. The answer is then let
// through late, and it must not land. A retry is answered as usual.
await type(page, "add an edge from c to a");
const idle = await screen(page);
assert.deepEqual(idle.draft, [`+${edgeC}`]);
const idlePanes = await panes(page);
const controlsOf = now => ({
  send: now.sendDisabled,
  mic: now.micDisabled,
  undo: now.undoDisabled,
  discard: now.discardDisabled,
  apply: now.applyDisabled,
  revert: now.revertDisabled,
});
const assertUnmoved = async (label, now) => {
  assert.equal(now.stored, idle.stored, `${label}: the stored bytes must not change`);
  assert.deepEqual(now.confirmed, idle.confirmed, `${label}: 確定図's entries must not change`);
  assert.deepEqual(now.draft, idle.draft, `${label}: the working steps must not change`);
  assert.deepEqual(await panes(page), idlePanes, `${label}: neither pane may change`);
  assert.deepEqual(controlsOf(now), controlsOf(idle), `${label}: every control must be given back`);
};

let releaseLate;
const late = new Promise(resolve => { releaseLate = resolve; });
let lateRoute;
await page.route(jevUrl, async route => {
  lateRoute = route;
  await late;
  await route.continue().catch(() => {});
}, { times: 1 });
// Only the request is awaited: this one gets no response.
const hung = page.waitForRequest(
  value => new URL(value.url()).pathname === "/api/jev" && value.method() === "POST",
  { timeout: 120000 },
);
await page.locator("#text").fill("add an edge from b to c");
const hangStarted = Date.now();
await page.locator("#send").click();
await hung;
assert.equal((await screen(page)).sendDisabled, true, "precondition: the request holds the controls");
await settle(page);
const hangMs = Date.now() - hangStarted;
assert.ok(hangMs >= 15000 && hangMs < 20000, `the page must give up at 15 s, took ${hangMs} ms`);
const gaveUp = await screen(page);
assert.equal(gaveUp.state, "failed");
assert.match(gaveUp.failure ?? "", /did not answer within 15 s/u);
await assertUnmoved("a request Jev never answered", gaveUp);

releaseLate();
await page.waitForTimeout(3000);
assert.ok(lateRoute, "precondition: the held request reached the route");
const afterLate = await screen(page);
assert.equal(afterLate.state, "failed", "an answer after the page gave up must not land");
await assertUnmoved("a late answer", afterLate);

const retried = await type(page, "add an edge from b to c");
const retriedEdge = edgeOf(retried.decision.answers);
assert.deepEqual((await screen(page)).draft, [`+${edgeC}`, `+${retriedEdge}`], "a retry is answered as usual");
await press(page, "#undo");

// (xi-c) The Function's own answer when the provider hangs: 504
// provider_timeout. The page reports it and gives everything back the same way.
const beforeTimeoutAnswer = failedResponses.length;
await page.route(jevUrl, route => route.fulfill({
  status: 504,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({ error: "provider_timeout" }),
}), { times: 1 });
const timeoutAnswer = jevExchange(page);
await page.locator("#text").fill("add an edge from b to c");
await page.locator("#send").click();
await timeoutAnswer.request;
assert.equal((await timeoutAnswer.response).status(), 504, "precondition: the 504 reached the page");
await settle(page);
const reported = await screen(page);
assert.equal(reported.state, "failed");
assert.match(reported.failure ?? "", /provider_timeout/u);
await assertUnmoved("a provider timeout", reported);
assert.deepEqual(failedResponses.splice(beforeTimeoutAnswer), [`504 ${jevUrl}`]);

const retriedAgain = await type(page, "add an edge from b to c");
assert.deepEqual((await screen(page)).draft, [`+${edgeC}`, `+${edgeOf(retriedAgain.decision.answers)}`]);
await press(page, "#discard");

// (xii) 作業図 holds at most 8 unapplied steps. At the cap nothing is dropped,
// no request is sent, and revert is disabled too; the page says what to do.
for (let index = 0; index < 4; index += 1) {
  const add = await type(page, "add an edge from c to a");
  assert.equal(add.decision.answers.action.choice, "add-edge", `precondition: step ${2 * index + 1} adds`);
  const remove = await type(page, "remove the edge from c to a");
  assert.equal(remove.decision.answers.action.choice, "remove-edge", `precondition: step ${2 * index + 2} removes`);
}
const full = await assertSavedUntouched("full working graph", savedThree, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`], [edgeA]);
assert.equal(full.draft.length, 8);
assert.match(full.draftCount, /8 \/ 8/u);
assert.match(full.draftCount, /上限/u);
assert.ok(full.revertDisabled.every(Boolean), "revert must be disabled at the cap");
assert.equal(full.applyDisabled, false);

const atCap = countJev(page);
await page.locator("#text").fill("add an edge from b to c");
await page.locator("#send").click();
await settle(page);
atCap.stop();
const refusedAtCap = await screen(page);
assert.equal(atCap.count, 0, "a full working graph must send no request to Jev");
assert.equal(refusedAtCap.state, "draft-full");
assert.deepEqual(refusedAtCap.draft, full.draft, "nothing is dropped at the cap");
await press(page, "#discard");

// (xiii) Apply's write fails on a genuinely exhausted quota: nothing is saved,
// 確定図 is unchanged, and 作業図 keeps its steps to retry.
await type(page, "add an edge from c to a");
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

await press(page, "#apply");
const afterFailedWrite = await assertSavedUntouched("a failed write", savedThree, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`], [edgeA]);
assert.equal(afterFailedWrite.state, "failed");
assert.match(afterFailedWrite.failure ?? "", /not persisted/u);
assert.deepEqual(afterFailedWrite.draft, [`+${edgeC}`], "a refused Apply keeps the working steps to retry");
assert.equal(afterFailedWrite.applyDisabled, false, "a failed write must not block the app");

await page.evaluate(count => {
  for (let index = 0; index < count; index += 1) localStorage.removeItem(`quota-filler-${index}`);
}, fillers);

// (xiv) Two tabs of one origin. The other tab applies first; this tab's Apply
// is then refused rather than overwrite that history, and this tab's working
// steps stay exactly as they were.
const otherTab = watch(await first.context.newPage());
await otherTab.goto(url, { waitUntil: "commit", timeout: 120000 });
await ready(otherTab);
const theirs = await type(otherTab, "add an edge from b to c");
const theirEdge = edgeOf(theirs.decision.answers);
await press(otherTab, "#apply");
const theirSaved = (await screen(otherTab)).stored;
assert.notEqual(theirSaved, savedThree, "precondition: the other tab must have saved");

await press(page, "#apply");
const conflicted = await screen(page);
assert.equal(conflicted.state, "failed");
assert.match(conflicted.failure ?? "", /別のタブ/u);
assert.equal(conflicted.stored, theirSaved, "the other tab's history must not be overwritten");
assert.deepEqual(conflicted.draft, [`+${edgeC}`], "a refused Apply keeps the working steps exactly");
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeC].sort());
await otherTab.close();

// (xv) A reload drops the unapplied steps, as 作業図 says it will; both panes
// start again from what is actually stored, and nothing else was ever stored.
await page.reload({ waitUntil: "commit" });
await ready(page);
const afterReload = await screen(page);
assert.equal(afterReload.state, "restored");
assert.deepEqual(afterReload.draft, [], "unapplied steps do not survive a reload");
assert.equal(afterReload.stored, theirSaved);
assert.deepEqual(afterReload.storageKeys, [STORAGE_KEY], "the working graph is never written to storage");
assert.deepEqual(afterReload.confirmed, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`, `+${theirEdge}`]);
assert.deepEqual(await panes(page), { confirmed: [edgeA, theirEdge].sort(), working: [edgeA, theirEdge].sort() });

// (xvi) Saved, but not displayed. Apply's write lands; only the drawing of
// 確定図 that follows fails - its frame document is refused for exactly that
// one render. Storage now leads the screen, so the page must say so, block
// every further action, and a reload must draw what was saved.
const beforeUndrawn = afterReload.stored;
await type(page, "add an edge from c to a");
assert.deepEqual((await screen(page)).draft, [`+${edgeC}`]);

const frameDocument = new URL("/ui/semantic-map/authoring/pages/embed.html", url).href;
const injected = [];
const noteInjected = request => {
  if (request.url() === frameDocument) injected.push(request.failure()?.errorText ?? "failed");
};
page.on("requestfailed", noteInjected);
await page.route(frameDocument, route => route.abort("failed"), { times: 1 });

await press(page, "#apply");
const undrawn = await screen(page);
page.off("requestfailed", noteInjected);
assert.equal(undrawn.state, "saved-display-failed");
assert.match(undrawn.failure ?? "", /display failed/u);
assert.ok(undrawn.stored.startsWith(beforeUndrawn), "the write must add to what was saved");
assert.equal(lineCount(undrawn.stored), lineCount(beforeUndrawn) + 1, "exactly one Decision must be added");
for (const control of ["sendDisabled", "micDisabled", "undoDisabled", "discardDisabled", "applyDisabled"]) {
  assert.equal(undrawn[control], true, `${control} while the screen is behind storage`);
}
assert.deepEqual(injected, ["net::ERR_FAILED"], "the only refused request must be the injected frame document");

await page.reload({ waitUntil: "commit" });
await ready(page);
const redrawn = await screen(page);
assert.equal(redrawn.state, "restored");
assert.equal(redrawn.stored, undrawn.stored, "reload must draw what was saved, not rewrite it");
assert.deepEqual((await drawn(page, "confirmed")).edges, [edgeA, theirEdge, edgeC].sort());
assert.equal(redrawn.sendDisabled, false);

await first.browser.close();

// (xvii) The spoken correction. A second browser, which hears only the
// correction file, starts from exactly the bytes the first saved after the
// spoken add - never from a working graph, which is memory only. In this
// browser a typed step is made first, so the correction is spoken into a
// working graph that holds an unapplied step, and "that edge" must be read off
// the focus: the typed step, not the saved edge.
const second = await openBrowser(correctionWav, afterVoiceApply);
page = second.page;
await page.goto(url, { waitUntil: "commit", timeout: 120000 });
await ready(page);
const carried = await screen(page);
assert.equal(carried.state, "restored");
assert.equal(carried.stored, savedLog, "the second browser must start from the saved spoken add");
assert.deepEqual(carried.confirmed, [`+${voiceEdge}`]);
assert.deepEqual(carried.draft, []);
assert.deepEqual(await panes(page), { confirmed: [voiceEdge], working: [voiceEdge] });

const typedStep = await type(page, "add an edge from a to b");
assert.equal(typedStep.decision.answers.action.choice, "add-edge");
const typedEdge = edgeOf(typedStep.decision.answers);
assert.notEqual(typedEdge, voiceEdge);
assert.notEqual(typedEdge, flip(voiceEdge));
assert.deepEqual((await screen(page)).draft, [`+${typedEdge}`]);
assert.equal((await screen(page)).stored, savedLog);
assert.deepEqual(await panes(page), { confirmed: [voiceEdge], working: [voiceEdge, typedEdge].sort() });

const [typedFrom, typedTo] = typedEdge.split("->");
const heard = await speak(page);
assert.equal(heard.sent.kind, "voice-ui.jev.request.v4");
assertHeard(heard.sent.state.utterance, correctionGolden);
assert.deepEqual(sortedEdges(heard.sent.state.working.edges), [voiceEdge, typedEdge].sort());
assert.deepEqual(heard.sent.state.draft, [{ changes: [{ change: "added", from: typedFrom, to: typedTo }] }]);
assert.deepEqual(heard.sent.state.focus, { kind: "draft", changes: [{ change: "added", from: typedFrom, to: typedTo }] });
assert.equal(heard.decision.kind, "voice-ui.jev.decision.v4");
assert.equal(heard.decision.answers.action.choice, "reverse-edge");
const typedEdgeId = heard.sent.state.working.edges.find(edge => edge.from === typedFrom && edge.to === typedTo).id;
assert.equal(heard.decision.answers.edge.choice, typedEdgeId, "\"that edge\" must be the focused working step");

const corrected = await screen(page);
assert.equal(corrected.state, "drafted");
assert.deepEqual(corrected.draft, [`+${typedEdge}`, `-${typedEdge} +${flip(typedEdge)}`]);
assert.equal(corrected.stored, savedLog, "a spoken correction changes 作業図 only");
assert.deepEqual(corrected.confirmed, [`+${voiceEdge}`]);
assert.deepEqual(await panes(page), { confirmed: [voiceEdge], working: [voiceEdge, flip(typedEdge)].sort() });

const correctionAccepts = await pressEmbeddedAccepts(page);
await page.waitForTimeout(500);
assert.equal((await screen(page)).stored, savedLog, "an embedded Accept must not save anything");
assert.deepEqual((await screen(page)).draft, corrected.draft);

await press(page, "#apply");
const final = await screen(page);
assert.equal(final.state, "applied");
assert.deepEqual(final.confirmed, [`+${voiceEdge}`, `+${typedEdge}`, `-${typedEdge} +${flip(typedEdge)}`]);
assert.ok(final.stored.startsWith(savedLog));
assert.equal(lineCount(final.stored), lineCount(savedLog) + 2, "both working steps are applied as they are");
assert.deepEqual(await panes(page), { confirmed: [voiceEdge, flip(typedEdge)].sort(), working: [voiceEdge, flip(typedEdge)].sort() });

// (xviii) Reload in the same browser: the final graph and every entry come back.
await page.reload({ waitUntil: "commit" });
await ready(page);
const restoredFinal = await screen(page);
assert.equal(restoredFinal.state, "restored");
assert.equal(restoredFinal.stored, final.stored);
assert.deepEqual(restoredFinal.confirmed, final.confirmed);
assert.deepEqual(restoredFinal.draft, []);
assert.deepEqual(await panes(page), { confirmed: [voiceEdge, flip(typedEdge)].sort(), working: [voiceEdge, flip(typedEdge)].sort() });

await second.browser.close();

assert.deepEqual(errors, []);
assert.deepEqual(failedResponses, []);

process.stdout.write(
  `local-voice-graph-e2e: PASS spoken add "${voiceAdd.sent.state.utterance}" -> 作業図 only, applied edge=${voiceEdge} `
  + `| embedded Accept [${embeddedAccepts.join("; ")}] / [${correctionAccepts.join("; ")}] `
  + `| corrupt and foreign logs fail closed | typed ${edgeA}, ${edgeB}: 2 undos, then 2-step apply `
  + `| empty input (0 Jev requests), undo-request and none change nothing | relation revert applied, overtaken revert refused `
  + `| controls locked while a request is in flight, answer on its own revision (${heldEdge}) `
  + `| unanswered request failed at ${hangMs} ms, late answer dropped, 504 provider_timeout reported, `
  + "controls given back and nothing changed, both retries answered "
  + `| cap 8 with 0 Jev requests at the cap | quota and other-tab Apply refused, working steps kept | reload drops the working steps `
  + `| saved-but-undrawn blocks, reload draws it | browser 2: typed ${typedEdge}, then spoken "${heard.sent.state.utterance}" `
  + `-> reverse of the focused step, applied with it, restored after reload\n`,
);
