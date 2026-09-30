import {
  ACTION_ARCHITECTURE,
  KEY_PATTERN,
  LABEL_MAX,
  MIN_CONFIDENCE,
  NONE,
  readAnswers,
  relationSlot,
  roleSlot,
  slotsFor,
} from "./contract.mjs";
import { ORIGIN_MODEL, ORIGIN_SOURCE, ORIGIN_UNKNOWN } from "./document.mjs";
import { OUTCOME_NO_CHANGE, OUTCOME_REFUSED, OUTCOME_STEP } from "./turn.mjs";

// The architecture view of one prepared source snapshot. The manifest is the
// only authority for what exists: admitted files as entities, the entities the
// scope names outside them, static imports, the candidate pairs Jev may judge,
// declared facts and the vocabulary. Jev only chooses, from closed options, a
// role per entity, a relation (or none) per candidate pair and a focus; this
// module turns those choices into the provider's own operations and says,
// for every record, where it comes from. It invents no entity, label or
// relation, and never calls a model-selected relation source-declared.

const MANIFEST_SCHEMA = "voice-ui.architecture-source/1";
const COMMIT = /^[0-9a-f]{40}$/u;

const IMPORT_KIND = "imports";
const DECLARES_KIND = "declares";
const NODE_KIND = "node";
const REGION_PREFIX = "arch-";
const FACT_PREFIX = "arch-fact-";

// New regions sit on a fixed grid below what is already drawn; the view lays
// the graph out itself, and the provider only needs real, non-overlapping bounds.
const PART_WIDTH = 140;
const PART_HEIGHT = 64;
const PART_GAP = 20;
const COLUMNS = 5;

const demand = (condition, reason) => {
  if (!condition) throw new TypeError(`voice-ui architecture: ${reason}`);
};

const exactObject = (value, keys) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

const text = value => typeof value === "string" && value.trim().length > 0;
const key = value => typeof value === "string" && KEY_PATTERN.test(value) && value !== NONE;
const deepFreeze = value => {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const validFile = file => typeof file?.path === "string" && typeof file.blob === "string" && (
  (exactObject(file, ["path", "blob", "class", "entity"]) && file.class === "admitted" && key(file.entity))
  || (exactObject(file, ["path", "blob", "class", "reason"]) && file.class === "excluded" && text(file.reason)));
const validEntity = entity =>
  (exactObject(entity, ["id", "label", "kind", "path"]) && entity.kind === "file" && typeof entity.path === "string")
  || (exactObject(entity, ["id", "label", "kind"]) && entity.kind === "external");
const validVocabulary = list => Array.isArray(list) && list.length > 0
  && list.every(entry => exactObject(entry, ["key", "purpose"]) && key(entry.key) && text(entry.purpose));

// The public manifest, checked whole: available and exactly this shape, or
// unavailable with the reason the preparation gave, or invalid.
export function readManifest(value) {
  if (exactObject(value, ["schema", "status", "reason"]) && value.schema === MANIFEST_SCHEMA && value.status === "unavailable") {
    return Object.freeze({ status: "unavailable", reason: String(value.reason) });
  }
  const invalid = reason => Object.freeze({ status: "invalid", reason });
  if (!exactObject(value, ["schema", "status", "source", "files", "entities", "imports", "candidates", "facts", "roles", "relations", "coverage"])
    || value.schema !== MANIFEST_SCHEMA || value.status !== "available") return invalid(`not an available ${MANIFEST_SCHEMA}`);
  if (!exactObject(value.source, ["handle", "commit"]) || !key(value.source.handle) || !COMMIT.test(value.source.commit ?? "")) {
    return invalid("source must name a handle and an exact commit");
  }
  if (!Array.isArray(value.files) || !value.files.every(validFile)) return invalid("files are not well-formed");
  if (!Array.isArray(value.entities) || !value.entities.every(entity => validEntity(entity) && key(entity.id)
    && text(entity.label) && entity.label.length <= LABEL_MAX)) return invalid("entities are not well-formed");
  const ids = value.entities.map(entity => entity.id);
  if (new Set(ids).size !== ids.length) return invalid("entity ids repeat");
  if (!Array.isArray(value.imports) || !value.imports.every(edge => exactObject(edge, ["from", "to", "path", "specifier"])
    && ids.includes(edge.from) && ids.includes(edge.to))) return invalid("imports are not well-formed");
  if (!Array.isArray(value.candidates) || !value.candidates.every(candidate => exactObject(candidate, ["id", "from", "to", "reasons"])
    && ids.includes(candidate.from) && ids.includes(candidate.to) && candidate.from !== candidate.to
    && Array.isArray(candidate.reasons) && candidate.reasons.length > 0)) return invalid("candidates are not well-formed");
  if (!Array.isArray(value.facts) || !value.facts.every(fact => exactObject(fact, ["id", "entity", "path", "pointer", "value"])
    && key(fact.id) && ids.includes(fact.entity) && ["string", "number", "boolean"].includes(typeof fact.value))) return invalid("facts are not well-formed");
  if (!validVocabulary(value.roles) || !validVocabulary(value.relations)) return invalid("the vocabulary is not well-formed");
  if (!exactObject(value.coverage, ["unsupported", "skipped", "notAnalyzed"])) return invalid("coverage is not well-formed");
  return deepFreeze(structuredClone(value));
}

// What the page sends Jev about the snapshot: its identity, entities with
// their labels, candidate pairs with why they are candidates, and the
// vocabulary. The server checks it against its own copy and adds the evidence.
export function architectureOf(manifest) {
  demand(manifest?.status === "available", "an available manifest is required");
  return deepFreeze({
    source: { ...manifest.source },
    entities: manifest.entities.map(entity => ({ id: entity.id, label: entity.label })),
    candidates: manifest.candidates.map(candidate => ({ id: candidate.id, from: candidate.from, to: candidate.to, reasons: [...candidate.reasons] })),
    roles: manifest.roles.map(role => ({ ...role })),
    relations: manifest.relations.map(relation => ({ ...relation })),
  });
}

// A request as the plain turn built it, with the architecture section and
// the questions that come with it.
export function withArchitecture({ turn, request }, manifest) {
  const state = Object.freeze({ ...request.state, architecture: architectureOf(manifest) });
  return Object.freeze({
    turn: Object.freeze({ ...turn, slots: slotsFor(state) }),
    request: Object.freeze({ ...request, state }),
  });
}

const regionIdOf = entityId => `${REGION_PREFIX}${entityId}`;
const factIdOf = factId => `${FACT_PREFIX}${factId}`;
const importIdOf = (from, to) => `${REGION_PREFIX}import-${from}-to-${to}`;
const relationIdOf = (relation, from, to) => `${REGION_PREFIX}${relation}-${from}-to-${to}`;
const declaresIdOf = factId => `${REGION_PREFIX}declares-${factId}`;

const noChange = reason => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason });
const refused = (reason, detail = null) => Object.freeze({ outcome: OUTCOME_REFUSED, reason, ...(detail === null ? {} : { detail }) });

// The step for one compose-architecture answer against the working graph: the
// entities, their static imports, the relations Jev chose among the candidate
// pairs, and - for a focus - the declared facts of the entities in that role.
// Only what the working graph lacks is added, as one Decision. Every region and
// relation gets its claim; every entity also gets the role Jev gave it, or none.
export async function planArchitecture({ working, turn, answers, manifest, protocol }) {
  demand(manifest?.status === "available", "an available manifest is required");
  if (turn.head !== working.head) return refused("stale");
  const read = readAnswers(answers, turn.slots);
  if (read === null) return refused("answer-invalid");
  demand(read.action.choice === ACTION_ARCHITECTURE, "only a compose-architecture answer is planned here");
  if (read.action.confidence < MIN_CONFIDENCE) return noChange("not-confident");

  const confident = slot => (read[slot].choice !== NONE && read[slot].confidence >= MIN_CONFIDENCE ? read[slot].choice : null);
  const roleOf = new Map(manifest.entities.map(entity => [entity.id, confident(roleSlot(entity.id))]));
  const focus = confident("focus");

  const records = working.records;
  const root = records.find(record => record?.type === "region" && record.parent === null);
  const has = id => records.some(record => (record?.type === "region" || record?.type === "relation") && record.id === id);

  const regions = [];
  const relations = [];
  const claims = [];
  for (const entity of manifest.entities) {
    const regionId = regionIdOf(entity.id);
    if (!has(regionId)) {
      regions.push({ regionId, label: entity.label });
      claims.push(entity.kind === "file"
        ? { record: { type: "region", id: regionId }, origin: ORIGIN_SOURCE, basis: [{ path: entity.path }] }
        : { record: { type: "region", id: regionId }, origin: ORIGIN_UNKNOWN, basis: [{ scope: "external" }] });
    }
    const role = roleOf.get(entity.id);
    if (role !== null) claims.push({ record: { type: "region", id: regionId }, origin: ORIGIN_MODEL, basis: [], role });
  }

  // One import edge per pair of entities, citing every import statement it rests on.
  const importsByPair = new Map();
  for (const edge of manifest.imports) {
    const pair = `${edge.from} ${edge.to}`;
    importsByPair.set(pair, [...(importsByPair.get(pair) ?? []), edge]);
  }
  for (const edges of importsByPair.values()) {
    const { from, to } = edges[0];
    const relationId = importIdOf(from, to);
    if (has(relationId)) continue;
    relations.push({ relationId, from: regionIdOf(from), to: regionIdOf(to), kind: IMPORT_KIND, label: "import" });
    claims.push({
      record: { type: "relation", id: relationId },
      origin: ORIGIN_SOURCE,
      basis: edges.map(edge => ({ path: edge.path, specifier: edge.specifier })),
    });
  }

  for (const candidate of manifest.candidates) {
    const relation = confident(relationSlot(candidate.id));
    if (relation === null) continue;
    const relationId = relationIdOf(relation, candidate.from, candidate.to);
    if (has(relationId)) continue;
    relations.push({ relationId, from: regionIdOf(candidate.from), to: regionIdOf(candidate.to), kind: relation, label: relation });
    claims.push({ record: { type: "relation", id: relationId }, origin: ORIGIN_MODEL, basis: [{ candidate: candidate.id }] });
  }

  if (focus !== null) {
    for (const fact of manifest.facts.filter(entry => roleOf.get(entry.entity) === focus)) {
      const regionId = factIdOf(fact.id);
      if (!has(regionId)) {
        regions.push({ regionId, label: `${fact.pointer}: ${String(fact.value)}`.slice(0, LABEL_MAX) });
        claims.push({ record: { type: "region", id: regionId }, origin: ORIGIN_SOURCE, basis: [{ path: fact.path, pointer: fact.pointer }] });
      }
      const relationId = declaresIdOf(fact.id);
      if (!has(relationId)) {
        relations.push({ relationId, from: regionId, to: regionIdOf(fact.entity), kind: DECLARES_KIND, label: DECLARES_KIND });
        claims.push({ record: { type: "relation", id: relationId }, origin: ORIGIN_SOURCE, basis: [{ path: fact.path, pointer: fact.pointer }] });
      }
    }
  }

  if (regions.length === 0 && relations.length === 0) return noChange("architecture-nothing-new");

  const boxes = records.filter(record => record?.type === "region").map(record => record.bounds);
  const top = Math.max(...boxes.map(box => box[1] + box[3])) + PART_GAP;
  const operations = [
    ...regions.map((region, index) => ({
      type: "AddRegion",
      regionId: region.regionId,
      parentId: root.id,
      label: region.label,
      kind: NODE_KIND,
      summary: "",
      bounds: [
        root.bounds[0] + PART_GAP + (index % COLUMNS) * (PART_WIDTH + PART_GAP),
        top + Math.floor(index / COLUMNS) * (PART_HEIGHT + PART_GAP),
        PART_WIDTH,
        PART_HEIGHT,
      ],
    })),
    ...relations.map(relation => ({ type: "ConnectRegions", ...relation })),
  ];
  const changes = [
    ...regions.map(region => ({ change: "added", kind: "region", id: region.regionId, label: region.label })),
    ...relations.map(relation => ({ change: "added", from: relation.from, to: relation.to })),
  ];

  let built;
  try {
    built = await protocol.createDecision(working.head, operations, records);
  } catch (error) {
    return refused("provider-rejected", String(error?.message ?? error));
  }
  const confidence = Math.min(read.action.confidence, ...(focus === null ? [] : [read.focus.confidence]));
  return Object.freeze({
    outcome: OUTCOME_STEP,
    step: Object.freeze({
      revision: working.head,
      action: ACTION_ARCHITECTURE,
      confidence,
      changes: Object.freeze(changes.map(change => Object.freeze(change))),
      decision: built.decision,
    }),
    claims: deepFreeze(claims),
  });
}
