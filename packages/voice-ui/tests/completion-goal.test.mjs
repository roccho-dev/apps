import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readBundle } from "../src/bundle.mjs";
import { runInventoryGoal } from "../src/completion.mjs";
import { isRequest, partOption } from "../src/contract.mjs";
import { createSession, undo, apply } from "../src/session.mjs";
import { MAP_ID, STATE_SCHEMA, COMMIT_COMMITTED, RESTORE_RESTORED, commitLog, restoreLog } from "../src/log.mjs";
if (!process.env.SEMANTIC_MAP) throw new Error("SEMANTIC_MAP is required");
const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP, "packages/semantic-map/protocol/index.js")));
const bundle = readBundle(JSON.parse(fs.readFileSync(new URL("./fixtures/legacy-bundle.v1.json", import.meta.url))));
const opened = async () => {
  const made = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "completion fixture" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 3000, 1000], summary: "" },
    { type: "region", id: "container", parent: "root", label: "Container", kind: "group", bounds: [0, 0, 2500, 800], summary: "" },
  ], MAP_ID);
  const pin = await protocol.createDecision(made.head, [{ type: "PinRegions", items: [{ regionId: "container", bounds: [0, 0, 2500, 800] }] }], made.records);
  const graph = (await protocol.appendDecision(made.log, pin.decision)).verified;
  return createSession({ accepted: graph, stored: graph.log });
};
const execute = async ({ completion, missing, labels, choice }) => {
  let session = await opened(), generated = 0;
  const before = session;
  const result = await runInventoryGoal({ utterance: "fixture explicit named parts inside Container", bundle, protocol, completion,
    current: () => session, cancelled: () => false, check: async () => ({ choice, confidence: 1 }),
    complete: async () => { generated++; return { missing }; },
    ask: async request => {
      assert.equal(isRequest(request), true);
      const offered = request.state.offers.parts;
      if (choice === "missing" && completion) assert.equal(offered.length, bundle.parts.length + missing.length);
      let selected = "none";
      if (request.state.placing === null) {
        for (const label of labels) {
          const wanted = labels.filter(x => x === label).length;
          const present = session.working.records.filter(r => r.type === "region" && r.label === label && r.parent === "container").length;
          if (present >= wanted) continue;
          const candidate = request.state.candidates.find(c => c.action === "add-part" && offered.some(p => p.key === c.part && p.label === label));
          if (candidate) { selected = partOption(candidate.part); break; }
        }
      } else selected = request.state.candidates.find(c => c.parent === "container")?.id ?? "none";
      return { kind: "answered", decision: { answers: { delta: { type: "choice", choice: selected, confidence: 1 } } } };
    }, adopt: async next => { session = next; },
  });
  return { session, before, result, generated };
};

test("full8-part library plus three custom group candidates executes exact labels through the real legal protocol", async () => {
  const labels = ["Alpha", "Beta", "Gamma"];
  const run = await execute({ choice: "missing", completion: true, labels,
    missing: labels.map(label => ({ label, kind: "group", occurrence: 1 })) });
  assert.equal(run.generated, 1); assert.equal(run.result.reason, "none");
  const added = run.session.working.records.filter(r => r.type === "region" && !run.before.working.records.some(old => old.type === "region" && old.id === r.id));
  assert.deepEqual(added.map(({ label, kind, parent }) => ({ label, kind, parent })), labels.map(label => ({ label, kind: "group", parent: "container" })));
  assert.equal(new Set(added.map(r => r.id)).size, 3);
  const undone = await undo(run.session, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.equal(undone.working.head, run.before.working.head);
  let stored = run.before.stored;
  const committed = await apply(run.session, { commit: ({ graph, expected }) => commitLog({ graph, expected, key: "completion-fixture",
    read: async () => stored, write: async (_key, value) => { stored = value; }, lock: async (_key, action) => action(), verifyDecisionLog: protocol.verifyDecisionLog }) });
  assert.equal(committed.result.status, COMMIT_COMMITTED);
  const restored = await restoreLog({ key: "completion-fixture", read: async () => stored, verifyDecisionLog: protocol.verifyDecisionLog });
  assert.equal(restored.status, RESTORE_RESTORED); assert.equal(restored.graph.head, run.session.working.head);
});

test("quantity3 reuses one known instance and materializes two missing instances without changing labels or the saved library", async () => {
  const saved = JSON.stringify(bundle);
  const run = await execute({ choice: "missing", completion: true, labels: ["DB", "DB", "DB"], missing: [
    { label: "DB", kind: "data", occurrence: 1 }, { label: "DB", kind: "data", occurrence: 2 },
  ] });
  assert.equal(run.result.reason, "none"); assert.equal(run.result.selected.length, 3);
  assert.equal(run.session.working.records.filter(r => r.type === "region" && r.label === "DB" && r.parent === "container").length, 3);
  assert.equal(JSON.stringify(bundle), saved);
});

test("sufficient uses the same known candidate without generation, and missing baseline still attempts the old catalogue", async () => {
  const enough = await execute({ choice: "sufficient", completion: true, labels: ["API"], missing: [] });
  assert.equal(enough.generated, 0); assert.equal(enough.result.selected.length, 1);
  const baseline = await execute({ choice: "missing", completion: false, labels: ["Alpha"], missing: [] });
  assert.equal(baseline.generated, 0); assert.ok(baseline.result.trace.length > 0);
  assert.equal(baseline.session.working.head, baseline.before.working.head);
});
