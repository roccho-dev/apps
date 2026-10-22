// C5 stage 1 (adrs#647 v4 c6335921034, adopted by the User c6335830037 with the conditions of c6335481832):
// the User's evaluations, read only from the owner input source — a private repo no agent can write to. Pure,
// no I/O. `comments` are the repo's Issue comments as the REST API returns them, or null when they could not
// be read. A comment counts only when its first line is one of three forms, its author is the owner login and
// no App wrote it (`performed_via_github_app` empty):
//   atlas-readback[ <note>]              the User read back every credential that could write here
//   atlas-credentials-changed[ <note>]   a credential changed: nothing counts until the next readback
//   atlas-eval <verdict> <purpose_id> <purpose_rev> <ideal_version>[ <reason>]
// An evaluation counts only after the latest readback (its updated_at later than the readback's created_at)
// and when no change was written at or after that readback. These evaluations are never put in the ledger:
// they are read again at every step, so one that is gone or unreadable is gone (never the last `achieved`).
// Each is recorded at the step's time `at`, its comment's updated_at kept as declaredAt.
import { EVAL } from './journal.mjs';
import { sha256 } from './plan.mjs';

export const READBACK = 'atlas-readback';
export const CHANGED = 'atlas-credentials-changed';
// Atlas shows these evaluations but does not verify them: the original is the comment in the owner repo.
export const OWNER_ADMISSION = 'owner-unverified';

const is = (line, word) => line === word || line.startsWith(word + ' ');
const issueOf = comment => /\/issues\/(\d+)$/u.exec(String(comment.issue_url ?? ''))?.[1] ?? null;

/** Owner repo comments (or null) → { events: D-form purpose.evaluated, held: [{ reason, journal }] }. */
export function ownerEvents(comments, { repo, login }, at) {
  const t = Date.parse(at);
  const heldEntry = (reason, line, source, recordedAt = at) => ({ reason, journal: { kind: 'journal.held', reason, line, source, recordedAt } });
  if (!Array.isArray(comments)) return { events: [], held: [heldEntry('owner-unreadable', null, { ref: repo, commentId: null, sha256: null })] };
  const held = [], mine = [];
  for (const comment of comments) {
    const line = String(comment.body ?? '').split(/\r?\n/u)[0].trimEnd();
    if (![READBACK, CHANGED].some(word => is(line, word)) && !line.startsWith('atlas-eval ')) continue;
    const source = { ref: `${repo}#${issueOf(comment)}`, commentId: String(comment.id), sha256: sha256(comment.body ?? '') };
    const hold = reason => held.push(heldEntry(reason, line, source, Date.parse(comment.updated_at) <= t ? comment.updated_at : at));
    if (comment.user?.login !== login) hold('owner-other-author');
    else if (comment.performed_via_github_app) hold('owner-via-app');
    else if (!(Date.parse(comment.updated_at) <= t) || !(Date.parse(comment.created_at) <= t)) hold('recordedAt-after-source');
    else mine.push({ comment, line, source, hold });
  }
  const latest = word => Math.max(-Infinity, ...mine.filter(value => is(value.line, word)).map(value => Date.parse(value.comment.created_at)));
  const readback = latest(READBACK), changed = latest(CHANGED), events = [];
  for (const { comment, line, source, hold } of mine.filter(value => value.line.startsWith('atlas-eval '))) {
    const match = EVAL.exec(line);
    if (!match) { hold('eval-form'); continue; }
    if (readback === -Infinity) { hold('owner-readback-missing'); continue; }
    if (changed >= readback) { hold('owner-credentials-changed'); continue; }
    if (!(Date.parse(comment.updated_at) > readback)) { hold('owner-before-readback'); continue; }
    const [, verdict, purposeId, purposeRev, idealVersion, note] = match;
    // Read now, at `at` (as a ledger row's recordedAt); the comment's own time is declaredAt (v10).
    const declared = Date.parse(comment.updated_at) < t ? { declaredAt: comment.updated_at } : {};
    events.push({ kind: 'purpose.evaluated', recordedAt: at, ...declared, purpose_id: purposeId, purpose_rev: purposeRev,
      ideal_version: idealVersion, verdict, ...(note ? { note } : {}), actor: login,
      source: { ref: source.ref, digest: source.sha256, commentId: source.commentId, admission: OWNER_ADMISSION } });
  }
  return { events, held };
}
