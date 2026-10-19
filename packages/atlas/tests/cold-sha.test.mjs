import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coldDigest, normalize, pyJsonDumps } from '../collect/adapter.mjs';
import { collect, toJsonl } from '../collect/collect.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

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

test('every real row with a content_sha256 is reproduced by the adapter; each dated one becomes a document', () => {
  for (const row of hashed) assert.equal(coldDigest(row.payload), row.observed_version.content_sha256);
  const dated = hashed.filter(row => typeof (row.payload.updated_at ?? row.observed_version.updated_at) === 'string');
  const docs = records.filter(record => record.kind === 'thread').flatMap(record => record.documents);
  assert.deepEqual(docs.map(doc => [doc.commentId, doc.source.sha256]),
    // A1: a body row (URL without a fragment, e.g. the adrs#603 PR) is commentId null, as in hot.
    dated.map(row => [row.payload.html_url.includes('#') ? row.payload.id : null, `sha256:${row.observed_version.content_sha256}`]));
  assert.deepEqual(docs.map(doc => doc.text), dated.map(row => row.payload.body));
});

test('real rows held with a reason: no payload or content_sha256 (missing, not a mismatch); no updated_at', () => {
  assert.deepEqual(records.filter(record => record.kind === 'held').map(record => [record.raw_id, record.reason]),
    [[rows[2].raw_id, 'content-sha256-missing'], [rows[5].raw_id, 'updated-at-missing']]);
});

// Python json.dumps(ensure_ascii=False, sort_keys=True) against JS JSON.stringify, one difference at a time.
// The expected strings are what Python prints; JSON.stringify is shown where it differs.
test('separators: ", " and ": " (JSON.stringify has none); keys sorted at every level', () => {
  const value = { b: 1, a: [1, { d: null, c: true }] };
  assert.equal(pyJsonDumps(value), '{"a": [1, {"c": true, "d": null}], "b": 1}');
  assert.equal(JSON.stringify(value), '{"b":1,"a":[1,{"d":null,"c":true}]}');
  assert.equal(pyJsonDumps({ e: {}, f: [] }), '{"e": {}, "f": []}');
});

test('keys sort by code point, not by UTF-16 unit', () => {
  // U+FF5E < U+1F600 by code point; JS's default sort puts the surrogate pair (0xD83D…) first.
  assert.equal(pyJsonDumps({ '😀': 2, '～': 1 }), '{"～": 1, "😀": 2}');
  assert.deepEqual(Object.keys({ '😀': 2, '～': 1 }).sort(), ['😀', '～']);
});

test('strings: non-ASCII raw, only quote, backslash and C0 controls escaped, \\u in lowercase', () => {
  assert.equal(pyJsonDumps('日本語 "引用" \\ \n\r\t\b\f\u0001\u001f\u007f é'),
    '"日本語 \\"引用\\" \\\\ \\n\\r\\t\\b\\f\\u0001\\u001f\u007f é"');
  // A lone surrogate: JSON.stringify writes \ud800, Python cannot UTF-8 encode it → not reproducible.
  assert.equal(JSON.stringify('\ud800'), '"\\ud800"');
  assert.equal(pyJsonDumps('\ud800'), null);
  assert.equal(pyJsonDumps({ '\udc00': 1 }), null);
});

test('numbers: safe integers only; floats and big integers cannot be reproduced after JSON.parse', () => {
  assert.equal(pyJsonDumps([0, -0, 6056248374, -3]), '[0, 0, 6056248374, -3]');
  // Python prints 1.0 / 1.5 / 1e+16 / 9007199254740993; JSON.parse has already lost which form was written.
  assert.equal(JSON.parse('1.0'), 1);
  assert.equal(JSON.stringify(JSON.parse('9007199254740993')), '9007199254740992');
  for (const value of [1.5, 2 ** 53, 1e21, Number.NaN]) assert.equal(pyJsonDumps(value), null);
});

test('a changed real row is held: body edited, raw_id tail edited, a float in the payload', () => {
  const base = rows[0], line = row => JSON.stringify(row);
  const edited = { ...base, payload: { ...base.payload, body: base.payload.body + ' ' } };
  const tail = { ...base, raw_id: base.raw_id.replace(/.$/u, char => (char === '0' ? '1' : '0')) };
  const float = { ...base, payload: { ...base.payload, score: 0.5 } };
  const held = normalize({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: PATH, committedAt: '2026-10-08T14:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null,
    text: [edited, tail, float].map(line).join('\n') + '\n' });
  assert.deepEqual(held.map(record => [record.kind, record.reason]),
    [['held', 'content-sha256-mismatch'], ['held', 'raw-id-mismatch'], ['held', 'content-sha256-unverifiable']]);
  assert.equal(coldDigest(base.payload), base.observed_version.content_sha256);
});

// C1c: the real rows go all the way through collect → live → D → World. The review row (adrs#603) has no
// updated_at anywhere (payload and observed_version are null); it must not stop the whole collection.
test('the real fixture passes collect and builds a World; a row without updated_at is held, never dated by guess', () => {
  const synthetic = readFileSync(fileURLToPath(new URL('../collect/fixtures/cold/decisions.jsonl', import.meta.url)), 'utf8');
  const purpose = normalize({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: 'decisions/synthetic.jsonl', committedAt: '2026-10-18T06:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: null, text: synthetic });
  const review = rows.find(row => row.raw_id.includes('.review.'));
  assert.deepEqual([review.payload.updated_at, review.observed_version.updated_at], [null, null]);
  const events = collect([...records, ...purpose], '2026-10-18T06:00:00Z');
  assert.deepEqual(events.filter(event => event.kind === 'journal.held' && event.line === review.raw_id).map(event => event.reason), ['cold: updated-at-missing']);
  const world = contractWorld(deriveAtlas(joinLog('', [toJsonl(events)]).log, '{"schema":"atlas.control-norms/1","authority":false}\n'));
  assert.equal(world.frames.at(-1).gap.basis.purpose_id, 'purpose.cold');
  // The World's journal keeps commentId as a number: compare numbers, and show the comparison can match.
  const commentIds = world.frames.flatMap(frame => frame.journal.map(entry => entry.source?.commentId));
  assert.ok(commentIds.includes(6249754001), 'a document that reached the World is found by its numeric id');
  assert.equal(typeof review.payload.id, 'number');
  assert.ok(!commentIds.includes(review.payload.id), 'the held review is not in the World');
});
