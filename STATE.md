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

**Completed 2026-08-14:** the launchd unload itself — the job was booted out,
its plist deleted from `~/Library/LaunchAgents`, and a copy archived at
`docs/archive/com.tathya.propagate.watcher.plist.retired-2026-08-14` so the
retirement stays reversible. Verified afterwards: only the digest job remains
loaded, no watcher process running, all 379 v2 events intact.
`docs/SYSTEMS.md`'s `propagate` row is now `done`. v1 ledger rows remain readable
via `status`/`drain` exactly as before — retiring the writer does not touch
the reader.

> **Count correction, 2026-08-14.** This section previously said "152ish open … 149+3".
> That was true when written and false hours later: the drain the same day closed 125 code
> rows as `wontfix` and 17 verified, leaving **8 open** (4 workspace + 3 cross-repo + 1 in
> the branch-local worktree ledger B1 that `status --all` cannot see). Counts in a state
> file rot faster than anything else in it — prefer naming the command that produces the
> number over pasting the number.

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

⚠️ ~~`cli.mjs init` re-arms launchd as a side effect~~ — **RESOLVED 2026-08-13 (N14)**:
split into a separate `reload` command, and the watcher plist it regenerated no longer
exists. Kept struck through rather than deleted: this line is why `reload` exists.

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

## TODO — a separate, hub-level mechanism: decision → document conformance

**Not propagate's job. Do not build it into this skill.** Raised by Rupali
2026-08-14 while draining the v1 backlog; recorded here because this is where
the diagnosis lives, not because propagate should own it.

**The gap, stated precisely.** propagate fires on *file change*. A decision that
should have changed a document, but didn't, produces no signal at all — because
nothing changed. Silence means "nothing happened", when the truth is "something
should have happened and did not."

**The instance that proved it.** `docs/DECISIONS.md:1287` (2026-07-15) records
Vastu as **removed — a refusal, not paused**. Thirty days later
`docs/constitution/VIPIN.md` still carried a `Vastu site visit · ₹21,000` row,
still described the locked model as three tiers "plus Vastu", and still called it
"(paused)".

The important part, and the thing I got wrong on first reading: **the edge was
declared the whole time.** `Vipin Kaushik/docs/.propagates.yml:10-17` has
`constitution/VIPIN.md → ../VipinKaushik/lib/pricing.ts` as `kind: code`. It is
not a missing coupling. It never fired because VIPIN.md was never edited after
the decision — and it has no baseline (`NEVER_VERIFIED`), because the two files
never co-committed inside the walk, so bootstrap could not seed it either.

Note also what stayed green throughout: `PRICING-CONTENT.md → lib/pricing.ts`
was CLEAN in both directions, verified 2026-08-14 down to `₹5,100 · $60` /
`₹8,100 · $95`. Every declared edge was consistent. The drift was one level up,
in the document all of them defer to, against a decision none of them watch.

**Why it must be hub-level and separate.** The subject is not a file pair inside
one workspace — it is `DECISIONS.md` (any repo) versus the documents that decision
governs (often another repo). It needs the decision log as its input, which is
precisely the thing every sidecar in this tree **deliberately excludes**: see
`Vipin Kaushik/.propagates.yml`'s header ("DECISIONS.md: deliberately NOT
declared — appends 3-5/week; declaring would flood the ledger with noise") and
`docs/.propagates.yml`'s equivalent. Wiring decisions into propagate was already
considered and rejected for good reason. A mechanism that reasons about
*semantic* conformance — "does this decision still hold in the documents it
binds?" — is a different tool with a different failure mode, and it will need
human or model judgment where propagate deliberately uses only content hashes.

**What it must not do**, learned the expensive way in this skill:
- Never let absence read as health (G2). "No conflict found" and "not checked"
  must be different outputs.
- Never ship a check that cannot fail (G1). If it cannot name the input that
  makes it fire, it is decoration.
- Never auto-edit a governed document. Propose; a human decides (this skill's
  hard non-goal, and it should be that one's too).

**Open scope questions** — unanswered, do not assume: which decision logs are in
scope (workspace, project, or both); whether it runs on decision-append or on a
schedule; whether it reports per-decision or per-document; and whether it lives
as its own skill or as a mode of an existing one.

**Related:** the immediate Vastu correction in `VIPIN.md` is separate, live work
and is Rupali's call — it touches the pricing table, the 2026-06-02
reconciliation note, and the pending-asks row.
