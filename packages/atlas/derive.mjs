// File I/O only. The derivation (events.mjs) has no filesystem, network, clock or UI dependency.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deriveAtlas } from './events.mjs';
import { contractWorld } from './contract.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const temporaries = [];
try {
  const { values, positionals } = parseArgs({ options: { 'out-dir': { type: 'string' } }, allowPositionals: true });
  if (!values['out-dir'] || positionals.length !== 2) throw new Error('usage: node derive.mjs --out-dir=<dir> <events.jsonl> <control.jsonl>');
  const inputPaths = await Promise.all(positionals.map(file => fs.realpath(file)));
  const bytes = await Promise.all(inputPaths.map(file => fs.readFile(file)));
  const [events, control] = bytes.map(value => new TextDecoder('utf-8', { fatal: true }).decode(value));
  const result = deriveAtlas(events, control);
  const json = value => JSON.stringify(value, null, 2) + '\n';
  const outputs = [['closure.jsonl', result.closure], ['semantic-scope-world.json', json(result.input)],
    ['plan-projection.json', json(result.plans)], ['world.json', json(contractWorld(result))]].map(([name, text]) => [name, Buffer.from(text)]);
  await fs.mkdir(values['out-dir'], { recursive: true });
  const directory = await fs.realpath(values['out-dir']);
  // Every output is validated before any file is replaced; each replacement is atomic.
  for (const [name] of outputs) {
    const target = path.join(directory, name);
    if (inputPaths.includes(target)) throw new Error('output must not replace an input');
    const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && !existing.isFile()) throw new Error(`${name}: output must be a regular file, not a symlink/directory`);
  }
  for (const [name, output] of outputs) {
    const target = path.join(directory, name), temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    temporaries.push(temporary);
    await fs.writeFile(temporary, output, { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, target);
    temporaries.pop();
  }
  console.log(JSON.stringify({
    schema: 'atlas.events-derive-build/1', status: 'PASS', authority: false, now: result.derived.now, frames: result.world.frames.length,
    inputs: inputPaths.map((file, index) => ({ path: file, sha256: digest(bytes[index]) })),
    outputs: outputs.map(([name, output]) => ({ path: path.join(directory, name), bytes: output.length, sha256: digest(output) })),
  }));
} catch (error) {
  for (const temporary of temporaries) await fs.rm(temporary, { force: true }).catch(() => {});
  console.error(`atlas-derive: ${error.message}`);
  process.exitCode = 1;
}
