import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// The approved acceptance runtime supplies this pinned dependency, never npm at run time.
const { chromium } = createRequire(import.meta.url)("playwright-core");

const url = process.argv[2];
if (!url) throw new Error("public URL is required");

// The one current Jev contract, as the target itself serves it: its contract
// module is fetched and imported unchanged, so every kind, slot and answer
// check below is the contract the page and the Function use - never a copy
// kept here. This file ships alone in the artifact.
const served = await fetch(new URL("/app/src/contract.mjs", url));
assert.equal(served.status, 200, "the target serves its contract module");
const contract = await import(`data:text/javascript;base64,${Buffer.from(await served.text()).toString("base64")}`);
const { REQUEST_KIND, DECISION_KIND } = contract;

if (process.argv[3] === "--binding-contract") {
  // Controlled composition proof only: the actual app imports three independent
  // bindings; no microphone, provider request or original display renderer runs.
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const page = await browser.newPage();
    const errors = [], resources = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => resources.push(new URL(request.url()).pathname));
    await page.route("**/adapters/transcription.mjs", route => route.fulfill({ contentType: "text/javascript", body: [
      'export const createTranscription=()=>({onListening})=>new Promise(resolve=>{',
      'document.body.dataset.fixtureCaptures=String(Number(document.body.dataset.fixtureCaptures||0)+1);',
      'onListening();document.body.dataset.fixtureListening="yes";',
      'window.addEventListener("fixture-text",event=>{delete document.body.dataset.fixtureListening;resolve(event.detail)},{once:true});});',
    ].join("\n") }));
    await page.route("**/adapters/judgment.mjs", route => route.fulfill({ contentType: "text/javascript", body: [
      'import {isRequest,slotsFor,NONE,DECISION_KIND} from "/app/src/contract.mjs";',
      'export const createJudgment=()=>async request=>{if(!isRequest(request))throw new Error("fixture invalid port request");',
      'document.body.dataset.fixtureJudgments=String(Number(document.body.dataset.fixtureJudgments||0)+1);',
      'const offered=slotsFor(request.state);const selected=request.state.utterance==="add edge"?{action:"add-edge",source:"node-a",target:"node-b"}:{};',
      'return {kind:"answered",decision:{kind:DECISION_KIND,answers:Object.fromEntries(Object.keys(offered).map(name=>[name,{type:"choice",choice:selected[name]||NONE,confidence:.9}]))}};};',
    ].join("\n") }));
    await page.route("**/ui/semantic-map/runtime.js", route => route.fulfill({ contentType: "text/javascript", body: [
      'import {inspectEnvelope} from "/ui/semantic-map/protocol/index.js";',
      'export const visibleFrameOf=()=>null;',
      'export const executeArtifactPackage=async ({document,input,surfaceMount})=>{',
      'if(document.body.dataset.fixtureHold==="yes"){document.body.dataset.fixtureRendering="yes";await new Promise(resolve=>window.addEventListener("fixture-render",resolve,{once:true}));delete document.body.dataset.fixtureRendering;}',
      'const value=await inspectEnvelope(input.envelope);const list=document.createElement("ol");list.dataset.fixtureProjection="yes";',
      'for(const row of value.base.records.filter(row=>row.type==="relation")){const item=document.createElement("li");item.textContent=row.from+"->"+row.to;list.append(item);}surfaceMount.replaceChildren(list);};',
    ].join("\n") }));
    const ready = () => page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== "pending");
    await page.goto(url); await ready();
    const seeded = await page.evaluate(async () => {
      const protocol = await import("/ui/semantic-map/protocol/index.js");
      const config = await (await fetch("/data/config.v1.json")).json();
      const graph = await protocol.createDecisionLog([
        {type:"meta",schema:"semantic-map-state/1",root:"root",title:"binding fixture"},
        {type:"region",id:"root",parent:null,label:"binding fixture",kind:"boundary",bounds:[0,0,720,260],summary:""},
        ...["node-a","node-b"].map((id,index)=>({type:"region",id,parent:"root",label:id,kind:"node",bounds:[40+index*250,90,140,64],summary:""})),
      ], "voice-graph");
      localStorage.setItem(config.persistence.key,graph.log);return {key:config.persistence.key,log:graph.log};
    });
    await page.reload(); await ready();
    assert.equal(await page.evaluate(() => document.body.dataset.state), "restored");
    await page.locator("#mic").click();
    await page.waitForFunction(() => document.body.dataset.fixtureListening === "yes");
    // Voice owns capture but not rendering while waiting; typed input is legal.
    await page.locator("#text").fill("no change"); await page.locator("#send").click();
    await page.waitForFunction(() => document.body.dataset.fixtureJudgments === "1");
    assert.equal(await page.evaluate(() => document.body.dataset.fixtureCaptures), "1");
    assert.equal(await page.locator("#mic").isDisabled(), true);
    await page.evaluate(() => {
      document.body.dataset.fixtureHold="yes";
      const event=document.createEvent("CustomEvent");event.initCustomEvent("fixture-text",false,false,"add edge");window.dispatchEvent(event);
    });
    await page.waitForFunction(() => document.body.dataset.fixtureRendering === "yes");
    // Rendering owns the surface: neither another capture nor typed work starts.
    await page.evaluate(() => {document.querySelector("#mic").click();document.querySelector("#send").click();});
    assert.deepEqual(await page.evaluate(() => [document.body.dataset.fixtureCaptures,document.body.dataset.fixtureJudgments]),["1","2"]);
    await page.evaluate(() => {delete document.body.dataset.fixtureHold;});
    // Dispatch a named platform event, without introducing a production hook.
    await page.evaluate(() => {const event=document.createEvent("Event");event.initEvent("fixture-render",false,false);window.dispatchEvent(event);});
    await page.waitForFunction(() => document.body.dataset.state === "drafted");
    assert.equal(await page.locator("#send").isDisabled(), false);
    assert.equal(await page.locator("#mic").isDisabled(), false);
    assert.deepEqual(await page.locator("#draft li").evaluateAll(rows => rows.map(row => row.dataset.changes)), ["+node-a->node-b"]);
    assert.deepEqual(await page.locator("#working-surface [data-fixture-projection] li").allTextContents(), ["node-a->node-b"]);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), seeded.key), seeded.log);
    await page.locator("#apply").click();await page.waitForFunction(() => document.body.dataset.state === "applied");
    const saved = await page.evaluate(key => localStorage.getItem(key), seeded.key);
    assert.ok(saved.startsWith(seeded.log));
    assert.equal(saved.split("\n").length,seeded.log.split("\n").length+1);
    await page.reload();await ready();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), seeded.key),saved);
    assert.deepEqual(await page.locator("#confirmed-surface [data-fixture-projection] li").allTextContents(),["node-a->node-b"]);
    assert.deepEqual(resources.filter(value => value.startsWith("/hayamimi/") || value === "/sw.js" || value === "/api/judge"),[]);
    assert.deepEqual(errors,[]);
    process.stdout.write("binding-contract: PASS actual app, independent ASR/Judge/projection; saved world/append/restore; capture/render ownership; provider/ASR-resource/API calls 0; mechanical only\n");
  } finally {await browser.close();}
} else {
const wav = process.env.VOICE_WAV;
const goldenPath = process.env.VOICE_GOLDEN;
if (!wav || !goldenPath) throw new Error("VOICE_WAV and VOICE_GOLDEN are required");

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

const args = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--use-file-for-fake-audio-capture=" + path.resolve(wav),
  "--autoplay-policy=no-user-gesture-required",
];

// The full browser rather than the reduced headless shell, which loses its
// renderer while loading this page.
const browser = await chromium.launch({ headless: true, channel: "chromium", args });
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin: new URL(url).origin });
const page = await context.newPage();

const errors = [];
const failedRequests = [];
const failedResponses = [];
page.on("pageerror", error => errors.push(String(error)));
page.on("requestfailed", request =>
  failedRequests.push(request.method() + " " + request.url() + " " + request.failure()?.errorText)
);
page.on("response", response => {
  if (response.status() >= 400) {
    failedResponses.push(response.status() + " " + response.request().method() + " " + response.url());
  }
});

// The page sets its body state last, once every control is in place.
const ready = () => page.waitForFunction(
  () => document.body.dataset.state !== undefined && document.body.dataset.state !== "pending",
  null,
  { timeout: 120000 },
);

const navigation = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
assert.equal(navigation?.status(), 200);
await ready();
assert.equal((await page.content()).includes("JEV_API_KEY"), false);

// A first visit is NO_LOG: nothing stored, nothing drawn, nothing to speak to.
assert.equal(await page.evaluate(() => document.body.dataset.state), "no-log");
assert.equal(await page.locator('iframe[data-package="semantic-map"]').count(), 0);
assert.equal(await page.locator("#send").isDisabled(), true);

// The configuration the target serves, read by its own production modules in
// the page: it is valid, and the data bundle it names gives every capability,
// so the page shows no unavailable notice. The storage key below is the one
// it declares.
const configured = await page.evaluate(async () => {
  const { readConfig } = await import("/app/src/config.mjs");
  const { readBundle } = await import("/app/src/bundle.mjs");
  const config = readConfig(await (await fetch("/data/config.v1.json", { cache: "no-store" })).json());
  if (config.error !== undefined) return { config };
  const bundle = readBundle(await (await fetch(config.data.bundle, { cache: "no-store" })).json());
  return {
    config,
    parts: bundle.parts !== null,
    diagrams: bundle.diagrams !== null,
    notice: document.querySelector("#bundle-notice").textContent,
  };
});
assert.equal(configured.config.error, undefined, `the served config is valid: ${configured.config.error}`);
assert.equal(configured.config.persistence.mechanism, "localStorage");
assert.deepEqual([configured.parts, configured.diagrams, configured.notice], [true, true, ""],
  "the configured bundle gives parts and diagrams, and nothing is shown as unavailable");
const STORAGE_KEY = configured.config.persistence.key;

// Two edges that are already saved. After the first typed step 作業図 offers
// three edges, so which one "that edge" means cannot be read off the graph.
const SEEDED = [["node-b", "node-c"], ["node-a", "node-c"]];
const seededEdges = SEEDED.map(([from, to]) => `${from}->${to}`).sort();

// A fixture of three plain nodes and the two saved edges, built by the pinned
// provider in the page and stored in this app's namespace, then loaded the way
// a saved log is.
const fixtureLog = await page.evaluate(async ({ key, seeded }) => {
  const protocol = await import("/ui/semantic-map/protocol/index.js");
  const node = (id, x) => ({ type: "region", id, parent: "root", label: id, kind: "node", bounds: [x, 90, 140, 64], summary: "" });
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: "semantic-map-state/1", root: "root", title: "public fixture" },
    { type: "region", id: "root", parent: null, label: "public fixture", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
    node("node-a", 40),
    node("node-b", 250),
    node("node-c", 460),
    ...seeded.map(([from, to]) => ({ type: "relation", id: `fixture-${from}-to-${to}`, from, to, kind: "flow", label: "" })),
  ], "voice-graph");
  localStorage.setItem(key, graph.log);
  return graph.log;
}, { key: STORAGE_KEY, seeded: SEEDED });
await page.reload({ waitUntil: "commit" });
await ready();
assert.equal(await page.evaluate(() => document.body.dataset.state), "restored");

// Every edge one pane's live adapter holds, read from inside that pane's own
// frame. This is the graph the page actually drew, not an envelope handed to it.
const drawnEdges = pane => page.evaluate(async pane => {
  const frame = document.querySelector(`#${pane}-surface iframe[data-package="semantic-map"]`);
  if (!frame) throw new Error(`${pane} semantic map iframe missing`);

  const started = performance.now();
  while (frame.contentWindow?.semanticMapSite?.ready !== true) {
    if (performance.now() - started > 60000) throw new Error("semantic map ready timeout");
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const win = frame.contentWindow;
  const svg = frame.contentDocument.querySelector("#graph-container svg");
  const box = svg?.getBoundingClientRect();
  return {
    pattern: win.semanticMapRuntime.view.pattern,
    svg: Boolean(box && box.width > 0 && box.height > 0),
    edges: [...win.semanticMapApp.adapter.edgesByProjectionKey.values()]
      .map(edge => `${edge.semantic.from}->${edge.semantic.to}`)
      .sort(),
  };
}, pane);

const appliedFacts = () => page.evaluate(() =>
  [...document.querySelectorAll("[data-history=confirmed] li")].map(item => item.dataset.facts).sort()
);
const draftSteps = () => page.evaluate(() =>
  [...document.querySelectorAll("#draft li")].map(item => item.dataset.changes)
);
const storedLog = () => page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
// The recent conversation as the panel shows it, entry by entry.
const contextPanel = () => page.evaluate(() =>
  [...document.querySelectorAll("#context-recent li")].map(item => JSON.parse(item.dataset.entry))
);

const waitForState = state => page.waitForFunction(
  value => document.body.dataset.state === value,
  state,
  { timeout: 360000 },
);

// Speaking and typing change 作業図 only. Until 確定図に反映, 確定図 and the
// stored bytes must not move.
const assertSavedUntouched = async label => {
  assert.equal(await storedLog(), fixtureLog, `${label}: nothing may be stored before Apply`);
  assert.deepEqual(await appliedFacts(), [], `${label}: 確定図 must have no entry before Apply`);
  assert.deepEqual((await drawnEdges("confirmed")).edges, seededEdges, `${label}: 確定図 must draw only the saved edges before Apply`);
};

assert.deepEqual((await drawnEdges("confirmed")).edges, seededEdges, "確定図 draws the saved edges");
assert.deepEqual((await drawnEdges("working")).edges, seededEdges, "作業図 starts from the saved edges");

// No credential or no provider is not a result: the run stops as NOT_RUN,
// which is RED, and names the reason the service gave.
const requireAnswered = async response => {
  if (response.status() === 503) {
    throw new Error(`NOT_RUN: judge_unavailable - the Jev service or its credential is unavailable (${await response.text()}); this run is RED, not PASS`);
  }
  assert.equal(response.status(), 200);
};

// A UNCONTROLLED_NETWORK answer: a 200 the page got from the network - this file installs no
// route, and the service worker must not have answered it - whose body is
// exactly the current success shape, and whose every answer is a choice from
// the slots the request actually sent offered, checked with the served
// contract's own functions. Anything else is RED; a crafted or malformed 200
// never counts. Returns the request as sent and the Decision as received.
const requireNetwork = async (response, label) => {
  const sent = JSON.parse(response.request().postData());
  assert.equal(sent.kind, REQUEST_KIND, `${label}: the page sends the current request kind`);
  assert.ok(contract.isRequest(sent), `${label}: the page's request is a valid current request`);
  await requireAnswered(response);
  assert.equal(response.fromServiceWorker(), false, `${label}: answered by the network, not by a service worker`);
  const decision = await response.json();
  assert.deepEqual(Object.keys(decision).sort(), ["answers", "kind"], `${label}: exactly the success shape`);
  assert.equal(decision.kind, DECISION_KIND, `${label}: the current Decision kind`);
  const read = contract.readAnswers(decision.answers, contract.slotsFor(sent.state));
  assert.notEqual(read, null, `${label}: every answer is a choice from the slots this request offered`);
  assert.deepEqual(decision.answers, read, `${label}: the answers are exactly what the contract reads`);
  return { sent, decision };
};

const judgeResponse = timeout => page.waitForResponse(
  response => new URL(response.url()).pathname === "/api/judge" && response.request().method() === "POST",
  { timeout },
);

// One typed input through Send, and the /api/judge response it caused.
const typed = async value => {
  await page.locator("#text").fill(value);
  const responsePromise = judgeResponse(120000);
  await page.locator("#send").click();
  return responsePromise;
};

// The input has settled once the page leaves `pending`; it must have drafted.
const settledDrafted = async label => {
  await page.waitForFunction(() => document.body.dataset.state !== "pending", null, { timeout: 360000 });
  const state = await page.evaluate(() => [document.body.dataset.state, document.querySelector("#status").textContent]);
  assert.equal(state[0], "drafted", `${label}: the step must be drafted (${state[1]})`);
};

// A two-turn scenario whose second answer is only right if Jev took the first
// turn into account. A rendered string is not evidence of anything; the
// request as sent, a UNCONTROLLED_NETWORK Decision, the step drawn on 作業図 and then applied
// to 確定図 and restored after reload are.
//
// Turn 1 names its edge. It is the first request the page makes to /api/judge,
// and it comes from Chromium itself.
const TURN_1 = "add an edge from a to b";
const turn1 = await requireNetwork(await typed(TURN_1), "turn 1");
assert.deepEqual(turn1.sent.state.context, { recent: [] }, "turn 1 has no earlier conversation");
assert.equal(turn1.sent.state.focus, null, "turn 1 has nothing in focus");
assert.equal(turn1.decision.answers.action.choice, "add-edge", `turn 1 must be heard as one added edge: ${JSON.stringify(turn1.decision.answers)}`);
await settledDrafted("turn 1");
const first = { from: turn1.decision.answers.source.choice, to: turn1.decision.answers.target.choice };
const firstEdge = `${first.from}->${first.to}`;
const reversedEdge = `${first.to}->${first.from}`;
assert.equal(seededEdges.includes(firstEdge), false, "turn 1 adds an edge that was not saved");
assert.deepEqual(await draftSteps(), [`+${firstEdge}`]);
assert.deepEqual((await drawnEdges("working")).edges, [...seededEdges, firstEdge].sort());
await assertSavedUntouched("turn 1");

// The deployed Function serves only the current request kind: a legacy kind is
// refused before any provider call. Checked after the page's own first call.
const legacy = await fetch(new URL("/api/judge", url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "voice-ui.jev.request.v1", text: "public legacy refusal proof" }),
});
assert.equal(legacy.status, 422);
assert.deepEqual(await legacy.json(), { error: "invalid_request" });

// Turn 2 names no node. Three edges are offered, so the only way to the right
// one is what turn 1 left behind: its text and outcome in the recent
// conversation, the effect the app itself derived from its Decision, and the
// focus on that step. Everything expected here is read off turn 1's actual
// Decision, never written down in advance.
const firstEffect = { change: "added", from: first.from, to: first.to };
const panelBefore = await contextPanel();
assert.equal(panelBefore.length, 1, "the panel shows turn 1 and nothing else");
assert.ok(Number.isSafeInteger(panelBefore[0].seq));
assert.deepEqual(panelBefore, [{
  seq: panelBefore[0].seq, source: "typed", text: TURN_1, outcome: "step", effect: { changes: [firstEffect] },
}], "the panel shows turn 1's text, its outcome and the effect it had");

const TURN_2 = "reverse that edge";
const turn2 = await requireNetwork(await typed(TURN_2), "turn 2");
const asked = turn2.sent.state;
assert.equal(asked.utterance, TURN_2);
for (const region of asked.graph.regions) {
  for (const name of [region.id, region.label]) {
    assert.equal(TURN_2.toLowerCase().includes(name.toLowerCase()), false, `turn 2 must not name ${name}`);
  }
}
const offeredEdges = asked.graph.edges.map(edge => `${edge.from}->${edge.to}`).sort();
assert.deepEqual(offeredEdges, [...seededEdges, firstEdge].sort(), "turn 2 is asked about the saved edges and turn 1's");
assert.ok(contract.slotsFor(asked).edge.filter(key => key !== contract.NONE).length >= 3, "at least three edges are candidates");
assert.deepEqual(asked.context.recent, panelBefore, "turn 2 sends exactly the conversation the panel showed");
assert.deepEqual(asked.focus, { kind: "draft", changes: [firstEffect] }, "turn 2's focus is turn 1's step");
assert.deepEqual(asked.draft, [{ changes: [firstEffect] }]);

const firstEdgeId = asked.graph.edges.find(edge => edge.from === first.from && edge.to === first.to).id;
assert.equal(turn2.decision.answers.action.choice, "reverse-edge", `turn 2 must be heard as a reversal: ${JSON.stringify(turn2.decision.answers)}`);
assert.equal(turn2.decision.answers.edge.choice, firstEdgeId, `"that edge" must be turn 1's edge, not a saved one: ${JSON.stringify(turn2.decision.answers)}`);

// The reversal is one more step on 作業図: turn 1's edge is gone from the
// drawing, its reverse is drawn, the saved edges stay, and nothing is saved.
await settledDrafted("turn 2");
assert.deepEqual(await draftSteps(), [`+${firstEdge}`, `-${firstEdge} +${reversedEdge}`]);
assert.deepEqual((await drawnEdges("working")).edges, [...seededEdges, reversedEdge].sort());
await assertSavedUntouched("turn 2");

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const clip = golden.clips.find(value => value.wav === path.basename(wav));
assert.ok(clip, "voice golden fixture is missing");

// The recorded-file voice path: the fixture audio through the artifact's own
// recognizer, then Jev. This is fixture-audio/ASR evidence only, never a real
// microphone, and not part of the two-turn scenario above.
const voiceResponsePromise = judgeResponse(360000);
await page.locator("#mic").click();
const voice = await requireNetwork(await voiceResponsePromise, "voice");
await settledDrafted("voice");

const actual = normalize(await page.locator("#text").inputValue());
const expected = normalize(clip.reference);
const cer = distance(actual, expected) / Math.max(1, expected.length);
assert.ok(cer <= Number(golden._cer_tolerance), "voice CER exceeded pinned tolerance");

const voiceEdge = `${voice.decision.answers.source.choice}->${voice.decision.answers.target.choice}`;
const appliedSteps = [`+${firstEdge}`, `-${firstEdge} +${reversedEdge}`, `+${voiceEdge}`];
const finalEdges = [...seededEdges, reversedEdge, voiceEdge].sort();
assert.deepEqual(await draftSteps(), appliedSteps);
assert.deepEqual((await drawnEdges("working")).edges, finalEdges);
await assertSavedUntouched("spoken step");

// 確定図に反映 writes all three steps at once, appended after the saved bytes,
// and 確定図 then draws the reversal instead of turn 1's edge.
await page.locator("#apply").click();
await waitForState("applied");
assert.deepEqual(await draftSteps(), []);
assert.deepEqual(await appliedFacts(), [...appliedSteps].sort());
const saved = await storedLog();
assert.ok(saved, "applied steps must be persisted");
assert.ok(saved.startsWith(fixtureLog), "Apply adds to the stored log; it rewrites nothing");
assert.equal(saved.split("\n").length - 1, fixtureLog.split("\n").length - 1 + appliedSteps.length,
  "the fixture plus exactly the three applied Decisions");

const drawn = await drawnEdges("confirmed");
assert.equal(drawn.pattern, "graph/1");
assert.equal(drawn.svg, true);
assert.deepEqual(drawn.edges, finalEdges, "確定図 must draw exactly the saved and applied edges");
assert.equal(drawn.edges.includes(firstEdge), false, "確定図 draws the reversal, not turn 1's edge");

// Every entry comes back from this origin's storage after a reload.
await page.reload({ waitUntil: "commit" });
await ready();
assert.equal(await page.evaluate(() => document.body.dataset.state), "restored");
assert.equal(await storedLog(), saved);
assert.deepEqual(await appliedFacts(), [...appliedSteps].sort());
assert.deepEqual((await drawnEdges("confirmed")).edges, finalEdges);
assert.deepEqual((await drawnEdges("working")).edges, finalEdges);

assert.deepEqual(errors, []);
assert.deepEqual(failedRequests, []);
assert.deepEqual(failedResponses, []);

await browser.close();
// Network structure is not upstream identity/authentication evidence.
process.stdout.write("provider identity/authentication: NOT_PROVEN; live microphone and whole-product acceptance: NOTRUN; scenario PASS is not provider PASS\n");
process.stdout.write(
  `public-e2e: PASS NO_LOG first visit, legacy kind refused | UNCONTROLLED_NETWORK turn 1 "${TURN_1}" -> +${firstEdge}, `
  + `UNCONTROLLED_NETWORK turn 2 "${TURN_2}" among ${offeredEdges.length} edges -> ${firstEdgeId} reversed to ${reversedEdge} `
  + `from turn 1's context and focus | fixture-audio voice edge=${voiceEdge} `
  + "| drawn on 作業図 only, applied together to 確定図 as a strict append, restored after reload\n",
);
}
