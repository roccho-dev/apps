import assert from "node:assert/strict";
import { createRequire } from "node:module";
// The approved acceptance runtime supplies this pinned dependency, never npm at run time.
const { chromium } = createRequire(import.meta.url)("playwright-core");

// The architecture page end to end, in exactly one explicitly named mode:
//
//   fixture  every /api/judge answer is crafted by this test at the network from
//            the request the page actually sent. It proves the page's own
//            mechanics - request, plan, claims, draft, Undo, Apply, reload -
//            and is never evidence about Jev or the code.
//   fixture-stop injects a first-turn 502 and proves cross-stage STOP only.
//   live     nothing is intercepted and nothing is crafted. The real service
//            judges this code; the run is PASS only if the required flows are
//            actually drawn and classified, NOT_PASS otherwise. Its input is
//            typed: it is never evidence about the microphone path.
//
// Every utterance prints one JSON line (event "turn") and every run ends with
// one (event "summary"), on stdout: which requests the page made, how each
// ended and in how long, the closed answers, and what the page then showed.
// Never a request's state, headers or any source, stored or secret text.
//
// And in exactly one explicitly named scenario - the same stages, checks and
// requirements, only the words of the utterances differ:
//
//   natural  the utterances as a person says them, by what a part does. This
//            is the acceptance scenario.
//   named    each utterance names its target part by its file path or
//            identifier - never a role or relation it should be given - and
//            the correction names its edge by both ends and kind. It shows
//            only whether the code can be reached and judged when named; it
//            is never a PASS of the natural scenario.
//
// node architecture-e2e.mjs --mode fixture|fixture-stop|live --scenario natural|named <url of the dev server root>
const [flag, mode, scenarioFlag, scenario, url] = process.argv.slice(2);
if (flag !== "--mode" || !["fixture", "fixture-stop", "live"].includes(mode) || scenarioFlag !== "--scenario"
  || !["natural", "named"].includes(scenario) || !url) {
  throw new Error("usage: architecture-e2e.mjs --mode fixture|fixture-stop|live --scenario natural|named <url>");
}
const STOP_FIXTURE = mode === "fixture-stop";
const FIXTURE = mode !== "live";
// In the natural fixture a part is never named: the intent answers none, and
// the part is located - so the locate frames and their judge are what the
// fixture exercises, failures included. The named fixture names it.
const LOCATES = FIXTURE && scenario === "natural";
// The neutral app boundary never exposes a provider model identity.
// Extra envelope fields are refused; no fixture can prove model homogeneity.
const LABEL = `architecture-e2e[${mode}/${scenario}]`;
const UTTERANCES = {
  natural: {
    whole: "このアプリの構成を図にして",
    app: "画面のコードの役割を詳しく見せて",
    credential: "認証とJevへの接続を詳しく見せて",
    storage: "ブラウザ保存に関わる部分を詳しく見せて",
    save: "保存の仕組みを詳しく見せて",
    correction: "その保存の関係は違うので消して",
  },
  named: {
    whole: "このアプリの構成を図にして",
    app: "web/app.mjs を詳しく見せて",
    credential: "JEV_API_KEY を詳しく見せて",
    storage: "localStorage を詳しく見せて",
    save: "src/log.mjs を詳しく見せて",
    correction: "web/app.mjs から localStorage への stores-in の関係を消して",
  },
}[scenario];
const PAGE = new URL("/architecture", url).href;
const ROOT_KEY = "voice-ui.decision-log.v1";

// The contract as the target serves it, never a copy kept here.
const served = await fetch(new URL("/app/src/contract.mjs", url));
assert.equal(served.status, 200, "the target serves its contract module");
const contract = await import(`data:text/javascript;base64,${Buffer.from(await served.text()).toString("base64")}`);
const config = await (await fetch(new URL("/architecture/data/config.v1.json", url))).json();
const KEY = config.persistence.key;
// The snapshot's public manifest as the target serves it: its parts, which a
// locate asks about, and the commit every architecture request must name.
const MANIFEST = await (await fetch(new URL(config.data.source, url))).json();
const ENTITY_IDS = MANIFEST.entities.map(entity => entity.id);
const SERVED_COMMIT = MANIFEST.source.commit;
// The most requests one utterance can make: its intent, one locate frame per
// part, and a judge of every part - one frame per file, and one per two files
// some candidate pair joins.
const FILE_IDS = MANIFEST.entities.filter(entity => entity.kind === "file").map(entity => entity.id);
const MOST = 1 + ENTITY_IDS.length + FILE_IDS.length + new Set(MANIFEST.candidates
  .filter(candidate => FILE_IDS.includes(candidate.from) && FILE_IDS.includes(candidate.to))
  .map(candidate => [candidate.from, candidate.to].sort().join(" "))).size;

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));

// Every request the page makes to /api/judge, held by the browser's own request
// object, as it was sent and as it ended: answered with a status and a body
// read whole - or "body-unreadable" - or failed with the browser's own error
// text, and how long until then. A body is read once, and every read is
// awaited before anything is reported. Each is marked once a turn reports it.
const exchanges = [];
page.on("request", request => {
  if (new URL(request.url()).pathname !== "/api/judge") return;
  exchanges.push({
    request, sent: JSON.parse(request.postData()), at: Date.now(), status: null, error: null, ms: null, body: null, read: null, reported: false,
  });
});
const exchangeOf = request => exchanges.find(entry => entry.request === request);
page.on("response", response => {
  const entry = exchangeOf(response.request());
  if (entry === undefined) return;
  entry.status = response.status();
  entry.read = response.json().then(body => {
    entry.body = body;
  }, () => {
    entry.error = "body-unreadable";
  }).finally(() => {
    entry.ms = Date.now() - entry.at;
  });
});
page.on("requestfailed", request => {
  const entry = exchangeOf(request);
  if (entry === undefined) return;
  entry.error = "transport-failed";
  entry.ms = Date.now() - entry.at;
});
const drain = () => Promise.all(exchanges.map(entry => entry.read));

// What of an exchange may be printed: its kind, a locate frame's part, a
// judge's focus, body file ids and the frame of them it asks, how it ended,
// the unavailable provider identity and the closed answers as choice and confidence.
const sanitized = entry => {
  let answers = null;
  try {
    const slots = slotsOf(entry.sent);
    if (slots !== null) answers = contract.readAnswers(entry.body?.answers, slots);
  } catch {}
  return ({
  kind: entry.sent.kind,
  ...(entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND
    ? { focus: entry.sent.state.architecture.focus, bodies: entry.sent.state.architecture.bodies, frame: entry.sent.state.frame }
    : entry.sent.kind === contract.ARCHITECTURE_LOCATE_KIND ? { focus: entry.sent.state.architecture.focus } : {}),
  status: entry.status,
  error: entry.error !== null && entry.error !== undefined
    ? ["body-unreadable", "transport-failed"].includes(entry.error) ? entry.error : "UNKNOWN"
    : entry.body?.error === null || entry.body?.error === undefined ? null
      : Object.values(contract.ERRORS).includes(entry.body.error) ? entry.body.error : "UNKNOWN",
  upstreamStatus: entry.status === 502 && entry.body?.error === contract.ERRORS.providerError
    && Number.isInteger(entry.body?.upstreamStatus) && entry.body.upstreamStatus >= 300 && entry.body.upstreamStatus <= 599
    ? entry.body.upstreamStatus : "UNKNOWN",
  diagnostic: entry.status === 502 && entry.body?.error === contract.ERRORS.providerError
    && entry.body?.upstreamStatus === 400 && entry.body?.diagnostic === "context-limit-vocabulary-observed"
    ? "context-limit-vocabulary-observed" : "UNKNOWN",
  ms: entry.ms,
  providerIdentity: "UNKNOWN",
  answers: answers === null ? null
    : Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.choice, answer.confidence]])),
  });
};
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// The frames a judge's section is asked in, as the served contract plans
// them; and the questions a request put to Jev, as it derives them for its
// kind - for a judge, those of the one frame it names, or null when its
// section's plan holds no such frame.
const framesOf = section => contract.judgeFramesFor(section) ?? [];
const slotsOf = sent => {
  if (sent.kind === contract.ARCHITECTURE_LOCATE_KIND) return contract.locateSlotsFor(sent.state.architecture.focus);
  if (sent.kind !== contract.ARCHITECTURE_JUDGE_KIND) return contract.slotsFor(sent.state);
  const framed = framesOf(sent.state.architecture).find(item => JSON.stringify(item.frame) === JSON.stringify(sent.state.frame));
  return framed === undefined ? null : contract.judgeSlotsFor(framed.section);
};

// Fixture mode only: the answer to a request, crafted from its own questions -
// an intent's, a locate frame's or a judge frame's. For a stage that proves a
// failure, `fault` may replace the answer to one request of the utterance, by
// its place (0 the intent): with a status and body of its own, with an unexpected envelope field, or with answers of its own. A judge naming a frame its section's
// plan does not hold is refused, as the Function refuses it.
const craft = (picks, fault = () => null) => {
  let index = 0;
  return async route => {
    const sent = JSON.parse(route.request().postData());
    const slots = slotsOf(sent);
    const faulty = slots === null ? { status: 422, body: { error: contract.ERRORS.architectureMismatch } } : fault(index);
    index += 1;
    if (faulty?.status !== undefined) {
      await route.fulfill({ status: faulty.status, contentType: "application/json; charset=utf-8", body: JSON.stringify(faulty.body) });
      return;
    }
    const answers = Object.fromEntries(Object.entries(slots).map(([name, options]) => {
      const picked = picks(name, sent);
      const structured = picked !== null && typeof picked === "object";
      const value = structured ? picked : { choice: picked, confidence: 0.9 };
      if (structured) assert.ok(options.includes(value.choice), name + ": the controlled uncertain choice is actually offered");
      return [name, { type: "choice", choice: options.includes(value.choice) ? value.choice : contract.NONE, confidence: value.confidence }];
    }));
    await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ kind: contract.DECISION_KIND, answers: faulty?.answers ?? answers, ...(faulty?.extra ?? {}) }) });
  };
};

const ready = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending", null, { timeout: 120000 });
const settle = () => page.waitForFunction(() => document.body.dataset.state !== "pending", null, { timeout: 120000 });
const screen = () => page.evaluate(([key, rootKey]) => ({
  state: document.body.dataset.state,
  status: document.querySelector("#status").textContent,
  failure: document.querySelector("[data-history=failure]")?.textContent ?? null,
  draft: [...document.querySelectorAll("#draft li")].map(item => item.dataset.changes),
  draftCount: document.querySelector("#draft-count").textContent,
  sourceStatus: document.querySelector("#architecture-status").textContent,
  shown: !document.querySelector("#architecture").hidden,
  claims: [...document.querySelectorAll("#architecture-claims li")].map(item => ({
    record: item.dataset.record, origins: item.dataset.origins.split(" "),
  })),
  coverage: [...document.querySelectorAll("#architecture-coverage li")].map(item => item.textContent),
  context: [...document.querySelectorAll("#context-recent li")].map(item => JSON.parse(item.dataset.entry)),
  graph: (() => {
    const runtime = document.querySelector("#working-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
    return runtime && Array.isArray(runtime.records) && runtime.records.length > 0 && typeof runtime.head === "string"
      ? { head: runtime.head, records: runtime.records, view: runtime.view } : null;
  })(),
  stored: localStorage.getItem(key),
  confirmedGraph: (() => {
    const runtime = document.querySelector("#confirmed-surface iframe[data-package=semantic-map]")?.contentWindow?.semanticMapRuntime;
    return runtime && Array.isArray(runtime.records) && runtime.records.length > 0 && typeof runtime.head === "string"
      ? { head: runtime.head, records: runtime.records, view: runtime.view } : null;
  })(),
  notice: document.querySelector("#working-notice").textContent,
  camera: document.querySelector("#camera-part").value,
  pending: document.body.dataset.pending ?? null,
  root: localStorage.getItem(rootKey),
}), [KEY, ROOT_KEY]);
const domOf = now => ({
  state: now.state, status: now.status, failure: now.failure, draftSteps: now.draft.length, draftCount: now.draftCount,
  claims: now.claims.map(claim => `${claim.record} ${claim.origins.join("+")}`),
  draft: now.draft, context: now.context, graph: now.graph, confirmedGraph: now.confirmedGraph, notice: now.notice, camera: now.camera, pending: now.pending,
});
// What the page showed last, for the summary.
let last = null;

// The requests one utterance must make, from the answers it actually got: an
// intent; then a judge of exactly [the part] when the intent names one part
// confidently; or, when it names neither the whole nor a part confidently, one
// locate frame per part the snapshot knows, and a judge of exactly every part
// its own frame answered yes confidently, sorted, if there is any. A judge is
// one request for every frame the served contract plans for the section its
// first request carries - at least one. Nothing else.
const expectedOf = sent => {
  const kinds = [contract.ARCHITECTURE_INTENT_KIND];
  const intent = sent[0]?.body?.answers;
  if (intent?.action?.choice !== contract.ACTION_ARCHITECTURE || !(intent.action.confidence >= contract.MIN_CONFIDENCE)) return { kinds, focus: null, frames: [] };
  const { choice, confidence } = intent.focus ?? {};
  const sure = confidence >= contract.MIN_CONFIDENCE;
  if (choice === contract.WHOLE && sure) return { kinds, focus: null, frames: [] };
  const judged = (before, focus) => {
    const first = sent[before.length]?.sent;
    const planned = first?.kind === contract.ARCHITECTURE_JUDGE_KIND ? framesOf(first.state.architecture).map(item => item.frame) : [];
    const frames = planned.length === 0 ? [null] : planned;
    return { kinds: [...before, ...frames.map(() => contract.ARCHITECTURE_JUDGE_KIND)], focus, frames };
  };
  if (choice !== contract.NONE && choice !== contract.WHOLE && sure) return judged(kinds, [choice]);
  const locates = ENTITY_IDS.map(() => contract.ARCHITECTURE_LOCATE_KIND);
  const found = sent.slice(1, 1 + ENTITY_IDS.length).flatMap(entry => {
    const [part] = entry.sent.state?.architecture?.focus ?? [];
    const answer = entry.body?.answers?.[contract.relevantSlot(part)];
    return answer?.choice === contract.YES && answer.confidence >= contract.MIN_CONFIDENCE ? [part] : [];
  }).sort();
  return found.length === 0
    ? { kinds: [...kinds, ...locates], focus: null, frames: [] }
    : judged([...kinds, ...locates], found);
};

// One utterance in the named stage. The page is pending from the click until
// it has finished the utterance, however it ended; then the requests it
// actually made are checked against what their own answers call for: their
// kinds and order, every one answered 200 with a complete answer, every one
// naming the served snapshot, one locate frame per part in the snapshot's
// order, each carrying the intent's utterance and conversation exactly, and a
// judge bound to exactly the parts asked for, every request of it carrying the
// same section and the utterance, and naming that section's frames once each
// in the contract's order. Anything else is a finding of this stage - never a
// wait for more.
const actions = { new: 0, send: 0, undo: 0, apply: 0, reload: 0 };
const click = async control => { actions[control]++; await page.locator("#" + control).click(); };
let stopBaseline = null;
const say = async (stage, utterance, picks) => {
  const route = new URL("/api/judge", url).href;
  if (STOP_FIXTURE) stopBaseline = await screen();
  if (FIXTURE) await page.route(route, craft(picks, () => STOP_FIXTURE ? { status: 502, body: { error: contract.ERRORS.providerError, upstreamStatus: 401 } } : null), { times: MOST });
  const before = exchanges.length;
  await page.locator("#text").fill(utterance);
  await click("send");
  await settle();
  await drain();
  if (FIXTURE) await page.unroute(route);
  const sent = exchanges.slice(before);
  const now = await screen();
  last = now;
  const answered = sent.filter(entry => entry.status !== null).length;
  let expected, planningError = null;
  try { expected = expectedOf(sent); } catch (error) {
    planningError = String(error?.message ?? error).split("\n")[0];
    expected = { kinds: [], focus: null, frames: [] };
  }
  report({ event: "turn", stage, expected: expected.kinds, requests: sent.length, answered, failed: sent.filter(entry => entry.error !== null).length,
    exchanges: sent.map(sanitized), dom: domOf(now) });
  for (const entry of sent) entry.reported = true;
  const defects = [];
  const valid = (condition, message) => { if (!condition) defects.push(message); };
  valid(planningError === null, `request plan could not be validated: ${planningError}`);
  try {
  const kinds = sent.map(entry => entry.sent.kind);
  valid(JSON.stringify(kinds) === JSON.stringify(expected.kinds), `${stage}: requests ${kinds.join(", ")} where the answers call for ${expected.kinds.join(", ")}`);
  valid(sent.every(entry => entry.status === 200 && entry.error === null && entry.body !== null
    && typeof entry.body === "object" && !Array.isArray(entry.body)
    && JSON.stringify(Object.keys(entry.body).sort()) === JSON.stringify(["answers", "kind"])
    && entry.body.kind === contract.DECISION_KIND && slotsOf(entry.sent) !== null && contract.readAnswers(entry.body?.answers, slotsOf(entry.sent)) !== null),
    `${stage}: every request answered 200 with a complete answer`);
  valid(sent.every(entry => entry.sent.kind === contract.REQUEST_KIND || entry.sent.state?.architecture?.source?.commit === SERVED_COMMIT),
    `${stage}: every request names the served snapshot`);
  const frames = sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_LOCATE_KIND);
  valid(frames.length === 0 || JSON.stringify(frames.map(entry => entry.sent.state.architecture.focus)) === JSON.stringify(ENTITY_IDS.map(id => [id])),
    `${stage}: one locate frame per part, in the snapshot's order`);
  valid(frames.every(entry => entry.sent.state.utterance === sent[0].sent.state.utterance
    && JSON.stringify(entry.sent.state.context) === JSON.stringify(sent[0].sent.state.context)),
  `${stage}: every locate frame carries the intent's utterance and conversation exactly`);
  const judges = sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND);
  valid(judges.every(entry => JSON.stringify(entry.sent.state.architecture.focus) === JSON.stringify(expected.focus)),
    `${stage}: the judge is bound to exactly ${JSON.stringify(expected.focus)}`);
  valid(judges.every(entry => JSON.stringify(entry.sent.state.architecture) === JSON.stringify(judges[0].sent.state.architecture)
    && entry.sent.state.utterance === sent[0].sent.state.utterance)
    && (judges.length === 0 || JSON.stringify(judges.map(entry => entry.sent.state.frame)) === JSON.stringify(expected.frames)),
  `${stage}: every judge frame carries the one section and the utterance, and the frames are that section's, once each and in order`);
  } catch (error) {
    defects.push(`protocol validation could not complete: ${String(error?.message ?? error).split("\n")[0]}`);
  }
  valid(errors.length === 0, `no page error: ${errors.join(" | ")}`);
  if (defects.length > 0) {
    protocolFailure = { stage, defects };
    stoppedAt = stage;
    throw PROTOCOL_HALT;
  }
  return { now, sent };
};
// The natural fixture only: one utterance - the save one, unless another is
// named with the part it is located to - whose request at place `at` (0 its
// intent, then one locate frame per part, then its judge's frames) fails as
// `fault` says. The page must ask nothing after it, and draw, draft and store
// nothing: the draft, the claims and both stored values stay exactly as they
// were just before this utterance.
const failing = async (stage, at, fault, why, { utterance = UTTERANCES.save, focus = LOG } = {}) => {
  const route = new URL("/api/judge", url).href;
  const baseline = await screen();
  await page.route(route, craft(picksFor(focus), index => (index === at ? fault : null)), { times: MOST });
  const before = exchanges.length;
  await page.locator("#text").fill(utterance);
  await click("send");
  await settle();
  await drain();
  await page.unroute(route);
  const sent = exchanges.slice(before);
  const now = await screen();
  last = now;
  const expected = Array.from({ length: at + 1 }, (_, index) => (index === 0 ? contract.ARCHITECTURE_INTENT_KIND
    : index <= ENTITY_IDS.length ? contract.ARCHITECTURE_LOCATE_KIND : contract.ARCHITECTURE_JUDGE_KIND));
  report({ event: "turn", stage, expected, requests: sent.length, answered: sent.filter(entry => entry.status !== null).length,
    failed: sent.filter(entry => entry.error !== null).length, exchanges: sent.map(sanitized), dom: domOf(now) });
  for (const entry of sent) entry.reported = true;
  need(JSON.stringify(sent.map(entry => entry.sent.kind)) === JSON.stringify(expected),
    `${stage}: nothing is asked after the failing request (${sent.length} requests, ${expected.length} expected)`);
  // What the page sent agrees with itself and the served plan - so a fault at
  // a judge's second frame lands on that frame, not on its first sent twice.
  // Nothing is said of what a server would hold; no judge sent, nothing to check.
  const judges = sent.filter(entry => entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND);
  need(judges.every((entry, index) => JSON.stringify(entry.sent.state.architecture.focus) === JSON.stringify([focus])
    && JSON.stringify(entry.sent.state.architecture) === JSON.stringify(judges[0].sent.state.architecture)
    && entry.sent.state.utterance === sent[0].sent.state.utterance
    && JSON.stringify(entry.sent.state.frame) === JSON.stringify(framesOf(judges[0].sent.state.architecture)[index]?.frame)),
  `${stage}: every judge frame sent is of [${focus}], the one section and the utterance, and they are that section's first frames in order`);
  const { displayedReason, genericReason } = await page.evaluate(async code => {
    const { reasonText } = await import("/app/src/render.mjs");
    return { displayedReason: reasonText(code), genericReason: reasonText("error") };
  }, why);
  need(typeof displayedReason === "string" && displayedReason.trim().length > 0
    && displayedReason !== genericReason
    && now.state === "failed" && (now.failure ?? "").includes(displayedReason), `${stage}: the utterance fails with ${why} (state ${now.state}: ${now.failure ?? now.status})`);
  need(JSON.stringify(now.draft) === JSON.stringify(baseline.draft) && JSON.stringify(now.claims) === JSON.stringify(baseline.claims)
    && baseline.graph !== null && JSON.stringify(now.graph) === JSON.stringify(baseline.graph)
    && now.stored === baseline.stored && now.root === baseline.root, `${stage}: nothing is drawn, drafted or stored`);
};
const claimOf = (now, record) => now.claims.find(claim => claim.record === record) ?? null;
// A role Jev gave a file, as drawn: the has-role edge, and the role's node.
const hasRole = (now, entity, role) => claimOf(now, `relation arch-has-role-${entity}-to-${role}`)?.origins.join(" ") === "model-inferred"
  && claimOf(now, `region arch-role-${role}`)?.origins.join(" ") === "scope-declared";

const verdicts = [];
const need = (condition, what) => { if (!condition) verdicts.push(what); };

// The stages in order. A stage whose outcome a later one stands on ends the
// run when it fails - nothing is undone or built on a state the next stage
// assumes - and every stage not reached is reported as not run.
const FAULTS = ["failed-frame", "incomplete-frame", "frame-extra-envelope", "judge-extra-envelope", "incomplete-judge-frame"];
const STAGES = ["open", "whole", "whole-undo", "app", "credential", "storage", "save", ...(FIXTURE ? ["save-again"] : []),
  ...(LOCATES ? FAULTS : []), "correction", "apply", "reload", ...(FIXTURE ? ["camera-pending", "resize-pending"] : [])];
const reached = [];
let stoppedAt = null;
const HALT = new Error("a stage a later one stands on failed");
const PROTOCOL_HALT = new Error("protocol failure: no later action is permitted");
let protocolFailure = null;
const prerequisite = (condition, stage) => {
  if (condition) return;
  stoppedAt = stage;
  throw HALT;
};

const APP = "web-app-mjs";
const FUNCTION = "functions-api-judge-mjs";
const WORKER = "functions-pages-worker-mjs";
const ADAPTER = "web-adapters-judgment-mjs";
const LOG = "src-log-mjs";

// What the crafted answers say in fixture mode; in live mode Jev says it.
const ROLES = {
  [APP]: ["voice-input", "jev-boundary", "graph-mutation", "persistence"],
  [FUNCTION]: ["jev-boundary", "auth"],
  [WORKER]: ["jev-boundary", "auth"],
  "dev-serve-mjs": ["auth", "config"],
  "src-config-mjs": ["config"],
  "web-data-config-v1-json": ["config"],
  "dev-architecture-config-v1-json": ["config"],
  [LOG]: ["persistence"],
};
const RELATIONS = {
  [`c-${APP}--${ADAPTER}`]: "calls",
  [`c-${APP}--ext-localstorage`]: "stores-in",
  [`c-${APP}--${LOG}`]: "calls",
  [`c-${WORKER}--ext-jev-api-key`]: "authenticates-with",
  [`c-${WORKER}--ext-voice-ui-judge-provider`]: "calls",
};
const picksFor = focus => (name, sent) => {
  if (sent.kind === contract.ARCHITECTURE_JUDGE_KIND) {
    const role = Object.entries(ROLES).flatMap(([entity, roles]) => roles.map(key => [contract.roleSlot(entity, key), key]))
      .find(([slot]) => slot === name);
    if (role !== undefined) return contract.YES;
    return name.startsWith("relation-") ? RELATIONS[name.slice("relation-".length)] : contract.NONE;
  }
  if (sent.kind === contract.ARCHITECTURE_LOCATE_KIND) return name === contract.relevantSlot(focus) ? contract.YES : contract.NONE;
  if (name === "action") return contract.ACTION_ARCHITECTURE;
  if (name === "focus") return LOCATES && focus !== contract.WHOLE ? contract.NONE : focus;
  return contract.NONE;
};
// In the natural fixture, a focus stage went through its locate.
const located = result => !LOCATES || result.sent.some(entry => entry.sent.kind === contract.ARCHITECTURE_LOCATE_KIND);
const codeIn = sent => JSON.stringify(sent).includes("export function") || JSON.stringify(sent).includes("\"evidence\"");

const inferredAt = (now, id) => claimOf(now, `relation ${id}`)?.origins.includes("model-inferred") === true;

let thrown = null;
let cleanup = null;
let rootBefore;
let applied = null;
let reloaded = null;
try {
  // The slash-less path is sent to the architecture page's own path.
  reached.push("open");
  const opened = await page.goto(PAGE, { waitUntil: "commit", timeout: 120000 });
  assert.ok(opened.url().endsWith("/architecture/"), `a 308 leads to /architecture/, not ${opened.url()}`);
  await ready();
  const start = await screen();
  last = start;
  assert.equal(start.shown, true, "the architecture account is shown on this page");
  assert.notEqual(start.state, "failed", `the prepared source must be available: ${start.failure}`);
  assert.match(start.sourceStatus, /^出典: apps-voice-ui@[0-9a-f]{40}$/u);
  assert.ok(start.coverage.some(line => /dynamic import/u.test(line)), "what was not analyzed is listed");
  assert.ok(start.coverage.some(line => /取り込み対象外: dist\.py/u.test(line)), "what was not admitted is listed");
  rootBefore = start.root;

  // The person names a new map; nothing is saved yet.
  await page.locator("#text").fill("voice-ui の構成");
  await click("new");
  await settle();
  assert.equal((await screen()).state, "drafted");

  // (1) The whole architecture: structure only, one request, no code sent.
  reached.push("whole");
  const whole = await say("whole", UTTERANCES.whole, picksFor(contract.WHOLE));
  need(whole.sent.length === 1 && whole.sent[0].sent.kind === contract.ARCHITECTURE_INTENT_KIND, "the whole view is one intent");
  need(whole.sent.every(entry => !codeIn(entry.sent)), "the page never sends source text");
  need(whole.now.state === "drafted", `the whole view was drafted (state ${whole.now.state}: ${whole.now.failure ?? whole.now.status})`);
  need(claimOf(whole.now, `region arch-${APP}`)?.origins.includes("source-declared"), "the page's file is drawn from the source");
  need(whole.now.claims.every(claim => !claim.origins.includes("model-inferred") && !claim.origins.includes("scope-declared")),
    "the whole view judges nothing: no role, no role node, no chosen relation");
  need(/未反映: 2 \/ 8/u.test(whole.now.draftCount), `the whole view counts as one utterance (${whole.now.draftCount})`);
  // Undo would otherwise take back the new map itself.
  prerequisite(whole.now.state === "drafted", "whole");

  // Undo takes the whole utterance back - every Decision it added.
  let cameraControlBefore;
  let cameraControlRequests;
  if (FIXTURE) {
    await page.locator("#camera-part").selectOption(`arch-${APP}`);
    await settle();
    cameraControlBefore = await screen();
    cameraControlRequests = exchanges.length;
    assert.equal(cameraControlBefore.camera, `arch-${APP}`);
  }
  reached.push("whole-undo");
  await click("undo");
  await settle();
  const undone = await screen();
  if (FIXTURE) {
    assert.equal(undone.camera, "", "Undo reconciles the disappeared draft camera to overview");
    assert.equal(undone.draft.length, 1, "selected draft camera does not block Undo");
    assert.equal(exchanges.length, cameraControlRequests, "camera and Undo make no judgment requests");
    for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(undone[key], cameraControlBefore[key], key);
    report({ event: "camera-undo", requests: 0, dom: domOf(undone) });
  }
  last = undone;
  report({ event: "turn", stage: "whole-undo", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(undone) });
  need(undone.draft.length === 1 && undone.claims.every(claim => !claim.record.startsWith("region arch-")),
    `Undo takes the whole view back (${undone.draft.length} steps left)`);
  prerequisite(undone.draft.length === 1, "whole-undo");
  if (FIXTURE) {
    // A separate crafted draft exercises failed rendering and Discard.
    // The natural/live scenario above and all its original utterances stay unchanged.
    const draft = await say("camera-discard-draft", UTTERANCES.whole, picksFor(contract.WHOLE));
    assert.equal(draft.now.state, "drafted");
    await page.locator("#camera-part").selectOption(`arch-${APP}`);
    await settle();
    const before = await screen();
    const requests = exchanges.length;
    await page.evaluate(() => {
      const mount = document.querySelector("#working-surface"), append = mount.append;
      mount.append = function (...nodes) { mount.append = append; throw new Error("controlled first-pane insertion failure"); };
    });
    await click("undo");
    await settle();
    const failed = await screen();
    assert.equal(failed.state, "failed");
    for (const key of ["camera", "graph", "draft", "claims", "stored", "root", "confirmedGraph"]) assert.deepEqual(failed[key], before[key], key);
    assert.equal(exchanges.length, requests, "failed Undo makes no judgment requests");
    report({ event: "camera-undo-render-failure", requests: 0, dom: domOf(failed) });
    await page.locator("#discard").click();
    await settle();
    const discarded = await screen();
    assert.equal(discarded.graph, null);
    assert.equal(discarded.camera, "", "Discard with no Accepted graph clears the disappeared camera");
    assert.equal(discarded.draft.length, 0);
    for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(discarded[key], before[key], key);
    report({ event: "camera-discard", requests: 0, dom: domOf(discarded) });
    await page.locator("#text").fill("voice-ui の構成");
    await click("new");
    await settle();
    const renewed = await screen();
    assert.equal(renewed.state, "drafted", "New is not blocked by the discarded camera");
    assert.equal(renewed.camera, "");
    assert.equal(renewed.draft.length, 1);
    assert.equal(exchanges.length, requests, "Discard and New make no judgment requests");
    for (const key of ["stored", "root", "confirmedGraph"]) assert.deepEqual(renewed[key], before[key], key);
    report({ event: "camera-discard-new", requests: 0, dom: domOf(renewed) });
  }

  // (2) The page's own code: its roles, its call to the Worker, its storage.
  reached.push("app");
  const app = await say("app", UTTERANCES.app, picksFor(APP));
  need(app.sent.at(-1)?.sent.kind === contract.ARCHITECTURE_JUDGE_KIND, "a focused utterance ends in a judge of its parts");
  need(located(app), "the natural fixture located the page's part");
  need(app.sent.every(entry => entry.status === 200), `every request was answered (${app.sent.map(entry => entry.status).join(", ")})`);
  need(app.sent.every(entry => !codeIn(entry.sent)), "the page sends no code in any request; the server adds it");
  for (const role of ["voice-input", "jev-boundary", "graph-mutation", "persistence"]) need(hasRole(app.now, APP, role), `the page's file is judged ${role}`);
  need(claimOf(app.now, `region arch-${APP}`)?.origins.join(" ") === "source-declared", "the file itself stays the source's");
  need(inferredAt(app.now, `arch-calls-${APP}-to-${ADAPTER}`), "the page invokes the judgment adapter, not a transitive direct Worker call");
  need(claimOf(app.now, "relation arch-import-functions-pages-worker-mjs-to-functions-api-judge-mjs")?.origins.includes("source-declared"),
    "the Worker imports the Function, as the source declares");
  need(inferredAt(app.now, `arch-stores-in-${APP}-to-ext-localstorage`), "the page stores in localStorage");
  // Every later stage stands on the structure this utterance drew.
  prerequisite(app.now.state === "drafted", "app");

  // (3) The credential: the Function authenticates with it and calls the provider.
  reached.push("credential");
  const auth = await say("credential", UTTERANCES.credential, picksFor("ext-jev-api-key"));
  need(located(auth), "the natural fixture located the credential");
  need(auth.sent.every(entry => entry.status === 200), `the credential focus was answered (${auth.sent.map(entry => entry.status).join(", ")})`);
  need(inferredAt(auth.now, `arch-authenticates-with-${WORKER}-to-ext-jev-api-key`), "the Worker holds and passes the credential");
  need(inferredAt(auth.now, `arch-calls-${WORKER}-to-ext-voice-ui-judge-provider`), "the Worker invokes the imported provider binding");
  need(claimOf(auth.now, "region arch-ext-voice-ui-judge-provider")?.origins.join(" ") === "unknown", "the non-admitted provider alias stays unknown");
  need(claimOf(auth.now, "region arch-ext-jev-api-key")?.origins.join(" ") === "unknown", "the credential itself stays unknown");
  need(hasRole(auth.now, WORKER, "auth"), "the Worker is judged as holding or passing a credential, not as implementing provider HTTP authorization");

  // (4) Storage: every admitted file that names it, whole.
  reached.push("storage");
  const stored = await say("storage", UTTERANCES.storage, picksFor("ext-localstorage"));
  need(located(stored), "the natural fixture located the storage");
  need(stored.sent.every(entry => entry.status === 200), `the storage focus was answered (${stored.sent.map(entry => entry.status).join(", ")})`);
  // The four files that name localStorage, from the served manifest: exactly
  // these for the named part; for a natural request all of them, any other
  // body only because the judged section - the server's own, for exactly the
  // located parts - opens it.
  const STORAGE_FILES = MANIFEST.candidates.filter(candidate => candidate.to === "ext-localstorage").map(candidate => candidate.from).sort();
  const storageBodies = [...(stored.sent.at(-1)?.sent.kind === contract.ARCHITECTURE_JUDGE_KIND ? stored.sent.at(-1).sent.state.architecture.bodies : [])].sort();
  need(JSON.stringify(STORAGE_FILES) === JSON.stringify(["dev-architecture-config-v1-json", "src-config-mjs", "web-app-mjs", "web-data-config-v1-json"]),
    `the snapshot's files that name localStorage are the original four (${STORAGE_FILES.join(", ")})`);
  need(scenario === "named"
    ? JSON.stringify(storageBodies) === JSON.stringify(STORAGE_FILES)
    : STORAGE_FILES.every(file => storageBodies.includes(file)),
  `the storage section opens ${scenario === "named" ? "exactly" : "all of"} the four files that name it (${storageBodies.join(", ")})`);
  need(hasRole(stored.now, "src-config-mjs", "config"), "the config module is judged config");

  // (5) A fresh source-bound judgment may add a missing role or acknowledge
  // an already present role. No-change alone is not success.
  reached.push("save");
  need(inferredAt(stored.now, `arch-calls-${APP}-to-${LOG}`), "the page -> decision log relation is already there");
  const beforeSave = await screen();
  const saveAgain = () => say("save", UTTERANCES.save, picksFor(LOG));
  const save = await saveAgain();
  const judgedPersistence = result => result.sent.some(entry => entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND
    && entry.sent.state.architecture.focus.includes(LOG)
    && entry.body?.answers?.[contract.roleSlot(LOG, "persistence")]?.choice === contract.YES
    && entry.body.answers[contract.roleSlot(LOG, "persistence")].confidence >= contract.MIN_CONFIDENCE);
  const acknowledged = (before, after) => {
    const last = after.context.at(-1);
    return last?.text === UTTERANCES.save && last.source === "typed" && last.outcome === "no-change"
      && last.seq > (before.context.at(-1)?.seq ?? 0)
      && JSON.stringify(after.context.slice(0, -1)) === JSON.stringify(before.context.slice(-(contract.CONTEXT_MAX - 1)));
  };
  const stable = (before, after) => JSON.stringify(after.claims) === JSON.stringify(before.claims)
    && JSON.stringify(after.draft) === JSON.stringify(before.draft)
    && before.graph !== null && JSON.stringify(after.graph) === JSON.stringify(before.graph);
  need(located(save), "the natural fixture located the decision log");
  need(save.sent.every(entry => entry.status === 200) && judgedPersistence(save), "fresh focused completed judgments affirm log persistence");
  const existing = hasRole(beforeSave, LOG, "persistence");
  need(existing
    ? save.now.state === "no-change" && stable(beforeSave, save.now) && acknowledged(beforeSave, save.now)
    : save.now.state === "drafted",
  `the log's role is ${existing ? "freshly acknowledged with stable graph/draft and appended conversation" : "newly drafted"} (state ${save.now.state})`);
  need(hasRole(save.now, LOG, "persistence"), "the decision log is judged persistence with its required provenance");
  need(claimOf(save.now, `relation arch-import-${APP}-to-${LOG}`)?.origins.includes("source-declared"), "the page imports the decision log");
  need(save.now.claims.every(claim => !(claim.record.startsWith("relation arch-import-") && claim.origins.includes("model-inferred"))),
    "an import edge is never model-inferred");
  if (FIXTURE) {
    prerequisite(existing ? save.now.state === "no-change" : save.now.state === "drafted", "save");
    reached.push("save-again");
    const repeat = await saveAgain();
    need(judgedPersistence(repeat) && repeat.now.state === "no-change" && stable(save.now, repeat.now)
      && acknowledged(save.now, repeat.now), "a repeated fresh affirmative role preserves graph/draft and appends its acknowledgement");
    if (!existing) {
      await click("undo");
      await settle();
      const back = await screen();
      need(!hasRole(back, LOG, "persistence") && claimOf(back, "region arch-role-persistence") !== null,
        "Undo removes the newly added log role and keeps the shared persistence node");
      need(hasRole((await saveAgain()).now, LOG, "persistence"), "a fresh judgment draws the missing role again");
    }
  }
  if (LOCATES) {
    // A failure part-way through an utterance leaves everything as it was: a
    // frame that fails, a frame answered 200 without its question, a locate or judge
    // with an unexpected envelope field, and - for storage, whose judge has
    // several frames - a judge's second frame answered 200 without its questions: after each, nothing is asked.
    const middle = 1 + Math.floor(ENTITY_IDS.length / 2);
    reached.push("failed-frame");
    await failing("failed-frame", middle, { status: 502, body: { error: contract.ERRORS.providerError } }, contract.ERRORS.providerError);
    reached.push("incomplete-frame");
    await failing("incomplete-frame", middle, { answers: {} }, "judge-contract");
    reached.push("frame-extra-envelope");
    await failing("frame-extra-envelope", middle, { extra: { model: "unexpected-provider-label" } }, "judge-contract");
    reached.push("judge-extra-envelope");
    await failing("judge-extra-envelope", 1 + ENTITY_IDS.length, { extra: { model: "unexpected-provider-label" } }, "judge-contract");
    reached.push("incomplete-judge-frame");
    await failing("incomplete-judge-frame", 1 + ENTITY_IDS.length + 1, { answers: {} }, "judge-contract",
      { utterance: UTTERANCES.storage, focus: "ext-localstorage" });
  }
  const judgedDraft = (await screen()).draft.length;

  // (6) A correction by the person: the judged storage relation is taken out -
  // one more utterance - and Undo takes it back.
  reached.push("correction");
  const storageEdge = `arch-stores-in-${APP}-to-ext-localstorage`;
  const corrected = await say("correction", UTTERANCES.correction, (name, sent) => {
    if (name === "action") return "remove-edge";
    if (name === "edge") return sent.state.graph.edges.find(edge => edge.id === storageEdge)?.id;
    return contract.NONE;
  });
  const removedOne = corrected.now.draft.length === judgedDraft + 1 && claimOf(corrected.now, `relation ${storageEdge}`) === null;
  need(removedOne, `the person's correction removes the judged relation as one more step (state ${corrected.now.state}: `
    + `${corrected.now.failure ?? corrected.now.status})`);
  if (removedOne) {
    await click("undo");
    await settle();
    need(claimOf(await screen(), `relation ${storageEdge}`) !== null, "Undo brings the judged relation back");
  }

  // Apply saves the new map and every view.
  reached.push("apply");
  await click("apply");
  await settle();
  applied = await screen();
  last = applied;
  report({ event: "turn", stage: "apply", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(applied) });
  need(applied.state === "applied", `Apply saved the document (state ${applied.state}: ${applied.failure ?? applied.status})`);
  need(applied.stored?.startsWith('{"schema":"voice-ui.architecture-document/1"'), "the architecture key holds the document");
  need(applied.root === rootBefore, "the plain page's stored value is untouched");
  need(applied.confirmedGraph !== null && JSON.stringify(applied.confirmedGraph.view) === JSON.stringify(applied.graph?.view), "Apply gives both panes the same settled view");
  need(applied.notice.includes("保存済み") && !applied.notice.includes("消えます"), "verified Apply has no unsaved warning");
  need(applied.stored !== null && !applied.stored.includes("export function") && !applied.stored.includes("confidence"),
    "no source text, raw answer or confidence is saved");

  // Reload restores the same graph with every claim and role, checked against the source.
  reached.push("reload");
  actions.reload++;
  await page.reload({ waitUntil: "commit" });
  await ready();
  reloaded = await screen();
  last = reloaded;
  report({ event: "turn", stage: "reload", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(reloaded) });
  need(reloaded.state === "restored", `reload restores the document (state ${reloaded.state}: ${reloaded.failure ?? reloaded.status})`);
  need(reloaded.stored === applied.stored, "reload does not rewrite the document");
  need(reloaded.confirmedGraph !== null && JSON.stringify(reloaded.confirmedGraph.view) === JSON.stringify(reloaded.graph?.view), "reload gives both panes the same settled view");
  need(reloaded.notice.includes("保存済み") && !reloaded.notice.includes("消えます"), "verified restore has no unsaved warning");
  need(JSON.stringify(reloaded.claims) === JSON.stringify(applied.claims), "the same records and origins come back");
  need(applied.graph !== null && reloaded.graph !== null
    && JSON.stringify(reloaded.graph.records) === JSON.stringify(applied.graph.records)
    && JSON.stringify(reloaded.graph.view) === JSON.stringify(applied.graph.view), "the complete rendered records and view come back");
  const originsAfter = [...new Set(reloaded.claims.flatMap(claim => claim.origins))].sort();
  need(JSON.stringify(originsAfter) === JSON.stringify(["model-inferred", "scope-declared", "source-declared", "unknown", "user-asserted"]),
    `all five origins come back (${originsAfter.join(", ")})`);
  need(hasRole(reloaded, LOG, "persistence") && hasRole(reloaded, APP, "persistence"), "the roles come back as drawn");
  need(/^出典: apps-voice-ui@/u.test(reloaded.sourceStatus), "the cited snapshot is still checkable");
  if (FIXTURE) {
    let beforeCamera = reloaded;
    const choices = await page.locator("#camera-part option").evaluateAll(options => options.filter(option => option.value).map(option => ({ id: option.value, label: option.textContent })));
    const file = choices.find(option => option.label === "web/app.mjs");
    assert.ok(file, "the actual source-file camera is offered");
    const long = choices.reduce((best, option) => option.label.length > best.label.length ? option : best, file);
    const heldPlacement = stage => say(stage, "fixture incomplete placement", name => ({
      action: contract.ACTION_PLACE_PART, move: file.id,
      anchor: { choice: choices.find(option => option.id !== file.id).id, confidence: 0.39 }, direction: "right",
    })[name] ?? contract.NONE);
    reached.push("camera-pending");
    const heldCamera = await heldPlacement("camera-pending");
    assert.equal(heldCamera.now.pending, "anchor", "the controlled placement really holds its missing anchor");
    await page.locator("#camera-part").selectOption(file.id);
    await settle();
    const clearedCamera = await screen();
    assert.equal(clearedCamera.pending, null, "camera deliberately clears the existing held placement");
    for (const key of ["draft", "claims", "context", "stored"]) assert.deepEqual(clearedCamera[key], heldCamera.now[key], key);
    assert.deepEqual(clearedCamera.graph.records, heldCamera.now.graph.records);
    assert.equal(clearedCamera.graph.head, heldCamera.now.graph.head);
    report({ event: "camera-clears-pending", dom: domOf(clearedCamera) });
    beforeCamera = clearedCamera;
    const labelVisible = label => page.evaluate(label => {
      const iframe = document.querySelector("#working-surface iframe[data-package=semantic-map]");
      const doc = iframe.contentDocument;
      return [...doc.querySelectorAll("svg text, svg foreignObject")].some(node => {
        const rect = node.getBoundingClientRect(), style = iframe.contentWindow.getComputedStyle(node);
        return node.textContent.includes(label) && rect.width > 0 && rect.height > 0
          && rect.right > 0 && rect.bottom > 0 && rect.left < iframe.clientWidth && rect.top < iframe.clientHeight
          && style.display !== "none" && style.visibility !== "hidden";
      });
    }, label);
    for (const chosen of [file, long]) {
      await page.locator("#camera-part").selectOption(chosen.id);
      await settle();
      const focused = await screen();
      assert.equal(focused.state, "camera", focused.status);
      assert.deepEqual(focused.graph.records, beforeCamera.graph.records);
      assert.deepEqual(focused.confirmedGraph.view, focused.graph.view);
      assert.deepEqual(focused.context, beforeCamera.context, "camera does not create conversational reference");
      assert.equal(focused.stored, beforeCamera.stored);
      const visible = await labelVisible(chosen.label);
      if (chosen === file) assert.equal(visible, true, "the actual source-file label is visible in the rendered graph");
      else if (!visible) assert.match(focused.status, /長いラベルは収まらない/u, "long-label limitation is explicit, not a math-only readability claim");
      report({ event: "camera", part: chosen.id, label: chosen.label, labelVisible: visible, dom: domOf(focused) });
    }
    await page.locator("#camera-part").selectOption("");
    await settle();
    const viewport = page.viewportSize();
    reached.push("resize-pending");
    const heldResize = await heldPlacement("resize-pending");
    assert.equal(heldResize.now.pending, "anchor");
    await page.setViewportSize({ ...viewport, height: viewport.height + 20 });
    await page.waitForFunction(() => document.body.dataset.state === "resized");
    const clearedResize = await screen();
    assert.equal(clearedResize.pending, null, "resize deliberately clears the existing held placement");
    for (const key of ["draft", "claims", "context", "stored"]) assert.deepEqual(clearedResize[key], heldResize.now[key], key);
    assert.deepEqual(clearedResize.graph.records, heldResize.now.graph.records);
    assert.equal(clearedResize.graph.head, heldResize.now.graph.head);
    report({ event: "resize-clears-pending", dom: domOf(clearedResize) });
    await Promise.all([
      page.locator("#camera-part").selectOption(file.id),
      page.setViewportSize({ ...viewport, height: viewport.height + 40 }),
    ]);
    await page.waitForFunction(() => {
      const mount = document.querySelector("#working-surface"), runtime = mount.querySelector("iframe")?.contentWindow?.semanticMapRuntime;
      return document.body.dataset.state !== "pending" && runtime?.view?.frame?.viewport?.[1] === mount.clientHeight;
    });
    const resized = await screen();
    assert.deepEqual(resized.confirmedGraph.view, resized.graph.view, "locked resize eventually synchronizes both panes");
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => document.body.dataset.state !== "pending");
    await page.locator("#camera-part").selectOption("");
    await settle();
    // Fail the second pane after the working pane adopted its new frame.
    // This changes neither the graph nor provider requests.
    await page.evaluate(() => {
      const mount = document.querySelector("#confirmed-surface");
      const append = mount.append;
      mount.append = function (...nodes) { mount.append = append; throw new Error("controlled second-pane insertion failure"); };
    });
    await page.locator("#camera-part").selectOption(file.id);
    await settle();
    const failedPair = await screen();
    assert.equal(failedPair.state, "view-unverified");
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#camera-part").isDisabled(), true);
    assert.equal(failedPair.stored, beforeCamera.stored);
    assert.deepEqual(failedPair.graph.records, beforeCamera.graph.records);
    assert.deepEqual(failedPair.draft, beforeCamera.draft);
    assert.match(failedPair.notice, /保存内容は確認済み.*表示を確認できません/u);
    report({ event: "camera-failure", dom: domOf(failedPair) });
    // Resize during the fixture recovery reload: queue until boot has a
    // session, rather than throwing or permanently dropping dimensions.
    await Promise.all([page.reload({ waitUntil: "commit" }), page.setViewportSize({ ...viewport, height: viewport.height + 24 })]);
    await ready();
    await page.waitForFunction(() => {
      const mount = document.querySelector("#working-surface"), runtime = mount.querySelector("iframe")?.contentWindow?.semanticMapRuntime;
      return runtime?.view?.frame?.viewport?.[1] === mount.clientHeight;
    });
    const recovered = await screen();
    assert.equal(recovered.camera, "", "camera is ephemeral, not restored from storage");
    assert.deepEqual(recovered.confirmedGraph.view, recovered.graph.view);
    assert.equal(recovered.stored, beforeCamera.stored);
    assert.deepEqual(recovered.graph.records, beforeCamera.graph.records);
    report({ event: "camera-recovered", dom: domOf(recovered) });
  }
} catch (error) {
  thrown = error;
  if (stoppedAt === null) stoppedAt = reached.at(-1) ?? "open";
} finally {
  // Every body is read (no read rejects: each ends in its own record) and the
  // browser closed, however the run ended; a failure to close is kept.
  await drain();
  await browser.close().catch(error => {
    cleanup = String(error?.message ?? error).split("\n")[0];
  });
}
need(errors.length === 0, `no page error: ${errors.join(" | ")}`);

const answered = exchanges.filter(entry => entry.status === 200);
const providerIdentity = "UNKNOWN";
const failure = thrown === null || thrown === HALT || thrown === PROTOCOL_HALT ? null : String(thrown?.message ?? thrown).split("\n")[0];
report({
  event: "summary", mode, scenario, stoppedAt, error: failure, cleanup, protocolFailure, actions, verdicts, notRun: STAGES.filter(stage => !reached.includes(stage)),
  requests: exchanges.length, answered: exchanges.filter(entry => entry.status !== null).length,
  failed: exchanges.filter(entry => entry.error !== null).length,
  non200: exchanges.filter(entry => entry.status !== null && entry.status !== 200).length, providerIdentity,
  // Whatever no turn reported - a turn that ended in an error - in full.
  unreported: exchanges.filter(entry => !entry.reported).map(sanitized),
});

const shown = last?.claims ?? [];
const summary = `${answered.length}/${exchanges.length} HTTP200 neutral judgment exchanges (provider identity UNKNOWN), `
  + `${shown.length} claimed records, ${shown.filter(claim => claim.origins.includes("model-inferred")).length} with model-inferred claims, `
  + `${shown.filter(claim => claim.record.startsWith("relation arch-has-role-")).length} has-role edges`
  + (stoppedAt === null ? "" : ` | stopped after ${stoppedAt}`);
if (failure !== null) {
  // An error of the run itself is never a verdict: it is reported and rethrown.
  process.stdout.write(`${LABEL}: ERROR | ${failure}${cleanup === null ? "" : ` | close failed: ${cleanup}`} | ${summary}\n`);
  throw thrown;
}
if (cleanup !== null) {
  // A browser that could not be closed makes the run an error, whatever it found.
  process.stdout.write(`${LABEL}: ERROR | close failed: ${cleanup} | ${summary}\n`);
  process.exitCode = 1;
} else if (STOP_FIXTURE) {
  assert.equal(thrown, PROTOCOL_HALT);
  assert.equal(stoppedAt, "whole");
  assert.deepEqual(reached, ["open", "whole"]);
  assert.deepEqual(actions, { new: 1, send: 1, undo: 0, apply: 0, reload: 0 });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].status, 502);
  assert.equal(exchanges[0].body?.error, contract.ERRORS.providerError);
  assert.equal(sanitized(exchanges[0]).upstreamStatus, 401);
  for (const upstreamStatus of [300,599,undefined,null,"401",200,299,600,401.5,NaN,{}]) {
    const entry = { ...exchanges[0], body: { error: contract.ERRORS.providerError, upstreamStatus } };
    const allowed = Number.isInteger(upstreamStatus) && upstreamStatus >= 300 && upstreamStatus <= 599;
    assert.equal(sanitized(entry).upstreamStatus, allowed ? upstreamStatus : "UNKNOWN");
  }
  assert.equal(sanitized({ ...exchanges[0], status: 200 }).upstreamStatus, "UNKNOWN");
  assert.equal(sanitized({ ...exchanges[0], body: { error: contract.ERRORS.providerContract, upstreamStatus: 401 } }).upstreamStatus, "UNKNOWN");
  const observed = { ...exchanges[0], body: { error: contract.ERRORS.providerError, upstreamStatus: 400, diagnostic: "context-limit-vocabulary-observed" } };
  assert.equal(sanitized(observed).diagnostic, "context-limit-vocabulary-observed");
  for (const diagnostic of [undefined,null,"private-diagnostic-canary",{},["context-limit-vocabulary-observed"],400]) {
    const reported = sanitized({ ...observed, body: { ...observed.body, diagnostic } });
    assert.equal(reported.diagnostic, "UNKNOWN");assert.ok(!JSON.stringify(reported).includes("private-diagnostic-canary"));
  }
  assert.equal(sanitized({ ...observed, status: 200 }).diagnostic, "UNKNOWN");
  assert.equal(sanitized({ ...observed, body: { ...observed.body, upstreamStatus: 401 } }).diagnostic, "UNKNOWN");
  assert.equal(sanitized({ ...observed, body: { ...observed.body, error: contract.ERRORS.providerContract } }).diagnostic, "UNKNOWN");
  assert.equal(sanitized({ ...exchanges[0], body: { answers: null } }).answers, null);
  for (const error of ["private-canary", { detail: "private-canary" }, ["private-canary"], 401, true]) {
    const reported = sanitized({ ...exchanges[0], error: null, body: { error, upstreamStatus: 401 } });
    assert.equal(reported.error, "UNKNOWN");
    assert.equal(reported.upstreamStatus, "UNKNOWN");
    assert.ok(!JSON.stringify(reported).includes("private-canary"));
  }
  for (const error of Object.values(contract.ERRORS))
    assert.equal(sanitized({ ...exchanges[0], error: null, body: { error } }).error, error);
  for (const error of ["body-unreadable", "transport-failed"])
    assert.equal(sanitized({ ...exchanges[0], error }).error, error);
  assert.equal(sanitized({ ...exchanges[0], error: "private-canary" }).error, "UNKNOWN");
  assert.equal(last.state, "failed");
  assert.equal(protocolFailure?.stage, "whole");
  assert.ok(protocolFailure.defects.includes("whole: every request answered 200 with a complete answer"));
  assert.equal(cleanup, null);
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("apply"));
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("reload"));
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("camera-pending"));
  assert.ok(STAGES.filter(stage => !reached.includes(stage)).includes("resize-pending"));
  assert.ok(exchanges.every(entry => entry.reported));
  assert.deepEqual(last.graph, stopBaseline.graph);
  assert.deepEqual(last.claims, stopBaseline.claims);
  assert.deepEqual(last.draft, stopBaseline.draft);
  assert.equal(last.stored, stopBaseline.stored);
  assert.equal(last.root, stopBaseline.root);
  assert.deepEqual(verdicts, []);
  process.stdout.write(`${LABEL}: PASS stop mechanics only (simulated protocol RED, no later actions) | ${summary}\n`);
} else if (protocolFailure !== null) {
  process.stdout.write(`${LABEL}: PROTOCOL_RED | ${protocolFailure.defects.join("; ")} | ${summary}\n`);
  process.exitCode = 1;
} else if (FIXTURE) {
  assert.deepEqual(verdicts, [], "the page's mechanics");
  assert.equal(stoppedAt, null, "every stage ran");
  assert.equal(providerIdentity, "UNKNOWN", "the neutral envelope never proves a provider identity");
  process.stdout.write(`${LABEL}: PASS mechanics only (crafted answers) | ${summary}\n`);
} else if (verdicts.length > 0 || stoppedAt !== null) {
  process.stdout.write(`${LABEL}: NOT_PASS | ${verdicts.join("; ")} | ${summary}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${LABEL}: PASS local source-dev only, typed input (not the microphone gate)`
    + `${scenario === "named" ? ", named targets only - never a PASS of the natural scenario" : ""} | ${summary}\n`);
}
