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
  empty while the Purpose is not declared satisfied. Each frame's
  `coverage.unknown` counts only unassigned units, unresolved/unknown/conflict
  units and Scopes whose own status is unknown or conflict or whose standing is
  unresolved. A known, owned, unmet Scope is in the current Gap but is a known
  missing change, not an unknown. Old obligations stay here as history.
- **Agents**: only declared ids (Scope `owner_actor`, observation `writer` and
  `evaluator`) with their declared roles, flagged synthetic, declared-only and
  activity-unobserved. `owner_role` is an attribute of the 担当 relation. With no
  declaration an explicit missing marker is shown. Unassigned units have no Agent.

Overview captions are presentation only: at most two short lines (for example
目的/目標/現状, a Scope label and its status, 未割当 and the id tail, an Agent id
and its declared roles). Every supplied label, id, revision and status stays
verbatim in the record summary, flags and relation context. Relation ids are
namespaced by unit kind (`change:scope:`, `change:unassigned:`,
`change:unresolved:`), so a Scope id equal to another unit id cannot collide.
The overview orders Purpose, Target, Current; old obligations before the current
units; owner Agents first. The observation `writer`/`evaluator` role relations
always cross the Scopes pane, so only those two relations carry `visible:false`
(their declared contexts are unchanged): the UI reports them as omitted
relations, and their records stay in the World,
catalog, search and detail, with the roles on the Agent caption and summary.
Owner (担当) and Current/Scope/Target/Purpose relations stay drawn.

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
