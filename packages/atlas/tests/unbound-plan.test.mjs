import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledgerEvents } from '../ledger.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import * as contract from '../contract.mjs';

const { contractWorld } = contract;
const unboundPlans = (frames, unbound) => contract.unboundPlans ? contract.unboundPlans(frames, unbound) : { unplaced: null };

// L3 (User 10-20: always show; adrs#647): a plan.set that no ideal state declares in requires[].plans stays held
// (g-plans.jsonl, reason unchanged) and never enters D; the World's journal also shows it, marked unbound: true,
// for display only. Fixture: the HQ ledger's declaration and plan.set rows (verbatim but seq) and one current line.
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const LEDGER = readFileSync(file('../fixtures/unbound/ledger.jsonl'), 'utf8'), CURRENT = readFileSync(file('../fixtures/unbound/g-current.jsonl'), 'utf8');
const CONTROL = '{"schema":"atlas.control-norms/1","authority":false}\n';
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const build = texts => {
  const joined = joinLog('', texts), result = deriveAtlas(joined.log, CONTROL), unbound = joined.unbound ?? [];
  return { ...joined, unbound, result, world: contractWorld(result, { unbound }), plain: contractWorld(result) };
};
const marked = world => world.frames.flatMap(frame => frame.journal).filter(entry => entry.unbound === true);
const withCurrent = build([ledgerEvents(LEDGER), CURRENT]), ledgerOnly = build([ledgerEvents(LEDGER)]);

test('the 12 unbound plans of the HQ ledger are in the journal, marked unbound, none unplaced', () => {
  assert.equal(withCurrent.unbound.length, 12);
  const entries = marked(withCurrent.world);
  assert.equal(entries.length, 12);
  assert.equal(new Set(entries.map(entry => JSON.stringify([entry.plan, entry.version, entry.source.sha256]))).size, 12);
  assert.deepEqual(entries.map(entry => Object.keys(entry).sort()), entries.map(() => ['actor', 'kind', 'plan', 'recordedAt', 'source', 'unbound', 'version']));
  assert.ok(entries.every(entry => entry.kind === 'plan.set' && ['ref', 'commentId', 'sha256'].every(key => key in entry.source)));
  assert.equal(unboundPlans(withCurrent.world.frames, withCurrent.unbound).unplaced, 0);
  // Each sits in the first frame whose asOf is at or after its recordedAt (never in an earlier frame).
  for (const frame of withCurrent.world.frames) {
    const before = withCurrent.world.frames[withCurrent.world.frames.indexOf(frame) - 1];
    for (const entry of frame.journal.filter(value => value.unbound)) {
      assert.ok(Date.parse(entry.recordedAt) <= Date.parse(frame.asOf) && (!before || Date.parse(entry.recordedAt) > Date.parse(before.asOf)));
    }
  }
});

test('without current the 6 plans after the last frame are not shown, only counted as unplaced', () => {
  assert.equal(unboundPlans(ledgerOnly.world.frames, ledgerOnly.unbound).unplaced, 6);
  assert.equal(marked(ledgerOnly.world).length, 6);
});

test('nothing else changes: D log, held, gap, phase, matched_until, plans and the other journal entries', () => {
  // The D log is byte for byte what it was before L3 (535cb34).
  assert.equal(sha(withCurrent.log), 'sha256:59577b357516135da1429e27d76f2c106ade02a11d49d48861e3f2ebdda0cf5e');
  assert.equal(withCurrent.held.filter(value => value.plan).length, 12);
  const view = world => world.frames.map(frame => ({ ...frame, journal: frame.journal.filter(entry => !entry.unbound) }));
  assert.deepEqual(view(withCurrent.world), view(withCurrent.plain));
});

test('live.mjs writes g-unbound-plans.jsonl, derive.mjs places them, the receipt counts unplaced', () => {
  const dir = mkdtempSync(fileURLToPath(new URL('./unbound-out-', import.meta.url)));
  try {
    const current = path.join(dir, 'g-current.jsonl');
    execFileSync('cp', [file('../fixtures/unbound/g-current.jsonl'), current]);
    execFileSync('cp', [file('../fixtures/unbound/ledger.jsonl'), path.join(dir, 'ledger.jsonl')]);
    const receipt = JSON.parse(execFileSync(process.execPath, [file('../live.mjs'), `--out-dir=${path.join(dir, 'out')}`, `--ledger=${path.join(dir, 'ledger.jsonl')}`, current], { encoding: 'utf8' }));
    assert.deepEqual([receipt.status, receipt.unbound], ['PASS', { count: 12, unplaced: 0 }]);
    assert.equal(readFileSync(path.join(dir, 'out', 'g-unbound-plans.jsonl'), 'utf8').trim().split('\n').length, 12);
    assert.equal(marked(JSON.parse(readFileSync(path.join(dir, 'out', 'world.json'), 'utf8'))).length, 12);
    // held and its reasons stay as they were.
    assert.equal(readFileSync(path.join(dir, 'out', 'g-plans.jsonl'), 'utf8').trim().split('\n').length, 12);
  } finally { rmSync(dir, { recursive: true }); }
});
