import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('cold rows map to the existing thread record; invalid rows are held with a reason', () => {
  const records = normalize(snapshot);
  const thread = records.find(record => record.kind === 'thread');
  assert.deepEqual([thread.repo, thread.number, thread.source.ref], ['roccho-dev/adrs', 647, REF]);
  assert.deepEqual(thread.documents.map(doc => [doc.commentId, doc.author, doc.updatedAt, doc.source, doc.admission]),
    [[6249754001, 'roccho', '2026-10-18T01:00:00Z', { ref: REF, sha256: rows[0].observed_version.content_sha256 }, 'observed_not_admitted']]);
  assert.equal(thread.documents[0].text, rows[0].payload.body);
  assert.deepEqual(records.filter(record => record.kind === 'held').map(record => [record.raw_id, record.reason]),
    [[rows[1].raw_id, 'schema'], [rows[2].raw_id, 'content-sha256-mismatch']]);
});

test('existing journal/plan extraction reads the cold bodies; provenance is the fixed commit; nothing is admitted', () => {
  const events = collect(normalize(snapshot), '2026-10-18T06:00:00Z');
  const decisions = events.filter(event => ['purpose.set', 'ideal.set'].includes(event.kind));
  assert.deepEqual(decisions.map(event => [event.kind, event.actor, event.source]), [
    ['purpose.set', 'roccho', { ref: REF, sha256: rows[0].observed_version.content_sha256, commentId: 6249754001 }],
    ['ideal.set', 'roccho', { ref: REF, sha256: rows[0].observed_version.content_sha256, commentId: 6249754001 }]]);
  assert.deepEqual(events.filter(event => event.kind === 'journal.held').map(event => event.reason), ['cold: schema', 'cold: content-sha256-mismatch']);
  // Capture carries no admission: no event says admitted (the record keeps observed_not_admitted verbatim).
  assert.ok(events.every(event => !('admission' in event) && !('status' in event)));
});

test('live.mjs builds world.json from cold G events alone (no ledger); the same commit gives the same events and World', () => {
  const build = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atlas-cold-'));
    mkdirSync(path.join(dir, 'snap'));
    writeFileSync(path.join(dir, 'snap', 'cold-0.json'), JSON.stringify(snapshot));
    // No --recorded-at: a cold collection is dated by its commit, so rebuilding it is reproducible.
    execFileSync(process.execPath, [file('../collect/collect.mjs'), path.join(dir, 'snap'), '--out', path.join(dir, 'g.jsonl')]);
    const receipt = JSON.parse(execFileSync(process.execPath, [file('../live.mjs'), '--out-dir=' + path.join(dir, 'out'), path.join(dir, 'g.jsonl')], { encoding: 'utf8' }));
    return { receipt, events: readFileSync(path.join(dir, 'g.jsonl'), 'utf8'), world: readFileSync(path.join(dir, 'out', 'world.json'), 'utf8') };
  };
  const first = build(), second = build();
  assert.equal(first.receipt.status, 'PASS');
  assert.equal(second.events, first.events);
  assert.equal(sha(second.world), sha(first.world));
  assert.ok(first.receipt.inputs.every(input => !input.path.includes('ledger')), 'no ledger is read');
  const world = JSON.parse(first.world);
  assert.deepEqual([world.frames.length, world.frames[0].phase, world.frames[0].gap.basis.purpose_id], [1, 'approximating', 'purpose.cold']);
  assert.ok(world.frames[0].journal.every(entry => entry.kind === 'observation' || entry.source.ref === REF));
});
