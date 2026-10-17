import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { UNKNOWN, parseFlowchart, parseExitTable, planEvents, markerSections, sha256 } from '../plan.mjs';
import { SESSION, sessionState, sessionObservations, portObservations } from '../observe.mjs';
import { normalize } from '../adapter.mjs';
import { collect, readRecords } from '../collect.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const snapshotDir = path.join(root, 'fixtures/snapshots');
const RECORDED = '2026-10-16T20:40:00Z'; // after the real fetch (fetchedAt 2026-10-16T20:33:31Z)
const snapshot = name => JSON.parse(fs.readFileSync(path.join(snapshotDir, name), 'utf8'));
const records = name => normalize(snapshot(name));
const R25 = 'issue-roccho-dev-resources-25.json', ADRS = 'pr-roccho-dev-adrs-628.json', APPS = 'pr-roccho-dev-apps-92.json';
const PLAN = 'roccho-dev/resources#25:windows-retirement-migration-20261016';
// One normalized document of roccho-dev/resources#25 (body = null), with its thread coordinates.
const doc = commentId => {
  const [thread] = records(R25);
  return { repo: thread.repo, number: thread.number, ...thread.documents.find(d => d.commentId === commentId) };
};
const V1 = null, V2 = 6206892120, V3 = 6208252115;
const id = (event, value) => event.nodes.find(n => n.id === `roccho-dev/resources#25:${value}`);
const edge = (event, from, to) => event.edges.filter(e => e.from === `roccho-dev/resources#25:${from}` && e.to === `roccho-dev/resources#25:${to}`);
const fields = ['exit', 'predicate', 'owner', 'requires'];

// UNKNOWN is a literal value: no field is empty, null or undefined anywhere in the output.
function noEmpty(value, at = '$') {
  assert.ok(value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0 && !/\.(groups|unknown)$/u.test(at)), at);
  if (value === null) { assert.match(at, /\.commentId$/u, `${at} is null`); return; }
  if (Array.isArray(value)) value.forEach((item, i) => noEmpty(item, `${at}[${i}]`));
  else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) noEmpty(item, `${at}.${key}`);
}

// ---- real data: roccho-dev/resources#25 -----------------------------------------------------------

test('roccho-dev/resources#25 (real): current is v3, which has no flowchart and no exit table → all UNKNOWN', () => {
  const events = collect(records(R25), RECORDED);
  assert.deepEqual(events.map(e => [e.plan, e.version]),
    [['roccho-dev/resources#25:windows-migration-preparation-scope-20261017', 1], [PLAN, 3]]);
  const current = events.find(e => e.plan === PLAN);
  assert.equal(current.source.commentId, V3);
  assert.equal(current.nodes, UNKNOWN);
  assert.equal(current.edges, UNKNOWN);
  assert.equal(current.exits, UNKNOWN);
  assert.deepEqual(current.unknown, ['flowchart-absent', 'exit-table-absent']);
  // Unmarked / non-version markers (p-rebuttal-1, execution-*) never become plans; v1/v2 are not merged into v3.
  for (const e of events) noEmpty(e);
});

test('roccho-dev/resources#25 v1 (real): flowchart parsed; the 2-column exit table does not match → exits UNKNOWN', () => {
  const [event, ...rest] = planEvents([doc(V1)], RECORDED);
  assert.equal(rest.length, 0);
  assert.equal(event.plan, PLAN);
  assert.equal(event.version, 1);
  assert.deepEqual(event.unknown, ['exit-table-absent']);
  assert.equal(event.exits, UNKNOWN);
  assert.equal(parseExitTable(doc(V1).text), null, 'v1 has only | ノード | 出口条件 |');
  assert.deepEqual(event.source, { repo: 'roccho-dev/resources#25', commentId: null, updatedAt: '2026-10-16T20:02:16Z',
    sha256: sha256(markerSections(doc(V1).text)[0].text) });
  assert.deepEqual(event.nodes.map(n => n.id.split(':')[1]), ['L', 'E', 'M', 'C', 'G', 'A']);
  for (const n of event.nodes) for (const field of fields) assert.equal(n[field], UNKNOWN, `${n.id}.${field}`);
  noEmpty(event);
});

test('roccho-dev/resources#25 v1/v2 (real): 6 nodes, 7 edges, back edges and decision nodes', () => {
  for (const [commentId, selfLoop] of [[V1, 'no：windows で継続'], [V2, 'no：windows で継続（E待ちに系列・最終作用を記録）']]) {
    const [event] = planEvents([doc(commentId)], RECORDED);
    assert.equal(event.nodes.length, 6);
    assert.equal(event.edges.length, 7);
    assert.deepEqual(event.nodes.filter(n => n.shape === 'decision').map(n => n.id), ['roccho-dev/resources#25:E', 'roccho-dev/resources#25:G']);
    assert.match(id(event, 'L').label, /^L 台帳<br\/>/u);
    assert.deepEqual(edge(event, 'E', 'E'), [{ from: 'roccho-dev/resources#25:E', to: 'roccho-dev/resources#25:E', kind: UNKNOWN, condition: selfLoop, style: 'solid' }]);
    assert.deepEqual(edge(event, 'G', 'L'), [{ from: 'roccho-dev/resources#25:G', to: 'roccho-dev/resources#25:L', kind: UNKNOWN, condition: 'no / UNKNOWN', style: 'solid' }]);
    // `E -->|yes| M --> C --> G` chain on one line.
    assert.deepEqual(['M', 'C', 'G'].map((to, i) => edge(event, ['E', 'M', 'C'][i], to).length), [1, 1, 1]);
    assert.deepEqual(event.unparsed, undefined);
  }
  assert.equal(doc(V2).text.includes('\r\n'), true, 'v2 is CRLF');
});

// ---- synthetic minimal inputs: rules the real data does not exercise ---------------------

test('synthetic minimal input: 5-column exit table fills exit / predicate / owner / requires per node', () => {
  const text = [
    '<!-- synthetic-plan-v1 -->',
    '```mermaid', 'flowchart TD', '  A[a] -->|dep| B{b?}', '  B -->|loop: no| B', '  B -.->|yes| C', '```',
    '| ノード | 出口条件 | 観測述語 | 担当根拠 | 寄与 requires |', '|---|---|---|---|---|',
    '| A | a done | pr.merged = true | atlas.W | |', '| `B` | b ok | ci.rollup = SUCCESS | atlas.R | A |', '| Z | z | z | z | z |',
  ].join('\n');
  const [event] = planEvents([{ repo: 'synthetic', number: 1, commentId: null, updatedAt: '2026-10-16T00:00:00Z', text }], RECORDED);
  const at = name => event.nodes.find(n => n.id === `synthetic#1:${name}`);
  assert.deepEqual(event.unknown, []);
  assert.deepEqual(fields.map(f => at('B')[f]), ['b ok', 'ci.rollup = SUCCESS', 'atlas.R', 'A']);
  assert.equal(at('A').requires, UNKNOWN, 'empty cell is UNKNOWN, not ""');
  assert.deepEqual(fields.map(f => at('C')[f]), [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN], 'node without a row');
  assert.deepEqual(event.exits.map(x => x.node), ['synthetic#1:A', 'synthetic#1:B', 'synthetic#1:C', 'synthetic#1:Z']);
  assert.deepEqual(event.edges.map(e => [e.kind, e.condition, e.style]),
    [['dep', UNKNOWN, 'solid'], ['loop', 'no', 'solid'], [UNKNOWN, 'yes', 'dotted']], 'only label prefixes declare kind');
  noEmpty(event);
});

test('synthetic minimal input: flowchart syntax (& / subgraph expansion, text links, chains, unparsed)', () => {
  const chart = parseFlowchart([
    'graph LR',
    '  A & B --> C & D',
    '  subgraph G1 ["group one"]',
    '    subgraph G2',
    '      X[x]',
    '    end',
    '    Y[y]',
    '  end',
    '  P -- branch: ok --> G1',
    '  Q -.-> R ==> S; T --- U',
    '  V -->|"loop"| V',
    '  ??? nonsense',
  ].join('\n'));
  const pairs = chart.edges.map(e => `${e.from}>${e.to}:${e.kind}:${e.condition}:${e.style}`);
  assert.deepEqual(pairs, [
    'A>C:UNKNOWN:null:solid', 'A>D:UNKNOWN:null:solid', 'B>C:UNKNOWN:null:solid', 'B>D:UNKNOWN:null:solid',
    'P>X:branch:ok:solid', 'P>Y:branch:ok:solid',
    'Q>R:UNKNOWN:null:dotted', 'R>S:UNKNOWN:null:thick', 'T>U:UNKNOWN:null:solid',
    'V>V:loop:null:solid',
  ]);
  assert.deepEqual(chart.nodes.find(n => n.id === 'X').groups, ['G1', 'G2']);
  assert.ok(!chart.nodes.some(n => n.id === 'G1'), 'subgraph id is expanded, not a node');
  assert.deepEqual(chart.unparsed, ['??? nonsense']);
  assert.equal(parseFlowchart('sequenceDiagram\n A->>B: x'), null);
});

test('synthetic minimal input: exit table header must match exactly', () => {
  assert.equal(parseExitTable('| ノード | 出口条件 | 観測述語 | 担当根拠 |\n|---|---|---|---|\n| A | x | y | z |'), null);
  assert.equal(parseExitTable('| ノード | 出口 | 観測述語 | 担当根拠 | 寄与 requires |\n|---|---|---|---|---|\n| A | x | y | z | w |'), null);
  assert.deepEqual(parseExitTable('|ノード|出口条件|観測述語|担当根拠|寄与 requires|\n|:--|---|---|---|---|\n|`A`|x| |z|w|'),
    [{ node: 'A', exit: 'x', predicate: UNKNOWN, owner: 'z', requires: 'w' }]);
});

test('synthetic minimal input: same version declared twice with different text → no winner, plan UNKNOWN', () => {
  const v1 = doc(V1), twin = { ...v1, commentId: 9, text: `${v1.text}\n別文\n` };
  const [event] = planEvents([v1, twin], RECORDED);
  assert.equal(event.nodes, UNKNOWN);
  assert.deepEqual(event.unknown, ['conflicting-version']);
  assert.equal(event.source.length, 2);
});

// ---- real data: PRs ----------------------------------------------------------------------

test('PR observations (real): adrs#628 and apps#92 are MERGED, no plan; null rollup is UNKNOWN', () => {
  const values = name => {
    const events = collect(records(name), RECORDED);
    assert.ok(events.every(e => e.kind === 'observation'), `${name}: no plan.set`);
    return Object.fromEntries(events.map(e => [e.target.split(':')[1], e.value]));
  };
  assert.deepEqual(values(ADRS), { 'pr.state': 'MERGED', 'pr.merged': 'true', 'pr.head': '36e182bba7d504caa37eb59248a4e4268063fce0', 'ci.rollup': UNKNOWN });
  assert.deepEqual(values(APPS), { 'pr.state': 'MERGED', 'pr.merged': 'true', 'pr.head': 'b1fec7a61a0f7728f6262c70afc591f5661f8dd3', 'ci.rollup': 'SUCCESS' });
});

test('adapter: rollup of a non-head commit is not the PR rollup; unreadable responses are null → UNKNOWN', () => {
  const s = snapshot(APPS);
  s.responses.pr.data.data.repository.pullRequest.commits.nodes[0].commit.oid = 'f'.repeat(40);
  assert.equal(normalize(s)[0].pr.rollup, null);
  const failed = { ...s, responses: { issue: { data: null }, comments: { data: null }, pr: { data: null } } };
  const [pr, thread] = normalize(failed);
  assert.deepEqual([pr.pr, thread.documents], [null, null]);
  const events = collect([pr, thread], RECORDED);
  assert.ok(events.every(e => e.kind === 'observation' && e.value === UNKNOWN));
  assert.ok(events.some(e => e.target === 'roccho-dev/apps#92:plan.source'), 'unreadable thread is UNKNOWN, not "no plan"');
  for (const e of events) noEmpty(e);
});

test('time order: observedAt / updated_at after recordedAt is rejected', () => {
  assert.throws(() => collect(records(APPS), '2026-10-16T20:33:30Z'), /observedAt .* is after recordedAt/u);
  assert.throws(() => collect(records(R25), '2026-10-16T20:02:15Z'), /updated_at .* is after recordedAt/u);
  const probe = { target: 't', observedAt: '2026-10-17T00:00:00Z', responded: true, source: { ref: 'tcp h:1', sha256: 'x' } };
  assert.throws(() => portObservations({ probes: [probe] }, RECORDED), /after recordedAt/u);
  assert.throws(() => collect(records(R25), 'yesterday'), /ISO-8601/u);
  assert.doesNotThrow(() => collect(records(APPS), '2026-10-16T20:33:31Z'), 'equality is allowed');
});

// ---- sessions ----------------------------------------------------------------------------

test('session rule: declared session id in command lines / session files only', () => {
  const sid = 'aaaaaaaa-0000-4000-8000-000000000009';
  const commands = [`claude --resume ${sid}`], files = [`/p/${sid}.jsonl`];
  assert.equal(sessionState(sid, commands, []), SESSION.RUNNING);
  assert.equal(sessionState(sid, commands, null), SESSION.RUNNING);
  assert.equal(sessionState(sid, [], files), SESSION.TRANSCRIPT_ONLY);
  assert.equal(sessionState(sid, [], []), SESSION.NOT_FOUND);
  assert.equal(sessionState(sid, null, files), UNKNOWN, 'process list not captured');
  assert.equal(sessionState(sid, [], null), UNKNOWN, 'session files not captured');
  assert.equal(sessionState('', commands, files), UNKNOWN, 'no declared id');
  assert.deepEqual(collect(records('sessions.json'), RECORDED).map(e => [e.target, e.value]), [
    ['atlas.R:session', 'running'], ['atlas.W:session', 'transcript-only'],
    ['atlas.W2:session', 'not-found'], // a process named "atlas.W2-…" is not evidence
  ]);
});

test('session rule on a /proc listing (host without ps): real cmdline row is running', () => {
  // Raw stdout of the README /proc processCommand ("<pid> <cmdline, NUL→space>"), read by the adapter.
  // Real row from this host for atlas.W3; the long --allowedTools list is elided (no secrets in it).
  const processes = [
    '1 /init',
    '105923 /nix/store/ias8xacs1h3jy7xgwi2awvim61k2ji6c-glibc-2.42-67/lib/ld-linux-x86-64.so.2 --library-path /nix/store/ias8xacs1h3jy7xgwi2awvim61k2ji6c-glibc-2.42-67/lib /nix/store/hbdx45v14b8p05cwvpwljp8wqq6rk4hz-claude -p --resume 2732b627-eeec-42ab-b12e-9969389dbdc7 -n atlas.W3 --model claude-opus-5-5 --output-format text --allowedTools [elided]',
  ].join('\n') + '\n';
  const declared = [
    { target: 'atlas.W3', sessionId: '2732b627-eeec-42ab-b12e-9969389dbdc7' },
    { target: 'atlas.R', sessionId: 'c63c8384-6d0b-42c1-9e27-2a37a26f2334' },
  ];
  const [record] = normalize({ type: 'sessions', host: 'localhost', observedAt: '2026-10-16T20:33:31Z', sha256: 'sha256:proc', declared, processes, sessionFiles: '' });
  assert.deepEqual(sessionObservations(record, RECORDED).map(e => [e.target, e.value]),
    [['atlas.W3:session', 'running'], ['atlas.R:session', 'not-found']]);
  // "-n atlas.W3" in the same row is not what matched: without the id, the name alone is no evidence.
  assert.equal(sessionState('ffffffff-0000-4000-8000-000000000000', record.commands, record.files), SESSION.NOT_FOUND);
});

// ---- whole set ---------------------------------------------------------------------------

test('whole fixture set: only observation / plan.set, no empty values, CLI matches collect()', () => {
  const events = collect(readRecords(snapshotDir), RECORDED);
  assert.equal(events.length, 15);
  assert.ok(events.every(e => e.kind === 'observation' || e.kind === 'plan.set'));
  for (const e of events) {
    noEmpty(e);
    if (e.kind === 'observation') assert.deepEqual(Object.keys(e), ['kind', 'target', 'value', 'source', 'observedAt', 'recordedAt']);
  }
  const cli = spawnSync(process.execPath, [path.join(root, 'collect.mjs'), snapshotDir, '--recorded-at', RECORDED], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(cli.stdout.trim().split('\n').map(line => JSON.parse(line)), events);
});
