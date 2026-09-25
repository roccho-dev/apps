const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const validText = value =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 8000;

const validRequest = value =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 2 &&
  value.kind === "voice-ui.jev.request.v1" &&
  validText(value.text);

const validRegions = value =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.length <= 64 &&
  value.every(id => typeof id === "string" && id.length > 0 && id.length <= 120) &&
  new Set(value).size === value.length;

const validRequestV2 = value =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 3 &&
  value.kind === "voice-ui.jev.request.v2" &&
  validText(value.text) &&
  value.graph !== null &&
  typeof value.graph === "object" &&
  !Array.isArray(value.graph) &&
  Object.keys(value.graph).length === 1 &&
  validRegions(value.graph.regions);

const exactObject = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const validId = value => typeof value === "string" && value.length > 0 && value.length <= 240;

const validEdges = (value, regions) =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every(edge =>
    exactObject(edge, ["id", "from", "to"]) &&
    validId(edge.id) &&
    regions.includes(edge.from) &&
    regions.includes(edge.to)) &&
  new Set(value.map(edge => edge.id)).size === value.length;

// Every slot also offers this option, so it may not be a node or edge id.
const NONE = "none";

// The working graph holds at most this many unapplied steps; the page never
// sends more, and never a shortened list.
const DRAFT_MAX = 8;

const FOCUS_KINDS = ["none", "draft", "applied"];

// What one step did. An edge change names the two nodes it runs between; a
// part change names the part and the label it is shown by. Both describe an
// effect the provider already verified, never a request for one.
const PART_LABEL_MAX = 120;

const DIRECTIONS = ["left", "right", "above", "below"];

const validChange = change =>
  (change?.kind === "region" && change?.change === "placed"
    ? exactObject(change, ["change", "kind", "id", "anchor", "direction"]) &&
      // A placement names the part, the part it was put beside and the side.
      // Putting one back where it was has no neighbour and no side, so both
      // slots also carry none - but never a part beside itself.
      validId(change.id) &&
      (validId(change.anchor) || change.anchor === NONE) &&
      (DIRECTIONS.includes(change.direction) || change.direction === NONE) &&
      change.anchor !== change.id &&
      (change.anchor === NONE) === (change.direction === NONE)
    : change?.kind === "region"
    ? exactObject(change, ["change", "kind", "id", "label"]) &&
      validId(change.id) &&
      typeof change.label === "string" &&
      change.label.trim().length > 0 &&
      change.label.length <= PART_LABEL_MAX
    : exactObject(change, ["change", "from", "to"]) &&
      validId(change.from) &&
      validId(change.to)) &&
  (change.change === "added" || change.change === "removed"
    || (change.change === "placed" && change.kind === "region"));

const validChanges = value =>
  Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(validChange);

const validFocus = value =>
  exactObject(value, ["kind", "changes"]) &&
  FOCUS_KINDS.includes(value.kind) &&
  Array.isArray(value.changes) &&
  (value.kind === "none" ? value.changes.length === 0 : validChanges(value.changes));

const validDraft = value =>
  Array.isArray(value) &&
  value.length <= DRAFT_MAX &&
  value.every(step => exactObject(step, ["changes"]) && validChanges(step.changes));

// The recent conversation the page shows as sent: at most this many earlier
// utterances Jev judged, each at most this long - longer ones are left out
// by the page, never shortened.
const CONTEXT_MAX = 5;
const CONTEXT_TEXT_MAX = 200;

const CONTEXT_SOURCES = ["voice", "typed"];
const CONTEXT_OUTCOMES = ["step", "no-change", "undo-request", "refused", "undone"];

// An earlier utterance and what came of it. Only a step - one not undone -
// carries the effect it had then, and that effect is history, not the current
// graph.
const validContextEntry = entry =>
  exactObject(entry, entry?.outcome === "step"
    ? ["seq", "source", "text", "outcome", "effect"]
    : ["seq", "source", "text", "outcome"]) &&
  Number.isSafeInteger(entry.seq) && entry.seq >= 1 &&
  CONTEXT_SOURCES.includes(entry.source) &&
  typeof entry.text === "string" && entry.text.trim().length > 0 && entry.text.length <= CONTEXT_TEXT_MAX &&
  CONTEXT_OUTCOMES.includes(entry.outcome) &&
  (entry.outcome !== "step" || (exactObject(entry.effect, ["changes"]) && validChanges(entry.effect.changes)));

const validContext = value =>
  exactObject(value, ["recent"]) &&
  Array.isArray(value.recent) &&
  value.recent.length <= CONTEXT_MAX &&
  value.recent.every(validContextEntry) &&
  value.recent.every((entry, index) => index === 0 || entry.seq > value.recent[index - 1].seq);

// v7 sends Jev one named state object: the utterance, the working graph it is
// spoken into, the effect of every unapplied step in order, the focus (the
// latest step, else the latest applied change), and the recent conversation -
// earlier utterances as unverified material for resolving references. An
// effect may now be a part as well as an edge. No saved graph, no log or hash,
// no list of actions - the questions carry the options.
const validRequestV7 = value =>
  exactObject(value, ["kind", "state"]) &&
  value.kind === "voice-ui.jev.request.v7" &&
  exactObject(value.state, ["utterance", "working", "draft", "focus", "context"]) &&
  validStepState(value.state);

// v8 is v7 plus one field: the placement the previous utterance nearly made,
// held for this one utterance only. It names the one piece that did not come
// through and the pieces that did - part ids and a side, nothing else, never
// text. null when nothing is pending. The questions are the same as v7's, so an
// unrelated or complete instruction is judged exactly as it would be otherwise.
const PLACEMENT_SLOTS = ["move", "anchor", "direction"];
const validPending = (pending, placeable) =>
  pending === null || (
    exactObject(pending, ["missing", "move", "anchor", "direction"]) &&
    PLACEMENT_SLOTS.includes(pending.missing) &&
    placeable.length >= 2 &&
    PLACEMENT_SLOTS.every(slot => slot === pending.missing
      ? pending[slot] === null
      : slot === "direction"
        ? DIRECTIONS.includes(pending[slot])
        : placeable.includes(pending[slot])) &&
    (pending.move === null || pending.anchor === null || pending.move !== pending.anchor)
  );

const validRequestV8 = value =>
  exactObject(value, ["kind", "state"]) &&
  value.kind === "voice-ui.jev.request.v8" &&
  exactObject(value.state, ["utterance", "working", "draft", "focus", "context", "pending"]) &&
  validStepState(value.state) &&
  validPending(value.state.pending, value.state.working.placeable);

// v9 is v8 plus the whole diagrams the page can compose: for each, a key and
// what it is for, and nothing more. The page owns every candidate's roles,
// steps, labels and links; Jev only chooses a key, or none.
const CANDIDATE_MAX = 8;
const CANDIDATE_PURPOSE_MAX = 300;
const validCandidates = value =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= CANDIDATE_MAX &&
  value.every(candidate =>
    exactObject(candidate, ["key", "purpose"]) &&
    typeof candidate.key === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(candidate.key) &&
    candidate.key !== NONE &&
    typeof candidate.purpose === "string" &&
    candidate.purpose.trim().length > 0 &&
    candidate.purpose.length <= CANDIDATE_PURPOSE_MAX) &&
  new Set(value.map(candidate => candidate.key)).size === value.length;

const validRequestV9 = value =>
  exactObject(value, ["kind", "state"]) &&
  value.kind === "voice-ui.jev.request.v9" &&
  exactObject(value.state, ["utterance", "working", "draft", "focus", "context", "pending", "candidates"]) &&
  validStepState(value.state) &&
  validPending(value.state.pending, value.state.working.placeable) &&
  validCandidates(value.state.candidates);

function validStepState(state) {
  const value = { state };
  return validContext(value.state.context) &&
  validText(value.state.utterance) &&
  exactObject(value.state.working, ["regions", "edges", "placeable"]) &&
  Array.isArray(value.state.working.placeable) &&
  value.state.working.placeable.length <= 64 &&
  value.state.working.placeable.every(id => value.state.working.regions.includes(id)) &&
  new Set(value.state.working.placeable).size === value.state.working.placeable.length &&
  validRegions(value.state.working.regions) &&
  !value.state.working.regions.includes(NONE) &&
  validEdges(value.state.working.edges, value.state.working.regions) &&
  value.state.working.edges.every(edge => edge.id !== NONE) &&
  validDraft(value.state.draft) &&
  validFocus(value.state.focus);
}

const typedAnswer = value => {
  const answer = value?.answers?.live;
  if (
    typeof value?.model !== "string" ||
    answer?.type !== "noul" ||
    typeof answer?.noul !== "number" ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new TypeError("provider typed contract mismatch");
  }
  return { model: value.model, noul: answer.noul };
};

const ACTIONS = ["add-edge", "none"];

// A choice question offers its alternatives as a criteria map keyed by the
// value to be returned; the answer carries its own confidence and a
// probabilities map over those same keys.
const criteria = (keys, describe) =>
  Object.fromEntries(keys.map(key => [key, describe(key)]));

const plainObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const inUnit = value => typeof value === "number" && Number.isFinite(value)
  && value >= 0 && value <= 1;

const choice = (answers, name, keys) => {
  const answer = answers?.[name];
  const probabilities = answer?.probabilities;
  if (
    answer?.type !== "choice" ||
    typeof answer.choice !== "string" ||
    !keys.includes(answer.choice) ||
    !inUnit(answer.confidence) ||
    !plainObject(probabilities) ||
    !Object.keys(probabilities).every(key => keys.includes(key)) ||
    !Object.values(probabilities).every(
      value => typeof value === "number" && Number.isFinite(value),
    )
  ) {
    throw new TypeError("provider typed contract mismatch");
  }
  return { type: "choice", choice: answer.choice, confidence: answer.confidence };
};

const typedDecision = (value, regions) => {
  if (typeof value?.model !== "string") {
    throw new TypeError("provider typed contract mismatch");
  }
  const answers = value.answers;
  return {
    model: value.model,
    answers: {
      action: choice(answers, "action", ACTIONS),
      source: choice(answers, "source", regions),
      target: choice(answers, "target", regions),
    },
  };
};

// How long the provider gets to answer, headers and body together. Measured on
// 2026-09-24 through the dev server against the live provider, 56 v4 calls:
// median about 0.3 s, slowest 0.92 s, and 0.65-0.81 s for a first call after an
// idle gap. Ten seconds is more than ten times the slowest; a provider that has
// not answered by then is treated as not answering, and the page is told so
// rather than left waiting.
const PROVIDER_TIMEOUT_MS = 10000;

// Returns the provider's body text, or the error response to send instead.
const callProvider = async (env, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const provider = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.JEV_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!provider.ok) return { error: json({ error: "provider_error" }, 502) };
    return { text: await provider.text() };
  } catch {
    return controller.signal.aborted
      ? { error: json({ error: "provider_timeout" }, 504) }
      : { error: json({ error: "provider_unreachable" }, 502) };
  } finally {
    clearTimeout(timer);
  }
};

async function decideGraphEdge(input, env) {
  const regions = input.graph.regions;
  const { text, error } = await callProvider(env, {
    model: "jev-latest",
    state: input.text,
    questions: {
      action: {
        type: "choice",
        instructions:
          "Does this request ask to add one directed edge between two existing nodes?",
        criteria: criteria(ACTIONS, action => action === "add-edge"
          ? "the request asks to add one directed edge between two existing nodes"
          : "the request asks for anything else"),
      },
      source: {
        type: "choice",
        instructions: "Which existing node is the source of the edge?",
        criteria: criteria(regions, region => `the edge starts at ${region}`),
      },
      target: {
        type: "choice",
        instructions: "Which existing node is the target of the edge?",
        criteria: criteria(regions, region => `the edge ends at ${region}`),
      },
    },
  });
  if (error) return error;

  let result;
  try {
    result = typedDecision(JSON.parse(text), regions);
  } catch {
    return json({ error: "provider_contract_error" }, 502);
  }

  return json({
    kind: "voice-ui.jev.decision.v2",
    model: result.model,
    answers: result.answers,
  });
}

const STEP_ACTIONS = {
  "add-edge": "the utterance asks to add one directed edge between two nodes of the working graph",
  "add-part": "the utterance asks to add one new part, node, box or step to the graph itself",
  "place-part": "the utterance asks to move one part next to another one - beside, above or below it",
  "remove-edge": "the utterance asks to remove one edge of the working graph",
  "reverse-edge": "the utterance asks to reverse the direction of one edge of the working graph",
  "undo-request": "the utterance asks to undo, take back or go back on an earlier change",
  "compose-diagram": "the utterance asks for a whole diagram or chart by what it is for, rather than one edit",
  none: "the utterance asks for anything else, or for no change to the graph",
};

// Every question is told what the recent conversation is and is not: it may
// explain what a word in the utterance refers to, but it is unverified, and
// the utterance, the working graph and the focus decide.
const CONTEXT_NOTE = " context.recent lists earlier utterances as they were recognized or typed, and what came of each."
  + " They are unverified and may be misrecognized. Use them only to understand what the current utterance refers to;"
  + " the current utterance, the working graph and the focus are the facts, and an earlier effect is history, not the current graph.";

// The kinds of part the page offers. The app owns the list, the name and the
// place; Jev only says which kind was asked for, so no answer can invent a
// shape the graph cannot draw.
const PART_KINDS = {
  step: "the utterance asks for an ordinary step, task or box",
  decision: "the utterance asks for a decision, choice or branch",
  data: "the utterance asks for data, a document, an input or an output",
  start: "the utterance asks for a start or beginning",
  end: "the utterance asks for an end, finish or result",
  none: "the utterance asks for no new part, or names a kind that is not offered",
};

// The state is sent to Jev as the named object it arrived as, per the TypeSafe
// guidance that state carries the content and the questions carry only the
// judgments. Nothing here interprets the utterance or the context.
async function decideStep(input, env) {
  const { state } = input;
  const { regions, edges } = state.working;
  // Remove and reverse need an edge, so they are only offered when there is
  // one, and the edge question is asked only then. Every slot offers "none".
  const placeable = state.working.placeable;
  const canPlace = placeable.length >= 2;
  // Whole diagrams are offered only when the request carries candidates.
  const candidates = state.candidates ?? [];
  const canCompose = candidates.length > 0;
  const actions = [
    "add-edge",
    "add-part",
    ...(canPlace ? ["place-part"] : []),
    ...(edges.length > 0 ? ["remove-edge", "reverse-edge"] : []),
    ...(canCompose ? ["compose-diagram"] : []),
    "undo-request",
    "none",
  ];
  const nodeKeys = [...regions, NONE];
  const edgeKeys = [...edges.map(edge => edge.id), NONE];
  const partKeys = Object.keys(PART_KINDS);

  const questions = {
    action: {
      type: "choice",
      instructions: "Which change to the working graph does the utterance ask for? "
        + "A follow-up such as \"that\" refers to the focus.",
      criteria: criteria(actions, action => STEP_ACTIONS[action]),
    },
    source: {
      type: "choice",
      instructions: "If the utterance asks to add an edge, which node of the working graph does it start at?",
      criteria: criteria(nodeKeys, key => key === NONE
        ? "the utterance names no node of the working graph as the start"
        : `the edge starts at ${key}`),
    },
    target: {
      type: "choice",
      instructions: "If the utterance asks to add an edge, which node of the working graph does it end at?",
      criteria: criteria(nodeKeys, key => key === NONE
        ? "the utterance names no node of the working graph as the end"
        : `the edge ends at ${key}`),
    },
    part: {
      type: "choice",
      instructions: "If the utterance asks to add a new part to the graph, which kind of part is it?",
      criteria: criteria(partKeys, key => PART_KINDS[key]),
    },
  };
  if (canPlace) {
    const placeKeys = [...placeable, NONE];
    const directionKeys = [...DIRECTIONS, NONE];
    questions.move = {
      type: "choice",
      instructions: "If the utterance asks to move a part next to another one, which part is being moved?",
      criteria: criteria(placeKeys, key => key === NONE
        ? "the utterance asks to move no part"
        : `the part ${key} is the one being moved`),
    };
    questions.anchor = {
      type: "choice",
      instructions: "If the utterance asks to move a part next to another one, which part is it being put beside?",
      criteria: criteria(placeKeys, key => key === NONE
        ? "the utterance names no part to put it beside"
        : `it is put beside the part ${key}`),
    };
    questions.direction = {
      type: "choice",
      instructions: "If the utterance asks to move a part next to another one, which side of that part does it go?",
      criteria: criteria(directionKeys, key => key === NONE
        ? "the utterance names no side"
        : `it goes to the ${key} of the other part`),
    };
    // The previous utterance nearly placed a part and lacked only this piece.
    // Say so on that one question, so that a reply naming just the missing
    // piece can be answered - and leave every other question as it is, so a
    // complete or unrelated instruction is judged exactly as without it.
    const pending = state.pending ?? null;
    if (pending !== null) {
      questions[pending.missing] = {
        ...questions[pending.missing],
        instructions: questions[pending.missing].instructions
          + " state.pending is a placement the previous utterance nearly made, lacking only this piece."
          + " If the utterance only supplies this piece for it - for example by naming just a part or a side -"
          + " answer with that. Otherwise answer from the utterance as usual.",
      };
    }
  }
  if (edges.length > 0) {
    const byId = new Map(edges.map(edge => [edge.id, edge]));
    questions.edge = {
      type: "choice",
      // An edge the utterance names by its two nodes wins. The focus only
      // resolves a reference such as "that edge" when no edge is named - it may
      // describe a change whose edge no longer exists, and must not outweigh an
      // explicit name.
      instructions: "If the utterance asks to remove or reverse an edge, which edge of the working graph does it mean? "
        + "If it names the edge by its two nodes, choose that edge. "
        + "Only if it names no edge and refers to one (for example \"that edge\"), choose the edge the focus describes.",
      criteria: criteria(edgeKeys, key => key === NONE
        ? "the utterance refers to no edge of the working graph"
        : `the edge from ${byId.get(key).from} to ${byId.get(key).to}`),
    };
  }
  if (canCompose) {
    const diagramKeys = [...candidates.map(candidate => candidate.key), NONE];
    const purposeOf = new Map(candidates.map(candidate => [candidate.key, candidate.purpose]));
    questions.diagram = {
      type: "choice",
      instructions: "If the utterance asks for a whole diagram or chart by what it is for, which of state.candidates is it? "
        + "Choose a candidate only if its purpose is what the utterance asks for; "
        + "if it asks for a kind of diagram that is not among them, answer none.",
      criteria: criteria(diagramKeys, key => key === NONE
        ? "the utterance asks for no whole diagram, or for a kind of diagram that is not among the candidates"
        : `the utterance asks for ${purposeOf.get(key)}`),
    };
  }
  for (const question of Object.values(questions)) question.instructions += CONTEXT_NOTE;

  const { text, error } = await callProvider(env, { model: "jev-latest", state, questions });
  if (error) return error;

  let result;
  try {
    const value = JSON.parse(text);
    if (typeof value?.model !== "string") throw new TypeError("provider typed contract mismatch");
    const answers = {
      action: choice(value.answers, "action", actions),
      source: choice(value.answers, "source", nodeKeys),
      target: choice(value.answers, "target", nodeKeys),
      part: choice(value.answers, "part", partKeys),
    };
    if (canPlace) {
      answers.move = choice(value.answers, "move", [...placeable, NONE]);
      answers.anchor = choice(value.answers, "anchor", [...placeable, NONE]);
      answers.direction = choice(value.answers, "direction", [...DIRECTIONS, NONE]);
    }
    if (edges.length > 0) answers.edge = choice(value.answers, "edge", edgeKeys);
    if (canCompose) {
      answers.diagram = choice(value.answers, "diagram", [...candidates.map(candidate => candidate.key), NONE]);
    }
    result = { model: value.model, answers };
  } catch {
    return json({ error: "provider_contract_error" }, 502);
  }

  return json({
    kind: "voice-ui.jev.decision.v4",
    model: result.model,
    answers: result.answers,
  });
}

export async function onRequestPost({ request, env }) {
  if (typeof env?.JEV_API_KEY !== "string" || env.JEV_API_KEY.length === 0) {
    return json({ error: "jev_unavailable" }, 503);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (validRequestV9(input) || validRequestV8(input) || validRequestV7(input)) return decideStep(input, env);
  if (validRequestV2(input)) return decideGraphEdge(input, env);
  if (!validRequest(input)) return json({ error: "invalid_request" }, 422);

  const { text, error } = await callProvider(env, {
    model: "jev-latest",
    state: input.text,
    questions: {
      live: {
        type: "noul",
        instructions: "Is this state a valid user request for this application?",
      },
    },
  });
  if (error) return error;

  let result;
  try {
    result = typedAnswer(JSON.parse(text));
  } catch {
    return json({ error: "provider_contract_error" }, 502);
  }

  return json({
    kind: "ui.ir.v1",
    capability: "a2ui-browser",
    payloadKind: "a2ui.surface.v1",
    payload: {
      components: [
        { id: "root", component: "Column", children: ["input", "score", "model"], gap: 8 },
        { id: "input", component: "Text", path: "/input", variant: "body" },
        { id: "score", component: "Text", path: "/score", variant: "h2" },
        { id: "model", component: "Text", path: "/model", variant: "caption" },
      ],
      dataModel: {
        input: input.text,
        score: "Jev Noul: " + result.noul.toFixed(3),
        model: result.model,
      },
    },
  });
}
