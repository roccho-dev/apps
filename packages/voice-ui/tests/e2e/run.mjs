import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openScenarioBrowser } from "./browser.mjs";
import { checkScenario } from "./oracle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDir = path.join(here, "scenarios");

const args = process.argv.slice(2);
const includeTargets = args.includes("--targets");
const live = args.includes("--live");
const ids = new Set(
  args.filter(value => value.startsWith("--id=")).map(value => value.slice("--id=".length)),
);
const url = args.find(value => !value.startsWith("--")) ?? process.env.VOICE_E2E_URL;
if (!url) throw new Error("pass the voice-ui URL or set VOICE_E2E_URL");

const scenarios = fs.readdirSync(scenarioDir)
  .filter(name => name.endsWith(".jsonl"))
  .sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(scenarioDir, name), "utf8").trim()))
  .filter(scenario => ids.size === 0 || ids.has(scenario.id))
  .filter(scenario => scenario.state === "accepted" || includeTargets);

if (scenarios.length === 0) throw new Error("no scenarios selected");

let failed = 0;
for (const scenario of scenarios) {
  let session;
  try {
    session = await openScenarioBrowser({ url, live });
    const initial = await session.snapshot();

    for (const turn of scenario.turns) {
      if ("say" in turn) await session.say(turn.say);
      else await session.control(turn.control);
    }

    const current = await session.snapshot();
    const checked = checkScenario(scenario, { initial, current });
    const status = checked.ok ? "GREEN" : "RED";
    process.stdout.write(`${status} ${scenario.state} ${scenario.id}\n`);
    for (const value of checked.results) {
      process.stdout.write(`  ${value.ok ? "PASS" : "FAIL"} ${value.invariant}: ${value.detail}\n`);
    }
    if (!checked.ok) failed += 1;
  } catch (error) {
    failed += 1;
    process.stdout.write(`RED ${scenario.state} ${scenario.id}\n  ${error.stack ?? error}\n`);
  } finally {
    if (session) await session.close();
  }
}

process.exitCode = failed === 0 ? 0 : 1;
