# Independent component-axis admission

This module verifies already stopped evidence; it never fetches a provider or reads credentials. The audit is separate from the frozen semantic scorer. A coherent wrong result is integrity PASS and semantic UNMET. A coherent failed execution is integrity PASS, all_valid_execution=false and inadmissible_for_semantic_claim=false. A missing or inconsistent observation is never filled with a predicted result.

`auditAxisRaw({projectionBytes, oracleBytes, rawFiles, bundleBytes, protocol, stdoutBytes, assessGoal, assessEdge, replayBytes=null, artifactManifestBytes=null, phaseKind='public', parentProjectionBytes=null})` is asynchronous. All byte inputs must retain their original bytes; `rawFiles` is the complete basename-to-Buffer inventory, including identity.json, execution.json and events.jsonl. Pass the actual immutable semantic-map protocol and the frozen finite painted assessors. The complete unsliced stdout belongs to this one axis phase.

Public case counts are G4/R2/F3/E4; fresh counts are G10/R8/F8/E10. G/E fresh strata remain 4 sufficient, 4 missing, 2 controls. A correction is a faithful subset of the full preregistered public parent and needs `parentProjectionBytes`; it cannot become a complete final panel. Final in the index maps to `phaseKind:'fresh'`.

The result separates `status`, `complete`, `all_valid_execution`, semantic results and replay integrity. It binds actual initial/final DecisionLog, trace snapshots, responses, supplied/effective offered parts, selected additions, local route/method, events, source identity inventory and literal stdout factors. Success check factors have a strict body join; failed checks may have 0/1/2 closed ordered factor rows. Ambiguous allocation among failed same-head calls is explicit and makes no cell factor claim. E Goal timing uses result.elapsedMs only; cell wall time and HTTP elapsed time are separate. Missing Goal time is UNPROVEN. E binds recorded target/Apply/reload bytes and actual finite paint. R/E replay paint is recomputed per [id,arm], after the global artifact/raw replay join; one failed cell never changes other cells' paint counts. An overview-only receipt does not prove paint.

`external_provider_attempt_bounds` is `{jev:{min,max},typellm:{min,max}}`. Successful provider-route HTTP200 implies one upstream attempt for live execution. Failed provider-route HTTP allows 0..1; literal completion always allows exactly 0. `external_provider_attempts[p]` is null when the raw alone is uncertain. It is not a replacement for the actual guarded send journal.

`auditAxisProviderPhase({configBytes,processBytes,stderrBytes,stdoutBytes,journalBytes}, expectedSendsOrBounds, {axis,caseCount})` accepts exact count pairs or the bounds above. It first verifies the complete stderr send sequence against the stopped journal cutoff and configuration, then checks the actual `sent` inside the raw bounds. It enforces per-input limits and the fixed new-cycle prior564/29 plus290/11 reservation limit. The actual phase.sent, rather than local HTTP count, is accounting authority. An independent physical PID/PGID observation (including zombies), exact-source review and preflight remain explicit required audit references.

`auditAxisProducerBinding({identityBytes,runtimeAuditBytes,configBytes,processBytes,artifactManifestBytes,workerBytes,providerBytes,protocolEntryBytes,bundleBytes,sourceFiles,auditReferences,rawFiles,stdoutBytes,stderrBytes,journalBytes,replayBytes=null}, producer)` binds the fixed independent producer expectation. Schema is voice-ui.component-axes-producer/1. Required fields are axis, phase_id, heads, inputs_sha256, bundle_sha256, source_sha256, raw_sha256, independent_audit_sha256, and raw_identity_sha256/runtime_audit_sha256/config_sha256/process_sha256/artifact_manifest_sha256/worker_sha256/provider_sha256/protocol_sha256/stdout_sha256/stderr_sha256/journal_sha256/replay_sha256. Replay digest is null for G/F. source_sha256 has exactly the 14 evaluator source names; raw/audit inventories are exact. A correction's independently frozen parent digest must additionally be joined by the driver to the raw report. Author producer expectations after independent source/process/raw observations and commit them before CI verification; never regenerate expectations from raw inside CI.

The explicit synthetic runtime marker and synthetic provider marker reject live producer admission. All tests remain synthetic mechanics even when using the actual immutable protocol and production Goal. No test outcome is a measured Jev/TypeLLM performance result. CI_LIVE_EXECUTION remains UNPROVEN.

CI mutation entry (all paths must come from the exact source/completed ZIP):

```
POC_PROTOCOL_ENTRY=<reopened-dist>/site/ui/semantic-map/protocol/index.js
POC_SOURCE_ROOT=<exact-source>/packages/voice-ui
POC_AXIS_FIXTURES=<exact-source>/docs/voice-ui/component-axes-20261017/preregistered
node --test tests/component-axis-audit.test.mjs
```

Copy only the audit module, test, this integration note, frozen index and test log. Existing semantic-score.mjs, receipt-admissibility.mjs and component-axis-score.mjs stay byte-identical dependencies. No sealed input/oracle or old reserve file is part of this copy permission.
