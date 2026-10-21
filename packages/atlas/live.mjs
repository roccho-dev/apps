// K: G events (+ an optional D-form declaration file) → D → World. Joins only; judging stays in D.
// fromG is the one place that knows G's event shape; D's parser checks every journal entry and plan.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAuthority, parseEvents } from './events.mjs';
import { ledgerEvents } from './ledger.mjs';

const fail = message => { throw new Error('atlas-live: ' + message); };
const exact = (event, keys) => Object.keys(event).length === keys.length && keys.every(key => key in event);
const rows = text => text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
const jsonl = list => list.map(value => JSON.stringify(value)).join('\n') + '\n';
const header = sourceMode => ({ schema: 'atlas.events/1', authority: false, source_mode: sourceMode });
const SESSION = ':session';
const JOURNAL = ['purpose.set', 'ideal.drafting', 'ideal.set', 'purpose.evaluated', 'purpose.ended'];
const byTime = list => list.map((event, index) => ({ event, index }))
  .sort((a, b) => Date.parse(a.event.recordedAt) - Date.parse(b.event.recordedAt) || a.index - b.index).map(value => value.event);

// A3: the source's admission (e.g. observed_not_admitted of a Git Cold row) rides along on journal decisions,
// for display only (adrs#647 records the journal; plans do not carry it).
const admission = source => typeof source?.admission === 'string' ? { admission: source.admission } : {};

// G plan.set → D plan.set under the ideal state that declares it in requires[].plans. Cells are
// copied, never parsed: D rejects anything that is not already a declared id, and then it is held.
const toPlan = (g, purpose) => ({ kind: 'plan.set', recordedAt: g.recordedAt, plan: g.plan, ...(g.actor ? { actor: g.actor } : {}),
  purposeRef: { purposeId: purpose.purpose?.id ?? purpose.purpose_id, version: purpose.version },
  source: { ref: g.source.repo, commentId: g.source.commentId === null ? null : String(g.source.commentId), updatedAt: g.source.updatedAt, digest: g.source.sha256 },
  version: String(g.version),
  ...(g.nodes === 'UNKNOWN' || g.edges === 'UNKNOWN' ? { nodes: null, edges: null, unknown: g.unknown ?? [] } : {
    nodes: g.nodes.map(node => ({ id: node.id, label: node.label, norm: node.owner, exit: node.exit, contributesTo: [node.requires],
      ...(purpose.requires.some(value => value.id === node.predicate) ? { predicateRefs: [node.predicate] } : {}) })),
    edges: g.edges.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind, ...(edge.condition && edge.condition !== 'UNKNOWN' ? { condition: edge.condition } : {}) })) }) });

/**
 * One G event → { events } for D, or { held: {reason, plan|journal} } kept verbatim.
 * Observation targets stay opaque D state ids; G's literal UNKNOWN becomes D's null (no value
 * obtained), which D judges unknown. G's documented `<target>:session` is also passed as the
 * Agent activity of <target> (the value as observed; transcript-only is not activity).
 * Journal decisions keep G's actor; their source sha256 becomes D's digest. `decisions` are
 * the already accepted D decisions, where a plan's declaring ideal state is looked up.
 */
export const fromG = (event, decisions = []) => {
  if (event?.kind === 'journal.held') return { held: { reason: event.reason, journal: event } };
  if (JOURNAL.includes(event?.kind) && (typeof event.source?.ref !== 'string' || typeof event.source?.sha256 !== 'string'))
    fail('unsupported G event ' + JSON.stringify(event).slice(0, 120));
  if (JOURNAL.includes(event?.kind)) return { events: [{ ...event, source: { ref: event.source.ref, digest: event.source.sha256,
    ...(event.source.commentId == null ? {} : { commentId: String(event.source.commentId) }), ...admission(event.source) } }] };
  if (event?.kind === 'plan.set') {
    const declaring = decisions.filter(value => Date.parse(value.recordedAt) <= Date.parse(event.recordedAt)
      && value.requires?.some(condition => condition.plans?.includes(event.plan))).at(-1);
    // Held as before; also returned as unbound so the World's journal can show it (L3, display only).
    if (!declaring) return { held: { reason: 'no ideal state declares this plan in requires[].plans', plan: event }, unbound: event };
    const plan = toPlan(event, declaring);
    try { parseEvents(jsonl([header('supplied'), ...decisions.slice(0, decisions.indexOf(declaring) + 1), plan])); }
    catch (error) { return { held: { reason: error.message, plan: event } }; }
    return { events: [plan] };
  }
  if (event?.kind !== 'observation' || !exact(event, ['kind', 'target', 'value', 'source', 'observedAt', 'recordedAt'])
    || typeof event.target !== 'string' || typeof event.source?.ref !== 'string' || typeof event.source?.sha256 !== 'string')
    fail('unsupported G event ' + JSON.stringify(event).slice(0, 120));
  const observed = { kind: 'observation', recordedAt: event.recordedAt, target: { kind: 'state', id: event.target },
    value: event.value === 'UNKNOWN' ? null : event.value, source: `${event.source.ref} ${event.source.sha256}`, observedAt: event.observedAt };
  const session = event.target.endsWith(SESSION) && event.target.length > SESSION.length
    ? [{ ...observed, target: { kind: 'session', id: event.target.slice(0, -SESSION.length) }, projection: true }] : [];
  return { events: [observed, ...session] };
};

/**
 * D log text: header, accepted decisions, plans and observations in recordedAt order (stable).
 * Decisions are accepted one by one in time order with D's parser; one D rejects is held, not fatal.
 */
// hot ∖ cold (A1): a document is `owner/repo#n` + commentId (null for the body). From the time cold (a
// `source.capture`) has it, cold is the confirmed value: a hot copy read then or later is dropped, or held as
// superseded-by-cold when it says something else. What hot read earlier stays as read (a past frame is never
// rewritten); when cold says the same, only `confirmed:<owner/repo#n>:<commentId|body>` = the capture is added
// at cold's time, not the decision again.
const DOCUMENT = [...JOURNAL, 'plan.set'];
const threadOf = event => event.kind === 'plan.set' ? event.source?.repo : event.source?.ref;
const documentOf = event => `${threadOf(event)} ${event.source?.commentId ?? null}`;
const said = event => `${documentOf(event)} ${JSON.stringify(Object.entries({ ...event, source: null, recordedAt: null, declaredAt: null }).sort(([a], [b]) => (a < b ? -1 : 1)))}`;
const hotMinusCold = (events, held) => {
  const isCold = event => DOCUMENT.includes(event.kind) && Boolean(event.source?.capture);
  const isHot = event => DOCUMENT.includes(event.kind) && !event.source?.capture;
  const arrived = new Map(); // document → when cold first has it
  for (const event of events.filter(isCold)) if (!arrived.has(documentOf(event)) || Date.parse(event.recordedAt) < Date.parse(arrived.get(documentOf(event)))) arrived.set(documentOf(event), event.recordedAt);
  const before = event => Date.parse(event.recordedAt) < Date.parse(arrived.get(documentOf(event)));
  const readEarlier = new Set(events.filter(event => isHot(event) && arrived.has(documentOf(event)) && before(event)).map(said));
  const coldSaid = new Set(events.filter(isCold).map(said)), confirmedOnce = new Set();
  return events.flatMap(event => {
    if (isCold(event)) {
      if (!readEarlier.has(said(event))) return [event];
      if (confirmedOnce.has(documentOf(event))) return [];
      confirmedOnce.add(documentOf(event));
      return [{ kind: 'observation', target: `confirmed:${threadOf(event)}:${event.source.commentId ?? 'body'}`, value: event.source.capture,
        source: { ref: event.source.capture, sha256: event.source.sha256 }, observedAt: event.recordedAt, recordedAt: event.recordedAt }];
    }
    if (!isHot(event) || !arrived.has(documentOf(event)) || before(event)) return [event];
    if (!coldSaid.has(said(event))) held.push({ reason: 'superseded-by-cold', [event.kind === 'plan.set' ? 'plan' : 'journal']: event });
    return [];
  });
};

// v12 (S4): who decided. Only a Purpose with an authority declaration is checked; a proposer's decision is a
// proposal (held, never in the log), an author who is neither is not authorized. Others are accepted as before.
const purposeOf = decision => decision.kind === 'purpose.set' ? decision.purpose?.id : decision.purpose_id;
const unauthorized = (decision, authority) => {
  const declared = authority.get(purposeOf(decision));
  if (!declared || declared.deciders.includes(decision.actor)) return null;
  return declared.proposers.includes(decision.actor) ? 'proposal' : 'actor-not-authorized';
};

export const joinLog = (purposeText, gTexts, sourceMode = 'supplied', { authority = new Map() } = {}) => {
  const held = [], accepted = [], gEvents = hotMinusCold(gTexts.flatMap(rows), held);
  const candidates = byTime([...rows(purposeText ?? ''),
    ...gEvents.filter(event => JOURNAL.includes(event.kind)).flatMap(event => fromG(event).events)]);
  for (const decision of candidates) {
    // adrs#654, the one check: a worklog value (work:* / evidence:*) or an evaluator's answer (evaluation:*, v12)
    // is a claim, never a condition. Every decision that carries requires (ideal.set, the legacy purpose.set, …),
    // from G or --purpose alike, passes here.
    if (Array.isArray(decision?.requires) && decision.requires.some(condition => /^(?:work|evidence|evaluation):/u.test(String(condition?.predicate?.target?.id ?? '')))) {
      held.push({ reason: 'worklog-target-in-predicate', journal: decision }); continue;
    }
    const refused = unauthorized(decision, authority);
    if (refused) { held.push({ reason: refused, journal: decision }); continue; }
    try { parseEvents(jsonl([header(sourceMode), ...accepted, decision])); accepted.push(decision); }
    // The held reason is D's stable code (contract v12), never its message with a line number.
    catch (error) { held.push({ reason: error.code ?? 'invalid-declaration', journal: decision }); }
  }
  const rest = gEvents.filter(event => !JOURNAL.includes(event.kind)).map(event => fromG(event, accepted));
  held.push(...rest.filter(value => value.held).map(value => value.held));
  // unbound: G plan.set events no ideal state declares (also held); the World's journal shows them (L3).
  return { log: jsonl([header(sourceMode), ...byTime([...accepted, ...rest.flatMap(value => value.events ?? [])])]), held,
    unbound: rest.filter(value => value.unbound).map(value => value.unbound) };
};

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
