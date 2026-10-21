import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAuthority } from '../events.mjs';
import { joinLog } from '../live.mjs';
import { journalEvents } from '../collect/journal.mjs';
import { HELD_REASONS } from '../contract.mjs';

// C5 (adrs#647 c6315614155, c6315696164): the User's evaluation is written by one login of its own as the first
// line of an Issue comment, `atlas-eval <verdict> <purpose_id> <purpose_rev> <ideal_version>[ <reason>]`. Only a
// login in the authority's `evaluators` may evaluate a declared Purpose; deciders and anyone else are held, and
// with no evaluators every evaluation is held (fail closed). The login here is a test one, `eval-test`.
const dir = new URL('./fixtures/cases/', import.meta.url);
const log = readFileSync(new URL('case-29.jsonl', dir), 'utf8');
const SHA = 'sha256:' + '0'.repeat(64);
const control = authority => '{"schema":"atlas.control-norms/1","authority":false}\n' + JSON.stringify({ kind: 'authority', purposeId: 'p', ...authority }) + '\n';
const evaluated = (actor, at, verdict = 'achieved') => JSON.stringify({ kind: 'purpose.evaluated', recordedAt: at, actor, purpose_id: 'p', purpose_rev: 'r1', ideal_version: 'v2',
  verdict, source: { ref: 's3:adrs#647', commentId: 1, sha256: SHA } });
const evaluations = [evaluated('eval-test', '2026-10-21T04:00:00Z'), evaluated('roccho', '2026-10-21T04:10:00Z', 'not-yet'), evaluated('someone', '2026-10-21T04:20:00Z')];
const join = authority => joinLog('', [log + evaluations.join('\n') + '\n'], 'supplied', { authority: parseAuthority(control(authority)) });
const accepted = joined => joined.log.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === 'purpose.evaluated').map(event => event.actor);
const heldOf = joined => joined.held.filter(value => value.journal?.kind === 'purpose.evaluated').map(value => [value.journal.actor, value.reason]);

test('authority takes an optional evaluators list, kept apart from deciders and proposers', () => {
  assert.deepEqual(parseAuthority(control({ deciders: ['roccho'], proposers: [], evaluators: ['eval-test'] })).get('p').evaluators, ['eval-test']);
  assert.deepEqual(parseAuthority(control({ deciders: ['roccho'], proposers: [] })).get('p').evaluators, [], 'absent: none');
  assert.throws(() => parseAuthority(control({ deciders: ['roccho'], proposers: [], evaluators: ['roccho'] })), /evaluator/u);
  assert.throws(() => parseAuthority(control({ deciders: ['roccho'], proposers: ['bot'], evaluators: ['bot'] })), /evaluator/u);
  assert.throws(() => parseAuthority(control({ deciders: ['roccho'], proposers: [], evaluators: 'eval-test' })), /evaluators/u);
});

test('only an evaluator\'s purpose.evaluated is accepted; a decider\'s and anyone else\'s are held', () => {
  const joined = join({ deciders: ['roccho'], proposers: [], evaluators: ['eval-test'] });
  assert.deepEqual(accepted(joined), ['eval-test']);
  assert.deepEqual(heldOf(joined), [['roccho', 'evaluator-only'], ['someone', 'evaluator-only']]);
});

test('with no evaluators declared, every evaluation is held: never evaluated (fail closed)', () => {
  for (const authority of [{ deciders: ['roccho'], proposers: [] }, { deciders: ['roccho'], proposers: [], evaluators: [] }]) {
    const joined = join(authority);
    assert.deepEqual(accepted(joined), []);
    assert.deepEqual(heldOf(joined), [['eval-test', 'evaluator-not-declared'], ['roccho', 'evaluator-not-declared'], ['someone', 'evaluator-not-declared']]);
  }
});

test('an evaluator decides nothing else', () => {
  const ideal = JSON.parse(log.split('\n')[1]);
  const joined = joinLog('', [log + JSON.stringify({ ...ideal, recordedAt: '2026-10-21T05:00:00Z', actor: 'eval-test', version: 'v3' }) + '\n'], 'supplied',
    { authority: parseAuthority(control({ deciders: ['roccho'], proposers: [], evaluators: ['eval-test'] })) });
  assert.deepEqual(joined.held.filter(value => value.journal?.actor === 'eval-test').map(value => value.reason), ['actor-not-authorized']);
});

// The comment form: the first line only, matched whole; the author is the comment's login, the time its updated_at.
const doc = (author, text, updatedAt = '2026-10-21T06:00:00Z') => ({ repo: 'roccho-dev/adrs', number: 647, commentId: 9, updatedAt, author, text });
const events = docs => journalEvents(docs, '2026-10-21T07:00:00Z');

test('the first line `atlas-eval …` of a comment is a purpose.evaluated by its author, at its updated_at', () => {
  const [event] = events([doc('eval-test', 'atlas-eval not-yet purpose.hq v1 v4 jev の完了を待つ\n\nほかの文')]);
  assert.deepEqual({ ...event, source: undefined }, { kind: 'purpose.evaluated', recordedAt: '2026-10-21T06:00:00Z', purpose_id: 'purpose.hq', purpose_rev: 'v1',
    ideal_version: 'v4', verdict: 'not-yet', note: 'jev の完了を待つ', actor: 'eval-test', source: undefined });
  assert.deepEqual(event.source, { ref: 'roccho-dev/adrs#647', commentId: 9, sha256: event.source.sha256 });
  assert.deepEqual(events([doc('eval-test', 'atlas-eval achieved purpose.hq v1 v4')]).map(item => [item.verdict, 'note' in item]), [['achieved', false]]);
});

test('`atlas-eval` on any other line is ignored; a first line that starts with it but does not match is held', () => {
  assert.deepEqual(events([doc('eval-test', '前置き\natlas-eval achieved purpose.hq v1 v4')]), []);
  for (const text of ['atlas-eval done purpose.hq v1 v4', 'atlas-eval achieved purpose.hq v1', 'atlas-evalachieved purpose.hq v1 v4', ' atlas-eval achieved purpose.hq v1 v4']) {
    const result = events([doc('eval-test', text)]);
    assert.ok(text.startsWith('atlas-eval ') ? result.length === 1 && result[0].kind === 'journal.held' && result[0].reason === 'eval-form' : result.length === 0, text + ' → ' + JSON.stringify(result));
  }
});

test('an evaluation comment by any login becomes the event; who may evaluate is the authority\'s rule, not collect\'s', () => {
  assert.deepEqual(events([doc('roccho-dev', 'atlas-eval achieved purpose.hq v1 v4'), doc(null, 'atlas-eval achieved purpose.hq v1 v4')]).map(item => [item.kind, item.actor ?? item.reason]),
    [['purpose.evaluated', 'roccho-dev'], ['journal.held', 'author-unknown']]);
});

test('the held reasons reach the World as they are (contract v12 HELD_REASONS), not as invalid-declaration', () => {
  for (const reason of ['evaluator-only', 'evaluator-not-declared', 'eval-form']) assert.ok(HELD_REASONS.includes(reason), reason);
});
