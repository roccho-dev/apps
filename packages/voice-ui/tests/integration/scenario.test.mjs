import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  correctionCriteria,
  diagramCandidatesForJev,
} from "../../src/decision/correction.mjs";
import {
  applySession,
  createSession,
  discardSession,
  proposeSession,
  undoSession,
} from "../../src/session.mjs";
import { checkScenario } from "./oracle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDir = path.join(here, "scenarios");
const scenarios = fs.readdirSync(scenarioDir)
  .filter(name => name.endsWith(".json"))
  .sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(scenarioDir, name), "utf8")));

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");
const protocol = await import(
  pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href
);

const node = (id, x) => ({
  type: "region",
  id,
  parent: "root",
  label: id,
  kind: "node",
  bounds: [x, 90, 140, 64],
  summary: "",
});

const initialGraph = initial => {
  assert.equal(initial, "voice-graph", `unknown initial state: ${initial}`);
  return protocol.createDecisionLog([
    { type: "meta", schema: "semantic-map-state/1", root: "root", title: "voice graph" },
    { type: "region", id: "root", parent: null, label: "voice graph", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
    node("node-a", 40),
    node("node-b", 250),
    node("node-c", 460),
  ], "voice-graph");
};

const choice = value => ({ type: "choice", choice: value ?? "none", confidence: 0.99 });

const answersFor = (session, typed, candidates) => {
  const criteria = correctionCriteria(session.working.records, null, null, candidates);
  const answers = {
    action: choice(typed.action),
    source: choice(typed.source),
    target: choice(typed.target),
    part: choice(typed.part),
  };
  if (criteria.placeable.length > 0) {
    answers.move = choice(typed.move);
    answers.anchor = choice(typed.anchor);
    answers.direction = choice(typed.direction);
  }
  if (criteria.edges.length > 0) answers.edge = choice(typed.edge);
  if (criteria.diagrams.length > 0) answers.diagram = choice(typed.diagram);
  return answers;
};

const assertContract = scenario => {
  assert.equal(typeof scenario.id, "string");
  assert.ok(scenario.id.length > 0);
  assert.ok(scenario.state === "accepted" || scenario.state === "target");
  assert.equal(typeof scenario.goal, "string");
  assert.equal(typeof scenario.initial, "string");
  assert.ok(Array.isArray(scenario.turns) && scenario.turns.length > 0);
  assert.ok(Array.isArray(scenario.expect) && scenario.expect.length > 0);
  if (scenario.examples !== undefined) {
    assert.ok(Array.isArray(scenario.examples));
    assert.ok(scenario.examples.every(value => typeof value === "string" && value.length > 0));
  }

  for (const turn of scenario.turns) {
    const keys = Object.keys(turn);
    assert.equal(keys.length, 1, `${scenario.id}: one command per turn`);
    assert.ok(["typed", "control", "say"].includes(keys[0]), `${scenario.id}: unknown turn ${keys[0]}`);
    if (scenario.state === "accepted") {
      assert.notEqual(keys[0], "say", `${scenario.id}: accepted core scenarios need typed interactions`);
    }
  }
};

test("scenario corpus has one unique, small contract per file", () => {
  assert.ok(scenarios.length > 0);
  const ids = new Set();
  for (const scenario of scenarios) {
    assertContract(scenario);
    assert.equal(ids.has(scenario.id), false, `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
});

for (const scenario of scenarios.filter(candidate => candidate.state === "accepted")) {
  test(`accepted scenario: ${scenario.id}`, { concurrency: true }, async () => {
    let stored = null;
    let session = createSession({ accepted: await initialGraph(scenario.initial), stored });
    const initial = session;
    const candidates = diagramCandidatesForJev().map(candidate => candidate.key);

    for (const turn of scenario.turns) {
      if (turn.typed !== undefined) {
        const transition = await proposeSession({
          session,
          answers: answersFor(session, turn.typed, candidates),
          protocol,
          candidates,
        });
        session = transition.session;
        continue;
      }

      if (turn.control === "apply") {
        session = await applySession({
          session,
          persist: async ({ graph, expected }) => {
            assert.equal(stored, expected, "memory storage changed outside the session");
            stored = graph.log;
          },
        });
        continue;
      }
      if (turn.control === "undo") {
        session = await undoSession({ session, verifyDecisionLog: protocol.verifyDecisionLog });
        continue;
      }
      if (turn.control === "discard") {
        session = discardSession(session);
        continue;
      }
      throw new Error(`${scenario.id}: unsupported accepted turn ${JSON.stringify(turn)}`);
    }

    const checked = checkScenario(scenario, { initial, current: session });
    assert.equal(
      checked.ok,
      true,
      checked.results.filter(value => !value.ok).map(value => value.detail).join("\n"),
    );
  });
}
