// G edge: snapshot files written by fetch.mjs → normalized records for collect().
// This is the only module that knows gh response paths, `--slurp` pages and listing lines.
// Anything missing becomes null here; the core turns null into UNKNOWN.
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

export function normalize(snapshot) {
  switch (snapshot.type) {
    case 'issue': return [thread(snapshot)];
    case 'pr': return [pullRequest(snapshot), thread(snapshot)];
    case 'sessions': return [sessions(snapshot)];
    case 'ports': return [ports(snapshot)];
    case 'repo': return [repoState(snapshot)];
    case 'issue-state': return [issueState(snapshot)];
    case 'declaration': return [declaration(snapshot)];
    default: throw new Error(`atlas-collect: unknown snapshot type ${JSON.stringify(snapshot.type)}`);
  }
}
