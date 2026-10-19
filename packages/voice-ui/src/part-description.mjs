import { isPartSymbol, KEY_PATTERN, PURPOSE_MAX } from './contract.mjs';

// App-owned descriptions inside the existing, hash-verified region summary.
// The provider log and storage format do not change. A rendered image is
// derived from its exact region, never looked up again by a displayed name
// or by the current catalogue. Ordinary summaries remain ordinary text.
const SCHEMA = 'voice-ui.part-description/1';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const valid = value => exact(value, ['schema', 'key', 'purpose', 'symbol']) && value.schema === SCHEMA
  && typeof value.key === 'string' && KEY_PATTERN.test(value.key) && value.key !== 'none'
  && typeof value.purpose === 'string' && value.purpose.trim().length > 0 && value.purpose.length <= PURPOSE_MAX
  && isPartSymbol(value.symbol);

export function partSummary(part) {
  if (!Object.hasOwn(part, 'symbol')) return '';
  const value = { schema: SCHEMA, key: part.key, purpose: part.purpose, symbol: part.symbol };
  if (!valid(value)) throw new TypeError('invalid supplied part description');
  const result = JSON.stringify(value);
  if (result.length > 2000) throw new TypeError('part description exceeds region summary capacity');
  return result;
}

export function partResourceView(records) {
  const resources = [], placements = [], bySource = new Map();
  for (const region of records.filter(record => record.type === 'region')) {
    let value;
    try { value = JSON.parse(region.summary); } catch { continue; }
    if (value?.schema !== SCHEMA) continue;
    if (!valid(value) || JSON.stringify(value) !== region.summary) throw new TypeError('invalid stored part description');
    const { symbol } = value;
    let resource = bySource.get(symbol.href);
    if (resource && resource.provenanceRef !== symbol.provenanceRef)
      throw new TypeError('one symbol source has conflicting provenance');
    if (!resource) {
      resource = { id: 'part-image-' + (resources.length + 1), contract: 'image/1',
        source: { type: 'url', href: symbol.href }, provenanceRef: symbol.provenanceRef };
      bySource.set(symbol.href, resource); resources.push(resource);
    }
    placements.push({ id: 'part-placement-' + (placements.length + 1), resourceRef: resource.id,
      targetRef: 'node:' + region.id, slot: 'content', view: { alt: symbol.alt, fit: 'contain' } });
  }
  return placements.length ? { resourceComposition: { schema: 'typed-resource-composition/1', resources, placements } } : {};
}
