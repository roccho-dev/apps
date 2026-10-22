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

Every GitHub id carries its owner (adrs#647 v9): targets `owner/repo#n:<fact>` and `owner/repo:archived`,
plan ids `owner/repo#n:<slug>`, plan node ids `owner/repo#n:<node>`, plan `source.repo` and journal
`source.ref` `owner/repo#n`. A fork and its upstream (`roccho-dev/Meltype#26`, `yksr-melt/Meltype#842`)
never share an id. Only `adapter.mjs` qualifies; a snapshot without a plain owner and repo name is
refused. Declarations naming the old owner-less ids no longer match (no fallback by name).

| target | value |
|---|---|
| `<owner>/<repo>#<n>:pr.state` | GraphQL `state` (`OPEN` / `CLOSED` / `MERGED`) |
| `<owner>/<repo>#<n>:pr.merged` | `"true"` / `"false"` |
| `<owner>/<repo>#<n>:pr.head` | head SHA |
| `<owner>/<repo>#<n>:ci.rollup` | GitHub's `statusCheckRollup.state` of the head commit; null or other commit → `UNKNOWN` |
| `<target>:session` | `running` / `transcript-only` / `not-found` / `UNKNOWN` |
| `<target>:port` | `responding` / `no-response` / `UNKNOWN` |
| `<owner>/<repo>#<n>:plan.source` | only when the Issue/comments fetch failed: `UNKNOWN` (not "no plan") |
| `<owner>/<repo>:archived` | `"true"` / `"false"`; a non-boolean or missing field, or a failed call → `UNKNOWN` |
| `<owner>/<repo>#<n>:issue.state` | `state`, plus `/<state_reason>` when GitHub gives one: `open`, `closed`, `closed/completed`, `closed/not_planned`, `open/reopened`; no string `state` → `UNKNOWN`; a PR (`pull_request` key) → `UNKNOWN`, reason in `source.ref` (list PRs in `pulls`: `pr.state`, `pr.merged`) |

`observedAt` is the snapshot's fetch time. `observedAt > recordedAt` is rejected (throws).

G emits fact targets only (`roccho-dev/windows:archived`, `roccho-dev/apps#92:pr.merged`). It never writes a meaning target
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
are read; a section runs to the next marker or the end of that text. Per `<owner>/<repo>#<n>:<slug>`
the highest `N` is current. Two different texts with the same highest `N` → nodes/edges/exits
`UNKNOWN`, `unknown:['conflicting-version']` (no winner).

```
{kind:'plan.set', plan:'roccho-dev/resources#25:windows-retirement-migration-20261016', version, recordedAt,
 source:{repo:'roccho-dev/resources#25', commentId|null, updatedAt, sha256},   // sha256 of the extracted section text
 nodes:[{id:'roccho-dev/resources#25:E', label, shape, groups, exit, predicate, owner, requires}] | 'UNKNOWN',
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
reason. The source is `{ref: owner/repo#n | hq:path, commentId, sha256 of the text}`. A plan.set
also carries its text's author as `actor` when the snapshot has it.

## Git Cold (C1)

G can read Git Cold rows (`adr_raw_event.v1`) of a **fixed** adrs commit instead of live gh responses, so
the reducer's input no longer needs a local ledger. The edge reads the file; the adapter only maps rows:

- config `cold: [{repo, checkout, commit, path}]` → `fetch.mjs` runs `git -C <checkout> show <commit>:<path>`
  and stores `{type:'cold', repo, commit, path, committedAt, sha256, text}` (the clone's place is not passed on).
- each valid row becomes one comment of the existing thread record (`subject_key` `owner/repo.issue.N`):
  `commentId` ← `payload.id` (null for the issue/PR body: a `html_url` without a fragment, as hot gives it),
  `author` ← `payload.author.login`, `text` ← `payload.body`, and the source `{ref: owner/repo#n, sha256: 'sha256:' +
  observed_version.content_sha256, capture: <repo>@<commit>:<path>}`. The existing journal and plan extraction read
  the bodies unchanged. `live.mjs` `joinLog` keeps hot ∖ cold: from the time cold has a document (`owner/repo#n` +
  commentId), a hot copy read then or later is dropped, or held as `superseded-by-cold` when it says something
  else. What hot read earlier stays as read (a past frame is never rewritten); when cold says the same, only an
  observation `confirmed:<owner/repo#n>:<commentId|body>` = `<repo>@<commit>:<path>` is added at cold's time.
- `status` is kept verbatim as the document's `admission`; capture never admits a meaning (adrs#607), and
  no event says admitted. A3 (adrs#647 comment 6265881722): the source also carries it (`source.admission`) through
  live and D to the World's journal entries (`frames[i].journal[].source.admission`) of journal decisions, for display
  only; no judgment reads it, a source without one has no such field, and plans do not carry it.
- `content_sha256` is checked in one form only, the writer's (adrs `tools/github_api.py`, a6284e58):
  plain hex of sha256 over Python `json.dumps(payload, ensure_ascii=False, sort_keys=True)` — separators
  `", "` / `": "`, keys sorted by code point at every level, non-ASCII raw, only `"`, `\` and C0 controls
  escaped (`\u00xx` lowercase) — and `raw_id` must end with its first 16 characters (`pyJsonDumps`,
  `coldDigest` in `adapter.mjs`; all 40 hashed rows of adrs 94a51c3a `hot-cold-observations-261008.jsonl` match).
- held with the reason (`journal.held`, `cold: …`): `schema` (not `adr_raw_event.v1`), `content-sha256-missing`
  (no payload or no `content_sha256`: revision, code_context and scope rows), `content-sha256-unverifiable`
  (a float, an integer beyond 2^53 or a lone surrogate: JSON.parse has lost what Python wrote),
  `content-sha256-mismatch`, `raw-id-mismatch`, `subject-id-author-or-body-missing`, `updated-at-missing`
  (no `updated_at` in payload or `observed_version`, e.g. the adrs#603 review rows; never dated by
  `created_at` or `submitted_at`). A held row stays out of the World; the rest of the collection goes on.
- `collect.mjs` without `--recorded-at` dates a cold collection by its commit (`committedAt`), so the same
  commit always gives the same events; `live.mjs <g-events.jsonl>` then builds `world.json` without `--ledger`.

## worklog (atlas-worklog-v1, minimal form)

`worklog.mjs` reads **one** ````jsonl` line per comment in a `<!-- worklog-v1 -->` section and maps it to an
observation on `work:<work_id>`, dated and authored by the captured document (the writer types neither):

| line | value |
|---|---|
| `{"kind":"work.created","work_id":…}` | `created` |
| `{"kind":"artifact.observed","work_id":…,"evidence":"owner/repo#n" or a 40-hex commit sha}` | `progressed` |
| `{"kind":"work.terminal","work_id":…,"terminal":"done"\|"blocked"\|"stopped"}` | `reported-done` / `reported-blocked` / `reported-stopped` |

Held (`journal.held`, `worklog: …`): `multiple-lines` (two or more lines in one comment: all of them),
`author-list-missing` (no `worklogAuthors` passed: fail closed), `author-not-allowed`, `invalid-json`, `kind`,
`fields` (any other field, e.g. `note`, `at`, `work_generation`), `work-id`, `evidence-form` (only `owner/repo#n`
or 40 lowercase hex), `terminal`. The allowed authors come from the declaration side:
`collect(records, recordedAt, { worklogAuthors })`, CLI `--worklog-author <login>` (repeatable); the adapter does
not know where the list lives. The evidence is not written into `source.ref`; the observation event has no field
for it yet (it stays in the comment, whose digest is `source.sha256`). A terminal is a report, never an achievement.
Worklog sections are not read as plans or journal decisions. The reducer, contract and ui are unchanged.

## P's records (p-record-v1)

`precord.mjs` reads P's file `hq:p-records.jsonl` (adrs#647 W c6346498633, R GO c6346515735): one JSON line per record,
written by P only, shipped whole to `<Hq>/decl/` by hq-refresh v3. `pRecords(text, recordedAt)` → `{records, held}`;
pure. `run.mjs --p-records=<path>` reads the file whole each run (no option: not read; a missing file: empty).
The step records each kept line once in the ledger as `p.record` (identity: its `id`; content: the record alone, so
the file's sha256 and line never make a change; P's `at` kept as declaredAt, the ledger's time cuts the frame); the
same id with other content later is held as `p-record-rewritten`. `p.record` rows pass by D (`joinLog`), and
`contract.mjs` puts each into the first frame at or after its ledgerAt as `frames[i].p_records` (only on frames that
have some, so a World without them is unchanged); one that enters when no frame does waits for the next frame.
The ui must read `p_records` (ui#387) before an apps version that writes it reaches the HQ (adrs#647 c6346827237).

- Common fields, all required: `schema` (`p-record-v1`), `id` (unique in the file), `kind`, `at` (ISO UTC), `series`
  (or null), `ref` (or null). Each kind adds its own closed set: `user.decision.requested`, `user.decision.recorded`,
  `p.position`, `review.pasted`, `user.criterion`, `loop.stopped`, `p.receipt`, `heartbeat`.
- Held (`journal.held`, `p-record: …`): `invalid-json`, `schema`, `kind`, `fields` (a missing or an extra field), `id`,
  `at` (not ISO UTC, or after this run's `recordedAt`: the copy's mtime is the copy's, so the run's time is the bound,
  as in the ledger), `value` (a field of the wrong type or value), `duplicate-id` (both lines; a rewrite is a new id's
  `p.position` correction).
- Every record is P's claim (`authority: false`): never an evaluation, a purpose or an ideal decision (C5, apps#151).
- `pRecordsInComments(documents, recordedAt)` holds the same form in a comment (`p-record-in-comment`): a comment's
  author cannot tell P from another agent.

## current (C2, removed)

The current files (`collect.mjs --current <author>=<path>`) are removed (adrs#647 v4 c6335921034, #13): the work log
is read only in the adrs#654 form, the worklog-v1 sections above. `collect.mjs --current` exits 2. Rows the ledger
already holds from current files (`current:<author>#L<n>`) stay as they were read; nothing new is added. Any
declaration with `requires` whose predicate targets `work:*` or `evidence:*` is still held before D in `live.mjs`
`joinLog` (`worklog-target-in-predicate`, adrs#654).

## Fixtures

`fixtures/snapshots/issue-roccho-dev-resources-25.json` and the two `pr-*.json` are real `gh api`
responses (fetched 2026-10-16T20:33:31Z with P's logged-in gh, recorded and replayed with the same
arguments as `fetch.mjs`). `sessions.json` and `ports.json` stay synthetic. Tests assert what the spec
gives for that real data (current v3 → all `UNKNOWN`; v1's 2-column table → exits `UNKNOWN`; v1/v2
flowcharts parsed). Rules the real data does not exercise (5-column exit table, flowchart syntax,
same-version conflict) are tested on minimal inputs named `synthetic minimal input`.
`fixtures/states/` (repo `archived` true / false / failed call; issue open / closed completed /
closed not_planned) is synthetic, with the field names and types of the real gh responses.
