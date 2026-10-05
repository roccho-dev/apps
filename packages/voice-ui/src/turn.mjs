import {
  ACTION_ADD_EDGE,
  ACTION_ADD_PART,
  ACTION_COMPOSE,
  ACTION_PLACE_PART,
  ACTION_REMOVE_EDGE,
  ACTION_REVERSE_EDGE,
  ACTION_UNDO_REQUEST,
  DIRECTIONS,
  LABEL_MAX,
  MIN_CONFIDENCE,
  NONE,
  PLACEMENT_SLOTS,
  REQUEST_KIND,
  readAnswers,
  slotsFor,
} from "./contract.mjs";
import { offersOf } from "./bundle.mjs";
import { MAP_ID, STATE_SCHEMA } from "./log.mjs";

// One turn: what the judgment binding is asked about the working graph, and what its answer
// means there. Every Decision the app makes is built here - a graph edit, a
// placement, a whole diagram, a revert, a new map - always by the provider,
// so it is validated before it ever reaches the working log. Nothing here
// stores, renders or holds state between turns; outcomes are plain tagged
// records, and only a broken caller contract throws.

const ACTION_REVERT = "revert";
export const ACTION_NEW = "new-map";

export const OUTCOME_STEP = "step";
export const OUTCOME_NO_CHANGE = "no-change";
export const OUTCOME_REFUSED = "refused";

// Code contracts shared with the graph view and with every log already saved.
const ROOT_ID = "root";
const ROOT_KIND = "boundary";
const ROOT_BOUNDS = Object.freeze([0, 0, 720, 260]);
const RELATION_KIND = "flow";
// A lane is a region that holds steps, drawn as a boundary around them. It is
// a "group": the view opens a group's contents at 16 000 px² on screen, where
// any other container needs 160 000 px². Never "actor", which the view leaves
// out of its layout.
const LANE_KIND = "group";
const PART_ID_PREFIX = "part-";

// A new part is the size of an initial node, on a fixed grid inside the
// enclosing boundary. The graph view ignores these bounds, but the provider
// requires them, so they are real, inside the parent and never overlapping.
const PART_WIDTH = 140;
const PART_HEIGHT = 64;
const PART_GAP = 20;
// The gap between a part and the one it is placed beside. Sizes come from the
// view; only this spacing is ours.
const NEIGHBOUR_GAP = 24;
// How a composed diagram is drawn: lanes as bands one above the other, each
// step inside its lane's band, steps in flow order from left to right.
const LANE_HEADER = 120;
const BAND_LABEL_ROOM = 36;
const BAND_PADDING = 12;
const BAND_GAP = 16;
const STEP_GAP = 24;

const demand = (condition, reason) => {
  if (!condition) throw new TypeError(`voice-ui turn: ${reason}`);
};

const noChange = (reason, extra = {}) => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason, ...extra });
const refused = (reason, detail = null) =>
  Object.freeze({ outcome: OUTCOME_REFUSED, reason, ...(detail === null ? {} : { detail }) });
const message = error => String(error?.message ?? error);

const requireGraph = graph => {
  demand(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  demand(typeof graph?.head === "string" && graph.head.length > 0, "graph.head must be a non-empty string");
  demand(Array.isArray(graph?.records), "graph.records is required");
};

const relationIdFor = (source, target) => `voice-${source}-to-${target}`;
const relationKey = (from, to) => JSON.stringify([from, to]);
const relationKeys = records => new Set(records
  .filter(record => record?.type === "relation")
  .map(record => relationKey(record.from, record.to)));

const rootOf = records => records.find(record => record?.type === "region" && record.parent === null);

// Every region under the enclosing boundary.
const selectableRegionIds = records =>
  records.filter(record => record?.type === "region" && record.parent !== null).map(record => record.id);

function edgesOf(records) {
  return Object.freeze(records
    .filter(record => record?.type === "relation")
    .map(record => Object.freeze({ id: record.id, from: record.from, to: record.to })));
}

// The parts the judgment binding may name: every region under the boundary except a lane. A
// lane is a container - its steps are what the flow connects - so it is never
// an endpoint and never put beside anything. It is still drawn.
function speakableRegions(records) {
  const lanes = new Set(records
    .filter(record => record?.type === "region" && record.kind === LANE_KIND)
    .map(record => record.id));
  return Object.freeze(records
    .filter(record => record?.type === "region" && record.parent !== null && !lanes.has(record.id))
    .map(record => Object.freeze({ id: record.id, label: record.label })));
}

const speakableIds = records => speakableRegions(records).map(region => region.id);

// The edges the judgment binding may name: those between two parts it may name.
function speakableEdges(records) {
  const ids = speakableIds(records);
  return Object.freeze(edgesOf(records).filter(edge => ids.includes(edge.from) && ids.includes(edge.to)));
}

const overlapping = (left, right) =>
  left[0] < right[0] + right[2] && right[0] < left[0] + left[2]
  && left[1] < right[1] + right[3] && right[1] < left[1] + left[3];

const inside = (frame, box) =>
  box[0] >= frame[0] && box[1] >= frame[1]
  && box[0] + box[2] <= frame[0] + frame[2] && box[1] + box[3] <= frame[1] + frame[3];

// The parts out of `ids` the view actually places, and with a frame - the
// pane's visible frame in the same coordinates - only those wholly inside it.
const placedIds = (layout, ids, frame) => Object.freeze(ids
  .filter(regionId => Object.hasOwn(layout.bounds, regionId))
  .filter(regionId => frame === null || inside(frame, layout.bounds[regionId]))
  .sort());

// The parts a person can put beside one another: the ones the judgment binding may name that
// the view places, and with a frame only those wholly inside it.
export function placeableIds(layout, records, frame = null) {
  return placedIds(layout, speakableIds(records), frame);
}

// The bounds a part would take beside its anchor: the anchor's own position
// and the moving part's own size, both read from the view, one gap apart.
function neighbourBounds(layout, targetId, anchorId, direction) {
  const [ax, ay, aw, ah] = layout.bounds[anchorId];
  const [, , tw, th] = layout.bounds[targetId];
  if (direction === "left") return Object.freeze([ax - tw - NEIGHBOUR_GAP, ay, tw, th]);
  if (direction === "right") return Object.freeze([ax + aw + NEIGHBOUR_GAP, ay, tw, th]);
  if (direction === "above") return Object.freeze([ax, ay - th - NEIGHBOUR_GAP, tw, th]);
  return Object.freeze([ax, ay + ah + NEIGHBOUR_GAP, tw, th]);
}

// A spot is usable only if nothing else the view placed sits there - a lane
// included, and a part off screen too. The part being moved does not block
// its own move.
const spotIsFree = (layout, records, targetId, box) =>
  placedIds(layout, selectableRegionIds(records), null)
    .filter(regionId => regionId !== targetId)
    .every(regionId => !overlapping(box, layout.bounds[regionId]));

// The first free place on the grid inside the enclosing boundary, in reading
// order. A full boundary is an honest "no room", not a part dropped on top.
function freeSlot(records, parent = null) {
  const [fx, fy, fw, fh] = (parent ?? rootOf(records)).bounds;
  const taken = records.filter(record => record?.type === "region"
    && (parent === null ? record.parent !== null : record.parent === parent.id)).map(record => record.bounds);
  for (let y = fy + PART_GAP; y + PART_HEIGHT <= fy + fh; y += PART_HEIGHT + PART_GAP) {
    for (let x = fx + PART_GAP; x + PART_WIDTH <= fx + fw; x += PART_WIDTH + PART_GAP) {
      const slot = [x, y, PART_WIDTH, PART_HEIGHT];
      if (!taken.some(used => overlapping(slot, used))) return Object.freeze(slot);
    }
  }
  return null;
}

// The next part name, counted over the whole log and every name the page has
// already handed out. Undo cuts a part's Decision out of the log, but the
// conversation still refers to it, so no name ever comes to mean a second part.
function nextPartId(graph, reserved = []) {
  const named = [
    ...reserved,
    ...graph.records.filter(record => record?.type === "region").map(record => record.id),
    ...graph.decisions.flatMap(decision => decision.operations.flatMap(operation =>
      operation.type === "AddRegion" ? [operation.regionId]
        : operation.type === "CreateMap" ? operation.records.filter(record => record?.type === "region").map(record => record.id)
          : [])),
  ];
  const used = named
    .filter(name => name.startsWith(PART_ID_PREFIX))
    .map(name => Number(name.slice(PART_ID_PREFIX.length)))
    .filter(Number.isSafeInteger);
  return `${PART_ID_PREFIX}${Math.max(0, ...used) + 1}`;
}

// One change as the judgment binding is told it: an edge by its two ends, a part by its id and
// label, a placement by part, neighbour and side.
export function changesForJudgment(changes) {
  return Object.freeze(changes.map(change => Object.freeze(
    change.kind === "region" && change.change === "placed"
      ? { change: "placed", kind: "region", id: change.id, anchor: change.anchor, direction: change.direction }
      : change.kind === "region"
        ? { change: change.change, kind: "region", id: change.id, label: change.label }
        : { change: change.change, from: change.from, to: change.to },
  )));
}

// What the person is looking at, for a follow-up like "reverse that": the
// latest working step, else the latest applied change, else nothing.
export function focusFor({ draft, lastApplied }) {
  if (draft.length > 0) return Object.freeze({ kind: "draft", changes: changesForJudgment(draft.at(-1).changes) });
  if (lastApplied.length > 0) return Object.freeze({ kind: "applied", changes: changesForJudgment(lastApplied) });
  return null;
}

// The pending placement as the next request carries it: part ids and a side.
export function pendingForJudgment(pending) {
  return Object.freeze({
    missing: pending.missing,
    move: pending.move?.choice ?? null,
    anchor: pending.anchor?.choice ?? null,
    direction: pending.direction?.choice ?? null,
  });
}

const sameFrame = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === 4 && right.length === 4 && left.every((value, index) => value === right[index]);
const sameIds = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

// Whether a held placement still describes what is in front of the person:
// the same head, the same frame to the unit, and the same parts on offer.
export function pendingHolds(pending, { head, frame, offered }) {
  return pending.head === head && sameFrame(pending.frame, frame) && sameIds(pending.offered, offered);
}

// T and its projection. T binds the working head, the bundle version with
// only the sections this turn offers (or none), the frame the placeable parts
// were read from, and the offered question slots. The request is exactly the
// declared read set: no log, head, hash, bounds or template ever leaves.
export function requestFor({ working, utterance, bundle, layout, offeredFrame, draft, focus, pending, recent }) {
  requireGraph(working);
  const placeable = layout === null ? [] : [...placeableIds(layout, working.records, offeredFrame)];
  const offers = offersOf(bundle);
  const state = Object.freeze({
    utterance,
    graph: Object.freeze({ regions: speakableRegions(working.records), edges: speakableEdges(working.records), placeable }),
    draft: Object.freeze(draft.map(step => Object.freeze({ changes: changesForJudgment(step.changes) }))),
    focus,
    pending,
    context: Object.freeze({ recent }),
    offers,
  });
  const sections = ["parts", "diagrams"].filter(name => offers[name].length > 0);
  const turn = Object.freeze({
    head: working.head,
    bundle: sections.length === 0 ? null : Object.freeze({ version: bundle.version, sections: Object.freeze(sections) }),
    frame: offeredFrame,
    slots: slotsFor(state),
  });
  return Object.freeze({ turn, request: Object.freeze({ kind: REQUEST_KIND, state }) });
}

// The one slot that fell short, or null when the shortfall is not exactly one
// placement slot with a confident placement action and no "none" anywhere. A
// part named as its own neighbour is never narrowed to one word either.
function weakPlacementSlot(read) {
  if (read?.action?.choice !== ACTION_PLACE_PART || !(read.action.confidence >= MIN_CONFIDENCE)) return null;
  if (PLACEMENT_SLOTS.some(slot => read[slot] === undefined || read[slot].choice === NONE)) return null;
  if (read.move.choice === read.anchor.choice) return null;
  const weak = PLACEMENT_SLOTS.filter(slot => !(read[slot].confidence >= MIN_CONFIDENCE));
  return weak.length === 1 ? weak[0] : null;
}

const plan = (action, confidence, operations, changes, extra = {}) =>
  Object.freeze({ outcome: "plan", action, confidence, operations, changes, ...extra });

// A whole bundle diagram as one set of canonical operations: each lane a
// region under the boundary, each step a region inside its lane, each link a
// relation, and one PinRegions that draws the lanes as bands and the steps in
// flow order - all in one Decision, so it is proposed, undone and applied
// whole. Where the pins go is asked of the provider's own layout, and the
// pinned result is laid out again and checked: every pin drawn where it was
// put, and no overlap this Decision brings about.
function composeDiagram(diagram, confidence, { working, reserved, protocol }) {
  const records = working.records;
  const root = rootOf(records);
  const view = { pattern: protocol.GRAPH_PATTERN };
  const first = Number(nextPartId(working, reserved).slice(PART_ID_PREFIX.length));
  const refs = [...diagram.lanes.map(lane => lane.ref), ...diagram.steps.map(step => step.ref)];
  const idOf = new Map(refs.map((ref, index) => [ref, `${PART_ID_PREFIX}${first + index}`]));

  const regionBoxes = records.filter(record => record?.type === "region").map(record => record.bounds);
  const top = Math.max(...regionBoxes.map(box => box[1] + box[3])) + PART_GAP;
  const left = root.bounds[0];
  const laneHeight = PART_HEIGHT + 2 * PART_GAP;
  const laneWidth = LANE_HEADER + diagram.steps.length * (PART_WIDTH + PART_GAP) + PART_GAP;

  const operations = [];
  const changes = [];
  diagram.lanes.forEach((lane, index) => {
    const regionId = idOf.get(lane.ref);
    operations.push({
      type: "AddRegion",
      regionId,
      parentId: root.id,
      label: lane.label,
      kind: LANE_KIND,
      summary: "",
      bounds: [left, top + index * (laneHeight + PART_GAP), laneWidth, laneHeight],
      order: index,
    });
    changes.push({ change: "added", kind: "region", id: regionId, label: lane.label });
  });
  diagram.steps.forEach((step, column) => {
    const laneIndex = diagram.lanes.findIndex(lane => lane.ref === step.lane);
    const regionId = idOf.get(step.ref);
    operations.push({
      type: "AddRegion",
      regionId,
      parentId: idOf.get(step.lane),
      label: step.label,
      kind: step.kind,
      summary: "",
      bounds: [
        left + LANE_HEADER + PART_GAP + column * (PART_WIDTH + PART_GAP),
        top + laneIndex * (laneHeight + PART_GAP) + PART_GAP,
        PART_WIDTH,
        PART_HEIGHT,
      ],
      order: column,
    });
    changes.push({ change: "added", kind: "region", id: regionId, label: step.label });
  });
  for (const [from, to] of diagram.links) {
    operations.push({
      type: "ConnectRegions",
      relationId: relationIdFor(idOf.get(from), idOf.get(to)),
      from: idOf.get(from),
      to: idOf.get(to),
      kind: RELATION_KIND,
      label: "",
    });
    changes.push({ change: "added", from: idOf.get(from), to: idOf.get(to) });
  }

  // The records these operations add, laid out as the view would lay them out.
  const added = operations.map(operation => (operation.type === "AddRegion"
    ? {
      type: "region",
      id: operation.regionId,
      parent: operation.parentId,
      label: operation.label,
      kind: operation.kind,
      bounds: operation.bounds,
      summary: operation.summary,
      order: operation.order,
    }
    : {
      type: "relation",
      id: operation.relationId,
      from: operation.from,
      to: operation.to,
      kind: operation.kind,
      label: operation.label,
    }));
  // A state lists its regions before its relations, and layout pins last.
  const stateWith = extra => [
    ...[...records, ...extra].filter(record => record?.type !== "relation" && record?.type !== "layout"),
    ...[...records, ...extra].filter(record => record?.type === "relation"),
    ...[...records, ...extra].filter(record => record?.type === "layout"),
  ];
  const auto = protocol.layoutBoundsFor(stateWith(added), view);
  const laneIds = diagram.lanes.map(lane => idOf.get(lane.ref));
  const stepIds = diagram.steps.map(step => idOf.get(step.ref));
  if (![...laneIds, ...stepIds].every(regionId => auto.bounds[regionId] !== undefined)) return refused("diagram-unplaceable");
  const stepWidth = Math.max(...stepIds.map(regionId => auto.bounds[regionId][2]));
  const stepHeight = Math.max(...stepIds.map(regionId => auto.bounds[regionId][3]));
  const [x0, y0] = auto.bounds[laneIds[0]];
  const bandWidth = 2 * BAND_PADDING + stepIds.length * stepWidth + (stepIds.length - 1) * STEP_GAP;
  const bandHeight = BAND_LABEL_ROOM + stepHeight + BAND_PADDING;
  const bandY = index => y0 + index * (bandHeight + BAND_GAP);
  const pins = new Map(laneIds.map((regionId, index) => [regionId, [x0, bandY(index), bandWidth, bandHeight]]));
  diagram.steps.forEach((step, column) => {
    const laneIndex = diagram.lanes.findIndex(lane => lane.ref === step.lane);
    pins.set(idOf.get(step.ref), [
      x0 + BAND_PADDING + column * (stepWidth + STEP_GAP),
      bandY(laneIndex) + BAND_LABEL_ROOM,
      stepWidth,
      stepHeight,
    ]);
  });
  operations.push({ type: "PinRegions", items: [...pins].map(([regionId, bounds]) => ({ regionId, bounds: [...bounds] })) });

  const pinned = protocol.layoutBoundsFor(stateWith([
    ...added,
    ...[...pins].map(([regionId, bounds]) => ({ type: "layout", regionId, pin: "hard", bounds: [...bounds] })),
  ]), view);
  for (const [regionId, bounds] of pins) {
    if (JSON.stringify(pinned.bounds[regionId]) !== JSON.stringify(bounds)) return refused("diagram-unplaceable");
  }
  // The overlaps this composition would bring about: between regions not
  // nested in each other, drawn after it but not before. An overlap already
  // there is not this Decision's doing.
  const parentOf = new Map([...records, ...added].filter(record => record?.type === "region").map(record => [record.id, record.parent]));
  const within = (inner, outer) => {
    for (let at = parentOf.get(inner); at != null; at = parentOf.get(at)) if (at === outer) return true;
    return false;
  };
  const overlapsIn = layout => {
    const placed = Object.keys(layout.bounds).filter(regionId => parentOf.get(regionId) != null).sort();
    return new Set(placed.flatMap((leftId, index) => placed.slice(index + 1)
      .filter(rightId => !within(leftId, rightId) && !within(rightId, leftId)
        && overlapping(layout.bounds[leftId], layout.bounds[rightId]))
      .map(rightId => `${leftId} ${rightId}`)));
  };
  const before = overlapsIn(protocol.layoutBoundsFor(stateWith([]), view));
  if ([...overlapsIn(pinned)].some(pair => !before.has(pair))) return noChange("diagram-no-room");
  return plan(ACTION_COMPOSE, confidence, operations, changes, { template: diagram.key });
}

// What a validated answer means on this working graph: a plan of operations,
// an ordinary no-change, or a refusal when it cannot be carried out here.
function operationsFor(read, context) {
  const { working, reserved, layout, visibleFrame, bundle } = context;
  const records = working.records;
  const action = read.action.choice;
  if (action === NONE) return noChange("none-requested");
  // Undo is a button. A spoken or typed "undo" never changes either graph.
  if (action === ACTION_UNDO_REQUEST) return noChange("undo-by-button", { undoRequest: true });

  // A whole diagram by purpose. "none" means one this app does not have.
  if (action === ACTION_COMPOSE) {
    if (read.diagram.choice === NONE) return noChange("diagram-not-offered");
    const confidence = Math.min(read.action.confidence, read.diagram.confidence);
    if (confidence < MIN_CONFIDENCE) return noChange("diagram-restate");
    return composeDiagram(bundle.diagrams.find(entry => entry.key === read.diagram.choice), confidence, context);
  }

  // Put a part beside another one. the judgment binding chooses the part, its neighbour and the
  // side from the parts wholly on the pane; the view says where they are.
  if (action === ACTION_PLACE_PART) {
    if (read.move.choice === NONE || read.anchor.choice === NONE || read.direction.choice === NONE) {
      return noChange("placement-restate");
    }
    const confidence = Math.min(read.action.confidence, read.move.confidence, read.anchor.confidence, read.direction.confidence);
    if (confidence < MIN_CONFIDENCE) {
      const weak = weakPlacementSlot(read);
      return noChange(weak === null ? "placement-restate" : `placement-missing-${weak}`);
    }
    if (read.move.choice === read.anchor.choice) return refused("beside-itself");

    const box = neighbourBounds(layout, read.move.choice, read.anchor.choice, read.direction.choice);
    // Whether the person can see the spot, asked of the pane itself; the three
    // ways of not having a frame are told apart.
    if (visibleFrame === null) return noChange("frame-unreadable");
    if (visibleFrame.head !== working.head) return noChange("frame-behind");
    if (!inside(visibleFrame.frame, box)) return noChange("spot-off-pane");
    if (!inside(visibleFrame.frame, layout.bounds[read.anchor.choice])) return noChange("anchor-off-pane");
    if (!inside(visibleFrame.frame, layout.bounds[read.move.choice])) return noChange("mover-off-pane");
    if (!spotIsFree(layout, records, read.move.choice, box)) return noChange("spot-taken");
    const previous = layout.pinned.includes(read.move.choice) ? layout.bounds[read.move.choice] : null;
    if (previous !== null && previous.every((value, index) => value === box[index])) return noChange("already-there");
    return plan(ACTION_PLACE_PART, confidence,
      [{ type: "PinRegions", items: [{ regionId: read.move.choice, bounds: [...box] }] }],
      [{ change: "placed", kind: "region", id: read.move.choice, anchor: read.anchor.choice, direction: read.direction.choice }]);
  }

  // A new part: the bundle says what it is, the app says where it goes and
  // what it is called. the judgment binding chooses neither a name nor a place.
  if (action === ACTION_ADD_PART) {
    if (read.part.choice === NONE) return noChange("no-part-named");
    const confidence = Math.min(read.action.confidence, read.part.confidence);
    if (confidence < MIN_CONFIDENCE) return noChange("not-confident");
    const part = bundle.parts.find(entry => entry.key === read.part.choice);
    const bounds = freeSlot(records);
    if (bounds === null) return noChange("no-room-for-part");
    const regionId = nextPartId(working, reserved);
    const label = `${part.label} ${regionId.slice(PART_ID_PREFIX.length)}`;
    return plan(ACTION_ADD_PART, confidence, [{
      type: "AddRegion",
      regionId,
      parentId: rootOf(records).id,
      label,
      kind: part.kind,
      summary: "",
      bounds: [...bounds],
    }], [{ change: "added", kind: "region", id: regionId, label }]);
  }

  const existing = relationKeys(records);
  if (action === ACTION_ADD_EDGE) {
    if (read.source.choice === NONE || read.target.choice === NONE) return noChange("no-two-nodes");
    const confidence = Math.min(read.action.confidence, read.source.confidence, read.target.confidence);
    if (confidence < MIN_CONFIDENCE) return noChange("not-confident");
    if (read.source.choice === read.target.choice) return refused("same-region");
    if (existing.has(relationKey(read.source.choice, read.target.choice))) return refused("edge-exists");
    return plan(ACTION_ADD_EDGE, confidence, [{
      type: "ConnectRegions",
      relationId: relationIdFor(read.source.choice, read.target.choice),
      from: read.source.choice,
      to: read.target.choice,
      kind: RELATION_KIND,
      label: "",
    }], [{ change: "added", from: read.source.choice, to: read.target.choice }]);
  }

  // Remove or reverse one edge.
  if (read.edge.choice === NONE) return noChange("no-edge-named");
  const confidence = Math.min(read.action.confidence, read.edge.confidence);
  if (confidence < MIN_CONFIDENCE) return noChange("not-confident");
  const relation = records.find(record => record?.type === "relation" && record.id === read.edge.choice);
  if (relation === undefined) return refused("edge-gone");
  const remove = { type: "RemoveSelection", regionIds: [], relationIds: [relation.id] };
  if (action === ACTION_REMOVE_EDGE) {
    return plan(ACTION_REMOVE_EDGE, confidence, [remove], [{ change: "removed", from: relation.from, to: relation.to }]);
  }
  // Reverse is one Decision holding a removal and an addition, so it applies
  // whole or not at all. ReconnectRelation would keep the old id, which encodes
  // the old direction, and a later add of that direction would then collide.
  if (existing.has(relationKey(relation.to, relation.from))) return refused("reversed-exists");
  return plan(ACTION_REVERSE_EDGE, confidence, [remove, {
    type: "ConnectRegions",
    relationId: relationIdFor(relation.to, relation.from),
    from: relation.to,
    to: relation.from,
    kind: relation.kind,
    label: relation.label,
  }], [
    { change: "removed", from: relation.from, to: relation.to },
    { change: "added", from: relation.to, to: relation.from },
  ]);
}

// Everything that decides, with no await: the frame the caller read is judged
// against in the same synchronous run. An answer to a working graph that has
// since moved describes a picture the person no longer sees, so it is refused.
function judge(answers, context) {
  if (context.turn.head !== context.working.head) return { read: null, planned: refused("stale") };
  const read = readAnswers(answers, context.turn.slots);
  if (read === null) return { read: null, planned: refused("answer-invalid") };
  return { read, planned: operationsFor(read, context) };
}

const step = (revision, action, changes, decision, confidence = null, extra = {}) => Object.freeze({
  revision,
  action,
  confidence,
  changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))),
  decision,
  ...extra,
});

// The provider builds every Decision on the working head, so it is validated
// before it ever reaches the working log. A Decision it will not build is a
// refusal that says what the provider said.
async function materialize(working, planned, protocol) {
  let built;
  try {
    built = await protocol.createDecision(working.head, planned.operations, working.records);
  } catch (error) {
    return refused("provider-rejected", message(error));
  }
  const extra = planned.template === undefined ? {} : { template: planned.template };
  return Object.freeze({
    outcome: OUTCOME_STEP,
    step: step(working.head, planned.action, planned.changes, built.decision, planned.confidence, extra),
  });
}

// Keep raw kernel legality and painted placement separate. Preview is pure:
// the provider owns candidate dimensions; only our existing spacing is used.
function additionSlot(working, parent, part, reserved, protocol) {
  const raw = freeSlot(working.records, parent);
  if (raw === null) return null;
  const regionId = nextPartId(working, reserved);
  const operation = { type: "AddRegion", regionId, parentId: parent.id,
    label: `${part.label} ${regionId.slice(PART_ID_PREFIX.length)}`, kind: part.kind, summary: "", bounds: [...raw] };
  const region = { type: "region", id: regionId, parent: parent.id, label: operation.label,
    kind: part.kind, summary: "", bounds: [...raw] };
  const records = [...working.records.filter(record => record.type !== "layout" && record.type !== "relation"), region,
    ...working.records.filter(record => record.type === "relation" || record.type === "layout")];
  const view = { pattern: protocol.GRAPH_PATTERN };
  const validBox = box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
  try {
    const current = protocol.layoutBoundsFor(working.records, view);
    const preview = protocol.layoutBoundsFor(records, view);
    const frame = current.bounds[parent.id], size = preview.bounds[regionId];
    if (!validBox(frame) || !validBox(size)) return null;
    const siblings = working.records.filter(record => record.type === "region" && record.parent === parent.id);
    if (siblings.some(record => !validBox(current.bounds[record.id]))) return null;
    for (let y = frame[1] + BAND_LABEL_ROOM; y + size[3] <= frame[1] + frame[3] - BAND_PADDING; y += size[3] + STEP_GAP) {
      for (let x = frame[0] + BAND_PADDING; x + size[2] <= frame[0] + frame[2] - BAND_PADDING; x += size[2] + STEP_GAP) {
        const bounds = [x, y, size[2], size[3]];
        if (siblings.some(record => overlapping(bounds, current.bounds[record.id]))) continue;
        const pinned = protocol.layoutBoundsFor([...records, { type: "layout", regionId, pin: "hard", bounds }], view);
        if (![parent.id, regionId, ...siblings.map(record => record.id)].every(id => validBox(pinned.bounds[id]))
          || !inside(pinned.bounds[parent.id], pinned.bounds[regionId])
          || siblings.some(record => overlapping(pinned.bounds[regionId], pinned.bounds[record.id]))) return null;
        return { operation, bounds };
      }
    }
  } catch { return null; }
  return null;
}

// A request-local catalogue, not an ID registry. Each pair owns its exact
// AddRegion and new-child pin; the read set includes every placement input.
const additionReadSet = (working, bundle, reserved, selected) => JSON.stringify({
  head: working.head, records: working.records, parts: bundle.parts, reserved, selected,
});
function legalAdditions(working, { bundle, protocol, reserved = [], selected = [] }) {
  requireGraph(working);
  const candidates = [];
  const parents = working.records.filter(record => record.type === "region"
    && record.kind === LANE_KIND && record.parent !== null).sort((a, b) => a.id.localeCompare(b.id));
  const parts = bundle.parts.filter(part => !selected.some(item => item.key === part.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const parent of parents) for (const part of parts) {
    const slot = additionSlot(working, parent, part, reserved, protocol);
    if (slot === null) continue;
    candidates.push(Object.freeze({ id: `delta-${candidates.length + 1}`, part: part.key, parent: parent.id,
      operations: Object.freeze([Object.freeze({ ...slot.operation, bounds: Object.freeze([...slot.operation.bounds]) }),
        Object.freeze({ type: "PinRegions", items: Object.freeze([Object.freeze({
          regionId: slot.operation.regionId, bounds: Object.freeze([...slot.bounds]),
        })]) })]) }));
  }
  return Object.freeze({ readSet: additionReadSet(working, bundle, reserved, selected),
    candidates: Object.freeze(candidates) });
}

async function proveAddition({ working, held, candidateId, confidence, bundle, reserved = [], selected = [], protocol }) {
  requireGraph(working);
  if (held.readSet !== additionReadSet(working, bundle, reserved, selected)) return refused("stale-addition");
  const candidate = held.candidates.find(item => item.id === candidateId);
  if (candidate === undefined) return refused("invalid-addition");
  if (!(confidence >= MIN_CONFIDENCE && confidence <= 1)) return noChange("not-confident");
  const latest = legalAdditions(working, { bundle, protocol, reserved, selected });
  if (JSON.stringify(latest.candidates) !== JSON.stringify(held.candidates)) return refused("stale-addition");
  const operation = candidate.operations[0];
  // Adopt the original held operations, never a silently replanned replacement.
  return materialize(working, plan(ACTION_ADD_PART, confidence, candidate.operations,
    [{ change: "added", kind: "region", id: operation.regionId, label: operation.label }]), protocol);
}

// One bounded union of existing additions and directed flow connections.
// Vocabulary stays in the graph/bundle; IDs belong only to this held request.
// A scope, when given, is a set of region IDs: only arrows touching one of
// them are offered, in either direction and to any other legal end.
export function legalLocalDeltas(working, options) {
  const scope = options.scope ?? null;
  const additions = legalAdditions(working, options);
  const candidates = [...additions.candidates];
  const ids = speakableIds(working.records).sort();
  const existing = relationKeys(working.records);
  for (const from of ids) for (const to of ids) {
    if (from === to || existing.has(relationKey(from, to))) continue;
    if (scope !== null && !scope.has(from) && !scope.has(to)) continue;
    candidates.push(Object.freeze({ id: `delta-${candidates.length + 1}`, from, to,
      operations: Object.freeze([Object.freeze({ type: "ConnectRegions", relationId: relationIdFor(from, to),
        from, to, kind: RELATION_KIND, label: "" })]) }));
  }
  return Object.freeze({ readSet: additions.readSet, candidates: Object.freeze(candidates) });
}

export async function proveLocalDelta({ working, held, candidateId, confidence, bundle, reserved = [], selected = [], scope = null, protocol }) {
  requireGraph(working);
  if (held.readSet !== additionReadSet(working, bundle, reserved, selected)) return refused("stale-addition");
  const candidate = held.candidates.find(item => item.id === candidateId);
  if (!candidate) return refused("invalid-addition");
  if (!(confidence >= MIN_CONFIDENCE && confidence <= 1)) return noChange("not-confident");
  const latest = legalLocalDeltas(working, { bundle, protocol, reserved, selected, scope });
  if (JSON.stringify(latest.candidates) !== JSON.stringify(held.candidates)) return refused("stale-addition");
  if (candidate.part !== undefined) return proveAddition({ working, held: { ...held,
    candidates: held.candidates.filter(item => item.part !== undefined) }, candidateId, confidence, bundle, reserved, selected, protocol });
  return materialize(working, plan(ACTION_ADD_EDGE, confidence, candidate.operations,
    [{ change: "added", from: candidate.from, to: candidate.to }]), protocol);
}

// The exact picture a held placement was said against, or null when the pane
// could not be read, showed another head, or moved between asking and judging.
function heldContext(working, layout, visibleFrame, offeredFrame) {
  if (layout === null || offeredFrame === null || visibleFrame === null) return null;
  if (visibleFrame.head !== working.head || !sameFrame(visibleFrame.frame, offeredFrame)) return null;
  return Object.freeze({
    head: working.head,
    frame: Object.freeze([...offeredFrame]),
    offered: placeableIds(layout, working.records, offeredFrame),
  });
}

// What an utterance left behind when all but one piece of a placement came
// through: the picture it was said against, how sure the judgment binding was that it is a
// placement, and the pieces that were understood - never any text.
function pendingFrom(read, missing, context) {
  const kept = slot => (slot === missing ? null : Object.freeze({ ...read[slot] }));
  return Object.freeze({
    missing,
    head: context.head,
    frame: context.frame,
    offered: context.offered,
    action: Object.freeze({ ...read.action }),
    move: kept("move"),
    anchor: kept("anchor"),
    direction: kept("direction"),
  });
}

const requireTurn = options => {
  requireGraph(options.working);
  demand(options.turn?.slots !== undefined, "turn is required");
  demand(typeof options.protocol?.createDecision === "function", "protocol.createDecision is required");
};

// Judge an answer against the working graph and the turn it was asked in. A
// usable answer becomes a step; a no-change that left exactly one placement
// piece unsure also carries `pending`, for the page to hold one utterance.
// `visibleFrame` is what the pane shows now, read by the caller in the same
// synchronous turn: everything that decides runs before the first await.
export async function planStep({ working, turn, answers, protocol, bundle, reserved = [], layout = null, visibleFrame = null }) {
  requireTurn({ working, turn, protocol });
  const context = { working, turn, reserved, layout, visibleFrame, bundle, protocol };
  const { read, planned } = judge(answers, context);
  if (planned.outcome === OUTCOME_NO_CHANGE) {
    const weak = weakPlacementSlot(read);
    const held = weak === null ? null : heldContext(working, layout, visibleFrame, turn.frame);
    return held === null ? planned : Object.freeze({ ...planned, pending: pendingFrom(read, weak, held) });
  }
  if (planned.outcome === OUTCOME_REFUSED) return planned;
  return materialize(working, planned, protocol);
}

// The one utterance after a near-placement. It is judged on its own first, so
// a complete instruction always wins. Only an utterance heard as a placement,
// or as no change at all, can be the missing piece; anything else is answered
// exactly as it would have been. The repaired placement goes through the same
// checks, and a repair turn never holds another piece - so it never offers the
// one-word follow-up either.
export async function repairStep(options) {
  const result = await attemptRepair(options);
  const promisesFollowUp = result.outcome === OUTCOME_NO_CHANGE && result.reason.startsWith("placement-missing-");
  return promisesFollowUp ? noChange("placement-restate") : result;
}

async function attemptRepair({ working, turn, answers, protocol, bundle, pending, reserved = [], layout = null, visibleFrame = null }) {
  requireTurn({ working, turn, protocol });
  demand(pending !== null && pending !== undefined, "there is no pending placement to repair");
  const context = { working, turn, reserved, layout, visibleFrame, bundle, protocol };
  const own = judge(answers, context);
  if (own.planned.outcome === "plan") return materialize(working, own.planned, protocol);

  const heardAs = answers?.action?.choice;
  if (heardAs !== ACTION_PLACE_PART && heardAs !== NONE) return own.planned;
  // Of the refusals, only a part beside itself leaves something to repair
  // with: a reply like "ノードAです" can be heard as that part beside itself,
  // yet still name the one missing piece.
  if (own.planned.outcome === OUTCOME_REFUSED && own.planned.reason !== "beside-itself") return own.planned;

  // The held piece belongs to one exact picture.
  const offeredNow = layout === null ? [] : placeableIds(layout, working.records, turn.frame);
  if (!pendingHolds(pending, { head: working.head, frame: turn.frame, offered: offeredNow })
    || visibleFrame === null || visibleFrame.head !== working.head || !sameFrame(visibleFrame.frame, pending.frame)
    || turn.slots.move === undefined) {
    return noChange("repair-context-changed");
  }
  const { read } = own;
  const supplied = read[pending.missing];

  // A reply is a repair only if it says nothing else. Every other placement
  // piece must be "none", the same as what is held, or - for a part - an echo
  // of the part it supplies. A confident piece that says something different is
  // its own instruction; an unsure one is ambiguity, never a guess.
  const echoes = slot => (slot === "move" || slot === "anchor")
    && (pending.missing === "move" || pending.missing === "anchor")
    && read[slot].choice === supplied.choice;
  let unsure = false;
  for (const slot of PLACEMENT_SLOTS) {
    if (slot === pending.missing) continue;
    const said = read[slot];
    if (said.choice === NONE || said.choice === pending[slot].choice || echoes(slot)) continue;
    if (said.confidence >= MIN_CONFIDENCE) return own.planned;
    unsure = true;
  }
  if (unsure) return noChange("repair-failed");
  if (supplied.choice === NONE || !(supplied.confidence >= MIN_CONFIDENCE)) return noChange("repair-failed");

  const pieces = { move: pending.move, anchor: pending.anchor, direction: pending.direction, [pending.missing]: supplied };
  if (!turn.slots.move.includes(pieces.move.choice) || !turn.slots.anchor.includes(pieces.anchor.choice)
    || !DIRECTIONS.includes(pieces.direction.choice)) {
    return noChange("repair-context-changed");
  }
  if (pieces.move.choice === pieces.anchor.choice) return noChange("repair-self");

  const repaired = judge({ ...answers, action: pending.action, ...pieces }, context);
  if (repaired.planned.outcome !== "plan") return repaired.planned;
  const done = await materialize(working, repaired.planned, protocol);
  return done.outcome === OUTCOME_STEP ? Object.freeze({ ...done, repaired: true }) : done;
}

// Put a planned step onto the working graph. It must still sit on the head it
// was planned against; the provider refuses the append otherwise as well.
export async function appendStep({ working, step: planned, protocol }) {
  requireGraph(working);
  if (planned.revision !== working.head) return refused("stale");
  try {
    return Object.freeze({ outcome: OUTCOME_STEP, graph: (await protocol.appendDecision(working.log, planned.decision)).verified });
  } catch (error) {
    return refused("provider-rejected", message(error));
  }
}

// A new, empty map named by the person: this app's map namespace and state
// schema, the enclosing boundary carrying the name, and nothing else. It is a
// draft like any other step; only Apply stores it.
export async function newMap({ title, protocol }) {
  const name = typeof title === "string" ? title.trim() : "";
  if (name.length === 0) return noChange("no-title");
  if (name.length > LABEL_MAX) return refused("title-too-long");
  let graph;
  try {
    graph = await protocol.createDecisionLog([
      { type: "meta", schema: STATE_SCHEMA, root: ROOT_ID, title: name },
      { type: "region", id: ROOT_ID, parent: null, label: name, kind: ROOT_KIND, bounds: [...ROOT_BOUNDS], summary: "" },
    ], MAP_ID);
  } catch (error) {
    return refused("provider-rejected", message(error));
  }
  return Object.freeze({
    outcome: OUTCOME_STEP,
    graph,
    step: step(null, ACTION_NEW, [{ change: "added", kind: "region", id: ROOT_ID, label: name }], graph.decisions[0]),
  });
}

// Every part that currently sits at a pinned position, as [id, bounds].
const layoutPins = records => records
  .filter(record => record?.type === "layout")
  .map(record => [record.regionId, [...record.bounds]]);
const relationsById = records => new Map(records.filter(record => record?.type === "relation").map(record => [record.id, record]));
const regionIds = records => records.filter(record => record?.type === "region").map(record => record.id).sort();
const sameEdge = (left, right) => left?.from === right?.from && left?.to === right?.to;

// Whether an applied entry can be taken back as one safe change: edges only,
// placements only, or parts that still stand alone in the saved graph.
export function revertable(entry, projection) {
  if (entry.facts.every(fact => fact.kind === "relation")) return true;
  if (entry.facts.every(fact => fact.kind === "layout")) return true;
  return entry.facts.every(fact => fact.kind === "region" && fact.change === "added")
    && entry.facts.every(fact => projection.regions.includes(fact.id)
      && !projection.relations.some(relation => relation.from === fact.id || relation.to === fact.id));
}

// Undo a saved entry by adding its opposite to the working graph. `before` and
// `after` are the provider's states around that entry; the opposite is read
// off their difference and checked against the working graph as it is now. A
// later change that already altered what the entry did makes it a conflict,
// refused rather than guessed at. The saved graph is never touched.
export async function revertStep({ before, after, working, protocol }) {
  requireGraph(working);
  const build = async (operations, changes) => {
    try {
      const { decision } = await protocol.createDecision(working.head, operations, working.records);
      return Object.freeze({ outcome: OUTCOME_STEP, step: step(working.head, ACTION_REVERT, changes, decision) });
    } catch (error) {
      return refused("provider-rejected", message(error));
    }
  };

  // Moved parts go back to where they were pinned before, or are unpinned.
  const layoutBefore = new Map(layoutPins(before));
  const layoutAfter = new Map(layoutPins(after));
  const movedIds = [...new Set([...layoutBefore.keys(), ...layoutAfter.keys()])]
    .filter(regionId => JSON.stringify(layoutBefore.get(regionId)) !== JSON.stringify(layoutAfter.get(regionId)));
  if (movedIds.length > 0 && JSON.stringify(regionIds(before)) === JSON.stringify(regionIds(after))) {
    const current = new Map(layoutPins(working.records));
    if (!movedIds.every(regionId => JSON.stringify(current.get(regionId)) === JSON.stringify(layoutAfter.get(regionId)))) {
      return refused("revert-moved");
    }
    const restore = movedIds.filter(regionId => layoutBefore.has(regionId));
    const unpin = movedIds.filter(regionId => !layoutBefore.has(regionId));
    return build([
      ...(restore.length > 0 ? [{ type: "PinRegions", items: restore.map(regionId => ({ regionId, bounds: [...layoutBefore.get(regionId)] })) }] : []),
      ...(unpin.length > 0 ? [{ type: "UnpinRegions", regionIds: [...unpin] }] : []),
    ], movedIds.map(regionId => ({ change: "placed", kind: "region", id: regionId, anchor: NONE, direction: NONE })));
  }

  // Added parts are removed again, but only while each is still a leaf with no
  // edge: RemoveSelection would take more than that entry did.
  const addedRegions = regionIds(after).filter(regionId => !regionIds(before).includes(regionId));
  const removedRegions = regionIds(before).filter(regionId => !regionIds(after).includes(regionId));
  if (addedRegions.length > 0 || removedRegions.length > 0) {
    if (removedRegions.length > 0) return refused("revert-unsupported");
    const present = new Set(regionIds(working.records));
    for (const regionId of addedRegions) {
      if (!present.has(regionId)) return refused("revert-removed");
      if (working.records.some(record => record?.type === "region" && record.parent === regionId)) return refused("revert-holds-parts");
      if (working.records.some(record => record?.type === "relation" && (record.from === regionId || record.to === regionId))) {
        return refused("revert-has-edge");
      }
    }
    const labelOf = regionId => after.find(record => record?.type === "region" && record.id === regionId).label;
    return build([{ type: "RemoveSelection", regionIds: [...addedRegions], relationIds: [] }],
      addedRegions.map(regionId => ({ change: "removed", kind: "region", id: regionId, label: labelOf(regionId) })));
  }

  // Edges it added are removed; edges it removed come back with their id,
  // kind and label.
  const earlier = relationsById(before);
  const later = relationsById(after);
  const added = [...later.values()].filter(relation => !sameEdge(earlier.get(relation.id), relation));
  const removed = [...earlier.values()].filter(relation => !sameEdge(later.get(relation.id), relation));
  if (added.length + removed.length === 0) return refused("revert-nothing");
  const current = relationsById(working.records);
  if (!added.every(relation => sameEdge(current.get(relation.id), relation))) return refused("revert-altered");
  if (!removed.every(relation => !current.has(relation.id))) return refused("revert-reused");
  return build([
    ...(added.length > 0 ? [{ type: "RemoveSelection", regionIds: [], relationIds: added.map(relation => relation.id) }] : []),
    ...removed.map(relation => ({
      type: "ConnectRegions",
      relationId: relation.id,
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      label: relation.label,
    })),
  ], [
    ...added.map(({ from, to }) => ({ change: "removed", from, to })),
    ...removed.map(({ from, to }) => ({ change: "added", from, to })),
  ]);
}
