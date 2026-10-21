import assert from 'node:assert/strict';
import test from 'node:test';
import { drawGraph } from '../src/render.mjs';
import { gradeGraph } from './semantic-score.mjs';

// The original drawing boundary can carry a log without a records cache.
// Plain closures model only replacement and failure cleanup, not browser paint.
const element = () => {
  const node = { style: {}, children: [] };
  node.append = child => { child.parent = node; node.children.push(child); };
  node.remove = () => { node.parent.children = node.parent.children.filter(child => child !== node); };
  node.replaceChildren = (...children) => { node.children = []; children.forEach(node.append); };
  return node;
};
const documentPort = { createElement: element, defaultView: { getComputedStyle: () => ({ position: 'relative' }) } };
const protocolPort = { GRAPH_PATTERN: 'graph/1', createEnvelope: async (log, patch, view) => ({ log, patch, view }) };
for (const fails of [false, true]) test(`log-only drawing preserves the existing replacement/error contract: failure=${fails}`, async () => {
  const mount = element(), previous = element(); mount.append(previous);
  const error = new Error('original renderer failure');
  const run = () => drawGraph({ graph: { log: 'unchanged-log' }, frame: null, mount, document: documentPort, protocol: protocolPort,
    renderProjection: async ({ input }) => {
      assert.deepEqual(input.envelope, { log: 'unchanged-log', patch: null, view: { pattern: 'graph/1' } });
      if (fails) throw error;
    } });
  if (fails) {
    await assert.rejects(run, caught => caught === error);
    assert.deepEqual(mount.children, [previous]);
  } else { await run(); assert.equal(mount.children.length, 1); assert.notEqual(mount.children[0], previous); }
});

// Expected descriptions are declared here, never read from product output or
// manufactured by the product encoder. This is a fixed mechanics oracle.
const symbol = { href: '/assets/symbol-fixture.svg', alt: 'Synthetic SQL fixture', provenanceRef: 'fixture:sql-symbol/1' };
const descriptions = ['sql-primary', 'goal-extra-1', 'goal-extra-2'].map(key =>
  ({ schema: 'voice-ui.part-description/1', key, purpose: 'one SQL fixture', symbol }));
const initial = [{ type: 'meta', schema: 'semantic-map-state/1', root: 'root', title: 'fixed oracle' },
  { type: 'region', id: 'root', label: 'World', kind: 'boundary', parent: null, summary: '', bounds: [0, 0, 1000, 700] },
  { type: 'region', id: 'container', label: 'OCI', kind: 'group', parent: 'root', summary: '', bounds: [0, 0, 900, 600] }];
const additions = descriptions.map((description, i) => ({ type: 'region', id: 'sql-' + i, parent: 'container', label: 'SQL',
  kind: 'data', summary: JSON.stringify(description), bounds: [i * 200, 70, 180, 92] }));
const expected = { expected_added_regions: descriptions.map(description =>
  ({ label: 'SQL', kind: 'data', parent: 'fixture:container', summary: JSON.stringify(description) })), expected_added_edges: [] };

test('explicit expected summaries accept only the declared complete symbol multiset', () => {
  assert.equal(gradeGraph(initial, [...initial, ...additions], expected).graph_exact, true);
  assert.equal(gradeGraph(initial, [...initial, ...additions.slice().reverse()], expected).graph_exact, true);
});
for (const field of ['key', 'purpose', 'href', 'alt', 'provenanceRef']) test(`a wrong stored ${field} cannot become a correct graph`, () => {
  const altered = structuredClone(additions), description = JSON.parse(altered[0].summary);
  if (['key', 'purpose'].includes(field)) description[field] = 'wrong'; else description.symbol[field] = 'wrong';
  altered[0].summary = JSON.stringify(description);
  assert.equal(gradeGraph(initial, [...initial, ...altered], expected).graph_exact, false);
});
for (const mutation of ['missing-description', 'duplicate-identity', 'missing-region', 'extra-region', 'wrong-kind', 'wrong-parent', 'changed-existing', 'unexpected-field'])
  test(`symbol graph oracle refuses ${mutation}`, () => {
    const before = structuredClone(initial), rows = structuredClone(additions);
    if (mutation === 'missing-description') rows[0].summary = '';
    if (mutation === 'duplicate-identity') rows[1].summary = rows[0].summary;
    if (mutation === 'missing-region') rows.pop();
    if (mutation === 'extra-region') rows.push({ ...rows[0], id: 'extra' });
    if (mutation === 'wrong-kind') rows[0].kind = 'step';
    if (mutation === 'wrong-parent') rows[0].parent = 'root';
    if (mutation === 'changed-existing') before[1].summary = 'changed';
    if (mutation === 'unexpected-field') rows[0].extra = 'ignored?';
    assert.equal(gradeGraph(initial, [...before, ...rows], expected).graph_exact, false);
  });
test('legacy oracle still refuses all unrequested descriptions and keeps its output shape', () => {
  const legacy = { expected_added_regions: expected.expected_added_regions.map(({ summary, ...row }) => row), expected_added_edges: [] };
  const plain = additions.map(row => ({ ...row, summary: '' }));
  const score = gradeGraph(initial, [...initial, ...plain], legacy);
  assert.equal(score.graph_exact, true);
  assert.deepEqual(score.actual_added_regions, legacy.expected_added_regions);
  assert.equal(gradeGraph(initial, [...initial, ...additions], legacy).graph_exact, false);
});
test('mixed oracle defaults only undeclared summaries to empty, never to a wildcard', () => {
  const mixed = structuredClone(expected); delete mixed.expected_added_regions[2].summary;
  const rows = structuredClone(additions); rows[2].summary = '';
  assert.equal(gradeGraph(initial, [...initial, ...rows], mixed).graph_exact, true);
  rows[2].summary = 'unrequested';
  assert.equal(gradeGraph(initial, [...initial, ...rows], mixed).graph_exact, false);
});
