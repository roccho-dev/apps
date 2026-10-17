// Independent semantic oracle. Protocol/layout/HTTP/budget/browser admissibility
// are separate mandatory audits; this module cannot turn those axes into PASS.
export const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const json = value => JSON.stringify(canonical(value));
const same = (a, b) => json(a) === json(b);
const bag = rows => rows.map(json).sort();
const equalBag = (a, b) => same(bag(a), bag(b));
const exactKeys = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row)
  && equalBag(Object.keys(row), keys);
export const semantics = records => records.filter(r => r.type !== 'layout').map(r => {
  if (r.type !== 'region') return r;
  const { bounds, ...value } = r;
  return value;
});

export function gradeGraph(initialRecords, finalRecords, oracle) {
  const initial = semantics(initialRecords), final = semantics(finalRecords);
  const key = r => r.type === 'meta' ? 'meta' : JSON.stringify([r.type, r.id]);
  const before = new Map(initial.map(r => [key(r), r]));
  const after = new Map(final.map(r => [key(r), r]));
  const uniqueRecordKeys = before.size === initial.length && after.size === final.length;
  const preserved = uniqueRecordKeys && initial.every(r => same(r, after.get(key(r))));
  const added = final.filter(r => !before.has(key(r)));
  const regions = added.filter(r => r.type === 'region');
  const edges = added.filter(r => r.type === 'relation');
  const oldRegionIds = new Set(initial.filter(r => r.type === 'region').map(r => r.id));
  const newById = new Map(regions.map(r => [r.id, r]));
  const ref = id => {
    if (oldRegionIds.has(id)) return 'fixture:' + id;
    const row = newById.get(id);
    return row && regions.filter(r => r.label === row.label).length === 1
      ? 'added:' + row.label : 'UNRESOLVED:' + id;
  };
  const actualRegions = regions.map(r => ({ label: r.label, kind: r.kind, parent: ref(r.parent) }));
  const actualEdges = edges.map(r => ({ from: ref(r.from), to: ref(r.to), kind: r.kind, label: r.label }));
  const cleanRegions = regions.every(r => r.summary === ''
    && exactKeys(r, ['type', 'id', 'parent', 'label', 'kind', 'summary']));
  const cleanEdges = edges.every(r => exactKeys(r, ['type', 'id', 'from', 'to', 'kind', 'label']));
  const noOtherNewSemantics = added.length === regions.length + edges.length;
  return {
    graph_exact: preserved && noOtherNewSemantics && cleanRegions && cleanEdges
      && equalBag(actualRegions, oracle.expected_added_regions) && equalBag(actualEdges, oracle.expected_added_edges),
    unique_record_keys: uniqueRecordKeys,
    existing_semantics_preserved: preserved,
    semantic_unchanged: uniqueRecordKeys && equalBag(initial, final),
    clean_new_regions: cleanRegions, clean_new_edges: cleanEdges, no_other_new_semantics: noOtherNewSemantics,
    actual_added_regions: actualRegions, actual_added_edges: actualEdges,
  };
}

export function gradeMissing(actual, oracle) {
  return Array.isArray(actual) && actual.every(x => exactKeys(x, ['label', 'kind', 'occurrence']))
    && equalBag(actual, oracle.expected_missing);
}

export function gradeGate(coverage, oracle) {
  const valid = exactKeys(coverage, ['choice', 'confidence'])
    && ['sufficient', 'missing', 'ambiguous', 'no-change', 'unsupported'].includes(coverage.choice)
    && typeof coverage.confidence === 'number' && Number.isFinite(coverage.confidence)
    && coverage.confidence >= 0 && coverage.confidence <= 1;
  return {
    contract_valid: valid,
    raw_choice_correct: valid && coverage.choice === oracle.expected_gate,
    accepted_gate_correct: valid && coverage.choice === oracle.expected_gate && coverage.confidence >= 0.5,
  };
}
