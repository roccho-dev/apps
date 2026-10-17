import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditReserveProjection as previous } from './component-axis-reserve-audit.ff279.mjs';
import { auditReserveProjection as current } from './component-axis-reserve-audit.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.POC_SOURCE_ROOT;
assert.ok(source, 'explicit public source required');
const sha = b => createHash('sha256').update(b).digest('hex');
const encode = x => Buffer.from(JSON.stringify(x));
const baseline = {
  poolBytes: fs.readFileSync(path.join(dir, 'component-axes-E10-source-pool.public.json')),
  projectionBytes: fs.readFileSync(path.join(dir, 'component-axes-E10.inputs.public.json')),
  oracleBytes: fs.readFileSync(path.join(dir, 'component-axes-E10.oracle.public.json')),
  bundleBytes: fs.readFileSync(path.join(source, 'web/data/bundle.v1.json')),
};
const oldBytes = fs.readFileSync(path.join(dir, 'component-axis-reserve-audit.ff279.mjs'));
const newBytes = fs.readFileSync(path.join(dir, 'component-axis-reserve-audit.mjs'));
assert.equal(newBytes.toString(), oldBytes.toString().replace(
  "error instanceof SyntaxError ? 'invalid JSON' : error.message",
  "error?.name === 'SyntaxError' ? 'invalid JSON' : error.message"));
const rows = [];
function compare(id, args, expected) {
  const before = Object.fromEntries(Object.entries(args).map(([k, b]) => [k, sha(b)]));
  const a = previous(args), b = current(args);
  assert.deepEqual(b, a, id);
  assert.equal(b.status, expected, id);
  assert.deepEqual(Object.fromEntries(Object.entries(args).map(([k, b]) => [k, sha(b)])), before);
  rows.push({ id, status: b.status, issues: b.issues, identical: true });
}
compare('consumed-original-reserve', baseline, 'PASS');
for (const field of Object.keys(baseline)) {
  compare(`malformed-${field}`, { ...baseline, [field]: Buffer.from('{') }, 'FAIL');
}
for (const [id, mutate] of [
  ['changed-original-target', o => { o.cases[0].expected_added_regions[0].label += ' changed'; }],
  ['changed-mechanical-required', o => { o.cases[0].required[0].quantity++; }],
  ['changed-mechanical-intent', o => { o.cases[0].expected_intent = 'ambiguous'; }],
  ['reordered-original-cases', o => { o.cases.reverse(); }],
]) {
  const oracle = JSON.parse(baseline.oracleBytes); mutate(oracle);
  const oracleBytes = encode(oracle), projection = JSON.parse(baseline.projectionBytes);
  projection.oracle_sha256 = sha(oracleBytes);
  compare(id, { ...baseline, oracleBytes, projectionBytes: encode(projection) }, 'FAIL');
}
const child = spawnSync(process.execPath, ['--test', path.join(dir, 'component-axis-reserve-audit.test.mjs')], {
  encoding: 'utf8', env: { ...process.env, POC_RESERVE_FIXTURES: dir, POC_SOURCE_ROOT: source },
});
assert.equal(child.status, 0, child.stdout + child.stderr);
fs.writeFileSync(path.join(dir, 'component-axis-reserve-tests.3696.log'), child.stdout + child.stderr);
const originalValidation = JSON.parse(fs.readFileSync(path.join(dir, 'component-axis-reserve-audit-validation.ff279.json')));
const report = { ...current(baseline), independent_mutation_tests: {
  groups: 5, passed: 5, failed: 0, fixture: originalValidation.independent_mutation_tests.fixture, node: process.version,
}, module_sha256: sha(newBytes), test_sha256: sha(fs.readFileSync(path.join(dir, 'component-axis-reserve-audit.test.mjs'))),
  compatibility: { original_module_sha256: sha(oldBytes), changed_expression_only: true,
    original_validation_preserved: 'component-axis-reserve-audit-validation.ff279.json', cases: rows,
    scope: 'same-realm JSON.parse SyntaxError and own Error paths of this fixed public auditor; no equivalence claim for arbitrary thrown objects or altered globals' },
};
assert.equal(report.module_sha256, '3696fc017b0a3268ee532b327ba03418a79d21c9b5f3c414705541b79b219c2a');
fs.writeFileSync(path.join(dir, 'component-axis-reserve-audit-validation.3696.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(dir, 'component-axis-reserve-audit-validation.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: 'PASS', mutation_groups: 5, compatibility_cases: rows.length,
  module_sha256: report.module_sha256, report_sha256: sha(Buffer.from(JSON.stringify(report, null, 2) + '\n')) }) + '\n');
