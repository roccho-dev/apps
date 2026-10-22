import test from 'node:test';
import assert from 'node:assert/strict';
import { coldDigest, normalize } from '../collect/adapter.mjs';
import { collect, toJsonl } from '../collect/collect.mjs';
import { appendEvents, ledgerEvents, ledgerText } from '../ledger.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

// A1: snapshot = reduce(cold, hot ∖ cold, current). One document (the issue body, or one comment) is identified by
// `owner/repo#n` and its commentId (null for the body) in hot and cold alike; when cold has it, cold is the
// confirmed value and hot does not override it. Synthetic minimal input on adrs#602: the body and three comments.
const REPO = 'roccho-dev/adrs', NUMBER = 602, ISSUE_ID = 5757973471, CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';
const line = value => JSON.stringify(value);
const block = lines => '<!-- atlas-journal-v1 -->\n```jsonl\n' + lines.map(line).join('\n') + '\n```\n';
const req = { id: 'merged', label: 'PR が入る', predicate: { target: { kind: 'state', id: 'roccho-dev/apps#200:pr.merged' }, op: 'equals', value: 'true' }, maxAge: 'PT72H', norm: 'norm.atlas' };
const BODY = 'synthetic minimal input\n' + block([
  { kind: 'purpose.set', recordedAt: '2026-10-08T07:00:00Z', purpose: { id: 'purpose.602', label: 'hot と cold を合わせる' }, rev: 'r1' },
  { kind: 'ideal.set', recordedAt: '2026-10-08T07:00:00Z', purpose_id: 'purpose.602', purpose_rev: 'r1', version: 'v1', requires: [req] }]);
// The sample decision in a comment is an ideal.drafting (an evaluation in a comment is held since C5 stage 1, adrs#647
// v4); its version names the copy.
const drafting = (at, version) => block([{ kind: 'ideal.drafting', recordedAt: at, purpose_id: 'purpose.602', version }]);
const SAME = 6055158360, EDITED = 6055246129, HOT_ONLY = 6055329139;
const docs = {
  body: { id: ISSUE_ID, at: '2026-10-08T07:00:00Z', text: BODY },
  same: { id: SAME, at: '2026-10-08T07:42:28Z', text: drafting('2026-10-08T07:42:00Z', 'in-both') },
  edited: { id: EDITED, at: '2026-10-08T08:00:00Z', text: drafting('2026-10-08T08:00:00Z', 'as-captured') },
};

// cold: adr_raw_event.v1 rows in the github_api.py form (content_sha256 = coldDigest of the payload).
const coldRow = ({ id, at, text }, body) => {
  const payload = { id, node_id: `N_${id}`, html_url: `https://github.com/${REPO}/issues/${NUMBER}${body ? '' : `#issuecomment-${id}`}`,
    created_at: at, updated_at: at, title: body ? 'hot と cold' : null, body: text, author: { id: 40359643, login: 'roccho-dev' } };
  const digest = coldDigest(payload);
  return { schema: 'adr_raw_event.v1', raw_id: `raw.adrs.hot_cold.${NUMBER}.${body ? 'issue' : 'comment'}.${id}.${digest.slice(0, 16)}`, status: 'observed_not_admitted',
    subject_key: `${REPO}.issue.${NUMBER}`, observed_version: { updated_at: at, content_sha256: digest }, payload };
};
const coldText = [coldRow(docs.body, true), coldRow(docs.same), coldRow(docs.edited)].map(line).join('\n') + '\n';
const cold = normalize({ type: 'cold', repo: REPO, commit: '94a51c3a', path: 'decisions/hot-cold.jsonl', committedAt: '2026-10-08T14:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null, text: coldText });
const contentOf = (doc, body = false) => 'sha256:' + coldRow(doc, body).observed_version.content_sha256;

// hot: the live gh responses for the same thread; one comment edited after the capture, one never captured.
const comment = ({ id, at, text }) => ({ id, updated_at: at, user: { login: 'roccho-dev' }, body: text });
const hotWith = (edit, fetchedAt = '2026-10-18T08:00:00Z') => normalize({ type: 'issue', owner: 'roccho-dev', repo: 'adrs', number: NUMBER, fetchedAt, responses: {
  issue: { sha256: 'sha256:' + '1'.repeat(64), data: { id: ISSUE_ID, updated_at: docs.body.at, user: { login: 'roccho-dev' }, body: BODY } },
  comments: { sha256: 'sha256:' + '2'.repeat(64), data: [[comment(docs.same),
    comment({ id: EDITED, at: '2026-10-10T00:00:00Z', text: drafting('2026-10-08T08:00:00Z', edit) }),
    comment({ id: HOT_ONLY, at: '2026-10-11T00:00:00Z', text: drafting('2026-10-11T00:00:00Z', 'hot-only') })]] } } });
const hot = hotWith('edited-after-capture');

// v4 (adrs#647 c6335921034, #6・#9; c6338759407): a decision comes only from P's declaration, so every decision in
// these comments is held as decision-from-comment. A1 still decides which copy of each document is the one held
// (cold's, never a changed hot one), and the Purpose comes from P's declaration (the D-form --purpose text).
const SHA = 'sha256:' + '3'.repeat(64);
const PURPOSE = [
  { kind: 'purpose.set', recordedAt: '2026-10-08T07:00:00Z', purpose: { id: 'purpose.602', label: 'hot と cold を合わせる' }, rev: 'r1', actor: 'P', source: { ref: 'hq:decl/purpose.jsonl', digest: SHA } },
  { kind: 'ideal.set', recordedAt: '2026-10-08T07:00:00Z', purpose_id: 'purpose.602', purpose_rev: 'r1', version: 'v1', requires: [req], actor: 'P', source: { ref: 'hq:decl/purpose.jsonl', digest: SHA } },
].map(line).join('\n') + '\n';
const join = texts => joinLog(PURPOSE, texts);
const fromComments = held => held.filter(value => value.reason === 'decision-from-comment').map(value => value.journal);

const check = ({ log, held }) => {
  const list = fromComments(held), of = commentId => list.filter(event => event.source.commentId === (commentId === null ? undefined : String(commentId)));
  // ① one row per document, from cold: the body's purpose.set / ideal.set and the comment in both.
  assert.deepEqual(list.filter(event => event.kind === 'purpose.set').map(event => event.source.digest), [contentOf(docs.body, true)]);
  assert.deepEqual(list.filter(event => event.kind === 'ideal.set').map(event => event.source.digest), [contentOf(docs.body, true)]);
  assert.deepEqual(of(SAME).map(event => [event.version, event.source.digest]), [['in-both', contentOf(docs.same)]]);
  // ③ a hot document whose content differs from cold is held as superseded-by-cold; cold stays.
  assert.deepEqual(of(EDITED).map(event => [event.version, event.source.digest]), [['as-captured', contentOf(docs.edited)]]);
  assert.deepEqual(held.filter(value => value.reason === 'superseded-by-cold').map(value => [value.journal.source.commentId, value.journal.version]),
    [[EDITED, 'edited-after-capture']]);
  // ④ a document only hot has stays.
  assert.deepEqual(of(HOT_ONLY).map(event => event.version), ['hot-only']);
  // reduce still builds a World.
  assert.ok(contractWorld(deriveAtlas(log, CONTROL)).frames.length > 0);
};

test('① ③ ④ hot and cold in one collection: one row per document, from cold; a changed hot is superseded; hot-only stays', () => {
  check(join([toJsonl(collect([...hot, ...cold], '2026-10-18T09:00:00Z'))]));
});

// A1b (R, v10: a past frame is never rewritten): through the ledger, hot read on 10-18 and cold on 10-19. The
// 10-18 row keeps the hot source after cold is read; on 10-19 only the fact that the same document is now
// confirmed by cold is added (an observation confirmed:<owner/repo#n>:<commentId|body>), the decision is not added
// again. (Since v4 the comment decisions are held, so the rows are checked where the join holds them.)
const T1 = '2026-10-18T09:00:00.000Z', T2 = '2026-10-19T09:00:00.000Z';
const first = appendEvents([], toJsonl(collect(hot, T1)), T1);
const second = appendEvents(first.rows, toJsonl(collect(cold, '2026-10-08T14:00:00Z')), T2);
const fromLedger = rows => join([ledgerEvents(ledgerText(rows))]);
const worldOf = rows => contractWorld(deriveAtlas(fromLedger(rows).log, CONTROL));
// The comment's purpose.set as the join holds it, by the time it reached the ledger.
const heldPurposes = rows => fromComments(fromLedger(rows).held).filter(event => event.kind === 'purpose.set').map(event => [event.recordedAt, event.source.digest]);

test('② ledger, hot first and cold later: the earlier row keeps the hot source; cold only adds a confirmation', () => {
  const hotDigest = first.rows.find(row => row.event.kind === 'purpose.set').event.source.sha256;
  assert.deepEqual(heldPurposes(first.rows), [[T1, hotDigest]]);
  assert.deepEqual(heldPurposes(second.rows), [[T1, hotDigest]], 'not rewritten to the cold digest, and not added again on 10-19');
  // On 10-19 only the confirmation is added, per document cold has and hot read the same.
  const later = worldOf(second.rows).frames.find(frame => frame.asOf === T2).journal;
  assert.deepEqual(later.filter(entry => entry.kind !== 'observation'), [], 'no decision is added on 10-19');
  assert.deepEqual(later.filter(entry => entry.kind === 'observation').map(entry => [entry.target.id, entry.value]), [
    [`confirmed:${REPO}#${NUMBER}:body`, `${REPO}@94a51c3a:decisions/hot-cold.jsonl`],
    [`confirmed:${REPO}#${NUMBER}:${SAME}`, `${REPO}@94a51c3a:decisions/hot-cold.jsonl`]]);
  // Every copy that reaches the join is held as decision-from-comment, once per document read, in time order.
  const { log, held } = fromLedger(second.rows);
  assert.deepEqual(fromComments(held).filter(event => event.kind === 'ideal.drafting').map(event => event.version), ['in-both', 'edited-after-capture', 'hot-only', 'as-captured']);
  assert.ok(!log.includes('"ideal.drafting"'), 'no comment decision is in the D log');
  assert.deepEqual(held.filter(value => /superseded|not declared/u.test(value.reason)), []);
});

test('② a hot row read after cold confirmed the document is held as superseded-by-cold; an unchanged re-read adds nothing', () => {
  const T3 = '2026-10-20T09:00:00.000Z';
  // An unchanged hot re-read is no change for the ledger.
  assert.deepEqual(appendEvents(second.rows, toJsonl(collect(hot, T3)), T3).appended.filter(row => row.event.kind !== 'plan.set').length, 0);
  const third = appendEvents(second.rows, toJsonl(collect(hotWith('edited-again', '2026-10-20T08:00:00Z'), T3)), T3);
  const { log, held } = fromLedger(third.rows);
  assert.deepEqual(held.filter(value => value.reason === 'superseded-by-cold').map(value => [value.journal.source.commentId, value.journal.version]), [[EDITED, 'edited-again']]);
  assert.deepEqual(fromComments(held).filter(event => event.recordedAt === T3).map(event => event.source.commentId), []);
  assert.ok(!log.includes('"ideal.drafting"'));
});

test('the issue body is one document in hot and cold: commentId null in both', () => {
  const coldBody = cold.find(record => record.kind === 'thread').documents.find(doc => doc.text === BODY);
  const hotBody = hot.find(record => record.kind === 'thread').documents.find(doc => doc.text === BODY);
  assert.deepEqual([coldBody.commentId, hotBody.commentId], [null, null]);
});
