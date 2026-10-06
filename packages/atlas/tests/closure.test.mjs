import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { reduceClosure } from '../closure.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const purpose = fs.readFileSync(path.join(root, 'fixtures/purpose.jsonl'), 'utf8');
const current = fs.readFileSync(path.join(root, 'fixtures/current.jsonl'), 'utf8');
const header = { schema: 'atlas.purpose-closure/1', authority: false };
const parse = value => value.trim().split('\n').map(line => JSON.parse(line));
const inputRows = () => [...parse(purpose).slice(1), ...parse(current).slice(1)];
const doc = (rows, meta = header) => [meta, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n';
const changed = fn => { const rows = inputRows(); fn(rows); return doc(rows); };
const find = (rows, id) => rows.find(row => row.id === id);
const result = () => parse(reduceClosure(purpose, current));
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const extraSource = { sourceRef: 'fixture:upstream@1', sourceDigest: sha('synthetic upstream projection') };
const extraPurpose = { kind: 'purpose', id: 'purpose.upstream', label: '例：別の上流', parents: ['purpose.company'], sources: [extraSource] };

// Independent consumer traversal. No validation/sorting helper is imported.
function pathsToPurpose(rows, start) {
  const nodes = new Map(rows.map(row => [row.id, row]));
  const paths = [], queue = [[start]];
  while (queue.length) {
    const trail = queue.pop(), node = nodes.get(trail.at(-1));
    assert.ok(node, trail.join(' -> '));
    let next;
    switch (node.kind) {
      case 'purpose': next = node.parents; break;
      case 'ideal': next = node.purposes; break;
      case 'current': next = rows.filter(row => row.kind === 'gap' && row.current === node.id).map(row => row.id); break;
      case 'gap': next = [node.ideal]; break;
      case 'fill': next = node.gaps; break;
      case 'receipt': next = [node.fill]; break;
      case 'residual': next = [node.receipt]; break;
      default: assert.fail('unexpected kind');
    }
    if (next.length === 0) { assert.equal(node.kind, 'purpose'); paths.push(trail); }
    for (const target of next) { assert.ok(!trail.includes(target)); queue.push([...trail, target]); }
  }
  return paths;
}

test('all eight meanings: seven distinct node kinds plus explicit purpose closure paths', () => {
  const [meta, ...nodes] = result();
  assert.deepEqual(meta, header);
  assert.equal(nodes.length, 13);
  assert.deepEqual([...new Set(nodes.map(row => row.kind))].sort(), ['current', 'fill', 'gap', 'ideal', 'purpose', 'receipt', 'residual']);
  for (const node of nodes) {
    const paths = pathsToPurpose(nodes, node.id);
    assert.ok(paths.length > 0, node.id);
    assert.ok(paths.every(trail => trail.at(-1) === 'purpose.company'), node.id);
  }
  const trails = pathsToPurpose(nodes, 'residual.source');
  assert.equal(trails.length, 2);
  assert.ok(trails.every(trail => trail.slice(0, 5).join('/') === 'residual.source/receipt.partial/fill.extraction/gap.extraction/ideal.extraction'));
  const gap = find(nodes, 'gap.extraction');
  assert.equal(find(nodes, gap.current).kind, 'current');
  assert.equal(find(nodes, gap.ideal).kind, 'ideal');
  assert.ok(gap.delta && gap.owner && gap.proof);
  assert.deepEqual(find(nodes, 'residual.source').next, ['gap.source']);
});

test('reduce preserves every declared meaning and source instead of inventing business completion', () => {
  const [meta, ...nodes] = result();
  for (const original of inputRows()) {
    const output = find(nodes, original.id);
    for (const [key, value] of Object.entries(original)) {
      assert.deepEqual(output[key], Array.isArray(value) && key !== 'sources' ? [...value].sort() : value);
    }
  }
  assert.equal(meta.authority, false);
  assert.equal(find(nodes, 'receipt.partial').status, 'reduced');
  assert.equal(nodes.filter(node => node.kind === 'receipt' && node.fill === 'fill.source').length, 0);
  assert.ok(nodes.filter(node => node.kind === 'purpose').every(node => !('status' in node) && !('progress' in node)));
});

test('deterministic canonical bytes across order, keys, whitespace and input roles', () => {
  const originalPurpose = purpose, originalCurrent = current;
  const shuffled = inputRows().reverse().map(row => Object.fromEntries(Object.entries(row).reverse()
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].reverse() : value])));
  assert.equal(reduceClosure(purpose, current), reduceClosure(current, purpose));
  assert.equal(reduceClosure(purpose, current), reduceClosure(doc(shuffled)));
  assert.equal(reduceClosure(purpose, current), reduceClosure(purpose.replaceAll('\n', '\r\n'), '\n' + current));
  assert.equal(purpose, originalPurpose); assert.equal(current, originalCurrent);
});

test('output is the same reusable contract: identity, overlap and a later tributary', () => {
  const reduced = reduceClosure(purpose, current);
  assert.equal(reduceClosure(reduced), reduced);
  assert.equal(reduceClosure(reduced, purpose, current), reduced);
  assert.equal(reduceClosure(reduced, doc([extraPurpose])), reduceClosure(purpose, current, doc([extraPurpose])));
});

test('a purpose may depend on upstream arriving in the other JSONL; no source is privileged', () => {
  const a = parse(purpose).slice(1), b = parse(current).slice(1);
  a.find(row => row.id === 'purpose.company').parents = ['purpose.external'];
  b.push({ ...extraPurpose, id: 'purpose.external', parents: [] });
  const reduced = parse(reduceClosure(doc(a), doc(b))).slice(1);
  assert.ok(pathsToPurpose(reduced, 'gap.extraction').every(trail => trail.at(-1) === 'purpose.external'));
});

test('consistent duplicate meanings merge provenance, rather than losing an upstream source', () => {
  const original = inputRows()[0], duplicate = { ...original, sources: [extraSource] };
  const joined = parse(reduceClosure(purpose, current, doc([duplicate]))).slice(1);
  assert.equal(find(joined, original.id).sources.length, 2);
  assert.deepEqual(new Set(find(joined, original.id).sources.map(source => source.sourceRef)), new Set([original.sources[0].sourceRef, extraSource.sourceRef]));
});

test('open gaps, a fill without a result, and an unassigned next step stay explicitly open', () => {
  const reduced = reduceClosure(changed(rows => { find(rows, 'residual.source').next = []; }));
  assert.deepEqual(find(parse(reduced).slice(1), 'residual.source').next, []);
  assert.doesNotThrow(() => reduceClosure(changed(rows => { rows.splice(rows.findIndex(row => row.id === 'fill.source'), 1); })));
});

test('a closed receipt is not a closed purpose; absence of residual does not imply a goal verdict', () => {
  const rows = inputRows().filter(row => row.kind !== 'residual');
  find(rows, 'receipt.partial').status = 'closed';
  const output = parse(reduceClosure(doc(rows))).slice(1);
  assert.equal(find(output, 'receipt.partial').status, 'closed');
  assert.ok(output.filter(node => node.kind === 'purpose').every(node => !Object.hasOwn(node, 'status')));
});

test('valid continuation via a new Current and several later gaps is preserved', () => {
  const rows = inputRows();
  find(rows, 'residual.source').next = ['current.after', 'gap.source'];
  const output = parse(reduceClosure(doc(rows))).slice(1);
  assert.deepEqual(find(output, 'residual.source').next, ['current.after', 'gap.source']);
});

test('strings remain data, including punctuation which resembles JSON syntax', () => {
  const label = '"id": "x" }, [ : <script>alert(1)</script> 日本語';
  const output = parse(reduceClosure(changed(rows => { rows[0].label = label; }))).slice(1);
  assert.equal(find(output, 'purpose.company').label, label);
});

const negatives = [
  ['empty input', () => reduceClosure(), /no inputs/u],
  ['empty document', () => reduceClosure(''), /empty document/u],
  ['invalid JSON', () => reduceClosure('{'), /invalid JSON/u],
  ['missing header', () => reduceClosure(inputRows().map(row => JSON.stringify(row)).join('\n')), /expected exactly/u],
  ['unknown schema', () => reduceClosure(doc(inputRows(), { ...header, schema: 'future' })), /unsupported schema/u],
  ['authority claim', () => reduceClosure(doc(inputRows(), { ...header, authority: true })), /authority claim/u],
  ['hidden authority header', () => reduceClosure(doc(inputRows(), { ...header, accepted: true })), /expected exactly/u],
  ['no purpose', () => reduceClosure(doc([])), /no purpose/u],
  ['unknown kind', rows => { rows[0].kind = 'operation'; }, /unknown record kind/u],
  ['prototype kind', rows => { rows[0].kind = '__proto__'; }, /unknown record kind/u],
  ['coerced array kind bypass', rows => { rows.push({ ...find(rows, 'current.before'), id: 'current.untyped', kind: ['current'], value: null }); }, /unknown record kind/u],
  ['object kind', rows => { rows[0].kind = { toString: 'purpose' }; }, /unknown record kind/u],
  ['null kind', rows => { rows[0].kind = null; }, /unknown record kind/u],
  ['boolean kind', rows => { rows[0].kind = true; }, /unknown record kind/u],
  ['null row', rows => { rows[0] = null; }, /unknown record kind/u],
  ['unknown record property', rows => { rows[0].businessComplete = true; }, /expected exactly/u],
  ['empty label', rows => { rows[0].label = ' '; }, /nonempty text/u],
  ['bad id', rows => { rows[0].id = 'bad id'; }, /whitespace/u],
  ['missing provenance', rows => { rows[0].sources = []; }, /missing source provenance/u],
  ['bad digest', rows => { rows[0].sources[0].sourceDigest = 'sha256:short'; }, /sha256 digest/u],
  ['missing source locator', rows => { delete rows[0].sources[0].sourceRef; }, /expected exactly/u],
  ['source claims authority', rows => { rows[0].sources[0].authority = true; }, /expected exactly/u],
  ['conflicting immutable source revision', rows => { rows[0].sources[0].sourceDigest = sha('changed'); }, /conflicting source revision/u],
  ['duplicate conflicting entity', rows => { rows.push({ ...rows[0], label: 'different' }); }, /conflicting record/u],
  ['missing purpose parent', rows => { rows[0].parents = ['absent']; }, /missing\/wrong-kind/u],
  ['wrong-kind purpose parent', rows => { rows[0].parents = ['ideal.source']; }, /missing\/wrong-kind/u],
  ['self purpose cycle', rows => { rows[0].parents = [rows[0].id]; }, /purpose hierarchy: cycle/u],
  ['multi-node purpose cycle', rows => { find(rows, 'purpose.company').parents = ['purpose.reuse']; }, /purpose hierarchy: cycle/u],
  ['duplicate reference', rows => { find(rows, 'ideal.source').purposes = ['purpose.company', 'purpose.company']; }, /duplicate item/u],
  ['ideal without purpose', rows => { find(rows, 'ideal.source').purposes = []; }, /nonempty array/u],
  ['ideal without value', rows => { find(rows, 'ideal.source').value = ''; }, /nonempty text/u],
  ['current without value', rows => { find(rows, 'current.before').value = null; }, /nonempty text/u],
  ['gap missing current', rows => { find(rows, 'gap.extraction').current = 'absent'; }, /missing\/wrong-kind/u],
  ['gap confuses current and ideal', rows => { find(rows, 'gap.extraction').current = 'ideal.extraction'; }, /missing\/wrong-kind/u],
  ['gap without delta', rows => { find(rows, 'gap.extraction').delta = ''; }, /nonempty text/u],
  ['gap without owner', rows => { find(rows, 'gap.extraction').owner = ''; }, /nonempty text/u],
  ['gap without proof', rows => { find(rows, 'gap.extraction').proof = ''; }, /nonempty text/u],
  ['fill missing gap', rows => { find(rows, 'fill.source').gaps = ['absent']; }, /missing\/wrong-kind/u],
  ['fill empty gap set', rows => { find(rows, 'fill.source').gaps = []; }, /nonempty array/u],
  ['fill without scope', rows => { find(rows, 'fill.source').scope = []; }, /nonempty array/u],
  ['receipt missing fill', rows => { find(rows, 'receipt.partial').fill = 'absent'; }, /missing\/wrong-kind/u],
  ['receipt unknown status', rows => { find(rows, 'receipt.partial').status = 'purpose-completed'; }, /unknown receipt status/u],
  ['receipt without evidence', rows => { find(rows, 'receipt.partial').evidence = []; }, /nonempty array/u],
  ['conflicting effective receipts', rows => { rows.push({ ...find(rows, 'receipt.partial'), id: 'receipt.second' }); }, /multiple effective receipts/u],
  ['closed receipt with residual', rows => { find(rows, 'receipt.partial').status = 'closed'; }, /closed receipt has residuals/u],
  ['reduced receipt loses residual', rows => { rows.splice(rows.findIndex(row => row.kind === 'residual'), 1); }, /must retain residuals/u],
  ['residual missing receipt', rows => { find(rows, 'residual.source').receipt = 'absent'; }, /missing\/wrong-kind/u],
  ['residual missing next', rows => { find(rows, 'residual.source').next = ['absent']; }, /missing\/wrong-kind/u],
  ['residual wrong next kind', rows => { find(rows, 'residual.source').next = ['fill.source']; }, /missing\/wrong-kind/u],
  ['cyclic next gap', rows => { find(rows, 'residual.source').next = ['gap.extraction']; }, /closure flow: cycle/u],
  ['cyclic next current', rows => { find(rows, 'residual.source').next = ['current.before']; }, /closure flow: cycle/u],
  ['orphan current', rows => { rows.push({ ...find(rows, 'current.before'), id: 'current.orphan' }); }, /no purpose path/u],
];
for (const [name, mutation, expected] of negatives) {
  test(`reject: ${name}`, () => assert.throws(() => mutation.length ? reduceClosure(changed(mutation)) : mutation(), expected));
}

for (const kind of ['purpose', 'ideal', 'current', 'gap', 'fill', 'receipt', 'residual']) {
  test(`reject: missing required field of ${kind}`, () => {
    const row = inputRows().find(item => item.kind === kind);
    const field = Object.keys(row).find(key => !['id', 'kind', 'label', 'sources'].includes(key));
    assert.throws(() => reduceClosure(changed(rows => { delete find(rows, row.id)[field]; })), /expected exactly/u);
  });
}

test('reject duplicate and escaped-equivalent JSON keys, never use last-key-wins', () => {
  assert.throws(() => reduceClosure(purpose.replace('"authority":false', '"authority":true,"authority":false'), current), /duplicate JSON key authority/u);
  assert.throws(() => reduceClosure(purpose.replace('"authority":false', '"\\u0061uthority":true,"authority":false'), current), /duplicate JSON key authority/u);
  assert.throws(() => reduceClosure(purpose.replace('"parents":[]', '"parents":["missing"],"parents":[]'), current), /duplicate JSON key parents/u);
});

test('large upstream hierarchy is validated without recursive call-stack growth', () => {
  const count = 4000;
  const rows = Array.from({ length: count }, (_, index) => ({
    kind: 'purpose', id: `p${index}`, label: `Purpose ${index}`,
    parents: index ? [`p${index - 1}`] : [], sources: [extraSource],
  }));
  assert.equal(parse(reduceClosure(doc(rows))).length, count + 1);
});

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-closure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const run = args => spawnSync(process.execPath, [path.join(root, 'reduce.mjs'), ...args], { encoding: 'utf8', timeout: 30_000 });
const inputs = [path.join(root, 'fixtures/purpose.jsonl'), path.join(root, 'fixtures/current.jsonl')];

test('real CLI writes reproducible bytes and receipts tied to the actual input/output files', t => {
  const directory = temporary(t), out = path.join(directory, 'output', 'atlas.reduced.jsonl');
  for (let index = 0; index < 2; index += 1) {
    const execution = run([`--out=${out}`, ...inputs]);
    assert.equal(execution.status, 0, execution.stderr);
    const receipt = JSON.parse(execution.stdout), bytes = fs.readFileSync(out);
    assert.equal(bytes.toString(), reduceClosure(purpose, current));
    assert.equal(receipt.schema, 'atlas.purpose-closure-build/1');
    assert.equal(receipt.authority, false); assert.equal(receipt.status, 'PASS');
    assert.equal(receipt.output.sha256, sha(bytes)); assert.equal(receipt.output.bytes, bytes.length);
    assert.deepEqual(receipt.inputs.map(input => input.sha256), [sha(purpose), sha(current)]);
  }
});

test('real CLI: invalid input preserves prior output and leaves no success receipt or temp file', t => {
  const directory = temporary(t), out = path.join(directory, 'atlas.reduced.jsonl'), bad = path.join(directory, 'bad.jsonl');
  fs.writeFileSync(out, 'previous accepted projection'); fs.writeFileSync(bad, '{');
  const execution = run([`--out=${out}`, ...inputs, bad]);
  assert.equal(execution.status, 1); assert.equal(execution.stdout, '');
  assert.match(execution.stderr, /invalid JSON/u);
  assert.equal(fs.readFileSync(out, 'utf8'), 'previous accepted projection');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['atlas.reduced.jsonl', 'bad.jsonl']);
});

test('real CLI rejects invalid UTF-8 and incomplete filesystem inputs before writing', t => {
  const directory = temporary(t), out = path.join(directory, 'out.jsonl'), bad = path.join(directory, 'bad.jsonl');
  fs.writeFileSync(bad, Buffer.from([0xff, 0xfe]));
  assert.equal(run([`--out=${out}`, ...inputs, bad]).status, 1);
  assert.equal(run([`--out=${out}`, ...inputs, path.join(directory, 'missing')]).status, 1);
  assert.equal(fs.existsSync(out), false);
});

test('real CLI does not overwrite its inputs or follow an output symlink', t => {
  const directory = temporary(t), original = path.join(directory, 'purpose.jsonl');
  fs.writeFileSync(original, purpose);
  assert.equal(run([`--out=${original}`, original, inputs[1]]).status, 1);
  const link = path.join(directory, 'link.jsonl'); fs.symlinkSync(original, link);
  assert.equal(run([`--out=${link}`, ...inputs]).status, 1);
  assert.equal(fs.readFileSync(original, 'utf8'), purpose);
});

test('real CLI rejects missing output, empty input list and unknown options', () => {
  assert.equal(run(inputs).status, 1);
  assert.equal(run(['--out=x']).status, 1);
  assert.equal(run(['--out=x', '--unknown', ...inputs]).status, 1);
});


test('fixture provenance matches the exact synthetic pre-join projection payload', () => {
  for (const input of [purpose, current]) {
    const rows = parse(input).slice(1);
    const payload = rows.map(({ sources, ...value }) => value);
    assert.ok(rows.every(row => row.sources[0].sourceDigest === sha(JSON.stringify(payload))));
  }
});

test('several highest purposes and a shared ideal are preserved without choosing one winner', () => {
  const rows = inputRows();
  rows.push({ ...extraPurpose, parents: [] });
  find(rows, 'ideal.extraction').purposes.push(extraPurpose.id);
  const reduced = parse(reduceClosure(doc(rows))).slice(1);
  assert.deepEqual(new Set(pathsToPurpose(reduced, 'current.before').map(trail => trail.at(-1))), new Set(['purpose.company', extraPurpose.id]));
});

// R #6023468958: both relations must be added AFTER a successful publication.
function lateUpstream() {
  const initial = reduceClosure(purpose, current);
  const parent = { ...extraPurpose, parents: [] };
  const child = { ...find(inputRows(), 'purpose.company'), parents: [parent.id], sources: [extraSource] };
  return { initial, later: doc([parent, child]), parent, child };
}

function lateContinuation() {
  const laterIds = new Set(['current.after', 'gap.source', 'fill.source']);
  const before = inputRows().filter(row => !laterIds.has(row.id));
  find(before, 'residual.source').next = [];
  const initial = reduceClosure(doc(before));
  const additions = inputRows().filter(row => laterIds.has(row.id)).map(row => ({ ...row, sources: [extraSource] }));
  const residual = { ...find(before, 'residual.source'), next: ['gap.source'], sources: [extraSource] };
  return { initial, later: doc([...additions, residual]), residual };
}

test('late upstream: add parent to the SAME purpose id after prior successful reduce', () => {
  const { initial, later, parent } = lateUpstream();
  assert.deepEqual(find(parse(initial).slice(1), 'purpose.company').parents, []);
  const output = reduceClosure(initial, later), nodes = parse(output).slice(1);
  assert.deepEqual(find(nodes, 'purpose.company').parents, [parent.id]);
  assert.equal(nodes.filter(node => node.id === 'purpose.company').length, 1);
  assert.ok(nodes.every(node => pathsToPurpose(nodes, node.id).every(trail => trail.at(-1) === parent.id)));
  assert.equal(reduceClosure(later, initial), output);
  assert.equal(reduceClosure(output, initial, later), output);
});

test('late continuation: assign SAME residual next after publishing an unassigned residual', () => {
  const { initial, later } = lateContinuation();
  const before = parse(initial).slice(1);
  assert.deepEqual(find(before, 'residual.source').next, []);
  assert.equal(find(before, 'gap.source'), undefined);
  const output = reduceClosure(initial, later), nodes = parse(output).slice(1);
  assert.deepEqual(find(nodes, 'residual.source').next, ['gap.source']);
  assert.equal(nodes.filter(node => node.id === 'residual.source').length, 1);
  assert.equal(find(nodes, 'receipt.partial').status, 'reduced');
  assert.ok(pathsToPurpose(nodes, 'gap.source').every(trail => trail.at(-1) === 'purpose.company'));
  assert.equal(reduceClosure(later, initial), output);
  assert.equal(reduceClosure(output, initial, later), output);
});

test('late links: disjoint ancestry and continuation fragments union without replacing existing links', () => {
  const initial = reduceClosure(purpose, current), originals = parse(initial).slice(1);
  const parent = { ...extraPurpose, parents: [] };
  const child = { ...find(originals, 'purpose.reuse'), parents: [parent.id], sources: [extraSource] };
  const residual = { ...find(originals, 'residual.source'), next: ['current.after'], sources: [extraSource] };
  const later = doc([parent, child, residual]);
  const output = reduceClosure(initial, later), nodes = parse(output).slice(1);
  assert.deepEqual(find(nodes, child.id).parents, ['purpose.company', 'purpose.upstream']);
  assert.deepEqual(find(nodes, residual.id).next, ['current.after', 'gap.source']);
  assert.equal(nodes.length, originals.length + 1);
  for (const original of originals) {
    const actual = find(nodes, original.id);
    for (const [key, value] of Object.entries(original)) {
      if (key !== 'sources' && !(original.kind === 'purpose' && key === 'parents') && !(original.kind === 'residual' && key === 'next')) {
        assert.deepEqual(actual[key], value, `${original.id}.${key}`);
      }
    }
  }
  for (const id of [child.id, residual.id]) {
    assert.deepEqual(new Set(find(nodes, id).sources.map(source => source.sourceRef)),
      new Set([...find(originals, id).sources.map(source => source.sourceRef), extraSource.sourceRef]));
  }
  assert.equal(reduceClosure(output, initial), output); // A stale subset is not deletion.
  assert.equal(reduceClosure(later, initial), output);
});

test('late links: all permutations and valid staged joins produce identical bytes', () => {
  const { initial, later: continuation } = lateContinuation();
  const { later: ancestry } = lateUpstream();
  const docs = [initial, ancestry, continuation], before = [...docs];
  const expected = reduceClosure(...docs);
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.equal(reduceClosure(docs[a], docs[b], docs[c]), expected);
  }
  assert.equal(reduceClosure(reduceClosure(initial, ancestry), continuation), expected);
  assert.equal(reduceClosure(ancestry, reduceClosure(continuation, initial)), expected);
  assert.equal(reduceClosure(reduceClosure(initial, ancestry), reduceClosure(initial, continuation)), expected);
  assert.equal(reduceClosure(expected, ...docs), expected);
  assert.equal(reduceClosure(expected), expected);
  assert.deepEqual(docs, before);
});

test('late links: two individually valid ancestry branches cannot hide a cycle at join', () => {
  const p = { ...extraPurpose, id: 'p', parents: [] }, u = { ...p, id: 'u' };
  const initial = reduceClosure(doc([p, u]));
  const left = reduceClosure(initial, doc([{ ...p, parents: ['u'] }]));
  const right = reduceClosure(initial, doc([{ ...u, parents: ['p'] }]));
  for (const pair of [[left, right], [right, left]]) {
    assert.throws(() => reduceClosure(...pair), /purpose hierarchy: cycle/u);
  }
});

test('late links: two individually valid continuation branches cannot hide a causal cycle at join', () => {
  const rows = inputRows();
  find(rows, 'residual.source').next = [];
  rows.push({ ...find(rows, 'receipt.partial'), id: 'receipt.source', fill: 'fill.source' });
  rows.push({ ...find(rows, 'residual.source'), id: 'residual.second', receipt: 'receipt.source', next: [] });
  const initial = reduceClosure(doc(rows));
  const left = reduceClosure(initial, doc([{ ...find(rows, 'residual.source'), next: ['gap.source'] }]));
  const right = reduceClosure(initial, doc([{ ...find(rows, 'residual.second'), next: ['gap.extraction'] }]));
  assert.throws(() => reduceClosure(left, right), /closure flow: cycle/u);
  assert.throws(() => reduceClosure(right, left), /closure flow: cycle/u);
});

for (const [name, change] of [
  ['purpose label', rows => { rows[0].label += ' changed'; }],
  ['residual label', rows => { find(rows, 'residual.source').label += ' changed'; }],
  ['current value', rows => { find(rows, 'current.before').value += ' changed'; }],
  ['ideal value', rows => { find(rows, 'ideal.source').value += ' changed'; }],
  ['ideal purposes', rows => { find(rows, 'ideal.source').purposes.push('purpose.company'); }],
  ['gap current', rows => { find(rows, 'gap.extraction').current = 'current.after'; }],
  ['gap ideal', rows => { find(rows, 'gap.extraction').ideal = 'ideal.source'; }],
  ['gap delta', rows => { find(rows, 'gap.extraction').delta += ' changed'; }],
  ['gap owner', rows => { find(rows, 'gap.extraction').owner += ' changed'; }],
  ['gap proof', rows => { find(rows, 'gap.extraction').proof += ' changed'; }],
  ['fill gaps', rows => { find(rows, 'fill.extraction').gaps.push('gap.source'); }],
  ['fill scope', rows => { find(rows, 'fill.extraction').scope.push('new obligation'); }],
  ['receipt fill', rows => { find(rows, 'receipt.partial').fill = 'fill.source'; }],
  ['receipt status', rows => { find(rows, 'receipt.partial').status = 'failed'; }],
  ['receipt evidence', rows => { find(rows, 'receipt.partial').evidence.push('fixture:additional-proof'); }],
  ['residual receipt', rows => { find(rows, 'residual.source').receipt = 'receipt.other'; }],
  ['node kind', rows => { rows[0] = { ...find(rows, 'residual.source'), id: rows[0].id }; }],
]) {
  test(`late links: still reject same-ID ${name} mutation in either input order`, () => {
    const initial = reduceClosure(purpose, current), later = changed(change);
    assert.throws(() => reduceClosure(initial, later), /conflicting record/u);
    assert.throws(() => reduceClosure(later, initial), /conflicting record/u);
  });
}

for (const [name, setup, change, expected] of [
  ['missing upstream', lateUpstream, rows => { rows.pop(); }, /missing\/wrong-kind/u],
  ['wrong-kind upstream', lateUpstream, rows => { rows[0].parents = ['ideal.source']; }, /missing\/wrong-kind/u],
  ['ancestry cycle', lateUpstream, rows => { rows[0].parents = ['purpose.reuse']; }, /purpose hierarchy: cycle/u],
  ['duplicate parent', lateUpstream, rows => { rows[0].parents.push(rows[0].parents[0]); }, /duplicate item/u],
  ['missing next', lateContinuation, rows => { rows[0].next = ['absent']; }, /missing\/wrong-kind/u],
  ['wrong-kind next', lateContinuation, rows => { rows[0].next = ['purpose.company']; }, /missing\/wrong-kind/u],
  ['causal cycle', lateContinuation, rows => { rows[0].next = ['gap.extraction']; }, /closure flow: cycle/u],
  ['duplicate next', lateContinuation, rows => { rows[0].next.push(rows[0].next[0]); }, /duplicate item/u],
]) {
  test(`late links: reject ${name} even after a valid reduced snapshot`, () => {
    const { initial, later } = setup();
    // Put the repeated node first; errors must not disappear through union.
    const rows = parse(later).slice(1).sort((a, b) => Number(b.kind === 'residual' || b.id === 'purpose.company') - Number(a.kind === 'residual' || a.id === 'purpose.company'));
    change(rows);
    for (const pair of [[initial, doc(rows)], [doc(rows), initial]]) {
      assert.throws(() => reduceClosure(...pair), expected);
    }
  });
}

test('late links: conflicting source revisions cannot be hidden by relation/provenance union', () => {
  const { initial, later } = lateUpstream();
  const rows = parse(later).slice(1);
  const declared = find(parse(initial).slice(1), 'purpose.company').sources[0];
  find(rows, 'purpose.company').sources = [{ ...declared, sourceDigest: sha('conflicting revision') }];
  assert.throws(() => reduceClosure(initial, doc(rows)), /conflicting source revision/u);
  assert.throws(() => reduceClosure(doc(rows), initial), /conflicting source revision/u);
});

test('real CLI: published reduced file accepts later links and rejects a late cycle without replacing output', t => {
  const directory = temporary(t), first = path.join(directory, 'first.jsonl'), later = path.join(directory, 'later.jsonl');
  const output = path.join(directory, 'second.jsonl');
  const initialRun = run([`--out=${first}`, ...inputs]);
  assert.equal(initialRun.status, 0, initialRun.stderr);
  const original = fs.readFileSync(first), { later: addition } = lateUpstream();
  fs.writeFileSync(later, addition);
  const joined = run([`--out=${output}`, first, later]);
  assert.equal(joined.status, 0, joined.stderr);
  const bytes = fs.readFileSync(output), receipt = JSON.parse(joined.stdout);
  assert.deepEqual(find(parse(bytes.toString()).slice(1), 'purpose.company').parents, ['purpose.upstream']);
  assert.deepEqual(receipt.inputs.map(input => input.sha256), [sha(original), sha(addition)]);
  assert.equal(receipt.output.sha256, sha(bytes));
  assert.equal(receipt.output.bytes, bytes.length);
  const rows = parse(addition).slice(1);
  find(rows, 'purpose.company').parents = ['purpose.reuse'];
  fs.writeFileSync(later, doc(rows));
  const rejected = run([`--out=${output}`, first, later]);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /purpose hierarchy: cycle/u);
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.deepEqual(fs.readFileSync(first), original);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['first.jsonl', 'later.jsonl', 'second.jsonl']);
});

test('late link support does not change the original fixture projection bytes', () => {
  const bytes = Buffer.from(reduceClosure(purpose, current));
  assert.equal(bytes.length, 4019);
  assert.equal(sha(bytes), 'sha256:c4ecedcf30a17f7c3102506f8310c2b7e2e676621ec2792a101378fe347de482');
});
