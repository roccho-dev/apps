import {
  DecisionRefused,
  MIN_CONFIDENCE,
  RELATION_KIND,
  relationIdFor,
  relationKey,
  relationKeys,
  selectableRegionIds,
} from "./graph-edge.mjs";

// The working side of the two-pane graph. An utterance or typed request is
// judged by Jev against the working graph and every unapplied step, and a
// usable answer becomes one *draft step*: a provider Decision appended to the
// working log in memory. Nothing here writes storage or touches the saved
// graph; only Apply does that, in the page. The codec is injected, as in
// graph-edge.mjs and history.mjs.

export const DECISION_KIND = "voice-ui.jev.decision.v4";
export const ACTION_ADD = "add-edge";
export const ACTION_REMOVE = "remove-edge";
export const ACTION_REVERSE = "reverse-edge";
export const ACTION_UNDO_REQUEST = "undo-request";
export const ACTION_NONE = "none";
export const ACTION_REVERT = "revert";

// Every slot also offers "none", so a request that names no usable node or edge
// has somewhere to go other than the nearest wrong answer.
export const OPTION_NONE = "none";

// The working graph holds at most this many unapplied steps. At the cap nothing
// is dropped; new steps are refused until the user applies, undoes or discards.
export const DRAFT_MAX = 8;

export const OUTCOME_STEP = "step";
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

// Only operations the working graph can actually carry out are offered. With no
// edge there is nothing to remove or reverse, so those choices are not put to
// Jev at all. "undo-request" is always offered: it is where a spoken "undo"
// lands, so that it cannot be mistaken for the nearest graph edit.
export function correctionCriteria(records) {
  const regions = selectableRegionIds(records);
  refuse(regions.length >= 2, "graph has fewer than two selectable regions");
  refuse(!regions.includes(OPTION_NONE), `a region may not be named "${OPTION_NONE}"`);
  const edges = edgesOf(records);
  refuse(edges.every(edge => edge.id !== OPTION_NONE), `an edge may not be named "${OPTION_NONE}"`);
  return Object.freeze({
    actions: Object.freeze(edges.length > 0
      ? [ACTION_ADD, ACTION_REMOVE, ACTION_REVERSE, ACTION_UNDO_REQUEST, ACTION_NONE]
      : [ACTION_ADD, ACTION_UNDO_REQUEST, ACTION_NONE]),
    regions: Object.freeze([...regions, OPTION_NONE]),
    edges: Object.freeze(edges.length > 0 ? [...edges.map(edge => edge.id), OPTION_NONE] : []),
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

const noChange = (reason, extra = {}) => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason, ...extra });

// Turn a validated answer into the operations it means, or into "no change".
// "No change" is an ordinary answer - nothing to do, a slot answered "none", an
// undo asked for by voice, or not sure enough to act - and is never reported as
// an error. A request that cannot be carried out on this graph (a self edge, a
// duplicate, a vanished target) is a refusal.
function operationsFor(read, records) {
  if (read.action.choice === ACTION_NONE) return noChange("no graph change was requested");
  // Undo is a button. A spoken or typed "undo" never changes either graph: it
  // is answered with where the button is, and nothing else happens.
  if (read.action.choice === ACTION_UNDO_REQUEST) {
    return noChange("undo is not done by voice or text; use the 元に戻す button", { undoRequest: true });
  }

  const edges = edgesOf(records);
  const existing = relationKeys(records);

  if (read.action.choice === ACTION_ADD) {
    if (read.source.choice === OPTION_NONE || read.target.choice === OPTION_NONE) {
      return noChange("the request did not name two existing nodes");
    }
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

  if (read.edge.choice === OPTION_NONE) return noChange("the request did not name an existing edge");
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

const viaProvider = async (reason, run) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DecisionRefused) throw error;
    throw new DecisionRefused(`${reason}: ${error.message}`);
  }
};

const requireGraph = graph => {
  refuse(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  refuse(typeof graph?.head === "string" && graph.head.length > 0, "graph.head must be a non-empty string");
};

const step = (revision, action, changes, decision, confidence = null) => Object.freeze({
  revision,
  action,
  confidence,
  changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))),
  decision,
});

// Judge an answer against the working graph it was asked about. `revision` is
// the working head recorded when the request was sent: an answer that arrives
// after the working graph has moved describes a graph the user no longer sees,
// so it is refused rather than applied to a different one. A usable answer is
// built into a provider Decision on that head, so the provider validates the
// step before it ever reaches the working graph. Nothing is appended here.
export async function planStep({ working, revision, answers, protocol } = {}) {
  requireGraph(working);
  refuse(typeof protocol?.createDecision === "function", "protocol.createDecision is required");
  refuse(revision === working.head, "the answer is stale: the working graph changed after the request was sent");

  const read = readAnswers(answers, correctionCriteria(working.records));
  const planned = operationsFor(read, working.records);
  if (planned.outcome === OUTCOME_NO_CHANGE) return planned;

  const { decision } = await viaProvider("the provider rejected the change",
    () => protocol.createDecision(working.head, planned.operations, working.records));
  return Object.freeze({
    outcome: OUTCOME_STEP,
    step: step(working.head, planned.action, planned.changes, decision, planned.confidence),
  });
}

// Put a planned step onto the working graph. It must still sit on the head it
// was planned against; the provider refuses the append otherwise as well.
export async function appendStep({ working, step: planned, protocol } = {}) {
  requireGraph(working);
  refuse(typeof protocol?.appendDecision === "function", "protocol.appendDecision is required");
  refuse(planned?.decision !== undefined, "there is no step to append");
  refuse(planned.revision === working.head, "the step is stale: the working graph changed after it was planned");

  const appended = await viaProvider("the provider refused to append the step",
    () => protocol.appendDecision(working.log, planned.decision));
  return appended.verified;
}

const relationsById = records => new Map(
  records.filter(record => record?.type === "relation").map(record => [record.id, record]),
);
const regionIds = records => records.filter(record => record?.type === "region").map(record => record.id).sort();
const sameEdge = (left, right) => left?.from === right?.from && left?.to === right?.to;

// Undo a saved entry by adding its opposite to the working graph. `before` and
// `after` are the provider's states around that entry; the opposite is read off
// their difference - edges it added are removed, edges it removed are put back
// with the id, kind and label they had - and checked against the working graph
// as it is now. Only edge changes can be reverted. A later change that already
// altered one of those edges makes the revert a conflict, and it is refused
// rather than guessed at. The saved graph is never touched.
export async function revertStep({ before, after, working, protocol } = {}) {
  requireGraph(working);
  refuse(Array.isArray(before) && Array.isArray(after), "before and after states are required");
  refuse(typeof protocol?.createDecision === "function", "protocol.createDecision is required");
  refuse(JSON.stringify(regionIds(before)) === JSON.stringify(regionIds(after)), "only edge changes can be reverted");

  const earlier = relationsById(before);
  const later = relationsById(after);
  const added = [...later.values()].filter(relation => !sameEdge(earlier.get(relation.id), relation));
  const removed = [...earlier.values()].filter(relation => !sameEdge(later.get(relation.id), relation));
  refuse(added.length + removed.length > 0, "that entry changed no edge");

  const current = relationsById(working.records);
  for (const relation of added) {
    refuse(sameEdge(current.get(relation.id), relation), "a later change already altered this edge; nothing was reverted");
  }
  for (const relation of removed) {
    refuse(!current.has(relation.id), "a later change already reused this edge; nothing was reverted");
  }

  const operations = [
    ...(added.length > 0
      ? [{ type: "RemoveSelection", regionIds: [], relationIds: added.map(relation => relation.id) }]
      : []),
    ...removed.map(relation => ({
      type: "ConnectRegions",
      relationId: relation.id,
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      label: relation.label,
    })),
  ];
  const { decision } = await viaProvider("the provider rejected the revert",
    () => protocol.createDecision(working.head, operations, working.records));
  return step(working.head, ACTION_REVERT, [
    ...added.map(({ from, to }) => ({ change: "removed", from, to })),
    ...removed.map(({ from, to }) => ({ change: "added", from, to })),
  ], decision);
}

// What the user is looking at, so a follow-up like "reverse that" can be judged
// against it: the latest working step if there is one, otherwise the most
// recently applied change, otherwise nothing.
export function focusFor({ draft = [], lastApplied = [] } = {}) {
  const pick = (kind, changes) => Object.freeze({
    kind,
    changes: Object.freeze(changes.map(({ change, from, to }) => Object.freeze({ change, from, to }))),
  });
  if (draft.length > 0) return pick("draft", draft.at(-1).changes);
  if (lastApplied.length > 0) return pick("applied", lastApplied);
  return pick("none", []);
}
