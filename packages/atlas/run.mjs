#!/usr/bin/env node
// The node runtime of 🔁 step (adrs#647 v3 c6329883005): one command for what fetch → collect → ledger → live →
// derive did in turn. It gives step the reading (fetch.mjs's gh / ssh / TCP / git reads) and
// writes what step returns: the ledger by appending only, the held rows by appending, the World by an atomic
// replace. When to run and where the files live are the caller's. No current files (v4 c6335921034).
//   node packages/atlas/run.mjs --sources=<collect.json> --ledger=<ledger.jsonl> --world=<world.json>
//     [--held=<held.jsonl>] [--control=<control.jsonl>] [--purpose=<D-form purpose.jsonl>] [--at=<ISO>]
//     [--worklog-author=<login>]... [--p-records=<P's p-records.jsonl>] [--p-series=<P's p-series.json>]
// --p-series (adrs#647 W c6349826755): P's series list, read whole each run, as --p-records is (absent: not read; a
// missing file: nothing declared yet).
// --records-only (adrs#647 W c6352434256, R c6352457408): the run hq-refresh starts when P's files change. It reads
// no snapshot (no gh, nothing replayed as if read now): only P's files and the owner source, as every run does.
// --p-records (adrs#647 c6346827237): P's records file, read whole each run; absent option = not read (no change to
// the World); a named file that does not exist is read as empty (nothing P wrote yet).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchOwnerComments, fetchSnapshots } from './collect/fetch.mjs';
import { parseAuthority } from './events.mjs';
import { step } from './step.mjs';

const fail = message => { throw new Error('atlas-run: ' + message); };
const read = file => fs.readFileSync(file, 'utf8');

/**
 * The node reading: snapshots through fetch.mjs, and the owner input source (C5 stage 1) with the read-only token
 * in ATLAS_OWNER_TOKEN alone (the runtime's environment, from envs; absent = unreadable, no evaluation counts).
 */
export const nodeRead = Object.freeze({
  snapshots: sources => fetchSnapshots(sources),
  owner: repo => fetchOwnerComments(repo, process.env.ATLAS_OWNER_TOKEN),
});

/**
 * One run on the node runtime: read, step, write. Returns the receipt. Without `at`, everything is read first and
 * the time is taken after the reading: a real reading stamps each fact with when it was read, and a fact may not be
 * later than the time it is recorded at (R's dry-run on the HQ data, adrs#647 c6339405812). step stays pure: it is
 * given what was read.
 */
export const run = async ({ sources, ledger, world, held = null, control = null, purpose = null, at = null, pRecords = null, pSeries = null,
  recordsOnly = false }, reading = nodeRead) => {
  const before = fs.existsSync(ledger) ? read(ledger) : '';
  const controlText = control ? read(control) : undefined;
  const pRecordsText = pRecords === null ? null : fs.existsSync(pRecords) ? read(pRecords) : '';
  const pSeriesText = pSeries === null ? null : fs.existsSync(pSeries) ? read(pSeries) : '';
  const snapshots = recordsOnly ? [] : await reading.snapshots(sources);
  const owners = new Map();
  for (const value of controlText ? parseAuthority(controlText).values() : []) {
    if (value.owner && !owners.has(value.owner.repo)) owners.set(value.owner.repo, reading.owner ? await reading.owner(value.owner.repo) : null);
  }
  at ??= new Date().toISOString();
  const given = { snapshots: async () => snapshots, owner: async repo => owners.get(repo) ?? null };
  const result = await step({ sources, at, ledgerText: before, ...(controlText ? { controlText } : {}), ...(purpose ? { purposeText: read(purpose) } : {}), pRecordsText, pSeriesText, readSources: !recordsOnly }, given);
  // Append only: the new ledger starts with the old bytes (step checks it; a fresh ledger gets its header).
  if (!result.ledgerText.startsWith(before)) fail('the ledger would be rewritten');
  const addition = result.ledgerText.slice(before.length);
  if (addition) fs.appendFileSync(ledger, addition);
  if (held && result.held.length) fs.appendFileSync(held, result.held.map(value => JSON.stringify({ ...value, at }) + '\n').join(''));
  // The World replaces the previous one atomically (as derive.mjs does).
  const temporary = path.join(path.dirname(path.resolve(world)), `.${path.basename(world)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(result.world, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    fs.renameSync(temporary, world);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { schema: 'atlas.run/1', status: 'PASS', authority: false, at, appended: result.appended.length, held: result.held.length,
    frames: result.world.frames.length, ledger: path.resolve(ledger), world: path.resolve(world) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { sources: { type: 'string' }, ledger: { type: 'string' }, world: { type: 'string' }, held: { type: 'string' },
      control: { type: 'string' }, purpose: { type: 'string' }, at: { type: 'string' },
      'worklog-author': { type: 'string', multiple: true }, 'p-records': { type: 'string' }, 'p-series': { type: 'string' }, 'records-only': { type: 'boolean' } } });
    if (!values.sources || !values.ledger || !values.world) fail('usage: node run.mjs --sources=<collect.json> --ledger=<ledger.jsonl> --world=<world.json> [--held=…] [--control=…] [--purpose=…] [--at=ISO] [--worklog-author=<login>]...');
    const sources = { ...JSON.parse(read(values.sources)), worklogAuthors: (values['worklog-author'] ?? []).filter(Boolean) };
    console.log(JSON.stringify(await run({ sources, ledger: values.ledger, world: values.world, held: values.held ?? null, control: values.control ?? null,
      purpose: values.purpose ?? null, pRecords: values['p-records'] ?? null, pSeries: values['p-series'] ?? null, recordsOnly: values['records-only'] === true, ...(values.at ? { at: values.at } : {}) })));
  } catch (error) {
    console.error(error.message.startsWith('atlas-') ? error.message : 'atlas-run: ' + error.message);
    process.exitCode = 1;
  }
}
