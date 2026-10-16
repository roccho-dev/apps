// K: G events + a purpose.set file → D → World. Joins only; judging stays in D.
// fromG is the one place that knows G's event shape. D (events.mjs/derive.mjs) is unchanged.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const fail = message => { throw new Error('atlas-live: ' + message); };
const exact = (event, keys) => Object.keys(event).length === keys.length && keys.every(key => key in event);
const rows = text => text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';

/**
 * One G event → { event } for D, or { held } kept verbatim. G observation targets stay
 * opaque strings (D state target ids); G's literal UNKNOWN becomes a non-scalar value,
 * which D judges unknown. G plan.set has no purposeRef, so D cannot take it yet: held.
 */
export const fromG = event => {
  if (event?.kind === 'plan.set') return { held: event };
  if (event?.kind !== 'observation' || !exact(event, ['kind', 'target', 'value', 'source', 'observedAt', 'recordedAt'])
    || typeof event.target !== 'string' || typeof event.source?.ref !== 'string' || typeof event.source?.sha256 !== 'string')
    fail('unsupported G event ' + JSON.stringify(event).slice(0, 120));
  return { event: { kind: 'observation', recordedAt: event.recordedAt, target: { kind: 'state', id: event.target },
    value: event.value === 'UNKNOWN' ? { G: 'UNKNOWN' } : event.value, source: `${event.source.ref} ${event.source.sha256}`, observedAt: event.observedAt } };
};

/** D log text: header, purpose.set lines and adapted G observations in recordedAt order (stable). */
export const joinLog = (purposeText, gTexts, sourceMode = 'supplied') => {
  const mapped = gTexts.flatMap(rows).map(fromG);
  const events = [...rows(purposeText), ...mapped.filter(value => value.event).map(value => value.event)]
    .map((event, index) => ({ event, index })).sort((a, b) => Date.parse(a.event.recordedAt) - Date.parse(b.event.recordedAt) || a.index - b.index)
    .map(value => value.event);
  return { log: jsonl([{ schema: 'atlas.events/1', authority: false, source_mode: sourceMode }, ...events]),
    held: mapped.filter(value => value.held).map(value => value.held) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true,
      options: { 'out-dir': { type: 'string' }, purpose: { type: 'string' }, control: { type: 'string' } } });
    if (!values['out-dir'] || !values.purpose || positionals.length === 0)
      fail('usage: node live.mjs --out-dir=<dir> --purpose=<purpose.jsonl> [--control=<control.jsonl>] <g-events.jsonl>...');
    const read = file => fs.readFileSync(file, 'utf8');
    const { log, held } = joinLog(read(values.purpose), positionals.map(read));
    fs.mkdirSync(values['out-dir'], { recursive: true });
    const out = name => path.join(fs.realpathSync(values['out-dir']), name);
    const inputs = [values.purpose, values.control, ...positionals].filter(Boolean).map(file => fs.realpathSync(file));
    if (['events.jsonl', 'control.jsonl', 'g-plans.jsonl'].some(name => inputs.includes(out(name)))) fail('output must not replace an input');
    fs.writeFileSync(out('events.jsonl'), log);
    // No control given: no Norm, so every condition is derived unassigned (never guessed).
    if (!values.control) fs.writeFileSync(out('control.jsonl'), jsonl([{ schema: 'atlas.control-norms/1', authority: false }]));
    fs.writeFileSync(out('g-plans.jsonl'), held.length ? jsonl(held) : '');
    const derive = fileURLToPath(new URL('./derive.mjs', import.meta.url));
    const receipt = JSON.parse(execFileSync(process.execPath, [derive, '--out-dir=' + out('.'), out('events.jsonl'),
      values.control ? fs.realpathSync(values.control) : out('control.jsonl')], { encoding: 'utf8' }));
    console.log(JSON.stringify({ ...receipt, schema: 'atlas.live-build/1', held_plans: { path: out('g-plans.jsonl'), count: held.length } }));
  } catch (error) {
    console.error(error.message.startsWith('atlas-') ? error.message : 'atlas-live: ' + error.message);
    process.exitCode = 1;
  }
}
