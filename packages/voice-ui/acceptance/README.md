# Acceptance execution boundary

## Finite evaluator input (shared-review source v5)

The existing architecture checker accepts an optional `--goal-case <JSON>` after
the existing URL for either Goal scenario. The exact input keys are `version`,
`id`, `goal`, `order`, and `expected`; version is `voice-ui.goal-evaluation.v1`,
order is `normal` or `reverse`. Expected has exactly `kind` (`change` or `none`),
`regions` (`partKey` with exactly one of `parentLabel` or `parent: {addedPart}`, see
below) and `flows` (`from`, `to`). Each endpoint is
either `{ "addedPart": "api" }` or `{ "baselineRegion": "existing-helper" }`.
The latter is the fixed public container-example **step.ref**, not a guessed
allocated record ID. Unknown keys, unsupported/duplicate parts or flows, root or
group endpoints, self edges and ambiguous public parent labels are rejected before
browser/provider invocation. Actual preparation is separately checked against the
complete public seed; unique exact label/kind/parent correspondence binds each
public seed step to its observed record ID before the Goal.

Expected data is evaluator-only gold: never sent to the app/provider, used to
filter a candidate, choose a fixture answer, or plan a change. Existing default
inputs retain their old scripted controls. The explicit `fixture-none` mode always
answers NONE, independently of expected data, and proves controlled mechanics
only. NONE success requires a nonempty actual legal catalogue, the first closed
NONE answer, zero adoption and unchanged full baseline/draft/claims/storage; no
meaningless Undo is required. Change evaluation compares exact added region/flow
multisets and preserves every old record/pin, rather than checking a positive
subset. All applicable existing node/edge paint predicates and overall exit
failure remain unchanged: independent `evaluation.semanticGrade` is not an
overall paint/CI/owner PASS.

Reversed presentation uses the same stable IDs and full candidate entries with
deep-equal other request state. The checker records before/after IDs and hashes,
actual closed answers and membership. In live mode this is an explicit
`route.continue` request intervention, not a claim of independently observed
provider wire or an unmodified ordinary request. Inputs/source/hash/order are
bound in each receipt. Sealed heldout Goal/expected data is supplied by R/P only
after production freeze; the checker generates neither.

This slice changes only the existing checker, smoke controls and this document.
Product/provider/schema/public data/pins remain unchanged. The W-owned prior
diagnostic preimage is retained separately; extra raw SVG diagnostics are not
new quality evidence. At that point classic/perimeter paint and the overall
boundary/flake check were unmet producer dependencies; the later UI 8a pin repaired
them and same-head CI passed (apps#59). These source/controlled checks do not authorize real
Jev, SOPS, display replacement or any C–F actual trial. Actual selection,
generalization and added value remain NOT_PROVEN/NOT_RUN until separately
registered first attempts; literal Add-only baseline is not a fair Connect
baseline. Internal model execution/time/cost are UNKNOWN.

## Local mixed Goal Choice v5

Goal requests choose one request-local executable change: AddRegion/new-child
PinRegions at a proved placement, or the existing directed flow ConnectRegions
between two nonroot, nongroup parts, or NONE. Typed part vocabulary is public
data, not an operator registry. The local join excludes self and existing same
direction edges, but keeps legal wrong directions and endpoints. It never filters
by the Goal's expected answer. Latest-state proof binds all records, pins, bundle,
reserved IDs and actual adopted history; adoption uses the original held effect,
not a replan. Zero candidates (`no-executable-delta`) and more than 254 candidates
stop before asking. A Goal request also carries two required fields. `context` is
the page's recent conversation in the bounded plain shape ordinary Send uses (at
most five earlier utterances of at most 200 characters; effects bounded like
architecture utterances), with no per-entry reference. `scope` is null, or the
latest `{source, focus}` the session remembered from a source-reopened architecture
focus, copied and frozen for the whole Goal. With a scope, only arrows touching a
focused part are offered (either direction, any other legal end), and the server
matches the scope against the served source, refusing a mismatched source, an
unknown part or an arrow outside it (422; 503 without the architecture). No source
text is sent with a Goal and it claims no understanding of the code. Without a
scope the whole catalogue stays, so a Goal on a drawn source snapshot still stops
at `candidate-overflow`. Goal v5 rejects older Goal kinds; ordinary Send v1 is
unchanged. (Goal v4 was the same without `scope`.)

The public bundle offers one generic group part (kind group) within the eight
offer cap; a seed diagram step is never a group. A group joins the catalogue as
a parent only once the same Goal adopted it, by its selected key and region and
a bundle part of kind group, never by an ID prefix. Its child goes below its
siblings, and the group and each ancestor under the root grow just enough in the
same PinRegions, origin kept and never smaller, using the existing padding, label
room and step gap; growing into an existing sibling refuses. A direct Add into a
seed group stays fit-or-none without growth (OCI grows only to enclose a child
of a Goal-added group), and the root is never pinned. The evaluator oracle names a parent as
`{partKey, parentLabel}` (a unique seed group) or `{partKey, parent: {addedPart}}`
(a group part of the same oracle), resolved top-down against the actual graph;
every chain must end at a seed group. Only such a nested oracle admits a replaced
baseline pin, and only for a non-root ancestor of an actual added group with the
same origin and no smaller size; flat oracles keep every baseline record exact.
`goal-nest` drives group, a child in it, a part in OCI and the arrow between them
with crafted answers and whole Undo; it is controlled mechanics, not Sys1 quality.

In the default overview the provider may close a small added group: its scene
then lists the group as not open and the child as not represented, and the
evaluator records that as closed, never as painted. goal-nest then selects the
added group with the existing camera control (a view operation, not an edit)
and proves on that actual frame that the group is open, the child is painted
inside it without overlap, every added label shows, and the expected arrow
matches once while its reverse and a disconnected counter-paint do not; it
returns to the overview before Undo. No threshold is computed by the
evaluator. In this Goal the confirmed pane holds no graph, so equal frames on
both panes are not observed here. Flat scenarios keep the unchanged-viewport
grades.

## Preregistered baseline replay and composed source Goal

Every evaluated Goal also replays the deterministic lexical baseline fixed in
the PR #60 preregistration. In the page, the checker imports the served
production `goal.mjs`, `bundle.mjs` and semantic-map protocol (each already
loaded by the page), verifies the actual pre-Goal Working log, and rebuilds the
session with the served production constructors (below). One selector reads
only each public request (NFKC and
lowercase, longest left-to-right mentions of public part keys/labels and actual
Working labels; an adopted part is named by its public key/label) and answers
through the same `runGoal`, catalogue, proof, bounds and STOP rules. Its first
request must equal the actual first product request and its start must equal
the actual head and records; otherwise the replay is a verdict, not a score. Its
final graph is graded by the same independent oracle. This is a CPU replay of
the semantic outcome only: no HTTP, paint, speed or Jev superiority claim. The
three byte-fixed calibrations (a literal Add/Connect, b reversed word order,
c explicit-key nested) are known controls graded PASS, NOT_MET and PASS; they
are not heldout cases. Sealed fresh Goals come only after production freeze.

`goal-source` composes one page: the whole account, the page code in focus,
then a Goal scoped by that remembered focus. In fixture mode the controlled
answer takes, in request order, the first offered arrow touching the focus
whose ends have no relation in either direction, and the utterance asks for a
trial arrow (画面のコードにつながる試案の矢印): a hypothesis on Working, never a
source fact and never a claim that the code was understood. In live mode the
existing finite `--goal-case` is required: `regions` empty and one flow whose
`baselineRegion` ends are served manifest entity IDs, resolved to the actual
pre-Goal Working; no crafted route or fixture answer is installed. Fixture
goal-source takes no evaluator data and the order must be normal. An unknown,
already related or unoffered target is INELIGIBLE, never success; malformed
input is refused before the browser starts. A Goal request keeps distinct
existing relations that share a directed pair (the page code both imports and
calls the log and the judgment adapter); only edge IDs are unique, and a
candidate may still never repeat an existing directed pair.

Positive proof needs the remembered source focus and plain conversation on the
wire, at most 254 offered arrows each touching the focus, exactly one new
expected arrow with every old non-layout record kept, and the actual painted
arrow at its named ends by the existing painted observer, with the reverse and
a disconnected visible part as negatives; the scene relation list is projection
only, not paint proof. The container is the shared actual parent, else the
actual root. PASS needs one actual frame on which the matched stroke start and
marker tip lie inside the zero-margin iframe viewport and both end shapes
intersect it, with that frame negatives; geometric connection alone is not a
viewport result. The overview is tried first, then the existing camera on the
from end, then on the to end, with records and storage unchanged; label
visibility is recorded only. In the current fixture the arrow joins
`artifact-jsonl` to `web-app-mjs`. The overview paints neither end; on the
`artifact-jsonl` camera (626x434) the stroke runs from (372.8, 263.5) to the
tip (579.0, 423.6), the `artifact-jsonl` shape is [223, 171, 180, 92] and the
`web-app-mjs` shape [549, 424, 180, 92] is partly clipped at the frame edge and
its label lies outside. Whole-Goal Undo, conversation clear with Working and
Accepted unchanged, and the same utterance overflowing before any provider
request follow.

The replay session is rebuilt in the page by the served `createSession`,
`startNew`, `requestFor`, `withArchitecture` and `propose` from the actual title
and the recorded preparation requests and answers. Observed and compared: each
rebuilt preparation request, the pre-Goal log, head and records, and the whole
first Goal request. Derived only from those constructors: issued part IDs,
sequence, conversation and draft count; a reserved ID for a new part is not
proven by the first request. Any difference withholds the score.

## Real-case regressions after the v29 first attempts

The v29 first real attempts (issue #58) are kept as recorded and never rescored.
Three corrections followed, each from an observed cause:

- At 3d858 a seed lane whose raw grid looked full offered no Add although its
  painted frame had room, so the sealed g2 and d1 Auxiliary requests were
  unreachable. The raw box is now only the AddRegion placeholder when the raw
  grid is full; the painted search and the provider still decide the fit. The
  seed Auxiliary takes exactly one more part, so the full g2 (two parts) and d1
  (two parts) sequences remain unreachable.
- In the observed g1 order a part was placed touching a grown group, and the
  strict painted nonoverlap check failed by a sub-pixel. A direct addition now
  tries the existing grid, then off-grid positions one band padding (12) after
  an actual sibling, and keeps that padding from every painted sibling; a grown
  group checks its siblings the same way. The checker tolerance is unchanged.
- Goal-undo ran even when a Goal adopted nothing and then undid the
  preparation. It now runs only when the Working head changed (this also covers
  a Connect-only Goal); otherwise records, draft, claims, storage and the
  confirmed view must be unchanged and the effect is recorded as none.

The preregistered lexical baseline selector is one definition, restored in the
page from its own source for the CPU replay. The explicit `fixture-baseline`
mode (Goal scenarios, `--goal-case` required) answers with that same selector
as a controlled seen regression; its Node answers must equal the replay, and
changing only the expected data changes grades, never answers. `fixture-weak`
answers a first offered choice below the confidence floor. These are controls,
not Jev quality. The intent words for compose and architecture now name
`state.offers.diagrams` and `state.architecture`; the API test proves only that
input distinction, not a confidence or quality change.

The smaller-only-fit fixture uses the same 220×160 parent and 40×40 other group:
one small offer fits while a wider offer does not. Its independent expected graph
and whole Undo prove finite coverage and controlled execution, not Sys1 judgment
quality or added value. The existing two-addition packed fixture still makes two
adoptions; with the mixed alphabet it asks NONE separately after those two
successful additions. `goal-flow` adds the same two parts then one empty-label
directed flow API→DB and asks NONE: four Goal requests, one Choice each in the
controlled positive fixture. Preparation remains separate. Its actual SVG stroke
and pinned classic filled arrow marker must uniquely connect the two raw-label
painted shapes in the expected direction; reverse and disconnected geometry
controls must fail. Logical relation records alone are not painted-edge proof.
Actual Jev and P screen evaluation for this change are NOT_RUN, added value is
NOT_PROVEN. Existing paint, persistence/readback and refusal regressions remain.

## Bounded Goal additions

Semantic graph attainment, elapsed-budget compliance and display observation are separate grades. A closed budget-time stop may leave the expected graph but does not meet the time envelope. Label visibility proves nonzero rendered text intersecting the unchanged viewport, not full text fit or human readability; independent P UI remains required. Incomplete HTTP, supervisor timeout or unknown drawing never becomes a known successful stop.

The separate Goal button takes one natural-language text and makes finite additions inside existing groups with room or directed flow connections between existing parts. Public parts and a preparation diagram are in the existing DataBundle; preparation is not Goal generation. Ordinary Send retains its single-edit behavior. No new planner, reparent operation or external Accepted contract is supplied.

The small chain is DataBundle/Working → local executable ADD/Connect catalogue → one closed delta Choice → latest-state proof → original held operation → session group → draw/adopt → actual adopted state → mechanical STOP. The public catalogue contains only individually executable pairs; already adopted part keys and existing directed edges leave the next catalogue. NONE, no executable delta, cancellation and budgets are unconfirmed stops, not semantic success. Goal steps share one Undo group, including partial known success; issued IDs remain monotonic. Cancel cooperatively stops further requests, not proven upstream cancellation. Display/adoption UNKNOWN requires reload/reconciliation, never blind retry.

`goal-addition` on the existing architecture entry prepares the public example, types “OCIの中にAPIとDBを追加して” once into Goal, and evaluates the unordered actual label/kind/parent records only after the product stops. Its independent sealed oracle never controls candidate generation. The literal-name baseline uses that first actual request's offered keys and eligible group labels, with output words from the same bundle authority. A solved literal example does not prove Jev added value. Product HTTP/planning/draw elapsed and baseline selection-only CPU elapsed have different measurement scopes; no price or internal model count is inferred. Whole-Goal Undo restores baseline records/draft/claims/storage/confirmed view.

The same packed boundary adds mandatory fixture-positive and first-Goal protocol STOP controls; pure tests cover wrong-parent retention, closed request rejection, cancellation, stale/unknown effects and partial-group Undo. These controls are not real Jev. Existing natural/camera, contextual-reverse, binding, shape and RED guards remain mandatory.

The historical PR54 registration budget is 100 actual checker or independent UI trials, not 100 GitHub workflow dispatches or a total of 100 Jev calls. This choice-source change does not authorize new actual trials. Count every preparation and Goal application/upstream POST, including ordinary Send preparation fanout; setup-at-most-one and a physical total-call cap are not required. Each Goal allows at most eight requests now with one Choice question per request. The sole-fetch binding proves one upstream POST per application request, not internal model execution counts. Fixture preparation remains exactly one response; live preparation requires all observed responses to be complete valid 200 answers and the actual container-example groups/helpers to match the public bundle before Goal starts. Product elapsed-time STOP is 180 seconds; supervisor and cleanup budgets are separate. Three serial cases use the same admitted head: W Goal plus whole-Goal Undo; P independent Goal success graph through explicit local Apply/readback/reload without Undo; and W fresh contextual-reverse. The last is a new-head measurement, never a rescore of PR51's frozen negative receipt. First UNKNOWN, evidence loss or unknown cleanup stops every remaining case. Known failure stays recorded. Packed controls make no live calls; exact head/data/input/collector/ownership admission precedes actual execution. Formal publication and external Accepted remain NOT_PROVEN.

`voice-ui-acceptance-runtime` is a separate pinned Nix closure containing Node, Playwright Core and its matching full Chromium. It executes the artifact-owned script supplied as its first argument, with no package installation, source checkout or app rebuild. The app/site artifact does not include the browser.

The runtime runs Node under the pinned Tini subreaper (`-s`), preserving Node's exit status. Tini adopts and reaps orphan descendants while its main child lives; it exits with that child and does not guarantee termination of every live descendant. Nix boundary PASS alone is not cleanup proof: before real execution, a keyless fixture under the exact runtime in the same target must show physical absence of every new owned PID/starttime and no new live or zombie descendants. Each real cleanup remains separately observed; historical cleanup UNKNOWN is unchanged.

The boundary check executes three fresh HOME/workspace starts with the artifact-owned entrypoints and actual Chromium. The first two serve exact site bytes and control only /api/judge: 503 judge_unavailable. Each must observe exactly one same-origin application request and a corresponding explicit NOT_RUN reason plus RED receipt. The third deliberately returns the intended JavaScript entry bytes as 200 text/html, observes that actual entry response, and requires a bounded RED exit with zero API requests and no judge_unavailable explanation. Browser-health checks remain in force. These are executable-boundary and misdelivery refusal evidence, not application or provider PASS.

An uncontrolled network exchange with a typed answer is only structural application evidence. It does not identify the upstream provider or prove authentication. The existing scenario assertions and PASS/RED exit remain intact; receipt v1 has fixed additive limits declaring application-e2e scope, provider identity/authentication NOT_PROVEN and live microphone NOT_RUN on either outcome. Whole-product acceptance and P user experience are not proved. Any separately required real-provider gate remains HOLD without independent provider-effect evidence; fixture results and old receipts cannot supply it.

The artifact's only provider route is the compiled Worker (`worker/worker.mjs`); raw `functions/` are not shipped. That is an artifact-contract decision, not proof of any live deployment, admission or acceptance.

Architecture uses the same artifact-owned `e2e/serve.mjs --formal` entry. Its explicit config and public source manifest are in `site/architecture/data/`; original source evidence remains outside the site in `architecture/evidence.json` and is bound server-side to the Worker. Artifact provenance records the prepared source identity and both file digests. Exact committed artifacts require the same apps/source commit and matching admitted Git blobs. Dirty source-dev builds record an unavailable snapshot, not exact-source readiness.

The boundary check additionally runs the artifact-owned architecture scenario in `fixture/natural` with actual Chromium on that keyless formal entry. Its PASS is only artifact shape and controlled mechanics, including legacy localStorage behavior; it proves neither real Jev nor actual accepted authority nor formal publication. The three existing application RED_EXPECTED starts remain a separate grade. Since `dev/serve.mjs` is admitted architecture source, this packaging slice also changes prepared evidence: a subsequent fresh natural real run must be graded against its new exact head, without rescaling or attributing the old provider400 to this change.

The release publishes this already-built closure as `voice-ui-acceptance-runtime.nix-export` (one full `nix-store --export` of every path) with its `.sha256`. Release provenance `/2` records its bytes, digest and locator, its root and `bin/voice-ui-acceptance-node` entry, and every closure path with its narHash and narSize, checked equal to the exported set and under the release asset limit. Ops owns admitting that exact identity, importing the closure with `nix-store --import` (unsigned, so the importing Nix must trust it; not yet proven on a fresh consumer), then passing the verified artifact entrypoint. The immutable Nix store closure, not just the shell wrapper's digest, defines the runtime. Normal invocation does not contact Nix/npm/package registries. The source Nix pin is shared with the root flake.

Physical completion of apps#27 still requires the actual deployed endpoint, target-native auth and complete application acceptance. CI's controlled endpoint must never be used for that claim.

## Distinct contextual reversal

The existing architecture entry also offers `contextual-reverse`: a fresh Working map, then exactly “画面のコードの役割を詳しく見せて” and “さっき詳しく見た画面が判定を頼む呼び出しを、試案として逆向きにして”. All focused-source role/provenance/import/calls/storage expectations are prerequisites of the second turn. That turn must carry the prior source reference and actual unique app-to-judgment-adapter calls edge, obtain one fresh typed intent, project its exact Remove+Connect direction change, and Undo back to the same records/claims/draft without changing either legacy stored key or confirmed view. The reverse is a hypothetical Working edit, not a new source fact or second body judgment. Its fresh browser viewport is explicitly 1280×720 and checked, never tuned after a failure.

The same packed boundary requires three keyless controls alongside the unchanged natural/camera case: `fixture` positive; `fixture-stop` first-intent 502 protocol STOP; and reverse-only `fixture-semantic-stop`, a complete valid 200 judge answer with the APP `jev-boundary` role NONE. The latter must stop at the first semantic prerequisite with no second send/Undo/Apply/reload and no protocol failure. Smoke checks actual structured summary, source/manifest identity, stage/action accounting and cleanup, not just a PASS string. These are controlled mechanics, not live Jev or Accepted integration.

Any real source-grade run requires a separate exact registration and permission with finite attempts/STOP and the existing lawful launcher; no live call is made by these controls. PR47's storage-removal correction400, receipts and NOT_MET remain unchanged and deferred through 2026-10-31. This distinct calls reversal neither retries nor resolves that case. Formal publication, usable external authority and final same-object Jev/current/P UX remain separate gates.

## Goal painted containment

The finite evaluator grades NONE only after exact graph, draft, claims, stored/root and confirmed-view equality. New pin owners must form a one-to-one multiset with added children. Expected flow identity is independent of JSON property order. Every expected edge's paint grade includes visible added labels and endpoint-bound reverse/disconnected negative geometry; these requirements do not waive the full arrow or overall boundary gate.

Goal candidates individually check an effective-layout slot for each remaining public part/group pair, not simultaneous packing or full legal reachability. A small-only fit is no longer excluded by an unrelated wider offer. The provider supplies preview dimensions; the selected held child placement is rechecked and added with its own pin in one Decision. Existing records and pins are retained. The mandatory Goal control records raw suffixed labels separately from catalogue-normalized labels and checks actual SVG child shapes inside the painted OCI boundary, sibling nonoverlap and whole-Goal Undo. Logical parent and label viewport visibility alone are not containment proof. Historical logical-only PASS and visual NOT_MET/collector UNKNOWN receipts remain unchanged; fresh real/UI evidence requires separate admission.

The pure request-exhaustion fixture has explicit roomy provider pins so seven/eight actual offers can exercise their request bound; raw record bounds alone never promise painted capacity. This test-only setup does not change the public container-example seed, actual Goal input, provider dimensions or acceptance thresholds.
