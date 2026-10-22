#!/usr/bin/env node
// The node runtime of 🔁 step (adrs#647 v3 c6329883005): one command for what fetch → collect → ledger → live →
// derive did in turn. It gives step the reading (fetch.mjs's gh / ssh / TCP / git reads) and
// writes what step returns: the ledger by appending only, the held rows by appending, the World by an atomic
// replace. When to run and where the files live are the caller's. No current files (v4 c6335921034).
//   node packages/atlas/run.mjs --sources=<collect.json> --ledger=<ledger.jsonl> --world=<world.json>
//     [--held=<held.jsonl>] [--control=<control.jsonl>] [--purpose=<D-form purpose.jsonl>] [--at=<ISO>]
//     [--worklog-author=<login>]...
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchSnapshots } from './collect/fetch.mjs';
import { step } from './step.mjs';

const fail = message => { throw new Error('atlas-run: ' + message); };
const read = file => fs.readFileSync(file, 'utf8');

/** The node reading: snapshots through fetch.mjs. */
export const nodeRead = Object.freeze({ snapshots: sources => fetchSnapshots(sources) });

/** One run on the node runtime: read, step, write. Returns the receipt. */
export const run = async ({ sources, ledger, world, held = null, control = null, purpose = null, at = new Date().toISOString() }, reading = nodeRead) => {
  const before = fs.existsSync(ledger) ? read(ledger) : '';
  const result = await step({ sources, at, ledgerText: before, ...(control ? { controlText: read(control) } : {}), ...(purpose ? { purposeText: read(purpose) } : {}) }, reading);
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
      'worklog-author': { type: 'string', multiple: true } } });
    if (!values.sources || !values.ledger || !values.world) fail('usage: node run.mjs --sources=<collect.json> --ledger=<ledger.jsonl> --world=<world.json> [--held=…] [--control=…] [--purpose=…] [--at=ISO] [--worklog-author=<login>]...');
    const sources = { ...JSON.parse(read(values.sources)), worklogAuthors: (values['worklog-author'] ?? []).filter(Boolean) };
    console.log(JSON.stringify(await run({ sources, ledger: values.ledger, world: values.world, held: values.held ?? null, control: values.control ?? null,
      purpose: values.purpose ?? null, ...(values.at ? { at: values.at } : {}) })));
  } catch (error) {
    console.error(error.message.startsWith('atlas-') ? error.message : 'atlas-run: ' + error.message);
    process.exitCode = 1;
  }
}
