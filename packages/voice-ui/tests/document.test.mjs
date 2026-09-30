import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { judgeRequestOf, planArchitecture, readManifest, withArchitecture } from "../src/architecture.mjs";
import { readBundle } from "../src/bundle.mjs";
import { ACTION_ARCHITECTURE, NONE, YES, judgeSlotsFor, relationSlot, roleSlot } from "../src/contract.mjs";
import { EVIDENCE_CURRENT, commitDocument, currentClaims, restoreDocument } from "../src/document.mjs";
import { COMMIT_COMMITTED, MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { createSession, draftForJev, draftUsed, proposeArchitecture, startNew, undo } from "../src/session.mjs";
import { requestFor } from "../src/turn.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href);
const { MAX_DECISION_OPERATIONS } = await import(pathToFileURL(path.join(store, "packages/semantic-map/domain/operation.js")).href);
const { verifyDecisionLog } = protocol;

const KEY = "document test key";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = Object.freeze({
  schema: "voice-ui.architecture-source/1",
  status: "available",
  source: { handle: "fixture", commit: COMMIT },
  files: [
    { path: "a.mjs", blob: "1".repeat(40), class: "admitted", entity: "a-mjs" },
    { path: "b.mjs", blob: "2".repeat(40), class: "admitted", entity: "b-mjs" },
    { path: "c.json", blob: "3".repeat(40), class: "admitted", entity: "c-json" },
  ],
  entities: [
    { id: "a-mjs", label: "a.mjs", kind: "file", path: "a.mjs" },
    { id: "b-mjs", label: "b.mjs", kind: "file", path: "b.mjs" },
    { id: "c-json", label: "c.json", kind: "file", path: "c.json" },
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
  coverage: { unsupported: [], skipped: [], notAnalyzed: [] },
});
const MANIFEST = readManifest(structuredClone(SOURCE));
// The same snapshot as someone else might claim it, to make a document that
// the real snapshot must refuse.
const lying = change => readManifest({ ...structuredClone(SOURCE), ...change(structuredClone(SOURCE)) });

// JSON with every object's keys sorted, as a stored provenance line is.
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

// Storage as the browser has it, and a lock that runs holders in turn.
const storage = () => {
  const values = new Map();
  return {
    values,
    read: async key => values.get(key) ?? null,
    write: async (key, value) => { values.set(key, value); },
    lock: (name, run) => run(),
  };
};

const choice = value => ({ type: "choice", choice: value, confidence: 0.9 });
const answering = (slots, picks) => Object.fromEntries(Object.keys(slots).map(name => [name, choice(picks[name] ?? NONE)]));

// One architecture utterance planned on a graph, as the page plans it: the
// whole view without a focus, or a focus judged with these picks.
const planOn = async (working, manifest, focus = null, picks = {}) => {
  const { turn } = withArchitecture(requestFor({
    working, utterance: "show the code", bundle: readBundle(null), layout: null, offeredFrame: null,
    draft: [], focus: null, pending: null, recent: [],
  }), manifest);
  const answers = answering(turn.slots, { action: ACTION_ARCHITECTURE, ...(focus === null ? {} : { focus }) });
  const request = focus === null ? null : judgeRequestOf(manifest, focus, "show it");
  const judged = request === null ? null
    : { section: request.state.architecture, answers: answering(judgeSlotsFor(request.state.architecture), picks) };
  return planArchitecture({ working, turn, answers, judged, manifest, protocol, operationsMax: MAX_DECISION_OPERATIONS });
};
const appendAll = async (working, planned) => {
  let graph = working;
  for (const { step } of planned.steps) graph = (await protocol.appendDecision(graph.log, step.decision)).verified;
  return graph;
};
const newMap = () => protocol.createDecisionLog([
  { type: "meta", schema: STATE_SCHEMA, root: "root", title: "map" },
  { type: "region", id: "root", parent: null, label: "map", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
], MAP_ID);

// The person's new map, the whole view on it, then a focus on b.mjs that Jev
// judged - as the page would hold them in its draft before Apply.
const drafted = async (manifest = MANIFEST, picks = { [roleSlot("b-mjs", "persistence")]: YES, [relationSlot("c-b-mjs--ext-store")]: "stores-in" }) => {
  const created = await newMap();
  const whole = await planOn(created, manifest);
  const viewed = await appendAll(created, whole);
  const focused = await planOn(viewed, manifest, "b-mjs", picks);
  const graph = await appendAll(viewed, focused);
  return { created, graph, draft: [{ step: { decision: created.decisions[0] } }, ...whole.steps, ...focused.steps], whole, focused };
};

const commitWith = (origin, graph, draft, saved, expected, manifest = MANIFEST) => commitDocument({
  graph, draft, saved, expected, key: KEY, read: origin.read, write: origin.write, lock: origin.lock, verifyDecisionLog, manifest,
});

test("a document is the provider's own log, line for line, each Decision paired with its provenance", async () => {
  const origin = storage();
  const { graph, draft } = await drafted();
  const result = await commitWith(origin, graph, draft, null, null);
  assert.equal(result.status, COMMIT_COMMITTED, result.reason);
  const lines = result.stored.split("\n").slice(0, -1);
  assert.equal(lines.length, 1 + 2 * graph.decisions.length);
  assert.deepEqual(JSON.parse(lines[0]), { schema: "voice-ui.architecture-document/1", source: { commit: COMMIT, handle: "fixture" } });
  assert.deepEqual(lines.filter((_, index) => index % 2 === 1), graph.log.split("\n").slice(0, -1), "the Decisions are unchanged");
  assert.equal(result.stored.includes("confidence"), false, "no raw answer or confidence is stored");

  const restored = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST });
  assert.equal(restored.status, "restored", restored.reason);
  assert.equal(restored.evidence, EVIDENCE_CURRENT);
  assert.equal(restored.graph.head, graph.head);
  const claims = currentClaims(restored.provenance, restored.graph.records);
  const origins = id => claims.find(entry => entry.record.id === id)?.claims.map(claim => claim.origin);
  assert.deepEqual(origins("root"), ["user-asserted"], "the person's map is theirs");
  assert.deepEqual(origins("arch-b-mjs"), ["source-declared", "model-inferred"],
    "a file exists in the source; the role Jev gave it later annotates the same region");
  assert.deepEqual(origins("arch-stores-in-b-mjs-to-ext-store"), ["model-inferred"]);
  assert.deepEqual(origins("arch-import-a-mjs-to-b-mjs"), ["source-declared"]);
  assert.deepEqual(origins("arch-ext-store"), ["unknown"]);
  assert.deepEqual(origins("arch-fact-store-key"), ["source-declared"]);
});

test("one architecture utterance is one entry of the draft: counted, sent and undone whole", async () => {
  const { session: started } = await startNew(createSession({ accepted: null, stored: null }), { title: "map", protocol });
  const { turn } = withArchitecture(requestFor({
    working: started.working, utterance: "show the code", bundle: readBundle(null), layout: null, offeredFrame: null,
    draft: [], focus: null, pending: null, recent: [],
  }), MANIFEST);
  // A small limit, so that one utterance takes several Decisions.
  const planned = await planArchitecture({
    working: started.working, turn, answers: answering(turn.slots, { action: ACTION_ARCHITECTURE }), judged: null,
    manifest: MANIFEST, protocol, operationsMax: 3,
  });
  assert.equal(planned.steps.length, 3);
  const { session: viewed } = await proposeArchitecture(started, { planned, input: { source: "typed", text: "show the code" }, protocol });
  assert.equal(viewed.draft.length, 1 + 3, "every Decision is its own step");
  assert.equal(draftUsed(viewed), 2, "but the utterance counts once");
  assert.deepEqual(draftForJev(viewed).at(-1).changes, planned.steps.flatMap(item => item.step.changes), "and is sent as one");
  assert.deepEqual(viewed.draft.slice(1).map(item => item.input === null), [false, true, true], "only its first step carries it");

  const back = await undo(viewed, { verifyDecisionLog });
  assert.equal(back.draft.length, 1, "Undo takes every Decision of the utterance back");
  assert.equal(back.working.head, started.working.head);
  assert.equal(back.conversation.at(-1).outcome, "undone");
});

test("Apply only ever grows the stored document, and a person's own step is claimed as theirs", async () => {
  const origin = storage();
  const { graph, draft } = await drafted();
  const first = await commitWith(origin, graph, draft, null, null);
  const saved = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST });

  const relation = graph.records.find(record => record.type === "relation" && record.id === "arch-stores-in-b-mjs-to-ext-store");
  const { decision } = await protocol.createDecision(graph.head, [{ type: "RemoveSelection", regionIds: [], relationIds: [relation.id] }], graph.records);
  const next = (await protocol.appendDecision(graph.log, decision)).verified;
  const second = await commitWith(origin, next, [{ step: { decision } }], saved, first.stored);
  assert.equal(second.status, COMMIT_COMMITTED, second.reason);
  assert.ok(second.stored.startsWith(first.stored), "strictly appended");
  const restored = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST });
  assert.equal(restored.provenance.at(-1).claims[0].origin, "user-asserted");
  assert.equal(restored.provenance.at(-1).claims[0].change, "removed");
  assert.equal(currentClaims(restored.provenance, restored.graph.records).some(entry => entry.record.id === relation.id), false);

  assert.equal((await commitWith(origin, next, [{ step: { decision } }], saved, first.stored)).status, "conflict",
    "a page that saw an older value is refused");
});

test("a changed, reordered or incomplete document fails closed, and its bytes are left where they are", async () => {
  const { graph, draft } = await drafted();
  const good = (await commitWith(storage(), graph, draft, null, null)).stored;
  const lines = good.split("\n").slice(0, -1);
  const variants = {
    "a provenance line that is not canonical": [lines[0], lines[1], lines[2].replace("{", "{ "), ...lines.slice(3)],
    "provenance naming another Decision": [lines[0], lines[1], lines[4], lines[3], lines[2]],
    "a missing provenance line": lines.slice(0, -1),
    "another header": [JSON.stringify({ schema: "voice-ui.architecture-document/2", source: { commit: COMMIT, handle: "fixture" } }), ...lines.slice(1)],
    "a claim about a record the Decision did not leave": [lines[0], lines[1],
      lines[2].replace('"root"', '"not-there"'), ...lines.slice(3)],
  };
  for (const [label, bad] of Object.entries(variants)) {
    const origin = storage();
    const bytes = `${bad.join("\n")}\n`;
    origin.values.set(KEY, bytes);
    const restored = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST });
    assert.notEqual(restored.status, "restored", label);
    assert.equal(origin.values.get(KEY), bytes, `${label}: nothing is deleted or rewritten`);
  }
});

// A document refused by the snapshot it cites, its bytes kept as they are.
const refusedAs = async (bytes, pattern, label) => {
  const origin = storage();
  origin.values.set(KEY, bytes);
  const restored = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST });
  assert.equal(restored.status, "corrupt", label);
  assert.match(restored.reason, pattern, label);
  assert.equal(origin.values.get(KEY), bytes, `${label}: nothing is deleted or rewritten`);
};

test("every source claim is bound to what its own Decision did and to what the cited snapshot grounds", async () => {
  const { graph, draft, whole } = await drafted();
  const good = (await commitWith(storage(), graph, draft, null, null)).stored;
  const lines = good.split("\n").slice(0, -1);
  // The provenance of Decision `index`, changed and written back canonically.
  const forge = (index, change) => {
    const next = [...lines];
    next[2 + 2 * index] = canonical(change(JSON.parse(lines[2 + 2 * index])));
    return `${next.join("\n")}\n`;
  };
  const focusedIndex = 1 + whole.steps.length;
  const retarget = (id, change) => provenance => ({
    ...provenance, claims: provenance.claims.map(claim => (claim.record.id === id ? change(claim) : claim)),
  });

  await refusedAs(forge(1, retarget("arch-a-mjs", claim => ({ ...claim, basis: [{ path: "b.mjs" }] }))),
    /arch-a-mjs: not a claim this snapshot grounds/u, "a file claim citing another file that exists");
  await refusedAs(forge(focusedIndex, retarget("arch-stores-in-b-mjs-to-ext-store", claim => ({ ...claim, basis: [{ candidate: "c-a-mjs--b-mjs" }] }))),
    /not a claim this snapshot grounds/u, "a judged relation citing another pair that exists");
  await refusedAs(forge(focusedIndex, retarget("arch-stores-in-b-mjs-to-ext-store", claim => ({ ...claim, basis: [{ candidate: "c-invented" }] }))),
    /not a closed relation of a candidate pair/u, "a judged relation citing no pair at all");
  await refusedAs(forge(focusedIndex, provenance => ({
    ...provenance,
    claims: [...provenance.claims, { record: { type: "region", id: "arch-a-mjs" }, origin: "source-declared", basis: [{ path: "a.mjs" }] }],
  })), /arch-a-mjs is not a record that Decision added/u, "a claim on a record an earlier Decision added");
  await refusedAs(forge(focusedIndex, retarget("arch-b-mjs", claim => ({ ...claim, role: "invented" }))),
    /invented is not a role of this snapshot/u, "a role outside the vocabulary");
  await refusedAs(forge(focusedIndex, retarget("arch-b-mjs", claim => ({ ...claim, record: { type: "region", id: "arch-ext-store" } }))),
    /only an admitted file has a role/u, "a role for what lies outside the source");
  await refusedAs(forge(focusedIndex, retarget("arch-b-mjs", claim => ({ ...claim, basis: [{ path: "a.mjs" }] }))),
    /a role rests on the file itself/u, "a role resting on another file");
  await refusedAs(forge(0, provenance => ({ ...provenance, claims: [{ ...provenance.claims[0], record: { type: "region", id: "arch-a-mjs" } }] })),
    /not a change that Decision made/u, "a person's claim for a change that Decision did not make");

  // Decisions drawn from someone else's account of the same snapshot: they
  // pass that account, and the real snapshot refuses them.
  const lie = async (manifest, picks, pattern, label) => {
    const origin = storage();
    const made = await drafted(manifest, picks);
    const result = await commitWith(origin, made.graph, made.draft, null, null, manifest);
    assert.equal(result.status, COMMIT_COMMITTED, `${label}: ${result.reason}`);
    await refusedAs(result.stored, pattern, label);
  };
  const judged = { [roleSlot("b-mjs", "persistence")]: YES, [relationSlot("c-b-mjs--ext-store")]: "stores-in" };
  await lie(lying(source => ({ facts: [{ ...source.facts[0], value: "forged" }] })), judged,
    /arch-fact-store-key: not drawn as this snapshot says/u, "a fact drawn with a value the file does not have");
  await lie(lying(source => ({ relations: [...source.relations, { key: "owns", purpose: "owns it" }] })),
    { [relationSlot("c-b-mjs--ext-store")]: "owns" }, /not a closed relation of a candidate pair/u, "a relation outside the vocabulary");
  await lie(lying(source => ({ candidates: source.candidates.map(candidate => (candidate.id === "c-b-mjs--ext-store"
    ? { ...candidate, from: "ext-store", to: "b-mjs" } : candidate)) })), judged,
  /not a claim this snapshot grounds/u, "a judged relation between other ends than its pair");
  await lie(lying(source => ({ imports: [{ ...source.imports[0], resolution: "scope-url-map" }] })), judged,
    /arch-import-a-mjs-to-b-mjs: not a claim this snapshot grounds/u, "an import resolved otherwise than the snapshot says");
});

test("without the cited snapshot the saved graph is still restored, as not checkable, and nothing grounded may be added", async () => {
  const origin = storage();
  const { graph, draft } = await drafted();
  const first = await commitWith(origin, graph, draft, null, null);
  const elsewhere = readManifest({ ...structuredClone(MANIFEST), source: { handle: "fixture", commit: "f".repeat(40) } });
  for (const manifest of [elsewhere, { status: "unavailable", reason: "no exact commit" }]) {
    const restored = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest });
    assert.equal(restored.status, "restored");
    assert.notEqual(restored.evidence, EVIDENCE_CURRENT);
    assert.equal(restored.stored, first.stored);
  }
});
