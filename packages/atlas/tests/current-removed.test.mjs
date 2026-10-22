import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// v4 (adrs#647 c6335921034, #13): G/current is removed. The work log is read only in the adrs#654 form
// (worklog-v1 sections of comments, collect/worklog.mjs worklogEvents); the step never read current files
// (apps#139), and once the HQ runs through run.mjs the CLI's --current goes too (PR 5).
const file = relative => fileURLToPath(new URL(relative, import.meta.url));

test('collect.mjs refuses --current: the option is gone, not ignored', () => {
  const run = spawnSync(process.execPath, [file('../collect/collect.mjs'), file('./fixtures/step/snapshots'), '--current', 'P=x.jsonl'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--current is removed/u);
});

test('worklog.mjs reads only worklog-v1 sections: no currentEvents', async () => {
  const worklog = await import('../collect/worklog.mjs');
  assert.deepEqual(Object.keys(worklog).sort(), ['WORKLOG_SLUG', 'worklogEvents']);
});
