import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { UNKNOWN } from '../plan.mjs';
import { normalize } from '../adapter.mjs';
import { collect } from '../collect.mjs';

// Repo / Issue state facts (adrs#647 v8: facts only, no meaning targets, unknown ≠ empty).
// Fixtures are synthetic but keep the field names and types of the real gh api responses.
const dir = fileURLToPath(new URL('../fixtures/states/', import.meta.url));
const RECORDED = '2026-10-17T09:10:00Z';
const snapshot = name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const observe = value => collect(normalize(value), RECORDED);
const only = events => { assert.equal(events.length, 1); return events[0]; };

test('repo archived: true / false / fetch failed → "true" / "false" / UNKNOWN', () => {
  for (const [name, value] of [['repo-archived-true', 'true'], ['repo-archived-false', 'false'], ['repo-fetch-failed', UNKNOWN]]) {
    const event = only(observe(snapshot(name)));
    assert.deepEqual([event.kind, event.target, event.value], ['observation', 'windows:archived', value], name);
    assert.equal(event.observedAt, '2026-10-17T09:00:00Z');
    assert.equal(event.source.ref, 'gh api repos/roccho-dev/windows');
  }
  assert.equal(only(observe(snapshot('repo-fetch-failed'))).source.sha256, UNKNOWN);
});

test('repo archived: a non-boolean field is not read as a value', () => {
  for (const archived of ['true', 1, null, undefined]) {
    const s = snapshot('repo-archived-true');
    s.responses.repo.data.archived = archived;
    assert.equal(only(observe(s)).value, UNKNOWN, JSON.stringify(archived));
  }
});

test('issue state: open / closed completed / closed not_planned keep state and state_reason in one fact', () => {
  for (const [name, value] of [['issue-open', 'open'], ['issue-closed-completed', 'closed/completed'], ['issue-closed-not-planned', 'closed/not_planned']]) {
    const event = only(observe(snapshot(name)));
    assert.deepEqual([event.target, event.value], ['ops#479:issue.state', value], name);
    assert.equal(event.source.ref, 'gh api repos/roccho-dev/ops/issues/479');
  }
});

test('issue state: no false "completed" — missing reason, missing state, failed call', () => {
  const closed = snapshot('issue-closed-completed');
  closed.responses.issue.data.state_reason = null;
  assert.equal(only(observe(closed)).value, 'closed', 'closed without a reason is not closed/completed');
  const stateless = snapshot('issue-closed-completed');
  delete stateless.responses.issue.data.state;
  assert.equal(only(observe(stateless)).value, UNKNOWN, 'a reason without a state is not a state');
  const failed = { ...snapshot('issue-open'), responses: { issue: { command: 'x', sha256: null, data: null, error: 'HTTP 502' } } };
  assert.equal(only(observe(failed)).value, UNKNOWN);
});

test('facts only: no meaning target is ever emitted; time order still enforced', () => {
  const events = ['repo-archived-true', 'issue-closed-completed', 'repo-fetch-failed'].flatMap(name => observe(snapshot(name)));
  assert.deepEqual(events.map(e => e.target), ['windows:archived', 'ops#479:issue.state', 'windows:archived']);
  assert.ok(events.every(e => !/^(input|envs):/u.test(e.target)), 'input:semcmp-adopted / envs:scope-claimed are P\'s, not G\'s');
  assert.throws(() => collect(normalize(snapshot('issue-open')), '2026-10-17T08:59:59Z'), /observedAt .* is after recordedAt/u);
});
