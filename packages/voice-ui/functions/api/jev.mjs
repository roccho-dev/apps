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

const FOCUS_KINDS = ["none", "proposal", "confirmed"];

const validFocus = value =>
  exactObject(value, ["kind", "changes"]) &&
  FOCUS_KINDS.includes(value.kind) &&
  Array.isArray(value.changes) &&
  value.changes.length <= 8 &&
  (value.kind === "none") === (value.changes.length === 0) &&
  value.changes.every(change =>
    exactObject(change, ["change", "from", "to"]) &&
    (change.change === "added" || change.change === "removed") &&
    validId(change.from) &&
    validId(change.to));

// v3 carries what the user can see: every node and edge on the graph, and the
// change they are looking at - an unsaved proposal or the last confirmed one -
// so a follow-up like "reverse that" can be judged against it.
const validRequestV3 = value =>
  exactObject(value, ["kind", "text", "graph", "focus"]) &&
  value.kind === "voice-ui.jev.request.v3" &&
  validText(value.text) &&
  exactObject(value.graph, ["regions", "edges"]) &&
  validRegions(value.graph.regions) &&
  validEdges(value.graph.edges, value.graph.regions) &&
  validFocus(value.focus);

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

const CORRECTION_ACTIONS = {
  "add-edge": "the request asks to add one directed edge between two existing nodes",
  "remove-edge": "the request asks to remove one existing edge",
  "reverse-edge": "the request asks to reverse the direction of one existing edge",
  none: "the request asks for anything else, or for no change to the graph",
};

const arrow = ({ from, to }) => `${from} -> ${to}`;

// The situation the request is spoken into, stated from the request's own
// structured fields. Jev judges the request against it; nothing here tries to
// interpret the request text.
const situation = ({ graph, focus }) => {
  const edges = graph.edges.length > 0
    ? `The graph currently has these edges: ${graph.edges.map(arrow).join(", ")}.`
    : "The graph currently has no edges.";
  const looking = focus.changes.map(change => `${change.change} the edge ${arrow(change)}`).join(" and ");
  const attention = focus.kind === "proposal"
    ? ` The user is looking at an unsaved proposal that has ${looking}; a follow-up may refer to it.`
    : focus.kind === "confirmed"
      ? ` The user just confirmed a change that ${looking}; a follow-up may refer to it.`
      : "";
  return edges + attention;
};

async function decideCorrection(input, env) {
  const { regions, edges } = input.graph;
  // Remove and reverse need an existing edge, so they are only offered when
  // there is one; the edge question is asked only then.
  const actions = edges.length > 0
    ? ["add-edge", "remove-edge", "reverse-edge", "none"]
    : ["add-edge", "none"];
  const context = situation(input);

  const questions = {
    action: {
      type: "choice",
      instructions: `${context} Which change to the graph does this request ask for?`,
      criteria: criteria(actions, action => CORRECTION_ACTIONS[action]),
    },
    source: {
      type: "choice",
      instructions: "If an edge is to be added, which existing node does it start at?",
      criteria: criteria(regions, region => `the edge starts at ${region}`),
    },
    target: {
      type: "choice",
      instructions: "If an edge is to be added, which existing node does it end at?",
      criteria: criteria(regions, region => `the edge ends at ${region}`),
    },
  };
  if (edges.length > 0) {
    const byId = new Map(edges.map(edge => [edge.id, edge]));
    questions.edge = {
      type: "choice",
      instructions: `${context} If an existing edge is to be removed or reversed, which one?`,
      criteria: criteria(edges.map(edge => edge.id), id => `the edge from ${arrow(byId.get(id))}`),
    };
  }

  const { provider, error } = await callProvider(env, { model: "jev-latest", state: input.text, questions });
  if (error) return error;

  let result;
  try {
    const value = await provider.json();
    if (typeof value?.model !== "string") throw new TypeError("provider typed contract mismatch");
    const answers = {
      action: choice(value.answers, "action", actions),
      source: choice(value.answers, "source", regions),
      target: choice(value.answers, "target", regions),
    };
    if (edges.length > 0) answers.edge = choice(value.answers, "edge", edges.map(edge => edge.id));
    result = { model: value.model, answers };
  } catch {
    return json({ error: "provider_contract_error" }, 502);
  }

  return json({
    kind: "voice-ui.jev.decision.v3",
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
  if (validRequestV3(input)) return decideCorrection(input, env);
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
