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

const validChange = change =>
  exactObject(change, ["change", "from", "to"]) &&
  (change.change === "added" || change.change === "removed") &&
  validId(change.from) &&
  validId(change.to);

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

// v4 sends Jev one named state object: the utterance, the working graph it is
// spoken into, the effect of every unapplied step in order, and the focus (the
// latest step, else the latest applied change). No earlier utterances, no saved
// graph, no log or hash, no list of actions - the questions carry the options.
const validRequestV4 = value =>
  exactObject(value, ["kind", "state"]) &&
  value.kind === "voice-ui.jev.request.v4" &&
  exactObject(value.state, ["utterance", "working", "draft", "focus"]) &&
  validText(value.state.utterance) &&
  exactObject(value.state.working, ["regions", "edges"]) &&
  validRegions(value.state.working.regions) &&
  !value.state.working.regions.includes(NONE) &&
  validEdges(value.state.working.edges, value.state.working.regions) &&
  value.state.working.edges.every(edge => edge.id !== NONE) &&
  validDraft(value.state.draft) &&
  validFocus(value.state.focus);

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

const callProvider = async (env, body) => {
  let provider;
  try {
    provider = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.JEV_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: json({ error: "provider_unreachable" }, 502) };
  }
  if (!provider.ok) return { error: json({ error: "provider_error" }, 502) };
  return { provider };
};

async function decideGraphEdge(input, env) {
  const regions = input.graph.regions;
  const { provider, error } = await callProvider(env, {
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
    result = typedDecision(await provider.json(), regions);
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
  "remove-edge": "the utterance asks to remove one edge of the working graph",
  "reverse-edge": "the utterance asks to reverse the direction of one edge of the working graph",
  "undo-request": "the utterance asks to undo, take back or go back on an earlier change",
  none: "the utterance asks for anything else, or for no change to the graph",
};

// The state is sent to Jev as the named object it arrived as, per the TypeSafe
// guidance that state carries the content and the questions carry only the
// judgments. Nothing here interprets the utterance.
async function decideStep(input, env) {
  const { state } = input;
  const { regions, edges } = state.working;
  // Remove and reverse need an edge, so they are only offered when there is
  // one, and the edge question is asked only then. Every slot offers "none".
  const actions = edges.length > 0
    ? ["add-edge", "remove-edge", "reverse-edge", "undo-request", "none"]
    : ["add-edge", "undo-request", "none"];
  const nodeKeys = [...regions, NONE];
  const edgeKeys = [...edges.map(edge => edge.id), NONE];

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
  };
  if (edges.length > 0) {
    const byId = new Map(edges.map(edge => [edge.id, edge]));
    questions.edge = {
      type: "choice",
      instructions: "If the utterance asks to remove or reverse an edge, which edge of the working graph? "
        + "\"That edge\" means the edge named by the focus.",
      criteria: criteria(edgeKeys, key => key === NONE
        ? "the utterance refers to no edge of the working graph"
        : `the edge from ${byId.get(key).from} to ${byId.get(key).to}`),
    };
  }

  const { provider, error } = await callProvider(env, { model: "jev-latest", state, questions });
  if (error) return error;

  let result;
  try {
    const value = await provider.json();
    if (typeof value?.model !== "string") throw new TypeError("provider typed contract mismatch");
    const answers = {
      action: choice(value.answers, "action", actions),
      source: choice(value.answers, "source", nodeKeys),
      target: choice(value.answers, "target", nodeKeys),
    };
    if (edges.length > 0) answers.edge = choice(value.answers, "edge", edgeKeys);
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
  if (validRequestV4(input)) return decideStep(input, env);
  if (validRequestV2(input)) return decideGraphEdge(input, env);
  if (!validRequest(input)) return json({ error: "invalid_request" }, 422);

  const { provider, error } = await callProvider(env, {
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
    result = typedAnswer(await provider.json());
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
