import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalize } from '../collect/adapter.mjs';
import { collect, toJsonl } from '../collect/collect.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

// WL2 (atlas-worklog-v1, R's minimal form, P's decision): one ```jsonl line per comment inside
// `<!-- worklog-v1 -->`, kinds work.created / artifact.observed / work.terminal, no note / at / work_generation.
// Time and author come from the captured document; authors are allowed by a list passed in (fail closed).
// Synthetic minimal inputs: thread records as the adapter gives them (live gh or Git Cold alike).
const RECORDED = '2026-10-18T06:00:00Z', REF = 'roccho-dev/apps#120', SHA = '0123456789abcdef0123456789abcdef01234567';
const ALLOWED = { worklogAuthors: ['roccho'] };
let nextId = 7001;
const doc = (lines, { author = 'roccho', at = '2026-10-18T02:00:00Z', blocks = [lines] } = {}) => ({ commentId: nextId++, updatedAt: at, author,
  text: '作業ログ\n<!-- worklog-v1 -->\n' + blocks.map(list => '```jsonl\n' + list.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n') + '\n```\n').join('') });
const thread = documents => ({ kind: 'thread', repo: 'roccho-dev/apps', number: 120, fetchedAt: '2026-10-18T05:00:00Z', documents });
const run = (documents, options = ALLOWED) => collect([thread(documents)], RECORDED, options);
const work = events => events.filter(event => event.kind === 'observation' && event.target.startsWith('work:'));
const held = events => events.filter(event => event.kind === 'journal.held').map(event => event.reason);

test('one line per comment maps to work:<id>: created, progressed, reported-done / -blocked / -stopped', () => {
  const events = run([
    doc([{ kind: 'work.created', work_id: 'wl2' }], { at: '2026-10-18T01:00:00Z' }),
    doc([{ kind: 'artifact.observed', work_id: 'wl2', evidence: 'roccho-dev/apps#119' }], { at: '2026-10-18T02:00:00Z' }),
    doc([{ kind: 'artifact.observed', work_id: 'wl2', evidence: SHA }], { at: '2026-10-18T03:00:00Z' }),
    doc([{ kind: 'work.terminal', work_id: 'wl2', terminal: 'done' }], { at: '2026-10-18T04:00:00Z' }),
    doc([{ kind: 'work.terminal', work_id: 'b', terminal: 'blocked' }]),
    doc([{ kind: 'work.terminal', work_id: 's', terminal: 'stopped' }]),
  ]);
  // The time is the captured document's, never a time the writer typed.
  assert.deepEqual(work(events).map(event => [event.target, event.value, event.observedAt]), [
    ['work:wl2', 'created', '2026-10-18T01:00:00Z'], ['work:wl2', 'progressed', '2026-10-18T02:00:00Z'],
    ['work:wl2', 'progressed', '2026-10-18T03:00:00Z'], ['work:wl2', 'reported-done', '2026-10-18T04:00:00Z'],
    ['work:b', 'reported-blocked', '2026-10-18T02:00:00Z'], ['work:s', 'reported-stopped', '2026-10-18T02:00:00Z']]);
  // The evidence is not mixed into source.ref: the source is the comment's thread and text digest only.
  assert.ok(work(events).every(event => event.source.ref === REF && /^sha256:[0-9a-f]{64}$/u.test(event.source.sha256)));
  assert.ok(!JSON.stringify(events).includes('evidence='));
  assert.deepEqual(held(events), []);
  // A worklog section is neither a plan nor a journal decision.
  assert.ok(!events.some(event => event.kind === 'plan.set'));
});

test('R path 1: the author is checked against the list passed in; no list holds everything (fail closed)', () => {
  const line = [{ kind: 'work.created', work_id: 'wl2' }];
  assert.deepEqual(held(run([doc(line, { author: 'mallory' }), doc(line)])), ['worklog: author-not-allowed']);
  for (const options of [[], [{}], [{ worklogAuthors: [] }]]) {
    const events = collect([thread([doc(line), doc(line, { author: 'mallory' })])], RECORDED, ...options);
    assert.deepEqual([work(events).length, held(events)], [0, ['worklog: author-list-missing', 'worklog: author-list-missing']]);
  }
});

test('R path 2: evidence is only owner/repo#n or a 40-hex commit sha; prose or other refs are held', () => {
  const bad = ['テストが通った', 'roccho-dev/apps@abc1234', 'abc1234', SHA.toUpperCase(), 'roccho-dev/apps#0', 'apps#119', `${SHA}0`, ['roccho-dev/apps#119']];
  const events = run(bad.map(evidence => doc([{ kind: 'artifact.observed', work_id: 'wl2', evidence }])));
  assert.deepEqual([work(events).length, held(events)], [0, bad.map(() => 'worklog: evidence-form')]);
});

test('R path 3: two or more lines in one comment are all held, in one block or across blocks', () => {
  const a = { kind: 'work.created', work_id: 'wl2' }, b = { kind: 'work.terminal', work_id: 'wl2', terminal: 'done' };
  const events = run([doc([a, b]), doc([], { blocks: [[a], [b]] })]);
  assert.deepEqual([work(events).length, held(events)], [0, Array(4).fill('worklog: multiple-lines')]);
});

test('lines outside the minimal form are held with the reason', () => {
  const cases = [
    [{ kind: 'work.created', work_id: 'wl2', note: '始めた' }, 'fields'],
    [{ kind: 'work.created', work_id: 'wl2', at: '2026-10-18T01:00:00Z' }, 'fields'],
    [{ kind: 'work.created', work_id: 'wl2', work_generation: 2 }, 'fields'],
    [{ kind: 'artifact.observed', work_id: 'wl2' }, 'fields'],
    [{ kind: 'work.terminal', work_id: 'wl2' }, 'fields'],
    [{ work_id: 'c1', event: 'started', at: '2026-10-18T02:00:00Z' }, 'kind'],
    [{ kind: 'work.started', work_id: 'wl2' }, 'kind'],
    [{ kind: 'work.terminal', work_id: 'wl2', terminal: 'finished' }, 'terminal'],
    [{ kind: 'work.created', work_id: 'a b' }, 'work-id'],
    [{ kind: 'work.created', work_id: 7 }, 'work-id'],
    ['{"kind":"work.created",', 'invalid-json'],
    ['["work.created"]', 'kind'],
  ];
  const events = run(cases.map(([line]) => doc([line])));
  assert.deepEqual([work(events).length, held(events)], [0, cases.map(([, reason]) => 'worklog: ' + reason)]);
  // A held line keeps the comment it came from.
  const first = events.find(event => event.kind === 'journal.held');
  assert.deepEqual([first.source.ref, typeof first.source.commentId, first.line], [REF, 'number', JSON.stringify(cases[0][0])]);
});

test('through the unchanged reducer: reports are facts in the journal, never an achievement or a closed difference', () => {
  const text = readFileSync(fileURLToPath(new URL('../collect/fixtures/cold/decisions.jsonl', import.meta.url)), 'utf8');
  const purpose = normalize({ type: 'cold', repo: 'roccho-dev/adrs', commit: '94a51c3a', path: 'decisions/synthetic.jsonl', committedAt: RECORDED, fetchedAt: RECORDED, sha256: null, text });
  const events = collect([...purpose, thread([doc([{ kind: 'work.created', work_id: 'wl2' }]), doc([{ kind: 'work.terminal', work_id: 'wl2', terminal: 'done' }], { at: '2026-10-18T03:00:00Z' })])], RECORDED, ALLOWED);
  // v4 (adrs#647 c6335921034): the Purpose is P's declaration (the same purpose.set / ideal.set as the cold rows).
  const declared = events.filter(event => ['purpose.set', 'ideal.set'].includes(event.kind))
    .map(({ source, ...event }) => JSON.stringify({ ...event, source: { ref: 'hq:decl/purpose.jsonl', digest: source.sha256 } })).join('\n') + '\n';
  const world = contractWorld(deriveAtlas(joinLog(declared, [toJsonl(events)]).log, '{"schema":"atlas.control-norms/1","authority":false}\n'));
  const frame = world.frames.at(-1);
  assert.deepEqual(frame.journal.filter(entry => entry.kind === 'observation' && entry.target.id === 'work:wl2').map(entry => entry.value), ['created', 'reported-done']);
  // No declared condition watches work:wl2, so nothing is satisfied or closed because the work "is done".
  assert.deepEqual([frame.gap.summary.satisfied, frame.gap.closed], [0, []]);
  assert.ok(!JSON.stringify(frame.gap).includes('work:wl2'));
});
