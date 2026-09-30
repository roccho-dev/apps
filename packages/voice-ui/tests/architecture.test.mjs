import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  focusedEvidence,
  judgeRequestOf,
  judgeSectionOf,
  locateRequestsOf,
  locatedOf,
  planArchitecture,
  readManifest,
  routeOf,
  withArchitecture,
} from "../src/architecture.mjs";
import { readBundle } from "../src/bundle.mjs";
import {
  ACTION_ARCHITECTURE,
  ARCHITECTURE_INTENT_KIND,
  ARCHITECTURE_LOCATE_KIND,
  NONE,
  REQUEST_KIND,
  WHOLE,
  YES,
  isJudgeRequest,
  isLocateRequest,
  isRequest,
  judgeSlotsFor,
  locateSlotsFor,
  relationSlot,
  relevantSlot,
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
  // Without a part, this fixture asks for the whole - explicitly, as Jev must.
  const answers = answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: focus ?? WHOLE, ...intent });
  const request = focus === null ? null : judgeRequestOf(manifest, [focus], "show it");
  const judged = request === null ? null
    : { section: request.state.architecture, answers: answerFor(judgeSlotsFor(request.state.architecture), judge) };
  return planArchitecture({ working, turn, answers, judged, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS });
};
// Every locate frame of an intent as the page sends them, each with its answer.
const framesFor = (manifest, request, picks = {}) => locateRequestsOf(manifest, request)
  .map(frame => ({ request: frame, answers: answerFor(locateSlotsFor(frame.state.architecture.focus), picks) }));

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
  assert.deepEqual(turn.slots.focus, ["a-mjs", "b-mjs", "c-json", "d-mjs", "ext-store", WHOLE, NONE]);
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
  const own = judgeSectionOf(manifest, ["b-mjs"]);
  assert.deepEqual(own.focus, ["b-mjs"]);
  assert.deepEqual(own.bodies, ["b-mjs"]);
  assert.deepEqual(own.candidates.map(candidate => candidate.id), ["c-a-mjs--b-mjs", "c-b-mjs--ext-store"]);
  assert.deepEqual(own.entities.map(entity => entity.id), ["a-mjs", "b-mjs", "ext-store"], "never the unrelated file");

  const outside = judgeSectionOf(manifest, ["ext-store"]);
  assert.deepEqual(outside.bodies, ["b-mjs"], "the file whose text names the store");
  assert.equal(judgeSectionOf(manifest, ["d-mjs"]).candidates.length, 0);
  for (const focus of [["nobody"], [], "b-mjs", ["b-mjs", "a-mjs"], ["a-mjs", "a-mjs"]]) {
    assert.equal(judgeSectionOf(manifest, focus), null, `${JSON.stringify(focus)} is no focus: known parts, sorted, once each`);
  }

  const request = JSON.parse(JSON.stringify(judgeRequestOf(manifest, ["b-mjs"], "show the saver")));
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
  assert.deepEqual(routeOf(turn, answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: choice("b-mjs", 0.3) })), { route: "locate" },
    "an unsure part is located, never taken as named");
  assert.equal(routeOf(turn, answerFor(turn.slots, { action: choice(ACTION_ARCHITECTURE, 0.3), focus: NONE })), null, "an unsure action goes nowhere");
});

test("only a confident whole draws the structure; none or any unsure focus is located, and nothing located is an honest no-change", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await mapGraph();
  const { turn, request: intent } = turnFor(working, manifest);
  const nothing = framesFor(manifest, intent);
  for (const focus of [NONE, choice(WHOLE, 0.3), choice("b-mjs", 0.3), choice(NONE, 0.2)]) {
    const answers = answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus });
    assert.deepEqual(routeOf(turn, answers), { route: "locate" }, JSON.stringify(focus));
    assert.deepEqual(await planArchitecture({ working, turn, answers, located: nothing, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS }),
      { outcome: "no-change", reason: "architecture-focus-unclear" }, JSON.stringify(focus));
    await assert.rejects(planArchitecture({ working, turn, answers, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS }),
      /an unclear focus is located before it is planned/u, "never planned without its locate");
  }
  assert.deepEqual(routeOf(turn, answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: WHOLE })), { route: "whole" }, "the whole is never a part");
  await assert.rejects(planArchitecture({
    working, turn, answers: answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: WHOLE }), located: nothing,
    manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS,
  }), /only an unclear focus is located/u, "the whole reads no code");

  // The whole, confidently: the structure, at the weaker of the two confidences.
  const whole = await planArchitecture({
    working, turn, judged: null, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS,
    answers: answerFor(turn.slots, { action: choice(ACTION_ARCHITECTURE, 0.9), focus: choice(WHOLE, 0.6) }),
  });
  assert.equal(whole.outcome, "step");
  assert.ok(whole.steps.every(item => item.step.confidence === 0.6));
  assert.equal(claimsOf(whole).some(claim => claim.origin === "model-inferred"), false);

  // A section judged for another focus than the answer's is a caller error, never drawn.
  const request = judgeRequestOf(manifest, ["b-mjs"], "show it");
  await assert.rejects(planArchitecture({
    working, turn, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS,
    answers: answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: WHOLE }),
    judged: { section: request.state.architecture, answers: answerFor(judgeSlotsFor(request.state.architecture), {}) },
  }), /the whole is never judged/u);
});

test("a part confidently asked for that no section opens is refused, never drawn as the whole", async () => {
  // A snapshot of its own: one more external part that no admitted file names.
  const source = structuredClone(MANIFEST);
  source.entities.push({ id: "ext-orphan", label: "orphan", kind: "external" });
  const manifest = readManifest(source);
  assert.equal(manifest.status, "available", manifest.reason);
  assert.equal(judgeSectionOf(manifest, ["ext-orphan"]), null, "no admitted file names it");
  const working = await mapGraph();
  const { turn } = turnFor(working, manifest);
  const answers = answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: "ext-orphan" });
  assert.deepEqual(routeOf(turn, answers), { route: "part", focus: ["ext-orphan"] });
  assert.deepEqual(await planArchitecture({ working, turn, answers, judged: null, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS }),
    { outcome: "refused", reason: "architecture-judge-missing" });
});

test("a locate is one frame per part the snapshot knows, in its order: the utterance, the conversation and that one part - never any code", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const { request } = turnFor(await mapGraph(), manifest);
  const frames = JSON.parse(JSON.stringify(locateRequestsOf(manifest, request)));
  assert.deepEqual(frames, manifest.entities.map(entity => ({
    kind: ARCHITECTURE_LOCATE_KIND,
    state: { utterance: request.state.utterance, context: request.state.context, architecture: { source: manifest.source, focus: [entity.id] } },
  })), "files and outside parts alike, derived from the manifest");
  for (const frame of frames) {
    assert.ok(isLocateRequest(frame));
    assert.equal(isRequest(frame), false);
    assert.equal(isJudgeRequest(frame), false);
  }
  for (const text of Object.values(FILES)) assert.equal(JSON.stringify(frames).includes(text.trim()), false, "no file text");
  const [locate] = frames;
  const architecture = locate.state.architecture;
  const broken = [
    { ...locate, extra: 1 },
    { ...locate, state: { ...locate.state, graph: request.state.graph } },
    { ...locate, state: { utterance: locate.state.utterance, architecture } },
    { ...locate, state: { ...locate.state, architecture: { source: manifest.source } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, focus: ["a-mjs", "b-mjs"] } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, focus: [] } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, focus: "a-mjs" } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, focus: [NONE] } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, focus: [WHOLE] } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, evidence: { bodies: [] } } } },
    { ...locate, state: { ...locate.state, architecture: { ...architecture, source: { ...manifest.source, commit: "HEAD" } } } },
    { ...locate, state: { ...locate.state, context: { recent: [{ seq: 1, source: "typed", text: "x", outcome: "invented" }] } } },
  ];
  for (const value of broken) assert.equal(isLocateRequest(value), false, JSON.stringify(value.state).slice(0, 120));
});

test("a locate is every frame answered, exactly as sent, or nothing; what it found is exactly every confident yes, sorted", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const { request } = turnFor(await mapGraph(), manifest);
  const found = locatedOf(manifest, framesFor(manifest, request, {
    [relevantSlot("ext-store")]: choice(YES, 0.7), [relevantSlot("b-mjs")]: choice(YES, 0.9), [relevantSlot("a-mjs")]: choice(YES, 0.4),
  }));
  assert.deepEqual(found, { focus: ["b-mjs", "ext-store"], confidence: 0.7 }, "an unsure yes is not found");
  assert.deepEqual(locatedOf(manifest, framesFor(manifest, request)).focus, [], "every part none: nothing found");

  const frames = framesFor(manifest, request);
  const other = turnFor(await mapGraph(), manifest).request;
  const reworded = locateRequestsOf(manifest, { ...other, state: { ...other.state, utterance: "something else" } });
  const answer = frames[1].answers;
  const broken = [
    ["a frame missing", frames.slice(1)],
    ["a frame repeated in another's place", [frames[0], frames[0], ...frames.slice(2)]],
    ["an extra frame", [...frames, frames[0]]],
    ["frames out of the manifest's order", [frames[1], frames[0], ...frames.slice(2)]],
    ["a frame of another utterance", [frames[0], { request: reworded[1], answers: answer }, ...frames.slice(2)]],
    ["a frame of another snapshot", [frames[0], { request: { ...frames[1].request, state: { ...frames[1].request.state,
      architecture: { ...frames[1].request.state.architecture, source: { ...manifest.source, commit: "f".repeat(40) } } } }, answers: answer }, ...frames.slice(2)]],
    ["an answer missing its question", [frames[0], { ...frames[1], answers: {} }, ...frames.slice(2)]],
    ["an answer to another frame's question", [frames[0], { ...frames[1], answers: frames[0].answers }, ...frames.slice(2)]],
    ["an option not offered", [frames[0], { ...frames[1], answers: { [relevantSlot("b-mjs")]: choice("maybe") } }, ...frames.slice(2)]],
    ["no frames", []],
    ["nothing", null],
    // Frames of one shape among themselves, but not a locate frame's shape.
    ["every frame with an empty conversation object", frames.map(frame => ({ ...frame, request: { ...frame.request, state: { ...frame.request.state, context: {} } } }))],
    ["every frame with an empty utterance", frames.map(frame => ({ ...frame, request: { ...frame.request, state: { ...frame.request.state, utterance: "" } } }))],
    ["every frame without its conversation", frames.map(frame => {
      const { context, ...state } = frame.request.state;
      assert.ok(context);
      return { ...frame, request: { ...frame.request, state } };
    })],
  ];
  for (const [label, value] of broken) assert.equal(locatedOf(manifest, value), null, label);
});

test("a snapshot with a part no section opens is never located: the utterance is refused before any frame is asked", async () => {
  const source = structuredClone(MANIFEST);
  source.entities.push({ id: "ext-orphan", label: "orphan", kind: "external" });
  const manifest = readManifest(source);
  assert.equal(manifest.status, "available", manifest.reason);
  const working = await mapGraph();
  const { turn, request } = turnFor(working, manifest);
  assert.equal(locateRequestsOf(manifest, request), null, "no frame is built, and none is left out");
  const answers = answerFor(turn.slots, { action: ACTION_ARCHITECTURE, focus: NONE });
  assert.deepEqual(routeOf(turn, answers), { route: "locate" });
  assert.deepEqual(await planArchitecture({ working, turn, answers, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS }),
    { outcome: "refused", reason: "architecture-judge-missing" });
});

test("every located part is judged together, the judge bound to exactly what was located, at the weakest confidence", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await appendAll(await mapGraph(), await plan(await mapGraph(), manifest));
  const { turn, request } = turnFor(working, manifest);
  const answers = answerFor(turn.slots, { action: choice(ACTION_ARCHITECTURE, 0.9), focus: NONE });
  const located = framesFor(manifest, request, { [relevantSlot("ext-store")]: choice(YES, 0.8), [relevantSlot("a-mjs")]: choice(YES, 0.6) });
  const focus = locatedOf(manifest, located).focus;
  assert.deepEqual(focus, ["a-mjs", "ext-store"]);

  // A part outside the source opens the files that name it: one section for both.
  const section = judgeSectionOf(manifest, focus);
  assert.deepEqual(section.focus, ["a-mjs", "ext-store"]);
  assert.deepEqual(section.bodies, ["a-mjs", "b-mjs"]);
  assert.deepEqual(judgeSectionOf(manifest, ["b-mjs", "ext-store"]).bodies, ["b-mjs"], "a file opened twice is one body");
  const judgeAnswers = answerFor(judgeSlotsFor(section), {
    [roleSlot("a-mjs", "persistence")]: YES, [relationSlot("c-b-mjs--ext-store")]: "stores-in",
  });
  const planned = await planArchitecture({
    working, turn, answers, located, judged: { section, answers: judgeAnswers }, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS,
  });
  assert.equal(planned.outcome, "step");
  assert.deepEqual(claimsOf(planned).map(claim => claim.record.id).sort(),
    ["arch-has-role-a-mjs-to-persistence", "arch-role-persistence", "arch-stores-in-b-mjs-to-ext-store"]);
  assert.ok(planned.steps.every(item => item.step.confidence === 0.6), "the weaker of the action and the weakest located part");

  // Bound exactly: a judge of fewer parts than were located is a caller error.
  const fewer = judgeSectionOf(manifest, ["ext-store"]);
  await assert.rejects(planArchitecture({
    working, turn, answers, located, judged: { section: fewer, answers: answerFor(judgeSlotsFor(fewer), {}) },
    manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS,
  }), /the judged section is the one this answer asked for/u);
  // An incomplete locate - a frame left out, or one answered off its question -
  // is an error, never nothing found.
  for (const incomplete of [located.slice(0, -1), located.map((frame, index) => (index === 3 ? { ...frame, answers: {} } : frame))]) {
    assert.deepEqual(await planArchitecture({ working, turn, answers, located: incomplete, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS }),
      { outcome: "refused", reason: "answer-invalid" });
  }
  // Located, but not judged: nothing is drawn.
  assert.deepEqual(await planArchitecture({ working, turn, answers, located, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS }),
    { outcome: "refused", reason: "architecture-judge-missing" });
});

test("the whole is reserved: no part may be called whole, in the manifest or in an intent", async () => {
  const source = structuredClone(MANIFEST);
  source.files.push({ path: "whole", blob: "7".repeat(40), class: "admitted", entity: "whole" });
  source.entities.push({ id: "whole", label: "whole", kind: "file", path: "whole" });
  assert.equal(readManifest(source).status, "invalid");
  const { request } = turnFor(await mapGraph(), readManifest(structuredClone(MANIFEST)));
  const intent = JSON.parse(JSON.stringify(request));
  assert.ok(isRequest(intent));
  intent.state.architecture.entities.push({ id: WHOLE, label: "whole" });
  assert.equal(isRequest(intent), false);
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
