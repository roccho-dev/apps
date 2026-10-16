// Event-sourced Atlas derivation. Only three declared event kinds go in; Gap,
// Scope state and responsibility are derived per frame t. No clock, filesystem,
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

const purposeSet = (event, at) => {
  keys(event, ['kind', 'recordedAt', 'purpose', 'version', 'label', 'requires', 'source'], [], at);
  keys(event.purpose, ['id', 'label'], [], `${at}.purpose`);
  demand(token(event.purpose.id) && text(event.purpose.label) && token(event.version) && text(event.label), `${at}: purpose identity/version/label required`);
  keys(event.source, ['ref', 'digest'], [], `${at}.source`);
  demand(token(event.source.ref) && sha(event.source.digest), `${at}: source ref and sha256 digest required`);
  demand(Array.isArray(event.requires) && event.requires.length > 0, `${at}: requires must be nonempty`);
  event.requires.forEach((value, index) => {
    const where = `${at}.requires[${index}]`;
    keys(value, ['id', 'label', 'predicate', 'maxAge', 'norm'], [], where);
    demand(token(value.id) && text(value.label) && token(value.norm), `${where}: id/label/norm required`);
    predicate(value.predicate, `${where}.predicate`);
    duration(value.maxAge, `${where}.maxAge`);
  });
  ids(event.requires.map(value => value.id), `${at}.requires ids`);
};
const observation = (event, at) => {
  keys(event, ['kind', 'recordedAt', 'target', 'value', 'source', 'observedAt'], [], at);
  stateTarget(event.target, `${at}.target`);
  demand(event.value !== undefined && event.value !== null, `${at}: observed value required`);
  demand(text(event.source), `${at}: observation source required`);
  demand(time(event.observedAt, `${at}.observedAt`) <= Date.parse(event.recordedAt), `${at}: observedAt is after recordedAt (future fact)`);
};
const PLAN_REF = /^[A-Za-z0-9._/-]+#\d+$/u;
const reaches = (deps, from, to) => { // from ->* to through dep edges
  const seen = new Set([from]), queue = [from];
  while (queue.length) {
    const next = queue.shift();
    for (const edge of deps) if (edge.from === next && !seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
  }
  return seen.has(to);
};
const planSet = (event, at) => {
  keys(event, ['kind', 'recordedAt', 'purposeRef', 'source', 'version', 'nodes', 'edges'], [], at);
  keys(event.purposeRef, ['purposeId', 'version'], [], `${at}.purposeRef`);
  demand(token(event.purposeRef.purposeId) && token(event.purposeRef.version) && token(event.version), `${at}: purposeRef/version required`);
  keys(event.source, ['ref', 'commentId', 'updatedAt', 'digest'], [], `${at}.source`);
  demand(PLAN_REF.test(event.source.ref) && (event.source.commentId === null || token(event.source.commentId)) && sha(event.source.digest),
    `${at}: source repo#number, commentId|null and sha256 digest required`);
  demand(time(event.source.updatedAt, `${at}.source.updatedAt`) <= Date.parse(event.recordedAt), `${at}: source updatedAt is after recordedAt (future fact)`);
  demand(Array.isArray(event.nodes) && event.nodes.length > 0 && Array.isArray(event.edges), `${at}: nodes[] and edges[] required`);
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

/** Parse the event log. Any invalid, unordered or future event fails closed. */
export const parseEvents = input => {
  const [first, ...rest] = lines(input, 'events');
  keys(first.value, ['schema', 'authority', 'source_mode'], [], `${first.at} header`);
  demand(first.value.schema === EVENTS_SCHEMA && first.value.authority === false && ['synthetic', 'supplied'].includes(first.value.source_mode),
    'unsupported events schema/authority/source_mode');
  let last = -Infinity, purposeId = null;
  const versions = new Map(), plans = new Map();
  const events = rest.map(({ value: event, at }) => {
    demand(object(event) && ['purpose.set', 'plan.set', 'observation'].includes(event.kind), `${at}: unknown event kind`);
    const recorded = time(event.recordedAt, `${at}.recordedAt`);
    demand(recorded >= last, `${at}: recordedAt goes backwards (log must be append-ordered)`);
    last = recorded;
    if (event.kind === 'purpose.set') {
      purposeSet(event, at);
      purposeId ??= event.purpose;
      demand(canonical(purposeId) === canonical(event.purpose), `${at}: one Purpose identity per log`);
      demand(!versions.has(event.version), `${at}: purpose version ${event.version} already set`);
      versions.set(event.version, event);
    } else if (event.kind === 'observation') observation(event, at);
    else {
      planSet(event, at);
      const purpose = versions.get(event.purposeRef.version);
      demand(purposeId && event.purposeRef.purposeId === purposeId.id && purpose, `${at}: purposeRef names no purpose.set recorded before it`);
      const required = new Set(purpose.requires.map(value => value.id));
      for (const node of event.nodes) demand([...node.contributesTo, ...(node.predicateRefs ?? [])].every(id => required.has(id)),
        `${at}: ${node.id} references a condition outside ${event.purposeRef.version}`);
      const previous = plans.get(event.source.ref) ?? [];
      const prior = previous.at(-1);
      demand(!prior || Date.parse(event.source.updatedAt) >= Date.parse(prior.source.updatedAt), `${at}: plan body updatedAt goes backwards`);
      demand(previous.every(value => value.version !== event.version || canonical(value) === canonical({ ...event, recordedAt: value.recordedAt })),
        `${at}: plan version ${event.version} redefined`);
      demand(!prior || prior.source.updatedAt !== event.source.updatedAt || prior.source.digest === event.source.digest,
        `${at}: same plan body time with another digest`);
      plans.set(event.source.ref, [...previous, event]);
    }
    return event;
  });
  demand(versions.size > 0, 'no purpose.set event');
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

const planAt = (log, plan, purposes, current, norms, times, t) => {
  const events = visible(log, t);
  const premise = purposes.get(plan.purposeRef.version);
  const states = new Map(plan.nodes.map(node => [node.id, nodeState(node, premise, events, t)]));
  // Re-entry count: known satisfied -> unmet transitions of a loop target over earlier frames of the same plan ref.
  const transitions = id => {
    let count = 0, last = null;
    for (const s of times.filter(value => value <= t)) {
      const version = log.filter(event => event.kind === 'plan.set' && event.source.ref === plan.source.ref && Date.parse(event.recordedAt) <= s).at(-1);
      const node = version?.nodes.find(value => value.id === id);
      if (!node) continue;
      const { state } = nodeState(node, purposes.get(version.purposeRef.version), visible(log, s), s);
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
  return { ref: plan.source.ref, version: plan.version, recordedAt: plan.recordedAt, source: { ...plan.source },
    purposeRef: { ...plan.purposeRef }, premise: plan.purposeRef.version === current.version ? 'current' : 'premise-version-mismatch',
    nodes, edges: plan.edges.map(edge => ({ ...edge })), loops };
};

/** Fold the log into one derived state per frame t (each distinct recordedAt from the first purpose.set). */
export const deriveFrames = ({ header, events: log }, norms) => {
  const times = [...new Set(log.map(event => Date.parse(event.recordedAt)))].sort((a, b) => a - b);
  const purposes = new Map(log.filter(event => event.kind === 'purpose.set').map(event => [event.version, event]));
  const first = Date.parse(log.find(event => event.kind === 'purpose.set').recordedAt);
  const frames = times.filter(t => t >= first).map(t => {
    const events = visible(log, t);
    const sets = events.filter(event => event.kind === 'purpose.set');
    const current = sets.at(-1);
    const conditions = current.requires.map(value => ({ ...value, judgment: judge(value, events, t),
      responsibility: owner(value, current.purpose.id, norms, events) }));
    // Superseded obligations are frozen at their archive instant, never re-derived later.
    const history = sets.slice(0, -1).flatMap((old, index) => {
      const archivedAt = Date.parse(sets[index + 1].recordedAt), then = visible(log, archivedAt);
      return old.requires.map(value => {
        const judged = judge(value, then, archivedAt);
        return { id: `${old.version}:${value.id}`, label: `旧義務 ${old.version}：${value.label}`, purpose_version: old.version,
          condition_id: value.id, state: judged.state, reason: judged.reason, observation: judged.observation,
          responsibility: owner(value, old.purpose.id, norms, then), archivedAt: new Date(archivedAt).toISOString(),
          frozen: true, relation: 'superseded', authority: 'derived-from-events' };
      });
    });
    const refs = [...new Set(events.filter(event => event.kind === 'plan.set').map(event => event.source.ref))].sort();
    const plans = refs.map(ref => planAt(log, events.filter(event => event.kind === 'plan.set' && event.source.ref === ref).at(-1),
      purposes, current, norms, times, t));
    const sessions = Object.fromEntries([...new Set(events.filter(event => event.kind === 'observation' && event.target.kind === 'session')
      .map(event => event.target.id))].sort().map(id => { const { observation: seen } = latest(events, 'session', id);
      return [id, { value: seen.value, source: seen.source, observedAt: seen.observedAt }]; }));
    // Gap inputs exclude plan.set: revising a plan cannot change the derived Gap or its provenance.
    const gapInputs = events.filter(event => event.kind !== 'plan.set');
    const used = conditions.map(value => value.judgment.observation?.observedAt).filter(Boolean).map(Date.parse);
    return { t, asOf: new Date(t).toISOString(), purpose: current, conditions, history, plans, sessions,
      gapDigest: digest(gapInputs.map(canonical).join('\n')), observedAt: used.length ? new Date(Math.max(...used)).toISOString() : null };
  });
  return { header, purposeId: log.find(event => event.kind === 'purpose.set').purpose.id, now: new Date(times.at(-1)).toISOString(), frames };
};

// ---- Projection to the existing contracts. ----
const closureRows = (derived, upto) => {
  const pid = derived.purposeId, frames = derived.frames.slice(0, upto + 1);
  const purpose = frames[0].purpose.purpose;
  const rows = [{ kind: 'purpose', id: pid, label: purpose.label, parents: [],
    sources: [{ sourceRef: `atlas-events:purpose/${pid}`, sourceDigest: digest(canonical(purpose)) }] }];
  const ideals = new Set();
  for (const frame of frames) {
    const p = frame.purpose, frameSource = [{ sourceRef: `atlas-events:frame@${frame.asOf}`, sourceDigest: frame.gapDigest }];
    if (!ideals.has(p.version)) {
      ideals.add(p.version);
      rows.push({ kind: 'ideal', id: `ideal.${p.version}`, label: p.label, purposes: [pid], value: p.requires.map(value => value.label).join(' / '),
        sources: [{ sourceRef: p.source.ref, sourceDigest: p.source.digest }] });
    }
    const states = frame.conditions.map(value => `${value.id}=${value.judgment.state}`).join(', ');
    rows.push({ kind: 'current', id: `current@${frame.asOf}`, label: `現状 ${frame.asOf}`, value: states, sources: frameSource });
    rows.push({ kind: 'gap', id: `gap@${frame.asOf}`, label: `Gap ${frame.asOf}`, current: `current@${frame.asOf}`, ideal: `ideal.${p.version}`,
      delta: 'derived: requires の述語と観測の照合', owner: 'derived: control Norm と観測', proof: `events digest ${frame.gapDigest}`, sources: frameSource });
  }
  return rows;
};
export const closureDocument = (derived, upto = derived.frames.length - 1) =>
  [{ schema: 'atlas.purpose-closure/1', authority: false }, ...closureRows(derived, upto)].map(canonical).join('\n') + '\n';

const EVALUATOR = 'atlas.D:derive', WRITER = 'atlas.events';
const semanticFrame = (derived, frame, index) => {
  const pid = derived.purposeId, space = `atlas-events:${pid}`, p = frame.purpose;
  const ref = revision => ({ space, revision, id: pid });
  const currentRef = ref(`obs@${frame.asOf}`), targetRef = ref(`target@${p.version}`);
  const owned = frame.conditions.filter(value => value.responsibility.state === 'assigned');
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
      // Every declared condition is a target part; its criterion state, not the verdict, carries satisfied/unmet/unknown.
      parts: frame.conditions.map(value => ({ id: value.id, verdict: 'change', basis: [canonical(value.predicate)],
        current_meaning: meaning(value.judgment), target_meaning: canonical(value.predicate) })),
      semantic_coverage: { assessment: 'declared-complete', basis: [`purpose.set ${p.version} requires[]`] },
    },
    partition: owned.map(value => ({ id: `scope.${value.id}`, label: value.label, parts: [value.id], owner_role: value.responsibility.norm,
      owner_actor: value.responsibility.actor, criteria: { [value.id]: [value.id] }, required_evidence: ['independent-post-state'],
      residual_policy: '未知・未達は次の観測で再判定', rationale: `requires[].norm=${value.norm} から導出（${value.responsibility.reason}）` })),
    observation: {
      purpose_id: pid, observed_ref: currentRef, target_ref: targetRef, evaluator: EVALUATOR, writer: WRITER, work_done: false,
      criteria: owned.map(value => ({ id: value.id, state: value.judgment.state,
        evidence: ['satisfied', 'unmet'].includes(value.judgment.state)
          ? evidence(value.judgment.observation.source, 'independent-post-state', `observation@${value.judgment.observation.observedAt}`) : [],
        fresh: value.judgment.reason !== 'stale' })),
      purpose_evaluation: { coverage: 'whole-selected-target', observed_ref: currentRef, target_ref: targetRef, evaluator: EVALUATOR, fresh: true,
        state: whole, residual, evidence: evidence('derive:whole-target', 'whole-target-independent-evaluation', `derived@${frame.asOf}`) },
      ...(frame.observedAt ? { observed_at: frame.observedAt } : {}),
    },
    history: frame.history.map(value => ({ ...value, target_ref: ref(`target@${value.purpose_version}`) })),
    bindings: null,
  };
  const closure = closureRows(derived, index), find = id => closure.find(row => row.id === id);
  const bound = (row, extra) => ({ id: row.id, kind: row.kind, sources: row.sources, ...extra });
  semantic.bindings = { pair: { purpose_id: pid, current_ref: currentRef, target_ref: targetRef },
    purpose: bound(find(pid), { domain_id: pid }), current: bound(find(`current@${frame.asOf}`), { state_ref: currentRef }),
    target: [bound(find(`ideal.${p.version}`), { state_ref: targetRef })], observed: bound(find(`current@${frame.asOf}`), { state_ref: currentRef }) };
  const known = frame.conditions.filter(value => value.judgment.observation).length;
  return { id: `t@${frame.asOf}`, rev: index + 1, asOf: frame.asOf, source_ref: `atlas-events:frame@${frame.asOf}`,
    purpose_label: p.label, current_label: `観測照合 ${known}/${p.requires.length} 件 @${frame.asOf}`,
    target_label: `${p.version} の条件 ${p.requires.length} 件`, post_label: `導出 ${frame.asOf}`, semantic,
    responsibility: Object.fromEntries(frame.conditions.map(value => [value.id, value.responsibility])),
    agent_activity: frame.sessions };
};
export const semanticInput = derived => ({ schema: 'atlas.semantic-scope-world/1', authority: false, source_mode: derived.header.source_mode,
  note: 'Derived from atlas.events/1 (purpose.set, plan.set, observation) and control Norms only; no hand-written Gap/Scope/owner.',
  frames: derived.frames.map((frame, index) => semanticFrame(derived, frame, index)) });

export const planProjection = derived => ({ schema: PLAN_PROJECTION_SCHEMA, authority: false, purpose_id: derived.purposeId, now: derived.now,
  note: 'Plans are future intentions observed in Issue/PR bodies. They never enter the Gap, Current or coverage.',
  frames: derived.frames.map(frame => ({ id: `t@${frame.asOf}`, asOf: frame.asOf, purpose_version: frame.purpose.version,
    ...(frame.plans.length ? { status: 'known', plans: frame.plans }
      : { status: 'unknown', reason: 'no plan.set recorded at or before t', plans: null }) })) });

/**
 * Whole derivation. Each World frame is built by the existing adapter with the
 * Closure reduced from events at or before that frame only (no future rows).
 */
export const deriveAtlas = (eventsText, controlText) => {
  const derived = deriveFrames(parseEvents(eventsText), parseControl(controlText));
  const input = semanticInput(derived);
  const built = input.frames.map((frame, index) => semanticScopeWorld({ ...input, frames: [frame] }, reduceClosure(closureDocument(derived, index))));
  const world = { ...built.at(-1), frames: built.map(value => value.frames[0]) };
  return { derived, closure: closureDocument(derived), input, world, plans: planProjection(derived) };
};
