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
can be reduced again, including with further complete source projections. Partial
fragments may be supplied together; a still-incomplete join fails rather than
inventing missing ancestors. Inputs are projections, **not a history ledger**:
conflicting versions must be reconciled by their owner before this join. There is
no timestamp winner, implicit source precedence or business-approval mechanism.

## Record contract

Every record has `kind`, a global `id`, `label`, and nonempty `sources`.
Each source is `{sourceRef, sourceDigest}`: a revision-qualified locator and
`sha256:<64 lowercase hex digits>`. These declarations are preserved and checked
for shape/consistency, **not authenticated against an external authority**.

| Kind | Additional required fields | Explicit relation |
|---|---|---|
| `purpose` | `parents` | Zero or more upstream purposes; an empty list is a highest purpose |
| `ideal` | `purposes`, `value` | Desired condition contributing to one or more purposes |
| `current` | `value` | Observed/declared current condition, linked through a Gap |
| `gap` | `current`, `ideal`, `delta`, `owner`, `proof` | Current → Gap → Ideal → Purpose |
| `fill` | `gaps`, `scope` | Work addressing one or more Gaps; scope lists work boundaries |
| `receipt` | `fill`, `status`, `evidence` | Effective outcome of that version of Fill |
| `residual` | `receipt`, `next` | What remains; next Current/Gap references can branch |

All scalar fields are nonempty text, except the fixed header boolean. Reference
and scope/evidence arrays are unordered sets. `parents` and `next` may be empty;
other arrays must be nonempty. Unknown fields/kinds/schemas, duplicate JSON keys,
duplicate set members and missing/wrong-kind references fail closed. Identical
records are deduplicated and their provenance is unioned. Same id with different
meaning, or same source locator with different digests, is a conflict.

A Gap's `delta` is **declared by its source**, not inferred from descriptions or
from work counts. A Current must have a route through a Gap to an Ideal/Purpose.
A Gap may have no Fill yet; a Fill may have no Receipt yet. Those are pending,
not malformed or complete. Multiple highest purposes and shared branches are
allowed; both purpose ancestry and causal work/continuation flow must be acyclic.

Receipt status is `closed`, `reduced` or `failed`. This v1 snapshot carries one
effective Receipt per Fill version, with potentially several evidence references.
Retries/history need distinct versioned Fill ids or upstream reconciliation.
`closed` cannot have linked Residuals; `reduced` must retain at least one. An empty
Residual `next` means a still-unassigned next step, **not completion**. Recursion
uses new Current/Gap ids; pointing back into the same causal cycle is rejected.
Neither a closed Receipt nor the absence of Residuals produces a Purpose verdict.
Typed reference fields are the relations; a second editable edge table is not added.

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
