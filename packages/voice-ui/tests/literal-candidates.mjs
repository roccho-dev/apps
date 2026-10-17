// Comparison B: an intentionally finite syntax, not a natural-language parser.
// Only a literal kind + quoted label + optional decimal count is transcribed.
// No fixture names, oracle, model, inferred parent/edge or persistent dictionary.
import { PART_KINDS, LABEL_MAX } from "../src/contract.mjs";
import { readTypedMissing } from "../src/completion.mjs";

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
export function literalCandidates(state) {
  const kinds = new Map(PART_KINDS.map(kind => [kind, kind]));
  for (const part of state.parts) kinds.set(part.label, part.kind);
  const prefix = [...kinds.keys()].sort((a, b) => b.length - a.length).map(escaped).join("|");
  const pattern = new RegExp(`(${prefix})\\s*(?:「([^「」\\r\\n]+)」|"([^"\\r\\n]+)")\\s*(?:(?:[×x]\\s*|を\\s*)([0-9]+)(?:個|つ)?)?`, "gu");
  const rows = new Map(), spans = [];
  for (const match of state.utterance.matchAll(pattern)) {
    const label = match[2] ?? match[3], kind = kinds.get(match[1]);
    const quantity = match[4] === undefined ? 1 : Number(match[4]);
    if (!label.trim() || label.length > LABEL_MAX || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 3)
      return { missing: [], extraction: { status: "unsupported-syntax", spans } };
    // Uncounted mentions of an existing node are references in this deliberately
    // conservative baseline. Explicit counted mentions remain new instances.
    if (match[4] === undefined && state.regions.some(r => r.label === label && r.kind === kind)) continue;
    const key = JSON.stringify([label, kind]);
    if (!rows.has(key)) rows.set(key, { label, kind, quantity: 0 });
    rows.get(key).quantity += quantity;
    spans.push({ start: match.index, end: match.index + match[0].length, source: match[0], label, kind, quantity });
  }
  const missingRows = [...rows.values()].flatMap(row => {
    const capacity = state.parts.filter(p => p.label === row.label && p.kind === row.kind).length;
    return row.quantity > capacity ? [{ ...row, quantity: row.quantity - capacity }] : [];
  });
  const slots = Object.fromEntries([1, 2, 3].map((n, i) => ["missing" + n,
    missingRows[i] ?? { label: "", kind: "none", quantity: 0 }]));
  const missing = missingRows.length <= 3 ? readTypedMissing(slots) : null;
  return { missing: missing ?? [], extraction: { status: missing === null || !spans.length ? "unsupported-syntax" : "transcribed", spans } };
}
