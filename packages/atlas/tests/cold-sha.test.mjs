import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalize } from '../collect/adapter.mjs';

// C1b: content_sha256 is checked in the one form adrs tools/github_api.py (a6284e58) writes:
// sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True)) in plain hex, raw_id ending with its first 16.
// The fixture is real rows of adrs 94a51c3a decisions/hot-cold-observations-261008.jsonl (lines 14, 18, 22, 23,
// 37, 38), bytes unchanged: three comments with Japanese, newlines and double quotes, a PR (nested head/base), a
// review (null created_at/updated_at), and a revision row that has no payload.
const PATH = 'decisions/hot-cold-observations-261008.jsonl';
const text = readFileSync(fileURLToPath(new URL('../collect/fixtures/cold/adrs-94a51c3a-hot-cold.jsonl', import.meta.url)), 'utf8');
const rows = text.trim().split('\n').map(line => JSON.parse(line));
const records = normalize({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: PATH, committedAt: '2026-10-08T14:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null, text });
const hashed = rows.filter(row => row.observed_version?.content_sha256);

test('the fixture is what it claims: real rows, three comments with Japanese, newlines and quotes', () => {
  assert.deepEqual(rows.map(row => row.raw_id.split('.').slice(3, 5).join('.')),
    ['602.comment', '602.comment', 'revision.5c47716ed36211b97546', '602.comment', '603.pr', '603.review']);
  const comments = rows.filter(row => row.raw_id.includes('.comment.') && /[ぁ-んァ-ヶ一-龠]/u.test(row.payload.body)
    && row.payload.body.includes('\n') && row.payload.body.includes('"'));
  assert.equal(comments.length, 3);
  // As written by github_api.py: plain hex, and the raw_id carries its first 16 characters.
  for (const row of hashed) {
    assert.match(row.observed_version.content_sha256, /^[0-9a-f]{64}$/u);
    assert.ok(row.raw_id.endsWith('.' + row.observed_version.content_sha256.slice(0, 16)));
  }
});

test('every real row with a content_sha256 is reproduced by the adapter and becomes a document', () => {
  const docs = records.filter(record => record.kind === 'thread').flatMap(record => record.documents);
  assert.deepEqual(docs.map(doc => [doc.commentId, doc.source.sha256]),
    hashed.map(row => [row.payload.id, row.observed_version.content_sha256]));
  assert.deepEqual(docs.map(doc => doc.text), hashed.map(row => row.payload.body));
});

test('a real row without payload or content_sha256 is held as missing, not as a mismatch', () => {
  assert.deepEqual(records.filter(record => record.kind === 'held').map(record => [record.raw_id, record.reason]),
    [[rows[2].raw_id, 'content-sha256-missing']]);
});
