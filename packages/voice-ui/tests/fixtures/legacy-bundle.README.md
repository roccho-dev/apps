# Legacy bundle fixture scope

`legacy-bundle.v1.json` is the exact byte copy of
`2cc4890b765a5534e92855f83f9232ae85bb373b:packages/voice-ui/web/data/bundle.v1.json`.
SHA-256: `8fd1b4f37f6a113653dbaeda5e040ba5bed6d7b007ab9269d307f8642d339189`.
It contains the original eight-part schema-1 catalogue.

The existing frame/inventory unit cases and synthetic component/quota audit
factories describe that catalogue. The stopped reserve pool explicitly binds
its `canonical_bundle_sha256` to these bytes; replacing it with the moving
public default invalidates that historical comparison. The current producer
and audit modules still execute all their original positive and negative
assertions against this fixed input. The four separately pinned historical
audit modules and their source targets are unchanged.

This fixture does not establish acceptance of the current distribution. The
shipped `web/data/bundle.v1.json` remains schema 2. Current direct/typed unit
cases retain that input. `acceptance/candidate-browser.mjs` exercises the real
configured bundle URL in the completed artifact through Goal, Undo, Apply and
reload. It records actual HTTP bodies and negative boot controls for an unknown
schema and duplicate part key, followed by restoration of the current bundle.
`acceptance/current-bundle-consumer.mjs` independently reopens the distribution
manifest, those bodies and saved DecisionLogs using the packaged parser and
protocol. The release workflow requires that current-consumer audit separately
from the historical reserve test. Neither result substitutes for the other.

The intent, frontier and quota paired comparisons also keep their original
schema-1 inventory through the explicit `--historical-bundle` option. Without
that option their original current-versus-baseline byte equality is retained.
Historical mode requires the exact original hash, the exact pinned baseline
bytes, and equality of every current catalogue value apart from the declared
schema-2 migration. It changes the served comparison data at the ordinary URL;
it never overwrites the physical distribution. Receipts record both hashes and
the historical scope. The separate current-consumer gate remains required.
