# Atlas Purpose Closure

Refs [apps#68](https://github.com/roccho-dev/apps/issues/68). This application-owned
projection restores **Purpose / Ideal / Current / Gap / Fill / Receipt / Residual**
and the relations that lead back to the highest purposes. It does not restore a
renderer or claim that the actual company has reached those purposes.

## One contract, several sources

`purpose.jsonl + current.jsonl → reduceClosure → atlas.reduced.jsonl`

Input and output use the same `atlas.purpose-closure/1` JSONL contract. Every
document starts with `{"schema":"atlas.purpose-closure/1","authority":false}`.
The remaining lines are typed records. Both filenames describe example roles,
not privileged source types: upstream purposes and later tributaries may arrive
in either input or in further inputs. References are checked **after the join**.

`reduceClosure(...documents)` is the only core entry. A complete reduced output
can be reduced again with later source projections, including new upstream links
and a previously unassigned Residual's next step. Partial fragments may be supplied
together; a still-incomplete join fails rather than inventing missing ancestors.
Inputs are projections, **not a history ledger**. Apart from the two additive
relation sets below, conflicting versions must be reconciled by their owner before
this join. No timestamp winner, source precedence or business approval is added.

## Record contract

Every record has `kind`, a global `id`, `label`, and nonempty `sources`.
Each source is `{sourceRef, sourceDigest}`: a revision-qualified locator and
`sha256:<64 lowercase hex digits>`. These declarations are preserved and checked
for shape/consistency, **not authenticated against an external authority**.

| Kind | Additional required fields | Explicit relation |
|---|---|---|
| `purpose` | `parents` | Known upstream purposes; an empty joined list is a root of the supplied graph |
| `ideal` | `purposes`, `value` | Desired condition contributing to one or more purposes |
| `current` | `value` | Observed/declared current condition, linked through a Gap |
| `gap` | `current`, `ideal`, `delta`, `owner`, `proof` | Current → Gap → Ideal → Purpose |
| `fill` | `gaps`, `scope` | Work addressing one or more Gaps; scope lists work boundaries |
| `receipt` | `fill`, `status`, `evidence` | Effective outcome of that version of Fill |
| `residual` | `receipt`, `next` | What remains; next Current/Gap references can branch |

All scalar fields are nonempty text, except the fixed header boolean. Reference
and scope/evidence arrays are unordered sets. `parents` and `next` may be empty;
other arrays must be nonempty. Unknown fields/kinds/schemas, duplicate JSON keys,
duplicate set members and missing/wrong-kind references fail closed. Repeated IDs
become one record: only the additive relations below and `sources` are unioned.
Every other semantic field must match. Same source locator with different digests
is still a conflict, including during a late relation addition.

A Gap's `delta` is **declared by its source**, not inferred from descriptions or
from work counts. A Current must have a route through a Gap to an Ideal/Purpose.
A Gap may have no Fill yet; a Fill may have no Receipt yet. Those are pending,
not malformed or complete. Multiple highest purposes and shared branches are
allowed; both purpose ancestry and causal work/continuation flow must be acyclic.

Receipt status is `closed`, `reduced` or `failed`. This v1 snapshot carries one
effective Receipt per Fill version, with potentially several evidence references.
Retries/history need distinct versioned Fill ids or upstream reconciliation.
`closed` cannot have linked Residuals; `reduced` must retain at least one. An empty
Residual `next` means no next step is declared in the joined inputs, **not completion**. Recursion
uses new Current/Gap ids; pointing back into the same causal cycle is rejected.
Neither a closed Receipt nor the absence of Residuals produces a Purpose verdict.
Typed reference fields are the relations; a second editable edge table is not added.

## Late relation rule

For the **same ID**, only `purpose.parents` and `residual.next` are additive
sets of positive relation assertions. Join them by sorted, deduplicated union;
join provenance by the existing source union. Every other field must agree.
A later record is still a full typed record, not a patch or a new event type.

`parents=[]` does not assert that no upstream can ever exist. `next=[]` does not
assert a final unassigned/complete state. Both mean no such relation is declared
in that input. The consumer reads the single joined record, so replaying an older
empty set or subset cannot erase a later link or restore an unassigned state.
Different added links coexist as branches; input order never chooses a winner.

In particular, after a successful reduction:

- A later source can add an upstream Purpose and name it in the existing child's
  `parents`; the child keeps its ID and its path now reaches that upstream.
- A later source can supply a new Gap/Current and name it in the existing
  Residual's `next`; no replacement Residual ID is required.

The final union must still have valid reference kinds, no missing targets and no
purpose/closure-flow cycles. `label`, `kind`, scalar links and values, and all
other arrays remain immutable per ID. In particular, `ideal.purposes`, `fill.gaps`,
`fill.scope` and `receipt.evidence` are **not** silently broadened: that would
change the meaning of an existing goal/work/result rather than discover a link.
The existing closed/reduced Receipt checks remain unchanged.

This is an additive join, not a way to retract/replace a link: omission never
means deletion. Non-additive correction needs an owner-reconciled replacement
snapshot without rejoining the superseded output, or a separately defined version
contract. No supersession protocol or authority is inferred here. `sources` keeps
node-level supporting provenance, not an authenticated per-edge attribution.
On valid joins, staged reduction, permutations and replay yield the same bytes.

## Files and use

- `closure.mjs`: pure parse → normalize/join → relation validation → canonical JSONL.
- `reduce.mjs`: UTF-8 file input, atomic output and an exact input/output hash receipt.
- `fixtures/{purpose,current}.jsonl`: synthetic, non-authoritative application data.
- `tests/closure.test.mjs`: independent consumer traversal, destructive cases and real CLI tests.

From the repository root:

```sh
node packages/atlas/reduce.mjs --out=/tmp/atlas.reduced.jsonl \
  packages/atlas/fixtures/purpose.jsonl packages/atlas/fixtures/current.jsonl
node --test packages/atlas/tests/*.test.mjs
```

The CLI prints an `atlas.purpose-closure-build/1` receipt **after** writing the
output. This is a build receipt, not one of the business `receipt` nodes. It hashes
the exact input files and output bytes. Invalid input never replaces the previous
output. Output cannot overwrite an input or follow a symlink. Output is generated
outside this package, not checked in or used as a new decision authority.

Fixtures describe a hypothetical company purpose, two contributing subpurposes,
current/ideal differences, partial work completion and a Residual leading to a
later Gap. They are **not actual apps#66 execution or real OCI observations**.
Their source digests identify each fixture's pre-join record payload with `sources`
removed; the CLI separately identifies the actual JSONL file bytes.

## Boundary and completion

This closes apps#68's contract/CLI slice, not the visual Atlas application.
[apps#66](https://github.com/roccho-dev/apps/issues/66) owns bootstrap/source wiring.
[ui#332](https://github.com/roccho-dev/ui/pull/332) remains the adopted SharedAtlasUI.
No ui examples, UI schema, renderer, distribution pin, credentials, live collector,
auto ticketing or decision authority are changed here. The CLI output is not yet
an input accepted by SharedAtlasUI: that consumer adaptation is a separate step.

The existing `nix-check` workflow runs these tests with its locked nixpkgs Node
before its unchanged flake check. No second workflow, registry, server, framework
or package-manager dependency is introduced.

## Semantic Scope supplied-data application slice

Refs [ADRS#613](https://github.com/roccho-dev/adrs/issues/613).
Status: supplied-data candidate implementation, authority=false. This does not
admit its own meaning, connect a real collector, prove business Purpose
achievement, or satisfy autonomous Factory [C01-C13](https://github.com/roccho-dev/adrs/issues/616).

The owning domain supplies an exact `current-to-target` meaning comparison and
a justified responsibility partition. Apps validates this application port and
projects it with the **existing** Closure reducer and generic SharedAtlasUI.
It never derives meaning from field equality, words, counts, a label or a hash.

### Explicit side input

`atlas.semantic-scopes/1` is a separate domain-declaration port, not an unknown
record inserted into `atlas.purpose-closure/1`.

| Input | Required meaning |
|---|---|
| comparison | logical Purpose; exact current/target refs; explicit direction; same-pair revision-bound basis; supplied semantic parts and verdicts; reconstruction/coverage basis |
| partition | selected Scope IDs, responsible parts, role/actor, per-part closure criteria, required evidence IDs, rationale, residual policy |
| observation | actual declared post-state ref, selected target, independent evaluator, Scope criterion evidence, separate whole-selected-target evaluation |
| evidence | explicit requirement IDs, revision-qualified witness, same observed/target refs, independent evaluator, known/unknown/conflict and currentness |
| history | prior obligations retained explicitly; target replacement or an empty current partition never deletes them |
| bindings | exact pair and explicit Closure purpose/current/ideal/observed records with their original sourceRef/sourceDigest sets |

`normalizeSemanticScopes` returns the exact comparison, responsible
transformations, bindings, observation and history. UNKNOWN/CONFLICT or a missing
decomposition has `scopes=null`; only a complete declared-equivalent comparison
has no active Scope. Unassigned changes stay uncovered. These are conformance
results, always `semantic_truth=domain-declared-not-verified`.

`scope_status` and `purpose_status` are separate. Scope-only evidence can
establish a bounded checkpoint while Purpose stays UNKNOWN. Whole-target
evaluation must include conditions that were initially equivalent: their
post-work regression becomes a new residual. A positive Purpose declaration
with residuals is a conflict. Successful Work, Receipt or CI does not supply
whole-target evidence.

Valid assigned Scope evidence is evaluated even when another semantic part is
unassigned. Its checkpoint and full observation remain available; responsibility
coverage and its residual are separate. Incomplete coverage cannot turn a known
Scope checkpoint into UNKNOWN, or turn an unreconciled overall obligation into
Purpose completion.

Bindings are domain assertions. Names, equal IDs across spaces, prefixes, owner
or Project membership never create a Closure bridge. Wrong revision/source,
another Purpose, missing or conflicting mappings stay UNKNOWN and unlinked.
Source digests remain declared provenance; this application does not authenticate
external source truth or grant authority.

### Same input to the existing generic UI

`semantic-scope-world.mjs` adapts the real `reduceClosure` output and the domain
side input to `ui.atlasWorldInput.v1` with exactly three areas: **Purpose**,
**Scopes** and **Agents**. There is no new renderer or business parser in UI/Host,
and no containment is drawn unless the input supplies it.

- **Purpose**: the Purpose, one **Current** and the target role. The Current keeps
  one identity across frames and shows the frame's selected revision (the
  supplied observation's `observed_ref`). The original comparison's current, the
  frame closure and the verbatim reduced seven-kind Closure rows (sources and
  absent times included) stay readable as history in the target-to-Purpose
  relation context. They are not drawn as separate Gap/Current/Closure entities.
- **Scopes**: the Gap is represented only by its responsibility units. A Scope's
  own status uses only its own criteria. A criterion the criterion-level
  evaluation satisfied but the whole-Purpose evaluation lists as residual is a
  visible `conflict` (`evaluation-disagreement`, both declarations kept), never
  history. A Scope is `active` (unmet, conflict or unknown: current needed
  change), `completed-history` (declared_satisfied with a bound mapping: a kept
  checkpoint, not current need) or `unresolved` (satisfied evidence kept readable
  while the mapping is unknown; its relation says 未確定, not necessity).
  Changed parts or residual/unknown criteria owned by no Scope are explicit
  unassigned units; units from a conflicting whole-Purpose evaluation are marked
  `whole-purpose-conflict` (未割当・矛盾), not plain unmet. An unknown/undecomposed
  comparison or binding, a conflicting whole-Purpose evaluation, or an unmet
  Purpose with no unit is an explicit unresolved unit: the current Gap is never
  empty while the Purpose is not declared satisfied. A whole evaluation that is
  *declared* unknown while uncertain units already exist gets no unit of its own:
  those units are the same open difference (D-derived frames always hit this).
  D marks a satisfied condition `equivalent`, so it is no Scope. Each frame's
  `coverage.unknown` counts only unassigned units, unresolved/unknown/conflict
  units and Scopes whose own status is unknown or conflict or whose standing is
  unresolved. A known, owned, unmet Scope is in the current Gap but is a known
  missing change, not an unknown. Old obligations stay here as history.
- **Agents**: only declared ids (Scope `owner_actor`, observation `writer` and
  `evaluator`) with their declared roles, flagged synthetic, declared-only and
  activity-unobserved. `owner_role` is an attribute of the 担当 relation. With no
  declaration an explicit missing marker is shown. Unassigned units have no Agent.

Overview captions are presentation only: exactly two logical lines, a role/kind
line and the **full** supplied text (for example 目的 and the Purpose label, 現状
and the full revision, a Scope label and its status, 未割当 and the full id, an
Agent id and its declared roles). The adapter never shortens them: no ellipsis,
no id-tail elision. The generic UI wraps long lines. Every supplied label, id,
revision and status also stays verbatim in the record summary, flags and context. Relation ids are
namespaced by unit kind (`change:scope:`, `change:unassigned:`,
`change:unresolved:`), so a Scope id equal to another unit id cannot collide.
The overview orders Purpose, Target, Current; old obligations before the current
units; Scopes grouped by declared owner (stable, first appearance) and owner
Agents first in that same order, so 担当 relations do not cross. Two relation
families carry `visible:false` with unchanged declared contexts: the observation
`writer`/`evaluator` role relations (they always cross the Scopes pane) and the
Current -> unit `change:*` relations (every unit would otherwise fan to both
Current and Target in the Purpose column). The latter keep `path` for Direction;
one drawn `gap:current-target` relation (差 N 件: one per open unit) lists them in
`context.change_relations`. The UI reports all of them as omitted relations;
their records stay in the World, catalog, search and detail. Owner (担当),
Current -> Target, Scope/unit -> Target -> Purpose and history relations stay drawn.
`tests/crossings.mjs` counts overview crossings (columns by area order, rows by
order, drawn relations only; same counts as ui `tests/fixtures/atlas-crossings.mjs`
on P's mock: 10 before). Every fixture frame now has 0.

Scope relation context keeps the full pair, responsibility, criteria, evidence,
frame closure, standing and old obligations. Known, source-declared Current ->
unit -> target -> Purpose relations adapt to the existing World `path` contract
for Direction. Unknown comparison/binding does not invent a semantic path or
bridge; history and Agent edges are not promoted. An unknown mapping never makes
the Current fresh or the Purpose achieved, and never erases the evidence.

A target is never dated as a later actual observation; its effective time remains
unavailable. World rev/asOf belongs only to supplied observation captures and
never supplies/freshens target/comparison timestamps. Only an explicit bound
observation.observed_at times the Current; otherwise it stays null. The included
fixture has two synthetic captures: the initial Scope closes, while an initially
equivalent recovery condition regresses as an unassigned unit and Purpose remains
unmet. Fixture dates are not actual service-observation timestamps.

~~~sh
node --test packages/atlas/tests/*.test.mjs
node packages/atlas/semantic-scope-world.mjs \
  packages/atlas/fixtures/semantic-scopes.json \
  packages/atlas/fixtures/purpose.jsonl packages/atlas/fixtures/current.jsonl \
  > /tmp/atlas.semantic-world.json
~~~

Pass that **actual app-generated JSON** to the existing UI build entry:

~~~sh
node scripts/build-live-atlas.mjs --consumer=app \
  --input=/tmp/atlas.semantic-world.json --out=<fresh-absent-output-directory>
~~~

The scoped proof consumer is UI exact
`ccd05d09dd4bf73326916bd275984a9b85a414b3` (Draft ui#344 over
`98621ca0f2b87dd27d2c9c6a5eb935009aeb06c3`); these are not current UI proposals.
This proof does not change the apps global voice-ui UI pin. The build's actual
input/module/output receipt, actual public source tree, independent R browser
verification and P's same User entry are separate evidence. Native artifact-only
checks may point `ATLAS_CLOSURE_INPUT_ROOT` to captured exact input modules for
preliminary tests; formal validation uses the actual published package source.

This six-file slice adds no schema to the adopted Closure reducer, workflow,
server, ledger, runtime collector, credentials, renderer, merge/close/deploy
authority, or Factory reactivation engine. Actual domain admission/observations,
real Agent collection and source/SSE integration remain their existing separate
responsibilities.

## Event-sourced derivation (D)

`events.jsonl + control.jsonl → deriveAtlas → closure.jsonl, semantic-scope-world.json, world.json, plan-projection.json`

The only inputs are an `atlas.events/1` log of three event kinds and an
`atlas.control-norms/1` Norm stand-in (ADRS `control.jsonl` R/W and binding).
Gap, Scope state and responsibility are **derived**; nothing is hand-written.
The existing contracts become outputs: per frame t the derivation emits the
`atlas.purpose-closure/1` rows and the `atlas.semantic-scope-world/1` frame, and
the unchanged `reduceClosure` + `semanticScopeWorld` build the World.

| Event | Required fields |
|---|---|
| `purpose.set` | `purpose{id,label}`, `version`, `label`, `requires[]{id,label,predicate{target{kind:state,id},op:equals\|oneOf,value},maxAge (ISO 8601),norm}`, `source{ref,digest}` |
| `plan.set` | `purposeRef{purposeId,version}`, `source{ref:repo#n,commentId\|null,updatedAt,digest}`, `version`, `nodes[]{id:repo#n:id,label,norm,exit,contributesTo[],predicateRefs?,due?}`, `edges[]{from,to,kind:dep\|loop\|branch,condition?}` |
| `observation` | `target{kind:state\|owner\|session,id}`, `value`, `source`, `observedAt` |

Every event has `recordedAt`; the log is append-ordered. `observedAt` and the
plan body's `updatedAt` must not be later than `recordedAt` (future facts are
rejected). Unknown fields/kinds, duplicate keys, unqualified plan node ids, dep
cycles and references outside the named Purpose version fail closed.

- Frames: each distinct `recordedAt` from the first `purpose.set`; now is the
  maximum `recordedAt`. A frame sees only events at or before t, and its Closure
  is reduced from that prefix only (no later rows leak into a past frame).
- Condition: `satisfied`/`unmet` only for the latest observation of the exact
  declared state target, within `maxAge` of t and comparable with the predicate;
  otherwise `unknown` (no observation, stale, unmatchable). Ids, prefixes and
  labels are never matched; reachability never satisfies anything.
- Responsibility: the referenced Norm must exist and bind this Purpose/condition
  and have exactly one W; an explicit `owner` observation must agree. Otherwise
  `unassigned` or `conflict` (shown as 未割当・矛盾). Criterion ids are the
  condition ids, so an unowned residual is one unassigned unit per condition.
- History: a superseded version's obligations are frozen with the values derived
  at its archive instant. Plans never enter the Gap, Current or coverage.
- Purpose: a log may change its Purpose (a purpose.set with another `purpose.id`);
  one id keeps one label. Ideal versions stay unique across the log.
  `fixtures/gap/` (6 frames) exercises every gap cause.
- Plans (`atlas.plan-projection/1`): the latest plan per `repo#n` at t;
  `premise-version-mismatch` when it names an older Purpose version. Node state
  comes from `predicateRefs` (condition ids) only, else `unknown`; `blockedBy`
  lists unsatisfied predicate ids and unfinished dep predecessors; a loop target's
  satisfied→unmet transitions give an iteration number (`instance` `id#n`); `overdue`
  only with `due`. No plan at t is `status: unknown, plans: null`, never empty.
  Optional: `plan.set.plan` is the plan identity (default `source.ref`, so one
  Issue may carry several plans); `nodes`/`edges` may both be `null` (content unknown) with
  `unknown[]` reasons; `requires[].plans` declares the plans serving a condition,
  shown as the plan's `serves`. Plans are compared by what D uses (not `recordedAt`,
  `source.updatedAt` or `source.digest`: GitHub can rewrite a body, e.g. a moved issue's `#28`
  into `owner/repo#28`, without moving `updated_at`). The same plan version, or the same body
  time, recorded again with other content does not stop the World: from then on that version is
  held as content unknown (`unknown: ['conflicting-redefinition: …']`, neither definition used);
  the same content again is accepted.
- Agents: the World heading and flags come from the declared `source_mode`
  (`synthetic`/`supplied`) and `session` observations, not a fixed caption.

~~~sh
node packages/atlas/derive.mjs --out-dir=/tmp/atlas-d \
  packages/atlas/fixtures/events/events.jsonl packages/atlas/fixtures/events/control.jsonl
~~~

`fixtures/events/` is synthetic (P's HQ mock events in this contract plus two
plans). Its World hash is fixed in `tests/events.test.mjs`.
Do not use `derive.mjs` with hand-written D events as an entry for declarations: it skips `live.mjs`
`joinLog`, where declarations are checked (e.g. no `work:*` / `evidence:*` condition, adrs#654).

## Live join (K): G → D → World

`live.mjs` only joins. `fromG` is the one place that knows G's event shape:
a G observation target stays an opaque D state id (`apps#92:pr.state`), its
`{ref, sha256}` source becomes D's source text, and G's literal `UNKNOWN` becomes a
`null` (D's own marker: no value obtained), which D judges `unknown`. G's documented `<target>:session` is
also passed as D's `session` observation of `<target>`, which the World shows as
that Agent's observed session value only when a Norm W id is exactly `<target>`. Declared
owners of conditions that are no Scope now (satisfied) stay in the Agents area as `responsible`,
so the heading (未観測 / 一部観測 / 観測あり) follows their session observations too.
The value is shown as observed: `transcript-only` is a past transcript, not activity.

A G `plan.set` enters D only when the Purpose author declares it: a condition's
`requires[].plans` lists the G plan ids that serve it (the latest ideal state at
or before the plan names its `purposeRef`). Journal decisions from G are accepted one
by one with D's parser; one D rejects is held in `g-journal-held.jsonl`, not fatal. G cells are copied, never parsed, and
D's own parser checks the converted plan; a plan D rejects or nobody declares is
held in `g-plans.jsonl` as `{reason, plan}`. L3 (adrs#647, display only): a plan nobody declares is also written to
`g-unbound-plans.jsonl` and passed as `derive.mjs --unbound-plans=`, and the World's journal shows it as
`{kind:'plan.set', recordedAt, actor, source:{ref, commentId, sha256}, plan, version, unbound:true}` (deduplicated by
plan, version and sha256; in the first frame at or after its time). It never enters D, the plans, the gap or any count;
one recorded after the last frame is not shown and is counted in the receipt as `unbound.unplaced`. G's `UNKNOWN` graph becomes D's `null` marker in `fromG` only: D keeps
it as a declared plan with `nodes: null` and the reasons, never as "no plan".
Without `--control` there is no Norm and every condition is unassigned.

Contract v12 (adrs#647 comments 6303801344, 6304588582), display only, never a judgment or a count:
- `frames[i].adequacy {basis, state, reason, evidence}` is GapA (目的↔理想). The reason is the first that applies:
  `purpose-ended`, `no-ideal`, `no-evaluation`, `past` (Purpose rev or ideal version differs, compared as written),
  then by the latest evaluation's verdict `evaluated` (ideal-insufficient), `not-yet-while-matched`,
  `achieved-while-open`, `no-adequacy-verdict`. state is `unmet` only for `evaluated`, else `unknown`.
- `frames[i].held` lists the declarations held back that entered at the frame (`derive.mjs --held=g-journal-held.jsonl`;
  held plans and unbound plans are not in it), `{reason, kind, recordedAt, source:{ref, commentId, sha256}}`. One
  recorded after the last frame is counted in the receipt as `held.unplaced`.
- A judge `no-value` (arrived with no value) is `current-unmatchable`, not `current-unobserved`.
- control `{kind:'authority', purposeId, deciders:[login], proposers:[login]}`: for that Purpose only, a proposer's
  decision is held as `proposal` and anyone else's as `actor-not-authorized` (live.mjs `--control`). A Purpose without
  it is accepted as before. An `evaluation:<purpose_id>:<question>` observation is an evaluator's unverified answer: a
  declaration that uses it (or `work:`/`evidence:`) in a predicate is held.
- control `{kind:'physical-scope', id, purposeId, lifetime:'development'|'operation', ref:{kind:'package', repo,
  package}|{kind:'service', host, name}, conditions}`: development is drawn to a condition's unit while its part is
  open (この差を埋める対象); operation is drawn to the `purpose-state-target` for as long as the condition is in the
  ideal, and to the open part too (この条件を保つもの), context `{condition, lifetime}`. Nothing points at GapA.

## Ledger (L1, apps#110): world events are appended, the World is derived

World events (decisions and observations, adrs#647 v9/v10) happen whether or not anything is drawn; their
source of truth is an append-only ledger (`atlas.ledger/1`, one header line then rows
`{seq, ledgerAt, recordedAt, actor, source, sha256, event}`, `event` = the G event as collected, `actor` =
its author or `atlas.G` for an observation). Each row has two times, like a book's entry date and event
date (v10): `ledgerAt`, when the row entered the ledger (`--ledger-at`, default now; monotonic, the only
time order checked), and the event's own time (`recordedAt` of a declaration, `observedAt` of an
observation), which may be in the past and is kept as is. `ledger.mjs` appends one collection; it never
rewrites a row:

- An **observation** is appended when its value or source changed, or as a **refresh** when half of the
  shortest `maxAge` declared on its target (any ideal state in the ledger) has passed since the last
  recorded observation of it. With collection at least every `maxAge/2`, the latest row is never stale
  while collection runs, and goes stale within `maxAge` once it stops. A target no condition watches is
  appended only when it changes. A refresh is no change of value.
- A **declaration** (purpose.set, ideal.drafting, ideal.set, plan.set, purpose.evaluated, purpose.ended) is
  appended only when its content changed for the same identity (a plan body's `updatedAt` alone is no
  change), whatever its own date: one dated before the ledger's last row is appended, not held.
- **Held, never appended** (to `<ledger>.held.jsonl` with a reason): damaged lines (invalid JSON, unknown
  kinds, G's own held lines, an event dated after its `ledgerAt`), exact duplicates of a row, and a
  collection whose `ledgerAt` goes back before the ledger's last row. A damaged ledger (seq, sha256 or
  `ledgerAt` order broken) is refused as a whole and nothing is appended.

`live.mjs --ledger=<ledger.jsonl>` derives the World from every row. Frames are cut by `ledgerAt` (what
was known then): a late, past-dated event shows from the frame where it entered and never rewrites an
earlier frame; a declaration's own time stays readable as `declaredAt` in the journal, an observation's
as `observedAt`. The same ledger always gives the same World.

### HQ refresh (P, `hq-refresh.ps1`): append → derive → publish

The ledger lives at `/tmp/p-hq/ledger.jsonl` on g6i3-own for now (GitHub in L2). P's declaration file is
read by G (list it under `declarations` in the collect config), so declarations enter the ledger too; do
not pass `--purpose` any more.

~~~sh
node packages/atlas/collect/fetch.mjs <collect.json> <snapshot-dir>                      # read the world
node packages/atlas/collect/collect.mjs <snapshot-dir> --out <g-events.jsonl>              # G events (this collection)
node packages/atlas/ledger.mjs --ledger=/tmp/p-hq/ledger.jsonl <g-events.jsonl>           # 1. append (exit 1: stop)
node packages/atlas/live.mjs --out-dir=<out> --ledger=/tmp/p-hq/ledger.jsonl --control=<control.jsonl>  # 2. derive
# 3. publish: copy <out>/world.json to the HQ input (e.g. /tmp/p-hq/in/world.json) by write-then-rename
~~~

If step 1 or 2 fails, do not publish: the previous `world.json` stays. The ledger only grows; to start
over, move it aside (never edit rows).

### A last line cut short (manual repair, never automatic)

An append that is interrupted (power, kill, full disk) can leave the ledger's last line incomplete. Then
`ledger.mjs` refuses the ledger: it stops with exit 1 and appends nothing more, and `live.mjs --ledger`
fails, so nothing is published and the previous `world.json` stays. Nothing repairs it automatically.
To repair by hand:

1. Stop the HQ refresh loop.
2. Confirm the damage: `node packages/atlas/ledger.mjs --ledger=/tmp/p-hq/ledger.jsonl --check` (exit 1 and
   the reason; `--check` only reads).
3. Keep the damaged file: `cp /tmp/p-hq/ledger.jsonl /tmp/p-hq/ledger.broken-<UTC time>.jsonl`.
4. Look at the end: `tail -c 400 /tmp/p-hq/ledger.jsonl`. Remove only an incomplete **last** line (no
   trailing newline, not valid JSON): `head -n -1 /tmp/p-hq/ledger.jsonl > /tmp/p-hq/ledger.fixed.jsonl`
   when the file ends without a newline, or truncate to the last `\n` otherwise. Never edit any other row.
5. Check the result: `node packages/atlas/ledger.mjs --ledger=/tmp/p-hq/ledger.fixed.jsonl --check` must
   print `PASS`; if the damage is not the last line only, stop and report it (do not rewrite rows).
6. Move it into place (`mv /tmp/p-hq/ledger.fixed.jsonl /tmp/p-hq/ledger.jsonl`) and restart the refresh:
   the next collection appends again what the lost row said (observations are re-observed, declarations
   re-read), dated by that collection's `ledgerAt`.

## World edge contracts (`contract.mjs`)

The model and contracts are adrs#647 (v3 is the newest section). `contract.mjs` is the
only module that knows the ui contracts; `derive.mjs` writes `contractWorld(result)`, so
`live.mjs` and the fixture CLI emit the same shape. Without `plans`/`gap`/`phase`/
`journal`/`matched_until` each frame is exactly D's World.

**Words.** The 理想状態 (ideal state) is the declared, versioned, freshness-bound,
observable approximation of the Purpose achieved; the Purpose itself is judged by
people (`purpose.evaluated`), never by observation. The 現在状態 is the observation at t.
A **Scope** is one open (unmet or unknown) condition and its owner; a satisfied
condition is no Scope (`equivalent` part) and appears only as gap history.

**Journal (D input).** Decisions, each with `recordedAt`, optional `actor` and
`source{ref, digest, commentId?}`: `purpose.set{purpose{id,label}, rev}`,
`ideal.drafting{purpose_id, version}`, `ideal.set{purpose_id, purpose_rev, version, label?,
requires[≥1]}`, `plan.set`, `purpose.evaluated{purpose_id, purpose_rev, ideal_version,
verdict: achieved|not-yet|ideal-insufficient, note?}`, `purpose.ended{purpose_id}`, plus
`observation`. Each decision must name the active Purpose (id and rev); ideal versions
are unique; the same id with a new label is a new rev, the same rev with another label
fails. A legacy `purpose.set` with `requires` is normalized to purpose.set (only when the
Purpose or its label changes; rev = the version that first declared that label) + ideal.set.

**`frames[i].phase`**: `purpose-changed` (no drafting or ideal.set since the active
purpose.set), `defining` (drafting only), `approximating` (ideal.set and ≥1 open part),
`matched` (ideal.set and no open part: every condition satisfied within its window), and
`ended` once `purpose.ended` is recorded (not in the v3 list: proposed). **`matched_until`**:
when matched, the earliest `observedAt + maxAge` (fresh while `t − observedAt ≦ maxAge`);
else null. **`frames[i].journal`** (v6): only what was newly recorded in that frame (after the previous
frame's t), in time order and not thinned; ui accumulates the frames (contract 3 puts observations in
the same book): decisions
`{kind, recordedAt, actor, source{ref, commentId, sha256}, …ids}` (an evaluation has `frame` and
`past`, true once the Purpose rev or the ideal version moved) and observations
`{kind:'observation', recordedAt, observedAt, actor:null, source{ref}, target, value}`. Each fact appears
once: an exactly repeated record is one row (rows differing in value or source stay); an observation marked `projection: true` (fromG's session view of a G `<target>:session`
fact) is not listed again.

**`frames[i].gap`** = `{basis:{purpose_id, purpose_rev, purpose_label, ideal_version, prev_frame},
parts:[{condition, label, state, cause{ideal, current}, since, scope|null, refs[], observed_before_ideal?}] | null,
closed:[{condition, at, by}], summary:{open, by_cause, conditions, satisfied, before_ideal}}`.
`before_ideal` (v5) counts satisfied conditions whose observation is older than the ideal.set (event times:
`observedAt` against the ideal state's own time, `declaredAt` when it entered the ledger later, else its
`recordedAt`; never its `ledgerAt`, which only cuts frames):
a match right after a Purpose change made only of earlier observations is shown, not hidden. With no ideal
state to compare (purpose-changed, defining, ended) `parts` and the counts are null
(UNKNOWN, never []), while `closed` still lists what closes. The cause (v6) compares with the
latest frame that has a gap (`prev_frame`), by id only, and has two sides, at most one each, so one
never hides the other. `ideal`: `initial` (no earlier frame with a gap), `purpose-changed` ((id, rev)
pair differs), `ideal-added`, `ideal-revised` (predicate or maxAge; labels/norms are not revisions),
or null. `current`: for an unknown condition always why — `current-stale`, `current-unmatchable`
(a value arrived but cannot be compared), `current-conflict`, `current-unobserved` (nothing arrived,
or D's `null`); for an unmet one only a change against the same, unrevised condition —
`current-regressed` (satisfied → unmet) or `current-confirmed-unmet` (unknown → unmet) — else null.
With no reason on either side the cause is `{ideal:null, current:'carried'}` (the same open difference
continues; ui refuses a cause that names no side). `summary.by_cause` counts both sides
and `carried`. `since` continues only while the difference stays open
without a break and unrevised; under a new rev of the same Purpose, what the new ideal
declares again continues. `closed.by`: `current-satisfied`, `ideal-removed`,
`purpose-changed`, `purpose-ended` (proposed with `ended`). `observed_before_ideal` marks a
judgment on an observation older than the ideal.set, by the same event-time rule (display only). `refs` are the
`repo#n` of recorded plans the condition declares; plans never enter the gap otherwise.
Each frame uses only itself and earlier frames; its Closure context holds only its own rows, so the
World grows linearly with frames and observations. `fixtures/journal/` (9 frames) runs one
cycle with an evaluation and an end.

**Scopes nesting (v7).** The Scopes area is nested with the existing containment shape
(`containment: 'from-contains-to'` from a `scope-group` entity to each member), decided only by
declarations: one frame per declared owner (`owner:<Norm W id>`, caption 担当 / id) holding that
owner's Scopes; `owner:none` (担当なし) holding unassigned and unresolved units; and `history`
(閉じた差（履歴）) holding the frozen old obligations, completed-history Scopes and the conditions the
current state meets now (`closed-change`, supplied by D as `frame.closed`, drawn without lines).
Each unit is in exactly one frame and empty frames are not emitted; every other entity and relation
is unchanged (crossings count drawn lines only, not containment).

`plansOf`: `frames[i].plans` is absent when the frame's ideal state declares no plan
(計画未宣言), `[]` when declared but none is recorded by then, else
`[{ref, plan, version, label, serves, nodes:[{id,label}]|null, edges:[{from,to,kind}]|null,
unknown, source:{repo, commentId, updatedAt, sha256}}]`. `nodes:null` means content
UNKNOWN, not empty. Plans are not facts: never used for Gap/Current/coverage/state,
and never attached to a frame whose `asOf` precedes their `recordedAt`.

~~~sh
node packages/atlas/collect/collect.mjs <snapshots> --out /tmp/g-events.jsonl
node packages/atlas/live.mjs --out-dir=/tmp/atlas-k --purpose=<purpose.set.jsonl> \
  [--control=<control.jsonl>] /tmp/g-events.jsonl   # → events.jsonl, world.json, plan-projection.json, g-plans.jsonl
~~~
