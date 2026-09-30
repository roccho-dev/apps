import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  focusOf,
  focusedEvidence,
  judgeRequestOf,
  judgeSectionOf,
  planArchitecture,
  readManifest,
  withArchitecture,
} from "../src/architecture.mjs";
import { readBundle } from "../src/bundle.mjs";
import {
  ACTION_ARCHITECTURE,
  ARCHITECTURE_INTENT_KIND,
  NONE,
  REQUEST_KIND,
  YES,
  isJudgeRequest,
  isRequest,
  judgeSlotsFor,
  relationSlot,
  roleSlot,
} from "../src/contract.mjs";
import { MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { requestFor } from "../src/turn.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href);
// The provider's own limit, read from the provider and passed in as the page
// passes it, never restated here.
const { MAX_DECISION_OPERATIONS } = await import(pathToFileURL(path.join(store, "packages/semantic-map/domain/operation.js")).href);

// Every step of a plan, appended in order onto the working graph.
const appendAll = async (working, planned) => {
  let graph = working;
  for (const { step } of planned.steps) graph = (await protocol.appendDecision(graph.log, step.decision)).verified;
  return graph;
};
const claimsOf = planned => planned.steps.flatMap(item => item.claims);
const changesOf = planned => planned.steps.flatMap(item => item.step.changes);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

// A prepared source of its own: a file importing another, a store outside the
// source that the second names, a JSON file with one declared fact, and an
// unrelated file that imports nothing and is named by nothing.
const MANIFEST = Object.freeze({
  schema: "voice-ui.architecture-source/1",
  status: "available",
  source: { handle: "fixture", commit: COMMIT },
  files: [
    { path: "a.mjs", blob: "1".repeat(40), class: "admitted", entity: "a-mjs" },
    { path: "b.mjs", blob: "2".repeat(40), class: "admitted", entity: "b-mjs" },
    { path: "c.json", blob: "3".repeat(40), class: "admitted", entity: "c-json" },
    { path: "d.mjs", blob: "5".repeat(40), class: "admitted", entity: "d-mjs" },
    { path: "t.test.mjs", blob: "4".repeat(40), class: "excluded", reason: "test" },
  ],
  entities: [
    { id: "a-mjs", label: "a.mjs", kind: "file", path: "a.mjs" },
    { id: "b-mjs", label: "b.mjs", kind: "file", path: "b.mjs" },
    { id: "c-json", label: "c.json", kind: "file", path: "c.json" },
    { id: "d-mjs", label: "d.mjs", kind: "file", path: "d.mjs" },
    { id: "ext-store", label: "store", kind: "external" },
  ],
  imports: [{ from: "a-mjs", to: "b-mjs", path: "a.mjs", specifier: "./b.mjs", resolution: "relative" }],
  candidates: [
    { id: "c-a-mjs--b-mjs", from: "a-mjs", to: "b-mjs", reasons: ["import:./b.mjs"] },
    { id: "c-b-mjs--ext-store", from: "b-mjs", to: "ext-store", reasons: ["identifier:store"] },
  ],
  facts: [{ id: "store-key", entity: "c-json", path: "c.json", pointer: "/key", value: "k1" }],
  roles: [{ key: "persistence", purpose: "stores data" }, { key: "config", purpose: "declares configuration" }],
  relations: [{ key: "calls", purpose: "calls it" }, { key: "stores-in", purpose: "stores data in it" }],
  coverage: { unsupported: [{ path: "c.json", reason: "not an ES module" }], skipped: [], notAnalyzed: ["dynamic import() is not analyzed"] },
});
const FILES = Object.freeze({
  "a-mjs": "import { save } from \"./b.mjs\";\nexport const run = () => save(1);\n",
  "b-mjs": "export const save = value => store.setItem(\"k\", value);\n",
  "c-json": "{\"key\": \"k1\"}\n",
  "d-mjs": "export const unrelated = 1;\n",
});

const mapGraph = () => protocol.createDecisionLog([
  { type: "meta", schema: STATE_SCHEMA, root: "root", title: "map" },
  { type: "region", id: "root", parent: null, label: "map", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
], MAP_ID);

const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence });
const plainFor = (working, draft = []) => requestFor({
  working, utterance: "show how this code is built", bundle: readBundle(null), layout: null, offeredFrame: null,
  draft, focus: null, pending: null, recent: [],
});
const turnFor = (working, manifest) => withArchitecture(plainFor(working), manifest);
const answerFor = (slots, picks) => Object.fromEntries(Object.keys(slots).map(name => [
  name, picks[name] === undefined ? choice(NONE) : typeof picks[name] === "string" ? choice(picks[name]) : picks[name],
]));
// One utterance as the page plans it: the intent's answer, and for a focus the
// judge's answer on that focus's section.
const plan = async (working, manifest, { focus = null, intent = {}, judge = {} } = {}) => {
  const { turn } = turnFor(working, manifest);
  const answers = answerFor(turn.slots, { action: ACTION_ARCHITECTURE, ...(focus === null ? {} : { focus }), ...intent });
  const request = focus === null ? null : judgeRequestOf(manifest, focus, "show it");
  const judged = request === null ? null
    : { section: request.state.architecture, answers: answerFor(judgeSlotsFor(request.state.architecture), judge) };
  return planArchitecture({ working, turn, answers, judged, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS });
};

test("the manifest is read whole: available, unavailable with its reason, or invalid", () => {
  assert.equal(readManifest(structuredClone(MANIFEST)).status, "available");
  assert.deepEqual(readManifest({ schema: "voice-ui.architecture-source/1", status: "unavailable", reason: "dirty" }),
    { status: "unavailable", reason: "dirty" });
  for (const broken of [null, {}, { ...MANIFEST, extra: 1 }, { ...MANIFEST, source: { handle: "fixture", commit: "HEAD" } },
    { ...MANIFEST, candidates: [{ id: "c", from: "a-mjs", to: "nobody", reasons: ["import:./x.mjs"] }] },
    { ...MANIFEST, candidates: [{ id: "c", from: "a-mjs", to: "b-mjs", reasons: ["import"] }] },
    { ...MANIFEST, entities: MANIFEST.entities.map(entity => (entity.id === "a-mjs" ? { ...entity, label: "The page" } : entity)) },
    { ...MANIFEST, imports: [{ ...MANIFEST.imports[0], resolution: "guessed" }] },
    { ...MANIFEST, facts: [{ ...MANIFEST.facts[0], path: "a.mjs" }] }]) {
    assert.equal(readManifest(broken).status, "invalid");
  }
  // No chosen relation may shadow an edge kind drawn here.
  for (const reserved of ["has-role", "imports", "declares"]) {
    assert.match(readManifest({ ...structuredClone(MANIFEST), relations: [...MANIFEST.relations, { key: reserved, purpose: "x" }] }).reason,
      /shadows an edge kind/u, reserved);
  }
  // A file whose path makes the same id as a role's node would make two records one.
  const clash = structuredClone(MANIFEST);
  clash.files.push({ path: "role/persistence", blob: "6".repeat(40), class: "admitted", entity: "role-persistence" });
  clash.entities.push({ id: "role-persistence", label: "role/persistence", kind: "file", path: "role/persistence" });
  assert.match(readManifest(clash).reason, /would share an id/u);
});

test("an intent carries the plain request, the parts by path or identifier, and no code; the plain request is unchanged", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await mapGraph();
  const { turn, request } = turnFor(working, manifest);
  assert.equal(request.kind, ARCHITECTURE_INTENT_KIND);
  assert.ok(isRequest(JSON.parse(JSON.stringify(request))));
  assert.deepEqual(request.state.architecture, {
    source: { handle: "fixture", commit: COMMIT },
    entities: [
      { id: "a-mjs", label: "a.mjs" }, { id: "b-mjs", label: "b.mjs" }, { id: "c-json", label: "c.json" },
      { id: "d-mjs", label: "d.mjs" }, { id: "ext-store", label: "store" },
    ],
  });
  assert.deepEqual(turn.slots.focus, ["a-mjs", "b-mjs", "c-json", "d-mjs", "ext-store", NONE]);
  assert.ok(turn.slots.action.includes(ACTION_ARCHITECTURE));
  assert.equal(Object.keys(turn.slots).some(name => name.startsWith("role-") || name.startsWith("relation-")), false,
    "an intent asks nothing about the code");

  // The plain request is exactly what it was: its own kind, no architecture,
  // and at most 8 changes a step - which an intent may exceed.
  const plain = plainFor(working);
  assert.equal(plain.request.kind, REQUEST_KIND);
  const wide = Array.from({ length: 9 }, (_, index) => ({ change: "added", from: `x${index}`, to: "y" }));
  const withDraft = kind => JSON.parse(JSON.stringify({ ...request, kind, state: { ...request.state, draft: [{ changes: wide }] } }));
  assert.equal(isRequest(withDraft(ARCHITECTURE_INTENT_KIND)), true);
  const { architecture, ...plainState } = withDraft(REQUEST_KIND).state;
  assert.equal(isRequest({ kind: REQUEST_KIND, state: plainState }), false, "the plain request keeps its bound of 8");
  assert.equal(isRequest({ kind: REQUEST_KIND, state: { ...plainState, architecture } }), false, "and takes no architecture");
});

test("a focus opens its own file, or every file that names it, and exactly the pairs that touch them", () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const own = judgeSectionOf(manifest, "b-mjs");
  assert.equal(own.focus, "b-mjs");
  assert.deepEqual(own.bodies, ["b-mjs"]);
  assert.deepEqual(own.candidates.map(candidate => candidate.id), ["c-a-mjs--b-mjs", "c-b-mjs--ext-store"]);
  assert.deepEqual(own.entities.map(entity => entity.id), ["a-mjs", "b-mjs", "ext-store"], "never the unrelated file");

  const outside = judgeSectionOf(manifest, "ext-store");
  assert.deepEqual(outside.bodies, ["b-mjs"], "the file whose text names the store");
  assert.equal(judgeSectionOf(manifest, "d-mjs").candidates.length, 0);
  assert.equal(judgeSectionOf(manifest, "nobody"), null);

  const request = JSON.parse(JSON.stringify(judgeRequestOf(manifest, "b-mjs", "show the saver")));
  assert.ok(isJudgeRequest(request));
  assert.equal(isRequest(request), false);
  const slots = judgeSlotsFor(request.state.architecture);
  assert.deepEqual(Object.keys(slots), [
    roleSlot("b-mjs", "persistence"), roleSlot("b-mjs", "config"), relationSlot("c-a-mjs--b-mjs"), relationSlot("c-b-mjs--ext-store"),
  ], "a role question only for the body file, several roles each yes or none");
  assert.deepEqual(slots[roleSlot("b-mjs", "persistence")], [YES, NONE]);
  assert.deepEqual(slots[relationSlot("c-b-mjs--ext-store")], ["calls", "stores-in", NONE]);

  // The body whole; of the other files, only the lines holding what a pair rests on.
  const evidence = focusedEvidence(own, manifest, FILES);
  assert.deepEqual(evidence.bodies, [{ path: "b.mjs", text: FILES["b-mjs"] }]);
  assert.deepEqual(evidence.lines, [{ path: "a.mjs", line: 1, text: "import { save } from \"./b.mjs\";" }]);
  assert.equal(JSON.stringify(evidence).includes("unrelated"), false);
});

test("the whole view is structure only: files, facts and imports declared, the outside unknown, no role and no judged relation", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await mapGraph();
  const planned = await plan(working, manifest);
  assert.equal(planned.outcome, "step");
  const added = changesOf(planned);
  assert.deepEqual(added.filter(change => change.kind === "region").map(change => [change.id, change.label]), [
    ["arch-a-mjs", "a.mjs"], ["arch-b-mjs", "b.mjs"], ["arch-c-json", "c.json"], ["arch-d-mjs", "d.mjs"], ["arch-ext-store", "store"],
    ["arch-fact-store-key", "c.json /key = \"k1\""],
  ], "each file by its own path, each fact by where it is written and what it says");
  assert.deepEqual(added.filter(change => change.kind !== "region").map(change => `${change.from}->${change.to}`),
    ["arch-a-mjs->arch-b-mjs", "arch-fact-store-key->arch-c-json"]);

  const claimOf = id => claimsOf(planned).find(claim => claim.record.id === id);
  assert.deepEqual(claimOf("arch-a-mjs"), { record: { type: "region", id: "arch-a-mjs" }, origin: "source-declared", basis: [{ path: "a.mjs" }] });
  assert.deepEqual(claimOf("arch-ext-store"), { record: { type: "region", id: "arch-ext-store" }, origin: "unknown", basis: [{ scope: "external" }] });
  assert.deepEqual(claimOf("arch-import-a-mjs-to-b-mjs").basis, [{ path: "a.mjs", specifier: "./b.mjs", resolution: "relative" }]);
  assert.deepEqual(claimOf("arch-fact-store-key").basis, [{ path: "c.json", pointer: "/key" }]);
  assert.equal(claimsOf(planned).some(claim => claim.origin === "model-inferred" || claim.origin === "scope-declared"), false,
    "with no focus nothing is judged: no role, no role node, no chosen relation");
  const next = await appendAll(working, planned);
  assert.equal(next.decisions.length, 1 + planned.steps.length);
});

test("a focus adds the relations and the several roles Jev confirmed from that section's text, and nothing unsure", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await appendAll(await mapGraph(), await plan(await mapGraph(), manifest));
  const planned = await plan(working, manifest, {
    focus: "b-mjs",
    judge: {
      [roleSlot("b-mjs", "persistence")]: YES,
      [roleSlot("b-mjs", "config")]: choice(YES, 0.3),
      [relationSlot("c-b-mjs--ext-store")]: "stores-in",
      [relationSlot("c-a-mjs--b-mjs")]: choice("calls", 0.4),
    },
  });
  assert.equal(planned.outcome, "step");
  assert.deepEqual(changesOf(planned), [
    { change: "added", kind: "region", id: "arch-role-persistence", label: "role:persistence" },
    { change: "added", from: "arch-b-mjs", to: "arch-ext-store" },
    { change: "added", from: "arch-b-mjs", to: "arch-role-persistence" },
  ], "the role's node first, then the confident relation and the role's edge; nothing unsure");
  assert.deepEqual(claimsOf(planned), [
    { record: { type: "region", id: "arch-role-persistence" }, origin: "scope-declared", basis: [{ vocabulary: "roles", key: "persistence" }] },
    { record: { type: "relation", id: "arch-stores-in-b-mjs-to-ext-store" }, origin: "model-inferred", basis: [{ candidate: "c-b-mjs--ext-store" }] },
    { record: { type: "relation", id: "arch-has-role-b-mjs-to-persistence" }, origin: "model-inferred", basis: [{ path: "b.mjs" }] },
  ], "the node is the scope's term; the edge is Jev's, judged from the file's own text");
  const drawn = (await appendAll(working, planned)).records.find(record => record.id === "arch-has-role-b-mjs-to-persistence");
  assert.deepEqual(drawn, { type: "relation", id: "arch-has-role-b-mjs-to-persistence", from: "arch-b-mjs", to: "arch-role-persistence", kind: "has-role", label: "has-role" },
    "a native provider relation");

  const both = await plan(working, manifest, {
    focus: "b-mjs",
    judge: { [roleSlot("b-mjs", "persistence")]: YES, [roleSlot("b-mjs", "config")]: YES },
  });
  assert.deepEqual(claimsOf(both).filter(claim => claim.record.id.startsWith("arch-has-role-")).map(claim => claim.record.id),
    ["arch-has-role-b-mjs-to-persistence", "arch-has-role-b-mjs-to-config"], "a file may have several roles");

  const after = await appendAll(working, planned);
  const repeat = await plan(after, manifest, {
    focus: "b-mjs", judge: { [roleSlot("b-mjs", "persistence")]: YES, [relationSlot("c-b-mjs--ext-store")]: "stores-in" },
  });
  assert.deepEqual(repeat, { outcome: "no-change", reason: "architecture-nothing-new" }, "the same judgement again adds nothing");
  const none = await plan(after, manifest, { focus: "b-mjs" });
  assert.deepEqual(none, { outcome: "no-change", reason: "architecture-nothing-new" }, "a later none takes nothing back");
});

test("a role judged later is drawn even when every relation of the section is already there", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const whole = await appendAll(await mapGraph(), await plan(await mapGraph(), manifest));
  const related = await appendAll(whole, await plan(whole, manifest, { focus: "b-mjs", judge: { [relationSlot("c-b-mjs--ext-store")]: "stores-in" } }));
  const roled = await plan(related, manifest, { focus: "b-mjs", judge: { [roleSlot("b-mjs", "persistence")]: YES, [relationSlot("c-b-mjs--ext-store")]: "stores-in" } });
  assert.equal(roled.outcome, "step", "the role alone is a change of the graph");
  assert.deepEqual(changesOf(roled).map(change => change.id ?? `${change.from}->${change.to}`),
    ["arch-role-persistence", "arch-b-mjs->arch-role-persistence"]);
  // A second file given a role whose node is drawn adds only its edge.
  const withRole = await appendAll(related, roled);
  const second = await plan(withRole, manifest, { focus: "a-mjs", judge: { [roleSlot("a-mjs", "persistence")]: YES } });
  assert.deepEqual(changesOf(second), [{ change: "added", from: "arch-a-mjs", to: "arch-role-persistence" }]);
});

test("a view larger than the provider takes in one Decision is split at the limit passed in, never refused or cut short", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `part-${String(index).padStart(2, "0")}`);
  const manifest = readManifest({
    ...structuredClone(MANIFEST),
    files: many.map(id => ({ path: `${id}.mjs`, blob: "1".repeat(40), class: "admitted", entity: `${id}-mjs` })),
    entities: many.map(id => ({ id: `${id}-mjs`, label: `${id}.mjs`, kind: "file", path: `${id}.mjs` })),
    imports: many.slice(1).map((id, index) => ({ from: `${many[index]}-mjs`, to: `${id}-mjs`, path: `${many[index]}.mjs`, specifier: `./${id}.mjs`, resolution: "relative" })),
    candidates: [],
    facts: [],
  });
  const working = await mapGraph();
  const planned = await plan(working, manifest);
  assert.equal(planned.outcome, "step", planned.detail);
  assert.deepEqual(planned.steps.map(item => item.step.changes.length), [32, 32, 15]);
  assert.equal(MAX_DECISION_OPERATIONS, 32, "the split above is the provider's own limit");
  const next = await appendAll(working, planned);
  assert.equal(next.records.filter(record => record.type === "region").length, 1 + 40);
  const { turn } = turnFor(working, manifest);
  await assert.rejects(planArchitecture({
    working, turn, judged: null, manifest, protocol, operationsMax: undefined,
    answers: answerFor(turn.slots, { action: ACTION_ARCHITECTURE }),
  }), /operation limit/u, "no limit of its own");
});

test("an unsure action, a stale head or an answer off the questions changes nothing", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await mapGraph();
  assert.deepEqual(await plan(working, manifest, { intent: { action: choice(ACTION_ARCHITECTURE, 0.2) } }), { outcome: "no-change", reason: "not-confident" });
  const { turn } = turnFor(working, manifest);
  const stale = await planArchitecture({
    working, turn: { ...turn, head: "sha256:other" }, judged: null, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS,
    answers: answerFor(turn.slots, { action: ACTION_ARCHITECTURE }),
  });
  assert.equal(stale.reason, "stale");
  const off = await plan(working, manifest, { focus: "b-mjs", judge: { [roleSlot("b-mjs", "persistence")]: "invented" } });
  assert.equal(off.reason, "answer-invalid");
  assert.equal(focusOf(turn, answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: choice("b-mjs", 0.3) })), null, "an unsure focus is none");
});

test("this package's whole snapshot, drawn, still fits the intent's bounds", async t => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ui-architecture-"));
  const prepared = spawnSync(process.execPath, [
    "--experimental-vm-modules", path.join(here, "../architecture/prepare.mjs"),
    "--scope", path.join(here, "../architecture/scope.v1.json"), "--root", path.join(here, ".."), "--commit", COMMIT, "--out", out,
  ], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const manifest = readManifest(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")));
  assert.equal(manifest.status, "available", manifest.reason);
  // The scenario the browser test walks: the whole view, then the page's
  // file, the credential and the decision log, each with its roles and pairs.
  let working = await mapGraph();
  const units = [];
  const say = async (focus, judge) => {
    const planned = await plan(working, manifest, { focus, judge });
    assert.equal(planned.outcome, "step", `${focus}: ${planned.reason}`);
    units.push({ changes: changesOf(planned) });
    working = await appendAll(working, planned);
  };
  await say(null, {});
  await say("web-app-mjs", {
    ...Object.fromEntries(["voice-input", "jev-boundary", "graph-mutation", "persistence"].map(role => [roleSlot("web-app-mjs", role), YES])),
    [relationSlot("c-web-app-mjs--functions-pages-worker-mjs")]: "calls",
    [relationSlot("c-web-app-mjs--ext-localstorage")]: "stores-in",
    [relationSlot("c-web-app-mjs--src-log-mjs")]: "calls",
  });
  await say("ext-jev-api-key", {
    [roleSlot("functions-api-jev-mjs", "jev-boundary")]: YES, [roleSlot("functions-api-jev-mjs", "auth")]: YES,
    [roleSlot("dev-serve-mjs", "auth")]: YES, [roleSlot("dev-serve-mjs", "config")]: YES,
    [relationSlot("c-functions-api-jev-mjs--ext-jev-api-key")]: "authenticates-with",
    [relationSlot("c-functions-api-jev-mjs--ext-api-typesafe-ai")]: "calls",
  });
  await say("src-log-mjs", { [roleSlot("src-log-mjs", "persistence")]: YES });
  const intent = withArchitecture(plainFor(working, units), manifest);
  assert.ok(isRequest(JSON.parse(JSON.stringify(intent.request))), "the drawn scenario, its utterances included, is a valid intent");
  const { regions, edges } = intent.request.state.graph;
  assert.ok(regions.length <= 128 && edges.length <= 128);
  t.diagnostic(`scenario graph: ${regions.length} regions, ${edges.length} edges `
    + `(${edges.filter(edge => edge.id.startsWith("arch-has-role-")).length} has-role), `
    + `${units.length} utterances with ${units.map(unit => unit.changes.length).join("/")} changes; bound 128/128`);
});
