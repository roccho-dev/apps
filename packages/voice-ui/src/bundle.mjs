import { KEY_PATTERN, LABEL_MAX, NONE, OFFER_MAX, PART_KINDS, PURPOSE_MAX } from "./contract.mjs";

// The DataBundle is the read-only authority for product words: which parts a
// person may ask for, which whole diagrams, what each is for and what it is
// called. It is checked section by section. A section that is missing or
// wrong disables only the capability that needs it; nothing here blocks
// reading or drawing a valid DecisionLog, whose applied Decisions carry their
// own labels and kinds.

const SCHEMA = "voice-ui.bundle/1";

const exactObject = (value, keys) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const key = value => typeof value === "string" && KEY_PATTERN.test(value) && value !== NONE;
const unique = values => new Set(values).size === values.length;

const validPart = part =>
  exactObject(part, ["key", "purpose", "label", "kind"])
  && key(part.key)
  && text(part.purpose, PURPOSE_MAX)
  && text(part.label, LABEL_MAX)
  && PART_KINDS.includes(part.kind);

const validDiagram = diagram => {
  if (!exactObject(diagram, ["key", "purpose", "label", "lanes", "steps", "links"])) return false;
  if (!key(diagram.key) || !text(diagram.purpose, PURPOSE_MAX) || !text(diagram.label, LABEL_MAX)) return false;
  const { lanes, steps, links } = diagram;
  if (!Array.isArray(lanes) || lanes.length < 1 || !lanes.every(lane =>
    exactObject(lane, ["ref", "label"]) && key(lane.ref) && text(lane.label, LABEL_MAX))) return false;
  const laneRefs = lanes.map(lane => lane.ref);
  if (!Array.isArray(steps) || steps.length < 1 || !steps.every(step =>
    exactObject(step, ["ref", "lane", "label", "kind"]) && key(step.ref) && laneRefs.includes(step.lane)
    && text(step.label, LABEL_MAX) && PART_KINDS.includes(step.kind))) return false;
  const stepRefs = steps.map(step => step.ref);
  if (!unique([...laneRefs, ...stepRefs])) return false;
  return Array.isArray(links) && links.every(link =>
    Array.isArray(link) && link.length === 2 && link[0] !== link[1]
    && stepRefs.includes(link[0]) && stepRefs.includes(link[1]))
    && unique(links.map(link => JSON.stringify(link)));
};

const deepFreeze = value => {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const section = (value, valid) =>
  Array.isArray(value) && value.length >= 1 && value.length <= OFFER_MAX && value.every(valid)
  && unique(value.map(entry => entry.key))
    ? deepFreeze(structuredClone(value))
    : null;

// The usable sections of whatever was loaded - `null` when the bundle could
// not be fetched or parsed at all. A section is either wholly valid or null.
export function readBundle(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.schema !== SCHEMA || !text(value.version, LABEL_MAX)) {
    return Object.freeze({ version: null, parts: null, diagrams: null });
  }
  return Object.freeze({
    version: value.version,
    parts: section(value.parts, validPart),
    diagrams: section(value.diagrams, validDiagram),
  });
}

// What Jev is told about each usable section: keys and purposes, never
// labels, lanes, steps or links.
export function offersOf(bundle) {
  const offer = entries => Object.freeze((entries ?? []).map(({ key: entryKey, purpose }) => Object.freeze({ key: entryKey, purpose })));
  return Object.freeze({ parts: offer(bundle.parts), diagrams: offer(bundle.diagrams) });
}
