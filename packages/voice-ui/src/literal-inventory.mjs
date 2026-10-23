// Comparison B: an intentionally finite syntax, not a natural-language parser.
// Only explicit quoted names with a neighbouring finite kind, a counted stock label, or stock labels (alone or
// coordinated) before a finite placement verb are transcribed. Unsupported paraphrases remain unsupported.
// No fixture names, oracle, model, inferred parent/edge or persistent dictionary.
import { PART_KINDS, LABEL_MAX } from "./contract.mjs";
import { inventoryLimit, inventoryQuestion, readTypedMissing } from "./completion.mjs";

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// Read only the quantity token. Names/source spans never pass through this
// normalization. Consume unsupported numeric words whole, rather than reading
// a valid prefix (e.g. one out of one hundred) or silently assuming one.
const countPattern = "[0-9０-９〇零一二三四五六七八九十百千万億兆]+|ひと|ふた|みっ";
// The finite set of ordinary placement verbs after a catalogue name: the original 追加/作成/配置 (with an optional
// する form) plus the plain affirmative forms of 置く・作る・加える・入れる. Each form is spelled out, so negative
// or other inflections (置かない, 置きません, 加えず, 入れない) never match a prefix.
const PLACEMENT_VERB = "(?:追加|作成|配置)(?:して|する)?|置いて|置く|作って|作る|加えて|加える|入れて|入れる";
// A verb followed by a prohibition or negation is not a request (R 7/200, apps#177 c6365486846): ては/では/ちゃ +
// いけ/だめ/ならない, a sentence-final or attached な (作るな), ない/ず, ておかない/ておくな, ほしくない, and the
// し/せ/ら/か negative stems a shorter verb alternative could leave behind (追加しないで, 作らない, 置かない).
const NOT_REQUESTED = "\\s*(?:[はで]\\s*(?:いけ|だめ|ダメ|なら|よくな)|ちゃ|じゃ|な(?!さい)|ず|おか(?:な|ず)|おくな"
  + "|ほしくな|欲しくな|し(?:て(?:は|ちゃ)|な|ちゃ)|せず|するな|[らか](?:な|ず))";
const placement = `(?:${PLACEMENT_VERB})(?!${NOT_REQUESTED})`;
// Round 3 (R 13/200): a sentence may go on after the verb in its continuative form (「…を作り、その中に…」). Only
// before a comma, so 作りません or 置きっぱなし never match.
const placementOrContinued = `(?:${placement}|(?:作り|置き|入れ|加え)(?=\\s*[、,，]))`;
// A catalogue name may be followed by という and one short word saying what it is (「Xという…を作る」). The catalogue
// decides the kind; the word is not a vocabulary in code. When the word is itself a catalogue alias (the default
// bundle names a part for each kind), the two kinds must agree. The の form is not read: without a vocabulary it
// cannot tell 「XとYの…を置く」 from 「Xの説明を追加」.
const kindPhrase = "(?:\\s*という\\s*(?:名前の\\s*)?([^\\s、。,，をのにはがと「」『』]{1,12}))?";
// The original short verb stems (追加・作・置) used by the counted and quoted forms take the same guard.
// The guard also looks past the affirmative ending a stem takes (置いて, 作る, 追加して), so 置いてはいけない is refused.
const counted = `(?:追加|作|置)(?!(?:して|する|いて|く|って|る)?${NOT_REQUESTED})`;
const countedAfter = new RegExp(`^${counted}`, "u"), countedObject = new RegExp(`^\\s*を\\s*${counted}`, "u");
// After an explicit count the verb was never read; a negated or prohibited verb there now refuses the mention.
const negatedVerb = new RegExp(`^\\s*(?:だけ|ずつ)?\\s*(?:${PLACEMENT_VERB}|追加|作|置)${NOT_REQUESTED}`, "u");
const digits = "一二三四五六七八九";
const countOf = value => {
  const number = value.replace(/[０-９]/gu, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  if (/^[0-9]+$/u.test(number)) return Number(number);
  const counted = ["ひと", "ふた", "みっ"].indexOf(number);
  if (counted !== -1) return counted + 1;
  if (number.length === 1 && digits.includes(number)) return digits.indexOf(number) + 1;
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(number);
  return tens ? (tens[1] ? digits.indexOf(tens[1]) + 1 : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) + 1 : 0) : NaN;
};
const numericTail = /^(?:[0-9０-９A-Za-z_+＋\-－/／〇零一二三四五六七八九十百千万億兆]|[.．][0-9０-９一二三四五六七八九])/u;
export function literalInventory(state) {
  const max = inventoryLimit(state);
  const kinds = new Map(PART_KINDS.map(kind => [kind, kind]));
  const stockKinds = new Map();
  for (const part of state.parts) {
    if (!stockKinds.has(part.label)) stockKinds.set(part.label, new Set());
    stockKinds.get(part.label).add(part.kind);
  }
  // A label may name several kinds. Only an unambiguous alias can transcribe
  // a kind; catalogue names never redefine the primitive kind vocabulary.
  const stockKind = label => [...stockKinds.get(label)][0];
  for (const [label, values] of stockKinds) {
    if (values.size === 1 && !kinds.has(label)) kinds.set(label, stockKind(label));
  }
  const prefix = [...kinds.keys()].sort((a, b) => b.length - a.length).map(escaped).join("|");
  const quote = '(?:「[^「」\\r\\n]+」|"[^"\\r\\n]+")';
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${prefix})\\s*(?:「([^「」\\r\\n]+)」|"([^"\\r\\n]+)")\\s*(?:(?:[×x]\\s*|を\\s*)(${countPattern})(?:個|つ)?)?`, "dgu");
  const rows = new Map(), spans = [], seen = new Set(), claimed = [];
  let invalid = false;
  const add = (label, kind, quantity, start, end, counted) => {
    if (!label.trim() || label.length > LABEL_MAX || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > max)
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
    claimed.push([match.index, match.index + match[0].length]);
    // Capture offsets identify the quoted name even when it repeats its kind or alias.
    const label = match[2] ?? match[3], start = (match.indices[2] ?? match.indices[3])[0];
    const rest = state.utterance.slice(match.index + match[0].length);
    const tail = rest.trimStart();
    if (match[4] === undefined ? /^[×x]/u.test(tail)
      || tail.startsWith("を") && !countedAfter.test(tail.slice(1).trimStart())
      : numericTail.test(rest) || negatedVerb.test(rest)) { invalid = true; continue; }
    add(label, kinds.get(match[1]), match[4] === undefined ? 1 : countOf(match[4]), start, start + label.length, match[4] !== undefined);
  }
  const after = new RegExp(`((?:${quote}\\s*(?:[、,と]\\s*)?)+)という(?:名前の|(${countPattern})(?:つ|個)の)?(${prefix})(?![A-Za-z0-9_])`, "gu");
  for (const match of state.utterance.matchAll(after)) {
    claimed.push([match.index, match.index + match[0].length]);
    const names = [...match[1].matchAll(/「([^「」\r\n]+)」|"([^"\r\n]+)"/gu)];
    const count = match[2] === undefined ? null : countOf(match[2]);
    const rest = state.utterance.slice(match.index + match[0].length);
    const suffix = new RegExp(`^\\s*を\\s*(${countPattern})(?:個|つ)(だけ|ずつ)?`, "u").exec(rest);
    if (suffix === null ? /^\s*を/u.test(rest) && !countedObject.test(rest)
      : numericTail.test(rest.slice(suffix[0].length)) || negatedVerb.test(rest.slice(suffix[0].length))) { invalid = true; continue; }
    const following = suffix === null ? null : countOf(suffix[1]);
    if (names.length > 1 && count !== null && count !== names.length) { invalid = true; continue; }
    if (names.length > 1 && following !== null && suffix[2] !== "ずつ" && following !== names.length
      || names.length === 1 && count !== null && following !== null && count !== following) { invalid = true; continue; }
    for (const name of names) {
      const label = name[1] ?? name[2], start = match.index + name.index + 1;
      add(label, kinds.get(match[3]), following !== null && suffix[2] === "ずつ" ? following
        : names.length === 1 ? following ?? count ?? 1 : 1,
        start, start + label.length, count !== null || following !== null);
    }
  }
  // A shared count applies to each explicitly coordinated catalogue name only
  // with `ずつ`. Quoted names have already claimed their text. Names containing
  // list separators, or two possible catalogue readings, need interpretation.
  const listNames = [...stockKinds.keys()].filter(label => !/[、,と「」"]/u.test(label))
    .sort((a, b) => b.length - a.length).map(escaped).join("|");
  if (listNames) {
    const list = new RegExp(`(?<![A-Za-z0-9_])((?:${listNames})\\s*(?:[、,と]\\s*(?:${listNames})\\s*)+)を\\s*(${countPattern})(?:個|つ)ずつ\\s*${counted}`, "dgu");
    for (const match of state.utterance.matchAll(list)) {
      const end = match.index + match[0].length;
      if (claimed.some(([start, stop]) => start < end && match.index < stop)) continue;
      claimed.push([match.index, end]);
      const names = [...match[1].matchAll(new RegExp(listNames, "dgu"))];
      // Do not choose between a coordinated list and a single catalogue name,
      // including a composite name covering only part of a longer list.
      const ambiguous = names.some(name => stockKinds.get(name[0]).size !== 1)
        || names.some((name, i) => names.slice(i + 1).some(last =>
          stockKinds.has(match[1].slice(name.index, last.index + last[0].length))));
      if (ambiguous) { invalid = true; continue; }
      for (const name of names) {
        const start = match.indices[1][0] + name.index;
        add(name[0], stockKind(name[0]), countOf(match[2]), start, start + name[0].length, true);
      }
    }
    // An uncounted coordination of catalogue names followed by an ordinary placement verb asks for one new
    // instance of each (「AとBを加えて」「A、Bを置く」). The same ambiguity refusals as the counted form apply.
    const plain = new RegExp(`(?<![A-Za-z0-9_])((?:${listNames})(?:\\s*(?:[、,と]|および|及び)\\s*(?:${listNames}))+)${kindPhrase}\\s*[をも]\\s*${placementOrContinued}`, "dgu");
    for (const match of state.utterance.matchAll(plain)) {
      const end = match.index + match[0].length;
      if (claimed.some(([start, stop]) => start < end && match.index < stop)) continue;
      claimed.push([match.index, end]);
      const names = [...match[1].matchAll(new RegExp(listNames, "dgu"))];
      const ambiguous = names.some(name => stockKinds.get(name[0]).size !== 1)
        || names.some((name, i) => names.slice(i + 1).some(last =>
          stockKinds.has(match[1].slice(name.index, last.index + last[0].length))))
        || match[2] !== undefined && kinds.has(match[2]) && names.some(name => stockKind(name[0]) !== kinds.get(match[2]));
      if (ambiguous) { invalid = true; continue; }
      for (const name of names) {
        const start = match.indices[1][0] + name.index;
        add(name[0], stockKind(name[0]), 1, start, start + name[0].length, true);
      }
    }
  }
  const stock = [...stockKinds.keys()].filter(label => stockKinds.get(label).size === 1).sort((a, b) => b.length - a.length).map(escaped).join("|");
  if (stock) for (const match of state.utterance.matchAll(new RegExp(`(?<![A-Za-z0-9_])(${stock})\\s*を\\s*(${countPattern})(?:個|つ)(?:だけ|ずつ)?\\s*${counted}`, "gu")))
    if (!claimed.some(([start, end]) => start <= match.index && match.index < end))
      add(match[1], stockKind(match[1]), countOf(match[2]), match.index, match.index + match[1].length, true);
  if (stock) for (const match of state.utterance.matchAll(new RegExp(`(?<![A-Za-z0-9_])(${stock})${kindPhrase}\\s*(?:[をも]\\s*)?${placementOrContinued}`, "gu"))) {
    if (claimed.some(([start, end]) => start <= match.index && match.index < end)) continue;
    // The word right after という says what the name before it is, even when the same word is a catalogue label
    // (the default bundle has a part named for each kind); it is never a second part.
    if (/という\s*(?:名前の\s*)?$/u.test(state.utterance.slice(0, match.index))) continue;
    if (match[2] !== undefined && kinds.has(match[2]) && stockKind(match[1]) !== kinds.get(match[2])) { invalid = true; continue; }
    add(match[1], stockKind(match[1]), 1, match.index, match.index + match[1].length, true);
  }
  if (invalid) return { valid: false, recognized: spans.length > 0, required: [], missing: [], spans, status: "unsupported-syntax" };
  const missingRows = [...rows.values()].flatMap(row => {
    const capacity = state.parts.filter(p => p.label === row.label && p.kind === row.kind).length;
    return row.quantity > capacity ? [{ ...row, quantity: row.quantity - capacity }] : [];
  });
  const slots = Object.fromEntries(Array.from({ length: max }, (_, i) => i + 1).map((n, i) => ["missing" + n,
    missingRows[i] ? { ...missingRows[i], quantity: String(missingRows[i].quantity) }
      : { label: "", kind: "none", quantity: "0" }]));
  const missing = missingRows.length <= max ? readTypedMissing(slots, { max }) : null;
  return { valid: missing !== null && [...rows.values()].reduce((n, row) => n + row.quantity, 0) <= max,
    recognized: spans.length > 0, required: [...rows.values()], missing: missing ?? [], spans,
    status: missing === null || !spans.length ? "unsupported-syntax" : "transcribed" };
}

// Recognition is literal evidence. Completeness remains an explicit Jev choice,
// never a parser theorem or authority to invent a parent, edge or operation.
export function literalQuestion(state, extracted) {
  const request = inventoryQuestion(state);
  return { ...request, state: { ...request.state, literal: {
    recognized: extracted.recognized, required: extracted.required, spans: extracted.spans,
  } }, questions: { ...request.questions, intent: { ...request.questions.intent,
    instruction: request.questions.intent.instruction
      + " Judge the requested operation, not whether a label already appears in the picture. An explicit addition requests NEW instances; the existing group named as destination is only a parent reference. "
      + "『AにBをN個追加』は既存のAの中へ新しいBをN個増やす要求です。AやBが既に存在しても、その追加要求は満たされていません。在庫不足と配置可否はこの意図判定とは別です。 "
      + "A requested new part needs an explicit displayed name or identifiable offered part and a supported kind. A count alone does not identify a part. "
      + "Judge intent from the original utterance and existing graph, independently of literal transcription. An empty or partial state.literal is not by itself an ambiguous request; the completeness question evaluates that omission. Choose ambiguous only when the original request itself leaves an extra requested part, parent, endpoint or count impossible to uniquely understand.",
    options: { ...request.questions.intent.options,
      change: request.questions.intent.options.change + " 明確な追加または接続の要求。既存ノードと同じ名前の新規追加も含む。",
      "no-change": "No change is requested, or a requested existing-state fact is already satisfied. An explicit request to ADD more instances is never satisfied merely by an existing matching label. 追加の指示がなく、変更不要な場合。",
    },
  }, completeness: {
    instruction: "Independently compare ALL requested NEW parts in the original utterance with state.literal.required and its source spans. "
      + "Check exact displayed labels, kinds and total NEW counts, including inside new groups. Existing graph references are not requests for additional instances. "
      + "Choose incomplete if any requested new part is omitted, only partially understood, has an unspecified name/kind/count, or is represented with the wrong quantity. "
      + "Do not assume a nonempty extraction covers the whole utterance. Do not infer or generate missing parts. "
      + "A clear connection between existing endpoints, or no change, needs no new parts and may have an empty required multiset.",
    options: { complete: "The required multiset exactly covers every requested new part, or the clear request needs no new parts.",
      incomplete: "At least one requested new part is unspecified, omitted, extra, mismatched or not fully represented in the literal required multiset." },
  } } };
}
