// G observations: normalized records (adapter.mjs) → observation events. Pure, no I/O, no verdicts.
// A value that the record does not carry (null) is UNKNOWN; nothing is inferred from names.
import { UNKNOWN, timestamp } from './plan.mjs';

// Values name what was seen, not an activity verdict: only a live process is 'running'; a transcript
// file alone means the session existed before (apps#95 comment 6224493129), not that it is working.
export const SESSION = Object.freeze({ RUNNING: 'running', TRANSCRIPT_ONLY: 'transcript-only', NOT_FOUND: 'not-found' });

const known = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? UNKNOWN : value;

export function observation(target, value, source, observedAt, recordedAt) {
  if (timestamp(observedAt, `${target} observedAt`) > timestamp(recordedAt, 'recordedAt'))
    throw new Error(`atlas-collect: ${target} observedAt ${observedAt} is after recordedAt ${recordedAt}`);
  return { kind: 'observation', target, value: known(value), source: { ref: source.ref, sha256: known(source.sha256) }, observedAt, recordedAt };
}

// pr: {state, merged, head, rollup} or null when the PR could not be read.
export function prObservations({ repo, number, fetchedAt, source, pr }, recordedAt) {
  const target = `${repo}#${number}`;
  return [['pr.state', 'state'], ['pr.merged', 'merged'], ['pr.head', 'head'], ['ci.rollup', 'rollup']]
    .map(([field, key]) => observation(`${target}:${field}`, pr?.[key], source, fetchedAt, recordedAt));
}

// Session rule (declared inputs only):
//   a captured command line contains the session id                    → running
//   else a captured session file path contains the session id          → transcript-only
//   else, with both lists captured                                      → not-found
//   any list needed for the decision was not captured (null)           → UNKNOWN
export function sessionState(sessionId, commands, files) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return UNKNOWN;
  if (!Array.isArray(commands)) return UNKNOWN;
  if (commands.some(command => command.includes(sessionId))) return SESSION.RUNNING;
  if (!Array.isArray(files)) return UNKNOWN;
  if (files.some(file => file.includes(sessionId))) return SESSION.TRANSCRIPT_ONLY;
  return SESSION.NOT_FOUND;
}

export function sessionObservations({ observedAt, source, declared, commands, files }, recordedAt) {
  return declared.map(({ target, sessionId }) =>
    observation(`${target}:session`, sessionState(sessionId, commands, files), source, observedAt, recordedAt));
}

// probes: [{target, observedAt, responded:true|false|null, source}] — null means the probe did not run.
export function portObservations({ probes }, recordedAt) {
  return probes.map(probe => observation(`${probe.target}:port`,
    probe.responded === true ? 'responding' : probe.responded === false ? 'no-response' : null,
    probe.source, probe.observedAt, recordedAt));
}
