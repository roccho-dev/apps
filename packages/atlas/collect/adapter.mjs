// G edge: snapshot files written by fetch.mjs → normalized records for collect().
// This is the only module that knows gh response paths, `--slurp` pages and listing lines.
// Anything missing becomes null here; the core turns null into UNKNOWN.
import { createHash } from 'node:crypto';

const pages = data => Array.isArray(data) && data.every(Array.isArray) ? data.flat() : data; // --paginate --slurp
const lines = text => typeof text === 'string' ? text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean) : null;

// Thread (Issue or PR): REST issue + issue comments → [{commentId, updatedAt, author, text}], body first.
function thread({ repo, number, fetchedAt, responses }) {
  const issue = responses?.issue?.data, comments = pages(responses?.comments?.data);
  const documents = issue && Array.isArray(comments) ? [
    { commentId: null, updatedAt: issue.updated_at, author: issue.user?.login ?? null, text: issue.body ?? '' },
    ...comments.map(comment => ({ commentId: comment.id, updatedAt: comment.updated_at, author: comment.user?.login ?? null, text: comment.body ?? '' })),
  ] : null;
  return { kind: 'thread', repo, number, fetchedAt, documents,
    source: { ref: `gh api issues ${repo}#${number}`, sha256: responses?.issue?.sha256 ?? null } };
}

// PR: GraphQL pullRequest → {state, merged, head, rollup}. The rollup is GitHub's own
// statusCheckRollup.state, and only when it belongs to the head commit.
function pullRequest({ repo, number, fetchedAt, responses }) {
  const pr = responses?.pr?.data?.data?.repository?.pullRequest ?? null;
  const last = pr?.commits?.nodes?.at(-1)?.commit;
  return { kind: 'pr', repo, number, fetchedAt,
    source: { ref: `gh api graphql ${repo}#${number} pullRequest`, sha256: responses?.pr?.sha256 ?? null },
    pr: pr && { state: pr.state ?? null, merged: typeof pr.merged === 'boolean' ? String(pr.merged) : null, head: pr.headRefOid ?? null,
      rollup: last && last.oid === pr.headRefOid ? last.statusCheckRollup?.state ?? null : null } };
}

// Sessions: raw stdout of the process listing ("<pid> <command line>", from ps or /proc) and the file listing.
function sessions({ host, observedAt, sha256, declared, processes, sessionFiles }) {
  return { kind: 'sessions', observedAt, declared: declared ?? [], source: { ref: `ssh ${host} sessions`, sha256 },
    commands: lines(processes)?.map(line => line.replace(/^\d+\s+/u, '')) ?? null, files: lines(sessionFiles) };
}

function ports({ sha256, probes }) {
  return { kind: 'ports', probes: (probes ?? []).map(({ target, host, port, observedAt, responded }) =>
    ({ target, observedAt, responded, source: { ref: `tcp ${host}:${port}`, sha256 } })) };
}

// Repo / Issue state → one fact each. Only a boolean `archived` and a string `state` are values.
// Issue state keeps GitHub's state_reason in the same value ("closed/completed"), so a reason-less
// close never reads as completed and an open issue's null reason never becomes UNKNOWN.
const fact = (target, value, { fetchedAt, responses }, response) =>
  ({ kind: 'fact', target, value, observedAt: fetchedAt, source: { ref: responses?.[response]?.command ?? null, sha256: responses?.[response]?.sha256 ?? null } });

function repoState(snapshot) {
  const archived = snapshot.responses?.repo?.data?.archived;
  return fact(`${snapshot.repo}:archived`, typeof archived === 'boolean' ? String(archived) : null, snapshot, 'repo');
}

// The issues API also answers for PRs (a `pull_request` key). Its state there drops merged and
// "is a PR", so a merged PR would read as a reason-less "closed": UNKNOWN, with the reason in the
// source (the only free text D keeps). PRs are read through `pulls` (pr.state / pr.merged).
const PR_REASON = 'UNKNOWN: pull request; read pr.state / pr.merged via pulls';

function issueState(snapshot) {
  const data = snapshot.responses?.issue?.data ?? {};
  const target = `${snapshot.repo}#${snapshot.number}:issue.state`;
  if (Object.hasOwn(data, 'pull_request')) {
    const record = fact(target, null, snapshot, 'issue');
    return { ...record, source: { ...record.source, ref: `${record.source.ref} — ${PR_REASON}` } };
  }
  const { state, state_reason: reason } = data;
  const value = typeof state !== 'string' ? null : typeof reason === 'string' ? `${state}/${reason}` : state;
  return fact(target, value, snapshot, 'issue');
}

// P's declaration file: its text as read (null when unreadable) and the sha256 of those bytes.
function declaration({ path, fetchedAt, sha256, text }) {
  return { kind: 'declaration', path, fetchedAt, sha256: sha256 ?? null, text: typeof text === 'string' ? text : null };
}

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);

// Existing Gov member/final reports are observations of a finite contract, not purpose verdicts.
// The caller selects an exact admitted binding. Acquisition authenticates the source; this edge
// checks byte/identity coherence only, without reimplementing Gov's comparator or admitting raw ADRS.
function governanceContract(snapshot) {
  const { binding: b, provider: p, responses = {}, fetchedAt } = snapshot;
  const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
  const revision = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
  const token = value => typeof value === 'string' && value.length > 0 && !/[\s\u0000-\u001f\u007f]/u.test(value);
  if (!b || !revision(b.targetCandidate) || !revision(b.governanceCandidate) || !token(b.obligationId)
    || !token(b.governanceRepository) || !token(b.claimCeiling) || !sha(b.requirementDigest) || !sha(b.meaningDigest)
    || !revision(b.requirement?.revision) || !token(b.requirement?.repository)
    || !token(b.requirement?.path) || !sha(b.requirement?.digest))
    throw new Error('atlas-collect: governance-contract needs an explicit exact binding');
  const observedAt = p?.artifact?.created_at;
  if (![observedAt, fetchedAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    || Date.parse(observedAt) > Date.parse(fetchedAt))
    throw new Error('atlas-collect: governance-contract needs original artifact time <= fetch time');
  const target = `${snapshot.repo}@${b.targetCandidate}:contract:${b.obligationId}:${b.requirement.digest}:${b.governanceCandidate}:contractDiffStatus`;
  const hashes = {};
  const read = name => {
    const response = responses[name];
    hashes[name] = { declared: response?.sha256 ?? null, actual: typeof response?.text === 'string' ? digest(response.text) : null };
    if (typeof response?.text !== 'string' || digest(response.text) !== response.sha256) throw new Error(`unreadable ${name}`);
    return JSON.parse(response.text);
  };
  let value = null, reason = null;
  try {
    const member = read('member'), pkg = read('package'), gate = read('gate'), input = read('input'), meaning = read('meaning'), manifest = read('manifest');
    const { memberDigest, ...unsigned } = member;
    const required = input.required?.rows, provided = input.provided?.source;
    const source = input.required?.source;
    const subject = meaning.meaning_identity?.subject;
    const entry = name => manifest.filter(row => row.path === name);
    const sourcePaths = { input: 'contract-diff-input.json', meaning: 'sources/adrs/apps-requirement-decision.jsonl' };
    const exits = { CLOSED: 0, OPEN: 2, INVALID: 3, UNKNOWN: 4 };
    const checks = [
      member.kind === 'governance.packageContractClosureMember.v3',
      member.authority === false, member.adoption === false, member.releasePublished === false,
      member.memberDigest === digest(canonical(unsigned)),
      member.bundleManifestDigest === responses.manifest.sha256,
      ...Object.entries(sourcePaths).map(([key, path]) => entry(path).length === 1 && entry(path)[0].sha256 === responses[key].sha256),
      member.logicalRepository === snapshot.repo, member.providerRepository === snapshot.repo,
      member.targetCandidate === b.targetCandidate, member.governanceCandidate === b.governanceCandidate,
      member.obligationId === b.obligationId, member.claimCeiling === b.claimCeiling,
      member.acceptedRequirementRevision === b.requirement.revision, member.acceptedRequirementDigest === b.requirementDigest,
      pkg.kind === 'governance.finalScopePurposeJoin.package.v1',
      pkg.authority === false, pkg.adoption === false, pkg.releasePublished === false,
      gate.kind === 'governance.finalScopePurposeJoin.gate.v8',
      gate.authority === false, gate.meaningAuthority === false, gate.effectAuthority === false,
      gate.companyAdoptionEffect === false, gate.operationalAdoptionEffect === false, gate.releasePublished === false,
      ...[pkg, gate].flatMap(report => [report.candidateSha === b.governanceCandidate,
        report.packageContractClosureDigest === member.memberDigest, same(report.packageContractClosure, member)]),
      input.kind === 'contractDiffInput.v1', same(source, b.requirement),
      Array.isArray(required) && required.length === 1 && required[0].id === b.obligationId
        && required[0].contract?.obligation_digest === b.requirementDigest,
      provided?.repository === snapshot.repo, provided?.revision === b.targetCandidate,
      input.observations?.source?.repository === b.governanceRepository,
      input.observations?.source?.revision === b.governanceCandidate,
      digest(responses.meaning.text) === b.requirement.digest,
      subject?.repository === snapshot.repo, subject?.obligation_id === b.obligationId,
      meaning.apps_source_binding?.revision === b.targetCandidate,
      meaning.meaning_identity?.claim_ceiling === b.claimCeiling,
      meaning.meaning_identity_contract?.meaning_digest === b.meaningDigest,
      digest(canonical(meaning.meaning_identity)) === b.meaningDigest,
      p.run?.head_sha === b.governanceCandidate, p.artifact?.workflow_run?.head_sha === b.governanceCandidate,
      p.run?.id === p.artifact?.workflow_run?.id, p.run?.status === 'completed',
      Number.isSafeInteger(p.artifact?.id) && p.artifact.id > 0,
      Number.isSafeInteger(p.run?.id) && p.run.id > 0, p.repository === b.governanceRepository, p.retrievedAt === fetchedAt,
      Object.hasOwn(exits, member.contractDiffStatus), exits[member.contractDiffStatus] === member.contractDiffExit,
    ];
    if (checks.some(check => !check)) throw new Error('incoherent contract evidence');
    value = member.contractDiffStatus; // Literal report field, never matched / achieved.
  } catch (error) { reason = error.message; }
  const ref = `${p?.repository ?? 'UNKNOWN'}/actions/runs/${p?.run?.id ?? 'UNKNOWN'}#artifact=${p?.artifact?.id ?? 'UNKNOWN'}`
    + `; requirement=${b.requirement.repository}@${b.requirement.revision}:${b.requirement.path}`
    + `; fetchedAt=${fetchedAt}${reason ? `; UNKNOWN: ${reason}` : ''}`;
  return { kind: 'fact', target, value, observedAt, availableAt: fetchedAt,
    source: { ref, sha256: digest(canonical({ binding: b, provider: p, hashes })) } };
}

// GitHub ids carry the owner: records get `repo: 'owner/repo'`, so every target, plan id and journal
// ref built from it is `owner/repo#n…` / `owner/repo:…` (a fork and its upstream never share a name).
// A snapshot without a plain owner and repo name is refused rather than collapsed into a shared id.
function qualified(snapshot) {
  const plain = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/u.test(value);
  if (!plain(snapshot.owner) || !plain(snapshot.repo))
    throw new Error(`atlas-collect: ${snapshot.type} snapshot needs a plain owner and repo, got ${JSON.stringify([snapshot.owner, snapshot.repo])}`);
  return { ...snapshot, repo: `${snapshot.owner}/${snapshot.repo}` };
}

export function normalize(snapshot) {
  switch (snapshot.type) {
    case 'issue': return [thread(qualified(snapshot))];
    case 'pr': return [pullRequest(qualified(snapshot)), thread(qualified(snapshot))];
    case 'sessions': return [sessions(snapshot)];
    case 'ports': return [ports(snapshot)];
    case 'repo': return [repoState(qualified(snapshot))];
    case 'issue-state': return [issueState(qualified(snapshot))];
    case 'declaration': return [declaration(snapshot)];
    case 'governance-contract': return [governanceContract(qualified(snapshot))];
    default: throw new Error(`atlas-collect: unknown snapshot type ${JSON.stringify(snapshot.type)}`);
  }
}
