import {
  ACTION_ARCHITECTURE,
  ARCHITECTURE_INTENT_KIND,
  ARCHITECTURE_JUDGE_KIND,
  ARCHITECTURE_LOCATE_KIND,
  KEY_PATTERN,
  LABEL_MAX,
  MIN_CONFIDENCE,
  NONE,
  WHOLE,
  YES,
  isJudgeRequest,
  isLocateRequest,
  judgeFramesFor,
  judgeSlotsFor,
  locateSlotsFor,
  readAnswers,
  relationSlot,
  relevantSlot,
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
// options: the whole or one part to look at (asked with no code at all); when
// neither is clear, which parts the utterance asks for (asked of each part in
// turn, with that part's own text); and then, shown the chosen parts' own text, which
// roles its files have and which relation, if any, holds for each of its
// candidate pairs. A role Jev confirms is drawn as an edge from the file to
// that role's node. Nothing here invents an entity, label or relation, or
// calls a model-selected one source-declared; which parts were located is
// never drawn or stored as a claim.

const MANIFEST_SCHEMA = "voice-ui.architecture-source/2";
const COMMIT = /^[0-9a-f]{40}$/u;

// Where a claim comes from. Only a file, a static import or a declared fact
// is source-declared; what Jev chose is model-inferred; what the person did is
// user-asserted; what the source names but does not contain is unknown; and a
// role's node, a term of the scope's closed vocabulary - a taxonomy, never
// something the code does - is scope-declared.
export const ORIGIN_SOURCE = "source-declared";
export const ORIGIN_MODEL = "model-inferred";
export const ORIGIN_USER = "user-asserted";
export const ORIGIN_UNKNOWN = "unknown";
export const ORIGIN_SCOPE = "scope-declared";

const IMPORT_KIND = "imports";
const DECLARES_KIND = "declares";
const HAS_ROLE_KIND = "has-role";
// Edge kinds this module draws itself, which no chosen relation may shadow.
const RESERVED_KINDS = Object.freeze([IMPORT_KIND, DECLARES_KIND, HAS_ROLE_KIND]);
const NODE_KIND = "node";
const REGION_PREFIX = "arch-";
const FACT_PREFIX = "arch-fact-";
const ROLE_PREFIX = "arch-role-";
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
const validFile = file => text(file?.path) && typeof file.blob === "string" && COMMIT.test(file.blob) && (
  (exactObject(file, ["path", "blob", "class", "entity", "jsonSyntax"]) && file.class === "admitted" && key(file.entity) && typeof file.jsonSyntax === "boolean")
  || (exactObject(file, ["path", "blob", "class", "reason"]) && file.class === "excluded" && text(file.reason)));
// An admitted file is labelled by its own path; anything else by the
// identifier or URL the source uses for it.
const validEntity = entity =>
  (exactObject(entity, ["id", "label", "kind", "path"]) && entity.kind === "file" && text(entity.path) && entity.label === entity.path)
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
    && text(entity.label) && entity.label.length <= LABEL_MAX && entity.id !== WHOLE)) return invalid("entities are not well-formed");
  const ids = value.entities.map(entity => entity.id);
  if (new Set(ids).size !== ids.length) return invalid("entity ids repeat");
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) return invalid("file paths repeat");
  const admitted = value.files.filter(file => file.class === "admitted");
  const fileEntities = value.entities.filter(entity => entity.kind === "file");
  if (new Set(admitted.map(file => file.entity)).size !== admitted.length
    || new Set(fileEntities.map(entity => entity.path)).size !== fileEntities.length
    || admitted.length !== fileEntities.length
    || !admitted.every(file => fileEntities.some(entity => entity.id === file.entity && entity.path === file.path))) {
    return invalid("admitted files and file entities must correspond exactly, once each");
  }
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
  if (value.relations.some(relation => RESERVED_KINDS.includes(relation.key))) return invalid("a relation shadows an edge kind drawn here");
  if (!exactObject(value.coverage, ["unsupported", "skipped", "notAnalyzed"])) return invalid("coverage is not well-formed");
  const manifest = deepFreeze(structuredClone(value));
  const recordIds = everyRecordOf(manifest).map(({ record }) => record.id);
  if (new Set(recordIds).size !== recordIds.length) return invalid("two records of this snapshot would share an id");
  return manifest;
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

// The one part a confident compose-architecture answer asks to see, or null:
// never the whole, never none.
function focusOf(turn, answers) {
  const read = readAnswers(answers, turn.slots);
  if (read === null || read.action.choice !== ACTION_ARCHITECTURE) return null;
  const { choice, confidence } = read.focus;
  return choice !== NONE && choice !== WHOLE && confidence >= MIN_CONFIDENCE ? choice : null;
}

// Where a confident compose-architecture answer goes next: to the whole, to
// the one part it names, or - when neither is confident - to the code itself,
// to locate what the utterance means. Null for any other answer.
export function routeOf(turn, answers) {
  const read = readAnswers(answers, turn.slots);
  if (read === null || read.action.choice !== ACTION_ARCHITECTURE || read.action.confidence < MIN_CONFIDENCE) return null;
  if (read.focus.choice === WHOLE && read.focus.confidence >= MIN_CONFIDENCE) return Object.freeze({ route: "whole" });
  const part = focusOf(turn, answers);
  return part === null ? Object.freeze({ route: "locate" }) : Object.freeze({ route: "part", focus: Object.freeze([part]) });
}

// Whether every part the snapshot knows opens some text to be asked about.
const everyPartOpens = manifest => manifest.entities.every(entity => judgeSectionOf(manifest, [entity.id]) !== null);

// The locate for an unclear focus: one frame for every part the snapshot
// knows, in its order, each with the utterance and the recent conversation
// exactly as the intent carried them, the snapshot's identity and that one
// part - no code. The server adds that part's own text, the text of the
// section it opens, and asks whether the utterance asks for it. Null when some
// part opens no text: then no part is asked about, and none is left out.
export function locateRequestsOf(manifest, intent) {
  demand(manifest?.status === "available", "an available manifest is required");
  if (!everyPartOpens(manifest)) return null;
  return deepFreeze(manifest.entities.map(entity => ({
    kind: ARCHITECTURE_LOCATE_KIND,
    state: {
      utterance: intent.state.utterance,
      context: intent.state.context,
      architecture: { source: { ...manifest.source }, focus: [entity.id] },
    },
  })));
}

// What a locate found, from its frames as sent, each with its answer: every
// part whose own frame answered yes at or above the threshold, sorted, and the
// weakest of those answers' confidences. Null unless the frames are exactly
// one per part in the snapshot's order, each a locate frame of the contract's
// own shape, all of one utterance and conversation, each answered completely
// on its own question.
export function locatedOf(manifest, frames) {
  const ids = manifest.entities.map(entity => entity.id);
  if (!Array.isArray(frames) || frames.length !== ids.length) return null;
  const { utterance, context } = frames[0]?.request?.state ?? {};
  const found = [];
  for (const [index, id] of ids.entries()) {
    const expected = { kind: ARCHITECTURE_LOCATE_KIND, state: { utterance, context, architecture: { source: manifest.source, focus: [id] } } };
    if (!isLocateRequest(frames[index]?.request) || !equal(frames[index].request, expected)) return null;
    const read = readAnswers(frames[index].answers, locateSlotsFor([id]));
    if (read === null) return null;
    const answer = read[relevantSlot(id)];
    if (answer.choice === YES && answer.confidence >= MIN_CONFIDENCE) found.push([id, answer.confidence]);
  }
  return deepFreeze({ focus: found.map(([id]) => id).sort(), confidence: Math.min(...found.map(([, confidence]) => confidence)) });
}

// The part of the snapshot a focus opens, decided by the manifest alone. A
// focus is a sorted list of known parts. Its body files are each focused
// file, and - for a part outside the source - every admitted file whose text
// names it; its pairs are exactly the candidate pairs that touch a focused
// part or a body file; its parts are those and their other ends. Null when
// the focus is not such a list, or opens no file.
// One deliberately bounded analysis rule, not a claim about execution.
// Original pairs still discover/open files; only model relation questions
// and the claims they could ground exclude a positive-JSON subject.
const relationEligible = (manifest, candidate) => {
  const entity = manifest.entities.find(value => value.id === candidate.from);
  demand(entity !== undefined, "a relation subject must be a known entity");
  if (entity.kind === "external") return true;
  const file = manifest.files.find(value => value.class === "admitted" && value.entity === entity.id && value.path === entity.path);
  demand(file !== undefined && typeof file.jsonSyntax === "boolean", "a file subject requires its validated JSON syntax fact");
  return !file.jsonSyntax;
};

export function judgeSectionOf(manifest, focus) {
  demand(manifest?.status === "available", "an available manifest is required");
  const byId = new Map(manifest.entities.map(entity => [entity.id, entity]));
  if (!Array.isArray(focus) || focus.length === 0 || !focus.every(id => byId.has(id))
    || !focus.every((id, index) => index === 0 || focus[index - 1] < id)) return null;
  const touching = id => manifest.candidates.filter(candidate => candidate.from === id || candidate.to === id);
  const opens = part => (byId.get(part).kind === "file"
    ? [part]
    : touching(part).map(candidate => (candidate.from === part ? candidate.to : candidate.from)).filter(id => byId.get(id).kind === "file"));
  const opened = new Set(focus.flatMap(opens));
  if (opened.size === 0) return null;
  const centre = new Set([...focus, ...opened]);
  const candidates = manifest.candidates.filter(candidate => relationEligible(manifest, candidate)
    && (centre.has(candidate.from) || centre.has(candidate.to)));
  const parts = new Set([...centre, ...candidates.flatMap(candidate => [candidate.from, candidate.to])]);
  return deepFreeze({
    source: { ...manifest.source },
    focus: [...focus],
    entities: manifest.entities.filter(entity => parts.has(entity.id)).map(entity => ({ id: entity.id, label: entity.label })),
    bodies: manifest.entities.filter(entity => opened.has(entity.id)).map(entity => entity.id),
    candidates: candidates.map(candidate => ({ id: candidate.id, from: candidate.from, to: candidate.to, reasons: [...candidate.reasons] })),
    roles: manifest.roles.map(role => ({ ...role })),
    relations: manifest.relations.map(relation => ({ ...relation })),
  });
}

// The judge of a focused utterance: one request for every frame of the
// focused section, in the contract's order, each with the utterance, the
// section whole and the frame it asks - no code. The server adds that frame's
// own text and nothing else. Null when the focus opens no section, or the
// section cannot be asked in frames.
export function judgeRequestsOf(manifest, focus, utterance) {
  const section = judgeSectionOf(manifest, focus);
  const frames = section === null ? null : judgeFramesFor(section);
  return frames === null ? null : deepFreeze(frames.map(({ frame }) => (
    { kind: ARCHITECTURE_JUDGE_KIND, state: { utterance, architecture: section, frame } })));
}

// What a judge found, from its frames as sent, each with its answer: the
// focused section and one answer for each of its questions, in the section's
// own order. Null unless the frames are exactly the requests this focus is
// judged by, once each and in order, all of one utterance, each answered
// completely on its own frame's questions. Nothing is weighed or merged: every
// question was asked in exactly one frame, and its answer is that frame's.
export function judgedOf(manifest, focus, frames) {
  if (!Array.isArray(frames)) return null;
  const requests = judgeRequestsOf(manifest, focus, frames[0]?.request?.state?.utterance);
  if (requests === null || frames.length !== requests.length) return null;
  const section = requests[0].state.architecture;
  const plan = judgeFramesFor(section);
  const found = {};
  for (const [index, request] of requests.entries()) {
    if (!isJudgeRequest(frames[index]?.request) || !equal(frames[index].request, request)) return null;
    const read = readAnswers(frames[index].answers, judgeSlotsFor(plan[index].section));
    if (read === null) return null;
    Object.assign(found, read);
  }
  return Object.freeze({ section, answers: Object.freeze(Object.fromEntries(Object.keys(judgeSlotsFor(section)).map(slot => [slot, found[slot]]))) });
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

// A role's node: the scope's term, drawn once it is first assigned.
const roleIdOf = key => `${ROLE_PREFIX}${key}`;
const roleNode = key => entry({ type: "region", id: roleIdOf(key), label: `role:${key}` }, ORIGIN_SCOPE, [{ vocabulary: "roles", key }]);

// A role Jev confirmed for an admitted file, judged from that file's whole text.
const roleEdge = (entity, key) => entry(
  { type: "relation", id: `${REGION_PREFIX}${HAS_ROLE_KIND}-${entity.id}-to-${key}`, from: regionIdOf(entity.id), to: roleIdOf(key), kind: HAS_ROLE_KIND, label: HAS_ROLE_KIND },
  ORIGIN_MODEL, [{ path: entity.path }]);

// Every record this snapshot could ever draw: what the source grounds, every
// role node, every relation any pair could be given and every role any file
// could be given. No two of them may share an id.
const everyRecordOf = manifest => {
  const files = manifest.entities.filter(entity => entity.kind === "file");
  return [
    ...sourceRecords(manifest).values(),
    ...manifest.roles.map(role => roleNode(role.key)),
    ...manifest.candidates.filter(candidate => relationEligible(manifest, candidate))
      .flatMap(candidate => manifest.relations.map(relation => inferredRecord(candidate, relation.key))),
    ...files.flatMap(entity => manifest.roles.map(role => roleEdge(entity, role.key))),
  ];
};

// What this snapshot defines a graph edge as, told by the edge's id and both
// its ends: the relation's kind and, for a relation of the scope's vocabulary,
// that relation's own purpose - a reserved kind has none. Null for any edge
// the snapshot does not define exactly so: another id, other ends or a region.
// It says what the snapshot defines, never what a graph actually holds.
export function definedRelation(manifest, edge) {
  demand(manifest?.status === "available", "an available manifest is required");
  const found = everyRecordOf(manifest).map(value => value.record)
    .find(record => record.type === "relation" && record.id === edge?.id && record.from === edge.from && record.to === edge.to);
  if (found === undefined) return null;
  return Object.freeze({ kind: found.kind, purpose: manifest.relations.find(relation => relation.key === found.kind)?.purpose ?? null });
}

const equal = (left, right) => left === right || (
  left !== null && right !== null && typeof left === "object" && typeof right === "object"
  && Array.isArray(left) === Array.isArray(right)
  && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(name => Object.hasOwn(right, name) && equal(left[name], right[name])));

// How a saved claim is checked against the snapshot it cites: a function of
// the claim and the record as its Decision left it, answering why the claim
// is not what this snapshot grounds, or null. A source-declared, unknown or
// scope-declared claim must be exactly the snapshot's own claim for that
// record - a role's node only for a role of the closed vocabulary - and the
// record exactly as the snapshot draws it: label, ends and kind. A relation
// Jev chose must be a relation of the closed vocabulary between the two ends
// of the one candidate pair it cites. A role Jev confirmed must be the
// has-role edge from the admitted file whose path it cites to the node of a
// role of the closed vocabulary.
export function claimCheckFor(manifest) {
  const known = new Map([...sourceRecords(manifest).values(), ...manifest.roles.map(role => roleNode(role.key))]
    .map(value => [`${value.record.type} ${value.record.id}`, value]));
  const candidates = new Map(manifest.candidates.filter(candidate => relationEligible(manifest, candidate)).map(candidate => [candidate.id, candidate]));
  const relations = manifest.relations.map(relation => relation.key);
  const roles = new Map(manifest.roles.map(role => [roleIdOf(role.key), role.key]));
  const files = new Map(manifest.entities.filter(entity => entity.kind === "file").map(entity => [entity.path, entity]));
  return (claim, record) => {
    const name = `${claim.record.type} ${claim.record.id}`;
    let expected = known.get(name);
    if (claim.origin === ORIGIN_MODEL) {
      const [basis] = claim.basis;
      if (claim.basis.length === 1 && basis.path !== undefined) {
        const entity = files.get(basis.path);
        if (entity === undefined || record?.kind !== HAS_ROLE_KIND || !roles.has(record?.to)) {
          return `${name}: not a closed role of an admitted file`;
        }
        expected = roleEdge(entity, roles.get(record.to));
      } else {
        const candidate = claim.basis.length === 1 ? candidates.get(basis.candidate) : undefined;
        if (candidate === undefined || !relations.includes(record?.kind)) return `${name}: not a closed relation of a candidate pair`;
        expected = inferredRecord(candidate, record.kind);
      }
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
// pair of the section, and a has-role edge for each role it confirmed for a
// body file, with that role's node if it is not drawn yet. Regions come first,
// then edges, as consecutive Decisions of at most `operationsMax` operations
// each - the provider's own limit, passed in by the caller - each planned on
// the one before; the page keeps them as one utterance. Every record carries
// its claim. Only an answer that confidently asks for the whole gets the view
// with nothing judged: structure only, with no role at all. A focus that is
// neither a confident whole nor a confident part is located from the code:
// `located` must be exactly every locate frame, each answered completely, and
// when it finds nothing the utterance is an honest no-change - never taken as
// the whole. A snapshot with a part that opens no text is never located: the
// utterance is refused, with no part left out. A focus - the named part, or exactly every part
// located - whose section was not judged changes nothing. The step is as sure
// as the weaker of the action and the focus: the named part's answer, or the
// weakest located part's. Nothing drawn is ever taken back here: a role or
// relation judged none later stays until the person removes it.
export async function planArchitecture({ working, turn, answers, judged = null, located = null, manifest, protocol, operationsMax }) {
  demand(manifest?.status === "available", "an available manifest is required");
  demand(Number.isSafeInteger(operationsMax) && operationsMax > 0, "the provider's operation limit is required");
  if (turn.head !== working.head) return refused("stale");
  const read = readAnswers(answers, turn.slots);
  if (read === null) return refused("answer-invalid");
  demand(read.action.choice === ACTION_ARCHITECTURE, "only a compose-architecture answer is planned here");
  if (read.action.confidence < MIN_CONFIDENCE) return noChange("not-confident");
  const route = routeOf(turn, answers);
  let focus = null;
  let focusConfidence = read.focus.confidence;
  if (route.route === "locate") {
    if (!everyPartOpens(manifest)) return refused("architecture-judge-missing");
    demand(located !== null, "an unclear focus is located before it is planned");
    const found = locatedOf(manifest, located);
    if (found === null) return refused("answer-invalid");
    if (found.focus.length === 0) return noChange("architecture-focus-unclear");
    focus = found.focus;
    focusConfidence = found.confidence;
  } else {
    demand(located === null, "only an unclear focus is located");
    if (route.route === "part") focus = route.focus;
  }
  let judge = null;
  if (focus === null) {
    demand(judged === null, "the whole is never judged");
  } else {
    // A focus whose section could not be judged - such as something outside
    // the source that no admitted file names.
    if (judged === null) return refused("architecture-judge-missing");
    demand(equal(judged.section.focus, focus), "the judged section is the one this answer asked for");
    judge = readAnswers(judged.answers, judgeSlotsFor(judged.section));
    if (judge === null) return refused("answer-invalid");
  }
  const confident = slot => (judge[slot].choice !== NONE && judge[slot].confidence >= MIN_CONFIDENCE ? judge[slot].choice : null);

  const records = working.records;
  const root = records.find(record => record?.type === "region" && record.parent === null);
  const has = id => records.some(record => (record?.type === "region" || record?.type === "relation") && record.id === id);

  const wanted = [...sourceRecords(manifest).values()];
  if (judge !== null) {
    for (const candidate of judged.section.candidates) {
      const kind = confident(relationSlot(candidate.id));
      if (kind !== null) wanted.push(inferredRecord(candidate, kind));
    }
    for (const entity of manifest.entities.filter(part => judged.section.bodies.includes(part.id))) {
      for (const role of judged.section.roles) {
        if (confident(roleSlot(entity.id, role.key)) === YES) wanted.push(roleNode(role.key), roleEdge(entity, role.key));
      }
    }
  }
  const fresh = [...new Map(wanted.filter(value => !has(value.record.id)).map(value => [value.record.id, value])).values()];
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
  const confidence = Math.min(read.action.confidence, focusConfidence);
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
      claims: chunk.map(item => item.claim),
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
