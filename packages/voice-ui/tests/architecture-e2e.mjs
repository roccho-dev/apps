import assert from "node:assert/strict";
import { createRequire } from "node:module";
// The approved acceptance runtime supplies this pinned dependency, never npm at run time.
const { chromium } = createRequire(import.meta.url)("playwright-core");

// The architecture page end to end, in exactly one explicitly named mode:
//
//   fixture  every /api/jev answer is crafted by this test at the network from
//            the request the page actually sent. It proves the page's own
//            mechanics - request, plan, claims, draft, Undo, Apply, reload -
//            and is never evidence about Jev or the code.
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
// node architecture-e2e.mjs --mode fixture|live <url of the dev server root>
const [flag, mode, url] = process.argv.slice(2);
if (flag !== "--mode" || !["fixture", "live"].includes(mode) || !url) {
  throw new Error("usage: architecture-e2e.mjs --mode fixture|live <url>");
}
const FIXTURE = mode === "fixture";
const PAGE = new URL("/architecture", url).href;
const ROOT_KEY = "voice-ui.decision-log.v1";

// The contract as the target serves it, never a copy kept here.
const served = await fetch(new URL("/app/src/contract.mjs", url));
assert.equal(served.status, 200, "the target serves its contract module");
const contract = await import(`data:text/javascript;base64,${Buffer.from(await served.text()).toString("base64")}`);
const config = await (await fetch(new URL("/architecture/data/config.v1.json", url))).json();
const KEY = config.persistence.key;

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));

// Every request the page makes to /api/jev, held by the browser's own request
// object, as it was sent and as it ended: answered with a status and a body
// read whole - or "body-unreadable" - or failed with the browser's own error
// text, and how long until then. A body is read once, and every read is
// awaited before anything is reported. Each is marked once a turn reports it.
const exchanges = [];
page.on("request", request => {
  if (new URL(request.url()).pathname !== "/api/jev") return;
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
  entry.error = request.failure()?.errorText ?? "failed";
  entry.ms = Date.now() - entry.at;
});
const drain = () => Promise.all(exchanges.map(entry => entry.read));

// What of an exchange may be printed: its kind, a judge's focus and body file
// ids, how it ended, the model and the closed answers as choice and confidence.
const sanitized = entry => ({
  kind: entry.sent.kind,
  ...(entry.sent.kind === contract.ARCHITECTURE_JUDGE_KIND
    ? { focus: entry.sent.state.architecture.focus, bodies: entry.sent.state.architecture.bodies }
    : {}),
  status: entry.status,
  error: entry.error ?? entry.body?.error ?? null,
  ms: entry.ms,
  model: entry.body?.model ?? null,
  answers: entry.body?.answers === undefined ? null
    : Object.fromEntries(Object.entries(entry.body.answers).map(([name, answer]) => [name, [answer?.choice ?? null, answer?.confidence ?? null]])),
});
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);

// Fixture mode only: the answer to a request, crafted from its own questions -
// an intent's or a judge's, each as the served contract derives them.
const craft = picks => async route => {
  const sent = JSON.parse(route.request().postData());
  const slots = sent.kind === contract.ARCHITECTURE_JUDGE_KIND ? contract.judgeSlotsFor(sent.state.architecture) : contract.slotsFor(sent.state);
  const answers = Object.fromEntries(Object.entries(slots).map(([name, options]) => {
    const picked = picks(name, sent);
    return [name, { type: "choice", choice: options.includes(picked) ? picked : contract.NONE, confidence: 0.9 }];
  }));
  await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ kind: contract.DECISION_KIND, model: "crafted-by-test", answers }) });
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
  stored: localStorage.getItem(key),
  root: localStorage.getItem(rootKey),
}), [KEY, ROOT_KEY]);
const domOf = now => ({
  state: now.state, status: now.status, failure: now.failure, draftSteps: now.draft.length, draftCount: now.draftCount,
  claims: now.claims.map(claim => `${claim.record} ${claim.origins.join("+")}`),
});
// What the page showed last, for the summary.
let last = null;

// One utterance in the named stage, expected to make `calls` requests: an
// intent, and a judge when the intent names one part. The page is pending
// from the click until it has finished the utterance, however it ended; then
// the requests it actually made are counted. Fewer or more, or any not
// answered, is a finding of this stage - never a wait for more.
const say = async (stage, utterance, picks, calls) => {
  const route = new URL("/api/jev", url).href;
  if (FIXTURE) await page.route(route, craft(picks), { times: calls });
  const before = exchanges.length;
  await page.locator("#text").fill(utterance);
  await page.locator("#send").click();
  await settle();
  await drain();
  if (FIXTURE) await page.unroute(route);
  const sent = exchanges.slice(before);
  const now = await screen();
  last = now;
  const answered = sent.filter(entry => entry.status !== null).length;
  report({ event: "turn", stage, expected: calls, requests: sent.length, answered, failed: sent.filter(entry => entry.error !== null).length,
    exchanges: sent.map(sanitized), dom: domOf(now) });
  for (const entry of sent) entry.reported = true;
  need(sent.length === calls && answered === calls, `${stage}: ${calls} requests expected, ${sent.length} made, ${answered} answered`);
  return { now, sent };
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
const STAGES = ["open", "whole", "whole-undo", "app", "credential", "storage", "save", ...(FIXTURE ? ["save-again"] : []),
  "correction", "apply", "reload"];
const reached = [];
let stoppedAt = null;
const HALT = new Error("a stage a later one stands on failed");
const prerequisite = (condition, stage) => {
  if (condition) return;
  stoppedAt = stage;
  throw HALT;
};

const APP = "web-app-mjs";
const FUNCTION = "functions-api-jev-mjs";
const LOG = "src-log-mjs";

// What the crafted answers say in fixture mode; in live mode Jev says it.
const ROLES = {
  [APP]: ["voice-input", "jev-boundary", "graph-mutation", "persistence"],
  [FUNCTION]: ["jev-boundary", "auth"],
  "dev-serve-mjs": ["auth", "config"],
  "src-config-mjs": ["config"],
  "web-data-config-v1-json": ["config"],
  "dev-architecture-config-v1-json": ["config"],
  [LOG]: ["persistence"],
};
const RELATIONS = {
  [`c-${APP}--functions-pages-worker-mjs`]: "calls",
  [`c-${APP}--ext-localstorage`]: "stores-in",
  [`c-${APP}--${LOG}`]: "calls",
  [`c-${FUNCTION}--ext-jev-api-key`]: "authenticates-with",
  [`c-${FUNCTION}--ext-api-typesafe-ai`]: "calls",
};
const picksFor = focus => (name, sent) => {
  if (sent.kind === contract.ARCHITECTURE_JUDGE_KIND) {
    const role = Object.entries(ROLES).flatMap(([entity, roles]) => roles.map(key => [contract.roleSlot(entity, key), key]))
      .find(([slot]) => slot === name);
    if (role !== undefined) return contract.YES;
    return name.startsWith("relation-") ? RELATIONS[name.slice("relation-".length)] : contract.NONE;
  }
  if (name === "action") return contract.ACTION_ARCHITECTURE;
  if (name === "focus") return focus;
  return contract.NONE;
};
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
  await page.locator("#new").click();
  await settle();
  assert.equal((await screen()).state, "drafted");

  // (1) The whole architecture: structure only, one request, no code sent.
  reached.push("whole");
  const whole = await say("whole", "このアプリの構成を図にして", picksFor(contract.NONE), 1);
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
  reached.push("whole-undo");
  await page.locator("#undo").click();
  await settle();
  const undone = await screen();
  last = undone;
  report({ event: "turn", stage: "whole-undo", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(undone) });
  need(undone.draft.length === 1 && undone.claims.every(claim => !claim.record.startsWith("region arch-")),
    `Undo takes the whole view back (${undone.draft.length} steps left)`);
  prerequisite(undone.draft.length === 1, "whole-undo");

  // (2) The page's own code: its roles, its call to the Worker, its storage.
  reached.push("app");
  const app = await say("app", "画面のコードの役割を詳しく見せて", picksFor(APP), 2);
  need(app.sent.map(entry => entry.sent.kind).join(" ") === `${contract.ARCHITECTURE_INTENT_KIND} ${contract.ARCHITECTURE_JUDGE_KIND}`,
    "a focused utterance is an intent, then a judge");
  need(app.sent.every(entry => entry.status === 200), `both were answered (${app.sent.map(entry => entry.status).join(", ")})`);
  need(app.sent.every(entry => !codeIn(entry.sent)), "the page sends no code in either; the server adds it");
  for (const role of ["voice-input", "jev-boundary", "graph-mutation", "persistence"]) need(hasRole(app.now, APP, role), `the page's file is judged ${role}`);
  need(claimOf(app.now, `region arch-${APP}`)?.origins.join(" ") === "source-declared", "the file itself stays the source's");
  need(inferredAt(app.now, `arch-calls-${APP}-to-functions-pages-worker-mjs`), "the page calls the Worker");
  need(claimOf(app.now, "relation arch-import-functions-pages-worker-mjs-to-functions-api-jev-mjs")?.origins.includes("source-declared"),
    "the Worker imports the Function, as the source declares");
  need(inferredAt(app.now, `arch-stores-in-${APP}-to-ext-localstorage`), "the page stores in localStorage");
  // Every later stage stands on the structure this utterance drew.
  prerequisite(app.now.state === "drafted", "app");

  // (3) The credential: the Function authenticates with it and calls the provider.
  reached.push("credential");
  const auth = await say("credential", "認証とJevへの接続を詳しく見せて", picksFor("ext-jev-api-key"), 2);
  need(auth.sent.every(entry => entry.status === 200), `the credential focus was answered (${auth.sent.map(entry => entry.status).join(", ")})`);
  need(inferredAt(auth.now, `arch-authenticates-with-${FUNCTION}-to-ext-jev-api-key`), "the Function authenticates with the key");
  need(inferredAt(auth.now, `arch-calls-${FUNCTION}-to-ext-api-typesafe-ai`), "the Function calls the provider");
  need(claimOf(auth.now, "region arch-ext-jev-api-key")?.origins.join(" ") === "unknown", "the credential itself stays unknown");
  need(hasRole(auth.now, FUNCTION, "auth"), "the Function is judged auth");

  // (4) Storage: every admitted file that names it, whole.
  reached.push("storage");
  const stored = await say("storage", "ブラウザ保存に関わる部分を詳しく見せて", picksFor("ext-localstorage"), 2);
  need(stored.sent.every(entry => entry.status === 200), `the storage focus was answered (${stored.sent.map(entry => entry.status).join(", ")})`);
  need(stored.sent.at(-1)?.sent.state.architecture?.bodies?.length === 4, "the storage section opens the four files that name it");
  need(hasRole(stored.now, "src-config-mjs", "config"), "the config module is judged config");

  // (5) The save flow: the decision log's own code. The page -> log relation is
  // already drawn, so the role alone must still become a change of the graph.
  reached.push("save");
  need(inferredAt(stored.now, `arch-calls-${APP}-to-${LOG}`), "the page -> decision log relation is already there");
  const saveAgain = () => say("save", "保存の仕組みを詳しく見せて", picksFor(LOG), 2);
  const save = await saveAgain();
  need(save.sent.every(entry => entry.status === 200), `the save focus was answered (${save.sent.map(entry => entry.status).join(", ")})`);
  need(save.now.state === "drafted", `the log's role is drafted (state ${save.now.state}: ${save.now.failure ?? save.now.status})`);
  need(hasRole(save.now, LOG, "persistence"), "the decision log is judged persistence");
  need(claimOf(save.now, `relation arch-import-${APP}-to-${LOG}`)?.origins.includes("source-declared"), "the page imports the decision log");
  need(save.now.claims.every(claim => !(claim.record.startsWith("relation arch-import-") && claim.origins.includes("model-inferred"))),
    "an import edge is never model-inferred");
  if (FIXTURE) {
    // Undo below would otherwise take back another utterance.
    prerequisite(save.now.state === "drafted", "save");
    reached.push("save-again");
    // The same judgement again adds nothing.
    const repeat = await saveAgain();
    need(repeat.now.state === "no-change" && repeat.now.draft.length === save.now.draft.length, `a repeated role is nothing new (${repeat.now.state})`);
    // Undo takes the log's utterance back: its edge goes, the shared node stays.
    await page.locator("#undo").click();
    await settle();
    const back = await screen();
    need(!hasRole(back, LOG, "persistence") && claimOf(back, `region arch-role-persistence`) !== null,
      "Undo removes the log's role edge and keeps the persistence node the page's role drew");
    // A new utterance judges it again.
    need(hasRole((await saveAgain()).now, LOG, "persistence"), "judged again, the log's role is drawn again");
  }
  const judgedDraft = (await screen()).draft.length;

  // (6) A correction by the person: the judged storage relation is taken out -
  // one more utterance - and Undo takes it back.
  reached.push("correction");
  const storageEdge = `arch-stores-in-${APP}-to-ext-localstorage`;
  const corrected = await say("correction", "その保存の関係は違うので消して", (name, sent) => {
    if (name === "action") return "remove-edge";
    if (name === "edge") return sent.state.graph.edges.find(edge => edge.id === storageEdge)?.id;
    return contract.NONE;
  }, 1);
  const removedOne = corrected.now.draft.length === judgedDraft + 1 && claimOf(corrected.now, `relation ${storageEdge}`) === null;
  need(removedOne, `the person's correction removes the judged relation as one more step (state ${corrected.now.state}: `
    + `${corrected.now.failure ?? corrected.now.status})`);
  if (removedOne) {
    await page.locator("#undo").click();
    await settle();
    need(claimOf(await screen(), `relation ${storageEdge}`) !== null, "Undo brings the judged relation back");
  }

  // Apply saves the new map and every view.
  reached.push("apply");
  await page.locator("#apply").click();
  await settle();
  applied = await screen();
  last = applied;
  report({ event: "turn", stage: "apply", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(applied) });
  need(applied.state === "applied", `Apply saved the document (state ${applied.state}: ${applied.failure ?? applied.status})`);
  need(applied.stored?.startsWith('{"schema":"voice-ui.architecture-document/1"'), "the architecture key holds the document");
  need(applied.root === rootBefore, "the plain page's stored value is untouched");
  need(applied.stored !== null && !applied.stored.includes("export function") && !applied.stored.includes("confidence"),
    "no source text, raw answer or confidence is saved");

  // Reload restores the same graph with every claim and role, checked against the source.
  reached.push("reload");
  await page.reload({ waitUntil: "commit" });
  await ready();
  reloaded = await screen();
  last = reloaded;
  report({ event: "turn", stage: "reload", expected: 0, requests: 0, answered: 0, failed: 0, exchanges: [], dom: domOf(reloaded) });
  need(reloaded.state === "restored", `reload restores the document (state ${reloaded.state}: ${reloaded.failure ?? reloaded.status})`);
  need(reloaded.stored === applied.stored, "reload does not rewrite the document");
  need(JSON.stringify(reloaded.claims) === JSON.stringify(applied.claims), "the same records and origins come back");
  const originsAfter = [...new Set(reloaded.claims.flatMap(claim => claim.origins))].sort();
  need(JSON.stringify(originsAfter) === JSON.stringify(["model-inferred", "scope-declared", "source-declared", "unknown", "user-asserted"]),
    `all five origins come back (${originsAfter.join(", ")})`);
  need(hasRole(reloaded, LOG, "persistence") && hasRole(reloaded, APP, "persistence"), "the roles come back as drawn");
  need(/^出典: apps-voice-ui@/u.test(reloaded.sourceStatus), "the cited snapshot is still checkable");
} catch (error) {
  thrown = error;
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
const models = [...new Set(answered.map(entry => entry.body?.model ?? "UNKNOWN"))];
const failure = thrown === null || thrown === HALT ? null : String(thrown?.message ?? thrown).split("\n")[0];
report({
  event: "summary", mode, stoppedAt, error: failure, cleanup, verdicts, notRun: STAGES.filter(stage => !reached.includes(stage)),
  requests: exchanges.length, answered: exchanges.filter(entry => entry.status !== null).length,
  failed: exchanges.filter(entry => entry.error !== null).length, models,
  // Whatever no turn reported - a turn that ended in an error - in full.
  unreported: exchanges.filter(entry => !entry.reported).map(sanitized),
});

const shown = last?.claims ?? [];
const summary = `${answered.length}/${exchanges.length} answered Jev exchanges (model ${models.join(", ") || "none"}), `
  + `${shown.length} claimed records, ${shown.filter(claim => claim.origins.includes("model-inferred")).length} with model-inferred claims, `
  + `${shown.filter(claim => claim.record.startsWith("relation arch-has-role-")).length} has-role edges`
  + (stoppedAt === null ? "" : ` | stopped after ${stoppedAt}`);
if (failure !== null) {
  // An error of the run itself is never a verdict: it is reported and rethrown.
  process.stdout.write(`architecture-e2e[${mode}]: ERROR | ${failure}${cleanup === null ? "" : ` | close failed: ${cleanup}`} | ${summary}\n`);
  throw thrown;
}
if (cleanup !== null) {
  // A browser that could not be closed makes the run an error, whatever it found.
  process.stdout.write(`architecture-e2e[${mode}]: ERROR | close failed: ${cleanup} | ${summary}\n`);
  process.exitCode = 1;
} else if (FIXTURE) {
  assert.deepEqual(verdicts, [], "the page's mechanics");
  assert.equal(stoppedAt, null, "every stage ran");
  assert.deepEqual(models, ["crafted-by-test"], "fixture answers only, never evidence about Jev or the code");
  process.stdout.write(`architecture-e2e[fixture]: PASS mechanics only (crafted answers) | ${summary}\n`);
} else if (verdicts.length > 0 || stoppedAt !== null) {
  process.stdout.write(`architecture-e2e[live]: NOT_PASS | ${verdicts.join("; ")} | ${summary}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`architecture-e2e[live]: PASS local source-dev only, typed input (not the microphone gate) | ${summary}\n`);
}
