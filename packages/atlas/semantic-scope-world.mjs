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

/** The second argument is the real reduceClosure output, not a substitute join. */
export const semanticScopeWorld = (input, reducedClosure) => {
  if (!object(input) || input.schema !== 'atlas.semantic-scope-world/1' || input.authority !== false
    || !Array.isArray(input.frames) || input.frames.length === 0) throw new Error('scope-world: explicit observation frames required');
  const records = readReduced(reducedClosure);
  const historicalIds = new Map();
  const frames = input.frames.map(observed => {
    if (typeof observed.id !== 'string' || !Number.isSafeInteger(observed.rev) || observed.rev < 0
      || !Number.isFinite(Date.parse(observed.asOf))) throw new Error('scope-world: observation identity/revision/time required');
    const meaning = normalizeSemanticScopes(observed.semantic);
    const previous = historicalIds.get(meaning.pair.purpose_id) ?? new Set();
    const present = new Set(meaning.history.map(value => value.id));
    if ([...previous].some(id => !present.has(id))) throw new Error('scope-world: prior obligation omitted; retain it with explicit disposition');
    historicalIds.set(meaning.pair.purpose_id, new Set([...previous, ...present]));
    const binding = bindClosure(meaning, records);
    const space = meaning.pair.current_ref?.space ?? 'semantic-input-unresolved';
    const purposeRef = ref(space, 'purpose', meaning.pair.purpose_id);
    const currentRef = ref(space, 'purpose-state-current', meaning.pair.purpose_id + ':current');
    const targetRef = ref(space, 'purpose-state-target', meaning.pair.purpose_id + ':target');
    const deltaRef = ref(space, 'semantic-delta', meaning.pair.purpose_id + ':delta');
    const entities = [], relations = [];
    const declaredSource = source(observed.source_ref ?? 'source:unavailable');
    const time = { observedAt: observed.asOf, acquiredAt: null, effectiveAt: null };
    const knownMeaning = ['declared_partition', 'declared_equivalent', 'incomplete', 'undecomposed'].includes(meaning.status);
    const entity = (entityRef, label, area, summary, flags = [], ownSource = declaredSource, ownTime = time) => {
      entities.push({ ref: entityRef, label, area, order: entities.length, visible: true, activity: 'none',
        summary, source: ownSource, time: { ...ownTime }, flags });
      return entityRef;
    };
    const edge = (id, from, to, label, context, kind = 'declared-relation', ownSource = declaredSource, ownTime = time, path = false) => {
      relations.push({ ref: ref(space, kind, id), from, to, kind, label, context,
        source: ownSource, time: { ...ownTime }, flags: ['authority=false'], containment: null, path });
    };
    entity(purposeRef, observed.purpose_label ?? 'Purpose', 'purpose', '供給された目的。実達成の証明ではありません。', ['domain-declared']);
    entity(currentRef, '現状 t0', 'purpose', observed.current_label ?? '現在の意味状態', ['role=current']);
    entity(targetRef, '目標 t1', 'purpose', observed.target_label ?? '目的達成状態', ['role=target', 'effective-time-unavailable']);
    entity(deltaRef, '意味差・分解: ' + meaning.status, 'purpose', meaning.reason ?? 'current → target の供給された意味比較', ['semantic-truth-not-verified']);
    edge('current-delta', currentRef, deltaRef, '現状からの意味差', { pair: meaning.pair, comparison: meaning.comparison }, 'declared-relation', declaredSource, time, knownMeaning);
    edge('delta-target', deltaRef, targetRef, '目標へ必要な変換', { pair: meaning.pair, comparison: meaning.comparison }, 'declared-relation', declaredSource, time, knownMeaning);
    edge('target-purpose', targetRef, purposeRef, 'このPurposeの目標', { pair: meaning.pair, closure: meaning.closure, binding }, 'declared-relation', declaredSource, time, knownMeaning);
    if (observed.semantic.observation) {
      const postRef = entity(ref(space, 'purpose-state-observed', meaning.pair.purpose_id + ':observed'), '再観測した現状', 'purpose',
        `Scope ${meaning.closure.scope_status}; Purpose ${meaning.closure.purpose_status} · ${observed.post_label ?? '観測宣言'}`);
      edge('post-observation', postRef, purposeRef, '目的全体を再評価', { pair: meaning.pair, observation: observed.semantic.observation,
        closure: meaning.closure, observedBinding: observed.semantic.bindings?.observed ?? null });
    }
    for (const scope of meaning.scopes ?? []) {
      const scopeRef = entity(ref(space, 'semantic-scope', scope.id), scope.label ?? scope.id, 'scopes',
        `${scope.owner_role} / ${scope.owner_actor} · Scope ${meaning.closure.scope_status}; Purpose ${meaning.closure.purpose_status}`);
      edge('scope:' + scope.id, scopeRef, deltaRef, '引き受ける意味差', { scope, comparison: meaning.comparison,
        closure: meaning.closure, history: meaning.history, binding }, 'declared-relation', declaredSource, time, knownMeaning);
    }
    const outstanding = [...new Set([...(meaning.uncovered ?? []), ...(meaning.closure.residual ?? []),
      ...(meaning.closure.unknown ?? []), ...(meaning.closure.conflicts ?? [])])];
    if (meaning.scopes === null || meaning.closure.purpose_status === 'unknown' || binding.state === 'unknown') outstanding.push('unknown-evaluation');
    for (const id of [...new Set(outstanding)]) {
      const residualRef = entity(ref(space, 'residual', id), id === 'unknown-evaluation' ? '未確認・未分解を保持' : '残差: ' + id,
        'evidence', '完了には昇格しません。次の観測・責任・根拠を確認します。', ['unresolved']);
      edge('residual:' + id, residualRef, deltaRef, '未達・未確認', { id, closure: meaning.closure, comparison: meaning.comparison, binding });
    }
    for (const duty of meaning.history) {
      if (!object(duty) || typeof duty.id !== 'string') throw new Error('scope-world: historical obligation identity required');
      const dutyRef = entity(ref(space, 'obligation', duty.id), duty.label ?? '旧義務: ' + duty.id, 'evidence', JSON.stringify(duty), ['history-preserved']);
      edge('history:' + duty.id, dutyRef, purposeRef, '旧義務を保持', { obligation: duty, currentPair: meaning.pair });
    }
    // Existing seven-kind entities/typed relations are reused, with distinct
    // qualified identity. An unknown domain binding never manufactures a bridge.
    for (const record of records.values()) {
      const nodeRef = ref(legacySpace, record.kind, record.id);
      const recordSource = { ...record.sources[0], kind: 'declared-closure-source' };
      const absentTime = { observedAt: null, acquiredAt: null, effectiveAt: null };
      entity(nodeRef, record.label, 'closure', JSON.stringify(record), ['existing-closure-contract'], recordSource, absentTime);
      const links = record.kind === 'purpose' ? record.parents : record.kind === 'ideal' ? record.purposes
        : record.kind === 'gap' ? [record.current, record.ideal] : record.kind === 'fill' ? record.gaps
          : record.kind === 'receipt' ? [record.fill] : record.kind === 'residual' ? [record.receipt, ...record.next] : [];
      for (const id of links) {
        const to = records.get(id);
        if (!to) throw new Error('scope-world: actual reduced Closure reference missing');
        const target = ref(legacySpace, to.kind, to.id);
        // gap.current names the originating Current; the purpose-closure path
        // is Current -> Gap -> Ideal, while work/results point toward their Gap.
        const [from, toward] = record.kind === 'gap' && id === record.current ? [target, nodeRef] : [nodeRef, target];
        edge(JSON.stringify(['closure', record.id, id]), from, toward, '既存Closure関係',
          { closureRecord: record, declaredFieldDirection: record.kind === 'gap' && id === record.current ? 'current-to-gap' : 'record-to-reference' },
          'closure-reference', recordSource, absentTime, true);
      }
    }
    if (binding.state === 'declared-bound') {
      edge('binding:purpose', purposeRef, ref(legacySpace, 'purpose', binding.purpose.id), '明示されたPurpose対応', { binding }, 'declared-relation', declaredSource, time, true);
      edge('binding:current', currentRef, ref(legacySpace, 'current', binding.current.id), '明示された現状対応', { binding }, 'declared-relation', declaredSource, time, true);
      binding.target.forEach((target, index) => edge('binding:target:' + index, targetRef, ref(legacySpace, 'ideal', target.id), '明示された目標対応', { binding }, 'declared-relation', declaredSource, time, true));
      if (binding.observed) edge('binding:observed', ref(space, 'purpose-state-observed', meaning.pair.purpose_id + ':observed'),
        ref(legacySpace, 'current', binding.observed.id), '明示された再観測対応', { binding }, 'declared-relation', declaredSource, time, true);
    }
    if (new Set(entities.map(value => key(value.ref))).size !== entities.length) throw new Error('scope-world: qualified entity collision');
    return { id: observed.id, rev: observed.rev, asOf: observed.asOf, sourceState: 'supplied fixture/domain declarations; actual truth unverified',
      coverage: { state: 'partial', label: '供給入力の投影 / 実状態・意味真偽は未実証', observed: entities.length, unsupported: 0,
        unknown: outstanding.length }, entities, relations };
  });
  const final = input.frames.at(-1).semantic.comparison;
  const space = final.current_ref?.space ?? 'semantic-input-unresolved';
  const purpose = ref(space, 'purpose', final.purpose_id);
  return { kind: 'ui.atlasWorldInput.v1', authority: false,
    presentation: { areas: [{ id: 'purpose', label: 'Purpose：現状と目標', order: 0 },
      { id: 'scopes', label: 'Scope：意味差の責任', order: 1 }, { id: 'evidence', label: '証拠・残差・旧義務', order: 2 },
      { id: 'closure', label: '既存Purpose Closure', order: 3 }], purposeAreaId: 'purpose', directionTargets: [purpose], defaultSelection: purpose },
    frames, comparisons: [], note: 'Supplied-data semantic Scope projection. Current/target roles coexist within each observation frame; target is not a later observation. No admission, actual Purpose achievement or autonomous Factory claim.' };
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
