// The World write edge: the only module that knows the ui contracts frames[i].plans and
// frames[i].gap (shared by apps and ui). D's derived frames go in; nothing here judges.
import { createHash } from 'node:crypto';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const open = condition => condition.judgment.state !== 'satisfied';
const frameId = frame => `t@${frame.asOf}`;
const number = value => /^\d+$/u.test(value) ? Number(value) : value; // G numbers that D keeps as tokens
// D judgment reason → the current-side cause of an open condition (no observation usable / stale).
const CURRENT = { 'no-observation': 'current-unobserved', unmatchable: 'current-unobserved',
  'conflicting-observations': 'current-unobserved', stale: 'current-stale' };
const state = condition => condition.judgment.state === 'unmet' ? 'unmet' : 'unknown';
const ideal = condition => [condition.predicate, condition.maxAge];

/**
 * Decompose the difference of one derived frame against the previous one, by id only.
 * Precedence: initial, purpose-changed, ideal-added, ideal-revised; then the current side
 * (regressed / unobserved / stale); carried when the open difference continues unchanged.
 */
export const gapOf = (frame, prev, gapOfPrev = null) => {
  const purpose = frame.purpose.purpose.id, samePurpose = prev && prev.purpose.purpose.id === purpose;
  const before = new Map((samePurpose ? prev.conditions : []).map(value => [value.id, value]));
  const openBefore = new Set((prev?.conditions ?? []).filter(open).map(value => value.id));
  const sinceBefore = new Map((gapOfPrev?.parts ?? []).map(part => [part.condition, part.since]));
  const refs = condition => [...new Set(frame.plans.filter(plan => condition.plans?.includes(plan.plan)).map(plan => plan.ref))].sort();
  const parts = frame.conditions.filter(open).map(value => {
    const old = before.get(value.id), revised = old && !same(ideal(old), ideal(value));
    const cause = !prev ? 'initial' : !samePurpose ? 'purpose-changed' : !old ? 'ideal-added' : revised ? 'ideal-revised'
      : old.judgment.state === 'satisfied' && value.judgment.state === 'unmet' ? 'current-regressed'
      : openBefore.has(value.id) && old.judgment.state === value.judgment.state && old.judgment.reason === value.judgment.reason ? 'carried'
      : value.judgment.state === 'unknown' || value.judgment.state === 'conflict' ? CURRENT[value.judgment.reason]
      : 'carried'; // unknown → unmet under the same ideal: the open difference continues, now observed
    // The difference keeps its opening frame while it stays open under the same ideal condition.
    const since = old && !revised && openBefore.has(value.id) ? sinceBefore.get(value.id) ?? frameId(prev) : frameId(frame);
    return { condition: value.id, state: state(value), cause: [cause], since,
      scope: value.responsibility.state === 'assigned' ? `scope.${value.id}` : null, refs: refs(value) };
  });
  const now = new Map(frame.conditions.map(value => [value.id, value]));
  const closed = [...openBefore].filter(id => !parts.some(part => part.condition === id)).map(id => ({ condition: id, at: frameId(frame),
    by: !samePurpose ? 'purpose-changed' : now.has(id) ? 'current-satisfied' : 'ideal-removed' }));
  const byCause = {};
  for (const part of parts) for (const cause of part.cause) byCause[cause] = (byCause[cause] ?? 0) + 1;
  return { basis: { purpose_id: purpose, purpose_rev: 'sha256:' + createHash('sha256').update(JSON.stringify(frame.purpose.purpose)).digest('hex'),
    ideal_version: frame.purpose.version, prev_frame: prev ? frameId(prev) : null },
  parts, closed, summary: { open: parts.length, by_cause: byCause } };
};

/** frames[i].gap for every World frame, each computed once from its own and the previous derived frame. */
export const withGap = (world, derived) => {
  let previous = null;
  const gaps = derived.frames.map((frame, index) => (previous = gapOf(frame, derived.frames[index - 1] ?? null, previous)));
  return { ...world, frames: world.frames.map((frame, index) => ({ ...frame, gap: gaps[index] })) };
};

/**
 * frames[i].plans: absent when no purpose.set at that frame declares a plan (計画未宣言); [] when
 * declared but none recorded yet. Plans are not facts: display only, never past the frame asOf.
 */
export const withPlans = (world, projection, purposes) => ({ ...world, frames: world.frames.map(frame => {
  const asOf = Date.parse(frame.asOf);
  const purpose = purposes.filter(value => Date.parse(value.recordedAt) <= asOf).at(-1);
  if (!purpose?.requires.some(condition => condition.plans?.length)) return frame;
  const plans = (projection.frames.find(value => value.asOf === frame.asOf)?.plans ?? [])
    .filter(plan => Date.parse(plan.recordedAt) <= asOf)
    .map(plan => ({ ref: plan.ref, plan: plan.plan, version: number(plan.version),
      label: `${plan.plan} v${plan.version} · ${plan.ref}${plan.source.commentId ? ' comment ' + plan.source.commentId : ''}`,
      serves: [...plan.serves], nodes: plan.nodes && plan.nodes.map(node => ({ id: node.id, label: node.label })),
      edges: plan.edges && plan.edges.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind })), unknown: [...(plan.unknown ?? [])],
      source: { repo: plan.source.ref, commentId: plan.source.commentId && number(plan.source.commentId), updatedAt: plan.source.updatedAt, sha256: plan.source.digest } }));
  return { ...frame, plans };
}) });

/** The World as ui reads it: D's World plus the two edge contracts. */
export const contractWorld = result => {
  const purposes = [...new Set(result.derived.frames.map(frame => frame.purpose))];
  return withGap(withPlans(result.world, result.plans, purposes), result.derived);
};
