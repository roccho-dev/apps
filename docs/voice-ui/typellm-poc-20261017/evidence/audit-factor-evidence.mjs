// Independent closed-factor recomputation, fixed before final-correction outputs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [stdoutPath, pairedDir, skipText = '0', outPath] = process.argv.slice(2);
assert.ok(stdoutPath && pairedDir && outPath, 'stdout path, paired directory, skip count, output path required');
const skip = Number(skipText);
assert.ok(Number.isInteger(skip) && skip >= 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => assert.deepEqual(a, b);
const keys = (value, names) => same(Object.keys(value).sort(), [...names].sort());
const bytes = fs.readFileSync(stdoutPath);
const factors = bytes.toString('utf8').split('\n').flatMap(line => {
  let value;
  try { value = JSON.parse(line); } catch { return []; }
  return value?.kind === 'voice-ui.parts.factors.v1' ? [value] : [];
});
const choices = { intent: ['change', 'ambiguous', 'no-change', 'unsupported'],
  labels: ['available', 'missing'], capacity: ['within', 'exceeded'] };
for (const entry of factors) {
  keys(entry, ['kind', 'head', 'factors']);
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(entry.head), 'actual evidence requires a canonical head');
  keys(entry.factors, Object.keys(choices));
  for (const [name, allowed] of Object.entries(choices)) {
    const answer = entry.factors[name];
    keys(answer, ['choice', 'confidence']);
    assert.ok(allowed.includes(answer.choice));
    assert.ok(typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
      && answer.confidence >= 0 && answer.confidence <= 1);
  }
}
const execution = JSON.parse(fs.readFileSync(path.join(pairedDir, 'execution.json')));
assert.equal(execution.status, 'RECORDED');
assert.equal(factors.length, skip + execution.summary.length, 'no missing or unaccounted factor records');
const rows = execution.summary.map(({ id, arm }, index) => {
  const output = JSON.parse(fs.readFileSync(path.join(pairedDir, `${id}-${arm}.json`)));
  const checks = output.calls.filter(call => call.route === '/api/parts/check');
  assert.equal(checks.length, 1);
  const entry = factors[skip + index];
  assert.equal(entry.head, checks[0].request.state.head);
  const { intent, labels, capacity } = entry.factors;
  const positives = [];
  if (labels.choice === 'missing') positives.push(labels.confidence);
  if (capacity.choice === 'exceeded') positives.push(capacity.confidence);
  const computed = intent.choice !== 'change' ? { choice: intent.choice, confidence: intent.confidence }
    : positives.length ? { choice: 'missing', confidence: Math.min(intent.confidence, Math.max(...positives)) }
      : { choice: 'sufficient', confidence: Math.min(intent.confidence, labels.confidence, capacity.confidence) };
  same(checks[0].response, computed);
  same(output.result.inventory.coverage, computed);
  return { id, arm, head: entry.head, factors: entry.factors, recomputed: computed };
});
const result = { schema: 'voice-ui.poc.independent-factors/1', reviewer: 'R /root/poc_reviewer',
  observed_at: new Date().toISOString(), source_stdout_sha256: hash(bytes), total_factor_records: factors.length,
  preceding_ui_records: skip, paired_records: rows.length, all_recomputed_responses_match: true, rows };
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ paired_records: rows.length, preceding_ui_records: skip,
  all_recomputed_responses_match: true, evidence_sha256: hash(fs.readFileSync(outPath)) }));
