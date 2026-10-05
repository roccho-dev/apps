// What the page and the Function agree on, in one place: the request kinds and
// the one answer kind, their shapes, the options each question offers, and every
// finite limit and key both sides check. The page builds requests and reads
// answers with these; the Function validates requests and provider answers
// with the same ones. Question wording is the Function's own; product words
// come from the DataBundle and never from here.

export const REQUEST_KIND = "voice-ui.judge.request.v1";
export const DECISION_KIND = "voice-ui.judge.decision.v1";
export const GOAL_REQUEST_KIND = "voice-ui.judge.goal-local-delta.v3";
export const GOAL_REQUEST_MAX = 8;
// The architecture page's requests, each its own closed kind. The intent is
// the plain request with the prepared snapshot's parts beside it, by path or
// identifier only, and never any code. When the intent names no part
// confidently, the locate asks the code itself which parts the utterance
// means, one frame per part: each carries the utterance, the conversation and
// that one part only, and the server adds that part's own text. The judge
// follows with the section of the parts chosen - one named part, or every
// part located - asked in frames: each carries the section whole and names
// the one or two body files its own questions rest on, whose text the server
// adds.
export const ARCHITECTURE_INTENT_KIND = "voice-ui.judge.architecture-intent.v2";
// Intent/locate v2 require an explicit nullable reference on every context
// entry. Plain v1 keeps its exact original shape; old architecture kinds are
// not admitted. Judge v1 is unchanged: it carries no conversation.
export const ARCHITECTURE_LOCATE_KIND = "voice-ui.judge.architecture-locate.v2";
// One judge request asks one frame of the section.
export const ARCHITECTURE_JUDGE_KIND = "voice-ui.judge.architecture-judge.v1";

// Every slot also offers this option, so it may not be a part, edge or key.
export const NONE = "none";
// An architecture intent's focus also offers the code as a whole, apart from
// none, so it may not be a part either.
export const WHOLE = "whole";

export const ACTION_ADD_EDGE = "add-edge";
export const ACTION_ADD_PART = "add-part";
export const ACTION_PLACE_PART = "place-part";
export const ACTION_REMOVE_EDGE = "remove-edge";
export const ACTION_REVERSE_EDGE = "reverse-edge";
export const ACTION_COMPOSE = "compose-diagram";
export const ACTION_UNDO_REQUEST = "undo-request";
// Offered only in an architecture intent.
export const ACTION_ARCHITECTURE = "compose-architecture";
// A judge's answer that a file has a role; its other option is NONE.
export const YES = "yes";

export const DIRECTIONS = Object.freeze(["left", "right", "above", "below"]);
export const PLACEMENT_SLOTS = Object.freeze(["move", "anchor", "direction"]);

// The kinds of part the graph view draws differently. A DataBundle part or
// diagram step may only name one of these, so no content can ask for a shape
// the view cannot show.
export const PART_KINDS = Object.freeze(["step", "decision", "data", "start", "end"]);

// A choice below this is not acted on; the weakest slot of an action governs.
export const MIN_CONFIDENCE = 0.5;

// The working graph holds at most this many unapplied steps.
export const DRAFT_MAX = 8;

// The recent conversation: at most this many earlier utterances, each at most
// this long. A longer one is left out, never shortened.
export const CONTEXT_MAX = 5;
export const CONTEXT_TEXT_MAX = 200;

export const LABEL_MAX = 120;
export const OFFER_MAX = 8;
export const PURPOSE_MAX = 300;
export const KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const TEXT_MAX = 8000;
const GRAPH_MAX = 64;
const ID_MAX = 240;
const CHANGES_MAX = 8;
// An architecture intent's graph holds a whole prepared snapshot - a region
// per part and per fact, an edge per import, fact and chosen relation - and
// one utterance there may add all of it at once, so its draft entries, focus
// and remembered effects may carry that many changes. A test holds this
// package's own snapshot within these bounds; the plain request keeps its own.
const ARCHITECTURE_GRAPH_MAX = 128;
const ARCHITECTURE_CHANGES_MAX = 2 * ARCHITECTURE_GRAPH_MAX;
const CONTEXT_SOURCES = Object.freeze(["voice", "typed"]);
const CONTEXT_OUTCOMES = Object.freeze(["step", "no-change", "undo-request", "refused", "undone"]);
const FOCUS_KINDS = Object.freeze(["draft", "applied"]);

// The closed set of failures the Function answers with. None carries the judgment binding
// content.
export const ERRORS = Object.freeze({
  unavailable: "judge_unavailable",
  invalidJson: "invalid_json",
  invalidRequest: "invalid_request",
  providerError: "provider_error",
  providerTimeout: "provider_timeout",
  providerUnreachable: "provider_unreachable",
  providerContract: "provider_contract_error",
  architectureUnavailable: "architecture_unavailable",
  architectureMismatch: "architecture_mismatch",
});

const exactObject = (value, keys) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === "string" && value.length > 0 && value.length <= ID_MAX && value !== NONE;
const unique = values => new Set(values).size === values.length;
const inUnit = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// What one step did. An edge change names its two ends; a part change names
// the part and its label; a placement names the part, its neighbour and the
// side, or none twice when the part was put back where the view had it.
const validChange = change => {
  if (change?.kind === "region" && change?.change === "placed") {
    return exactObject(change, ["change", "kind", "id", "anchor", "direction"])
      && id(change.id)
      && (id(change.anchor) || change.anchor === NONE)
      && (DIRECTIONS.includes(change.direction) || change.direction === NONE)
      && change.anchor !== change.id
      && (change.anchor === NONE) === (change.direction === NONE);
  }
  if (change?.kind === "region") {
    return exactObject(change, ["change", "kind", "id", "label"])
      && (change.change === "added" || change.change === "removed")
      && id(change.id)
      && text(change.label, LABEL_MAX);
  }
  return exactObject(change, ["change", "from", "to"])
    && (change.change === "added" || change.change === "removed")
    && id(change.from)
    && id(change.to);
};

// The bounds each request kind is held to.
const LIMITS = new Map([
  [REQUEST_KIND, Object.freeze({ graph: GRAPH_MAX, changes: CHANGES_MAX, architecture: false })],
  [ARCHITECTURE_INTENT_KIND, Object.freeze({ graph: ARCHITECTURE_GRAPH_MAX, changes: ARCHITECTURE_CHANGES_MAX, architecture: true })],
]);

const validChanges = (value, max) =>
  Array.isArray(value) && value.length >= 1 && value.length <= max && value.every(validChange);

const validGraph = (graph, max) => {
  if (!exactObject(graph, ["regions", "edges", "placeable"])) return false;
  const { regions, edges, placeable } = graph;
  if (!Array.isArray(regions) || regions.length > max) return false;
  if (!regions.every(region => exactObject(region, ["id", "label"]) && id(region.id) && text(region.label, LABEL_MAX))) return false;
  const ids = regions.map(region => region.id);
  if (!unique(ids)) return false;
  if (!Array.isArray(edges) || edges.length > max) return false;
  if (!edges.every(edge => exactObject(edge, ["id", "from", "to"]) && id(edge.id) && ids.includes(edge.from) && ids.includes(edge.to))) return false;
  if (!unique(edges.map(edge => edge.id))) return false;
  return Array.isArray(placeable) && placeable.every(value => ids.includes(value)) && unique(placeable);
};

const validFocus = (focus, max) => focus === null
  || (exactObject(focus, ["kind", "changes"]) && FOCUS_KINDS.includes(focus.kind) && validChanges(focus.changes, max));

// An earlier utterance and what came of it. Only a step, not undone, carries
// the effect the page built from it then.
const validReference = reference => reference === null || (
  exactObject(reference, ["source", "focus"]) && validSource(reference.source)
  && Array.isArray(reference.focus) && reference.focus.length > 0 && reference.focus.length <= ARCHITECTURE_GRAPH_MAX
  && reference.focus.every(part => KEY_PATTERN.test(part ?? "") && ![NONE, WHOLE].includes(part))
  && sortedUnique(reference.focus)
);
const validContextEntry = (entry, max, architecture) =>
  exactObject(entry, entry?.outcome === "step"
    ? ["seq", "source", "text", "outcome", "effect", ...(architecture ? ["reference"] : [])]
    : ["seq", "source", "text", "outcome", ...(architecture ? ["reference"] : [])])
  && Number.isSafeInteger(entry.seq) && entry.seq >= 1
  && CONTEXT_SOURCES.includes(entry.source)
  && text(entry.text, CONTEXT_TEXT_MAX)
  && CONTEXT_OUTCOMES.includes(entry.outcome)
  && (!architecture || (validReference(entry.reference)
    && (entry.reference === null || ["step", "no-change"].includes(entry.outcome))))
  && (entry.outcome !== "step" || (exactObject(entry.effect, ["changes"]) && validChanges(entry.effect.changes, max)));

const validContext = (context, max, architecture = false) =>
  exactObject(context, ["recent"])
  && Array.isArray(context.recent)
  && context.recent.length <= CONTEXT_MAX
  && context.recent.every(entry => validContextEntry(entry, max, architecture))
  && context.recent.every((entry, index) => index === 0 || entry.seq > context.recent[index - 1].seq);

// The placement the previous utterance nearly made: part ids and a side, the
// one missing slot null, never text.
const validPending = (pending, placeable) => pending === null || (
  exactObject(pending, ["missing", "move", "anchor", "direction"])
  && PLACEMENT_SLOTS.includes(pending.missing)
  && placeable.length >= 2
  && PLACEMENT_SLOTS.every(slot => slot === pending.missing
    ? pending[slot] === null
    : slot === "direction" ? DIRECTIONS.includes(pending[slot]) : placeable.includes(pending[slot]))
  && (pending.move === null || pending.anchor === null || pending.move !== pending.anchor)
);

const validOffer = list =>
  Array.isArray(list)
  && list.length <= OFFER_MAX
  && list.every(offer => exactObject(offer, ["key", "purpose"])
    && typeof offer.key === "string" && KEY_PATTERN.test(offer.key) && offer.key !== NONE
    && text(offer.purpose, PURPOSE_MAX))
  && unique(list.map(offer => offer.key));

const COMMIT = /^[0-9a-f]{40}$/u;
// One executable candidate choice; ordinary v1 requests keep their exact shape.
const validGoalRequest = value => {
  if (!exactObject(value, ["kind", "state"])) return false;
  const state = value.state;
  if (!exactObject(state, ["utterance", "graph", "edges", "parents", "offers", "selected", "candidates"])) return false;
  if (!text(state.utterance, TEXT_MAX) || !Array.isArray(state.graph) || state.graph.length > GRAPH_MAX) return false;
  if (!state.graph.every(region => exactObject(region, ["id", "label", "parent"])
    && id(region.id) && text(region.label, LABEL_MAX) && (region.parent === null || id(region.parent)))) return false;
  const ids = state.graph.map(region => region.id);
  if (!unique(ids) || !state.graph.every(region => region.parent === null || ids.includes(region.parent))) return false;
  if (state.graph.filter(region => region.parent === null).length !== 1) return false;
  const parentOf = new Map(state.graph.map(region => [region.id, region.parent]));
  for (const region of state.graph) {
    const seen = new Set();
    for (let at = region.id; at !== null; at = parentOf.get(at)) {
      if (seen.has(at)) return false;
      seen.add(at);
    }
  }
  if (!Array.isArray(state.parents) || state.parents.length > GRAPH_MAX
    || !state.parents.every(parent => exactObject(parent, ["id", "label", "kind", "parent"])
      && ids.includes(parent.id) && text(parent.label, LABEL_MAX) && parent.kind === "group"
      && ids.includes(parent.parent) && state.graph.some(region => region.id === parent.id
        && region.label === parent.label && region.parent === parent.parent))
    || !unique(state.parents.map(parent => parent.id))) return false;
  if (!exactObject(state.offers, ["parts"]) || !validOffer(state.offers.parts)) return false;
  const endpoints = ids.filter(value => parentOf.get(value) !== null && !state.parents.some(parent => parent.id === value));
  if (!Array.isArray(state.edges) || state.edges.length > GRAPH_MAX
    || !state.edges.every(edge => exactObject(edge, ["id", "from", "to"]) && id(edge.id)
      && endpoints.includes(edge.from) && endpoints.includes(edge.to) && edge.from !== edge.to)
    || !unique(state.edges.map(edge => edge.id))
    || !unique(state.edges.map(edge => JSON.stringify([edge.from, edge.to])))) return false;
  if (!Array.isArray(state.candidates) || state.candidates.length < 1 || state.candidates.length > 254
    || !state.candidates.every(candidate => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && id(candidate.id) && (candidate.action === ACTION_ADD_PART
      ? exactObject(candidate, ["id", "action", "part", "parent"])
        && state.offers.parts.some(part => part.key === candidate.part)
        && state.parents.some(parent => parent.id === candidate.parent)
      : candidate.action === ACTION_ADD_EDGE && exactObject(candidate, ["id", "action", "from", "to"])
        && endpoints.includes(candidate.from) && endpoints.includes(candidate.to) && candidate.from !== candidate.to
        && !state.edges.some(edge => edge.from === candidate.from && edge.to === candidate.to)))
    || !unique(state.candidates.map(candidate => candidate.id))
    || !unique(state.candidates.map(candidate => JSON.stringify(candidate.action === ACTION_ADD_PART
      ? [candidate.action, candidate.part, candidate.parent] : [candidate.action, candidate.from, candidate.to])))) return false;
  return Array.isArray(state.selected) && state.selected.length <= OFFER_MAX
    && state.selected.every(item => exactObject(item, ["key", "region", "parent"])
      && KEY_PATTERN.test(item.key ?? "") && item.key !== NONE && ids.includes(item.region)
      && ids.includes(item.parent) && state.graph.some(region => region.id === item.region && region.parent === item.parent))
    && unique(state.selected.map(item => item.key))
    && unique(state.selected.map(item => item.region))
    && state.selected.every(item => state.offers.parts.some(part => part.key === item.key))
    && state.candidates.every(candidate => !state.selected.some(item => item.key === candidate.part));
};

// The prepared snapshot's identity.
const validSource = source =>
  exactObject(source, ["handle", "commit"]) && KEY_PATTERN.test(source.handle ?? "") && COMMIT.test(source.commit ?? "");

// A list of ids in strictly increasing order: sorted, with no repeats.
const sortedUnique = list => list.every((value, index) => index === 0 || list[index - 1] < value);

// The prepared snapshot's identity, and its parts by id and path or identifier.
const validParts = (source, entities) =>
  validSource(source)
  && Array.isArray(entities) && entities.length > 0 && entities.length <= ARCHITECTURE_GRAPH_MAX
  && entities.every(entity => exactObject(entity, ["id", "label"]) && KEY_PATTERN.test(entity.id ?? "") && entity.id !== NONE && entity.id !== WHOLE
    && text(entity.label, LABEL_MAX))
  && unique(entities.map(entity => entity.id));

// An intent's section: the parts and nothing else.
const validIntent = section => exactObject(section, ["source", "entities"]) && validParts(section.source, section.entities);

const STATE_KEYS = Object.freeze(["utterance", "graph", "draft", "focus", "pending", "context", "offers"]);

// A plain request, or an architecture intent, each held to its own bounds.
export function isRequest(value) {
  if (value?.kind === GOAL_REQUEST_KIND) return validGoalRequest(value);
  if (!exactObject(value, ["kind", "state"]) || !LIMITS.has(value.kind)) return false;
  const { graph, changes, architecture } = LIMITS.get(value.kind);
  const { state } = value;
  return exactObject(state, architecture ? [...STATE_KEYS, "architecture"] : STATE_KEYS)
    && (!architecture || validIntent(state.architecture))
    && text(state.utterance, TEXT_MAX)
    && validGraph(state.graph, graph)
    && Array.isArray(state.draft)
    && state.draft.length <= DRAFT_MAX
    && state.draft.every(step => exactObject(step, ["changes"]) && validChanges(step.changes, changes))
    && validFocus(state.focus, changes)
    && validPending(state.pending, state.graph.placeable)
    && validContext(state.context, changes, architecture)
    && exactObject(state.offers, ["parts", "diagrams"])
    && validOffer(state.offers.parts)
    && validOffer(state.offers.diagrams);
}

// An architecture locate frame: the utterance and the recent conversation
// exactly as the intent carried them, the snapshot's identity, and the one
// part it asks about. Never file contents; the server adds those itself.
export function isLocateRequest(value) {
  if (!exactObject(value, ["kind", "state"]) || value.kind !== ARCHITECTURE_LOCATE_KIND) return false;
  const { state } = value;
  return exactObject(state, ["utterance", "context", "architecture"])
    && text(state.utterance, TEXT_MAX)
    && validContext(state.context, ARCHITECTURE_CHANGES_MAX, true)
    && exactObject(state.architecture, ["source", "focus"]) && validSource(state.architecture.source)
    && Array.isArray(state.architecture.focus) && state.architecture.focus.length === 1
    && KEY_PATTERN.test(state.architecture.focus[0] ?? "") && ![NONE, WHOLE].includes(state.architecture.focus[0]);
}

// An architecture judge: the utterance, one focused section - the parts it
// was asked for, sorted; its parts, which of them are body files, the
// candidate pairs among them with the text each rests on, and the vocabulary -
// and the frame of it this request asks: one or two of its body files, sorted.
// Never file contents; the server adds those itself.
export function isJudgeRequest(value) {
  if (!exactObject(value, ["kind", "state"]) || value.kind !== ARCHITECTURE_JUDGE_KIND) return false;
  const { state } = value;
  if (!exactObject(state, ["utterance", "architecture", "frame"]) || !text(state.utterance, TEXT_MAX)) return false;
  const section = state.architecture;
  if (!exactObject(section, ["source", "focus", "entities", "bodies", "candidates", "roles", "relations"])
    || !validParts(section.source, section.entities)) return false;
  const ids = section.entities.map(entity => entity.id);
  const { candidates } = section;
  const { frame } = state;
  return Array.isArray(frame) && (frame.length === 1 || frame.length === 2)
    && Array.isArray(section.bodies) && frame.every(body => section.bodies.includes(body)) && sortedUnique(frame)
    && Array.isArray(section.focus) && section.focus.length > 0 && section.focus.every(part => ids.includes(part))
    && sortedUnique(section.focus)
    && Array.isArray(section.bodies) && section.bodies.length > 0 && section.bodies.every(body => ids.includes(body)) && unique(section.bodies)
    && Array.isArray(candidates) && candidates.length <= ARCHITECTURE_GRAPH_MAX
    && candidates.every(candidate => exactObject(candidate, ["id", "from", "to", "reasons"]) && id(candidate.id)
      && ids.includes(candidate.from) && ids.includes(candidate.to) && candidate.from !== candidate.to
      && Array.isArray(candidate.reasons) && candidate.reasons.length > 0 && candidate.reasons.every(reason => text(reason, LABEL_MAX)))
    && unique(candidates.map(candidate => candidate.id))
    && validOffer(section.roles) && section.roles.length > 0 && validOffer(section.relations) && section.relations.length > 0;
}

// A locate frame's question by name, one for its part; and its options:
// whether the utterance asks for that part, yes or none.
export const relevantSlot = entityId => `relevant-${entityId}`;
export const locateSlotsFor = entityIds => Object.freeze(Object.fromEntries(
  entityIds.map(entityId => [relevantSlot(entityId), Object.freeze([YES, NONE])])));

// A judge's questions by name: one per role of each body file, one per pair.
export const roleSlot = (entityId, role) => `role-${entityId}--${role}`;
export const relationSlot = candidateId => `relation-${candidateId}`;

// The questions a judge request puts to Jev and the options of each: whether
// a body file has a role, yes or none; and which relation, or none, holds for
// a pair.
export function judgeSlotsFor(section) {
  const relations = section.relations.map(relation => relation.key);
  const slots = {};
  for (const body of section.bodies) {
    for (const role of section.roles) slots[roleSlot(body, role.key)] = [YES, NONE];
  }
  for (const candidate of section.candidates) slots[relationSlot(candidate.id)] = [...relations, NONE];
  return Object.freeze(Object.fromEntries(Object.entries(slots).map(([name, keys]) => [name, Object.freeze(keys)])));
}

// The frames a judge of a section is asked in, decided by the section alone.
// Every question rests on whole body files: a role on its own file, a pair on
// whichever of its two ends are body files. A frame is one such set of one or
// two files, sorted, with every question that rests on exactly that set - so
// a pair of two body files shares its frame with the pair the other way - and
// each question of the section is in exactly one frame. Frames come in the
// order their first question has among the section's. Each is given as the
// part of the section it asks, in the section's own shape and order: the
// frame's files as its bodies, its own pairs, only the parts those name, and
// the roles for one file but none for two, whose roles their own frames ask.
// Null when a pair rests on no body file: then nothing is asked.
export function judgeFramesFor(section) {
  const groups = new Map(section.bodies.map(body => [body, { frame: [body], candidates: [] }]));
  for (const candidate of section.candidates) {
    const frame = [candidate.from, candidate.to].filter(end => section.bodies.includes(end)).sort();
    if (frame.length === 0) return null;
    const name = frame.join(" ");
    if (!groups.has(name)) groups.set(name, { frame, candidates: [] });
    groups.get(name).candidates.push(candidate);
  }
  return Object.freeze([...groups.values()].map(({ frame, candidates }) => {
    const parts = new Set([...frame, ...candidates.flatMap(candidate => [candidate.from, candidate.to])]);
    return Object.freeze({
      frame: Object.freeze(frame),
      section: Object.freeze({
        source: section.source,
        focus: section.focus,
        entities: Object.freeze(section.entities.filter(entity => parts.has(entity.id))),
        bodies: Object.freeze(section.bodies.filter(body => frame.includes(body))),
        candidates: Object.freeze(candidates),
        roles: frame.length === 1 ? section.roles : Object.freeze([]),
        relations: section.relations,
      }),
    });
  }));
}

// The questions a request puts to Jev and the options of each, derived from
// the request alone. An action is offered only when the graph can carry it
// out, and a slot exists only when an action that needs it is offered.
export function slotsFor(state) {
  if (state.candidates !== undefined) return Object.freeze({ delta: Object.freeze([...state.candidates.map(candidate => candidate.id), NONE]) });
  const nodes = state.graph.regions.map(region => region.id);
  const canEdge = nodes.length >= 2;
  const canPart = state.offers.parts.length > 0;
  const canPlace = state.graph.placeable.length >= 2;
  const hasEdges = state.graph.edges.length > 0;
  const canCompose = state.offers.diagrams.length > 0;
  const slots = {
    action: [
      ...(canEdge ? [ACTION_ADD_EDGE] : []),
      ...(canPart ? [ACTION_ADD_PART] : []),
      ...(canPlace ? [ACTION_PLACE_PART] : []),
      ...(hasEdges ? [ACTION_REMOVE_EDGE, ACTION_REVERSE_EDGE] : []),
      ...(canCompose ? [ACTION_COMPOSE] : []),
      ...(state.architecture ? [ACTION_ARCHITECTURE] : []),
      ACTION_UNDO_REQUEST,
      NONE,
    ],
  };
  if (state.architecture) slots.focus = [...state.architecture.entities.map(entity => entity.id), WHOLE, NONE];
  if (canEdge) {
    slots.source = [...nodes, NONE];
    slots.target = [...nodes, NONE];
  }
  if (canPart) slots.part = [...state.offers.parts.map(offer => offer.key), NONE];
  if (canPlace) {
    slots.move = [...state.graph.placeable, NONE];
    slots.anchor = [...state.graph.placeable, NONE];
    slots.direction = [...DIRECTIONS, NONE];
  }
  if (hasEdges) slots.edge = [...state.graph.edges.map(edge => edge.id), NONE];
  if (canCompose) slots.diagram = [...state.offers.diagrams.map(offer => offer.key), NONE];
  return Object.freeze(Object.fromEntries(Object.entries(slots).map(([name, keys]) => [name, Object.freeze(keys)])));
}

const readChoice = (answer, offered) => {
  if (answer?.type !== "choice" || !offered.includes(answer.choice) || !inUnit(answer.confidence)) return null;
  const { probabilities } = answer;
  if (probabilities !== undefined && !(
    probabilities !== null && typeof probabilities === "object" && !Array.isArray(probabilities)
    && Object.keys(probabilities).every(key => offered.includes(key))
    && Object.values(probabilities).every(value => typeof value === "number" && Number.isFinite(value))
  )) return null;
  if (!Object.keys(answer).every(key => ["type", "choice", "confidence", "probabilities"].includes(key))) return null;
  return Object.freeze({ type: "choice", choice: answer.choice, confidence: answer.confidence });
};

// Exactly the questions that were asked, each a choice from its own options
// with a confidence in [0,1]; anything else is null. Probabilities are checked
// and dropped, so only choice and confidence ever travel on.
export function readAnswers(answers, slots) {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) return null;
  const names = Object.keys(slots);
  if (!exactObject(answers, names)) return null;
  const read = {};
  for (const name of names) {
    read[name] = readChoice(answers[name], slots[name]);
    if (read[name] === null) return null;
  }
  return Object.freeze(read);
}

// Adopted ports: Judge(request) resolves {kind:"answered",decision} or a closed
// {kind:"failed",reason,detail}; Transcription({onListening,signal}) resolves text
// or rejects with a closed code and owns start/stop/300s cleanup.
// UI createDecision/appendDecision/createDecisionLog/verifyDecisionLog and
// layoutBoundsFor/createEnvelope preserve the accepted world schema/kernel;
// a display binding renders the envelope without owning application decisions.
