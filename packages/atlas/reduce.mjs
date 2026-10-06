// File I/O only. The reducer has no filesystem, network, clock or UI dependency.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { reduceClosure } from './closure.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let temporary;
try {
  const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
  if (!values.out || positionals.length === 0) throw new Error('usage: node reduce.mjs --out=<atlas.reduced.jsonl> <purpose.jsonl> <current.jsonl> [...]');
  const inputPaths = await Promise.all(positionals.map(file => fs.realpath(file)));
  const bytes = await Promise.all(inputPaths.map(file => fs.readFile(file)));
  const output = Buffer.from(reduceClosure(...bytes.map(value => new TextDecoder('utf-8', { fatal: true }).decode(value))));
  const requested = path.resolve(values.out);
  await fs.mkdir(path.dirname(requested), { recursive: true });
  const target = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  if (inputPaths.includes(target)) throw new Error('output must not replace an input');
  const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !existing.isFile()) throw new Error('output must be a regular file, not a symlink/directory');
  temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, output, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, target);
  temporary = undefined;
  console.log(JSON.stringify({
    schema: 'atlas.purpose-closure-build/1', status: 'PASS', authority: false,
    inputs: inputPaths.map((file, index) => ({ path: file, sha256: digest(bytes[index]) })),
    output: { path: target, bytes: output.length, sha256: digest(output) },
  }));
} catch (error) {
  if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  console.error(`atlas-reduce: ${error.message}`);
  process.exitCode = 1;
}
