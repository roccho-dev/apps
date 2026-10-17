// Comparison B: an intentionally finite syntax, not a natural-language parser.
// Only explicit quoted names with a neighbouring finite kind, or a counted
// stock label, are transcribed. Unsupported paraphrases remain unsupported.
// No fixture names, oracle, model, inferred parent/edge or persistent dictionary.
import { PART_KINDS, LABEL_MAX } from "../src/contract.mjs";
import { readTypedMissing } from "../src/completion.mjs";

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
export function literalCandidates(state) {
  const kinds = new Map(PART_KINDS.map(kind => [kind, kind]));
  for (const part of state.parts) kinds.set(part.label, part.kind);
  const prefix = [...kinds.keys()].sort((a, b) => b.length - a.length).map(escaped).join("|");
  const quote = '(?:「[^「」\\r\\n]+」|"[^"\\r\\n]+")';
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${prefix})\\s*(?:「([^「」\\r\\n]+)」|"([^"\\r\\n]+)")\\s*(?:(?:[×x]\\s*|を\\s*)([0-9]+)(?:個|つ)?)?`, "gu");
  const rows = new Map(), spans = [], seen = new Set();
  let invalid = false;
  const add = (label, kind, quantity, start, end, counted) => {
    if (!label.trim() || label.length > LABEL_MAX || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 3)
      { invalid = true; return; }
    const id = JSON.stringify([start, end, label]);
    if (seen.has(id)) return;
    seen.add(id);
    // Uncounted mentions of an existing node are references in this deliberately
    // conservative baseline. Explicit counted mentions remain new instances.
    if (!counted && state.regions.some(r => r.label === label && r.kind === kind)) return;
    const key = JSON.stringify([label, kind]);
    if (!rows.has(key)) rows.set(key, { label, kind, quantity: 0 });
    rows.get(key).quantity += quantity;
    spans.push({ start, end, source: state.utterance.slice(start, end), label, kind, quantity });
  };
  for (const match of state.utterance.matchAll(pattern)) {
    const label = match[2] ?? match[3], start = match.index + match[0].indexOf(label);
    const rest = state.utterance.slice(match.index + match[0].length);
    const tail = rest.trimStart();
    if (match[4] === undefined ? /^[×x]/u.test(tail)
      || tail.startsWith("を") && !/^(?:追加|作|置)/u.test(tail.slice(1).trimStart())
      : /^(?:[0-9A-Za-z_+\-]|\.[0-9])/u.test(rest)) { invalid = true; continue; }
    add(label, kinds.get(match[1]), match[4] === undefined ? 1 : Number(match[4]), start, start + label.length, match[4] !== undefined);
  }
  const after = new RegExp(`((?:${quote}\\s*(?:[、,と]\\s*)?)+)という(?:名前の|([0-9]+)(?:つ|個)の)?(${prefix})(?![A-Za-z0-9_])`, "gu");
  for (const match of state.utterance.matchAll(after)) {
    const names = [...match[1].matchAll(/「([^「」\r\n]+)」|"([^"\r\n]+)"/gu)];
    const count = match[2] === undefined ? null : Number(match[2]);
    if (names.length > 1 && count !== null && count !== names.length) { invalid = true; continue; }
    for (const name of names) {
      const label = name[1] ?? name[2], start = match.index + name.index + 1;
      add(label, kinds.get(match[3]), names.length === 1 && count !== null ? count : 1,
        start, start + label.length, count !== null);
    }
  }
  const stock = [...new Set(state.parts.map(p => p.label))].sort((a, b) => b.length - a.length).map(escaped).join("|");
  if (stock) for (const match of state.utterance.matchAll(new RegExp(`(?<![A-Za-z0-9_])(${stock})\\s*を\\s*([0-9]+)(?:個|つ)\\s*(?:追加|作|置)`, "gu")))
    add(match[1], kinds.get(match[1]), Number(match[2]), match.index, match.index + match[1].length, true);
  if (invalid) return { missing: [], extraction: { status: "unsupported-syntax", spans } };
  const missingRows = [...rows.values()].flatMap(row => {
    const capacity = state.parts.filter(p => p.label === row.label && p.kind === row.kind).length;
    return row.quantity > capacity ? [{ ...row, quantity: row.quantity - capacity }] : [];
  });
  const slots = Object.fromEntries([1, 2, 3].map((n, i) => ["missing" + n,
    missingRows[i] ?? { label: "", kind: "none", quantity: 0 }]));
  const missing = missingRows.length <= 3 ? readTypedMissing(slots) : null;
  return { missing: missing ?? [], extraction: { status: missing === null || !spans.length ? "unsupported-syntax" : "transcribed", spans } };
}
