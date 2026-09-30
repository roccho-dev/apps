import {
  ACTION_ARCHITECTURE,
  ARCHITECTURE_INTENT_KIND,
  ARCHITECTURE_JUDGE_KIND,
  KEY_PATTERN,
  LABEL_MAX,
  MIN_CONFIDENCE,
  NONE,
  YES,
  judgeSlotsFor,
  readAnswers,
  relationSlot,
  roleSlot,
  slotsFor,
} from "./contract.mjs";
import { OUTCOME_NO_CHANGE, OUTCOME_REFUSED, OUTCOME_STEP } from "./turn.mjs";

// The architecture view of one prepared source snapshot. The manifest is the
// only authority for what exists: admitted files as entities named by their
// paths, the identifiers the scope names outside them, static imports, the
// candidate pairs Jev may judge, declared facts and the vocabulary. This
// module is the one place that says which graph record stands for what, and
// where each comes from: it builds the records and their claims, and it is
// what a saved document is checked against. Jev only chooses, from closed
// options: which one part to look at (asked with no code at all), and then,
// shown that part's own text, which roles its files have and which relation,
// if any, holds for each of its candidate pairs. Nothing here invents an
// entity, label or relation, or calls a model-selected one source-declared.

const MANIFEST_SCHEMA = "voice-ui.architecture-source/1";
const COMMIT = /^[0-9a-f]{40}$/u;

// Where a claim comes from. Only a file, a static import or a declared fact
// is source-declared; what Jev chose is model-inferred; what the person did is
// user-asserted; what the source names but does not contain is unknown.
export const ORIGIN_SOURCE = "source-declared";
export const ORIGIN_MODEL = "model-inferred";
export const ORIGIN_USER = "user-asserted";
export const ORIGIN_UNKNOWN = "unknown";

const IMPORT_KIND = "imports";
const DECLARES_KIND = "declares";
const NODE_KIND = "node";
const REGION_PREFIX = "arch-";
const FACT_PREFIX = "arch-fact-";
const RESOLUTIONS = Object.freeze(["relative", "scope-url-map", "scope-external-url"]);
const REASON = /^(import|identifier):./u;

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

const scalar = value => ["string", "number", "boolean"].includes(typeof value);
const validFile = file => typeof file?.path === "string" && typeof file.blob === "string" && (
  (exactObject(file, ["path", "blob", "class", "entity"]) && file.class === "admitted" && key(file.entity))
  || (exactObject(file, ["path", "blob", "class", "reason"]) && file.class === "excluded" && text(file.reason)));
// An admitted file is labelled by its own path; anything else by the
// identifier or URL the source uses for it.
const validEntity = entity =>
  (exactObject(entity, ["id", "label", "kind", "path"]) && entity.kind === "file" && entity.label === entity.path)
  || (exactObject(entity, ["id", "label", "kind"]) && entity.kind === "external");
const validFact = fact => exactObject(fact, Object.hasOwn(fact ?? {}, "row")
  ? ["id", "entity", "path", "row", "pointer", "value"] : ["id", "entity", "path", "pointer", "value"])
  && key(fact.id) && typeof fact.path === "string" && typeof fact.pointer === "string"
  && (fact.row === undefined || (Number.isSafeInteger(fact.row) && fact.row >= 1))
  && (scalar(fact.value) || (Array.isArray(fact.value) && fact.value.every(scalar)));
const validVocabulary = list => Array.isArray(list) && list.length > 0
  && list.every(entry => exactObject(entry, ["key", "purpose"]) && key(entry.key) && text(entry.purpose));

// A declared fact as it is drawn: where it is written and what it says.
const factLabel = fact => `${fact.path}${fact.row === undefined ? "" : `:${fact.row}`} ${fact.pointer} = ${JSON.stringify(fact.value)}`;

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
  const pathOf = new Map(value.entities.filter(entity => entity.kind === "file").map(entity => [entity.id, entity.path]));
  if (!Array.isArray(value.imports) || !value.imports.every(edge => exactObject(edge, ["from", "to", "path", "specifier", "resolution"])
    && pathOf.get(edge.from) === edge.path && ids.includes(edge.to) && typeof edge.specifier === "string"
    && RESOLUTIONS.includes(edge.resolution))) return invalid("imports are not well-formed");
  if (!Array.isArray(value.candidates) || !value.candidates.every(candidate => exactObject(candidate, ["id", "from", "to", "reasons"])
    && typeof candidate.id === "string" && ids.includes(candidate.from) && ids.includes(candidate.to) && candidate.from !== candidate.to
    && Array.isArray(candidate.reasons) && candidate.reasons.length > 0
    && candidate.reasons.every(reason => typeof reason === "string" && REASON.test(reason)))) return invalid("candidates are not well-formed");
  if (new Set(value.candidates.map(candidate => candidate.id)).size !== value.candidates.length) return invalid("candidate ids repeat");
  if (!Array.isArray(value.facts) || !value.facts.every(fact => validFact(fact) && pathOf.get(fact.entity) === fact.path
    && factLabel(fact).length <= LABEL_MAX)) return invalid("facts are not well-formed");
  if (new Set(value.facts.map(fact => fact.id)).size !== value.facts.length) return invalid("fact ids repeat");
  if (!validVocabulary(value.roles) || !validVocabulary(value.relations)) return invalid("the vocabulary is not well-formed");
  if (!exactObject(value.coverage, ["unsupported", "skipped", "notAnalyzed"])) return invalid("coverage is not well-formed");
  return deepFreeze(structuredClone(value));
}

// What the page may say about the snapshot with no code at all: its identity
// and its parts, each by its path or identifier. The server checks it against
// its own copy.
export function intentSectionOf(manifest) {
  demand(manifest?.status === "available", "an available manifest is required");
  return deepFreeze({
    source: { ...manifest.source },
    entities: manifest.entities.map(entity => ({ id: entity.id, label: entity.label })),
  });
}

// A request as the plain turn built it, as the architecture page's intent:
// the same state, the snapshot's parts beside it, and the question which one
// part, if any, the utterance asks to see. No code is sent.
export function withArchitecture({ turn, request }, manifest) {
  const state = Object.freeze({ ...request.state, architecture: intentSectionOf(manifest) });
  return Object.freeze({
    turn: Object.freeze({ ...turn, slots: slotsFor(state) }),
    request: Object.freeze({ kind: ARCHITECTURE_INTENT_KIND, state }),
  });
}

// The one part a confident compose-architecture answer asks to see, or null.
export function focusOf(turn, answers) {
  const read = readAnswers(answers, turn.slots);
  if (read === null || read.action.choice !== ACTION_ARCHITECTURE) return null;
  return read.focus.choice !== NONE && read.focus.confidence >= MIN_CONFIDENCE ? read.focus.choice : null;
}

// The part of the snapshot one focus opens, decided by the manifest alone.
// Its body files are the focus's own file, or - for a part outside the
// source - every admitted file whose text names it; its pairs are exactly the
// candidate pairs that touch the focus or a body file; its parts are those
// and their other ends. Null when the focus opens no file.
export function judgeSectionOf(manifest, focus) {
  demand(manifest?.status === "available", "an available manifest is required");
  const byId = new Map(manifest.entities.map(entity => [entity.id, entity]));
  if (!byId.has(focus)) return null;
  const touching = id => manifest.candidates.filter(candidate => candidate.from === id || candidate.to === id);
  const opened = byId.get(focus).kind === "file"
    ? new Set([focus])
    : new Set(touching(focus).map(candidate => (candidate.from === focus ? candidate.to : candidate.from)).filter(id => byId.get(id).kind === "file"));
  if (opened.size === 0) return null;
  const centre = new Set([focus, ...opened]);
  const candidates = manifest.candidates.filter(candidate => centre.has(candidate.from) || centre.has(candidate.to));
  const parts = new Set([...centre, ...candidates.flatMap(candidate => [candidate.from, candidate.to])]);
  return deepFreeze({
    source: { ...manifest.source },
    focus,
    entities: manifest.entities.filter(entity => parts.has(entity.id)).map(entity => ({ id: entity.id, label: entity.label })),
    bodies: manifest.entities.filter(entity => opened.has(entity.id)).map(entity => entity.id),
    candidates: candidates.map(candidate => ({ id: candidate.id, from: candidate.from, to: candidate.to, reasons: [...candidate.reasons] })),
    roles: manifest.roles.map(role => ({ ...role })),
    relations: manifest.relations.map(relation => ({ ...relation })),
  });
}

// The second request of a focused utterance: the utterance and the focused
// section. The server adds that section's text and nothing else.
export function judgeRequestOf(manifest, focus, utterance) {
  const section = judgeSectionOf(manifest, focus);
  return section === null ? null : deepFreeze({ kind: ARCHITECTURE_JUDGE_KIND, state: { utterance, architecture: section } });
}

// The text a judge request is answered from, for the server to add: every
// body file whole; and from every other admitted file of the section, exactly
// the lines holding the text one of its pairs rests on - an import specifier
// or an identifier - each with its path and line number, and nothing around it.
export function focusedEvidence(section, manifest, files) {
  const pathOf = new Map(manifest.entities.filter(entity => entity.kind === "file").map(entity => [entity.id, entity.path]));
  const bodies = section.bodies.map(id => ({ path: pathOf.get(id), text: files[id] }));
  const lines = [];
  for (const { id } of section.entities.filter(entity => pathOf.has(entity.id) && !section.bodies.includes(entity.id))) {
    const tokens = section.candidates.filter(candidate => candidate.from === id || candidate.to === id)
      .flatMap(candidate => candidate.reasons.map(reason => reason.slice(reason.indexOf(":") + 1)));
    files[id].split("\n").forEach((line, index) => {
      if (tokens.some(token => line.includes(token))) lines.push({ path: pathOf.get(id), line: index + 1, text: line });
    });
  }
  return deepFreeze({ bodies, lines });
}

const regionIdOf = entityId => `${REGION_PREFIX}${entityId}`;
const factIdOf = factId => `${FACT_PREFIX}${factId}`;
const importIdOf = (from, to) => `${REGION_PREFIX}import-${from}-to-${to}`;
const relationIdOf = (relation, from, to) => `${REGION_PREFIX}${relation}-${from}-to-${to}`;
const declaresIdOf = factId => `${REGION_PREFIX}declares-${factId}`;

const factBasis = fact => (fact.row === undefined
  ? { path: fact.path, pointer: fact.pointer }
  : { path: fact.path, row: fact.row, pointer: fact.pointer });
const entry = (record, origin, basis) => Object.freeze({
  record: Object.freeze(record),
  claim: Object.freeze({ record: Object.freeze({ type: record.type, id: record.id }), origin, basis: Object.freeze(basis) }),
});

// Every record the snapshot itself grounds, keyed by type and id, with what
// it must look like and the one claim that says where it comes from: a region
// per part and per fact, one import edge per importing pair citing every
// import statement it rests on, and one edge from each fact to its file.
function sourceRecords(manifest) {
  const records = new Map();
  const put = value => records.set(`${value.record.type} ${value.record.id}`, value);
  for (const entity of manifest.entities) {
    put(entity.kind === "file"
      ? entry({ type: "region", id: regionIdOf(entity.id), label: entity.label }, ORIGIN_SOURCE, [{ path: entity.path }])
      : entry({ type: "region", id: regionIdOf(entity.id), label: entity.label }, ORIGIN_UNKNOWN, [{ scope: "external" }]));
  }
  for (const fact of manifest.facts) {
    put(entry({ type: "region", id: factIdOf(fact.id), label: factLabel(fact) }, ORIGIN_SOURCE, [factBasis(fact)]));
  }
  const importsByPair = new Map();
  for (const edge of manifest.imports) {
    const pair = `${edge.from} ${edge.to}`;
    importsByPair.set(pair, [...(importsByPair.get(pair) ?? []), edge]);
  }
  for (const edges of importsByPair.values()) {
    const { from, to } = edges[0];
    put(entry({ type: "relation", id: importIdOf(from, to), from: regionIdOf(from), to: regionIdOf(to), kind: IMPORT_KIND, label: IMPORT_KIND },
      ORIGIN_SOURCE, edges.map(edge => ({ path: edge.path, specifier: edge.specifier, resolution: edge.resolution }))));
  }
  for (const fact of manifest.facts) {
    put(entry({ type: "relation", id: declaresIdOf(fact.id), from: factIdOf(fact.id), to: regionIdOf(fact.entity), kind: DECLARES_KIND, label: DECLARES_KIND },
      ORIGIN_SOURCE, [factBasis(fact)]));
  }
  return records;
}

// The relation Jev chose for a candidate pair.
const inferredRecord = (candidate, kind) => entry(
  { type: "relation", id: relationIdOf(kind, candidate.from, candidate.to), from: regionIdOf(candidate.from), to: regionIdOf(candidate.to), kind, label: kind },
  ORIGIN_MODEL, [{ candidate: candidate.id }]);

// A role Jev gave an admitted file, resting on that file's own text.
const roleClaim = (entity, role) => Object.freeze({
  record: Object.freeze({ type: "region", id: regionIdOf(entity.id) }), origin: ORIGIN_MODEL, basis: Object.freeze([{ path: entity.path }]), role,
});

const equal = (left, right) => left === right || (
  left !== null && right !== null && typeof left === "object" && typeof right === "object"
  && Array.isArray(left) === Array.isArray(right)
  && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(name => Object.hasOwn(right, name) && equal(left[name], right[name])));

// How a saved claim is checked against the snapshot it cites: a function of
// the claim and the record as its Decision left it, answering why the claim
// is not what this snapshot grounds, or null. A source-declared or unknown
// claim must be exactly the snapshot's own claim for that record, and the
// record exactly as the snapshot draws it - label, ends and kind. A relation
// Jev chose must be a relation of the closed vocabulary between the two ends
// of the one candidate pair it cites. A role must be a closed role of an
// admitted file's region, resting on that file.
export function claimCheckFor(manifest) {
  const known = sourceRecords(manifest);
  const candidates = new Map(manifest.candidates.map(candidate => [candidate.id, candidate]));
  const relations = manifest.relations.map(relation => relation.key);
  const roles = manifest.roles.map(role => role.key);
  const files = new Map(manifest.entities.filter(entity => entity.kind === "file").map(entity => [regionIdOf(entity.id), entity]));
  return (claim, record) => {
    const name = `${claim.record.type} ${claim.record.id}`;
    if (claim.role !== undefined) {
      const entity = files.get(claim.record.id);
      if (claim.record.type !== "region" || entity === undefined) return `${name}: only an admitted file has a role`;
      if (!roles.includes(claim.role)) return `${name}: ${claim.role} is not a role of this snapshot`;
      return equal(claim, roleClaim(entity, claim.role)) ? null : `${name}: a role rests on the file itself`;
    }
    let expected = known.get(name);
    if (claim.origin === ORIGIN_MODEL) {
      const candidate = claim.basis.length === 1 ? candidates.get(claim.basis[0].candidate) : undefined;
      if (candidate === undefined || !relations.includes(record?.kind)) return `${name}: not a closed relation of a candidate pair`;
      expected = inferredRecord(candidate, record.kind);
    }
    if (expected === undefined || !equal(expected.claim, claim)) return `${name}: not a claim this snapshot grounds`;
    const drawn = Object.keys(expected.record).every(field => equal(expected.record[field], record?.[field]));
    return drawn ? null : `${name}: not drawn as this snapshot says`;
  };
}

const noChange = reason => Object.freeze({ outcome: OUTCOME_NO_CHANGE, reason });
const refused = (reason, detail = null) => Object.freeze({ outcome: OUTCOME_REFUSED, reason, ...(detail === null ? {} : { detail }) });

// The steps for one compose-architecture utterance against the working graph.
// Every region and edge the snapshot grounds that the working graph lacks;
// for a focused utterance also each relation Jev chose, confidently, for a
// pair of the section, and each role it confirmed for a body file. Regions
// come first, then edges, as consecutive Decisions of at most `operationsMax`
// operations each - the provider's own limit, passed in by the caller - each
// planned on the one before. Every record carries its claim; the roles, which
// add no record, ride with the last step. Without a focus nothing is judged:
// the view is structure only, and every role stays unknown.
export async function planArchitecture({ working, turn, answers, judged, manifest, protocol, operationsMax }) {
  demand(manifest?.status === "available", "an available manifest is required");
  demand(Number.isSafeInteger(operationsMax) && operationsMax > 0, "the provider's operation limit is required");
  if (turn.head !== working.head) return refused("stale");
  const read = readAnswers(answers, turn.slots);
  if (read === null) return refused("answer-invalid");
  demand(read.action.choice === ACTION_ARCHITECTURE, "only a compose-architecture answer is planned here");
  if (read.action.confidence < MIN_CONFIDENCE) return noChange("not-confident");
  let judge = null;
  if (judged !== null) {
    demand(judged.section.focus === focusOf(turn, answers), "the judged section is the one this answer asked for");
    judge = readAnswers(judged.answers, judgeSlotsFor(judged.section));
    if (judge === null) return refused("answer-invalid");
  }
  const confident = slot => (judge[slot].choice !== NONE && judge[slot].confidence >= MIN_CONFIDENCE ? judge[slot].choice : null);

  const records = working.records;
  const root = records.find(record => record?.type === "region" && record.parent === null);
  const has = id => records.some(record => (record?.type === "region" || record?.type === "relation") && record.id === id);

  const wanted = [...sourceRecords(manifest).values()];
  const roleClaims = [];
  if (judge !== null) {
    for (const candidate of judged.section.candidates) {
      const kind = confident(relationSlot(candidate.id));
      if (kind !== null) wanted.push(inferredRecord(candidate, kind));
    }
    for (const entity of manifest.entities.filter(part => judged.section.bodies.includes(part.id))) {
      for (const role of judged.section.roles) {
        if (confident(roleSlot(entity.id, role.key)) === YES) roleClaims.push(roleClaim(entity, role.key));
      }
    }
  }
  const fresh = wanted.filter(value => !has(value.record.id));
  if (fresh.length === 0) return noChange("architecture-nothing-new");

  // The provider operation and the change it shows, for each fresh record;
  // new regions sit on a grid below what is already drawn.
  const boxes = records.filter(record => record?.type === "region").map(record => record.bounds);
  const top = Math.max(...boxes.map(box => box[1] + box[3])) + PART_GAP;
  const regions = fresh.filter(value => value.record.type === "region").map(({ record, claim }, index) => ({
    operation: {
      type: "AddRegion",
      regionId: record.id,
      parentId: root.id,
      label: record.label,
      kind: NODE_KIND,
      summary: "",
      bounds: [
        root.bounds[0] + PART_GAP + (index % COLUMNS) * (PART_WIDTH + PART_GAP),
        top + Math.floor(index / COLUMNS) * (PART_HEIGHT + PART_GAP),
        PART_WIDTH,
        PART_HEIGHT,
      ],
    },
    change: { change: "added", kind: "region", id: record.id, label: record.label },
    claim,
  }));
  const edges = fresh.filter(value => value.record.type === "relation").map(({ record, claim }) => ({
    operation: { type: "ConnectRegions", relationId: record.id, from: record.from, to: record.to, kind: record.kind, label: record.label },
    change: { change: "added", from: record.from, to: record.to },
    claim,
  }));
  const items = [...regions, ...edges];
  const chunks = Array.from({ length: Math.ceil(items.length / operationsMax) },
    (_, index) => items.slice(index * operationsMax, (index + 1) * operationsMax));
  const confidence = Math.min(read.action.confidence, ...(judged === null ? [] : [read.focus.confidence]));
  const steps = [];
  let graph = working;
  for (const [index, chunk] of chunks.entries()) {
    let built;
    try {
      built = await protocol.createDecision(graph.head, chunk.map(item => item.operation), graph.records);
    } catch (error) {
      return refused("provider-rejected", String(error?.message ?? error));
    }
    const last = index === chunks.length - 1;
    steps.push({
      step: {
        revision: graph.head,
        action: ACTION_ARCHITECTURE,
        confidence,
        changes: chunk.map(item => item.change),
        decision: built.decision,
      },
      claims: [...chunk.map(item => item.claim), ...(last ? roleClaims : [])],
    });
    if (!last) {
      try {
        graph = (await protocol.appendDecision(graph.log, built.decision)).verified;
      } catch (error) {
        return refused("provider-rejected", String(error?.message ?? error));
      }
    }
  }
  return Object.freeze({ outcome: OUTCOME_STEP, steps: deepFreeze(steps) });
}
