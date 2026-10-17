import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvents, readLedger, ledgerText } from '../ledger.mjs';

// L1 (apps#110): world events are appended to a ledger; the World is derived from the whole ledger.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const run = (script, args) => execFileSync(process.execPath, [file(script), ...args], { encoding: 'utf8' });
const json = text => JSON.parse(text);
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');

// One HQ refresh: real gh response snapshots (apps#92 state set per run) + P's declaration → G → ledger → World.
const refresh = (dir, ledger, at, state) => {
  const snaps = path.join(dir, 'snap-' + at.replace(/\W/gu, ''));
  cpSync(file('../collect/fixtures/snapshots'), snaps, { recursive: true });
  const pr = path.join(snaps, 'pr-roccho-dev-apps-92.json'), value = json(readFileSync(pr, 'utf8'));
  value.fetchedAt = at;
  Object.assign(value.responses.pr.data.data.repository.pullRequest, { state, merged: state === 'MERGED' });
  writeFileSync(pr, JSON.stringify(value));
  const declaration = readFileSync(file('../fixtures/live/purpose.jsonl'), 'utf8');
  writeFileSync(path.join(snaps, 'declaration-0.json'), JSON.stringify({ type: 'declaration', path: 'fixtures/live/purpose.jsonl', fetchedAt: at, sha256: sha(declaration), text: declaration }));
  const events = path.join(dir, 'g-' + at.replace(/\W/gu, '') + '.jsonl');
  run('../collect/collect.mjs', [snaps, '--recorded-at', at, '--out', events]);
  const receipt = json(run('../ledger.mjs', ['--ledger=' + ledger, events]));
  return { receipt, events };
};
const derive = (ledger, out) => run('../live.mjs', ['--out-dir=' + out, '--ledger=' + ledger, '--control=' + file('../fixtures/live/control.jsonl')]);

test('three refreshes (same, change, same) pile up frames in the ledger; the past observation stays reachable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-ledger-')), ledger = path.join(dir, 'ledger.jsonl');
  const runs = [['2026-10-16T20:40:00Z', 'OPEN'], ['2026-10-16T20:50:00Z', 'OPEN'], ['2026-10-16T21:00:00Z', 'MERGED'], ['2026-10-16T21:10:00Z', 'MERGED']];
  const appended = [], lengths = [];
  for (const [at, state] of runs) {
    const before = (() => { try { return readFileSync(ledger, 'utf8'); } catch { return ''; } })();
    appended.push(refresh(dir, ledger, at, state).receipt.appended);
    const after = readFileSync(ledger, 'utf8');
    assert.ok(after.startsWith(before), 'existing rows are never rewritten');
    lengths.push(rows(after).length - 1);
  }
  // First run records everything; the same values add nothing; the change adds only apps#92's changed facts.
  assert.deepEqual(appended.slice(1), [0, 2, 0]);
  const ledgerRows = readLedger(readFileSync(ledger, 'utf8'));
  assert.deepEqual(ledgerRows.map(row => row.seq), ledgerRows.map((row, index) => index + 1));
  assert.ok(ledgerRows.every(row => row.sha256.startsWith('sha256:') && row.recordedAt && row.actor && row.source));
  assert.deepEqual(ledgerRows.slice(-2).map(row => [row.event.target, row.event.value, row.recordedAt]),
    [['roccho-dev/apps#92:pr.state', 'MERGED', '2026-10-16T21:00:00Z'], ['roccho-dev/apps#92:pr.merged', 'true', '2026-10-16T21:00:00Z']]);
  // Frames at the declaration and at each change point: the OPEN observation is still in the past frame.
  const out = path.join(dir, 'out');
  derive(ledger, out);
  const world = json(readFileSync(path.join(out, 'world.json'), 'utf8'));
  assert.deepEqual(world.frames.map(frame => frame.asOf), ['2026-10-16T03:00:00.000Z', '2026-10-16T20:40:00.000Z', '2026-10-16T21:00:00.000Z']);
  const state = frame => world.frames.flatMap(value => value.asOf <= frame.asOf ? value.journal : [])
    .filter(entry => entry.kind === 'observation' && entry.target.id === 'roccho-dev/apps#92:pr.state').at(-1)?.value;
  assert.deepEqual(world.frames.slice(1).map(state), ['OPEN', 'MERGED']);
  const merged = frame => frame.gap.parts?.find(part => part.condition === 'merged');
  assert.equal(merged(world.frames[1])?.state, 'unmet', 'at 20:40 the PR was still OPEN');
  assert.equal(merged(world.frames[2]), undefined, 'at 21:00 it is met (closed difference)');
  // The same ledger gives the same World (idempotent derivation).
  const again = path.join(dir, 'again');
  derive(ledger, again);
  assert.equal(readFileSync(path.join(again, 'world.json'), 'utf8'), readFileSync(path.join(out, 'world.json'), 'utf8'));
  // Feeding the same collection again appends nothing: its observations are held as duplicates.
  const repeat = json(run('../ledger.mjs', ['--ledger=' + ledger, path.join(dir, 'g-20261016T210000Z.jsonl')]));
  assert.equal(repeat.appended, 0);
  assert.ok(repeat.held > 0);
});

const ideal = (maxAge, at = '2026-10-18T00:00:00Z') => ({ kind: 'ideal.set', recordedAt: at, purpose_id: 'p', purpose_rev: 'r1', version: 'v1', actor: 'P',
  source: { ref: 'hq:p', sha256: 'sha256:' + '0'.repeat(64) },
  requires: [{ id: 'A', label: 'A', predicate: { target: { kind: 'state', id: 'x' }, op: 'equals', value: 'ok' }, maxAge, norm: 'n' }] });
const obs = (at, value, ref = 'gh x') => ({ kind: 'observation', target: 'x', value, source: { ref, sha256: 'sha256:' + '1'.repeat(64) }, observedAt: at, recordedAt: at });
const jsonl = list => list.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';

test('freshness: the same value is recorded again once half of the shortest maxAge on its target has passed', () => {
  let state = appendEvents([], jsonl([ideal('PT1H'), obs('2026-10-18T00:00:00Z', 'ok')]));
  const step = (at, value, ref) => { state = appendEvents(state.rows, jsonl([obs(at, value, ref)])); return state.appended.length; };
  assert.equal(step('2026-10-18T00:29:00Z', 'ok'), 0, 'within half the window: no change');
  assert.equal(step('2026-10-18T00:30:00Z', 'ok'), 1, 'half the window passed: recorded as a refresh');
  assert.equal(step('2026-10-18T00:31:00Z', 'bad'), 1, 'a changed value is always recorded');
  assert.equal(step('2026-10-18T00:32:00Z', 'bad', 'gh x mirror'), 1, 'a changed source is recorded');
  // A target no condition declares a window on is recorded only when it changes.
  state = appendEvents(state.rows, jsonl([{ ...obs('2026-10-18T09:00:00Z', 'y'), target: 'free' }]));
  assert.equal(state.appended.length, 1);
  state = appendEvents(state.rows, jsonl([{ ...obs('2026-10-19T09:00:00Z', 'y'), target: 'free' }]));
  assert.equal(state.appended.length, 0, 'no window declared on "free": a day later the same value is still no change');
});

test('nothing damaged, duplicated or dated backwards enters the ledger; declarations are appended only when they change', () => {
  const base = appendEvents([], jsonl([ideal('PT1H'), obs('2026-10-18T01:00:00Z', 'ok')]));
  const next = appendEvents(base.rows, jsonl(['{not json', obs('2026-10-18T00:30:00Z', 'bad'), obs('2026-10-18T01:00:00Z', 'ok'),
    { kind: 'journal.held', reason: 'actor-mismatch', recordedAt: '2026-10-18T02:00:00Z' }, ideal('PT1H'), { ...ideal('PT2H'), recordedAt: '2026-10-18T02:00:00Z' }]));
  assert.deepEqual(next.held.map(value => value.reason), ['invalid-json', 'recordedAt-backwards', 'duplicate', 'held-by-G: actor-mismatch']);
  assert.deepEqual(next.skipped.map(value => value.event.kind), ['ideal.set'], 'the same declaration again is no change');
  assert.deepEqual(next.appended.map(row => [row.seq, row.event.kind, row.event.requires?.[0].maxAge]), [[3, 'ideal.set', 'PT2H']]);
  // A damaged ledger is refused as a whole; nothing is appended to it.
  const text = ledgerText(next.rows);
  assert.throws(() => readLedger(text.replace('"seq":2', '"seq":5')), /seq must be 2/u);
  assert.throws(() => readLedger(text.replace('"value":"ok"', '"value":"changed"')), /sha256/u);
});
