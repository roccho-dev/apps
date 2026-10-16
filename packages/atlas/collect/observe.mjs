// G observations: fetched snapshots → observation events. Pure, no I/O, no verdicts.
// A value that the snapshot does not literally carry is UNKNOWN; nothing is inferred from names.
import { UNKNOWN, timestamp } from './plan.mjs';

export const SESSION = Object.freeze({ RUNNING: 'running', WAITING: 'waiting', NOT_STARTED: 'not-started' });

function observation(target, value, source, observedAt, recordedAt) {
  if (timestamp(observedAt, `${target} observedAt`) > timestamp(recordedAt, 'recordedAt'))
    throw new Error(`atlas-collect: ${target} observedAt ${observedAt} is after recordedAt ${recordedAt}`);
  const text = value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? UNKNOWN : value;
  return { kind: 'observation', target, value: text, source, observedAt, recordedAt };
}

// pr: GraphQL pullRequest {state, merged, headRefOid, commits.nodes[].commit{oid, statusCheckRollup{state}}}.
export function prObservations({ repo, number, fetchedAt, sha256, pr }, recordedAt) {
  const target = `${repo}#${number}`;
  const source = { ref: `gh api graphql ${target} pullRequest`, sha256 };
  if (!pr || typeof pr !== 'object')
    return ['pr.state', 'pr.merged', 'pr.head', 'ci.rollup'].map(field => observation(`${target}:${field}`, UNKNOWN, source, fetchedAt, recordedAt));
  const last = pr.commits?.nodes?.at(-1)?.commit;
  // The rollup is GitHub's own statusCheckRollup.state for the head commit; it is not recomputed here.
  const rollup = last && last.oid === pr.headRefOid ? last.statusCheckRollup?.state : null;
  return [
    observation(`${target}:pr.state`, pr.state, source, fetchedAt, recordedAt),
    observation(`${target}:pr.merged`, typeof pr.merged === 'boolean' ? String(pr.merged) : null, source, fetchedAt, recordedAt),
    observation(`${target}:pr.head`, pr.headRefOid, source, fetchedAt, recordedAt),
    observation(`${target}:ci.rollup`, rollup, source, fetchedAt, recordedAt),
  ];
}

// Session rule (declared inputs only):
//   the process list has a command line containing the session id      → running
//   else a session file path contains the session id                   → waiting
//   else, with both lists captured                                      → not-started
//   any list needed for the decision was not captured (null)           → UNKNOWN
export function sessionState(sessionId, processes, sessionFiles) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return UNKNOWN;
  if (!Array.isArray(processes)) return UNKNOWN;
  if (processes.some(process => typeof process.command === 'string' && process.command.includes(sessionId))) return SESSION.RUNNING;
  if (!Array.isArray(sessionFiles)) return UNKNOWN;
  if (sessionFiles.some(file => typeof file === 'string' && file.includes(sessionId))) return SESSION.WAITING;
  return SESSION.NOT_STARTED;
}

export function sessionObservations({ host, observedAt, sha256, declared, processes, sessionFiles }, recordedAt) {
  const source = { ref: `ssh ${host} sessions`, sha256 };
  return (declared ?? []).map(({ target, sessionId }) =>
    observation(`${target}:session`, sessionState(sessionId, processes, sessionFiles), source, observedAt, recordedAt));
}

// probes: [{target, host, port, observedAt, responded:true|false|null}] — null means the probe did not run.
export function portObservations({ sha256, probes }, recordedAt) {
  return (probes ?? []).map(probe => observation(`${probe.target}:port`,
    probe.responded === true ? 'responding' : probe.responded === false ? 'no-response' : UNKNOWN,
    { ref: `tcp ${probe.host}:${probe.port}`, sha256 }, probe.observedAt, recordedAt));
}
