> Entry point: [`../skills/propagate/SKILL.md`](../skills/propagate/SKILL.md) · Index: [`README.md`](./README.md)

# Propagate — issue register

> **Triage pass, 2026-08-20.** Every entry marked RESOLVED or MOOT below carries the
> measurement or code path that closed it, not a judgement. **Nine of the twenty-five
> "open" issues turned out to be already closed** — mostly by the v1 watcher retirement
> (2026-08-14) and the v2 reconcile rewrite — and nobody had gone back to mark them. An
> issue register reporting work already done is the same failure as a check that cannot
> fail: it describes a state that is not real, and it costs whoever acts on it.
>
> **Not everything was re-verified.** `N19`, `N20`, `N22`, `N25`, `N26`, `N28`, `N30`,
> `N31`, `N35` were not re-measured in this pass and keep their existing status. Saying
> so is the point — a triage that silently leaves entries untouched is indistinguishable
> from one that checked and confirmed them.


> **Paths in entries below may predate 2026-08-20**, when `lib/` and `tests/` were
> grouped into directories. `docs/DECISIONS.md` 2026-08-20 carries the old→new map.
> Entries are not rewritten: the citation is evidence, and evidence is not edited.

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
corrupted one. Regression test: `tests/unit/ledger-activity.test.mjs`, *"a `manual` row is known, is
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

### N3 · Sequential ids cannot survive branches — **S1** — **RESOLVED 2026-08-20**

**RESOLVED 2026-08-20** — v2 `lib/edges/events.mjs:85` mints ids from `crypto.randomInt` over Crockford base32 — not sequential, so branches cannot collide.
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
`tests/unit/dedup-pathcheck.test.mjs`. Every status transition on 1,460 rows was written from outside the
skill. There is no supported close path.

*Fix:* throw on absent id; add a supported drain/close interface.

**Verified resolved, both halves:** `markStatus` (`lib/ledger.mjs:155-172`) now throws
`markStatus: no Event with id "…"` when the id is absent, and separately requires
`wontfix_reason` on a `wontfix` and `closed_by` on any terminal close. `cli.mjs drain`
(`cli.mjs:1594`, usage at `:24-29`) is the supported close path: lists open rows grouped by
`correlation_id`, closes by id or by group, and — because the same lock/reread machinery backs
it — a close that silently failed to persist would now surface as the thrown error above rather
than a quiet no-op. Landed in `60db5c6`.

### N5 · `hasOpenDuplicateDrift` cannot see `code_drift` — **S1** — **MOOT 2026-08-20**

**MOOT 2026-08-20** — `hasOpenDuplicateDrift`'s only caller is `watcher.mjs:247`, and the watcher was retired 2026-08-14 and refuses to run. The v1 ledger is frozen at 405 closed events, so the dedup window can no longer be reached.
`lib/ledger.mjs:121-142`: the loop's `if (r.type === "drift")` excludes `code_drift` from
`driftById`, and the `else if` excludes it from `statusById` too. Two reasons stack, so **all 136
`code_drift` rows are outside the dedup window** — every mtime bump appends a new row.

Visible today: `astroacharya/app/api/calendar.py` and `calendar_combined.py` each hold **3 open
rows** in the Vipin Kaushik ledger.

*Fix:* dedup on `(type, source, downstream-set)`.

### N6 · Glob `kind: code` edges silently never fire — **S1** — **RESOLVED 2026-08-20**

**RESOLVED 2026-08-20** — not by implementing glob-code firing (a larger change), but by the fix this entry itself specifies: `doctor` now lists every glob `kind: code` edge as **unenforced**. It found **7 live ones** on first run, four of them in `Manav-portfolio`, all of which had looked declared and never fired. Guarded by `tests/cli/doctor-glob-code.test.mjs`, with negative controls for concrete kind:code and glob prose so the warning cannot fire on the common case.
`lib/edges.mjs:184-190` logs and skips. `check` passes no logger (`cli.mjs:848` → `noopLogger`), so
the deferral isn't even printed. A doc declaring `path: lib/**/*.ts, kind: code` gets **zero**
coverage in both watcher and gate while looking declared.

Self-documented in five places (`SKILL.md:161,199-205,278`, `edges.mjs:161,216-218`,
the since-deleted `code-drift` watcher test) as "documented limitation, not a bug" — but the user-visible effect
is indistinguishable from a working edge.

*Fix:* until implemented, `doctor` lists glob-code edges as **unenforced**.

### N7 · A missing `PROPAGATE_SEARCH_ROOTS` reports healthy forever — **S1** — **RESOLVED 2026-08-20**

**RESOLVED 2026-08-20** — measured: a fresh `HOME=$(mktemp -d)` install exits **1** from `doctor`, and `SEARCH_ROOTS_DIAGNOSTIC` distinguishes `roots-missing` from `no-markers`.
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
(`com.tathya.propagate.watcher`, `com.tathya.propagate.digest`), and `tests/docs/skill-doc.test.mjs`
asserts every label in an executable context is actually installed, so this cannot silently return.
The `doctor`-prints-the-resolved-label half, previously called out as still open, is also now done:
`cli.mjs:645-648` prints `resolved label: ${LAUNCHD_LABEL}` explicitly tagged
`// N10 (doctor half)`, and the subsequent `launchctl list` check (`:651-652`) checks against that
same resolved label rather than a hardcoded string.

### N12 · Every `Affects:` line in `DECISIONS.md` parses to nothing — **S1** — **RESOLVED 2026-08-20**

**RESOLVED 2026-08-20** — `parseDecisions` tokenises `Affects:` correctly — proved the hard way when its own test rejected a DECISIONS entry I added without one, on 2026-08-20.
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
`docs/DECISIONS.md`, not only synthetic fixtures — `tests/docs/decisions.test.mjs` passes 4/4 today
precisely because its fixtures use the bare form the live file never uses.

### N13 · `PROPAGATE_SEARCH_ROOTS` does not scope state, so testing the watcher corrupts production — **S1** — **RESOLVED 2026-08-20**

**RESOLVED 2026-08-20** — `STATE_DIR` now defaults to `~/.propagate` and `STATE_DIR_EXPLICIT` distinguishes a set-and-resolved override from a defaulted one; `npm test` runs against a temp state dir. Commit `1f8ea73`.
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
`tests/portability/config-state-dir.test.mjs`'s "defaults unchanged" regression guard, which is the explicit
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
   `{ ok: false, error }` instead of writing — `tests/portability/plist-watch-roots.test.mjs` covers both the
   refusal and the unchanged N>0 write path. This alone would have prevented the incident.
3. `init` no longer calls `regeneratePlist`/`reloadLaunchd` at all (see N15's fix below) — the new
   `reload` subcommand does that job, explicitly and only when asked.
`tests/cli/init-reload.test.mjs` proves `init` never writes a plist file even when run unscoped-of-plist
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
next to `discovered 0 workspaces` as if both were success. `tests/cli/init-reload.test.mjs` covers both
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

### N18 · Source keys are never validated to exist — **S1** — **RESOLVED 2026-08-20**

**RESOLVED 2026-08-20** — `doctor` now stats every `sources:` key and fails naming any that does not exist, using the existing per-sidecar check reporting rather than a second mechanism. A source is deliberately NOT declare-ahead eligible: the edge fires when the source changes, so a missing source is an edge that is already dead. The live instance this entry cited in `astroacharya/.propagates.yml` has since been fixed — all eight of its source keys resolve — and the tree now reports zero. Guarded by `tests/cli/doctor-source-keys.test.mjs`.
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

### N21 · A glob matching zero files must report UNMATCHED, not let its edge vanish — **S2** — **RESOLVED by v2**

**RESOLVED by v2** — `UNMATCHED` is a first-class state in `lib/edges/reconcile.mjs` STATES and is ACTIONABLE in `lib/graph/graph.mjs` — exactly the explicit state this asked for.
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

### N23 · `WATCHER_LOG` is not test-scoped — `npm test` writes into the production log — **S2** — **impact moot 2026-08-14 (watcher retired)** — **RESOLVED 2026-08-20**
**Structurally closed 2026-08-22** — `watcher.mjs` and the four test files that imported it were deleted outright (plan §0a), so the module-level `WATCHER_LOG` binding no longer exists and the defect cannot recur.

**RESOLVED 2026-08-20** — measured: production `~/.propagate/watcher.log` does not exist after a full suite run; the suite writes to `$TMPDIR/propagate-test-state`. Commit `1f8ea73`.
Same family as N13/N14 (a scoping variable exists but isn't universally applied) — **not** already
closed by Phase B's `PROPAGATE_STATE_DIR` work, contrary to what that work's scope might suggest.
`PROPAGATE_STATE_DIR` *can* relocate `WATCHER_LOG` (`lib/config.mjs:143`, covered by
`tests/portability/config-state-dir.test.mjs`), but four test files (two under `tests/watcher/`,
two under `tests/unit/`, all deleted 2026-08-22 together with `watcher.mjs` — recoverable from
git history) imported functions from `watcher.mjs` directly and invoked
them without setting `PROPAGATE_STATE_DIR`, so any call that logs (`watcher.mjs`'s internal `log()`
at `:82-85`, which always writes to the imported `WATCHER_LOG` binding) appends into the real
`~/.claude/skills/propagate/watcher.log` during `npm test`. Verified 2026-08-13: the production log
carries 7,082 lines timestamped today, and a subset are attributable to test-triggered fires rather
than launchd's own 60s cadence — the two are currently indistinguishable in the log itself, which is
part of the problem: an incident investigator reading `watcher.log` cannot tell which lines are real.

*Fix:* the four test files above set `PROPAGATE_STATE_DIR` to a temp directory (matching the pattern
already proven safe in `tests/cli/init-reload.test.mjs`'s sandboxed acceptance test), or `watcher.mjs`'s
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
post-fix it does not (`tests/cli/check-injection.test.mjs`, 5 tests, including a legitimate-range
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

### N24 · `init` leaves a workspace that `doctor` immediately fails — **S2** — **RESOLVED 2026-08-22**

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

**RESOLVED 2026-08-22, and the diagnosis above was incomplete.** `init` had ALREADY been
creating the pair since the 2026-08-20 gate-4 fix — it is one of
`LEDGER_SCAFFOLDING_VERBS` (`lib/core/discovery.mjs:282`), so its own
`discoverWorkspacesSync` call reaches `ensureLedgerPair`. Two things were actually wrong:

1. **It created a SUPERSEDED layout, in both branches.** Measured on temp workspaces:
   no `docs/` -> `.propagation/ledger.*`; with `docs/` -> `docs/PROPAGATION_LEDGER.*`.
   Neither is canonical (`docs/REFERENCE.md` §"Propagation layout"), so **`init` could not
   produce the canonical layout at all**, and every stranger install minted a third
   layout while the 2026-08-21 consolidation was cleaning up the first two. This is the
   cause `docs/DECISIONS.md` recorded as contained but not removed — *"the location
   remains an accident of directory layout at first-write time; the guard contains the
   damage but does not remove the cause."* `makeWorkspaceRecord` now pins
   `propagation/` for the no-ledger-anywhere case only; the pinning rule is untouched, so
   nothing holding data moves. Measured after the change: **all 7 live workspaces already
   canonical, 0 relocated.**
2. **It never asserted the pair.** `ensureLedgerPair` is deliberately best-effort and
   silent, so a permission fault left no pair and `init complete.` printed anyway. `init`
   now names the missing files and exits 1 — verified against a read-only directory, and
   by mutation.

**Two tests were pinning the accident**, each naming it in its own comment ("the legacy
convention applies" / "the legacy `.propagation/ledger.{jsonl,md}` convention applies").
Both kept their real subjects — one workspace not two, and a fresh machine reaching
`doctor: all green`. That pairing is why this survived: the decision record said it was
wrong, and the tests said it was expected.

`.templates/NEW-PROJECT-CHECKLIST.md` §4's workaround ("verify the ledger files exist
afterwards — `init` confirms discoverable, not complete") is now stale and should be
dropped on its next edit; `init` confirms both.

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

**Progress 2026-08-22 — option 3, half.** `reconcile` and `verify` now accept
`--ref <ref>` / `--source-ref <ref>` / `--downstream-ref <ref>`, so a whole-project answer
CAN be derived for a named branch regardless of what is checked out, and the resulting
event records the ref of each side independently (`docs/DATA_MODEL.md` §10). What is still
missing is the part this issue is really about: **nothing yet compares a ledger ACROSS
refs, and no command warns that HEAD is not the repo's default branch.** Options 1 and 2
below are untouched, and option 1 remains the one-line honesty fix that should not wait.

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
> `tests/cli/verify-ordering.test.mjs` snapshots the event store byte-for-byte around
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
> **Regression cover:** `tests/unit/journal.test.mjs`. The test that asserted IGNORED
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

## N31 · S2 · **BLOCKED (on Phase D)** · `renderMarkdown` has no live caller, and would regress the tree if called

> **DUPLICATE OF N42**, filed five days apart on the same defect with different emphases —
> N31 on the false lines it would emit, N42 on the prose it would destroy. Neither entry
> knew about the other. Decide once, close both. (Recorded because I made the same mistake
> today, filing a new issue against a live `N46`; a register with two names for one defect
> is a register where one of them stops being findable.)

**Filed 2026-08-17**, same handover.

`renderMarkdown` is defined at `lib/ledger.mjs:391`. Verified callers, whole tree:
`watcher.mjs:499`, `:554`, `:699` — **retired 2026-08-14, refuses to run** — and
`tests/unit/ledger-render-staleness.test.mjs`. **`cli.mjs` never imports it.** `drain`'s close
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

**DEFERRED TO PHASE D, 2026-08-24 — and one of this entry's two arguments has expired.**

`Watcher healthy` is **gone from the renderer**: `grep -c "Watcher healthy" lib/edges/ledger.mjs`
returns 0, and the messages now read "drift is derived on demand, so a long gap may just mean
nothing has been run." The "calling it would write falsehoods" half of this entry is stale.

Still true, re-measured the same day: the relative-date tripwire (7 `daysAgo` references, so the
output differs on the passage of time alone), and the prose — see N42 for the 39-line figure.

The 9 files across the tree still carrying `Watcher writes drift rows` are **historical**: no
code emits that string anywhere, and the six ledger pairs created 2026-08-24 are clean. Do not
sweep them expecting to find a live writer.

**Full option analysis and the decision live in N42.** See there.

**Original text preserved below.** Decide one of two, do not leave it as is: (a) fix the three
false lines, drop the relative-date tripwire, and wire it into `drain`; or (b) retire
`renderMarkdown`, delete
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

### N32 · `check` cannot gate a repo that has a sidecar but is not a workspace root — **S1** — **RESOLVED 2026-08-19**

**`check` silently matched nothing in this very repo, and would in any repo shaped like it.**
Discovery works, the edges are evaluated by `reconcile`, `graph` lists them — only the
commit-time gate is dead, which is the quietest failure available: a gate that never fires
looks exactly like a repo with no couplings.

**Measured 2026-08-19.** `lib/metrics.mjs` is a declared source with two downstreams
(`docs/OBSERVABILITY.md`, `docs/GOTCHAS.md`). Staging it and running `check --staged` in
`~/.claude/skills/propagate` printed nothing, exit 0. The same command in
`Vipin Kaushik/marketing-intel` correctly warned. Its two edges had been DRIFTED for the whole
session while six commits landed.

**Mechanism.** `check()` derives `repoRoot` from `git rev-parse --show-toplevel`, which always
reports the **real** path. This repo is reached by discovery through
`~/Documents/GitHub/propagate-skill` → `~/.claude/skills/propagate` (a markered symlink,
followed per N29). `resolveChangedFile()` then matches the changed file against
`WORKSPACES[].root` by prefix, and:

  - the file's real path is not under any workspace root — it is inside the hub workspace
    only *via* the symlink;
  - `propagate-skill` is not itself a workspace root (its `.propagates.yml` carries no
    `workspace: true`, correctly — the 2026-08-18 "one ledger" decision).

So there is no candidate to match, and `cd`-ing to the symlink path does not help: git resolves
it before `check` ever sees it.

**Two fixes that do NOT work**, both tried and reverted the same day so nobody repeats them:
  1. Comparing realpaths on both sides. The workspace root is not a symlink; the *file* is
     reachable only through one. Real→real can never bridge that.
  2. Running the hook from the symlink path. `git rev-parse --show-toplevel` returns the real
     path regardless of cwd.

**What would work** — resolution must map the real path *into* the workspace's namespace, using
the symlinks discovery already followed. `doctor` reports "symlinked dirs seen", so the
information exists; it is simply not available to `resolveChangedFile`. Export the followed
symlink map from discovery and consult it as a fallback.

**Not fixed here on purpose.** A gate that cannot fire was installed in this repo and then
removed rather than left as decoration (GOTCHAS G1). The seven Vipin Kaushik repos are
unaffected — verified: `marketing-intel` still warns correctly.

**Resolved 2026-08-19.** `resolveChangedFile` now translates real -> link as a fallback:
when the lexical match fails it realpaths the changed file and, for each workspace, checks the
symlinked children of that root (depth 1, cached) for one whose target contains it, then rewrites
the prefix and retries. That produces `propagate-skill/lib/metrics.mjs` — exactly the key
`buildEdgeMap` emits. Depth 1 is deliberate: every symlinked repo here is an immediate child of a
search root, and a deeper scan would cost syscalls on every unmatched file for a case nobody has.

The gate is re-installed in this repo and verified firing on the same command that printed nothing.
Covered by two tests in `tests/cli/check.test.mjs` — the symlink case **and** a negative control proving
the symlink is what makes it findable, mirroring `tests/unit/journal.test.mjs:44-63`.

**Related:** GOTCHAS **G48** (an enforcement point that does not watch itself) — this was the
fourth instance in that entry, and is now the first one closed.

---

### N33 · Three `lib/*.mjs` carry a literal NUL byte and are invisible to code search — **S2** — **RESOLVED 2026-08-19**

**Filed 2026-08-19.**

`lib/events.mjs:120`, `lib/frontmatter.mjs:128,152` and `lib/graph.mjs:344` each build
a composite map key with a NUL separator, written as a **raw byte** rather than the
`\u0000` escape. The separator is correct and must stay (see G49 — removing it makes
`a/b`+`c` and `a`+`b/c` collide, a correctness bug in the edge-id hash and the
duplicate-pair index). The raw byte is the defect.

Effect: the `grep` shim passes `-I`, so all three files are skipped **silently, exit
1** — identical output to "the symbol is not in this file". Plain `grep -n` prints
`Binary file … matches` and suppresses the lines. `file` calls them `data`.

**Severity S2, not S3.** These are not obscure files: `events.mjs` owns the edge-id
derivation and `graph.mjs` owns the worklist. Every code search over this repo — by a
person or an agent — has been silently missing them, and on 2026-08-19 that nearly
produced the published claim that `graph.mjs` does not implement `fixOrder`.

**Fix:** replace each literal NUL with the six-character escape `\u0000`.
Runtime-identical — same string, same hash, same keys — so no behaviour changes and
no baseline moves. Guard with `tests/portability/no-literal-nul.test.mjs` asserting no tracked
non-vendor file contains byte 0, so the next composite key cannot reintroduce it.

**Verification that the fix is a no-op at runtime:** hash the three key-building
expressions before and after and assert equality, rather than trusting that an escape
"obviously" produces the same bytes. `lib/events.mjs`'s edge ids are persisted in the
append-only event store; if that derivation moved, every existing event would orphan.
That is the load-bearing check, and it is the reason this is not a blind sed.

**RESOLVED 2026-08-19.** `tests/watcher/edge-id-stability.test.mjs` was written and confirmed
GREEN *before* the edit, freezing three edge ids captured from the running pre-fix
code (`3340074a`, `dab23bf6`, `39cf8b39`) plus two collision assertions proving the
separator still separates. The rewrite ran on bytes, never on a decoded string, and
aborted unless each file grew by exactly 5 bytes per NUL and contained none after:
`events.mjs` 14030→14040 (2), `frontmatter.mjs` 7090→7100 (2), `graph.mjs`
18557→18562 (1). All three ids unchanged. The original symptom is gone — `grep -c
fixOrder lib/graph.mjs` now returns 3 where it returned nothing, and `file` reports
UTF-8 text for all three. 696 pass, 0 fail.

Guarded by `tests/portability/no-literal-nul.test.mjs` across every tracked non-vendor file, so a
future composite key cannot reintroduce it. Do NOT re-capture the frozen ids to make
the stability test pass — that converts the alarm into a rubber stamp.

---

### N34 · Rule restatements — 15 reported, 7 real, 0 remaining — **S2** — **RESOLVED 2026-08-19**

**Filed 2026-08-19**, by `rules check` the first time it could actually see.

Three of the sixteen live rules had **dead detectors**: `nextjs-dev-server-port`,
`plan-mode-3-files` and `state-and-decisions` all declare fingerprints containing a
backslash escape, and the old frontmatter parser stripped quotes without unescaping,
so `"STATE\\.md"` reached the regex engine as `STATE\\.md` — matching a literal
backslash, therefore nothing. The old selftest passed all three because it tested the
fingerprint against the whole file, whose frontmatter contains the fingerprint text.

With a real YAML parse the count goes **2 → 15 restatements across 13 files**:

| Rule | Files |
|---|---|
| `nextjs-dev-server-port` | 8 |
| `plan-mode-3-files` | 4 |
| `skill-routing` | 2 |
| `state-and-decisions` | 1 |

Two spot-checked by hand and both true positives:
`PanditPawanKaushik/CLAUDE.md:45` restates STATE.md/daily-open with zero
`rule:state-and-decisions` references, and `Tathya/CLAUDE.md:31` restates the 3+-files
plan-mode rule.

**Not fixed here, deliberately.** These are 13 files across many repos, several with
concurrent uncommitted work; converting them is its own change under
`rule:plan-mode-3-files` and `rule:never-commit-unless-asked`. What this issue
records is that the count was never 2 — the detector was blind, and the number it
reported was the number it could see.

**RESOLVED 2026-08-19 — and 15 was the instrument again, not the tree.** Reading all
fifteen sites before touching any of them found **7 genuine restatements, not 15**. Two
separate over-counts, both now fixed:

**The `nextjs-dev-server-port` fingerprint matched the helper script's NAME.** It was
`next-dev\.sh|PORT_DEFAULTS|hardcode.{0,20}-p 3000`, so every project documenting its own
dev command was flagged — `Manav-portfolio:12`, `marketing-intel:30`,
`VipinKaushik-mb:37`, `Keerti-portfolio:37`, `SSJK-mb:43`, `astroacharya:114`, and the
hub's own repo-map row at `CLAUDE.md:46`. A project stating its port and its script is
**describing compliance**, which is what a project `CLAUDE.md` is for; only a file
asserting the *general pattern* is restating. Tightened to require the generalised claim:
**8 files → 1**, and that 1 was the real one. Verified in both directions — the selftest
still passes (the fingerprint matches its own body via `PORT_DEFAULTS`), and a scratch
file carrying the generalised sentence is still flagged. A fingerprint narrowed until it
matches nothing is the failure this whole mechanism exists to catch.

**Worktree checkouts were counted as independent files.**
`Motherboard/.claude/worktrees/hardcore-villani-778ff0/CLAUDE.md` is a **detached-HEAD**
checkout — on no branch, so an edit there could never merge. The finding was real and the
work it implied could not land. `findCandidateFiles` now skips `worktrees`/`.worktrees`
and **reports the count** rather than silently narrowing its own scope.

**The 7 genuine restatements, all converted** (edited, not committed — these trees carry
concurrent work):

| Rule | File | Kept |
|---|---|---|
| `plan-mode-3-files` | hub `CLAUDE.md`, `Motherboard/CLAUDE.md`, `Tathya/CLAUDE.md` | — |
| `skill-routing` | `Khushboo/CLAUDE.md`, `Rishabh/CLAUDE.md` | whole 12-row table replaced; the canonical rule has **21** rows, so readers gain 9 routes |
| `nextjs-dev-server-port` | `PanditPawanKaushik/CLAUDE.md:62` | the workspace's `dev:legacy`/`start:legacy` fallbacks |
| `state-and-decisions` | `PanditPawanKaushik/CLAUDE.md:45` | local paths, the `Affects:` tag rule, `scripts/decisions-check.sh` |

`propagate rules check` now reports **0 restatements, exit 0** — the first time it has
been able to say that truthfully, since three of its detectors were dead until Phase 5 and
one was over-broad until now.

**Both skill-routing copies were NARROWER than the canonical rule**, which is the argument
for pointers rather than copies, restated by evidence: the copy drifts by losing content,
silently, and nobody notices because the copy still looks complete.

---

### N35 · `selftest` proves self-match, not wild-match — 7 rules are unexercised — **S2** — **OPEN**

**Filed 2026-08-19**, found while widening `never-commit-unless-asked`.

`selftest` asserts every fingerprint matches **its own rule body**. That body is written
in the rule's own house style, so the check says nothing about whether the fingerprint
can fire on how the claim is written **in the wild** — and those differ in exactly the
way that matters.

**The proven instance.** `never-commit-unless-asked` was `[Nn]ever commit unless`. It
matched **zero files across 47 CLAUDE.md**, while passing selftest, because the rule
body bolds the whole sentence (`**Never commit unless explicitly asked.**`) and every
real restatement bolds only the first half (`- **Never commit** unless explicitly
asked`). Two `*` characters, and the detector had never fired since it was written.
`overrideRe` already tolerates exactly this markup, for exactly this reason — the
tolerance existed and was not applied here.

Fixed for that rule: markup-tolerant, still anchored on `unless|without` so
`Rupali/Obsidian/CLAUDE.md`'s "Never commit `Scripts/config/…json`" — a project fact
about one file, not a restatement — stays excluded. 0 files → 2, both converted.

**The open part: 7 of 16 rules are `unexercised`** — fingerprint matches nothing AND
nothing references them:

`adversarial-review-reads-the-ledger`, `browser-only-when-asked`, `delegation-criteria`,
`discernment-checks`, `every-project-carries-gotchas`, `model-routing`,
`no-waiting-on-deploys`, `safety-flag-needs-a-test`.

**This is NOT a claim that those fingerprints are broken.** Several are recent, and a
rule with genuinely nothing restating it produces the identical output. That is the
whole problem: **unknown and clean are indistinguishable**, which is the failure this
skill exists to catch, sitting in its own newest component.

`propagate rules list` now prints restated/referenced/status per rule and names the
unexercised count, so the unknown is at least visible. Making it *decidable* needs a
per-rule probe — a known-positive sample of how each claim is actually phrased — which
is judgment work, one rule at a time, and is what this issue tracks.

**Do not "fix" this by widening fingerprints speculatively.** The opposite error is
already recorded: `nextjs-dev-server-port` matched the helper script's name and produced
7 false positives (N34). Widen only against a real sample.

---

**RE-MEASURED 2026-08-24, and this entry's own list was stale.** Run `propagate rules list`
rather than trusting the names below:

* **6 unexercised, not 7:** `adversarial-review-reads-the-ledger`, `browser-only-when-asked`,
  `discernment-checks`, `enforcement-watches-itself`, `every-project-carries-gotchas`,
  `no-waiting-on-deploys`.
* `delegation-criteria`, `model-routing` and `safety-flag-needs-a-test` are **no longer**
  unexercised — they now read adopted or firing. `enforcement-watches-itself` newly is, and
  is not in the list above. Four of the eight names were wrong within five days, which is the
  ordinary rot rate for a count in a state file and the reason `rules list` exists.

**A SHARPER DEFECT, found while measuring this one and fixed in the same pass.** `rules
check` reported **0 restatement(s) across 0 file(s)** while `rules list` reported **25**
matches — two commands answering one question with 0 and 25.

Cause: `checkRules` carried

```js
if (raw.includes(`rule:${r.id}`)) continue; // references it — clean
```

A blanket exemption. Sound in intent — a file pointing at the canonical rule is doing the
right thing, and a rule id beside a hub-local fact is not a copy — but it excused a file that
references a rule in one line and keeps a stale copy in another. **That is the most likely
shape, not a hypothetical:** nobody deletes the copy and adds the pointer in the same edit,
so "pointer added, copy left behind" is precisely what a half-finished conversion looks like,
and it is how nine divergent copies of `tool-priority` came to make four mutually exclusive
claims.

Measured: **19 files restate a rule they also reference** — `tool-priority` 11,
`secrets-source-of-truth` 6, `safety-flag-needs-a-test` 1, `state-and-decisions` 1. None was
reported.

They are now **counted and printed, per rule, and still not failed**. Flipping nineteen files
to failures in one commit is how a gate gets bypassed rather than fixed; the exit code stays
quiet and the number now exists. `referencedRestatements` is present-and-empty on a clean
tree, never absent.

**STILL OPEN:** the per-rule known-positive probe this issue was filed for. Nothing here
proves any of the six unexercised fingerprints can fire on real phrasing — that remains
judgment work, one rule at a time, against a real sample. What changed is that a second way
of being blind was closed, and the stale names above were corrected.

---

### N36 · The commit-time gate is silently dead for any repo under a symlinked path — **S1** — **RESOLVED 2026-08-20**

**Found by running the edge lifecycle end to end**, which no unit test did. One fixture —
a workspace with a declared `spec.md -> docs/impl.md` edge, source staged, downstream
deliberately stale — behaved two ways depending only on where it lived:

| Repo path | `check --staged` |
|---|---|
| `/var/folders/…` (macOS tmpdir, a symlink to `/private/var/folders`) | **nothing, exit 0** |
| `$HOME/…` (no symlink in the path) | `spec.md → verify: docs/impl.md` |

`reconcile` reported **DRIFTED in both**. Discovery, reconcile and graph were all
correct; only the gate was dead — N32's exact signature in a different shape.

**Cause.** `check` injects `git rev-parse --show-toplevel`, which always returns the
REALPATH (`/private/var/...`), while discovery holds the lexical path (`/var/...`). The
prefix test in `resolveChangedFile` then compares two spellings of one directory and
finds no match, and the miss is dropped silently at the call site.

N32's fix does not cover this: it scans symlinks that are CHILDREN of the workspace root.
Here the root's own ANCESTOR is the symlink.

**Fix.** A third strategy in `resolveChangedFile`, tried only after the existing two
miss: compare `realpath(changed)` against `realpath(ws.root)`. Deliberately last, and
deliberately not a replacement — the realpath-on-both-sides approach reverted during N32
failed because it was proposed INSTEAD of the real→link translation, which N32's case
needs. Ordering keeps both working, and `tests/cli/check-symlinked-root.test.mjs`
asserts all three cases including a negative control, so fixing one by breaking the other
fails loudly.

**Verified both ways after the fix:** the `/var/folders` fixture now fires, and
propagate's own symlink-reached repo still resolves through the link
(`propagate-skill/lib/report/metrics.mjs → …`), not through its realpath.

**Reach.** Any repo whose path traverses a symlink — macOS temp dirs, `/home` symlinked
to another volume, a checkout under a linked directory. The gate reports success while
enforcing nothing, which is the failure this skill exists to catch.

---

### N37 · propagate declares 3% of itself, and the god-file is why — **S2** — **PARTIALLY RESOLVED 2026-08-20**

Found by an adversarial pass ahead of the public port, per
`rule:adversarial-review-reads-the-ledger` (read the sidecar before the artifacts).

**Measured:** 5 declared sources against 163 tracked files, and **8 of 9 own edges
`NEVER_VERIFIED`**. `cli.mjs` — 4,694 lines, the entire CLI surface — undeclared. The tool
reported the tree healthy while 97% of itself had never had a coupling review. That is the
rule's own headline case, occurring in the tool the rule was written for.

**Partially closed:** 9 sources now (VERSION's three-way manifest fan-out,
`propagates.schema.json` → SKILL.md + REFERENCE, `lib/core/setup.mjs` → REFERENCE +
SKILL.md, `lib/rules/rules-check.mjs` → SKILL.md), 17 own edges.

**Deliberately still open: `cli.mjs` → `docs/REFERENCE.md`.** The coupling is real. The
edge would be worse than the gap. Measured over 30 days: **cli.mjs changed in 46 commits,
REFERENCE.md in 7.** A file-level edge fires 46 times to be right about 7 — a 6.5:1
false-positive rate, and a check people learn to ignore has failed more completely than
one that was never written. Same shape as N6, where an edge that could not fire still read
as declared.

**The god-file IS the coverage problem.** propagate's model is file-level, so a 4,694-line
file cannot carry a precise coupling. The three edges added today were declarable
*because* their modules are small and stable. Closing this properly requires D7 from the
reviewed plan — moving command bodies into lib modules — after which
`lib/core/sync.mjs → docs/REFERENCE.md` is precise and cheap.

**Do not close this by declaring the noisy edge.** Improving the coverage count by adding
an edge that cries wolf would trade a visible gap for an invisible one, which is the
trade this register exists to prevent.

---

### N38 · The private→public coupling has no watcher — `release --check` step 3 is a procedure, not a check — **S2** — **BLOCKED** (precondition unmet, re-verified 2026-08-24)

Raised while defining release mechanics
(`~/.claude/plans/status-temporal-plum.md` §4, "named, deferred, not faked"). Recorded
so a future pass does not read `make-public --check` passing as evidence the two-repo
coupling is watched — that claim was drafted once already in this plan's first pass
and caught in adversarial review before it shipped (A3 in the plan file): the draft
declared `VERSION → docs/RELEASE.md` and called the cross-repo problem closed. That
edge is within THIS repo; it says nothing about the repo that does not exist yet.

**The actual coupling.** This private working copy (real names, real paths, internal
docs) and the eventual public release copy (scrubbed, no git history in common) must
stay in sync by hand, via `bin/make-public.mjs`, run by a person, at a time of their
choosing. Nothing fires if that scrub goes stale relative to a code change — there is
no edge, so there is no drift to detect.

**Why it cannot be declared today.** A cross-repo edge is bounded by
`cross-allow.yml`'s `partner_roots`, which is `[]` by design (empty is the safe
default: an unconfigured install permits no cross-repo edge). Declaring
`propagate-skill → propagate` today would need `partner_roots` to name the public
repo's path — and the public repo does not exist. There is nothing to point at.

**What stands in for it, and why that is weaker than it sounds.**
`docs/RELEASE.md` step 3 (`node cli.mjs release --check`, gate `make-public-check`)
runs the real scrub against the real forbidden-pattern list and refuses to report
success without a complete identity map. That is real coverage of "does the scrub
produce a clean tree right now" — but it is a thing a human has to remember to run,
not a thing that fires on the triggering change the way a declared edge would. The
distinction that matters: a propagate edge tells you a *specific* file moved out of
sync with a *specific* downstream; `release --check` only tells you "as of this
invocation, nothing forbidden survives the current scrub of the current tree." A
change landing between releases produces no signal either way.

**Close condition.** Once the public repo exists and its root is added to
`cross-allow.yml`'s `partner_roots`, declare the edge for real — plausibly something
like `cli.mjs`/`lib/**` (or a narrower set, per N37's god-file lesson) →
the corresponding public-repo paths, `kind: cross-repo`. Until then this entry is the
honest record that step 3 is a procedure a human runs, not a coupling propagate
watches, and `release --check` passing must not be read as more than that.

**Re-verified 2026-08-24 — the precondition is still unmet, measured not assumed:**

| | |
|---|---|
| `Rupali59/propagate` | `"visibility": "PRIVATE"` |
| a public propagate repo | absent from `gh repo list --visibility public` (20 repos) |
| `cross-allow.yml` `partner_roots` | `Motherboard`, `Tathya`, `SSJK-mb` — no public propagate |

**Relabelled OPEN → BLOCKED, and the distinction is the point.** "Open because nobody
did it" and "open because it cannot be done yet" are different facts, and a register that
renders them identically is the same conflation this repo keeps paying for. Nothing here
is waiting on effort. The trigger is external: the public repo coming into existence.

**Do not close this by declaring the edge against a path that does not exist,** and do not
close it by widening `partner_roots` to make the declaration validate. The entry above
records that exact draft being caught in adversarial review once already.


### N39 · A subagent's unscoped `bootstrap --apply` wrote 7 events to the live store — **S2** — **ACCEPTED, NOT REVERTED**

**2026-08-20.** A Phase 2 lane debugging a dirty-tree test ran `bootstrap --apply` without
setting `PROPAGATE_SEARCH_ROOTS` / `PROPAGATE_STATE_DIR`. It hit the real search roots and
the real store, appending **7 events** (1347 → 1354) against propagate's own edges:
`lib/core/setup.mjs`, `VERSION` ×3, `lib/graph/graph.mjs`, `lib/report/metrics.mjs` ×2.

The lane then attempted `cp` + `head -n 1347 > tmp && mv` to truncate the store back. **The
permission classifier blocked it and nothing was applied** — no bytes were lost, no backup
was written, the file stayed at 1354.

**Why this was ACCEPTED rather than reverted**, on the maintainer's decision:

- All 7 carry `reason: "baseline-from-git: co-committed at <sha>"` — they are
  **evidence-backed**, produced by the mechanism designed to produce exactly them.
- All 7 edges had **zero prior events** (`NEVER_VERIFIED`). Nothing a human had open was
  closed; the edges moved from unverified to baselined on real git evidence.
- Truncating an append-only store to delete evidence-backed events is the more damaging
  act. It would have been the **fourth** violation of append-only in this repo's history and
  the third time done as a remedy — see `rule:safety-flag-needs-a-test`.

**How it differs from the 2026-08-17 incident** that rule documents: that one appended
events asserting verifications nobody performed *and nothing evidenced*, and silently closed
**3 real worklist items**. This one closed nothing and every event has evidence. The defect
here is **authorization, not truth** — nobody chose to baseline propagate's own repo at that
moment.

**The route, which is the actual defect:** `--apply` was set deliberately, so no flag gate
would have helped. What was missing is that a test-time invocation of the real CLI defaults
to the real roots and the real store. See `docs/GOTCHAS.md` **G54**.

**Attempted fix 2026-08-21, and it is BLOCKED — see N40.** Scoping `bootstrap` to propagate
alone requires a narrower `PROPAGATE_SEARCH_ROOTS`, and under any narrower root every edge
gets a different id, so the run would have created duplicates rather than baselining the
real ones. Adding `workspace: true` to propagate's sidecar was tried and reverted: it left
`doctor` red (no ledger) and did not unblock scoping, because edge identity is tied to the
absolute access path, not to the workspace.

**Current state, measured 2026-08-21:** propagate's 17 own edges are **8 CLEAN, 9
NEVER_VERIFIED, 0 REVERSED**. The 2 formerly-REVERSED edges were resolved by hand
(`d1ae5ac0` both-reconciled, `0775c32e` no-change-needed). The 9 never-verified stay
blocked on N40.

### N40 · Edge identity is tied to the absolute access path, so the same coupling has different ids by route — **S1** — **PARTIALLY RESOLVED 2026-08-22**

**PARTIALLY RESOLVED 2026-08-22.** The downstream half is now minted as a repo-relative node id
(`lib/edges/reconcile.mjs:301`), with the two concrete-path matchers in `cli.mjs` moved to the same
form; the unmatched-glob identity still keys on the pattern text and is unchanged. `edgeId` itself is
untouched, so `tests/watcher/edge-id-stability.test.mjs` stays green — which exposed the real gap:
that test freezes the HASH and cannot see a change to what the hash is FED, though the consequence is
identical. `tests/watcher/edge-id-mount-independence.test.mjs` now asserts the property instead of the
derivation, and was mutation-checked (stubbing `toNodeId` to return the absolute path turns it red on
the N40 assertion specifically).

**Residual, deliberately not fixed:** `node_id` still embeds `basename(repoRoot)`, so a checkout
*renamed* on disk (`propagate-skill` -> `propagate`) still mints new ids. A stable repo identifier needs
a decision about repos with no remote — larger than this change, and tracked here rather than silently
claimed as done.

**Note on the consolidation merge:** fixing this does **not** preserve edge history across the planned
subtree merge. That move changes the repo-relative path itself (`docs/X.md` -> `skills/propagate/docs/X.md`),
so ids change regardless of how identity is derived. Orphaning there is accepted and recorded in
docs/DECISIONS.md rather than mitigated.

**2026-08-21.** `edgeId(nodeId, downstreamPath, why)` (`lib/edges/events.mjs:117`) hashes the
**absolute** downstream path (`lib/edges/reconcile.mjs:297`), and `nodeId` is
`basename(repoRoot):relPath` where `repoRoot` is the path **as traversed**, not realpath'd
(`lib/edges/reconcile.mjs:82-87`).

So one repo reached by three routes yields three disjoint edge sets. Measured on propagate's
own 17 edges:

| Route | `node_id` prefix | ids |
|---|---|---|
| `~/Documents/GitHub/propagate-skill` (hub symlink) | `propagate-skill` | the store's — e.g. `79b71dbb` |
| `~/.claude/skills/propagate` (real dir) | `propagate` | all 17 different |
| `/tmp/<x>/propagate-skill` (same basename, different mount) | `propagate-skill` | **still all 17 different** |

The third row is the important one: **matching the basename is not sufficient**, because the
absolute downstream path is also hashed. Only the exact original root reproduces the ids.

**What it cost, nearly.** Fixing propagate's partial baseline (N39) meant scoping `bootstrap`
to propagate alone, which requires a narrower `PROPAGATE_SEARCH_ROOTS`. Under any narrower
root every edge reads `NEVER_VERIFIED` — not because it is, but because it is a *different
edge*. The dry run reported `17 edges NEVER_VERIFIED · 8 baselineable` with full confidence.
Applying it would have written 8 baselines against duplicate edges and left the real 17
untouched, **silently doubling propagate's edge set**. Caught only by diffing the id lists
against a pre-change snapshot.

**Consequences beyond this incident:**
- `bootstrap` cannot be scoped to one workspace when several share a search root — its only
  scoping mechanism changes edge identity.
- Moving a checkout, or reaching it through a different symlink, orphans every verification
  in it. The events remain; nothing matches them.
- This is the same family as **N36** (the commit gate dead under symlinked paths), which was
  fixed with a realpath-pair strategy in `resolveChangedFile`. Edge identity has the same
  defect and no such fix.

**Not fixed here, deliberately.** Any fix re-keys existing edges — realpath'ing `repoRoot`
would change `nodeId` for every edge reached via a symlink, and making `downstreamPath`
repo-relative would re-key all 801. That is a migration (close-and-re-emit, never rewrite),
not a patch, and it needs its own plan.

**Interaction with N39:** propagate's own repo therefore stays partially baselined — 9
`NEVER_VERIFIED`, 6 `CLEAN`, 2 `REVERSED`. The mechanical fix is blocked until this is
resolved or `bootstrap` gains a per-workspace filter that does not go through search roots.

### N41 · ~~S2~~ · **RESOLVED 2026-08-24** · Cross-branch dedupe silently discarded a differing disposition

**2026-08-21.** `migrate-ledger --all-refs` dedupes rows on `(type, source, timestamp)`
because ledger ids are per-file and meaningless across refs. When the same logical row
carries a **different final status** on different branches, the dedupe keeps whichever ref
sorts first (`main` → `master` → checked-out → alphabetical) and discards the rest **with no
report**.

That is the semantic-conflict case the office-hours design named `CONTESTED`
(`docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md`): *"Branch A verifies edge E as
`propagated`; branch B verifies the same edge as `wontfix`. Union storage faithfully
preserves both, and the ledger now holds two contradictory human decisions about one edge."*

**Measured across every multi-branch sub-project ledger in the tree — exactly one live
instance:**

```
SSJK-mb  docs/CLAUDE.md row
  feat/impersonate-lucide-icons : open
  feat/r1-dashboard             : done
  feat/r1-redis-queue-substrate : done
  fix/passkey-bootstrap         : done
  main                          : done
```

`Manav-portfolio`: 3 rows on more than one branch, 0 contested. `Keerti-portfolio`: 0 of
either. So the mechanism is needed and the current exposure is one row.

**Why it is S2 and not S1:** the discarded value is currently the minority one on an
unmerged feature branch, and the majority (including `main`) agrees. The defect is that
this is decided by sort order rather than by a human, and reported nowhere.

**What it should do**, per the maintainer 2026-08-21 — *"like git workflow, decisions
should be amended and reconciled if differentiated"*: a collapse that spans differing
dispositions must be surfaced as contested and reconciled deliberately, not resolved by
ordering. `docs/deferred/…` D5 already settled the shape: **`contested` is a flag on the
row, not a ninth state** — the edge keeps its real content state and carries the conflicting
dispositions alongside.

**RESOLVED 2026-08-24.** `flattenAndDedupe` now folds each ref's `status_change` rows into a
per-ref final status BEFORE the duplicate filter drops them — which is precisely why the
minority disposition used to vanish without trace. Where the refs disagree, the migrated row
carries a `contested: [{ref, status}]` flag and `migrateLedger` returns a `contested` list;
`migrate-ledger` prints it loudly, separately from the collapse count, because a collapse is
bookkeeping and this is two humans disagreeing about one edge.

**A FLAG, NOT A NINTH STATE**, per D5. The row still migrates and keeps its own content state.

**Premise re-measured independently before building** (`rule:discernment-checks` §7), not
taken from this entry: exactly one contested row in `SSJK-mb`, `source=CLAUDE.md`,
`ts=2026-05-25T13:49:35.821Z`, `open` on `feat/impersonate-lucide-icons` against `done` on the
other four. The live dry run now reports exactly that.

`contested` is present-and-empty in ref mode when the refs agree, and empty in plain mode where
the question cannot arise — never absent, so a caller reading `.length` need not distinguish
"none" from "this build does not report them".

**No longer blocks** sweeping `SSJK-mb` with `--all-refs`.

### N42 · `renderMarkdown` has no live caller, and the file it renders is hand-written — **S2** — **BLOCKED (on Phase D)**

> **DUPLICATE OF N31.** One defect, filed twice, five days apart. This entry carries the
> decision and the full option analysis; N31 carries the earlier false-lines argument, one
> half of which has since expired.

**2026-08-21.** `renderMarkdown` (`lib/edges/ledger.mjs`) now groups rows under per-branch
headings, giving `source_worktree` its first reader. **Nothing calls it.** Its only caller
is `watcher.mjs`, retired 2026-08-14. So branch nodes exist in the `.jsonl` and are invisible
in the `.md` a human reads — `docs/GOTCHAS.md` G48 / `rule:enforcement-watches-itself`,
in freshly-written code.

It cannot simply be wired up. The rendered `.md` files now carry **hand-written prose**:
`ManavDaehi/docs/PROPAGATION_LEDGER.md` opens by explaining why it is frozen, and both
`Manav-portfolio`'s and `SSJK-mb`'s carry uncommitted editorial corrections. Regenerating
would destroy them.

The file is doing two incompatible jobs — machine-rendered table and human explanation —
which is the conflation `rule:state-and-decisions` names: *"a file that is half
machine-refreshed and half hand-written reads as one thing."*

---

**DEFERRED TO PHASE D, decided 2026-08-24.** Phase D freezes the v1 ledger, and a frozen
ledger's `.md` is a historical artifact by definition — so D determines the answer.
Deciding it now risks deciding it twice.

**Re-measured before deferring, so D inherits facts rather than assertions:**

| Claim | Command | Result |
|---|---|---|
| emits `Watcher healthy` | `grep -c "Watcher healthy" lib/edges/ledger.mjs` | **0 — expired**, messages rewritten to "drift is derived on demand" |
| date tripwire | `grep -c daysAgo lib/edges/ledger.mjs` | **7 — live.** Output differs on the passage of time alone |
| prose at risk | `wc -l ManavDaehi/propagation/ledger.md` | **50 lines, 39 of them prose** explaining why the file is frozen |
| stale watcher text in the tree | `rg -l "Watcher writes drift rows"` | **9 files, historical** — no code emits it; the six pairs created 2026-08-24 are clean |

So the live objections are **only** the tripwire and the prose. The "it would write
falsehoods" argument is gone.

**The four options, so D does not re-derive them:**

| | For | Against |
|---|---|---|
| **(a)** fix + wire into `drain`/`verify` | `.md` stops rotting; `source_worktree` branch grouping reaches a reader for the first time; the two docs that prescribe it become true | destroys ManavDaehi's 39 lines and the `Manav-portfolio` / `SSJK-mb` corrections unless (c) lands first |
| **(b)** retire it | removes provably dead code and a documented-but-forbidden path; matches derive-on-demand; where D lands anyway | `.jsonl` becomes the only machine view and nobody reads it by eye; branch grouping stays invisible |
| **(c)** split machine table from prose | one job per file; regeneration safe by construction | a third artifact per workspace, on a layout standardised 2026-08-24 |
| **(d)** marked-region render | one file, prose safe, machine part fresh; `collect.sh` precedent | **RULED OUT** — `rule:state-and-decisions` forbids exactly this, and #25 records the marker splice silently no-opping when the markers are absent |

**THE COST OF DEFERRING, stated rather than hidden:** `docs/GOTCHAS.md` G40 and
`docs/REFERENCE.md:193` continue to prescribe calling a function that must not be called,
while `SKILL.md` forbids the hand-close they describe. That contradiction stays live for as
long as this is deferred. It is the price of not deciding twice, not an argument that the
deferral is free.

**Unresolved and needed before the branch-node view reaches a human.**

### N43 · The plugin cutover broke ELEVEN referrers of one deleted directory — **S2** — **PARTIALLY RESOLVED 2026-08-22**

**2026-08-22.** Both propagate launchd agents invoke a path the cutover deleted:

| Agent | `ProgramArguments[1]` | Cadence |
|---|---|---|
| `com.tathya.propagate.monitor` | `~/.claude/skills/propagate/cli.mjs` | `StartInterval` 1800 |
| `com.tathya.propagate.digest` | `~/.claude/skills/propagate/digest.mjs` | scheduled |

That directory was one of the six `~/.claude/skills` symlinks removed when
`propagate@tathya` was installed. Both have failed on every fire since:

```
Error: Cannot find module '/Users/rupali.b/.claude/skills/propagate/cli.mjs'
  code: 'MODULE_NOT_FOUND'
```

`~/.propagate/monitor.stderr.log` grew to 32 KB of identical stack traces, last
appended 16:05 — roughly two hours of a half-hourly job failing. **`monitor.log`
and `monitor.stdout.log` both stopped at 13:36**, which is the tell: the
component's own logs going quiet is indistinguishable from a quiet period, and
the only file that knew was stderr, which nothing reads.

**How it was found:** by chance, running `ls -la ~/.propagate/` while chasing an
unrelated line-count discrepancy in the event store. Not by any probe.

**Why this is `rule:enforcement-watches-itself`, again.** The cutover was careful
about the hooks — it moved all four registrations to `${CLAUDE_PLUGIN_ROOT}` and
captured the originals at `~/.propagate/uninstall-capture-2026-08-22.json` so
they could be restored. Nothing enumerated the OTHER referrers of the directory
it was deleting. The uninstall capture answers "what did I unregister", never
"what else pointed here".

**`docs/SYSTEMS.md` is where a liveness probe per background component is
supposed to live.** Either these entries have no probe, or the probe has never
run — the same defect the file exists to prevent. Fix that before fixing the
plists, or the next cutover repeats this exactly.

**The repoint is a real decision, not a typo fix:**
- `~/.claude/plugins/cache/tathya/propagate/<version>/` is version-keyed, so a
  plist pointing there breaks on every version bump — the same brittleness in a
  new place.
- `~/Documents/GitHub/propagate/` works and never moves, but makes two scheduled
  jobs depend on a dev working tree, mid-edit and mid-rebase.

Neither is obviously right. **Do not repoint without deciding which**, and record
the choice in `docs/DECISIONS.md`.

**Related:** the digest agent is the one `rule:safety-flag-needs-a-test` records
for `--dry-run` running an armed deletion (G22). It has been inert since the
cutover, which is accidentally safe and still wrong.

---

**RESOLVED 2026-08-22.** Both plists regenerated from the repo working tree
(`~/Documents/GitHub/propagate`), chosen over the version-keyed plugin cache because that
path never moves and both jobs are read-only derivations writing only to `~/.propagate/`.
`SKILL_DIR` self-locates (`config.mjs:77-93`), so this was a regeneration, not a patch.
Rupali ran the four `launchctl bootout`/`bootstrap` commands; the tool never touches
launchd (`plist.mjs`'s stated contract).

**Measured after the reload:**

| | Before | After |
|---|---|---|
| digest | last ran 2026-08-21 10:47 local | **17:21:06** — `DAILY.md` gained a section, `lastRunAt` matches |
| monitor | `MODULE_NOT_FOUND` every 1800s | **17:30:04** — 860 rows, 0 actionable, 3452 ms |
| `doctor` | "all green" while both were dead | `✓ monitor is running on schedule  last run 0 min ago` |

**Two things the reload surfaced that the diagnosis had not:**

1. **`WatchPaths` went 20 -> 12**, and all eight dropped paths still exist on disk:
   `Keerti-portfolio`, `keerti-job-radar`, `Manav-portfolio`, `SSJK-mb` and their `docs/`.
   They stopped being *workspaces* in the 2026-08-21 consolidation ("one folder, at depth
   1, never per sub-project"). So the old plist carried **two** independent staleness
   problems and only one announced itself: the dead script path produced 35 KB of stderr,
   the eight phantom watch paths produced nothing, because watching a directory that no
   longer needs watching is not an error.
2. **The crash tell is sticky, and self-clears.** `monitor.stderr.log` stays newer than
   `monitor.log` from a crash until the next SUCCESSFUL run, so between a fix and the next
   interval the probe still reports "loaded and CRASHING". Observed here: stderr 17:26:01
   (the old job's last firing, between the plist rewrite at 17:19 and the bootout), cleared
   by the 17:30:04 success. The window is bounded by one interval and errs toward alarming
   rather than silent, which is the right direction for a liveness probe. Documented, not
   fixed.

The rollback was repaired first — `~/.propagate/uninstall-capture-2026-08-22.json` cited
`~/Documents/GitHub/propagate-skill`, a path removed by the rename that FOLLOWED the
capture, so the cutover's own undo could not execute. Every path it now cites was verified
present, including the deliberately-kept local `curate-docs-skill` checkout (`8ea167a`,
archived on GitHub). **A safety net is the one artifact whose correctness is never
exercised until the moment it must work.**



**TWO MORE REFERRERS FOUND AFTER THIS WAS CLOSED — the count was 2, it is 4.** Both surfaced
by accident while doing unrelated Phase A work, neither by any probe:

| Referrer | Symptom | Found by |
|---|---|---|
| `rules/_check.mjs` | `--selftest` exited 2 on every run since the cutover | running it |
| `Vipin Kaushik/.githooks/pre-commit` | printed `propagate gate SKIPPED` on every commit | committing |

**Every one of the four was individually well built.** Each names the path it tried; none
fails silently; the pre-commit hook even offers `PROPAGATE_CLI` in its own error message, and
its comment asserts *"The CLI path is derived, not hardcoded to one location (G48)"* directly
above the line that hardcoded it. All four had **exactly one candidate**.

That is the generalisation this issue should have carried from the start: a cutover that
deletes a directory must enumerate the **referrers** of that directory, not the registrations
it is replacing. The uninstall capture answers "what did I unregister" and cannot answer
"what else pointed here". Both are now fixed the same way — an ordered candidate list ending
in the legacy path, with the plugin cache **globbed** rather than version-pinned, because
pinning reintroduces the identical bug on the next release.

**THE CHEAP CHECK, FINALLY RUN — and "a fifth is likely" was an understatement.** One
`grep -rl 'skills/propagate'` over the tree, which nobody had run in the eight hours since
the cutover, found **eleven executable referrers**:

| | Referrer | State |
|---|---|---|
| 1-2 | the two launchd agents | fixed |
| 3 | `rules/_check.mjs` | fixed |
| 4 | `Vipin Kaushik/.githooks/pre-commit` | fixed |
| 5 | `Motherboard/propagation/bin/render-ledgers.sh` | fixed — hardcoded BOTH propagate and curate-docs |
| 6-11 | **six more pre-commit hooks** — `VipinKaushik-mb`, `astroacharya`, `Astroclarity`, `marketing-intel`, `sanskrit-texts`, `VipinKaushik` | **OPEN** |

**The propagate gate is silently not running in seven repos.** Every one is the same hook
block, copied, each with the same single hardcoded candidate — so this is copy-drift, and the
copies were identical right up until the moment the path they all shared stopped existing.

Not fixed here because three of the six are on feature branches or dirty
(`astroacharya` on `feat/muhurta-typed-endpoints`, `VipinKaushik` on
`fix/privacy-slice5-regression`), and committing across six repos on unrelated branches is
not this change's to make.

Two `settings.local.json` files also match and are unaudited.

**The lesson, restated because the first version of this entry got the scale wrong twice.**
The uninstall capture answers *"what did I unregister"*. It cannot answer *"what else pointed
here"*, and no probe asks. The grep costs one command and was not run until a fourth instance
turned up by accident.

**Still open, carried to a new issue:** nothing detects the phantom-`WatchPaths` class, and
`watchPathsFor()` still hardcodes `docs/`.

### N44 · The RED phase of a validator test appended two events to the production ledger — **S2** — **RESOLVED 2026-08-22**

Full hazard, signals and fix: `docs/GOTCHAS.md` **G56**. Recorded here for the ledger
count, not restated.

**What happened.** Two tests asserting `validateEvent` rejects an event missing
`observed_on_ref` / `downstream_on_ref` were written before the rule existed — correct
RED-first order — and run with `node --test tests/watcher/events.test.mjs`, to watch one
file go red. With no rule to reject them **both events were written**, and only then did the
assertion fail. `ℹ fail 2` was RED for exactly the stated reason *and* a silent write.

**The mechanism is the launcher, not the assertion** (corrected 2026-08-22, hours after this
entry was first written — the original blamed `assert.rejects(appendEvent(...))` in general,
which is wrong and would have taught the wrong lesson). The store is scoped by the npm
script, not by any test:

```json
"test:propagate": "PROPAGATE_STATE_DIR=\"${TMPDIR:-/tmp}/propagate-test-state\" node --test 'tests/**/*.test.mjs'"
```

`npm test` is safe and always was — the full run half an hour later touched nothing.
`node --test <file>` is not. The same tests are safe or unsafe depending only on how the
process was launched, and **all eight test files that call `appendEvent` have this
property**; two were hardened. Hazard, signals and fix: `docs/GOTCHAS.md` **G56**.

**Store 1912 -> 1914**, noticed an hour later by accident. The two events carry
`edge_id e717028e` / `node_id VipinKaushik:lib/pricing.ts` — fixture values matching **0**
declared edges, so nothing was falsely closed and nothing is recoverable-but-wrong. They
remain in the append-only store; **removing them is not proposed**, since the 2026-08-17
precedent for a deliberate append-only violation existed only because that incident had
falsely closed three real worklist items. This one closed nothing.

**Fixed** by scoping both tests through `withScopedStore` + `runInSubprocess`, and by
retargeting G56's trigger to fire on any `node --test` Bash command — verified against a real
payload, and verified NOT to fire on `npm test`, which is the discrimination that makes it
useful rather than noise. Verified by mutation: removing the validator rule reproduces the
RED condition exactly — same two tests, same message — **with the store line count unchanged
at 1914**. That count is the assertion that distinguishes the fixed version from the one that
"worked".

**Residual, deliberately not fixed:** the safety property lives in a `package.json` string
that no test asserts. A future edit to `test:propagate` could drop the scoping and every
suite would still pass.

### N45 · ~~S2~~ · **RESOLVED 2026-08-24 (fix 2)** · Gotchas documented as auto-firing could not fire, and `--selftest` passed anyway

**2026-08-22.** `hooks/gotcha-guard.mjs:189` matches `Edit`/`Write`/`NotebookEdit` against
**`input.file_path` only** — never the content being written. Only `Bash` exposes a content
string (`input.command`). So a trigger describing a *code pattern* can never fire on the
edit that introduces it.

Measured across both `GOTCHAS.md` files — 10 entries carry a `**Trigger:**`:

| Fires via | Count | Examples |
|---|---|---|
| `Bash` (command text) | 4 | `npm install`, `git push origin production`, `node cli.mjs bootstrap --apply` |
| `Edit`/`Write` (file path) | 3 | `(site)/layout.tsx`, `tests/watcher/events.test.mjs` |
| **Neither — inert** | **3** | `toLocaleString(undefined`, `unstable_cache`, `const elapsedMs = Date.now() - start` |

**Two of the three inert ones are marked ⚡ in `Vipin Kaushik/CLAUDE.md`**, whose text says
those entries fire automatically and are "put in front of you at the moment of risk". G4
(hydration bomb) and G6 (`unstable_cache` serialises a `Date`) do not. Verified by feeding
the guard a real `Edit` payload whose `new_string` contains each pattern: empty output for
both, while a `Bash` control on the same tree fired a different entry — so the harness
works and these two specifically cannot match.

**`--selftest` reports success throughout**, because it asserts each trigger matches its own
`**Fires on:**` **literal** — never that the literal can ever BE a subject the guard is
handed. A check that validates a regex against a string of its author's choosing cannot
detect that the string never occurs in production. `rule:discernment-checks` §1, and
`rule:enforcement-watches-itself`'s exact corollary: the selftest is the mechanism that was
supposed to make this impossible.

**Two candidate fixes, and they are not equivalent:**
1. **Extend `subjectOf`** to include `new_string`/`content` for Edit/Write. Makes
   code-pattern triggers work as their authors clearly assumed. Cost: every entry's trigger
   now matches against far more text, so false positives rise and existing path-triggers are
   unaffected only by luck.
2. **Extend `--selftest`** to assert each `Fires on:` literal is reachable — i.e. that it is
   a plausible `file_path` or a plausible `command` for the tool classes `subjectOf`
   handles — and fail the run for the ones that are not. Does not make G4/G6 work; makes
   their deadness **loud** rather than silent.

(2) is the one that matches this repo's stated posture — make "found nothing" and "looked at
nothing" different outputs — and should land first regardless of whether (1) does.

**FIX (2) LANDED 2026-08-24.** `deliverableAs()` classifies each `**Fires on:**` literal as a
path, a command, or neither, and `selftestProblems` reports the neithers as UNREACHABLE
before it ever checks whether the regex matches. Reachability first: a trigger that matches an
example the guard is never handed is dead however well the regex works.

**It caught one on its first real run, and two FALSE POSITIVES before that** — the first
version rejected `n=$(git cherry … )` and `amodels="${6:-{}}"` because their head token
carries `=` and `$(`. Both are shell assignments and therefore perfectly ordinary Bash command
lines. A wrong "this is dead" is worse than a missed one, since it invites deleting a working
trigger; the classifier now recognises `name=value` as a command.

The one true finding was **G25**, whose literal was
`assert.ok(elapsedMs < 15000, "the bound did not hold")` — JavaScript source. Its
`**Trigger:**` is removed with the reason recorded in the entry: most gotchas have no
mechanical trigger, and a timing assertion lives in code, so that hazard belongs to review.

**Fix (1) — extending `subjectOf` to include `new_string`/`content` — is NOT done and is not
scheduled.** It would make every trigger match against far more text, and the entry's own
analysis says the false-positive cost is unbudgeted. Deadness is now loud, which was the
point.

**Scope note worth keeping:** the guard reads GOTCHAS files from the working directory
upward, so a selftest run inside `propagate` sees 2 sources and not `Vipin Kaushik`'s. The
three inert entries measured on 2026-08-22 spanned both files; run it from each workspace to
see that workspace's own.


### N46 · ~~S3~~ · **RESOLVED 2026-08-24** · `watchPathsFor()` hardcoded `docs/`, and stale watch paths were undetectable

**2026-08-22, found while resolving N43.** `lib/core/plist.mjs:261-269` builds the monitor's
`WatchPaths` as `ws.root` plus `ws.root/docs` if that directory exists. Two problems, both
low-severity and neither worth fixing blind:

1. **`docs/` is hardcoded** and the ledgers moved to `propagation/` on 2026-08-21. But
   widening it would be **the wrong fix for the obvious want**: the monitor never reads a
   ledger (`monitor.mjs:21` — "it writes no drift rows. Not to a ledger"), so waking it on a
   ledger change buys nothing. The job that reads ledgers is the **digest**, which is
   time-triggered and needs no `WatchPaths` at all.
2. **Stale entries are invisible.** Regenerating on 2026-08-22 silently dropped 8 of 20
   paths — sub-projects that stopped being workspaces in the consolidation. Nothing reported
   the plist as stale; a directory that no longer needs watching produces no error, so this
   class of drift is silent by construction. `doctor` has a `plist WatchPaths` check for the
   RETIRED watcher and none for the monitor.

**Also worth knowing before anyone invests here:** launchd `WatchPaths` is **not recursive**
— it fires on changes to entries *in* the named directory, not deep beneath it. So `ws.root`
never caught a nested source edit either, and the real trigger has always been
`StartInterval 1800`. The whole `WatchPaths` mechanism is less load-bearing than its size in
the plist suggests.

**Recommendation:** re-derive `WatchPaths` from what the monitor actually reads (sidecars and
the source files they name), or drop them entirely and rely on the interval. Do not simply
add `propagation/`.

**RESOLVED 2026-08-24 — dropped, not re-derived.** The second option, for the reasons this
entry already lists: launchd `WatchPaths` is not recursive, so it never caught the nested
source edits anyone assumed it did; the monitor reads no ledger; and `StartInterval 1800` has
always been the real trigger. Re-deriving would keep a non-recursive mechanism alive and hand
it a fresh directory to rot against.

`watchPathsFor()` now returns `[]` and the template emits **no `WatchPaths` key at all** — an
empty array is still a declaration, and a declaration is something a later regeneration can
quietly repopulate.

**Two things fell out of it that were not in the plan:**

* `writeMonitorPlist` REFUSED when the derived array was empty — "a monitor watching nothing
  is worse than no monitor", true while WatchPaths were the mechanism and now the opposite.
  It would have blocked every regeneration from here. Re-aimed at the condition it was
  actually protecting against: zero discovered workspaces.
* `renderMonitorPlist` extracted as a pure function, because the only way to assert "declares
  no WatchPaths" was previously to write the real file into `~/Library/LaunchAgents`.

**And problem 2's real cause was not what the entry said.** It reads "`doctor` has a `plist
WatchPaths` check for the RETIRED watcher and none for the monitor" — accurate, and the
consequence is sharper than "none": the existing check reads the retired watcher's path,
which does not exist, so it reported `n/a` **forever** while the live monitor's plist went
stale in both directions. A check aimed at the wrong file reads as a pass. It now also reads
the monitor's plist and asserts the emptiness.

Measured on the live artifact: **12 stale paths**, cleared by regenerating. `StartInterval
1800` preserved; the plist is written but deliberately not loaded — arming launchd stays the
human's step.

## N48 · ~~S2~~ · **RESOLVED 2026-08-24** · `npm test` scaffolded ledger pairs into REAL workspaces

> **Renumbered from N46 on 2026-08-24.** N46 was already taken by the `watchPathsFor()`
> entry above — I filed against a live id without checking, which is how two issues end up
> answering to one name and one of them stops being findable.

**Reproduction, and it is exact:**

```bash
/bin/rm -f ~/Documents/GitHub/Khushboo/propagation/ledger.{jsonl,md}
npm test                       # or: node --test tests/portability/fresh-machine.test.mjs
ls ~/Documents/GitHub/Khushboo/propagation/    # both files are back
```

Bisected 2026-08-24 by deleting one empty ledger and re-running each group, then each file:
`tests/cli` no · `tests/unit` no · **`tests/portability` YES** → **`fresh-machine.test.mjs`**,
alone, out of that directory's 18 files.

**CAUSE, established by tracing `ensureLedgerPair` rather than by reasoning.** The earlier
version of this entry said the route was unknown and that it should be found before anything
changed. It was found:

```
argv: [node, cli.mjs, setup, --roots, /Users/rupali.b/Documents/GitHub]
HOME: /var/folders/.../propagate-xallow-VqE9xi          <- isolated, correctly
stack: ensureLedgerPair <- makeWorkspaceRecord <- walk <- discoverWorkspacesSync
       <- verifyDiscovery <- setupCmd
```

One test in that file hands the **real hub** to `setup`, a scaffolding verb:

```js
const roots = path.join(process.env.HOME, "Documents", "GitHub");  // the RUNNER's home
run(["setup", "--roots", roots]);
```

It is deliberate — the assertion needs real repos carrying cross edges to exist at all — and
`process.env.HOME` there is the test runner's home, not the isolated one the child is given.
Isolating HOME and `PROPAGATE_STATE_DIR` protected the config and the event store. Neither
could protect the tree the command was explicitly pointed at.

**It was silent for as long as it did nothing.** `ensureLedgerPair` writes only iff NEITHER
file exists, so on a tree where every workspace already had a pair it was a no-op on every run.
Declaring six new workspaces gave it somewhere to act, and twelve `doctor` failures cleared
themselves between two runs.

**FIX.** The config is now written directly into the isolated HOME via `renderConfig` —
imported, so the format cannot drift from what `setup` writes — and only `doctor`, a read-only
verb, is spawned. The real tree is still READ, which is what the assertion needs.

**Ratchet, so it cannot come back:** `state-isolation.test.mjs` now fails if any test derives a
path from the runner's `process.env.HOME`. Comments are skipped — a line behind `//` cannot
target anything, and without that the rule could not be written down without tripping itself
(four of the first run's five hits were the entry explaining it). Verified it still fires on
real code by appending one line and watching it go red.

**What was ruled out, so nobody re-does it:** `setup.test.mjs` (fully sandboxed — HOME,
`PROPAGATE_STATE_DIR`, and `PROPAGATE_SEARCH_ROOTS=""`), `hub-root.test.mjs`,
`relocate-ledger-cli.test.mjs` (its `"init"` hit is `git init`, not the CLI verb), and
`reconcile`/`verify` (neither is a scaffolding verb).

**What does NOT fix it:** adding `PROPAGATE_SEARCH_ROOTS` to the `test:propagate` script.
Tried 2026-08-24 — it breaks 5 tests that legitimately exercise search-root resolution
(`config.yml supplies searchRoots when the env var is unset`, `env beats file`, `maxDepth is
configurable`, …) **and the leak persists anyway**. Reverted. The fix belongs in the test
file, not in the npm script.

**Severity S2, not S1, and the reason matters.** The files it creates are EMPTY ledger pairs —
the same thing `init` would create deliberately — so nothing was corrupted and nothing lost.
But it is a test suite writing into directories it does not own, and the next thing it writes
may not be empty. Same family as G56 (`node --test` writing to the production event store) one
level up: there the test wrote to the store, here it writes to the tree.

**How it surfaced.** Twelve `✗ ledger JSONL/MD exists` failures cleared between two `doctor`
runs with no scaffolding verb in between. All six files carried the same mtime to the second,
which is what proved a single command did it rather than six.

## N49 · ~~S2~~ · **RESOLVED 2026-08-24** · `migrate --apply` failed PARTWAY on an untracked artifact

> **Renumbered from N47 on 2026-08-24**, for the same reason as N48.

**2026-08-24, hit during v3 Phase E on `Tushar`.**

```
refused: Command failed: git mv Tushar/docs/GOTCHAS.md
         Tushar/propagation/state/workspace/GOTCHAS.md
```

`docs/GOTCHAS.md` was untracked (`??` — never `git add`ed, not ignored), and
`git mv` requires a tracked file. By then THREE artifacts had already moved and
were staged as renames, and the four scaffold files had not been written. The
workspace was left half-migrated — which `migrate`'s own conformance message
calls *"the state that loses data"*.

**Nothing was lost**, verified by checksum: all four Tushar artifacts matched at
their old or new path, and `git add` + a re-run completed it cleanly.

**The defect is the ORDER, not the failure.** `planMigration` already refuses up
front for two whole-run preconditions — "not inside a git repository" and
"unresolved conflicts" — precisely so a doomed run writes nothing. Untracked
sources belong in that same preflight: they are knowable before the first `git
mv`, from `git status --porcelain` or `git ls-files --error-unmatch`, and they
are per-file rather than per-run, so the check must name every offender rather
than stopping at the first.

**Not a conflict, and should not be reported as one.** A conflict is two real
files where one must win; this is one real file the repo has never been told
about. The fix is `git add`, and the message should say so.

**Blast radius as measured:** of the 8 workspaces migrated in Phase E, exactly
one hit this. The other seven had every artifact tracked.

**RESOLVED.** `migrateWorkspace` now preflights every planned move with
`git ls-files --error-unmatch` and refuses before the first `git mv`, beside the two
whole-run refusals that were already there for the same reason.

It names EVERY offender. Unlike "not a git repository" this is per-file, so stopping at the
first would turn one re-run into N, each discovering the next. The test asserts two untracked
artifacts and checks both appear.

The message says `git add`, not "conflict": a conflict is two real files where one must win,
this is one real file the repo was never told about, and the two need different fixes.

Asserted on the TREE — a refused run leaves it byte-identical — and paired with a test that a
fully tracked workspace still migrates, so the preflight cannot pass by blocking everything.

## 2026-08-25 · The never-verified backlog is a baseline gap, not a worklist — POLICY

**399 edges are NEVER_VERIFIED and that is the correct steady state.** Do not treat the
number as debt to be zeroed, and do not close them in bulk.

**Measured, not assumed.** `bootstrap --baseline-from-git` over the 413 that existed before
this pass could baseline **12** — 2.9%. The rest: 276 no-co-commit, 119
ineligible-cross-repo, 6 bound-reached. The 12 were applied; every one names a real
co-commit SHA in its `reason`.

**Why the other 401 must stay open.** `appendEvent` refuses a `baselined` event without a
reason naming its evidence (`lib/edges/events.mjs:147-160`), and the reason it refuses is
v1's **556 unexplained `wontfix_reason` rows**. Closing them without evidence would recreate
that failure in a new place, and it would be indistinguishable afterwards from work that was
genuinely checked.

**How it drains: verify-as-you-touch.** When a session edits either end of a declared edge,
it settles that edge with a reason saying what it actually read. That is the only mechanism
that produces evidence rather than a claim. The number falls as work happens; it is not a
project.

**What "done" means for the edge graph** — and it was reached 2026-08-25: **0 need
attention** across all 13 workspaces plus cross. Every DRIFTED / REVERSED / DIVERGED edge was
read on both sides and settled with a disposition matching what was actually found. Three
settlements record findings rather than clean reconciles (`e377000b`, `eddcd444`, and the
`22c0e76a` / `6a114165` pair state the LIMIT of what was checked).

**One deliberate override.** Attention edges are gated by never-verified upstreams — the
guard is conservative, since NEVER_VERIFIED means unchecked, not known-wrong. Settling them
in fix order would have required draining most of the 399. `--out-of-order` was used where
both sides had been read, by explicit decision, and every such event says so in its reason.

---

### N50 · `inventory.test.mjs` classifies by a 5s git timeout, so its verdict depends on machine load

**Status:** open. Reproduced in 3 of 4 full-suite runs 2026-08-25; passes in isolation every
time. A third test joins the set intermittently: `a recently-committed repo with a remote
classifies active` (27.4s under load).

**A third test was added here and then WITHDRAWN the same day — the entry was wrong.**
`tests/portability/update-notice.test.mjs` appeared to fail at HEAD, HEAD~1 and 963d416,
which read as "pre-existing, three commits deep". It was not: **every one of those runs had
`PROPAGATE_STATE_DIR=$(mktemp -d)` exported by me.** `CONFIG_PATH` derives from `STATE_DIR`,
so a fresh empty temp dir means no `config.yml`, no `searchRoots`, and zero workspaces — the
"no workspaces — hub root is not configured" the test reported. Re-run with the value
`npm test` actually uses, `${TMPDIR:-/tmp}/propagate-test-state`, it **passes**. See G56,
which now carries the corrected mitigation, because the bad advice came from G56 itself.

**Root cause, measured rather than guessed.** `node --test` spawns one worker PER TEST FILE.
There are **123 test files on a 10-core machine**, ~9 workers resident at once, and several of
them shell out to real `git` against real temp repos. Observed `load average: 33.6` mid-run —
mostly I/O wait, not CPU. A 5-second `git` timeout is simply not a safe assumption in that
environment, and the tests that depend on one are the ones that fail.

`lib/report/inventory.mjs:329` runs `git` with `timeout: GIT_TIMEOUT_MS` (5000ms), and
`runGit` correctly degrades to `{ ok: false, error: "git timed out" }` when it expires. That
degradation is right for production — a hung git must not hang `inventory`. It is wrong as a
*test* input, because `node --test` runs files concurrently and the classification then
changes underneath the assertion:

```
a recent repo with NO remote classifies active-unadopted, never silently dropped
  isolated       8.4s   PASS
  in full suite 15.5s   FAIL
```

`gitStage — apply:true on a non-git directory runs git init` (`tests/cli/bootstrap.test.mjs`)
is the same shape, via `bootstrap.mjs`'s own `GIT_TIMEOUT_MS`.

**Why it matters beyond the annoyance.** A test whose verdict depends on machine load is a
check that can fail for the wrong reason, which `rule:discernment-checks` §4 rates as bad as
one that cannot fail — and the more common harm is the opposite reading: the next person sees
red, shrugs, re-runs, and gets green. That teaches the suite is unreliable, which is how a
real regression gets waved through.

**Not caused by the doctor split** (#31 T2), though it surfaced during it. `inventory.mjs` is
untouched by that work and nothing in the extracted modules reaches it. The two new test
files add marginal concurrency pressure, which is enough to change how often an existing
race lands, not enough to be its cause.

**Fix direction, when it is picked up:** make the timeout injectable and have these tests
pass a generous value, or have `runGit` distinguish "timed out" from "failed" at the call
site so a timeout produces an attributable `status`, not a silently different
classification. Do NOT simply raise the constant — that moves the threshold without removing
the dependence on load.

### N51 · `parseHandovers` reads fenced examples as real sections — **S2** — **RESOLVED 2026-08-26**

Found 2026-08-26 while correcting `HANDOVERS.md`'s header to document its marker protocol.
Writing the convention **inside the file it governs** minted a 17th section:

```
sections: 16  totals: {"open":0,"closed":0,"unknown":16}     before
sections: 17  totals: {"open":0,"closed":1,"unknown":16}     after adding a ```markdown example
```

The example was a fenced block containing `## 2026-08-26 · A thing handed over` followed by
`**Resolved:** …`. `SECTION_RE` matched the heading and, because the marker sat within
`MARKER_WINDOW`, the phantom section reported **closed**.

**Why S2 and not S3.** The direction is the dangerous one. `closed` is the single state that
makes work disappear, and `MARKER_WINDOW = 3` exists precisely because a looser reading
produced two false closes on this file before. A code fence re-opens that door from a
different side — and unlike the earlier case, the phantom carries no real work, so it
inflates the closed count with something nobody can ever act on.

**Worked around, not fixed.** The example heading is now `## <YYYY-MM-DD> · <title>`, which
`SECTION_RE` cannot match (it requires a literal date or number), and the file carries a
note saying why. That protects this file and nothing else: any handover file quoting a
dated heading in a fence has the same defect.

**Fix direction:** track fenced state while scanning (a ```-toggle) and skip lines inside a
fence, in both the section scan and the marker window. Test with the exact shape above —
a fenced dated heading plus a `**Resolved:**` line — and assert the section count does not
move. Do NOT fix it by narrowing `SECTION_RE`; the heading grammar is correct, the problem
is that prose about the format is being read as the format.

**Related:** the granularity mismatch recorded in the same session — `HANDOVERS.md` resolves
per ITEM, `handovers.mjs` scopes per SECTION — is a separate, larger design question and is
NOT this issue. This one is a parser bug with a bounded fix.

**A second instance, found by writing this entry.** Its first title ended
`… and a phantom section reports CLOSED — **S2**`, and the register promptly classified
**this issue** as closed: `CLOSED_MARKERS_RE` matches the word anywhere in a heading, and
`CLOSED_SECTION_RE` would have marked every entry beneath it closed too — harmless only
because N51 is currently last. So the classifier cannot tell *"this item is closed"* from
*"this item is about closing"*, and an issue describing a close-state bug closes itself.

Same root shape as the fence bug: **prose about a mechanism being read as the mechanism.**
Worked around the same way — the title now avoids the vocabulary. A real fix would require
the marker to be positional (a status field, a leading token) rather than a keyword anywhere
in the line, which is a bigger change than this issue's, and is why it is recorded here as
evidence rather than filed as its own entry.

**RESOLVED 2026-08-26 — the parser tracks fences.** `FENCE_RE` toggles on ``` / ~~~ and
fenced lines are skipped for both the section scan and the marker window. The workaround is
gone: `HANDOVERS.md`'s example now carries a real date again and the file still parses to 16
sections, which is the check that the fix rather than the evasion is what holds.

Fenced lines DO still consume the marker window, deliberately — a section-level marker
belongs directly under its heading, before any illustration, so a code block between them is
exactly the distance `MARKER_WINDOW` exists to measure. Not consuming it would widen the
window by an arbitrary amount and re-open the false-close door from a third side.

Five tests in `tests/unit/handovers-fence.test.mjs`; the mutation (disabling fence tracking)
turns three of them red and reproduces the original symptom verbatim — a fenced example
becoming a section, and an illustration discharging real work.

**THE SECOND INSTANCE ABOVE IS NOT FIXED** and this entry is not closing it. The classifier
still cannot tell *"this item is closed"* from *"this item is about closing"*: any heading
containing the word closes itself, and `CLOSED_SECTION_RE` sweeps every entry beneath it.
That needs a positional marker — a status field or a leading token — rather than a keyword
anywhere in the line, which is a larger change than this issue's. It is recorded here as
evidence and stays live; **do not read this RESOLVED banner as covering it.**

### N52 · `migrate-refs`'s markdown renderer prints `undefined` and misplaces paths into the ref column — **S3** — OPEN

Found 2026-08-27 while refreshing the branch registry after pruning worktrees. The
**data layer is correct**; only the human-readable rendering is wrong, which is why this is
S3 and not S2.

`migrate-refs <workspace>` (dry-run) renders every event with a literal `undefined` as its
leading field, emits `<project>/null` rows, and puts an absolute filesystem path where a ref
name belongs:

```
undefined Motherboard/chore/shared-as-versioned-module
undefined Motherboard//Users/rupali.b/Documents/GitHub/Motherboard/.claude/worktrees/hardcore-villani-778ff0
undefined Rishabh/null
undefined curate-docs-skill/null
```

**The same run under `--json` is entirely well-formed**, which is what localises the defect:

```json
{"type":"worktree-removed","project":"Motherboard","ref":"feature/asset-registration","path":"/Users/.../\.worktrees/feature/asset-registration"}
{"type":"baseline","project":"Anushka","ref":null,"path":null,"ref_count":1,"detected_by":"snapshot-diff"}
```

So: the renderer reads a field name the event objects do not carry (hence `undefined` where
`type` belongs), prints `ref` without handling the documented `null` case that `baseline`
and workspace-level events legitimately use, and falls back to `path` for
`worktree-removed`/`worktree-added` events — where `path` is the worktree directory, not a
ref, and is correct data displayed in the wrong column.

**Why it matters despite being cosmetic.** `rule:discernment-checks` §6 — a reader that
cannot report failure invents an answer. Three of the four symptoms here are a *correct*
value in the wrong slot, which reads as corruption and argues against running `--apply`.
That is the actual cost: a working refresh command looks broken, so the registry does not
get refreshed, so `doctor`'s `✓ ref registry` count drifts from disk. Measured this session,
before the refresh: the snapshot still listed a pruned worktree and a `curate-docs-skill`
project that no longer exists.

**Corrected root cause.** This entry's first draft claimed `buildWorkspaceSnapshot` had a
single caller (`lib/migrate/workspace.mjs`) and therefore *no refresh path at all*. That was
wrong, and the error was in the instrument: the search pattern required
`from "../refs/snapshot"`, while `lib/refs/migrate-refs.mjs:23` imports
`from "./snapshot.mjs"` — so the second, and decisive, production caller never matched.
`migrate-refs` **is** the refresh path and it works. Recorded here rather than silently
edited, per this register's own standard that evidence is not rewritten.

**Fix.** In `migrate-refs`'s renderer: print `e.type`; render `ref ?? "—"`; give
`worktree-*` events their own line format with the path labelled as a path.

---

### N53 · The size-cap check reads `STATE.md` at the pre-move path, so it measures 14-line stubs — **S1** — **OPEN**

**Status:** open, filed 2026-08-27. Found while reconciling
`Vipin Kaushik/propagation/state/marketing-intel/STATE.md`, not by any check.

**The hazard.** The 2026-08-21/22 relocation moved project state to
`<workspace>/propagation/state/<project>/STATE.md` and left a 14-line pointer stub at the old
repo-relative path. `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh` still measures
`proj_files=("CLAUDE.md" "STATE.md")` at each **project repo path**, read from the committed
active line (`git -C $REPO show $ACTIVE:$FILE | wc -l`). So it now measures the stub.

Neither side knows the new path — this returns nothing:

```sh
grep 'propagation/state' docs/conventions/CONTEXT-BUDGET.md scripts/hygiene/lib/size-caps.sh
```

**Measured 2026-08-27**, each project read at its own `[active_lines]` value, cap 200:

| Project | Active | Checker sees | Stub? | Real file | Verdict |
|---|---|---:|---|---:|---|
| workspace | main | 14 | yes | **248** | green, 48 over |
| marketing-intel | main | 14 | yes | **225** | green, 25 over |
| sanskrit-texts | main | 14 | yes | **586** | green, **386 over** |
| Astroclarity | main | 14 | yes | 93 | green, and correct by luck |
| VipinKaushik-mb | main | 14 | yes | 38 | green, and correct by luck |
| astroacharya | main | 190 | no | 187 | measures **stale pre-move content** |
| VipinKaushik | production | 78 | no | *never migrated* | genuinely measured |

**Five of seven are stubs.** Two of those five are genuinely under cap, so the pass is
accidentally right — which is what makes the other three hard to notice.

Two population wrinkles a fix must not assume away:

- **astroacharya's move landed on `feat/muhurta-typed-endpoints`, not on its active line.** Its
  `main` still carries 190 lines of pre-move content; the stub and the real 187-line file are
  elsewhere. The checker measures a third thing nobody reads.
- **`VipinKaushik` never migrated at all** — 78 real lines in-repo, no
  `propagation/state/VipinKaushik/`. The population is heterogeneous; "every project moved" is
  false.

**Why this is propagate's and not the workspace's.** The relocation is propagate's
(`docs/REFERENCE.md` §"Propagation layout"). `rule:enforcement-watches-itself` §1: installing
or *moving* something is the moment to ask what read it at the old path. Nothing did.

**Why S1.** The checker cannot distinguish *"this file is 14 lines"* from *"I am looking at a
stub"*, and renders the second as a pass — `rule:discernment-checks` §2 (absence must be
attributable) and §6 (a reader that cannot report failure reports absence, which is worse than
reporting success, because absence gets acted on). Nothing in the output distinguishes the
three over-cap files from the two that are genuinely fine.

**Observed live, not only read from the code.** The `Vipin Kaushik` pre-commit hook ran on
`ab91f23` — the commit that took `marketing-intel/STATE.md` from 200 to **225** lines against a
200 cap — and printed:

```
check-doc-sizes: yellow (>= 90% of cap):
  CLAUDE.md: 219 lines (yellow at 198, cap 220)
  marketing-intel/CLAUDE.md: 179 lines (yellow at 162, cap 180)
precommit-check[workspace]: size-caps yellow (warning, not blocking):
  ~ CLAUDE.md (219 / cap 220)
```

Two `CLAUDE.md` files at 99% of cap were named. **No `STATE.md` appears at all** — not the
225-line file in that very commit, not the 248-line workspace file, not sanskrit-texts' 586.
The gate ran, resolved every `STATE.md` to a stub, and reported nothing. That is the failure in
one screenful.

**Fix direction, not implemented here.** Resolve `STATE.md` through the same `.sidecar.yml`
the rest of the layout already uses instead of a hardcoded repo-relative path; and make a stub
an explicit `skipped: stub-at-legacy-path` result rather than a 14-line pass. **Do not simply
repoint the path** — that would fix the five and silently keep measuring astroacharya's stale
`main` copy and VipinKaushik's unmigrated one. Sub-200 is not evidence when 14 is the number.

**The tension that surfaced it, recorded for propagate to decide.** The overage was created by
a legitimate edit: `marketing-intel/STATE.md` gained a previously-undocumented branch and a
corrected instrument rule, going 200 → 225. Caps are static; a state file grows when genuinely
new information arrives. The template's ">90d archive" release valve did not apply — the oldest
`Completed` entries are ~58d. It was left over-cap and flagged rather than trimmed early, since
deleting history to satisfy a checker that is not currently reading the file would be the wrong
trade twice over.
