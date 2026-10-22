// L1 core (adrs#647 v3 c6329883005): the append-only ledger's rules, with no I/O. ledger.mjs is its CLI.
import { createHash } from 'node:crypto';

export const LEDGER_SCHEMA = 'atlas.ledger/1';
const HEADER = { schema: LEDGER_SCHEMA, authority: false };
const DECISIONS = ['purpose.set', 'ideal.drafting', 'ideal.set', 'plan.set', 'purpose.evaluated', 'purpose.ended'];
const COLLECTOR = 'atlas.G'; // the author of an observation is the collector that read it
const fail = message => { throw new Error('atlas-ledger: ' + message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha256 = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ? Date.parse(value) : NaN;
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;
const ms = value => { const m = DURATION.exec(value ?? ''); if (!m) return NaN; const [d, h, mi, s] = m.slice(1).map(part => Number(part ?? 0)); return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000; };
const lines = text => (text ?? '').split(/\r?\n/u).filter(line => line.trim());

/** Read and check an existing ledger. A damaged ledger fails closed: nothing is appended to it. */
export const readLedger = text => {
  const [first, ...rest] = lines(text);
  if (first === undefined) return [];
  if (canonical(JSON.parse(first)) !== canonical(HEADER)) fail('unsupported ledger header');
  let last = -Infinity;
  return rest.map((line, index) => {
    const row = JSON.parse(line);
    if (row.seq !== index + 1) fail(`row ${index + 1}: seq must be ${index + 1}`);
    if (row.sha256 !== sha256(row.event) || row.recordedAt !== row.event?.recordedAt) fail(`row ${row.seq}: sha256/recordedAt does not match its event`);
    if (!(time(row.ledgerAt) >= last)) fail(`row ${row.seq}: ledgerAt goes backwards`);
    last = time(row.ledgerAt);
    return row;
  });
};

// P's records (p-record-v1, collect/precord.mjs; adrs#647 c6346827237): a row per record id, once. Its content is
// the record alone: the file's sha256 and the line move whenever P adds a line, so they never make a change.
const P_RECORD = 'p.record';
// The identity of a declaration: a later row with the same identity and the same content is no change.
const identity = event => event.kind === P_RECORD ? JSON.stringify([P_RECORD, event.record?.id ?? null]) : JSON.stringify([event.kind, event.purpose?.id ?? event.purpose_id ?? null, event.rev ?? event.purpose_rev ?? null,
  event.version ?? event.ideal_version ?? null, event.plan ?? null, ['purpose.evaluated', 'purpose.ended'].includes(event.kind) ? event.recordedAt : null]);
// What a declaration says, without when it was read (a plan body's updatedAt also moves with new comments).
// A confirmed (cold) copy of a hot declaration is a change: it is what joinLog keeps (hot ∖ cold).
const content = event => event.kind === P_RECORD ? canonical(event.record ?? null) : canonical({ ...event, recordedAt: null, source: event.kind === 'plan.set' ? { ...event.source, updatedAt: null } : event.source?.capture ?? null });
// The shortest freshness window any declared condition puts on a target (null when none does).
const windowOf = (rows, target) => {
  const windows = rows.flatMap(row => row.event.requires ?? []).filter(value => value.predicate?.target?.id === target).map(value => ms(value.maxAge)).filter(Number.isFinite);
  return windows.length ? Math.min(...windows) : null;
};

/**
 * Append one collection (G events) to the ledger rows. Returns the new rows, what was skipped as no change,
 * and what was held with a reason. An observation is recorded when its value or source changed, or when
 * half of the shortest maxAge declared on its target has passed since the last recorded observation
 * (a refresh: the latest row then never looks stale while collection runs, and goes stale when it stops).
 */
export const appendEvents = (rows, eventsText, ledgerAt) => {
  const accepted = [...rows], appended = [], skipped = [], held = [];
  if (!Number.isFinite(time(ledgerAt))) fail('ledgerAt (the time the rows enter the ledger) must be an ISO time');
  // ledgerAt going backwards would rewrite what the ledger knew at an earlier time: the whole collection is held.
  const backwards = accepted.length > 0 && time(ledgerAt) < time(accepted.at(-1).ledgerAt);
  const candidates = lines(eventsText).map((line, index) => {
    try { return { index, event: JSON.parse(line) }; } catch { held.push({ reason: 'invalid-json', line }); return null; }
  }).filter(Boolean);
  // One collection is appended in time order (G emits old-dated decisions next to new observations).
  candidates.sort((a, b) => (time(a.event.recordedAt) - time(b.event.recordedAt)) || a.index - b.index);
  for (const { event } of candidates) {
    const hold = reason => held.push({ reason, event });
    if (!object(event)) { hold('not-an-object'); continue; }
    if (event.kind === 'journal.held') { hold('held-by-G: ' + event.reason); continue; }
    if (event.kind !== 'observation' && !DECISIONS.includes(event.kind) && event.kind !== P_RECORD) { hold('unknown-kind'); continue; }
    if (!Number.isFinite(time(event.recordedAt)) || !object(event.source)) { hold('recordedAt-or-source-invalid'); continue; }
    if (backwards) { hold('ledgerAt-backwards'); continue; }
    // An event dated after the time it entered the ledger is a broken row (a future fact), not a late one.
    if (time(event.recordedAt) > time(ledgerAt) || time(event.observedAt ?? event.recordedAt) > time(ledgerAt)) { hold('dated-after-ledgerAt'); continue; }
    const digest = sha256(event);
    // A declaration is re-read on every collection: the same content again is no change, not an anomaly.
    if (event.kind !== 'observation') {
      const before = accepted.filter(row => identity(row.event) === identity(event)).at(-1)?.event;
      if (before && content(before) === content(event)) { skipped.push({ reason: 'unchanged', event }); continue; }
      // A record P wrote again under the same id says something else: the first stays (a rewrite is a new id's correction).
      if (before && event.kind === P_RECORD) { hold('p-record-rewritten'); continue; }
    }
    if (accepted.some(row => row.sha256 === digest)) { hold('duplicate'); continue; }
    if (event.kind === 'observation') {
      const before = accepted.filter(row => row.event.kind === 'observation' && row.event.target === event.target).at(-1)?.event;
      const window = windowOf(accepted, event.target);
      const same = before && canonical(before.value) === canonical(event.value) && before.source?.ref === event.source.ref;
      if (same && !(window !== null && time(event.observedAt) - time(before.observedAt) >= window / 2)) { skipped.push({ reason: 'unchanged', event }); continue; }
    }
    // A past-dated event (e.g. a declaration recorded at 00:45, read at 01:00) is appended: rows are never
    // rewritten, and its own time stays in the event (v10: holding it would hide it for ever).
    const row = { seq: accepted.length + 1, ledgerAt, recordedAt: event.recordedAt, actor: event.actor ?? COLLECTOR, source: event.source, sha256: digest, event };
    accepted.push(row); appended.push(row);
  }
  return { rows: accepted, appended, skipped, held };
};

export const ledgerText = rows => [HEADER, ...rows].map(value => JSON.stringify(value)).join('\n') + '\n';
/**
 * The ledger's events as G JSONL, in ledger order: the input of live.mjs. Frames are cut by ledgerAt (what was
 * known then), so each event is dated by its ledgerAt; a decision's own time is kept as declaredAt, an
 * observation's in observedAt. A late, past-dated event never rewrites an earlier frame.
 */
export const ledgerEvents = text => readLedger(text).map(({ ledgerAt, event }) => JSON.stringify(event.kind === 'observation' || event.recordedAt === ledgerAt
  ? { ...event, recordedAt: ledgerAt } : { ...event, recordedAt: ledgerAt, declaredAt: event.recordedAt })).join('\n') + '\n';

