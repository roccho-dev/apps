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
      + "If this ordinal has no missing pair, kind none marks the slot unused. Its label and quantity are bounded padding with no candidate meaning; prefer an empty label and quantity 0. "
      + "Do not return edges, parents, operators, existing nodes or invented extras.",
    properties: {
      label: { type: "string", instructions: "Exact requested display name for an active pair, no ID or sequence suffix. Unused kind-none slots may use an empty padding string." },
      kind: { type: "string", enum: [...PART_KINDS, "none"], instructions: "The supported kind for this distinct requested pair, or none if there is no pair at this ordinal." },
      quantity: { type: "string", enum: ["0", "1", "2", "3"], instructions: "Select the missing instance count for this active distinct pair: 1, 2 or 3. For an unused kind-none slot this field is padding; prefer 0." },
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
    if (!exact(row, ["label", "kind", "quantity"]) || typeof row.label !== "string" || row.label.length > LABEL_MAX) return null;
    if (!["0", "1", "2", "3"].includes(row.quantity)) return null;
    if (row.kind === "none") {
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

// Literal evidence crosses the same closed boundary for every gate outcome.
export function readLiteralInspection(value, utterance) {
  if (!exact(value, ["source", "recognized", "required", "missing", "spans", "completeness"])
      || value.source !== "literal+jev" || typeof value.recognized !== "boolean"
      || readTypedRows(value.required) === null || readMissing(value.missing) === null
      || !Array.isArray(value.spans) || value.spans.length > 3
      || value.recognized !== (value.spans.length > 0)
      || !value.spans.every(s => exact(s, ["start", "end", "source", "label", "kind", "quantity"])
        && Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end)
        && s.start >= 0 && s.start < s.end && s.end <= utterance.length
        && s.source === utterance.slice(s.start, s.end) && s.source === s.label
        && readTypedRows([{ label: s.label, kind: s.kind, quantity: s.quantity }]) !== null)
      || value.spans.reduce((n, s) => n + s.quantity, 0) > 3
      || !unique(value.spans.map(s => JSON.stringify([s.start, s.end, s.label])))
      || !exact(value.completeness, ["choice", "confidence"])
      || !["complete", "incomplete"].includes(value.completeness.choice)
      || typeof value.completeness.confidence !== "number" || !Number.isFinite(value.completeness.confidence)
      || value.completeness.confidence < 0 || value.completeness.confidence > 1) return null;
  const quantities = new Map();
  for (const span of value.spans) {
    const key = JSON.stringify([span.label, span.kind]);
    quantities.set(key, (quantities.get(key) ?? 0) + span.quantity);
  }
  if (quantities.size !== value.required.length
      || !value.required.every(row => quantities.get(JSON.stringify([row.label, row.kind])) === row.quantity)) return null;
  return structuredClone(value);
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

// A verified full NEW requirement limits executable instances, in inventory order.
// Short stock stays short; this filter neither invents parts nor interprets structure.
export function quotaGoalBundle(bundle, required) {
  const rows = readRequired(required);
  if (rows === null || bundle === null || typeof bundle !== "object" || Array.isArray(bundle)
      || !Array.isArray(bundle.parts) || bundle.parts.length > GOAL_OFFER_MAX
      || !bundle.parts.every(part) || !unique(bundle.parts.map(p => p.key))) return null;
  const remaining = new Map(rows.map(row => [JSON.stringify([row.label, row.kind]), row.quantity]));
  const parts = bundle.parts.filter(p => {
    const key = JSON.stringify([p.label, p.kind]), count = remaining.get(key) ?? 0;
    if (count === 0) return false;
    remaining.set(key, count - 1);
    return true;
  }).map(p => Object.freeze({ ...p }));
  return Object.freeze({ ...bundle, parts: Object.freeze(parts) });
}

// The optional completion contributes candidates only. The existing Goal owns every legal change and its proof.
// Baseline still executes the unaugmented Goal after a missing verdict: the comparison cannot force its failure.
export async function runInventoryGoal({ check, complete, completion = true, now = () => performance.now(), ...options }) {
  const first = options.current(), started = now();
  const request = inventoryOf({ utterance: options.utterance, bundle: options.bundle, working: first.working });
  const inventory = { checks: 0, completions: 0, preparations: 0, coverage: null, missing: [] };
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
  const receipt = exact(coverage, ["choice", "confidence", "inspection"])
    ? readRequirementInspection(coverage.inspection, request.state, readLiteralInspection) : null;
  const inspected = exact(coverage, ["choice", "confidence", "inspection"])
    && (receipt !== null || readLiteralInspection(coverage.inspection, options.utterance) !== null);
  if (!(exact(coverage, ["choice", "confidence"]) || inspected)
      || !(COVERAGE.includes(coverage.choice) || inspected && coverage.choice === "unknown" && coverage.confidence === null)
      || coverage.choice !== "unknown" && (typeof coverage.confidence !== "number" || !Number.isFinite(coverage.confidence)
        || coverage.confidence < 0 || coverage.confidence > 1))
    return stop("inventory-contract");
  if (receipt !== null && (coverage.choice !== receipt.decision.choice || coverage.confidence !== receipt.decision.confidence))
    return stop("inventory-contract");
  inventory.coverage = Object.freeze({ ...coverage });
  reason = interrupted();
  if (reason !== null) return stop(reason);
  if (coverage.choice === "unknown") return stop("inventory-unresolved");
  if (coverage.confidence < MIN_CONFIDENCE) return stop("inventory-not-confident");
  if (!["sufficient", "missing"].includes(coverage.choice)) return stop("inventory-" + coverage.choice);
  let bundle = options.bundle;
  if (coverage.choice === "missing" && completion) {
    let result;
    if (receipt !== null) result = { missing: receipt.missing };
    else {
      inventory.completions++;
      try { result = await complete(request); } catch { return stop("completion-unknown"); }
    }
    reason = interrupted();
    if (reason !== null) return stop(reason);
    const missing = readMissing(result?.missing);
    if (missing === null) return stop("completion-contract");
    inventory.missing = missing;
    if (!missing.length) return stop("completion-empty");
    bundle = withMissing(bundle, missing);
    if (bundle === null) return stop("completion-contract");
    inventory.preparations++;
  }
  if (receipt !== null) {
    bundle = quotaGoalBundle(bundle, receipt.required);
    if (bundle === null) return stop("completion-contract");
  }
  const result = await runGoal({ ...options, bundle, now, deadlineAt: started + 180000 });
  return Object.freeze({ ...result, requests: result.requests + inventory.checks,
    elapsedMs: Math.max(0, now() - started), inventory: Object.freeze({ ...inventory }) });
}

// Full NEW requirements share the existing inventory boundary.
const requiredExact = (x, keys) => x !== null && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = ["intent", "labels", "capacity", "completeness"];
const choices = [["change", "ambiguous", "no-change", "unsupported"], ["available", "missing"],
  ["within", "exceeded"], ["complete", "incomplete"]];
const answer = (x, options) => requiredExact(x, ["choice", "confidence"]) && options.includes(x.choice)
  && Number.isFinite(x.confidence) && x.confidence >= 0 && x.confidence <= 1;

export function readRequired(rows) {
  if (!Array.isArray(rows) || rows.length > 3 || !rows.every(r => requiredExact(r, ["label", "kind", "quantity"])
      && typeof r.label === "string" && r.label.trim().length > 0 && r.label.length <= LABEL_MAX
      && PART_KINDS.includes(r.kind) && Number.isSafeInteger(r.quantity) && r.quantity >= 1 && r.quantity <= 3)
      || rows.reduce((n, r) => n + r.quantity, 0) > 3
      || new Set(rows.map(r => JSON.stringify([r.label, r.kind]))).size !== rows.length) return null;
  return structuredClone(rows);
}

export function readRequiredSlots(slots) {
  if (!requiredExact(slots, ["required1", "required2", "required3"])) return null;
  const rows = [];
  let ended = false;
  for (const key of ["required1", "required2", "required3"]) {
    const row = slots[key];
    if (!requiredExact(row, ["label", "kind", "quantity"]) || typeof row.label !== "string" || row.label.length > LABEL_MAX
        || !["0", "1", "2", "3"].includes(row.quantity)) return null;
    if (row.kind === "none") ended = true;
    else {
      if (ended) return null;
      rows.push({ label: row.label, kind: row.kind, quantity: Number(row.quantity) });
    }
  }
  return readRequired(rows);
}

// Existing Working nodes never increase the stock of executable new instances.
export function requiredDifference(required, parts) {
  return required.flatMap(row => Array.from({ length: Math.max(0,
    row.quantity - parts.filter(p => p.label === row.label && p.kind === row.kind).length) }, (_, i) =>
    ({ label: row.label, kind: row.kind, occurrence: i + 1 })));
}

export function requiredRequest(context, { generation = "dependent" } = {}) {
  if (!["independent", "dependent"].includes(generation)) throw new Error("invalid requirements generation");
  const extraction = { utterance: context.utterance,
    existing_regions: context.regions.map(({ label, kind }) => ({ label, kind })),
    part_definitions: context.parts.map(({ label, kind, purposes }) => ({ label, kind, purposes })) };
  const subject = n => "原文のutterance全体から、今回新しく追加する部品の（表示名,種類）の組を、最初に言及された順に重複なく列挙する。"
    + "同じ組を複数個追加しても1組として数える。新しい囲み内の子も列挙するが、既存の親や接続先は追加に含めない。"
    + "existing_regionsは既存参照、part_definitionsは名称と種類の定義であり、追加用の個数ではない。"
    + "既存の個数を差し引かない。この質問が答えるのは、その一覧の第" + n + "組だけ。"
    + "第" + n + "組がなければ未使用とする。別の順位の組を繰り返して埋めない。";
  const request = { context: JSON.stringify(extraction), questions: Object.fromEntries([1, 2, 3].map(n => ["required" + n, {
    type: "object",
    instructions: "最大3組、総個数も最大3個の新規追加要求を読み取る。ID・親・矢印・操作は答えない。" + subject(n),
    properties: {
      label: { type: "string", instructions: subject(n) + "第" + n + "組の表示名だけを原文どおり答える。"
        + "引用された名称や明示された表示名を優先し、通し番号や種類名を付け足さない。"
        + "表示名の指定がない種類はpart_definitionsの対応する標準labelを使う。未使用なら空文字。" },
      kind: { type: "string", enum: [...PART_KINDS, "none"], instructions: subject(n) + "第" + n + "組の種類だけを答える。"
        + "Supported meanings: step=task/action/process/box; decision=branch/condition/diamond; data=stored information/document; "
        + "start=begin; end=finish; group=container/boundary. part_definitionsのlabel/kind/purposesも参照する。"
        + "名称の意味より原文で明示された種類を優先する。未使用ならnone。" },
      quantity: { type: "string", enum: ["0", "1", "2", "3"], instructions: subject(n) + "第" + n + "組について、"
        + "今回新たに追加する総個数だけを答える（1・2・3）。組の順位や全組の合計数とは異なる。"
        + "同じ表示名と種類の反復は合算し、在庫や既存の図から差し引かない。未使用なら0。" },
    },
  }])) };
  if (generation === "dependent") for (const [index, name] of Object.keys(request.questions).entries()) {
    const question = request.questions[name];
    question.properties.label.depends_on = ["kind"];
    question.properties.quantity.depends_on = ["kind", "label"];
    if (index) question.depends_on = Object.keys(request.questions).slice(0, index);
  }
  return request;
}

// Experimental extraction contract. Explicit names and definition names have
// separate provenance; neither branch may invent a replacement display name.
export function displaySourceRequest(context) {
  const request = requiredRequest(context, { generation: "dependent" });
  for (const [index, question] of Object.values(request.questions).entries()) {
    const n = index + 1, { kind, label, quantity } = question.properties;
    const label_source = { type: "string", enum: ["utterance", "definition", "none"], depends_on: ["kind"],
      instructions: "第" + n + "組の表示名の出所だけを答える。utterance=原文が表示名を明示している。"
        + "definition=表示名の指定がなく、種類に対応するpart_definitionsの標準名を使う。none=この順位の組はない。"
        + "種類名と表示名が両方あるときは、表示名の指定を優先してutteranceとする。" };
    question.properties = { kind, label_source,
      label: { ...label, depends_on: ["kind", "label_source"], instructions: "第" + n + "組の表示名だけを答える。"
        + "label_source=utteranceなら、原文で明示された表示名をそのまま抜き出す。種類名へ言い換えない。"
        + "label_source=definitionなら、kindが一致するpart_definitionsの標準labelをそのまま使う。"
        + "label_source=noneなら空文字。番号・種類名・説明・引用符は付け足さない。" },
      quantity: { ...quantity, depends_on: ["kind", "label_source", "label"] } };
  }
  return request;
}

export function readDisplaySourceSlots(source, context) {
  if (!requiredExact(source, ["required1", "required2", "required3"])) return null;
  const slots = {};
  for (const [key, row] of Object.entries(source)) {
    if (!requiredExact(row, ["kind", "label_source", "label", "quantity"])) return null;
    slots[key] = { label: row.label, kind: row.kind, quantity: row.quantity };
  }
  const required = readRequiredSlots(slots);
  if (required === null) return null;
  for (const row of Object.values(source)) {
    if (row.label_source === "none") {
      if (row.kind !== "none" || row.label !== "" || row.quantity !== "0") return null;
    } else {
      if (row.kind === "none") return null;
      if (row.label_source === "utterance") {
        if (!context.utterance.includes(row.label)) return null;
      } else if (row.label_source === "definition") {
        if (!context.parts.some(p => p.label === row.label && p.kind === row.kind)) return null;
      } else return null;
    }
  }
  return { slots, required, source_slots: structuredClone(source) };
}

// This question receives no expected answer, oracle, parent or edge proposal.
// Keep the dependent extraction DAG, but ask its leaves as top-level scalars.
export function flatRequiredRequest(context) {
  const request = requiredRequest(context, { generation: "dependent" }), questions = {};
  const fields = ["label", "kind", "quantity"];
  for (const [name, parent] of Object.entries(request.questions)) {
    const inherited = (parent.depends_on ?? []).flatMap(key => fields.map(field => key + "_" + field));
    for (const [field, schema] of Object.entries(parent.properties)) {
      const depends_on = [...inherited, ...(schema.depends_on ?? []).map(key => name + "_" + key)];
      questions[name + "_" + field] = { ...schema, instructions: parent.instructions + "\n" + schema.instructions };
      if (depends_on.length) questions[name + "_" + field].depends_on = depends_on;
      else delete questions[name + "_" + field].depends_on;
    }
  }
  return { context: request.context, questions };
}

export function readFlatRequiredSlots(source) {
  const names = ["required1", "required2", "required3"], fields = ["label", "kind", "quantity"];
  if (!requiredExact(source, names.flatMap(name => fields.map(field => name + "_" + field)))) return null;
  const slots = Object.fromEntries(names.map(name => [name,
    Object.fromEntries(fields.map(field => [field, source[name + "_" + field]]))]));
  const required = readRequiredSlots(slots);
  return required === null ? null : { slots, required, scalar_answers: structuredClone(source) };
}

export function requiredQuestion(base, required) {
  const comparison = { utterance: base.state.utterance, proposed_new_parts: required,
    part_definitions: base.state.parts.map(({ label, kind, purposes }) => ({ label, kind, purposes })) };
  return { ...base, state: { ...base.state, required }, questions: { ...base.questions, completeness: {
    instruction: "Judge only the correspondence between the original request and this untrusted extraction: "
      + JSON.stringify(comparison) + ". Compare EVERY requested NEW label/kind pair and its TOTAL NEW count. "
      + "Preserve explicit display names, kinds and counts. A generic request may use a standard label and kind ONLY when the utterance "
      + "and part_definitions uniquely determine them. Reject any remaining ambiguity; do not invent names, kinds or counts. "
      + "Inventory availability and capacity are different questions: an exact extraction is complete even if its labels are absent "
      + "from stock or its total NEW counts exceed stock. Never subtract stock from requested quantities. "
      + "Include new containers and their requested children. Existing references are not additions. Parent/edge assignments are "
      + "not fields of this proposal, so their absence is not an omitted part. Connecting existing nodes needs no NEW parts. "
      + "Do not repair the proposal or assume it is correct.",
    options: { complete: "Every uniquely determined requested NEW label, kind and total count is represented exactly, with no extras.",
      incomplete: "A requested NEW label, kind or total count is omitted, extra, wrong, or cannot be uniquely determined." },
  } } };
}

export function readRequirementFactors(answers) {
  if (answers === null || typeof answers !== "object" || !names.every((name, i) => {
    const x = answers[name];
    return x && answer({ choice: x.choice, confidence: x.confidence }, choices[i]);
  })) return null;
  return Object.fromEntries(names.map(name => [name, { choice: answers[name].choice, confidence: answers[name].confidence }]));
}

export const acceptedRequirements = factors => factors.intent.choice === "change" && factors.intent.confidence >= MIN_CONFIDENCE
  && factors.completeness.choice === "complete" && factors.completeness.confidence >= MIN_CONFIDENCE;
export const requiresInterpretation = factors => factors.intent.choice === "change" && factors.intent.confidence >= MIN_CONFIDENCE
  && factors.completeness.choice === "incomplete" && factors.completeness.confidence >= MIN_CONFIDENCE;

export function requirementProposalPolicy(factors) {
  const confident = requiresInterpretation(factors);
  const uncertain = ["change", "ambiguous"].includes(factors.intent.choice) && factors.intent.confidence < MIN_CONFIDENCE
    && factors.completeness.choice === "incomplete" && factors.completeness.confidence >= MIN_CONFIDENCE;
  return { id: "uncertainty-frontier-v1", eligible: confident || uncertain,
    reason: confident ? "confident-change-incomplete" : uncertain ? "uncertain-intent-incomplete" : null };
}

export function requirementDecision(factors, ready, missing) {
  const choice = factors.intent.choice !== "change" ? factors.intent.choice
    : ready && factors.completeness.choice === "complete" && factors.completeness.confidence >= MIN_CONFIDENCE
      ? missing.length ? "missing" : "sufficient" : "unknown";
  return { choice, confidence: choice === "unknown" ? null : factors.intent.choice !== "change" ? factors.intent.confidence
    : Math.min(factors.intent.confidence, factors.completeness.confidence) };
}

// The browser independently checks the receipt before deterministic preparation.
export function readRequirementInspection(value, state, literalReader) {
  const frontier = value?.schema === "voice-ui.parts.inspection/3" && value.mode === "adaptive-v3";
  if (!requiredExact(value, ["schema", "request_id", "mode", "initial", "proposal", "verification", "required", "missing",
        ...(frontier ? ["proposal_policy"] : [])])
      || !frontier && (value.schema !== "voice-ui.parts.inspection/2" || !["literal-v2", "adaptive-v2"].includes(value.mode))
      || typeof value.request_id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.request_id)
      || readRequired(value.required) === null) return null;
  if (!same(value.missing, requiredDifference(value.required, state.parts))) return null;
  const initial = value.initial;
  if (!requiredExact(initial, ["decision", "factors", "literal", "observation"])
      || !requiredExact(initial.factors, names) || readRequirementFactors(initial.factors) === null
      || !names.every((name, i) => answer(initial.factors[name], choices[i]))
      || !requiredExact(initial.observation, ["valid", "status"]) || typeof initial.observation.valid !== "boolean"
      || !["transcribed", "unsupported-syntax"].includes(initial.observation.status)
      || !requiredExact(initial.literal, ["recognized", "required", "spans"])) return null;
  const literal = initial.literal;
  const literalMissing = readRequired(literal.required) === null ? null : requiredDifference(literal.required, state.parts);
  if (literalMissing === null || literalReader({ source: "literal+jev", ...literal, missing: literalMissing,
      completeness: initial.factors.completeness }, state.utterance) === null
      || !initial.observation.valid && (literal.recognized || literal.required.length || literal.spans.length)) return null;
  const references = new Set(state.regions.filter(r => !["group", "boundary"].includes(r.kind)
    && state.utterance.includes(r.label)).map(r => r.label));
  const ready = initial.observation.valid && (initial.observation.status === "transcribed" || literal.required.length === 0 && references.size >= 2);
  if (!same(initial.decision, requirementDecision(initial.factors, ready, literalMissing))) return null;
  const policy = requirementProposalPolicy(initial.factors);
  if (frontier && !same(value.proposal_policy, policy)) return null;
  const adaptive = frontier || value.mode === "adaptive-v2", eligible = frontier ? policy.eligible : requiresInterpretation(initial.factors);
  let decision = initial.decision;
  if (value.proposal === null) {
    if (value.verification !== null || !same(value.required, literal.required)
        || adaptive && eligible) return null;
  } else {
    if (!adaptive || !eligible
        || !requiredExact(value.proposal, ["slots", "required"]) || readRequiredSlots(value.proposal.slots) === null
        || !same(readRequiredSlots(value.proposal.slots), value.proposal.required)
        || !same(value.required, value.proposal.required) || !requiredExact(value.verification, names)
        || !names.every((name, i) => answer(value.verification[name], choices[i]))) return null;
    decision = requirementDecision(value.verification, true, value.missing);
  }
  return { ...structuredClone(value), decision };
}
