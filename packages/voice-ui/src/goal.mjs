import { GOAL_REQUEST_KIND, GOAL_REQUEST_MAX, MIN_CONFIDENCE, NONE, isRequest, readAnswers, slotsFor } from "./contract.mjs";
import { offersOf } from "./bundle.mjs";
import { legalAdditions, OUTCOME_STEP, proveAddition } from "./turn.mjs";
import { proposeGoal } from "./session.mjs";

// One bounded AddRegion attempt. Ports own HTTP and the draw/adopt effect;
// this coordinator owns only actual selected history and mechanical STOP.
// It has no semantic goal oracle and never writes durable state.
export async function runGoal({ utterance, bundle, protocol, current, ask, adopt, cancelled, now = () => performance.now() }) {
  const first = current();
  const group = first.nextSeq;
  const selected = [];
  const trace = [];
  const started = now();
  const stop = reason => Object.freeze({ reason, requests: trace.length, elapsedMs: Math.max(0, now() - started),
    selected: Object.freeze([...selected]), trace: Object.freeze([...trace]) });
  let expected = first;
  for (let count = 0; count < GOAL_REQUEST_MAX; count += 1) {
    if (cancelled()) return stop("cancelled");
    if (now() - started >= 180000) return stop("budget-time");
    if (current() !== expected || expected.working === null) return stop("stale-goal");
    const parts = offersOf(bundle).parts;
    if (parts.every(part => selected.some(item => item.key === part.key))) return stop("offers-exhausted");
    const held = legalAdditions(expected.working, { bundle, protocol, reserved: expected.issuedPartIds, selected });
    if (held.candidates.length === 0) return stop("no-room-for-part");
    if (held.candidates.length > 254) return stop("candidate-overflow");
    const parents = expected.working.records.filter(record => record.type === "region"
      && held.candidates.some(candidate => candidate.parent === record.id))
      .map(({ id, label, kind, parent }) => ({ id, label, kind, parent }));
    const request = { kind: GOAL_REQUEST_KIND, state: {
      utterance,
      graph: expected.working.records.filter(record => record.type === "region")
        .map(({ id, label, parent }) => ({ id, label, parent })),
      parents, offers: { parts }, selected: [...selected],
      candidates: Object.freeze(held.candidates.map(({ id, part, parent }) => Object.freeze({ id, part, parent }))),
    } };
    if (!isRequest(request)) return stop("invalid-goal-request");
    const head = expected.working.head;
    let answered;
    try { answered = await ask(request); }
    catch {
      trace.push(Object.freeze({ head, answers: null, failure: "judge-unknown" }));
      return stop("judge-unknown");
    }
    const read = answered?.kind === "answered" ? readAnswers(answered.decision?.answers, slotsFor(request.state)) : null;
    trace.push(Object.freeze({ head, answers: read, failure: answered?.kind === "failed" ? answered.reason : read === null ? "judge-contract" : null }));
    if (read === null) return stop("judge-failed");
    if (cancelled()) return stop("cancelled");
    if (now() - started >= 180000) return stop("budget-time");
    if (current() !== expected) return stop("stale-goal");
    if (read.delta.choice === NONE) return stop("none");
    const confidence = read.delta.confidence;
    if (confidence < MIN_CONFIDENCE) return stop("not-confident");
    const candidate = held.candidates.find(item => item.id === read.delta.choice);
    const planned = await proveAddition({ working: expected.working, held, candidateId: read.delta.choice,
      confidence, bundle, reserved: expected.issuedPartIds, selected, protocol });
    if (planned.outcome !== OUTCOME_STEP) return stop(planned.reason);
    if (cancelled() || current() !== expected) return stop("stale-goal");
    const proposed = await proposeGoal(expected, { step: planned.step, input: { source: "typed", text: utterance }, group, protocol });
    if (proposed.result.outcome !== OUTCOME_STEP) return stop(proposed.result.reason);
    if (cancelled() || current() !== expected) return stop("stale-goal");
    try { await adopt(proposed.session); }
    catch { return stop("adoption-unknown"); }
    if (current() !== proposed.session) return stop("adoption-unknown");
    const operation = planned.step.decision.operations.find(item => item.type === "AddRegion");
    const record = proposed.session.working.records.find(item => item.type === "region" && item.id === operation.regionId);
    const part = bundle.parts.find(item => item.key === candidate.part);
    if (record?.parent !== candidate.parent || record.kind !== part.kind || record.label !== operation.label) return stop("adoption-unknown");
    selected.push(Object.freeze({ key: part.key, region: record.id, parent: record.parent }));
    expected = proposed.session;
  }
  return stop("budget-requests");
}
