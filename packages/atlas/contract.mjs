// The World write edge: the only module that knows the ui contracts (adrs#647 v3) frames[i].plans,
// gap, phase, journal and matched_until. D's derived frames go in; nothing here judges.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const open = condition => condition.judgment.state !== 'satisfied';
const frameId = frame => `t@${frame.asOf}`;
const number = value => /^\d+$/u.test(value) ? Number(value) : value; // G numbers that D keeps as tokens
const purposeKey = frame => JSON.stringify([frame.purpose.purpose.id, frame.purpose.rev]); // compared as the pair
const state = condition => condition.judgment.state === 'unmet' ? 'unmet' : 'unknown';
const ideal = condition => [condition.predicate, condition.maxAge];
const iso = ms => new Date(ms).toISOString();
// The ideal state's own time (v10): when it was declared, not when it entered the ledger (ledgerAt only cuts frames).
const idealAt = ideal => Date.parse(ideal.declaredAt ?? ideal.recordedAt);
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;
const ms = value => { const [d, h, m, s] = DURATION.exec(value).slice(1).map(part => Number(part ?? 0)); return (((d * 24 + h) * 60 + m) * 60 + s) * 1000; };

// The current side (v6): why the current state does not meet the condition now, at most one, never hidden
// by an ideal-side cause. An unmet condition only has one when it changed against the same, unrevised
// condition before (regressed / confirmed); an unknown one always says why it is unknown.
const currentCause = (before, now) => {
  if (now.state === 'unmet') return !before ? null : before.state === 'satisfied' ? 'current-regressed'
    : before.state === 'unmet' ? null : 'current-confirmed-unmet';
  if (now.state === 'conflict') return 'current-conflict';
  // Arrived but not comparable with the predicate (unmatchable, or arrived with no value: v12) is not the
  // same as nothing arrived.
  return now.reason === 'stale' ? 'current-stale' : ['unmatchable', 'no-value'].includes(now.reason) ? 'current-unmatchable' : 'current-unobserved';
};

/**
 * One frame's difference. `last` is the latest earlier frame with a gap (the comparison partner for
 * causes); `previous` is the frame just before (its open parts are what this frame can close).
 * No ideal state to compare with (purpose-changed, defining, ended): parts are null (UNKNOWN), not [].
 */
export const gapOf = (frame, last = null, previous = null) => {
  const sameId = other => other && other.frame.purpose.purpose.id === frame.purpose.purpose.id;
  const sameKey = last && purposeKey(last.frame) === purposeKey(frame);
  const before = new Map((sameId(last) ? last.frame.conditions : []).map(value => [value.id, value]));
  // Only a difference open without a break (open in the previous frame) keeps its opening frame.
  const since = new Map((sameId(previous) ? previous.gap.parts ?? [] : []).map(part => [part.condition, part.since]));
  const refs = condition => [...new Set(frame.plans.filter(plan => condition.plans?.includes(plan.plan)).map(plan => plan.ref))].sort();
  const parts = frame.ideal && frame.conditions.filter(open).map(value => {
    const old = before.get(value.id), revised = old && !same(ideal(old), ideal(value));
    // The ideal side (v6): at most one; 'initial' when there is no earlier frame with a gap to compare.
    const sides = { ideal: !last ? 'initial' : !sameKey ? 'purpose-changed' : !old ? 'ideal-added' : revised ? 'ideal-revised' : null,
      current: currentCause(old && !revised && sameKey ? old.judgment : null, value.judgment) };
    // Neither side has a reason: the same open difference continues. It is named (ui refuses a cause with no side).
    const cause = sides.ideal || sides.current ? sides : { ideal: null, current: 'carried' };
    const observedAt = value.judgment.observation?.observedAt;
    return { condition: value.id, label: value.label, state: state(value), cause,
      // A difference declared again (same Purpose id, same condition, unrevised) continues from its opening frame.
      since: old && !revised && since.has(value.id) ? since.get(value.id) : frameId(frame),
      scope: value.responsibility.state === 'assigned' ? `scope.${value.id}` : null, refs: refs(value),
      ...(observedAt && Date.parse(observedAt) < idealAt(frame.ideal) ? { observed_before_ideal: true } : {}),
      // S5: the last observation the judge saw for this condition, or null. Its ref is the source without the trailing
      // " sha256:<hex>" G appends (the ref itself may have spaces: "gh api graphql owner/repo#n pullRequest").
      // D's observations carry no actor.
      last_observed: value.judgment.observation
        ? { observedAt: value.judgment.observation.observedAt, source: { ref: String(value.judgment.observation.source).replace(/ sha256:[0-9a-f]{64}$/u, '') }, actor: null } : null };
  });
  // Close what the previous frame had open and this frame no longer has open.
  // Under a new Purpose rev only what the new ideal declares again continues; the rest closes.
  const continued = sameId(previous) && parts ? new Set(parts.map(part => part.condition)) : new Set();
  const ids = new Set(frame.conditions.map(value => value.id));
  const closed = (previous?.gap.parts ?? []).filter(part => !continued.has(part.condition)).map(part => ({
    condition: part.condition, at: frameId(frame),
    by: frame.stage === 'ended' ? 'purpose-ended' : !frame.ideal || !sameId(previous) || purposeKey(previous.frame) !== purposeKey(frame) && !ids.has(part.condition)
      ? 'purpose-changed' : ids.has(part.condition) ? 'current-satisfied' : 'ideal-removed' }));
  const byCause = {};
  // Both sides are counted (carried included).
  for (const part of parts ?? []) for (const cause of [part.cause.ideal, part.cause.current].filter(Boolean)) byCause[cause] = (byCause[cause] ?? 0) + 1;
  return { basis: { purpose_id: frame.purpose.purpose.id, purpose_rev: frame.purpose.rev, purpose_label: frame.purpose.purpose.label,
    ideal_version: frame.ideal?.version ?? null, prev_frame: last ? frameId(last.frame) : null },
  parts, closed, summary: parts ? { open: parts.length, by_cause: byCause, conditions: frame.conditions.length, satisfied: frame.conditions.filter(value => !open(value)).length,
    // Satisfied only on an observation older than this ideal.set: a match to show, not to hide (v5).
    before_ideal: frame.conditions.filter(value => !open(value) && value.judgment.observation && Date.parse(value.judgment.observation.observedAt) < idealAt(frame.ideal)).length }
    : { open: null, by_cause: {}, conditions: null, satisfied: null, before_ideal: null } };
};

/** phase: purpose-changed / defining / approximating / matched (and ended once purpose.ended is recorded). */
export const phaseOf = (frame, gap) => frame.stage === 'ideal' ? (gap.parts.length ? 'approximating' : 'matched') : frame.stage;

/**
 * upkeep (S5, widened by S7): on every frame with an ideal, each condition met, with the observation the judge
 * chose and stale_at = observedAt + maxAge (still fresh at that instant: the judge's <=). No ideal: [].
 */
export const upkeepOf = frame => frame.conditions.filter(value => value.judgment.state === 'satisfied')
  .map(value => ({ condition: value.id, observedAt: value.judgment.observation.observedAt,
    stale_at: iso(Date.parse(value.judgment.observation.observedAt) + ms(value.maxAge)) }));

/** matched only: the earliest stale_at of the upkeep, after which the match is no longer known to hold. */
export const matchedUntil = (upkeep, phase) => phase === 'matched' ? upkeep.map(item => item.stale_at).sort()[0] : null;

/**
 * journal (v6): what was newly recorded in this frame, i.e. after the previous frame's t and up to this one,
 * in time order (contract 3 puts observations in the same book): decisions with their declared ids and
 * observations with observedAt and target. Not thinned; the ui accumulates the frames. An evaluation's
 * `past` is as of its own frame; later frames compare its purpose_rev/ideal_version with gap.basis.
 */
export const journalOf = (frame, after = -Infinity) => frame.journal.filter(event => Date.parse(event.recordedAt) > after).map(event => {
  if (event.kind === 'observation') return { kind: event.kind, recordedAt: event.recordedAt, observedAt: event.observedAt, actor: null,
    source: { ref: event.source, commentId: null, sha256: null }, target: { ...event.target }, value: event.value };
  // admission (adrs#647 comment 6265881722): shown only when the source has one; never part of a judgment.
  const source = { ref: event.source.ref, commentId: event.source.commentId == null ? null : number(event.source.commentId), sha256: event.source.digest,
    ...(event.source.admission ? { admission: event.source.admission } : {}) };
  const detail = {
    'purpose.set': () => ({ purpose_id: event.purpose.id, purpose_label: event.purpose.label, purpose_rev: event.rev }),
    'ideal.drafting': () => ({ purpose_id: event.purpose_id, ideal_version: event.version }),
    'ideal.set': () => ({ purpose_id: event.purpose_id, purpose_rev: event.purpose_rev, ideal_version: event.version }),
    'plan.set': () => ({ plan: event.plan ?? event.source.ref, version: number(event.version) }),
    // A later move of the Purpose rev or the ideal version turns the evaluation into a past one.
    'purpose.evaluated': () => ({ purpose_id: event.purpose_id, purpose_rev: event.purpose_rev, ideal_version: event.ideal_version,
      verdict: event.verdict, ...(event.note ? { note: event.note } : {}), frame: frameId({ asOf: iso(Date.parse(event.recordedAt)) }),
      past: !(event.purpose_id === frame.purpose.purpose.id && event.purpose_rev === frame.purpose.rev && event.ideal_version === frame.ideal?.version) }),
    'purpose.ended': () => ({ purpose_id: event.purpose_id }),
  }[event.kind]();
  return { kind: event.kind, recordedAt: event.recordedAt, ...(event.declaredAt ? { declaredAt: event.declaredAt } : {}), actor: event.actor ?? null, source, ...detail };
});

/**
 * frames[i].plans: absent when the frame's ideal state declares no plan (計画未宣言); [] when declared but
 * none recorded yet. Plans are not facts: display only, never past the frame asOf.
 */
export const plansOf = (frame, projection) => {
  if (!frame.ideal?.requires.some(condition => condition.plans?.length)) return undefined;
  const asOf = Date.parse(frame.asOf);
  return (projection.frames.find(value => value.asOf === frame.asOf)?.plans ?? [])
    .filter(plan => Date.parse(plan.recordedAt) <= asOf)
    .map(plan => ({ ref: plan.ref, plan: plan.plan, version: number(plan.version),
      label: `${plan.plan} v${plan.version} · ${plan.ref}${plan.source.commentId ? ' comment ' + plan.source.commentId : ''}`,
      serves: [...plan.serves], nodes: plan.nodes && plan.nodes.map(node => ({ id: node.id, label: node.label })),
      edges: plan.edges && plan.edges.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind })), unknown: [...(plan.unknown ?? [])],
      source: { repo: plan.source.ref, commentId: plan.source.commentId && number(plan.source.commentId), updatedAt: plan.source.updatedAt, sha256: plan.source.digest } }));
};

/**
 * L3 (adrs#647): G plan.set events no ideal state declares, as journal rows marked `unbound: true`, display only
 * (never in D, the plans, the gap or any count). Deduplicated by (plan, version, source sha256), the earliest kept;
 * each goes to the first frame with prev.asOf < recordedAt <= asOf. Those after the last frame are only counted.
 */
export const unboundPlans = (frames, unbound = []) => {
  const seen = new Set(), placed = frames.map(() => []);
  let unplaced = 0;
  for (const g of [...unbound].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))) {
    const key = JSON.stringify([g.plan, g.version, g.source?.sha256]);
    if (seen.has(key)) continue;
    seen.add(key);
    const index = frames.findIndex(frame => Date.parse(g.recordedAt) <= Date.parse(frame.asOf));
    if (index < 0) { unplaced += 1; continue; }
    placed[index].push({ kind: 'plan.set', recordedAt: g.recordedAt, actor: g.actor ?? null,
      source: { ref: g.source.repo, commentId: g.source.commentId ?? null, sha256: g.source.sha256 }, plan: g.plan, version: g.version, unbound: true });
  }
  return { placed, unplaced };
};

/**
 * GapA (contract v12): frames[i].adequacy {basis, state, reason, evidence}. Only a human evaluation of the
 * same Purpose rev and ideal version (compared as written) that says ideal-insufficient is unmet; every
 * other reason is unknown and nothing here is counted. The first reason that applies, in this order.
 */
export const adequacyOf = (frame, gap, phase) => {
  const pid = frame.purpose.purpose.id;
  const latest = frame.journal.filter(event => event.kind === 'purpose.evaluated' && event.purpose_id === pid).at(-1) ?? null;
  const reason = frame.stage === 'ended' ? 'purpose-ended' : !frame.ideal ? 'no-ideal' : !latest ? 'no-evaluation'
    : latest.purpose_rev !== frame.purpose.rev || latest.ideal_version !== frame.ideal.version ? 'past'
      : latest.verdict === 'ideal-insufficient' ? 'evaluated'
        : latest.verdict === 'not-yet' && phase === 'matched' ? 'not-yet-while-matched'
          : latest.verdict === 'achieved' && gap.parts.length > 0 ? 'achieved-while-open' : 'no-adequacy-verdict';
  const { purpose_id, purpose_rev, ideal_version } = gap.basis;
  return { basis: { purpose_id, purpose_rev, ideal_version }, state: reason === 'evaluated' ? 'unmet' : 'unknown', reason,
    evidence: latest && { recordedAt: latest.recordedAt, ...(latest.declaredAt ? { declaredAt: latest.declaredAt } : {}), actor: latest.actor ?? null,
      source: { ref: latest.source.ref, commentId: latest.source.commentId == null ? null : number(latest.source.commentId), sha256: latest.source.digest,
        ...(latest.source.admission ? { admission: latest.source.admission } : {}) },
      purpose_id: latest.purpose_id, purpose_rev: latest.purpose_rev, ideal_version: latest.ideal_version, verdict: latest.verdict,
      ...(latest.note ? { note: latest.note } : {}) } };
};

/**
 * frames[i].held (contract v12): the declarations held back before D (live.mjs g-journal-held.jsonl; held
 * plans are not declarations, and unbound plans are shown by the journal), each in the first frame with
 * prev.asOf < recordedAt <= asOf. Those after the last frame are only counted (unplaced). Display only.
 */
// The held reasons (contract v12 values): D's codes for a declaration refused in sequence (else
// invalid-declaration), the join's own, and the collector's. Stable words, never a message with a line number.
export const HELD_REASONS = Object.freeze([
  'ideal-version-already-set', 'ideal-purpose-rev-mismatch', 'purpose-not-active', 'purpose-rev-redefined', 'purpose-rev-already-active',
  'evaluation-not-declared', 'recorded-at-backwards', 'invalid-declaration',
  'proposal', 'actor-not-authorized', 'evaluator-only', 'evaluator-not-declared', 'superseded-by-cold', 'worklog-target-in-predicate', 'eval-form',
  'invalid-json', 'unknown-kind', 'author-unknown', 'actor-mismatch', 'recordedAt-invalid', 'recordedAt-after-source', 'declaration-unreadable',
  'cold: invalid-json', 'cold: schema', 'cold: content-sha256-missing', 'cold: content-sha256-unverifiable', 'cold: content-sha256-mismatch',
  'cold: raw-id-mismatch', 'cold: subject-id-author-or-body-missing', 'cold: updated-at-missing',
  // C5 stage 1 (adrs#647 v4 c6335921034): evaluations only from the owner input source (collect/owner.mjs).
  'evaluation-not-from-owner', 'owner-mismatch', 'owner-not-read', 'decision-from-comment', 'owner-unreadable', 'owner-readback-missing',
  'owner-credentials-changed', 'owner-before-readback', 'owner-other-author', 'owner-via-app',
  // P's records (collect/precord.mjs, apps#158; the ledger's p-record-rewritten): adrs#647 c6346827237.
  'p-record: invalid-json', 'p-record: schema', 'p-record: kind', 'p-record: fields', 'p-record: id', 'p-record: at', 'p-record: value',
  'p-record: duplicate-id', 'p-record: p-record-in-comment', 'p-record-rewritten']);
// A work claim the collector held (current: / worklog:, e.g. overwritten) is an L2 observation, not a declaration.
const claim = reason => /^(?:current|worklog): /u.test(reason);
const heldKind = entry => {
  if (entry.kind !== 'journal.held') return entry.kind ?? null;
  try { const kind = JSON.parse(entry.line)?.kind; return typeof kind === 'string' ? kind : null; } catch { return null; }
};
export const heldEntries = (frames, all = []) => {
  const placed = frames.map(() => []), held = all.filter(value => !claim(value.reason));
  let unplaced = 0;
  for (const { reason, journal: entry } of [...held].sort((a, b) => Date.parse(a.journal.recordedAt) - Date.parse(b.journal.recordedAt))) {
    const index = frames.findIndex(frame => Date.parse(entry.recordedAt) <= Date.parse(frame.asOf));
    if (index < 0) { unplaced += 1; continue; }
    const source = entry.source ?? {};
    // Only the closed words are shown: anything else (a new or raw reason) is invalid-declaration.
    placed[index].push({ reason: HELD_REASONS.includes(reason) ? reason : 'invalid-declaration', kind: heldKind(entry), recordedAt: entry.recordedAt,
      source: { ref: source.ref ?? source.repo, commentId: source.commentId == null ? null : number(String(source.commentId)), sha256: source.sha256 ?? source.digest ?? null } });
  }
  return { placed, unplaced, count: held.length };
};

/**
 * frames[i].p_records (adrs#647 c6346827237, ui#387): P's records from the ledger (p.record rows, dated by their
 * ledgerAt), each in the first frame with prev.asOf < recordedAt <= asOf, as the ui reads them: the record's own
 * fields, authority false (P's claim) and its source. One that entered after the last frame waits for the next
 * frame (only counted until then), as an unbound plan or a held row does; none is put into an earlier frame.
 */
export const pRecordsAt = (frames, events = []) => {
  const placed = frames.map(() => []);
  let unplaced = 0;
  for (const event of [...events].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))) {
    const index = frames.findIndex(frame => Date.parse(event.recordedAt) <= Date.parse(frame.asOf));
    if (index < 0) { unplaced += 1; continue; }
    placed[index].push({ ...event.record, authority: false, source: { ref: event.source.ref, sha256: event.source.sha256, line: event.source.line } });
  }
  return { placed, unplaced };
};

/** The World as ui reads it: D's World plus the edge contracts. Each frame uses only itself and earlier frames. */
export const contractWorld = (result, { unbound = [], held = [], pRecords = [] } = {}) => {
  let last = null, previous = null;
  const { placed } = unboundPlans(result.world.frames, unbound);
  const { placed: heldAt } = heldEntries(result.world.frames, held);
  const { placed: recordsAt } = pRecordsAt(result.world.frames, pRecords);
  const byTime = list => list.map((entry, index) => ({ entry, index }))
    .sort((a, b) => Date.parse(a.entry.recordedAt) - Date.parse(b.entry.recordedAt) || a.index - b.index).map(value => value.entry);
  return { ...result.world, frames: result.world.frames.map((frame, index) => {
    const derived = result.derived.frames[index], gap = gapOf(derived, last, previous), phase = phaseOf(derived, gap);
    const own = journalOf(derived, previous ? previous.frame.t : -Infinity);
    const journal = placed[index].length ? byTime([...own, ...placed[index]]) : own;
    previous = { frame: derived, gap };
    if (gap.parts) last = previous;
    const plans = plansOf(derived, result.plans);
    const upkeep = upkeepOf(derived);
    return { ...frame, ...(plans ? { plans } : {}), gap, phase, journal, matched_until: matchedUntil(upkeep, phase), upkeep,
      adequacy: adequacyOf(derived, gap, phase), held: heldAt[index],
      // Only on a frame that has some, so a World without P's records is the same as before (an older ui reads it).
      ...(recordsAt[index].length ? { p_records: recordsAt[index] } : {}) };
  }) };
};
