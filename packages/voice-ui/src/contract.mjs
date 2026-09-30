// What the page and the Function agree on, in one place: the one request and
// answer kind, their shapes, the options each question offers, and every
// finite limit and key both sides check. The page builds requests and reads
// answers with these; the Function validates requests and provider answers
// with the same ones. Question wording is the Function's own; product words
// come from the DataBundle and never from here.

export const REQUEST_KIND = "voice-ui.jev.request.v10";
export const DECISION_KIND = "voice-ui.jev.decision.v5";

// Every slot also offers this option, so it may not be a part, edge or key.
export const NONE = "none";

export const ACTION_ADD_EDGE = "add-edge";
export const ACTION_ADD_PART = "add-part";
export const ACTION_PLACE_PART = "place-part";
export const ACTION_REMOVE_EDGE = "remove-edge";
export const ACTION_REVERSE_EDGE = "reverse-edge";
export const ACTION_COMPOSE = "compose-diagram";
export const ACTION_UNDO_REQUEST = "undo-request";
// Offered only on the architecture page, whose requests carry the prepared
// source's public entities and candidate pairs.
export const ACTION_ARCHITECTURE = "compose-architecture";

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
// One step changes at most every region and every edge a graph may hold: an
// architecture view is drafted whole, as one step.
const CHANGES_MAX = 2 * GRAPH_MAX;
const CONTEXT_SOURCES = Object.freeze(["voice", "typed"]);
const CONTEXT_OUTCOMES = Object.freeze(["step", "no-change", "undo-request", "refused", "undone"]);
const FOCUS_KINDS = Object.freeze(["draft", "applied"]);

// The closed set of failures the Function answers with. None carries Jev
// content.
export const ERRORS = Object.freeze({
  unavailable: "jev_unavailable",
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

const validChanges = value =>
  Array.isArray(value) && value.length >= 1 && value.length <= CHANGES_MAX && value.every(validChange);

const validGraph = graph => {
  if (!exactObject(graph, ["regions", "edges", "placeable"])) return false;
  const { regions, edges, placeable } = graph;
  if (!Array.isArray(regions) || regions.length > GRAPH_MAX) return false;
  if (!regions.every(region => exactObject(region, ["id", "label"]) && id(region.id) && text(region.label, LABEL_MAX))) return false;
  const ids = regions.map(region => region.id);
  if (!unique(ids)) return false;
  if (!Array.isArray(edges) || edges.length > GRAPH_MAX) return false;
  if (!edges.every(edge => exactObject(edge, ["id", "from", "to"]) && id(edge.id) && ids.includes(edge.from) && ids.includes(edge.to))) return false;
  if (!unique(edges.map(edge => edge.id))) return false;
  return Array.isArray(placeable) && placeable.every(value => ids.includes(value)) && unique(placeable);
};

const validFocus = focus => focus === null
  || (exactObject(focus, ["kind", "changes"]) && FOCUS_KINDS.includes(focus.kind) && validChanges(focus.changes));

// An earlier utterance and what came of it. Only a step, not undone, carries
// the effect the page built from it then.
const validContextEntry = entry =>
  exactObject(entry, entry?.outcome === "step"
    ? ["seq", "source", "text", "outcome", "effect"]
    : ["seq", "source", "text", "outcome"])
  && Number.isSafeInteger(entry.seq) && entry.seq >= 1
  && CONTEXT_SOURCES.includes(entry.source)
  && text(entry.text, CONTEXT_TEXT_MAX)
  && CONTEXT_OUTCOMES.includes(entry.outcome)
  && (entry.outcome !== "step" || (exactObject(entry.effect, ["changes"]) && validChanges(entry.effect.changes)));

const validContext = context =>
  exactObject(context, ["recent"])
  && Array.isArray(context.recent)
  && context.recent.length <= CONTEXT_MAX
  && context.recent.every(validContextEntry)
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

// The prepared source as the architecture page sends it: its identity, the
// entities and candidate pairs of its public manifest, and the vocabulary Jev
// may choose from. Never file contents; the server adds those itself.
const validArchitecture = architecture => {
  if (!exactObject(architecture, ["source", "entities", "candidates", "roles", "relations"])) return false;
  const { source, entities, candidates, roles, relations } = architecture;
  if (!exactObject(source, ["handle", "commit"]) || !KEY_PATTERN.test(source.handle ?? "") || !COMMIT.test(source.commit ?? "")) return false;
  if (!Array.isArray(entities) || entities.length === 0 || entities.length > GRAPH_MAX) return false;
  if (!entities.every(entity => exactObject(entity, ["id", "label"]) && KEY_PATTERN.test(entity.id ?? "") && entity.id !== NONE
    && text(entity.label, LABEL_MAX))) return false;
  const ids = entities.map(entity => entity.id);
  if (!unique(ids)) return false;
  if (!Array.isArray(candidates) || candidates.length > GRAPH_MAX) return false;
  if (!candidates.every(candidate => exactObject(candidate, ["id", "from", "to", "reasons"]) && id(candidate.id)
    && ids.includes(candidate.from) && ids.includes(candidate.to) && candidate.from !== candidate.to
    && Array.isArray(candidate.reasons) && candidate.reasons.length > 0 && candidate.reasons.every(reason => text(reason, LABEL_MAX)))) return false;
  if (!unique(candidates.map(candidate => candidate.id))) return false;
  return validOffer(roles) && roles.length > 0 && validOffer(relations) && relations.length > 0;
};

const STATE_KEYS = Object.freeze(["utterance", "graph", "draft", "focus", "pending", "context", "offers"]);

export function isRequest(value) {
  if (!exactObject(value, ["kind", "state"]) || value.kind !== REQUEST_KIND) return false;
  const { state } = value;
  const architecture = state !== null && typeof state === "object" && Object.hasOwn(state, "architecture");
  return exactObject(state, architecture ? [...STATE_KEYS, "architecture"] : STATE_KEYS)
    && (!architecture || validArchitecture(state.architecture))
    && text(state.utterance, TEXT_MAX)
    && validGraph(state.graph)
    && Array.isArray(state.draft)
    && state.draft.length <= DRAFT_MAX
    && state.draft.every(step => exactObject(step, ["changes"]) && validChanges(step.changes))
    && validFocus(state.focus)
    && validPending(state.pending, state.graph.placeable)
    && validContext(state.context)
    && exactObject(state.offers, ["parts", "diagrams"])
    && validOffer(state.offers.parts)
    && validOffer(state.offers.diagrams);
}

// The architecture questions' names: one role per entity, one relation per
// candidate pair.
export const roleSlot = entityId => `role-${entityId}`;
export const relationSlot = candidateId => `relation-${candidateId}`;

// The questions a request puts to Jev and the options of each, derived from
// the request alone. An action is offered only when the graph can carry it
// out, and a slot exists only when an action that needs it is offered.
export function slotsFor(state) {
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
  if (state.architecture) {
    const roles = state.architecture.roles.map(role => role.key);
    const relations = state.architecture.relations.map(relation => relation.key);
    slots.focus = [...roles, NONE];
    for (const entity of state.architecture.entities) slots[roleSlot(entity.id)] = [...roles, NONE];
    for (const candidate of state.architecture.candidates) slots[relationSlot(candidate.id)] = [...relations, NONE];
  }
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
