import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../collect/adapter.mjs';
import { collect } from '../collect/collect.mjs';

// C1: G reads Git Cold rows (adr_raw_event.v1) of a fixed adrs commit, so the reducer's input no longer
// needs /tmp/p-hq/ledger.jsonl. Capture is not admission (#607): status observed_not_admitted is kept as is.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const COMMIT = '94a51c3a0000000000000000000000000000beef', PATH = 'decisions/hot-cold-observations-261008.jsonl';
const REF = `roccho-dev/adrs@${COMMIT}:${PATH}`;
const text = readFileSync(file('../collect/fixtures/cold/decisions.jsonl'), 'utf8');
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
// What the edge (fetch.mjs) stores for one fixed commit and path: the adapter does not know where it lives.
const snapshot = { type: 'cold', repo: 'roccho-dev/adrs', commit: COMMIT, path: PATH, committedAt: '2026-10-18T06:00:00Z', fetchedAt: '2026-10-18T07:00:00Z', sha256: sha(text), text };
const rows = text.trim().split('\n').map(line => JSON.parse(line));
const CONTENT = `sha256:${rows[0].observed_version.content_sha256}`; // plain hex in the row, G's notation in the source

test('cold rows map to the existing thread record; invalid rows are held with a reason', () => {
  const records = normalize(snapshot);
  const thread = records.find(record => record.kind === 'thread');
  assert.deepEqual([thread.repo, thread.number, thread.source.ref], ['roccho-dev/adrs', 647, REF]);
  assert.deepEqual(thread.documents.map(doc => [doc.commentId, doc.author, doc.updatedAt, doc.source, doc.admission]),
    // A1: the document is owner/repo#n + commentId, as in hot; `capture` names the fixed commit and path.
    [[6249754001, 'roccho', '2026-10-18T01:00:00Z', { ref: 'roccho-dev/adrs#647', sha256: CONTENT, capture: REF, admission: 'observed_not_admitted' }, 'observed_not_admitted']]);
  assert.equal(thread.documents[0].text, rows[0].payload.body);
  assert.deepEqual(records.filter(record => record.kind === 'held').map(record => [record.raw_id, record.reason]),
    [[rows[1].raw_id, 'schema'], [rows[2].raw_id, 'content-sha256-mismatch']]);
});

test('existing journal/plan extraction reads the cold bodies; provenance is the fixed commit; nothing is admitted', () => {
  const events = collect(normalize(snapshot), '2026-10-18T06:00:00Z');
  const decisions = events.filter(event => ['purpose.set', 'ideal.set'].includes(event.kind));
  assert.deepEqual(decisions.map(event => [event.kind, event.actor, event.source]), [
    ['purpose.set', 'roccho', { ref: 'roccho-dev/adrs#647', sha256: CONTENT, capture: REF, admission: 'observed_not_admitted', commentId: 6249754001 }],
    ['ideal.set', 'roccho', { ref: 'roccho-dev/adrs#647', sha256: CONTENT, capture: REF, admission: 'observed_not_admitted', commentId: 6249754001 }]]);
  assert.deepEqual(events.filter(event => event.kind === 'journal.held').map(event => event.reason), ['cold: schema', 'cold: content-sha256-mismatch']);
  // Capture carries no admission: no event says admitted (the record keeps observed_not_admitted verbatim).
  assert.ok(events.every(event => !('admission' in event) && !('status' in event)));
});

// v4 (adrs#647 c6335921034, #6・#9; c6338759407): a decision comes only from P's declaration, so the Purpose is
// given as P's D-form declaration (the same purpose.set / ideal.set) and the cold rows' decisions are held as
// decision-from-comment, still named by the document and the cold row's content digest.
const DECLARED = collect(normalize(snapshot), '2026-10-18T06:00:00Z').filter(event => ['purpose.set', 'ideal.set'].includes(event.kind))
  .map(({ source, ...event }) => JSON.stringify({ ...event, source: { ref: 'hq:decl/purpose.jsonl', digest: source.sha256 } })).join('\n') + '\n';

test('live.mjs builds world.json from cold G events (no ledger) and P\'s declaration; the same commit gives the same events and World', t => {
  const build = () => {
    const dir = mkdtempSync(fileURLToPath(new URL('./cold-out-', import.meta.url)));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'snap'));
    writeFileSync(path.join(dir, 'snap', 'cold-0.json'), JSON.stringify(snapshot));
    writeFileSync(path.join(dir, 'purpose.jsonl'), DECLARED);
    // No --recorded-at: a cold collection is dated by its commit, so rebuilding it is reproducible.
    execFileSync(process.execPath, [file('../collect/collect.mjs'), path.join(dir, 'snap'), '--out', path.join(dir, 'g.jsonl')]);
    const receipt = JSON.parse(execFileSync(process.execPath, [file('../live.mjs'), '--out-dir=' + path.join(dir, 'out'), '--purpose=' + path.join(dir, 'purpose.jsonl'),
      path.join(dir, 'g.jsonl')], { encoding: 'utf8' }));
    return { receipt, events: readFileSync(path.join(dir, 'g.jsonl'), 'utf8'), world: readFileSync(path.join(dir, 'out', 'world.json'), 'utf8') };
  };
  const first = build(), second = build();
  assert.equal(first.receipt.status, 'PASS');
  assert.equal(second.events, first.events);
  assert.equal(sha(second.world), sha(first.world));
  assert.ok(first.receipt.inputs.every(input => !input.path.includes('ledger')), 'no ledger is read');
  const world = JSON.parse(first.world);
  assert.deepEqual([world.frames.length, world.frames[0].phase, world.frames[0].gap.basis.purpose_id], [1, 'approximating', 'purpose.cold']);
  assert.ok(world.frames[0].journal.every(entry => entry.kind === 'observation' || entry.source.ref === 'hq:decl/purpose.jsonl'), 'the decisions are P\'s');
  // The cold rows' decisions are held, named by the document (owner/repo#n, comment) and the cold row's content digest.
  assert.deepEqual(world.frames[0].held.map(entry => [entry.reason, entry.kind, entry.source.ref, entry.source.sha256]),
    [['decision-from-comment', 'purpose.set', 'roccho-dev/adrs#647', CONTENT], ['decision-from-comment', 'ideal.set', 'roccho-dev/adrs#647', CONTENT]]);
});
