// Event-sourced Atlas derivation. Only journal decisions (adrs#647), plan.set and observations
// go in; Gap, Scope state and responsibility are derived per frame t. No clock, filesystem,
// network, name/prefix inference or decision authority is introduced here.
import { createHash } from 'node:crypto';
import { reduceClosure } from './closure.mjs';
import { semanticScopeWorld } from './semantic-scope-world.mjs';

export const EVENTS_SCHEMA = 'atlas.events/1';
export const CONTROL_SCHEMA = 'atlas.control-norms/1';
export const PLAN_PROJECTION_SCHEMA = 'atlas.plan-projection/1';
const fail = message => { throw new Error('atlas-events: ' + message); };
const demand = (condition, message) => { if (!condition) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const token = value => text(value) && !/[\s\u0000-\u001f\u007f]/u.test(value);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
const sha = value => /^sha256:[a-f0-9]{64}$/u.test(value);
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const time = (value, at) => {
  demand(typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value)), `${at}: UTC timestamp required`);
  return Date.parse(value);
};
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;
const duration = (value, at) => {
  const match = typeof value === 'string' ? DURATION.exec(value) : null;
  const [d, h, m, s] = (match ?? []).slice(1).map(part => Number(part ?? 0));
  const ms = (((d * 24 + h) * 60 + m) * 60 + s) * 1000;
  demand(match && ms > 0, `${at}: maxAge must be a positive ISO 8601 duration (PnDTnHnMnS)`);
  return ms;
};
const keys = (value, required, optional, at) => {
  demand(object(value), `${at}: expected an object`);
  const present = Object.keys(value);
  demand(required.every(key => present.includes(key)) && present.every(key => required.includes(key) || optional.includes(key)),
    `${at}: expected exactly ${required.join(', ')}${optional.length ? ` (optional ${optional.join(', ')})` : ''}`);
};
const ids = (values, at, empty = false) => {
  demand(Array.isArray(values) && (empty || values.length > 0) && values.every(token) && new Set(values).size === values.length,
    `${at}: expected ${empty ? '' : 'nonempty '}unique id list`);
  return values;
};

// JSON.parse silently keeps the last duplicate key; reject that ambiguity (same rule as the Closure reader).
const parse = (line, at) => {
  let value;
  try { value = JSON.parse(line); } catch { fail(`${at}: invalid JSON`); }
  const stack = [];
  for (const part of line.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/gu)) {
    const piece = part[0];
    if (piece === '{') stack.push(new Set());
    else if (piece === '[') stack.push(null);
    else if (piece === '}' || piece === ']') stack.pop();
    else if (/^\s*:/u.test(line.slice(part.index + piece.length))) {
      const key = JSON.parse(piece), owner = stack.at(-1);
      demand(owner && !owner.has(key), `${at}: duplicate JSON key ${key}`);
      owner.add(key);
    }
  }
  return value;
};
const lines = (input, at) => {
  demand(typeof input === 'string', `${at}: expected JSONL text`);
  const rows = input.split(/\r?\n/u).map((line, index) => ({ line, at: `${at}:${index + 1}` })).filter(({ line }) => line.trim());
  demand(rows.length > 0, `${at}: empty document`);
  return rows.map(({ line, at: where }) => ({ value: parse(line, where), at: where }));
};

const stateTarget = (value, at) => {
  keys(value, ['kind', 'id'], [], at);
  demand(['state', 'owner', 'session'].includes(value.kind) && token(value.id), `${at}: target kind state|owner|session and id required`);
  return value;
};
const predicate = (value, at) => {
  keys(value, ['target', 'op', 'value'], [], at);
  demand(stateTarget(value.target, `${at}.target`).kind === 'state', `${at}: a condition predicate observes a state target`);
  if (value.op === 'equals') demand(scalar(value.value), `${at}: equals needs a scalar`);
  else demand(value.op === 'oneOf' && Array.isArray(value.value) && value.value.length > 0 && value.value.every(scalar), `${at}: op equals|oneOf required`);
  return value;
};

// Journal decisions (adrs#647 contract 3): who decided what, when, from which source.
const VERDICTS = ['achieved', 'not-yet', 'ideal-insufficient'];
const decision = (event, required, optional, at) => {
  keys(event, ['kind', 'recordedAt', 'source', ...required], ['actor', 'declaredAt', ...optional], at);
  // declaredAt (v10): the decision's own time when it entered the ledger later (recordedAt is then the ledgerAt).
  if ('declaredAt' in event) demand(time(event.declaredAt, `${at}.declaredAt`) <= Date.parse(event.recordedAt), `${at}: declaredAt is after recordedAt`);
  keys(event.source, ['ref', 'digest'], ['commentId'], `${at}.source`);
  demand(token(event.source.ref) && sha(event.source.digest) && ((event.source.commentId ?? null) === null || token(event.source.commentId)),
    `${at}: source ref, sha256 digest (and commentId) required`);
  if ('actor' in event) demand(text(event.actor), `${at}: actor must be text`);
};
const requiresList = (requires, at) => {
  // At least one condition: an ideal state without conditions would read as matched while meeting nothing.
  demand(Array.isArray(requires) && requires.length > 0, `${at}: requires must be nonempty`);
  requires.forEach((value, index) => {
    const where = `${at}.requires[${index}]`;
    keys(value, ['id', 'label', 'predicate', 'maxAge', 'norm'], ['plans'], where);
    // plans: the plan identities the Purpose author declares for this condition (never inferred).
    if ('plans' in value) ids(value.plans, `${where}.plans`);
    demand(token(value.id) && text(value.label) && token(value.norm), `${where}: id/label/norm required`);
    predicate(value.predicate, `${where}.predicate`);
    duration(value.maxAge, `${where}.maxAge`);
  });
  ids(requires.map(value => value.id), `${at}.requires ids`);
};
const purpose = (value, at) => {
  keys(value, ['id', 'label'], [], at);
  demand(token(value.id) && text(value.label), `${at}: purpose id/label required`);
};
const DECISIONS = {
  // Legacy form: one declaration carries the Purpose and its ideal state (normalized below).
  'purpose.set': (event, at) => {
    if ('requires' in event) {
      decision(event, ['purpose', 'version', 'label', 'requires'], [], at);
      demand(token(event.version) && text(event.label), `${at}: version/label required`);
      requiresList(event.requires, at);
    } else {
      decision(event, ['purpose', 'rev'], [], at);
      demand(token(event.rev), `${at}: rev must be a token`);
    }
    purpose(event.purpose, `${at}.purpose`);
  },
  'ideal.drafting': (event, at) => {
    decision(event, ['purpose_id', 'version'], [], at);
    demand(token(event.purpose_id) && token(event.version), `${at}: purpose_id/version required`);
  },
  'ideal.set': (event, at) => {
    decision(event, ['purpose_id', 'purpose_rev', 'version', 'requires'], ['label'], at);
    demand(token(event.purpose_id) && token(event.purpose_rev) && token(event.version) && (event.label === undefined || text(event.label)),
      `${at}: purpose_id/purpose_rev/version required`);
    requiresList(event.requires, at);
  },
  'purpose.evaluated': (event, at) => {
    decision(event, ['purpose_id', 'purpose_rev', 'ideal_version', 'verdict'], ['note'], at);
    demand(token(event.purpose_id) && token(event.purpose_rev) && token(event.ideal_version) && VERDICTS.includes(event.verdict),
      `${at}: purpose_id/purpose_rev/ideal_version and verdict ${VERDICTS.join('|')} required`);
  },
  'purpose.ended': (event, at) => {
    decision(event, ['purpose_id'], ['note'], at);
    demand(token(event.purpose_id), `${at}: purpose_id required`);
  },
};
const observation = (event, at) => {
  keys(event, ['kind', 'recordedAt', 'target', 'value', 'source', 'observedAt'], ['projection'], at);
  // projection: this is another view of an observation already in the log (not a second fact).
  if ('projection' in event) demand(event.projection === true, `${at}: projection must be true when present`);
  stateTarget(event.target, `${at}.target`);
  // null is D's marker for an observation that obtained no value (never compared with a predicate).
  demand(event.value !== undefined, `${at}: observed value (or null: no value obtained) required`);
  demand(text(event.source), `${at}: observation source required`);
  demand(time(event.observedAt, `${at}.observedAt`) <= Date.parse(event.recordedAt), `${at}: observedAt is after recordedAt (future fact)`);
};
const PLAN_REF = /^[A-Za-z0-9._/-]+#\d+$/u;
// A plan is identified by its declared id, else by its source locator (one plan per Issue/PR).
const planId = event => event.plan ?? event.source.ref;
// D's own marker for a declared plan whose graph its source does not carry: nodes and edges null.
const opaque = event => event.nodes === null && event.edges === null;
const reaches = (deps, from, to) => { // from ->* to through dep edges
  const seen = new Set([from]), queue = [from];
  while (queue.length) {
    const next = queue.shift();
    for (const edge of deps) if (edge.from === next && !seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
  }
  return seen.has(to);
};
const planSet = (event, at) => {
  keys(event, ['kind', 'recordedAt', 'purposeRef', 'source', 'version', 'nodes', 'edges'], ['plan', 'unknown', 'actor'], at);
  if ('actor' in event) demand(text(event.actor), `${at}: actor must be text`);
  if ('plan' in event) demand(token(event.plan), `${at}: plan id must be a token`);
  if ('unknown' in event) demand(Array.isArray(event.unknown) && event.unknown.every(text), `${at}: unknown must list reasons`);
  keys(event.purposeRef, ['purposeId', 'version'], [], `${at}.purposeRef`);
  demand(token(event.purposeRef.purposeId) && token(event.purposeRef.version) && token(event.version), `${at}: purposeRef/version required`);
  keys(event.source, ['ref', 'commentId', 'updatedAt', 'digest'], [], `${at}.source`);
  demand(PLAN_REF.test(event.source.ref) && (event.source.commentId === null || token(event.source.commentId)) && sha(event.source.digest),
    `${at}: source repo#number, commentId|null and sha256 digest required`);
  demand(time(event.source.updatedAt, `${at}.source.updatedAt`) <= Date.parse(event.recordedAt), `${at}: source updatedAt is after recordedAt (future fact)`);
  // A declared plan whose graph its source does not carry: kept as UNKNOWN content, never as no plan.
  if (opaque(event)) return;
  demand(Array.isArray(event.nodes) && event.nodes.length > 0 && Array.isArray(event.edges), `${at}: nodes[] and edges[] (or both null: content unknown) required`);
  for (const [index, node] of event.nodes.entries()) {
    const where = `${at}.nodes[${index}]`;
    keys(node, ['id', 'label', 'norm', 'exit', 'contributesTo'], ['predicateRefs', 'due'], where);
    // The qualifier is the declared source locator itself, not a name heuristic.
    demand(token(node.id) && node.id.startsWith(event.source.ref + ':') && node.id.length > event.source.ref.length + 1,
      `${where}: node id must be qualified as ${event.source.ref}:<id>`);
    demand(text(node.label) && token(node.norm) && text(node.exit), `${where}: label/norm/exit required`);
    ids(node.contributesTo, `${where}.contributesTo`);
    if ('predicateRefs' in node) ids(node.predicateRefs, `${where}.predicateRefs`);
    if ('due' in node) time(node.due, `${where}.due`);
  }
  const nodeIds = new Set(ids(event.nodes.map(node => node.id), `${at}.nodes ids`));
  for (const [index, edge] of event.edges.entries()) {
    const where = `${at}.edges[${index}]`;
    keys(edge, ['from', 'to', 'kind'], ['condition'], where);
    demand(nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to, `${where}: from/to must be distinct declared nodes`);
    demand(['dep', 'loop', 'branch'].includes(edge.kind), `${where}: kind dep|loop|branch required`);
    if ('condition' in edge) demand(text(edge.condition), `${where}: condition must be text`);
  }
  const deps = event.edges.filter(edge => edge.kind === 'dep');
  demand(deps.every(edge => !reaches(deps, edge.to, edge.from)), `${at}: dep edges must be acyclic (declare re-entry as loop)`);
  demand(event.edges.filter(edge => edge.kind === 'loop').every(edge => reaches(deps, edge.to, edge.from)), `${at}: loop must return to a dep-ancestor`);
};

/**
 * Parse the event log. Any invalid, unordered or future event fails closed. A legacy purpose.set
 * that carries requires is normalized into purpose.set (only when the Purpose or its label
 * changes; rev = the version that first declared that label) followed by ideal.set.
 */
export const parseEvents = input => {
  const [first, ...rest] = lines(input, 'events');
  keys(first.value, ['schema', 'authority', 'source_mode'], [], `${first.at} header`);
  demand(first.value.schema === EVENTS_SCHEMA && first.value.authority === false && ['synthetic', 'supplied'].includes(first.value.source_mode),
    'unsupported events schema/authority/source_mode');
  let last = -Infinity, active = null, ended = false;
  const versions = new Map(), plans = new Map(), revs = new Map(); // revs: purpose id → Map(rev → label)
  const conflicts = new Map(); // `<plan>@<version>` → reason, once that version was redefined with other content
  const label = (id, rev) => revs.get(id)?.get(rev);
  const setPurpose = (event, at) => {
    const known = revs.get(event.purpose.id) ?? new Map();
    demand(!known.has(event.rev) || known.get(event.rev) === event.purpose.label, `${at}: Purpose ${event.purpose.id} rev ${event.rev} redefined`);
    demand(ended || !active || active.purpose.id !== event.purpose.id || active.rev !== event.rev, `${at}: Purpose ${event.purpose.id} rev ${event.rev} is already active`);
    known.set(event.rev, event.purpose.label); revs.set(event.purpose.id, known);
    active = event; ended = false;
    return event;
  };
  const current = (id, at) => demand(active && !ended && active.purpose.id === id, `${at}: ${id} is not the active Purpose`);
  const events = rest.flatMap(({ value: event, at }) => {
    demand(object(event) && (event.kind in DECISIONS || ['plan.set', 'observation'].includes(event.kind)), `${at}: unknown event kind`);
    const recorded = time(event.recordedAt, `${at}.recordedAt`);
    demand(recorded >= last, `${at}: recordedAt goes backwards (log must be append-ordered)`);
    last = recorded;
    if (event.kind in DECISIONS) DECISIONS[event.kind](event, at);
    switch (event.kind) {
      case 'purpose.set': {
        if (!('requires' in event)) return [setPurpose(event, at)];
        const { requires, version, label: idealLabel, purpose: declared, ...common } = event;
        const rev = [...(revs.get(declared.id) ?? new Map())].find(([, value]) => value === declared.label)?.[0] ?? version;
        const head = !ended && active?.purpose.id === declared.id && active.rev === rev ? [] : [setPurpose({ ...common, purpose: declared, rev }, at)];
        return [...head, ideal({ ...common, kind: 'ideal.set', purpose_id: declared.id, purpose_rev: rev, version, label: idealLabel, requires }, at)];
      }
      case 'ideal.drafting': current(event.purpose_id, at); return [event];
      case 'ideal.set': return [ideal(event, at)];
      case 'purpose.evaluated':
        demand(label(event.purpose_id, event.purpose_rev) !== undefined && versions.get(event.ideal_version)?.purpose_id === event.purpose_id,
          `${at}: evaluated Purpose rev or ideal version not declared before`);
        return [event];
      case 'purpose.ended': current(event.purpose_id, at); ended = true; return [event];
      case 'observation': observation(event, at); return [event];
      default: return [plan(event, at)];
    }
  });
  function ideal(event, at) {
    current(event.purpose_id, at);
    demand(active.rev === event.purpose_rev, `${at}: ideal.set names purpose_rev ${event.purpose_rev}, active is ${active.rev}`);
    demand(!versions.has(event.version), `${at}: ideal version ${event.version} already set`);
    versions.set(event.version, event);
    return event;
  }
  function plan(event, at) {
    planSet(event, at);
    const purpose = versions.get(event.purposeRef.version);
    demand(purpose && event.purposeRef.purposeId === purpose.purpose_id, `${at}: purposeRef names no ideal.set recorded before it`);
    const required = new Set(purpose.requires.map(value => value.id));
    for (const node of opaque(event) ? [] : event.nodes) demand([...node.contributesTo, ...(node.predicateRefs ?? [])].every(id => required.has(id)),
      `${at}: ${node.id} references a condition outside ${event.purposeRef.version}`);
    const previous = plans.get(planId(event)) ?? [];
    const prior = previous.at(-1);
    demand(!prior || Date.parse(event.source.updatedAt) >= Date.parse(prior.source.updatedAt), `${at}: plan body updatedAt goes backwards`);
    // A body's updatedAt also moves with new comments; the same version must keep the same content.
    const content = value => canonical({ ...value, recordedAt: null, source: { ...value.source, updatedAt: null } });
    demand(!prior || prior.source.updatedAt !== event.source.updatedAt || prior.source.digest === event.source.digest,
      `${at}: same plan body time with another digest`);
    plans.set(planId(event), [...previous, event]);
    // The same version with other content (a body edited in place): not fatal for the whole World. From here on
    // that plan version is held as a conflict: content UNKNOWN, neither definition used, even if one comes back.
    const key = `${planId(event)}@${event.version}`;
    if (!conflicts.has(key) && previous.every(value => value.version !== event.version || content(value) === content(event))) return event;
    if (!conflicts.has(key)) conflicts.set(key, `conflicting-redefinition: plan version ${event.version} redefined (${
      [...new Set([...previous.filter(value => value.version === event.version), event].map(value => value.source.digest))].join(' / ')})`);
    return { ...event, nodes: null, edges: null, unknown: [conflicts.get(key)] };
  }
  demand(events.some(event => event.kind === 'purpose.set'), 'no purpose.set event');
  return { header: first.value, events };
};

/** Norm stand-in projected from ADRS control.jsonl: R/W actors and the declared binding. */
export const parseControl = input => {
  const [first, ...rest] = lines(input, 'control');
  keys(first.value, ['schema', 'authority'], [], `${first.at} header`);
  demand(first.value.schema === CONTROL_SCHEMA && first.value.authority === false, 'unsupported control schema/authority');
  const norms = new Map();
  for (const { value, at } of rest) {
    keys(value, ['kind', 'id', 'R', 'W', 'binding'], [], at);
    demand(value.kind === 'norm' && token(value.id) && !norms.has(value.id), `${at}: unique norm id required`);
    ids(value.R, `${at}.R`, true); ids(value.W, `${at}.W`, true);
    keys(value.binding, ['purposeId', 'conditions'], [], `${at}.binding`);
    demand(token(value.binding.purposeId), `${at}: binding purposeId required`);
    ids(value.binding.conditions, `${at}.binding.conditions`, true);
    norms.set(value.id, value);
  }
  return norms;
};

// ---- Derivation at a time t: only events with recordedAt <= t are visible. ----
const visible = (events, t) => events.filter(event => Date.parse(event.recordedAt) <= t);
const latest = (events, kind, id) => {
  const found = events.filter(event => event.kind === 'observation' && event.target.kind === kind && event.target.id === id);
  if (!found.length) return { observation: null };
  const at = Math.max(...found.map(event => Date.parse(event.observedAt)));
  const top = found.filter(event => Date.parse(event.observedAt) === at);
  return new Set(top.map(event => canonical(event.value))).size > 1 ? { observation: top.at(-1), conflict: top } : { observation: top.at(-1) };
};
/** Condition state: an exact, fresh, comparable observation of the declared target, nothing else. */
const judge = (condition, events, t) => {
  const { observation: seen, conflict } = latest(events, 'state', condition.predicate.target.id);
  const base = { id: condition.id, predicate: condition.predicate, maxAge: condition.maxAge };
  if (!seen) return { ...base, state: 'unknown', reason: 'no-observation', observation: null };
  const used = { value: seen.value, source: seen.source, observedAt: seen.observedAt, recordedAt: seen.recordedAt };
  if (seen.value === null) return { ...base, state: 'unknown', reason: 'no-value', observation: used };
  if (t - Date.parse(seen.observedAt) > duration(condition.maxAge, condition.id)) return { ...base, state: 'unknown', reason: 'stale', observation: used };
  if (conflict) return { ...base, state: 'conflict', reason: 'conflicting-observations', observation: used,
    conflicting: conflict.map(event => ({ value: event.value, source: event.source })) };
  const expected = condition.predicate.op === 'equals' ? [condition.predicate.value] : condition.predicate.value;
  if (!scalar(seen.value) || !expected.some(value => typeof value === typeof seen.value))
    return { ...base, state: 'unknown', reason: 'unmatchable', observation: used };
  return { ...base, state: expected.includes(seen.value) ? 'satisfied' : 'unmet', reason: 'observed', observation: used };
};
/** Responsibility from the referenced Norm and an explicit owner observation; never from names. */
const owner = (condition, purposeId, norms, events) => {
  const norm = norms.get(condition.norm);
  const { observation: claim, conflict } = latest(events, 'owner', condition.id);
  const observed = claim ? { value: claim.value, source: claim.source, observedAt: claim.observedAt } : null;
  if (!norm) return { state: 'unassigned', reason: 'norm-not-found', norm: condition.norm, observed };
  if (norm.binding.purposeId !== purposeId || !norm.binding.conditions.includes(condition.id))
    return { state: 'unassigned', reason: 'norm-binding-mismatch', norm: norm.id, observed };
  if (norm.W.length === 0) return { state: 'unassigned', reason: 'norm-has-no-W', norm: norm.id, observed };
  if (norm.W.length > 1) return { state: 'conflict', reason: 'norm-has-several-W', norm: norm.id, candidates: [...norm.W], observed };
  if (conflict) return { state: 'conflict', reason: 'conflicting-owner-observations', norm: norm.id,
    candidates: [...new Set([norm.W[0], ...conflict.map(event => String(event.value))])], observed };
  if (claim && claim.value !== norm.W[0]) return { state: 'conflict', reason: 'observed-owner-differs-from-norm', norm: norm.id,
    candidates: [norm.W[0], String(claim.value)], observed };
  return { state: 'assigned', actor: norm.W[0], reviewer: [...norm.R], reason: claim ? 'norm-and-observation' : 'norm', norm: norm.id, observed };
};

const planNodeOwner = (node, norms) => {
  const norm = norms.get(node.norm);
  if (!norm || norm.W.length === 0) return { state: 'unassigned', norm: node.norm };
  return norm.W.length > 1 ? { state: 'conflict', norm: norm.id, candidates: [...norm.W] } : { state: 'assigned', actor: norm.W[0], norm: norm.id };
};
const nodeState = (node, purpose, events, t) => {
  if (!node.predicateRefs?.length) return { state: 'unknown', reason: 'natural-language-only', predicates: [] };
  const predicates = node.predicateRefs.map(id => judge(purpose.requires.find(value => value.id === id), events, t));
  const state = predicates.every(value => value.state === 'satisfied') ? 'satisfied'
    : predicates.some(value => value.state === 'unmet') ? 'unmet' : 'unknown';
  return { state, reason: 'predicate-refs', predicates: predicates.map(value => ({ id: value.id, state: value.state, reason: value.reason })) };
};

const planAt = (log, plan, ideals, current, norms, times, t) => {
  const events = visible(log, t);
  const premise = ideals.get(plan.purposeRef.version);
  const head = { ref: plan.source.ref, plan: planId(plan), version: plan.version, recordedAt: plan.recordedAt, source: { ...plan.source },
    purposeRef: { ...plan.purposeRef }, premise: plan.purposeRef.version === current?.version ? 'current' : 'premise-version-mismatch',
    serves: premise.requires.filter(value => value.plans?.includes(planId(plan))).map(value => value.id) };
  if (opaque(plan)) return { ...head, nodes: null, edges: null, loops: [], unknown: [...(plan.unknown ?? ['content-unknown'])] };
  const states = new Map(plan.nodes.map(node => [node.id, nodeState(node, premise, events, t)]));
  // Re-entry count: known satisfied -> unmet transitions of a loop target over earlier frames of the same plan ref.
  const transitions = id => {
    let count = 0, last = null;
    for (const s of times.filter(value => value <= t)) {
      const version = log.filter(event => event.kind === 'plan.set' && planId(event) === planId(plan) && Date.parse(event.recordedAt) <= s).at(-1);
      const node = opaque(version ?? {}) ? undefined : version?.nodes.find(value => value.id === id);
      if (!node) continue;
      const { state } = nodeState(node, ideals.get(version.purposeRef.version), visible(log, s), s);
      if (state === 'unmet' && last === 'satisfied') count += 1;
      if (state !== 'unknown') last = state;
    }
    return count;
  };
  const deps = plan.edges.filter(edge => edge.kind === 'dep');
  const between = (from, to) => plan.nodes.map(node => node.id).filter(id => reaches(deps, from, id) && reaches(deps, id, to));
  const iteration = new Map(), loops = [];
  for (const edge of plan.edges.filter(value => value.kind === 'loop')) {
    const reentries = transitions(edge.to);
    loops.push({ from: edge.from, to: edge.to, condition: edge.condition ?? null, iteration: reentries + 1, reentries });
    for (const id of between(edge.to, edge.from)) iteration.set(id, Math.max(iteration.get(id) ?? 1, reentries + 1));
  }
  const looped = new Set(plan.edges.filter(edge => edge.kind === 'loop').flatMap(edge => between(edge.to, edge.from)));
  const nodes = plan.nodes.map(node => {
    const own = states.get(node.id), n = iteration.get(node.id) ?? 1;
    const blocked = own.state === 'satisfied' ? null : {
      predicates: own.predicates.filter(value => value.state !== 'satisfied').map(value => value.id),
      deps: deps.filter(edge => edge.to === node.id && states.get(edge.from).state !== 'satisfied').map(edge => edge.from) };
    return { id: node.id, instance: `${node.id}#${n}`, iteration: n, reentry: n > 1, label: node.label, exit: node.exit,
      contributesTo: [...node.contributesTo], predicateRefs: node.predicateRefs ?? null, owner: planNodeOwner(node, norms),
      state: own.state, reason: own.reason, predicates: own.predicates, blockedBy: blocked,
      regressions: looped.has(node.id) ? 0 : transitions(node.id),
      due: node.due ?? null, overdue: 'due' in node ? own.state !== 'satisfied' && t > Date.parse(node.due) : null };
  });
  return { ...head, nodes, edges: plan.edges.map(edge => ({ ...edge })), loops };
};

/**
 * Fold the log into one derived state per frame t (each distinct recordedAt from the first purpose.set).
 * stage: purpose-changed (no ideal.drafting/ideal.set since the active purpose.set), defining (drafting
 * only), ideal (an ideal.set of the active Purpose rev), ended (purpose.ended since the purpose.set).
 */
export const deriveFrames = ({ header, events: log }, norms) => {
  const times = [...new Set(log.map(event => Date.parse(event.recordedAt)))].sort((a, b) => a - b);
  const ideals = new Map(log.filter(event => event.kind === 'ideal.set').map(event => [event.version, event]));
  const first = Date.parse(log.find(event => event.kind === 'purpose.set').recordedAt);
  // An ideal.set is superseded by the next purpose.set, ideal.set or purpose.ended in the log.
  const archive = ideal => log.slice(log.indexOf(ideal) + 1).find(event => ['purpose.set', 'ideal.set', 'purpose.ended'].includes(event.kind));
  const frames = times.filter(t => t >= first).map(t => {
    const events = visible(log, t);
    const start = events.findLastIndex(event => event.kind === 'purpose.set');
    const purpose = events[start], since = events.slice(start + 1);
    const set = since.filter(event => event.kind === 'ideal.set').at(-1) ?? null;
    const stage = since.some(event => event.kind === 'purpose.ended') ? 'ended' : set ? 'ideal'
      : since.some(event => event.kind === 'ideal.drafting') ? 'defining' : 'purpose-changed';
    const ideal = stage === 'ideal' ? set : null;
    const conditions = (ideal?.requires ?? []).map(value => ({ ...value, judgment: judge(value, events, t),
      responsibility: owner(value, ideal.purpose_id, norms, events) }));
    // Superseded obligations are frozen at their archive instant, never re-derived later.
    const history = events.filter(event => event.kind === 'ideal.set' && event !== ideal).flatMap(old => {
      const archivedAt = Date.parse(archive(old).recordedAt), then = visible(log, archivedAt);
      return old.requires.map(value => {
        const judged = judge(value, then, archivedAt);
        return { id: `${old.version}:${value.id}`, label: `旧義務 ${old.version}：${value.label}`, purpose_id: old.purpose_id, purpose_version: old.version,
          condition_id: value.id, state: judged.state, reason: judged.reason, observation: judged.observation,
          responsibility: owner(value, old.purpose_id, norms, then), archivedAt: new Date(archivedAt).toISOString(),
          frozen: true, relation: 'superseded', authority: 'derived-from-events' };
      });
    });
    const refs = [...new Set(events.filter(event => event.kind === 'plan.set').map(planId))].sort();
    const plans = refs.map(ref => planAt(log, events.filter(event => event.kind === 'plan.set' && planId(event) === ref).at(-1),
      ideals, ideal, norms, times, t));
    const sessions = Object.fromEntries([...new Set(events.filter(event => event.kind === 'observation' && event.target.kind === 'session')
      .map(event => event.target.id))].sort().map(id => { const { observation: seen } = latest(events, 'session', id);
      return [id, { value: seen.value, source: seen.source, observedAt: seen.observedAt }]; }));
    // Gap inputs exclude plan.set: revising a plan cannot change the derived Gap or its provenance.
    const gapInputs = events.filter(event => event.kind !== 'plan.set');
    const used = conditions.map(value => value.judgment.observation?.observedAt).filter(Boolean).map(Date.parse);
    return { t, asOf: new Date(t).toISOString(), purpose, stage, ideal, conditions, history, plans, sessions,
      // The journal (adrs#647 contract 3): decisions and observations in time order, each fact once.
      // An exactly repeated record (the same line recorded twice) is one fact: listed once, judged the same.
      journal: [...new Map(events.filter(event => !event.projection).map(event => [canonical(event), event])).values()],
      gapDigest: digest(gapInputs.map(canonical).join('\n')), observedAt: used.length ? new Date(Math.max(...used)).toISOString() : null };
  });
  return { header, now: new Date(times.at(-1)).toISOString(), frames };
};

// ---- Projection to the existing contracts. ----
const purposeRow = frame => `${frame.purpose.purpose.id}@${frame.purpose.rev}`;
const sourceRef = source => source.commentId ? `${source.ref}:comment-${source.commentId}` : source.ref;
// Rows of frames from..upto. A World frame uses only its own rows (from = upto): never later rows, and the
// World stays linear in the number of frames (v6); closure.jsonl keeps every frame (from = 0).
const closureRows = (derived, upto, from = 0) => {
  const frames = derived.frames.slice(from, upto + 1), rows = [], seen = new Set();
  for (const frame of frames) {
    const row = purposeRow(frame), p = frame.ideal, frameSource = [{ sourceRef: `atlas-events:frame@${frame.asOf}`, sourceDigest: frame.gapDigest }];
    if (!seen.has('purpose:' + row)) {
      seen.add('purpose:' + row);
      rows.push({ kind: 'purpose', id: row, label: frame.purpose.purpose.label, parents: [],
        sources: [{ sourceRef: `atlas-events:purpose/${row}`, sourceDigest: digest(canonical({ ...frame.purpose.purpose, rev: frame.purpose.rev })) }] });
    }
    if (!p) continue;
    if (!seen.has('ideal:' + p.version)) {
      seen.add('ideal:' + p.version);
      rows.push({ kind: 'ideal', id: `ideal.${p.version}`, label: p.label ?? `理想状態 ${p.version}`, purposes: [row], value: p.requires.map(value => value.label).join(' / '),
        // Qualified by the version: one declaration source may carry several ideal versions.
        sources: [{ sourceRef: `${sourceRef(p.source)}@${p.version}`, sourceDigest: p.source.digest }] });
    }
    const states = frame.conditions.map(value => `${value.id}=${value.judgment.state}`).join(', ');
    rows.push({ kind: 'current', id: `current@${frame.asOf}`, label: `現状 ${frame.asOf}`, value: states, sources: frameSource });
    rows.push({ kind: 'gap', id: `gap@${frame.asOf}`, label: `Gap ${frame.asOf}`, current: `current@${frame.asOf}`, ideal: `ideal.${p.version}`,
      delta: 'derived: requires の述語と観測の照合', owner: 'derived: control Norm と観測', proof: `events digest ${frame.gapDigest}`, sources: frameSource });
  }
  return rows;
};
export const closureDocument = (derived, upto = derived.frames.length - 1, from = 0) =>
  [{ schema: 'atlas.purpose-closure/1', authority: false }, ...closureRows(derived, upto, from)].map(canonical).join('\n') + '\n';

const EVALUATOR = 'atlas.D:derive', WRITER = 'atlas.events';
const semanticFrame = (derived, frame, index) => {
  const p = frame.ideal, pid = frame.purpose.purpose.id, space = `atlas-events:${pid}`;
  const ref = (revision, id = pid) => ({ space, revision, id });
  if (!p) return undefinedIdeal(frame, index, pid, ref);
  const currentRef = ref(`obs@${frame.asOf}`), targetRef = ref(`target@${p.version}`);
  // A Scope is one open condition with its owner: a satisfied condition is no difference (equivalent), not a Scope.
  const open = value => value.judgment.state !== 'satisfied';
  const owned = frame.conditions.filter(value => open(value) && value.responsibility.state === 'assigned');
  const evidence = (id, requirement, revision) => [{ requirements: [requirement], ref: { space, revision, id },
    observed_ref: currentRef, target_ref: targetRef, evaluator: EVALUATOR, state: 'known', fresh: true }];
  const residual = frame.conditions.filter(value => value.judgment.state !== 'satisfied').map(value => value.id);
  const whole = residual.length === 0 ? 'satisfied'
    : frame.conditions.some(value => value.judgment.state === 'unmet') ? 'unmet' : 'unknown';
  const meaning = judged => judged.observation ? `${JSON.stringify(judged.observation.value)} (${judged.reason})` : `観測なし (${judged.reason})`;
  const semantic = {
    schema: 'atlas.semantic-scopes/1', authority: false,
    comparison: {
      purpose_id: pid, current_ref: currentRef, target_ref: targetRef, direction: 'current-to-target', availability: 'known',
      basis: { current_ref: currentRef, target_ref: targetRef, evidence: [`atlas-events:gap-inputs@${frame.gapDigest}`] },
      // Every declared condition is a part of the ideal state; only an open one is a change to make.
      parts: frame.conditions.map(value => ({ id: value.id, verdict: open(value) ? 'change' : 'equivalent', basis: [canonical(value.predicate)],
        current_meaning: meaning(value.judgment), target_meaning: canonical(value.predicate) })),
      semantic_coverage: { assessment: 'declared-complete', basis: [`purpose.set ${p.version} requires[]`] },
    },
    partition: owned.map(value => ({ id: `scope.${value.id}`, label: value.label, parts: [value.id], owner_role: value.responsibility.norm,
      owner_actor: value.responsibility.actor, criteria: { [value.id]: [value.id] }, required_evidence: ['independent-post-state'],
      residual_policy: '未知・未達は次の観測で再判定', rationale: `requires[].norm=${value.norm} から導出（${value.responsibility.reason}）` })),
    observation: {
      purpose_id: pid, observed_ref: currentRef, target_ref: targetRef, evaluator: EVALUATOR, writer: WRITER, work_done: false,
      criteria: owned.map(value => ({ id: value.id, state: value.judgment.state,
        evidence: value.judgment.state === 'unmet'
          ? evidence(value.judgment.observation.source, 'independent-post-state', `observation@${value.judgment.observation.observedAt}`) : [],
        fresh: value.judgment.reason !== 'stale' })),
      purpose_evaluation: { coverage: 'whole-selected-target', observed_ref: currentRef, target_ref: targetRef, evaluator: EVALUATOR, fresh: true,
        state: whole, residual, evidence: evidence('derive:whole-target', 'whole-target-independent-evaluation', `derived@${frame.asOf}`) },
      ...(frame.observedAt ? { observed_at: frame.observedAt } : {}),
    },
    history: frame.history.map(value => ({ ...value, target_ref: ref(`target@${value.purpose_version}`, value.purpose_id) })),
    bindings: null,
  };
  const closure = closureRows(derived, index, index), find = id => closure.find(row => row.id === id);
  const bound = (row, extra) => ({ id: row.id, kind: row.kind, sources: row.sources, ...extra });
  semantic.bindings = { pair: { purpose_id: pid, current_ref: currentRef, target_ref: targetRef },
    purpose: bound(find(purposeRow(frame)), { domain_id: pid }), current: bound(find(`current@${frame.asOf}`), { state_ref: currentRef }),
    target: [bound(find(`ideal.${p.version}`), { state_ref: targetRef })], observed: bound(find(`current@${frame.asOf}`), { state_ref: currentRef }) };
  const known = frame.conditions.filter(value => value.judgment.observation).length;
  return { id: `t@${frame.asOf}`, rev: index + 1, asOf: frame.asOf, source_ref: `atlas-events:frame@${frame.asOf}`,
    purpose_label: frame.purpose.purpose.label, current_label: `観測照合 ${known}/${p.requires.length} 件 @${frame.asOf}`,
    target_label: `理想状態 ${p.version}：${p.label ?? '条件'}（条件 ${p.requires.length} 件）`, post_label: `導出 ${frame.asOf}`, semantic,
    responsibility: Object.fromEntries(frame.conditions.map(value => [value.id, value.responsibility])),
    // Closed differences (v7 history frame): conditions of this ideal state the current state meets now.
    closed: frame.conditions.filter(value => value.judgment.state === 'satisfied').map(value => ({ id: value.id, label: value.label,
      observedAt: value.judgment.observation.observedAt, source: value.judgment.observation.source, owner: value.responsibility.actor ?? null })),
    agent_activity: frame.sessions };
};
// No ideal state to compare with (purpose-changed, defining, ended): the comparison is UNKNOWN, never empty.
const STAGE = { 'purpose-changed': '目的変更・理想状態の定義待ち', defining: '理想状態を定義中', ended: '目的は終了' };
const undefinedIdeal = (frame, index, pid, ref) => {
  const currentRef = ref(`obs@${frame.asOf}`), targetRef = ref(`ideal@${frame.stage}`);
  return { id: `t@${frame.asOf}`, rev: index + 1, asOf: frame.asOf, source_ref: `atlas-events:frame@${frame.asOf}`,
    purpose_label: frame.purpose.purpose.label, current_label: `観測 @${frame.asOf}`, target_label: `理想状態：未確定（${STAGE[frame.stage]}）`,
    post_label: `導出 ${frame.asOf}`, responsibility: {}, agent_activity: frame.sessions,
    semantic: { schema: 'atlas.semantic-scopes/1', authority: false,
      comparison: { purpose_id: pid, current_ref: currentRef, target_ref: targetRef, direction: 'current-to-target', availability: 'unknown',
        basis: { current_ref: currentRef, target_ref: targetRef, evidence: [`atlas-events:stage@${frame.stage}`] } },
      partition: null, observation: null, bindings: null,
      history: frame.history.map(value => ({ ...value, target_ref: ref(`target@${value.purpose_version}`, value.purpose_id) })) } };
};
export const semanticInput = derived => ({ schema: 'atlas.semantic-scope-world/1', authority: false, source_mode: derived.header.source_mode,
  note: 'Derived from atlas.events/1 (purpose.set, plan.set, observation) and control Norms only; no hand-written Gap/Scope/owner.',
  frames: derived.frames.map((frame, index) => semanticFrame(derived, frame, index)) });

export const planProjection = derived => ({ schema: PLAN_PROJECTION_SCHEMA, authority: false, purpose_id: derived.frames.at(-1).purpose.purpose.id, now: derived.now,
  note: 'Plans are future intentions observed in Issue/PR bodies. They never enter the Gap, Current or coverage.',
  frames: derived.frames.map(frame => ({ id: `t@${frame.asOf}`, asOf: frame.asOf, purpose_id: frame.purpose.purpose.id, purpose_version: frame.ideal?.version ?? null,
    ...(frame.plans.length ? { status: 'known', plans: frame.plans }
      : { status: 'unknown', reason: 'no plan.set recorded at or before t', plans: null }) })) });

/**
 * Whole derivation. Each World frame is built by the existing adapter with the
 * Closure reduced from events at or before that frame only (no future rows).
 */
export const deriveAtlas = (eventsText, controlText) => {
  const derived = deriveFrames(parseEvents(eventsText), parseControl(controlText));
  const input = semanticInput(derived);
  const built = input.frames.map((frame, index) => semanticScopeWorld({ ...input, frames: [frame] }, reduceClosure(closureDocument(derived, index, index))));
  const world = { ...built.at(-1), frames: built.map(value => value.frames[0]) };
  return { derived, closure: closureDocument(derived), input, world, plans: planProjection(derived) };
};
