# propagate — State

Last updated: 2026-08-13

> Navigation: "What's the current status?" → this file. "Why did we choose X?" →
> `docs/DECISIONS.md`. "How do I use it?" → `SKILL.md`. "Where do I start
> reading?" → `docs/README.md`.

## What this is

Doc/code drift watcher. Declares edges in `.propagates.yml` sidecars, detects
source-file mtime changes, and appends drift rows to a per-workspace append-only
JSONL ledger. Runs as launchd `com.tathya.propagate.watcher` on `StartInterval
60`; a companion `com.tathya.propagate.digest` runs a daily summary (see below).

Own git repo, remote `Rupali59/propagate-skill`.

## Now (in flight)

### 2026-08-10 — Part A COMPLETE: discovery partition fixed, 2 → 7 workspaces

`workspace: true` now marks a ledger boundary explicitly; discovery always
descends. All 7 ledger-owning dirs are discovered. **116/116 tests pass, as of 2026-08-10** (was 80; discovery had *zero*
coverage before) — the full suite has grown well past that since; run `npm
test` for the current count. `doctor: all green`.

Verified end-to-end: after promotion the watcher fired and wrote two
`code_drift` rows for `SSJK-mb/.env.example` and `server/config/index.js` into
**SSJK-mb's own ledger** with workspace-relative `source` — rows that would
previously have been misfiled into the hub. Zero overlap with open hub rows, so
this is correct new routing, not the duplicate class. Open rows 93 → 95 for that
reason; 93 was only ever an at-the-instant-of-promotion figure, never a
steady-state invariant.

New doctor checks, all passing: `plistMatchesWorkspaces`,
`duplicateOpenAcrossLedgers`, `malformedLedgerLines`,
`unreachableWorkspaceMarkers`, `suspiciousMarkers`.

`status --all --json` now exists — the first machine-readable output in the
project. Its `watcher` block derives state **only** from the heartbeat file and
its `quietDays` **only** from ledger content, in separate objects, so the two can
never be conflated again. Live proof: watcher `alive` at 36s while ManavDaehi
reports `quietDays: 12` with 0 open — a healthy watcher on a quiet project.

**Remaining as of 2026-08-10:** the daily digest (Part B2) and the Systems
Ledger seed records.

### 2026-08-13 — Part B has landed

Verified directly, not assumed: `~/Library/LaunchAgents/com.tathya.propagate.digest.plist`
exists (mtime 2026-08-11) and `launchctl list` shows it registered (loaded,
last exit `0`, not currently running — expected for a `StartCalendarInterval`
job between fires). `~/.claude/DAILY.md` carries a real entry timestamped
`2026-08-13T03:57:19Z` with live BROKEN/NEW DRIFT/CLOSED sections, and
`~/.claude/propagate-digest-state.json` shows a matching `lastRunAt`. The
Systems Ledger itself (`docs/SYSTEMS.md`) is populated and has been since
2026-08-10. So: **digest build + Systems Ledger seed are both done.** What is
*not* yet true, and shouldn't be claimed: `docs/SYSTEMS.md`'s
`propagate-digest` row still carries a blank `adoption_date` by design — that
field only fills after two weeks of demonstrated engagement, which as of this
date has not been observed or measured. Landed ≠ adopted; see that row for the
distinction.

### Historical — the bug this fixed

`discoverWorkspacesSync` stops recursing once it finds a `.propagates.yml`. The
hub `~/Documents/GitHub` has one at its root, so the walk halts there and
swallows everything beneath. **`WORKSPACES` resolves to 2 entries — the hub and
`Keerti/Keerti-portfolio`** — the latter only because `SEARCH_ROOTS` hand-promotes
it, with a comment saying the hub marker "otherwise swallows everything." The bug
was known and worked around once, per-repo.

Five ledgers are orphaned; **93 open rows total, 71 piled into the hub ledger**
with foreign `source` values like `PanditPawanKaushik/SSJK-mb/CLAUDE.md`.

| Ledger | rows | open | discovered? |
|---|---|---|---|
| hub `.propagation/ledger.jsonl` | 146 | 71 | ✅ |
| `Vipin Kaushik/docs/` | 327 | 16 | ❌ orphan |
| `PanditPawanKaushik/docs/` | 70 | 0 | ❌ orphan |
| `PanditPawanKaushik/SSJK-mb/docs/` | 4 | 3 | ❌ orphan |
| `ManavDaehi/docs/` | 1 | 0 | ❌ orphan |
| `ManavDaehi/Manav-portfolio/docs/` | 5 | 0 | ❌ orphan |
| `Keerti/Keerti-portfolio/docs/` | 9 | 3 | ✅ |
| cross-ledger | 5 | 0 | (separate) |

**Watcher status: RUNNING.** It was booted out for the duration of Part A —
it executes the working tree every 60s, not commits, and a mid-edit state
creates stray ledger files. It came back up partway through (an agent ran
`cli.mjs init`, which internally calls `regeneratePlist` + `reloadLaunchd`).
No damage: all 7 ledger paths already existed, so the unconditional
mkdir+appendFile at watcher.mjs:553-558 was a no-op everywhere. Side effect:
the plist's `WatchPaths` — which had drifted to list neither current workspace
root — was regenerated and now matches all 7.

⚠️ `cli.mjs init` re-arms launchd as a side effect. That is surprising and
should be split into a separate `reload` mode.

### Known hazards while editing (verified, do not rediscover)

- Naive "recurse past the marker" is **worse**: 19 markers exist, only 8 dirs own
  a ledger. `Vipin Kaushik/docs/.propagates.yml` exists with no `docs/docs`, so
  recursion mints a new empty ledger beside the real 327-row one.
- `propagates.schema.json` is `additionalProperties: false`. A marker gaining
  `workspace: true` before the schema declares it is **rejected silently** — the
  watcher logs, updates the mtime anyway, and every edge in that sidecar stops
  firing. Schema first, always.
- A throw at `config.mjs` module load bricks watcher, CLI and UI simultaneously.
  Discovery must never throw.
- **Zero existing tests exercise discovery.** 80/80 green proves nothing here.

## Active initiatives

- **Part A** — COMPLETE (2026-08-10). Split "edge declarations" from "ledger
  boundary" via an explicit `workspace: true` field. 2 → 7 workspaces.
- **Part B** — COMPLETE as of 2026-08-13. `status --all --json`, the daily
  digest (`com.tathya.propagate.digest`), and the Systems Ledger seed
  (`docs/SYSTEMS.md`) are all built and verifiably running. A web UI was
  designed and then **cut**; see `docs/DECISIONS.md` 2026-08-10. Adoption of
  the digest — as opposed to it running — is a separate, still-open question;
  see `docs/SYSTEMS.md`'s `propagate-digest` row.
- **Deferred** — migrating the 69 misfiled hub rows. Close-and-re-emit only,
  never rewrite.
