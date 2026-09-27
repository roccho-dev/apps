import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDir = path.join(here, "e2e", "scenarios");
const files = fs.readdirSync(scenarioDir)
  .filter(name => name.endsWith(".jsonl"))
  .sort();

const assertSay = (say, file, state) => {
  if (typeof say === "string") {
    assert.equal(state, "target", `${file}: accepted say turns need deterministic typed intent`);
    assert.ok(say.length > 0);
    return;
  }

  assert.equal(typeof say, "object");
  assert.deepEqual(Object.keys(say).sort(), ["as", "text"]);
  assert.equal(typeof say.text, "string");
  assert.ok(say.text.length > 0);
  assert.equal(typeof say.as, "object");
  assert.ok(Object.keys(say.as).length > 0);
  for (const [slot, value] of Object.entries(say.as)) {
    assert.ok(
      ["action", "source", "target", "part", "move", "anchor", "direction", "edge", "diagram"].includes(slot),
      `${file}: unknown typed slot ${slot}`,
    );
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
  }
};

test("goal scenarios are one small contract per file", () => {
  assert.ok(files.length > 0, "at least one goal scenario is required");

  const ids = new Set();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(scenarioDir, file), "utf8").trim();
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `${file}: one scenario per file`);

    const scenario = JSON.parse(lines[0]);
    assert.deepEqual(
      Object.keys(scenario).sort(),
      ["expect", "goal", "id", "initial", "state", "turns"].sort(),
      `${file}: keep the scenario contract small`,
    );
    assert.equal(typeof scenario.id, "string");
    assert.ok(scenario.id.length > 0);
    assert.equal(typeof scenario.goal, "string");
    assert.ok(scenario.goal.length > 0);
    assert.equal(scenario.initial, "genesis");
    assert.ok(scenario.state === "accepted" || scenario.state === "target");
    assert.ok(Array.isArray(scenario.turns) && scenario.turns.length > 0);
    assert.ok(Array.isArray(scenario.expect) && scenario.expect.length > 0);
    assert.equal(ids.has(scenario.id), false, `${file}: duplicate scenario id`);
    ids.add(scenario.id);

    for (const turn of scenario.turns) {
      const keys = Object.keys(turn);
      assert.equal(keys.length, 1, `${file}: each turn is one user action`);
      assert.ok(
        keys[0] === "say" || keys[0] === "control",
        `${file}: a turn is either say or control`,
      );
      if (keys[0] === "say") {
        assertSay(turn.say, file, scenario.state);
      } else {
        assert.ok(["apply", "reload", "undo", "discard"].includes(turn.control));
      }
    }

    for (const expectation of scenario.expect) {
      assert.equal(typeof expectation.invariant, "string");
      assert.ok(expectation.invariant.length > 0);
    }
  }
});
