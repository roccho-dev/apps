export const DECISION_KIND = "voice-ui.jev.decision.v2";
export const GRAPH_PATTERN = "graph/1";
export const RELATION_KIND = "flow";
export const ACTION_ADD_EDGE = "add-edge";
export const ACTION_NONE = "none";
export const MIN_CONFIDENCE = 0.5;

export class DecisionRefused extends Error {
  constructor(reason) {
    super(`decision refused: ${reason}`);
    this.name = "DecisionRefused";
    this.reason = reason;
  }
}

const refuse = (condition, reason) => {
  if (!condition) throw new DecisionRefused(reason);
};

// Endpoints are the regions the current graph actually offers. The enclosing
// boundary region (parent === null) is structure, not a selectable endpoint.
export function selectableRegionIds(records) {
  refuse(Array.isArray(records), "records must be an array");
  return Object.freeze(
    records
      .filter(record => record?.type === "region" && record.parent !== null)
      .map(record => record.id),
  );
}

export function relationKey(from, to) {
  // JSON keeps the pair injective without needing a separator character, so
  // the source stays plain ASCII and the file keeps a reviewable diff.
  return JSON.stringify([from, to]);
}

export function relationKeys(records) {
  return new Set(
    (records ?? [])
      .filter(record => record?.type === "relation")
      .map(record => relationKey(record.from, record.to)),
  );
}

// The finite criteria Jev is allowed to choose from. Option values are region
// ids verbatim so the answer needs no decoding table on either side.
export function buildCriteria(records) {
  const regions = selectableRegionIds(records);
  refuse(regions.length >= 2, "graph has fewer than two selectable regions");
  return Object.freeze({
    actions: Object.freeze([ACTION_ADD_EDGE, ACTION_NONE]),
    regions,
  });
}

// Each choice answer carries its own confidence, so there is no separate
// confidence answer to read.
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

export function validateAnswers(answers, criteria) {
  refuse(
    answers !== null && typeof answers === "object" && !Array.isArray(answers),
    "answers must be an object",
  );
  const expected = ["action", "source", "target"];
  for (const key of expected) refuse(Object.hasOwn(answers, key), `answers.${key} is required`);
  for (const key of Object.keys(answers)) refuse(expected.includes(key), `answers.${key} is not allowed`);

  const action = choiceOf(answers, "action", criteria.actions);
  const source = choiceOf(answers, "source", criteria.regions);
  const target = choiceOf(answers, "target", criteria.regions);

  // The weakest answer governs: every part of the decision must clear the bar.
  const confidence = Math.min(action.confidence, source.confidence, target.confidence);

  refuse(action.choice === ACTION_ADD_EDGE, "action is not add-edge");
  refuse(confidence >= MIN_CONFIDENCE, "confidence is below the pinned threshold");
  refuse(source.choice !== target.choice, "source and target are the same region");

  return Object.freeze({
    action: action.choice,
    source: source.choice,
    target: target.choice,
    confidence,
  });
}

export function relationIdFor(source, target) {
  return `voice-${source}-to-${target}`;
}

// Pure projection: the same verified graph and the same answers always yield the
// same envelope. `graph` is a verified decision log ({log, head, records}) and
// `protocol` is the pinned semantic-map codec, injected the same way app.mjs and
// render.mjs take their collaborators.
export async function compileDecision({ graph, answers, protocol } = {}) {
  refuse(typeof graph?.log === "string" && graph.log.length > 0, "graph.log must be a non-empty string");
  refuse(typeof graph?.head === "string" && graph.head.length > 0, "graph.head must be a non-empty string");
  refuse(typeof protocol?.createDecision === "function", "protocol.createDecision is required");
  refuse(typeof protocol?.createEnvelope === "function", "protocol.createEnvelope is required");

  const records = graph.records;
  const criteria = buildCriteria(records);
  const decided = validateAnswers(answers, criteria);

  refuse(
    !relationKeys(records).has(relationKey(decided.source, decided.target)),
    "relation already exists",
  );

  const { decision } = await protocol.createDecision(
    graph.head,
    [{
      type: "ConnectRegions",
      relationId: relationIdFor(decided.source, decided.target),
      from: decided.source,
      to: decided.target,
      kind: RELATION_KIND,
      label: "",
    }],
    records,
  );
  const envelope = await protocol.createEnvelope(graph.log, decision, { pattern: GRAPH_PATTERN });

  return Object.freeze({
    kind: "ui.ir.v1",
    capability: "render.semantic-map",
    payloadKind: "semantic-map-envelope/3",
    payload: envelope,
  });
}
