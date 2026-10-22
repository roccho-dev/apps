// G journal extraction (adrs#647 contract 3): decisions written as ```jsonl inside marker sections
// of Issue/PR texts, and P's declaration file. Pure, no I/O, no verdicts. The actor is who wrote it
// (the gh comment author; P for the declaration file); a different self-declared actor is held.
import { markerSections, sha256, timestamp } from './plan.mjs';

export const JOURNAL_KINDS = Object.freeze(['purpose.set', 'ideal.drafting', 'ideal.set', 'purpose.evaluated', 'purpose.ended']);
const BLOCK = /```jsonl[^\S\n]*\n([\s\S]*?)```/gu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// One declared line → an event with the observed actor and source, or a held line with its reason.
function entry(line, { author, source, notAfter, at }) {
  let value;
  try { value = JSON.parse(line); } catch { return { kind: 'journal.held', reason: 'invalid-json', line, source, recordedAt: notAfter }; }
  const held = reason => ({ kind: 'journal.held', reason, line, source, recordedAt: notAfter });
  if (!object(value) || !JOURNAL_KINDS.includes(value.kind)) return held('unknown-kind');
  if (typeof author !== 'string' || !author) return held('author-unknown');
  if ('actor' in value && value.actor !== author) return held('actor-mismatch');
  let recorded;
  try { recorded = timestamp(value.recordedAt, `${at} recordedAt`); } catch { return held('recordedAt-invalid'); }
  if (recorded > Date.parse(notAfter)) return held('recordedAt-after-source');
  const { source: declared, ...rest } = value; // the source is what G read, not what the line claims
  return { ...rest, actor: author, source };
}

// C5 (adrs#647 c6315696164): the User's evaluation, written by hand as the first line of a comment:
// `atlas-eval <verdict> <purpose_id> <purpose_rev> <ideal_version>[ <reason>]`, matched whole; a first line that
// starts with it but does not match is held. Its time is the comment's (updated_at), its actor the comment's
// login; who may evaluate is the authority's rule (live.mjs), not the collector's. Other lines are not read.
export const EVAL = /^atlas-eval (achieved|not-yet|ideal-insufficient) (\S+) (\S+) (\S+)(?: (\S.*))?$/u;
function evaluation(doc, { source, notAfter }) {
  const first = String(doc.text ?? '').split(/\r?\n/u)[0].trimEnd();
  if (!first.startsWith('atlas-eval ')) return [];
  const line = first, match = EVAL.exec(first);
  if (!match) return [{ kind: 'journal.held', reason: 'eval-form', line, source, recordedAt: notAfter }];
  if (typeof doc.author !== 'string' || !doc.author) return [{ kind: 'journal.held', reason: 'author-unknown', line, source, recordedAt: notAfter }];
  const [, verdict, purposeId, purposeRev, idealVersion, note] = match;
  // The comment's own time as GitHub wrote it (never later than the collection).
  const recordedAt = Date.parse(doc.updatedAt) <= Date.parse(notAfter) ? doc.updatedAt : notAfter;
  return [{ kind: 'purpose.evaluated', recordedAt, purpose_id: purposeId, purpose_rev: purposeRev, ideal_version: idealVersion, verdict,
    ...(note ? { note } : {}), actor: doc.author, source }];
}

const unique = events => [...new Map(events.map(event => [JSON.stringify(event.kind === 'journal.held' ? event : { ...event, source: null }), event])).values()];

/** Thread documents [{repo, number, commentId, updatedAt, author, text}] → journal events (sections of any version). */
export function journalEvents(documents, recordedAt) {
  const recorded = timestamp(recordedAt, 'recordedAt');
  // A document read from Git Cold names its own source (<repo>@<commit>:<path>, content_sha256).
  const where = doc => ({ at: `${doc.repo}#${doc.number}`, notAfter: new Date(Math.min(timestamp(doc.updatedAt, 'updated_at'), recorded)).toISOString(),
    source: doc.source ? { ...doc.source, commentId: doc.commentId } : { ref: `${doc.repo}#${doc.number}`, commentId: doc.commentId, sha256: sha256(doc.text) } });
  return unique(documents.flatMap(doc => [...evaluation(doc, where(doc)), ...markerSections(doc.text).filter(section => section.slug !== 'worklog')
    .flatMap(section => [...section.text.matchAll(BLOCK)])
    .flatMap(block => block[1].split(/\r?\n/u).map(line => line.trim()).filter(Boolean))
    .map(line => entry(line, { author: doc.author, ...where(doc) }))]));
}

/** P's declaration file {path, sha256, text} → journal events with actor P (lines are whole entries). */
export function declarationEvents({ path, sha256: digest, text }, recordedAt) {
  timestamp(recordedAt, 'recordedAt');
  if (typeof text !== 'string') return [{ kind: 'journal.held', reason: 'declaration-unreadable', line: null, source: { ref: `hq:${path}`, sha256: digest }, recordedAt }];
  return unique(text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    .map(line => entry(line, { author: 'P', at: `hq:${path}`, notAfter: recordedAt, source: { ref: `hq:${path}`, sha256: digest } })));
}
