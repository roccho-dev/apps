// Independent v2 audit authoring milestone. DRAFT_NOT_ADMITTED.
// This file may be copied for a provider-free distribution build only.
// Every audit entry throws until the complete implementation and mutations pass.
export const REQUIREMENTS_SOURCE_NAMES = Object.freeze([
  'src/completion.mjs', 'src/literal-inventory.mjs', 'src/goal.mjs', 'src/contract.mjs', 'src/turn.mjs', 'src/session.mjs',
  'functions/api/parts.mjs', 'functions/pages-worker.mjs', 'web/app.mjs', 'web/adapters/completion.mjs',
  'src/requirements.mjs', 'functions/api/requirements.mjs', 'dev/serve.mjs',
  'tests/requirements-cycle-eval.mjs', 'tests/requirements-cycle-score.mjs', 'tests/requirements-cycle-audit.mjs',
  'tests/semantic-score.mjs', 'tests/requirements-cycle-http.mjs', 'tests/painted-goal.mjs',
]);
export async function auditRequirementRaw() { throw Error('requirements_raw_audit_not_frozen'); }
export function auditRequirementProviderPhase() { throw Error('requirements_provider_audit_not_frozen'); }
export function auditRequirementProducerBinding() { throw Error('requirements_producer_audit_not_frozen'); }
export function auditRequirementReplayJoin() { throw Error('requirements_replay_audit_not_frozen'); }
