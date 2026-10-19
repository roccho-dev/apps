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
const evaluated = (at, note) => block([{ kind: 'purpose.evaluated', recordedAt: at, purpose_id: 'purpose.602', purpose_rev: 'r1', ideal_version: 'v1', verdict: 'not-yet', note }]);
const SAME = 6055158360, EDITED = 6055246129, HOT_ONLY = 6055329139;
const docs = {
  body: { id: ISSUE_ID, at: '2026-10-08T07:00:00Z', text: BODY },
  same: { id: SAME, at: '2026-10-08T07:42:28Z', text: evaluated('2026-10-08T07:42:00Z', 'in both') },
  edited: { id: EDITED, at: '2026-10-08T08:00:00Z', text: evaluated('2026-10-08T08:00:00Z', 'as captured') },
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
const hot = normalize({ type: 'issue', owner: 'roccho-dev', repo: 'adrs', number: NUMBER, fetchedAt: '2026-10-18T08:00:00Z', responses: {
  issue: { sha256: 'sha256:' + '1'.repeat(64), data: { id: ISSUE_ID, updated_at: docs.body.at, user: { login: 'roccho-dev' }, body: BODY } },
  comments: { sha256: 'sha256:' + '2'.repeat(64), data: [[comment(docs.same),
    comment({ id: EDITED, at: '2026-10-10T00:00:00Z', text: evaluated('2026-10-08T08:00:00Z', 'edited after the capture') }),
    comment({ id: HOT_ONLY, at: '2026-10-11T00:00:00Z', text: evaluated('2026-10-11T00:00:00Z', 'hot only') })]] } } });

const decisions = log => log.trim().split('\n').slice(1).map(text => JSON.parse(text)).filter(event => event.kind !== 'observation');
const check = ({ log, held }) => {
  const list = decisions(log), of = commentId => list.filter(event => event.source.commentId === (commentId === null ? undefined : String(commentId)));
  // ① one row per document, from cold: the body's purpose.set / ideal.set and the comment in both.
  assert.deepEqual(list.filter(event => event.kind === 'purpose.set').map(event => event.source.digest), [contentOf(docs.body, true)]);
  assert.deepEqual(list.filter(event => event.kind === 'ideal.set').map(event => event.source.digest), [contentOf(docs.body, true)]);
  assert.deepEqual(of(SAME).map(event => [event.note, event.source.digest]), [['in both', contentOf(docs.same)]]);
  // ③ a hot document whose content differs from cold is held as superseded-by-cold; cold stays.
  assert.deepEqual(of(EDITED).map(event => [event.note, event.source.digest]), [['as captured', contentOf(docs.edited)]]);
  assert.deepEqual(held.filter(value => value.reason === 'superseded-by-cold').map(value => [value.journal.source.commentId, value.journal.note]),
    [[EDITED, 'edited after the capture']]);
  // ④ a document only hot has stays.
  assert.deepEqual(of(HOT_ONLY).map(event => event.note), ['hot only']);
  // reduce still builds a World.
  assert.ok(contractWorld(deriveAtlas(log, CONTROL)).frames.length > 0);
};

test('① ③ ④ hot and cold in one collection: one row per document, from cold; a changed hot is superseded; hot-only stays', () => {
  check(joinLog('', [toJsonl(collect([...hot, ...cold], '2026-10-18T09:00:00Z'))]));
});

test('② through the ledger, hot first and cold later: still one row per document, from cold', () => {
  const first = appendEvents([], toJsonl(collect(hot, '2026-10-18T09:00:00Z')), '2026-10-18T09:00:00Z');
  const second = appendEvents(first.rows, toJsonl(collect(cold, '2026-10-08T14:00:00Z')), '2026-10-19T09:00:00Z');
  check(joinLog('', [ledgerEvents(ledgerText(second.rows))]));
});

test('the issue body is one document in hot and cold: commentId null in both', () => {
  const coldBody = cold.find(record => record.kind === 'thread').documents.find(doc => doc.text === BODY);
  const hotBody = hot.find(record => record.kind === 'thread').documents.find(doc => doc.text === BODY);
  assert.deepEqual([coldBody.commentId, hotBody.commentId], [null, null]);
});
