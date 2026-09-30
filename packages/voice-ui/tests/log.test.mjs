import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  COMMIT_COMMITTED,
  COMMIT_UNVERIFIED,
  MAP_ID,
  RESTORE_NO_LOG,
  RESTORE_RESTORED,
  STATE_SCHEMA,
  commitLog,
  projectHistory,
  restoreLog,
  statesOf,
  truncateLog,
} from "../src/log.mjs";

// A storage key of this test's own, not the product's: the log reads, writes
// and locks exactly the key it is given. Then the outcomes the page never
// branches on by name.
const HISTORY_KEY = "log test key";
const RESTORE_CORRUPT = "corrupt";
const RESTORE_FOREIGN = "foreign";
const COMMIT_CONFLICT = "conflict";
const COMMIT_REJECTED = "rejected";
const COMMIT_NOT_PERSISTED = "not-persisted";

// One whole stored log, byte for byte as the pinned provider wrote it: a
// genesis this app once started from, one edge, one part, one placement. It is
// the compatibility gate for the pin and for this app's log identity.
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
  assert.equal(verified.ids[0], GENESIS, "an unchanged genesis must still hash to the same id");
  assert.equal(verified.ids[2], BEFORE_PLACEMENT, "the placement was appended to the log as it already stood");
  assert.equal(verified.head, HEAD, "an unchanged log must still hash to the same head");
  assert.equal(verified.log, GOLDEN_LOG, "verification must not rewrite the stored bytes");
});

test("a stored log holding a part and a placement still restores as this app's and projects", async () => {
  const restored = await restoreLog({ key: HISTORY_KEY, read: () => GOLDEN_LOG, verifyDecisionLog: protocol.verifyDecisionLog });
  assert.equal(restored.status, RESTORE_RESTORED, "identity is namespace, schema and verification, not starter content");

  const projected = restored.projection;
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

// Storage as the browser has it: one key-value map, read and written only
// through the functions the page passes in.
const storage = (initial = null) => {
  const values = new Map(initial === null ? [] : [[HISTORY_KEY, initial]]);
  const writes = [];
  return {
    values,
    writes,
    read: async key => values.get(key) ?? null,
    write: async (key, value) => {
      writes.push(value);
      values.set(key, value);
    },
  };
};

// A lock that runs holders one after another, as the origin-wide Web Lock does.
const serialLock = () => {
  let tail = Promise.resolve();
  return (name, run) => {
    assert.equal(name, HISTORY_KEY);
    const held = tail.then(run);
    tail = held.catch(() => {});
    return held;
  };
};

const verifyDecisionLog = protocol.verifyDecisionLog;
const extend = async (log, relation) => {
  const base = await verifyDecisionLog(log);
  const { decision } = await protocol.createDecision(base.head, [{
    type: "ConnectRegions", relationId: `voice-${relation[0]}-to-${relation[1]}`,
    from: relation[0], to: relation[1], kind: "flow", label: "",
  }], base.records);
  return (await protocol.appendDecision(base.log, decision)).verified;
};
const commitWith = (store, graph, expected, lock = serialLock()) =>
  commitLog({ graph, expected, key: HISTORY_KEY, read: store.read, write: store.write, lock, verifyDecisionLog });

test("absent storage is NO_LOG, never a starter graph", async () => {
  for (const absent of [null, undefined]) {
    const restored = await restoreLog({ key: HISTORY_KEY, read: async () => absent, verifyDecisionLog });
    assert.deepEqual(restored, { status: RESTORE_NO_LOG });
  }
});

test("the storage key is always given: none or a blank one is refused, and only that key is read or written", async () => {
  const store = storage(GOLDEN_LOG);
  for (const key of [undefined, null, "", "   ", 1]) {
    await assert.rejects(restoreLog({ key, read: store.read, verifyDecisionLog }), /storage key/u, JSON.stringify(key));
    await assert.rejects(commitLog({ graph: { log: GOLDEN_LOG }, expected: null, key, read: store.read, write: store.write, lock: serialLock(), verifyDecisionLog }),
      /storage key/u, JSON.stringify(key));
  }
  assert.deepEqual(await restoreLog({ key: "another key", read: store.read, verifyDecisionLog }), { status: RESTORE_NO_LOG },
    "a log under another key is not this key's log");
  assert.deepEqual(store.writes, []);
});

test("a log the provider rejects is corrupt and restoring it writes nothing", async () => {
  for (const bytes of ['{"not":"a decision"}\n', "", GOLDEN_LOG.slice(0, -1)]) {
    const store = storage(bytes);
    const restored = await restoreLog({ key: HISTORY_KEY, read: store.read, verifyDecisionLog });
    assert.equal(restored.status, RESTORE_CORRUPT, JSON.stringify(bytes));
    assert.equal(typeof restored.reason, "string");
    assert.deepEqual(store.writes, [], "restoring never writes");
  }
});

test("a valid log under another map namespace is foreign, never this app's history", async () => {
  const other = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "other graph" },
    { type: "region", id: "root", parent: null, label: "other graph", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  ], "some-other-map");
  const restored = await restoreLog({ key: HISTORY_KEY, read: async () => other.log, verifyDecisionLog });
  assert.equal(restored.status, RESTORE_FOREIGN);
  assert.match(restored.reason, /foreign/u);
  assert.match(restored.reason, new RegExp(MAP_ID, "u"));
});

test("Apply commits a verified strict extension, writes once and reads it back", async () => {
  const store = storage(GOLDEN_LOG);
  const next = await extend(GOLDEN_LOG, ["node-a", "node-b"]);
  const result = await commitWith(store, next, GOLDEN_LOG);
  assert.deepEqual(result, { status: COMMIT_COMMITTED, stored: next.log });
  assert.deepEqual(store.writes, [next.log]);
  assert.ok(next.log.startsWith(GOLDEN_LOG), "every saved Decision is still there");
});

test("a new map is committed only where nothing is stored", async () => {
  const made = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "plan" },
    { type: "region", id: "root", parent: null, label: "plan", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  ], MAP_ID);
  const empty = storage();
  assert.equal((await commitWith(empty, made, null)).status, COMMIT_COMMITTED);
  assert.equal(empty.values.get(HISTORY_KEY), made.log);

  // Something is stored now: the same Apply from a page that saw nothing is a
  // conflict, and it replaces nothing.
  const taken = storage(GOLDEN_LOG);
  assert.deepEqual(await commitWith(taken, made, null), { status: COMMIT_CONFLICT });
  assert.equal(taken.values.get(HISTORY_KEY), GOLDEN_LOG);
});

test("corrupt or foreign bytes are never overwritten by Apply", async () => {
  const made = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "plan" },
    { type: "region", id: "root", parent: null, label: "plan", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  ], MAP_ID);
  for (const bytes of ['{"not":"a decision"}\n', "foreign"]) {
    const store = storage(bytes);
    assert.deepEqual(await commitWith(store, made, null), { status: COMMIT_CONFLICT });
    assert.equal(store.values.get(HISTORY_KEY), bytes);
    assert.deepEqual(store.writes, []);
  }
});

test("storage another page changed since this page read it is a conflict, and nothing is written", async () => {
  const theirs = await extend(GOLDEN_LOG, ["node-b", "node-c"]);
  const mine = await extend(GOLDEN_LOG, ["node-a", "node-b"]);
  const store = storage(theirs.log);
  assert.deepEqual(await commitWith(store, mine, GOLDEN_LOG), { status: COMMIT_CONFLICT });
  assert.equal(store.values.get(HISTORY_KEY), theirs.log, "their Decision is not lost");
  assert.deepEqual(store.writes, []);
});

test("a log that is not a strict extension of what is stored is rejected", async () => {
  const store = storage(GOLDEN_LOG);
  const same = await verifyDecisionLog(GOLDEN_LOG);
  const shorter = await truncateLog(same, { count: 3, floor: 1, verifyDecisionLog });
  for (const graph of [same, shorter]) {
    const result = await commitWith(store, graph, GOLDEN_LOG);
    assert.equal(result.status, COMMIT_REJECTED);
    assert.match(result.reason, /strictly extend/u);
  }
  assert.deepEqual(store.writes, []);
});

test("an unverifiable or foreign log is rejected before anything is written", async () => {
  const store = storage(GOLDEN_LOG);
  const broken = { log: `${GOLDEN_LOG}{"not":"a decision"}\n` };
  const rejected = await commitWith(store, broken, GOLDEN_LOG);
  assert.equal(rejected.status, COMMIT_REJECTED);

  const foreign = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "x" },
    { type: "region", id: "root", parent: null, label: "x", kind: "boundary", bounds: [0, 0, 720, 260], summary: "" },
  ], "some-other-map");
  const empty = storage();
  const foreignResult = await commitWith(empty, foreign, null);
  assert.equal(foreignResult.status, COMMIT_REJECTED);
  assert.match(foreignResult.reason, /foreign/u);
  assert.deepEqual([...store.writes, ...empty.writes], []);
});

test("a failed write that left storage exactly as it was is not persisted, and says so", async () => {
  const next = await extend(GOLDEN_LOG, ["node-a", "node-b"]);
  const failing = storage(GOLDEN_LOG);
  failing.write = async () => { throw new Error("quota exceeded"); };
  assert.deepEqual(await commitWith(failing, next, GOLDEN_LOG), { status: COMMIT_NOT_PERSISTED, reason: "quota exceeded" });
  assert.equal(failing.values.get(HISTORY_KEY), GOLDEN_LOG, "read back unchanged");
});

test("storage that cannot be vouched for after a write is unverified, never committed or merely failed", async () => {
  const next = await extend(GOLDEN_LOG, ["node-a", "node-b"]);

  // The write said it landed, but other bytes read back.
  const lying = storage(GOLDEN_LOG);
  lying.write = async () => {};
  const differs = await commitWith(lying, next, GOLDEN_LOG);
  assert.equal(differs.status, COMMIT_UNVERIFIED);
  assert.match(differs.reason, /read back differently/u);

  // The write failed, yet storage no longer holds what it did.
  const torn = storage(GOLDEN_LOG);
  torn.write = async key => {
    torn.values.set(key, "partial");
    throw new Error("disk error");
  };
  const changed = await commitWith(torn, next, GOLDEN_LOG);
  assert.equal(changed.status, COMMIT_UNVERIFIED);
  assert.match(changed.reason, /disk error.*storage changed/u);

  // The bytes cannot be read back at all.
  const blind = storage(GOLDEN_LOG);
  let reads = 0;
  const firstRead = blind.read;
  blind.read = async key => {
    reads += 1;
    if (reads > 1) throw new Error("storage unavailable");
    return firstRead(key);
  };
  const unreadable = await commitWith(blind, next, GOLDEN_LOG);
  assert.equal(unreadable.status, COMMIT_UNVERIFIED);
  assert.match(unreadable.reason, /cannot be read back/u);
});

test("two Applies from the same saved log never lose a committed Decision", async () => {
  const store = storage(GOLDEN_LOG);
  const lock = serialLock();
  const left = await extend(GOLDEN_LOG, ["node-a", "node-b"]);
  const right = await extend(GOLDEN_LOG, ["node-b", "node-c"]);
  const results = await Promise.all([
    commitWith(store, left, GOLDEN_LOG, lock),
    commitWith(store, right, GOLDEN_LOG, lock),
  ]);
  assert.deepEqual(results.map(result => result.status), [COMMIT_COMMITTED, COMMIT_CONFLICT]);
  assert.equal(store.values.get(HISTORY_KEY), left.log);
  assert.deepEqual(store.writes, [left.log], "exactly one write");

  // The page that lost reads the new log, and its Decision on top of that
  // commits; every earlier Decision is still in it.
  const rebased = await extend(left.log, ["node-b", "node-c"]);
  assert.equal((await commitWith(store, rebased, left.log, lock)).status, COMMIT_COMMITTED);
  assert.ok(store.values.get(HISTORY_KEY).startsWith(left.log));
});

test("a working log is never cut below what is saved", async () => {
  const graph = await extend(GOLDEN_LOG, ["node-a", "node-b"]);
  const cut = await truncateLog(graph, { count: 4, floor: 4, verifyDecisionLog });
  assert.equal(cut.log, GOLDEN_LOG);
  await assert.rejects(() => truncateLog(graph, { count: 3, floor: 4, verifyDecisionLog }), /below what is saved/u);
});

test("a removal names the ends the edge had, and a reversal is one entry of both halves", async () => {
  const base = await verifyDecisionLog(GOLDEN_LOG);
  const remove = await protocol.createDecision(base.head, [
    { type: "RemoveSelection", regionIds: [], relationIds: ["voice-node-c-to-node-a"] },
    { type: "ConnectRegions", relationId: "voice-node-a-to-node-c", from: "node-a", to: "node-c", kind: "flow", label: "" },
  ], base.records);
  const reversed = (await protocol.appendDecision(base.log, remove.decision)).verified;
  const projection = await projectHistory(reversed, { verifyDecisionLog });
  assert.deepEqual(projection.entries.at(-1).facts, [
    { change: "removed", kind: "relation", id: "voice-node-c-to-node-a", from: "node-c", to: "node-a" },
    { change: "added", kind: "relation", id: "voice-node-a-to-node-c", from: "node-a", to: "node-c" },
  ]);
});

test("the projection of a log names its initial graph, every applied entry and the current state", async () => {
  const graph = await extend(GOLDEN_LOG, ["node-a", "node-b"]);
  const projection = await projectHistory(graph, { verifyDecisionLog });
  assert.equal(projection.head, graph.head);
  assert.equal(projection.entries.length, 4);
  assert.deepEqual(projection.entries.at(-1).facts, [
    { change: "added", kind: "relation", id: "voice-node-a-to-node-b", from: "node-a", to: "node-b" },
  ]);
  assert.deepEqual(projection.relations.map(relation => relation.id).sort(), ["voice-node-a-to-node-b", "voice-node-c-to-node-a"]);
});
