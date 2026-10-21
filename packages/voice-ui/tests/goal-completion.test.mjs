import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GOAL_COMPLETION_KIND, GOAL_REQUEST_KIND, NONE, isRequest, goalCompletionSlots } from "../src/contract.mjs";
import { questionsFor } from "../src/judgment.mjs";
import { onRequestPost } from "../functions/api/judge.mjs";
import { runGoal } from "../src/goal.mjs";
import { createSession, undo } from "../src/session.mjs";
import { MAP_ID, STATE_SCHEMA } from "../src/log.mjs";

if (!process.env.SEMANTIC_MAP) throw new Error("SEMANTIC_MAP is required");
const protocol = await import(pathToFileURL(path.join(process.env.SEMANTIC_MAP, "packages/semantic-map/protocol/index.js")).href);
const bundle = { parts: [
  { key: "api", label: "API", kind: "step", purpose: "one API service" },
  { key: "db", label: "DB", kind: "data", purpose: "one database" },
], diagrams: [] };
const opened = async (extra = []) => {
  const graph = await protocol.createDecisionLog([
    { type: "meta", schema: STATE_SCHEMA, root: "root", title: "completion fixture" },
    { type: "region", id: "root", parent: null, label: "fixture", kind: "boundary", bounds: [0, 0, 900, 400], summary: "" },
    { type: "region", id: "container", parent: "root", label: "OCI", kind: "group", bounds: [0, 0, 700, 200], summary: "" },
    { type: "region", id: "other", parent: "root", label: "Other", kind: "group", bounds: [0, 230, 700, 160], summary: "" },
    ...extra,
  ], MAP_ID);
  const pinned = await protocol.createDecision(graph.head, [{ type: "PinRegions", items: [
    { regionId: "container", bounds: [0, 0, 2000, 500] }, { regionId: "other", bounds: [0, 600, 2000, 500] },
  ] }], graph.records);
  const prepared = (await protocol.appendDecision(graph.log, pinned.decision)).verified;
  return createSession({ accepted: prepared, stored: prepared.log });
};
const delta = (choice, confidence = 1) => ({ kind: "answered", decision: { answers: { delta: { type: "choice", choice, confidence } } } });
const verdict = (choice, confidence = 1) => ({ kind: "answered", decision: { answers: {
  completion: { type: "choice", choice, confidence },
} } });
const snapshot = records => ({
  regions: records.filter(r => r.type === "region").map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
  edges: records.filter(r => r.type === "relation").map(({ id, from, to, kind, label }) => ({ id, from, to, kind, label })),
});

test("terminal request is closed, whole, and distinguishes initial instances from new additions", async () => {
  const before = await opened();
  const graph = snapshot(before.working.records);
  const request = { kind: GOAL_COMPLETION_KIND, state: { utterance: "OCIにAPIを新しく1つ追加", initial: graph, graph, context: { recent: [] } } };
  assert.equal(isRequest(request), true);
  const question = questionsFor(request.state, goalCompletionSlots(), { kind: request.kind });
  assert.deepEqual(Object.keys(question.completion.options), ["complete", "incomplete", "unknown"]);
  for (const meaning of ["initial", "direct parent", "directed connection", "unrequested", "new addition", "unknown"])
    assert.ok(question.completion.instruction.includes(meaning), meaning);
  for (const mutate of [
    r => { r.state.extra = "authority"; },
    r => { delete r.state.initial; },
    r => { delete r.state.graph.regions[1].kind; },
    r => { r.state.graph.regions[1].parent = "container"; },
    r => { r.state.graph.edges = [{ id: "edge", from: "container", to: "absent", kind: "flow", label: "" }]; },
    r => { r.state.graph.regions = Array.from({ length: 65 }, (_, i) => ({ id: `r${i}`, label: "region", kind: "step", parent: i ? "r0" : null })); },
  ]) { const bad = structuredClone(request); mutate(bad); assert.equal(isRequest(bad), false); }
  let calls = 0;
  const invoke = body => onRequestPost({ available: true, request: new Request("http://localhost/api/judge", {
    method: "POST", body: JSON.stringify(body),
  }) }, async input => { calls++; assert.deepEqual(input, { state: request.state, questions: question });
    return { answers: { completion: { choice: "incomplete", confidence: .9 } } }; });
  const response = await invoke(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answers.completion.choice, "incomplete");
  assert.equal((await invoke({ ...request, state: { ...request.state, graph: {} } })).status, 422);
  assert.equal(calls, 1, "a malformed read set never reaches Jev");
});

test("sufficient candidates build the graph, then a separate model judgment is bound to that head", async () => {
  const before = await opened(); let session = before; const asked = [];
  const result = await runGoal({ utterance: "OCIにAPIとDBを追加し、APIからDBへ矢印。他は変えない", bundle, protocol,
    current: () => session, cancelled: () => false, adopt: async next => { session = next; },
    ask: async request => {
      asked.push(request); assert.equal(isRequest(request), true);
      if (request.kind === GOAL_COMPLETION_KIND) {
        assert.deepEqual(request.state.initial, snapshot(before.working.records));
        assert.deepEqual(request.state.graph, snapshot(session.working.records));
        assert.ok(Object.isFrozen(request.state.initial) && Object.isFrozen(request.state.initial.regions[0]));
        const [api, db] = ["API", "DB"].map(label => request.state.graph.regions.find(r => r.label === label));
        assert.deepEqual([api.parent, db.parent, api.kind, db.kind], ["container", "container", "step", "data"]);
        assert.deepEqual(request.state.graph.edges.map(e => [e.from, e.to, e.kind]), [[api.id, db.id, "flow"]]);
        return verdict("complete", .8);
      }
      const { candidates, placing, selected, edges } = request.state;
      if (placing !== null) return delta(candidates.find(c => c.part === placing && c.parent === "container").id);
      if (selected.length < 2) return delta(`part:${selected.length ? "db" : "api"}`);
      return delta(edges.length ? NONE : candidates.find(c => c.from === selected[0].region && c.to === selected[1].region).id);
    } });
  assert.equal(result.reason, "none"); assert.equal(result.requests, 7);
  assert.deepEqual(result.completion, { status: "complete", head: session.working.head, confidence: .8, basis: "jev-judgment" });
  assert.equal(asked.at(-1).kind, GOAL_COMPLETION_KIND);
  assert.equal(result.selected.length, 2); assert.equal(session.stored, before.stored, "judgment never applies or stores the graph");
  assert.deepEqual((await undo(session, { verifyDecisionLog: protocol.verifyDecisionLog })).working.records, before.working.records);
});

test("legal stopping can leave missing parts, a wrong parent, a reverse arrow, or an extra part", async () => {
  // This deterministic oracle tests the integration, not real Jev accuracy.
  for (const scenario of ["partial", "wrong-parent", "reverse", "extra"]) {
    const before = await opened(); let session = before;
    const result = await runGoal({ utterance: scenario === "extra" ? "OCIにAPIを1つ追加。他は変えない"
      : "OCIにAPIとDBを追加し、APIからDBへ矢印。他は変えない", bundle, protocol,
      current: () => session, cancelled: () => false, adopt: async next => { session = next; },
      ask: async request => {
        if (request.kind === GOAL_COMPLETION_KIND) {
          const api = request.state.graph.regions.find(r => r.label === "API");
          const db = request.state.graph.regions.find(r => r.label === "DB");
          const correct = scenario === "extra" ? api?.parent === "container" && !db
            && request.state.graph.regions.length === request.state.initial.regions.length + 1
            : api?.parent === "container" && db?.parent === "container"
            && request.state.graph.edges.length === 1 && request.state.graph.edges[0].from === api.id
            && request.state.graph.edges[0].to === db.id
            && request.state.graph.regions.length === request.state.initial.regions.length + 2;
          return verdict(correct ? "complete" : "incomplete");
        }
        const { candidates, placing, selected, edges } = request.state;
        if (placing !== null) return delta(candidates.find(c => c.part === placing
          && c.parent === (scenario === "wrong-parent" ? "other" : "container")).id);
        if (scenario === "partial" && selected.length === 1) return delta(NONE);
        if (selected.length < 2) return delta(`part:${selected.length ? "db" : "api"}`);
        if (scenario === "extra") { assert.equal(selected.length, 2, "DB is an unrequested extra part"); return delta(NONE); }
        if (scenario !== "reverse") return delta(NONE);
        return delta(edges.length ? NONE : candidates.find(c => c.from === selected[1].region && c.to === selected[0].region).id);
      } });
    assert.equal(result.reason, "none", scenario);
    assert.equal(result.completion.status, "incomplete", scenario);
    assert.equal(result.completion.head, session.working.head, scenario);
  }
});

test("an existing matching node cannot alone satisfy an explicit additional-node request", async () => {
  const before = await opened([{ type: "region", id: "existing", parent: "container", label: "API", kind: "step", bounds: [20, 20, 140, 64], summary: "" }]);
  const result = await runGoal({ utterance: "OCIにAPIを新しく1つ追加", bundle, protocol, current: () => before,
    cancelled: () => false, adopt: async () => assert.fail("no selected move"), ask: async request => {
      if (request.kind === GOAL_REQUEST_KIND) return delta(NONE);
      assert.deepEqual(request.state.initial, request.state.graph);
      assert.equal(request.state.graph.regions.filter(r => r.label === "API").length, 1);
      return verdict("incomplete");
    } });
  assert.equal(result.reason, "none"); assert.equal(result.completion.status, "incomplete");
  assert.deepEqual(result.selected, []);
});

test("unknown, weak, failed, late, cancelled and stale terminal responses remain unknown", async () => {
  for (const mode of ["unknown", "weak", "malformed", "thrown", "late", "cancelled", "stale"]) {
    const before = await opened(); let session = before, cancelled = false, time = 0;
    const result = await runGoal({ utterance: "APIを追加", bundle, protocol, current: () => session,
      cancelled: () => cancelled, now: () => time, adopt: async () => assert.fail("no selected move"),
      ask: async request => {
        if (request.kind === GOAL_REQUEST_KIND) return delta(NONE);
        if (mode === "thrown") throw Error("provider unknown");
        if (mode === "late") time = 180000;
        if (mode === "cancelled") cancelled = true;
        if (mode === "stale") session = { ...session };
        return mode === "malformed" ? delta(NONE) : verdict(mode === "unknown" ? "unknown" : "complete", mode === "weak" ? .49 : 1);
      } });
    assert.equal(result.reason, "none", mode); assert.equal(result.requests, 2, mode);
    assert.equal(result.completion.status, "unknown", mode); assert.equal(result.completion.head, before.working.head, mode);
    assert.deepEqual(result.selected, [], mode);
  }
});

test("a weak NONE, an exhausted request budget, and an oversized whole graph cannot authorize completion", async () => {
  const before = await opened();
  const weak = await runGoal({ utterance: "APIを追加", bundle, protocol, current: () => before,
    cancelled: () => false, ask: async request => { assert.equal(request.kind, GOAL_REQUEST_KIND); return delta(NONE, .49); },
    adopt: async () => assert.fail("weak cannot adopt") });
  assert.equal(weak.requests, 1); assert.equal(weak.completion.status, "unknown");
  const four = { parts: [...bundle.parts, ...["third", "fourth"].map(key => ({ key, label: key, kind: "step", purpose: "one part" }))] };
  let session = before;
  const exhausted = await runGoal({ utterance: "4つの部品を追加", bundle: four, protocol, current: () => session,
    cancelled: () => false, adopt: async next => { session = next; }, ask: async request => {
      assert.equal(request.kind, GOAL_REQUEST_KIND, "the completion question cannot exceed the shared limit");
      return delta(request.state.placing === null ? `part:${four.parts[request.state.selected.length].key}`
        : request.state.candidates.find(c => c.parent === "container").id);
    } });
  assert.equal(exhausted.requests, 8); assert.equal(exhausted.reason, "budget-requests");
  assert.equal(exhausted.selected.length, 4); assert.equal(exhausted.completion.status, "unknown");
  const extra = Array.from({ length: 62 }, (_, i) => ({ type: "region", id: `existing-${i}`, parent: "container", label: "existing", kind: "step", bounds: [0, 0, 140, 64], summary: "" }));
  const large = await opened(extra);
  const oversized = await runGoal({ utterance: "変えない", bundle: { parts: [], diagrams: [] }, protocol,
    current: () => large, cancelled: () => false, ask: async () => assert.fail("no cropped terminal request"), adopt: async () => assert.fail("no adoption") });
  assert.equal(oversized.completion.status, "unknown"); assert.equal(oversized.requests, 0);
});
