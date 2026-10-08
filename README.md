# apps

`apps` owns deployable application composition. Reusable UI capabilities, runtime packages, environment/secret authority, and deployment effects remain in their owning repositories.

## voice-ui provider boundaries

Application questions, offered choices, typed operations, confidence threshold and durable-world semantics remain in the flat voice-ui core. Explicit judgment and transcription call shapes are adopted in its existing contract; browser composition selects two small concrete adapters. The adopted UI world/schema/serialization kernel is retained, while projection can be replaced independently. These mechanical swap tests do not prove user experience, ASR accuracy or live provider success.

Jev mechanism is supplied as an exact reviewed ops ESM artifact and compiled only into the server Worker. Hayamimi is also an exact provided artifact; neither provider consumes an ops source checkout or rebuild. The UI producer source pin at 8a295d78ad6a6930608b1ad388c896ea49039102 (the ui#317 head, now normal-merged into ui proposals as b9a360a81d7c2eae8077d5cfe2e324d0d8a1f51c) remains an explicit exception: this is not an all-repository artifact-only claim. /api/judge returns typed application answers, not raw provider model/error bodies. JEV_API_KEY and the jev-api capability are unchanged, Worker-only requirements. The target composition binds the supplied ops capability once per request; ordinary app operations receive no key. Ops owns the auth/HTTP mechanism, while the target remains the physical credential holder. Nonsecret availability only preserves the pre-JSON 503 gate: it is not proof of authenticated upstream success.

Producer assembly precedes the target-owned SOPS child. Dev consumes the produced Worker; a consumer of the formal artifact does not build, install or check out source. Input ESM identity and compiled Worker identity are recorded separately. Publication supplies PRODUCT and ACCEPTANCE as six assets; a later ops convergence stage supplies DEPLOY and a fresh same-object gate. New identities require new evidence; old artifacts and real receipts are not inherited.

The same server source is also supplied as PRODUCT `e2e/serve.mjs`. Its fixed `--formal` mode derives the PRODUCT root from its own location and serves that exact site and compiled Worker; there is no formal-root environment override or caller-selected program. The formal target route must first use the provided DEPLOY admission and verify the formal PRODUCT/ACCEPTANCE closure, then start the fixed provided acceptance entry with this server in one secret child. Direct arbitrary Node invocation is not that admitted route. Source-dev mode remains legal with assembly before secret injection, but is a separate evidence grade and cannot replace same-formal-byte acceptance.

## Controlled Proposal acquisition (development only)

The existing `nix run .#dev` host can acquire ranked typed Proposals from
the installed `semcmp` command. The package definition is sourced from
`roccho-org/ops@50bd8a674ca6c13d45cb362c6bc1b6e18659f8eb` and
built into the app's Nix runtime closure: no adjacent ops checkout or working
directory is consulted. This fixed-revision `fetchGit` pin is in `flake.nix`;
it does not add another flake input, so the existing `flake.lock` is unchanged.

Supply all three operator-only settings to enable `POST /api/proposals`:

- `VOICE_UI_PROPOSAL_MODULE`: trusted, absolute ESM module path exporting `propose(query)`.
- `VOICE_UI_PROPOSAL_JEV_URL`: explicit loopback HTTP *controlled test* endpoint.
- `VOICE_UI_PROPOSAL_TEST_KEY`: separately owned synthetic key; not the Worker key.

`VOICE_UI_SEMCMP_BIN` is set by the installed Nix app, never by an HTTP
request. Request: `{"query":{"input":...,"state":...,"focus":...}}`.
The output echoes the exact query and keeps the ordered original opaque IDs,
typed `meaning`, `representation`, and computed Jev `evidence`. No configured
proposer means a 404, not a default catalog or `/api/judge` fallback.
Malformed input, invalid CLI output and timeout fail closed without exposing
private provider diagnostics. The configured proposer is *trusted operator
code*, not a sandbox for user-supplied modules.

An optional `VOICE_UI_PROPOSAL_B` is an opaque operator-provided data locator
passed through the bounded child environment to the configured proposer.
It is **independent** of the executable module path and is never inferred,
opened, mutated or treated as accepted/current by this controlled slice.
The real B owner, format and effective revision remain unresolved in ADRS #577/#506.

Formal PRODUCT's `e2e/serve.mjs` intentionally does not contain the dev
`proposals.mjs` dependency. Formal mode never imports it or offers this route;
the existing Worker `/api/judge` and its capability contract remain unchanged.
The tests are controlled/synthetic only. They do **not** demonstrate real
B/current source, Jev quality, Direct/Voice sharing, UI selection/Working,
physical host acceptance, authoritative Accepted state or edits retirement.
Any real provider/host binding must be separately authorized at ReadyLive.
