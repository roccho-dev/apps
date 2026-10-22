import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAuthority } from '../events.mjs';
import { joinLog } from '../live.mjs';
import { journalEvents } from '../collect/journal.mjs';
import { ownerEvents } from '../collect/owner.mjs';
import { HELD_REASONS } from '../contract.mjs';

// C5 stage 1 (adrs#647 v4 c6335921034, adopted by the User c6335830037 with the conditions of c6335481832): the
// User's evaluation counts only from the owner input source the authority names (`owner` {repo, login}), a
// private repo no agent can write to. The comment form is the same `atlas-eval …` first line; anywhere else it
// is held, whoever wrote it. The login `evaluators` list (apps#136) is retired.
const dir = new URL('./fixtures/cases/', import.meta.url);
const log = readFileSync(new URL('case-29.jsonl', dir), 'utf8');
const SHA = 'sha256:' + '0'.repeat(64);
const OWNER = { repo: 'roccho-dev/atlas-owner', login: 'roccho-dev' };
const control = authority => '{"schema":"atlas.control-norms/1","authority":false}\n' + JSON.stringify({ kind: 'authority', purposeId: 'p', ...authority }) + '\n';
const AT = '2026-10-21T07:00:00Z';

// The owner repo's comments as the REST API returns them (repo-wide Issue comments).
let id = 100;
const comment = (body, at, { login = 'roccho-dev', via = null, issue = 1, created = at } = {}) => ({ id: id++, issue_url: `https://api.github.com/repos/${OWNER.repo}/issues/${issue}`,
  created_at: created, updated_at: at, user: { login }, performed_via_github_app: via, body });
const readback = (at, extra) => comment('atlas-readback Applications・tokens・SSH and GPG keys・Sessions を確かめた', at, extra);
const changed = (at, extra) => comment('atlas-credentials-changed token を作り直した', at, extra);
const evaluation = (at, verdict = 'achieved', extra) => comment(`atlas-eval ${verdict} p r1 v2`, at, extra);
const reasons = result => result.held.map(value => value.reason);

test('authority takes an optional owner {repo, login}; evaluators is refused, not read two ways', () => {
  assert.deepEqual(parseAuthority(control({ deciders: ['roccho'], proposers: [], owner: OWNER })).get('p').owner, OWNER);
  assert.equal(parseAuthority(control({ deciders: ['roccho'], proposers: [] })).get('p').owner, null, 'absent: no one evaluates');
  assert.deepEqual(parseAuthority(control({ deciders: ['roccho-dev'], proposers: [], owner: OWNER })).get('p').owner, OWNER, 'the owner login may also be a decider');
  assert.throws(() => parseAuthority(control({ deciders: ['roccho'], proposers: [], evaluators: ['eval-test'] })), /evaluators is retired/u);
  for (const owner of [{ repo: 'atlas-owner', login: 'roccho-dev' }, { repo: OWNER.repo }, { ...OWNER, extra: 1 }, 'roccho-dev/atlas-owner'])
    assert.throws(() => parseAuthority(control({ deciders: ['roccho'], proposers: [], owner })), /owner/u, JSON.stringify(owner));
});

test('owner: an evaluation after the latest readback counts, as purpose.evaluated by the owner login, read at `at` and declared at its updated_at', () => {
  const result = ownerEvents([readback('2026-10-21T05:00:00Z'), evaluation('2026-10-21T06:00:00Z', 'not-yet', { issue: 3 })], OWNER, AT);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.events.map(event => ({ ...event, source: { ...event.source, digest: null } })), [{ kind: 'purpose.evaluated', recordedAt: AT, declaredAt: '2026-10-21T06:00:00Z',
    purpose_id: 'p', purpose_rev: 'r1', ideal_version: 'v2', verdict: 'not-yet', actor: 'roccho-dev',
    source: { ref: 'roccho-dev/atlas-owner#3', digest: null, commentId: String(id - 1), admission: 'owner-unverified' } }]);
});

test('owner: nothing counts before a readback, at or before it, or after a change written at or after it', () => {
  assert.deepEqual(reasons(ownerEvents([evaluation('2026-10-21T06:00:00Z')], OWNER, AT)), ['owner-readback-missing']);
  assert.deepEqual(reasons(ownerEvents([evaluation('2026-10-21T05:00:00Z'), readback('2026-10-21T05:00:00Z')], OWNER, AT)), ['owner-before-readback']);
  assert.deepEqual(reasons(ownerEvents([readback('2026-10-21T05:00:00Z'), changed('2026-10-21T05:30:00Z'), evaluation('2026-10-21T06:00:00Z')], OWNER, AT)),
    ['owner-credentials-changed']);
  // A new readback after the change: evaluations after it count again.
  const again = ownerEvents([readback('2026-10-21T05:00:00Z'), changed('2026-10-21T05:30:00Z'), readback('2026-10-21T05:40:00Z'), evaluation('2026-10-21T06:00:00Z')], OWNER, AT);
  assert.deepEqual([again.events.length, reasons(again)], [1, []]);
});

test('owner: another login, an App (performed_via_github_app), a future time and a malformed form are held', () => {
  const app = { id: 1, slug: 'chatgpt-codex-connector' };
  const result = ownerEvents([readback('2026-10-21T05:00:00Z'), evaluation('2026-10-21T06:00:00Z', 'achieved', { login: 'someone' }),
    evaluation('2026-10-21T06:00:00Z', 'achieved', { via: app }), evaluation('2026-10-21T08:00:00Z'), comment('atlas-eval done p r1 v2', '2026-10-21T06:00:00Z'),
    readback('2026-10-21T06:30:00Z', { via: app })], OWNER, AT);
  assert.deepEqual([result.events.length, reasons(result)], [0, ['owner-other-author', 'owner-via-app', 'recordedAt-after-source', 'owner-via-app', 'eval-form']]);
});

test('owner: unreadable comments (null) give no evaluation and one held owner-unreadable (never the last achieved)', () => {
  assert.deepEqual([ownerEvents(null, OWNER, AT).events, reasons(ownerEvents(null, OWNER, AT))], [[], ['owner-unreadable']]);
});

// The join: only the owner source's evaluations count; any other evaluation is held, whoever wrote it.
const fromComment = (actor, at, verdict = 'achieved') => JSON.stringify({ kind: 'purpose.evaluated', recordedAt: at, actor, purpose_id: 'p', purpose_rev: 'r1', ideal_version: 'v2',
  verdict, source: { ref: 'roccho-dev/adrs#647', commentId: 1, sha256: SHA } });
const comments = [fromComment('roccho-dev', '2026-10-21T04:00:00Z'), fromComment('eval-test', '2026-10-21T04:10:00Z', 'not-yet')];
const owned = ownerEvents([readback('2026-10-21T03:00:00Z'), evaluation('2026-10-21T04:20:00Z')], OWNER, AT).events;
const join = (authority, owner = owned) => joinLog('', [log + comments.join('\n') + '\n'], 'supplied', { authority: parseAuthority(control(authority)), owner });
const accepted = joined => joined.log.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === 'purpose.evaluated').map(event => [event.actor, event.source.ref]);
const heldOf = joined => joined.held.filter(value => value.journal?.kind === 'purpose.evaluated').map(value => [value.journal.actor, value.reason]);

test('join: the owner source\'s evaluation is accepted; one in any other comment is held, the owner login\'s too', () => {
  const joined = join({ deciders: ['roccho'], proposers: [], owner: OWNER });
  assert.deepEqual(accepted(joined), [['roccho-dev', 'roccho-dev/atlas-owner#1']]);
  assert.deepEqual(heldOf(joined), [['roccho-dev', 'evaluation-not-from-owner'], ['eval-test', 'evaluation-not-from-owner']]);
});

test('join: with no owner declared (or no authority) the owner source\'s evaluation is held too: never evaluated (fail closed)', () => {
  assert.deepEqual([accepted(join({ deciders: ['roccho'], proposers: [] })), heldOf(join({ deciders: ['roccho'], proposers: [] })).at(-1)],
    [[], ['roccho-dev', 'evaluator-not-declared']]);
  const none = joinLog('', [log], 'supplied', { owner: owned });
  assert.deepEqual([accepted(none), heldOf(none)], [[], [['roccho-dev', 'evaluator-not-declared']]]);
});

test('join: an owner source other than the declared one, or another login, is owner-mismatch', () => {
  const other = ownerEvents([readback('2026-10-21T03:00:00Z'), evaluation('2026-10-21T04:20:00Z')], { repo: 'roccho-dev/elsewhere', login: 'roccho-dev' }, AT).events;
  assert.deepEqual(heldOf(join({ deciders: ['roccho'], proposers: [], owner: OWNER }, other)).at(-1), ['roccho-dev', 'owner-mismatch']);
  assert.deepEqual(heldOf(join({ deciders: ['roccho'], proposers: [], owner: { ...OWNER, login: 'someone' } })).at(-1), ['roccho-dev', 'owner-mismatch']);
});

// The comment form itself is unchanged: collect still reads it (and the join holds it outside the owner source).
const doc = (author, text, updatedAt = '2026-10-21T06:00:00Z') => ({ repo: 'roccho-dev/adrs', number: 647, commentId: 9, updatedAt, author, text });
const events = docs => journalEvents(docs, AT);

test('the first line `atlas-eval …` of a comment is a purpose.evaluated by its author, at its updated_at', () => {
  const [event] = events([doc('eval-test', 'atlas-eval not-yet purpose.hq v1 v4 jev の完了を待つ\n\nほかの文')]);
  assert.deepEqual({ ...event, source: undefined }, { kind: 'purpose.evaluated', recordedAt: '2026-10-21T06:00:00Z', purpose_id: 'purpose.hq', purpose_rev: 'v1',
    ideal_version: 'v4', verdict: 'not-yet', note: 'jev の完了を待つ', actor: 'eval-test', source: undefined });
  assert.deepEqual(event.source, { ref: 'roccho-dev/adrs#647', commentId: 9, sha256: event.source.sha256 });
});

test('`atlas-eval` on any other line is ignored; a first line that starts with it but does not match is held', () => {
  assert.deepEqual(events([doc('eval-test', '前置き\natlas-eval achieved purpose.hq v1 v4')]), []);
  for (const text of ['atlas-eval done purpose.hq v1 v4', 'atlas-eval achieved purpose.hq v1', 'atlas-evalachieved purpose.hq v1 v4', ' atlas-eval achieved purpose.hq v1 v4']) {
    const result = events([doc('eval-test', text)]);
    assert.ok(text.startsWith('atlas-eval ') ? result.length === 1 && result[0].kind === 'journal.held' && result[0].reason === 'eval-form' : result.length === 0, text + ' → ' + JSON.stringify(result));
  }
});

test('the held reasons reach the World as they are (contract v12 HELD_REASONS), not as invalid-declaration', () => {
  for (const reason of ['evaluation-not-from-owner', 'evaluator-not-declared', 'owner-mismatch', 'owner-unreadable', 'owner-readback-missing',
    'owner-credentials-changed', 'owner-before-readback', 'owner-other-author', 'owner-via-app', 'eval-form']) assert.ok(HELD_REASONS.includes(reason), reason);
});
