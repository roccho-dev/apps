// Atlas application adaptation only. The existing Closure reducer owns its
// seven-kind join; SharedAtlasUI owns World validation, projection and rendering.
import { normalizeSemanticScopes } from './semantic-scopes.mjs';
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const ref = (space, kind, id) => ({ space, kind, id });
const key = value => JSON.stringify([value.space, value.kind, value.id]);
const source = (sourceRef, kind = 'synthetic') => ({ sourceRef, sourceDigest: null, kind });
const legacySpace = 'atlas.purpose-closure/1';

const readReduced = text => {
  const [header, ...rows] = text.split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line));
  if (header?.schema !== legacySpace || header.authority !== false) throw new Error('scope-world: validated Closure output required');
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== rows.length) throw new Error('scope-world: duplicate Closure identity');
  return byId;
};

const bindClosure = (meaning, records) => {
  const binding = meaning.bindings;
  const unavailable = reason => ({ state: 'unknown', reason, declaration: binding });
  if (!object(binding) || !same(binding.pair, meaning.pair)) return unavailable('explicit same-pair Closure binding missing');
  const resolve = (item, kind) => {
    if (!object(item) || item.kind !== kind || typeof item.id !== 'string') return null;
    const record = records.get(item.id);
    return record?.kind === kind && Array.isArray(item.sources)
      && same(stable(item.sources).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)),
        stable(record.sources).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))) ? record : null;
  };
  const purpose = resolve(binding.purpose, 'purpose');
  const current = resolve(binding.current, 'current');
  if (!purpose || !current || binding.purpose.domain_id !== meaning.pair.purpose_id
    || !same(binding.current.state_ref, meaning.pair.current_ref)) return unavailable('Purpose/current source binding missing or wrong revision');
  if (!Array.isArray(binding.target) || binding.target.length === 0) return unavailable('explicit target Ideal bindings missing');
  const target = binding.target.map(item => resolve(item, 'ideal'));
  if (target.some((item, index) => !item || !same(binding.target[index].state_ref, meaning.pair.target_ref)
    || !item.purposes.includes(purpose.id))) return unavailable('target source binding points to another Purpose/revision');
  const currentRoute = [...records.values()].some(gap => gap.kind === 'gap' && gap.current === current.id
    && records.get(gap.ideal)?.purposes.includes(purpose.id));
  if (!currentRoute) return unavailable('declared Closure Current has no typed route to the bound Purpose');
  let observed = null;
  if (meaning.observation !== null) {
    observed = resolve(binding.observed, 'current');
    if (!observed || !same(binding.observed.state_ref, meaning.observation.observed_ref))
      return unavailable('post-observation Closure binding missing or wrong revision');
    if (![...records.values()].some(gap => gap.kind === 'gap' && gap.current === observed.id
      && records.get(gap.ideal)?.purposes.includes(purpose.id))) return unavailable('post-observation Current has no typed route to bound Purpose');
  }
  return { state: 'declared-bound', purpose, current, target, observed, declaration: binding,
    semantic_truth: 'mapping-declared-not-authenticated' };
};

// A Scope's own status uses only its own criteria. Criterion-level states come
// from the supplied observation; a whole-Purpose residual naming a criterion the
// criterion evaluation satisfied is a disagreement, kept visible, never resolved.
const ownScopeStatus = (scope, closure) => {
  if (closure.reason) return { status: 'unknown' };
  const own = Object.values(scope.criteria).flat();
  const states = new Map((closure.observation?.criteria ?? []).map(value => [value.id, value.state]));
  const has = list => own.some(id => (list ?? []).includes(id));
  if (has(closure.conflicts)) return { status: 'conflict' };
  if (has(closure.unknown)) return { status: 'unknown' };
  const residual = own.filter(id => (closure.residual ?? []).includes(id));
  if (residual.some(id => states.get(id) === 'unmet')) return { status: 'unmet' };
  if (residual.length) return { status: 'conflict', disagreement: {
    criterion_level: residual.map(id => ({ id, state: states.get(id) ?? null })),
    whole_purpose_residual: residual, purpose_status: closure.purpose_status } };
  return { status: 'declared_satisfied' };
};
// active: counted in the current Gap. completed-history: satisfied with a bound
// mapping, kept as a checkpoint. unresolved: satisfied evidence kept readable,
// but its standing cannot be settled while the mapping is unknown.
const scopeStanding = (status, bound) => status !== 'declared_satisfied' ? 'active' : bound ? 'completed-history' : 'unresolved';
const standingLabel = { active: '現在必要', 'completed-history': '完了済み（履歴）', unresolved: '未確定（証拠は保持）' };
const statusCaption = { unmet: '必要', conflict: '矛盾', unknown: '未確認', declared_satisfied: '完了・履歴' };
const roleCaption = { owner_actor: '担当', writer: '作業', evaluator: '評価' };
// Overview captions are presentation only: exactly two logical lines, a role/kind
// line and the full supplied text. Nothing is shortened here (no ellipsis, no
// id-tail elision); the generic UI wraps. The record summary, flags and relation
// context still carry every supplied label, id and revision verbatim.
const caption = (first, second) => String(first) + '\n' + String(second);

/** The second argument is the real reduceClosure output, not a substitute join. */
export const semanticScopeWorld = (input, reducedClosure) => {
  if (!object(input) || input.schema !== 'atlas.semantic-scope-world/1' || input.authority !== false
    || !Array.isArray(input.frames) || input.frames.length === 0) throw new Error('scope-world: explicit observation frames required');
  const records = readReduced(reducedClosure);
  const historicalIds = new Map();
  // Agent provenance comes from the declared input mode and explicit session observations only.
  const synthetic = input.source_mode === 'synthetic';
  let agentsSeen = { declared: 0, observed: 0 };
  const frames = input.frames.map(observed => {
    if (typeof observed.id !== 'string' || !Number.isSafeInteger(observed.rev) || observed.rev < 0
      || !Number.isFinite(Date.parse(observed.asOf))) throw new Error('scope-world: observation identity/revision/time required');
    const meaning = normalizeSemanticScopes(observed.semantic);
    const previous = historicalIds.get(meaning.pair.purpose_id) ?? new Set();
    const present = new Set(meaning.history.map(value => value.id));
    if ([...previous].some(id => !present.has(id))) throw new Error('scope-world: prior obligation omitted; retain it with explicit disposition');
    historicalIds.set(meaning.pair.purpose_id, new Set([...previous, ...present]));
    const binding = bindClosure(meaning, records);
    const bound = binding.state === 'declared-bound';
    const closure = meaning.closure;
    const space = meaning.pair.current_ref?.space ?? 'semantic-input-unresolved';
    const purposeRef = ref(space, 'purpose', meaning.pair.purpose_id);
    const currentRef = ref(space, 'purpose-state-current', meaning.pair.purpose_id + ':current');
    const targetRef = ref(space, 'purpose-state-target', meaning.pair.purpose_id + ':target');
    const entities = [], relations = [];
    const declaredSource = source(observed.source_ref ?? 'source:unavailable');
    // Frame.asOf is a capture coordinate. It must not freshen an old state,
    // a target definition or the original comparison's unknown observation time.
    const time = { observedAt: null, acquiredAt: null, effectiveAt: null };
    const suppliedPostAt = meaning.observation?.observed_at;
    const postTime = { ...time, observedAt: typeof suppliedPostAt === 'string'
      && Number.isFinite(Date.parse(suppliedPostAt)) ? suppliedPostAt : null };
    const knownMeaning = ['declared_partition', 'declared_equivalent', 'incomplete', 'undecomposed'].includes(meaning.status);
    const purposeStanding = bound ? closure.purpose_status : 'unknown';
    const entity = (entityRef, label, area, summary, flags = [], ownSource = declaredSource, ownTime = time) => {
      entities.push({ ref: entityRef, label, area, order: entities.length, visible: true, activity: 'none',
        summary, source: ownSource, time: { ...ownTime }, flags });
      return entityRef;
    };
    const edge = (id, from, to, label, context, path = false, visible = true) => {
      relations.push({ ref: ref(space, 'declared-relation', id), from, to, kind: 'declared-relation', label, context,
        source: declaredSource, time: { ...time }, flags: ['authority=false'], containment: null, path, ...(visible ? {} : { visible: false }) });
    };

    // Purpose area: one Purpose, one Current (this frame's selected revision), one Target role.
    const purposeLabel = observed.purpose_label ?? 'Purpose';
    entity(purposeRef, caption('目的', purposeLabel), 'purpose',
      purposeLabel + ' · 供給された目的。実達成の証明ではありません。 Purpose ' + purposeStanding, ['domain-declared', 'purpose_standing=' + purposeStanding]);
    // Target sits next to Purpose so their relation never crosses the Current.
    const targetLabel = observed.target_label ?? '目標 t1';
    entity(targetRef, caption('目標', targetLabel), 'purpose', targetLabel + ' · 目的達成状態（役割）。後の観測ではありません。',
      ['role=target', 'effective-time-unavailable']);
    const currentRevision = meaning.observation?.observed_ref ?? meaning.pair.current_ref;
    const revision = currentRevision?.revision ?? 'unknown';
    const currentStanding = !meaning.observation ? 'declared-baseline-not-reobserved' : bound ? 'observed-bound' : 'unresolved';
    // Supplied labels keep their own subject: post_label describes the observed
    // revision; current_label describes the original comparison's current.
    const originalNote = same(currentRevision, meaning.pair.current_ref) ? ''
      : ' · 元の比較の現状: ' + (meaning.pair.current_ref?.revision ?? 'unknown') + ' ' + (observed.current_label ?? '');
    entity(currentRef, caption('現状', revision), 'purpose',
      '現状 ' + revision + ' · ' + currentStanding + ' · '
        + (meaning.observation ? observed.post_label ?? '観測宣言' : observed.current_label ?? '現在の意味状態') + originalNote,
      ['role=current', 'standing=' + currentStanding, 'revision=' + revision], declaredSource, currentStanding === 'observed-bound' ? postTime : time);
    edge('target-purpose', targetRef, purposeRef, '目標', {
      pair: meaning.pair, original_current_ref: meaning.pair.current_ref, current_revision: currentRevision,
      current_standing: currentStanding, purpose_standing: purposeStanding,
      comparison_status: { status: meaning.status, reason: meaning.reason ?? null,
        coverage_status: closure.coverage_status ?? null, uncovered: meaning.uncovered ?? [] },
      closure, binding, closureRecords: [...records.values()] }, knownMeaning);

    // Scopes area: the current Gap is its active units plus explicit unassigned/unresolved units.
    // `uncertain` counts only units whose responsibility or evaluation is unknown,
    // conflicting or undeclared; a known, owned, unmet Scope is a known missing change.
    const owned = new Set((meaning.scopes ?? []).flatMap(scope => Object.values(scope.criteria).flat()));
    let currentGap = 0, uncertain = 0;
    // Old obligations first: their history relations then do not cross the current units.
    for (const duty of meaning.history) {
      if (!object(duty) || typeof duty.id !== 'string') throw new Error('scope-world: historical obligation identity required');
      const dutyRef = entity(ref(space, 'obligation', duty.id), caption(duty.label ?? duty.id, '旧義務・履歴'), 'scopes', JSON.stringify(duty), ['history-preserved']);
      edge('history:' + duty.id, dutyRef, purposeRef, '旧義務', { obligation: duty, currentPair: meaning.pair });
    }
    // Scopes are grouped by their declared owner (stable, first appearance) so owner
    // relations to the Agents column, which uses the same order, never cross.
    const ownerRank = new Map();
    for (const scope of meaning.scopes ?? []) if (!ownerRank.has(scope.owner_actor)) ownerRank.set(scope.owner_actor, ownerRank.size);
    const scopes = [...(meaning.scopes ?? [])].sort((a, b) => ownerRank.get(a.owner_actor) - ownerRank.get(b.owner_actor));
    // Current -> unit relations keep their declared context and path, but are not
    // drawn (visible:false): every unit would otherwise fan to both Current and
    // Target in the Purpose column. One drawn Current -> Target relation lists them.
    const changes = [];
    const change = (id, to, label, context, path = false) => { changes.push(id); edge(id, currentRef, to, label, context, path, false); };
    for (const scope of scopes) {
      const { status, disagreement } = ownScopeStatus(scope, closure);
      const standing = scopeStanding(status, bound);
      if (standing === 'active') currentGap += 1;
      if (status === 'unknown' || status === 'conflict' || standing === 'unresolved') uncertain += 1;
      const scopeRef = entity(ref(space, 'semantic-scope', scope.id),
        caption(scope.label ?? scope.id, standing === 'unresolved' ? '未確定' : statusCaption[status]), 'scopes',
        `${scope.label ?? scope.id} · ${scope.owner_role} / ${scope.owner_actor} · ${status} · ${standingLabel[standing]}`,
        ['standing=' + standing, 'scope_status=' + status, ...(disagreement ? ['evaluation-disagreement'] : [])]);
      edge('scope:' + scope.id, scopeRef, targetRef, '引受', { scope, standing, scope_status: status,
        ...(disagreement ? { disagreement } : {}), comparison: meaning.comparison, closure, history: meaning.history, binding }, knownMeaning);
      if (standing === 'active') change('change:scope:' + scope.id, scopeRef, '変化',
        { scope_id: scope.id, standing, necessity: 'current', current_revision: currentRevision }, knownMeaning);
      else if (standing === 'unresolved') change('change:scope:' + scope.id, scopeRef, '未確定',
        { scope_id: scope.id, standing, necessity: 'unresolved', current_revision: currentRevision });
    }
    // A derived responsibility conflict (frame.responsibility) keeps its part unassigned but says so.
    const responsibility = object(observed.responsibility) ? observed.responsibility : {};
    const unassigned = (meaning.uncovered ?? []).map(id => [id, responsibility[id]?.state === 'conflict' ? 'owner-conflict' : 'uncovered-part']);
    // An unowned residual comes from the whole-Purpose evaluation; when that
    // evaluation conflicts, its units say so instead of plain unmet.
    const residualWhy = closure.purpose_status === 'conflict' ? 'whole-purpose-conflict' : 'unmet';
    for (const [list, why] of [[closure.residual, residualWhy], [closure.unknown, 'unknown'], [closure.conflicts, 'conflict']])
      for (const id of list ?? []) if (!owned.has(id) && !unassigned.some(([known]) => known === id)) unassigned.push([id, why]);
    for (const [id, why] of unassigned) {
      currentGap += 1; uncertain += 1;
      const unitRef = entity(ref(space, 'unassigned-change', id), caption(why.includes('conflict') ? '未割当・矛盾' : '未割当', id), 'scopes',
        '未割当: ' + id + ' · 担当未割当（' + why + '）。完了には昇格しません。次の観測・責任・根拠を確認します。', ['unassigned', 'owner-unassigned', 'source=' + why]);
      const context = { id, source: why, ...(object(responsibility[id]) ? { responsibility: responsibility[id] } : {}),
        comparison: meaning.comparison, closure, binding };
      change('change:unassigned:' + id, unitRef, '変化', context, knownMeaning);
      edge('residual:unassigned:' + id, unitRef, targetRef, '未達', context, knownMeaning);
    }
    // Uncertain or conflicting whole-Purpose evaluation is never an empty current Gap.
    const unresolvedUnit = (id, first, second, summary, flag, context) => {
      currentGap += 1; uncertain += 1;
      const unitRef = entity(ref(space, 'unresolved-change', id), caption(first, second), 'scopes', summary, [flag]);
      change('change:unresolved:' + id, unitRef, first, context);
      edge('residual:unresolved:' + id, unitRef, targetRef, first, context);
    };
    const evaluationContext = { comparison_status: meaning.status, reason: meaning.reason ?? closure.reason ?? null,
      binding_reason: binding.reason ?? null, purpose_status: closure.purpose_status, closure, comparison: meaning.comparison, binding };
    // The caption names which declaration is unknown: the comparison/partition, the Closure
    // mapping, or the whole-Purpose evaluation (then listing the criteria it could not settle).
    if (meaning.scopes === null || closure.purpose_status === 'unknown' || !bound) {
      const cause = meaning.scopes === null ? '比較・分解' : !bound ? '対応付け' : '全体評価';
      const pending = [...(closure.unknown ?? []), ...(closure.conflicts ?? []), ...(meaning.uncovered ?? [])];
      const reason = meaning.reason ?? closure.reason ?? binding.reason ?? closure.purpose_status_reason
        ?? (pending.length ? '未確定の条件: ' + [...new Set(pending)].join(', ') : '全体評価の宣言が未確認');
      unresolvedUnit('unknown-evaluation', cause, '未確認', cause + 'が未確認 · ' + reason + ' · 完了には昇格しません。',
        'unknown', evaluationContext);
    }
    else if (closure.purpose_status === 'conflict')
      unresolvedUnit('purpose-evaluation-conflict', '全体評価', '矛盾', '全体評価の矛盾を保持（purpose_status=conflict）· 完了には昇格しません。',
        'conflict', evaluationContext);
    else if (closure.purpose_status === 'unmet' && currentGap === 0)
      unresolvedUnit('purpose-evaluation-unmet', '全体評価', '未達', '全体評価は未達ですが責任単位へ対応付いていません · 完了には昇格しません。',
        'unexplained', evaluationContext);
    if (changes.length) edge('gap:current-target', currentRef, targetRef, '変化 ' + changes.length + ' 件',
      { change_relations: [...changes], current_revision: currentRevision, purpose_standing: purposeStanding,
        drawing: 'aggregate of the visible:false Current -> unit relations; each keeps its own context and path' });

    // Agents area: only explicitly declared identities with their declared roles.
    const actors = new Map();
    const declare = (id, role) => {
      if (typeof id !== 'string' || !id.trim()) return;
      if (!actors.has(id)) actors.set(id, []);
      actors.get(id).push(role);
    };
    for (const scope of scopes) declare(scope.owner_actor, { role: 'owner_actor', scope: scope.id, owner_role: scope.owner_role });
    if (meaning.observation) {
      declare(meaning.observation.writer, { role: 'writer' });
      declare(meaning.observation.evaluator, { role: 'evaluator' });
    }
    const activity = object(observed.agent_activity) ? observed.agent_activity : {};
    const mode = synthetic ? 'synthetic' : 'supplied';
    for (const [id, roles] of actors) {
      const seen = object(activity[id]) && typeof activity[id].source === 'string' ? activity[id] : null;
      const seenAt = typeof seen?.observedAt === 'string' && Number.isFinite(Date.parse(seen.observedAt)) ? seen.observedAt : null;
      const agentRef = entity(ref(space, 'agent', id), caption(id, [...new Set(roles.map(value => roleCaption[value.role]))].join('・')), 'agents',
        id + (seen ? ' · 宣言（' + mode + '）: ' : ' · 宣言のみ（' + mode + '）: ') + roles.map(value => value.role).join(', ')
          + (seen ? ' · session 観測: ' + JSON.stringify(seen.value) + '（' + seen.source + ' @' + (seenAt ?? 'unknown') + '）' : ' · 実活動・セッションは未観測'),
        seen ? [mode, 'declared', 'session-observed'] : [mode, 'declared-only', 'activity-unobserved'], declaredSource, { ...time, observedAt: seenAt });
      for (const role of roles) {
        // A session observation (even transcript-only) is not activity: activity stays unobserved.
        const declared = { declared_id: id, ...role, synthetic, activity: 'unobserved', ...(seen ? { session_observed: seen.value } : {}) };
        if (role.role === 'owner_actor') edge('owner:' + role.scope, agentRef, ref(space, 'semantic-scope', role.scope), '担当', declared);
        // The writer/evaluator role relations always cross the Scopes pane, so their
        // overview line is not drawn (visible:false). The records stay in the World,
        // catalog, search and detail; the roles stay in the Agent caption and summary.
        else edge('observation-' + role.role + ':' + id, agentRef, currentRef, roleCaption[role.role],
          { ...declared, observed_ref: meaning.observation.observed_ref }, false, false);
      }
    }
    agentsSeen = { declared: actors.size, observed: [...actors.keys()].filter(id => object(activity[id])).length };
    if (actors.size === 0) entity(ref(space, 'agent-declaration', 'missing'), caption('担当', '宣言なし'), 'agents',
      '担当の宣言なし · 供給データに担当者の宣言がありません。実Agentも未観測です。', ['missing']);

    if (new Set(entities.map(value => key(value.ref))).size !== entities.length) throw new Error('scope-world: qualified entity collision');
    return { id: observed.id, rev: observed.rev, asOf: observed.asOf, sourceState: 'supplied fixture/domain declarations; actual truth unverified',
      // coverage.unknown counts unassigned and unresolved units and Scopes whose own
      // status is unknown/conflict or whose standing is unresolved. Known owned unmet
      // Scopes belong to the current Gap but are not unknown.
      coverage: { state: 'partial', label: '供給入力の投影 / 実状態・意味真偽は未実証', observed: entities.length, unsupported: 0,
        unknown: uncertain }, entities, relations };
  });
  const final = input.frames.at(-1).semantic.comparison;
  const space = final.current_ref?.space ?? 'semantic-input-unresolved';
  const purpose = ref(space, 'purpose', final.purpose_id);
  return { kind: 'ui.atlasWorldInput.v1', authority: false,
    presentation: { areas: [{ id: 'purpose', label: 'Purpose：現状と目標', order: 0 },
      { id: 'scopes', label: 'Scope：必要な意味差の責任単位', order: 1 }, { id: 'agents', label: 'Agent：宣言された担当（' + (synthetic ? '合成' : '供給') + '・'
        + (agentsSeen.observed === 0 ? '未観測' : agentsSeen.observed === agentsSeen.declared ? '観測あり' : '一部観測') + '）', order: 2 }],
    purposeAreaId: 'purpose', directionTargets: [purpose], defaultSelection: purpose },
    frames, comparisons: [], note: 'Supplied-data three-pane projection. Each frame shows one selected Current revision; the original comparison, Closure records, evidence and old obligations stay readable as history. Agents are declared ids only (synthetic, activity unobserved). No admission, actual Purpose achievement or autonomous Factory claim.' };
};

// File I/O remains at this application adapter's edge. The real published
// Closure module is used here; there is no configurable substitute implementation.
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFile } = await import('node:fs/promises');
  const { reduceClosure } = await import('./closure.mjs');
  const [inputPath, ...closurePaths] = process.argv.slice(2);
  if (!inputPath || closurePaths.length === 0) throw new Error('usage: node semantic-scope-world.mjs <semantic-input.json> <closure-input.jsonl>...');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const reduced = reduceClosure(...await Promise.all(closurePaths.map(path => readFile(path, 'utf8'))));
  console.log(JSON.stringify(semanticScopeWorld(input, reduced)));
}
