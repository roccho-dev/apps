import { canonical, gradeGraph } from './semantic-score.mjs';

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const bag = rows => rows.map(row => JSON.stringify(canonical(row))).sort();

// The expected structure is supplied separately from model answers. This checks
// the public reducer and the UI's reported state/view, NOT painted pixels.
export async function auditReducedView({ log, ui, initialRecords, oracle, protocol }) {
  const reduced = await protocol.verifyDecisionLog(log);
  const semantic = gradeGraph(initialRecords, reduced.records, oracle);
  const initialIds = new Set(initialRecords.filter(row => row.type === 'region').map(row => row.id));
  const additions = reduced.records.filter(row => row.type === 'region' && !initialIds.has(row.id));
  const remaining = new Set(additions.map(row => row.id));
  const reference = id => initialIds.has(id) ? 'fixture:' + id : (() => {
    const row = additions.find(item => item.id === id);
    return row && additions.filter(item => item.label === row.label).length === 1
      ? 'added:' + row.label : 'UNRESOLVED:' + id;
  })();
  const expectedImages = [];
  const expectedDescription = summary => {
    let value;
    try { value = JSON.parse(summary); } catch { return null; }
    return value?.schema === 'voice-ui.part-description/1' ? value : null;
  };
  const imageFor = (id, description) => {
    const symbol = description.symbol;
    return { target: 'node:' + id, contract: 'image/1',
      source: { type: 'url', href: symbol?.href }, provenance: symbol?.provenanceRef,
      slot: 'content', view: { alt: symbol?.alt, fit: 'contain', opacity: 1 } };
  };
  // Whole-view expectations include retained state, not only this turn's additions.
  // Their symbols come from the independent initial/expected records, not from
  // the app's encoder or the UI reporting port. New opaque IDs are matched once.
  for (const row of initialRecords.filter(item => item.type === 'region')) {
    const description = expectedDescription(row.summary);
    if (description) expectedImages.push(imageFor(row.id, description));
  }
  for (const expected of oracle.expected_added_regions) {
    const description = expectedDescription(expected.summary);
    if (!description) continue;
    const match = additions.find(row => remaining.has(row.id) && row.label === expected.label
      && row.kind === expected.kind && row.summary === expected.summary && reference(row.parent) === expected.parent);
    if (!match) { expectedImages.push({ unmatched: expected }); continue; }
    remaining.delete(match.id);
    expectedImages.push(imageFor(match.id, description));
  }
  let viewValid = false;
  try {
    await protocol.createEnvelope(reduced.log, null, ui?.view);
    viewValid = ui.view.pattern === protocol.GRAPH_PATTERN;
  } catch { /* A malformed reported view is RED, never repaired from the expected one. */ }
  const composition = ui?.view?.resourceComposition;
  const resources = Array.isArray(composition?.resources) ? composition.resources : [], placements = Array.isArray(composition?.placements) ? composition.placements : [];
  const used = new Set(placements.map(row => row.resourceRef));
  const actualImages = placements.map(placement => {
    const matching = resources.filter(resource => resource.id === placement.resourceRef);
    return matching.length === 1 ? { target: placement.targetRef, contract: matching[0].contract,
      source: matching[0].source, provenance: matching[0].provenanceRef, slot: placement.slot, view: placement.view }
      : { invalid_reference: placement.resourceRef };
  });
  const fields = {
    ui_view_contract_valid: viewValid,
    reduced_matches_expected: semantic.graph_exact,
    ui_head_matches_reduced: ui?.head === reduced.head,
    ui_records_match_reduced: same(ui?.records, reduced.records),
    resource_view_matches_expected: same(bag(actualImages), bag(expectedImages))
      && resources.every(resource => used.has(resource.id)) && new Set(resources.map(row => row.id)).size === resources.length,
  };
  return { schema: 'voice-ui.reduced-view-audit/1', status: Object.values(fields).every(Boolean) ? 'PASS' : 'RED',
    ...fields, head: reduced.head, expected_images: expectedImages.length, reported_placements: placements.length,
    scope: 'JSONL_REDUCE_AND_UI_STATE_VIEW', pixels: 'SEPARATE_REQUIRED_GATE', model_quality: 'NOT_MEASURED' };
}
