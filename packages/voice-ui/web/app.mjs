import { createHayamimi } from "/hayamimi/runtime/api/hayamimi.mjs";
import {
  executeArtifactPackage as renderSemanticMap,
  visibleFrameOf,
} from "/ui/semantic-map/runtime.js";
import * as protocol from "/ui/semantic-map/protocol/index.js";
import { DECISION_KIND, ERRORS } from "/app/src/contract.mjs";
import { readBundle } from "/app/src/bundle.mjs";
import { readConfig } from "/app/src/config.mjs";
import {
  COMMIT_COMMITTED,
  COMMIT_UNVERIFIED,
  RESTORE_NO_LOG,
  RESTORE_RESTORED,
  commitLog,
  projectHistory,
  restoreLog,
  statesOf,
} from "/app/src/log.mjs";
import {
  appendRevert,
  apply,
  clearConversation,
  clearPending,
  createSession,
  discard,
  draftFull,
  noteRefused,
  propose,
  recentConversation,
  spendPending,
  startNew,
  undo,
} from "/app/src/session.mjs";
import {
  OUTCOME_NO_CHANGE,
  OUTCOME_STEP,
  focusFor,
  pendingForJev,
  pendingHolds,
  placeableIds,
  requestFor,
  revertStep,
  revertable,
} from "/app/src/turn.mjs";
import {
  drawGraph,
  frameFor,
  reasonText,
  renderContext,
  renderControls,
  renderDiagnostic,
  renderDraft,
  renderBundleNotice,
  renderHistory,
  renderOutOfView,
} from "/app/src/render.mjs";

// The browser side of the app and nothing else: the elements, the platform
// adapters (storage, the origin-wide lock, fetch, the recognizer, the service
// worker) and the events that move one session reference from state to state.

const text = document.querySelector("#text");
const send = document.querySelector("#send");
const mic = document.querySelector("#mic");
const newButton = document.querySelector("#new");
const status = document.querySelector("#status");
const historyPanel = document.querySelector("#history");
const confirmedSurface = document.querySelector("#confirmed-surface");
const draftList = document.querySelector("#draft");
const draftCount = document.querySelector("#draft-count");
const undoButton = document.querySelector("#undo");
const discardButton = document.querySelector("#discard");
const applyButton = document.querySelector("#apply");
const workingSurface = document.querySelector("#working-surface");
const outOfView = document.querySelector("#out-of-view");
const bundleNotice = document.querySelector("#bundle-notice");
const contextList = document.querySelector("#context-recent");
const contextSkipped = document.querySelector("#context-skipped");
const contextClear = document.querySelector("#context-clear");

const controls = {
  send,
  mic,
  newMap: newButton,
  undo: undoButton,
  discard: discardButton,
  apply: applyButton,
  history: historyPanel,
  contextClear,
};

const { verifyDecisionLog } = protocol;

// The configuration this page was given (web/data/config.v1.json), set once
// it has been read and found valid; nothing below runs against storage or data
// before that.
let config;

// The only place in the app that touches browser storage and its lock. The
// modules are pure and take these as arguments. localStorage is the one
// mechanism the config may name, and the key it declares also names the lock.
const read = key => localStorage.getItem(key);
const write = (key, value) => localStorage.setItem(key, value);
const lock = (name, run) => navigator.locks.request(name, run);
const commit = ({ graph, expected }) => commitLog({
  graph, expected, key: config.persistence.key, read, write, lock, verifyDecisionLog,
});

// The service worker only exists to reassemble the chunked ASR model that
// the Cloudflare 25MB file limit forces. A host that serves the model whole
// answers the probe with 204, so registration is skipped there.
const serviceWorkerReady = (async () => {
  const manifest = await fetch("/hayamimi/sherpa/data.parts.json", { cache: "no-store" });
  // Only the status is needed, but the body is drained all the same. A
  // response left unread is cancelled by the browser, which reports the
  // probe as an aborted request even though the host answered it.
  await manifest.arrayBuffer();
  // 204 is the host stating there are no chunks to reassemble. It has to
  // be read before `ok`, which is true for 204 and would otherwise
  // register a worker with nothing to do. Anything else that is not a
  // served manifest is unexpected and must surface rather than silently
  // disable the worker.
  if (manifest.status === 204) return;
  if (!manifest.ok) throw new Error(`chunk manifest probe failed: ${manifest.status}`);
  if (!("serviceWorker" in navigator)) throw new Error("service worker is required");
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })
    );
  }
})();

// Capture and the surface are separate resources, so they are owned
// separately. `capturing` makes microphone capture exclusive to one voice
// attempt; `rendering` makes the decide-and-render critical section
// exclusive across every input and control. Typed submission is therefore
// allowed while voice is only listening, and refused only while the surface
// is being decided or rendered. Each path releases `rendering` solely when
// it is the owner, so neither can free the other's hold.
let capturing = false;
let rendering = false;
let typedHoldsRender = false;
let voiceHoldsRender = false;
let controlHoldsRender = false;

// Fail-closed latch. A stored log that is corrupt or foreign, and a change
// that was saved but could not be drawn, both leave the screen unable to
// speak for storage. Neither is transient, so no in-app control clears it:
// a reload recovers a display failure, and only clearing this origin's
// storage from outside the app recovers a log that is not usable here.
let blocked = false;

// The one session reference, the saved graph's history as the left pane
// shows it, and the DataBundle this page loaded once.
let session;
let savedHistory = null;
let bundle;

const adopt = next => {
  session = next;
  if (next.pending === null) delete document.body.dataset.pending;
  else document.body.dataset.pending = next.pending.intent.missing;
};

const sync = () => renderControls(controls, {
  idle: !rendering && !blocked,
  capturing,
  noLog: session.accepted === null,
  working: session.working !== null,
  draftLength: session.draft.length,
  conversationLength: session.conversation.length,
});

const setState = (state, message) => {
  document.body.dataset.state = state;
  status.textContent = message;
};

const showLists = () => {
  renderDraft(draftList, draftCount, { draft: session.draft, bundle });
  renderContext(contextList, contextSkipped, recentConversation(session));
};

const showHistory = (note = null) => renderHistory(historyPanel, {
  projection: savedHistory,
  revertable: savedHistory === null ? [] : savedHistory.entries.map(entry => revertable(entry, savedHistory)),
  failure: note,
});

// Where a voice press has got to: preparing the microphone and the
// recognizer, listening, or deciding what was heard. The body state stays
// `pending` for the whole press; this only says what the user may do now,
// so "話してください" appears once capture has actually started.
const setVoice = (phase, message) => {
  if (phase === null) {
    delete document.body.dataset.voice;
    return;
  }
  document.body.dataset.voice = phase;
  status.textContent = message;
};

// Where the working graph is drawn, answered by the provider's public layout
// contract. The app never computes a position itself; a part can only be put
// beside another because the view says where that other one is. A graph the
// view cannot lay out offers no placement; everything else still works.
const workingLayout = () => {
  if (session.working === null) return null;
  try {
    return protocol.layoutBoundsFor(session.working.records, { pattern: protocol.GRAPH_PATTERN });
  } catch {
    return null;
  }
};

// Each drawing fits the whole working graph, but the camera does not follow
// a later resize, so parts can still end up outside the pane. They are still
// in 作業図; the person is told which ones, never that they are visible. Only
// 作業図 is asked, which is sound while both panes show the same frame: both
// have the same box and are given the same View.frame, which the browser test
// asserts.
const showOutOfView = () => {
  if (session.working === null) {
    renderOutOfView(outOfView, { outside: [] });
    return;
  }
  const layout = workingLayout();
  const shown = visibleFrameOf(workingSurface);
  if (layout === null || shown === null || shown.head !== session.working.head) {
    renderOutOfView(outOfView, { outside: null });
    return;
  }
  const whole = placeableIds(layout, session.working.records, shown.frame);
  renderOutOfView(outOfView, { outside: placeableIds(layout, session.working.records).filter(id => !whole.includes(id)) });
};

// The Function gives the provider 10 s and then answers 504 itself, so a
// page that has heard nothing 5 s after that is not being answered at all:
// the connection or the host has stalled. It stops waiting and says so,
// and the caller releases every control. The request is aborted, so an
// answer that turns up later can never land.
const JEV_TIMEOUT_MS = 15000;

const failure = (reason, detail = null) => Object.freeze({ kind: "failed", reason, detail });

// Jev's answer, or why there is none.
const postJev = async request => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  try {
    const response = await fetch("/api/jev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = (await response.json().catch(() => null))?.error;
      return failure("jev-failed", Object.values(ERRORS).includes(code) ? code : String(response.status));
    }
    const decision = await response.json().catch(() => null);
    if (decision?.kind !== DECISION_KIND || typeof decision.model !== "string") return failure("jev-contract");
    return Object.freeze({ kind: "answered", decision });
  } catch (error) {
    return controller.signal.aborted
      ? failure("jev-timeout", `${JEV_TIMEOUT_MS / 1000} s`)
      : failure("jev-failed", String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
  }
};

// Both panes point their cameras at the frame the working graph needs in the
// working pane's box, so the frame read from 作業図 holds for 確定図 too.
const paneFrame = graph => frameFor({
  graph,
  width: workingSurface.clientWidth,
  height: workingSurface.clientHeight,
  protocol,
});
const sameFrame = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const drawWorking = graph => drawGraph({
  graph, frame: paneFrame(graph), mount: workingSurface, protocol, renderSemanticMap, document,
});

// 確定図 is drawn at the frame 作業図 has now, and again only when that frame
// changed, so an edit that leaves the working graph's extent alone does not
// redraw the saved graph.
let confirmedFrame;
const drawConfirmed = async () => {
  const frame = paneFrame(session.working);
  await drawGraph({ graph: session.accepted, frame, mount: confirmedSurface, protocol, renderSemanticMap, document });
  confirmedFrame = frame;
};
const followWorkingFrame = async () => {
  if (!sameFrame(confirmedFrame, paneFrame(session.working))) await drawConfirmed();
};
// After a change to 作業図, which stands whatever happens here: redraw
// 確定図 at the new frame, or say plainly that it could not be - the two
// panes then show different frames - rather than report a clean step.
// The next change tries again. Returns true when the page reported it.
const followOrReport = async (state, message) => {
  try {
    await followWorkingFrame();
    return false;
  } catch (error) {
    confirmedFrame = undefined;
    setState("confirmed-display-failed", `${message}。ただし確定図を同じ表示範囲で描き直せませんでした`);
    showHistory(`display failed (${state}): ${error.message}`);
    return true;
  }
};

let hayamimi;
const transcribe = async () => {
  await serviceWorkerReady;
  hayamimi ??= createHayamimi();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      hayamimi.onText = null;
      reject(new Error("voice transcription timed out"));
    }, 300000);
    hayamimi.onText = async value => {
      settled = true;
      clearTimeout(timeout);
      hayamimi.onText = null;
      try {
        await hayamimi.stop();
        text.value = value;
        resolve(value);
      } catch (error) {
        reject(error);
      }
    };
    // start() resolves once the recognizer is loaded and the microphone
    // is feeding it, so only then is the user asked to speak.
    hayamimi.start().then(
      () => {
        if (!settled) setVoice("listening", "voice: 聞いています。話してください");
      },
      error => {
        settled = true;
        clearTimeout(timeout);
        hayamimi.onText = null;
        reject(error);
      },
    );
  });
};

// The changes that are not graph edges and that the focus may point at: the
// latest applied entry's edges and parts.
const lastApplied = () => (savedHistory?.entries.at(-1)?.facts ?? [])
  .filter(fact => fact.kind === "relation" || fact.kind === "region");

// Send and Voice take the same path, and neither touches 確定図 or storage:
// the utterance is judged against 作業図 and every unapplied step, and a
// usable answer becomes one more step on 作業図, drawn before it is adopted.
// Returns how the input ended; only an utterance Jev judged joins the
// conversation, which the session records.
const decide = async (value, source) => {
  renderDiagnostic(status, null);
  if (typeof value !== "string" || value.trim().length === 0) {
    return Object.freeze({ kind: OUTCOME_NO_CHANGE, reason: "nothing-said" });
  }
  if (draftFull(session)) return Object.freeze({ kind: OUTCOME_NO_CHANGE, reason: "draft-full", state: "draft-full" });

  const working = session.working;
  const layout = workingLayout();
  const asked = visibleFrameOf(workingSurface);
  const offeredFrame = asked !== null && asked.head === working.head ? asked.frame : null;
  const placeable = layout === null ? [] : [...placeableIds(layout, working.records, offeredFrame)];

  // A held placement is spent by this utterance even if the provider later
  // times out or refuses it, and is passed on explicitly for the repair.
  const spent = spendPending(session);
  adopt(spent.session);
  const held = spent.held;
  const stillHeld = held !== null && pendingHolds(held.intent, { head: working.head, frame: offeredFrame, offered: placeable });

  const steps = session.draft.map(item => item.step);
  const { turn, request } = requestFor({
    working,
    utterance: value,
    bundle,
    layout,
    offeredFrame,
    draft: steps,
    focus: focusFor({ draft: steps, lastApplied: lastApplied() }),
    pending: stillHeld ? pendingForJev(held.intent) : null,
    recent: recentConversation(session).recent,
  });
  const answer = await postJev(request);
  if (answer.kind === "failed") return answer;

  // Read in the same synchronous run the answer is judged in.
  const visibleFrame = visibleFrameOf(workingSurface);
  const input = Object.freeze({ source, text: value });
  const before = session;
  const transition = await propose(session, {
    turn, answers: answer.decision.answers, protocol, bundle, layout, visibleFrame, input, repair: held,
  });
  if (transition.result.outcome === OUTCOME_NO_CHANGE) {
    adopt(transition.session);
    renderDiagnostic(status, {
      answers: answer.decision.answers,
      placeable,
      undoRequest: transition.result.undoRequest === true,
      frame: visibleFrame,
      revision: working.head,
    });
    return Object.freeze({
      kind: OUTCOME_NO_CHANGE,
      reason: transition.result.reason,
      state: transition.result.undoRequest === true ? "undo-request" : "no-change",
    });
  }
  if (transition.result.outcome !== OUTCOME_STEP) {
    adopt(transition.session);
    return failure(transition.result.reason, transition.result.detail ?? null);
  }
  // A step joins 作業図 only once it is drawn. If it cannot be, the pane still
  // shows the map it had (drawGraph keeps it) and the utterance counts as refused.
  try {
    await drawWorking(transition.session.working);
  } catch (error) {
    adopt(noteRefused(before, input));
    return failure("display-failed", String(error?.message ?? error));
  }
  adopt(transition.session);
  return Object.freeze({ kind: OUTCOME_STEP });
};

// How an input ends. Only a drawn step changes 作業図; "no change" and a
// failure leave it exactly as it was. 確定図 and storage are never touched.
const finish = async (prefix, outcome) => {
  showLists();
  if (outcome.kind === OUTCOME_STEP) {
    showOutOfView();
    const drafted = `${prefix}: 作業図に追加しました (未反映)`;
    if (!(await followOrReport("drafted", drafted))) {
      setState("drafted", drafted);
      showHistory();
    }
    return;
  }
  if (outcome.kind === OUTCOME_NO_CHANGE) {
    setState(outcome.state ?? "no-change", `${prefix}: no change - ${reasonText(outcome.reason)}`);
    showHistory();
    return;
  }
  // The status names the phase that failed; history keeps what was said about it.
  setState("failed", `${prefix}: failed - ${reasonText(outcome.reason)}`);
  showHistory(`failed: ${reasonText(outcome.reason, outcome.detail)}`);
};

send.addEventListener("click", async () => {
  if (blocked) return;
  if (rendering) {
    setState("pending", "type: busy");
    return;
  }
  rendering = true;
  typedHoldsRender = true;
  sync();

  setState("pending", "type: working");
  try {
    await finish("type", await decide(text.value, "typed"));
  } catch (error) {
    await finish("type", failure("error", String(error?.message ?? error)));
  } finally {
    if (typedHoldsRender) {
      rendering = false;
      typedHoldsRender = false;
    }
    sync();
  }
});

// One press is all it takes: nothing here needs the text field. The surface
// critical section begins once transcription has finished; its claim is taken
// before the first await after that, and the finally releases it.
const hear = async () => {
  const heard = await transcribe();
  if (typeof heard !== "string") return failure("voice-failed", "Hayamimi must return text");
  if (rendering) return failure("error", "surface is busy");
  rendering = true;
  voiceHoldsRender = true;
  sync();
  setVoice("deciding", "voice: 判定中");
  return decide(heard, "voice");
};

mic.addEventListener("click", async () => {
  if (blocked) return;
  if (capturing || rendering) {
    setState("pending", "voice: busy");
    return;
  }
  capturing = true;
  sync();

  setState("pending", "voice: preparing");
  setVoice("preparing", "voice: 準備中です。まだ話さないでください");
  try {
    await finish("voice", await hear());
  } catch (error) {
    await finish("voice", failure("voice-failed", String(error?.message ?? error)));
  } finally {
    if (voiceHoldsRender) {
      rendering = false;
      voiceHoldsRender = false;
    }
    capturing = false;
    setVoice(null);
    sync();
  }
});

// The working-graph controls share the surface with the inputs, so they take
// the same exclusive hold and release it only as its owner. Each drops a held
// placement and the last turn's diagnostic, whatever it then does.
const withSurface = async (label, run) => {
  if (blocked || rendering) return;
  adopt(clearPending(session));
  rendering = true;
  controlHoldsRender = true;
  renderDiagnostic(status, null);
  sync();
  setState("pending", `${label}: working`);
  try {
    await run();
  } catch (error) {
    setState("failed", `${label}: failed`);
    showHistory(`failed: ${String(error?.message ?? error)}`);
  } finally {
    if (controlHoldsRender) {
      rendering = false;
      controlHoldsRender = false;
    }
    sync();
  }
};

// Draw a new working graph and adopt it, then report as a control does.
const showWorking = async (next, state, message) => {
  await drawWorking(next.working);
  adopt(next);
  showLists();
  showOutOfView();
  if (!(await followOrReport(state, message))) {
    setState(state, message);
    showHistory();
  }
};

const refusedBy = (label, result) => {
  if (result.outcome === OUTCOME_NO_CHANGE) {
    setState(result.reason === "draft-full" ? "draft-full" : "no-change", `${label}: no change - ${reasonText(result.reason)}`);
    showHistory();
    return;
  }
  setState("failed", `${label}: failed`);
  showHistory(`failed: ${reasonText(result.reason, result.detail ?? null)}`);
};

// 新しい図: only where there is no log. The typed name becomes a new, empty
// map on 作業図; nothing is stored until 確定図に反映.
newButton.addEventListener("click", () => withSurface("new", async () => {
  const { session: next, result } = await startNew(session, { title: text.value, protocol });
  if (result.outcome !== OUTCOME_STEP) {
    refusedBy("new", result);
    return;
  }
  await showWorking(next, "drafted", "new: 作業図に新しい図を作りました (未反映)");
}));

// 元に戻す drops the last unapplied step and nothing else, never below what is
// saved, and there is no redo.
undoButton.addEventListener("click", () => withSurface("undo", async () => {
  if (session.draft.length === 0) return;
  await showWorking(await undo(session, { verifyDecisionLog }), "undone", "作業図の最後の変更を元に戻しました");
}));

// 作業図を破棄 returns the working graph to the saved one.
discardButton.addEventListener("click", () => withSurface("discard", async () => {
  if (session.draft.length === 0) return;
  await showWorking(discard(session), "discarded", "作業図を破棄しました");
}));

// 会話をクリア forgets the recent conversation; the next request sends none.
// It changes neither pane.
contextClear.addEventListener("click", () => {
  if (blocked || rendering) return;
  adopt(clearConversation(session));
  renderDiagnostic(status, null);
  showLists();
  sync();
});

// 確定図に反映: the only write to storage and the only change to 確定図. Every
// unapplied Decision is written at once, under the origin-wide lock, only as
// a verified strict extension of what storage still holds, and read back. A
// refused Apply keeps 作業図 exactly as it was. Once the write has landed,
// a failure to draw it blocks the page until a reload.
applyButton.addEventListener("click", () => withSurface("apply", async () => {
  if (session.draft.length === 0) return;
  const { session: next, result } = await apply(session, { commit });
  // Storage that cannot be vouched for after a write leaves the screen unable
  // to speak for it: the page blocks until a reload reads what is really there.
  if (result.status === COMMIT_UNVERIFIED) {
    blocked = true;
    setState("storage-unverified", "apply: storage could not be verified - reload to recover");
    showHistory(`failed: ${reasonText(result.status, result.reason)}`);
    return;
  }
  if (result.status !== COMMIT_COMMITTED) {
    setState("failed", "apply: failed");
    showHistory(`failed: ${reasonText(result.status, result.reason ?? null)}`);
    return;
  }
  adopt(next);
  showLists();
  try {
    savedHistory = await projectHistory(next.accepted, { verifyDecisionLog });
    await drawConfirmed();
  } catch (error) {
    blocked = true;
    setState("saved-display-failed", "apply: saved, display failed - reload to recover");
    showHistory(`display failed: ${String(error?.message ?? error)}`);
    return;
  }
  setState("applied", "確定図に反映しました");
  showHistory();
}));

// 取り消しを作業図に追加: the opposite of an applied entry, read off the
// provider's states on either side of it, checked against 作業図 as it is now,
// and added there as one more step. 確定図 is untouched until Apply.
historyPanel.addEventListener("click", event => {
  const button = event.target.closest("button[data-revert]");
  if (!button || button.disabled) return;
  const index = Number(button.dataset.revert);
  withSurface("revert", async () => {
    const states = await statesOf(session.accepted.log, verifyDecisionLog);
    const built = await revertStep({ before: states[index], after: states[index + 1], working: session.working, protocol });
    if (built.outcome !== OUTCOME_STEP) {
      refusedBy("revert", built);
      return;
    }
    const { session: next, result } = await appendRevert(session, { step: built.step, protocol });
    if (result.outcome !== OUTCOME_STEP) {
      refusedBy("revert", result);
      return;
    }
    await showWorking(next, "drafted", "取り消しを作業図に追加しました (未反映)");
  });
});

// A JSON document of this origin, or why there is none: the network, the
// status, or a body that is not JSON.
const fetchJson = async path => {
  let response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch (error) {
    return Object.freeze({ reason: `network: ${String(error?.message ?? error)}` });
  }
  if (!response.ok) return Object.freeze({ reason: `HTTP ${response.status}` });
  try {
    return Object.freeze({ value: await response.json() });
  } catch (error) {
    return Object.freeze({ reason: `invalid JSON: ${String(error?.message ?? error)}` });
  }
};

// The configuration is the first thing read, from its one fixed place.
const CONFIG_PATH = "/data/config.v1.json";
const loadConfig = async () => {
  const fetched = await fetchJson(CONFIG_PATH);
  return fetched.reason === undefined ? readConfig(fetched.value) : Object.freeze({ error: fetched.reason });
};

// The DataBundle from where the config says. One that cannot be fetched or
// read disables only the capabilities it would have provided, and the notice
// names them and says why; nothing is offered in their place.
const BUNDLE_CAPABILITIES = Object.freeze({ parts: "部品の追加", diagrams: "図の作成" });
const loadBundle = async path => {
  const fetched = await fetchJson(path);
  const offered = readBundle(fetched.reason === undefined ? fetched.value : null);
  const affected = Object.keys(BUNDLE_CAPABILITIES).filter(name => offered[name] === null).map(name => BUNDLE_CAPABILITIES[name]);
  const reason = fetched.reason ?? (offered.version === null ? "invalid bundle" : "invalid section");
  return { offered, affected, reason };
};

let bootState;
let bootMessage;
let bootFailure = null;
const configured = await loadConfig();
if (configured.error !== undefined) {
  // Without a valid config nothing is read, fetched, asked or drawn, and the
  // page is blocked until a reload finds one.
  blocked = true;
  bundle = readBundle(null);
  adopt(createSession({ accepted: null, stored: null }));
  showLists();
  [bootState, bootMessage] = ["failed", "the configuration is unusable - nothing was read or drawn"];
  bootFailure = `config rejected: ${configured.error}`;
} else {
  config = configured;
  const loaded = await loadBundle(config.data.bundle);
  bundle = loaded.offered;
  renderBundleNotice(bundleNotice, loaded);

  // Storage decides what this origin starts from. No log is NO_LOG: nothing is
  // drawn until the person makes a map. A corrupt or foreign log is left exactly
  // where it is, blocks the page and draws nothing; the only way forward is an
  // explicit clear from outside the app. 作業図 starts as the saved graph:
  // nothing unapplied survives a reload, and the conversation starts empty.
  const restored = await restoreLog({ key: config.persistence.key, read, verifyDecisionLog });
  if (restored.status === RESTORE_RESTORED) {
    savedHistory = restored.projection;
    adopt(createSession({ accepted: restored.graph, stored: restored.graph.log }));
  } else {
    blocked = restored.status !== RESTORE_NO_LOG;
    adopt(createSession({ accepted: null, stored: null }));
  }
  showLists();

  try {
    await drawConfirmed();
    await drawWorking(session.working);
    showOutOfView();
    if (blocked) {
      [bootState, bootMessage] = ["failed", "saved history is unusable - clear this site's storage to start over"];
      bootFailure = `stored log rejected: ${restored.reason}`;
    } else if (restored.status === RESTORE_RESTORED) {
      [bootState, bootMessage] = ["restored", `restored: ${savedHistory.entries.length} confirmed`];
    } else {
      [bootState, bootMessage] = ["no-log", "no saved graph - type a name and press 新しい図"];
    }
  } catch (error) {
    // The stored graph is intact but undrawable. Nothing was lost, so this is
    // the same saved-but-not-displayed state a failed render produces.
    blocked = true;
    [bootState, bootMessage] = ["saved-display-failed", "stored graph could not be drawn - reload to retry"];
    bootFailure = `display failed: ${String(error?.message ?? error)}`;
  }
}
// The body state is set last, with every control already in its place: it is
// what tells anyone watching that the page is ready.
showHistory(bootFailure);
sync();
setState(bootState, bootMessage);
