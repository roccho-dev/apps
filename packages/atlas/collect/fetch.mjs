#!/usr/bin/env node
// G acquisition only: run read-only `gh api`, the existing ssh, and TCP probes; save snapshots.
// No parsing beyond JSON, no verdicts. Uses whatever gh/ssh login already exists on the host.
//   node packages/atlas/collect/fetch.mjs <config.json> <snapshot-dir>
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

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

const [configPath, outDir] = process.argv.slice(2);
if (!configPath || !outDir) { console.error('usage: fetch.mjs <config.json> <snapshot-dir>'); process.exit(2); }
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const placeholder = (config.sessions?.declared ?? []).filter(d => typeof d.sessionId !== 'string' || /^<.*>$/u.test(d.sessionId));
if (placeholder.length) { console.error(`fetch: fill or remove sessionId for ${placeholder.map(d => d.target).join(', ')}`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
const slug = snapshot => `${snapshot.type}-${snapshot.owner}-${snapshot.repo}-${snapshot.number}.json`;

for (const ref of config.issues ?? []) { const s = fetchThread(ref, 'issue'); write(slug(s), s); }
for (const ref of config.pulls ?? []) { const s = fetchThread(ref, 'pr'); write(slug(s), s); }
if (config.ports?.length) {
  const probes = await Promise.all(config.ports.map(probe));
  write('ports.json', { type: 'ports', sha256: sha256(JSON.stringify(probes)), probes });
}
if (config.sessions) write('sessions.json', sessions(config.sessions));
console.error(`fetch: snapshots written to ${outDir}`);
