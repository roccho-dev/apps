// Independent, keyless provenance check. This never regrades model observations.
import { createHash } from 'node:crypto';
import { canonical } from './semantic-score.mjs';
import { validateAxisInput, validParts, validRequired, missingFromRequired } from './component-axis-score.mjs';

export const RESERVE_POOL_SHA256 = 'b64985019e2248c4fde62e330f319846c96ab5014db4e96a7d8f0d50d5f86076';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const need = (condition, message) => { if (!condition) throw Error(message); };

export function auditReserveProjection({ poolBytes, projectionBytes, oracleBytes, bundleBytes }) {
  const issues = [], result = { schema: 'voice-ui.component-axes-reserve-audit/1', source_pool_sha256: hash(poolBytes),
    projection_sha256: hash(projectionBytes), oracle_sha256: hash(oracleBytes), bundle_sha256: hash(bundleBytes) };
  try {
    need(result.source_pool_sha256 === RESERVE_POOL_SHA256, 'original reserve pool raw bytes');
    const pool = JSON.parse(poolBytes), projection = JSON.parse(projectionBytes), oracle = JSON.parse(oracleBytes), bundle = JSON.parse(bundleBytes);
    need(result.bundle_sha256 === pool.canonical_bundle_sha256 && validParts(bundle.parts) && bundle.parts.length === 8, 'original canonical inventory');
    need(validateAxisInput(projection) && projection.axis === 'E' && projection.cases.length === 10, 'E10 input shape');
    need(projection.oracle_sha256 === result.oracle_sha256, 'input/oracle byte binding');
    need(oracle.schema === 'voice-ui.component-axes-oracle/1' && oracle.axis === 'E'
      && oracle.source_seal_sha256 === RESERVE_POOL_SHA256 && oracle.source_batch === 'reserve_unopened', 'oracle reserve identity');
    need(same(oracle.stock_parts, bundle.parts), 'oracle original inventory');
    need(same(projection.fixture_contract, pool.fixture_contract) && same(oracle.fixture_contract, pool.fixture_contract), 'original fixture contract');
    const order = pool.batches.reserve_unopened.case_order;
    need(Array.isArray(order) && order.length === 10 && new Set(order).size === 10, 'original reserve order');
    need(Array.isArray(oracle.cases) && oracle.cases.length === 10, 'oracle reserve count');
    const originals = order.map(id => {
      const found = pool.cases.filter(c => c.id === id); need(found.length === 1, 'unique original reserve case'); return found[0];
    });
    need(same(projection.cases, originals.map(({ id, fixture, utterance }) => ({ id, fixture, utterance }))), 'unchanged input cases and order');
    const strata = { sufficient: 0, missing: 0, ambiguous: 0, 'no-change': 0 };
    const originalHashes = [];
    for (const [i, original] of originals.entries()) {
      const actual = oracle.cases[i];
      const wantedKeys = [...Object.keys(original), 'expected_intent', 'required'].sort();
      need(actual && same(Object.keys(actual).sort(), wantedKeys), 'only two mechanical oracle fields may be added');
      need(same(Object.fromEntries(Object.keys(original).map(k => [k, actual[k]])), original), 'unchanged original oracle fields and order');
      need(Object.hasOwn(strata, original.expected_gate), 'original reserve stratum');
      strata[original.expected_gate]++;
      const clear = ['sufficient', 'missing'].includes(original.expected_gate);
      need(actual.expected_intent === (clear ? 'change' : original.expected_gate), 'mechanical expected intent');
      const required = clear ? [] : null;
      if (clear) {
        for (const region of original.expected_added_regions) {
          const found = required.find(r => r.label === region.label && r.kind === region.kind);
          if (found) found.quantity++; else required.push({ label: region.label, kind: region.kind, quantity: 1 });
        }
        need(validRequired(required), 'bounded original target multiset');
        need(same(missingFromRequired(required, bundle.parts), original.expected_missing), 'original one-use inventory difference');
      } else need(same(original.expected_missing, []) && same(original.expected_added_regions, [])
        && same(original.expected_added_edges, []), 'original unchanged controls');
      need(same(actual.required, required), 'required must be the original target multiset');
      need(original.expected_added_regions.length <= 3 && original.expected_added_edges.length <= 1, 'original finite scope');
      originalHashes.push({ id: original.id, sha256: hash(Buffer.from(JSON.stringify(canonical(original)))) });
    }
    need(same(strata, { sufficient: 4, missing: 4, ambiguous: 1, 'no-change': 1 }), 'original 4/4/2 denominator');
    Object.assign(result, { case_order: order, strata, original_case_object_sha256: originalHashes });
  } catch (error) { issues.push(error?.name === 'SyntaxError' ? 'invalid JSON' : error.message); }
  return { ...result, status: issues.length ? 'FAIL' : 'PASS', issues,
    scope: 'raw original seal, case/target/order/fixture preservation and mechanical required derivation only; no model-quality verdict' };
}
