import { GOAL_OFFER_MAX, KEY_PATTERN, LABEL_MAX, MIN_CONFIDENCE, OFFER_MAX, PART_KINDS, PURPOSE_MAX } from "./contract.mjs";
import { runGoal } from "./goal.mjs";

const INVENTORY_KIND = "voice-ui.goal.inventory.v1";
export const COVERAGE = Object.freeze(["sufficient", "missing", "ambiguous", "no-change", "unsupported"]);
const exact = (x, names) => x !== null && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === names.length && names.every(name => Object.hasOwn(x, name));
const text = (x, max) => typeof x === "string" && x.trim().length > 0 && x.length <= max;
const unique = xs => new Set(xs).size === xs.length;
const part = x => exact(x, ["key", "purpose", "label", "kind"])
  && KEY_PATTERN.test(x.key ?? "") && x.key !== "none"
  && text(x.purpose, PURPOSE_MAX) && text(x.label, LABEL_MAX) && PART_KINDS.includes(x.kind);

export function isInventory(request) {
  if (!exact(request, ["kind", "state"]) || request.kind !== INVENTORY_KIND) return false;
  const s = request.state;
  if (!exact(s, ["utterance", "head", "regions", "edges", "parts"]) || !text(s.utterance, 8000) || !text(s.head, 240)
      || !Array.isArray(s.parts) || s.parts.length > OFFER_MAX || !s.parts.every(part) || !unique(s.parts.map(p => p.key))
      || !Array.isArray(s.regions) || !s.regions.length || s.regions.length > 64) return false;
  if (!s.regions.every(r => exact(r, ["id", "label", "kind", "parent"]) && text(r.id, 240)
      && text(r.label, LABEL_MAX) && (PART_KINDS.includes(r.kind) || r.kind === "boundary"))) return false;
  const ids = s.regions.map(r => r.id);
  return unique(ids) && s.regions.filter(r => r.parent === null).length === 1
    && s.regions.every(r => r.parent === null || ids.includes(r.parent) && r.parent !== r.id)
    && Array.isArray(s.edges) && s.edges.length <= 64
    && s.edges.every(e => exact(e, ["id", "from", "to"]) && text(e.id, 240) && ids.includes(e.from) && ids.includes(e.to))
    && unique(s.edges.map(e => e.id));
}

function inventoryOf({ utterance, bundle, working }) {
  const value = { kind: INVENTORY_KIND, state: { utterance, head: working?.head,
    regions: (working?.records ?? []).filter(r => r.type === "region").map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
    edges: (working?.records ?? []).filter(r => r.type === "relation").map(({ id, from, to }) => ({ id, from, to })),
    parts: bundle.parts === null ? null : structuredClone(bundle.parts),
  } };
  return isInventory(value) ? value : null;
}

export function inventoryQuestion(state) {
  return { state, questions: { coverage: {
    instruction: "Assess the executable candidate inventory for the current utterance, not confidence in choosing a next step. "
      + "Existing regions/edges already satisfy their corresponding requested facts. Each library part key can add exactly ONE new instance per Goal, "
      + "with exactly its displayed label and kind. It cannot rename itself; a generic shape/purpose does not provide an arbitrary requested name. "
      + "Count requested new instances and compare labels/kinds/capacity, allowing clear synonyms only when the displayed name was not explicitly specified. "
      + "The small supported task adds at most three regions and one directed flow edge inside existing named groups, including a group added earlier in the same goal. "
      + "No root additions, removal, movement, new operators or unspecified endpoints. Distinguish missing candidates from ambiguity and from an already satisfied goal.",
    options: {
      sufficient: "The requested change is clear, supported, not already satisfied, and EVERY required new instance is available in the library with the required label/kind and capacity. Existing nodes can be connected without adding candidates.",
      missing: "The supported change is clear, but at least one required NEW part instance lacks its requested displayed label/kind or exceeds the one-instance capacity of the matching library keys. A new name or repeated instance needs completion.",
      ambiguous: "The requested change, count, group or endpoint cannot be uniquely understood. Do not invent missing instructions.",
      "no-change": "No graph change is requested, or every requested fact already exists in the current graph.",
      unsupported: "The clear request requires operations or size outside the stated small supported task.",
    },
  } } };
}

export function typedMissingRequest(state) {
  return { context: JSON.stringify(state), questions: { missing: {
    type: "array", minItems: 0, maxItems: 3,
    instructions: "List ONLY the missing NEW executable part instances required by the utterance. "
      + "Reuse the current graph and the library first: each existing library key can add one instance with its exact label and kind. "
      + "Do not return those reusable instances. Return extra instances only for unavailable requested names/kinds or multiplicity beyond that capacity. "
      + "Preserve each requested display name exactly. Do not return edges, parents, operators, existing nodes or invented extras. "
      + "For identical label/kind missing instances, occurrence is consecutive 1,2,3 within this returned list; it is not a graph ID. "
      + "Use the existing supported kinds. Return an empty list if no safe missing part is identifiable.",
    items: { type: "object", properties: {
      label: { type: "string", instructions: "Exact requested display name, no ID or sequence suffix." },
      kind: { type: "string", enum: [...PART_KINDS], instructions: "The existing shape kind appropriate to that requested part." },
      occurrence: { type: "integer", instructions: "1 for the first missing instance of this label/kind, then 2 or 3." },
    } },
  } } };
}

export function readMissing(value) {
  if (!Array.isArray(value) || value.length > 3) return null;
  const seen = new Map();
  for (const x of value) {
    if (!exact(x, ["label", "kind", "occurrence"]) || !text(x.label, LABEL_MAX) || !PART_KINDS.includes(x.kind)
        || !Number.isInteger(x.occurrence) || x.occurrence < 1 || x.occurrence > 3) return null;
    const key = JSON.stringify([x.label, x.kind]);
    if (x.occurrence !== (seen.get(key) ?? 0) + 1) return null;
    seen.set(key, x.occurrence);
  }
  return Object.freeze(value.map(x => Object.freeze({ ...x })));
}

function withMissing(bundle, missing) {
  const valid = readMissing(missing);
  if (valid === null || !Array.isArray(bundle.parts) || bundle.parts.length > OFFER_MAX || !bundle.parts.every(part)) return null;
  const used = new Set(bundle.parts.map(p => p.key));
  let next = 0;
  const extra = valid.map(x => {
    let key;
    do { key = `goal-extra-${++next}`; } while (used.has(key));
    used.add(key);
    return Object.freeze({ key, label: x.label, kind: x.kind, purpose: `one requested part named ${x.label}, kind ${x.kind}, missing instance ${x.occurrence}` });
  });
  const parts = Object.freeze([...bundle.parts, ...extra]);
  return parts.length <= GOAL_OFFER_MAX && parts.every(part) ? Object.freeze({ ...bundle, parts }) : null;
}

// The optional completion contributes candidates only. The existing Goal owns every legal change and its proof.
// Baseline still executes the unaugmented Goal after a missing verdict: the comparison cannot force its failure.
export async function runInventoryGoal({ check, complete, completion = true, now = () => performance.now(), ...options }) {
  const first = options.current(), started = now();
  const request = inventoryOf({ utterance: options.utterance, bundle: options.bundle, working: first.working });
  const inventory = { checks: 0, completions: 0, coverage: null, missing: [] };
  const stop = reason => Object.freeze({ reason, requests: inventory.checks, elapsedMs: Math.max(0, now() - started),
    selected: [], trace: [], inventory: Object.freeze({ ...inventory }) });
  const interrupted = () => options.cancelled() ? "cancelled" : options.current() !== first ? "stale-goal"
    : now() - started >= 180000 ? "budget-time" : null;
  if (request === null) return stop("invalid-inventory");
  let reason = interrupted();
  if (reason !== null) return stop(reason);
  let coverage;
  inventory.checks++;
  try { coverage = await check(request); } catch { return stop("inventory-unknown"); }
  if (!exact(coverage, ["choice", "confidence"]) || !COVERAGE.includes(coverage.choice)
      || typeof coverage.confidence !== "number" || !Number.isFinite(coverage.confidence) || coverage.confidence < 0 || coverage.confidence > 1)
    return stop("inventory-contract");
  inventory.coverage = Object.freeze({ ...coverage });
  reason = interrupted();
  if (reason !== null) return stop(reason);
  if (coverage.confidence < MIN_CONFIDENCE) return stop("inventory-not-confident");
  if (!["sufficient", "missing"].includes(coverage.choice)) return stop("inventory-" + coverage.choice);
  let bundle = options.bundle;
  if (coverage.choice === "missing" && completion) {
    inventory.completions++;
    let result;
    try { result = await complete(request); } catch { return stop("completion-unknown"); }
    reason = interrupted();
    if (reason !== null) return stop(reason);
    const missing = readMissing(result?.missing);
    if (missing === null) return stop("completion-contract");
    inventory.missing = missing;
    if (!missing.length) return stop("completion-empty");
    bundle = withMissing(bundle, missing);
    if (bundle === null) return stop("completion-contract");
  }
  const result = await runGoal({ ...options, bundle, now, deadlineAt: started + 180000 });
  return Object.freeze({ ...result, requests: result.requests + inventory.checks,
    elapsedMs: Math.max(0, now() - started), inventory: Object.freeze({ ...inventory }) });
}
