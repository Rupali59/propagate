# propagate — State

Last updated: 2026-08-20

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

## Linked plans

- [`docs/plans/2026-08-19-portability-and-rules.md`](docs/plans/2026-08-19-portability-and-rules.md)
  — **ACTIVE.** Make the skill installable on any machine against any repo set, absorb the
  global-rules lifecycle, and conform to `superpowers:writing-skills`. Phases 0-1, 3-4 done;
  2 (de-personalise literals), 5 (rules lifecycle) and 6 (skill-creation conformance) pending.
  Installing is now two commands — `npm install` then `propagate setup`, which refuses to
  report success unless discovery finds a workspace (`docs/REFERENCE.md` § Install).

Plans live in `docs/plans/`, not `~/.claude/plans/` — session scratch rots, and `lib/graph.mjs`
carried a citation to an overwritten one for weeks.

### 2026-08-20 — Lane C (release mechanics) landed: `docs/RELEASE.md` + `release --check`

Per `~/.claude/plans/status-temporal-plum.md` §3 (release mechanics, defined not run) and
§4 (the two-repo coupling, named and deferred). Landed alongside Lanes A (decompose) and B
(watchlist) from the same plan.

- **`docs/RELEASE.md`** — the five-step procedure. Steps 1-4 are `release --check`; step 5
  ("a human publishes") has no flag, deliberately — git history is permanent and this
  skill's premise is "it reports, a human acts."
- **`node cli.mjs release --check [--json]`** — thin dispatch arm in `cli.mjs` (D7 pattern);
  the four gates live in `lib/core/release.mjs`, tested directly in
  `tests/cli/release.test.mjs` (RED-first, each success case paired with a
  negative control; `node --test tests/cli/release.test.mjs` derives the count). Every gate reports `passed` / `failed` / `could-not-run` — never lets
  an unanswered gate read as a pass (`rule:discernment-checks` §2).
- **A real bug caught by running the gate for real, not just its tests**: gate 2's summary
  regex was written against TAP's `# pass N` and this machine's `npm test` actually emits
  the "spec" reporter's `ℹ pass N`. The very first live run of `release --check` therefore
  misreported a clean 763/0 suite as `could-not-run`. Fixed to accept both glyphs, with a
  regression test locking in the `ℹ` form specifically (`docs/GOTCHAS.md`-worthy: a check
  whose fixture format doesn't match the real tool's output looks green and proves nothing).
- **Live run on this machine, 2026-08-20:** `version-manifests` passed (all four agree at
  `0.1.0`); `suite` passed (763/0); `make-public-check` **could-not-run** — no identity map
  at `~/.propagate/identity-map.json` on this machine, the same state CI is in by design;
  `stranger-install` **failed** — a synthetic fresh workspace's `doctor` does not reach
  clean after `setup` → `bootstrap --apply`, because nothing in the current install path
  ever creates the per-workspace ledger JSONL/MD files for a workspace with no prior v1
  rows (`init` scaffolds the sidecar, not the ledger; `bootstrap --apply` writes to the v2
  event store, not the v1 ledger). Real, pre-existing gap, out of this lane's scope — filed
  nowhere yet; the honest thing to do until it's triaged is let the gate report FAILED
  rather than force a pass.
- **`docs/ISSUES.md` N38** — the private→public coupling has no propagate edge yet
  (`cross-allow.yml`'s `partner_roots` is `[]`; the public repo doesn't exist). Recorded
  honestly as an open procedure, not a watched coupling — do not read `make-public --check`
  passing as more than "clean this run."

## Now (in flight)

### 2026-08-21 — N39's fix attempted, blocked, and the blocker is bigger than the fix

Trying to finish propagate's partial baseline surfaced **N40**: `edgeId` hashes the
**absolute** downstream path, and `nodeId` uses the *traversed* repo basename — so one repo
reached by three routes yields three disjoint edge sets. Matching the directory basename is
not enough; the absolute path is hashed too.

`bootstrap`'s only scoping mechanism is `PROPAGATE_SEARCH_ROOTS`, so **scoping a run changes
what the edges are**. The scoped dry run reported `17 NEVER_VERIFIED · 8 baselineable` with
full confidence; applying it would have written 8 baselines against duplicate edges and
silently doubled propagate's edge set. Caught by diffing edge ids against a pre-change
snapshot — no check would have caught it. `docs/GOTCHAS.md` **G55**.

`workspace: true` was added to propagate's sidecar and **reverted**: edge ids were proven
identical across the change (all 17), but it left `doctor` red for want of a ledger and did
not unblock scoping.

**What did get fixed:** both REVERSED edges, which turned out to be real drift caused in
this session — `docs/GOTCHAS.md` grew from G51 to G55 and two declared downstreams noticed.
`docs/AUDIT-2026-08.md` gained a dated 2026-08-21 addendum dispositioning G48–G55 (its
2026-08-17 tables deliberately untouched — a point-in-time audit that gets rewritten stops
being evidence), closed `both-reconciled`; the metrics edge closed `no-change-needed`.
propagate's own edges are now **8 CLEAN, 9 NEVER_VERIFIED, 0 REVERSED**.

**The addendum's own finding:** G48–G51 carry no `**Trigger:**`; G52–G55 all do. Entries
written once the trigger became part of authoring an entry are delivered; those written
before it are not. G48 (an enforcement point that does not watch itself) has now fired four
times and is the corpus's strongest PROMOTE-to-a-rule candidate.


### 2026-08-20 — Phase 2 wedge landed: a reconciliation now says when, on what ref, by whom

Answers the question that prompted it — *at what status/decision point was a branch's record
last reconciled?* — which was previously **unanswerable**: `observed_on_ref` was the literal
`"working-tree"` on all 1347 events, no field held a commit, `by` had one distinct value, and
`reconcile()` persisted nothing about a run.

- **Step 0 · the reviewed design was rescued.** `/plan-eng-review`'s output — decisions
  **D3–D9** — existed only in a session transcript after its plan file was overwritten. Now
  `docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md`, with the design's `--all-refs`
  cost estimate corrected (it was wrong by ~100x: `git ls-tree -r` returns a blob SHA per
  file in one spawn, and a blob SHA *is* the content identity).
- **W1 · `observed_on_ref` is honest (D3).** `lib/edges/provenance.mjs` centralizes the rule
  across the three call sites that each carried `row.source.ref || "working-tree"`: a
  resolved ref, a genuine working-tree read, and a **failed lookup** are now three different
  answers. New additive event fields `observed_at_commit`, `observed_on_branch`,
  `observed_dirty`, `by_kind`. `observed_dirty` is load-bearing — a dirty tree means the
  content hashed was never at that commit.
- **W2 · the graph index's event join was silently broken.** `graph-index.mjs` mapped
  `event_id: e.id ?? null` against a field written as `event_id`, so every indexed event had
  a NULL id and `v_edge_history` could not cite a specific event. Verified on a copy of the
  real store: now **0 null ids**. Previously-dropped `by` / `observed_on_ref` /
  `source_content` / `downstream_content` are carried through, plus SQL-NULL-safe columns
  for W1's fields.
- **W3 · run records and `propagate why`.** `lib/core/runs.mjs` appends one record per
  reconcile — **from the caller**, because `reconcile()`'s read-only contract is what makes
  derived state safe across merges. `propagate why <edge>` renders the disposition-change
  chain (`--all` for everything), distinguishing `unknown-edge` / `no-events` / `found`, and
  renders *"position not recorded"* for pre-W1 events rather than guessing.

**The acceptance test failed honestly, and that is the finding.** `why` **cannot** answer the
branch question it was built for: `PanditPawanKaushik`'s `worktree-client-answers-propagation`
carries 40 v1 ledger rows with 1 open, and v1 rows have **no `edge_id` at all** while `why`
reads the v2 event store. Two independent gaps — a schema mismatch and `why`'s lack of
ref-awareness (D9, deferred). No bridge was fabricated to make the item pass.

**Two GOTCHAS learned the hard way, both new.** **G53** fired twice: a timing test asserted a
proxy for its claim (*"doctor finished under 4s"* for *"the 2s bound held"*; *"under 3s"* for
*"the cache was used"*), and both proxies flipped when doctor grew by ~0.26s. Both now assert
the claim itself — the stub records its invocations, so one call across two runs **is** the
cache working. **G54**, and its own first version was wrong: a lane's unscoped
`bootstrap --apply` appended 7 events to the live store, and the advice to "export the safety
vars once per session" does not work here because shell state does not persist between tool
calls.

**Live store: 1354 events** (1347 + the 7 from N39, kept deliberately — evidence-backed,
closed nothing). Suite green, `doctor` 0, `rules check` 0; derive counts with `npm test`.

**Open:** propagate's own repo is **partially** baselined — 7 edges by accident, the rest not.
That is worse than either extreme. See `docs/ISSUES.md` N39.


### 2026-08-20 — Phase 1 landed: this machine is now a clean reference install

`release --check` reports **READY**, all four gates green. It reported
`✗ stranger-install` and `· make-public-check (could-not-run)` before this phase. Derive
the current numbers with `node cli.mjs release --check`; do not restate them here.

Four lanes, plus the identity map. Each lane's load-bearing claims were re-measured on the
parent before acceptance (`rule:delegation-criteria` §4), which caught two wrong ones.

- **P1 · gate-4 ledger creation.** `doctor` never reached clean on a fresh workspace:
  `init`/`setup` scaffold the sidecar, `bootstrap --apply` writes only the v2 event store,
  and nothing created the v1 ledger pair. Fixed in `lib/core/discovery.mjs`'s
  `makeWorkspaceRecord`, gated to the `setup`/`init`/`bootstrap` verbs via
  `ledgerScaffoldingAllowed()` — an unconditional first version wrote untracked ledger
  files as a side effect of a plain read-only `check --changed`, caught by the G43 test.
  `.github/workflows/test.yml` lost its `|| true`. Live-tree rows unchanged: 746 distinct,
  0 open.
- **P2 · state migration.** `LEGACY_STATE.live` now covers `events/` (directory-aware),
  `graph-index.db`, `graph-index.cypher`, `notified.jsonl` — discharging G12 for the
  artifact whose loss is unrecoverable. `archiveEventBackups()` moves stray
  `*.jsonl.pre-truncate-*` out of the state-dir root. **Incident:** `cross-allow.yml` was
  added to `live` per the original brief and, run for real, deleted the repo's shipped
  fallback twice. New `LEGACY_STATE.seedOnly` (copy-if-absent, source never touched) is the
  fix; `docs/GOTCHAS.md` **G52** is the hazard.
- **P3 · hooks + plists.** The 5 pre-commit hooks under the astro-platform workspace no
  longer fail open — a missing `cli.mjs` prints one line instead of skipping silently
  (G48 shape); `PROPAGATE_CLI` overrides, `PROPAGATE_SKIP=1` still bypasses. All three
  plists now generate via `resolveStableNodeBin()`, so they stop baking in a Homebrew
  Cellar version — the installed monitor plist was one `brew upgrade node` from failing
  silently. The digest plist had no generator at all; `writeDigestPlist()` +
  `digest.mjs --install` closes that. **Files written, `launchctl` never invoked** — the
  loaded definitions are still the old ones until a human reloads them.
- **P4 · undiscoverable-ledger report.** `findLedgersUnder` had zero production callers
  (G48). Now an informational `doctor` section that can never fail the run, with every
  non-finding case named (`no-roots` / `walk-failed` / `none-found`), reusing `openCount()`
  rather than reimplementing the fold. Cost measured at ≈0.26s.
- **Identity map.** `~/.propagate/identity-map.json`, outside the repo by design, aliases
  derived from each workspace's `persona/profile.yaml`. Verified by building the public
  tree and grepping it independently of the tool's own check: zero real-name hits, clone
  URL intact. Three of eight workspaces have a directory name that is *not* the identity,
  so a map keyed on directory names alone would have published the person.

**Two measurements corrected, both worth keeping.** A parent-side count of open ledger rows
reported 42; the instrument was wrong — `drift` rows carry their own `status` and were
hardcoded as open. The real figure is 0. Separately, two lanes diagnosed a failing timing
test as CPU contention; it still failed on an idle machine. The 2s bound was intact
throughout — the test measured *all* of `doctor` against a budget ~1.4s above its floor.
`docs/GOTCHAS.md` **G53**.

**Finding, not fixed (P4):** `findUnownedLedgers` (`lib/edges/ledger.mjs`, commit
`b9c1075`, predating the plan) already walks the same tree with its own SKIP set and is
wired into `doctor` as a *hard-failing* check. The two mechanisms overlap for nearly every
real input and diverge only on `.gstack`. They should be reconciled onto one walk.

**Finding (P4):** the worktree ledger this lane was built to surface no longer exists on
disk — `.claude/worktrees/` was emptied 2026-08-15, before this session. The rows are not
lost: branch `worktree-client-answers-propagation` still carries 40 distinct rows with **1
open**, readable via `git show <ref>:<path>` with no checkout. That is **N25** in its
purest form — one path holding two different ledgers depending on the ref — and the
concrete argument for Phase 2.


### 2026-08-20 — Lane B done: `make-public.mjs` watchlist completeness

Plan: `~/.claude/plans/status-temporal-plum.md` §2 "Identity map: configurable, with a
self-maintaining watchlist". `make-public --check` now refuses if any depth-1 directory
under `SEARCH_ROOTS` (`lib/core/config.mjs`) is neither a key in the identity map's
`names` nor listed in its `allow` array — naming the specific unmapped directory. Map
format extended to `{ names: {...}, allow: [...] }`; a flat legacy `{name: alias}` map
(the shape on disk today) is still accepted, normalized as `{names: <that>, allow: []}`.
Watchlist source is directory names, deliberately not discovered workspaces — discovery
misses `Tathya`/`Khushboo`/`Tushar`, which have no `.propagates.yml` marker but do leak.
New test `tests/portability/make-public-watchlist.test.mjs` (5 cases, RED-first — the 2
refusal cases failed with exit 0 before `checkWatchlistCoverage()` existed). Full suite:
749 pass / 0 fail (was 744/0). `doctor` exit 0 before and after. See `docs/DECISIONS.md`
2026-08-20 "watchlist completeness" for the full writeup. Lane A (skill decomposition)
and Lane C (release mechanics) are separate, not covered by this entry.

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
- The suite passes clean; **run `npm test` for the count** rather than reading
  one here. On 2026-08-14 it was 470 (was 465: -1 removed for
  now-intentionally-wrong behavior, +6 new — see `docs/DECISIONS.md`
  2026-08-14 for the breakdown). It has grown since; a number in this file is
  wrong within days, which is what hub ledger row #148 was opened about.

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
descends. All ledger-owning dirs are discovered — `cli.mjs status --all` reports the
current count, and since 2026-08-15 it also names any ledger file that no
workspace owns rather than omitting it. Test count: **run `npm test`**; it was
116 on 2026-08-10 (up from 80 — discovery had *zero* coverage before) and has
grown well past that. `doctor`: one known failure, the `manual` row (N1).

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

## TODO — every project carries `docs/GOTCHAS.md`

Requested 2026-08-17. `rule:every-project-carries-gotchas` is written and active; this is
the propagate-side work to make it a mechanism rather than a convention.

**Adoption today, measured:** 3 of 43 `CLAUDE.md` files carry a gotchas-style section
(all under the name *"Things that will bite you"*), and **1** project has a real
`docs/GOTCHAS.md` — `Keerti/keerti-job-radar`, created as the worked example. This
skill's own `docs/GOTCHAS.md` (~40 entries) is the model and propagated nowhere for
months.

**Note the first measurement of this said 0 of 22.** It was the ugrep/`.gitignore` trap
(`rule:discernment-checks` §4) — treat any adoption count here as a floor until
re-measured with `find` + a real reader.

Done:
- Hub `.propagates.yml` declares `rules/discernment-checks.md → */docs/GOTCHAS.md` and
  one level deeper, so a globally-learned hazard fires drift at every project that has
  one. A glob matching 0 files is skipped with a warning, so this reports adoption
  rather than assuming it.
- `keerti-job-radar` declares `docs/GOTCHAS.md → CLAUDE.md`, and the edge is verified to
  fire.

Still to do:
1. **`init` should scaffold `docs/GOTCHAS.md`** alongside the sidecar, with the three
   headings and the "name what it cost" instruction. A convention that must be
   remembered is a convention that decays.
2. **A `doctor` check for the three-file set** — `STATE.md`, `docs/DECISIONS.md`,
   `docs/GOTCHAS.md`. As a **ratchet, not an equality**: 1 of 43 today, so asserting the
   full set would print 42 findings on day one and noise is a hiding place (G23). Fail
   only on the count *dropping*.
3. **Decide whether the 3 files using `## Things that will bite you` should be
   converted or left.** They are the pattern working under a different name; converting
   them is cheap, but per `rule:skill-routing`'s lesson, convert the *whole* section
   rather than only the part that matched a fingerprint.
4. **G43 above** — `check --changed` silently ignores untracked files, which made this
   very edge look broken when it was not.

---

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
