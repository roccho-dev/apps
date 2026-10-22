// The CLI of semantic-scope-world-core.mjs (adrs#647 v3 c6329883005: the core loads no file system).
import { pathToFileURL } from 'node:url';
import { semanticScopeWorld } from './semantic-scope-world-core.mjs';
export * from './semantic-scope-world-core.mjs';

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFile } = await import('node:fs/promises');
  const { reduceClosure } = await import('./closure.mjs');
  const [inputPath, ...closurePaths] = process.argv.slice(2);
  if (!inputPath || closurePaths.length === 0) throw new Error('usage: node semantic-scope-world.mjs <semantic-input.json> <closure-input.jsonl>...');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const reduced = reduceClosure(...await Promise.all(closurePaths.map(path => readFile(path, 'utf8'))));
  console.log(JSON.stringify(semanticScopeWorld(input, reduced)));
}
