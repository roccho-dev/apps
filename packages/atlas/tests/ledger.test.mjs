import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvents, readLedger, ledgerText, ledgerEvents } from '../ledger.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

// L1 (apps#110) / v10: world events are appended to a ledger; the World is derived from the whole ledger,
// with frames cut by ledgerAt (when a row entered the ledger) and each event keeping its own time.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const run = (script, args) => execFileSync(process.execPath, [file(script), ...args], { encoding: 'utf8' });
const json = text => JSON.parse(text);
const rows = text => text.trim().split('\n').map(line => JSON.parse(line));
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const NO_NORMS = '{"schema":"atlas.control-norms/1","authority":false}\n';

// One HQ refresh: real gh response snapshots (apps#92 state set per run) + P's declaration → G → ledger.
// state null: P's declaration alone (P declares before the first collection).
const refresh = (dir, ledger, at, state) => {
  const snaps = path.join(dir, 'snap-' + at.replace(/\W/gu, ''));
  if (state) {
    cpSync(file('../collect/fixtures/snapshots'), snaps, { recursive: true });
    const pr = path.join(snaps, 'pr-roccho-dev-apps-92.json'), value = json(readFileSync(pr, 'utf8'));
    value.fetchedAt = at;
    Object.assign(value.responses.pr.data.data.repository.pullRequest, { state, merged: state === 'MERGED' });
    writeFileSync(pr, JSON.stringify(value));
  } else mkdirSync(snaps, { recursive: true });
  const declaration = readFileSync(file('../fixtures/live/purpose.jsonl'), 'utf8');
  writeFileSync(path.join(snaps, 'declaration-0.json'), JSON.stringify({ type: 'declaration', path: 'fixtures/live/purpose.jsonl', fetchedAt: at, sha256: sha(declaration), text: declaration }));
  const events = path.join(dir, 'g-' + at.replace(/\W/gu, '') + '.jsonl');
  run('../collect/collect.mjs', [snaps, '--recorded-at', at, '--out', events]);
  const receipt = json(run('../ledger.mjs', ['--ledger=' + ledger, '--ledger-at=' + at, events]));
  return { receipt, events };
};
const derive = (ledger, out) => run('../live.mjs', ['--out-dir=' + out, '--ledger=' + ledger, '--control=' + file('../fixtures/live/control.jsonl')]);

test('refreshes (same, change, same) pile up frames in the ledger; the past observation stays reachable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-ledger-')), ledger = path.join(dir, 'ledger.jsonl');
  const runs = [['2026-10-16T20:30:00Z', null], ['2026-10-16T20:40:00Z', 'OPEN'], ['2026-10-16T20:50:00Z', 'OPEN'],
    ['2026-10-16T21:00:00Z', 'MERGED'], ['2026-10-16T21:10:00Z', 'MERGED']];
  const appended = [];
  for (const [at, state] of runs) {
    const before = (() => { try { return readFileSync(ledger, 'utf8'); } catch { return ''; } })();
    appended.push(refresh(dir, ledger, at, state).receipt.appended);
    assert.ok(readFileSync(ledger, 'utf8').startsWith(before), 'existing rows are never rewritten');
  }
  // Declaration, then the first collection records everything; same values add nothing; the change adds apps#92's changed facts.
  assert.deepEqual(appended.slice(2), [0, 2, 0]);
  const ledgerRows = readLedger(readFileSync(ledger, 'utf8'));
  assert.deepEqual(ledgerRows.map(row => row.seq), ledgerRows.map((row, index) => index + 1));
  assert.ok(ledgerRows.every(row => row.sha256.startsWith('sha256:') && row.ledgerAt && row.recordedAt && row.actor && row.source));
  assert.deepEqual(ledgerRows.slice(-2).map(row => [row.event.target, row.event.value, row.ledgerAt]),
    [['roccho-dev/apps#92:pr.state', 'MERGED', '2026-10-16T21:00:00Z'], ['roccho-dev/apps#92:pr.merged', 'true', '2026-10-16T21:00:00Z']]);
  // Frames are cut by ledgerAt: the declaration's entry, then each change point.
  const out = path.join(dir, 'out');
  derive(ledger, out);
  const world = json(readFileSync(path.join(out, 'world.json'), 'utf8'));
  assert.deepEqual(world.frames.map(frame => frame.asOf), ['2026-10-16T20:30:00.000Z', '2026-10-16T20:40:00.000Z', '2026-10-16T21:00:00.000Z']);
  // The declaration's own time (03:00) stays readable in the frame where it entered the ledger.
  assert.deepEqual(world.frames[0].journal.map(entry => [entry.kind, entry.declaredAt]), [['purpose.set', '2026-10-16T03:00:00Z'], ['ideal.set', '2026-10-16T03:00:00Z']]);
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
  const repeat = json(run('../ledger.mjs', ['--ledger=' + ledger, '--ledger-at=2026-10-16T21:20:00Z', path.join(dir, 'g-20261016T210000Z.jsonl')]));
  assert.equal(repeat.appended, 0);
  assert.ok(repeat.held > 0);
});

const ideal = (maxAge, at = '2026-10-18T00:00:00Z', version = 'v1') => ({ kind: 'ideal.set', recordedAt: at, purpose_id: 'p', purpose_rev: 'r1', version, actor: 'P',
  source: { ref: 'hq:p', sha256: 'sha256:' + '0'.repeat(64) },
  requires: [{ id: 'A', label: 'A', predicate: { target: { kind: 'state', id: 'x' }, op: 'equals', value: 'ok' }, maxAge, norm: 'n' }] });
const obs = (at, value, ref = 'gh x') => ({ kind: 'observation', target: 'x', value, source: { ref, sha256: 'sha256:' + '1'.repeat(64) }, observedAt: at, recordedAt: at });
const jsonl = list => list.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';

test('freshness: the same value is recorded again once half of the shortest maxAge on its target has passed', () => {
  let state = appendEvents([], jsonl([ideal('PT1H'), obs('2026-10-18T00:00:00Z', 'ok')]), '2026-10-18T00:00:00Z');
  const step = (at, value, ref) => { state = appendEvents(state.rows, jsonl([obs(at, value, ref)]), at); return state.appended.length; };
  assert.equal(step('2026-10-18T00:29:00Z', 'ok'), 0, 'within half the window: no change');
  assert.equal(step('2026-10-18T00:30:00Z', 'ok'), 1, 'half the window passed: recorded as a refresh');
  assert.equal(step('2026-10-18T00:31:00Z', 'bad'), 1, 'a changed value is always recorded');
  assert.equal(step('2026-10-18T00:32:00Z', 'bad', 'gh x mirror'), 1, 'a changed source is recorded');
  // A target no condition declares a window on is recorded only when it changes.
  state = appendEvents(state.rows, jsonl([{ ...obs('2026-10-18T09:00:00Z', 'y'), target: 'free' }]), '2026-10-18T09:00:00Z');
  assert.equal(state.appended.length, 1);
  state = appendEvents(state.rows, jsonl([{ ...obs('2026-10-19T09:00:00Z', 'y'), target: 'free' }]), '2026-10-19T09:00:00Z');
  assert.equal(state.appended.length, 0, 'no window declared on "free": a day later the same value is still no change');
});

test('held only: damaged rows, exact duplicates, ledgerAt going backwards; declarations appended only when they change', () => {
  const base = appendEvents([], jsonl([ideal('PT1H'), obs('2026-10-18T01:00:00Z', 'ok')]), '2026-10-18T01:00:00Z');
  const next = appendEvents(base.rows, jsonl(['{not json', obs('2026-10-18T01:00:00Z', 'ok'), obs('2026-10-18T03:00:00Z', 'late'),
    { kind: 'journal.held', reason: 'actor-mismatch', recordedAt: '2026-10-18T02:00:00Z' }, ideal('PT1H'),
    ideal('PT2H', '2026-10-18T00:30:00Z', 'v2'), obs('2026-10-18T00:30:00Z', 'bad')]), '2026-10-18T02:00:00Z');
  // (one collection is processed in its own time order)
  assert.deepEqual(next.held.map(value => value.reason), ['invalid-json', 'duplicate', 'held-by-G: actor-mismatch', 'dated-after-ledgerAt']);
  assert.deepEqual(next.skipped.map(value => value.event.kind), ['ideal.set'], 'the same declaration again is no change');
  // Past-dated events are not held (v10): they enter with this ledgerAt and keep their own time.
  assert.deepEqual(next.appended.map(row => [row.seq, row.ledgerAt, row.event.kind, row.recordedAt]),
    [[3, '2026-10-18T02:00:00Z', 'ideal.set', '2026-10-18T00:30:00Z'], [4, '2026-10-18T02:00:00Z', 'observation', '2026-10-18T00:30:00Z']]);
  const back = appendEvents(next.rows, jsonl([obs('2026-10-18T01:30:00Z', 'again')]), '2026-10-18T01:59:00Z');
  assert.deepEqual([back.appended.length, back.held.map(value => value.reason)], [0, ['ledgerAt-backwards']]);
  // A damaged ledger is refused as a whole; nothing is appended to it.
  const text = ledgerText(next.rows);
  assert.throws(() => readLedger(text.replace('"seq":2', '"seq":5')), /seq must be 2/u);
  assert.throws(() => readLedger(text.replace('"value":"ok"', '"value":"changed"')), /sha256/u);
  assert.throws(() => readLedger(text.replace('"seq":4,"ledgerAt":"2026-10-18T02:00:00Z"', '"seq":4,"ledgerAt":"2026-10-18T00:00:00Z"')), /ledgerAt goes backwards/u);
});

// L1c (P's HQ false positive): "observed before the ideal state was set" compares event times, the
// observation's observedAt with the ideal state's own time (declaredAt), never the ledgerAt of the ideal.
test('before-ideal marks compare observedAt with the declaration time, not with ledgerAt', () => {
  const two = { ...ideal('PT24H', '2026-10-17T22:54:31Z'), requires: [ideal('PT24H').requires[0],
    { id: 'B', label: 'B', predicate: { target: { kind: 'state', id: 'y' }, op: 'equals', value: 'ok' }, maxAge: 'PT24H', norm: 'n' }] };
  const purpose = { kind: 'purpose.set', recordedAt: '2026-10-17T22:54:31Z', purpose: { id: 'p', label: 'P' }, rev: 'r1', actor: 'P',
    source: { ref: 'hq:p', sha256: 'sha256:' + '0'.repeat(64) } };
  const world = observedAt => {
    // One collection: fetched just before it is appended; the declaration was written earlier (22:54).
    const seen = [{ ...obs(observedAt, 'ok'), recordedAt: '2026-10-17T23:17:41.900Z' }, { ...obs(observedAt, 'no'), target: 'y', recordedAt: '2026-10-17T23:17:41.900Z' }];
    const { rows: ledgerRows } = appendEvents([], jsonl([purpose, two, ...seen]), '2026-10-17T23:17:42.036Z');
    const frame = contractWorld(deriveAtlas(joinLog('', [ledgerEvents(ledgerText(ledgerRows))]).log, NO_NORMS)).frames.at(-1);
    return [frame.gap.summary.before_ideal, frame.gap.parts.map(part => [part.condition, part.observed_before_ideal ?? false])];
  };
  assert.deepEqual(world('2026-10-17T23:17:41.695Z'), [0, [['B', false]]], 'observed after the declaration: no mark');
  assert.deepEqual(world('2026-10-17T22:50:00Z'), [1, [['B', true]]], 'observed before the declaration: marked');
});

// README "A last line cut short": the CLI stops and appends nothing; removing only that line repairs it.
test('a ledger whose last line was cut short is refused (nothing appended) until the line is removed by hand', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-ledger-cut-')), ledger = path.join(dir, 'ledger.jsonl'), events = path.join(dir, 'g.jsonl');
  const whole = ledgerText(appendEvents([], jsonl([ideal('PT1H'), obs('2026-10-18T00:00:00Z', 'ok')]), '2026-10-18T00:00:00Z').rows);
  const cut = whole.slice(0, whole.length - 20);
  writeFileSync(ledger, cut);
  writeFileSync(events, jsonl([obs('2026-10-18T00:10:00Z', 'bad')]));
  const attempt = () => execFileSync(process.execPath, [file('../ledger.mjs'), '--ledger=' + ledger, '--ledger-at=2026-10-18T00:10:00Z', events], { stdio: 'pipe' });
  assert.throws(attempt);
  assert.throws(() => execFileSync(process.execPath, [file('../ledger.mjs'), '--ledger=' + ledger, '--check'], { stdio: 'pipe' }));
  assert.equal(readFileSync(ledger, 'utf8'), cut, 'nothing appended to a damaged ledger');
  // Manual repair: drop only the incomplete last line, check, then the next collection appends again.
  writeFileSync(ledger, cut.slice(0, cut.lastIndexOf('\n') + 1));
  assert.equal(json(run('../ledger.mjs', ['--ledger=' + ledger, '--check'])).rows, 1);
  assert.equal(json(attempt().toString()).appended, 1);
});

// R's reproduction (L1 NO_GO): the value changed at 00:50, so the ledger's last row is 00:50; then ideal.set v2,
// declared at 00:45, is read at 01:00 and 01:10. It must enter the ledger once and show from the 01:00 frame on.
test("a declaration dated before the ledger's last row enters the ledger (R's false negative)", () => {
  const purpose = { kind: 'purpose.set', recordedAt: '2026-10-18T00:00:00Z', purpose: { id: 'p', label: 'P' }, rev: 'r1', actor: 'P',
    source: { ref: 'hq:p', sha256: 'sha256:' + '0'.repeat(64) } };
  const v1 = ideal('PT1H', '2026-10-18T00:00:00Z'), v2 = ideal('PT1H', '2026-10-18T00:45:00Z', 'v2');
  const s0 = appendEvents([], jsonl([purpose, v1, obs('2026-10-18T00:00:00Z', 'ok')]), '2026-10-18T00:00:00Z');
  const s1 = appendEvents(s0.rows, jsonl([obs('2026-10-18T00:50:00Z', 'bad')]), '2026-10-18T00:50:00Z');
  const s2 = appendEvents(s1.rows, jsonl([purpose, v1, v2, obs('2026-10-18T01:00:00Z', 'bad')]), '2026-10-18T01:00:00Z');
  assert.deepEqual(s2.held.map(value => value.reason), [], 'v2 is not held');
  assert.deepEqual(s2.appended.map(row => [row.event.kind, row.event.version, row.recordedAt]), [['ideal.set', 'v2', '2026-10-18T00:45:00Z']]);
  const s3 = appendEvents(s2.rows, jsonl([purpose, v1, v2, obs('2026-10-18T01:10:00Z', 'bad')]), '2026-10-18T01:10:00Z');
  assert.deepEqual([s3.appended.length, s3.held.length], [0, 0], 'read again at 01:10: no change, nothing held');
  // Derived: v2 shows from the frame of its entry (01:00); the 00:50 frame (what was known then) is not rewritten.
  const { log } = joinLog('', [ledgerEvents(ledgerText(s3.rows))]);
  const world = contractWorld(deriveAtlas(log, NO_NORMS));
  assert.deepEqual(world.frames.map(frame => [frame.asOf.slice(11, 16), frame.gap.basis.ideal_version]), [['00:00', 'v1'], ['00:50', 'v1'], ['01:00', 'v2']]);
  assert.deepEqual(world.frames[2].journal.filter(entry => entry.kind === 'ideal.set').map(entry => [entry.ideal_version, entry.declaredAt]),
    [['v2', '2026-10-18T00:45:00Z']]);
});
