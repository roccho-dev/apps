// L1: the append-only ledger of world events (adrs#647 v9). G's events for one collection are appended;
// existing rows are never rewritten. A projection (World) is derived from the whole ledger by live.mjs.
//   node packages/atlas/ledger.mjs --ledger=<ledger.jsonl> [--ledger-at=<ISO>] [--held=<held.jsonl>] <g-events.jsonl>...
// Two times per row (v10, like a book's entry date and the event date): ledgerAt = when the row entered the
// ledger (monotonic; the only time order checked), and the event's own time (recordedAt / observedAt), kept as is.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendEvents, ledgerText, readLedger } from './ledger-core.mjs';
export * from './ledger-core.mjs';

const fail = message => { throw new Error('atlas-ledger: ' + message); };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { ledger: { type: 'string' }, held: { type: 'string' }, 'ledger-at': { type: 'string' }, check: { type: 'boolean' } } });
    if (!values.ledger || (positionals.length === 0 && !values.check)) fail('usage: node ledger.mjs --ledger=<ledger.jsonl> [--ledger-at=<ISO>] [--held=<held.jsonl>] <g-events.jsonl>... | --check');
    // --check: read only; exit 1 if the ledger is damaged (e.g. a last line cut short).
    if (values.check) {
      const checked = readLedger(fs.readFileSync(values.ledger, 'utf8'));
      console.log(JSON.stringify({ schema: 'atlas.ledger-check/1', status: 'PASS', rows: checked.length, lastLedgerAt: checked.at(-1)?.ledgerAt ?? null }));
    } else {
      const ledgerAt = values['ledger-at'] ?? new Date().toISOString(); // the clock is read here, at the edge only
      const before = fs.existsSync(values.ledger) ? fs.readFileSync(values.ledger, 'utf8') : '';
      let result = { rows: readLedger(before), appended: [], skipped: [], held: [] };
      for (const file of positionals) {
        const next = appendEvents(result.rows, fs.readFileSync(file, 'utf8'), ledgerAt);
        result = { rows: next.rows, appended: [...result.appended, ...next.appended], skipped: [...result.skipped, ...next.skipped], held: [...result.held, ...next.held] };
      }
      // Append only: the new text starts with the old bytes (a fresh ledger starts with its header).
      const addition = before ? result.appended.map(row => JSON.stringify(row) + '\n').join('') : ledgerText(result.rows);
      if (addition) fs.appendFileSync(values.ledger, addition);
      const heldPath = values.held ?? values.ledger.replace(/\.jsonl$/u, '') + '.held.jsonl';
      if (result.held.length) fs.appendFileSync(heldPath, result.held.map(value => JSON.stringify({ ...value, at: ledgerAt }) + '\n').join(''));
      console.log(JSON.stringify({ schema: 'atlas.ledger-append/1', status: 'PASS', ledger: path.resolve(values.ledger), ledgerAt, rows: result.rows.length,
        appended: result.appended.length, skipped: result.skipped.length, held: result.held.length, heldPath: result.held.length ? path.resolve(heldPath) : null }));
    }
  } catch (error) {
    console.error(error.message.startsWith('atlas-') ? error.message : 'atlas-ledger: ' + error.message);
    process.exitCode = 1;
  }
}
