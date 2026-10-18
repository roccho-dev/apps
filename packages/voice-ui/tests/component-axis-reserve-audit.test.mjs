import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditReserveProjection, RESERVE_POOL_SHA256 } from './component-axis-reserve-audit.mjs';

const fixtureRoot = process.env.POC_RESERVE_FIXTURES ?? path.dirname(fileURLToPath(import.meta.url));
const bundleFile = process.env.POC_RESERVE_BUNDLE ?? path.join(process.env.POC_SOURCE_ROOT ?? '', 'web/data/bundle.v1.json');
const baseline = {
  poolBytes: fs.readFileSync(path.join(fixtureRoot, 'component-axes-E10-source-pool.public.json')),
  projectionBytes: fs.readFileSync(path.join(fixtureRoot, 'component-axes-E10.inputs.public.json')),
  oracleBytes: fs.readFileSync(path.join(fixtureRoot, 'component-axes-E10.oracle.public.json')),
  bundleBytes: fs.readFileSync(bundleFile),
};
const encode = v => Buffer.from(JSON.stringify(v));
const hash = v => createHash('sha256').update(v).digest('hex');
const changed = mutate => {
  const args = Object.fromEntries(Object.entries(baseline).map(([k, bytes]) => [k, Buffer.from(bytes)]));
  const oracle = JSON.parse(args.oracleBytes), input = JSON.parse(args.projectionBytes);
  mutate(oracle, input, args);
  args.oracleBytes = encode(oracle); input.oracle_sha256 = hash(args.oracleBytes); args.projectionBytes = encode(input);
  return args;
};

test('the actual consumed reserve projects faithfully without editing inputs or golden meanings', () => {
  const before = Object.fromEntries(Object.entries(baseline).map(([k, b]) => [k, hash(b)]));
  const result = auditReserveProjection(baseline);
  assert.equal(result.status, 'PASS', JSON.stringify(result.issues)); assert.equal(result.source_pool_sha256, RESERVE_POOL_SHA256);
  assert.deepEqual(result.case_order, ['R01', 'R05', 'R09', 'R02', 'R06', 'R10', 'R03', 'R07', 'R04', 'R08']);
  assert.deepEqual(result.strata, { sufficient: 4, missing: 4, ambiguous: 1, 'no-change': 1 });
  assert.deepEqual(Object.fromEntries(Object.entries(baseline).map(([k, b]) => [k, hash(b)])), before);
});

test('consistent new input hashes cannot authorize edited original utterances, cases, order or targets', () => {
  const mutators = [
    (o, p) => { o.cases[0].utterance += ' extra'; p.cases[0].utterance = o.cases[0].utterance; },
    (o, p) => { o.cases.reverse(); p.cases.reverse(); },
    (o, p) => { o.cases.pop(); p.cases.pop(); },
    o => { o.cases[0].expected_gate = 'no-change'; },
    o => { o.cases.find(c => c.expected_added_regions.length).expected_added_regions[0].label += ' changed'; },
    o => { o.cases.find(c => c.expected_added_edges.length).expected_added_edges[0].from = 'fixture:other'; },
    o => { o.cases.find(c => c.expected_missing.length).expected_missing.pop(); },
    o => { o.cases[0].new_override = true; },
  ];
  for (const mutate of mutators) assert.equal(auditReserveProjection(changed(mutate)).status, 'FAIL');
});

test('required rows and intent can only be mechanically derived from the unchanged original graph target', () => {
  for (const mutate of [o => { o.cases[0].required[0].quantity++; },
    o => { o.cases[0].required[0].kind = 'group'; }, o => { o.cases[0].required = []; },
    o => { o.cases[0].expected_intent = 'ambiguous'; },
    o => { o.cases.find(c => c.expected_gate === 'no-change').required = []; }])
    assert.equal(auditReserveProjection(changed(mutate)).status, 'FAIL');
});

test('fixture, stock and original seal bytes are independently anchored', () => {
  const mutateFixture = changed((o, p) => { o.fixture_contract.base_records[1].bounds[0] += 1;
    p.fixture_contract = structuredClone(o.fixture_contract); });
  assert.equal(auditReserveProjection(mutateFixture).status, 'FAIL');
  const args = { ...baseline, poolBytes: Buffer.concat([baseline.poolBytes, Buffer.from('\n')]) };
  assert.equal(auditReserveProjection(args).status, 'FAIL');
  const stock = JSON.parse(baseline.bundleBytes); stock.parts[0].label += ' changed';
  assert.equal(auditReserveProjection({ ...baseline, bundleBytes: encode(stock) }).status, 'FAIL');
  assert.equal(auditReserveProjection(changed(o => { o.stock_parts[0].label += ' changed'; })).status, 'FAIL');
});

test('substituting the already exposed primary10 never becomes the reserve10', () => {
  const pool = JSON.parse(baseline.poolBytes);
  const args = changed((o, p) => {
    const originals = pool.batches.primary.case_order.map(id => pool.cases.find(c => c.id === id));
    o.cases = originals.map(c => ({ ...c, expected_intent: 'change', required: [] }));
    p.cases = originals.map(({ id, fixture, utterance }) => ({ id, fixture, utterance }));
  });
  assert.equal(auditReserveProjection(args).status, 'FAIL');
});
