// G transform core (adrs#647 v3 c6329883005): normalized records → observation / plan.set events. Pure; collect.mjs is its CLI.
import { planEvents } from './plan.mjs';
import { journalEvents, declarationEvents } from './journal.mjs';
import { worklogEvents } from './worklog.mjs';
import { observation, prObservations, sessionObservations, portObservations } from './observe.mjs';

// `worklogAuthors`: logins allowed to write worklog-v1 lines (declared by P, passed in; absent → all held).
export function collect(records, recordedAt, { worklogAuthors } = {}) {
  return records.flatMap(record => {
    switch (record.kind) {
      case 'thread': return record.documents
        ? [...planEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt),
          ...journalEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt),
          ...worklogEvents(record.documents.map(doc => ({ repo: record.repo, number: record.number, ...doc })), recordedAt, worklogAuthors)]
        // The thread could not be read: UNKNOWN, not "no plan".
        : [observation(`${record.repo}#${record.number}:plan.source`, null, record.source, record.fetchedAt, recordedAt)];
      case 'pr': return prObservations(record, recordedAt);
      case 'sessions': return sessionObservations(record, recordedAt);
      case 'ports': return portObservations(record, recordedAt);
      case 'declaration': return declarationEvents(record, recordedAt);
      case 'fact': return [observation(record.target, record.value, record.source, record.observedAt, recordedAt)];
      // A Cold row the adapter refused: kept with its reason, never a fact or a decision.
      case 'held': return [{ kind: 'journal.held', reason: 'cold: ' + record.reason, line: record.raw_id ?? record.line, source: record.source, recordedAt }];
      default: throw new Error(`atlas-collect: unknown record kind ${JSON.stringify(record.kind)}`);
    }
  });
}

export const toJsonl = events => events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
