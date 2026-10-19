import { isPartSymbol, KEY_PATTERN, PURPOSE_MAX } from './contract.mjs';

// Descriptions travel in the provider's existing, hash-verified summary.
// v1 remains byte-compatible for symbols. v2 preserves a key and purpose even
// without an image; neither spelling may be resolved from a later catalogue.
const SCHEMA = 'voice-ui.part-description/1';
const IDENTITY_SCHEMA = 'voice-ui.part-description/2';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const valid = value => exact(value, ['schema', 'key', 'purpose', ...(value?.schema === SCHEMA ? ['symbol'] : [])])
  && [SCHEMA, IDENTITY_SCHEMA].includes(value.schema)
  && typeof value.key === 'string' && KEY_PATTERN.test(value.key) && value.key !== 'none'
  && typeof value.purpose === 'string' && value.purpose.trim().length > 0 && value.purpose.length <= PURPOSE_MAX
  && (value.schema === IDENTITY_SCHEMA || isPartSymbol(value.symbol));

export function partSummary(part, { preserveIdentity = false } = {}) {
  if (typeof preserveIdentity !== 'boolean') throw new TypeError('invalid identity preservation option');
  const symbol = Object.hasOwn(part, 'symbol');
  if (!symbol && !preserveIdentity) return '';
  const value = { schema: symbol ? SCHEMA : IDENTITY_SCHEMA, key: part.key, purpose: part.purpose,
    ...(symbol ? { symbol: part.symbol } : {}) };
  if (!valid(value)) throw new TypeError('invalid supplied part description');
  const result = JSON.stringify(value);
  if (result.length > 2000) throw new TypeError('part description exceeds region summary capacity');
  return result;
}

export function partResourceView(records = []) {
  const resources = [], placements = [], bySource = new Map();
  for (const region of records.filter(record => record.type === 'region')) {
    let value;
    try { value = JSON.parse(region.summary); } catch { continue; }
    if (![SCHEMA, IDENTITY_SCHEMA].includes(value?.schema)) continue;
    if (!valid(value) || JSON.stringify(value) !== region.summary) throw new TypeError('invalid stored part description');
    if (value.schema === IDENTITY_SCHEMA) continue;
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
