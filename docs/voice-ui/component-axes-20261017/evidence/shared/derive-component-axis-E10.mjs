// Independent format projection of the previously committed, unused E reserve.
// No implementation parser or provider output is read by this projection.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonical } from './semantic-score.mjs';
import { validParts, validRequired, missingFromRequired, validateAxisInput } from './component-axis-score.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const digest = b => createHash('sha256').update(b).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const poolBytes = fs.readFileSync(path.join(dir, 'fresh-pool-v2.sealed.json'));
const sourceSeal = 'b64985019e2248c4fde62e330f319846c96ab5014db4e96a7d8f0d50d5f86076';
assert.equal(digest(poolBytes), sourceSeal);
const pool = JSON.parse(poolBytes), order = pool.batches.reserve_unopened.case_order;
assert.equal(order.length, 10); assert.equal(new Set(order).size, 10);
const stockBytes = fs.readFileSync('C:/Users/resta/Codex/repos/apps.git/.worktrees/typellm-ci-20261017/packages/voice-ui/web/data/bundle.v1.json');
assert.equal(digest(stockBytes), pool.canonical_bundle_sha256);
const stock = JSON.parse(stockBytes).parts; assert.ok(validParts(stock)); assert.equal(stock.length, 8);
const originals = order.map(id => {
  const matches = pool.cases.filter(c => c.id === id); assert.equal(matches.length, 1); return matches[0];
});
const cases = originals.map(original => {
  const clear = ['sufficient', 'missing'].includes(original.expected_gate);
  const required = clear ? [] : null;
  if (clear) for (const region of original.expected_added_regions) {
    const found = required.find(r => r.label === region.label && r.kind === region.kind);
    if (found) found.quantity++; else required.push({ label: region.label, kind: region.kind, quantity: 1 });
  }
  if (clear) {
    assert.ok(validRequired(required));
    assert.deepEqual(canonical(missingFromRequired(required, stock)), canonical(original.expected_missing));
  } else {
    assert.ok(['ambiguous', 'no-change'].includes(original.expected_gate));
    assert.deepEqual(original.expected_missing, []); assert.deepEqual(original.expected_added_regions, []);
    assert.deepEqual(original.expected_added_edges, []);
  }
  const c = { ...original, expected_intent: clear ? 'change' : original.expected_gate, required };
  const unchanged = Object.fromEntries(Object.keys(original).map(key => [key, c[key]]));
  assert.deepEqual(unchanged, original);
  assert.ok(original.expected_added_regions.length <= 3 && original.expected_added_edges.length <= 1);
  return c;
});
const strata = Object.fromEntries(['sufficient', 'missing', 'ambiguous', 'no-change'].map(k =>
  [k, cases.filter(c => c.expected_gate === k).length]));
assert.deepEqual(strata, { sufficient: 4, missing: 4, ambiguous: 1, 'no-change': 1 });
const completeFactorOracle = 'For clear change cases, complete iff observed extracted required multiset equals this oracle.required exactly. Controls are N/A. This pure expected predicate is fixed before provider outputs, not a post-output oracle change.';
const oracle = { schema: 'voice-ui.component-axes-oracle/1', axis: 'E', reviewer: '/root/poc_reviewer',
  source_seal_sha256: sourceSeal, source_batch: 'reserve_unopened', source_baseline: pool.source_baseline,
  fixture_contract: pool.fixture_contract, stock_parts: stock, cases, complete_factor_oracle: completeFactorOracle,
  score_scope: 'Unchanged reserve10 ordinary default literal route; no oracle parts/parents/edges supplied; target and strata unchanged' };
const oracleBytes = encode(oracle);
const input = { schema: 'voice-ui.component-axes-input/1', axis: 'E', oracle_sha256: digest(oracleBytes),
  fixture_contract: pool.fixture_contract, cases: cases.map(({ id, fixture, utterance }) => ({ id, fixture, utterance })) };
assert.ok(validateAxisInput(input));
assert.deepEqual(input.cases, originals.map(({ id, fixture, utterance }) => ({ id, fixture, utterance })));
assert.deepEqual(input.fixture_contract, pool.fixture_contract);
const inputBytes = encode(input);
fs.writeFileSync(path.join(dir, 'component-axes-E10.oracle.sealed.json'), oracleBytes, { flag: 'wx' });
fs.writeFileSync(path.join(dir, 'component-axes-E10.inputs.public.json'), inputBytes, { flag: 'wx' });
const report = { schema: 'voice-ui.reviewer.reserve-projection/1', status: 'PASS', source_seal_sha256: sourceSeal,
  source_batch: 'reserve_unopened', case_order: order, strata, all_original_case_fields_unchanged: true,
  fixture_contract_unchanged: true, required_derivation: 'multiset of original expected_added_regions label/kind; controls null',
  expected_missing_equals_original_and_one_use_stock_difference: true,
  input: { file: 'component-axes-E10.inputs.public.json', bytes: inputBytes.length, sha256: digest(inputBytes) },
  oracle: { file: 'component-axes-E10.oracle.sealed.json', bytes: oracleBytes.length, sha256: digest(oracleBytes), visibility: 'SEALED_UNTIL_STOP' },
  original_case_object_sha256: originals.map(c => ({ id: c.id, sha256: digest(Buffer.from(JSON.stringify(canonical(c)))) })),
  scope: 'format adaptation only, fixed source reserve/targets/order; no provider output, parser, selection, substitution or oracle retuning' };
fs.writeFileSync(path.join(dir, 'component-axes-E10-reserve-projection-audit.json'), encode(report), { flag: 'wx' });
console.log(JSON.stringify(report));
