import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { UNKNOWN, parseFlowchart, parseExitTable, planEvents, markerSections, sha256 } from '../plan.mjs';
import { SESSION, sessionState, sessionObservations, prObservations, portObservations } from '../observe.mjs';
import { collect, readSnapshots } from '../collect.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const snapshotDir = path.join(root, 'fixtures/snapshots');
const RECORDED = '2026-10-16T20:40:00Z'; // after the real fetch (fetchedAt 2026-10-16T20:33:31Z)
const snapshots = () => readSnapshots(snapshotDir);
const byName = (repo, number) => snapshots().find(s => s.repo === repo && s.number === number);
const r25 = () => byName('resources', 25);
const body = s => ({ repo: s.repo, number: s.number, commentId: null, updatedAt: s.responses.issue.data.updated_at, text: s.responses.issue.data.body });
const node = (event, id) => event.nodes.find(n => n.id === `resources#25:${id}`);
const edge = (event, from, to) => event.edges.filter(e => e.from === `resources#25:${from}` && e.to === `resources#25:${to}`);
const fields = ['exit', 'predicate', 'owner', 'requires'];

// UNKNOWN is a literal value: no field is empty, null or undefined anywhere in the output.
function noEmpty(value, at = '$') {
  assert.ok(value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0 && !/\.(groups|unknown)$/u.test(at)), at);
  if (value === null) { assert.match(at, /\.commentId$/u, `${at} is null`); return; }
  if (Array.isArray(value)) value.forEach((item, i) => noEmpty(item, `${at}[${i}]`));
  else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) noEmpty(item, `${at}.${key}`);
}

test('resources#25 v1: full flowchart and exit table, ids qualified, provenance carried', () => {
  const [event, ...rest] = planEvents([body(r25())], RECORDED);
  assert.equal(rest.length, 0);
  assert.equal(event.kind, 'plan.set');
  assert.equal(event.plan, 'resources#25:atlas-plan');
  assert.equal(event.version, 1);
  assert.deepEqual(event.unknown, []);
  assert.deepEqual(event.source, { repo: 'resources#25', commentId: null, updatedAt: '2026-10-15T09:00:00Z',
    sha256: sha256(markerSections(r25().responses.issue.data.body)[0].text) });
  assert.deepEqual(event.nodes.map(n => n.id.split(':')[1]), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'L', 'H']);
  assert.ok(event.nodes.every(n => n.id.startsWith('resources#25:')));
  assert.deepEqual(node(event, 'E'), { id: 'resources#25:E', label: '出口を満たす?', shape: 'decision', groups: [],
    exit: 'C と D の出口', predicate: 'ci.rollup = SUCCESS', owner: 'atlas.R', requires: 'C, D' });
  assert.equal(node(event, 'A').requires, UNKNOWN, 'empty table cell is UNKNOWN, not ""');
  assert.equal(node(event, 'F').exit, UNKNOWN, 'node without a row is UNKNOWN');
  assert.deepEqual(node(event, 'C').groups, ['resources#25:S1']);
  assert.equal(event.exits.length, event.nodes.length);
  noEmpty(event);
});

test('resources#25 v2 is current; diff-only version leaves the table, E exit, owners and requires UNKNOWN', () => {
  const events = collect([r25()], RECORDED);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.version, 2);
  assert.equal(event.source.commentId, 3001);
  assert.equal(event.exits, UNKNOWN);
  assert.deepEqual(event.unknown, ['exit-table-absent']);
  assert.equal(node(event, 'E').exit, UNKNOWN);
  for (const n of event.nodes) for (const field of fields) assert.equal(n[field], UNKNOWN, `${n.id}.${field}`);
  // v1's table is not carried into v2, and the unmarked comment's table is ignored.
  assert.ok(!JSON.stringify(event).includes('ignored'));
  assert.ok(!JSON.stringify(event).includes('atlas.R'));
  noEmpty(event);
});

test('back edges and decision nodes: E -->|no| E and G -->|no / UNKNOWN| L', () => {
  const v2 = collect([r25()], RECORDED)[0];
  assert.deepEqual(edge(v2, 'E', 'E'), [{ from: 'resources#25:E', to: 'resources#25:E', kind: UNKNOWN, condition: 'no', style: 'solid' }]);
  assert.deepEqual(edge(v2, 'G', 'L'), [{ from: 'resources#25:G', to: 'resources#25:L', kind: UNKNOWN, condition: 'no / UNKNOWN', style: 'solid' }]);
  assert.equal(node(v2, 'G').shape, 'decision');
  assert.equal(edge(v2, 'L', 'B').length, 1);
  // Declared kinds survive; the same edge without a declaration stays UNKNOWN.
  const v1 = planEvents([body(r25())], RECORDED)[0];
  assert.deepEqual(edge(v1, 'G', 'L').map(e => [e.kind, e.condition]), [['loop', 'no / UNKNOWN']]);
  assert.deepEqual(edge(v1, 'B', 'C').map(e => e.kind), ['dep']);
  assert.equal(edge(v1, 'F', 'G')[0].style, 'dotted');
  assert.equal(edge(v1, 'F', 'G')[0].kind, UNKNOWN, 'dotted arrow is not a kind declaration');
});

test('flowchart syntax: & expansion, subgraph expansion, text links, chains, unparsed lines', () => {
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

test('exit table: only the exact header is read', () => {
  assert.equal(parseExitTable('| ノード | 出口条件 | 観測述語 | 担当根拠 |\n|---|---|---|---|\n| A | x | y | z |'), null);
  assert.equal(parseExitTable('| ノード | 出口 | 観測述語 | 担当根拠 | 寄与 requires |\n|---|---|---|---|---|\n| A | x | y | z | w |'), null);
  assert.deepEqual(parseExitTable('|ノード|出口条件|観測述語|担当根拠|寄与 requires|\n|:--|---|---|---|---|\n|`A`|x| |z|w|'),
    [{ node: 'A', exit: 'x', predicate: UNKNOWN, owner: 'z', requires: 'w' }]);
});

test('plan absent: adrs#628 and apps#92 yield no plan.set', () => {
  for (const [repo, number] of [['adrs', 628], ['apps', 92]]) {
    const events = collect([byName(repo, number)], RECORDED);
    assert.equal(events.filter(e => e.kind === 'plan.set').length, 0, `${repo}#${number}`);
    assert.deepEqual(events.map(e => e.target.split(':')[1]), ['pr.state', 'pr.merged', 'pr.head', 'ci.rollup']);
  }
});

test('PR observations: state, merged, head SHA, GitHub rollup; missing rollup is UNKNOWN', () => {
  const value = (events, field) => events.find(e => e.target.endsWith(`:${field}`)).value;
  const apps = collect([byName('apps', 92)], RECORDED);
  assert.deepEqual(['pr.state', 'pr.merged', 'pr.head', 'ci.rollup'].map(f => value(apps, f)),
    ['MERGED', 'true', 'b1fec7a61a0f7728f6262c70afc591f5661f8dd3', 'SUCCESS']);
  assert.equal(value(collect([byName('adrs', 628)], RECORDED), 'ci.rollup'), UNKNOWN);
  // A rollup for a commit other than the head is not this PR's rollup.
  const s = byName('apps', 92), pr = s.responses.pr.data.data.repository.pullRequest;
  pr.commits.nodes[0].commit.oid = 'f'.repeat(40);
  assert.equal(value(prObservations({ repo: 'apps', number: 92, fetchedAt: s.fetchedAt, sha256: 'x', pr }, RECORDED), 'ci.rollup'), UNKNOWN);
  // Fetch failure: every field UNKNOWN, and plan source UNKNOWN rather than "no plan".
  const failed = { ...s, responses: { issue: { data: null }, comments: { data: null }, pr: { data: null } } };
  const events = collect([failed], RECORDED);
  assert.ok(events.every(e => e.kind === 'observation' && e.value === UNKNOWN));
  assert.ok(events.some(e => e.target === 'apps#92:plan.source'));
  for (const e of events) noEmpty(e);
});

test('time order: observedAt / updated_at after recordedAt is rejected', () => {
  assert.throws(() => collect([byName('apps', 92)], '2026-10-16T20:33:30Z'), /observedAt .* is after recordedAt/u);
  assert.throws(() => collect([r25()], '2026-10-16T20:02:15Z'), /updated_at .* is after recordedAt/u);
  assert.throws(() => portObservations({ sha256: 'x', probes: [{ target: 't', host: 'h', port: 1, observedAt: '2026-10-17T00:00:00Z', responded: true }] }, RECORDED), /after recordedAt/u);
  assert.throws(() => collect([r25()], 'yesterday'), /ISO-8601/u);
  // Equality is allowed.
  assert.doesNotThrow(() => collect([byName('apps', 92)], '2026-10-16T20:33:31Z'));
});

test('session rule: declared session id in process list / session files only', () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000009';
  const proc = [{ pid: 1, command: `claude --resume ${id}` }], file = [`/p/${id}.jsonl`];
  assert.equal(sessionState(id, proc, []), SESSION.RUNNING);
  assert.equal(sessionState(id, proc, null), SESSION.RUNNING);
  assert.equal(sessionState(id, [], file), SESSION.WAITING);
  assert.equal(sessionState(id, [], []), SESSION.NOT_STARTED);
  assert.equal(sessionState(id, null, file), UNKNOWN, 'process list not captured');
  assert.equal(sessionState(id, [], null), UNKNOWN, 'session files not captured');
  assert.equal(sessionState('', proc, file), UNKNOWN, 'no declared id');
  const s = snapshots().find(x => x.type === 'sessions');
  assert.deepEqual(sessionObservations(s, RECORDED).map(e => [e.target, e.value]), [
    ['atlas.R:session', 'running'], ['atlas.W:session', 'waiting'],
    ['atlas.W2:session', 'not-started'], // a process named "atlas.W2-…" is not evidence
  ]);
});

test('session rule on a /proc listing (host without ps): real cmdline row is running', () => {
  // Rows as the README /proc processCommand prints them ("<pid> <cmdline, NUL→space>"), split like fetch.mjs.
  // Real row from this host for atlas.W3; the long --allowedTools list is elided (no secrets in it).
  const listing = [
    '1 /init',
    '105923 /nix/store/ias8xacs1h3jy7xgwi2awvim61k2ji6c-glibc-2.42-67/lib/ld-linux-x86-64.so.2 --library-path /nix/store/ias8xacs1h3jy7xgwi2awvim61k2ji6c-glibc-2.42-67/lib /nix/store/hbdx45v14b8p05cwvpwljp8wqq6rk4hz-claude -p --resume 2732b627-eeec-42ab-b12e-9969389dbdc7 -n atlas.W3 --model claude-opus-5-5 --output-format text --allowedTools [elided]',
  ];
  const processes = listing.map(line => { const [, pid, command] = /^(\d+)\s+(.*)$/u.exec(line); return { pid: Number(pid), command }; });
  const declared = [
    { target: 'atlas.W3', sessionId: '2732b627-eeec-42ab-b12e-9969389dbdc7' },
    { target: 'atlas.R', sessionId: 'c63c8384-6d0b-42c1-9e27-2a37a26f2334' },
  ];
  const snapshot = { host: 'localhost', observedAt: '2026-10-16T20:33:31Z', sha256: 'sha256:proc', declared, processes, sessionFiles: [] };
  assert.deepEqual(sessionObservations(snapshot, RECORDED).map(e => [e.target, e.value]),
    [['atlas.W3:session', 'running'], ['atlas.R:session', 'not-started']]);
  // "-n atlas.W3" in the same row is not what matched: without the id, the name alone is no evidence.
  assert.equal(sessionState('ffffffff-0000-4000-8000-000000000000', processes, []), SESSION.NOT_STARTED);
});

test('same version declared twice with different text: no winner, plan UNKNOWN', () => {
  const s = r25(), v1 = body(s);
  const twin = { ...v1, commentId: 9, text: `${v1.text}\n別文\n` };
  const [event] = planEvents([v1, twin], RECORDED);
  assert.equal(event.nodes, UNKNOWN);
  assert.deepEqual(event.unknown, ['conflicting-version']);
  assert.equal(event.source.length, 2);
});

test('whole fixture set: only observation / plan.set, no empty values, CLI matches collect()', () => {
  const events = collect(snapshots(), RECORDED);
  assert.ok(events.every(e => e.kind === 'observation' || e.kind === 'plan.set'));
  for (const e of events) {
    noEmpty(e);
    if (e.kind === 'observation') assert.deepEqual(Object.keys(e), ['kind', 'target', 'value', 'source', 'observedAt', 'recordedAt']);
  }
  const cli = spawnSync(process.execPath, [path.join(root, 'collect.mjs'), snapshotDir, '--recorded-at', RECORDED], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(cli.stdout.trim().split('\n').map(line => JSON.parse(line)), events);
});
