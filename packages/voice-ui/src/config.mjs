// The configuration this page runs with, declared in a config.v1.json beside
// the page: in which format and where the graph is kept, and which data the
// page offers from. Nothing here chooses a value; there are no defaults. A
// config that is not exactly this shape is refused with the reason, and the
// page then reads and writes no storage, fetches no data, asks Jev nothing and
// draws nothing.
//
// Each format has its own exact data: a plain DecisionLog needs the bundle; an
// architecture document also needs the prepared source manifest it cites.

const SCHEMA = "voice-ui.config/2";
const MECHANISMS = Object.freeze(["localStorage"]);
const FORMAT_DECISION_LOG = "decision-log/1";
export const FORMAT_ARCHITECTURE = "architecture-document/1";
const DATA_KEYS = Object.freeze({
  [FORMAT_DECISION_LOG]: Object.freeze(["bundle"]),
  [FORMAT_ARCHITECTURE]: Object.freeze(["bundle", "source"]),
});

const exactObject = (value, keys) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

// A clean root-relative path of this origin, kept only if URL canonicalization
// leaves it exactly as written: a query, fragment, backslash, dot segment or
// encoding difference is refused, never rewritten.
const rootPath = value =>
  typeof value === "string"
  && value.startsWith("/")
  && !value.startsWith("//")
  && new URL(value, "http://config.invalid").pathname === value;

const refused = reason => Object.freeze({ error: reason });

// The config as declared, frozen, or `{ error }` saying what is wrong with it.
export function readConfig(value) {
  if (!exactObject(value, ["schema", "persistence", "data"])) {
    return refused("config must have exactly schema, persistence and data");
  }
  if (value.schema !== SCHEMA) return refused(`config schema must be ${SCHEMA}`);
  const { persistence, data } = value;
  if (!exactObject(persistence, ["format", "mechanism", "key"])) {
    return refused("persistence must have exactly format, mechanism and key");
  }
  if (!Object.hasOwn(DATA_KEYS, persistence.format)) {
    return refused(`persistence format must be one of: ${Object.keys(DATA_KEYS).join(", ")}`);
  }
  if (!MECHANISMS.includes(persistence.mechanism)) {
    return refused(`persistence mechanism must be one of: ${MECHANISMS.join(", ")}`);
  }
  if (typeof persistence.key !== "string" || persistence.key.trim().length === 0) {
    return refused("persistence key must be a non-empty string");
  }
  const dataKeys = DATA_KEYS[persistence.format];
  if (!exactObject(data, dataKeys)) return refused(`data for ${persistence.format} must have exactly ${dataKeys.join(", ")}`);
  for (const name of dataKeys) {
    if (!rootPath(data[name])) return refused(`data ${name} must be a clean root-relative path of this origin`);
  }
  return Object.freeze({
    persistence: Object.freeze({ format: persistence.format, mechanism: persistence.mechanism, key: persistence.key }),
    data: Object.freeze(Object.fromEntries(dataKeys.map(name => [name, data[name]]))),
  });
}
