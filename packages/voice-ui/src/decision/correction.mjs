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
export const ACTION_ADD_PART = "add-part";
export const ACTION_PLACE_PART = "place-part";
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

// The parts a person may ask for, each a kind the graph view already draws
// differently. The app owns this list: Jev chooses one of these keys, never a
// kind or a label of its own, so no answer can invent a shape the view cannot
// show. A part is named after the id it gets, so two parts never share a name.
export const PART_PALETTE = Object.freeze([
  Object.freeze({ key: "step", label: "工程", kind: "step" }),
  Object.freeze({ key: "decision", label: "判断", kind: "decision" }),
  Object.freeze({ key: "data", label: "データ", kind: "data" }),
  Object.freeze({ key: "start", label: "開始", kind: "start" }),
  Object.freeze({ key: "end", label: "終了", kind: "end" }),
]);

// A new part is the size of an initial node, laid out on a fixed grid inside
// the enclosing boundary. The graph view lays parts out by itself and ignores
// these bounds, but the provider requires them and a later spatial view would
// draw them, so they are real, inside the parent and never overlapping - never
// a placeholder every part shares.
const PART_WIDTH = 140;
const PART_HEIGHT = 64;
const PART_GAP = 20;
const PART_ID_PREFIX = "part-";

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
// Where a part goes when it is put beside another one. The app never invents
// a size or a position: it asks the view where things actually are through the
// provider's public layout contract, and offers Jev only the four neighbouring
// directions of a part that is already on screen.
export const DIRECTIONS = Object.freeze(["left", "right", "above", "below"]);

// The gap between a part and the one it is placed beside. The sizes come from
// the view; only this spacing is ours.
const NEIGHBOUR_GAP = 24;

const overlapping = (left, right) =>
  left[0] < right[0] + right[2] && right[0] < left[0] + left[2]
  && left[1] < right[1] + right[3] && right[1] < left[1] + left[3];

const inside = (frame, box) =>
  box[0] >= frame[0] && box[1] >= frame[1]
  && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3];

// The parts a person can talk about: the regions this graph offers as
// endpoints - never the enclosing boundary, which cannot be pinned - and only
// those the view actually places. A part the view folds away has no position
// to put anything beside.
export function placeableIds(layout, records) {
  refuse(layout?.bounds !== undefined, "layout bounds are required");
  return Object.freeze(selectableRegionIds(records)
    .filter(regionId => Object.hasOwn(layout.bounds, regionId))
    .sort());
}

// The bounds a part would take beside its anchor: the anchor's own position
// and the moving part's own size, both read from the view, offset by one gap.
export function neighbourBounds(layout, targetId, anchorId, direction) {
  const anchor = layout.bounds[anchorId];
  const target = layout.bounds[targetId];
  refuse(anchor !== undefined, "the anchor is not placed in this view");
  refuse(target !== undefined, "the part is not placed in this view");
  refuse(DIRECTIONS.includes(direction), `unknown direction ${direction}`);
  const [ax, ay, aw, ah] = anchor;
  const [, , tw, th] = target;
  if (direction === "left") return Object.freeze([ax - tw - NEIGHBOUR_GAP, ay, tw, th]);
  if (direction === "right") return Object.freeze([ax + aw + NEIGHBOUR_GAP, ay, tw, th]);
  if (direction === "above") return Object.freeze([ax, ay - th - NEIGHBOUR_GAP, tw, th]);
  return Object.freeze([ax, ay + ah + NEIGHBOUR_GAP, tw, th]);
}

// A spot is usable only if nothing else the view placed already sits there.
// The part being moved does not block its own move.
export function spotIsFree(layout, records, targetId, box) {
  const placeable = placeableIds(layout, records);
  return placeable
    .filter(regionId => regionId !== targetId)
    .every(regionId => !overlapping(box, layout.bounds[regionId]));
}

const boundsOf = record => Object.freeze({
  x: record.bounds[0], y: record.bounds[1], w: record.bounds[2], h: record.bounds[3],
});

const overlaps = (left, right) =>
  left.x < right.x + right.w && right.x < left.x + left.w
  && left.y < right.y + right.h && right.y < left.y + left.h;

// The first free place on the grid inside the enclosing boundary, in reading
// order, that no existing region already occupies. There is a finite number of
// them: a full boundary is an honest "no room", not a part dropped on top of
// another.
export function freeSlot(records) {
  refuse(Array.isArray(records), "records must be an array");
  const root = records.find(record => record?.type === "region" && record.parent === null);
  refuse(root !== undefined, "the graph has no enclosing boundary");
  const frame = boundsOf(root);
  const taken = records
    .filter(record => record?.type === "region" && record.parent !== null)
    .map(boundsOf);

  for (let y = frame.y + PART_GAP; y + PART_HEIGHT <= frame.y + frame.h; y += PART_HEIGHT + PART_GAP) {
    for (let x = frame.x + PART_GAP; x + PART_WIDTH <= frame.x + frame.w; x += PART_WIDTH + PART_GAP) {
      const slot = { x, y, w: PART_WIDTH, h: PART_HEIGHT };
      if (!taken.some(used => overlaps(slot, used))) return Object.freeze([x, y, PART_WIDTH, PART_HEIGHT]);
    }
  }
  return null;
}

// The next part name, counted over the whole log rather than the current
// graph, plus any name the page has already handed out. A part that was added
// and then removed keeps its name for good, and so does one the page undid -
// undo cuts its Decision out of the log, but the conversation still refers to
// it - so a name in the history or in an earlier utterance can never come to
// mean a second part.
export function nextPartId(graph, reserved = []) {
  refuse(Array.isArray(graph?.decisions), "graph.decisions is required");
  const named = [
    ...reserved,
    ...graph.records.filter(record => record?.type === "region").map(record => record.id),
    ...graph.decisions.flatMap(decision => (decision.operations ?? []).flatMap(operation =>
      operation.type === "AddRegion" ? [operation.regionId]
        : operation.type === "CreateMap" ? operation.records.filter(record => record?.type === "region").map(record => record.id)
          : [])),
  ];
  const used = named
    .filter(id => id.startsWith(PART_ID_PREFIX))
    .map(id => Number(id.slice(PART_ID_PREFIX.length)))
    .filter(Number.isSafeInteger);
  return `${PART_ID_PREFIX}${Math.max(0, ...used) + 1}`;
}

// `layout` is the provider's public answer about where this graph is drawn.
// Placement is offered only when it is present and holds at least two parts:
// something to move, and something to put it beside.
export function correctionCriteria(records, layout = null) {
  const regions = selectableRegionIds(records);
  refuse(regions.length >= 2, "graph has fewer than two selectable regions");
  refuse(!regions.includes(OPTION_NONE), `a region may not be named "${OPTION_NONE}"`);
  const edges = edgesOf(records);
  refuse(edges.every(edge => edge.id !== OPTION_NONE), `an edge may not be named "${OPTION_NONE}"`);
  const placeable = layout === null ? [] : placeableIds(layout, records);
  const canPlace = placeable.length >= 2;
  return Object.freeze({
    actions: Object.freeze([
      ACTION_ADD,
      ACTION_ADD_PART,
      ...(canPlace ? [ACTION_PLACE_PART] : []),
      ...(edges.length > 0 ? [ACTION_REMOVE, ACTION_REVERSE] : []),
      ACTION_UNDO_REQUEST,
      ACTION_NONE,
    ]),
    regions: Object.freeze([...regions, OPTION_NONE]),
    edges: Object.freeze(edges.length > 0 ? [...edges.map(edge => edge.id), OPTION_NONE] : []),
    parts: Object.freeze([...PART_PALETTE.map(part => part.key), OPTION_NONE]),
    placeable: Object.freeze(canPlace ? [...placeable, OPTION_NONE] : []),
    directions: Object.freeze(canPlace ? [...DIRECTIONS, OPTION_NONE] : []),
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
  const expected = [
    "action", "source", "target", "part",
    ...(criteria.placeable.length > 0 ? ["move", "anchor", "direction"] : []),
    ...(criteria.edges.length > 0 ? ["edge"] : []),
  ];
  for (const key of expected) refuse(Object.hasOwn(answers, key), `answers.${key} is required`);
  for (const key of Object.keys(answers)) refuse(expected.includes(key), `answers.${key} is not allowed`);

  return Object.freeze({
    action: choiceOf(answers, "action", criteria.actions),
    source: choiceOf(answers, "source", criteria.regions),
    target: choiceOf(answers, "target", criteria.regions),
    part: choiceOf(answers, "part", criteria.parts),
    move: criteria.placeable.length > 0 ? choiceOf(answers, "move", criteria.placeable) : null,
    anchor: criteria.placeable.length > 0 ? choiceOf(answers, "anchor", criteria.placeable) : null,
    direction: criteria.directions.length > 0 ? choiceOf(answers, "direction", criteria.directions) : null,
    edge: criteria.edges.length > 0 ? choiceOf(answers, "edge", criteria.edges) : null,
  });
}

const noChange = (reason, extra = {}) => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason, ...extra });

// Turn a validated answer into the operations it means, or into "no change".
// "No change" is an ordinary answer - nothing to do, a slot answered "none", an
// undo asked for by voice, or not sure enough to act - and is never reported as
// an error. A request that cannot be carried out on this graph (a self edge, a
// duplicate, a vanished target) is a refusal.
function operationsFor(read, working, reserved, layout) {
  const records = working.records;
  if (read.action.choice === ACTION_NONE) return noChange("no graph change was requested");
  // Undo is a button. A spoken or typed "undo" never changes either graph: it
  // is answered with where the button is, and nothing else happens.
  if (read.action.choice === ACTION_UNDO_REQUEST) {
    return noChange("undo is not done by voice or text; use the 元に戻す button", { undoRequest: true });
  }

  const edges = edgesOf(records);
  const existing = relationKeys(records);

  // Put a part beside another one. Jev chooses which part, which neighbour and
  // which side, all from what is on screen; the app asks the view where those
  // parts actually are and computes the position. Jev never sees a coordinate,
  // and the app never invents a size.
  if (read.action.choice === ACTION_PLACE_PART) {
    if (read.move.choice === OPTION_NONE || read.anchor.choice === OPTION_NONE || read.direction.choice === OPTION_NONE) {
      return noChange("the request did not name a part, a neighbour and a side");
    }
    const confidence = Math.min(
      read.action.confidence, read.move.confidence, read.anchor.confidence, read.direction.confidence,
    );
    if (confidence < MIN_CONFIDENCE) return noChange("not confident enough to propose a change");
    refuse(read.move.choice !== read.anchor.choice, "a part cannot be placed beside itself");

    const box = neighbourBounds(layout, read.move.choice, read.anchor.choice, read.direction.choice);
    if (!spotIsFree(layout, records, read.move.choice, box)) {
      return noChange("その場所には別の部品があります");
    }
    const previous = layout.pinned.includes(read.move.choice) ? layout.bounds[read.move.choice] : null;
    if (previous !== null && previous[0] === box[0] && previous[1] === box[1]) {
      return noChange("その部品はすでにそこにあります");
    }
    return Object.freeze({
      action: ACTION_PLACE_PART,
      confidence,
      operations: [{ type: "PinRegions", items: [{ regionId: read.move.choice, bounds: [...box] }] }],
      changes: [{
        change: "placed",
        kind: "region",
        id: read.move.choice,
        anchor: read.anchor.choice,
        direction: read.direction.choice,
      }],
    });
  }

  // A new part: the palette says what it is, and the app says where it goes and
  // what it is called. Jev chooses neither a name nor a place, so an answer can
  // never put two parts in one spot or reuse a name.
  if (read.action.choice === ACTION_ADD_PART) {
    if (read.part.choice === OPTION_NONE) return noChange("the request did not name a part to add");
    const confidence = Math.min(read.action.confidence, read.part.confidence);
    if (confidence < MIN_CONFIDENCE) return noChange("not confident enough to propose a change");
    const palette = PART_PALETTE.find(candidate => candidate.key === read.part.choice);
    refuse(palette !== undefined, "the chosen part is not in the palette");
    const bounds = freeSlot(records);
    if (bounds === null) return noChange("図に部品を置く場所がありません");

    const regionId = nextPartId(working, reserved);
    const label = `${palette.label} ${regionId.slice(PART_ID_PREFIX.length)}`;
    return Object.freeze({
      action: ACTION_ADD_PART,
      confidence,
      operations: [{
        type: "AddRegion",
        regionId,
        parentId: records.find(record => record?.type === "region" && record.parent === null).id,
        label,
        kind: palette.kind,
        summary: "",
        bounds: [...bounds],
      }],
      changes: [{ change: "added", kind: "region", id: regionId, label }],
    });
  }

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
// `reserved` is every part name this page has already handed out, including
// ones since undone. The log alone cannot know them, because undo removes the
// Decision that named them.
export async function planStep({ working, revision, answers, protocol, reserved = [], layout = null } = {}) {
  requireGraph(working);
  refuse(typeof protocol?.createDecision === "function", "protocol.createDecision is required");
  refuse(revision === working.head, "the answer is stale: the working graph changed after the request was sent");

  const read = readAnswers(answers, correctionCriteria(working.records, layout));
  const planned = operationsFor(read, working, reserved, layout);
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

// Every part that currently sits at a pinned position, as [id, bounds].
const layoutPins = records => (records ?? [])
  .filter(record => record?.type === "layout")
  .map(record => [record.regionId, [...record.bounds]]);

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

  // An entry that only moved parts is undone by putting them back: to the
  // bounds they were pinned at before, or by unpinning them if they were not
  // pinned at all. Refused if a later change moved the same part again, so a
  // revert never quietly overwrites a newer position.
  const layoutBefore = new Map(layoutPins(before));
  const layoutAfter = new Map(layoutPins(after));
  const movedIds = [...new Set([...layoutBefore.keys(), ...layoutAfter.keys()])]
    .filter(id => JSON.stringify(layoutBefore.get(id)) !== JSON.stringify(layoutAfter.get(id)));
  if (movedIds.length > 0 && JSON.stringify(regionIds(before)) === JSON.stringify(regionIds(after))) {
    const current = new Map(layoutPins(working.records));
    for (const id of movedIds) {
      refuse(
        JSON.stringify(current.get(id)) === JSON.stringify(layoutAfter.get(id)),
        "a later change already moved this part; nothing was reverted",
      );
    }
    const restore = movedIds.filter(id => layoutBefore.has(id));
    const unpin = movedIds.filter(id => !layoutBefore.has(id));
    const operations = [
      ...(restore.length > 0
        ? [{ type: "PinRegions", items: restore.map(id => ({ regionId: id, bounds: [...layoutBefore.get(id)] })) }]
        : []),
      ...(unpin.length > 0 ? [{ type: "UnpinRegions", regionIds: [...unpin] }] : []),
    ];
    const { decision } = await viaProvider("the provider rejected the revert",
      () => protocol.createDecision(working.head, operations, working.records));
    return step(working.head, ACTION_REVERT,
      movedIds.map(id => ({ change: "placed", kind: "region", id, anchor: OPTION_NONE, direction: OPTION_NONE })), decision);
  }

  // An entry that only added parts is undone by removing them again, but only
  // while each is still a leaf: RemoveSelection would take a part's children
  // and edges with it, which is more than that entry did. Anything else that
  // changed a region - a removal, a rename, several at once - is refused
  // rather than guessed at.
  const addedRegions = regionIds(after).filter(id => !regionIds(before).includes(id));
  const removedRegions = regionIds(before).filter(id => !regionIds(after).includes(id));
  if (addedRegions.length > 0 || removedRegions.length > 0) {
    refuse(removedRegions.length === 0, "only an added part can be reverted");
    const present = new Set(regionIds(working.records));
    for (const id of addedRegions) {
      refuse(present.has(id), "a later change already removed this part; nothing was reverted");
      refuse(
        !working.records.some(record => record?.type === "region" && record.parent === id),
        "this part now holds other parts; nothing was reverted",
      );
      refuse(
        !working.records.some(record => record?.type === "relation" && (record.from === id || record.to === id)),
        "this part now has an edge; nothing was reverted",
      );
    }
    const labelOf = id => after.find(record => record?.type === "region" && record.id === id)?.label ?? id;
    const { decision } = await viaProvider("the provider rejected the revert",
      () => protocol.createDecision(
        working.head,
        [{ type: "RemoveSelection", regionIds: [...addedRegions], relationIds: [] }],
        working.records,
      ));
    return step(working.head, ACTION_REVERT,
      addedRegions.map(id => ({ change: "removed", kind: "region", id, label: labelOf(id) })), decision);
  }

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
// One change as Jev is told it: an edge by its two ends, a part by its id and
// the label it is shown by. Everything else a step carries stays in the page.
export function changesForJev(changes) {
  return Object.freeze((changes ?? []).map(change => Object.freeze(
    change.kind === "region" && change.change === "placed"
      ? { change: "placed", kind: "region", id: change.id, anchor: change.anchor, direction: change.direction }
      : change.kind === "region"
        ? { change: change.change, kind: "region", id: change.id, label: change.label }
        : { change: change.change, from: change.from, to: change.to },
  )));
}

export function focusFor({ draft = [], lastApplied = [] } = {}) {
  const pick = (kind, changes) => Object.freeze({ kind, changes: changesForJev(changes) });
  if (draft.length > 0) return pick("draft", draft.at(-1).changes);
  if (lastApplied.length > 0) return pick("applied", lastApplied);
  return pick("none", []);
}
