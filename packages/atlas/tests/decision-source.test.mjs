import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthority } from '../events.mjs';
import { joinLog } from '../live.mjs';
import { journalEvents } from '../collect/journal.mjs';
import { HELD_REASONS } from '../contract.mjs';

// v4 (adrs#647 c6335921034, #6・#9; the consequence for A1・A3 in c6338759407): purposes and ideals come only
// from P's declaration — the D-form --purpose text, or the declaration file G reads as `hq:<path>`. The same
// decision in a comment is held as decision-from-comment, whoever wrote it (a decider's login is shared,
// control.jsonl:8), and a Purpose with no authority row is no longer open to anyone who writes a comment. The
// authority check comes first, so a proposer's comment is still a proposal (S4).
const SHA = 'sha256:' + '0'.repeat(64);
const req = { id: 'A', label: 'A', predicate: { target: { kind: 'state', id: 's.a' }, op: 'equals', value: 'ok' }, maxAge: 'PT24H', norm: 'n.a' };
const decisions = (ref, actor) => [
  { kind: 'purpose.set', recordedAt: '2026-10-21T01:00:00Z', purpose: { id: 'p', label: 'P' }, rev: 'r1', actor, source: { ref, sha256: SHA } },
  { kind: 'ideal.set', recordedAt: '2026-10-21T01:00:00Z', purpose_id: 'p', purpose_rev: 'r1', version: 'v1', requires: [req], actor, source: { ref, sha256: SHA } },
].map(value => JSON.stringify(value)).join('\n') + '\n';
const control = authority => '{"schema":"atlas.control-norms/1","authority":false}\n' + (authority ? JSON.stringify({ kind: 'authority', purposeId: 'p', ...authority }) + '\n' : '');
const join = (text, authority) => joinLog('', [text], 'supplied', { authority: parseAuthority(control(authority)) });
const accepted = joined => joined.log.split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line).kind);
const heldOf = joined => joined.held.filter(value => value.journal).map(value => [value.journal.kind, value.reason]);

test('a decider\'s purpose and ideal in a comment are held as decision-from-comment; from P\'s declaration file they are accepted', () => {
  const authority = { deciders: ['P', 'roccho-dev'], proposers: [] };
  const fromComment = join(decisions('roccho-dev/adrs#647', 'roccho-dev'), authority);
  assert.deepEqual([accepted(fromComment), heldOf(fromComment)], [[], [['purpose.set', 'decision-from-comment'], ['ideal.set', 'decision-from-comment']]]);
  const fromDeclaration = join(decisions('hq:decl/purpose.jsonl', 'P'), authority);
  assert.deepEqual([accepted(fromDeclaration), heldOf(fromDeclaration)], [['purpose.set', 'ideal.set'], []]);
});

test('a Purpose with no authority row is no longer open to a comment (#9); P\'s declaration still declares it', () => {
  assert.deepEqual(heldOf(join(decisions('roccho-dev/apps#1', 'someone'))), [['purpose.set', 'decision-from-comment'], ['ideal.set', 'decision-from-comment']]);
  assert.deepEqual(accepted(join(decisions('hq:decl/purpose.jsonl', 'P'))), ['purpose.set', 'ideal.set']);
});

test('the authority check comes first: a proposer\'s comment stays a proposal, an outsider\'s is actor-not-authorized', () => {
  const authority = { deciders: ['P'], proposers: ['bot'] };
  assert.deepEqual(heldOf(join(decisions('o/r#1', 'bot'), authority)), [['purpose.set', 'proposal'], ['ideal.set', 'proposal']]);
  assert.deepEqual(heldOf(join(decisions('o/r#1', 'someone'), authority)), [['purpose.set', 'actor-not-authorized'], ['ideal.set', 'actor-not-authorized']]);
});

test('a comment cannot name P\'s declaration as its source: G replaces the source a line claims with where it read it', () => {
  const line = JSON.parse(decisions('hq:decl/purpose.jsonl', 'P').split('\n')[0]);
  const text = '<!-- atlas-journal-v1 -->\n```jsonl\n' + JSON.stringify(line) + '\n```\n';
  const [event] = journalEvents([{ repo: 'roccho-dev/adrs', number: 647, commentId: 1, updatedAt: '2026-10-21T02:00:00Z', author: 'P', text }], '2026-10-21T03:00:00Z');
  assert.equal(event.source.ref, 'roccho-dev/adrs#647');
  assert.deepEqual(heldOf(join(JSON.stringify(event) + '\n')), [['purpose.set', 'decision-from-comment']]);
});

test('decision-from-comment reaches the World as it is (contract v12 HELD_REASONS)', () => {
  assert.ok(HELD_REASONS.includes('decision-from-comment'));
});
