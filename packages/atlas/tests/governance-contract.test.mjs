import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalize } from '../collect/adapter.mjs';
import { collect, toJsonl } from '../collect/collect.mjs';
import { joinLog } from '../live.mjs';
import { deriveAtlas } from '../events.mjs';
import { contractWorld } from '../contract.mjs';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const response = value => { const text = typeof value === 'string' ? value : JSON.stringify(value) + '\n'; return { text, sha256: sha(text) }; };
const read = (s, key) => JSON.parse(s.responses[key].text);
const change = (s, key, fn) => { const row = read(s, key); fn(row); s.responses[key] = response(row); };
const signMember = s => {
  const member = read(s, 'member'); delete member.memberDigest; member.memberDigest = sha(canonical(member));
  s.responses.member = response(member);
  for (const key of ['package', 'gate']) change(s, key, value => {
    value.packageContractClosure = member; value.packageContractClosureDigest = member.memberDigest;
  });
};

// Synthetic shape fixture, not an admission, actual report, or human Purpose evaluation.
function fixture() {
  const requirement = { repository: 'example/adrs', revision: 'a'.repeat(40), path: 'decisions/finite.jsonl' };
  const meaning = { meaning_identity: { subject: { repository: 'example/apps', obligation_id: 'artifact.v1' }, claim_ceiling: 'FINITE' },
    apps_source_binding: { revision: 'b'.repeat(40) } };
  meaning.meaning_identity_contract = { meaning_digest: sha(canonical(meaning.meaning_identity)) };
  const meaningResponse = response(meaning); requirement.digest = meaningResponse.sha256;
  const binding = { targetCandidate: 'b'.repeat(40), governanceCandidate: 'c'.repeat(40), governanceRepository: 'example/governance', obligationId: 'artifact.v1',
    claimCeiling: 'FINITE', requirement, requirementDigest: sha('synthetic projected requirement'), meaningDigest: meaning.meaning_identity_contract.meaning_digest };
  const member = { kind: 'governance.packageContractClosureMember.v3', status: 'pass', authority: false, adoption: false,
    releasePublished: false, remaining: 0, evidenceBound: true, observerMeaningVerified: true, receiptReplayed: true, comparatorReplayed: true,
    logicalRepository: 'example/apps', providerRepository: 'example/apps', targetCandidate: binding.targetCandidate,
    governanceCandidate: binding.governanceCandidate, obligationId: binding.obligationId, claimCeiling: binding.claimCeiling,
    acceptedRequirementRevision: requirement.revision, acceptedRequirementDigest: binding.requirementDigest, contractDiffStatus: 'CLOSED', contractDiffExit: 0 };
  member.memberDigest = sha(canonical(member));
  const common = { status: 'pass', authority: false, releasePublished: false, candidateSha: binding.governanceCandidate,
    packageContractClosure: member, packageContractClosureDigest: member.memberDigest };
  const s = { type: 'governance-contract', owner: 'example', repo: 'apps', binding, fetchedAt: '2026-10-18T00:00:00Z',
    provider: { repository: 'example/governance', retrievedAt: '2026-10-18T00:00:00Z', artifact: { id: 12, created_at: '2026-10-17T07:22:47Z',
      workflow_run: { id: 34, head_sha: binding.governanceCandidate } },
    run: { id: 34, head_sha: binding.governanceCandidate, status: 'completed', conclusion: 'success' } },
    responses: { member: response(member), meaning: meaningResponse,
      package: response({ ...common, kind: 'governance.finalScopePurposeJoin.package.v1', adoption: false, remaining: 0 }),
      gate: response({ ...common, kind: 'governance.finalScopePurposeJoin.gate.v8', decision: 'allow', meaningAuthority: false,
        effectAuthority: false, companyAdoptionEffect: false, operationalAdoptionEffect: false }),
      input: response({ kind: 'contractDiffInput.v1', required: { source: requirement, rows: [{ id: binding.obligationId, contract: { obligation_digest: binding.requirementDigest } }] },
        provided: { source: { repository: 'example/apps', revision: binding.targetCandidate },
          rows: [{ id: binding.obligationId, evidence_refs: { build: 'receipt:fixture' } }] },
        observations: { source: { repository: binding.governanceRepository, revision: binding.governanceCandidate },
          rows: [{ id: binding.obligationId, attempt: binding.targetCandidate, refs: { build: 'receipt:fixture' } }] },
        receipts: { rows: [{ id: 'receipt:fixture', role: 'build', obligation_id: binding.obligationId, attempt: binding.targetCandidate, status: 'PASS', readback: 'PASS' }] } }) } };
  s.responses.manifest = response([{ path: 'contract-diff-input.json', sha256: s.responses.input.sha256 },
    { path: 'sources/adrs/apps-requirement-decision.jsonl', sha256: s.responses.meaning.sha256 }]);
  change(s, 'member', row => { row.bundleManifestDigest = s.responses.manifest.sha256; }); signMember(s);
  return s;
}

// A caller explicitly selects this finite observation condition. No business Purpose is inferred.
function declarations(target, maxAge = 'P2D', at = '2026-10-17T07:00:00Z', source = 'synthetic:packages/atlas/tests/governance-contract.test.mjs') {
  const common = { recordedAt: at, actor: 'caller', source: { ref: source, digest: sha(readFileSync(new URL(import.meta.url))) } };
  return jsonl([{ ...common, kind: 'purpose.set', purpose: { id: 'finite-observation', label: 'Observe the selected finite contract result' }, rev: 'r1' },
    { ...common, kind: 'ideal.set', purpose_id: 'finite-observation', purpose_rev: 'r1', version: 'i1',
      requires: [{ id: 'contract', label: 'The exact member reports contractDiffStatus CLOSED, referenced by the same final reports',
        predicate: { target: { kind: 'state', id: target }, op: 'equals', value: 'CLOSED' }, maxAge, norm: 'n' }] }]);
}
const control = jsonl([{ schema: 'atlas.control-norms/1', authority: false },
  { kind: 'norm', id: 'n', R: [], W: ['caller'], binding: { purposeId: 'finite-observation', conditions: ['contract'] } }]);
function derive(s, recordedAt, { maxAge = 'P2D', idealAt, source, prior = [] } = {}) {
  const records = normalize(s), events = collect(records, recordedAt);
  const { log, held } = joinLog(declarations(records[0].target, maxAge, idealAt, source), [toJsonl([...prior, ...events])]);
  assert.deepEqual(held, []);
  const result = deriveAtlas(log, control);
  return { events, log, result, world: contractWorld(result), last: contractWorld(result).frames.at(-1) };
}

test('member/final bytes → collect → existing Atlas; CLOSED, matched and achieved stay separate', () => {
  const s = fixture(), at = s.fetchedAt, out = derive(s, at);
  assert.equal(out.events.length, 1); assert.equal(out.events[0].value, 'CLOSED');
  assert.equal(out.events[0].observedAt, s.provider.artifact.created_at);
  assert.match(out.events[0].source.ref, /fetchedAt=2026-10-18/);
  assert.ok(out.events[0].target.startsWith('example/apps@' + s.binding.targetCandidate));
  assert.ok(out.events[0].target.includes(s.binding.requirement.digest));
  assert.equal(out.last.phase, 'matched'); assert.equal(out.last.gap.summary.open, 0);
  assert.equal(out.last.matched_until, '2026-10-19T07:22:47.000Z');
  assert.ok(out.world.frames.some(frame => frame.gap.summary.open === 1));
  assert.equal(out.world.frames.flatMap(frame => frame.journal).some(row => row.kind === 'purpose.evaluated'), false);
  // Without the owner's declared condition, collection emits no meaning or decision records.
  assert.deepEqual(out.events.map(row => row.kind), ['observation']);
});

test('new fetch time does not renew an old report; facts predating an Ideal are not new improvement', () => {
  const s = fixture(), stale = derive(s, s.fetchedAt, { maxAge: 'PT1H' });
  assert.equal(stale.last.phase, 'approximating'); assert.equal(stale.last.gap.summary.open, 1);
  assert.equal(stale.last.gap.parts[0].cause.current, 'current-stale');
  const earlier = derive(s, s.fetchedAt, { maxAge: 'P2D', idealAt: '2026-10-17T08:00:00Z' });
  assert.equal(earlier.last.phase, 'matched'); assert.equal(earlier.last.gap.summary.before_ideal, 1);
});

test('missing, tampered, self-resigned wrong binding and UNKNOWN never erase a Gap', () => {
  const cases = [
    s => { delete s.responses.member; }, s => { delete s.responses.package; }, s => { delete s.responses.gate; },
    s => { delete s.responses.meaning; }, s => { s.responses.member.text += ' '; },
    s => change(s, 'input', row => { row.receipts.rows = []; }),
    s => change(s, 'input', row => { row.required.rows = []; }),
    s => change(s, 'input', row => { row.observations = {}; }),
    s => change(s, 'input', row => { row.observations.rows = []; }),
    s => change(s, 'input', row => { row.provided.rows = []; }),
    s => change(s, 'input', row => { row.required.source.revision = 'd'.repeat(40); }),
    s => change(s, 'input', row => { row.required.source.digest = sha('wrong source bytes'); }),
    s => change(s, 'member', row => { row.targetCandidate = 'd'.repeat(40); }),
    s => change(s, 'member', row => { row.logicalRepository = 'other/apps'; }),
    s => change(s, 'member', row => { row.obligationId = 'other'; }),
    s => change(s, 'member', row => { row.acceptedRequirementDigest = s.binding.requirement.digest; }),
    s => change(s, 'member', row => { row.contractDiffStatus = 'UNKNOWN'; row.contractDiffExit = 4; }),
    s => change(s, 'gate', row => { row.operationalAdoptionEffect = true; }),
    s => { s.provider.run.head_sha = 'd'.repeat(40); },
    s => { s.provider.repository = 'fork/governance'; },
    s => { delete s.provider.run.id; delete s.provider.artifact.workflow_run.id; },
    s => { s.provider.retrievedAt = '2026-10-19T00:00:00Z'; },
    s => { s.provider.run.status = 'in_progress'; },
  ];
  for (const [index, mutation] of cases.entries()) {
    const s = fixture(); mutation(s);
    // Re-signing the altered member and both final reports still cannot change the selected binding.
    if (s.responses.member && s.responses.package && s.responses.gate && digestValid(s.responses.member)) signMember(s);
    const out = derive(s, s.fetchedAt);
    assert.equal(out.events[0].value, 'UNKNOWN', `mutation ${index}`);
    assert.equal(out.last.phase, 'approximating', `mutation ${index}`);
    assert.equal(out.last.gap.summary.open, 1, `mutation ${index}`);
  }
});
const digestValid = r => sha(r.text) === r.sha256;

test('forks/candidates do not alias; a later unknown revokes an earlier match', () => {
  const s = fixture(), first = derive(s, s.fetchedAt);
  const fork = fixture(); fork.owner = 'fork';
  assert.notEqual(normalize(fork)[0].target, normalize(s)[0].target);
  const next = fixture(); next.binding.targetCandidate = 'd'.repeat(40);
  assert.notEqual(normalize(next)[0].target, normalize(s)[0].target);
  delete s.responses.gate; s.provider.artifact.created_at = '2026-10-18T00:30:00Z';
  s.fetchedAt = '2026-10-18T00:31:00Z'; s.provider.retrievedAt = s.fetchedAt;
  const out = derive(s, s.fetchedAt, { prior: first.events });
  assert.equal(out.last.gap.summary.open, 1); assert.equal(out.last.phase, 'approximating');
});

test('missing selection or original timestamp fails explicitly rather than making a shared target', () => {
  const s = fixture(); delete s.binding; assert.throws(() => normalize(s), /exact binding/);
  const future = fixture(); future.provider.artifact.created_at = '2026-10-19T00:00:00Z';
  assert.throws(() => normalize(future), /original artifact time/);
  const unqualified = fixture(); delete unqualified.owner; assert.throws(() => normalize(unqualified), /owner and repo/);
  assert.throws(() => collect(normalize(fixture()), '2026-10-17T07:23:00Z'), /recordedAt.*availableAt/);
});

test('coherently acquired four statuses stay literal; this edge does not judge Gov proofs again', () => {
  for (const [status, exit] of Object.entries({ CLOSED: 0, OPEN: 2, INVALID: 3, UNKNOWN: 4 })) {
    const s = fixture();
    change(s, 'member', row => { row.contractDiffStatus = status; row.contractDiffExit = exit; row.status = status === 'CLOSED' ? 'pass' : 'fail'; });
    signMember(s);
    const out = derive(s, s.fetchedAt);
    assert.equal(out.events[0].value, status);
    assert.equal(out.last.gap.summary.open, status === 'CLOSED' ? 0 : 1);
  }
  const mismatch = fixture(); change(mismatch, 'member', row => { row.contractDiffStatus = 'OPEN'; }); signMember(mismatch);
  assert.equal(collect(normalize(mismatch), mismatch.fetchedAt)[0].value, 'UNKNOWN');
});

// Optional retained immutable input, acquired by the authorized authenticated surface. The normal
// CI always runs the synthetic boundaries above; this explicit path runs the same consumer on raw bytes.
test('retained contract-632 Apps artifact reaches the existing Atlas consumer', { skip: !process.env.ATLAS_CONTRACT_INPUT }, () => {
  const root = process.env.ATLAS_CONTRACT_INPUT;
  const text = p => readFileSync(path.join(root, p), 'utf8');
  const provider = JSON.parse(text('provider-metadata.json'));
  assert.equal(provider.archive.sha256, 'b9a0400e6fcbc6de2d47c367553e5752e7b2a82f6fa7a2f9fa1d905a955c326c');
  assert.equal(sha(readFileSync(path.join(root, 'artifact.zip'))), 'sha256:' + provider.archive.sha256);
  const raw = { member: 'package-contract-member-apps.json', package: 'package-final-report-apps.json',
    gate: 'final-check-report-apps.json', input: 'apps-bundle/contract-diff-input.json', meaning: 'apps-bundle/sources/adrs/apps-requirement-decision.jsonl',
    manifest: 'apps-bundle/bundle-manifest.json' };
  // Independent readback from this fixed artifact, not hashes derived from the supplied body/ tree.
  // The production edge trusts authenticated acquisition; this retained-input proof additionally
  // pins each extracted body so a different, self-consistent re-signed bundle cannot impersonate it.
  const bodyDigests = {
    member: 'sha256:7145867dc757345e427d9186664cae7b5c5471de21e534ae288eedca25e5d19b',
    package: 'sha256:d672dbb42cc3f63cd723b8917726b8e1134245a8f1635f45b42649b2dbb9a380',
    gate: 'sha256:231bf6ef12672d9e8afea28a1374d5c08c73277eba57770dcea9ebacfd4cd009',
    input: 'sha256:9dabfb4f9c98184e997b963b35a39f4327c3c00274168634af337912f649b293',
    meaning: 'sha256:ed25a4f30f18d842596c7c13f91c208a559cd2e5131294d399a56440af54d14d',
    manifest: 'sha256:bfd54f3385d19d64bf6037096367d53ba77bde197df9b962b0cdc184773a76fa',
  };
  for (const [key, file] of Object.entries(raw))
    assert.equal(sha(readFileSync(path.join(root, 'body', file))), bodyDigests[key], `fixed artifact body ${key}`);
  const s = { type: 'governance-contract', owner: 'roccho-dev', repo: 'apps', provider, fetchedAt: provider.retrievedAt,
    binding: { targetCandidate: '71409fa013b6cb681c0a80b4c377e4685685b690', governanceCandidate: '3b9246ff1b4bb0211508213ac714ab460f3801dc', governanceRepository: 'roccho-dev/governance',
      obligationId: 'apps.voice-ui-artifact-auth.v1', claimCeiling: 'APPS_ARTIFACT_DECLARATION_AND_EXACT_BUILD_PROJECTION_ONLY',
      requirement: { repository: 'roccho-dev/adrs', revision: '862313008ad19a743034599792d9a8b6e470e4cf',
        path: 'decisions/apps-voice-ui-artifact-auth-requirement-261015.jsonl', digest: 'sha256:ed25a4f30f18d842596c7c13f91c208a559cd2e5131294d399a56440af54d14d' },
      requirementDigest: 'sha256:e1ac51fd83ee193544a4dfbdab5d1b8644cf048b598c53c9dd54a6782a9e1f18',
      meaningDigest: 'sha256:0e6cef91a67b066f473055a48e879d1182056ed637611ec5819399697c774b3c' },
    responses: Object.fromEntries(Object.entries(raw).map(([key, file]) => [key, response(text('body/' + file))])) };
  const source = 'caller:packages/atlas/tests/governance-contract.test.mjs#retained-input';
  const selected = derive(s, s.fetchedAt, { source, idealAt: s.fetchedAt });
  const baseline = joinLog(declarations(selected.events[0].target, 'P2D', s.fetchedAt, source), []);
  assert.deepEqual(baseline.held, []);
  const before = contractWorld(deriveAtlas(baseline.log, control));
  assert.equal(before.frames.at(-1).gap.summary.open, 1);
  assert.equal(selected.events[0].value, 'CLOSED'); assert.equal(selected.last.phase, 'matched');
  assert.equal(selected.last.gap.summary.before_ideal, 1, 'an already observed result is not new implementation progress');
  const current = derive(s, s.fetchedAt, { source, idealAt: s.fetchedAt, maxAge: 'PT1H' });
  assert.equal(current.last.phase, 'approximating'); assert.equal(current.last.gap.parts[0].cause.current, 'current-stale');
  assert.equal(current.world.frames.flatMap(f => f.journal).some(row => row.kind === 'purpose.evaluated'), false);
  // Counterexamples alter in-memory copies only; the retained original files remain untouched.
  for (const mutation of [
    value => { delete value.responses.meaning; },
    value => change(value, 'input', row => { row.receipts.rows = []; }),
    value => change(value, 'input', row => { row.required.source.revision = 'd'.repeat(40); }),
    value => { change(value, 'member', row => { row.targetCandidate = 'd'.repeat(40); }); signMember(value); },
  ]) {
    const negative = structuredClone(s); mutation(negative);
    const result = derive(negative, s.fetchedAt, { source, idealAt: s.fetchedAt });
    assert.equal(result.events[0].value, 'UNKNOWN'); assert.equal(result.last.gap.summary.open, 1);
  }
  if (process.env.ATLAS_CONTRACT_OUT) {
    const out = process.env.ATLAS_CONTRACT_OUT; mkdirSync(out, { recursive: true });
    for (const [name, value] of Object.entries({ snapshot: s, before, selected: selected.world, current: current.world }))
      writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n');
    writeFileSync(path.join(out, 'events.jsonl'), toJsonl(current.events));
  }
});
