import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { offersOf, readBundle } from "../src/bundle.mjs";
import { PART_KINDS } from "../src/contract.mjs";
import { requestFor, planStep, appendStep, legalLocalDeltas } from "../src/turn.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shipped = () => JSON.parse(fs.readFileSync(path.join(here, "../web/data/bundle.v1.json"), "utf8"));

test("the shipped diagram accepts a typed Goal addition without changing its existing records", async () => {
  const protocol = await import(pathToFileURL(process.env.VOICE_UI_TEST_PROTOCOL
    ?? path.join(process.env.SEMANTIC_MAP, "packages/semantic-map/protocol/index.js")));
  const bundle = readBundle(shipped());
  const working = await protocol.createDecisionLog([
    { type: "meta", schema: "semantic-map-state/1", root: "root", title: "World" },
    { type: "region", id: "root", parent: null, label: "World", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  ], "voice-graph");
  const { turn } = requestFor({ working, utterance: "Container preparationを表示", bundle,
    layout: null, offeredFrame: null, draft: [], focus: null, pending: null, recent: [], typedEdges: true });
  const answers = Object.fromEntries(Object.keys(turn.slots).map(name => [name,
    { type: "choice", choice: ({ action: "compose-diagram", diagram: "container-example" })[name] ?? "none", confidence: 1 }]));
  const result = await planStep({ working, turn, answers, protocol, bundle, reserved: [], layout: null, visibleFrame: null });
  assert.equal(result.outcome, "step");
  const composed = (await appendStep({ working, step: result.step, protocol })).graph;
  const boxes = protocol.layoutBoundsFor(composed.records, { pattern: protocol.GRAPH_PATTERN }).bounds;
  const left = composed.records.find(row => row.label === "Helper left");
  const right = composed.records.find(row => row.label === "Helper right");
  assert.ok(boxes[right.id][0] - boxes[left.id][0] - boxes[left.id][2] >= boxes[left.id][3],
    "new prepared columns reserve an annotation gutter; actual glyph visibility is a browser check");
  const parent = composed.records.find(row => row.label === "OCI");
  const held = legalLocalDeltas(composed, { bundle: { ...bundle, parts: bundle.parts.filter(part => part.key === "db") }, protocol, expressive: true });
  const addition = held.candidates.find(candidate => candidate.part === "db" && candidate.parent === parent.id);
  assert.ok(addition, "the normal prepared OCI group has a title-safe executable DB slot");
  const next = await protocol.appendDecision(composed.log,
    (await protocol.createDecision(composed.head, addition.operations, composed.records)).decision);
  assert.ok(composed.records.every(row => next.verified.records.some(actual => JSON.stringify(actual) === JSON.stringify(row))));
});

test("the shipped bundle is valid in every section, and frozen once read", () => {
  const bundle = readBundle(shipped());
  assert.equal(bundle.version, "1");
  assert.equal(bundle.goalSelection, "delta", "the shipped catalogue enables typed edge and annotation editing");
  assert.ok(bundle.parts.length > 0 && bundle.diagrams.length > 0);
  assert.ok(bundle.parts.every(part => PART_KINDS.includes(part.kind)));
  assert.ok(Object.isFrozen(bundle.parts[0]) && Object.isFrozen(bundle.diagrams[0].lanes[0]));
});

test("the legacy schema keeps its eight-offer cap and generic group", () => {
  const value = { ...shipped(), schema: "voice-ui.bundle/1" };
  const bundle = readBundle(value);
  assert.deepEqual(bundle.parts.filter(part => part.kind === "group").map(part => part.key), ["group"]);
  assert.equal(bundle.parts.length, 8);
  assert.equal(readBundle({ ...value, parts: [...value.parts, { ...value.parts[0], key: "ninth" }] }).parts, null, "a ninth offer is refused");
});

test("a bundle that cannot be read offers nothing, and blocks nothing else", () => {
  for (const value of [null, [], "text", { ...shipped(), schema: "other/1" }, { ...shipped(), version: "" }]) {
    assert.deepEqual(readBundle(value), { version: null, parts: null, diagrams: null });
  }
  assert.deepEqual(offersOf(readBundle(null), { named: false }), { parts: [], diagrams: [] });
  assert.deepEqual(offersOf(readBundle(null), { named: true }), { parts: [], diagrams: [] });
});

test("a broken section disables only its own capability", () => {
  const value = shipped();
  const withBadPart = { ...value, parts: [...value.parts, { ...value.parts[0], key: "other", kind: "actor" }] };
  const read = readBundle(withBadPart);
  assert.equal(read.parts, null, "a kind the view cannot draw rejects the section");
  assert.equal(read.diagrams.length, value.diagrams.length, "the diagrams are still offered");

  const diagram = value.diagrams[0];
  for (const broken of [
    { ...diagram, steps: [{ ...diagram.steps[0], lane: "nobody" }] },
    { ...diagram, steps: [{ ...diagram.steps[0], kind: "group" }] },
    { ...diagram, links: [[diagram.steps[0].ref, "nowhere"]] },
    { ...diagram, links: [[diagram.steps[0].ref, diagram.steps[0].ref]] },
    { ...diagram, lanes: [...diagram.lanes, diagram.lanes[0]] },
    { ...diagram, extra: 1 },
  ]) {
    const readBroken = readBundle({ ...value, diagrams: [broken] });
    assert.equal(readBroken.diagrams, null, JSON.stringify(broken).slice(0, 80));
    assert.equal(readBroken.parts.length, value.parts.length);
  }
  assert.equal(readBundle({ ...value, parts: [value.parts[0], value.parts[0]] }).parts, null, "keys are unique");
  assert.equal(readBundle({ ...value, parts: [{ ...value.parts[0], key: "none" }] }).parts, null, "none is never a key");
});

test("Jev is offered keys and purposes only - never labels, lanes, steps or links", () => {
  const bundle = readBundle(shipped());
  const offers = offersOf(bundle, { named: false });
  assert.deepEqual(offers.parts, bundle.parts.map(({ key, purpose }) => ({ key, purpose })));
  assert.deepEqual(offers.diagrams, bundle.diagrams.map(({ key, purpose }) => ({ key, purpose })));
  const sent = JSON.stringify(offers);
  for (const label of [...bundle.parts.map(part => part.label), ...bundle.diagrams.flatMap(diagram => [diagram.label, ...diagram.lanes.map(lane => lane.label)])]) {
    assert.equal(sent.includes(label), false, label);
  }
});

test("a Goal's parts also carry their displayed name, as data; diagrams stay keys and purposes", () => {
  const bundle = readBundle(shipped());
  const offers = offersOf(bundle, { named: true });
  assert.deepEqual(offers.parts, bundle.parts.map(({ key, purpose, label }) => ({ key, purpose, label })));
  assert.deepEqual(offers.diagrams, bundle.diagrams.map(({ key, purpose }) => ({ key, purpose })));
  const sent = JSON.stringify(offers.diagrams);
  for (const label of bundle.diagrams.flatMap(diagram => [diagram.label, ...diagram.lanes.map(lane => lane.label)])) {
    assert.equal(sent.includes(label), false, label);
  }
  // A name is display data, not identity: two parts may share one, kept apart by their keys.
  const value = shipped();
  const shared = readBundle({ ...value, parts: [value.parts[0], { ...value.parts[1], label: value.parts[0].label }] });
  assert.deepEqual(offersOf(shared, { named: true }).parts.map(part => part.key), [value.parts[0].key, value.parts[1].key]);
  // Which projection is meant is always said.
  assert.throws(() => offersOf(bundle));
});
