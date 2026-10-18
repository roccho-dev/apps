// G edge: snapshot files written by fetch.mjs → normalized records for collect().
import { createHash } from 'node:crypto';
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

// Git Cold rows (adr_raw_event.v1) of one fixed commit and path, as read by the edge: each valid row is one
// comment of the existing thread record. The adapter never learns where the file lives (repo, commit and
// path come in the snapshot). Capture is not admission (adrs#607): `status` is carried as `admission`
// verbatim and nothing here admits a meaning. A row that is not adr_raw_event.v1, without a payload or
// content_sha256, whose payload does not hash to it (or cannot be hashed the writer's way), whose raw_id
// does not end with it, or that lacks a subject, id, author or body is held with the reason.
const COLD = 'adr_raw_event.v1';
const SUBJECT = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\.(?:issue|pull)\.(\d+)$/u;

// The one form the writer (adrs tools/github_api.py, a6284e58) hashes: Python
// json.dumps(payload, ensure_ascii=False, sort_keys=True) — separators ", " and ": ", keys of every object
// sorted by code point, non-ASCII kept raw, only `"`, `\` and C0 controls escaped (\uXXXX in lowercase hex).
// What JS cannot reproduce byte for byte returns null: a number other than a safe integer (Python's float
// repr and big ints are lost by JSON.parse) and a lone surrogate (Python cannot UTF-8 encode it).
const ESCAPES = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
const pyString = value => `"${value.replace(/["\\\u0000-\u001f]/gu, char => ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
const byCodePoint = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export function pyJsonDumps(value) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value === 'string') return value.isWellFormed() ? pyString(value) : null;
  if (typeof value !== 'object') return null;
  const array = Array.isArray(value), keys = array ? [] : Object.keys(value);
  if (keys.some(key => !key.isWellFormed())) return null;
  const parts = array ? value.map(pyJsonDumps)
    : keys.sort(byCodePoint).map(key => { const item = pyJsonDumps(value[key]); return item === null ? null : `${pyString(key)}: ${item}`; });
  if (parts.includes(null)) return null;
  return array ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`;
}
export const coldDigest = payload => {
  const text = pyJsonDumps(payload);
  return text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
};

function cold({ repo, commit, path, committedAt, fetchedAt, sha256, text }) {
  const ref = `${repo}@${commit}:${path}`, threads = new Map(), held = [];
  const hold = (reason, line, rawId = null) => held.push({ kind: 'held', reason, raw_id: rawId, line, committedAt, source: { ref, sha256: sha256 ?? null } });
  for (const line of lines(text) ?? []) {
    let row;
    try { row = JSON.parse(line); } catch { hold('invalid-json', line); continue; }
    if (row?.schema !== COLD) { hold('schema', null, row?.raw_id ?? null); continue; }
    const payload = row.payload, content = row.observed_version?.content_sha256;
    // content_sha256 is stored as plain hex and the raw_id ends with its first 16 characters; one form only.
    if (!payload || typeof payload !== 'object' || typeof content !== 'string') { hold('content-sha256-missing', null, row.raw_id ?? null); continue; }
    const computed = coldDigest(payload);
    if (computed === null) { hold('content-sha256-unverifiable', null, row.raw_id ?? null); continue; }
    if (computed !== content) { hold('content-sha256-mismatch', null, row.raw_id ?? null); continue; }
    if (typeof row.raw_id !== 'string' || !row.raw_id.endsWith(`.${computed.slice(0, 16)}`)) { hold('raw-id-mismatch', null, row.raw_id ?? null); continue; }
    const subject = SUBJECT.exec(row.subject_key ?? '');
    if (!subject || !Number.isSafeInteger(payload.id) || typeof payload.author?.login !== 'string' || typeof payload.body !== 'string') {
      hold('subject-id-author-or-body-missing', null, row.raw_id ?? null); continue;
    }
    // No time is guessed: without updated_at (payload or observed_version) the row is held, not dated by
    // created_at or submitted_at (an adrs#603 review row has both updated_at null).
    const updatedAt = payload.updated_at ?? row.observed_version.updated_at;
    if (typeof updatedAt !== 'string') { hold('updated-at-missing', null, row.raw_id ?? null); continue; }
    const key = `${subject[1]}#${subject[2]}`;
    if (!threads.has(key)) threads.set(key, { kind: 'thread', repo: subject[1], number: Number(subject[2]), fetchedAt, committedAt, documents: [], source: { ref, sha256: sha256 ?? null } });
    threads.get(key).documents.push({ commentId: payload.id, updatedAt, author: payload.author.login,
      // The same digest in G's `sha256:<hex>` notation (what D's source digest requires).
      text: payload.body, source: { ref, sha256: `sha256:${content}` }, admission: row.status ?? null });
  }
  return [...threads.values(), ...held];
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
    case 'cold': return cold(snapshot);
    default: throw new Error(`atlas-collect: unknown snapshot type ${JSON.stringify(snapshot.type)}`);
  }
}
