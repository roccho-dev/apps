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
