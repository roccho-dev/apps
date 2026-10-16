import { ACTION_ADD_EDGE, ARCHITECTURE_GOAL_INTENT_KIND, ARCHITECTURE_INTENT_KIND, GOAL_REQUEST_KIND, GOAL_REQUEST_MAX, MIN_CONFIDENCE, NONE, isRequest,
  architectureGoalSlotsFor, partOption, readAnswers, slotsFor } from "./contract.mjs";
import { offersOf } from "./bundle.mjs";
import { scopeOf } from "./architecture.mjs";
import { legalLocalDeltas, OUTCOME_STEP, proveLocalDelta } from "./turn.mjs";
import { proposeGoal, recentConversation } from "./session.mjs";

// What a scoped Goal request shows: every end of its offered arrows, every
// group enclosing them up to the root, and only the relations between the
// named end and those ends - for one resolved arrow, the relations between its
// two ends - plus, for an end that is a role node of the scope, the one
// relation that attaches it to a focused part and that part, so the server can
// check the scope. Nothing is cropped. The whole Working still decides what is
// legal, proved and adopted.
const localView = (records, pair, candidates, attachments) => {
  const named = pair.from ?? pair.to;
  const ends = new Set(candidates.flatMap(candidate => [candidate.from, candidate.to]));
  const attaching = new Set(attachments.filter(relation => ends.has(relation.to)).map(relation => relation.id));
  const parentOf = new Map(records.filter(record => record.type === "region").map(record => [record.id, record.parent]));
  const shown = new Set();
  const starts = [...ends, ...attachments.filter(relation => attaching.has(relation.id)).map(relation => relation.from)];
  for (const end of starts) {
    for (let at = end; at !== null && at !== undefined && !shown.has(at); at = parentOf.get(at)) shown.add(at);
  }
  return records.filter(record => (record.type === "region" ? shown.has(record.id)
    : record.type === "relation" && (attaching.has(record.id)
      || ends.has(record.from) && ends.has(record.to) && (record.from === named || record.to === named))));
};
// Without the page's manifest no role can widen a scope.
const NO_ROLES = Object.freeze({ roles: Object.freeze([]) });

// One bounded AddRegion/ConnectRegions attempt. Ports own HTTP and the draw/adopt effect;
// this coordinator owns only actual selected history and mechanical STOP.
// It has no semantic goal oracle and never writes durable state.
// On every iteration a scoped Goal validates the page's latest intent, then
// projects its whole graph, conversation and source identity into three
// questions: action and endpoints. This resolve counts against the same bound.
export async function runGoal({ utterance, bundle, protocol, current, ask, adopt, cancelled, resolveIntent = null, manifest = null,
  now = () => performance.now(), deadlineAt = null }) {
  const first = current();
  const group = first.nextSeq;
  const selected = [];
  const trace = [];
  const started = now();
  const deadline = deadlineAt === null ? started + 180000 : deadlineAt;
  const stop = reason => Object.freeze({ reason, requests: trace.length, elapsedMs: Math.max(0, now() - started),
    selected: Object.freeze([...selected]), trace: Object.freeze([...trace]) });
  let expected = first;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return stop("invalid-goal-deadline");
  if (now() >= deadline) return stop("budget-time");
  // The latest source focus the session remembered, held for the whole Goal so
  // later utterances cannot push it out of the recent conversation.
  const reference = [...first.conversation].reverse().find(entry => entry.reference)?.reference ?? null;
  const scope = reference === null ? null
    : Object.freeze({ source: Object.freeze({ ...reference.source }), focus: Object.freeze([...reference.focus]) });
  if (scope !== null && typeof resolveIntent !== "function") return stop("invalid-goal-request");
  // One counted judgment. Nothing is sent once the Goal is cancelled, out of
  // time, no longer current or at its request bound; a thrown call is unknown,
  // an unreadable answer a contract failure, and afterwards it must still be current.
  const judged = async (request, slots) => {
    if (cancelled()) return { stop: "cancelled" };
    if (now() >= deadline) return { stop: "budget-time" };
    if (current() !== expected || expected.working === null) return { stop: "stale-goal" };
    if (trace.length >= GOAL_REQUEST_MAX) return { stop: "budget-requests" };
    const head = expected.working.head;
    let answered;
    try { answered = await ask(request); }
    catch {
      trace.push(Object.freeze({ head, answers: null, failure: "judge-unknown" }));
      return { stop: "judge-unknown" };
    }
    const read = answered?.kind === "answered" ? readAnswers(answered.decision?.answers, slots) : null;
    trace.push(Object.freeze({ head, answers: read, failure: answered?.kind === "failed" ? answered.reason : read === null ? "judge-contract" : null }));
    if (read === null) return { stop: "judge-failed" };
    if (cancelled()) return { stop: "cancelled" };
    if (now() >= deadline) return { stop: "budget-time" };
    if (current() !== expected) return { stop: "stale-goal" };
    return { read };
  };
  while (trace.length < GOAL_REQUEST_MAX) {
    if (cancelled()) return stop("cancelled");
    if (now() >= deadline) return stop("budget-time");
    if (current() !== expected || expected.working === null) return stop("stale-goal");
    // The scope of the latest Working: its focused parts and the role nodes attached to them.
    const scoped = scope === null ? null
      : scopeOf(manifest ?? NO_ROLES, scope.focus, expected.working.records.filter(record => record.type === "relation"));
    const regions = scoped === null ? null : scoped.regions;
    let pair = null;
    if (scope !== null) {
      let intent;
      // Building and checking the intent are one step: a resolver that throws,
      // or a request or turn that is not this Working's own, asks nothing.
      try {
        intent = resolveIntent(expected);
        if (intent?.request?.kind !== ARCHITECTURE_INTENT_KIND || !isRequest(intent.request)
          || intent.turn?.head !== expected.working.head
          || JSON.stringify(intent.turn.slots) !== JSON.stringify(slotsFor(intent.request.state))) intent = null;
      } catch { intent = null; }
      if (intent === null) return stop("invalid-goal-request");
      const { utterance: text, graph, context, architecture } = intent.request.state;
      const edges = [];
      for (const edge of graph.edges) {
        const matches = expected.working.records.filter(record => record.type === "relation" && record.id === edge.id);
        if (matches.length !== 1 || matches[0].from !== edge.from || matches[0].to !== edge.to) return stop("invalid-goal-request");
        // Carry only the actual current Working kind, never infer it from an ID.
        edges.push({ ...edge, kind: matches[0].kind });
      }
      const request = { kind: ARCHITECTURE_GOAL_INTENT_KIND, state: {
        utterance: text, graph: { regions: graph.regions, edges }, context, architecture,
      } };
      if (!isRequest(request)) return stop("invalid-goal-request");
      const resolved = await judged(request, architectureGoalSlotsFor(request.state));
      if (resolved.stop !== undefined) return stop(resolved.stop);
      const { action, source, target } = resolved.read;
      if (action.choice !== ACTION_ADD_EDGE || (source.choice === NONE && target.choice === NONE)) return stop("none");
      // The weakest answer governs, an end answered none included.
      if (Math.min(action.confidence, source.confidence, target.confidence) < MIN_CONFIDENCE) return stop("not-confident");
      // An end answered none is open, never an endpoint: it ranges only over the
      // focus, and the Goal judgment below picks one offered arrow or none.
      pair = Object.freeze({ from: source.choice === NONE ? null : source.choice, to: target.choice === NONE ? null : target.choice });
    }
    const parts = offersOf(bundle, { named: true }).parts;
    const held = legalLocalDeltas(expected.working, { bundle, protocol, reserved: expected.issuedPartIds, selected, scope: regions, pair });
    if (held.candidates.length === 0) return stop("no-executable-delta");
    if (held.candidates.length > 254) return stop("candidate-overflow");
    const shown = pair === null ? expected.working.records : localView(expected.working.records, pair, held.candidates, scoped.attachments);
    const parents = shown.filter(record => record.type === "region"
      && record.kind === "group" && record.parent !== null)
      .map(({ id, label, kind, parent }) => ({ id, label, kind, parent }));
    const state = {
      utterance,
      graph: shown.filter(record => record.type === "region")
        .map(({ id, label, parent }) => ({ id, label, parent })),
      edges: shown.filter(record => record.type === "relation")
        .map(({ id, from, to }) => ({ id, from, to })),
      parents, offers: { parts }, selected: [...selected],
      candidates: Object.freeze(held.candidates.map(candidate => Object.freeze(candidate.part !== undefined
        ? { id: candidate.id, action: "add-part", part: candidate.part, parent: candidate.parent }
        : { id: candidate.id, action: "add-edge", from: candidate.from, to: candidate.to }))),
      context: { recent: recentConversation(expected).recent },
      scope,
    };
    // One counted judgment per frame over the same held candidates: what comes
    // next over all of them, then - only for a part - where it goes, shown only
    // that part's held additions in their order; adoption proves the whole held set.
    const frame = async bound => {
      const request = { kind: GOAL_REQUEST_KIND, state: bound === null ? { ...state, placing: null }
        : { ...state, placing: bound, candidates: Object.freeze(state.candidates.filter(item => item.part === bound)) } };
      if (!isRequest(request)) return { stop: "invalid-goal-request" };
      const answer = await judged(request, slotsFor(request.state));
      if (answer.stop !== undefined) return answer;
      const { choice, confidence } = answer.read.delta;
      if (choice === NONE) return { stop: "none" };
      return confidence < MIN_CONFIDENCE ? { stop: "not-confident" } : { choice, confidence };
    };
    const what = await frame(null);
    if (what.stop !== undefined) return stop(what.stop);
    let { choice, confidence } = what;
    // A part alternative names no candidate: the bound frame names the held one,
    // and the weaker of the two answers is the step's confidence.
    const placing = held.candidates.find(item => item.part !== undefined && partOption(item.part) === choice)?.part;
    if (placing !== undefined) {
      const where = await frame(placing);
      if (where.stop !== undefined) return stop(where.stop);
      ({ choice } = where);
      confidence = Math.min(confidence, where.confidence);
    }
    const candidate = held.candidates.find(item => item.id === choice);
    const planned = await proveLocalDelta({ working: expected.working, held, candidateId: choice,
      confidence, bundle, reserved: expected.issuedPartIds, selected, scope: regions, pair, protocol });
    if (planned.outcome !== OUTCOME_STEP) return stop(planned.reason);
    if (cancelled() || current() !== expected) return stop("stale-goal");
    if (now() >= deadline) return stop("budget-time");
    const proposed = await proposeGoal(expected, { step: planned.step, input: { source: "typed", text: utterance }, group, protocol });
    if (proposed.result.outcome !== OUTCOME_STEP) return stop(proposed.result.reason);
    if (cancelled() || current() !== expected) return stop("stale-goal");
    if (now() >= deadline) return stop("budget-time");
    try { await adopt(proposed.session); }
    catch { return stop("adoption-unknown"); }
    if (current() !== proposed.session) return stop("adoption-unknown");
    const operation = planned.step.decision.operations.find(item => item.type === "AddRegion" || item.type === "ConnectRegions");
    if (operation.type === "ConnectRegions") {
      const edge = proposed.session.working.records.find(item => item.type === "relation" && item.id === operation.relationId);
      if (edge?.from !== operation.from || edge.to !== operation.to || edge.kind !== operation.kind || edge.label !== operation.label) return stop("adoption-unknown");
      expected = proposed.session;
      continue;
    }
    const record = proposed.session.working.records.find(item => item.type === "region" && item.id === operation.regionId);
    const part = bundle.parts.find(item => item.key === candidate.part);
    if (record?.parent !== candidate.parent || record.kind !== part.kind || record.label !== operation.label) return stop("adoption-unknown");
    selected.push(Object.freeze({ key: part.key, region: record.id, parent: record.parent }));
    expected = proposed.session;
  }
  return stop("budget-requests");
}
