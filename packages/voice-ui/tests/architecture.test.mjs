import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { planArchitecture, readManifest, withArchitecture } from "../src/architecture.mjs";
import { readBundle } from "../src/bundle.mjs";
import { ACTION_ARCHITECTURE, NONE, isRequest, relationSlot, roleSlot } from "../src/contract.mjs";
import { MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { requestFor } from "../src/turn.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href);
// The provider's own limit, read from the provider, never restated here.
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

// A prepared source of its own: two files importing one another, a store the
// scope names outside them, one candidate by co-occurrence, one declared fact.
const MANIFEST = Object.freeze({
  schema: "voice-ui.architecture-source/1",
  status: "available",
  source: { handle: "fixture", commit: COMMIT },
  files: [
    { path: "a.mjs", blob: "1".repeat(40), class: "admitted", entity: "page-app" },
    { path: "b.mjs", blob: "2".repeat(40), class: "admitted", entity: "saver" },
    { path: "c.json", blob: "3".repeat(40), class: "admitted", entity: "settings" },
    { path: "t.test.mjs", blob: "4".repeat(40), class: "excluded", reason: "test" },
  ],
  entities: [
    { id: "page-app", label: "Page (a.mjs)", kind: "file", path: "a.mjs" },
    { id: "saver", label: "Saver (b.mjs)", kind: "file", path: "b.mjs" },
    { id: "settings", label: "Settings (c.json)", kind: "file", path: "c.json" },
    { id: "browser-store", label: "Browser store", kind: "external" },
  ],
  imports: [{ from: "page-app", to: "saver", path: "a.mjs", specifier: "./b.mjs" }],
  candidates: [
    { id: "c-page-app--saver", from: "page-app", to: "saver", reasons: ["import"] },
    { id: "c-saver--browser-store", from: "saver", to: "browser-store", reasons: ["cooccurrence:localStorage"] },
  ],
  facts: [{ id: "store-key", entity: "settings", path: "c.json", pointer: "/key", value: "k1" }],
  roles: [{ key: "persistence", purpose: "stores data" }, { key: "config", purpose: "declares configuration" }],
  relations: [{ key: "calls", purpose: "calls it" }, { key: "stores-in", purpose: "stores data in it" }],
  coverage: { unsupported: [{ path: "c.json", reason: "not an ES module" }], skipped: [], notAnalyzed: ["dynamic import() is not analyzed"] },
});

const mapGraph = () => protocol.createDecisionLog([
  { type: "meta", schema: STATE_SCHEMA, root: "root", title: "map" },
  { type: "region", id: "root", parent: null, label: "map", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
], MAP_ID);

const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence });
const turnFor = (working, manifest) => withArchitecture(requestFor({
  working, utterance: "show how this code is built", bundle: readBundle(null), layout: null, offeredFrame: null,
  draft: [], focus: null, pending: null, recent: [],
}), manifest);
const answerFor = (turn, picks) => Object.fromEntries(Object.keys(turn.slots).map(name => [
  name, picks[name] === undefined ? choice(NONE) : typeof picks[name] === "string" ? choice(picks[name]) : picks[name],
]));

test("the manifest is read whole: available, unavailable with its reason, or invalid", () => {
  assert.equal(readManifest(structuredClone(MANIFEST)).status, "available");
  assert.deepEqual(readManifest({ schema: "voice-ui.architecture-source/1", status: "unavailable", reason: "dirty" }),
    { status: "unavailable", reason: "dirty" });
  for (const broken of [null, {}, { ...MANIFEST, extra: 1 }, { ...MANIFEST, source: { handle: "fixture", commit: "HEAD" } },
    { ...MANIFEST, candidates: [{ id: "c", from: "page-app", to: "nobody", reasons: ["import"] }] }]) {
    assert.equal(readManifest(broken).status, "invalid");
  }
});

test("the request carries the public section and the questions it implies, and nothing else", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const { turn, request } = turnFor(await mapGraph(), manifest);
  assert.ok(isRequest(JSON.parse(JSON.stringify(request))));
  assert.deepEqual(Object.keys(request.state.architecture).sort(), ["candidates", "entities", "relations", "roles", "source"]);
  assert.equal(JSON.stringify(request).includes("blob"), false, "no identity or text beyond the public section");
  assert.ok(turn.slots.action.includes(ACTION_ARCHITECTURE));
  assert.deepEqual(turn.slots.focus, ["persistence", "config", NONE]);
  assert.deepEqual(turn.slots[roleSlot("browser-store")], ["persistence", "config", NONE]);
  assert.deepEqual(turn.slots[relationSlot("c-saver--browser-store")], ["calls", "stores-in", NONE]);
  const tampered = JSON.parse(JSON.stringify(request));
  tampered.state.architecture.candidates[0].to = "nobody";
  assert.equal(isRequest(tampered), false);
});

test("a view is built from the source only: files and imports declared, roles and relations chosen, the rest unknown", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await mapGraph();
  const { turn } = turnFor(working, manifest);
  const planned = await planArchitecture({
    working, turn, manifest, protocol,
    answers: answerFor(turn, {
      action: ACTION_ARCHITECTURE,
      [roleSlot("saver")]: "persistence",
      [roleSlot("settings")]: choice("config", 0.3),
      [relationSlot("c-saver--browser-store")]: "stores-in",
      [relationSlot("c-page-app--saver")]: choice("calls", 0.4),
    }),
  });
  assert.equal(planned.outcome, "step");
  const added = changesOf(planned);
  assert.deepEqual(added.filter(change => change.kind === "region").map(change => change.id).sort(),
    ["arch-browser-store", "arch-page-app", "arch-saver", "arch-settings"]);
  assert.deepEqual(added.filter(change => change.kind !== "region").map(change => `${change.from}->${change.to}`).sort(),
    ["arch-page-app->arch-saver", "arch-saver->arch-browser-store"], "the import, and the one confident relation");
  assert.deepEqual(planned.steps.map(item => item.step.changes.length), [4, 1, 1],
    "regions, then the declared import, then the chosen relation - which Undo removes first");

  const claimOf = (id, origin) => claimsOf(planned).find(claim => claim.record.id === id && claim.origin === origin);
  assert.deepEqual(claimOf("arch-page-app", "source-declared").basis, [{ path: "a.mjs" }]);
  assert.deepEqual(claimOf("arch-browser-store", "unknown").basis, [{ scope: "external" }]);
  assert.deepEqual(claimOf("arch-import-page-app-to-saver", "source-declared").basis, [{ path: "a.mjs", specifier: "./b.mjs" }]);
  assert.deepEqual(claimOf("arch-stores-in-saver-to-browser-store", "model-inferred").basis, [{ candidate: "c-saver--browser-store" }]);
  assert.equal(claimOf("arch-saver", "model-inferred").role, "persistence");
  assert.equal(claimOf("arch-settings", "model-inferred"), undefined, "an unsure role is no role");
  assert.equal(claimsOf(planned).some(claim => claim.record.id.startsWith("arch-calls")), false, "an unsure relation is not drawn");
  assert.equal(claimsOf(planned).some(claim => claim.origin === "source-declared" && claim.basis.some(entry => entry.candidate)), false,
    "a model-selected relation is never source-declared");
  assert.ok(planned.steps.at(-1).claims.some(claim => claim.role === "persistence"), "roles come with the last step");

  // The provider built each step on the one before: consecutive Decisions.
  const next = await appendAll(working, planned);
  assert.equal(next.decisions.length, 1 + planned.steps.length);
});

test("a view larger than the provider takes in one Decision is split, never refused or cut short", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `part-${String(index).padStart(2, "0")}`);
  const manifest = readManifest({
    ...structuredClone(MANIFEST),
    files: many.map(id => ({ path: `${id}.mjs`, blob: "1".repeat(40), class: "admitted", entity: id })),
    entities: many.map(id => ({ id, label: id, kind: "file", path: `${id}.mjs` })),
    imports: many.slice(1).map((id, index) => ({ from: many[index], to: id, path: `${many[index]}.mjs`, specifier: `./${id}.mjs` })),
    candidates: [],
    facts: [],
  });
  const working = await mapGraph();
  const { turn } = turnFor(working, manifest);
  const planned = await planArchitecture({ working, turn, manifest, protocol, answers: answerFor(turn, { action: ACTION_ARCHITECTURE }) });
  assert.equal(planned.outcome, "step", planned.detail);
  assert.ok(planned.steps.length > 2);
  for (const { step } of planned.steps) assert.ok(step.changes.length <= MAX_DECISION_OPERATIONS);
  assert.equal(changesOf(planned).length, 40 + 39, "every region and every import, nothing dropped");
  const next = await appendAll(working, planned);
  assert.equal(next.records.filter(record => record.type === "region").length, 1 + 40);
});

test("a focus adds the declared facts of the entities in that role, and a repeat adds nothing", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const first = await mapGraph();
  const firstTurn = turnFor(first, manifest).turn;
  const whole = await planArchitecture({
    working: first, turn: firstTurn, manifest, protocol,
    answers: answerFor(firstTurn, { action: ACTION_ARCHITECTURE, [roleSlot("settings")]: "config" }),
  });
  const working = await appendAll(first, whole);
  const { turn } = turnFor(working, manifest);
  const focused = await planArchitecture({
    working, turn, manifest, protocol,
    answers: answerFor(turn, { action: ACTION_ARCHITECTURE, focus: "config", [roleSlot("settings")]: "config" }),
  });
  assert.equal(focused.outcome, "step");
  assert.deepEqual(changesOf(focused).map(change => change.id ?? `${change.from}->${change.to}`),
    ["arch-fact-store-key", "arch-fact-store-key->arch-settings"]);
  assert.equal(changesOf(focused)[0].label, "/key: k1");
  assert.ok(claimsOf(focused).every(claim => claim.origin !== "source-declared" || claim.basis.every(entry => entry.pointer === "/key")));

  const after = await appendAll(working, focused);
  const again = turnFor(after, manifest).turn;
  const repeat = await planArchitecture({
    working: after, turn: again, manifest, protocol,
    answers: answerFor(again, { action: ACTION_ARCHITECTURE, focus: "config", [roleSlot("settings")]: "config" }),
  });
  assert.deepEqual(repeat, { outcome: "no-change", reason: "architecture-nothing-new" });
});

test("an unsure action, a stale head or an answer off the questions changes nothing", async () => {
  const manifest = readManifest(structuredClone(MANIFEST));
  const working = await mapGraph();
  const { turn } = turnFor(working, manifest);
  const unsure = await planArchitecture({ working, turn, manifest, protocol, answers: answerFor(turn, { action: choice(ACTION_ARCHITECTURE, 0.2) }) });
  assert.deepEqual(unsure, { outcome: "no-change", reason: "not-confident" });
  const stale = await planArchitecture({ working, turn: { ...turn, head: "sha256:other" }, manifest, protocol, answers: answerFor(turn, { action: ACTION_ARCHITECTURE }) });
  assert.equal(stale.reason, "stale");
  const off = answerFor(turn, { action: ACTION_ARCHITECTURE, [roleSlot("saver")]: "invented-role" });
  assert.equal((await planArchitecture({ working, turn, manifest, protocol, answers: off })).reason, "answer-invalid");
});
