# Atlas G — read-only collection

G collects; it does not judge. Output is JSONL of two event kinds, `observation` and
`plan.set`. Satisfied / unmet is decided by D, not here. Anything a snapshot does not
literally carry is the string `UNKNOWN`; nothing is inferred and nothing is typed by hand.

```
fetch.mjs (gh api / ssh / tcp, read-only)  →  snapshots/*.json  →  adapter.mjs  →  collect.mjs (pure)  →  events.jsonl
```

| File | Role |
|---|---|
| `fetch.mjs` | Acquisition only. Runs `gh api` (existing login), the existing `ssh`, TCP probes; stores the raw responses / stdout. |
| `adapter.mjs` | The only place that knows data formats: gh JSON paths, `--slurp` pages, process/file listing lines. Snapshot → normalized record (`thread`, `pr`, `sessions`, `ports`, `fact`); missing → null. |
| `collect.mjs` | `collect(records, recordedAt)` → events. CLI reads a snapshot dir through the adapter. No network. |
| `plan.mjs` | Marker sections in text → `plan.set` (mermaid flowchart + exit table). |
| `journal.mjs` | ```` ```jsonl ```` in marker sections and declaration files → journal decisions (actor = author). |
| `observe.mjs` | Normalized PR / session / port values and facts (`{target, value}`) → `observation`. |

## Run on G6I3 (P)

PowerShell, from the apps checkout, with gh already authenticated and `ssh g6i3-own` working:

```powershell
Copy-Item packages/atlas/collect/collect.config.example.json $env:TEMP/atlas-collect.json
# edit $env:TEMP/atlas-collect.json: fill the declared session ids (and ports) — this is the only declaration
node packages/atlas/collect/fetch.mjs $env:TEMP/atlas-collect.json .artifacts/g-snapshots
node packages/atlas/collect/collect.mjs .artifacts/g-snapshots --out .artifacts/g-events.jsonl
```

`fetch.mjs` calls, per entry (all GET / read-only GraphQL):

- `gh api repos/<owner>/<repo>/issues/<n>` — body and `updated_at` (Issues and PRs)
- `gh api --paginate --slurp repos/<owner>/<repo>/issues/<n>/comments?per_page=100`
- PRs only: `gh api graphql` → `state merged mergedAt headRefOid commits(last:1){oid statusCheckRollup{state}}`
- `repos: [owner/repo]`: `gh api repos/<owner>/<repo>` — `archived`
- `issueStates: [owner/repo#n]`: `gh api repos/<owner>/<repo>/issues/<n>` — `state`, `state_reason`
- sessions: `ssh g6i3-own 'ps -eo pid=,args='` and `ssh g6i3-own 'find ~/.claude/projects -name "*.jsonl"'`
  (override with `sessions.processCommand` / `sessions.filesCommand` in the config)
- a host without `ps` (e.g. g6i3-own): read `/proc` instead; the output keeps the `<pid> <command line>` form

  ```json
  "processCommand": "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); [ -n \"$c\" ] && printf '%s %s\\n' \"${p#/proc/}\" \"$c\"; done"
  ```
- ports: a TCP connect to each declared `host:port` (2 s timeout)

gh responses are stored as returned (`data`) and session listings as raw stdout; a failed call is
stored as null, which the transform turns into `UNKNOWN`. Snapshots from before the adapter
(sessions stored as parsed arrays) read as `UNKNOWN`; rerun `fetch.mjs`.
`--recorded-at <ISO>` pins `recordedAt` (default: now).

## observation

`{kind:'observation', target, value, source:{ref, sha256}, observedAt, recordedAt}`

| target | value |
|---|---|
| `<repo>#<n>:pr.state` | GraphQL `state` (`OPEN` / `CLOSED` / `MERGED`) |
| `<repo>#<n>:pr.merged` | `"true"` / `"false"` |
| `<repo>#<n>:pr.head` | head SHA |
| `<repo>#<n>:ci.rollup` | GitHub's `statusCheckRollup.state` of the head commit; null or other commit → `UNKNOWN` |
| `<target>:session` | `running` / `transcript-only` / `not-found` / `UNKNOWN` |
| `<target>:port` | `responding` / `no-response` / `UNKNOWN` |
| `<repo>#<n>:plan.source` | only when the Issue/comments fetch failed: `UNKNOWN` (not "no plan") |
| `<repo>:archived` | `"true"` / `"false"`; a non-boolean or missing field, or a failed call → `UNKNOWN` |
| `<repo>#<n>:issue.state` | `state`, plus `/<state_reason>` when GitHub gives one: `open`, `closed`, `closed/completed`, `closed/not_planned`, `open/reopened`; no string `state` → `UNKNOWN` |

`observedAt` is the snapshot's fetch time. `observedAt > recordedAt` is rejected (throws).

G emits fact targets only (`windows:archived`, `ops#479:issue.state`). It never writes a meaning target
such as `input:semcmp-adopted`; which fact satisfies a condition is P's declared predicate. Keeping
`state_reason` inside the `issue.state` value lets one `equals "closed/completed"` predicate exclude
a reason-less or `not_planned` close, and keeps an open issue's null reason from becoming `UNKNOWN`.

### Session rule

Only the declared `sessionId` per target and the two captured lists are evidence:

1. a process command line contains the session id → `running`
2. else a session file path contains the session id → `transcript-only` (a past transcript exists; not activity)
3. else, both lists captured → `not-found`
4. a list needed for the step above was not captured, or no id declared → `UNKNOWN`

Target names, process names and file names are never matched against the target.

## plan.set

Only sections that start at a marker `<!-- <slug>-v<N> -->` in an Issue/PR body or comment
are read; a section runs to the next marker or the end of that text. Per `<repo>#<n>:<slug>`
the highest `N` is current. Two different texts with the same highest `N` → nodes/edges/exits
`UNKNOWN`, `unknown:['conflicting-version']` (no winner).

```
{kind:'plan.set', plan:'resources#25:windows-retirement-migration-20261016', version, recordedAt,
 source:{repo:'resources#25', commentId|null, updatedAt, sha256},   // sha256 of the extracted section text
 nodes:[{id:'resources#25:E', label, shape, groups, exit, predicate, owner, requires}] | 'UNKNOWN',
 edges:[{from, to, kind, condition, style}] | 'UNKNOWN',
 exits:[{node, exit, predicate, owner, requires}] | 'UNKNOWN',
 unknown:[...reasons], unparsed?:[lines]}
```

- **Flowchart**: one ```` ```mermaid ```` block with `flowchart`/`graph`. Nodes keep id, label, shape
  (`{}` → `decision`). Links `-->`, `---`, `-.->`, `==>`, `-->|cond|`, `-- text -->`, chains,
  `A & B --> C & D` (cross product), and a subgraph id as an endpoint (expanded to its members).
  Lines that do not parse are kept in `unparsed`, never guessed.
- **Edge kind**: only a label `dep`, `loop`, `branch` or `<kind>: <condition>` declares it.
  Otherwise `UNKNOWN` — arrow style, self-loops and decision nodes are not declarations.
- **Exit table**: only a table whose header is exactly
  `| ノード | 出口条件 | 観測述語 | 担当根拠 | 寄与 requires |`. Empty cells, nodes without a row and
  duplicated rows are `UNKNOWN`. A version without the table (diff-only) has `exits:'UNKNOWN'` and
  every node's exit/predicate/owner/requires `UNKNOWN`; earlier versions are not merged in.
- `updated_at > recordedAt` is rejected (throws). No marker → no `plan.set` (e.g. adrs#628, apps#92).

Known limitation: for a body, `source.updatedAt` is the whole Issue/PR `updated_at`, which also moves when a comment is added.

## journal

Decisions (adrs#647 contract 3) are read, never typed in by G: ````jsonl` blocks inside marker
sections of Issue/PR texts, and P's declaration files (`declarations: [path]` in the config;
`fetch.mjs` stores the text and its sha256). Kinds: `purpose.set`, `ideal.drafting`,
`ideal.set`, `purpose.evaluated`, `purpose.ended`. The actor is the gh author of that text
(P for a declaration file); a line naming another actor, without an author, with a
`recordedAt` after its text, of another kind or not JSON becomes `journal.held` with the
reason. The source is `{ref: repo#n | hq:path, commentId, sha256 of the text}`. A plan.set
also carries its text's author as `actor` when the snapshot has it.

## Fixtures

`fixtures/snapshots/issue-roccho-dev-resources-25.json` and the two `pr-*.json` are real `gh api`
responses (fetched 2026-10-16T20:33:31Z with P's logged-in gh, recorded and replayed with the same
arguments as `fetch.mjs`). `sessions.json` and `ports.json` stay synthetic. Tests assert what the spec
gives for that real data (current v3 → all `UNKNOWN`; v1's 2-column table → exits `UNKNOWN`; v1/v2
flowcharts parsed). Rules the real data does not exercise (5-column exit table, flowchart syntax,
same-version conflict) are tested on minimal inputs named `synthetic minimal input`.
`fixtures/states/` (repo `archived` true / false / failed call; issue open / closed completed /
closed not_planned) is synthetic, with the field names and types of the real gh responses.
