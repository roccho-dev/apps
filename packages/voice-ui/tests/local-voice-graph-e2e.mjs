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
const consoleMessages = [];
// Answers the real Jev gave through the dev server during this run, reported
// so its cost is visible. Answers the test fakes at the network are not here.
let jevAnswered = 0;

const watch = target => {
  target.on("pageerror", error => errors.push(String(error)));
  target.on("console", message => consoleMessages.push(message.text()));
  target.on("response", response => {
    if (response.status() >= 400) {
      failedResponses.push(response.status() + " " + response.url());
    }
    if (new URL(response.url()).pathname === "/api/jev" && response.status() === 200 && !response.request().isNavigationRequest()) {
      jevAnswered += 1;
    }
  });
  return target;
};

// A test-only trace, installed before the page's own scripts, of what a voice
// press actually does in order: when the microphone stream and the capture
// worklet became ready, every change of the page's voice phase (with the body
// state at that moment), and any focus on the text field or click on Send.
// The page exposes nothing for this; the browser APIs it calls are wrapped.
const traceVoice = () => {
  if (window !== window.top) return;
  const trace = [];
  window.voiceTrace = trace;
  const note = (kind, state) => trace.push({ kind, state });

  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (window.failNextMicrophone) {
      window.failNextMicrophone = false;
      throw new DOMException("microphone refused by the test", "NotAllowedError");
    }
    const stream = await getUserMedia(constraints);
    note("microphone");
    return stream;
  };
  const addModule = AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule = async function (...args) {
    const result = await addModule.apply(this, args);
    note("worklet");
    return result;
  };

  document.addEventListener("focusin", event => {
    if (event.target.id === "text") note("text-focus");
  }, true);
  document.addEventListener("click", event => {
    if (event.target.closest?.("#send")) note("send-click");
  }, true);
  new MutationObserver(() => {
    const phase = document.body.dataset.voice ?? "idle";
    if (trace.findLast(entry => entry.kind.startsWith("voice:"))?.kind !== `voice:${phase}`) {
      note(`voice:${phase}`, document.body.dataset.state);
    }
  // The document itself: no element exists yet when this runs.
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-voice"] });
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
  await context.addInitScript(traceVoice);
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
  // Each unapplied step as shown: where its text came from, that text, what it
  // does, and whether any element was created inside the item's text.
  items: [...document.querySelectorAll("#draft li")].map(item => ({
    source: item.dataset.source,
    input: item.querySelector("[data-input]")?.textContent ?? null,
    effect: item.querySelector("[data-effect]")?.textContent ?? null,
    elements: item.querySelectorAll("[data-input] *, img, b, script").length,
  })),
  draftHeading: document.querySelector("#draft-heading")?.textContent ?? null,
  // The recent conversation as the panel shows it - the entries themselves.
  context: [...document.querySelectorAll("#context-recent li")].map(item => JSON.parse(item.dataset.entry)),
  contextHeading: document.querySelector("#context-heading")?.textContent ?? null,
  contextSkipped: document.querySelector("#context-skipped").textContent,
  contextClearDisabled: document.querySelector("#context-clear").disabled,
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

// Where each part is really drawn, read off the live adapter's own cells and
// their rendered shapes. This is the only evidence that counts for a placement:
// the layout contract reports bounds for a part the view has culled, and the
// boundary stretches around any pin, so neither can tell a drawn part from a
// vanished one. A part with no cell, or a cell with no shape in the document,
// is not on the screen however good its numbers look.
const boxes = (target, pane) => target.evaluate(async pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  if (!frame) throw new Error(`${pane} semantic map iframe missing`);

  const started = performance.now();
  while (frame.contentWindow?.semanticMapSite?.ready !== true) {
    if (performance.now() - started > 60000) throw new Error(`${pane} semantic map ready timeout`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const adapter = frame.contentWindow.semanticMapApp.adapter;
  const view = adapter.graph.getView();
  const drawn = {};
  for (const [regionId, cell] of adapter.cellsByRegionId) {
    const geometry = cell.getGeometry();
    const state = view.getState(cell);
    drawn[regionId] = {
      box: geometry ? [geometry.x, geometry.y, geometry.width, geometry.height] : null,
      rendered: Boolean(state?.shape?.node?.isConnected),
    };
  }
  return drawn;
}, pane);

// What a pane is showing now, from the provider's own public contract - the same
// call the page makes. Never computed here, so the test cannot agree with the app
// by repeating its arithmetic.
const visibleFrame = (target, pane) => target.evaluate(async pane => {
  const runtime = await import("/ui/semantic-map/runtime.js");
  return runtime.visibleFrameOf(document.querySelector(`#${pane}-surface`));
}, pane);

// The width of each pane's mount. The app asks only 作業図 whether a spot is
// visible, which is sound while both panes resolve the same camera; #panes is a
// 1fr 1fr grid and the embed fixes its own height, so equal widths are the whole
// of that condition. A future ratio change must fail here rather than quietly
// let a spot pass on the right and land off-pane on the left.
const mountWidths = target => target.evaluate(() => ({
  confirmed: document.querySelector("#confirmed-surface").getBoundingClientRect().width,
  working: document.querySelector("#working-surface").getBoundingClientRect().width,
  columns: getComputedStyle(document.querySelector("#panes")).gridTemplateColumns,
}));

// Whether a box is wholly inside a frame, in the view's own coordinates.
const insideFrame = (box, frame) => box[0] >= frame[0] && box[1] >= frame[1]
  && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3];

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

// Every text that has gone to Jev so far. A request carries its own text as
// state.utterance, and earlier text only inside state.context.recent - the
// recent conversation, which is exactly what the panel showed when the input
// was made. Each draft entry is its changes only, and no earlier text appears
// anywhere else in the body.
const inputsSent = new Set();
const assertOnlyCurrentInput = (sent, panelBefore) => {
  assert.equal(sent.kind, "voice-ui.jev.request.v7");
  const { utterance, context, ...rest } = sent.state;
  assert.deepEqual(context.recent, panelBefore, "the request must send exactly the recent conversation the panel showed");
  for (const entry of sent.state.draft) {
    assert.deepEqual(Object.keys(entry), ["changes"], "a draft entry sent to Jev must be its changes only");
  }
  const body = JSON.stringify({ ...sent, state: rest });
  for (const earlier of inputsSent) {
    assert.equal(body.includes(earlier), false, `an earlier input reached Jev outside the context: ${earlier}`);
  }
  inputsSent.add(utterance);
};

const contextPanel = target => target.evaluate(() =>
  [...document.querySelectorAll("#context-recent li")].map(item => JSON.parse(item.dataset.entry)));

// Speak or type, and return what was sent and what Jev answered once the page
// has settled.
const ask = async (target, act) => {
  const panelBefore = await contextPanel(target);
  const exchange = jevExchange(target);
  await act();
  const request = await exchange.request;
  const response = await exchange.response;
  assert.equal(response.status(), 200);
  await settle(target);
  const sent = JSON.parse(request.postData());
  assertOnlyCurrentInput(sent, panelBefore);
  return { sent, decision: await response.json() };
};

// A recent-conversation entry as expected, without its sequence number: the
// text sent for that input and what came of it. A step carries the changes it
// made then, read off the same form as data-changes.
const changesOf = changes => changes.split(" ").map(change => {
  const [from, to] = change.slice(1).split("->");
  return { change: change.startsWith("+") ? "added" : "removed", from, to };
});
const heardAs = (asked, source, outcome, changes = null) => ({
  source,
  text: asked.sent.state.utterance,
  outcome,
  ...(changes === null ? {} : { effect: { changes: changesOf(changes) } }),
});
const withoutSeq = entries => entries.map(({ seq, ...entry }) => entry);

// What an unapplied step should show: the exact text sent to Jev for it
// (認識文 for voice, 入力文 for typed), or nothing for a revert, and its
// effect in words read off the same verified changes as data-changes.
const effectText = changes => {
  const [first, second] = changes.split(" ");
  if (second === undefined) return `${first.startsWith("+") ? "追加" : "削除"} ${first.slice(1)}`;
  return `反転 ${first.slice(1)} ⇒ ${second.slice(1)}`;
};
const itemFor = (source, input, changes) => ({ source, input, effect: effectText(changes), elements: 0 });
const typedItem = (asked, changes) => itemFor("typed", asked.sent.state.utterance, changes);
const voiceItem = (asked, changes) => itemFor("voice", asked.sent.state.utterance, changes);
const revertItem = changes => itemFor("revert", null, changes);
const assertNotStored = stored => {
  for (const input of inputsSent) assert.equal(stored.includes(input), false, `an input was stored: ${input}`);
};

const voiceTrace = (target, from = 0) => target.evaluate(from => window.voiceTrace.slice(from), from);
const voicePhases = trace => trace.filter(entry => entry.kind.startsWith("voice:"));
const voiceIdle = target => target.waitForFunction(() => document.body.dataset.voice === undefined);

// One press of Voice and nothing else: the text field is never focused and
// Send never clicked. The page says it is preparing, asks the user to speak
// only after both the microphone stream and the capture worklet are ready,
// then decides, and the body state stays `pending` throughout. Exactly one
// Jev request follows from the one utterance.
const speak = async target => {
  const from = (await voiceTrace(target)).length;
  const jev = countJev(target);
  const result = await ask(target, () => target.locator("#mic").click());
  await voiceIdle(target);
  jev.stop();
  const trace = await voiceTrace(target, from);
  const kinds = trace.map(entry => entry.kind);
  assert.equal(kinds.includes("text-focus"), false, "a voice press must not focus the text field");
  assert.equal(kinds.includes("send-click"), false, "a voice press must not need Send");
  const phases = voicePhases(trace);
  assert.deepEqual(phases.map(entry => entry.kind), ["voice:preparing", "voice:listening", "voice:deciding", "voice:idle"]);
  assert.deepEqual(phases.slice(0, 3).map(entry => entry.state), ["pending", "pending", "pending"]);
  const listening = kinds.indexOf("voice:listening");
  for (const ready of ["microphone", "worklet"]) {
    const at = kinds.indexOf(ready);
    assert.ok(at > kinds.indexOf("voice:preparing") && at < listening, `${ready} must be ready before the user is asked to speak`);
  }
  assert.equal(jev.count, 1, "one utterance must send exactly one Jev request");
  return { ...result, trace: kinds };
};
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
assert.equal(voiceAdd.sent.kind, "voice-ui.jev.request.v7");
assert.deepEqual(voiceAdd.sent.state.context, { recent: [] }, "a first visit has no recent conversation");
assert.deepEqual(voiceAdd.sent.state.working, {
  // Every part the view has drawn is a part that can be put beside another.
  placeable: ["node-a", "node-b", "node-c"],
  regions: ["node-a", "node-b", "node-c"],
  edges: [],
});
assert.deepEqual(voiceAdd.sent.state.draft, []);
assert.deepEqual(voiceAdd.sent.state.focus, { kind: "none", changes: [] });
assertHeard(voiceAdd.sent.state.utterance, addGolden);

assert.equal(voiceAdd.decision.kind, "voice-ui.jev.decision.v4");
assert.equal(voiceAdd.decision.answers.action.choice, "add-edge");
const voiceEdge = edgeOf(voiceAdd.decision.answers);

const drafted = await screen(page);
assert.equal(drafted.state, "drafted");
assert.deepEqual(drafted.draft, [`+${voiceEdge}`]);
assert.equal(drafted.draftHeading, "未反映の操作");
assert.deepEqual(drafted.items, [voiceItem(voiceAdd, `+${voiceEdge}`)], "the step shows the recognized text it was judged from");
// The judged utterance joins the recent conversation, with the step it made.
assert.equal(drafted.contextHeading, "Jevが参照する最近の会話（未検証）");
assert.deepEqual(withoutSeq(drafted.context), [heardAs(voiceAdd, "voice", "step", `+${voiceEdge}`)]);
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
assert.deepEqual(applied.context, drafted.context, "Apply keeps the recent conversation");
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
assert.deepEqual(restored.context, [], "a reload erases the recent conversation");
assert.equal(restored.contextSkipped, "");
assert.equal(restored.contextClearDisabled, true, "there is nothing to clear");
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
assert.equal(typedA.sent.kind, "voice-ui.jev.request.v7", "Send must use the typed graph decision");
assert.equal(typedA.decision.answers.action.choice, "add-edge");
const edgeA = edgeOf(typedA.decision.answers);
await assertSavedUntouched("first typed step", null, [], []);
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`]);
assert.deepEqual((await screen(page)).items, [typedItem(typedA, `+${edgeA}`)]);
assert.deepEqual(withoutSeq((await screen(page)).context), [heardAs(typedA, "typed", "step", `+${edgeA}`)]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA]);

const typedB = await type(page, "add an edge from b to c");
const edgeB = edgeOf(typedB.decision.answers);
assert.notEqual(edgeB, edgeA, "precondition: Jev must choose the new pair");
const [aFrom, aTo] = edgeA.split("->");
assert.deepEqual(typedB.sent.state.draft, [{ changes: [{ change: "added", from: aFrom, to: aTo }] }]);
assert.deepEqual(typedB.sent.state.focus, { kind: "draft", changes: [{ change: "added", from: aFrom, to: aTo }] });
await assertSavedUntouched("second typed step", null, [], []);
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`, `+${edgeB}`]);
assert.deepEqual((await screen(page)).items, [typedItem(typedA, `+${edgeA}`), typedItem(typedB, `+${edgeB}`)]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeB].sort());

await press(page, "#undo");
assert.equal((await screen(page)).state, "undone");
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`]);
assert.deepEqual((await screen(page)).items, [typedItem(typedA, `+${edgeA}`)], "Undo keeps the remaining step's text");
// Undo marks exactly the step it took back as undone, in place, without an effect.
assert.deepEqual(withoutSeq((await screen(page)).context), [
  heardAs(typedA, "typed", "step", `+${edgeA}`),
  heardAs(typedB, "typed", "undone"),
]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA]);
await press(page, "#undo");
const undoneAll = await assertSavedUntouched("two undos", null, [], []);
assert.deepEqual(withoutSeq(undoneAll.context), [heardAs(typedA, "typed", "undone"), heardAs(typedB, "typed", "undone")]);
assert.deepEqual(undoneAll.draft, []);
assert.equal(undoneAll.undoDisabled, true, "undo never goes below what is saved");
assert.deepEqual((await drawn(page, "working")).edges, []);

const typedA2 = await type(page, "add an edge from a to b");
const typedB2 = await type(page, "add an edge from b to c");
assert.deepEqual((await screen(page)).draft, [`+${edgeA}`, `+${edgeB}`]);
const beforeApplyTwo = await screen(page);
await press(page, "#apply");
const appliedTwo = await screen(page);
assert.deepEqual(appliedTwo.context, beforeApplyTwo.context, "Apply keeps the recent conversation and its effects, now history");
assert.deepEqual(withoutSeq(appliedTwo.context).slice(-2), [
  heardAs(typedA2, "typed", "step", `+${edgeA}`),
  heardAs(typedB2, "typed", "step", `+${edgeB}`),
]);
assert.equal(appliedTwo.state, "applied");
assert.deepEqual(appliedTwo.draft, []);
assert.deepEqual(appliedTwo.items, []);
assertNotStored(appliedTwo.stored);
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
assert.deepEqual((await screen(page)).context, withOneStep.context, "input Jev never judged does not join the conversation");
// Five entries now, the most recent last: the window is full.
assert.equal(withOneStep.context.length, 5);
assert.deepEqual(withoutSeq(withOneStep.context).at(-1), heardAs(typedC, "typed", "step", `+${edgeC}`));

const spokenUndo = await type(page, "undo that");
assert.equal(spokenUndo.decision.answers.action.choice, "undo-request", "precondition: Jev must answer undo-request");
const afterSpokenUndo = await assertSavedUntouched("undo by text", savedTwo, [`+${edgeA}`, `+${edgeB}`], [edgeA, edgeB].sort());
assert.equal(afterSpokenUndo.state, "undo-request");
assert.match(afterSpokenUndo.status, /元に戻す/u);
assert.deepEqual(afterSpokenUndo.draft, withOneStep.draft, "an undo-request must never pop a step");
// The undo-request joins the conversation; the window moves on by one.
assert.deepEqual(afterSpokenUndo.context.slice(0, 4), withOneStep.context.slice(1));
assert.deepEqual(withoutSeq(afterSpokenUndo.context).at(-1), heardAs(spokenUndo, "typed", "undo-request"));
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeB, edgeC].sort());

// This no-change is longer than 200 characters: it is remembered but never
// sent, and never shortened - the panel counts it instead.
const longNothing = "what is the weather like today? "
  + "I am only asking about the weather outside and not about the graph at all. ".repeat(3);
assert.ok(longNothing.length > 200);
const nothing = await type(page, longNothing);
assert.equal(nothing.decision.answers.action.choice, "none", "precondition: Jev must answer with no action");
const afterNothing = await assertSavedUntouched("no change", savedTwo, [`+${edgeA}`, `+${edgeB}`], [edgeA, edgeB].sort());
assert.equal(afterNothing.state, "no-change");
assert.deepEqual(afterNothing.draft, withOneStep.draft);
assert.deepEqual(afterNothing.context, afterSpokenUndo.context, "a text over 200 characters is left out of the window");
assert.equal(afterNothing.contextSkipped, "長すぎるため参照しない発話 1件");

await press(page, "#discard");
assert.equal((await screen(page)).state, "discarded");
assert.deepEqual((await screen(page)).draft, []);
assert.deepEqual((await screen(page)).items, []);
// Discard marks the step it dropped as undone.
const typedCEntry = withOneStep.context.at(-1);
assert.deepEqual((await screen(page)).context.find(entry => entry.seq === typedCEntry.seq),
  { seq: typedCEntry.seq, source: "typed", text: typedCEntry.text, outcome: "undone" });
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeB].sort());

// (x) Revert: an applied entry's opposite is added to 作業図 - never to 確定図 -
// and reaches storage only through Apply, as one more Decision after the rest.
await page.locator('button[data-revert="1"]').click();
await settle(page);
const reverting = await assertSavedUntouched("revert", savedTwo, [`+${edgeA}`, `+${edgeB}`], [edgeA, edgeB].sort());
assert.equal(reverting.state, "drafted");
assert.deepEqual(reverting.draft, [`-${edgeB}`]);
assert.deepEqual(reverting.items, [revertItem(`-${edgeB}`)], "a revert shows 取り消し and no text");
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
assert.deepEqual(conflict.items, [typedItem(removeA, `-${edgeA}`)]);
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
// `contextBefore` is the conversation just before the request in question:
// answers Jev did give in between (the retry below) join it as usual.
const assertUnmoved = async (label, now, contextBefore = idle.context) => {
  assert.equal(now.stored, idle.stored, `${label}: the stored bytes must not change`);
  assert.deepEqual(now.confirmed, idle.confirmed, `${label}: 確定図's entries must not change`);
  assert.deepEqual(now.draft, idle.draft, `${label}: the working steps must not change`);
  assert.deepEqual(now.context, contextBefore, `${label}: an utterance Jev never judged must not join the conversation`);
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
// The retry was judged, so it joined the conversation - and Undo marked it undone.
const beforeTimeout = await screen(page);
assert.deepEqual(withoutSeq(beforeTimeout.context).at(-1), heardAs(retried, "typed", "undone"));

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
await assertUnmoved("a provider timeout", reported, beforeTimeout.context);
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
// Still at most five entries, oldest first, none longer than 200 characters.
assert.equal(full.context.length, 5);
assert.ok(full.context.every((entry, index) => index === 0 || entry.seq > full.context[index - 1].seq));
assert.ok(full.context.every(entry => entry.text.length <= 200));
await press(page, "#discard");

// (xii-b) 会話をクリア forgets the recent conversation and changes nothing
// else; the next request sends none.
const beforeClear = await screen(page);
assert.ok(beforeClear.context.length > 0 && beforeClear.contextClearDisabled === false);
await page.locator("#context-clear").click();
const cleared = await screen(page);
assert.deepEqual(cleared.context, []);
assert.equal(cleared.contextSkipped, "", "clearing forgets the long utterance too");
assert.equal(cleared.contextClearDisabled, true);
assert.equal(cleared.stored, beforeClear.stored);
assert.deepEqual(cleared.draft, beforeClear.draft);

// (xiii) Apply's write fails on a genuinely exhausted quota: nothing is saved,
// 確定図 is unchanged, and 作業図 keeps its steps to retry.
const quotaStep = await type(page, "add an edge from c to a");
assert.deepEqual(quotaStep.sent.state.context, { recent: [] }, "after clearing, the next request sends no conversation");
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
assert.deepEqual(afterFailedWrite.items, [typedItem(quotaStep, `+${edgeC}`)], "a refused Apply keeps each step's text");
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
assert.deepEqual(conflicted.items, [typedItem(quotaStep, `+${edgeC}`)]);
assert.deepEqual((await drawn(page, "working")).edges, [edgeA, edgeC].sort());
await otherTab.close();

// (xv) A reload drops the unapplied steps, as 作業図 says it will; both panes
// start again from what is actually stored, and nothing else was ever stored.
await page.reload({ waitUntil: "commit" });
await ready(page);
const afterReload = await screen(page);
assert.equal(afterReload.state, "restored");
assert.deepEqual(afterReload.draft, [], "unapplied steps do not survive a reload");
assert.deepEqual(afterReload.items, []);
assert.deepEqual(afterReload.context, [], "a reload erases the recent conversation");
assertNotStored(afterReload.stored);
assert.equal(afterReload.stored, theirSaved);
assert.deepEqual(afterReload.storageKeys, [STORAGE_KEY], "the working graph is never written to storage");
assert.deepEqual(afterReload.confirmed, [`+${edgeA}`, `+${edgeB}`, `-${edgeB}`, `+${theirEdge}`]);
assert.deepEqual(await panes(page), { confirmed: [edgeA, theirEdge].sort(), working: [edgeA, theirEdge].sort() });

// (xvi) Saved, but not displayed. Apply's write lands; only the drawing of
// 確定図 that follows fails - its frame document is refused for exactly that
// one render. Storage now leads the screen, so the page must say so, block
// every further action, and a reload must draw what was saved.
const beforeUndrawn = afterReload.stored;
// The text of this step looks like markup. It must be shown literally, as
// text, and nothing in it may run or become an element.
const hostile = await type(page, 'add an edge from c to a <img src=x onerror="window.injected=1"><b>now</b>');
assert.deepEqual((await screen(page)).draft, [`+${edgeC}`], "precondition: Jev must still add c->a");
assert.deepEqual((await screen(page)).items, [typedItem(hostile, `+${edgeC}`)], "markup-like text is shown literally");
assert.equal(await page.evaluate(() => window.injected), undefined, "nothing in the text may run");

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
assertNotStored(undrawn.stored);
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

// (xvi-b) A part. One typed request adds one new part to 作業図 only: the page
// names it, places it and draws it, and 確定図 and the stored bytes do not move
// until Apply.
const cellsOf = async () => (await drawn(page, "working")).cells;
const beforePart = await screen(page);
const cellsBeforePart = await cellsOf();
assert.deepEqual(beforePart.draft, [], "precondition: nothing unapplied before the part");

const addPart = await type(page, "add a new decision box");
assert.equal(addPart.decision.answers.action.choice, "add-part", "precondition: Jev must answer add-part");
assert.equal(addPart.decision.answers.part.choice, "decision", "precondition: Jev must choose the decision kind");
const parted = await screen(page);
assert.equal(parted.state, "drafted");
assert.equal(parted.draft.length, 1);
const partId = parted.draft[0].replace(/^\+/u, "").replace(/「.*$/u, "");
assert.match(partId, /^part-\d+$/u, "the page names the part, not Jev");
assert.deepEqual(parted.items, [{
  source: "typed",
  input: addPart.sent.state.utterance,
  effect: `部品追加 ${partId}「判断 1」`,
  elements: 0,
}], "the step shows what was typed and the part it made");
assert.equal(await cellsOf(), cellsBeforePart + 1, "作業図 must draw exactly one more cell");
assert.equal(parted.stored, beforePart.stored, "a part must not be saved before Apply");
assert.deepEqual(parted.confirmed, beforePart.confirmed, "確定図 must not move before Apply");
assert.deepEqual((await drawn(page, "confirmed")).cells, cellsBeforePart, "確定図 must not draw the part");

// The request after it carries the part as an effect. A contract that knew
// only edges would refuse this one with 422 and the conversation would stop.
const afterPart = await type(page, "what is the weather like today");
assert.deepEqual(afterPart.sent.state.draft, [{
  changes: [{ change: "added", kind: "region", id: partId, label: "判断 1" }],
}], "a part effect reaches Jev as its id and label");
assert.deepEqual(afterPart.sent.state.focus, { kind: "draft", changes: afterPart.sent.state.draft[0].changes });
assert.equal((await screen(page)).state, "no-change");
assert.deepEqual((await screen(page)).draft, parted.draft, "a no-change keeps the part in the draft");

// Undo takes it away again, and its name is spent.
await press(page, "#undo");
assert.deepEqual((await screen(page)).draft, [], "Undo removes the part");
assert.equal(await cellsOf(), cellsBeforePart, "作業図 draws one fewer cell again");

const rebuilt = await type(page, "add a new decision box");
assert.equal(rebuilt.decision.answers.action.choice, "add-part");
const rebuiltId = (await screen(page)).draft[0].replace(/^\+/u, "").replace(/「.*$/u, "");
assert.notEqual(rebuiltId, partId, "a part name is never reused, not even after Undo");

await press(page, "#apply");
const appliedPart = await screen(page);
assert.equal(appliedPart.state, "applied");
assert.deepEqual(appliedPart.draft, []);
assert.ok(appliedPart.confirmed.at(-1).startsWith(`+${rebuiltId}`), "確定図 records the part");
assert.ok(appliedPart.stored.includes(rebuiltId), "Apply is what writes the part");
assert.equal(lineCount(appliedPart.stored), lineCount(beforePart.stored) + 1, "exactly one Decision is added");
const savedWithPart = appliedPart.stored;
const partEntry = appliedPart.confirmed.length - 1;
assert.equal(appliedPart.revertDisabled[partEntry], false, "a part standing alone can be taken back");

await page.reload({ waitUntil: "commit" });
await ready(page);
const afterPartReload = await screen(page);
assert.equal(afterPartReload.state, "restored");
assert.equal(afterPartReload.stored, savedWithPart, "reload must not rewrite the stored log");
assert.ok(afterPartReload.confirmed.at(-1).startsWith(`+${rebuiltId}`));
assert.equal(await cellsOf(), cellsBeforePart + 1, "both panes come back with the part");

// Taking the part back is one more step on 作業図, and Apply writes it.
await page.locator(`button[data-revert="${partEntry}"]`).click();
await settle(page);
const revertingPart = await screen(page);
assert.equal(revertingPart.state, "drafted");
assert.deepEqual(revertingPart.draft, [`-${rebuiltId}「判断 2」`], "the revert removes exactly that part");
assert.equal(revertingPart.stored, savedWithPart, "確定図 is untouched until Apply");
assert.equal(await cellsOf(), cellsBeforePart, "作業図 already shows it gone");
await press(page, "#discard");
assert.equal(await cellsOf(), cellsBeforePart + 1, "Discard puts 作業図 back");

// A part that has since gained an edge is not offered for revert: removing it
// would take the edge with it, which is more than that entry did.
const attach = await type(page, `add an edge from ${rebuiltId} to node-a`);
assert.equal(attach.decision.answers.action.choice, "add-edge", "precondition: Jev must connect the part");
await press(page, "#apply");
const attached = await screen(page);
assert.equal(attached.revertDisabled[partEntry], true, "a part with an edge is not offered for revert");
// Even activated directly, a disabled revert must do nothing: the page's own
// handler checks it, so the guard is not only in how the button looks.
await page.locator(`button[data-revert="${partEntry}"]`).dispatchEvent("click");
await page.waitForTimeout(300);
assert.equal((await screen(page)).stored, attached.stored, "a disabled revert does nothing");
assert.deepEqual((await screen(page)).draft, []);

// (xvi-b) Putting one part beside another, and proving it is actually drawn
// there. The layout contract and the boundary both keep reporting a part the
// view has culled, so every claim below is read off the adapter's own cells.
const placeBefore = await screen(page);
const drawnBefore = await boxes(page, "working");
const placeableDrawn = Object.keys(drawnBefore).filter(id => id !== "root").sort();
assert.ok(placeableDrawn.length >= 2, "precondition: at least two parts are drawn");

// The condition the single-pane guard rests on. If the panes ever stop being
// equal, this fails instead of the guard silently going wrong.
const widths = await mountWidths(page);
assert.equal(widths.working, widths.confirmed,
  `the guard asks 作業図 only, which needs both panes the same width: ${JSON.stringify(widths)}`);
assert.match(widths.columns, /^([\d.]+)px \1px$/u, `#panes must resolve to two equal columns: ${widths.columns}`);

// What 作業図 is showing. With no unapplied step both panes show the same head,
// which is exactly why head can never be what tells the panes apart.
const frameBefore = await visibleFrame(page, "working");
const confirmedFrameBefore = await visibleFrame(page, "confirmed");
assert.notEqual(frameBefore, null, "作業図 must report a visible frame");
assert.equal(frameBefore.schema, "semantic-map-visible-frame/1");
assert.equal(frameBefore.pattern, "graph/1");
assert.equal(frameBefore.frame.length, 4);
assert.deepEqual(placeBefore.draft, [], "precondition: nothing unapplied");
assert.equal(frameBefore.head, confirmedFrameBefore.head,
  "both panes show the same head here, so head is provenance and never pane identity");

// The view lays this graph out as one row, so the free spot is under it.
const placed = await type(page, "move node-c below node-a");
assert.deepEqual(
  [...placed.sent.state.working.placeable].sort(),
  placeableDrawn,
  "the parts offered to Jev are exactly the ones the view draws - never the boundary, and never an empty list from a swallowed layout failure",
);
assert.equal(placed.sent.state.working.placeable.includes("root"), false);
assert.equal(JSON.stringify(placed.sent).includes("bounds"), false, "Jev is never told where anything is drawn");
assert.equal(placed.decision.answers.action.choice, "place-part", "precondition: Jev must hear this as a placement");
const moveId = placed.decision.answers.move.choice;
const anchorId = placed.decision.answers.anchor.choice;
const direction = placed.decision.answers.direction.choice;
assert.ok(placeableDrawn.includes(moveId) && placeableDrawn.includes(anchorId), "both parts are drawn ones");
assert.ok(["left", "right", "above", "below"].includes(direction));

const placedScreen = await screen(page);
assert.equal(placedScreen.state, "drafted",
  `placement was not drafted: ${placedScreen.status} | answers=${JSON.stringify(placed.decision.answers)} `
  + `| drawn=${JSON.stringify(drawnBefore)}`);
assert.equal(placedScreen.draft.length, 1, "a placement is one step on 作業図");
assert.deepEqual(placedScreen.draft, [`~${moveId}`], "the step names the part Jev chose");
assert.match(placedScreen.items[0].effect, new RegExp(`配置 ${moveId} を ${anchorId} の[左右上下]へ`, "u"),
  "and says in words where it went");

// Where it should land, worked out here from the geometry the view itself is
// using - not read back off the app's own label.
const gap = 24;
const [ax, ay, aw, ah] = drawnBefore[anchorId].box;
const [, , tw, th] = drawnBefore[moveId].box;
const target = direction === "left" ? [ax - tw - gap, ay, tw, th]
  : direction === "right" ? [ax + aw + gap, ay, tw, th]
  : direction === "above" ? [ax, ay - th - gap, tw, th]
  : [ax, ay + ah + gap, tw, th];

// The claim under test: the cell exists, it is rendered, and it is there.
const drawnAfter = await boxes(page, "working");
assert.ok(drawnAfter[moveId], `${moveId} must still have a cell after being moved`);
assert.equal(drawnAfter[moveId].rendered, true, `${moveId} must still be drawn after being moved`);
assert.deepEqual(drawnAfter[moveId].box, target, "and drawn exactly where the step says");
assert.notDeepEqual(drawnAfter[moveId].box, drawnBefore[moveId].box, "which is not where it was");
for (const id of Object.keys(drawnBefore)) {
  // The boundary is the frame, not a part: it is allowed to fit itself around
  // what it holds. Every actual part must stay exactly where it was.
  if (id === moveId || id === "root") continue;
  assert.deepEqual(drawnAfter[id].box, drawnBefore[id].box, `${id} must not move`);
  assert.equal(drawnAfter[id].rendered, true, `${id} must stay drawn`);
}
// The promise the guard makes: the spot was inside what 作業図 was showing when
// the answer came back - the provider's frame, not the enclosing boundary.
assert.ok(insideFrame(target, frameBefore.frame),
  `the new spot ${JSON.stringify(target)} must be inside the visible frame ${JSON.stringify(frameBefore.frame)}`);
// And it is on screen in the ordinary sense: the whole cell's own rectangle
// falls inside the pane's own rectangle.
const paintedInPane = await page.evaluate(regionId => {
  const surface = document.querySelector("#working-surface");
  const win = surface.querySelector('iframe[data-package="semantic-map"]').contentWindow;
  const doc = surface.querySelector('iframe[data-package="semantic-map"]').contentDocument;
  const adapter = win.semanticMapApp.adapter;
  const cell = adapter.cellsByRegionId.get(regionId);
  const shape = adapter.graph.getView().getState(cell)?.shape?.node ?? null;
  const rect = shape?.getBoundingClientRect?.() ?? null;
  const pane = doc.querySelector("#graph-container").getBoundingClientRect();
  if (rect === null) return { rect: null };
  const w = Math.max(0, Math.min(rect.right, pane.right) - Math.max(rect.left, pane.left));
  const h = Math.max(0, Math.min(rect.bottom, pane.bottom) - Math.max(rect.top, pane.top));
  return {
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    pane: { x: pane.x, y: pane.y, w: pane.width, h: pane.height },
    visibleArea: w * h,
    wholeArea: rect.width * rect.height,
  };
}, moveId);
assert.notEqual(paintedInPane.rect, null, "the moved part must have a painted shape");
assert.ok(paintedInPane.wholeArea > 0, "and that shape must have area");
assert.ok(paintedInPane.visibleArea >= paintedInPane.wholeArea - 0.5,
  `the whole moved part must be inside the pane: ${JSON.stringify(paintedInPane)}`);
assert.equal(Object.keys(drawnAfter).length, Object.keys(drawnBefore).length, "no cell appears or disappears");
assert.equal(placedScreen.stored, placeBefore.stored, "nothing is saved before Apply");
assert.deepEqual(await boxes(page, "confirmed"), await boxes(page, "confirmed"), "確定図 is read twice identically");
const confirmedDuring = await boxes(page, "confirmed");
assert.deepEqual(confirmedDuring[moveId].box, drawnBefore[moveId].box, "確定図 must not move the part before Apply");

// The ceiling, in the same run and immediately after the placement above. The
// pane's camera does not follow the diagram as it grows, so the window is
// finite: a spot past its edge is a truthful no change, not a hidden failure.
// Both coordinates are measured, so the refusal is shown to be geometric.
const frameAtCeiling = await visibleFrame(page, "working");
assert.notEqual(frameAtCeiling, null, "the pane still reports a frame");
const leftmost = placeableDrawn
  .map(id => [id, drawnAfter[id].box])
  .sort((left, right) => left[1][0] - right[1][0])[0][0];
const mover = placeableDrawn.find(id => id !== leftmost);
const ceilingSpot = [
  drawnAfter[leftmost].box[0] - drawnAfter[mover].box[2] - gap,
  drawnAfter[leftmost].box[1],
  drawnAfter[mover].box[2],
  drawnAfter[mover].box[3],
];
assert.equal(insideFrame(ceilingSpot, frameAtCeiling.frame), false,
  `precondition: the spot left of ${leftmost} at ${JSON.stringify(ceilingSpot)} is outside the visible `
  + `frame ${JSON.stringify(frameAtCeiling.frame)}`);
// The positive spot from a moment ago was inside the very same frame, so the two
// outcomes differ by geometry alone.
assert.ok(insideFrame(target, frameAtCeiling.frame),
  "the spot that was placed is inside this same frame, so only geometry separates the two");
const offscreen = await type(page, `move ${mover} to the left of ${leftmost}`);
let offscreenGuard;
if (offscreen.decision.answers.action.choice === "place-part"
  && offscreen.decision.answers.direction.choice === "left"
  && offscreen.decision.answers.anchor.choice === leftmost
  && offscreen.decision.answers.move.choice === mover) {
  const refusedScreen = await screen(page);
  assert.equal(refusedScreen.state, "no-change", "a spot past the edge is a no change");
  assert.match(refusedScreen.status, /今の表示の外/u, "and it says why, in the words for being off the pane");
  assert.equal(/読み取れない|追いついていない/u.test(refusedScreen.status), false,
    "not the words for having no frame or for a pane that has not caught up");
  assert.equal(refusedScreen.state === "failed", false, "ordinary speech is never an error");
  assert.deepEqual(refusedScreen.draft, placedScreen.draft, "the draft is untouched");
  assert.deepEqual(await boxes(page, "working"), drawnAfter, "and nothing on the screen moved");
  offscreenGuard = `a spot left of ${leftmost} is past the edge and was refused, nothing moved`;
} else {
  console.log(`  off-screen probe: Jev answered ${JSON.stringify(offscreen.decision.answers.action.choice)} / `
    + `move=${JSON.stringify(offscreen.decision.answers.move?.choice)} `
    + `anchor=${JSON.stringify(offscreen.decision.answers.anchor?.choice)} `
    + `side=${JSON.stringify(offscreen.decision.answers.direction?.choice)}, `
    + "so the edge guard was not exercised by this utterance");
  offscreenGuard = "the edge guard was not exercised by this run";
}

// Apply writes it, and a reload draws it from the stored log alone.
await press(page, "#apply");
const appliedPlacement = await screen(page);
assert.equal(appliedPlacement.state, "applied");
assert.deepEqual(appliedPlacement.draft, []);
assert.equal(lineCount(appliedPlacement.stored), lineCount(placeBefore.stored) + 1, "exactly one Decision is added");
assert.equal(appliedPlacement.confirmed.at(-1), `+${moveId}@${target.join(",")}`,
  "確定図 records the part and exactly where it went");
const placementEntry = appliedPlacement.confirmed.length - 1;
assert.equal(appliedPlacement.revertDisabled[placementEntry], false, "a placement can be taken back");

await page.reload({ waitUntil: "commit" });
await ready(page);
const afterPlacementReload = await screen(page);
assert.equal(afterPlacementReload.state, "restored");
assert.equal(afterPlacementReload.stored, appliedPlacement.stored, "reload must not rewrite the stored log");
const reloaded = await boxes(page, "working");
assert.equal(reloaded[moveId].rendered, true, "the moved part comes back drawn");
assert.deepEqual(reloaded[moveId].box, target, "in exactly the same place");
assert.deepEqual((await boxes(page, "confirmed"))[moveId].box, target, "and 確定図 now draws it there too");
// 確定図 shows the same world geometry and, while the panes are equal, the same
// visible frame - so what the person approved on the right is what they see on
// the left. This is where an unequal ratio would show up.
const reloadedFrames = {
  working: await visibleFrame(page, "working"),
  confirmed: await visibleFrame(page, "confirmed"),
};
assert.deepEqual(reloadedFrames.confirmed.frame, reloadedFrames.working.frame,
  `equal panes must resolve the same frame: ${JSON.stringify(reloadedFrames)}`);
assert.equal(reloadedFrames.confirmed.head, reloadedFrames.working.head, "and the same head once applied");
assert.ok(insideFrame(target, reloadedFrames.confirmed.frame),
  "the applied placement is inside what 確定図 shows, not only what 作業図 showed");

// Revert puts it back where the view had it, and that is drawn as well.
await page.locator(`button[data-revert="${placementEntry}"]`).click();
await settle(page);
const revertingPlacement = await screen(page);
assert.equal(revertingPlacement.state, "drafted");
assert.deepEqual(revertingPlacement.draft, [`~${moveId}`], "the revert takes back exactly that part");
assert.equal(revertingPlacement.items[0].effect, `配置を戻す ${moveId}`, "and says so in words");
const afterRevert = await boxes(page, "working");
assert.equal(afterRevert[moveId].rendered, true, "the part is still drawn after being put back");
assert.deepEqual(afterRevert[moveId].box, drawnBefore[moveId].box, "back where the view had put it itself");
assert.equal(revertingPlacement.stored, appliedPlacement.stored, "確定図 is untouched until Apply");
await press(page, "#discard");
assert.deepEqual((await boxes(page, "working"))[moveId].box, target, "Discard puts 作業図 back");

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
assert.deepEqual((await screen(page)).items, [typedItem(typedStep, `+${typedEdge}`)]);
assert.equal((await screen(page)).stored, savedLog);
assert.deepEqual(await panes(page), { confirmed: [voiceEdge], working: [voiceEdge, typedEdge].sort() });

// (xvii-b) A press whose microphone is refused - the browser API is made to
// reject, as a denied permission would. The page never asks the user to
// speak, sends nothing to Jev, reports the failure, and gives every control
// back with both panes, the working steps and the stored bytes unchanged. The
// next press is the spoken correction below.
const beforeRefusal = await screen(page);
const panesBeforeRefusal = await panes(page);
const refusalFrom = (await voiceTrace(page)).length;
const refusalJev = countJev(page);
await page.evaluate(() => { window.failNextMicrophone = true; });
await page.locator("#mic").click();
await settle(page);
await voiceIdle(page);
refusalJev.stop();
const refused = await screen(page);
const refusalTrace = await voiceTrace(page, refusalFrom);
assert.equal(refused.state, "failed");
assert.match(refused.failure ?? "", /microphone refused by the test/u);
assert.deepEqual(voicePhases(refusalTrace).map(entry => entry.kind), ["voice:preparing", "voice:idle"],
  "a refused microphone must never ask the user to speak");
assert.equal(refusalTrace.some(entry => entry.kind === "text-focus"), false);
assert.equal(refusalJev.count, 0, "a refused microphone must send nothing to Jev");
assert.equal(refused.stored, beforeRefusal.stored);
assert.deepEqual(refused.confirmed, beforeRefusal.confirmed);
assert.deepEqual(refused.draft, beforeRefusal.draft);
assert.deepEqual(await panes(page), panesBeforeRefusal);
for (const control of ["sendDisabled", "micDisabled", "undoDisabled", "discardDisabled", "applyDisabled", "revertDisabled"]) {
  assert.deepEqual(refused[control], beforeRefusal[control], `${control} must be given back after a refused microphone`);
}

const [typedFrom, typedTo] = typedEdge.split("->");
const heard = await speak(page);
assert.equal(heard.sent.kind, "voice-ui.jev.request.v7");
// The spoken correction carries the typed step before it as recent context:
// what was typed, and the step it made.
assert.deepEqual(withoutSeq(heard.sent.state.context.recent), [heardAs(typedStep, "typed", "step", `+${typedEdge}`)]);
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
// Each step keeps the text it was judged from: the typed one its typed text,
// the spoken one exactly the recognized text that was sent to Jev.
assert.deepEqual(corrected.items, [
  typedItem(typedStep, `+${typedEdge}`),
  voiceItem(heard, `-${typedEdge} +${flip(typedEdge)}`),
]);
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
assert.deepEqual(final.items, []);
assertNotStored(final.stored);
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
for (const input of inputsSent) {
  assert.equal(consoleMessages.some(message => message.includes(input)), false, `an input was logged to the console: ${input}`);
}

process.stdout.write(
  `local-voice-graph-e2e: PASS spoken add "${voiceAdd.sent.state.utterance}" -> 作業図 only, applied edge=${voiceEdge} `
  + `| each voice press: one click, 0 text focus, 0 Send, [${voiceAdd.trace.join(" ")}], 1 Jev request `
  + `| every step shows its exact text (認識文/入力文) and verified effect through Undo, revert, refused and successful Apply, reload; `
  + `${inputsSent.size} distinct inputs: earlier ones reach Jev only in state.context.recent, which equalled the panel on every request, `
  + "never stored or logged; markup-like text literal "
  + "| recent conversation: step, undone by Undo and Discard, undo-request and no-change kept, >200 characters counted not sent, "
  + "window of 5, kept by Apply, erased by reload and 会話をクリア, nothing from blank input or timeouts "
  + `| part: one typed request drew ${rebuiltId}「判断 2」 on 作業図 only, the next request carried it as an effect, `
  + `Undo removed it and spent its name (${partId} never reused), Apply and reload kept it, `
  + "lone-part revert drafted then discarded, a part with an edge is not revertable "
  + `| placement: "${placed.sent.state.utterance}" -> ${moveId} ${direction} ${anchorId}, `
  + `drawn cell present and rendered at ${JSON.stringify(target)} (was ${JSON.stringify(drawnBefore[moveId].box)}), `
  + `wholly inside the pane, every other part unmoved; visible frame ${JSON.stringify(frameBefore.frame)} `
  + `at head ${frameBefore.head.slice(0, 14)}, panes equal at ${widths.working}px; `
  + `ceiling in the same run: ${JSON.stringify(ceilingSpot)} is outside that frame - ${offscreenGuard}; `
  + "Apply and reload draw it in the same place in both panes, revert puts it back drawn "
  + `| ${jevAnswered} real Jev answers in this run `
  + `| refused microphone: [${voicePhases(refusalTrace).map(entry => entry.kind).join(" ")}], 0 Jev requests, nothing changed, controls given back `
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
