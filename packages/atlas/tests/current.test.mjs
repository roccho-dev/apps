import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// C2: current = record(agent), end to end: record → reduce → snapshot. The caller passes each current file as
// `collect.mjs --current <author>=<path>` (one or more; the author is required, no default). Lines are
// atlas-worklog-v1 (adrs#654); the author is the argument, the time is when the file was read (pinned by
// --recorded-at), the order is the line position. Authors outside `--worklog-author` are held (fail closed).
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const line = value => JSON.stringify(value) + '\n';
// P's purpose as a declaration snapshot: a World needs one. No condition watches work:* (adrs#654).
const req = { id: 'merged', label: 'PR が入る', predicate: { target: { kind: 'state', id: 'roccho-dev/apps#200:pr.merged' }, op: 'equals', value: 'true' }, maxAge: 'PT72H', norm: 'norm.atlas' };
const declaration = line({ kind: 'purpose.set', recordedAt: '2026-10-19T01:00:00Z', purpose: { id: 'purpose.current', label: 'current を表す' }, rev: 'r1' })
  + line({ kind: 'ideal.set', recordedAt: '2026-10-19T01:00:00Z', purpose_id: 'purpose.current', purpose_rev: 'r1', version: 'v1', requires: [req] });
const SHA = '0123456789abcdef0123456789abcdef01234567';
const T1 = '2026-10-19T02:00:00.000Z', T2 = '2026-10-19T03:00:00.000Z';

const workspace = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-current-'));
  mkdirSync(path.join(dir, 'snap'));
  writeFileSync(path.join(dir, 'snap', 'declaration-0.json'), JSON.stringify({ type: 'declaration', path: 'purpose.jsonl', fetchedAt: '2026-10-19T01:00:00Z',
    sha256: 'sha256:' + createHash('sha256').update(declaration).digest('hex'), text: declaration }));
  return dir;
};
const within = body => { const dir = workspace(); try { return body(dir); } finally { rmSync(dir, { recursive: true }); } };
const collectArgs = (dir, recordedAt, name, current) => [file('../collect/collect.mjs'), path.join(dir, 'snap'),
  ...current.flatMap(pair => ['--current', pair]), '--worklog-author', 'P', '--recorded-at', recordedAt, '--out', path.join(dir, `${name}.g.jsonl`)];
const snapshot = (dir, recordedAt, name, current = [`P=${path.join(dir, 'current.jsonl')}`]) => {
  execFileSync(process.execPath, collectArgs(dir, recordedAt, name, current));
  execFileSync(process.execPath, [file('../live.mjs'), `--out-dir=${path.join(dir, name)}`, path.join(dir, `${name}.g.jsonl`)], { encoding: 'utf8' });
  const held = readFileSync(path.join(dir, name, 'g-journal-held.jsonl'), 'utf8');
  return { world: readFileSync(path.join(dir, name, 'world.json'), 'utf8'), held: held.trim() ? held.trim().split('\n').map(text => JSON.parse(text).journal) : [] };
};
// What the snapshot says about the work: target (work:<id> state, evidence:<id> evidence), value, and the line.
const claims = world => JSON.parse(world).frames.at(-1).journal.filter(entry => entry.kind === 'observation' && /^(work|evidence):/u.test(entry.target.id))
  .map(entry => [entry.target.id, entry.value, entry.source.ref.split(' ')[0], entry.observedAt]);

test('P appends one line: the next snapshot shows it with work_id, state, evidence and its line', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'c2' }) + '\n'
    + line({ kind: 'artifact.observed', work_id: 'c2', evidence: 'roccho-dev/apps#119' }));
  assert.deepEqual(claims(snapshot(dir, T1, 'one').world), [
    ['work:c2', 'created', 'current:P#L1', T1],
    ['work:c2', 'progressed', 'current:P#L3', T1], ['evidence:c2', 'roccho-dev/apps#119', 'current:P#L3', T1]]);
  appendFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.terminal', work_id: 'c2', terminal: 'done' }));
  const two = snapshot(dir, T2, 'two');
  assert.deepEqual(claims(two.world).at(-1), ['work:c2', 'reported-done', 'current:P#L4', T2]);
  // A report is a claim, never an achievement: no condition watches work:*, nothing is satisfied by it.
  const frame = JSON.parse(two.world).frames.at(-1);
  assert.deepEqual([frame.gap.summary.satisfied, JSON.stringify(frame.gap).includes('c2')], [0, false]);
}));

test('the author is required: --current without <author>= is refused; an author outside the list is held', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'c2' }));
  for (const pair of [path.join(dir, 'current.jsonl'), `=${path.join(dir, 'current.jsonl')}`, 'P=']) {
    const run = spawnSync(process.execPath, collectArgs(dir, T1, 'refused', [pair]), { encoding: 'utf8' });
    assert.notEqual(run.status, 0, pair);
    assert.match(run.stderr, /--current <author>=<path>/u);
  }
  writeFileSync(path.join(dir, 'w2.jsonl'), line({ kind: 'work.created', work_id: 'w2' }));
  const { world, held } = snapshot(dir, T1, 'two', [`P=${path.join(dir, 'current.jsonl')}`, `W2=${path.join(dir, 'w2.jsonl')}`]);
  assert.deepEqual(claims(world).map(claim => claim.slice(0, 3)), [['work:c2', 'created', 'current:P#L1']]);
  assert.deepEqual(held.map(value => [value.reason, value.source.ref]), [['current: author-not-allowed', 'current:W2#L1']]);
}));

test('lines against the rules are held with the reason and stay out of the snapshot', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), [
    line({ kind: 'work.created', work_id: 'ok' }),
    line({ kind: 'work.created', work_id: 'c2', note: '始めた' }),
    line({ kind: 'work.created', work_id: 'c2', at: '2026-10-19T01:00:00Z' }),
    line({ kind: 'work.created', work_id: 'c2', author: 'W2' }),
    line({ kind: 'artifact.observed', work_id: 'c2', evidence: '試験が通った' }),
    line({ kind: 'work.terminal', work_id: 'c2', terminal: 'finished' }),
    '{"kind":"work.created",\n'].join(''));
  const { world, held } = snapshot(dir, T1, 'out');
  assert.deepEqual(claims(world).map(claim => claim.slice(0, 3)), [['work:ok', 'created', 'current:P#L1']]);
  assert.deepEqual(held.map(value => [value.reason, value.source.ref]), [
    ['current: fields', 'current:P#L2'], ['current: fields', 'current:P#L3'], ['current: fields', 'current:P#L4'],
    ['current: evidence-form', 'current:P#L5'], ['current: terminal', 'current:P#L6'], ['current: invalid-json', 'current:P#L7']]);
}));

test('the same input gives the same snapshot', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'c2' }) + line({ kind: 'artifact.observed', work_id: 'c2', evidence: SHA })
    + line({ kind: 'work.terminal', work_id: 'c2', terminal: 'blocked' }));
  const a = snapshot(dir, T1, 'a'), b = snapshot(dir, T1, 'b');
  assert.equal(a.world, b.world);
  assert.deepEqual(claims(a.world).map(claim => claim[1]), ['created', 'progressed', SHA, 'reported-blocked']);
}));
