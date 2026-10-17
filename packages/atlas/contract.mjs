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
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;
const ms = value => { const [d, h, m, s] = DURATION.exec(value).slice(1).map(part => Number(part ?? 0)); return (((d * 24 + h) * 60 + m) * 60 + s) * 1000; };

// The current side (v6): why the current state does not meet the condition now, at most one, never hidden
// by an ideal-side cause. An unmet condition only has one when it changed against the same, unrevised
// condition before (regressed / confirmed); an unknown one always says why it is unknown.
const currentCause = (before, now) => {
  if (now.state === 'unmet') return !before ? null : before.state === 'satisfied' ? 'current-regressed'
    : before.state === 'unmet' ? null : 'current-confirmed-unmet';
  if (now.state === 'conflict') return 'current-conflict';
  // Arrived but not comparable with the predicate (unmatchable) is not the same as nothing arrived.
  return now.reason === 'stale' ? 'current-stale' : now.reason === 'unmatchable' ? 'current-unmatchable' : 'current-unobserved';
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
    const cause = { ideal: !last ? 'initial' : !sameKey ? 'purpose-changed' : !old ? 'ideal-added' : revised ? 'ideal-revised' : null,
      current: currentCause(old && !revised && sameKey ? old.judgment : null, value.judgment) };
    const observedAt = value.judgment.observation?.observedAt;
    return { condition: value.id, label: value.label, state: state(value), cause,
      // A difference declared again (same Purpose id, same condition, unrevised) continues from its opening frame.
      since: old && !revised && since.has(value.id) ? since.get(value.id) : frameId(frame),
      scope: value.responsibility.state === 'assigned' ? `scope.${value.id}` : null, refs: refs(value),
      ...(observedAt && Date.parse(observedAt) < Date.parse(frame.ideal.recordedAt) ? { observed_before_ideal: true } : {}) };
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
  // Both sides are counted; carried = neither side has a reason now (the same open difference continues).
  for (const part of parts ?? []) for (const cause of [part.cause.ideal, part.cause.current].filter(Boolean)
    .concat(part.cause.ideal || part.cause.current ? [] : ['carried'])) byCause[cause] = (byCause[cause] ?? 0) + 1;
  return { basis: { purpose_id: frame.purpose.purpose.id, purpose_rev: frame.purpose.rev, purpose_label: frame.purpose.purpose.label,
    ideal_version: frame.ideal?.version ?? null, prev_frame: last ? frameId(last.frame) : null },
  parts, closed, summary: parts ? { open: parts.length, by_cause: byCause, conditions: frame.conditions.length, satisfied: frame.conditions.filter(value => !open(value)).length,
    // Satisfied only on an observation older than this ideal.set: a match to show, not to hide (v5).
    before_ideal: frame.conditions.filter(value => !open(value) && value.judgment.observation && Date.parse(value.judgment.observation.observedAt) < Date.parse(frame.ideal.recordedAt)).length }
    : { open: null, by_cause: {}, conditions: null, satisfied: null, before_ideal: null } };
};

/** phase: purpose-changed / defining / approximating / matched (and ended once purpose.ended is recorded). */
export const phaseOf = (frame, gap) => frame.stage === 'ideal' ? (gap.parts.length ? 'approximating' : 'matched') : frame.stage;

/** matched: the earliest observedAt + maxAge, after which the match is no longer known to hold. */
export const matchedUntil = (frame, phase) => phase !== 'matched' ? null
  : iso(Math.min(...frame.conditions.map(value => Date.parse(value.judgment.observation.observedAt) + ms(value.maxAge))));

/**
 * journal (v6): what was newly recorded in this frame, i.e. after the previous frame's t and up to this one,
 * in time order (contract 3 puts observations in the same book): decisions with their declared ids and
 * observations with observedAt and target. Not thinned; the ui accumulates the frames. An evaluation's
 * `past` is as of its own frame; later frames compare its purpose_rev/ideal_version with gap.basis.
 */
export const journalOf = (frame, after = -Infinity) => frame.journal.filter(event => Date.parse(event.recordedAt) > after).map(event => {
  if (event.kind === 'observation') return { kind: event.kind, recordedAt: event.recordedAt, observedAt: event.observedAt, actor: null,
    source: { ref: event.source, commentId: null, sha256: null }, target: { ...event.target } };
  const source = { ref: event.source.ref, commentId: event.source.commentId == null ? null : number(event.source.commentId), sha256: event.source.digest };
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
  return { kind: event.kind, recordedAt: event.recordedAt, actor: event.actor ?? null, source, ...detail };
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

/** The World as ui reads it: D's World plus the edge contracts. Each frame uses only itself and earlier frames. */
export const contractWorld = result => {
  let last = null, previous = null;
  return { ...result.world, frames: result.world.frames.map((frame, index) => {
    const derived = result.derived.frames[index], gap = gapOf(derived, last, previous), phase = phaseOf(derived, gap);
    const journal = journalOf(derived, previous ? previous.frame.t : -Infinity);
    previous = { frame: derived, gap };
    if (gap.parts) last = previous;
    const plans = plansOf(derived, result.plans);
    return { ...frame, ...(plans ? { plans } : {}), gap, phase, journal, matched_until: matchedUntil(derived, phase) };
  }) };
};
