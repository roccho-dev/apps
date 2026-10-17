import test from 'node:test';
import assert from 'node:assert/strict';
import { journalEvents, declarationEvents } from '../journal.mjs';
import { normalize } from '../adapter.mjs';
import { collect } from '../collect.mjs';
import { sha256 } from '../plan.mjs';

const RECORDED = '2026-10-17T10:00:00Z';
const line = value => JSON.stringify(value);
const decision = { kind: 'ideal.drafting', recordedAt: '2026-10-17T08:00:00Z', purpose_id: 'purpose.hq', version: 'v2' };
const comment = (text, extra = {}) => ({ repo: 'adrs', number: 647, commentId: 101, updatedAt: '2026-10-17T09:00:00Z', author: 'roccho', text, ...extra });
const section = (...lines) => `<!-- atlas-journal-v1 -->\n\`\`\`jsonl\n${lines.join('\n')}\n\`\`\`\n`;

test('synthetic minimal input: jsonl inside a marker section is a decision; the actor is the comment author', () => {
  // A section runs from its marker to the next marker or the end, so 'outside' means before the first marker.
  const text = '```jsonl\n' + line({ ...decision, version: 'outside' }) + '\n```\n' + section(line(decision));
  const events = journalEvents([comment(text)], RECORDED);
  assert.deepEqual(events, [{ ...decision, actor: 'roccho', source: { ref: 'adrs#647', commentId: 101, sha256: sha256(text) } }],
    'a block outside any marker section is not read');
});

test('synthetic minimal input: a mismatching self-declared actor, missing author, future time or unknown kind is held', () => {
  const held = (doc, reason) => assert.deepEqual(journalEvents([doc], RECORDED).map(event => [event.kind, event.reason]), [['journal.held', reason]]);
  held(comment(section(line({ ...decision, actor: 'someone-else' }))), 'actor-mismatch');
  held(comment(section(line(decision)), { author: null }), 'author-unknown');
  held(comment(section(line({ ...decision, recordedAt: '2026-10-17T09:30:00Z' }))), 'recordedAt-after-source');
  held(comment(section(line({ ...decision, kind: 'observation' }))), 'unknown-kind');
  held(comment(section('{not json')), 'invalid-json');
  // The same decision restated in a later section version is one decision.
  assert.equal(journalEvents([comment(section(line(decision)) + section(line(decision)).replace('-v1', '-v2'))], RECORDED).length, 1);
});

test("P's declaration file: every line is a decision by P with the file's path and sha256", () => {
  const text = line(decision) + '\n' + line({ ...decision, version: 'v3', actor: 'P' }) + '\n' + line({ ...decision, version: 'v4', actor: 'W' }) + '\n';
  const events = declarationEvents({ path: '/tmp/p-hq/live/purpose.jsonl', sha256: sha256(text), text }, RECORDED);
  assert.deepEqual(events.map(event => [event.kind, event.version ?? event.reason, event.actor ?? null]),
    [['ideal.drafting', 'v2', 'P'], ['ideal.drafting', 'v3', 'P'], ['journal.held', 'actor-mismatch', null]]);
  assert.deepEqual(events[0].source, { ref: 'hq:/tmp/p-hq/live/purpose.jsonl', sha256: sha256(text) });
  assert.deepEqual(declarationEvents({ path: 'gone', sha256: null, text: null }, RECORDED).map(event => event.reason), ['declaration-unreadable']);
});

test('adapter carries gh comment authors and declaration snapshots to the core', () => {
  const [thread] = normalize({ type: 'issue', owner: 'roccho-dev', repo: 'adrs', number: 647, fetchedAt: RECORDED, responses: {
    issue: { sha256: 'sha256:x', data: { updated_at: '2026-10-17T09:00:00Z', body: section(line(decision)), user: { login: 'roccho' } } },
    comments: { data: [[{ id: 7, updated_at: '2026-10-17T09:00:00Z', body: 'no marker', user: { login: 'atlas-w2' } }]] } } });
  assert.deepEqual(thread.documents.map(doc => doc.author), ['roccho', 'atlas-w2']);
  const events = collect([{ ...thread, repo: 'adrs' }, ...normalize({ type: 'declaration', path: 'decl.jsonl', fetchedAt: RECORDED, sha256: 'sha256:y', text: line(decision) })], RECORDED);
  assert.deepEqual(events.filter(event => event.kind !== 'plan.set').map(event => [event.kind, event.actor, event.source.ref]),
    [['ideal.drafting', 'roccho', 'adrs#647'], ['ideal.drafting', 'P', 'hq:decl.jsonl']]);
  assert.deepEqual(events.filter(event => event.kind === 'plan.set').map(event => event.actor), ['roccho'], 'a plan carries its section author too');
});
