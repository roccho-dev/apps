// Fixed before oracle-assisted diagnostic output. Never a main/fresh effect score.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const base = path.dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(base, name)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const stable = x => JSON.stringify(canonical(x));
const bag = xs => xs.map(stable).sort();
const sameBag = (a, b) => stable(bag(a)) === stable(bag(b));
const semantic = records => records.filter(r => r.type !== 'layout').map(r => {
  if (r.type !== 'region') return r;
  const { bounds, ...value } = r; return value;
});
const fixtureBytes = fs.readFileSync(path.join(base, 'inventory-ready-fixtures.json'));
assert.equal(hash(fixtureBytes), '2091b8180120d27a62098a94c98c536a3f5feed5b4a609353482abdc9b9b8b30');
const fixture = JSON.parse(fixtureBytes);
const sealBytes = fs.readFileSync(path.join(base, 'poc-holdout.sealed.json'));
assert.equal(hash(sealBytes), '22e47667ba3d6eaf1061c058b7f3e8fe07824dd3885b24264603a2be0b1f2c32');
const seal = JSON.parse(sealBytes);
const preflight = read('inventory-ready-runtime-preflight.json');
const bundleBytes = fs.readFileSync(path.join(base, '../packages/voice-ui/web/data/bundle.v1.json'));
const bundle = JSON.parse(bundleBytes);
const dir = path.join(base, 'inventory-ready-e4a2');
const parse = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
const identity = parse('identity.json'), execution = parse('execution.json');
assert.equal(execution.status, 'RECORDED'); assert.equal(execution.summary.length, 2);
assert.equal(identity.fixture_sha256, hash(fixtureBytes));
assert.equal(identity.driver_sha256, '19c3ca58958cefb19b10b9df6a6db565c1c592111ea7e59b6ce6cb096103dc79');
assert.equal(identity.canonical_bundle_sha256, hash(bundleBytes));
assert.deepEqual(identity.runtime, preflight.identity);
assert.equal(identity.source, 'e4a2af1efe9278996391f0374d4546a51aa98736');
assert.equal(identity.runtime.launcher.pid, 103655); assert.equal(identity.runtime.launcher.start_ticks, '7896006');
assert.equal(identity.runtime.launcher.phase_id, 'poc-ready-8');
assert.deepEqual(identity.runtime.launcher.allowances, { jev: 18, typellm: 0 });
assert.equal(identity.completion, false);
const order = ['H06', 'H08'];
assert.deepEqual(execution.summary.map(x => [x.id, x.arm]), order.map(id => [id, 'READY']));
const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
for (const kind of ['arm-start', 'arm-end'])
  assert.deepEqual(events.filter(e => e.kind === kind).map(x => [x.id, x.arm]), order.map(id => [id, 'READY']));
const reasons = new Set(['none', 'not-confident', 'no-executable-delta', 'candidate-overflow', 'budget-requests', 'budget-time',
  'inventory-not-confident', 'inventory-ambiguous', 'inventory-no-change', 'inventory-unsupported']);
let total = 0;
const rows = order.map(id => {
  const output = parse(id + '-READY.json'), input = fixture.cases.find(c => c.id === id), gold = seal.cases.find(c => c.id === id);
  const original = read('paired-main-e4a2/' + id + '-B.json');
  assert.equal(output.id, id); assert.equal(output.arm, 'READY'); assert.equal(output.valid_execution, true);
  assert.equal(output.completion, false); assert.equal(output.condition, 'oracle-assisted inventory-ready');
  assert.ok(reasons.has(output.result.reason)); assert.equal(output.utterance, gold.utterance);
  assert.equal(output.initial_head, original.initial_head); assert.equal(output.initial_log_sha256, original.initial_log_sha256);
  assert.deepEqual(output.initial_records, original.initial_records);
  const library = bundle.parts.map(p => input.slot_replacements.find(r => r.key === p.key) ?? p);
  assert.deepEqual(output.library, library); assert.equal(output.library.length, 8);
  assert.equal(output.result.inventory.checks, 1); assert.equal(output.result.inventory.completions, 0);
  assert.deepEqual(output.result.inventory.missing, []);
  assert.ok(output.calls.length >= 1 && output.calls.length <= 9);
  const es = events.filter(e => e.id === id && e.arm === 'READY');
  assert.equal(es.filter(e => e.kind === 'http-start').length, output.calls.length);
  assert.equal(es.filter(e => e.kind === 'http-end').length, output.calls.length);
  output.calls.forEach((call, i) => {
    assert.equal(call.n, i + 1); assert.equal(call.id, id); assert.equal(call.arm, 'READY');
    assert.equal(call.status, 200); assert.equal(call.error, undefined);
    assert.equal(call.route, i === 0 ? '/api/parts/check' : '/api/judge');
    const start = es.filter(e => e.kind === 'http-start' && e.n === call.n);
    const end = es.filter(e => e.kind === 'http-end' && e.n === call.n);
    assert.equal(start.length, 1); assert.equal(end.length, 1);
    assert.equal(start[0].route, call.route); assert.deepEqual(start[0].request, call.request);
    assert.equal(end[0].status, call.status); assert.deepEqual(end[0].response, call.response);
  });
  assert.deepEqual(output.calls[0].request.state.parts, library);
  assert.deepEqual(output.calls[0].response, output.result.inventory.coverage);
  assert.equal(output.result.requests, output.calls.length);
  total += output.calls.length;
  const initial = semantic(output.initial_records), final = semantic(output.final_records);
  const key = r => r.type === 'meta' ? 'meta' : r.type + ':' + r.id;
  const before = new Map(initial.map(r => [key(r), r])), after = new Map(final.map(r => [key(r), r]));
  assert.equal(before.size, initial.length); assert.equal(after.size, final.length);
  const preserved = initial.every(r => stable(r) === stable(after.get(key(r))));
  const added = final.filter(r => !before.has(key(r))), regions = added.filter(r => r.type === 'region'), edges = added.filter(r => r.type === 'relation');
  const oldIds = new Set(initial.filter(r => r.type === 'region').map(r => r.id)), newIds = new Map(regions.map(r => [r.id, r]));
  const ref = id => oldIds.has(id) ? 'fixture:' + id : newIds.has(id) && regions.filter(r => r.label === newIds.get(id).label).length === 1
    ? 'added:' + newIds.get(id).label : 'UNRESOLVED:' + id;
  const actualRegions = regions.map(r => ({ label: r.label, kind: r.kind, parent: ref(r.parent) }));
  const actualEdges = edges.map(r => ({ from: ref(r.from), to: ref(r.to), kind: r.kind, label: r.label }));
  const clean = added.length === regions.length + edges.length
    && regions.every(r => r.summary === '' && sameBag(Object.keys(r), ['type', 'id', 'parent', 'label', 'kind', 'summary']))
    && edges.every(r => sameBag(Object.keys(r), ['type', 'id', 'from', 'to', 'kind', 'label']));
  const coverage = output.result.inventory.coverage;
  return { id, arm: 'READY', coverage, accepted_sufficient: coverage.choice === 'sufficient' && coverage.confidence >= 0.5
      && (output.calls.length > 1 || ['no-executable-delta', 'candidate-overflow', 'budget-requests'].includes(output.result.reason)),
    graph_exact: preserved && clean && sameBag(actualRegions, gold.expected_added_regions) && sameBag(actualEdges, gold.expected_added_edges),
    existing_semantics_preserved: preserved, actual_added_regions: actualRegions, actual_added_edges: actualEdges,
    calls: output.calls.length, reason: output.result.reason };
});
assert.ok(total <= 18); assert.equal(total, execution.total_jev); assert.equal(execution.typellm, 0);
console.log(JSON.stringify({ schema: 'voice-ui.poc.independent-inventory-ready-score/1', reviewer: 'R /root/poc_reviewer',
  scope: 'Posthoc oracle-assisted inventory-ready diagnosis only; excluded from Type/main/fresh/generalization/full EFFECT scores.',
  source: identity.source, fixture_sha256: hash(fixtureBytes), driver_sha256: identity.driver_sha256,
  actual_calls: { jev: total, typellm: 0 }, execution_integrity: 'PASS_LOCAL_STRUCTURAL_AND_REQUEST_RESPONSE_CHECKS',
  accepted_sufficient: rows.filter(r => r.accepted_sufficient).length, exact_graphs: rows.filter(r => r.graph_exact).length,
  both_diagnostic_conditions_pass: rows.every(r => r.accepted_sufficient && r.graph_exact), rows }, null, 2));
