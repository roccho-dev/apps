import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationEvents, journalEvents } from '../collect/journal.mjs';
import { currentEvents } from '../collect/worklog.mjs';
import { toJsonl } from '../collect/collect.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

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
    + line({ kind: 'artifact.observed', work_id: 'c1', evidence: 'roccho-dev/apps#119' }));
  assert.deepEqual(claims(snapshot(dir, T1, 'one').world), [
    ['work:c2', 'created', 'current:P#L1', T1],
    ['work:c1', 'progressed', 'current:P#L3', T1], ['evidence:c1', 'roccho-dev/apps#119', 'current:P#L3', T1]]);
  appendFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.terminal', work_id: 'wl2', terminal: 'done' }));
  const two = snapshot(dir, T2, 'two');
  assert.deepEqual(claims(two.world).at(-1), ['work:wl2', 'reported-done', 'current:P#L4', T2]);
  // A report is a claim, never an achievement: no condition watches work:*, nothing is satisfied by it.
  const frame = JSON.parse(two.world).frames.at(-1);
  assert.deepEqual([frame.gap.summary.satisfied, /work:|evidence:/u.test(JSON.stringify(frame.gap))], [0, false]);
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
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'a' }) + line({ kind: 'artifact.observed', work_id: 'b', evidence: SHA })
    + line({ kind: 'work.terminal', work_id: 'c', terminal: 'blocked' }));
  const a = snapshot(dir, T1, 'a'), b = snapshot(dir, T1, 'b');
  assert.equal(a.world, b.world);
  assert.deepEqual(claims(a.world).map(claim => claim[1]), ['created', 'progressed', SHA, 'reported-blocked']);
}));

// C4 (apps#89 comment 6257137004): one work_id in one author's file is last-write-wins by line position (no time is
// made up). Only the last state line and the last evidence of a work_id are observations; D never sees two
// same-time observations of one target. Earlier lines are kept as overwritten (held, not in the World).
test('LWW: created → progressed (evidence) → reported-done gives reported-done and the last evidence; the rest is overwritten', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'c2' }) + line({ kind: 'work.created', work_id: 'ok' })
    + line({ kind: 'artifact.observed', work_id: 'c2', evidence: SHA }) + line({ kind: 'work.terminal', work_id: 'c2', terminal: 'done' }));
  const a = snapshot(dir, T1, 'a'), b = snapshot(dir, T1, 'b');
  assert.deepEqual(claims(a.world).map(claim => claim.slice(0, 3)), [
    ['work:ok', 'created', 'current:P#L2'], ['evidence:c2', SHA, 'current:P#L3'], ['work:c2', 'reported-done', 'current:P#L4']]);
  assert.deepEqual(a.held.map(value => [value.reason, value.source.ref]), [['current: overwritten', 'current:P#L1'], ['current: overwritten', 'current:P#L3']]);
  // The World has one observation per target at that time: no same-time conflict for D.
  const frame = JSON.parse(a.world).frames.at(-1);
  const targets = frame.journal.filter(entry => entry.kind === 'observation').map(entry => entry.target.id);
  assert.equal(new Set(targets).size, targets.length);
  assert.equal(a.world, b.world);
}));

// C4b (R): the latest line is the author's latest intent. When it is invalid, the work has no state or evidence
// (not an earlier valid line in its place); the earlier lines are held as latest-line-invalid.
test('LWW: when the last line of a work_id is invalid, neither its state nor its evidence is shown', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'a' }) + line({ kind: 'artifact.observed', work_id: 'a', evidence: SHA })
    + line({ kind: 'work.created', work_id: 'ok' }) + line({ kind: 'work.terminal', work_id: 'a', terminal: 'finished' }));
  const { world, held } = snapshot(dir, T1, 'out');
  assert.deepEqual(claims(world).map(claim => claim.slice(0, 3)), [['work:ok', 'created', 'current:P#L3']]);
  assert.deepEqual(held.map(value => [value.reason, value.source.ref]), [
    ['current: latest-line-invalid', 'current:P#L1'], ['current: latest-line-invalid', 'current:P#L2'], ['current: terminal', 'current:P#L4']]);
}));

test('LWW for evidence: of two artifact.observed lines, the later evidence is the one in the World', () => within(dir => {
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'artifact.observed', work_id: 'c2', evidence: 'roccho-dev/apps#119' })
    + line({ kind: 'artifact.observed', work_id: 'c2', evidence: SHA }));
  const { world, held } = snapshot(dir, T1, 'out');
  assert.deepEqual(claims(world).map(claim => claim.slice(0, 3)), [['work:c2', 'progressed', 'current:P#L2'], ['evidence:c2', SHA, 'current:P#L2']]);
  assert.deepEqual(held.map(value => [value.reason, value.source.ref]), [['current: overwritten', 'current:P#L1']]);
  // LWW is per author's file: the same work_id in another author's file is another record, not overwritten here.
  writeFileSync(path.join(dir, 'w2.jsonl'), line({ kind: 'work.created', work_id: 'c2' }));
  execFileSync(process.execPath, [...collectArgs(dir, T1, 'two', [`P=${path.join(dir, 'current.jsonl')}`, `W2=${path.join(dir, 'w2.jsonl')}`]), '--worklog-author', 'W2']);
  const events = readFileSync(path.join(dir, 'two.g.jsonl'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
  assert.deepEqual(events.filter(event => event.kind === 'observation' && event.target === 'work:c2').map(event => event.source.ref), ['current:P#L2', 'current:W2#L1']);
}));

// C2e (R, NO_GO): reading current must not move the cold events' time: cold stays dated by its commit.
test('cold with --current and no --recorded-at: the cold events are the same on every run, dated by the commit', () => within(dir => {
  const text = readFileSync(file('../collect/fixtures/cold/decisions.jsonl'), 'utf8');
  rmSync(path.join(dir, 'snap', 'declaration-0.json')); // only cold and current here
  writeFileSync(path.join(dir, 'snap', 'cold-0.json'), JSON.stringify({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: 'decisions/x.jsonl',
    committedAt: '2026-10-18T06:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null, text }));
  writeFileSync(path.join(dir, 'current.jsonl'), line({ kind: 'work.created', work_id: 'c2' }));
  const run = name => {
    execFileSync(process.execPath, [file('../collect/collect.mjs'), path.join(dir, 'snap'), '--current', `P=${path.join(dir, 'current.jsonl')}`,
      '--worklog-author', 'P', '--out', path.join(dir, `${name}.jsonl`)]);
    const events = readFileSync(path.join(dir, `${name}.jsonl`), 'utf8').trim().split('\n').map(text => JSON.parse(text));
    return { cold: events.filter(event => !event.source?.ref?.startsWith('current:')), current: events.filter(event => event.source?.ref?.startsWith('current:')) };
  };
  const first = run('first'), second = run('second');
  assert.ok(first.cold.length > 0);
  assert.deepEqual(second.cold, first.cold);
  // Every cold event is dated by the commit; journal decisions keep the recordedAt their own line declares.
  const dated = first.cold.filter(event => !['purpose.set', 'ideal.set'].includes(event.kind));
  assert.ok(dated.length > 0 && dated.every(event => event.recordedAt === '2026-10-18T06:00:00Z'));
  // current carries the time it was read (after the commit), on its own events only.
  assert.ok(first.current.length === 1 && Date.parse(first.current[0].observedAt) > Date.parse('2026-10-18T06:00:00Z')
    && first.current[0].recordedAt === first.current[0].observedAt);
}));

// C2e/C2f (adrs#654): a worklog value is never a condition. A declaration whose condition targets work:* or
// evidence:* is held before D — from a declaration file, a comment or `live.mjs --purpose` alike, whatever its
// kind (ideal.set, or the legacy purpose.set that carries requires). The reducer is unchanged.
const ZERO = 'sha256:' + '0'.repeat(64), CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';
const workCondition = target => ({ ...req, id: 'w', predicate: { target: { kind: 'state', id: target }, op: 'equals', value: 'reported-done' } });
const fromFile = text => declarationEvents({ path: 'p.jsonl', sha256: ZERO, text }, T1);
const fromComment = text => journalEvents([{ repo: 'roccho-dev/apps', number: 89, commentId: 1, updatedAt: T1, author: 'P', text: '<!-- atlas-journal-v1 -->\n```jsonl\n' + text + '```\n' }], T1);
// P reports work a as done: a claim at T1.
const done = () => currentEvents([{ author: 'P', text: line({ kind: 'work.terminal', work_id: 'a', terminal: 'done' }) }], T1, T1, ['P']);
const reduce = (purposeText, gEvents) => {
  const { log, held } = joinLog(purposeText, [toJsonl(gEvents)]);
  return { log, held: held.map(value => value.reason), frame: contractWorld(deriveAtlas(log, CONTROL)).frames.at(-1) };
};

test('an ideal.set with a work: or evidence: predicate target is held before D', () => {
  const ideal = target => line({ kind: 'ideal.set', recordedAt: '2026-10-19T01:00:00Z', purpose_id: 'purpose.current', purpose_rev: 'r1', version: 'v1',
    requires: [req, workCondition(target)] });
  for (const target of ['work:c2', 'evidence:c2']) for (const intake of [fromFile, fromComment]) {
    const { log, held } = joinLog('', [toJsonl([...fromFile(declaration.split('\n')[0]), ...intake(ideal(target))])]);
    assert.ok(held.some(value => value.reason === 'worklog-target-in-predicate'), target);
    assert.ok(!log.includes('"kind":"ideal.set"'), target);
  }
  // Another target is unchanged: the same line with roccho-dev/apps#201:pr.merged is accepted.
  assert.ok(joinLog('', [toJsonl([...fromFile(declaration.split('\n')[0]), ...fromFile(ideal('roccho-dev/apps#201:pr.merged'))])]).log.includes('"kind":"ideal.set"'));
});

test('R: a legacy purpose.set with requires on work:a is held via G and via --purpose; a claim never satisfies it', () => {
  const legacy = { kind: 'purpose.set', recordedAt: '2026-10-19T01:30:00Z', purpose: { id: 'purpose.work', label: '作業で満たす' }, version: 'v2', label: '作業が終わる',
    requires: [workCondition('work:a')] };
  // G: P's declaration (purpose.current) plus a comment carrying the legacy purpose.set.
  const g = reduce('', [...fromFile(declaration), ...fromComment(line(legacy)), ...done()]);
  // --purpose: the same as D-form lines given straight to live.mjs, not through G.
  const dForm = text => text.trim().split('\n').map(value => line({ ...JSON.parse(value), actor: 'P', source: { ref: 'hq:p.jsonl', digest: ZERO } })).join('');
  const direct = reduce(dForm(declaration + line(legacy)), done());
  for (const { held, frame } of [g, direct]) {
    assert.ok(held.includes('worklog-target-in-predicate'));
    assert.deepEqual([frame.gap.basis.purpose_id, frame.gap.summary.satisfied], ['purpose.current', 0]);
  }
});
