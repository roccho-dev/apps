import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { offersOf, readBundle } from "../src/bundle.mjs";
import { PART_KINDS } from "../src/contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shipped = () => JSON.parse(fs.readFileSync(path.join(here, "../web/data/bundle.v1.json"), "utf8"));

test("the shipped bundle is valid in every section, and frozen once read", () => {
  const bundle = readBundle(shipped());
  assert.equal(bundle.version, "1");
  assert.ok(bundle.parts.length > 0 && bundle.diagrams.length > 0);
  assert.ok(bundle.parts.every(part => PART_KINDS.includes(part.kind)));
  assert.ok(Object.isFrozen(bundle.parts[0]) && Object.isFrozen(bundle.diagrams[0].lanes[0]));
});

test("one generic group part is offered within the eight-offer cap", () => {
  const value = shipped();
  const bundle = readBundle(value);
  assert.deepEqual(bundle.parts.filter(part => part.kind === "group").map(part => part.key), ["group"]);
  assert.equal(bundle.parts.length, 8);
  assert.equal(readBundle({ ...value, parts: [...value.parts, { ...value.parts[0], key: "ninth" }] }).parts, null, "a ninth offer is refused");
});

test("a bundle that cannot be read offers nothing, and blocks nothing else", () => {
  for (const value of [null, [], "text", { ...shipped(), schema: "other/1" }, { ...shipped(), version: "" }]) {
    assert.deepEqual(readBundle(value), { version: null, parts: null, diagrams: null });
  }
  assert.deepEqual(offersOf(readBundle(null)), { parts: [], diagrams: [] });
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
  const offers = offersOf(bundle);
  assert.deepEqual(offers.parts, bundle.parts.map(({ key, purpose }) => ({ key, purpose })));
  assert.deepEqual(offers.diagrams, bundle.diagrams.map(({ key, purpose }) => ({ key, purpose })));
  const sent = JSON.stringify(offers);
  for (const label of [...bundle.parts.map(part => part.label), ...bundle.diagrams.flatMap(diagram => [diagram.label, ...diagram.lanes.map(lane => lane.label)])]) {
    assert.equal(sent.includes(label), false, label);
  }
});
