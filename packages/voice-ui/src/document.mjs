import { ORIGIN_MODEL, ORIGIN_SCOPE, ORIGIN_SOURCE, ORIGIN_UNKNOWN, ORIGIN_USER, claimCheckFor } from "./architecture.mjs";
import { RESTORE_NO_LOG, RESTORE_RESTORED, commitStored, inspectLog, statesOf } from "./log.mjs";

// The architecture page's one stored value: the provider's own DecisionLog,
// line for line and unchanged, with the provenance of every Decision beside it.
//
//   line 1        the header: this format and the exact source snapshot cited
//   then, per Decision, exactly two lines:
//     the provider's canonical Decision line, as the provider wrote it
//     its provenance: the Decision's id and one claim per record it changed
//
// Only the provider verifies the Decisions, taken out as its own log; this
// module checks everything else: the pairing, and that each Decision's claims
// name exactly what it changed, each change once - a person's claim any
// change, any other claim a record it added. A record whose meaning changed
// under the same id counts as removed and added, so no earlier claim outlives
// it. While the same snapshot is available, every claim other than a person's
// is also checked by the architecture module, the one authority for which
// record stands for what, against that snapshot. It only ever grows, under the
// same write core as a plain log. No source text, raw answer or confidence is
// stored here.

const DOCUMENT_SCHEMA = "voice-ui.architecture-document/1";

const ORIGINS = Object.freeze([ORIGIN_SOURCE, ORIGIN_MODEL, ORIGIN_USER, ORIGIN_UNKNOWN, ORIGIN_SCOPE]);
const RECORD_TYPES = Object.freeze(["region", "relation", "layout"]);

const DOCUMENT_CORRUPT = "corrupt";
export const EVIDENCE_CURRENT = "current";
const EVIDENCE_UNAVAILABLE = "unavailable";

const message = error => String(error?.message ?? error);

const exactObject = (value, keys) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

// JSON with every object's keys in sorted order, so equal values are equal bytes.
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

// A line that parses to a value whose canonical form is exactly the line.
const canonicalLine = line => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return canonical(value) === line ? value : undefined;
};

// What a claim may cite: a file, an import statement and how it was resolved,
// a fact at a pointer (of one row, for JSONL), a candidate pair, a term of the
// scope's role vocabulary, or nothing but being outside the source.
const validBasis = basis => Array.isArray(basis) && basis.every(entry =>
  (exactObject(entry, ["path"]) && typeof entry.path === "string")
  || (exactObject(entry, ["path", "specifier", "resolution"]) && typeof entry.path === "string"
    && typeof entry.specifier === "string" && typeof entry.resolution === "string")
  || (exactObject(entry, ["path", "pointer"]) && typeof entry.path === "string" && typeof entry.pointer === "string")
  || (exactObject(entry, ["path", "row", "pointer"]) && typeof entry.path === "string"
    && Number.isSafeInteger(entry.row) && typeof entry.pointer === "string")
  || (exactObject(entry, ["candidate"]) && typeof entry.candidate === "string")
  || (exactObject(entry, ["vocabulary", "key"]) && entry.vocabulary === "roles" && typeof entry.key === "string")
  || (exactObject(entry, ["scope"]) && entry.scope === "external"));

// A removal is only ever the person's.
const validClaim = claim => {
  const keys = ["record", "origin", "basis", ...(Object.hasOwn(claim ?? {}, "change") ? ["change"] : [])];
  return exactObject(claim, keys)
    && exactObject(claim.record, ["type", "id"]) && RECORD_TYPES.includes(claim.record.type)
    && typeof claim.record.id === "string" && claim.record.id.length > 0
    && ORIGINS.includes(claim.origin)
    && validBasis(claim.basis)
    && (claim.change === undefined || (claim.change === "removed" && claim.origin === ORIGIN_USER));
};

const validProvenance = value => exactObject(value, ["decision", "claims"])
  && typeof value.decision === "string" && Array.isArray(value.claims) && value.claims.every(validClaim);

const recordOf = (records, { type, id }) => records.find(record => record?.type === type
  && (type === "layout" ? record.regionId === id : record.id === id));
const recordPresent = (records, claimed) => recordOf(records, claimed) !== undefined;

// Why a Decision's claims do not name exactly what it changed, or null: every
// claim is one change it made - a person's any change, any other an added
// record - and every change it made is named by exactly one claim.
const coverageReason = (claims, before, after) => {
  const changes = userClaims(before, after).map(claimKey);
  const named = claims.map(claimKey);
  const stray = named.find(key => !changes.includes(key));
  if (stray !== undefined) return `${stray} is not a change that Decision made`;
  const twice = named.find((key, index) => named.indexOf(key) !== index);
  if (twice !== undefined) return `${twice} is claimed twice`;
  const unnamed = changes.find(key => !named.includes(key));
  return unnamed === undefined ? null : `${unnamed} is a change no claim names`;
};

const sameSource = (left, right) => left?.handle === right?.handle && left?.commit === right?.commit;

// A stored document read whole: restored, with the evidence it can still be
// checked against, or corrupt/foreign with the reason. Nothing is repaired.
async function inspectDocument(text, { verifyDecisionLog, manifest }) {
  const corrupt = reason => Object.freeze({ status: DOCUMENT_CORRUPT, reason });
  if (typeof text !== "string" || !text.endsWith("\n")) return corrupt("the document must end with a newline");
  const lines = text.split("\n").slice(0, -1);
  if (lines.length < 3 || lines.length % 2 !== 1) return corrupt("the document must be a header and whole Decision/provenance pairs");
  const header = canonicalLine(lines[0]);
  if (!exactObject(header, ["schema", "source"]) || header.schema !== DOCUMENT_SCHEMA
    || !exactObject(header.source, ["handle", "commit"])) return corrupt(`the header is not ${DOCUMENT_SCHEMA}`);

  const decisionLines = lines.filter((_, index) => index > 0 && index % 2 === 1);
  const provenance = lines.filter((_, index) => index > 0 && index % 2 === 0).map(canonicalLine);
  if (!provenance.every(validProvenance)) return corrupt("a provenance line is not canonical or not well-formed");

  const log = `${decisionLines.join("\n")}\n`;
  const inspected = await inspectLog(log, verifyDecisionLog);
  if (inspected.status !== RESTORE_RESTORED) return inspected;
  const graph = inspected.graph;

  let states;
  try {
    states = await statesOf(log, verifyDecisionLog);
  } catch (error) {
    return corrupt(message(error));
  }
  const checkable = manifest?.status === "available" && sameSource(manifest.source, header.source);
  const grounded = checkable ? claimCheckFor(manifest) : null;
  for (const [index, item] of provenance.entries()) {
    if (item.decision !== graph.ids[index]) return corrupt(`provenance ${index + 1} names another Decision`);
    const before = index === 0 ? [] : states[index - 1];
    const after = states[index];
    const uncovered = coverageReason(item.claims, before, after);
    if (uncovered !== null) return corrupt(`provenance ${index + 1}: ${uncovered}`);
    for (const claim of item.claims.filter(entry => grounded !== null && entry.origin !== ORIGIN_USER)) {
      const reason = grounded(claim, recordOf(after, claim.record));
      if (reason !== null) return corrupt(`provenance ${index + 1}: ${reason}`);
    }
  }
  return Object.freeze({
    status: RESTORE_RESTORED,
    graph,
    projection: inspected.projection,
    source: Object.freeze({ ...header.source }),
    provenance: Object.freeze(provenance.map(item => Object.freeze(item))),
    evidence: checkable ? EVIDENCE_CURRENT : EVIDENCE_UNAVAILABLE,
  });
}

// What this origin has stored under the architecture key.
export async function restoreDocument({ key, read, verifyDecisionLog, manifest }) {
  const stored = await read(key);
  if (stored === null || stored === undefined) return Object.freeze({ status: RESTORE_NO_LOG });
  return Object.freeze({ ...(await inspectDocument(stored, { verifyDecisionLog, manifest })), stored });
}

// The document for a verified graph and one provenance entry per Decision.
const documentFor = ({ source, graph, provenance }) => {
  const decisionLines = graph.log.split("\n").slice(0, -1);
  if (decisionLines.length !== provenance.length) throw new TypeError("architecture document: one provenance entry per Decision");
  return [
    canonical({ schema: DOCUMENT_SCHEMA, source }),
    ...decisionLines.flatMap((line, index) => [line, canonical(provenance[index])]),
  ].join("\n") + "\n";
};

// Claims for what the person did in one Decision: every record it added or
// removed, as the provider's states before and after show it. A record is
// keyed by what it means - a region's label, kind and parent, a relation's
// ends, kind and label, a layout's bounds - so the same id with another
// meaning is one removed and one added, while moving a region is no change.
const MEANING = Object.freeze({ region: ["label", "kind", "parent"], relation: ["from", "to", "kind", "label"], layout: ["bounds"] });
const recordsOf = records => new Map(records
  .filter(record => RECORD_TYPES.includes(record?.type))
  .map(record => {
    const id = record.type === "layout" ? record.regionId : record.id;
    const meaning = Object.fromEntries(MEANING[record.type].map(field => [field, record[field] ?? null]));
    return [`${record.type} ${id} ${canonical(meaning)}`, Object.freeze({ type: record.type, id })];
  }));
function userClaims(before, after) {
  const previous = recordsOf(before);
  const next = recordsOf(after);
  return [
    ...[...previous].filter(([key]) => !next.has(key)).map(([, record]) => ({ record, origin: ORIGIN_USER, basis: [], change: "removed" })),
    ...[...next].filter(([key]) => !previous.has(key)).map(([, record]) => ({ record, origin: ORIGIN_USER, basis: [] })),
  ];
}
function claimKey(claim) {
  return `${claim.change ?? "added"} ${claim.record.type} ${claim.record.id}`;
}

// Apply for the architecture page. The saved Decisions keep their provenance;
// each unapplied one takes the claims its step carries - the architecture
// view's own, with their sources - and a step the person made is user-asserted
// for exactly the records it changed. The new document must extend the stored
// one byte for byte and pass every check above against the current manifest.
export async function commitDocument({ graph, draft, saved, expected, key, read, write, lock, verifyDecisionLog, manifest }) {
  const source = saved === null ? manifest.source : saved.source;
  const states = await statesOf(graph.log, verifyDecisionLog);
  const first = graph.decisions.length - draft.length;
  const provenance = [
    ...(saved === null ? [] : saved.provenance),
    ...draft.map((item, offset) => {
      const index = first + offset;
      const claims = item.claims !== undefined ? item.claims : userClaims(index === 0 ? [] : states[index - 1], states[index]);
      return { decision: graph.ids[index], claims };
    }),
  ];
  const next = documentFor({ source, graph, provenance });
  return commitStored({
    next,
    expected,
    key,
    read,
    write,
    lock,
    check: async value => {
      const inspected = await inspectDocument(value, { verifyDecisionLog, manifest });
      return inspected.status === RESTORE_RESTORED ? null : inspected.reason;
    },
  });
}

// What the graph as it now is rests on: for every record still present, every
// claim made about it since it was last removed, oldest first - so a file's
// source-declared existence and Jev's model-inferred role stay side by side.
export function currentClaims(provenance, records) {
  const byRecord = new Map();
  for (const claim of provenance.flatMap(item => item.claims)) {
    const key = `${claim.record.type} ${claim.record.id}`;
    if (claim.change === "removed") byRecord.delete(key);
    else byRecord.set(key, [...(byRecord.get(key) ?? []), claim]);
  }
  return Object.freeze([...byRecord.values()]
    .filter(claims => recordPresent(records, claims[0].record))
    .map(claims => Object.freeze({ record: claims[0].record, claims: Object.freeze(claims) })));
}
