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

// A key is one executable instance, not an unlimited reusable type. Expose that
// capacity as data; requested names/counts still belong to the provider judgment.
function inventoryContext(state) {
  const parts = new Map();
  for (const part of state.parts) {
    const key = JSON.stringify([part.label, part.kind]);
    if (!parts.has(key)) parts.set(key, { label: part.label, kind: part.kind, capacity: 0, purposes: [] });
    const item = parts.get(key);
    item.capacity++;
    if (!item.purposes.includes(part.purpose)) item.purposes.push(part.purpose);
  }
  return { utterance: state.utterance, regions: state.regions, edges: state.edges, parts: [...parts.values()],
    limits: { new_regions: 3, new_flow_edges: 1 } };
}

export function inventoryQuestion(state) {
  const context = inventoryContext(state);
  const labels = JSON.stringify(context.parts.map(({ label, kind }) => ({ label, kind })));
  return { state: context, questions: { intent: {
    instruction: "Classify whether the utterance requests a clear supported graph change, independently of library availability. "
      + "Existing regions/edges satisfy their corresponding requested facts. An explicit addition still requests a change when other parts must stay unchanged. "
      + "Adding one, two or three regions is supported, including repeated instances of the same part. At most one directed flow edge may also be added. "
      + "Additions are inside existing named groups, including a group added earlier in the same goal. "
      + "No root additions, removal, movement, new operators or unspecified endpoints. Missing library candidates do not make a clear supported request ambiguous or unsupported.",
    options: {
      change: "A clear request adds one to three regions or one directed flow edge and at least one requested fact is not yet satisfied. New display names are allowed. Ignore whether the candidate parts are in the library.",
      ambiguous: "The requested change, count, group or endpoint cannot be uniquely understood. Do not invent missing instructions.",
      "no-change": "No graph change is requested, or every requested fact already exists in the current graph.",
      unsupported: "The clear request requires operations or size outside the stated small supported task.",
    },
  }, labels: {
    instruction: "Compare ONLY the displayed names and kinds of requested NEW parts with the finite inventory below. Ignore quantity in this question. "
      + "An explicitly requested display name, including a quoted name, must match an inventory label exactly. A generic shape or purpose cannot rename itself. "
      + "Allow clear synonyms only when no display name was specified. Existing nodes satisfy existing references, not requests for additional new instances. "
      + "Connecting existing nodes needs no new parts.",
    options: {
      available: "Every required NEW displayed label/kind matches a row in this inventory, or no new parts are needed: " + labels,
      missing: "At least one required NEW displayed label/kind is absent from this exact inventory: " + labels,
    },
  }, capacity: {
    instruction: "For requested NEW parts whose label/kind already matches an inventory row, compare their requested instance count with that row's integer capacity in state.parts. "
      + "A capacity is a finite number of new instances, not unlimited reuse of a type. Existing nodes do not provide additional new instances. "
      + "Ignore unavailable label/kind pairs here: the labels question handles those. Connecting existing nodes needs no new parts.",
    options: {
      within: "Every requested NEW count for a matching inventory label/kind is at most its capacity, or there are no matching new parts to count.",
      exceeded: "At least one requested NEW count for a matching inventory label/kind exceeds its integer capacity.",
    },
  } } };
}

export function typedMissingRequest(state) {
  const question = index => ({
    type: "object",
    instructions: `Independently find the ${index === 1 ? "FIRST" : index === 2 ? "SECOND" : "THIRD"} DISTINCT missing label/kind pair in utterance order. `
      + "Count distinct requested missing pairs in the input itself; do not depend on another slot's generated answer. "
      + "Check the WHOLE utterance, including parts inside a requested new group. Do not stop at the first named group. "
      + "For each requested NEW label/kind, missing quantity = requested new count minus its available capacity in parts, with a minimum of zero. "
      + "Skip pairs with zero missing quantity. Existing graph facts satisfy existing references, not requests for additional new instances. "
      + "A single requested unavailable part needs exactly one row with quantity 1; multiple identical missing instances use one row with their quantity. "
      + "The sum of missing quantities must be at most three. Preserve requested display names exactly and use only supported kinds. "
      + "If this ordinal has no missing pair, return kind none, label an empty string and quantity 0. "
      + "Do not return edges, parents, operators, existing nodes or invented extras.",
    properties: {
      label: { type: "string", instructions: "Exact requested display name, no ID or sequence suffix; empty string only when kind is none." },
      kind: { type: "string", enum: [...PART_KINDS, "none"], instructions: "The supported kind for this distinct requested pair, or none if there is no pair at this ordinal." },
      quantity: { type: "string", enum: ["0", "1", "2", "3"], instructions: "Select the missing instance count for this distinct pair: 1, 2 or 3. Select 0 only when kind is none." },
    },
  });
  // Ask every bounded ordinal explicitly rather than relying on array stopping
  // to enumerate all pairs. This is one provider request, not three retries.
  return { context: JSON.stringify(inventoryContext(state)), questions: Object.fromEntries(
    [1, 2, 3].map(index => [`missing${index}`, question(index)])) };
}

// TypeLLM supplies quantities; the app owns occurrence ordinals and local IDs.
// Duplicate rows or an oversized sum are refused, never silently deduplicated.
export function readTypedMissing(value) {
  if (!exact(value, ["missing1", "missing2", "missing3"])) return null;
  const rows = [];
  let ended = false;
  for (const key of ["missing1", "missing2", "missing3"]) {
    const row = value[key];
    if (!exact(row, ["label", "kind", "quantity"])) return null;
    if (!["0", "1", "2", "3"].includes(row.quantity)) return null;
    if (row.kind === "none") {
      if (row.label !== "" || row.quantity !== "0") return null;
      ended = true;
    } else {
      if (ended) return null;
      rows.push({ ...row, quantity: Number(row.quantity) });
    }
  }
  return readTypedRows(rows);
}

function readTypedRows(value) {
  if (!Array.isArray(value) || value.length > 3) return null;
  const seen = new Set(), missing = [];
  for (const x of value) {
    if (!exact(x, ["label", "kind", "quantity"]) || !text(x.label, LABEL_MAX) || !PART_KINDS.includes(x.kind)
        || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 3 || missing.length + x.quantity > 3) return null;
    const key = JSON.stringify([x.label, x.kind]);
    if (seen.has(key)) return null;
    seen.add(key);
    for (let occurrence = 1; occurrence <= x.quantity; occurrence++) missing.push({ label: x.label, kind: x.kind, occurrence });
  }
  return readMissing(missing);
}

function readMissing(value) {
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
