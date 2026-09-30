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
//            actually drawn and classified, NOT_PASS otherwise.
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

// Every Jev exchange, as the page sent it and as it was answered.
const exchanges = [];

// Fixture mode only: the answer to a request, crafted from its own questions.
const craft = picks => async route => {
  const sent = JSON.parse(route.request().postData());
  const slots = contract.slotsFor(sent.state);
  const answers = Object.fromEntries(Object.entries(slots).map(([name, options]) => {
    const picked = typeof picks === "function" ? picks(name, sent) : picks[name];
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
  sourceStatus: document.querySelector("#architecture-status").textContent,
  shown: !document.querySelector("#architecture").hidden,
  claims: [...document.querySelectorAll("#architecture-claims li")].map(item => ({
    record: item.dataset.record, origins: item.dataset.origins.split(" "), role: item.dataset.role ?? null,
  })),
  coverage: [...document.querySelectorAll("#architecture-coverage li")].map(item => item.textContent),
  stored: localStorage.getItem(key),
  root: localStorage.getItem(rootKey),
  frames: document.querySelectorAll('#working-surface iframe[data-package="semantic-map"]').length,
}), [KEY, ROOT_KEY]);
const say = async (utterance, picks) => {
  if (FIXTURE) await page.route(new URL("/api/jev", url).href, craft(picks), { times: 1 });
  const answered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/jev", { timeout: 120000 });
  await page.locator("#text").fill(utterance);
  await page.locator("#send").click();
  const response = await answered;
  await settle();
  const exchange = {
    sent: JSON.parse(response.request().postData()),
    status: response.status(),
    body: await response.json().catch(() => null),
  };
  exchanges.push(exchange);
  return { now: await screen(), exchange };
};
const claimOf = (now, record) => now.claims.find(claim => claim.record === record) ?? null;

// The slash-less path is sent to the architecture page's own path.
const opened = await page.goto(PAGE, { waitUntil: "commit", timeout: 120000 });
assert.ok(opened.url().endsWith("/architecture/"), `a 308 leads to /architecture/, not ${opened.url()}`);
await ready();
const start = await screen();
assert.equal(start.shown, true, "the architecture account is shown on this page");
assert.notEqual(start.state, "failed", `the prepared source must be available: ${start.failure}`);
assert.match(start.sourceStatus, /^出典: apps-voice-ui@[0-9a-f]{40}$/u);
assert.ok(start.coverage.some(line => /dynamic import/u.test(line)), "what was not analyzed is listed");
assert.ok(start.coverage.some(line => /取り込み対象外: src\/turn\.mjs/u.test(line)), "what was not admitted is listed");
const rootBefore = start.root;

// The person names a new map; nothing is saved yet.
await page.locator("#text").fill("voice-ui の構成");
await page.locator("#new").click();
await settle();
assert.equal((await screen()).state, "drafted");

// (1) The whole architecture, judged from the admitted source.
const ROLES = {
  "browser-app": "voice-input", page: "voice-input", hayamimi: "voice-input",
  "jev-contract": "jev-boundary", "jev-function": "jev-boundary", "jev-provider": "jev-boundary",
  "jev-credential": "auth", session: "graph-mutation", "architecture-builder": "graph-mutation", "semantic-map": "graph-mutation",
  "decision-log": "persistence", "architecture-document": "persistence", "browser-storage": "persistence",
  config: "config", "normal-config": "config", "architecture-config": "config",
};
const RELATIONS = {
  "c-jev-function--jev-credential": "authenticates-with",
  "c-jev-function--jev-provider": "calls",
  "c-browser-app--browser-storage": "stores-in",
};
const wholePicks = extra => name => {
  if (name === "action") return contract.ACTION_ARCHITECTURE;
  if (name === "focus") return extra.focus ?? contract.NONE;
  if (name.startsWith("role-")) return ROLES[name.slice("role-".length)];
  if (name.startsWith("relation-")) return RELATIONS[name.slice("relation-".length)];
  return contract.NONE;
};
const whole = await say("このアプリの構成を図にして", wholePicks({}));
assert.equal(whole.exchange?.status, 200, "the architecture request was answered");
assert.ok(whole.exchange.sent.state.architecture, "the request carried the prepared source's public section");
assert.equal(JSON.stringify(whole.exchange.sent).includes("export function"), false, "the page never sends source text");

const REQUIRED = ["arch-browser-app", "arch-jev-function", "arch-decision-log", "arch-architecture-document", "arch-jev-credential", "arch-browser-storage"];
const verdicts = [];
const need = (condition, what) => { if (!condition) verdicts.push(what); };
need(whole.now.state === "drafted", `the architecture was drafted (state ${whole.now.state}: ${whole.now.failure ?? whole.now.status})`);
for (const record of REQUIRED) need(claimOf(whole.now, `region ${record}`) !== null, `${record} is drawn`);
const roleOf = record => claimOf(whole.now, `region ${record}`)?.role ?? null;
need(["auth", "jev-boundary"].includes(roleOf("arch-jev-function")) || roleOf("arch-jev-credential") === "auth", "the Jev credential path is classified");
need(["persistence"].includes(roleOf("arch-decision-log")) || roleOf("arch-browser-storage") === "persistence", "the storage path is classified");
const inferred = whole.now.claims.filter(claim => claim.record.startsWith("relation ") && claim.origins.includes("model-inferred"));
need(inferred.some(claim => /jev-credential|jev-provider/u.test(claim.record)), "a run-time relation to the Jev credential or provider is judged");
need(inferred.some(claim => /browser-storage/u.test(claim.record)), "a run-time relation to browser storage is judged");
need(whole.now.claims.some(claim => claim.record.startsWith("relation arch-import-") && claim.origins.includes("source-declared")),
  "static imports are drawn as source-declared");
need(whole.now.claims.every(claim => !(claim.record.startsWith("relation arch-import-") && claim.origins.includes("model-inferred"))),
  "an import edge is never model-inferred");
need(claimOf(whole.now, "region arch-jev-credential")?.origins.includes("unknown"), "the credential outside the admitted source is unknown");

// (2) The auth and storage detail: the declared facts of the configuration.
const detail = await say("設定と保存の部分を詳しく見せて", wholePicks({ focus: "config" }));
need(detail.exchange?.status === 200, "the detail request was answered");
need(detail.now.claims.some(claim => claim.record.startsWith("region arch-fact-") && claim.origins.includes("source-declared")),
  "declared facts are drawn, cited by file and pointer");

// (3) A correction by the person: one judged relation is taken out.
const judged = inferred.map(claim => claim.record.slice("relation ".length));
const corrected = await say("その保存の関係は違うので消して", (name, sent) => {
  if (name === "action") return "remove-edge";
  if (name === "edge") return sent.state.graph.edges.find(edge => judged.includes(edge.id) && /browser-storage/u.test(edge.id))?.id;
  return contract.NONE;
});
const removedOne = corrected.now.draft.length === detail.now.draft.length + 1;
if (FIXTURE) assert.ok(removedOne, "the person's correction is one more step");

// Undo takes the correction back; Apply saves the new map and both views.
if (removedOne) {
  await page.locator("#undo").click();
  await settle();
}
await page.locator("#apply").click();
await settle();
const applied = await screen();
need(applied.state === "applied", `Apply saved the document (state ${applied.state}: ${applied.failure ?? applied.status})`);
need(applied.stored?.startsWith('{"schema":"voice-ui.architecture-document/1"'), "the architecture key holds the document");
need(applied.root === rootBefore, "the plain page's stored value is untouched");
need(applied.stored !== null && !applied.stored.includes("export function") && !applied.stored.includes("confidence"),
  "no source text, raw answer or confidence is saved");

// Reload restores the same graph with every claim, checked against the source.
await page.reload({ waitUntil: "commit" });
await ready();
const reloaded = await screen();
need(reloaded.state === "restored", `reload restores the document (state ${reloaded.state}: ${reloaded.failure ?? reloaded.status})`);
need(reloaded.stored === applied.stored, "reload does not rewrite the document");
need(JSON.stringify(reloaded.claims.map(claim => claim.record).sort()) === JSON.stringify(applied.claims.map(claim => claim.record).sort()),
  "the same records and claims come back");
need(/^出典: apps-voice-ui@/u.test(reloaded.sourceStatus), "the cited snapshot is still checkable");
need(errors.length === 0, `no page error: ${errors.join(" | ")}`);

const answered = exchanges.filter(entry => entry.status === 200);
const models = [...new Set(answered.map(entry => entry.body?.model ?? "UNKNOWN"))];
await browser.close();

const summary = `${answered.length} answered Jev exchanges (model ${models.join(", ")}), `
  + `${reloaded.claims.length} claimed records, ${reloaded.claims.filter(claim => claim.origins.includes("model-inferred")).length} with model-inferred claims`;
if (FIXTURE) {
  assert.deepEqual(verdicts, [], "the page's mechanics");
  assert.deepEqual(models, ["crafted-by-test"], "fixture answers only, never evidence about Jev or the code");
  process.stdout.write(`architecture-e2e[fixture]: PASS mechanics only (crafted answers) | ${summary}\n`);
} else if (verdicts.length > 0) {
  process.stdout.write(`architecture-e2e[live]: NOT_PASS | ${verdicts.join("; ")} | ${summary}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`architecture-e2e[live]: PASS local source-dev only | ${summary}\n`);
}
