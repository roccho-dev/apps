#!/usr/bin/env node
// G acquisition only: run read-only `gh api`, the existing ssh, and TCP probes; save snapshots.
// No parsing beyond JSON, no verdicts. Uses whatever gh/ssh login already exists on the host.
//   node packages/atlas/collect/fetch.mjs <config.json> <snapshot-dir>
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = text => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const now = () => new Date().toISOString();

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false });
  if (result.error || result.status !== 0)
    return { ok: false, error: (result.error?.message ?? result.stderr ?? '').trim() || `exit ${result.status}` };
  return { ok: true, stdout: result.stdout };
}

function gh(args) {
  const result = run('gh', ['api', ...args]);
  if (!result.ok) return { command: ['gh', 'api', ...args].join(' '), sha256: null, data: null, error: result.error };
  return { command: ['gh', 'api', ...args].join(' '), sha256: sha256(result.stdout), data: JSON.parse(result.stdout) };
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number state merged mergedAt headRefOid updatedAt commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}}`;

function fetchThread(ref, type) {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/u.exec(ref);
  if (!m) throw new Error(`fetch: expected owner/repo#number, got ${ref}`);
  const [, owner, repo, number] = m;
  const responses = {
    issue: gh([`repos/${owner}/${repo}/issues/${number}`]),
    comments: gh(['--paginate', '--slurp', `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`]),
  };
  if (type === 'pr') responses.pr = gh(['graphql', '-f', `query=${PR_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${repo}`, '-F', `number=${number}`]);
  return { type, owner, repo, number: Number(number), fetchedAt: now(), responses };
}

// State facts: one read-only REST call each (`repos: [owner/repo]`, `issueStates: [owner/repo#n]`).
function fetchRepo(ref) {
  const m = /^([^/\s#]+)\/([^/\s#]+)$/u.exec(ref);
  if (!m) throw new Error(`fetch: expected owner/repo, got ${ref}`);
  const [, owner, repo] = m;
  return { type: 'repo', owner, repo, fetchedAt: now(), responses: { repo: gh([`repos/${owner}/${repo}`]) } };
}

function fetchIssueState(ref) {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/u.exec(ref);
  if (!m) throw new Error(`fetch: expected owner/repo#number, got ${ref}`);
  const [, owner, repo, number] = m;
  return { type: 'issue-state', owner, repo, number: Number(number), fetchedAt: now(),
    responses: { issue: gh([`repos/${owner}/${repo}/issues/${number}`]) } };
}

function probe({ target, host, port, timeoutMs = 2000 }) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = responded => { socket.destroy(); resolve({ target, host, port, observedAt: now(), responded }); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function sessions({ ssh, declared, processCommand = 'ps -eo pid=,args=', filesCommand = 'find ~/.claude/projects -name "*.jsonl"' }) {
  const ps = run('ssh', [ssh, processCommand]);
  const files = run('ssh', [ssh, filesCommand]);
  // Raw stdout only; adapter.mjs reads the lines. null = not captured.
  return { type: 'sessions', host: ssh, observedAt: now(), sha256: sha256(`${ps.stdout ?? ''}\0${files.stdout ?? ''}`),
    declared, processes: ps.ok ? ps.stdout : null, sessionFiles: files.ok ? files.stdout : null, errors: [ps.error, files.error].filter(Boolean) };
}

const slug = snapshot => `${snapshot.type}-${snapshot.owner}-${snapshot.repo}-${snapshot.number}.json`;

/** The snapshots of one collection, as the CLI writes them (name and content), in the order it writes them. */
export async function fetchSnapshots(config) {
  const placeholder = (config.sessions?.declared ?? []).filter(d => typeof d.sessionId !== 'string' || /^<.*>$/u.test(d.sessionId));
  if (placeholder.length) throw new Error(`fetch: fill or remove sessionId for ${placeholder.map(d => d.target).join(', ')}`);
  const out = [];
  const write = (name, snapshot) => out.push({ name, snapshot });
  for (const ref of config.issues ?? []) { const s = fetchThread(ref, 'issue'); write(slug(s), s); }
  for (const ref of config.pulls ?? []) { const s = fetchThread(ref, 'pr'); write(slug(s), s); }
  for (const ref of config.repos ?? []) { const s = fetchRepo(ref); write(`repo-${s.owner}-${s.repo}.json`, s); }
  for (const ref of config.issueStates ?? []) { const s = fetchIssueState(ref); write(slug(s), s); }
  if (config.ports?.length) {
    const probes = await Promise.all(config.ports.map(probe));
    write('ports.json', { type: 'ports', sha256: sha256(JSON.stringify(probes)), probes });
  }
  if (config.sessions) write('sessions.json', sessions(config.sessions));
  // Git Cold (C1): adr_raw_event.v1 rows of a fixed commit, read from a local clone: { repo, checkout, commit, path }.
  // The snapshot names repo/commit/path; the adapter maps rows and never learns where the clone lives.
  (config.cold ?? []).forEach(({ repo, checkout, commit, path: file }, index) => {
    const shown = run('git', ['-C', checkout, 'show', `${commit}:${file}`]);
    const date = run('git', ['-C', checkout, 'show', '-s', '--format=%cI', commit]);
    write(`cold-${index}.json`, { type: 'cold', repo, commit, path: file, fetchedAt: now(),
      committedAt: date.ok ? new Date(date.stdout.trim()).toISOString() : null,
      sha256: shown.ok ? sha256(shown.stdout) : null, text: shown.ok ? shown.stdout : null, errors: [shown.error, date.error].filter(Boolean) });
  });
  // P's declaration files: read as bytes; the sha256 identifies exactly what was read.
  (config.declarations ?? []).forEach((file, index) => {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    write(`declaration-${index}.json`, { type: 'declaration', path: file, fetchedAt: now(), sha256: text === null ? null : sha256(text), text });
  });
  return out;
}

/**
 * C5 stage 1 (adrs#647 v4): the owner input source's Issue comments (`owner/repo`), read with the read-only token
 * the runtime is given for it alone (`token`; the secret comes from envs, adrs#443), never with the host's own gh
 * login. No token, or any error: null (unreadable; collect/owner.mjs then counts no evaluation).
 */
export function fetchOwnerComments(repo, token) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(String(repo)) || typeof token !== 'string' || !token) return null;
  const result = spawnSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues/comments?per_page=100`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false, env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(result.stdout).flat(); } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, outDir] = process.argv.slice(2);
  if (!configPath || !outDir) { console.error('usage: fetch.mjs <config.json> <snapshot-dir>'); process.exit(2); }
  let snapshots;
  try { snapshots = await fetchSnapshots(JSON.parse(fs.readFileSync(configPath, 'utf8'))); }
  catch (error) { console.error(error.message); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, snapshot } of snapshots) fs.writeFileSync(path.join(outDir, name), JSON.stringify(snapshot, null, 2) + '\n');
  console.error(`fetch: snapshots written to ${outDir}`);
}
