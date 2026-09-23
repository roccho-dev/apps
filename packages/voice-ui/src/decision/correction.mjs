import {
  DecisionRefused,
  GRAPH_PATTERN,
  MIN_CONFIDENCE,
  RELATION_KIND,
  relationIdFor,
  relationKey,
  relationKeys,
  selectableRegionIds,
} from "./graph-edge.mjs";

// The correction loop: an utterance or typed request is judged by Jev against
// the graph on screen and whatever the user is looking at, and the answer
// becomes a *proposal* - a provider Decision that is shown but not applied.
// Only an explicit confirmation appends it. Nothing here touches storage or the
// DOM; the codec is injected, as in graph-edge.mjs and history.mjs.

export const DECISION_KIND = "voice-ui.jev.decision.v3";
export const ACTION_ADD = "add-edge";
export const ACTION_REMOVE = "remove-edge";
export const ACTION_REVERSE = "reverse-edge";
export const ACTION_NONE = "none";

export const OUTCOME_PROPOSED = "proposed";
export const OUTCOME_NO_CHANGE = "no-change";

const refuse = (condition, reason) => {
  if (!condition) throw new DecisionRefused(reason);
};

export function edgesOf(records) {
  refuse(Array.isArray(records), "records must be an array");
  return Object.freeze(
    records
      .filter(record => record?.type === "relation")
      .map(record => Object.freeze({ id: record.id, from: record.from, to: record.to })),
  );
}

// Only operations the current graph can actually carry out are offered. With
// no edge there is nothing to remove or reverse, so those choices are not put
// to Jev at all rather than being offered and then refused.
export function correctionCriteria(records) {
  const regions = selectableRegionIds(records);
  refuse(regions.length >= 2, "graph has fewer than two selectable regions");
  const edges = edgesOf(records);
  return Object.freeze({
    actions: Object.freeze(edges.length > 0
      ? [ACTION_ADD, ACTION_REMOVE, ACTION_REVERSE, ACTION_NONE]
      : [ACTION_ADD, ACTION_NONE]),
    regions,
    edges: Object.freeze(edges.map(edge => edge.id)),
  });
}

const choiceOf = (answers, name, offered) => {
  const answer = answers?.[name];
  refuse(answer?.type === "choice", `${name} is not a choice answer`);
  refuse(typeof answer.choice === "string", `${name}.choice is not a string`);
  refuse(offered.includes(answer.choice), `${name}.choice is outside the offered criteria`);
  refuse(
    typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
      && answer.confidence >= 0 && answer.confidence <= 1,
    `${name}.confidence is outside [0,1]`,
  );
  return answer;
};

// The answer set must be exactly the questions that were asked: the edge
// question exists only when the graph has an edge to choose.
function readAnswers(answers, criteria) {
  refuse(
    answers !== null && typeof answers === "object" && !Array.isArray(answers),
    "answers must be an object",
  );
  const expected = criteria.edges.length > 0
    ? ["action", "source", "target", "edge"]
    : ["action", "source", "target"];
  for (const key of expected) refuse(Object.hasOwn(answers, key), `answers.${key} is required`);
  for (const key of Object.keys(answers)) refuse(expected.includes(key), `answers.${key} is not allowed`);

  return Object.freeze({
    action: choiceOf(answers, "action", criteria.actions),
    source: choiceOf(answers, "source", criteria.regions),
    target: choiceOf(answers, "target", criteria.regions),
    edge: criteria.edges.length > 0 ? choiceOf(answers, "edge", criteria.edges) : null,
  });
}

const noChange = reason => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason });

// Turn a validated answer into the operations it means, or into "no change".
// "No change" is an ordinary answer - nothing to do, or not sure enough to act
// - and is never reported as an error. A request that cannot be carried out on
// this graph (a self edge, a duplicate, a vanished target) is a refusal.
function operationsFor(read, records) {
  if (read.action.choice === ACTION_NONE) return noChange("no graph change was requested");

  const edges = edgesOf(records);
  const existing = relationKeys(records);

  if (read.action.choice === ACTION_ADD) {
    const confidence = Math.min(read.action.confidence, read.source.confidence, read.target.confidence);
    if (confidence < MIN_CONFIDENCE) return noChange("not confident enough to propose a change");
    refuse(read.source.choice !== read.target.choice, "source and target are the same region");
    refuse(!existing.has(relationKey(read.source.choice, read.target.choice)), "relation already exists");
    return Object.freeze({
      action: ACTION_ADD,
      confidence,
      operations: [{
        type: "ConnectRegions",
        relationId: relationIdFor(read.source.choice, read.target.choice),
        from: read.source.choice,
        to: read.target.choice,
        kind: RELATION_KIND,
        label: "",
      }],
      changes: [{ change: "added", from: read.source.choice, to: read.target.choice }],
    });
  }

  const confidence = Math.min(read.action.confidence, read.edge.confidence);
  if (confidence < MIN_CONFIDENCE) return noChange("not confident enough to propose a change");
  const edge = edges.find(candidate => candidate.id === read.edge.choice);
  refuse(edge !== undefined, "the chosen edge no longer exists");
  const remove = { type: "RemoveSelection", regionIds: [], relationIds: [edge.id] };

  if (read.action.choice === ACTION_REMOVE) {
    return Object.freeze({
      action: ACTION_REMOVE,
      confidence,
      operations: [remove],
      changes: [{ change: "removed", from: edge.from, to: edge.to }],
    });
  }

  // Reverse is one Decision holding a removal and an addition, so it applies
  // whole or not at all. ReconnectRelation would keep the old id, which encodes
  // the old direction, and a later add of that direction would then collide.
  const relation = records.find(record => record.type === "relation" && record.id === edge.id);
  refuse(!existing.has(relationKey(edge.to, edge.from)), "the reversed edge already exists");
  return Object.freeze({
    action: ACTION_REVERSE,
    confidence,
    operations: [remove, {
      type: "ConnectRegions",
      relationId: relationIdFor(edge.to, edge.from),
      from: edge.to,
      to: edge.from,
      kind: relation.kind,
      label: relation.label,
    }],
    changes: [
      { change: "removed", from: edge.from, to: edge.to },
      { change: "added", from: edge.to, to: edge.from },
    ],
  });
}

const uiIrFor = envelope => Object.freeze({
  kind: "ui.ir.v1",
  capability: "render.semantic-map",
  payloadKind: "semantic-map-envelope/3",
  payload: envelope,
});

const viaProvider = async (reason, run) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DecisionRefused) throw error;
    throw new DecisionRefused(`${reason}: ${error.message}`);
  }
};

// Judge an answer against the verified graph and, if it asks for a change,
// build it as a provider Decision bound to the current head. The Decision is
// validated by the provider here, so a proposal that is shown can be applied
// exactly as shown - but nothing is appended: the log and graph are untouched.
export async function proposeCorrection({ graph, answers, protocol } = {}) {
  refuse(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  refuse(typeof graph?.head === "string" && graph.head.length > 0, "graph.head must be a non-empty string");
  refuse(typeof protocol?.createDecision === "function", "protocol.createDecision is required");
  refuse(typeof protocol?.createEnvelope === "function", "protocol.createEnvelope is required");

  const read = readAnswers(answers, correctionCriteria(graph.records));
  const planned = operationsFor(read, graph.records);
  if (planned.outcome === OUTCOME_NO_CHANGE) return planned;

  const { decision } = await viaProvider("the provider rejected the change",
    () => protocol.createDecision(graph.head, planned.operations, graph.records));
  const envelope = await protocol.createEnvelope(graph.log, decision, { pattern: GRAPH_PATTERN });

  return Object.freeze({
    outcome: OUTCOME_PROPOSED,
    proposal: Object.freeze({
      head: graph.head,
      action: planned.action,
      confidence: planned.confidence,
      changes: Object.freeze(planned.changes.map(Object.freeze)),
      decision,
    }),
    ir: uiIrFor(envelope),
  });
}

// Apply a proposal the user confirmed. It must still sit on the head it was
// made against: a graph that moved on underneath it makes it stale, and it is
// refused rather than re-based onto a graph the user never looked at.
export async function confirmProposal({ graph, proposal, protocol } = {}) {
  refuse(typeof protocol?.appendDecision === "function", "protocol.appendDecision is required");
  refuse(typeof protocol?.createEnvelope === "function", "protocol.createEnvelope is required");
  refuse(proposal?.decision !== undefined, "there is no proposal to confirm");
  refuse(proposal.head === graph?.head, "the proposal is stale: the graph changed after it was made");

  const appended = await viaProvider("the provider refused to append the proposal",
    () => protocol.appendDecision(graph.log, proposal.decision));
  const envelope = await protocol.createEnvelope(appended.log, null, { pattern: GRAPH_PATTERN });
  return Object.freeze({ ir: uiIrFor(envelope), graph: appended.verified });
}

// What the user is looking at, so a follow-up like "reverse that" can be judged
// against it: the pending proposal if there is one, otherwise the most recently
// confirmed change, otherwise nothing.
export function focusFor({ proposal = null, lastConfirmed = null } = {}) {
  const pick = (kind, changes) => Object.freeze({
    kind,
    changes: Object.freeze(changes.map(({ change, from, to }) => Object.freeze({ change, from, to }))),
  });
  if (proposal) return pick("proposal", proposal.changes);
  if (lastConfirmed?.length) return pick("confirmed", lastConfirmed);
  return pick("none", []);
}
