# propagate — State

Last updated: 2026-08-14

> Navigation: "What's the current status?" → this file. "Why did we choose X?" →
> `docs/DECISIONS.md`. "How do I use it?" → `SKILL.md`. "Where do I start
> reading?" → `docs/README.md`.

## What this is

Doc/code drift detector. Declares edges in `.propagates.yml` sidecars.
Drift is derived from content on demand via `reconcile` (also driving
`check` at pre-push and the daily digest's DRIFT/INBOUND sections) against
the v2 event store — **not** discovered by a background watcher polling
mtimes; that mechanism (`watcher.mjs`, launchd `com.tathya.propagate.watcher`,
`StartInterval 60`) was **retired 2026-08-14** (see "Now" below and
`docs/DECISIONS.md`). A companion `com.tathya.propagate.digest` still runs a
daily summary (unaffected by the retirement).

Own git repo, remote `Rupali59/propagate-skill`.

## Now (in flight)

### 2026-08-14 — v1 watcher retired; doctor/digest report the v2 replacement's health

`watcher.mjs` is retired (docs/DECISIONS.md 2026-08-14): measured 4,420 runs,
4,384 no-ops (99.2% found nothing), and two incidents in one day traced to
its `state.json` mtime baseline. `reconcile` (on demand), `check` (pre-push),
and the digest's DRIFT/INBOUND sections (commit `45a5e63`) replace its
coverage — production holds 379 baselined events in the v2 event store, so
drift is genuinely derivable today.

Code/docs side of the retirement, this pass:
- `watcher.mjs` stays on disk (not deleted), gains a header recording the
  retirement, and its direct-invocation path now refuses (`node watcher.mjs`
  exits 1) unless `PROPAGATE_ALLOW_RETIRED_WATCHER=1` is explicitly set.
  Its exported functions are still imported directly by several tests —
  that import path is untouched.
- `cli.mjs doctor`'s launchd/heartbeat checks are now informational only
  (`·`, never `✗`) and explicitly labeled RETIRED; a new "v2 replacement"
  section asserts the event store is readable + non-empty and that
  `reconcile()` completes — these are the checks that can fail now.
- `digest.mjs`'s `broken` check no longer trips on heartbeat staleness;
  it trips on `reconcile()` failing to complete instead. The
  `watcher: alive (Ns)` summary line now reads `watcher: retired (v2
  reconcile ok|FAILED)`.
- `SKILL.md`, `docs/REFERENCE.md`, `docs/SYSTEMS.md`, `docs/ISSUES.md`
  (N8 moot — its only caller, `enumerateWorktrees`, lived in `watcher.mjs`;
  N23's impact moot — `watcher.log` is no longer a live incident-response
  source) updated in the same pass.
- 470/470 tests pass as of 2026-08-14 (was 465: -1 removed for
  now-intentionally-wrong behavior, +6 new — see `docs/DECISIONS.md`
  2026-08-14 for the exact breakdown).

**Explicitly NOT done here, and not claimed:** the actual
`launchctl bootout` unloading `com.tathya.propagate.watcher` from launchd.
That is a separate, later operational step (task constraint: no `launchctl`
commands run as part of this change). `docs/SYSTEMS.md`'s `propagate` row
marks `retirement_checklist_done` as `partial` for exactly this reason —
verify with `launchctl list | grep com.tathya.propagate.watcher` before
updating that to `done`. v1 ledger rows (152ish open across 7 workspaces +
cross-repo, measured 2026-08-14 as 149+3) are untouched and remain readable
via `status`/`drain` exactly as before — retiring the writer does not touch
the reader.

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
