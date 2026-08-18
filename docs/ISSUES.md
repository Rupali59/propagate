> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# Propagate — issue register

Consolidated 2026-08-13 from two sources: problems observed live during a long workspace session,
and the skill's own self-documented defects (in-code `TODO`/`deferred` markers, `SKILL.md`'s
"does NOT do" section, and `docs/DECISIONS.md`). Re-consolidated the same day (register pass,
Phase C of `~/.claude/plans/okay-i-dont-think-logical-haven.md`) to pull in findings that had been
scattered across `docs/DATA_MODEL.md`, `docs/OBSERVABILITY.md`, `docs/DECISIONS.md`, the plan file,
and commit bodies — the thing this register exists to prevent was happening to the register itself.
**This file is the index.** Where a finding is documented at length elsewhere, this file links to
it rather than copying the prose.

**Grouped by failure mode, not by module.** That is the finding: most S1s are largely *one*
defect wearing different clothes.

Severity — **S1** silently wrong (you cannot tell it happened) · **S2** noisy or misleading ·
**S3** friction.

Scale as of **2026-08-15** (`cli.mjs status --all`): **1,922 raw rows across 11 physical ledger
files → 798 folded ids → 7 open**, across 9 workspaces plus the cross-repo ledger. The worktree
ledger that B1 was opened about is now classified, not invisible (see B1).

**Read that as three different numbers, because it is.** Raw `open` LINES across those files
total **501** — the ledger is append-only, so a row closed later keeps its original `open` line
forever. Folded by last-status-per-id the answer is **7**. Anything that greps instead of folding
is wrong by ~70×, and has been published wrong at least once.
18 `.propagates.yml` markers · 7 discovered workspaces · 5 project families. Counts rot; re-measure
before trusting these past a few weeks (the prior count here — "1,460 rows / 298 open across 8
ledgers" — was itself already stale by the time this pass started).

---

## The root defect: the silent no-op

Every entry in this section fails by doing nothing, successfully. No error, no counter, no log.
This is the class the spec must close.

**A named sub-pattern: checks that could not fail.** Three defects found this session were not
"no check exists" but "a check exists and is structurally incapable of reporting a problem" — a
worse failure mode, because it reports success rather than silence. `lib/decisions.mjs` matched a
bare `Affects:` while every real entry writes `**Affects:**`, so the parser returned zero tokens
against a non-empty file and nothing said so (N12). `readLedgerWithStats` computed `unknownTypes`
and discarded it before any caller could see it (N1). And `cli.mjs doctor`'s aggregate "sidecar
downstream paths resolve" check declared a `pathProblems` counter, tested it with
`if (pathProblems === 0)`, and never incremented it anywhere — so it reported green unconditionally,
for every workspace, regardless of what it found (N17, below). None of the three were subtle once
looked at directly; all three had been green for a long time before anyone looked.

### N1 · Unknown row types are dropped, and the stats are discarded — **S1** — **RESOLVED 2026-08-13**
`lib/ledger.mjs:171-203` folds three cases and sends everything else to an `unknownTypes` counter —
then `readLedger` (`:210-213`) throws that counter away and returns only rows. **Every caller is
blind to both `unknownTypes` and `malformed`.**

Cost, measured: a `type: "manual"` row at `Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl` line 470 has
been invisible to `readLedger`, `renderMarkdown`, `nextId`, `hasOpenDuplicateDrift`, `check`, and
every drain path **since 2026-06-20**. Type counts in that file: `drift 215`, `status_change 312`,
`code_drift 136`, `manual 1`.

*Fix:* return stats to callers; `doctor` reports non-zero `unknownTypes`/`malformed` as a failure.

**Verified resolved:** `readLedgerWithStats` (`lib/ledger.mjs:265-337`) returns
`{rows, malformed, unknownTypes}`; `doctor` (`cli.mjs:710-721`) reads `unknownTypes` off it and
fails on any non-zero entry, and a separate check (`cli.mjs:995-1013`) sums `malformed` across all
ledgers and fails the same way. Landed in `60db5c6`.

**Follow-up 2026-08-18 — the detection was resolved; the surviving row was not.** N1 fixed the
*reporting*, so from 2026-08-13 `doctor` failed continuously on the one real instance: the
`manual` row still on line 470. A standing red trains people to ignore the block (see the
propagation plan's E2), so the row itself is now handled — `readLedgerWithStats` recognises
`type: "manual"` as a **terminal-only** type and returns it in a separate `manual` array.

**It is deliberately NOT folded into `drifts`, and that is the load-bearing part.** Because
N2 (below) left `id 256` duplicated, admitting the row to the drift map would let it and the
real `drift` row overwrite each other by file order — converting an invisible row into a
corrupted one. Regression test: `tests/ledger-activity.test.mjs`, *"a `manual` row is known, is
NOT folded as drift, and is returned separately"*. It exercises **both** file orderings on
purpose: with the manual row first the drift row wins anyway and the bug is invisible, so a
first-order-only fixture is a check that cannot fail — the first draft of that test made
exactly this mistake and was caught by mutating the fold.

The four tests that had used `manual` as their stand-in for "an unknown type"
(`doctor.test.mjs`, `index.test.mjs`, `ledger-activity.test.mjs`, `metrics.test.mjs`) now use
`"not-a-real-type"`, so N1's detection is still exercised at full strength.

**N2 is unaffected.** Its *mechanism* was resolved on 2026-08-13 (the watcher uses
`appendRowWithId`, so no new collisions can be minted), but the **data artifact it left
behind persists**: `id 256` is still duplicated in the Vipin Kaushik ledger and the
`status_change` at line 507 is still ambiguous by construction. Nothing here resolves that,
and it cannot be resolved by editing — the store is append-only.

### N2 · `nextId` is check-then-act racy **and** type-blind — **S1** — **RESOLVED 2026-08-13**
`lib/ledger.mjs:244-251` computes `max+1` over *visible* rows with no lock. `appendRowWithId`
(`:144-161`) exists precisely to fix this race and its docstring says so — but `watcher.mjs:227`
still uses `nextId()` + `appendRow()` for the primary per-workspace ledger. Only the cross-ledger
path uses the atomic variant.

Cost, measured: because N1 hid the `manual` row's id, **id 256 exists twice** in the Vipin Kaushik
ledger — line 470 (`manual`) and line 474 (`drift`, source `docs/MEASUREMENT.md`) — with a single
`status_change` at line 507 that is ambiguous by construction.

Also: `parseInt("256abc")` is `256`; ids are never validated.

*Fix:* watcher uses `appendRowWithId`; ids become non-sequential (see N3).

**Verified resolved:** both main-ledger drift paths in `watcher.mjs` (the `drift` path at `:242`
and the `code_drift` path at `:360`) now call `appendRowWithId`, matching the four cross-repo call
sites that already used it. `nextId` (`lib/ledger.mjs:379`) has zero production callers left — grep
finds only its own definition and the doc comment referencing the race it used to cause. Landed in
`60db5c6`. **N3 itself is not resolved** — `appendRowWithId` closes the race but still mints
sequential ids under one lock, which remains unsafe across branches; that is v2's ULID work
(`~/.claude/plans/okay-i-dont-think-logical-haven.md` §1, §9 Phase 4).

### N3 · Sequential ids cannot survive branches — **S1**
Ids derive from file content, so two branches each appending from `max=255` both mint `"256"`. On
merge, `readLedger`'s id-keyed `drifts` Map collapses them last-line-wins, and they share one
`status_change` namespace. Not hypothetical — N2 produced the same collision by another route.

*Fix:* ULID or content-hash for new rows; existing ids are strings and stay.

### N4 · `markStatus` no-ops on an absent or misordered id — **S1** — **RESOLVED 2026-08-13**
The writer always succeeds; the drop is in the reader. `lib/ledger.mjs:186-188`:

```js
if (row.type === "status_change") {
  const existing = drifts.get(row.id);
  if (existing) existing.status = row.status;
}
```

No `else`, no counter, no warning. A `status_change` for a nonexistent id vanishes. So does one that
appears *before* its drift row, since folding is a single forward pass. It isn't even counted in
`unknownTypes`.

**And `markStatus` has no production callers** — grep finds it only in its own definition and
`tests/dedup-pathcheck.test.mjs`. Every status transition on 1,460 rows was written from outside the
skill. There is no supported close path.

*Fix:* throw on absent id; add a supported drain/close interface.

**Verified resolved, both halves:** `markStatus` (`lib/ledger.mjs:155-172`) now throws
`markStatus: no Event with id "…"` when the id is absent, and separately requires
`wontfix_reason` on a `wontfix` and `closed_by` on any terminal close. `cli.mjs drain`
(`cli.mjs:1594`, usage at `:24-29`) is the supported close path: lists open rows grouped by
`correlation_id`, closes by id or by group, and — because the same lock/reread machinery backs
it — a close that silently failed to persist would now surface as the thrown error above rather
than a quiet no-op. Landed in `60db5c6`.

### N5 · `hasOpenDuplicateDrift` cannot see `code_drift` — **S1**
`lib/ledger.mjs:121-142`: the loop's `if (r.type === "drift")` excludes `code_drift` from
`driftById`, and the `else if` excludes it from `statusById` too. Two reasons stack, so **all 136
`code_drift` rows are outside the dedup window** — every mtime bump appends a new row.

Visible today: `astroacharya/app/api/calendar.py` and `calendar_combined.py` each hold **3 open
rows** in the Vipin Kaushik ledger.

*Fix:* dedup on `(type, source, downstream-set)`.

### N6 · Glob `kind: code` edges silently never fire — **S1**
`lib/edges.mjs:184-190` logs and skips. `check` passes no logger (`cli.mjs:848` → `noopLogger`), so
the deferral isn't even printed. A doc declaring `path: lib/**/*.ts, kind: code` gets **zero**
coverage in both watcher and gate while looking declared.

Self-documented in five places (`SKILL.md:161,199-205,278`, `edges.mjs:161,216-218`,
`tests/code-drift.test.mjs:59`) as "documented limitation, not a bug" — but the user-visible effect
is indistinguishable from a working edge.

*Fix:* until implemented, `doctor` lists glob-code edges as **unenforced**.

### N7 · A missing `PROPAGATE_SEARCH_ROOTS` reports healthy forever — **S1**
On a machine that keeps code outside `~/Documents/GitHub`, discovery finds zero workspaces and the
watcher reports healthy. Named in `lib/config.mjs`'s own comment as "precisely the *abandoned
automation reports itself healthy* failure this skill exists to catch." Mitigated by the override
(`3c4eb65`), not closed — zero-workspace discovery is still a silent success.

*Fix:* zero discovered workspaces is a `doctor` failure, not a quiet pass.

### N8 · Worktree enumeration swallows failure — **S1** — **MOOT 2026-08-14 (watcher retired)**
`lib/worktrees.mjs:181-185` — bare `catch { return []; }`, no log, no stderr. The watcher then
falls back to canonical-only silently. `watcher.mjs:569-572` has its own logging catch, but layer 1
already swallowed, so that catch is dead code.

*Fix:* surface the failure; keep the fallback.

**Moot, not fixed:** the production failure mode described above only happens inside a live
`enumerateWorktrees()`/`enumerateCanonicalRepos()` fire — grep confirms that call path
(`lib/worktrees.mjs:83,206`) is imported **only** by `watcher.mjs`, nowhere else in `cli.mjs`,
`digest.mjs`, or `lib/reconcile.mjs` (the v2 replacement resolves repos differently, via
`lib/content-id.mjs`'s `resolveRepo`). `watcher.mjs` is retired 2026-08-14 (docs/DECISIONS.md) and
now refuses to run directly without an explicit override, so this silent-fallback path cannot fire
in production anymore. The underlying `catch { return []; }` bug is still present in the source —
this is not a code fix — but it has no live caller left to trigger it. Re-open if a future caller
(e.g. a v2 worktree-aware feature) starts using `enumerateWorktrees()` again.

### N9 · Schema rejection stops a sidecar's edges silently — **S1** — **RESOLVED 2026-08-13**
`additionalProperties: false` means a marker carrying a field the schema doesn't know is rejected by
`loadSidecar`, and that sidecar's edges simply stop firing. Recorded in `docs/DECISIONS.md`
2026-08-10 as the reason schema must ship *before* any marker gains a field.

**We triggered this ourselves on 2026-08-13, and it is live right now.** Tightening the schema to
reject a `path` ending in `/` (the directory-as-downstream guard) turned
`PanditPawanKaushik/SSJK-mb/.propagates.yml` from *"loads, with one path that does not resolve"*
into *"does not load at all"*. Every edge in that sidecar has stopped firing. Visible in
`watcher.log`:

```
synthesizeKindCodeEntries: skip broken sidecar .../SSJK-mb/.propagates.yml:
  schema violation: /sources/…task-engine-v2.md/propagates_to/5/path must NOT be valid
```

Net effect is **worse than the bug it catches** — one malformed path was traded for a wholly
disabled sidecar. The lesson generalises beyond us: N9 makes *any* schema tightening a potential
outage for existing markers, so the rule recorded on 2026-08-10 ("schema before field") needs its
mirror image: **a schema constraint must not be able to disable a file that previously worked.**

*Fix:* validation must be per-entry, not per-file — a malformed `path` invalidates that downstream
and reports it, while the sidecar's other edges keep firing. Rejecting the whole file makes the
validator a bigger outage than the thing it validates. Until that lands, weigh any new constraint
against the sidecars already on disk.

*Fix:* rejected sidecars are a loud `doctor` failure naming the file and field.

**Verified resolved:** `loadSidecar` (`lib/frontmatter.mjs`) now partitions ajv errors by
`instancePath`; an error confined to one `/sources/<key>/propagates_to/<i>/...` entry prunes only
that entry (re-validated before being returned), while anything structural (malformed YAML,
`sources` not an object, a top-level shape violation) still throws and rejects the whole file, since
there is no honest partial recovery from that. Every pruned entry is its own `doctor` `FAILURE`
naming the sidecar, source key, index and path via the new `problems[]` field — pruning does not
mean going quiet. Measured after: SSJK-mb's sidecar goes from 0 sources / 0 edges (whole-file reject)
to 10 sources / 39 live edges / 1 pruned-and-reported. Landed in `0e4f9ca`; the general rule
("a schema constraint must not disable a file that previously worked") is recorded in
`docs/DECISIONS.md` 2026-08-13. See also N17 below — validating *entries* required first fixing an
aggregate check that could not fail.

### N10 · `SKILL.md` documents a launchd label that does not exist — **S1**
`SKILL.md:15,116,131,243-244` say `com.rupali.propagate`; `lib/plist.mjs:25` uses
`com.tathya.propagate.watcher`. Every documented `bootout`/`bootstrap` command targets a nonexistent
label and **fails silently**.

Observed live: the watcher was paused before git surgery, believed stopped, and ran throughout. It
shipped into a publishable plugin at `3c4eb65`.

*Fix:* correct the doc; have `doctor` print the label it actually found.

**RESOLVED 2026-08-13, both halves.** `SKILL.md` and `docs/REFERENCE.md` now carry the real labels
(`com.tathya.propagate.watcher`, `com.tathya.propagate.digest`), and `tests/skill-doc.test.mjs`
asserts every label in an executable context is actually installed, so this cannot silently return.
The `doctor`-prints-the-resolved-label half, previously called out as still open, is also now done:
`cli.mjs:645-648` prints `resolved label: ${LAUNCHD_LABEL}` explicitly tagged
`// N10 (doctor half)`, and the subsequent `launchctl list` check (`:651-652`) checks against that
same resolved label rather than a hardcoded string.

### N12 · Every `Affects:` line in `DECISIONS.md` parses to nothing — **S1**
`lib/decisions.mjs:58` matches `/^Affects:\s*(.+)$/m` — a bare `Affects:` at line start. All 8
entries in `docs/DECISIONS.md` write `**Affects:**` in markdown bold. Zero match.

Measured 2026-08-13 by running the parser against the live file: **8 entries found, 0 with tokens**;
`affectsRaw` and `tokens` come back empty for every entry, old and new alike. The hub `CLAUDE.md`
describes this field as "machine-parsed by `lib/decisions.mjs` and gated by an external pre-commit
script" — so the gate has been evaluating an empty token set and passing everything.

This is I1's failure mode inside the decision log itself: the mechanism that records *why* a choice
was made cannot read its own attribution field, and nothing said so. Found while appending the
premise and skills-split entries, not by any check.

*Fix:* accept both forms (`/^\*{0,2}Affects:\*{0,2}\s*(.+)$/m`) and make a zero-token parse of a
non-empty file a `doctor` failure rather than a silent empty array. Add a test that parses the real
`docs/DECISIONS.md`, not only synthetic fixtures — `tests/decisions.test.mjs` passes 4/4 today
precisely because its fixtures use the bare form the live file never uses.

### N13 · `PROPAGATE_SEARCH_ROOTS` does not scope state, so testing the watcher corrupts production — **S1**
`lib/config.mjs:86-88` fixes `STATE_PATH`, `LOCK_PATH` and `HEARTBEAT_PATH` to `SKILL_DIR` with no
env override, while `SEARCH_ROOTS` *is* overridable. So the documented way to exercise the watcher
safely — point it at a temp tree — silently rewrites the real mtime baseline with the temp tree's.

**Caused a live incident on 2026-08-13.** A verification run of
`PROPAGATE_SEARCH_ROOTS=/tmp/watcher-verify node watcher.mjs` overwrote `state.json`. The next
launchd run saw all 203 tracked files as unseen and fired **120 events (40 drift, 80 code_drift)**
into the Vipin Kaushik ledger between 11:15:26Z and 11:18:45Z. Ruled out as the cause: no branch
checkout in either repo since 2026-08-12, and `state.json` re-seeded to 203 entries afterward,
consistent with a wipe-then-reseed rather than genuine drift.

Every one of those 120 rows is indistinguishable from real drift — same shape, same fields. The
ledger has no way to say "this fired because the baseline was lost."

*Fix:* scope state to the search roots, or add `PROPAGATE_STATE_DIR` alongside
`PROPAGATE_SEARCH_ROOTS` so the two move together. Relates to the deferred state-relocation item
(state living inside the plugin dir is also destroyed by a marketplace plugin update). Until then,
**there is no safe way to run the watcher by hand** — say so wherever the manual invocation is
documented.

**RESOLVED 2026-08-13 (Phase B).** `PROPAGATE_STATE_DIR` (`lib/config.mjs`) relocates
`STATE_PATH`/`LOCK_PATH`/`HEARTBEAT_PATH`/`WATCHER_LOG` (and, via N14's fix, the plist) together.
When unset, every path resolves byte-identically to the pre-existing literal — proved by
`tests/config-state-dir.test.mjs`'s "defaults unchanged" regression guard, which is the explicit
test against a fifth incident of this shape. A bad `PROPAGATE_STATE_DIR` (a file, or an uncreatable
path) logs a warning and falls back to the default; `config.mjs` never throws at module load
(`STATE.md`'s hazard about a throw bricking watcher/CLI/UI together still holds and is now tested).
Testing the watcher safely requires setting **both** `PROPAGATE_SEARCH_ROOTS` and
`PROPAGATE_STATE_DIR` — documented in the code comment above `resolveStateDir()`.

### N14 · `init` rewrites the real plist from a scoped run, disarming the watcher — **S1**
The same defect as N13, in a second location, and worse because the blast radius is the whole
machine. `PROPAGATE_SEARCH_ROOTS` scopes discovery, but `PLIST_PATH` (`lib/plist.mjs:26`) is fixed
to `~/Library/LaunchAgents/`. `cli.mjs init` ends by calling `regeneratePlist({workspaces})` with
whatever discovery returned, then `reloadLaunchd()`.

So running `init` against a temp directory with `PROPAGATE_SEARCH_ROOTS` set — the documented way
to try it safely — discovers 0 workspaces, writes the **real** plist with **0 WatchPaths**, and
bootstraps it. **Reproduced live 2026-08-13**: `WatchPaths` became an empty array; the watcher
stayed loaded but fired only on `StartInterval`, never on file events. Restored by re-running
`regeneratePlist` against real discovery (7 workspaces, 11 paths).

Compounding it: `init` regenerating and reloading launchd **at all** is a side effect
`STATE.md` already flagged as surprising. A setup command that can silently disarm the watcher is
the worst possible shape for that bug.

*Fix:* scope `PLIST_PATH` alongside `SEARCH_ROOTS` (one `PROPAGATE_STATE_DIR` should move state,
lock, heartbeat, and plist together); split plist regeneration out of `init` into an explicit
`reload`; and refuse to write a plist with 0 watch roots when discovery is degraded — an empty
plist is never a legitimate outcome.

**RESOLVED 2026-08-13 (Phase B).** Three independent fixes, each closing one blast-radius path:
1. `lib/plist.mjs`'s `PLIST_PATH` now derives from `PROPAGATE_STATE_DIR` (via `lib/config.mjs`'s
   `STATE_DIR`) exactly like `STATE_PATH`/`LOCK_PATH`/etc — a scoped run with both env vars set
   writes to a scoped plist path, never `~/Library/LaunchAgents/`.
2. `regeneratePlist()` now refuses to write when `workspaces.length === 0`, returning
   `{ ok: false, error }` instead of writing — `tests/plist-watch-roots.test.mjs` covers both the
   refusal and the unchanged N>0 write path. This alone would have prevented the incident.
3. `init` no longer calls `regeneratePlist`/`reloadLaunchd` at all (see N15's fix below) — the new
   `reload` subcommand does that job, explicitly and only when asked.
`tests/init-reload.test.mjs` proves `init` never writes a plist file even when run unscoped-of-plist
(no `.plist` appears under a scoped `PROPAGATE_STATE_DIR`), and proves via source inspection that
`reload`'s body — not `init`'s — calls `regeneratePlist`/`reloadLaunchd` (that half is intentionally
not exercised end-to-end in automated tests: it is the one command that is supposed to touch real
launchd state, and a stray registered job's `ProgramArguments` carry no environment, so a
scoped-but-imperfectly-cleaned-up test job would run the real watcher against real production paths
— exactly what this task's safety section forbids).

### N15 · `init` creates a marker that is not a workspace — **S2**
`cli.mjs init` writes a template containing `sources: {}` and **no `workspace: true`**. Since
`lib/discovery.mjs:113` promotes a marker to a ledger-owning workspace only on a strict `true`,
the directory `init` just created is invisible to discovery. Reproduced 2026-08-13: init printed
`✓ created …/.propagates.yml` and then `discovered 0 workspaces`, reporting both as success.

So the onboarding command cannot, by itself, onboard anything. Combined with N14, running it also
wipes the WatchPaths of every workspace that already worked.

*Fix:* the template sets `workspace: true` (or `init` asks whether this is a ledger-owning root
versus an edge-only sidecar, since both are legitimate — see A3), and init fails loudly when the
directory it just initialised does not appear in the subsequent discovery.

**RESOLVED 2026-08-13 (Phase B).** `init <dir> [--workspace|--edges-only]` — `--workspace`
(the default, since that's what someone running `init` almost always means) writes
`workspace: true` into the template; `--edges-only` writes today's sourceless template with no
`workspace` key, for a downstream-only sidecar. After writing, `init` always re-runs discovery and,
when `--workspace` was used, verifies the new root is actually present in the result — if not, it
prints `init failed: ... not discoverable` and exits non-zero rather than reporting `✓ created`
next to `discovered 0 workspaces` as if both were success. `tests/init-reload.test.mjs` covers both
flags, the default, and the loud-failure path (a target deliberately outside `SEARCH_ROOTS`, so
discovery can never see it regardless of the marker).

### N11 · Moving a directory silently breaks every `../` edge — **S1**
`propagates_to` paths and `sources:` keys both resolve relative to the sidecar's own directory.
Moving the parent breaks all of them, and `doctor` reports only a yellow "downstream missing" —
indistinguishable from a declare-ahead entry.

Hit twice in one day: `design/` → `docs/design/` (3 paths), then the `docs/` reorg (9 source keys).

*Fix:* keep a last-seen set in `state.json`; "existed at last run, now missing" is a break, not a
warning.

### N16 · `doctor`'s graph-integration check spent 94% of the run on a known-deferred answer — **S2**
Measured 2026-08-13 from `~/Documents/GitHub/Vipin Kaushik`:

```
claude mcp list  : 17793ms      <- 94% of doctor's ~19s
readLedger x8    :   102ms
launchctl list    :    69ms
```

`doctor`'s "Graph integration" section shelled out to `claude mcp list` (`cli.mjs`, synchronous
`execSync`, no timeout) to check whether `code-review-graph` is MCP-registered. Its only possible
output was a WARNING that is already known and already deferred: `code-review-graph MCP not
registered (V1 expected; see TM-064)`. Every `doctor` run paid ~18 seconds, unbounded, to reconfirm a
fact already written down.

This is the same failure class the rest of this register is about, in a different shape: not a
check that silently reports nothing, but a check whose *cost* silently exceeds the value of what it
reports — and because `execSync` here had no `timeout`, a hung `claude` binary would hang `doctor`
itself, indefinitely, with no distinguishing signal. **An unbounded subprocess inside a health check
is a liveness risk, not just a slow one** — a health check must never cost more than the thing it
checks, or the cost itself becomes the next silent-failure vector.

*Fix (2026-08-13):* `checkGraphMcpStatus()` (`cli.mjs`) bounds the shell-out to a 2s `timeout` and
caches the outcome (including timeout/error outcomes) to `GRAPH_MCP_CACHE_PATH` — inside
`PROPAGATE_STATE_DIR` when set, via `lib/config.mjs`, same as `STATE_PATH`/`HEARTBEAT_PATH` — for one
hour. Critically, a timeout is reported as `graph integration check timed out after 2s — status
unknown`, a distinct `status: "timeout"` outcome that is never treated as, or printed as, a pass —
"I could not look" must stay visibly different from "I looked and it is fine" (the theme of this
whole register). Measured after: doctor's graph-integration section drops from ~17.8s to
sub-millisecond on a warm cache, cold-cache cost bounded to ≤2s instead of unbounded.

### N17 · `pathProblems` was declared but never incremented — the aggregate check could not fail — **S1** — **RESOLVED 2026-08-13**
`cli.mjs`'s "sidecar downstream paths resolve" aggregate check declared `let pathProblems = 0`,
gated its verdict on `if (pathProblems === 0)`, and had no code path anywhere that ever incremented
it — so it reported green unconditionally, for every workspace, regardless of what the per-entry
loop found. This is the third instance of the "checks that could not fail" pattern named in this
register's intro, alongside N1 and N12.

It was also masking a real bug: two sidecars declare a *directory* as a downstream path
(`admin/app`, `server/__tests__/__golden__/flows/`), which is never a legitimate reading of a
downstream — unlike a missing file, which may be declare-ahead. `classifyDownstreamPath` now stats
every non-glob downstream and returns ok / missing / is-directory; a directory is a `FAILURE`
naming the sidecar, source, and path; `pathProblems` is now actually incremented, so the aggregate
check can fail. The schema also now rejects a `path` that is empty or ends in `/` at load time
(schema cannot stat the filesystem, so it cannot catch a directory without a trailing slash — the
description says so rather than implying more coverage than exists).

*Fix (2026-08-13):* landed in `b6d8972`. Live result at the time: `doctor` in Vipin Kaushik went
from 2 to 5 problems (3 new, all the same real bug seen from three nested workspace scopes — see
A4). Note the trailing-slash schema rejection was itself the *cause* of the N9 self-inflicted
outage the same day; the fix for one silent-no-op briefly created another, which is why N9's
resolution (per-entry validation) had to follow immediately rather than stand alone.

### N18 · Source keys are never validated to exist — **S1**
`doctor` validates every downstream `path` a sidecar declares (N17's fix), but never checks that a
sidecar's `sources:` **keys** — the upstream file the edge fires from — exist on disk. A source key
pointing at a file that was renamed or deleted can never fire, because the watcher's mtime check
has nothing to watch; the edge silently goes dead with no signal anywhere.

Live: `astroacharya/.propagates.yml` declares source keys `app/services/sky_today.py` and
`app/api/admin_festivals.py`; neither exists in the `astroacharya/` tree as of 2026-08-13
(`app/services/`/`app/api/` contain no such files). Named as a known gap in the `b6d8972` commit
message ("doctor validates downstream paths only, not source keys — a real gap, out of scope
here") but never entered into this register until now.

*Fix:* `doctor` stats every source key the same way `classifyDownstreamPath` now stats downstream
paths, and reports a missing source key as a `FAILURE` (not declare-ahead-eligible — a source, by
definition, must already exist for the watcher to have anything to watch).

### N19 · 39 Event rows carry a terminal status with no Transition — no audit trail — **S1**
Full analysis: `docs/DATA_MODEL.md` §6.1. Measured 2026-08-13 in the Vipin Kaushik ledger: 39
`type: "drift"` rows are written already `status: "done"` or `"wontfix"`, with no matching
`status_change` row anywhere in the file — no `closed_at`, no `closed_by`, no reasoning trail. All
39 are hand-authored (the `JSON.stringify`-spacing tell, see N20). Some are not drift observations
at all: at least one (`id: "015"`) is a bulk-close of ids #008–#014 recorded as if it were a single
drift event, `source: "watcher"`, empty `downstream`, because the data model offered no other way
to say "I closed these together and here is why" — direct evidence for the batch-close requirement
`60db5c6`'s `drain` now supports.

*Fix:* going forward, `60db5c6`'s `drain` writes real Transitions with `closed_by`/`wontfix_reason`,
so no *new* row can be written this way. The 39 existing rows are historical debt: either accepted
as pre-tooling history (no action) or re-emitted under a type that says what they are — that choice
has not been made. `doctor` should count `rows.closed_without_transition` (see
`docs/OBSERVABILITY.md` §1) so this stays visible rather than being forgotten a second time.

### N20 · 87% of the Vipin Kaushik ledger is hand-authored, outside any schema — **S2**
Full analysis: `docs/DATA_MODEL.md` §6, §9. Forensic split (`JSON.stringify` emits `{"type":"drift"`
with no space; hand-authored JSON commonly has a space after the colon) puts 578 of 664 rows in
that ledger outside this codebase entirely — because `markStatus` had zero production callers for
months (root cause fixed by N4), every close before `60db5c6` was a human or agent editing the
JSONL file by hand, inventing field names (`wontfix_reason`, `closed_by`, `note`) the schema never
saw. 100% of the 556 `wontfix_reason` rows fall inside that hand-authored set.

This is not eleven unrelated small bugs; it is one missing close path with eleven symptoms — see
`docs/DATA_MODEL.md` §6 for the full causal argument.

*Fix:* forward-looking half already shipped (N4 — `drain` is now the supported close path, so new
rows stop accumulating this way). The 578 existing rows are unmigrated hand-authored data with no
`content_id`/`ref`; per `~/.claude/plans/okay-i-dont-think-logical-haven.md` §8, v2's answer is
**freeze, don't convert** — a synthesised identity on historical rows would make a stale
verification look current, which is worse than no record.

### N21 · A glob matching zero files must report UNMATCHED, not let its edge vanish — **S2**
`lib/edges.mjs`/`watcher.mjs` expand a glob downstream at fire time and record `glob_matched`/
`sample` on the row (37 of 1,911 downstream entries carry it), but nothing distinguishes "the glob
matched zero files" from "there is nothing to report" — a glob that stops matching (a directory
renamed out from under it, a file pattern that no longer applies) simply produces no downstream
entries, with no signal that the edge went from N matches to 0. Zero live instances today
(confirmed in the Phase 1 spike, `~/.claude/plans/okay-i-dont-think-logical-haven.md` §3b:
"unmatched globs: 0") — still unmodelled, and a zero-instance count today is exactly the condition
under which a silent regression later goes unnoticed (same shape as N7).

*Fix:* a glob that resolves to zero matches emits (or `doctor` reports) an explicit `UNMATCHED`
state for that edge, distinct from both "no downstream" and "declare-ahead."

### N22 · Glob expansion correlates states, so raw expanded counts mislead a future drain UI — **S3, design**
Not a v1 defect — a design finding from the v2 spike, recorded here because a finding that lives
only in a plan file is a finding that is already lost (Phase C of
`~/.claude/plans/okay-i-dont-think-logical-haven.md`, itself citing R4). Measured in the read-only
Phase 1 spike (plan §3c): one globbed source matched against ~20 files yields 20 edges all carrying
that source's state, so a raw per-edge count overstates independent findings — "76 DIVERGED" was
really a handful of globbed sources times N matches. Showing 76 rows for 4 real decisions is
precisely the ratio that trained people to ignore v1's queue in the first place (see A2, C1's
"298 rows became furniture").

*Fix:* not yet built — this is a requirement on v2's `reconcile`/`drain`, not a v1 code change. Any
UI over expanded glob edges must group by the generating glob (the same way `correlation_id` groups
worktree-expanded rows today), so one glob decision reads as one queue item, not N.

### N23 · `WATCHER_LOG` is not test-scoped — `npm test` writes into the production log — **S2** — **impact moot 2026-08-14 (watcher retired)**
Same family as N13/N14 (a scoping variable exists but isn't universally applied) — **not** already
closed by Phase B's `PROPAGATE_STATE_DIR` work, contrary to what that work's scope might suggest.
`PROPAGATE_STATE_DIR` *can* relocate `WATCHER_LOG` (`lib/config.mjs:143`, covered by
`tests/config-state-dir.test.mjs`), but four test files —
`tests/code-drift.test.mjs`, `tests/cross-decision.test.mjs`, `tests/fire-paths.test.mjs`, and
`tests/cross-repo.integration.test.mjs` — import functions from `watcher.mjs` directly and invoke
them without setting `PROPAGATE_STATE_DIR`, so any call that logs (`watcher.mjs`'s internal `log()`
at `:82-85`, which always writes to the imported `WATCHER_LOG` binding) appends into the real
`~/.claude/skills/propagate/watcher.log` during `npm test`. Verified 2026-08-13: the production log
carries 7,082 lines timestamped today, and a subset are attributable to test-triggered fires rather
than launchd's own 60s cadence — the two are currently indistinguishable in the log itself, which is
part of the problem: an incident investigator reading `watcher.log` cannot tell which lines are real.

*Fix:* the four test files above set `PROPAGATE_STATE_DIR` to a temp directory (matching the pattern
already proven safe in `tests/init-reload.test.mjs`'s sandboxed acceptance test), or `watcher.mjs`'s
directly-imported functions take an injectable logger so tests never touch the module-level
`WATCHER_LOG` binding at all.

**Impact moot, code defect not fixed:** `watcher.mjs` is retired 2026-08-14 (docs/DECISIONS.md) —
it no longer runs under launchd, and running it directly (`node watcher.mjs`) now refuses without
an explicit override. `watcher.log` is therefore a retired artifact: nobody reads it as a live
incident-investigation source anymore, which was this finding's entire stated cost ("an incident
investigator reading watcher.log cannot tell which lines are real"). The four test files still
import `watcher.mjs`'s functions directly and still write into the real `watcher.log` during
`npm test` — that part of the bug is technically unchanged — but with no live incident-response use
of the file left to corrupt, the fix above is now cosmetic/optional rather than a live risk. Not
reclassified as RESOLVED because the code itself was not touched.

---

## Ledger attribution

### A1 · Workspace promotion strands prior rows — **S1**
Rows written before a directory gained `workspace: true` stay in the parent ledger and are invisible
to workspace-scoped `status`. **36 such rows** found in the hub, all predating Vipin Kaushik's
2026-08-10 promotion; they also kept `doctor`'s duplicate check red until drained.

Per `docs/DECISIONS.md` 2026-08-10 the deferred 69 hub rows may only ever be **closed-and-re-emitted,
never rewritten** — ids are per-file sequential, `source` is workspace-relative, `status_change`
history must be re-pointed, and N4 makes a half-applied migration invisible.

*Fix:* promotion migrates or `doctor` says "N rows predate this promotion".

### A2 · The same drift can be open in two ledgers at once — **S2**
`hasOpenDuplicateDrift` is scoped to one file and `source` is workspace-relative. `DECISIONS.md`
2026-08-10 states plainly that "total open stays 93" was true only at the instant of promotion, not
a steady-state invariant. `findDuplicateOpenAcrossLedgers` (`cli.mjs:119-120`) was shipped as the
deferral's **expiry signal** — it has since fired: 28 source paths, measured 2026-08-13 from
`~/Documents/GitHub/Vipin Kaushik`.

**Root cause, measured (2026-08-13):** all 28 are nested parent+child pairs. Zero are genuinely
unrelated ledgers. Example: `PanditPawanKaushik/SSJK-mb/server/auth/webauthn.js` is open in both the
`GitHub` hub ledger and the `SSJK-mb` ledger. This is not an independent defect — it is a
**symptom of nested workspace attribution**: workspace roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃
`SSJK-mb`), and the watcher attributes a changed file's drift row to *every* workspace whose subtree
contains it, not just the nearest one. A file under a child workspace gets claimed by the child AND
every ancestor, and each fires its own row into its own ledger.

The real fix is **attribution at write time**: a file belongs to its nearest (deepest) workspace, and
only that workspace's ledger should ever receive its rows. **This has not been done.** The
2026-08-13 doctor-dedup commit (see below) only dedupes *reporting* — the same nested-workspace
insight applied to `doctor`'s sidecar validation, not to the watcher's ledger writes. Changing where
the watcher writes is a live behaviour change, and it would leave the 28 existing duplicate rows
needing a separate decision (migrate? close-and-re-emit, per A1's rule? leave as historical?). Do not
conflate the two: reporting is deduped as of 2026-08-13; attribution is not, and `watcher.mjs` was
not touched to produce that fix.

*Consequence for `doctor`:* the sidecar **validation** side of this same nested-root pattern was
separately measured and fixed 2026-08-13 — `doctor` was running `findSidecars` per workspace root,
and since `findSidecars` recursively walks a workspace's entire subtree with no awareness of nested
workspace boundaries, the same `.propagates.yml` was found (and revalidated) by every ancestor
workspace. Measured before the fix: 43 sidecar scans for 21 unique sidecars (22 wasted, ~51%), 11
`doctor` problems for 4 real defects. After the sidecar-dedup fix alone: 21 scans (one per unique
sidecar, exactly), 5 problems (the 5th was `doctor`'s pre-existing habit of emitting both a per-entry
`check()` failure AND an aggregate "sidecar downstream paths resolve" `check()` failure for the same
directory-as-downstream defect — a double-count that only became *visible* here because `pathProblems`
had been declared-but-never-incremented until this same 2026-08-13 session, so before that the
aggregate could never fail and the double-count could not fire). **RESOLVED same day:** the aggregate
now prints as an informational summary (count only, `·` marker, not `✗`) whenever per-entry failures
already fired above it, instead of casting a second vote for the same bug — see `info()` in
`cli.mjs`'s `doctor()`. Warnings-only runs are unchanged: with zero per-entry failures the aggregate
still counts as the sole `check()`. Net: 4 problems for 4 real defects, matching one-`✗`-per-defect.
`assignSidecarsToWorkspaces` (`cli.mjs`) assigns each sidecar, keyed by `fs.realpathSync`, to the
deepest workspace whose root contains it; `doctor`'s per-workspace loop validates only what it owns.
This is the reporting-side analogue of the write-time fix described above, and does not substitute
for it — the ledger duplication (this section) is unchanged.

### A4 · Nested-workspace multiplication is structural, not only a doctor/ledger symptom — **S2**
Roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃ `SSJK-mb`), and every place in the codebase that
iterates workspaces without deduplicating by nearest-owner inherits the same multiplication A2 and
the `b6d8972`/`dca09be` commits fixed in two specific spots. Before `dca09be`, one sidecar bug was
independently scanned and reported **three times** (43 scans for 21 unique sidecars, 11 `doctor`
problems for 4 real defects) purely because `findSidecars` walked each workspace's full subtree with
no boundary awareness. `assignSidecarsToWorkspaces` (keyed by `fs.realpathSync`, assigning each
sidecar to its deepest owning workspace) fixed *sidecar validation* specifically. A2's own root
cause — the watcher attributing one file's drift row to every ancestor workspace's ledger, not just
the nearest — is the write-time instance of the same pattern and is explicitly **not** fixed (see
A2's "Consequence for doctor" note: reporting is deduped, attribution is not).

The two fixes so far are both point fixes for specific call sites, not a general utility. Any new
code that walks `discoverWorkspacesSync()`'s output and does per-workspace work on overlapping
subtrees (a future metrics emitter, a new `doctor` check, a v2 `reconcile` pass) needs to either
reuse `assignSidecarsToWorkspaces`'s realpath-keyed dedup pattern or inherit the same triple-counting
bug in a new location.

*Fix:* extract the nearest-owner assignment into a shared helper (`lib/discovery.mjs` is the natural
home, next to `discoverWorkspacesSync`) so future call sites get it by construction rather than by
remembering to re-derive it, the way `assignSidecarsToWorkspaces` and A2's write-time fix would
otherwise have to be reinvented a third time.

### A3 · Ledger location is pinned — **S2**
`makeWorkspaceRecord` resolves to `<root>/docs/PROPAGATION_LEDGER.jsonl` when `docs/` exists, else
`.propagation/ledger.jsonl`, with a pinning rule for whichever already exists. Moving `docs/` would
orphan a live ledger — narrowly avoided during the 2026-08-12 reorg.

---

## Coverage

### C1 · Nothing reports what is *not* declared — **S1**
`VipinKaushik` had **no sidecar at all** while every sibling repo had one; its 31 content specs
(10,010 lines) could not be sources. Consequence: the 2026-07-15 legal-shell migration dropped two
privacy disclosures that are live on production and **no row fired**. Fixed for that repo on
2026-08-13; the *blind spot* is not fixed.

*Fix:* a `doctor` coverage line per repo — sidecar present? sources declared? files in the docs tree
named nowhere? This would have caught it in seconds.

### C2 · The ledger reads as a forensic record and is not one — **S2**
Asked "is there anything in the ledger about the legal documents?", the honest answer was two
incidental rows — because the ledger only knows declared files. Its silence carries no information
but *looks* like evidence of absence.

*Fix:* when a query matches nothing, say "not declared in any sidecar" rather than returning empty.

---

## Branch and merge blindness

*Re-ranked S2 → S1 on 2026-08-13, following the premise change (`docs/DECISIONS.md` 2026-08-13):
propagate coordinates parallel work across branches/worktrees/repos, not doc staleness. Under that
premise, branch-blindness is not noise — it is the coupling the tool exists to hold, silently
failing on exactly the case that matters most.*

### B1 · Sidecars are branch-local; `doctor` is not branch-aware — **S1** — **RESOLVED 2026-08-15**
*(was S2; re-ranked 2026-08-13 — see note above)*

**Resolved, but not as stated.** `doctor` gained `no unowned ledger files`, which scans the search
roots for the *artifact* rather than trusting discovery — depth finds today's worktree and misses
tomorrow's. `status --all` gained the cross ledger and a whole-project rollup.

**The row this issue was opened about was never real work.** All 40 ids in that worktree ledger
exist in the parent workspace's ledger, and `#039` — its one `open` row — is already `done`
upstream. It is a branch-time snapshot, so it is reported and deliberately **not counted**;
counting it would have moved the whole-project figure from an under-reported 4 to an over-reported
8, when the truth is **7**. See `docs/DECISIONS.md` 2026-08-15.

The sidecar half of this issue (16 of VipinKaushik's 31 specs existing only on
`feat/hero-v4-rebuild`) is **not** addressed by that change and remains open under B2.

16 of VipinKaushik's 31 specs exist only on `feat/hero-v4-rebuild`. A sidecar landing with that
branch shows unresolved paths from production's perspective, indistinguishable from N11.

**Caught live, 2026-08-13 — it is worse than "sidecars".** A whole *ledger* is branch-local and
undiscovered:
`PanditPawanKaushik/.claude/worktrees/client-answers-propagation/docs/PROPAGATION_LEDGER.jsonl`,
79 rows, **1 of them open**. `discoverWorkspacesSync` returns 7 workspaces and that path is not
among them, so the row appears in no `status --all` and no `doctor` run. Discovery never descends
into `.claude/worktrees/<name>/`.

The sharpest part: `doctor`'s `duplicateOpenAcrossLedgers` assertion passes over this, because it
cannot see the second ledger to compare against. A check whose failure case is invisible to it
reports success either way — I1, inside the safety net built to catch I1.

Found only because a data-model census walked the filesystem directly rather than asking discovery.
See `docs/DATA_MODEL.md` §9.

*Fix (superset of the sidecar case):* discovery enumerates worktrees via `git worktree list` — the
machinery already exists in `lib/worktrees.mjs` for expanding sidecar paths — and either adopts
worktree ledgers or reports them as unreachable. Silently not-looking is the one option I1 forbids.

### B2 · Squash merges defeat ancestry checks — **S1**
*(was S2; re-ranked 2026-08-13 — see note above)*

13 branches read as unmerged by `git branch --merged` while their content was live in production.
`git cherry` (patch-id) sees through it. A git property rather than a skill bug — but it produced a
wrong conclusion about lost work, and the skill is the natural place to document it.

---

## The commit-time gate

### G1 · `check --range` interpolates argv into a shell — **S1, security** — **RESOLVED 2026-08-13**
`cli.mjs:923`: `` execSync(`git diff --name-only ${range}`) `` — no validation, no `execFileSync`.
Any shell metacharacter in `--range` executes. This is a tool explicitly intended for git hooks and
CI, i.e. for hostile-ish input.

*Fix:* `gitDiffNames` now takes an argv array and runs `execFileSync("git", args, {cwd, encoding})` —
no shell is ever spawned, so a hostile `--range` value (e.g. `x; touch ...`, `x$(...)`, `` `...` ``)
is passed to git as one literal argument, which git rejects as an invalid revision; `check` exits 2
with no side effect. All four call sites (`check`'s `--range`/`--staged`/default-`--changed` paths)
converted. Verified: pre-fix, `node cli.mjs check --range 'HEAD; touch /tmp/x'` created `/tmp/x`;
post-fix it does not (`tests/check-injection.test.mjs`, 5 tests, including a legitimate-range
regression test proving behaviour is otherwise unchanged). The other `execSync` calls in `cli.mjs`
(`:245`, `:446`, `:578` — `launchctl list`, `launchctl list`, `claude mcp list 2>&1`; `:934` — `git
rev-parse --show-toplevel`) are fixed literal strings with no argv interpolation and were left as-is.
The `docs/REFERENCE.md` pre-push-hook blocker note tied to this issue is removed — see that doc.

### G2 · `--changed` is a documented no-op, not a parse failure — **S3** — **corrected 2026-08-13**
*(Originally filed as S2 "never parsed", implying `check --changed` was broken. That overstated it —
corrected after re-reading `cli.mjs:907-937` against the actual branching.)*

`cli.mjs` reads `--strict`, `--staged`, `--range`; `--changed` matches none of them and falls through
to the `else` branch, which is *exactly* the documented `--changed` behaviour (working tree + staged
vs `HEAD`, unioned — see the usage comment at the top of `cli.mjs`). So `check --changed` behaves
correctly and identically to bare `check`; the flag is accepted but has no distinct code path because
it names the default, not because parsing failed. `check --bogus` also falls through to the same
default, which is arguably worth a warning someday, but that's unrelated to `--changed` specifically.
Passing both `--range` and `--staged` does make `--range` win silently (branch order:
`range` → `staged` → default) — that's the only real (S3, cosmetic) finding here.

*Fix (if ever prioritized):* warn on unrecognized flags; document the `--range`-beats-`--staged`
precedence in the usage comment. Not a correctness bug — downgraded from S2.

### G3 · The gate is documented but not installed — **S2**
`SKILL.md` describes a pre-push hook. Nothing installs it, and no repo in the workspace has one.
`check` is read-only, correct, and hook-safe — it is simply unused.

---

## Noise

### E1 · Reorg edits are indistinguishable from content edits — **S2**
Updating a path reference inside a declared source fires the same row as changing its meaning. The
2026-08-12 `docs/` reorg produced **11** such rows, all closed by hand with a "path-reference
housekeeping only" note.

### E2 · Declare-ahead warnings never expire — **S3**
Four have stood for weeks (`InboxRail.tsx` ×2, `ephemeris_scheduler.py`, `CHAPTER_LOG.md`).
Permanent yellow trains readers to skip the warning block — which is how A1's red ✗ went unnoticed.

*Fix:* `expect_by:` on declare-ahead entries; escalate past it.

### E3 · No way to record "deliberately not declared" — **S2**
`VipinKaushik/docs/content/README.md` argues the spec tree should *not* be declared. That reasoning
lives in prose the tooling cannot see, so the only states are "declared" and "absent" — and absent
looks like an oversight. It took a full audit to establish it was a decision.

*Fix:* an `excluded:` block with a `why`, reported by `doctor` as intentional.

---

## Deferred by design (live, not bugs)

- **Graph integration** — `concepts:` is schema-accepted and unused; `code-review-graph` MCP not
  registered. TM-064. (`SKILL.md:135,139,268-269`, `propagates.schema.json:46`, `ledger.mjs:43`)
- **macOS-only** — launchd. No Linux/remote path.
- **Cross-repo layer dormant** — 20 commits, 2 slices, 90 tests, **10 rows total, silent since
  2026-07-13**. Whether it stays is a decision, not a defect.
- **`optional: true`** — proposed in `cross-project-capture-2026-06-09` Phase 3a so a missing
  downstream can be tolerated. **Could not confirm it ever shipped**; verify against
  `propagates.schema.json` before relying on it.
- ~~**`cli.mjs init` re-arms launchd as a side effect**~~ — **RESOLVED 2026-08-13**, folded into
  N14's fix: `init` no longer touches the plist or launchd at all; `node cli.mjs reload` is now the
  explicit, separate command for that.

---

## Suggested order

**Done, in the order this list originally proposed:** N10 (doc + doctor-prints-label, both halves),
G1 (injection fix), N1 (dropped-row stats surfaced), N4 (close path supported and loud), N2 (id race
closed), N9 (per-entry sidecar validation), N12 (`Affects:` parsing), N13/N14/N15 (state/plist
scoping), N16 (doctor perf), N17 (the check that couldn't fail). **C1 remains open** — coverage
reporting was the single highest-value item on the original list and nothing above closed it.

Remaining, re-ordered against what actually shipped:

1. **C1** — coverage reporting. Still the highest value per effort; would have caught the
   2026-07-15 privacy regression, and nothing built since has substituted for it.
2. **N18** — source-key validation. Same shape as C1's declared-vs-real gap, cheap given
   `classifyDownstreamPath` (N17) already exists as a template to extend to the source side.
3. **N3** — sequential ids still cannot survive branches; N2 only closed the race, not the scheme.
   Prerequisite for any branch-aware or merge-aware work below.
4. **N5** — dedup `code_drift`; directly reduces open-row growth, independent of N3.
5. **B1 + B2** — branch/merge blindness. Re-ranked S2 → S1 2026-08-13: under the
   parallel-coordination premise this is premise-critical, not noise, but it is sequenced after the
   id-integrity work (3, 4) because branch-aware `doctor` checks and merge-aware dedup both build on
   ids that survive branches and merges (I5) — doing this first would need redoing once N3 lands.
6. **A4** — extract the nearest-owner dedup helper before a third call site reinvents it (or
   inherits the triple-count bug) independently.
7. **N19 / N20** — the 39 audit-trail-less closes and the 578 hand-authored rows are historical
   debt now that N4's close path exists going forward; a migration decision, not urgent.
8. **N21 / N22 / N23** — lower urgency: N21/N22 are zero-instance-today/design-only, N23 is test
   hygiene rather than a production-data risk (and its impact is now moot post-2026-08-14 watcher
   retirement — see N23's entry).

Everything else is friction rather than error. **N8** dropped off this list entirely 2026-08-14 —
moot, not fixed, once `watcher.mjs` (its only caller) was retired; see N8's entry.

### N24 · `init` leaves a workspace that `doctor` immediately fails — **S2**

`cli.mjs init --workspace` writes `.propagates.yml` and verifies the directory is
*discoverable*. It does **not** create `.propagation/ledger.{jsonl,md}`, so the two
`ledger * exists` checks fail the moment onboarding finishes.

**Observed twice, identically.** Obsidian on 2026-08-14 (doctor 1 → 3), then Motherboard
the same day (doctor 1 → 3, same two checks). Both fixed by hand.

The failure mode is that `init` ends by printing `✓ verified: discoverable as a
workspace` and `init complete.` — a success banner over a state that fails the project's
own health check. That is the silent-no-op shape this register exists to catch, inverted:
not a check that cannot fail, but a **success message that outranks a check that just
did**.

`.templates/NEW-PROJECT-CHECKLIST.md` §4 already documents the workaround ("verify the
ledger files exist afterwards — `init` confirms discoverable, not complete"). Documenting
a defect twice is not fixing it: `init` should create both ledger files, or run `doctor`
before printing `init complete` and refuse to claim success while it fails.

### N25 · A ledger is read from the working tree, so its state is whatever branch is checked out — **S2**

`reconcile`, `status` and `verify` read ledger and source files from the **working tree**.
The skill already knows this — every verify event records
`observed_on_ref: row.source.ref || "working-tree"` (`cli.mjs:2468,2540`,
`lib/bootstrap.mjs:375`) — and `lib/git-context.mjs:96,134` already resolves the current
branch. **Nothing joins those two facts.** No command compares a ledger across refs, and
none warns that the checked-out branch is not the repo's default.

**Measured 2026-08-15, `PanditPawanKaushik/SSJK-mb`:**

| Ref | `docs/PROPAGATION_LEDGER.jsonl` |
|---|---|
| `main` | **7 rows** |
| `r1-dashboard-rebuild` (checked out) | **86 rows** |

`status --all` reports SSJK-mb as `✓ no open drift events`. That is true of the branch and
says nothing about `main`, which is 79 rows behind — and the output does not mention a
branch at all. Anyone reading the project's propagation state from its default branch gets
a different answer than the tool just gave them, with no indication the two exist.

The divergence here is benign — append-only, strictly ahead, `main`'s 7 rows are
byte-identical to the branch's first 7. That is the point: **the failure is not corruption,
it is an unqualified answer.** A `0 open` that silently means `0 open on whatever you have
checked out` is the same class as G2 (absence must be attributable) and the same class as
the size-cap gate reading HEAD instead of the index (SSJK-workspace #19).

**Not the same as the B1 branch-snapshot case** (`docs/DECISIONS.md` 2026-08-15), and the
fix there does not cover it. B1 was an **unowned ledger file at another path**, caught by
scanning search roots for the artifact. Here there is exactly one path, one workspace, one
owner — the divergence lives inside git, not on the filesystem, so no amount of scanning
finds it.

**Options, in ascending cost:**
1. **Qualify the output.** When `HEAD` is not the repo's default branch, append the branch
   to the status line: `SSJK-mb [r1-dashboard-rebuild] ✓ no open drift events`. Cheapest,
   and removes the unqualified claim, which is the actual harm.
2. **Warn on divergence.** Compare `git show <default>:<ledger>` against the working-tree
   copy; if they differ, say by how many rows and in which direction. Reuses the same
   `git show` reading `scripts/hygiene/lib/size-caps.sh` already relies on.
3. **Make the ref explicit in `status`/`reconcile`** (`--ref main`), so a whole-project
   answer can be derived for the default branch regardless of what is checked out.

(1) is a one-line honesty fix and should not wait for (2) or (3).

**Live instances today:** `SSJK-mb` on `r1-dashboard-rebuild` (7 vs 86 rows), and this very
repo — `~/.claude/skills/propagate` on `docs/premise-and-routing`, where `docs/GOTCHAS.md`
does **not exist on `main` at all** while the branch carries 37 entries. Neither is a bug in
the branches; both are answers that decline to name their scope.

## Related

- `docs/SPEC.md` — the specification these fixes resolve to
- `Vipin Kaushik/docs/plans/2026-08-13-propagation-issues.md` — the incident narrative this register
  supersedes
- `docs/DECISIONS.md` — six 2026-08-10 entries that constrain any fix

### N26 · A stale rendered `PROPAGATION_LEDGER.md` can be committed beside a correct `.jsonl`, and nothing detects it — **S1**

**Symptom.** Committed ledger markdown shows rows as `open` that the authoritative JSONL
records as `wontfix` or `done`. A reader of the `.md` sees a large open backlog that does
not exist.

**Measured 2026-08-16**, by re-rendering each ledger from its own JSONL and diffing:

| Repo | committed `.md` shows | JSONL fold |
|---|---|---|
| `Vipin Kaushik` | 19 open | 0 |
| `PanditPawanKaushik` | 14 open | 0 |
| `Keerti/Keerti-portfolio` | 12 open | 0 |

`propagate status` simultaneously reported **3 open across 12 ledgers** — the tool was
right; 45 rows of committed markdown were wrong.

**Why it is S1.** Nothing announces it. The `.md` header even says "JSONL store is
authoritative — this file is rendered", which reads as reassurance and suppresses
suspicion (G40). `doctor` checks that the ledger JSONL exists and parses; it does **not**
check that the `.md` agrees with it.

**Root cause.** Nothing re-renders on `drain` / `verify`, and nothing gates the commit.
In `Vipin Kaushik` the stale `.md` and correct `.jsonl` were committed together in
`7282c6e` — row 291 carries a `drift` row (open, 2026-06-30) and a `status_change`
(wontfix, 2026-08-13); the fold is `wontfix` and the committed `.md` said `open`.

**Contributing defect.** The rendered header is a *relative* date —
`**Last entry: today.**`. It becomes false with the passage of time alone, so every
committed `.md` is guaranteed to differ from a fresh render regardless of content. That
churn also trains readers to dismiss ledger diffs as noise, which is how the row-status
drift stayed invisible.

**Fix candidates.** (a) `drain` and `verify` re-render the affected `.md` after writing.
(b) A `doctor` check asserting each `.md` matches a fresh render of its `.jsonl` — this
is the one that would have caught it, and it can fail, per G1. (c) Render an absolute
date, or omit the freshness line from the file and leave it to `status`.

### N27 · `verify` writes on first invocation while `bootstrap` is dry-run by default — **RESOLVED 2026-08-17**

> **Fixed by candidate (a).** `--apply` now gates the event write for every
> disposition, not just `decoupled`; without it `verify` prints what it would write,
> runs the real validator so predicted refusals match actual ones, and touches
> nothing. `cli.mjs`'s misleading header comment is corrected and `SKILL.md` states
> the posture under Important Rules. Regression cover:
> `tests/verify-ordering.test.mjs` snapshots the event store byte-for-byte around
> every non-writing path — the word "would" in the output is never trusted.
>
> **It was filed on 2026-08-16 and hit again on 2026-08-17**, this time for 11 events
> and 3 falsely-closed worklist items, by a session that had read neither this entry
> nor the code. That is the cost of an S2 that stays open: the second instance was
> more expensive than the first, and the entry that would have prevented it existed
> the whole time. See `docs/GOTCHAS.md` G44 and the DECISIONS entry of 2026-08-17.

**Original report follows.**

**Symptom.** Two adjacent commands with opposite safety postures and no signal about it.
`bootstrap` requires `--apply` to write and prints `dry run — pass --apply to write N
events`. `verify` writes immediately: there is no `--apply`, no dry-run, and no
confirmation. Its only output is a success line and an event ID.

**Misleading in the source too.** The bootstrap block in `cli.mjs` is commented
"Dry-run by default; `--apply` writes, **same posture as verify --apply**", which asserts
a gate on `verify` that does not exist.

**Instance, 2026-08-16.** An operator invoked `verify --edge <id> --disposition
no-change-needed` on three edges believing it a dry run, and re-baselined all three. The
dispositions were correct and verified, so no data was harmed — but the belief was wrong,
and the same mistake with a wrong disposition writes an unearned CLEAN into the event
store. Since events are append-only, that is corrected by another event, never removed.

**Why S2 and not S1.** It is not silent: event IDs are printed and `reconcile` shows the
new state immediately. The defect is the misleading asymmetry, not invisibility.

**Fix candidates.** (a) Accept `--apply` on `verify` and dry-run without it, matching
`bootstrap`. (b) If writing-by-default is intended, say so in the command's own output
(`writing N events — verify has no dry-run`) and correct the `cli.mjs` comment. (c) At
minimum, document the asymmetry in `SKILL.md`, where the two commands are listed
together with no hint that they differ.

## N28 · S3 · `supersession_prose_only` cannot tell "I supersede X" from "I was superseded"

**Observed 2026-08-17**, `Keerti/keerti-job-radar`. The ratchet grew 107 → 109. Both new
files are `CLAUDE.md` and `STATE.md`, and neither claims to supersede anything — they
*announce that they themselves are superseded*, with a banner at the top pointing at the
replacement:

> **The Chrome extension here is superseded (D13).** The live product is the Claude
> Cowork skill in `cowork-skill/`.

That is the metric's own stated goal achieved — *"the superseded doc never learns it was
overruled"* — and it is counted as a violation, because the check greps for the word
rather than the direction.

**Not tuned, not gamed.** Rewording to dodge the grep would make the docs worse, and
raising the baseline is forbidden by the metric's own basis. Recorded so the next person
seeing 109 knows two of them are the check misreading a doc that did the right thing.

**Possible fix:** distinguish the direction — a doc saying *"is superseded by"* /
*"superseded (D-n)"* is the passive form and should either count separately or want a
`superseded_by:` declaration, which does not currently exist as a field.


---

## N29 · ~~S2~~ · **RESOLVED 2026-08-17** · propagate cannot declare its own couplings

> **Fixed by candidate (b): markered symlinks are now descended.** A symlinked
> directory is followed when — and only when — it carries a `.propagates.yml`.
> The marker is the opt-in, so the tree's incidental symlinks behave exactly as
> before. Cycle safety is a realpath-keyed visited set in each walk.
>
> **It had to be fixed in TWO walks, and fixing one proved nothing.**
> `lib/discovery.mjs`'s `listDirs` finds WORKSPACES; `lib/edges.mjs`'s
> `findAllSidecarsRecursive` finds SIDECARS. After the first fix the expanded
> edge count was still **711 → 711** and `doctor` still said IGNORED. Only the
> second made it real: **711 → 720**, with 9 edges and 12 of the skill's own
> files in the graph.
>
> Also fixed: `doctor`'s line still read `** declares .propagates.yml and is
> being IGNORED **` after the behaviour changed — a check asserting the opposite
> of what the code does. Now `(declares .propagates.yml — followed, N29)`.
>
> **Regression cover:** `tests/journal.test.mjs`. The test that asserted IGNORED
> is inverted in place — a markered link must become a workspace, and the old
> message must be **absent** — plus a new test that an UNMARKERED link is still
> skipped and still named. Following links by default is what invites cycles and
> duplicate workspaces; the marker is the entire safety argument, so it needs its
> own test.
>
> **Known limit, not fixed:** `check --changed` is repo-scoped. The skill is its
> own git repo, so running `check` from the hub cannot see its diffs. The edges
> are live in `reconcile`/`graph` regardless, since those derive from content.

**Original report follows.**

**Symptom.** The skill that exists to catch undeclared couplings has none of its
own, and cannot be given any. `~/.claude/skills/propagate` is outside
`SEARCH_ROOTS` (`~/Documents/GitHub`). The one path from the hub is
`~/Documents/GitHub/propagate-skill`, a symlink — and `lib/discovery.mjs` uses
`readdirSync(parent, { withFileTypes: true })`, where a symlinked directory
reports `isDirectory() === false`, so it is never descended.

**Confirmed by construction, 2026-08-17.** A `.propagates.yml` was written into
the skill dir declaring five edges (`lib/graph.mjs` → `SKILL.md` and
`docs/DECISIONS.md`; `lib/metrics.mjs` → `docs/OBSERVABILITY.md` and
`docs/GOTCHAS.md`; `lib/events.mjs` → `docs/DATA_MODEL.md`). Edge count before
and after: **711 and 711.** Not one of the five was read. The file was removed
rather than left in place — a declaration nothing reads is the exact
"looks machine-checked and is not" failure this project is about, and leaving it
would have been worse than having none.

**`doctor` already catches this, and is too quiet about it.** With the marker
present the symlink line escalates from `(no marker — nothing lost)` to
`** declares .propagates.yml and is being IGNORED **`. That check works and
found this immediately — but it is an `info()`, so it does not fail the run. A
marker-bearing symlink means declared edges are silently dead; that is a
problem, not a note.

**Why this was invisible until now.** `status` and `check` are per-edge and
report on what discovery found. `graph` reports the whole workspace, so a
workspace with zero edges in it is visible for the first time.

**Fix candidates.** (a) Promote the doctor line from `info()` to a failing
`check()` when a marker is present — smallest change, and it makes the gap
impossible to forget. (b) Descend symlinked directories that carry a marker,
with a realpath-based visited set for cycles (the journal walker already
solved cycle termination — see DECISIONS 2026-08-16 and `lib/journal.mjs`).
(c) Add the skill dir to `SEARCH_ROOTS`. (b) is the general fix and the one
that would let any out-of-tree tool declare edges; (a) should land regardless,
since it is the check that stops this being rediscovered a third time.

**Deferred sidecar.** The five declarations are drafted and correct; they need
(b) or (c) before they do anything. They are saved at
**`docs/deferred/own-sidecar.yml`** — not re-derived when this is fixed, and no longer
in a session scratch directory, which is where they spent their first hour and would
have been deleted along with the job (`rule:delegation-criteria` §5: verify every path
a handover cites, *before* writing it).

The measurement behind the 1-of-45 adoption figure is kept beside it at
`docs/deferred/gotchas-census.mjs`, so a future coverage ratchet has a derivation to
build on instead of a number quoted in prose.

---

## N30 · S2 · `ledger.unknown_types` cannot be cleared without a disambiguation strategy

**Filed 2026-08-17** during a whole-tree ledger sync, as a handover: the fix is
skill code, and the session doing the sync was scoped to the projects.

`doctor` fails on `ledger.unknown_types == 0`, naming one row:

```
/Users/rupali.b/Documents/GitHub/Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl
  "manual" × 1
```

It is line 470, id `256`, `"type": "manual"`, `"status": "wontfix"`, timestamped
2026-06-20 (the `Campaigner/` → `marketing-intel/` rename).

**There is no data fix.** `readLedgerWithStats` (`lib/ledger.mjs:283-313`) folds only
`status_change`, `drift` and `code_drift`; anything else falls to the `else` at
`:309-312`, which *counts* the row and drops it. The row's `status` is therefore never
read, so its already being `wontfix` is irrelevant — `drain` cannot see it, and
`SKILL.md` forbids rewriting a ledger row ("append-only; migration is close-and-re-emit").

**The obvious fix has a live collision.** Folding `manual` into the `drift` branch at
`:305` is one line, but **id `256` exists twice in that file** — line 470 (`manual`) and
line 474 (`drift`, source `docs/MEASUREMENT.md`) — and `drifts` is a `Map` keyed by `id`.
Folding naively makes one row silently overwrite the other, and the `status_change` at
line 507 then lands on whichever survives. That trades one silent wrongness for another.

**So this needs, together:** a disambiguation strategy (composite key, or a legacy-type
allowlist that folds to a distinct namespace), **and a test pinning which row wins** —
per `rule:safety-flag-needs-a-test`, asserting the *fold output*, not that the type is
recognised.

**It also sits against `SKILL.md`'s own rule** — "a red `doctor` is doing its job … never
tune the check until it passes." Teaching the reader a type it has been silently dropping
since 2026-06-20 (that is N1's whole cost) is arguably making the instrument honest rather
than tuning it, but it is close enough to the line to be a human call, not an agent's.

## N31 · S2 · `renderMarkdown` has no live caller, and would regress the tree if called

**Filed 2026-08-17**, same handover.

`renderMarkdown` is defined at `lib/ledger.mjs:391`. Verified callers, whole tree:
`watcher.mjs:499`, `:554`, `:699` — **retired 2026-08-14, refuses to run** — and
`tests/ledger-render-staleness.test.mjs`. **`cli.mjs` never imports it.** `drain`'s close
loop calls `markStatus` then re-reads to verify the close landed, and stops; `verify`
writes v2 events and has no `.md` to render at all.

**Two documents prescribe it anyway.** `docs/GOTCHAS.md` G40's **Do:** says re-render
after any drain or verify, in the same commit, naming `renderMarkdown(jsonl, md)`; and
`docs/REFERENCE.md:102-112` shows a hand-written `markStatus` + `renderMarkdown` snippet
that `SKILL.md` simultaneously forbids ("close through `cli drain`, never by hand").
N26 fix candidate (a) — "`drain` and `verify` re-render the affected `.md` after writing"
— is unimplemented.

**And calling it today would make things worse.** `lib/ledger.mjs:401-415` still emits,
verbatim, `**Last entry: today.** Watcher healthy.` and ``Append-only. Watcher writes
drift rows; `/propagate drain` marks them done.`` Both false since 2026-08-14. Running it
would overwrite the two hand-written frozen-render banners in
`ManavDaehi/docs/PROPAGATION_LEDGER.md` and
`ManavDaehi/Manav-portfolio/docs/PROPAGATION_LEDGER.md` (commit `589c10a`), which are
currently the *most* honest ledger renders in the tree. The relative-date tripwire also
means the body differs from any committed copy on the passage of time alone, so the
idempotence guard at `:456-463` rewrites it about once a day forever.

**Measured 2026-08-17** — N26's 45 stale `open` rows are gone; do not "fix" that by
re-rendering:

| file | `\| open \|` rows |
|---|---|
| `Vipin Kaushik/docs/PROPAGATION_LEDGER.md` | 0 |
| `PanditPawanKaushik/docs/PROPAGATION_LEDGER.md` | 0 |
| `Keerti/Keerti-portfolio/docs/PROPAGATION_LEDGER.md` | 0 |
| `ManavDaehi/docs/PROPAGATION_LEDGER.md` | 5 (frozen historical render, banner says so) |

**Decide one of two, do not leave it as is:** (a) fix the three false lines, drop the
relative-date tripwire, and wire it into `drain`; or (b) retire `renderMarkdown`, delete
G40's prescription and `REFERENCE.md`'s snippet, and adopt ManavDaehi's frozen-banner
pattern everywhere. The present state — a renderer nobody calls, that would lie if
called, named by a gotcha as the remedy — is the worst of the three options.

## Smaller findings from the same 2026-08-17 sync

Recorded here rather than as separate issues; each is a docs/code disagreement, not a bug.

1. **`UNMATCHED` is `ACTIONABLE` in code and "do not fix" in data.** `lib/graph.mjs:52`
   puts `UNMATCHED` in `ACTIONABLE`, so `graph` lists edge `07d914bc`
   (`rules/discernment-checks.md → */docs/GOTCHAS.md`) as work — while
   `~/Documents/GitHub/.propagates.yml:38-61` documents it as a deliberate 0-of-N adoption
   gauge: *"Do NOT delete it to make the worklist green."* It blocks nothing (it is not in
   `UNSETTLED`, `:44`), so the honest resolution is an exemption in `isActionable`, or a
   distinct state. Until then every green run reads as 1-of-N remaining forever.
2. **G46 mis-describes the duplicate pair it records.** G46 and `lib/metrics.mjs:157-160`
   say `brand-system.md → components/README.md` was "declared twice with two restatements
   of the same reason". It was actually an **explicit path subsumed by a glob**
   (`website/components/**/*.md`) in the same source block. The distinction is
   operational: decoupling the wrong one of the two would have taken 26 edges with it.
   Resolved 2026-08-17 by decoupling the explicit entry.
3. **`docs/REFERENCE.md`'s `doctor` row is stale** — it still describes the pre-2026-08-14
   check set (launchd plist loaded, heartbeat age as a failure), with no mention of the v2
   event-store/reconcile checks or the `lib/metrics.mjs` expectations that actually fail.
4. **The `graph-integration` doctor check times out at 2s** on an `execSync("claude mcp
   list")`, and reports "status unknown". That is correct behaviour and should stay — but
   note `claude mcp list` health-checks ~30 remote servers and is documented in
   `rule:tool-priority` as taking tens of seconds, so the check can essentially never pass.
   **Do not fix this by raising the timeout**: a check that cannot distinguish "no
   integration" from "did not answer in time" is the G2 shape this project exists to avoid.
5. **`docs/LIFECYCLE.md` still lists N29 under "Machine — do first"**, though N29's own
   heading in this file reads **RESOLVED 2026-08-17**. Verified the same day:
   `~/.claude/skills/propagate/.propagates.yml` exists and `reconcile --all` resolves 9
   edges under it. The backlog table is the stale copy, not the issue.
