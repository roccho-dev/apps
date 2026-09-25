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
// so its cost is visible. Answers the test crafts at the network carry the
// model "jev-test" and are counted apart, never as real ones.
let jevAnswered = 0;
let craftedAnswered = 0;
const pendingCounts = [];

const watch = target => {
  target.on("pageerror", error => errors.push(String(error)));
  target.on("console", message => consoleMessages.push(message.text()));
  target.on("response", response => {
    if (response.status() >= 400) {
      failedResponses.push(response.status() + " " + response.url());
    }
    // An answer fulfilled by the test at the network is also a 200 here, so it
    // is told apart by the model name every crafted answer carries.
    if (new URL(response.url()).pathname === "/api/jev" && response.status() === 200 && !response.request().isNavigationRequest()) {
      pendingCounts.push(response.json().then(
        body => { if (body?.model === "jev-test") craftedAnswered += 1; else jevAnswered += 1; },
        () => { jevAnswered += 1; },
      ));
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
  // The transient per-turn diagnostic. Present only for a no-change Jev judged,
  // replaced on every input, never stored.
  diagnostic: { ...document.querySelector("#status").dataset },
  initialLine: document.querySelector("[data-history=initial]")?.textContent ?? null,
  // 確定図's applied entries.
  confirmed: [...document.querySelectorAll("[data-history=confirmed] li")]
    .map(item => item.dataset.facts),
  failure: document.querySelector("[data-history=failure]")?.textContent ?? null,
  // 作業図's unapplied steps.
  draft: [...document.querySelectorAll("#draft li")].map(item => item.dataset.changes),
  // Each unapplied step as shown: where its text came from, that text, what it
  // does, and whether any element was created inside the item's text.
  // The piece a near-placement is waiting for, if any. In memory only.
  pending: document.body.dataset.pending ?? null,
  items: [...document.querySelectorAll("#draft li")].map(item => ({
    source: item.dataset.source,
    input: item.querySelector("[data-input]")?.textContent ?? null,
    // A step completed by a second utterance also shows the first one.
    originSource: item.dataset.originSource ?? null,
    origin: item.querySelector("[data-origin]")?.textContent ?? null,
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
// visible, which is sound while both panes resolve the same camera: #panes is a
// 1fr 1fr grid of equal sections, and both are given the same View.frame. Equal
// widths are one half of that condition and equal frames (bothFrames) the other.
// A future ratio change must fail here rather than quietly let a spot pass on
// the right and land off-pane on the left.
const mountWidths = target => target.evaluate(() => ({
  confirmed: document.querySelector("#confirmed-surface").getBoundingClientRect().width,
  working: document.querySelector("#working-surface").getBoundingClientRect().width,
  columns: getComputedStyle(document.querySelector("#panes")).gridTemplateColumns,
}));

// Both panes' visible frames, from the provider's own contract.
const bothFrames = async target => ({
  confirmed: (await visibleFrame(target, "confirmed"))?.frame ?? null,
  working: (await visibleFrame(target, "working"))?.frame ?? null,
});

// What each pane's embed says it presents. Only the pinned provider (ui#308)
// marks these; an older one would ignore the option without a word and keep its
// own chrome over the cells, so a missing marker is a wrong pin, not a detail.
const presentations = target => target.evaluate(() => Object.fromEntries(["confirmed", "working"].map(pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  return [pane, {
    iframe: frame?.dataset.presentation ?? null,
    document: frame?.contentDocument?.documentElement?.dataset.presentation ?? null,
  }];
})));
const CHROME_FREE = { iframe: "chrome-free", document: "chrome-free" };

// Whether a box is wholly inside a frame, in the view's own coordinates.
const insideFrame = (box, frame) => box[0] >= frame[0] && box[1] >= frame[1]
  && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3];

// The parts wholly on a pane: drawn cells whose own boxes lie inside the
// provider's frame. A cell alone is not enough - the renderer builds cells in a
// margin band just outside the frame that nobody sees.
const onPane = (drawnBoxes, frame) => Object.entries(drawnBoxes)
  .filter(([id, drawn]) => id !== "root" && drawn.box !== null && insideFrame(drawn.box, frame))
  .map(([id]) => id)
  .sort();

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
  assert.equal(sent.kind, "voice-ui.jev.request.v9");
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
const itemFor = (source, input, changes) => ({
  source, input, originSource: null, origin: null, effect: effectText(changes), elements: 0,
});
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

// VOICE_E2E_FOCUS=diagram runs only (xix) and (xx): each opens a fresh browser
// from the genesis graph and empty storage and depends on nothing an earlier
// section did, so they prove the same thing on their own. Their Jev turns are
// the real Jev's, exactly as in the full run; nothing here is mocked that the
// full run does not also craft. It does not replace the full run: sections
// (i)-(xviii) are not executed, and the result line says so - it is never the
// full run's "local-voice-graph-e2e: PASS". Any other value is refused.
const FOCUS = process.env.VOICE_E2E_FOCUS ?? "";
assert.ok(FOCUS === "" || FOCUS === "diagram", `VOICE_E2E_FOCUS must be unset or "diagram", not ${JSON.stringify(FOCUS)}`);
const focused = FOCUS === "diagram";

// Shared by the sections that run in both modes.
const jevUrl = new URL("/api/jev", url).href;
// A Jev answer crafted from the request it answers, for turns where geometry
// or the app's own refusal - not Jev's hearing - is what is under test.
const craftFor = (sent, answers) => ({
  kind: "voice-ui.jev.decision.v4",
  model: "jev-test",
  answers: {
    source: { type: "choice", choice: "none", confidence: 0.9 },
    target: { type: "choice", choice: "none", confidence: 0.9 },
    part: { type: "choice", choice: "none", confidence: 0.9 },
    ...(sent.state.working.placeable.length >= 2
      ? {
        move: { type: "choice", choice: "none", confidence: 0.9 },
        anchor: { type: "choice", choice: "none", confidence: 0.9 },
        direction: { type: "choice", choice: "none", confidence: 0.9 },
      }
      : {}),
    ...(sent.state.working.edges.length > 0 ? { edge: { type: "choice", choice: "none", confidence: 0.9 } } : {}),
    ...(sent.state.candidates?.length > 0 ? { diagram: { type: "choice", choice: "none", confidence: 0.9 } } : {}),
    ...answers,
  },
});
const answerFrom = answers => route => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(craftFor(JSON.parse(route.request().postData()), answers)),
});

let page;
// What sections (i)-(xviii) report, captured while their values are in scope.
let fullRunSummary = null;

// Sections (i)-(xviii), the full run only. The body is not re-indented, to
// keep this change to its boundaries.
if (!focused) {
const first = await openBrowser(wav);
page = first.page;

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
assert.equal(voiceAdd.sent.kind, "voice-ui.jev.request.v9");
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
assert.equal(typedA.sent.kind, "voice-ui.jev.request.v9", "Send must use the typed graph decision");
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
  originSource: null,
  origin: null,
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
assert.deepEqual(await presentations(page), { confirmed: CHROME_FREE, working: CHROME_FREE },
  "both panes are drawn by the pinned provider's chrome-free presentation");
const framesAtStart = await bothFrames(page);
assert.deepEqual(framesAtStart.confirmed, framesAtStart.working,
  `and both are given the same View.frame: ${JSON.stringify(framesAtStart)}`);

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

// The parts Jev may name are the ones wholly on 作業図 as the request is built:
// the provider's frame and the adapter's own cells, never the layout contract's
// pre-culling bounds.
const offeredBefore = onPane(drawnBefore, frameBefore.frame);
assert.ok(offeredBefore.length >= 2, `precondition: at least two parts are on the pane: ${JSON.stringify(offeredBefore)}`);

// A request that can succeed here: two parts on the pane and a side of the
// anchor that is free and on the pane too, worked out from the drawn cells and
// the provider's frame. Which parts that is depends on how the earlier steps
// laid the graph out, so it is chosen, not assumed.
const sideWords = { left: "to the left of", right: "to the right of", above: "above", below: "below" };
const spotBeside = (anchorBox, moverBox, side) => side === "left" ? [anchorBox[0] - moverBox[2] - 24, anchorBox[1], moverBox[2], moverBox[3]]
  : side === "right" ? [anchorBox[0] + anchorBox[2] + 24, anchorBox[1], moverBox[2], moverBox[3]]
  : side === "above" ? [anchorBox[0], anchorBox[1] - moverBox[3] - 24, moverBox[2], moverBox[3]]
  : [anchorBox[0], anchorBox[1] + anchorBox[3] + 24, moverBox[2], moverBox[3]];
const freeOf = (drawnBoxes, box, except) => Object.entries(drawnBoxes).every(([id, cell]) =>
  id === "root" || id === except || cell.box === null
  || !(box[0] < cell.box[0] + cell.box[2] && cell.box[0] < box[0] + box[2]
    && box[1] < cell.box[1] + cell.box[3] && cell.box[1] < box[1] + box[3]));
const request = (() => {
  for (const anchor of offeredBefore) {
    for (const mover of offeredBefore) {
      if (mover === anchor) continue;
      for (const side of ["below", "right", "left", "above"]) {
        const spot = spotBeside(drawnBefore[anchor].box, drawnBefore[mover].box, side);
        if (insideFrame(spot, frameBefore.frame) && freeOf(drawnBefore, spot, mover)) return { anchor, mover, side };
      }
    }
  }
  return null;
})();
assert.notEqual(request, null, `precondition: some free spot on the pane beside an on-pane part: `
  + JSON.stringify({ offeredBefore, frame: frameBefore.frame }));

const placed = await type(page, `move ${request.mover} ${sideWords[request.side]} ${request.anchor}`);
assert.deepEqual(
  [...placed.sent.state.working.placeable].sort(),
  offeredBefore,
  "the parts offered to Jev are exactly the ones wholly on the pane - never the boundary, never a part the "
    + "pane cuts off, and never an empty list from a swallowed layout failure",
);
assert.equal(placed.sent.state.working.placeable.includes("root"), false);
assert.equal(JSON.stringify(placed.sent).includes("bounds"), false, "Jev is never told where anything is drawn");
assert.equal(placed.decision.answers.action.choice, "place-part", "precondition: Jev must hear this as a placement");
const moveId = placed.decision.answers.move.choice;
const anchorId = placed.decision.answers.anchor.choice;
const direction = placed.decision.answers.direction.choice;
assert.ok(offeredBefore.includes(moveId) && offeredBefore.includes(anchorId), "both parts are ones on the pane");
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
// Both named parts are on the pane, so the only thing off it is the spot.
const offeredAtCeiling = onPane(drawnAfter, frameAtCeiling.frame);
const leftmost = offeredAtCeiling
  .map(id => [id, drawnAfter[id].box])
  .sort((left, right) => left[1][0] - right[1][0])[0][0];
const mover = offeredAtCeiling.find(id => id !== leftmost);
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
const refusedScreen = await screen(page);

// Whatever Jev made of that sentence, the safety property holds unconditionally:
// nothing may be placed at a spot outside the frame. Any placement step the draft
// gained has to name a spot inside it.
const placementSteps = refusedScreen.items
  .map((item, index) => ({ item, changes: refusedScreen.draft[index] }))
  .filter(entry => /^[~+-][^@]+$/u.test(entry.changes) && /配置/u.test(entry.item.effect ?? ""));
const frameNow = await visibleFrame(page, "working");
for (const [regionId, drawn] of Object.entries(await boxes(page, "working"))) {
  if (regionId === "root") continue;
  if (JSON.stringify(drawn.box) === JSON.stringify(drawnAfter[regionId]?.box)) continue;
  assert.ok(insideFrame(drawn.box, frameNow.frame),
    `${regionId} moved to ${JSON.stringify(drawn.box)}, which is outside the frame `
    + `${JSON.stringify(frameNow.frame)} - nothing may be placed where it cannot be seen`);
}

// And the evidence R asked for - the ceiling in the same run as the placement -
// is not optional. If Jev heard this sentence as something else the run cannot
// produce that evidence, so it fails rather than passing quietly.
assert.deepEqual(
  {
    action: offscreen.decision.answers.action.choice,
    move: offscreen.decision.answers.move?.choice,
    anchor: offscreen.decision.answers.anchor?.choice,
    direction: offscreen.decision.answers.direction?.choice,
  },
  { action: "place-part", move: mover, anchor: leftmost, direction: "left" },
  "the ceiling has to be exercised in this run, so Jev must hear this sentence as that placement; "
  + `${placementSteps.length} placement steps in the draft`,
);
assert.equal(refusedScreen.state, "no-change", "a spot past the edge is a no change");
assert.match(refusedScreen.status, /今の表示の外/u, "and it says why, in the words for being off the pane");
assert.equal(/読み取れない|追いついていない/u.test(refusedScreen.status), false,
  "not the words for having no frame or for a pane that has not caught up");
assert.equal(refusedScreen.state === "failed", false, "ordinary speech is never an error");
assert.deepEqual(refusedScreen.draft, placedScreen.draft, "the draft is untouched");
assert.deepEqual(await boxes(page, "working"), drawnAfter, "and nothing on the screen moved");
const offscreenGuard = `a spot left of ${leftmost} is past the edge and was refused, nothing moved`;

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

// (xvi-c) The per-turn diagnostic. A real refusal is the one thing a person
// cannot report usefully: the reason is on screen, but not the context that
// produced it - how many parts were on offer, what Jev actually chose and how
// sure it was, and what the pane said. This turn is answered from the test
// rather than by Jev, so the numbers are fixed and the assertion is exact.
const diagBefore = (await screen(page)).diagnostic;
assert.equal(diagBefore.diag, undefined, "a turn that ended in a step leaves no diagnostic behind");
// What this turn will offer: the parts wholly on the pane now. The crafted
// answer below names two of them, so it is judged rather than refused.
const offeredAtDiag = onPane(await boxes(page, "working"), (await visibleFrame(page, "working")).frame);
assert.ok(offeredAtDiag.includes(moveId) && offeredAtDiag.includes(anchorId),
  `precondition: ${moveId} and ${anchorId} are on the pane: ${JSON.stringify(offeredAtDiag)}`);

// Shaped exactly as the page's own reader expects: the edge slot exists only
// while the working graph has an edge to name, and "none" is always offered.
const craftedAnswer = {
  kind: "voice-ui.jev.decision.v4",
  model: "jev-test",
  answers: {
    action: { type: "choice", choice: "place-part", confidence: 0.91 },
    source: { type: "choice", choice: "none", confidence: 0.9 },
    target: { type: "choice", choice: "none", confidence: 0.9 },
    part: { type: "choice", choice: "none", confidence: 0.9 },
    move: { type: "choice", choice: moveId, confidence: 0.44 },
    anchor: { type: "choice", choice: anchorId, confidence: 0.87 },
    direction: { type: "choice", choice: "left", confidence: 0.93 },
    ...((await panes(page)).working.length > 0
      ? { edge: { type: "choice", choice: "none", confidence: 0.9 } }
      : {}),
    // The page always offers its whole diagrams, so every answer says which.
    diagram: { type: "choice", choice: "none", confidence: 0.9 },
  },
};
await page.route(jevUrl, route => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(craftedAnswer),
}), { times: 1 });
const diagExchange = jevExchange(page);
await page.locator("#text").fill("この部品をその隣に置いて");
await page.locator("#send").click();
await diagExchange.request;
assert.equal((await diagExchange.response).status(), 200, "precondition: the crafted answer reached the page");
await settle(page);

const diagnosed = await screen(page);
assert.equal(diagnosed.state, "no-change", "a slot under the floor is a no change");
assert.deepEqual(diagnosed.diagnostic, {
  diag: "jev-no-change",
  diagOutcome: "no-change",
  diagPlaceable: String(offeredAtDiag.length),
  diagPlaceOffered: "yes",
  diagAction: "place-part:0.91",
  diagMove: `${moveId}:0.44`,
  diagAnchor: `${anchorId}:0.87`,
  diagDirection: "left:0.93",
  diagFrame: "ok",
}, "the turn is inspectable: what was offered, what was chosen, how sure, and what the pane said");
// The reason itself is the status text, so the attributes never repeat it - and
// they never carry the utterance, a probability distribution, or anything else.
assert.equal(Object.keys(diagnosed.diagnostic).every(key => key === "diag" || key.startsWith("diag")), true);
for (const value of Object.values(diagnosed.diagnostic)) {
  assert.equal(value.includes("この部品をその隣に置いて"), false, "no utterance in the diagnostic");
  assert.ok(value.length <= 40, `bounded values only: ${value}`);
}
// Only the moved part was unsure (0.44) and the placement itself was sure
// (0.91), so the person is told which piece did not come through - in the
// status they already read, without any part id - and that one piece is now
// held, in memory, for the next utterance.
assert.equal(diagnosed.status,
  "type: no change - 動かす部品が聞き取れませんでした。どの部品を動かしますか。部品の名前だけでも、指示全体でも言ってください",
  "exactly one unsure piece is named");
assert.equal(/node-|part-/u.test(diagnosed.status), false, "no part id is read out");
assert.deepEqual(diagnosed.draft, [], "and nothing was drafted");
assert.equal(diagnosed.pending, "move", "the missing piece is held for one utterance");

// Each of the following crafted turns stands on its own, so any piece held by
// the one before is dropped first - with 会話をクリア, which drops it by design.
const dropPending = async () => {
  if ((await screen(page)).pending === null) return;
  await page.locator("#context-clear").click();
  assert.equal((await screen(page)).pending, null, "会話をクリア drops a held piece");
};
await dropPending();

// The measured real turn itself, replayed with its own confidences: action
// 0.94, move 0.86, anchor 0.39, direction 0.97. Only the neighbour is named.
const measuredTurn = async (answers, text) => {
  await page.route(jevUrl, route => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ ...craftedAnswer, answers: { ...craftedAnswer.answers, ...answers } }),
  }), { times: 1 });
  const exchange = jevExchange(page);
  await page.locator("#text").fill(text);
  await page.locator("#send").click();
  await exchange.request;
  await settle(page);
  return screen(page);
};
const weakAnchor = await measuredTurn({
  action: { type: "choice", choice: "place-part", confidence: 0.94 },
  move: { type: "choice", choice: moveId, confidence: 0.86 },
  anchor: { type: "choice", choice: anchorId, confidence: 0.39 },
  direction: { type: "choice", choice: "left", confidence: 0.97 },
}, "一を濃度A の左に置いてください");
assert.equal(weakAnchor.state, "no-change");
assert.equal(weakAnchor.status,
  "type: no change - 隣に置く相手の部品が聞き取れませんでした。どの部品の隣ですか。部品の名前だけでも、指示全体でも言ってください",
  "the measured turn names the neighbour, and only the neighbour");
assert.equal(weakAnchor.diagnostic.diagAnchor, `${anchorId}:0.39`, "the diagnostic shows the same shortfall");
assert.deepEqual(weakAnchor.draft, []);
assert.equal(weakAnchor.pending, "anchor");
await dropPending();

// A part named as its own neighbour, with only the side unsure: supplying the
// side would only reach "cannot be placed beside itself", so the whole
// instruction is asked for - never the side alone, and never a failure.
const selfAnchor = await measuredTurn({
  action: { type: "choice", choice: "place-part", confidence: 0.94 },
  move: { type: "choice", choice: moveId, confidence: 0.9 },
  anchor: { type: "choice", choice: moveId, confidence: 0.9 },
  direction: { type: "choice", choice: "left", confidence: 0.39 },
}, "これをこれの隣に置いて");
assert.equal(selfAnchor.state, "no-change", "a self-anchor with one unsure piece is a no change, not a failure");
assert.equal(selfAnchor.status,
  "type: no change - 配置の指示を聞き取れませんでした。動かす部品・隣の部品・方向をそろえて、もう一度言ってください");
assert.deepEqual(selfAnchor.draft, []);
assert.equal(selfAnchor.pending, null, "a part beside itself is never held");

// Not eligible for naming one piece: the placement action itself was unsure.
// The whole instruction is asked for again instead.
await page.route(jevUrl, route => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({
    ...craftedAnswer,
    answers: { ...craftedAnswer.answers, action: { type: "choice", choice: "place-part", confidence: 0.41 } },
  }),
}), { times: 1 });
const restateExchange = jevExchange(page);
await page.locator("#text").fill("この部品をその隣に置いて");
await page.locator("#send").click();
await restateExchange.request;
await settle(page);
const restated = await screen(page);
assert.equal(restated.state, "no-change");
assert.equal(restated.status, "type: no change - 配置の指示を聞き取れませんでした。動かす部品・隣の部品・方向をそろえて、もう一度言ってください",
  "an unsure action asks for the whole instruction, never for one word");
assert.deepEqual(restated.draft, []);
assert.equal(restated.pending, null, "an unsure action is never held");

// Nothing persisted.
assert.equal(diagnosed.stored, appliedPlacement.stored, "the diagnostic is not written to storage");
assert.deepEqual(diagnosed.storageKeys, appliedPlacement.storageKeys, "and adds no storage key");

// Replaced on the next turn rather than accumulating: the same crafted route,
// this time a confident "none", so every value must change together and nothing
// from the previous turn may survive.
await page.route(jevUrl, route => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({
    ...craftedAnswer,
    answers: {
      ...craftedAnswer.answers,
      action: { type: "choice", choice: "none", confidence: 0.99 },
      move: { type: "choice", choice: "none", confidence: 0.99 },
      anchor: { type: "choice", choice: "none", confidence: 0.99 },
      direction: { type: "choice", choice: "none", confidence: 0.99 },
    },
  }),
}), { times: 1 });
const replacedExchange = jevExchange(page);
await page.locator("#text").fill("なんでもない");
await page.locator("#send").click();
await replacedExchange.request;
await settle(page);
const replaced = await screen(page);
assert.equal(replaced.state, "no-change");
assert.deepEqual(replaced.diagnostic, {
  diag: "jev-no-change",
  diagOutcome: "no-change",
  diagPlaceable: String(offeredAtDiag.length),
  diagPlaceOffered: "yes",
  diagAction: "none:0.99",
  diagMove: "none:0.99",
  diagAnchor: "none:0.99",
  diagDirection: "none:0.99",
  diagFrame: "ok",
}, "the whole set is replaced, never merged with the turn before");
assert.equal(Object.keys(replaced.diagnostic).length, Object.keys(diagnosed.diagnostic).length,
  "and the set stays bounded");

// (xvi-d) One-slot repair, in the real app. The first turn of each pair is the
// measured near-placement answered from the test - the real trigger depends on
// speech recognition and cannot be reproduced on demand. Where a second turn is
// marked real, Jev itself judges it, with the pending placement in the request.
const NEAR = {
  action: { type: "choice", choice: "place-part", confidence: 0.94 },
  move: { type: "choice", choice: moveId, confidence: 0.86 },
  anchor: { type: "choice", choice: anchorId, confidence: 0.39 },
  // Above the neighbour: earlier in this run the moved part was applied below
  // it, so below would rightly answer "already there".
  direction: { type: "choice", choice: "above", confidence: 0.97 },
};
const nearTurn = async (text = "一を濃度A の上に置いてください") => {
  const before = await screen(page);
  const near = await measuredTurn(NEAR, text);
  assert.equal(near.state, "no-change", "precondition: a near-placement");
  assert.equal(near.pending, "anchor", "precondition: the neighbour is held");
  assert.deepEqual(near.draft, before.draft, "precondition: nothing drafted");
  return near;
};
const replyTurn = answers => measuredTurn(answers, "補足");
const LOW = { type: "choice", choice: "none", confidence: 0.99 };
// A complete, confident placement of a different part onto a free spot on the
// pane, well away from where the held placement would go. Only parts wholly on
// the pane can be named (apps#19), so the parts and the side are chosen from
// what the pane shows now rather than assumed.
const repairCells = await boxes(page, "working");
const repairFrame = (await visibleFrame(page, "working")).frame;
const repairOnPane = onPane(repairCells, repairFrame);
const OTHER_PART = repairOnPane.find(id => id !== moveId && id !== anchorId);
assert.ok(OTHER_PART, `precondition: a third part is on the pane: ${JSON.stringify(repairOnPane)}`);
const heldSpot = (() => {
  const [ax, ay] = repairCells[anchorId].box;
  const [, , tw, th] = repairCells[moveId].box;
  return [ax, ay - th - gap, tw, th];
})();
const boxesMeet = (left, right) => left[0] < right[0] + right[2] && right[0] < left[0] + left[2]
  && left[1] < right[1] + right[3] && right[1] < left[1] + left[3];
const sideOf = (anchorBox, moverBox, side) => side === "left" ? [anchorBox[0] - moverBox[2] - gap, anchorBox[1], moverBox[2], moverBox[3]]
  : side === "right" ? [anchorBox[0] + anchorBox[2] + gap, anchorBox[1], moverBox[2], moverBox[3]]
  : side === "above" ? [anchorBox[0], anchorBox[1] - moverBox[3] - gap, moverBox[2], moverBox[3]]
  : [anchorBox[0], anchorBox[1] + anchorBox[3] + gap, moverBox[2], moverBox[3]];
const spotsFor = mover => repairOnPane.filter(id => id !== mover).flatMap(anchor =>
  ["below", "right", "left", "above"].map(side => ({ anchor, side, spot: sideOf(repairCells[anchor].box, repairCells[mover].box, side) })))
  .filter(({ spot }) => insideFrame(spot, repairFrame));
const occupiedBy = (spot, mover) => Object.entries(repairCells)
  .some(([id, cell]) => id !== "root" && id !== mover && cell.box !== null && boxesMeet(spot, cell.box));
const freeOther = spotsFor(OTHER_PART).find(({ spot }) => !occupiedBy(spot, OTHER_PART) && !boxesMeet(spot, heldSpot));
const takenOther = spotsFor(OTHER_PART).find(({ spot }) => occupiedBy(spot, OTHER_PART));
assert.ok(freeOther && takenOther, `precondition: ${OTHER_PART} has a free and a taken spot on the pane: `
  + JSON.stringify({ repairOnPane, repairFrame }));
const COMPLETE_OTHER = {
  action: { type: "choice", choice: "place-part", confidence: 0.95 },
  move: { type: "choice", choice: OTHER_PART, confidence: 0.95 },
  anchor: { type: "choice", choice: freeOther.anchor, confidence: 0.95 },
  direction: { type: "choice", choice: freeOther.side, confidence: 0.95 },
};
await dropPending();

// A blank input is not an utterance: no request, nothing spent.
await nearTurn();
const blankJev = countJev(page);
await page.locator("#text").fill("");
await page.locator("#send").click();
await settle(page);
blankJev.stop();
assert.equal(blankJev.count, 0, "a blank input sends nothing to Jev");
assert.equal((await screen(page)).pending, "anchor", "and leaves the held piece alone");

// Real Jev: the person names only the neighbour. Jev hears it with the pending
// placement in the request, and the placement is completed on 作業図 only.
const repairJev = jevExchange(page);
await page.locator("#text").fill(`相手は${anchorId}です`);
await page.locator("#send").click();
const repairRequest = JSON.parse((await repairJev.request).postData());
assert.equal((await repairJev.response).status(), 200);
await settle(page);
assert.equal(repairRequest.kind, "voice-ui.jev.request.v9");
assert.deepEqual(repairRequest.state.pending, { missing: "anchor", move: moveId, anchor: null, direction: "above" },
  "the request carries the held ids and side - never the first utterance's text");
assert.equal(JSON.stringify(repairRequest.state.pending).includes("一を濃度A"), false);
const repaired = await screen(page);
assert.equal(repaired.state, "drafted",
  `the real Jev reply must complete the placement: ${repaired.status} ${JSON.stringify(repaired.diagnostic)}`);
assert.equal(repaired.pending, null, "the one repair is spent");
assert.deepEqual(repaired.draft, [`~${moveId}`]);
assert.deepEqual({
  source: repaired.items[0].source,
  input: repaired.items[0].input,
  originSource: repaired.items[0].originSource,
  origin: repaired.items[0].origin,
}, { source: "typed", input: `相手は${anchorId}です`, originSource: "typed", origin: "一を濃度A の上に置いてください" },
"both utterances are shown with where each came from");
assert.match(repaired.items[0].effect, new RegExp(`配置 ${moveId} を ${anchorId} の上へ`, "u"));
const repairedBox = (await boxes(page, "working"))[moveId].box;
const [rax, ray] = drawnBefore[anchorId].box;
const [, , rtw, rth] = drawnBefore[moveId].box;
assert.deepEqual(repairedBox, [rax, ray - rth - gap, rtw, rth], "drawn above the neighbour, measured from the view");
const repairedPaint = await page.evaluate(regionId => {
  const surface = document.querySelector("#working-surface");
  const frame = surface.querySelector('iframe[data-package="semantic-map"]');
  const adapter = frame.contentWindow.semanticMapApp.adapter;
  const node = adapter.graph.getView().getState(adapter.cellsByRegionId.get(regionId))?.shape?.node;
  const rect = node?.getBoundingClientRect();
  const pane = frame.contentDocument.querySelector("#graph-container").getBoundingClientRect();
  if (!rect) return null;
  const w = Math.max(0, Math.min(rect.right, pane.right) - Math.max(rect.left, pane.left));
  const h = Math.max(0, Math.min(rect.bottom, pane.bottom) - Math.max(rect.top, pane.top));
  return { visible: w * h, whole: rect.width * rect.height };
}, moveId);
assert.ok(repairedPaint !== null && repairedPaint.whole > 0 && repairedPaint.visible >= repairedPaint.whole - 0.5,
  `the repaired part is wholly painted inside the pane: ${JSON.stringify(repairedPaint)}`);
assert.equal(repaired.stored, restated.stored, "確定図 and storage are untouched until Apply");
assert.equal(JSON.stringify(repaired.stored ?? "").includes("相手は"), false, "no utterance reaches storage");

// Undo takes the repaired step - and its two texts - away together.
await press(page, "#undo");
const undoneRepair = await screen(page);
assert.deepEqual(undoneRepair.draft, []);
assert.equal(undoneRepair.items.length, 0, "the shown texts leave with the step");

// A second failure spends the one repair: after it, a bare neighbour is no
// longer read as completing anything.
await nearTurn();
const failed = await replyTurn({ action: LOW, move: LOW, anchor: LOW, direction: LOW });
assert.equal(failed.state, "no-change");
assert.equal(failed.status, "type: no change - 足りなかった部分が聞き取れませんでした。指示全体をもう一度言ってください");
assert.equal(failed.pending, null, "a failed repair drops the held piece");
const afterSpent = await replyTurn({
  action: LOW, move: LOW, direction: LOW, anchor: { type: "choice", choice: anchorId, confidence: 0.95 },
});
assert.equal(afterSpent.state, "no-change", "nothing is held any more, so the bare neighbour completes nothing");
assert.deepEqual(afterSpent.draft, []);

// The repair reply names the moved part itself as the neighbour: a reasoned
// no change, not a failure.
await nearTurn();
const selfRepair = await replyTurn({
  action: LOW, move: LOW, direction: LOW, anchor: { type: "choice", choice: moveId, confidence: 0.95 },
});
assert.equal(selfRepair.state, "no-change");
assert.equal(selfRepair.status, "type: no change - 同じ部品の隣には置けません。指示全体をもう一度言ってください");
assert.equal(selfRepair.pending, null);

// The held piece belongs to the exact picture it was said against. The window
// narrows a little between hold and reply - every part still on the pane, only
// the frame different - and the reply goes to the real Jev through the real
// server. It must not carry the held piece, must pass the server's own request
// check (200, never 422), and must come back as an explicit no-change that
// says why, with the piece spent.
await nearTurn();
const heldViewport = page.viewportSize();
const frameHeld = (await visibleFrame(page, "working")).frame;
await page.setViewportSize({ width: heldViewport.width - 60, height: heldViewport.height });
let frameMoved = null;
for (let attempt = 0; attempt < 40 && frameMoved === null; attempt += 1) {
  const current = await visibleFrame(page, "working");
  if (current !== null && JSON.stringify(current.frame) !== JSON.stringify(frameHeld)) frameMoved = current.frame;
  else await page.waitForTimeout(100);
}
assert.notEqual(frameMoved, null, `precondition: the pane's frame changed from ${JSON.stringify(frameHeld)}`);
const failedBeforeMoved = failedResponses.length;
const movedJev = jevExchange(page);
await page.locator("#text").fill(`相手は${anchorId}です`);
await page.locator("#send").click();
const movedRequest = JSON.parse((await movedJev.request).postData());
const movedResponse = await movedJev.response;
await settle(page);
assert.equal(movedRequest.kind, "voice-ui.jev.request.v9");
assert.equal(movedRequest.state.pending, null, "a held piece from another picture is never sent");
assert.equal(movedResponse.status(), 200, "the request passes the server's check - no 422");
assert.equal((await movedResponse.json()).model === "jev-test", false, "answered by the real Jev");
const movedReply = await screen(page);
assert.equal(movedReply.state, "no-change", `an explicit no-change, not a failure: ${movedReply.status}`);
assert.equal(movedReply.status, "type: no change - 図が変わったので補えませんでした。指示全体をもう一度言ってください");
assert.equal(movedReply.pending, null, "the held piece is spent");
assert.deepEqual(movedReply.draft, [], "nothing was drafted");
assert.equal(failedResponses.length, failedBeforeMoved, "and no failed response");
await page.setViewportSize(heldViewport);
for (let attempt = 0; attempt < 40; attempt += 1) {
  const current = await visibleFrame(page, "working");
  if (current !== null && JSON.stringify(current.frame) === JSON.stringify(frameHeld)) break;
  await page.waitForTimeout(100);
}
assert.deepEqual((await visibleFrame(page, "working")).frame, frameHeld, "the pane is back to the held frame");

// An unrelated complete instruction wins, and is judged as itself.
await nearTurn();
const other = await replyTurn(COMPLETE_OTHER);
assert.equal(other.state, "drafted", `a complete instruction is judged as itself: ${other.status}`);
assert.equal(other.pending, null);
assert.deepEqual(other.draft, [`~${OTHER_PART}`], "it moved what it named, not the held part");
assert.equal(other.items[0].origin, null, "and shows only its own text");

// R's RED on 15cf4ba: an unrelated complete instruction that is itself blocked
// was mined for the missing piece and proposed a placement nobody asked for.
// Now it gets its own answer and the draft does not move.
await nearTurn();
const draftBeforeBlocked = (await screen(page)).draft;
const blocked = await replyTurn({
  action: { type: "choice", choice: "place-part", confidence: 0.93 },
  move: { type: "choice", choice: OTHER_PART, confidence: 0.92 },
  anchor: { type: "choice", choice: takenOther.anchor, confidence: 0.92 },
  direction: { type: "choice", choice: takenOther.side, confidence: 0.92 },
});
assert.equal(blocked.state, "no-change", `a blocked complete instruction is its own no change: ${blocked.status}`);
assert.match(blocked.status, /別の部品があります/u, "with its own reason");
assert.deepEqual(blocked.draft, draftBeforeBlocked, "no placement is proposed on 作業図");
assert.equal(blocked.pending, null, "and the held piece is spent");

await nearTurn();
const unrelatedSelf = await replyTurn({
  action: { type: "choice", choice: "place-part", confidence: 0.95 },
  move: { type: "choice", choice: OTHER_PART, confidence: 0.95 },
  anchor: { type: "choice", choice: OTHER_PART, confidence: 0.95 },
  direction: { type: "choice", choice: "below", confidence: 0.95 },
});
assert.equal(unrelatedSelf.state, "failed", "a different part beside itself keeps its v7 refusal");
assert.deepEqual(unrelatedSelf.draft, draftBeforeBlocked, "no placement is proposed on 作業図");
assert.equal(unrelatedSelf.pending, null);

// R's finding on d58ebb4: the repair turn's own answer is a new near-placement.
// Nothing is held after a repair turn, so it must not invite one word - it asks
// for the whole instruction, and the bare name that follows completes nothing.
await nearTurn();
const newNearInRepair = await replyTurn({
  action: { type: "choice", choice: "place-part", confidence: 0.93 },
  move: { type: "choice", choice: OTHER_PART, confidence: 0.92 },
  anchor: { type: "choice", choice: anchorId, confidence: 0.3 },
  direction: { type: "choice", choice: "right", confidence: 0.92 },
});
assert.equal(newNearInRepair.state, "no-change");
assert.equal(newNearInRepair.status,
  "type: no change - 配置の指示を聞き取れませんでした。動かす部品・隣の部品・方向をそろえて、もう一度言ってください",
  "the whole instruction, never a one-word follow-up that cannot be kept");
assert.equal(newNearInRepair.pending, null, "nothing is held after a repair turn");
assert.deepEqual(newNearInRepair.draft, draftBeforeBlocked);
const bareAfterRepair = await replyTurn({
  action: LOW, move: LOW, direction: LOW, anchor: { type: "choice", choice: anchorId, confidence: 0.95 },
});
assert.equal(bareAfterRepair.state, "no-change", "the bare name completes nothing");
assert.deepEqual(bareAfterRepair.draft, draftBeforeBlocked, "作業図 is unchanged");
assert.equal(bareAfterRepair.pending, null);

// Undo, Discard, Apply and Revert each drop a held piece; so does a reload.
await nearTurn();
await press(page, "#undo");
assert.equal((await screen(page)).pending, null, "Undo drops it");

await replyTurn(COMPLETE_OTHER);
await nearTurn();
await press(page, "#discard");
assert.equal((await screen(page)).pending, null, "Discard drops it");

await replyTurn(COMPLETE_OTHER);
await nearTurn();
await press(page, "#apply");
const appliedWithHeld = await screen(page);
assert.equal(appliedWithHeld.state, "applied");
assert.equal(appliedWithHeld.pending, null, "Apply drops it");

await nearTurn();
const lastEntry = appliedWithHeld.confirmed.length - 1;
await page.locator(`button[data-revert="${lastEntry}"]`).click();
await settle(page);
assert.equal((await screen(page)).pending, null, "Revert drops it");
await press(page, "#discard");

await nearTurn();
await page.reload({ waitUntil: "commit" });
await ready(page);
assert.equal((await screen(page)).pending, null, "a reload drops it");

// A provider timeout after the request still spends the one repair.
await nearTurn();
await page.route(jevUrl, route => route.fulfill({
  status: 504,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({ error: "provider_timeout" }),
}), { times: 1 });
const timeoutRepair = jevExchange(page);
await page.locator("#text").fill(`相手は${anchorId}です`);
await page.locator("#send").click();
await timeoutRepair.request;
await settle(page);
// The utterance was sent to Jev, so the held piece is spent. What failed is the
// provider, and it is reported as that - not as a verdict on what was said.
const timedOut = await screen(page);
assert.equal(timedOut.state, "failed");
assert.equal(timedOut.status, "type: failed", "a transport failure, not a repair no-change");
assert.match(timedOut.failure ?? "", /provider_timeout/u, "naming the provider timeout");
assert.equal(/聞き取れませんでした|補えませんでした/u.test(`${timedOut.status} ${timedOut.failure}`), false,
  "and never dressed up as a repair reason");
assert.equal(timedOut.pending, null, "a timed-out repair is spent all the same");
assert.deepEqual(failedResponses.splice(0), [`504 ${jevUrl}`], "the only failed response is the one crafted here");

// A voice first utterance and a typed reply. The microphone press is real - the
// fixture audio through the real recognizer - and only its Jev answer is
// crafted as the near-placement; the typed reply's answer is crafted too.
await page.route(jevUrl, route => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({ ...craftedAnswer, answers: { ...craftedAnswer.answers, ...NEAR } }),
}), { times: 1 });
const spokenNear = await speak(page);
const heardText = spokenNear.sent.state.utterance;
assert.equal((await screen(page)).pending, "anchor", "a spoken near-placement is held the same way");
const pairTurn = await replyTurn({
  action: LOW, move: LOW, direction: LOW, anchor: { type: "choice", choice: anchorId, confidence: 0.95 },
});
assert.equal(pairTurn.state, "drafted", `the typed reply completes the spoken placement: ${pairTurn.status}`);
assert.deepEqual({
  source: pairTurn.items[0].source,
  input: pairTurn.items[0].input,
  originSource: pairTurn.items[0].originSource,
  origin: pairTurn.items[0].origin,
}, { source: "typed", input: "補足", originSource: "voice", origin: heardText },
"the spoken text is labelled as recognized, the typed one as typed");
assert.equal(pairTurn.items[0].elements, 0, "both texts are set as text only");
await press(page, "#discard");

// (xvi-e) The other two things the pane can say, each produced for real while one
// answer is held: a pane that cannot be read, and a pane still showing another
// head. Both are no-changes with their own sentences, and the diagnostic names
// them - which is what attributes a refused real-microphone turn later.
// A confident placement of two parts the held request itself offered, so it is
// judged rather than refused whatever earlier sections left on the pane.
const confidentPlace = sent => {
  const offered = sent.state.working.placeable;
  assert.ok(offered.length >= 2, `precondition: placement is offered: ${JSON.stringify(offered)}`);
  return {
    action: { type: "choice", choice: "place-part", confidence: 0.95 },
    source: { type: "choice", choice: "none", confidence: 0.9 },
    target: { type: "choice", choice: "none", confidence: 0.9 },
    part: { type: "choice", choice: "none", confidence: 0.9 },
    move: { type: "choice", choice: offered[0], confidence: 0.95 },
    anchor: { type: "choice", choice: offered[1], confidence: 0.95 },
    direction: { type: "choice", choice: "left", confidence: 0.95 },
    ...(sent.state.working.edges.length > 0 ? { edge: { type: "choice", choice: "none", confidence: 0.9 } } : {}),
    diagram: { type: "choice", choice: "none", confidence: 0.9 },
  };
};
const heldTurn = async (text, whileHeld, undo) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(jevUrl, async route => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ ...craftedAnswer, answers: confidentPlace(JSON.parse(route.request().postData())) }),
    });
  }, { times: 1 });
  const exchange = jevExchange(page);
  await page.locator("#text").fill(text);
  await page.locator("#send").click();
  await exchange.request;
  await whileHeld();
  release();
  await exchange.response;
  await settle(page);
  const result = await screen(page);
  await undo();
  return result;
};
const workingBeforeHeld = await boxes(page, "working");
// What is saved as this section starts: the one-slot section before it applies.
const storedBeforeHeld = (await screen(page)).stored;

const unreadable = await heldTurn("この部品を左へ", () => page.evaluate(() => {
  document.querySelector("#working-surface").style.display = "none";
}), async () => {
  await page.evaluate(() => { document.querySelector("#working-surface").style.display = ""; });
  await page.waitForFunction(async () => {
    const runtime = await import("/ui/semantic-map/runtime.js");
    return runtime.visibleFrameOf(document.querySelector("#working-surface")) !== null;
  });
});
assert.equal(unreadable.state, "no-change", "a pane that cannot be read places nothing");
assert.match(unreadable.status, /読み取れない/u);
assert.equal(unreadable.diagnostic.diagFrame, "null", "and the diagnostic says the frame was null");
assert.deepEqual(unreadable.draft, [], "nothing was drafted");
assert.equal(unreadable.stored, storedBeforeHeld);

const otherHead = await heldTurn("その部品を左へ", () => page.evaluate(() => {
  const runtime = document.querySelector('#working-surface iframe[data-package="semantic-map"]')
    .contentWindow.semanticMapSite.runtime;
  window.heldHead = Object.getOwnPropertyDescriptor(runtime, "head");
  Object.defineProperty(runtime, "head", { ...window.heldHead, value: "sha256:another-head" });
}), () => page.evaluate(() => {
  const runtime = document.querySelector('#working-surface iframe[data-package="semantic-map"]')
    .contentWindow.semanticMapSite.runtime;
  Object.defineProperty(runtime, "head", window.heldHead);
  delete window.heldHead;
}));
assert.equal(otherHead.state, "no-change", "a pane still showing another head places nothing");
assert.match(otherHead.status, /追いついていない/u);
assert.equal(otherHead.diagnostic.diagFrame, "head-mismatch", "and the diagnostic says the heads differed");
assert.deepEqual(otherHead.draft, [], "nothing was drafted");
assert.equal(otherHead.stored, storedBeforeHeld);
assert.notEqual(unreadable.status, otherHead.status, "two conditions, two sentences");
assert.deepEqual(await boxes(page, "working"), workingBeforeHeld, "neither turn moved anything");

// A diagnostic describes the last turn Jev judged. Any control that changes
// what is on screen - or the conversation - removes it, so a later reading can
// never pin an old turn on a new screen.
const noChangeTurn = async text => {
  await page.route(jevUrl, route => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      ...craftedAnswer,
      answers: {
        ...craftedAnswer.answers,
        action: { type: "choice", choice: "none", confidence: 0.99 },
        move: { type: "choice", choice: "none", confidence: 0.99 },
        anchor: { type: "choice", choice: "none", confidence: 0.99 },
        direction: { type: "choice", choice: "none", confidence: 0.99 },
      },
    }),
  }), { times: 1 });
  const exchange = jevExchange(page);
  await page.locator("#text").fill(text);
  await page.locator("#send").click();
  await exchange.response;
  await settle(page);
  assert.equal((await screen(page)).diagnostic.diag, "jev-no-change", `precondition: ${text} left a diagnostic`);
};
const partStep = async text => {
  await page.route(jevUrl, route => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      ...craftedAnswer,
      answers: {
        ...craftedAnswer.answers,
        action: { type: "choice", choice: "add-part", confidence: 0.95 },
        part: { type: "choice", choice: "decision", confidence: 0.95 },
        move: { type: "choice", choice: "none", confidence: 0.9 },
        anchor: { type: "choice", choice: "none", confidence: 0.9 },
        direction: { type: "choice", choice: "none", confidence: 0.9 },
      },
    }),
  }), { times: 1 });
  const exchange = jevExchange(page);
  await page.locator("#text").fill(text);
  await page.locator("#send").click();
  await exchange.response;
  await settle(page);
  assert.equal((await screen(page)).state, "drafted", `precondition: ${text} drafted a part`);
};
const clearedBy = {};
await partStep("add a part to undo");
await noChangeTurn("nothing for undo");
await press(page, "#undo");
clearedBy.undo = (await screen(page)).diagnostic;
await partStep("add a part to discard");
await noChangeTurn("nothing for discard");
await press(page, "#discard");
clearedBy.discard = (await screen(page)).diagnostic;
await partStep("add a part to apply");
await noChangeTurn("nothing for apply");
await press(page, "#apply");
const appliedForRevert = await screen(page);
clearedBy.apply = appliedForRevert.diagnostic;
await noChangeTurn("nothing for revert");
await page.locator(`button[data-revert="${appliedForRevert.confirmed.length - 1}"]`).click();
await settle(page);
clearedBy.revert = (await screen(page)).diagnostic;
await press(page, "#discard");
await noChangeTurn("nothing for clearing the conversation");
await page.locator("#context-clear").click();
clearedBy.contextClear = (await screen(page)).diagnostic;
assert.deepEqual(clearedBy, { undo: {}, discard: {}, apply: {}, revert: {}, contextClear: {} },
  "Undo, Discard, Apply, Revert and 会話をクリア each remove the previous turn's diagnostic");
assert.deepEqual((await screen(page)).draft, [], "and the graph is back to what was applied");

// (xvi-f) R's counterexample (D): more parts than the pane shows. The layout
// contract keeps bounds for every part, on screen or not, and the renderer
// builds cells in a margin band nobody sees - so neither can say what a person
// could name. Every answer here is crafted from the request it answers
// (craftFor), so the geometry, not Jev's hearing, decides the outcome.
const tallBefore = await screen(page);
assert.deepEqual(tallBefore.draft, [], "precondition: nothing unapplied");

// Grow 作業図 by crafted parts. Each drawing fits the camera to the whole
// working graph, so growth alone never pushes a part off the pane - that is
// asserted, not assumed. The camera does not follow a later resize, though,
// so a shorter window afterwards really does leave parts outside the frame:
// that is the pane this guard is about.
const addDecision = { action: { type: "choice", choice: "add-part", confidence: 0.95 },
  part: { type: "choice", choice: "decision", confidence: 0.95 } };
for (let index = 0; index < 4; index += 1) {
  await page.route(jevUrl, answerFrom(addDecision), { times: 1 });
  await type(page, `add decision number ${index + 1} to the tall graph`);
  assert.equal((await screen(page)).state, "drafted", "each crafted part is one working step");
  const cells = await boxes(page, "working");
  const frameNow = (await visibleFrame(page, "working")).frame;
  const cutOff = Object.keys(cells).filter(id => id !== "root" && !insideFrame(cells[id].box, frameNow));
  assert.deepEqual(cutOff, [], `a drawing fits the whole working graph, so no part is off the pane: ${JSON.stringify({ cutOff, frameNow })}`);
}
const tallFrom = page.viewportSize();
let tall = null;
for (const height of [600, 520, 440, 380, 320]) {
  if (tall !== null) break;
  await page.setViewportSize({ width: tallFrom.width, height });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cells = await boxes(page, "working");
  const frameNow = (await visibleFrame(page, "working")).frame;
  const cutOff = Object.keys(cells).filter(id => id !== "root" && !insideFrame(cells[id].box, frameNow));
  if (cutOff.length > 0) tall = { cells, frame: frameNow, height };
}
assert.notEqual(tall, null, "precondition: a shorter window leaves some parts past the pane");

// The offer. The request is built from the frame read as it is sent: exactly
// the parts wholly inside it, whatever the layout contract or the cells say.
await page.route(jevUrl, answerFrom({ action: { type: "choice", choice: "none", confidence: 0.99 } }), { times: 1 });
const frameAsked = (await visibleFrame(page, "working")).frame;
const cellsAsked = await boxes(page, "working");
const askedTall = await type(page, "which parts can I see now");
const offeredTall = [...askedTall.sent.state.working.placeable].sort();
assert.deepEqual(offeredTall, onPane(cellsAsked, frameAsked),
  "Jev is offered exactly the parts wholly on the pane");
const allParts = askedTall.sent.state.working.regions;
const notOffered = allParts.filter(id => !offeredTall.includes(id));
assert.ok(notOffered.length > 0, `some parts are off the pane and not offered: ${JSON.stringify({ allParts, offeredTall })}`);
const inMarginBand = notOffered.filter(id => cellsAsked[id]?.rendered === true);
assert.ok(inMarginBand.length > 0,
  `a part with a live cell - built in the margin band - is still not offered: ${JSON.stringify(notOffered)}`);

// The judgement. One request is held; while it is out the pane narrows, so a
// part that was wholly on it when Jev was asked is cut off by the time the
// answer lands. The spot beside it stays on the pane.
const narrowFrom = page.viewportSize();
let releaseNarrow;
const narrowAnswer = new Promise(resolve => { releaseNarrow = resolve; });
await page.route(jevUrl, async route => {
  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(craftFor(JSON.parse(route.request().postData()), await narrowAnswer)),
  });
}, { times: 1 });
const narrowExchange = jevExchange(page);
await page.locator("#text").fill("put that one beside the other");
await page.locator("#send").click();
const narrowSent = JSON.parse((await narrowExchange.request).postData());
const narrowOffered = narrowSent.state.working.placeable;
const cellsWide = await boxes(page, "working");
const frameWide = (await visibleFrame(page, "working")).frame;
const mountWide = (await mountWidths(page)).working;
await page.setViewportSize({ width: 700, height: narrowFrom.height });
await page.waitForFunction(width => {
  const mount = document.querySelector("#working-surface");
  return mount !== null && mount.getBoundingClientRect().width < width;
}, mountWide);
let frameNarrow = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const current = await visibleFrame(page, "working");
  if (current !== null && current.frame[2] < frameWide[2]) {
    frameNarrow = current.frame;
    break;
  }
  await page.waitForTimeout(100);
}
assert.notEqual(frameNarrow, null, `the narrowed pane reports a narrower frame than ${JSON.stringify(frameWide)}`);
const beside = (anchorBox, moverBox, side) => side === "left" ? [anchorBox[0] - moverBox[2] - gap, anchorBox[1], moverBox[2], moverBox[3]]
  : side === "right" ? [anchorBox[0] + anchorBox[2] + gap, anchorBox[1], moverBox[2], moverBox[3]]
  : side === "above" ? [anchorBox[0], anchorBox[1] - moverBox[3] - gap, moverBox[2], moverBox[3]]
  : [anchorBox[0], anchorBox[1] + anchorBox[3] + gap, moverBox[2], moverBox[3]];
const overlapsAny = (box, except) => Object.entries(cellsWide).some(([id, cell]) =>
  id !== "root" && id !== except && cell.box !== null
  && box[0] < cell.box[0] + cell.box[2] && cell.box[0] < box[0] + box[2]
  && box[1] < cell.box[1] + cell.box[3] && cell.box[1] < box[1] + box[3]);
let cutAnchor = null;
for (const anchor of narrowOffered) {
  for (const mover of narrowOffered) {
    for (const side of ["left", "right", "above", "below"]) {
      if (cutAnchor !== null || mover === anchor) continue;
      const spot = beside(cellsWide[anchor].box, cellsWide[mover].box, side);
      if (insideFrame(spot, frameWide) && insideFrame(spot, frameNarrow)
        && insideFrame(cellsWide[anchor].box, frameWide) && !insideFrame(cellsWide[anchor].box, frameNarrow)
        && !overlapsAny(spot, mover)) {
        cutAnchor = { anchor, mover, side, spot };
      }
    }
  }
}
assert.notEqual(cutAnchor, null,
  `precondition: some offered anchor is cut off by the narrower pane while a free spot beside it stays on it: `
  + JSON.stringify({ narrowOffered, frameWide, frameNarrow }));
const placeCut = {
  action: { type: "choice", choice: "place-part", confidence: 0.95 },
  move: { type: "choice", choice: cutAnchor.mover, confidence: 0.95 },
  anchor: { type: "choice", choice: cutAnchor.anchor, confidence: 0.95 },
  direction: { type: "choice", choice: cutAnchor.side, confidence: 0.95 },
};
const draftBeforeCut = (await screen(page)).draft;
releaseNarrow(placeCut);
await narrowExchange.response;
await settle(page);
const cutScreen = await screen(page);
assert.equal(cutScreen.state, "no-change", "an anchor the pane no longer shows places nothing");
assert.match(cutScreen.status, /基準の部品が今の表示の外/u, "and it says the anchor is off the pane");
assert.deepEqual(cutScreen.draft, draftBeforeCut, "the draft is untouched");
// The narrow pane culls some cells, so which cells exist differs; where each
// remaining one is drawn does not.
for (const [id, cell] of Object.entries(await boxes(page, "working"))) {
  assert.deepEqual(cell.box, cellsWide[id]?.box, `${id} did not move`);
}

// The same answer at the width it was asked at is a step: only the pane differs.
await page.setViewportSize(narrowFrom);
let frameBack = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const current = await visibleFrame(page, "working");
  if (current !== null && JSON.stringify(current.frame) === JSON.stringify(frameWide)) {
    frameBack = current.frame;
    break;
  }
  await page.waitForTimeout(100);
}
assert.notEqual(frameBack, null, "the pane returns to the frame the request was asked from");
// The renderer rebuilds culled cells on its next render, not on a resize, so
// only the positions of the cells it has are compared.
for (const [id, cell] of Object.entries(await boxes(page, "working"))) {
  assert.deepEqual(cell.box, cellsWide[id]?.box, `${id} is where it was when the request was asked`);
}
await page.route(jevUrl, answerFrom(placeCut), { times: 1 });
await type(page, "put that one beside the other again");
const wideScreen = await screen(page);
assert.equal(wideScreen.state, "drafted", `with the anchor on the pane it is a placement: ${wideScreen.status}`);
assert.deepEqual(wideScreen.draft.at(-1), `~${cutAnchor.mover}`);
assert.deepEqual((await boxes(page, "working"))[cutAnchor.mover].box, cutAnchor.spot, "drawn exactly beside it");
const tallGuard = `every drawing fit the growing graph; a ${tall.height} px window then left parts off the pane - `
  + `${offeredTall.length} of ${allParts.length} parts offered; `
  + `${cutAnchor.mover} ${cutAnchor.side} of ${cutAnchor.anchor} refused once the pane cut the anchor off, placed once it did not`;

await press(page, "#discard");
const tallAfter = await screen(page);
assert.deepEqual(tallAfter.draft, [], "Discard clears the tall graph's steps");
assert.equal(tallAfter.stored, tallBefore.stored, "and nothing from them was ever saved");

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
assert.equal(heard.sent.kind, "voice-ui.jev.request.v9");
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

fullRunSummary = {
  head: `spoken add "${voiceAdd.sent.state.utterance}" -> 作業図 only, applied edge=${voiceEdge} `
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
    + `| one-slot repair: real Jev completed "相手は${anchorId}です" into ${moveId} above ${anchorId}, `
    + "both texts shown with their sources, blank not spent, failure/self/unrelated/timeout each drop it, "
    + "Undo/Discard/Apply/Revert/reload each drop it; a held piece is dropped once the pane changes "
    + "| diagnostic: frame ok, null (pane hidden) and head-mismatch (pane on another head) each named on a held turn; "
    + "cleared by Undo, Discard, Apply, Revert and 会話をクリア "
    + `| tall graph: ${tallGuard} `,
  tail: `| refused microphone: [${voicePhases(refusalTrace).map(entry => entry.kind).join(" ")}], 0 Jev requests, nothing changed, controls given back `
    + `| embedded Accept [${embeddedAccepts.join("; ")}] / [${correctionAccepts.join("; ")}] `
    + `| corrupt and foreign logs fail closed | typed ${edgeA}, ${edgeB}: 2 undos, then 2-step apply `
    + `| empty input (0 Jev requests), undo-request and none change nothing | relation revert applied, overtaken revert refused `
    + `| controls locked while a request is in flight, answer on its own revision (${heldEdge}) `
    + `| unanswered request failed at ${hangMs} ms, late answer dropped, 504 provider_timeout reported, `
    + "controls given back and nothing changed, both retries answered "
    + `| cap 8 with 0 Jev requests at the cap | quota and other-tab Apply refused, working steps kept | reload drops the working steps `
    + `| saved-but-undrawn blocks, reload draws it | browser 2: typed ${typedEdge}, then spoken "${heard.sent.state.utterance}" `
    + "-> reverse of the focused step, applied with it, restored after reload\n",
};
}

// (xix) A whole diagram by purpose. A fresh browser, so the proof starts from
// the genesis graph and empty storage. Every Jev answer in this section is the
// real Jev's. The diagram's roles, steps, labels and links are the app's; Jev
// only chooses a candidate key, or none.
const third = await openBrowser(wav);
page = third.page;
await page.goto(url, { waitUntil: "commit", timeout: 120000 });
await ready(page);
const diagramStart = await screen(page);
assert.deepEqual(diagramStart.draft, [], "precondition: a fresh page with nothing unapplied");
const confirmedStart = await boxes(page, "confirmed");
// The page's own notice of parts that 作業図 holds but does not show whole.
const outOfViewNotice = target => target.evaluate(() => {
  const notice = document.querySelector("#out-of-view");
  return { parts: notice.dataset.parts ?? null, text: notice.textContent };
});
assert.deepEqual(await outOfViewNotice(page), { parts: "", text: "" }, "the genesis graph fits the pane, and nothing is said");
assert.deepEqual(page.viewportSize(), { width: 1280, height: 720 }, "the named viewport for what follows");

// The first screen, never scrolled: where both graphs start, and whether each
// thing the person needs next - the input, Send, Voice, the status, both
// notices and Undo/Discard/Apply - is what a click at its centre reaches,
// inside the window.
const FIRST_SCREEN = ["#text", "#send", "#mic", "#status", "#working-notice", "#out-of-view", "#undo", "#discard", "#apply"];
const firstScreen = target => target.evaluate(selectors => ({
  scrollY: window.scrollY,
  tops: ["confirmed", "working"].map(pane => document.querySelector(`#${pane}-surface`).getBoundingClientRect().top),
  widths: ["confirmed", "working"].map(pane => document.querySelector(`#${pane}-surface`).getBoundingClientRect().width),
  unreachable: selectors.filter(selector => {
    const element = document.querySelector(selector);
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (rect.width === 0 || rect.height === 0 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    return !(hit === element || element.contains(hit));
  }),
}), FIRST_SCREEN);
const screenStart = await firstScreen(page);
assert.equal(screenStart.scrollY, 0);
assert.deepEqual(screenStart.unreachable, [], `on the first screen: ${JSON.stringify(screenStart)}`);
assert.equal(screenStart.tops[0], screenStart.tops[1], "both graphs start at the same height");
assert.equal(screenStart.widths[0], screenStart.widths[1], "and are the same width");
// Still the first screen, the graphs where they were, and nothing scrolled.
const assertFirstScreen = async when => {
  const now = await firstScreen(page);
  assert.equal(now.scrollY, 0, `${when}: the page was not scrolled`);
  assert.deepEqual(now.tops, screenStart.tops, `${when}: neither graph moved: ${JSON.stringify(now)}`);
  assert.deepEqual(now.widths, screenStart.widths, `${when}: the panes stay equal`);
  assert.deepEqual(now.unreachable, [], `${when}: the input, buttons and notices stay reachable: ${JSON.stringify(now)}`);
  return now;
};

// Edges as the working or confirmed pane draws them: endpoints, whether the
// view draws them as directed, the arrowhead, and whether the shape is live.
const drawnEdges = (target, pane) => target.evaluate(pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  const adapter = frame.contentWindow.semanticMapApp.adapter;
  const view = adapter.graph.getView();
  return [...adapter.edgesByProjectionKey.values()].map(edge => ({
    from: edge.semantic.from,
    to: edge.semantic.to,
    directed: edge.semantic.directed === true,
    endArrow: view.getState(edge)?.style?.endArrow ?? null,
    rendered: Boolean(view.getState(edge)?.shape?.node?.isConnected),
  }));
}, pane);

// A kind of diagram the app does not have.
const aws = await type(page, "AWS の構成図を作って");
assert.equal(aws.sent.kind, "voice-ui.jev.request.v9");
assert.deepEqual(aws.sent.state.candidates.map(candidate => candidate.key), ["request-approval-flow"],
  "the page offers its diagrams by key and purpose");
assert.equal(JSON.stringify(aws.sent).includes("申請者"), false, "and never their contents");
assert.notEqual(aws.decision.model, "jev-test", "answered by the real Jev");
assert.notEqual(aws.decision.answers.diagram.choice, "request-approval-flow",
  `the real Jev must not pass an AWS diagram off as the approval flow: ${JSON.stringify(aws.decision.answers)}`);
const awsScreen = await screen(page);
assert.equal(awsScreen.state, "no-change", `an unsupported diagram changes nothing: ${awsScreen.status}`);
assert.deepEqual(awsScreen.draft, []);
assert.equal(awsScreen.stored, diagramStart.stored);

// The purpose-level request: no part, side or link is named.
const asked = await type(page, "申請して承認してもらう流れを図にして");
assert.notEqual(asked.decision.model, "jev-test", "answered by the real Jev");
assert.equal(asked.decision.answers.action.choice, "compose-diagram",
  `the real Jev must hear a whole diagram: ${JSON.stringify(asked.decision.answers)}`);
assert.equal(asked.decision.answers.diagram.choice, "request-approval-flow");
const diagramDrafted = await screen(page);
assert.equal(diagramDrafted.state, "drafted", `the diagram is drafted: ${diagramDrafted.status}`);
assert.equal(diagramDrafted.draft.length, 1, "the whole diagram is one step");
assert.match(diagramDrafted.items[0].effect, /^図の提案「申請と承認の流れ」/u);
const composedRegions = [...diagramDrafted.draft[0].matchAll(/\+(part-\d+)「([^」]+)」/gu)].map(match => match[1]);
const composedLinks = [...diagramDrafted.draft[0].matchAll(/\+(part-\d+)->(part-\d+)/gu)].map(match => `${match[1]}->${match[2]}`);
assert.equal(diagramDrafted.draft[0].includes(" -"), false, "the diagram only adds; nothing already there is removed");
assert.equal(composedRegions.length, 5);
const [laneA, laneB, stepSubmit, stepReview, stepReceive] = composedRegions;
assert.deepEqual(composedLinks, [`${stepSubmit}->${stepReview}`, `${stepReview}->${stepReceive}`]);

// What the pane actually draws: each lane and each step has a live cell, each
// step inside its role's lane, all wholly inside the visible frame.
const diagramCells = await boxes(page, "working");
const diagramFrame = (await visibleFrame(page, "working")).frame;
for (const id of composedRegions) {
  assert.ok(diagramCells[id], `${id} has a cell`);
  assert.equal(diagramCells[id].rendered, true, `${id} is drawn`);
  assert.ok(insideFrame(diagramCells[id].box, diagramFrame), `${id} is wholly on the pane: ${JSON.stringify({ box: diagramCells[id].box, frame: diagramFrame })}`);
}
for (const [stepId, laneId] of [[stepSubmit, laneA], [stepReview, laneB], [stepReceive, laneA]]) {
  assert.ok(insideFrame(diagramCells[stepId].box, diagramCells[laneId].box), `${stepId} is drawn inside lane ${laneId}`);
}
const diagramEdges = await drawnEdges(page, "working");
for (const link of composedLinks) {
  const [from, to] = link.split("->");
  const drawn = diagramEdges.find(edge => edge.from === from && edge.to === to);
  assert.ok(drawn, `${link} is drawn`);
  assert.equal(drawn.directed, true, `${link} is directed`);
  assert.equal(drawn.endArrow, "classic", `${link} has an arrowhead at ${to}`);
  assert.equal(drawn.rendered, true, `${link} is painted`);
}
// The shape of a cross-functional flow, measured from the drawn cells: the two
// lanes are bands one above the other - disjoint in y, overlapping in x - and
// the steps run left to right in flow order.
const bandsDrawn = (cells, lanes, steps) => {
  const [boxA, boxB] = lanes.map(id => cells[id].box);
  const xs = steps.map(id => cells[id].box[0]);
  return {
    bands: boxA[1] + boxA[3] <= boxB[1] && boxA[0] < boxB[0] + boxB[2] && boxB[0] < boxA[0] + boxA[2],
    flow: xs[0] < xs[1] && xs[1] < xs[2],
    lanes: [boxA, boxB],
    xs,
  };
};
const diagramBands = bandsDrawn(diagramCells, [laneA, laneB], [stepSubmit, stepReview, stepReceive]);
assert.ok(diagramBands.bands, `the lanes are drawn as bands one above the other: ${JSON.stringify(diagramBands.lanes)}`);
assert.ok(diagramBands.flow, `the steps are drawn left to right in flow order: ${JSON.stringify(diagramBands.xs)}`);
const laneLayout = `bands one above the other ${JSON.stringify(diagramBands.lanes)}, steps at x ${diagramBands.xs.join(" < ")}`;
// Both panes are the pinned provider's chrome-free presentation, and show the
// same frame: 確定図 was drawn again at the frame the grown working graph needs.
assert.deepEqual(await presentations(page), { confirmed: CHROME_FREE, working: CHROME_FREE });
const framesComposed = await bothFrames(page);
assert.deepEqual(framesComposed.confirmed, framesComposed.working,
  `both panes show the same frame after the diagram: ${JSON.stringify(framesComposed)}`);
const genesisOnPane = ["node-a", "node-b", "node-c"].filter(id => diagramCells[id] && insideFrame(diagramCells[id].box, diagramFrame));
// Whether each step's own shape is what a click at its centre reaches, or the
// embed's own controls cover it.
const stepCovered = await page.evaluate(ids => {
  const frame = document.querySelector('#working-surface iframe[data-package="semantic-map"]');
  const adapter = frame.contentWindow.semanticMapApp.adapter;
  const view = adapter.graph.getView();
  return ids.filter(id => {
    const node = view.getState(adapter.cellsByRegionId.get(id))?.shape?.node;
    const rect = node.getBoundingClientRect();
    const hit = frame.contentDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !(hit && (node.contains(hit) || hit.closest?.("svg") === node.ownerSVGElement));
  });
}, [stepSubmit, stepReview, stepReceive]);
// Nothing reached 確定図 or storage.
assert.deepEqual(await boxes(page, "confirmed"), confirmedStart, "確定図 is unchanged before Apply");
assert.equal(diagramDrafted.stored, diagramStart.stored, "storage is unchanged before Apply");
if (process.env.VOICE_DIAGRAM_SHOTS) {
  // The window as the person sees it; a screenshot of the pane itself would
  // scroll the page to it.
  await page.screenshot({ path: path.join(process.env.VOICE_DIAGRAM_SHOTS, "first-screen-drafted.png") });
}

// Seen, not only laid out: with the page exactly as the request left it -
// never scrolled - each lane and step of the diagram, and its label, is what
// the person reaches at nine points across it. A point counts only if it is
// inside the window, the page hit-tests to the pane there, and inside the pane
// what is there is this cell's own shape or label, a cell nested in it, a link,
// or the graph's empty background. Another cell there - one band over the
// other's label, a step over a part already placed - does not count, nor does
// anything of the embed's own, nor maxGraph's in-cell editor (which only a
// double-click opens, and which is reported, never counted as clear).
const unobscured = id => page.evaluate(id => {
  const frame = document.querySelector('#working-surface iframe[data-package="semantic-map"]');
  const adapter = frame.contentWindow.semanticMapApp.adapter;
  const view = adapter.graph.getView();
  const cell = adapter.cellsByRegionId.get(id);
  const state = view.getState(cell);
  const shape = state?.shape?.node;
  const text = state?.text?.node;
  if (!shape?.isConnected || !text?.isConnected) return { drawn: false };
  const container = frame.contentDocument.querySelector("#graph-container");
  // maxGraph's own cell tree is flat; which region a cell sits in is the
  // projection's parentRegionId the view put on it.
  const parentOf = regionId => adapter.cellsByRegionId.get(regionId)?.semantic?.parentRegionId ?? null;
  const within = (inner, outer) => {
    for (let at = inner; at != null; at = parentOf(at)) if (at === outer) return true;
    return false;
  };
  const owners = [];
  for (const [regionId, other] of adapter.cellsByRegionId) {
    const drawn = view.getState(other);
    for (const node of [drawn?.shape?.node, drawn?.text?.node]) if (node) owners.push({ node, regionId, own: within(regionId, id) });
  }
  const pane = frame.getBoundingClientRect();
  const blockers = new Set();
  const clear = element => {
    const rect = element.getBoundingClientRect();
    let count = 0;
    for (const fx of [0.2, 0.5, 0.8]) {
      for (const fy of [0.2, 0.5, 0.8]) {
        const x = rect.x + rect.width * fx;
        const y = rect.y + rect.height * fy;
        const pageX = pane.left + frame.clientLeft + x;
        const pageY = pane.top + frame.clientTop + y;
        if (x < 0 || y < 0 || x > frame.clientWidth || y > frame.clientHeight
          || pageX < 0 || pageY < 0 || pageX > innerWidth || pageY > innerHeight) { blockers.add("outside"); continue; }
        if (document.elementFromPoint(pageX, pageY) !== frame) { blockers.add("page"); continue; }
        const hit = frame.contentDocument.elementFromPoint(x, y);
        if (hit === null || !container.contains(hit)) { blockers.add(`embed:${hit?.id || hit?.className || hit?.tagName}`); continue; }
        if (hit.closest(".mxCellEditor")) { blockers.add("in-cell-editor"); continue; }
        const owner = owners.find(item => item.node.contains(hit));
        if (owner && !owner.own) { blockers.add(`cell:${owner.regionId}`); continue; }
        count += 1;
      }
    }
    return count;
  };
  const shapeClear = clear(shape);
  const textClear = clear(text);
  return { drawn: true, label: text.textContent.trim(), shape: shapeClear, text: textClear, blockers: [...blockers].sort() };
}, id);
await assertFirstScreen("after the purpose request");
const labelOf = Object.fromEntries([laneA, laneB, stepSubmit, stepReview, stepReceive].map((id, index) =>
  [id, ["申請者", "承認者", "申請する", "確認して判断する", "結果を受け取る"][index]]));
const seenCells = {};
for (const id of composedRegions) {
  seenCells[id] = await unobscured(id);
  assert.deepEqual(seenCells[id], { drawn: true, label: labelOf[id], shape: 9, text: 9, blockers: [] },
    `${id} and its label are drawn and unobscured at 1280x720: ${JSON.stringify(seenCells[id])}`);
}

// The parts already there stay in 作業図 whether or not the pane shows them,
// and the page says which ones it does not show whole - never that they are
// visible. The view's own frame decides, exactly as it does for placement.
const genesisOffPane = ["node-a", "node-b", "node-c"].filter(id => !genesisOnPane.includes(id));
const composedNotice = await outOfViewNotice(page);
assert.deepEqual(composedNotice.parts.split(" ").filter(Boolean), genesisOffPane,
  `the notice names exactly the parts not wholly on the pane: ${JSON.stringify(composedNotice)}`);
if (genesisOffPane.length > 0) {
  assert.match(composedNotice.text, /^表示に収まっていない部品: .*（作業図には残っています。表示の外か、一部しか見えていません）$/u);
  for (const id of genesisOffPane) assert.ok(composedNotice.text.includes(id), `${id} is named`);
}

// A lane is a container, never an endpoint: the next request does not offer
// it, and a real Jev asked for an arrow from it drafts nothing.
const laneLink = await type(page, `${laneA} から ${stepSubmit} へ矢印を足して`);
assert.notEqual(laneLink.decision.model, "jev-test", "answered by the real Jev");
const laneOffer = laneLink.sent.state.working;
for (const lane of [laneA, laneB]) {
  assert.equal(laneOffer.regions.includes(lane), false, `${lane} is not offered as an endpoint`);
  assert.equal(laneOffer.placeable.includes(lane), false, `${lane} is not offered for placement`);
  assert.equal(laneOffer.edges.some(edge => edge.from === lane || edge.to === lane), false);
}
for (const id of ["node-a", "node-b", "node-c", stepSubmit, stepReview, stepReceive]) {
  assert.ok(laneOffer.regions.includes(id), `${id} is still in 作業図 and offered, on the pane or not`);
}
const laneLinkScreen = await screen(page);
assert.notEqual(laneLinkScreen.state, "drafted", `an arrow from a lane drafts nothing: ${laneLinkScreen.status}`);
assert.deepEqual(laneLinkScreen.draft, diagramDrafted.draft, "the draft is exactly the diagram still");
assert.equal(laneLinkScreen.stored, diagramStart.stored);
assert.equal((await drawnEdges(page, "working")).length, 2, "no link was drawn");
await assertFirstScreen("after the lane request");

// The draft is refined like any other graph: a link back, named by its parts.
const refined = await type(page, `${stepReview} から ${stepSubmit} へ差し戻しの矢印を足して`);
assert.equal(refined.decision.answers.action.choice, "add-edge",
  `the real Jev must hear one more link: ${JSON.stringify(refined.decision.answers)}`);
const refinedScreen = await screen(page);
assert.equal(refinedScreen.state, "drafted", refinedScreen.status);
assert.deepEqual(refinedScreen.draft.at(-1), `+${stepReview}->${stepSubmit}`);
assert.ok((await drawnEdges(page, "working")).some(edge =>
  edge.from === stepReview && edge.to === stepSubmit && edge.directed && edge.rendered), "the link back is drawn");
// Said straight after, from the same input, with nothing scrolled - and the
// composed parts are still all in view with the longer draft list.
await assertFirstScreen("after the refinement");
for (const id of composedRegions) {
  assert.deepEqual(await unobscured(id), seenCells[id], `${id} is still unobscured after the refinement`);
}
const framesRefined = await bothFrames(page);
assert.deepEqual(framesRefined.confirmed, framesRefined.working,
  `both panes still show the same frame after the refinement: ${JSON.stringify(framesRefined)}`);

// Undo takes the refinement, then the whole diagram - every lane, step and
// link together - and nothing else.
await press(page, "#undo");
assert.equal((await screen(page)).draft.length, 1, "Undo takes the refinement only");
await press(page, "#undo");
const undoneDiagram = await screen(page);
assert.deepEqual(undoneDiagram.draft, [], "the second Undo takes the whole diagram");
const afterUndo = await boxes(page, "working");
assert.deepEqual(composedRegions.filter(id => afterUndo[id]), [], "no lane or step is left drawn");
assert.deepEqual(await drawnEdges(page, "working"), [], "and no link");
await assertFirstScreen("after both Undos");

// Asked again, it is composed under new names; then applied and reloaded.
const again = await type(page, "申請と承認の流れの図を作ってください");
assert.equal(again.decision.answers.diagram.choice, "request-approval-flow",
  `the real Jev must choose the approval flow again: ${JSON.stringify(again.decision.answers)}`);
const againScreen = await screen(page);
assert.equal(againScreen.state, "drafted", againScreen.status);
const againRegions = [...againScreen.draft[0].matchAll(/\+(part-\d+)「/gu)].map(match => match[1]);
assert.equal(againRegions.length, 5);
assert.deepEqual(againRegions.filter(id => composedRegions.includes(id)), [], "names handed out before are never reused");
await assertFirstScreen("after composing again");
for (const id of againRegions) {
  const seen = await unobscured(id);
  assert.equal(seen.shape === 9 && seen.text === 9, true, `${id} is unobscured on the first screen: ${JSON.stringify(seen)}`);
}
await press(page, "#apply");
// The history of 確定図 grew, below its graph.
await assertFirstScreen("after Apply");
const appliedDiagram = await screen(page);
assert.equal(appliedDiagram.state, "applied");
assert.equal(lineCount(appliedDiagram.stored ?? ""), lineCount(diagramStart.stored ?? "") + (diagramStart.stored ? 1 : 2),
  "Apply writes the diagram as one Decision after the genesis");
assert.equal(appliedDiagram.revertDisabled.at(-1), true, "a whole diagram is not offered as a revert");
const confirmedDiagram = await boxes(page, "confirmed");
for (const id of againRegions) assert.equal(confirmedDiagram[id]?.rendered, true, `確定図 draws ${id} after Apply`);

await page.reload({ waitUntil: "commit" });
await ready(page);
const reloadedDiagram = await screen(page);
assert.equal(reloadedDiagram.state, "restored");
assert.equal(reloadedDiagram.stored, appliedDiagram.stored, "reload does not rewrite the stored log");
for (const pane of ["confirmed", "working"]) {
  const cells = await boxes(page, pane);
  for (const id of againRegions) assert.equal(cells[id]?.rendered, true, `${pane} draws ${id} after reload`);
  const links = await drawnEdges(page, pane);
  assert.equal(links.filter(edge => againRegions.includes(edge.from) && againRegions.includes(edge.to) && edge.directed && edge.rendered).length, 2,
    `${pane} draws both directed links after reload`);
}
await assertFirstScreen("after reload");
if (process.env.VOICE_DIAGRAM_SHOTS) {
  await page.screenshot({ path: path.join(process.env.VOICE_DIAGRAM_SHOTS, "first-screen-reloaded.png") });
}
const diagramSummary = `unsupported "AWS の構成図を作って" -> ${awsScreen.status}; `
  + `"${asked.sent.state.utterance}" -> one step: lanes ${laneA},${laneB}, steps ${stepSubmit},${stepReview},${stepReceive}, `
  + `links ${composedLinks.join(" ")} drawn directed; lanes as ${laneLayout}; genesis parts wholly on the pane: `
  + `[${genesisOnPane.join(",")}]; steps covered by the embed's controls at their centre: [${stepCovered.join(",")}]; `
  + "at 1280x720 on the first screen, never scrolled, every lane and step and its label hit-tested at 9/9 points, "
  + `the input, Send, Voice, status, notices and Undo/Discard/Apply reachable, both graphs at top ${screenStart.tops[0]}px `
  + `and ${screenStart.widths[0]}px wide through refinement, Undo, recompose, Apply and reload; `
  + `out-of-view notice named [${genesisOffPane.join(",")}]: "${composedNotice.text}"; `
  + `"${laneLink.sent.state.utterance}" offered no lane and drafted nothing (${laneLinkScreen.state}: ${laneLinkScreen.status}); `
  + `refined with ${stepReview}->${stepSubmit}, Undo took it then the whole diagram, recomposed as ${againRegions.join(",")}, `
  + "applied, revert not offered, reload drew it in both panes";
await third.browser.close();

// (xx) The same purpose request in a 1366x657 window - a common laptop's inner
// height - from a fresh browser and the genesis graph. Real Jev for the
// composition and the refinement; the placed-part counterexample afterwards is
// crafted, because what it tests is the app's own refusal, not Jev's hearing.
const fourth = await openBrowser(wav);
page = fourth.page;
await page.setViewportSize({ width: 1366, height: 657 });
await page.goto(url, { waitUntil: "commit", timeout: 120000 });
await ready(page);
const laptopStart = await screen(page);
assert.deepEqual(laptopStart.draft, [], "precondition: a fresh page with nothing unapplied");
const laptopScreen = await firstScreen(page);
assert.equal(laptopScreen.scrollY, 0);
assert.deepEqual(laptopScreen.unreachable, [], `1366x657 first screen: ${JSON.stringify(laptopScreen)}`);
const laptopAsked = await type(page, "申請して承認してもらう流れを図にして");
assert.notEqual(laptopAsked.decision.model, "jev-test", "answered by the real Jev");
assert.equal(laptopAsked.decision.answers.diagram.choice, "request-approval-flow",
  `the real Jev must choose the approval flow: ${JSON.stringify(laptopAsked.decision.answers)}`);
const laptopDrafted = await screen(page);
assert.equal(laptopDrafted.state, "drafted", laptopDrafted.status);
const laptopRegions = [...laptopDrafted.draft[0].matchAll(/\+(part-\d+)「/gu)].map(match => match[1]);
assert.equal(laptopRegions.length, 5);
const [laptopLaneA, laptopLaneB, laptopSubmit, laptopReview, laptopReceive] = laptopRegions;
const laptopCells = await boxes(page, "working");
const laptopBands = bandsDrawn(laptopCells, [laptopLaneA, laptopLaneB], [laptopSubmit, laptopReview, laptopReceive]);
assert.ok(laptopBands.bands && laptopBands.flow, `bands and flow order at 1366x657: ${JSON.stringify(laptopBands)}`);
assert.deepEqual(await presentations(page), { confirmed: CHROME_FREE, working: CHROME_FREE });
const laptopLabels = Object.fromEntries(laptopRegions.map((id, index) =>
  [id, ["申請者", "承認者", "申請する", "確認して判断する", "結果を受け取る"][index]]));
const laptopSeen = async when => {
  const now = await firstScreen(page);
  assert.equal(now.scrollY, 0, `${when}: the page was not scrolled`);
  assert.deepEqual(now.unreachable, [], `${when}: input, buttons and notices reachable: ${JSON.stringify(now)}`);
  for (const id of laptopRegions) {
    assert.deepEqual(await unobscured(id), { drawn: true, label: laptopLabels[id], shape: 9, text: 9, blockers: [] },
      `${when}: ${id} and its label are unobscured at 1366x657`);
  }
  const frames = await bothFrames(page);
  assert.deepEqual(frames.confirmed, frames.working, `${when}: both panes show the same frame: ${JSON.stringify(frames)}`);
  return now;
};
const laptopComposed = await laptopSeen("1366x657 after the purpose request");
const laptopRefined = await type(page, `${laptopReview} から ${laptopSubmit} へ差し戻しの矢印を足して`);
assert.equal(laptopRefined.decision.answers.action.choice, "add-edge",
  `the real Jev must hear one more link: ${JSON.stringify(laptopRefined.decision.answers)}`);
assert.equal((await screen(page)).state, "drafted");
const laptopAfter = await laptopSeen("1366x657 after the refinement");
assert.deepEqual(laptopAfter.tops, laptopComposed.tops, "neither graph moved with the refinement");

// A diagram is never drawn over a part the person placed: node-c put beside
// node-a, into the space the bands would take, then the same diagram asked for.
await press(page, "#discard");
await page.route(jevUrl, answerFrom({
  action: { type: "choice", choice: "place-part", confidence: 0.95 },
  move: { type: "choice", choice: "node-c", confidence: 0.95 },
  anchor: { type: "choice", choice: "node-a", confidence: 0.95 },
  direction: { type: "choice", choice: "right", confidence: 0.95 },
}), { times: 1 });
await type(page, "node-c を node-a の右に置いて");
const placedFirst = await screen(page);
assert.equal(placedFirst.state, "drafted", `precondition: node-c is placed: ${placedFirst.status}`);
const cellsPlaced = await boxes(page, "working");
await page.route(jevUrl, answerFrom({
  action: { type: "choice", choice: "compose-diagram", confidence: 0.95 },
  diagram: { type: "choice", choice: "request-approval-flow", confidence: 0.95 },
}), { times: 1 });
await type(page, "申請して承認してもらう流れを図にして");
const noRoom = await screen(page);
assert.equal(noRoom.state, "no-change", `a diagram over a placed part is a no-change: ${noRoom.status}`);
assert.match(noRoom.status, /図を置く場所にほかの部品があります/u, "and it says why");
assert.deepEqual(noRoom.draft, placedFirst.draft, "the draft is untouched");
assert.deepEqual(await boxes(page, "working"), cellsPlaced, "and nothing on the screen moved");
assert.equal(noRoom.stored, laptopStart.stored, "nothing was saved");
const laptopSummary = `1366x657 (fresh browser, real Jev): "${laptopAsked.sent.state.utterance}" -> bands `
  + `${JSON.stringify(laptopBands.lanes)}, steps at x ${laptopBands.xs.join(" < ")}, every lane and step and its label 9/9 `
  + `before and after the real refinement ${laptopReview}->${laptopSubmit}, never scrolled, equal pane frames; `
  + `a crafted compose over a placed node-c -> "${noRoom.status}", nothing drawn`;
await fourth.browser.close();

assert.deepEqual(errors, []);
assert.deepEqual(failedResponses, []);
for (const input of inputsSent) {
  assert.equal(consoleMessages.some(message => message.includes(input)), false, `an input was logged to the console: ${input}`);
}
await Promise.all(pendingCounts);
assert.ok(craftedAnswered > 0, "precondition: the crafted turns were answered and counted apart");

const diagramParts = `| ${jevAnswered} real Jev answers in this run, ${craftedAnswered} crafted by the test `
  + `| whole diagram (fresh browser, real Jev): ${diagramSummary} `
  + `| ${laptopSummary} `;
if (focused) {
  // Never the full run's PASS line: it names what did not run.
  assert.equal(fullRunSummary, null, "focused mode ran none of sections (i)-(xviii)");
  process.stdout.write(
    "local-voice-graph-e2e: FOCUSED diagram sections (xix)-(xx) PASS; sections (i)-(xviii) NOT RUN "
    + `${diagramParts}\n`,
  );
} else {
  assert.notEqual(fullRunSummary, null, "the full run reached the end of section (xviii)");
  process.stdout.write(`local-voice-graph-e2e: PASS ${fullRunSummary.head}${diagramParts}${fullRunSummary.tail}`);
}
