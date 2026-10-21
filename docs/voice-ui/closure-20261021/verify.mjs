// R1 evaluation vessel (apps#94 comment 6313847759). It checks only that the
// vessel's own records are well-formed and comparable: one denominator per
// lane and round, all four cells when the evaluator changes, UNKNOWN kept, no
// END1 count without a GitHub-readable SHA. It judges no product (§8-12).
//
// node docs/voice-ui/closure-20261021/verify.mjs [vessel-dir]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMAS = Object.freeze({
  expectation: "voice-ui.closure.expectation/1",
  judgment: "voice-ui.closure.judgment/1",
  seal: "voice-ui.closure.seal/1",
  cost: "voice-ui.closure.cost/1",
});
// §7 of apps#118 comment 6310563121, with step 14 split into 14a/14b (apps#94 6313847759).
export const STEPS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14a", "14b", "15"]);
export const LANES = Object.freeze(["A", "B", "E2E"]);
export const ARMS = Object.freeze(["old", "new"]);
export const VERDICTS = Object.freeze(["PASS", "FAIL", "UNKNOWN"]);
export const GOLD_SETS = Object.freeze(["presented-1", "presented-2", "atlas"]);
export const ROUND_MAX = 4;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;
const PROVIDERS = ["jev", "typellm", "ci", "browser"];

// Keys sorted at every depth, no whitespace; the seal digest is sha256 over its UTF-8 bytes.
export const canonicalJson = value => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
export const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const exactKeys = (value, keys, where) => {
  if (!isObject(value)) return [`${where}: not an object`];
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  return [...extra.map(key => `${where}: unexpected ${key}`), ...missing.map(key => `${where}: missing ${key}`)];
};
const steps = (value, where) => Array.isArray(value) && value.length > 0 && value.every(step => STEPS.includes(step))
  && new Set(value).size === value.length ? [] : [`${where}: step must be a nonempty list of ${STEPS.join("|")}`];

export const validateExpectation = value => {
  const errors = exactKeys(value, ["schema", "id", "version", "status", "source", "required", "forbidden", "allowed", "unknown"], "expectation");
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
  }
  return errors;
};

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
  errors.push(...exactKeys(value.product, ["arm", "apps", "ui", "github_readable"], "judgment.product"));
  if (isObject(value.product)) {
    if (!ARMS.includes(value.product.arm)) errors.push("judgment.product: arm");
    if (!SHA40.test(value.product.apps ?? "")) errors.push("judgment.product: apps is a full SHA");
    if (value.product.ui !== null && !SHA40.test(value.product.ui ?? "")) errors.push("judgment.product: ui is a full SHA or null");
    if (typeof value.product.github_readable !== "boolean") errors.push("judgment.product: github_readable");
  }
  errors.push(...exactKeys(value.evaluator, ["arm", "id", "sha256"], "judgment.evaluator"));
  if (isObject(value.evaluator)) {
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
  if (value.counts_toward_end1 === true && value.product?.github_readable !== true) {
    errors.push("judgment: END1 counts only a product SHA read back from GitHub");
  }
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
  const normal = path.posix.normalize(value.path ?? "");
  if (!text(value.path) || path.posix.isAbsolute(normal) || normal.startsWith("..") || normal !== value.path) {
    errors.push("seal: path is relative inside the vessel");
  }
  if (!["canonical-json-sha256", "raw-sha256"].includes(value.digest)) errors.push("seal: digest");
  if (!Number.isInteger(value.bytes) || value.bytes < 0) errors.push("seal: bytes");
  if (!SHA64.test(value.sha256 ?? "")) errors.push("seal: sha256");
  if (value.sealed_by !== "R") errors.push("seal: sealed_by is R");
  if (!ISO.test(value.sealed_at ?? "")) errors.push("seal: sealed_at");
  // A seal made after any candidate output was seen is no seal.
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
    errors.push(...exactKeys(value.ledger, ["file", "line"], "cost.ledger"));
    if (isObject(value.ledger) && (!text(value.ledger.file) || !Number.isInteger(value.ledger.line) || value.ledger.line < 1)) {
      errors.push("cost.ledger: file and line");
    }
  }
  if (value.phase_id !== null && !text(value.phase_id)) errors.push("cost: phase_id");
  if (!ISO.test(value.at ?? "")) errors.push("cost: at");
  return errors;
};

const RECORDS = { judgment: validateJudgment, seal: validateSeal, cost: validateCost };
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

const groupKey = record => `${record.cycle}/${record.round}/${record.lane}`;
const cellKey = record => `${record.product.arm}/${record.evaluator.arm}`;
const groups = judgments => judgments.reduce((map, record) => map.set(groupKey(record), [...(map.get(groupKey(record)) ?? []), record]), new Map());

// Within a cycle, round and lane, every cell judges exactly the same items once.
// UNKNOWN is a verdict inside the denominator, never a reason to leave it.
export const checkDenominators = judgments => [...groups(judgments)].flatMap(([key, records]) => {
  const cells = records.reduce((map, record) => map.set(cellKey(record), [...(map.get(cellKey(record)) ?? []), record.item]), new Map());
  const errors = [];
  for (const [cell, items] of cells) {
    if (new Set(items).size !== items.length) errors.push(`${key} ${cell}: an item is judged twice`);
  }
  const sets = [...cells].map(([cell, items]) => [cell, [...new Set(items)].sort().join(",")]);
  for (const [cell, items] of sets) if (items !== sets[0][1]) errors.push(`${key} ${cell}: denominator differs from ${sets[0][0]}`);
  return errors;
});

// When a group holds a new evaluator, product and evaluator change are only
// separable with all four old/new cells present.
export const checkFourCell = judgments => [...groups(judgments)].flatMap(([key, records]) => {
  if (!records.some(record => record.evaluator.arm === "new")) return [];
  const present = new Set(records.map(cellKey));
  return ARMS.flatMap(product => ARMS.map(evaluator => `${product}/${evaluator}`))
    .filter(cell => !present.has(cell)).map(cell => `${key}: evaluator changed but cell ${cell} is missing`);
});

const readJsonl = file => fs.existsSync(file) ? parseJsonl(fs.readFileSync(file, "utf8")) : { records: [], errors: [{ line: 0, error: "missing" }] };

export const verifyDirectory = dir => {
  const errors = [];
  const at = (file, list) => list.map(error => `${file}: ${typeof error === "string" ? error : `line ${error.line} ${error.error}`}`);
  for (const name of fs.readdirSync(path.join(dir, "expectations")).filter(name => name.endsWith(".json")).sort()) {
    errors.push(...at(`expectations/${name}`, validateExpectation(JSON.parse(fs.readFileSync(path.join(dir, "expectations", name), "utf8")))));
  }
  const sets = JSON.parse(fs.readFileSync(path.join(dir, "gold/sets.json"), "utf8"));
  const ids = (sets.sets ?? []).map(set => set.id).sort();
  if (ids.join(",") !== [...GOLD_SETS].sort().join(",")) errors.push(`gold/sets.json: sets are ${GOLD_SETS.join("|")}`);
  const ledgers = {};
  for (const [file, kind] of [["ledgers/judgments.jsonl", "judgment"], ["ledgers/seals.jsonl", "seal"], ["ledgers/costs.jsonl", "cost"]]) {
    const parsed = readJsonl(path.join(dir, file));
    errors.push(...at(file, parsed.errors));
    parsed.records.forEach((record, index) => {
      errors.push(...at(file, validateRecord(record).map(error => `line ${index + 1} ${error}`)));
      if (record?.kind !== kind) errors.push(`${file}: line ${index + 1} holds only ${kind} records`);
    });
    ledgers[kind] = parsed.records;
  }
  errors.push(...at("ledgers/judgments.jsonl", [...checkDenominators(ledgers.judgment), ...checkFourCell(ledgers.judgment)]));
  // Every judgment cites a sealed expectation, and a gold seal when it has one.
  const sealed = new Set(ledgers.seal.map(seal => seal.sha256));
  ledgers.judgment.forEach((record, index) => {
    if (!sealed.has(record.expectation_sha256)) errors.push(`ledgers/judgments.jsonl: line ${index + 1} cites an unsealed expectation`);
    if (record.gold_seal_sha256 !== null && !sealed.has(record.gold_seal_sha256)) {
      errors.push(`ledgers/judgments.jsonl: line ${index + 1} cites an unsealed gold`);
    }
  });
  return { ok: errors.length === 0, errors };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDirectory(path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url))));
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}
