// Purpose Closure is an application projection, never a decision authority.
const SCHEMA = 'atlas.purpose-closure/1';
const COMMON = ['kind', 'id', 'label', 'sources'];
const FIELDS = Object.freeze({
  purpose: ['parents'],
  ideal: ['purposes', 'value'],
  current: ['value'],
  gap: ['current', 'ideal', 'delta', 'owner', 'proof'],
  fill: ['gaps', 'scope'],
  receipt: ['fill', 'status', 'evidence'],
  residual: ['receipt', 'next'],
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new Error(`atlas-closure: ${message}`); };
const demand = (condition, message) => { if (!condition) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// All accepted leaves are strings/booleans. Keys and set-valued arrays have an
// explicit order; no locale, source order, clock or provider chooses a winner.
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort(compare)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function keys(value, expected, at) {
  demand(object(value), `${at}: expected an object`);
  demand(canonical(Object.keys(value).sort(compare)) === canonical([...expected].sort(compare)),
    `${at}: expected exactly ${expected.join(', ')}`);
}

function text(value, at) {
  demand(typeof value === 'string' && value.trim().length > 0, `${at}: expected nonempty text`);
  return value;
}

function id(value, at) {
  text(value, at);
  demand(!/[\s\u0000-\u001f\u007f]/u.test(value), `${at}: id/ref contains whitespace or control characters`);
  return value;
}

function set(value, at, empty = false) {
  demand(Array.isArray(value) && (empty || value.length > 0), `${at}: expected ${empty ? 'an' : 'a nonempty'} array`);
  const result = value.map((item, index) => text(item, `${at}[${index}]`));
  demand(new Set(result).size === result.length, `${at}: duplicate item`);
  return result.sort(compare);
}

function sources(values, at) {
  demand(Array.isArray(values) && values.length > 0, `${at}: missing source provenance`);
  const byRef = new Map();
  for (const source of values) {
    keys(source, ['sourceRef', 'sourceDigest'], at);
    id(source.sourceRef, `${at}.sourceRef`);
    demand(typeof source.sourceDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(source.sourceDigest),
      `${at}: sourceDigest must be a sha256 digest`);
    const previous = byRef.get(source.sourceRef);
    demand(!previous || previous.sourceDigest === source.sourceDigest, `${at}: conflicting source revision ${source.sourceRef}`);
    byRef.set(source.sourceRef, { ...source });
  }
  return [...byRef.values()].sort((a, b) => compare(a.sourceRef, b.sourceRef));
}

function parse(line, at) {
  let value;
  try { value = JSON.parse(line); } catch { fail(`${at}: invalid JSON`); }
  // JSON.parse alone silently chooses the last duplicate key. Scan only its
  // already-valid syntax, including escaped keys, to reject that ambiguity.
  const stack = [];
  for (const token of line.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/gu)) {
    const part = token[0];
    if (part === '{') stack.push(new Set());
    else if (part === '[') stack.push(null);
    else if (part === '}' || part === ']') stack.pop();
    else if (/^\s*:/u.test(line.slice(token.index + part.length))) {
      const key = JSON.parse(part);
      const owner = stack.at(-1);
      demand(owner && !owner.has(key), `${at}: duplicate JSON key ${key}`);
      owner.add(key);
    }
  }
  return value;
}

function normalize(row, at) {
  demand(object(row) && typeof row.kind === 'string' && Object.hasOwn(FIELDS, row.kind), `${at}: unknown record kind`);
  keys(row, [...COMMON, ...FIELDS[row.kind]], at);
  id(row.id, `${at}.id`);
  text(row.label, `${at}.label`);
  const node = { ...row, sources: sources(row.sources, `${at}.sources`) };
  switch (node.kind) {
    case 'purpose': node.parents = set(row.parents, `${at}.parents`, true); break;
    case 'ideal':
      node.purposes = set(row.purposes, `${at}.purposes`);
      text(row.value, `${at}.value`);
      break;
    case 'current': text(row.value, `${at}.value`); break;
    case 'gap':
      for (const field of FIELDS.gap) text(row[field], `${at}.${field}`);
      break;
    case 'fill':
      node.gaps = set(row.gaps, `${at}.gaps`);
      node.scope = set(row.scope, `${at}.scope`);
      break;
    case 'receipt':
      id(row.fill, `${at}.fill`);
      demand(['closed', 'reduced', 'failed'].includes(row.status), `${at}: unknown receipt status`);
      node.evidence = set(row.evidence, `${at}.evidence`);
      break;
    case 'residual':
      id(row.receipt, `${at}.receipt`);
      node.next = set(row.next, `${at}.next`, true);
      break;
  }
  return node;
}

function readDocument(input, index) {
  demand(typeof input === 'string', `input ${index}: expected JSONL text`);
  const lines = input.split(/\r?\n/u).map((line, number) => ({ line, number: number + 1 }))
    .filter(({ line }) => line.trim());
  demand(lines.length > 0, `input ${index}: empty document`);
  const header = parse(lines[0].line, `input ${index}:1`);
  keys(header, ['schema', 'authority'], `input ${index} header`);
  demand(header.schema === SCHEMA && header.authority === false, `input ${index}: unsupported schema or authority claim`);
  return lines.slice(1).map(({ line, number }) => normalize(parse(line, `input ${index}:${number}`), `input ${index}:${number}`));
}

function merge(rows) {
  const byId = new Map();
  for (const row of rows) {
    const previous = byId.get(row.id);
    if (!previous) { byId.set(row.id, row); continue; }
    // Only discovered ancestry/continuation links grow. Empty/subset input is
    // not retraction; every other semantic field must still match exactly.
    const relation = row.kind === 'purpose' ? 'parents' : row.kind === 'residual' ? 'next' : null;
    const omit = { sources: [], ...(relation ? { [relation]: [] } : {}) };
    demand(canonical({ ...previous, ...omit }) === canonical({ ...row, ...omit }), `conflicting record ${row.id}`);
    const joined = { ...row, sources: sources([...previous.sources, ...row.sources], row.id) };
    if (relation) joined[relation] = [...new Set([...previous[relation], ...row[relation]])].sort(compare);
    byId.set(row.id, joined);
  }
  const nodes = [...byId.values()].sort((a, b) => compare(a.id, b.id));
  // One revision-qualified source locator cannot denote two digests, including
  // when its records have different ids. Digests are carried, not authenticated.
  if (nodes.length) sources(nodes.flatMap(node => node.sources), 'joined provenance');
  return nodes;
}

function acyclic(nodes, edges, name) {
  const outgoing = new Map(nodes.map(node => [node.id, new Set()]));
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const [from, to] of edges) {
    if (outgoing.get(from).has(to)) continue;
    outgoing.get(from).add(to);
    degree.set(to, degree.get(to) + 1);
  }
  const queue = [...degree].filter(([, count]) => count === 0).map(([key]) => key);
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of outgoing.get(queue[index])) {
      degree.set(next, degree.get(next) - 1);
      if (degree.get(next) === 0) queue.push(next);
    }
  }
  demand(queue.length === nodes.length, `${name}: cycle`);
}

function validate(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  demand(nodes.some(node => node.kind === 'purpose'), 'no purpose');
  const reference = (node, target, kinds) => {
    id(target, `${node.id}.reference`);
    const found = byId.get(target);
    demand(found && kinds.includes(found.kind), `${node.id}: missing/wrong-kind reference ${target} (expected ${kinds.join('|')})`);
    return found;
  };
  const purposes = [], flow = [], currents = new Set(), receiptByFill = new Map(), residuals = new Map();
  for (const node of nodes) {
    switch (node.kind) {
      case 'purpose':
        for (const parent of node.parents) { reference(node, parent, ['purpose']); purposes.push([parent, node.id]); }
        break;
      case 'ideal':
        for (const target of node.purposes) reference(node, target, ['purpose']);
        break;
      case 'gap':
        reference(node, node.current, ['current']); reference(node, node.ideal, ['ideal']);
        currents.add(node.current); flow.push([node.current, node.id]);
        break;
      case 'fill':
        for (const gap of node.gaps) { reference(node, gap, ['gap']); flow.push([gap, node.id]); }
        break;
      case 'receipt':
        reference(node, node.fill, ['fill']); flow.push([node.fill, node.id]);
        demand(!receiptByFill.has(node.fill), `${node.fill}: multiple effective receipts; reconcile upstream or version the fill`);
        receiptByFill.set(node.fill, node);
        break;
      case 'residual':
        reference(node, node.receipt, ['receipt']); flow.push([node.receipt, node.id]);
        residuals.set(node.receipt, (residuals.get(node.receipt) ?? 0) + 1);
        for (const next of node.next) { reference(node, next, ['current', 'gap']); flow.push([node.id, next]); }
        break;
    }
  }
  for (const node of nodes) {
    if (node.kind === 'current') demand(currents.has(node.id), `${node.id}: current has no purpose path through a gap`);
    if (node.kind === 'receipt') {
      const count = residuals.get(node.id) ?? 0;
      demand(node.status !== 'closed' || count === 0, `${node.id}: closed receipt has residuals`);
      demand(node.status !== 'reduced' || count > 0, `${node.id}: reduced receipt must retain residuals`);
    }
  }
  acyclic(nodes, purposes, 'purpose hierarchy');
  acyclic(nodes, flow, 'closure flow');
}

/**
 * Join complete projection inputs; accept this function's output as input too.
 * References may cross files. Only the final join must be closed and acyclic.
 * @param {...string} inputs JSONL documents with atlas.purpose-closure/1 headers.
 * @returns {string} Canonical, non-authoritative JSONL. Throws before output on error.
 */
export function reduceClosure(...inputs) {
  demand(inputs.length > 0, 'no inputs');
  const nodes = merge(inputs.flatMap(readDocument));
  validate(nodes);
  return [canonical({ schema: SCHEMA, authority: false }), ...nodes.map(canonical)].join('\n') + '\n';
}
