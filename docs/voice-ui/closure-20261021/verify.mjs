// R1 evaluation vessel (apps#94 comment 6313847759). It checks only that the
// vessel's records are well-formed and bound to what they cite: seals are
// recomputed from the sealed bytes, judgments cite seals of the right target
// made before them, rounds are counted per cycle from the cycle ledger, the
// denominator is the sealed expectation's own items, evaluator and product
// changes are found by identity, and END1 and costs are counted only from
// recorded receipts and ledger lines. It judges no product (§8-12).
//
// node docs/voice-ui/closure-20261021/verify.mjs [vessel-dir]
//
// Every error starts with its rule's code, e.g. "E_SEAL_DIGEST ledgers/seals.jsonl:2 ...".
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMAS = Object.freeze({
  expectation: "voice-ui.closure.expectation/1",
  judgment: "voice-ui.closure.judgment/2",
  seal: "voice-ui.closure.seal/1",
  cost: "voice-ui.closure.cost/2",
  cycle: "voice-ui.closure.cycle/1",
  readback: "voice-ui.closure.github-readback/1",
});
// §7 of apps#118 comment 6310563121, with step 14 split into 14a/14b (apps#94 6313847759).
export const STEPS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14a", "14b", "15"]);
// JUDGE: the Jev evaluator's eligibility against an independent gold (§9 item 4), its own denominator.
export const LANES = Object.freeze(["A", "B", "E2E", "JUDGE"]);
export const ARMS = Object.freeze(["old", "new"]);
export const VERDICTS = Object.freeze(["PASS", "FAIL", "UNKNOWN"]);
export const GOLD_SETS = Object.freeze(["presented-1", "presented-2", "atlas"]);
export const ROUND_MAX = 4;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;
const PROVIDERS = ["jev", "typellm", "ci", "browser"];
const REPOS = { apps: "roccho-dev/apps", ui: "roccho-dev/ui" };

// Keys sorted at every depth, no whitespace; the seal digest is sha256 over its UTF-8 bytes.
export const canonicalJson = value => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
export const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const time = value => Date.parse(value);
const exactKeys = (value, keys, where) => {
  if (!isObject(value)) return [`${where}: not an object`];
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  return [...extra.map(key => `${where}: unexpected ${key}`), ...missing.map(key => `${where}: missing ${key}`)];
};
const steps = (value, where) => Array.isArray(value) && value.length > 0 && value.every(step => STEPS.includes(step))
  && new Set(value).size === value.length ? [] : [`${where}: step must be a nonempty list of ${STEPS.join("|")}`];
// A path the vessel may read: relative, normalized, and inside the vessel.
const inside = value => {
  if (!text(value)) return false;
  const normal = path.posix.normalize(value);
  return normal === value && !path.posix.isAbsolute(normal) && !normal.startsWith("..");
};

export const validateExpectation = value => {
  const errors = exactKeys(value, ["schema", "id", "version", "status", "source", "gold_set", "required", "forbidden", "allowed", "unknown"], "expectation");
  if (errors.length) return errors;
  if (value.schema !== SCHEMAS.expectation) errors.push("expectation: schema");
  if (!ID.test(value.id ?? "")) errors.push("expectation: id");
  if (!Number.isInteger(value.version) || value.version < 1) errors.push("expectation: version");
  // A seal is a separate record; the expectation only says whether it is filled.
  if (!["template", "candidate"].includes(value.status)) errors.push("expectation: status is template|candidate");
  errors.push(...exactKeys(value.source, ["text", "ref"], "expectation.source"));
  const ids = [];
  for (const [list, keys] of [["required", ["id", "claim", "step"]], ["forbidden", ["id", "claim", "step"]],
    ["allowed", ["id", "claim", "step"]], ["unknown", ["id", "question"]]]) {
    if (!Array.isArray(value[list])) { errors.push(`expectation: ${list} must be a list`); continue; }
    value[list].forEach((entry, index) => {
      const where = `expectation.${list}[${index}]`;
      const shape = exactKeys(entry, keys, where);
      errors.push(...shape);
      if (shape.length) return;
      if (!ID.test(entry.id)) errors.push(`${where}: id`);
      ids.push(entry.id);
      if (!text(entry.claim ?? entry.question)) errors.push(`${where}: empty text`);
      if (keys.includes("step")) errors.push(...steps(entry.step, where));
    });
  }
  if (new Set(ids).size !== ids.length) errors.push("expectation: ids repeat across Required/Forbidden/Allowed/UNKNOWN");
  if (value.status === "candidate") {
    if (!text(value.source?.text) || !text(value.source?.ref)) errors.push("expectation: a candidate needs its source text and ref");
    if (!Array.isArray(value.required) || value.required.length === 0) errors.push("expectation: a candidate needs a Required");
    // The one gold set this expectation is judged against; a PASS cannot borrow another set's gold.
    if (!GOLD_SETS.includes(value.gold_set)) errors.push(`expectation: a candidate names its gold_set ${GOLD_SETS.join("|")}`);
  } else if (value.gold_set !== null) errors.push("expectation: a template has gold_set null");
  return errors;
};
// The judged items of a sealed expectation: every Required and Forbidden claim.
export const denominatorOf = expectation => [...expectation.required, ...expectation.forbidden].map(entry => entry.id).sort();

const validateJudgment = value => {
  const errors = exactKeys(value, ["schema", "kind", "cycle", "round", "lane", "item", "step", "product", "evaluator",
    "expectation_sha256", "gold_seal_sha256", "verdict", "judge", "counts_toward_end1", "source", "at"], "judgment");
  if (errors.length) return errors;
  if (value.schema !== SCHEMAS.judgment) errors.push("judgment: schema");
  if (!ID.test(value.cycle)) errors.push("judgment: cycle");
  if (!Number.isInteger(value.round) || value.round < 1 || value.round > ROUND_MAX) errors.push(`judgment: round is 1..${ROUND_MAX}`);
  if (!LANES.includes(value.lane)) errors.push("judgment: lane");
  if (!ID.test(value.item)) errors.push("judgment: item");
  errors.push(...steps(value.step, "judgment"));
  const product = exactKeys(value.product, ["arm", "apps", "ui", "receipts"], "judgment.product");
  errors.push(...product);
  if (!product.length) {
    if (!ARMS.includes(value.product.arm)) errors.push("judgment.product: arm");
    if (!SHA40.test(value.product.apps ?? "")) errors.push("judgment.product: apps is a full SHA");
    if (value.product.ui !== null && !SHA40.test(value.product.ui ?? "")) errors.push("judgment.product: ui is a full SHA or null");
    if (!Array.isArray(value.product.receipts) || !value.product.receipts.every(inside)) errors.push("judgment.product: receipts are vessel paths");
  }
  const evaluator = exactKeys(value.evaluator, ["arm", "id", "sha256"], "judgment.evaluator");
  errors.push(...evaluator);
  if (!evaluator.length) {
    if (!ARMS.includes(value.evaluator.arm)) errors.push("judgment.evaluator: arm");
    if (!text(value.evaluator.id)) errors.push("judgment.evaluator: id");
    if (!SHA64.test(value.evaluator.sha256 ?? "")) errors.push("judgment.evaluator: sha256");
  }
  if (!SHA64.test(value.expectation_sha256 ?? "")) errors.push("judgment: expectation_sha256");
  if (value.gold_seal_sha256 !== null && !SHA64.test(value.gold_seal_sha256 ?? "")) errors.push("judgment: gold_seal_sha256");
  if (!VERDICTS.includes(value.verdict)) errors.push("judgment: verdict");
  if (value.verdict === "PASS" && value.gold_seal_sha256 === null) errors.push("judgment: PASS needs a sealed gold");
  // Independent R judges; the writer of the candidate never does.
  if (value.judge !== "R") errors.push("judgment: judge is R");
  if (typeof value.counts_toward_end1 !== "boolean") errors.push("judgment: counts_toward_end1");
  if (!text(value.source)) errors.push("judgment: source");
  if (!ISO.test(value.at ?? "")) errors.push("judgment: at");
  return errors;
};

const validateSeal = value => {
  const errors = exactKeys(value, ["schema", "kind", "target", "set", "path", "digest", "bytes", "sha256",
    "sealed_by", "sealed_at", "before_exposure"], "seal");
  if (errors.length) return errors;
  if (value.schema !== SCHEMAS.seal) errors.push("seal: schema");
  if (!["expectation", "gold", "holdout"].includes(value.target)) errors.push("seal: target");
  if (value.target === "gold" && !GOLD_SETS.includes(value.set)) errors.push(`seal: gold set is ${GOLD_SETS.join("|")}`);
  if (!ID.test(value.set ?? "")) errors.push("seal: set");
  if (!inside(value.path)) errors.push("seal: path is relative inside the vessel");
  if (!["canonical-json-sha256", "raw-sha256"].includes(value.digest)) errors.push("seal: digest");
  if (!Number.isInteger(value.bytes) || value.bytes < 0) errors.push("seal: bytes");
  if (!SHA64.test(value.sha256 ?? "")) errors.push("seal: sha256");
  if (value.sealed_by !== "R") errors.push("seal: sealed_by is R");
  if (!ISO.test(value.sealed_at ?? "")) errors.push("seal: sealed_at");
  // The declaration is required, but the time order against judgments is checked too.
  if (value.before_exposure !== true) errors.push("seal: before_exposure must be true");
  return errors;
};

const validateCost = value => {
  const errors = exactKeys(value, ["schema", "kind", "cycle", "round", "provider", "calls", "ledger", "phase_id", "at"], "cost");
  if (errors.length) return errors;
  if (value.schema !== SCHEMAS.cost) errors.push("cost: schema");
  if (!ID.test(value.cycle)) errors.push("cost: cycle");
  if (!Number.isInteger(value.round) || value.round < 1 || value.round > ROUND_MAX) errors.push(`cost: round is 1..${ROUND_MAX}`);
  if (!PROVIDERS.includes(value.provider)) errors.push(`cost: provider is ${PROVIDERS.join("|")}`);
  // A count, zero included, cites its ledger line; without one it is UNKNOWN (§8-13).
  if (value.calls === "UNKNOWN") {
    if (value.ledger !== null) errors.push("cost: UNKNOWN calls cite no ledger line");
  } else if (!Number.isInteger(value.calls) || value.calls < 0) {
    errors.push("cost: calls is a count or UNKNOWN");
  } else {
    const ledger = exactKeys(value.ledger, ["file", "line", "line_sha256"], "cost.ledger");
    errors.push(...ledger);
    if (!ledger.length && (!Number.isInteger(value.ledger.line) || value.ledger.line < 1 || !SHA64.test(value.ledger.line_sha256 ?? ""))) {
      errors.push("cost.ledger: line and line_sha256");
    }
  }
  if (value.phase_id !== null && !text(value.phase_id)) errors.push("cost: phase_id");
  if (!ISO.test(value.at ?? "")) errors.push("cost: at");
  return errors;
};

const validateCycle = value => {
  const keys = value?.kind === "cycle-end" ? ["schema", "kind", "cycle", "end", "at"] : ["schema", "kind", "cycle", "seq", "previous", "at"];
  const errors = exactKeys(value, keys, "cycle");
  if (errors.length) return errors;
  if (value.schema !== SCHEMAS.cycle) errors.push("cycle: schema");
  if (!["cycle-open", "cycle-end"].includes(value.kind)) errors.push("cycle: kind is cycle-open|cycle-end");
  if (!ID.test(value.cycle)) errors.push("cycle: cycle");
  if (value.kind === "cycle-open") {
    if (!Number.isInteger(value.seq) || value.seq < 1) errors.push("cycle: seq");
    if (value.previous !== null && !ID.test(value.previous)) errors.push("cycle: previous");
  } else if (!["END1", "END2"].includes(value.end)) errors.push("cycle: end is END1|END2");
  if (!ISO.test(value.at ?? "")) errors.push("cycle: at");
  return errors;
};

const RECORDS = { judgment: validateJudgment, seal: validateSeal, cost: validateCost, "cycle-open": validateCycle, "cycle-end": validateCycle };
export const validateRecord = value => isObject(value) && Object.hasOwn(RECORDS, value.kind)
  ? RECORDS[value.kind](value)
  : [`record: kind is ${Object.keys(RECORDS).join("|")}`];

// One record per line; only the final newline may leave an empty line.
export const parseJsonl = source => {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records = [], errors = [];
  lines.forEach((line, index) => {
    try { records.push(JSON.parse(line)); } catch { errors.push({ line: index + 1, error: "not one JSON value" }); }
  });
  return { records, errors };
};

const LEDGERS = [["cycles", "ledgers/cycles.jsonl", ["cycle-open", "cycle-end"]], ["seals", "ledgers/seals.jsonl", ["seal"]],
  ["judgments", "ledgers/judgments.jsonl", ["judgment"]], ["costs", "ledgers/costs.jsonl", ["cost"]]];
const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);

export const verifyDirectory = dir => {
  const errors = [];
  const fail = (code, where, detail) => errors.push(`${code} ${where} ${detail}`);
  const file = relative => path.join(dir, relative);
  const readBytes = relative => inside(relative) && fs.existsSync(file(relative)) && fs.statSync(file(relative)).isFile()
    ? fs.readFileSync(file(relative)) : null;
  const readJson = relative => {
    const bytes = readBytes(relative);
    try { return bytes === null ? null : JSON.parse(bytes.toString("utf8")); } catch { return null; }
  };

  for (const name of fs.readdirSync(file("expectations")).filter(name => name.endsWith(".json")).sort()) {
    const value = readJson(`expectations/${name}`);
    for (const error of value === null ? ["not JSON"] : validateExpectation(value)) fail("E_EXPECTATION", `expectations/${name}`, error);
  }
  const sets = (readJson("gold/sets.json")?.sets ?? []).map(set => set.id).sort();
  if (sets.join(",") !== [...GOLD_SETS].sort().join(",")) fail("E_GOLD_SETS", "gold/sets.json", `sets are ${GOLD_SETS.join("|")}`);

  // Each ledger, with records that fail their shape left out of every later check.
  const ledger = {};
  for (const [name, relative, kinds] of LEDGERS) {
    const bytes = readBytes(relative);
    if (bytes === null) { fail("E_MISSING", relative, "ledger file"); ledger[name] = []; continue; }
    const parsed = parseJsonl(bytes.toString("utf8"));
    for (const error of parsed.errors) fail("E_PARSE", `${relative}:${error.line}`, error.error);
    ledger[name] = parsed.records.flatMap((record, index) => {
      const where = `${relative}:${index + 1}`;
      const shape = kinds.includes(record?.kind) ? validateRecord(record) : [`holds only ${kinds.join("|")}`];
      for (const error of shape) fail("E_SHAPE", where, error);
      return shape.length ? [] : [{ record, where }];
    });
  }

  // Seals, recomputed from the bytes they name.
  const seals = new Map();
  for (const { record: seal, where } of ledger.seals) {
    const bytes = readBytes(seal.path);
    if (bytes === null) { fail("E_SEAL_MISSING", where, seal.path); continue; }
    let ok = true;
    if (bytes.length !== seal.bytes) { fail("E_SEAL_BYTES", where, `${seal.path} has ${bytes.length} bytes, sealed ${seal.bytes}`); ok = false; }
    let digest = null;
    if (seal.digest === "raw-sha256") digest = sha256Hex(bytes);
    else { try { digest = sha256Hex(canonicalJson(JSON.parse(bytes.toString("utf8")))); } catch { digest = null; } }
    if (digest !== seal.sha256) { fail("E_SEAL_DIGEST", where, `${seal.path} digests to ${digest}`); ok = false; }
    if (seal.target === "expectation") {
      const expectation = readJson(seal.path);
      if (expectation === null || validateExpectation(expectation).length || expectation.status !== "candidate") {
        fail("E_EXPECTATION", where, "a sealed expectation is a valid candidate"); ok = false;
      }
    }
    push(seals, seal.sha256, { ...seal, ok });
  }
  const sealOf = (sha, target, where, code, at) => {
    const found = seals.get(sha) ?? [];
    const match = found.find(seal => seal.target === target);
    if (!match) {
      fail(found.length ? code : "E_SEAL_UNKNOWN", where, found.length ? `cites a ${found[0].target} seal as ${target}` : `cites no recorded ${target} seal`);
      return null;
    }
    if (!(time(match.sealed_at) < time(at))) fail("E_SEAL_LATE", where, `${target} sealed at ${match.sealed_at}, judged at ${at}`);
    return match.ok ? match : null;
  };

  // Cycles: one numbered chain; a cycle opens only after the previous one ended.
  const cycles = new Map();
  let opened = 0, last = null;
  for (const { record, where } of ledger.cycles) {
    if (record.kind === "cycle-open") {
      if (cycles.has(record.cycle)) { fail("E_CYCLE_SEQ", where, `${record.cycle} opened twice`); continue; }
      opened += 1;
      if (record.seq !== opened || record.previous !== last) fail("E_CYCLE_SEQ", where, `expected seq ${opened} after ${last}`);
      const previous = last === null ? null : cycles.get(last);
      if (previous && !(previous.end && time(previous.end.at) <= time(record.at))) {
        fail("E_CYCLE_OPEN_BEFORE_END", where, `${record.cycle} opens before ${last} ends`);
      }
      cycles.set(record.cycle, { open: record, end: null });
      last = record.cycle;
    } else {
      const cycle = cycles.get(record.cycle);
      if (!cycle || cycle.end) fail("E_CYCLE_SEQ", where, `${record.cycle} ends without being open`);
      else cycle.end = record;
    }
  }
  const rounds = new Map();
  const inCycle = (record, where) => {
    const cycle = cycles.get(record.cycle);
    if (!cycle) { fail("E_CYCLE_UNOPENED", where, `${record.cycle} has no cycle-open record`); return false; }
    if (time(record.at) < time(cycle.open.at) || (cycle.end && time(record.at) > time(cycle.end.at))) {
      fail("E_CYCLE_TIME", where, `${record.at} is outside ${record.cycle}`);
    }
    push(rounds, record.cycle, record.round);
    return true;
  };

  // Judgments: bound to their cycle, seals and receipts.
  const groups = new Map();
  for (const { record, where } of ledger.judgments) {
    inCycle(record, where);
    const expectation = sealOf(record.expectation_sha256, "expectation", where, "E_EXPECTATION_TARGET", record.at);
    if (record.gold_seal_sha256 !== null) {
      const gold = sealOf(record.gold_seal_sha256, "gold", where, "E_GOLD_TARGET", record.at);
      const named = expectation ? readJson(expectation.path)?.gold_set : null;
      if (gold && expectation && gold.set !== named) fail("E_GOLD_SET", where, `cites gold set ${gold.set}, the expectation names ${named}`);
    }
    if (record.counts_toward_end1) {
      // Only a readback recorded in the vessel for exactly this SHA lets a judgment count.
      const read = record.product.receipts.map(readJson).filter(receipt => receipt?.schema === SCHEMAS.readback);
      const backed = (repo, sha) => read.some(receipt => receipt.repo === REPOS[repo] && receipt.sha === sha && receipt.response?.sha === sha);
      if (!backed("apps", record.product.apps) || (record.product.ui !== null && !backed("ui", record.product.ui))) {
        fail("E_END1_RECEIPT", where, "END1 needs a recorded GitHub readback of every product SHA");
      }
    }
    push(groups, `${record.cycle}/${record.round}/${record.lane}/${record.expectation_sha256}`, { record, where, expectation });
  }
  for (const [key, members] of groups) {
    const where = `ledgers/judgments.jsonl group ${key}`;
    const identities = (pick, label) => {
      const byArm = new Map();
      for (const { record } of members) push(byArm, record[pick].arm, label(record[pick]));
      const sets = [...byArm].map(([arm, values]) => [arm, [...new Set(values)]]);
      return { arms: sets.map(([arm]) => arm), clash: sets.some(([, values]) => values.length !== 1)
        || new Set(sets.map(([, values]) => values[0])).size !== sets.length };
    };
    const product = identities("product", value => `${value.apps}/${value.ui}`);
    if (product.clash) fail("E_PRODUCT_ARM", where, "each product arm is one SHA pair, and old differs from new");
    const evaluator = identities("evaluator", value => `${value.id}/${value.sha256}`);
    if (evaluator.clash) fail("E_EVALUATOR_ARM", where, "each evaluator arm is one id and sha256, and old differs from new");
    if (!ARMS.every(arm => product.arms.includes(arm))) fail("E_SINGLE_CELL", where, "both product arms are judged");
    const cells = new Map();
    for (const { record } of members) push(cells, `${record.product.arm}/${record.evaluator.arm}`, record.item);
    if (evaluator.arms.includes("new")) {
      for (const cell of ARMS.flatMap(p => ARMS.map(e => `${p}/${e}`))) if (!cells.has(cell)) fail("E_FOUR_CELL", where, `cell ${cell} is missing`);
    }
    const expectation = members[0].expectation;
    if (expectation) {
      const denominator = denominatorOf(readJson(expectation.path)).join(",");
      for (const [cell, items] of cells) {
        if ([...items].sort().join(",") !== denominator) fail("E_DENOMINATOR", where, `cell ${cell} judges ${[...items].sort().join(",")}, sealed ${denominator}`);
      }
    }
  }

  // Costs: a count is the cited ledger line, byte for byte, and its own number.
  for (const { record, where } of ledger.costs) {
    inCycle(record, where);
    if (record.calls === "UNKNOWN") continue;
    const bytes = readBytes(record.ledger.file);
    const line = bytes === null ? null : bytes.toString("utf8").split("\n")[record.ledger.line - 1] ?? null;
    if (line === null || sha256Hex(line) !== record.ledger.line_sha256) {
      fail("E_COST_LEDGER", where, `${record.ledger.file}:${record.ledger.line} is not the cited line`);
      continue;
    }
    if (record.provider === "jev" || record.provider === "typellm") {
      let event = null;
      try { event = JSON.parse(line); } catch { event = null; }
      if (event?.kind !== "phase-reconcile" || event.id !== record.phase_id || event.sent?.[record.provider] !== record.calls) {
        fail("E_COST_MISMATCH", where, `the cited line does not record ${record.calls} ${record.provider} calls for ${record.phase_id}`);
      }
    }
  }
  // Rounds of one cycle run 1, 2, ... without a gap; renaming a cycle cannot reset them (see cycles).
  for (const [cycle, list] of rounds) {
    const present = [...new Set(list)].sort((a, b) => a - b);
    if (present.some((round, index) => round !== index + 1)) fail("E_ROUND_GAP", "ledgers", `${cycle} has rounds ${present.join(",")}`);
  }
  return { ok: errors.length === 0, errors };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDirectory(path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url))));
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
