// G plan extraction: marker sections → plan.set events. Pure, no I/O, no verdicts.
// Anything not literally declared in the marked section stays UNKNOWN.
import { createHash } from 'node:crypto';

export const UNKNOWN = 'UNKNOWN';
export const EXIT_HEADER = Object.freeze(['ノード', '出口条件', '観測述語', '担当根拠', '寄与 requires']);
const EDGE_KINDS = new Set(['dep', 'loop', 'branch']);
const MARKER = /<!--\s*([A-Za-z0-9][A-Za-z0-9._-]*?)-v(\d+)\s*-->/gu;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const known = value => typeof value === 'string' && value.trim().length > 0 ? value.trim() : UNKNOWN;
export const sha256 = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

// Every marker starts a section that runs to the next marker of any slug, or the end of the text.
export function markerSections(text) {
  if (typeof text !== 'string') return [];
  const marks = [...text.matchAll(MARKER)];
  return marks.map((mark, index) => ({
    slug: mark[1],
    version: Number(mark[2]),
    text: text.slice(mark.index, index + 1 < marks.length ? marks[index + 1].index : text.length),
  }));
}

// ---- mermaid flowchart -------------------------------------------------------------

const SHAPES = [
  ['(((', ')))', 'circle2'], ['((', '))', 'circle'], ['([', '])', 'stadium'], ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'], ['[/', '/]', 'parallelogram'], ['[\\', '\\]', 'parallelogram-alt'],
  ['{{', '}}', 'hexagon'], ['(', ')', 'round'], ['[', ']', 'rect'], ['{', '}', 'decision'], ['>', ']', 'flag'],
];
const ID = /[\p{L}\p{N}_]+/uy;
const SPACE = /\s*/y;
const AMP = /\s*&\s*/y;
// Plain links: -->, --->, ---, -.->, -.-, ==>, ===, <-->, --o, --x; optional |label|.
const LINK = /\s*(<?(?:-{2,}|={2,}|-\.+-)[>ox]?)\s*(?:\|([^|]*)\|)?\s*/y;
// Text links: A -- text --> B, A -. text .-> B, A == text ==> B.
const TEXT_LINK = /\s*(--|==|-\.)(?![-.=>])\s*(.+?)\s*(-{2,}>|-{3,}|\.-+>|\.-+|={2,}>|={3,})\s*/y;
const SKIP = /^(?:classDef|class|style|linkStyle|click|direction)\b/u;

function sticky(re, text, at) { re.lastIndex = at; const m = re.exec(text); return m ? [m, re.lastIndex] : [null, at]; }

function readNode(line, at) {
  let [m, pos] = sticky(SPACE, line, at);
  [m, pos] = sticky(ID, line, pos);
  if (!m) return null;
  const node = { id: m[0], label: null, shape: null };
  for (const [open, close, shape] of SHAPES) {
    if (!line.startsWith(open, pos)) continue;
    let start = pos + open.length, end;
    if (line[start] === '"') {
      const quote = line.indexOf('"', start + 1);
      if (quote < 0 || !line.startsWith(close, quote + 1)) return null;
      node.label = line.slice(start + 1, quote); end = quote + 1;
    } else {
      end = line.indexOf(close, start);
      if (end < 0) return null;
      node.label = line.slice(start, end);
    }
    node.shape = shape; pos = end + close.length;
    break;
  }
  const cls = /:::[\p{L}\p{N}_-]+/uy; cls.lastIndex = pos;
  if (cls.exec(line)) pos = cls.lastIndex;
  return [node, pos];
}

function readGroup(line, at) {
  const first = readNode(line, at);
  if (!first) return null;
  const nodes = [first[0]];
  let pos = first[1];
  for (;;) {
    const [amp, next] = sticky(AMP, line, pos);
    if (!amp) break;
    const node = readNode(line, next);
    if (!node) return null;
    nodes.push(node[0]); pos = node[1];
  }
  return [nodes, pos];
}

function readLink(line, at) {
  let [m, pos] = sticky(TEXT_LINK, line, at);
  if (m) return [{ arrow: `${m[1]}${m[3]}`, label: m[2] }, pos];
  [m, pos] = sticky(LINK, line, at);
  if (m) return [{ arrow: m[1], label: m[2] ?? null }, pos];
  return null;
}

const styleOf = arrow => arrow.includes('.') ? 'dotted' : arrow.includes('=') ? 'thick' : 'solid';

// Edge kind is declared only by a label prefix `dep:`, `loop:` or `branch:` (or the bare word).
// Arrow style, self-reference and decision shapes are not declarations; those edges stay UNKNOWN.
function edgeKind(label) {
  if (label === null) return [UNKNOWN, null];
  label = label.trim().replace(/^"(.*)"$/u, '$1');
  const m = /^\s*(dep|loop|branch)\s*(?::\s*(.*))?$/u.exec(label);
  if (m && EDGE_KINDS.has(m[1])) return [m[1], m[2] === undefined || m[2].trim() === '' ? null : m[2].trim()];
  return [UNKNOWN, label.trim() === '' ? null : label.trim()];
}

export function parseFlowchart(source) {
  const lines = source.split(/\r?\n/u).flatMap(line => line.replace(/%%.*$/u, '').split(';')).map(line => line.trim()).filter(Boolean);
  const header = lines.shift() ?? '';
  if (!/^(?:flowchart|graph)\b/u.test(header)) return null;
  const nodes = new Map(), edges = [], unparsed = [], groups = new Map(), stack = [];
  const touch = node => {
    const seen = nodes.get(node.id) ?? { id: node.id, label: null, shape: null, groups: new Set() };
    if (node.label !== null && seen.label === null) { seen.label = node.label; seen.shape = node.shape; }
    for (const group of stack) { seen.groups.add(group); groups.get(group).add(node.id); }
    nodes.set(node.id, seen);
    return node.id;
  };
  for (const line of lines) {
    const sub = /^subgraph\s+(?:([\p{L}\p{N}_]+)\s*(?:\[\s*"?(.*?)"?\s*\])?|"(.*)")\s*$/u.exec(line);
    if (sub) {
      const id = sub[1] ?? sub[3];
      stack.push(id);
      if (!groups.has(id)) groups.set(id, new Set());
      continue;
    }
    if (line === 'end') { if (stack.length) stack.pop(); else unparsed.push(line); continue; }
    if (SKIP.test(line)) continue;
    const parsed = [];
    let group = readGroup(line, 0);
    if (!group) { unparsed.push(line); continue; }
    parsed.push({ nodes: group[0] });
    let pos = group[1], ok = true;
    for (;;) {
      const link = readLink(line, pos);
      if (!link) break;
      group = readGroup(line, link[1]);
      if (!group) { ok = false; break; }
      parsed.push({ link: link[0] }, { nodes: group[0] });
      pos = group[1];
    }
    if (!ok || line.slice(pos).trim() !== '') { unparsed.push(line); continue; }
    const ids = parsed.map(part => part.nodes?.map(touch));
    for (let i = 1; i < parsed.length; i += 2) {
      const [kind, condition] = edgeKind(parsed[i].link.label);
      for (const from of ids[i - 1]) for (const to of ids[i + 1])
        edges.push({ from, to, kind, condition, style: styleOf(parsed[i].link.arrow) });
    }
  }
  // A subgraph id used as an endpoint expands to its member nodes; the subgraph itself is not a node.
  const members = id => groups.has(id) ? [...expand(id, new Set())] : [id];
  function expand(id, seen) {
    if (seen.has(id)) return [];
    seen.add(id);
    return [...groups.get(id)].flatMap(member => groups.has(member) ? expand(member, seen) : [member]);
  }
  const expanded = edges.flatMap(edge => members(edge.from).flatMap(from => members(edge.to).map(to => ({ ...edge, from, to }))));
  for (const id of groups.keys()) if (nodes.get(id)?.label === null) nodes.delete(id);
  return {
    nodes: [...nodes.values()].map(node => ({ id: node.id, label: known(node.label ?? ''), shape: node.shape ?? UNKNOWN, groups: [...node.groups].sort(compare) })),
    edges: expanded,
    unparsed,
  };
}

// ---- exit table ----------------------------------------------------------------------

const cells = line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
const bare = cell => cell.replace(/^`(.*)`$/u, '$1').trim();

// Only a table whose header equals EXIT_HEADER is read. Returns null when there is none.
export function parseExitTable(text) {
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) continue;
    const head = cells(lines[i]);
    if (head.length !== EXIT_HEADER.length || head.some((cell, k) => cell !== EXIT_HEADER[k])) continue;
    if (!cells(lines[i + 1]).every(cell => /^:?-+:?$/u.test(cell))) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
      const row = cells(lines[j]);
      if (row.length !== EXIT_HEADER.length) continue;
      const [node, exit, predicate, owner, requires] = row.map(bare);
      if (node) rows.push({ node, exit: known(exit), predicate: known(predicate), owner: known(owner), requires: known(requires) });
    }
    return rows;
  }
  return null;
}

// ---- plan.set ------------------------------------------------------------------------

function flowchartsIn(text) {
  return [...text.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/gu)].map(m => m[1]);
}

export function timestamp(value, at) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error(`atlas-collect: ${at}: expected an ISO-8601 timestamp, got ${JSON.stringify(value)}`);
  return Date.parse(value);
}

// documents: [{repo:'resources', number:25, commentId:null|number, updatedAt, text}] — body and comments.
export function planEvents(documents, recordedAt) {
  const recorded = timestamp(recordedAt, 'recordedAt');
  const bySlug = new Map();
  for (const doc of documents) {
    if (timestamp(doc.updatedAt, `${doc.repo}#${doc.number}${doc.commentId === null ? '' : ` comment ${doc.commentId}`} updated_at`) > recorded)
      throw new Error(`atlas-collect: ${doc.repo}#${doc.number} updated_at ${doc.updatedAt} is after recordedAt ${recordedAt}`);
    // A worklog-v1 section is a work log (worklog.mjs), not a plan.
    for (const section of markerSections(doc.text).filter(value => value.slug !== 'worklog')) {
      const key = `${doc.repo}#${doc.number}:${section.slug}`;
      const list = bySlug.get(key) ?? [];
      list.push({ doc, section });
      bySlug.set(key, list);
    }
  }
  const events = [];
  for (const [key, list] of [...bySlug].sort(([a], [b]) => compare(a, b))) {
    const version = Math.max(...list.map(item => item.section.version));
    const current = list.filter(item => item.section.version === version);
    const digests = new Set(current.map(item => sha256(item.section.text)));
    const { doc, section } = current[0];
    const qualify = id => `${doc.repo}#${doc.number}:${id}`;
    const source = { repo: `${doc.repo}#${doc.number}`, commentId: doc.commentId, updatedAt: doc.updatedAt, sha256: sha256(section.text),
      ...(doc.source?.capture ? { capture: doc.source.capture } : {}) }; // read from cold: where it was confirmed
    // The author of the text that carries the section (gh comment author), only when the snapshot has it.
    const base = { kind: 'plan.set', plan: key, version, source, recordedAt, ...(doc.author ? { actor: doc.author } : {}) };
    if (digests.size > 1) {
      // Same version declared twice with different text: no winner is chosen.
      events.push({ ...base, source: current.map(item => ({ repo: source.repo, commentId: item.doc.commentId, updatedAt: item.doc.updatedAt, sha256: sha256(item.section.text) })),
        nodes: UNKNOWN, edges: UNKNOWN, exits: UNKNOWN, unknown: ['conflicting-version'] });
      continue;
    }
    const charts = flowchartsIn(section.text).map(parseFlowchart).filter(Boolean);
    const table = parseExitTable(section.text);
    const unknown = [];
    if (charts.length !== 1) unknown.push(charts.length ? 'multiple-flowcharts' : 'flowchart-absent');
    if (table === null) unknown.push('exit-table-absent');
    const chart = charts.length === 1 ? charts[0] : null;
    if (chart?.unparsed.length) unknown.push('flowchart-unparsed-lines');
    const rows = new Map();
    for (const row of table ?? []) {
      if (rows.has(row.node)) { rows.set(row.node, null); continue; } // duplicated row → that node UNKNOWN
      rows.set(row.node, row);
    }
    const exitOf = id => {
      const row = rows.get(id);
      return row ? { exit: row.exit, predicate: row.predicate, owner: row.owner, requires: row.requires }
        : { exit: UNKNOWN, predicate: UNKNOWN, owner: UNKNOWN, requires: UNKNOWN };
    };
    const ids = chart ? chart.nodes.map(node => node.id) : [];
    const tableOnly = [...rows.keys()].filter(id => !ids.includes(id)).sort(compare);
    events.push({
      ...base,
      nodes: chart ? chart.nodes.map(node => ({ id: qualify(node.id), label: node.label, shape: node.shape, groups: node.groups.map(qualify), ...exitOf(node.id) })) : UNKNOWN,
      edges: chart ? chart.edges.map(edge => ({ from: qualify(edge.from), to: qualify(edge.to), kind: edge.kind, condition: edge.condition ?? UNKNOWN, style: edge.style })) : UNKNOWN,
      exits: table === null ? UNKNOWN : [...ids, ...tableOnly].map(id => ({ node: qualify(id), ...exitOf(id) })),
      ...(chart?.unparsed.length ? { unparsed: chart.unparsed } : {}),
      unknown,
    });
  }
  return events;
}
