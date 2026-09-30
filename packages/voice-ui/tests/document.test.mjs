import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { planArchitecture, readManifest, withArchitecture } from "../src/architecture.mjs";
import { readBundle } from "../src/bundle.mjs";
import { ACTION_ARCHITECTURE, NONE, relationSlot, roleSlot } from "../src/contract.mjs";
import { EVIDENCE_CURRENT, commitDocument, currentClaims, restoreDocument } from "../src/document.mjs";
import { COMMIT_COMMITTED, MAP_ID, STATE_SCHEMA } from "../src/log.mjs";
import { requestFor } from "../src/turn.mjs";

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href);
const { verifyDecisionLog } = protocol;

const KEY = "document test key";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST = readManifest({
  schema: "voice-ui.architecture-source/1",
  status: "available",
  source: { handle: "fixture", commit: COMMIT },
  files: [
    { path: "a.mjs", blob: "1".repeat(40), class: "admitted", entity: "page-app" },
    { path: "b.mjs", blob: "2".repeat(40), class: "admitted", entity: "saver" },
  ],
  entities: [
    { id: "page-app", label: "Page (a.mjs)", kind: "file", path: "a.mjs" },
    { id: "saver", label: "Saver (b.mjs)", kind: "file", path: "b.mjs" },
  ],
  imports: [{ from: "page-app", to: "saver", path: "a.mjs", specifier: "./b.mjs" }],
  candidates: [{ id: "c-page-app--saver", from: "page-app", to: "saver", reasons: ["import"] }],
  facts: [],
  roles: [{ key: "persistence", purpose: "stores data" }],
  relations: [{ key: "calls", purpose: "calls it" }],
  coverage: { unsupported: [], skipped: [], notAnalyzed: [] },
});

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

// The person's new map, then one architecture view on it - as the page would
// hold them in its draft before Apply.
const drafted = async () => {
  const created = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "map" },
    { type: "region", id: "root", parent: null, label: "map", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  ], MAP_ID);
  const { turn } = withArchitecture(requestFor({
    working: created, utterance: "show the code", bundle: readBundle(null), layout: null, offeredFrame: null,
    draft: [], focus: null, pending: null, recent: [],
  }), MANIFEST);
  const answers = Object.fromEntries(Object.keys(turn.slots).map(name => [name, { type: "choice", choice: NONE, confidence: 0.9 }]));
  answers.action = { type: "choice", choice: ACTION_ARCHITECTURE, confidence: 0.9 };
  answers[roleSlot("saver")] = { type: "choice", choice: "persistence", confidence: 0.9 };
  answers[relationSlot("c-page-app--saver")] = { type: "choice", choice: "calls", confidence: 0.9 };
  const planned = await planArchitecture({ working: created, turn, answers, manifest: MANIFEST, protocol });
  const graph = (await protocol.appendDecision(created.log, planned.step.decision)).verified;
  return { created, graph, draft: [{ step: { decision: created.decisions[0] } }, { step: planned.step, claims: planned.claims }] };
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
  assert.deepEqual(origins("arch-saver"), ["source-declared", "model-inferred"], "a file exists in the source; its role is Jev's");
  assert.deepEqual(origins("arch-calls-page-app-to-saver"), ["model-inferred"]);
  assert.deepEqual(origins("arch-import-page-app-to-saver"), ["source-declared"]);
});

test("Apply only ever grows the stored document, and a person's own step is claimed as theirs", async () => {
  const origin = storage();
  const { graph, draft } = await drafted();
  const first = await commitWith(origin, graph, draft, null, null);
  const saved = await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST });

  const relation = graph.records.find(record => record.type === "relation" && record.id === "arch-calls-page-app-to-saver");
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

  // A cited candidate the current manifest of the same snapshot does not have.
  const origin = storage();
  origin.values.set(KEY, good.replace('"candidate":"c-page-app--saver"', '"candidate":"c-invented"'));
  assert.match((await restoreDocument({ key: KEY, read: origin.read, verifyDecisionLog, manifest: MANIFEST })).reason, /unknown candidate/u);
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
