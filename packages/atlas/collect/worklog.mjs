// G worklog mapping (atlas-worklog-v1, R's minimal form as decided by P). One ```jsonl line per comment in a
// `<!-- worklog-v1 -->` section becomes an observation on `work:<work_id>`. Pure, no I/O, no verdicts:
//   {"kind":"work.created","work_id":…}                          → created
//   {"kind":"artifact.observed","work_id":…,"evidence":…}        → progressed (evidence: owner/repo#n or a 40-hex sha)
//   {"kind":"work.terminal","work_id":…,"terminal":done|blocked|stopped} → reported-done / -blocked / -stopped
// Time and author are the captured document's; the writer types neither. Any other field, two or more lines in
// one comment, an author outside the allowed list (or no list at all) → journal.held with the reason.
// A terminal is a report, never an achievement: only declared conditions judge.
import { markerSections, sha256 } from './plan.mjs';

export const WORKLOG_SLUG = 'worklog';
const BLOCK = /```jsonl[^\S\n]*\n([\s\S]*?)```/gu;
const FIELDS = { 'work.created': ['kind', 'work_id'], 'artifact.observed': ['kind', 'work_id', 'evidence'], 'work.terminal': ['kind', 'work_id', 'terminal'] };
const TERMINAL = { done: 'reported-done', blocked: 'reported-blocked', stopped: 'reported-stopped' };
const WORK_ID = /^[A-Za-z0-9._:/-]+$/u;
const EVIDENCE = /^(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*|[0-9a-f]{40})$/u;

function value(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(FIELDS, entry.kind)) return { reason: 'kind' };
  const keys = Object.keys(entry);
  if (keys.length !== FIELDS[entry.kind].length || !FIELDS[entry.kind].every(key => keys.includes(key))) return { reason: 'fields' };
  if (typeof entry.work_id !== 'string' || !WORK_ID.test(entry.work_id)) return { reason: 'work-id' };
  if (entry.kind === 'work.created') return { value: 'created' };
  if (entry.kind === 'artifact.observed') return typeof entry.evidence === 'string' && EVIDENCE.test(entry.evidence) ? { value: 'progressed' } : { reason: 'evidence-form' };
  return Object.hasOwn(TERMINAL, entry.terminal) ? { value: TERMINAL[entry.terminal] } : { reason: 'terminal' };
}

/**
 * Thread documents [{repo, number, commentId, updatedAt, author, text, source?}] → observations or held lines.
 * `authors`: the logins allowed to write a worklog, from the declaration side; absent or empty holds every line.
 */
export function worklogEvents(documents, recordedAt, authors) {
  const allowed = Array.isArray(authors) && authors.length ? new Set(authors) : null;
  return documents.flatMap(doc => {
    const lines = markerSections(doc.text).filter(section => section.slug === WORKLOG_SLUG && section.version === 1)
      .flatMap(section => [...section.text.matchAll(BLOCK)]).flatMap(block => block[1].split(/\r?\n/u).map(line => line.trim()).filter(Boolean));
    const base = doc.source ? { ref: doc.source.ref, sha256: doc.source.sha256 } : { ref: `${doc.repo}#${doc.number}`, sha256: sha256(doc.text) };
    const held = (reason, line) => ({ kind: 'journal.held', reason: 'worklog: ' + reason, line, source: { ...base, commentId: doc.commentId }, recordedAt });
    if (lines.length > 1) return lines.map(line => held('multiple-lines', line));
    return lines.map(line => {
      const checked = check(line, doc.author, allowed);
      if (checked.reason) return held(checked.reason, line);
      // The evidence stays in the comment (its digest is source.sha256); it is not written into source.ref.
      return { kind: 'observation', target: `work:${checked.entry.work_id}`, value: checked.value, source: base, observedAt: doc.updatedAt, recordedAt };
    });
  });
}

// The one check for a worklog line, wherever it was written: author in the allowed list, then the line form.
function check(line, author, allowed) {
  if (!allowed) return { reason: 'author-list-missing' };
  if (!allowed.has(author)) return { reason: 'author-not-allowed' };
  let entry;
  try { entry = JSON.parse(line); } catch { return { reason: 'invalid-json' }; }
  const mapped = value(entry);
  return mapped.reason ? mapped : { entry, value: mapped.value };
}

/**
 * current = record(agent): files [{author, text}] as passed by the caller (the author is the argument, never a
 * field of the line), read at `readAt`; every non-empty line is one claim, ordered by its line number.
 * State → observation on `work:<id>`; the evidence of artifact.observed → observation on `evidence:<id>`, so it
 * is readable in the snapshot without a new field and never mixed into a source. Source: `current:<author>#L<n>`
 * and the sha256 of the file as read. A claim is not an achievement; no condition may watch these (adrs#654).
 */
export function currentEvents(files, readAt, recordedAt, authors) {
  const allowed = Array.isArray(authors) && authors.length ? new Set(authors) : null;
  return files.flatMap(({ author, text }) => {
    const digest = sha256(text);
    return text.split(/\r?\n/u).flatMap((raw, index) => {
      const line = raw.trim(), source = { ref: `current:${author}#L${index + 1}`, sha256: digest };
      if (!line) return [];
      const checked = check(line, author, allowed);
      if (checked.reason) return [{ kind: 'journal.held', reason: 'current: ' + checked.reason, line, source, recordedAt }];
      const observed = (target, value) => ({ kind: 'observation', target, value, source, observedAt: readAt, recordedAt });
      return [observed(`work:${checked.entry.work_id}`, checked.value),
        ...(checked.entry.kind === 'artifact.observed' ? [observed(`evidence:${checked.entry.work_id}`, checked.entry.evidence)] : [])];
    });
  });
}
