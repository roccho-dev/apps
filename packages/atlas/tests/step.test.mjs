import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 🔁 step (adrs#647 v3 c6329883005; PR 1 c6329938666; R's conditions c6329948739, made required by P c6329960185).
// v4 (c6335921034): no G/current; the work log is read only in the adrs#654 form (worklog-v1 sections of comments).
const file = relative => fileURLToPath(new URL(relative, import.meta.url));
const fixture = relative => file('./fixtures/step/' + relative);
const AT = '2026-10-21T03:00:00Z';
const loaded = await import('../step.mjs').catch(error => ({ error }));
const run = await import('../run.mjs').catch(error => ({ error }));
const need = module => assert.ok(!module.error, String(module.error?.message ?? ''));

// The step's reading, from the fixture alone (no gh, no network).
const snapshots = readdirSync(fixture('snapshots')).map(name => ({ name, snapshot: JSON.parse(readFileSync(fixture('snapshots/' + name), 'utf8')) }));
// The owner input source (C5 stage 1, v4): the comments of the repo the control's authority names.
const ownerComments = JSON.parse(readFileSync(fixture('owner.comments.json'), 'utf8'));
const fakeRead = Object.freeze({ snapshots: async () => snapshots.map(value => structuredClone(value)),
  owner: async repo => (repo === 'roccho-dev/atlas-owner' ? structuredClone(ownerComments) : null) });
// The CLI chain reads no owner source; compared with it, the step reads an empty one.
const noOwner = Object.freeze({ ...fakeRead, owner: async () => [] });
const sources = { worklogAuthors: ['P'] };
const controlText = readFileSync(fixture('control.jsonl'), 'utf8');
const input = (extra = {}) => ({ sources, at: AT, ledgerText: '', controlText, ...extra });

// The current chain (fetch → collect → ledger → live → derive), on the same snapshots, with both its times at `at`.
const workspace = () => mkdtempSync(file('./step-out-'));
const node = (script, args) => execFileSync(process.execPath, [file(script), ...args], { encoding: 'utf8' });
const chain = (dir, at, ledger = path.join(dir, 'ledger.jsonl')) => {
  node('../collect/collect.mjs', [fixture('snapshots'), '--recorded-at', at, '--worklog-author', 'P', '--out', path.join(dir, 'g.jsonl')]);
  node('../ledger.mjs', ['--ledger=' + ledger, '--ledger-at=' + at, '--held=' + path.join(dir, 'held.jsonl'), path.join(dir, 'g.jsonl')]);
  node('../live.mjs', ['--out-dir=' + path.join(dir, 'live'), '--ledger=' + ledger, '--control=' + fixture('control.jsonl')]);
  return { ledgerText: readFileSync(ledger, 'utf8'), world: JSON.parse(readFileSync(path.join(dir, 'live/world.json'), 'utf8')) };
};
const within = async body => { const dir = workspace(); try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

// (b) The whole import graph from step.mjs: static and side-effect imports, re-exports, dynamic import() and
// require(). Of node's built-ins only node:crypto (sha256) and node:url (a "was I run directly" check in
// semantic-scope-world.mjs, no I/O) are allowed; a dynamic import or require whose argument is not a literal
// cannot be checked and fails too.
const ALLOWED = new Set(['node:crypto', 'node:url']);
const builtin = specifier => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]);
const specifiers = source => {
  const found = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/gmu)) found.push(match[2]);
  for (const match of source.matchAll(/^\s*import\s*(['"])([^'"]+)\1/gmu)) found.push(match[2]);
  for (const match of source.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/gu)) {
    const literal = /^(['"])([^'"]+)\1$/u.exec(match[2].trim());
    found.push(literal ? literal[2] : `<non-literal ${match[1]}(${match[2].trim()})>`);
  }
  if (/\bcreateRequire\b/u.test(source)) found.push('<createRequire>');
  return found;
};
const graph = entry => {
  const seen = new Set(), offending = [];
  const walk = at => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const specifier of specifiers(readFileSync(at, 'utf8'))) {
      if (specifier.startsWith('<')) offending.push(`${path.basename(at)}: ${specifier}`);
      else if (builtin(specifier)) { if (!ALLOWED.has(specifier.startsWith('node:') ? specifier : 'node:' + specifier)) offending.push(`${path.basename(at)}: ${specifier}`); }
      else if (specifier.startsWith('.')) walk(path.resolve(path.dirname(at), specifier));
      else offending.push(`${path.basename(at)}: package ${specifier}`);
    }
  };
  walk(entry);
  return { files: [...seen].map(at => path.relative(file('..'), at)), offending };
};

test('(b) the scanner itself catches static, dynamic and require loads of node built-ins', () => {
  const caught = text => specifiers(text).filter(specifier => specifier.startsWith('<') || (builtin(specifier) && !ALLOWED.has(specifier)));
  assert.deepEqual(caught("import fs from 'node:fs';"), ['node:fs']);
  assert.deepEqual(caught("const fs = await import('node:fs');"), ['node:fs']);
  assert.deepEqual(caught("const cp = require('child_process');"), ['child_process']);
  assert.deepEqual(caught("export * from 'node:net';"), ['node:net']);
  assert.deepEqual(caught("import 'node:path';"), ['node:path']);
  assert.deepEqual(caught('const m = await import(name);'), ['<non-literal import(name)>']);
  assert.deepEqual(caught("import { createRequire } from 'node:module'; const r = createRequire(import.meta.url);"), ['node:module', '<createRequire>']);
  assert.deepEqual(caught("import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';"), []);
});

test('(b) nothing step.mjs loads, followed through every import, reads files, processes or the network', () => {
  const { files, offending } = graph(file('../step.mjs'));
  assert.deepEqual(offending, []);
  for (const cli of ['collect/collect.mjs', 'collect/fetch.mjs', 'ledger.mjs', 'live.mjs', 'derive.mjs', 'run.mjs']) assert.ok(!files.includes(cli), cli + ' is not loaded by step');
  assert.ok(files.includes('ledger-core.mjs') && files.includes('live-core.mjs') && files.includes('collect/collect-core.mjs'), files.join(' '));
});

test('step runs on a fake reading and the same input gives the same ledger and World', async () => {
  need(loaded);
  const [a, b] = [await loaded.step(input(), fakeRead), await loaded.step(input(), fakeRead)];
  assert.equal(a.ledgerText, b.ledgerText);
  assert.deepEqual(a.world, b.world);
  assert.ok(a.appended.length > 0 && a.world.frames.length > 0);
  assert.deepEqual(Object.keys(a).sort(), ['appended', 'held', 'ledgerText', 'world'], 'the ledger, its held rows and the World only');
});

test('equal to the current chain: the same ledger rows and the same world.json (both times at `at`)', async () => {
  need(loaded);
  const result = await loaded.step(input(), noOwner);
  await within(dir => {
    const old = chain(dir, AT);
    assert.equal(result.ledgerText, old.ledgerText);
    assert.deepEqual(result.world, old.world);
  });
});

test('the fixture holds what the condition asks: atlas-eval accepted and held, cold, an unread thread, an unbound plan', async () => {
  need(loaded);
  const { ledgerText, world, held } = await loaded.step(input(), fakeRead);
  assert.ok(held.some(value => /^held-by-G: cold: /u.test(value.reason)), 'cold: a refused row is held with its reason');
  const events = ledgerText.trim().split('\n').slice(1).map(line => JSON.parse(line).event);
  const journal = world.frames.flatMap(frame => frame.journal ?? []);
  assert.deepEqual(journal.filter(entry => entry.kind === 'purpose.evaluated').map(entry => [entry.actor, entry.verdict, entry.source.ref, entry.source.admission]),
    [['roccho-dev', 'achieved', 'roccho-dev/atlas-owner#1', 'owner-unverified']], 'only the owner source\'s, shown as unverified');
  const heldReasons = world.frames.flatMap(frame => frame.held ?? []).map(entry => entry.reason);
  assert.deepEqual(heldReasons.filter(reason => reason === 'evaluation-not-from-owner').length, 2, 'both #647 evaluations are held, whoever wrote them');
  assert.ok(heldReasons.includes('owner-via-app'), 'an App\'s comment in the owner source is held');
  assert.ok(events.some(event => event.source?.capture), 'cold: a decision confirmed by a Git Cold row carries its capture');
  assert.ok(events.some(event => event.kind === 'observation' && event.target === 'roccho-dev/adrs#999:plan.source' && event.value === 'UNKNOWN'), 'an unread thread is UNKNOWN as G writes it (D reads it as no value)');
  assert.ok(journal.some(entry => entry.kind === 'plan.set' && entry.unbound === true), 'a plan no ideal state declares');
});

test('a past-dated decision keeps declaredAt: the evaluation at its comment\'s updated_at', async () => {
  need(loaded);
  const { ledgerEvents } = await import('../ledger-core.mjs');
  const { ledgerText } = await loaded.step(input(), fakeRead);
  const evaluated = ledgerEvents(ledgerText).trim().split('\n').map(line => JSON.parse(line)).find(event => event.kind === 'purpose.evaluated');
  assert.deepEqual([evaluated.recordedAt, evaluated.declaredAt], [AT, '2026-10-21T02:00:00Z']);
});

test('(a) continuity: on the ledger the current chain made, step with the same input appends nothing', async () => {
  need(loaded);
  await within(async dir => {
    const old = chain(dir, AT);
    const later = await loaded.step(input({ ledgerText: old.ledgerText, at: '2026-10-21T03:01:00Z' }), fakeRead);
    assert.deepEqual(later.appended, [], 'no row from reading the same facts again');
    assert.equal(later.ledgerText, old.ledgerText);
  });
});

test('the ledger only grows: the returned text starts with the given one', async () => {
  need(loaded);
  const first = await loaded.step(input(), fakeRead);
  // A port that stopped responding is a change: it is appended after the rows already there.
  const changed = snapshots.map(value => structuredClone(value));
  const ports = changed.find(value => value.name === 'ports.json').snapshot;
  ports.probes[0] = { ...ports.probes[0], observedAt: '2026-10-21T03:04:00Z', responded: false };
  const next = await loaded.step(input({ ledgerText: first.ledgerText, at: '2026-10-21T03:05:00Z' }), { snapshots: async () => changed });
  assert.ok(next.ledgerText.startsWith(first.ledgerText), 'the old rows stay as they were');
  assert.deepEqual(next.appended.map(row => row.event.target), [`${ports.probes[0].target}:port`]);
});

test('run.mjs writes the ledger (append only), the held rows and world.json under the given paths, and nothing else', async () => {
  need(run);
  await within(async dir => {
    const at = name => path.join(dir, name);
    writeFileSync(at('ledger.jsonl'), '');
    const receipt = await run.run({ sources, ledger: at('ledger.jsonl'), world: at('world.json'), held: at('held.jsonl'), control: fixture('control.jsonl'), at: AT }, fakeRead);
    assert.equal(receipt.status, 'PASS');
    assert.deepEqual(readdirSync(dir).sort(), ['held.jsonl', 'ledger.jsonl', 'world.json']);
    const first = readFileSync(at('ledger.jsonl'), 'utf8');
    const again = await run.run({ sources, ledger: at('ledger.jsonl'), world: at('world.json'), held: at('held.jsonl'), control: fixture('control.jsonl'), at: '2026-10-21T03:01:00Z' }, fakeRead);
    assert.equal(again.appended, 0);
    assert.equal(readFileSync(at('ledger.jsonl'), 'utf8'), first);
    assert.deepEqual(JSON.parse(readFileSync(at('world.json'), 'utf8')), (await loaded.step(input({ ledgerText: first, at: '2026-10-21T03:01:00Z' }), fakeRead)).world);
  });
});

test('v4: step reads no current files (G/current removed, #13); a reading that offers them is never asked', async () => {
  need(loaded);
  let asked = 0;
  const offering = { ...fakeRead, current: async () => { asked += 1; return [{ author: 'P', text: '{"kind":"work.created","work_id":"x"}\n' }]; } };
  const result = await loaded.step(input({ sources: { ...sources, current: [{ author: 'P', path: 'unused' }] } }), offering);
  assert.equal(asked, 0);
  assert.ok(!result.ledgerText.includes('current:'), 'no current: source in the ledger');
});

test('C5 stage 1: the owner source\'s evaluation is read again at every step, never put in the ledger; unreadable = none (never the last achieved)', async () => {
  need(loaded);
  const evaluated = world => world.frames.flatMap(frame => frame.journal ?? []).filter(entry => entry.kind === 'purpose.evaluated');
  const first = await loaded.step(input(), fakeRead);
  assert.equal(evaluated(first.world).length, 1);
  assert.ok(!first.ledgerText.includes('roccho-dev/atlas-owner'), 'the owner source is not in the ledger');
  const later = await loaded.step(input({ ledgerText: first.ledgerText, at: '2026-10-21T03:01:00Z' }), { ...fakeRead, owner: async () => null });
  assert.deepEqual([evaluated(later.world).length, later.appended.length], [0, 0]);
  assert.ok(later.world.frames.every(frame => frame.adequacy?.evidence == null), 'no frame keeps the earlier achieved as evidence');
  const without = await loaded.step(input(), { snapshots: fakeRead.snapshots });
  assert.equal(evaluated(without.world).length, 0, 'a runtime with no owner reading counts no evaluation');
});

test('v4: run.mjs has no --current option', () => {
  assert.throws(() => execFileSync(process.execPath, [file('../run.mjs'), '--current=P=x.jsonl'], { encoding: 'utf8', stdio: 'pipe' }),
    error => /Unknown option '--current'/u.test(String(error.stderr)));
});
