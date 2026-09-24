import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { projectHistory, restoreHistory, statesOf } from "../src/decision/history.mjs";

// One whole stored log, byte for byte as the pinned provider wrote it: this
// app's genesis, one edge, one part, one placement. It is the compatibility
// gate for the pin.
// Every other test builds its log on the spot, so a provider that changed how
// it normalizes operations or computes a state hash would rebuild those logs
// the new way and still pass. This one cannot be rebuilt. If the pin moves in
// a way that breaks a log a browser already saved, this test says so.
//
// It proves the provider contract and the restore path, not the screen. What
// the page draws from a restored log is the E2E's business.
//
// The first three Decisions were written with semantic-map
// f3qlzl68qassibdpgvb075zvd9mr1sks and are unchanged here on purpose: that is
// the evidence that the ui e632c76 pin still accepts bytes an earlier pin
// saved. The fourth was appended by the same app path under the new pin.
// Regenerate only with a deliberate pin bump.

const store = process.env.SEMANTIC_MAP;
if (!store) throw new Error("SEMANTIC_MAP must point at the pinned semantic-map store path");

const protocol = await import(
  pathToFileURL(path.join(store, "packages/semantic-map/protocol/index.js")).href
);

const GOLDEN_LOG = `{"operations":[{"mapId":"voice-graph","records":[{"root":"root","schema":"semantic-map-state/1","title":"voice graph","type":"meta"},{"bounds":[0,0,720,260],"id":"root","kind":"boundary","label":"voice graph","parent":null,"summary":"","type":"region"},{"bounds":[40,90,140,64],"id":"node-a","kind":"node","label":"node-a","parent":"root","summary":"","type":"region"},{"bounds":[250,90,140,64],"id":"node-b","kind":"node","label":"node-b","parent":"root","summary":"","type":"region"},{"bounds":[460,90,140,64],"id":"node-c","kind":"node","label":"node-c","parent":"root","summary":"","type":"region"}],"type":"CreateMap"}],"parent":null,"schema":"semantic-map-decision/2","stateHash":"sha256:730c270f8ce5bfbcdd57af26f358dc23c1d1736e274285d9757753cd3dd9ffc7"}
{"operations":[{"from":"node-c","kind":"flow","label":"","relationId":"voice-node-c-to-node-a","to":"node-a","type":"ConnectRegions"}],"parent":"sha256:858da5ad3693f2e7a3abfb09a3921337621304722e6e56781d4e800a55aa1817","schema":"semantic-map-decision/2","stateHash":"sha256:39b601f22bbcb87b0e29b8bb6b8b3131577859d050cfe35db6e9e21c590fb2c7"}
{"operations":[{"bounds":[20,20,140,64],"kind":"decision","label":"判断 1","parentId":"root","regionId":"part-1","summary":"","type":"AddRegion"}],"parent":"sha256:00ca99049bb0f332dcddd6215d0c5f674181c65c0e14958eeecfe55d0f8323fc","schema":"semantic-map-decision/2","stateHash":"sha256:5a2722b9972db748e24d723033a229fab31ed69eb42867a8b927e1466afdbbbb"}
{"operations":[{"items":[{"bounds":[358,78,180,92],"regionId":"part-1"}],"type":"PinRegions"}],"parent":"sha256:d5d62cd19f87662f59f939cb53efce293278135538785701cedc12e9bbea2354","schema":"semantic-map-decision/2","stateHash":"sha256:32c6181ae2ec44a75710ab569e773efae8c8d0e7f760a86519310c1457e64fd2"}
`;

const GENESIS = "sha256:858da5ad3693f2e7a3abfb09a3921337621304722e6e56781d4e800a55aa1817";
// The head before the placement was appended, which is now its parent.
const BEFORE_PLACEMENT = "sha256:d5d62cd19f87662f59f939cb53efce293278135538785701cedc12e9bbea2354";
const HEAD = "sha256:9231479b4e972b4c12478776e142d60fbcfa992ebe850e8acf2c6027f2bf3268";
const PLACED_AT = [358, 78, 180, 92];

test("the pinned provider still verifies a stored log holding an edge, a part and a placement", async () => {
  let verified;
  try {
    verified = await protocol.verifyDecisionLog(GOLDEN_LOG);
  } catch (error) {
    assert.fail(`the pin no longer accepts a log this app already wrote: ${error.message}`);
  }
  assert.equal(verified.decisions.length, 4);
  assert.equal(verified.ids[0], GENESIS, "the genesis id decides whether a stored log is this app's");
  assert.equal(verified.ids[2], BEFORE_PLACEMENT, "the placement was appended to the log as it already stood");
  assert.equal(verified.head, HEAD, "an unchanged log must still hash to the same head");
  assert.equal(verified.log, GOLDEN_LOG, "verification must not rewrite the stored bytes");
});

test("a stored log holding a part and a placement still restores and projects", async () => {
  const restored = await restoreHistory({
    read: () => GOLDEN_LOG,
    verifyDecisionLog: protocol.verifyDecisionLog,
    genesis: GENESIS,
  });
  assert.equal(restored.status, "restored");

  const projected = await projectHistory(restored.graph, { verifyDecisionLog: protocol.verifyDecisionLog });
  assert.deepEqual(projected.initial.regions, ["node-a", "node-b", "node-c"]);
  assert.deepEqual(projected.regions, ["node-a", "node-b", "node-c", "part-1"]);
  assert.deepEqual(projected.entries.map(entry => entry.facts), [
    [{ change: "added", kind: "relation", id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" }],
    [{ change: "added", kind: "region", id: "part-1", label: "判断 1" }],
    [{ change: "added", kind: "layout", id: "part-1", bounds: PLACED_AT }],
  ]);

  // Reload draws the part where it was left, from the log alone.
  const layout = protocol.layoutBoundsFor(restored.graph.records, { pattern: "graph/1" });
  assert.deepEqual(layout.pinned, ["part-1"]);
  assert.deepEqual(layout.bounds["part-1"], PLACED_AT);
});

test("each prefix of a stored log is itself a state the provider accepts", async () => {
  const states = await statesOf(GOLDEN_LOG, protocol.verifyDecisionLog);
  const regions = state => state.filter(record => record.type === "region").length;
  const layouts = state => state.filter(record => record.type === "layout");
  assert.equal(states.length, 4);
  assert.equal(regions(states[0]), 4, "the genesis holds the boundary and three nodes");
  assert.equal(regions(states[1]), 4, "an edge adds no region");
  assert.equal(regions(states[2]), 5, "the part adds exactly one");
  assert.equal(states[2].find(record => record.id === "part-1").label, "判断 1");
  assert.deepEqual(layouts(states[2]), [], "and it is not pinned yet");
  assert.equal(regions(states[3]), 5, "a placement adds no region");
  assert.deepEqual(layouts(states[3]), [{ type: "layout", regionId: "part-1", bounds: PLACED_AT, pin: "hard" }],
    "it only says where one part now sits");
});
