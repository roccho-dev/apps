// The configuration this page runs with, declared in web/data/config.v1.json:
// where the DecisionLog is kept and which data the page offers from. Nothing
// here chooses a value; there are no defaults. A config that is not exactly
// this shape is refused with the reason, and the page then reads and writes no
// storage, fetches no data, asks Jev nothing and draws nothing.

const SCHEMA = "voice-ui.config/1";
const MECHANISMS = Object.freeze(["localStorage"]);

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
  if (!exactObject(persistence, ["mechanism", "key"])) return refused("persistence must have exactly mechanism and key");
  if (!MECHANISMS.includes(persistence.mechanism)) {
    return refused(`persistence mechanism must be one of: ${MECHANISMS.join(", ")}`);
  }
  if (typeof persistence.key !== "string" || persistence.key.trim().length === 0) {
    return refused("persistence key must be a non-empty string");
  }
  if (!exactObject(data, ["bundle"])) return refused("data must have exactly bundle");
  if (!rootPath(data.bundle)) return refused("data bundle must be a clean root-relative path of this origin");
  return Object.freeze({
    persistence: Object.freeze({ mechanism: persistence.mechanism, key: persistence.key }),
    data: Object.freeze({ bundle: data.bundle }),
  });
}
