# Read-only source-reference input

This optional proposer plugs into the existing installed semcmp `--propose`
entry through `dev/proposals.mjs`. It supplies a citation text Proposal, not
an ADR decision, adoption or state write. Existing semcmp owns evaluation and
ordering. No source snapshot or operator binding is shipped here.

The operator's existing `VOICE_UI_PROPOSAL_B` is a private JSON locator with
exact fields `repository`, `directory`, `revision`, `path`, `blob`,
`sha256`, `rawId`. Repository is `roccho-dev/adrs`; directory is an absolute
local path. The existing launch supplies its fixed Git binary separately as
`VOICE_UI_REFERENCE_GIT`; a data locator cannot select a program. Revision and blob are immutable 40-hex Git
identities, SHA256 identifies the exact bytes, and path names one existing
`decisions/*.jsonl` file. No branch resolution, fetching, credentials or new
data catalog is provided. Original raw ID and status remain source provenance;
the new Proposal has a distinct identity and a citation representation.

The host and input target session must bind one immutable locator throughout.
To change source revision, end the old input target/session and host first,
discard its pending responses, then bind the new session. Hot rebinding under
the same raw/generation is unsupported. A new source locator alone does not
invalidate an already-active Meltype request.

Record bodies are not sent in Proposals. Raw IDs, statuses, source paths and
citations are still private information: do not publish them in source, test
logs or artifacts. External provider use requires an applicable existing
authorization for both those references and the query. Controlled evaluation
does not establish actual provider/source integration.

`packages.<system>.voice-ui-reference-proposer` ships only this code and fixes
the existing Git executable at packaging time. Set the existing dev host's
`VOICE_UI_PROPOSAL_MODULE` to its `propose.mjs`, supply the private locator, and
explicitly set `VOICE_UI_MELTYPE_PROPOSALS=1` to enable `/api/meltype-proposals`.
This adapts the existing local `{generation, raw}` port through the same installed
semcmp calculation. It preserves order/IDs/meaning/evidence and rejects the
entire nontext/mixed response. Default, formal PRODUCT and handwritten fixture
routes remain separate. The existing controlled loopback evaluator gate is not
relaxed into external-provider permission. Source/host rebinding and actual B
target invalidation still need their own real observations for B4 acceptance.

The existing target-owned `voice-ui-jev-dev` launcher also admits an explicit,
bounded real-reference session. It takes a private owned mode0600 JSON locator
file, one permitted query, an attempt limit and an absolute deadline. The locator
and existing credential enter through separate pipes; neither goes into argv
or launcher output. This does not grant provider/data-use permission.

In that session the installed dev wrapper fixes both semcmp and this proposer.
Operator-selected modules, endpoints and test keys are rejected. Only the
existing Jev endpoint is used; the child receives no other ambient credentials.
The generic acquisition route and the Worker's other judgment routes are closed.
Only the declared raw query is adapted to the existing reference Qcore. Attempts
are reserved before child launch, without refund, and any failure/unknown closes
the session. Normal, formal and controlled modes retain their existing behavior.

The attempt limit belongs to one host lifetime. An admitted multi-version trial
must additionally retain its total limit and original deadline across r0/r1
hosts; a restart does not renew its permission or budget. Private reference
metadata and provider responses remain outside public CI/PR artifacts. Synthetic
boundary checks do not establish actual data/provider/input acceptance.
