# Acceptance execution boundary

## External Accepted handoff

Apps owns the acceptance-flow consumer, not the accepted authority. The [consumer boundary](https://github.com/roccho-dev/apps/issues/46#issuecomment-5965467828) separates explicit Accept of a Working candidate from the external owner deciding Judge / Prove / Admit, post-Admit persistence, and authoritative current/readback. These are logical responsibilities, not a prescribed number of APIs. The [#506 semantic statement](https://github.com/roccho-dev/adrs/issues/506#issuecomment-5965308107) retains Fact / Condition / Claim: persist admitted semantic deltas, then derive current; do not commit the current graph as authority or invent another semantic model.

The [#506 handoff request](https://github.com/roccho-dev/adrs/issues/506#issuecomment-5965171498) and those consumer references do not yet supply the following concrete integration inputs:

- The adopted exact contract and authoritative repository / accepted ref / path, event schema/version and digest vocabulary, and current/generation identity.
- A consumer-facing pre-Admit entry: candidate and expected-generation inputs, explicit Accept meaning, admission conditions and evidence, and consumer-observable outcomes.
- Post-Admit persistence and atomic stale-update rejection, including concurrent consumers; a preceding GET alone is not CAS evidence.
- Authoritative ref/content/current readback and deterministic reconciliation of an unknown effect, with correlation identity and safe resumption conditions.
- The owner-provided event-to-current path, whether a public reducer or consumer-ready current, its owner and exact provided version. Apps must not add a global reducer.
- The actual implementation owner and existing Issue/PR, usable binding/entry and access conditions. No owner, provider wire or credential is assigned by this document.

Confirmed / refused / stale / unknown describe observable meanings, not new wire enums or a required synchronous response. Only confirmed authoritative current may advance apps Accepted; refusal, staleness or uncertainty leaves Accepted unchanged and retains Working without success, blind retry, dual write, automatic legacy migration or localStorage fallback. View/edit/Undo must not request adoption or write accepted state. Legacy controlled localStorage mechanics are not external integration evidence.

Resume integration only after the adopted exact contract and usable binding can be read back. Apps then owns same-contract controlled checks and actual read → explicit Accept → authoritative readback → reload/fresh-current diagram proof, including stale rejection and preserved Working on non-confirmed outcomes. Final acceptance still needs the same formal PRODUCT/ACCEPTANCE and provided DEPLOY admission, plus P same-entry UX. Real contextual Jev is a separate gate; this dependency does not explain or resolve its failures. The [existing correction400 TODO](https://github.com/roccho-dev/apps/pull/47#deferred-todo--jev-correction-http400) remains deferred through 2026-10-31, with its failure grade intact.

This is consumer readiness documentation: references are not runtime dependencies or proof of delivered/received handoff. Documentation readiness is not contract adoption, binding supply, Accepted integration, real Jev, formal publication or whole-product completion.

## Execution and artifact evidence

`voice-ui-acceptance-runtime` is a separate pinned Nix closure containing Node, Playwright Core and its matching full Chromium. It executes the artifact-owned script supplied as its first argument, with no package installation, source checkout or app rebuild. The app/site artifact does not include the browser.

The boundary check executes three fresh HOME/workspace starts with the artifact-owned entrypoints and actual Chromium. The first two serve exact site bytes and control only /api/judge: 503 judge_unavailable. Each must observe exactly one same-origin application request and a corresponding explicit NOT_RUN reason plus RED receipt. The third deliberately returns the intended JavaScript entry bytes as 200 text/html, observes that actual entry response, and requires a bounded RED exit with zero API requests and no judge_unavailable explanation. Browser-health checks remain in force. These are executable-boundary and misdelivery refusal evidence, not application or provider PASS.

An uncontrolled network exchange with a typed answer is only structural application evidence. It does not identify the upstream provider or prove authentication. The existing scenario assertions and PASS/RED exit remain intact; receipt v1 has fixed additive limits declaring application-e2e scope, provider identity/authentication NOT_PROVEN and live microphone NOT_RUN on either outcome. Whole-product acceptance and P user experience are not proved. Any separately required real-provider gate remains HOLD without independent provider-effect evidence; fixture results and old receipts cannot supply it.

The artifact's only provider route is the compiled Worker (`worker/worker.mjs`); raw `functions/` are not shipped. That is an artifact-contract decision, not proof of any live deployment, admission or acceptance.

Architecture uses the same artifact-owned `e2e/serve.mjs --formal` entry. Its explicit config and public source manifest are in `site/architecture/data/`; original source evidence remains outside the site in `architecture/evidence.json` and is bound server-side to the Worker. Artifact provenance records the prepared source identity and both file digests. Exact committed artifacts require the same apps/source commit and matching admitted Git blobs. Dirty source-dev builds record an unavailable snapshot, not exact-source readiness.

The boundary check additionally runs the artifact-owned architecture scenario in `fixture/natural` with actual Chromium on that keyless formal entry. Its PASS is only artifact shape and controlled mechanics, including legacy localStorage behavior; it proves neither real Jev nor actual accepted authority nor formal publication. The three existing application RED_EXPECTED starts remain a separate grade. Since `dev/serve.mjs` is admitted architecture source, this packaging slice also changes prepared evidence: a subsequent fresh natural real run must be graded against its new exact head, without rescaling or attributing the old provider400 to this change.

The release publishes this already-built closure as `voice-ui-acceptance-runtime.nix-export` (one full `nix-store --export` of every path) with its `.sha256`. Release provenance `/2` records its bytes, digest and locator, its root and `bin/voice-ui-acceptance-node` entry, and every closure path with its narHash and narSize, checked equal to the exported set and under the release asset limit. Ops owns admitting that exact identity, importing the closure with `nix-store --import` (unsigned, so the importing Nix must trust it; not yet proven on a fresh consumer), then passing the verified artifact entrypoint. The immutable Nix store closure, not just the shell wrapper's digest, defines the runtime. Normal invocation does not contact Nix/npm/package registries. The source Nix pin is shared with the root flake.

Physical completion of apps#27 still requires the actual deployed endpoint, target-native auth and complete application acceptance. CI's controlled endpoint must never be used for that claim.
