// K: G events (+ an optional D-form declaration file) → D → World. Joins only; judging stays in D.
// fromG is the one place that knows G's event shape; D's parser checks every journal entry and plan.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAuthority } from './events.mjs';
import { ledgerEvents } from './ledger-core.mjs';
import { joinLog } from './live-core.mjs';
export * from './live-core.mjs';

const fail = message => { throw new Error('atlas-live: ' + message); };
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true,
      options: { 'out-dir': { type: 'string' }, purpose: { type: 'string' }, control: { type: 'string' }, ledger: { type: 'string' } } });
    if (!values['out-dir'] || (positionals.length === 0 && !values.ledger))
      fail('usage: node live.mjs --out-dir=<dir> [--ledger=<ledger.jsonl>] [--purpose=<D-form purpose.jsonl>] [--control=<control.jsonl>] [<g-events.jsonl>...]');
    const read = file => fs.readFileSync(file, 'utf8');
    // L1: with --ledger the World is derived from every ledger row (the same ledger, the same World).
    const gTexts = [...(values.ledger ? [ledgerEvents(read(values.ledger))] : []), ...positionals.map(read)];
    const authority = values.control ? parseAuthority(read(values.control)) : new Map();
    const { log, held, unbound } = joinLog(values.purpose ? read(values.purpose) : '', gTexts, 'supplied', { authority });
    fs.mkdirSync(values['out-dir'], { recursive: true });
    const out = name => path.join(fs.realpathSync(values['out-dir']), name);
    const inputs = [values.purpose, values.control, values.ledger, ...positionals].filter(Boolean).map(file => fs.realpathSync(file));
    if (['events.jsonl', 'control.jsonl', 'g-plans.jsonl', 'g-journal-held.jsonl', 'g-unbound-plans.jsonl'].some(name => inputs.includes(out(name)))) fail('output must not replace an input');
    fs.writeFileSync(out('g-unbound-plans.jsonl'), unbound.length ? jsonl(unbound) : '');
    fs.writeFileSync(out('events.jsonl'), log);
    // No control given: no Norm, so every condition is derived unassigned (never guessed).
    if (!values.control) fs.writeFileSync(out('control.jsonl'), jsonl([{ schema: 'atlas.control-norms/1', authority: false }]));
    const plans = held.filter(value => value.plan), journal = held.filter(value => value.journal);
    fs.writeFileSync(out('g-plans.jsonl'), plans.length ? jsonl(plans) : '');
    fs.writeFileSync(out('g-journal-held.jsonl'), journal.length ? jsonl(journal) : '');
    const derive = fileURLToPath(new URL('./derive.mjs', import.meta.url));
    const receipt = JSON.parse(execFileSync(process.execPath, [derive, '--out-dir=' + out('.'), '--unbound-plans=' + out('g-unbound-plans.jsonl'),
      '--held=' + out('g-journal-held.jsonl'), out('events.jsonl'), values.control ? fs.realpathSync(values.control) : out('control.jsonl')], { encoding: 'utf8' }));
    console.log(JSON.stringify({ ...receipt, schema: 'atlas.live-build/1', held_plans: { path: out('g-plans.jsonl'), count: plans.length },
      held_journal: { path: out('g-journal-held.jsonl'), count: journal.length } }));
  } catch (error) {
    console.error(error.message.startsWith('atlas-') ? error.message : 'atlas-live: ' + error.message);
    process.exitCode = 1;
  }
}
