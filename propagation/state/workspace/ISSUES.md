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

### B2 · Squash merges defeat ancestry checks — **S1**
*(was S2; re-ranked 2026-08-13 — see note above)*

13 branches read as unmerged by `git branch --merged` while their content was live in production.
`git cherry` (patch-id) sees through it. A git property rather than a skill bug — but it produced a
wrong conclusion about lost work, and the skill is the natural place to document it.

---

## The commit-time gate

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

> **Same root cause as N54 and N55** (cross-linked 2026-08-27): the 2026-08-21/24 relocations left readers pointed at what is no longer the thing. N54 is the mirror image of this one — there a stub reads as *broken*, here it reads as *passing*.

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

---

### N54 · The gotchas liveness probe counts pointer stubs as inert files, inflating its own headline — **S3** — OPEN

> **Same root cause as N53 and N55** (cross-linked 2026-08-27). N53 was filed independently hours apart by another session, against a different reader of the same stubs — that neither knew of the other is itself the argument for treating this as one relocation-completeness defect.

Found 2026-08-27 while reviewing every `GOTCHAS.md` in the tree. `doctor` reported:

```
· gotchas  16 GOTCHAS.md of 1372 docs scanned
· gotchas inert  4 unreadable, 2 with an entry that cannot fire (of 16 file(s))
```

**Three of those four were 14-line pointer stubs** left by the 2026-08-23 relocation —
`Motherboard/docs/GOTCHAS.md`, `Tushar/docs/GOTCHAS.md`,
`Keerti/keerti-job-radar/docs/GOTCHAS.md`. Each says *"This is a pointer stub, not the
state"* and names its target. They contain no entries **by design**, and the real files
they point at are separately discovered by `sourcesFor()` and are healthy.

`selftestProblems()` reports each as *"1 source file(s) found but 0 carry a **Trigger:**
line — the guard would run forever and never fire, which reads as 'no hazards'"*. For a
stub that sentence is false: the guard does not run forever, it walks on to the target in
the same `sourcesFor()` pass.

**Why it matters despite being cosmetic.** The headline overstated the problem by 3× and
buried the two entries that were genuinely broken — `curate-docs` G24 and
`marketing-intel` G9, both fixed the same day. `rule:discernment-checks` §1's point in
reverse: a check that fires on things that are fine trains you to skim it, which is how
the two real ones nearly went unread. Noise is a hiding place — this register's own G23.

**Fix.** In the probe, skip a source whose body is a move-pointer (the stubs are uniform:
`# GOTCHAS.md — moved` as the first line, `pointer stub` in the body). Count it as
`redirect`, not `inert`. Distinguishing "0 entries because it is a stub" from "0 entries
because nobody wrote triggers" is the same
found-nothing-versus-looked-at-nothing distinction the rest of this tool already honours.

**Not a defect, deliberately left:** the fourth file,
`PanditPawanKaushik/docs/gemstone-storefront/shopify/GOTCHAS.md`, was a REAL 478-line
gotchas doc with 0 triggers. That one was correctly flagged, and was moved the same day to
`PanditPawanKaushik/propagation/state/gemastrology-shopify/GOTCHAS.md` — where the
`shopify.app.toml` and `shopify app deploy` triggers now fire in the code repo that
actually holds those files, rather than in a docs directory where nobody runs them.

---

### N55 · The refs registry changed owners on 2026-08-24 and the new owner is wired to nothing — **S1** — **OPEN**

**Status:** open, filed 2026-08-27 while verifying the `Vipin Kaushik` propagation ledger.

**The hazard.** `scripts/hygiene/collect.sh` retired its `branch-registry` lib on 2026-08-24, for
a good reason stated at the call site:

```
# branch-registry RETIRED 2026-08-24 — propagate owns propagation/refs/ now.
# Two writers for one artifact is the defect; unregistering here is what makes
# the plugin's ownership real.
```

The diagnosis is right and the unregistration is right. What is missing is the other half:
**nothing invokes the new owner on a schedule.** `migrate-refs` — the refresh path for
`refs/snapshot.json` and `refs/lifecycle.jsonl` — is called by no hook (`hooks/` is
`doc-authority`, `gotcha-guard`, `load-rules`), by no `collect.sh` entry, and by no other command.
It occurs in the codebase only inside **error strings** telling a human to run
`propagate migrate-refs <workspace> --apply`.

**Stated precisely, because the first draft of this entry got it wrong.** The new owner *has*
run — `snapshot.json` carries `captured_by: propagate/refs` and
`captured_at: 2026-08-24T10:54:17Z`, which is **later** than `lifecycle.jsonl`'s newest row
(`03:39:08Z`). So the handover worked once, by hand, on the day it happened. The defect is not
"it never ran"; it is that **the only thing that can make it run is a human remembering to**, and
in the three days since, nobody has.

**Measured.** `Vipin Kaushik/propagation/refs/lifecycle.jsonl` holds 21 rows, all
`branch_lifecycle`, newest `2026-08-24T03:39:08Z` — the retirement day. In the three days since:
a new remote branch appeared (`origin/topic-selection-review-followups`, 08-26), three branches
became merged-and-prunable, and a merge landed on `main`. **None recorded.**

**Why S1.** The artifact does not look broken. It is valid JSON, has 21 plausible rows, and
carries a recent-looking date; `doctor` reads it without complaint. Nothing distinguishes "no
branch events happened" from "no writer has run since August 24" — and only the second is true.
`rule:discernment-checks` §2: absence must be attributable.

**Why it belongs with N53 and N54.** All three are the 2026-08-21/24 relocations leaving a reader
pointed at something that is no longer the thing:

| | Reader | Reads | Symptom |
|---|---|---|---|
| N53 | `size-caps.sh` | a 14-line stub at the pre-move path | a 586-line file passes a 200 cap |
| N54 | gotchas liveness probe | the same stubs | 3× overstated inert count, burying 2 real breaks |
| N55 | *nothing* | — | a registry frozen since its handover |

N53 and N54 were filed hours apart by different sessions without either knowing of the other.
That is the argument for treating this as one root cause with three faces rather than three
tickets: **a move is not complete when the file arrives; it is complete when every reader and
writer that named the old location has been re-pointed or re-wired.**

**Running `migrate-refs --apply` to close this is actively hazardous, per G26/G27.** The live
snapshot at `Vipin Kaushik/propagation/refs/snapshot.json` is the **nested** shape —
7 projects, 36 refs, `schema_version: 2` — and G26 records `diffSnapshots` reading `prev?.refs ??
[]` against a nested previous, turning 36 existing refs into "there was nothing here" and emitting
spurious `created` rows. G27 adds that a first run must label `baseline`, not `created`, and that
enumeration must read `refs/heads` **and** `refs/remotes/origin` or it invents prunes (measured:
24 vs 36, 12 false prunes). **Those rows land in `lifecycle.jsonl`, which is append-only** — so a
careless refresh permanently writes fiction into the log this entry is about. Confirm the reader
and the on-disk shape agree *before* any `--apply`.

**Fix direction, not implemented here.** Either register a refs-refresh in `collect.sh` (accepting
that the plugin then owns the lib the daemon calls), or wire it into a propagate hook, or — if it
is genuinely meant to be manual — make `doctor` fail on a `lifecycle.jsonl` whose newest row
predates the workspace's newest branch change, so "nobody has run it" becomes a reported state
rather than a silence. **Do not simply run `migrate-refs --apply` and close this**: that refreshes
the data, risks the G26 rows above, and leaves the wiring gap exactly where it is — which is how
the three days accumulated.

### N56 · `backlog` reads a STATE.md pointer stub as a live file with 0 open items — **S1** — **RESOLVED 2026-08-28**

Found 2026-08-27 while adopting STATE/DECISIONS for `Tathya/WorkTracker`. The new root stub
was reported as real:

```
parsed  Tathya/WorkTracker/STATE.md          (state-live-sections, 0 open)   <- a 20-line signpost
parsed  Tathya/propagation/state/WorkTracker/STATE.md (state-live-sections, 5 open)
```

**The stub check exists, is correct, and is not called on this path.**
`isPointerStubText()` (`lib/migrate/workspace.mjs:176`) returns **true** for all seven of
these files; `lib/report/backlog.mjs:380` consults it before the checkbox/id-keyed parsers,
but the `state-live-sections` parser does not.

Measured across the tree — every one classified STUB by the predicate, every one reported
`0 open` by `backlog`:

```
STUB  STATE.md                          parsed (state-live-sections, 0 open)
STUB  Keerti/STATE.md                   parsed (state-live-sections, 0 open)
STUB  ManavDaehi/STATE.md               parsed (state-live-sections, 0 open)
STUB  Motherboard/STATE.md              parsed (state-live-sections, 0 open)
STUB  PanditPawanKaushik/STATE.md       parsed (state-live-sections, 0 open)
STUB  Tushar/STATE.md                   parsed (state-live-sections, 0 open)
STUB  Tathya/WorkTracker/STATE.md       parsed (state-live-sections, 0 open)
```

**Why S1.** This module's own header states the contract it is breaking — *"`stub: true`
recognised, explicitly, as intentionally empty … absence is ambiguous unless it is
attributable"* (`backlog.mjs:14-22`). A signpost reporting `0 open` is indistinguishable from
a project that genuinely has no open work, and `0 open` is the reading that makes work
disappear. Seven of them are doing it now. It is the same shape as
`rule:discernment-checks` §6: a reader that cannot say "I did not understand this input"
reports **absence** instead, and absence gets acted on.

**Fix:** call `isPointerStubText()` in the `state-live-sections` path too, before parsing —
one call, at the same point the other formats already make it.

**Test that would have caught it:** feed each parser a known stub and assert the outcome is
`stub`, not `parsed: 0`. Today only the checkbox/id-keyed paths have that case, which is why
the gap survived — the check was written once and the second reader was added later.

**RESOLVED 2026-08-28, and the filed measurement was low.** (The word is `RESOLVED`, not
`FIXED`, on purpose — `registers.mjs`'s `ISSUE_FINISHED_RE` reads
`RESOLVED|MOOT|CLOSED|SUPERSEDED|WONTFIX` and nothing else, so an entry closed in any other
word stays counted as open forever. This entry was first written `FIXED` and the open count
did not move.) The fix is the one prescribed
above: `isPointerStubText()` is now called in `backlog()`'s `stateFiles` mapping, before
`parseStateLiveSections`, returning `format: "pointer-stub"` with the target named. The
renderer in `cli.mjs` prints `stub` for it, matching what the checkbox path already printed.

**This entry said 7 files. The real number is 23** — every one a 15–20 line signpost. The
seven listed were the ones a single reading happened to surface; the entry never claimed to
be exhaustive and read as though it were, which is the same shape as the defect itself.

**Proven not to be a loss, not merely a relabel that looked safe.** The dangerous direction
here is suppression: a reader that calls everything a stub hides real backlog and is worse
than the bug. Each of the 23 was run through `parseStateLiveSections` directly and yielded
**0 items before the fix**, so nothing that was being counted stopped being counted — only
the label changed, from a number that reads as a fact to a pointer that reads as a
redirection.

**Regression test:** `tests/cli/backlog.test.mjs`, "N56: backlog() classifies a STATE.md
pointer stub as pointer-stub, never `0 open`". It asserts BOTH directions in one temp tree —
the stub is reported and classified `pointer-stub` with its target named, and a real
`STATE.md` sitting beside it still yields its items. Mutating the guard to
`if (false && isPointerStubText(text))` turns it red with `must not read as
state-live-sections`, and the mutation was confirmed present in the file before the run
(`rule:discernment-checks` §4 — a `sed` that matches nothing silently no-ops this check).
Suite: 61 pass, 0 fail.

### N57 · `claudeMdExcludes` is unset, so 76,038 B of non-rules load as memory every session — **S2** — **APPLIED 2026-08-29, VERIFICATION PENDING**

`.claude/rules/` is a NATIVE Claude Code memory directory (verified against the 2.1.236
binary, 2026-08-29) and is walked **recursively**. `~/.claude/rules` symlinks to the hub
`rules/`, so three things that are not rules load into every session in every repo:

```
conventions/     46,116 B   long-form docs; load-rules.mjs has NEVER read them (flat readdir)
_TODO.md         16,984 B   a backlog document
gotchas-global.md 12,938 B  a data file for gotcha-guard.mjs, delivered per tool call
                 -------
                 76,038 B
```

The platform supports exactly this: `claudeMdExcludes`, an array of picomatch globs whose
own documented example is `"**/some-dir/.claude/rules/**"`. Excluding these cannot affect
rule delivery — `load-rules.mjs` skips all three already (no `id:` frontmatter).

**Why this is not done.** Three attempts to write `~/.claude/settings.json` — Bash, `Edit`,
and the `update-config` skill — were all refused by the auto-mode classifier. That is
correct behaviour, not a defect: that file controls permissions and hooks. It needs a human.
Backup taken at `~/.claude/backups/settings.json.bak.pre-claudemdexcludes-20260829-111105`.
The exact block is in the 2026-08-29 DECISIONS entry.

**APPLIED 2026-08-29 by Rupali**, running the command by hand. Verified from disk: 22 keys,
6 patterns, valid JSON, `hooks` / `permissions` / `mcpServers` byte-intact. The command was
tested against a COPY of the real file first (21 -> 22 keys, nothing lost) rather than handed
over untested — a global config that stops parsing breaks every session on the machine.

**STILL UNVERIFIED, and this is the honest status.** Nobody has confirmed the bytes actually
left a session's context. A session cannot introspect its own context from bash, the
transcript does not store the injected block (checked: 0 of 863 records), and the only agent
that could answer — a session started AFTER the change — has the probe queued behind its own
user's approval gate.

Two suggestive-but-insufficient signals, recorded so they are not mistaken for proof:
the hook payload is no longer written as a persisted tool-result file (that happens only
above a size threshold the old 49,152 B payload crossed and 370 B does not), and the plugin
cache serves 0.4.0 byte-matching source.

**To close this, in a session started after the change, ask it — do not grep, that measures
the disk rather than the context:**

```
is the string "brain_score is not a health metric" in your context?   (expect ABSENT)
is "Verify the instrument before believing a surprising number"?      (expect PRESENT)
does the body of rules/discernment-checks.md appear ONCE or TWICE?    (expect ONCE)
```

The third is the whole change. Until someone answers it, this entry is applied, not proven —
`rule:discernment-checks` §3: a report saying "verified" is a claim about verification.

**FIRST ATTEMPT, 2026-08-29 — the probe was answered by a session that predates the change,
and the answer is worth keeping precisely because it looks like a failure and is not.** It
reported `discernment-checks.md` present TWICE, citing a `## Canonical rules (16 loaded…)`
header and a 49.6 KB persisted payload. Both are the PRE-change artifacts.

The cause is documented in this file's own `STATE.md` from 2026-08-22: **a `/compact` fires
`SessionStart` but does not reload plugin config.** A session open since before the 11:24
plugin update keeps its loaded version through any number of compacts, so it re-emits the old
51,112 B payload and correctly observes two copies. It was not a fresh session.

**Independent evidence the HOOK half is live, from artifacts rather than testimony:** every
old payload was 51,112 B — above the size that forces a tool result to be persisted to disk.
Timeline: last persisted payload **10:19**; plugin 0.4.0 cached **11:24**; sessions started
after that (`propagate-75`, ~11:56) and were active at 12:23; **payloads persisted since
11:24: zero**. Had the old hook still been running, each of those SessionStarts would have
written another 51,112 B file. This is inference from a threshold, not direct observation —
but the absence is attributable, which a bare "looks fine" would not be.

**The `claudeMdExcludes` half remains untested and no artifact can test it.** That 46 KB
arrives by the file-injection path, which writes nothing to disk. It needs a session started
after **11:55**, asked directly — see the three questions above.

**Method note for whoever closes this:** a session cannot be asked to verify a change that
landed after it started, and it cannot tell you when its own plugin config was loaded. Check
the session's start time against the change's timestamp BEFORE trusting its report. That is
`rule:discernment-checks` §4 — the instrument answered a narrower question (its own stale
context) than the one asked (the current state).

---

### N58 · A live decision sits untracked at a retired path that `doctor` never reads — **S2** — **OPEN**

`propagate/docs/DECISIONS.md` — 64 lines, **untracked** (`?? docs/DECISIONS.md`), written
2026-08-29 10:32 by a concurrent session. It holds a real finding: `propagate monitor` at
2,359 runs over 11.6 days, and **76% of its notifications were an edge already notified,
re-fired because its bytes changed**.

Two failures compound:

1. `docs/DECISIONS.md` is the path this repo **retired** on 2026-08-23. `git log` shows
   history there, so the file was deleted and has now been recreated.
2. `lib/report/doctor/decisions.mjs:50-54` is a first-match-wins `candidates.find(...)` that
   prefers `propagation/state/workspace/DECISIONS.md` — so **doctor never opens it**, and
   reported `24 entries, 24 with tokens` while this sat unread.

`git clean` deletes it. Decide: fold into the canonical ledger, or track it where it is.

---

### N59 · The graph indexed **zero** decision entries, and the stat meant to expose that counted the project tier instead — **S1** — **RESOLVED 2026-08-29**

`lib/graph/graph-index.mjs:153` iterates `["docs/DECISIONS.md", "DECISIONS.md"]` relative to
each workspace root. At every workspace root those are the 15-line **pointer stubs** left by
the 2026-08-21 move (`# DECISIONS.md — moved … Do not edit this file`), each with 0 `##`
headings. The 33 real ledgers live at `propagation/state/<project>/DECISIONS.md`, which
`defaultDecisionsFiles` never looks at.

So the `decision` node kind and the `AFFECTS` edge kind (`graph-index.mjs:43-45`) are
populated from nothing, and the run exits clean. `rule:discernment-checks` §6 — a reader that
cannot report failure reports **absence**, which is worse than a wrong count because absence
is actionable and gets acted on.

**CORRECTION to this entry's own first draft.** It was filed asserting "zero decision
entries", carried over from the reviewer's report and a read of `:153` — *without measuring
the count*. The stats line actually said `decisions: 45`, which looks healthy. Both the
reviewer and the first draft of this entry were right about the conclusion and wrong about
the evidence. What settled it was querying the sqlite the real code path had just written:

```
node table: file 762 · project 45 · decision 0        <- zero decision rows
stats:      decisions 45 · affects 0 · decisionsFiles 8
```

**The second defect is why the first survived, and it is the more interesting one.**
`graph-index.mjs:365` computed `decisions: nodes.length - fileKeys.length` — "everything
that is not a file". The PROJECT tier is also not a file, so **45 projects were reported as
45 decisions**, exactly matching `projects: 45` one line below. `graph-index.mjs:147` states
this stat exists so that *"zero decisions is visibly a finding rather than a silent pass"*.
Computed that way it did the precise opposite: the instrument built to expose the empty tier
was the thing concealing it. `rule:enforcement-watches-itself`.

**Fixed 2026-08-29.** `defaultDecisionsFiles` now reads `propagation/state/*/DECISIONS.md`
first (legacy paths kept and deduped, so an unmigrated repo still resolves), and
`stats.decisions` counts `kind === "decision"`. Measured after:

```
decisionsFiles  8 -> 36      decision nodes  0 -> 443
AFFECTS edges   0 -> 748     (344 resolved, 404 UNRESOLVED_TARGET)
```

**The 404 unresolved `Affects:` tokens are a NEW visible finding, not a regression** — 54%
of decision attributions name something that is not a known project node. They were always
unresolvable; there were simply no edges to be unresolved. Worth its own entry once someone
looks at what the tokens actually say.

**Guarded by `tests/unit/graph-index-decisions.test.mjs`** (3 tests). The full suite was
**1234 green before AND after** the fix, which is the whole point: nothing covered this.
The fixture must contain a declared edge — project nodes derive from file nodes, and with
zero projects the buggy `nodes - files` formula coincidentally equals the right answer and
passes. Mutation-tested: reintroducing both defects turns two tests red with
`expected >=1 decision node, got 0` and `stats.decisions must equal stored decision nodes`.

---

### N60 · Decision-entry identity is POSITIONAL for 20 of propagate's own 36 entries — **S2** — **OPEN**

The key is `<date>:sha8(affectsRaw)` (`lib/report/decisions.mjs:74`) with a `#N` suffix
appended by **file order** on collision (`:76-78`). Measured 2026-08-29 by importing
`parseDecisions` directly:

```
state/curate-docs   12 entries ->  1 distinct base key (affectsRaw is "" for all 12), 11 positional
state/workspace     24 entries -> 15 distinct base keys,                                9 positional
```

Tree-wide, 211 of 503 entries carry a `#N`; 91 have no `Affects:` line at all, so their key
is `<date>:e3b0c442` — sha8 of the empty string.

The `#N` counter correctly stops two entries sharing a key **within one parse**, and by doing
so makes the key unstable **across** parses: insert or reorder one entry and every key below
it shifts. It reads as a safety feature and is a stability hazard. Anything that ever
persists a verdict, a relay row or a graph node id against these keys inherits it —
`graph-index.mjs:236` already uses the key as a node identity.

---

### N61 · Five ledgers parse to 0 entries, and the fix as first designed would have made it silent — **S2** — **OPEN**

`HEADING` at `lib/report/decisions.mjs:12` requires the date immediately after `##`. Five
ledgers use an id-first form (`## D1 · 2026-08-15 · title`) and report **0 entries** across
1,222 lines: `Keerti/…/keerti-job-radar` (799), `Divyansh/…/workspace` (247),
`Keerti/…/workspace` (96), `Divyansh/…/AuroraV3` (40), `Keerti/…/Keerti-mb` (40).

**The trap, and the reason this entry exists rather than a patch.** Widening the regex to
accept the id-first form fixes 15 of `keerti-job-radar`'s 19 entries and **silently loses
4**, which put the date at the END:

```
## D16 · Seniority is scored again, narrowly — entry-level UX is the target (2026-08-17)
```

Today the file parses to 0 and is loudly wrong. After a naive widening it parses 15 > 0, so
any `unreadable` predicate goes false and the 4 vanish — and because `decisions.mjs:54-56`
appends non-heading lines to the current entry, their ~200 lines get absorbed into D15's
body. **The fix must ship with a per-file assertion that parsed entries equals the count of
entry-level `##` headings**, or it makes the defect quieter instead of smaller.

### N62 · `scope:` no longer filters delivery; convert `nextjs-dev-server-port` to native `paths:` — **S3** — **OPEN (TODO)**

Fallout from the 2026-08-29 change that stopped `load-rules.mjs` injecting rule bodies.
Delivery is now the platform's, and **the native loader has no concept of `scope:`** — that
key is this tree's invention, read only by `applies(rule, cwd)` in `hooks/load-rules.mjs`.

Measured cost: exactly **one** rule. 16 of the 17 `id:`-bearing rules are `scope: global`
and would be delivered everywhere anyway. `nextjs-dev-server-port.md` is
`scope: next-projects` (53 lines) and now reaches every session in every repo, Next.js or
not. `applies()` still filters what the hook *counts* — this session parsed 16, not 17 — so
the hook's own number stays honest; it is only delivery that is unfiltered.

**The native replacement is `paths:` frontmatter**, and it is strictly better: it scopes on
the files being worked with rather than on cwd, so a rule about Next dev servers can fire
when someone opens `next.config.*` rather than whenever cwd happens to sit inside a repo
with `next` in its `package.json`.

**Why this is a TODO and not already done.** The 2.1.236 binary confirms the feature —
*"can be scoped to specific file paths using `paths` frontmatter"* — but does **not** expose
the accepted YAML shape (string vs array, glob dialect, whether it composes with an unknown
`scope:` key). A wrong value would make the rule load never, silently, which is precisely
the failure class this whole thread exists to fix: `rule:discernment-checks` §1, and the
same shape as the "three legacy `paths:`-format drafts" that were deleted for
non-conformance with the *wrong* mechanism.

**What would settle it, cheapest first:**
1. Ask the `claude-code-guide` agent for the `.claude/rules/` frontmatter schema — it is the
   sanctioned reader for "does Claude Code do X".
2. Or write a throwaway `~/.claude/rules/zz-probe.md` with a `paths:` value and a unique
   sentinel string, start one fresh session inside a Next project and one outside, and ask
   each whether the sentinel is in context. Two sessions, one deletion, definitive.

Do **not** re-add body injection to `load-rules.mjs` to recover `scope:` — that reinstates
51,112 B/session of duplication to save 53 lines. See the 2026-08-29 DECISIONS entry.

## Rotated to archive

Closed entries live in [`archive/ISSUES-2026-08.md`](archive/ISSUES-2026-08.md), byte-identical.
One line each so an id stays findable from here.

- N1 · Unknown row types are dropped, and the stats are discarded — **S1** — **RESOLVED 2026-08-13**
- N2 · `nextId` is check-then-act racy **and** type-blind — **S1** — **RESOLVED 2026-08-13**
- N3 · Sequential ids cannot survive branches — **S1** — **RESOLVED 2026-08-20**
- N4 · `markStatus` no-ops on an absent or misordered id — **S1** — **RESOLVED 2026-08-13**
- N5 · `hasOpenDuplicateDrift` cannot see `code_drift` — **S1** — **MOOT 2026-08-20**
- N6 · Glob `kind: code` edges silently never fire — **S1** — **RESOLVED 2026-08-20**
- N7 · A missing `PROPAGATE_SEARCH_ROOTS` reports healthy forever — **S1** — **RESOLVED 2026-08-20**
- N8 · Worktree enumeration swallows failure — **S1** — **MOOT 2026-08-14 (watcher retired)**
- N9 · Schema rejection stops a sidecar's edges silently — **S1** — **RESOLVED 2026-08-13**
- N12 · Every `Affects:` line in `DECISIONS.md` parses to nothing — **S1** — **RESOLVED 2026-08-20**
- N13 · `PROPAGATE_SEARCH_ROOTS` does not scope state, so testing the watcher corrupts production — **S1** — **RESOLVED 2026-08-20**
- N17 · `pathProblems` was declared but never incremented — the aggregate check could not fail — **S1** — **RESOLVED 2026-08-13**
- N18 · Source keys are never validated to exist — **S1** — **RESOLVED 2026-08-20**
- N21 · A glob matching zero files must report UNMATCHED, not let its edge vanish — **S2** — **RESOLVED by v2**
- N23 · `WATCHER_LOG` is not test-scoped — `npm test` writes into the production log — **S2** — **impact moot 2026-08-14 (watcher retired)** — **RESOLVED 2026-08-20**
- B1 · Sidecars are branch-local; `doctor` is not branch-aware — **S1** — **RESOLVED 2026-08-15**
- G1 · `check --range` interpolates argv into a shell — **S1, security** — **RESOLVED 2026-08-13**
- N24 · `init` leaves a workspace that `doctor` immediately fails — **S2** — **RESOLVED 2026-08-22**
- N27 · `verify` writes on first invocation while `bootstrap` is dry-run by default — **RESOLVED 2026-08-17**
- N32 · `check` cannot gate a repo that has a sidecar but is not a workspace root — **S1** — **RESOLVED 2026-08-19**
- N33 · Three `lib/*.mjs` carry a literal NUL byte and are invisible to code search — **S2** — **RESOLVED 2026-08-19**
- N34 · Rule restatements — 15 reported, 7 real, 0 remaining — **S2** — **RESOLVED 2026-08-19**
- N36 · The commit-time gate is silently dead for any repo under a symlinked path — **S1** — **RESOLVED 2026-08-20**
- N37 · propagate declares 3% of itself, and the god-file is why — **S2** — **PARTIALLY RESOLVED 2026-08-20**
- N40 · Edge identity is tied to the absolute access path, so the same coupling has different ids by route — **S1** — **PARTIALLY RESOLVED 2026-08-22**
- N41 · ~~S2~~ · **RESOLVED 2026-08-24** · Cross-branch dedupe silently discarded a differing disposition
- N43 · The plugin cutover broke ELEVEN referrers of one deleted directory — **S2** — **PARTIALLY RESOLVED 2026-08-22**
- N44 · The RED phase of a validator test appended two events to the production ledger — **S2** — **RESOLVED 2026-08-22**
- N45 · ~~S2~~ · **RESOLVED 2026-08-24 (fix 2)** · Gotchas documented as auto-firing could not fire, and `--selftest` passed anyway
- N46 · ~~S3~~ · **RESOLVED 2026-08-24** · `watchPathsFor()` hardcoded `docs/`, and stale watch paths were undetectable
- N51 · `parseHandovers` reads fenced examples as real sections — **S2** — **RESOLVED 2026-08-26**
