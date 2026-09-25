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

**2026-09-15 — Phase 2a judged 15 restatements and this issue is UNCHANGED by it.** That
is worth writing down, because the plan that built the restate lane asserted it would close
N35 and the assertion was wrong in a way only measurement caught.

`claims restate`'s corpus is `checkRules`'s `referencedRestatements` — entries that both
CITE a rule and restate it. An unexercised rule is by definition one with `restated 0,
referenced 0`. **The two sets are disjoint by construction**, so no amount of work in this
lane can ever reach the rules this issue is about. All 15 verdicts landed on four rules that
were already `firing`: `tool-priority` (12 restatements), `secrets-source-of-truth` (3),
`environment-vocabulary` and `state-and-decisions` (1 each).

The count has moved on its own, and the membership churned — derive it, never trust this
line (`propagate rules list`). At filing it was 7; on 2026-09-15 it is **5**:
`adversarial-review-reads-the-ledger`, `browser-only-when-asked`,
`enforcement-watches-itself`, `no-waiting-on-deploys`, `safety-flag-needs-a-test`.
Four named at filing have since become adopted or firing — and `enforcement-watches-itself`,
which was NOT on the original list, has since joined it. A rule about checks that exempt
themselves, itself unexercised, is the joke writing itself.

What would actually close this is still what the entry already says: a per-rule known-positive
probe. Phase 2b (the silent set — restates WITHOUT citing) is nearer to it, since it drops the
citation requirement, but it still cannot see a rule that nothing restates at all.

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
undefined Motherboard//Users/<user>/Documents/GitHub/Motherboard/.claude/worktrees/hardcore-villani-778ff0
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

### N63 · `referencedRestatements` is dominated by false positives — the shape N35 asserts was never sampled — **S2** — **OPEN**

**Filed 2026-08-31**, found while answering "how is rule promotion working out".

N35's body introduced this bucket for a sound reason: `checkRules` carried a blanket
``if (raw.includes(`rule:${r.id}`)) continue;``, so a file that pointed at a rule in one line
and kept a stale copy in another was excused entirely. Closing that hole was right.

**What is wrong is the claim attached to the number.** N35 states the pointer-plus-stale-copy
shape "is the most likely shape, not a hypothetical", and the printed label calls each file
"a pointer and a copy in one file, which is what a half-finished conversion looks like".
Neither was measured. The bucket has never been sampled.

**Sampled 2026-08-31 — 8 of the 20 entries, and 7 are false positives:**

| Flagged | What the line actually is |
|---|---|
| `Tushar/CLAUDE.md:88` | ``See `rule:tool-priority`.`` — a pure pointer |
| `Tathya/CLAUDE.md:57` | ``Tool priority / freshness-check workflow: `rule:tool-priority`.`` — pure pointer |
| hub `CLAUDE.md:25` | the Motherboard **repo-map row**, about `go.work` module counts |
| `Rupali/Obsidian/CLAUDE.md:170` | the heading `## MCP Tools: code-review-graph` |
| hub `CLAUDE.md:192` | a citation of the `secrets-source-of-truth.md -> CLAUDE.md` **edge** |
| `Keerti/Keerti-portfolio/CLAUDE.md:82` | pointer + a `kirti-portfolio` Doppler fact — project **compliance** |
| `PanditPawanKaushik/SSJK-mb/CLAUDE.md:16` | pointer + `dev-up.sh --doppler` mechanics — compliance |
| `Vipin Kaushik/CLAUDE.md:166` | a docs-table cell, "Append-only… Never edit past entries" — **borderline**, the only arguable one |

Six of the seven are exactly what the conversion was supposed to produce. Two are
project-specific compliance statements, which `rule:nextjs-dev-server-port` and
`rule:environment-vocabulary` both explicitly exempt in their own bodies: *"A project
describing its own config is compliance, not restatement."*

**Why this matters more than a bad count.** The reading it invites is backwards. The bucket
presents as a 20-item conversion backlog; the conversion is in better shape than that. Acting
on it means editing files that are already correct, and the most likely edit — deleting the
"copy" that is actually a compliance fact — removes real project knowledge.

**It is also N35's own defect pointing the other way.** N35 says the fingerprints are too
NARROW, proven by `never-commit-unless-asked` matching 0 of 47 files while `selftest` passed.
This says that near a `rule:` pointer they are too BROAD. One root cause: **the fingerprint is
a proxy for the claim, and `selftest` only ever tests it against the house-style body it was
derived from.** A check whose only test is self-match cannot detect either error, which is
`rule:discernment-checks` §1 wearing a green badge.

**UPDATE 2026-09-01 — the same defect was ALSO producing the headline number, and it is
now zero.** `rules check` reported **1 restatement across 50 files** all session, which reads
as "almost clean". It was an eighth false positive, from the same cause one level up: the
fingerprint for `secrets-source-of-truth` carried a bare `|Doppler|` alternative, so ANY
mention of the vendor anywhere read as restating the rule.

The flagged passage was `Motherboard/CLAUDE.md:379-380` describing Motherboard's OWN
`environments.json`, in a sentence that explicitly says *"It is DERIVED from
`rule:environment-vocabulary`, which wins if they disagree"*. Textbook compliance, and
flagged under the WRONG RULE — the content belongs to `environment-vocabulary`.

Narrowing the fingerprint to require the CLAIM rather than the vendor name
(`source of truth.{0,60}(env|secret)|vercel-env-(all|audit|sync)`) took the tree to **0
restatements across 51 files scanned**, and dropped the excused bucket from **20 to 16** —
`secrets-source-of-truth` went 6 to 2 there. **Five false positives from one regex
alternative.** `selftest` still passes: the rule body says "Doppler is the source of truth
for deployed env", which the first alternative matches.

So the true-positive rate of this detector on this tree is now measured at approximately
**zero**, in both buckets. That does not mean the detector is worthless — it means every
number it has ever printed was noise, and nobody could tell because the numbers were small
and plausible. A corpus test is no longer a nice-to-have.

**What would settle it, and the order:**
1. Sample the remaining 12 and record the true positive rate per rule. Cheap, no code.
2. Until then, **relabel** the printed line. "restate a rule they also reference" asserts a
   finding; "fingerprint matched near a reference — unverified" states what is known. Do not
   delete the bucket: the hole N35 closed is real.
3. The real fix is N35's own: a **corpus test** asserting each fingerprint against known real
   restatements AND known correct pointers, rather than against its own prose. That single
   test closes the narrow case and the broad case together.

---

### N64 · `rules promote` is declared in three places and built in none — **S3** — **OPEN**

**Filed 2026-08-31**, same pass as N63.

`cli.mjs`'s `rules` dispatch accepts `promote`, and answers:

```
not implemented — `rules promote` is declared in the Phase 5 plan and not built.
```

exit 2. `docs/LIFECYCLE.md` defines PROMOTE, `rules/_TODO.md` describes promotion as the
mechanism, and the usage string advertises it: `rules <list|check|selftest|promote>`.

**Credit where it is due, because this is the good failure mode.** It exits non-zero, names
the gap, and tells you to write the rule file by hand and run `selftest`. Its own comment says
why: *"a command that silently did nothing would be worse than one that admits the gap."* That
is `rule:discernment-checks` §2 applied correctly, and it is the reason this is S3 and not S2.

**The cost is not the missing automation — the practice works by hand.** Active rules went
6 → 11 → 13 → 18, and the 2026-08-16 pass is the model: `plan-opus-execute-sonnet` was
**merged into `model-routing`** rather than promoted to its own rule, "because a second rule
restating Opus-plans/Sonnet-executes is the exact failure this document is about", and the
source memories were deleted so it was a move and not another copy. No command would have made
that judgment.

---

**MEASURED 2026-09-17, and the numbers argue for a narrower fix than "build the command".**

An audit of how all 18 rules actually came to exist, plus a full gotcha census, was run to
answer whether promotion happens at all. It does.

**6-7 of 18 rules (~35%) show direct, dated evidence of promotion** from a project,
memory, or convention origin — not inferred, but named in commit messages and rule bodies:

| rule | evidence |
|---|---|
| `skill-routing`, `state-and-decisions` | first commit: *"rules: **promote** … to canonical"* (2026-08-14) |
| `enforcement-watches-itself` | first commit: *"**promote** 'an enforcement point that does not watch itself' to a rule"*; G48 records the other end |
| `safety-flag-needs-a-test` | `_TODO.md`: *"generalises propagate GOTCHAS G22, N27, and G44"* |
| `browser-only-when-asked`, `no-waiting-on-deploys` | `_TODO.md`: *"Three project-scoped memories promoted 2026-08-16"* |
| `discernment-checks` §4 | `keerti-job-radar/GOTCHAS.md`: *"Cost: **promoted** to `rule:discernment-checks` §4"* |

Cadence during the active window: **roughly one promotion every 3-4 days** (2026-08-14 …
2026-08-24), tapering after.

**So the hub `CLAUDE.md`'s line — "a proven local gotcha has no promotion path to
`rules/gotchas-global.md`" — is accurate about MECHANISM and overstates the PRACTICE.**
Worth correcting there, because "no path" reads as "never happens" and a third of the rule
set says otherwise.

**The real defect is LATENCY.** `rules/_TODO.md` has carried 4-5 unwritten rules since
2026-08-14 (last touched 2026-09-10). `LIFECYCLE.md` already priced one lag: *"the general
form of the most expensive one sat in `rules/_TODO.md` for three days while its hazard
fired twice more, for 11 spurious events."* The hand path works; it is just slow, and slow
is expensive when the thing waiting is a hazard that keeps firing.

**The design Rupali chose 2026-09-17: ASSISTED, human decides.** Surface candidates,
draft, let a person write and commit. Explicitly NOT mechanical promotion — this entry's
own 2026-08-16 example (merging `plan-opus-execute-sonnet` into `model-routing` instead of
creating a second rule) is the judgement no command would have made, and N76 spent a day
proving machine-authored fingerprints are hard. `LIFECYCLE.md`'s exit criterion already
demands *"the fingerprint does not punish the behaviour the rule wants"*, which is a
judgement call by construction.

**The candidate predicate already exists and nothing evaluates it.** `rules/gotchas-global.md`
states its own admission bar: ***"it has already repeated, or it fired while documented."***
Both halves are measurable — "repeated" is the same hazard present in ≥2 project
`GOTCHAS.md` files; "fired while documented" is a guard hit on an entry that already
existed. A surfacing pass against that bar is the whole of the assisted design, and it
needs no new vocabulary because the bar was written down a month ago.

**Census backing it** (2026-09-17): **23 `GOTCHAS.md` files**, 4 of them pointer stubs,
**427 entries / 426 live**, of which **216 (~51%) carry a `**Trigger:**`** — the untriggered
half is the documented correct default, not debt. Trigger liveness tree-wide:
`selftestProblems()` reports **0 problems**, so every declared trigger fires. The per-file
ratio is invisible for a separate reason — see **N80**.

**One real duplication found, and it is not promotion:**
`propagation/state/curate-docs-skill/GOTCHAS.md` and
`propagate/propagation/state/curate-docs/GOTCHAS.md` are **byte-identical through line 203**,
the second carrying two later entries. Two copies of one project's file at two paths, neither
removed — the restatement failure `every-project-carries-gotchas` warns about, at
project-to-project scope. Worth its own decision about which path is canonical.

**The cost is that the usage string promises a capability the tool does not have.** Per
`rule:description-standard`, a thing that announces itself must say when it applies; an
advertised subcommand that always exits 2 is an announcement with no referent. Either build it
or drop `promote` from the usage line and leave the stub reachable for anyone who types it.

### N65 · The update notice printed to stdout, corrupting every `--json` consumer — **S1** — **RESOLVED 2026-08-31**

**Found 2026-08-31** by bumping `VERSION` 0.3.0 → 0.4.0 to finish a half-done fan-out.
Six `tests/cli/status-coverage.test.mjs` tests went red with:

```
SyntaxError: Unexpected token '', "[2mpropag"... is not valid JSON
```

`cli.mjs` wired the update check for `status` and `doctor` and emitted it with
**`console.log`**. Both commands have a `--json` mode, so the dim human line

```
propagate 0.3.0 → 0.4.0 available: git -C … pull · silence it with `updateCheck: off`
```

landed **ahead of the JSON document**. Every machine consumer died on `JSON.parse`.

**Fixed** by changing that one call to `console.error`. The notice is still shown to a human
in a terminal; it is no longer in the data stream. Suite: 1257/1257 and 91/91 green.

**Why it stayed invisible.** The notice only renders when a newer version is detected, and on
a normal working tree `VERSION` equals the served plugin version, so it never fires. It
becomes reachable the moment someone bumps `VERSION` — **which `gateVersionManifests` requires
before a release.** So the failure was scheduled to arrive at release time, on the run where
the tooling is trusted most, and could not appear before then.

**The part worth keeping.** `lib/core/update-notice.mjs`'s own header records that it exists
*because* the check "was written and then invoked by nothing … GOTCHAS G48, an enforcement
point that does not watch anything." Wiring it up was right. But the fix for *"a capability
nobody invokes"* introduced *"a capability that corrupts every automated caller"* — and it did
so in a way no existing test could see, because the tests that parse `--json` only exercise
the version-equal path.

**The general form, which is not fixed by this commit.** Nothing asserts that a command with a
`--json` mode emits *only* JSON on stdout. Any future banner, hint, deprecation notice or
warning added near a `--json` path reintroduces this exact defect, silently. A cheap guard
would be a test that runs every `--json`-capable command with a forced notice condition and
asserts `JSON.parse(stdout)` succeeds — `rule:discernment-checks` §1: construct the input that
makes the check fail before shipping it. **Filed here rather than done, deliberately: the
one-line fix is verified, the general guard is a separate change.**

### N68 · A nested `.propagates-cross.yml` is unreachable, so `doctor`'s cross-repo check reports clean over edges it never enumerated — **S1** — **RESOLVED 2026-09-14**

Found 2026-09-14, draining the worklist in `Vipin Kaushik/astro-studio`.

`discoverCrossReposSync` (`lib/edges/cross-repo.mjs:138`) stops descending the moment it finds
a cross sidecar:

```js
if (existsSync(path.join(dir, FILE_NAME))) {
  out.push({ name: path.basename(dir), root: dir });
  return; // don't recurse below a found cross repo
}
```

`Vipin Kaushik/.propagates-cross.yml` exists, so the walk returns at that directory and
`Vipin Kaushik/astro-studio/.propagates-cross.yml` — **7 declared cross edges** — was never
enumerated. Not a `maxDepth` problem; reproduced at `maxDepth: 5` on a two-level fixture,
2 sidecars on disk, 1 discovered.

**Why it is S1 rather than S3.** `doctor` has a check for exactly this failure and it was
GREEN throughout: `✓ cross-repo edges resolve  4 edges, 0 missing, 0 outside-allowlist`.
Meanwhile all 7 undiscovered edges resolved `{ok:false, reason:"missing"}` — they pointed at
`~/.hermes/hermes-agent`, a repo absent from the machine, through a `../../../` that lands in
`~/Documents` rather than `~/`, for an integration removed around 2026-09-02. The count stayed
at `4 edges` after the file was deleted, which is how the gap was confirmed.

So this is not "a check that is missing". It is `rule:discernment-checks` §2 and
`rule:enforcement-watches-itself` together: **"found nothing" and "looked at nothing" rendered
identically**, and the one that was true read as a pass. A reviewer trusting that line would
have concluded the tree's cross edges were healthy.

**FIXED, same day.** Two changes, both in this entry's own terms:

1. `lib/edges/cross-repo.mjs` — the walk no longer `return`s after pushing a found sidecar. A
   sidecar marks a participating directory, not a subtree boundary.
2. `cli.mjs` `checkCrossRepo` — now returns `sidecars` and `unreadable` alongside the edge
   counts, and doctor leads its detail line with the CORPUS:
   `✓ cross-repo edges resolve  2 sidecar file(s) scanned — 4 edges, 0 missing, 0 outside-allowlist`.
   An `unreadable` sidecar now FAILS the check rather than being skipped in silence — a check
   declining to look must never render as a pass.

**Verified against the real tree, not only fixtures.** The deleted
`astro-studio/.propagates-cross.yml` was restored from `b91f494` and `checkCrossRepo` re-run
over the hub:

| | sidecars | edges | missing | doctor |
|---|---|---|---|---|
| before the fix | *(not reported)* | 4 | 0 | ✓ green |
| after the fix | 3 | 11 | **7** | ✗ red, naming all 7 |

The same tree, the same file: a silent green became a correct red. That comparison is the
evidence, because the edge count *alone* did not move once the offending file was deleted —
`2 sidecars, 4 edges, 0 missing` looks identical before and after, and only the corpus figure
distinguishes them. Which is the whole point of adding it.

**Guards, 4 of them** (`tests/unit/cross-repo.test.mjs`, `tests/cli/cross-doctor.test.mjs`):
nesting is discovered; nesting is discovered at `maxDepth` 2 AND 5, so a future "fix" that only
widens the bound still fails; `checkCrossRepo` reaches the nested sidecar and reports
`sidecars === 2`; an unparseable sidecar counts as `unreadable`, never as clean. All four were
written FIRST and confirmed red on the old code. Re-mutating the `return` back turns exactly
the three nesting guards red and leaves the orthogonal `unreadable` one green.

### N67 · `rotted-citation` cannot tell a live citation from a recorded supersede — **S3** — **OPEN**

Found 2026-09-10 while fixing the very thing it reports, in `Vipin Kaushik`.

`findDeadBranchCitations` fires on any literal occurrence of an absent branch name. It has no
way to distinguish **"cited as if the branch still exists"** from **"explicitly recorded as
gone, and here is where the work landed"** — and a supersede note *must* name the branch, or
a reader cannot tell what was superseded.

Measured: three `rotted-citation` findings on `docs/constitution/VIPIN.md` and
`docs/design/DESIGN.md`. Fixing all three — rewriting each citation to say the branch is gone
and to name the merge commit that carries the work (`b0ce3fc`, `df63c32`/PR #185) — moved the
count **4 → 3**. Only the self-line citation cleared. The three dead-branch findings survive
their own fix, because the fixed text still contains the branch name.

**The perverse incentive is the point.** The only way to satisfy this check is to delete the
branch name, which destroys the information the supersede note exists to carry. A checker
that rewards making a record less useful will be ignored, and then it protects nothing.

**Suggested:** treat a citation as settled when the branch name is adjacent to a supersede
marker — a merge SHA, "no longer exists", "superseded", "landed in". Narrow is fine; the
current behaviour has a 100% false-positive rate on correctly-superseded citations.

**A second defect in the same check, found in the same pass.** For
`DESIGN.md:1000` → `feat/hero-v4-rebuild`, `resolveRepo` resolved the CITING file to the
workspace repo (`repoRoot: Vipin Kaushik`, branches: `main` only) and checked there — but that
branch only ever existed in `VipinKaushik/`. The verdict came out right **by luck, not by
mechanism**. The latent form: a workspace doc citing any live sibling-repo branch — including
`` `production` ``, which does not exist in the workspace repo — reports as dead. This is the
citation-side analogue of G13, "`check --changed` only sees the repo it runs from".

**Related, cosmetic but easy to trip over.** `asQuestions` (`lib/claims/judge.mjs:105`) emits
`kind_hint` from the *structural* block kind — `prose` / `list-item`. A verdict's `kind` wants
a CLAIM kind (`fact` / `policy` / `quote` / `impression` / `aspiration`). Passing the hint
straight through is rejected by `validateClaim`, which is the good outcome; the bad one is a
reader assuming the tool has pre-classified the claim. Two vocabularies, one field name.

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

### N66 · `make-public` refuses because its watchlist does not recognise propagate's own directories — **S2** — **OPEN**

**Found 2026-09-01**, while checking whether the publishable tree could be rebuilt before
pushing the claims lane. `bin/make-public.mjs --out <tmp> --check` never reaches the scrub:

```
3 WATCHLIST DIRECTORIES ARE UNMAPPED:
   Divyansh
   propagate
   propagation
```

Two of those three **are this tool's own directories.** The watchlist source is every
depth-1 directory under `SEARCH_ROOTS` — chosen deliberately, and correctly, over workspace
discovery, because real client names leak into docs without carrying a `.propagates.yml`
marker (`tests/portability/make-public-watchlist.test.mjs` states that reasoning). But the
hub root holds `propagate/` and `propagation/`, which are the plugin and its ledger, not
identities. So the check demands they be mapped to pseudonyms or allow-listed, and until
someone does that by hand on each machine the release path cannot run at all.

`Divyansh` is a genuine gap of the intended kind — a workspace added after the map was
last written, which is exactly what the watchlist exists to catch. The other two are the
mechanism failing to exempt itself.

**Why S2 and not S3.** `rule:enforcement-watches-itself` names this shape directly: *"a
mechanism that enforces a property on others and is exempt from it reports success
forever"* — here it is the mirror, a mechanism that cannot complete because it does not
recognise itself, which is the same missing question. And the consequence is not cosmetic:
the scrub is the only thing standing between the private working copy and a public
distribution, so a scrub that never runs is a scrub nobody notices is absent. The CI job
asserts `make-public` exits 2 *without* an identity map; it does not assert that it exits
**0 with one**, so a green suite is compatible with a release path that has never
completed on any machine.

**The fix is mechanical, not data.** Adding `propagate` and `propagation` to a per-machine
`allow` array works and is wrong — it must be re-done on every clone, and a per-machine
data edit is invisible to the next reader. The tool knows its own repo root (`REPO`) and
its ledger directory; both should be exempt by construction, with `Divyansh` left to fail
loudly as designed. Then assert it: a test that runs `--check` against a harness root
containing a directory named like the tool's own and expects exit 0.

**Note the scope this does NOT cover.** `origin` for this working copy IS the public repo
(`Rupali59/propagate`, verified PUBLIC via `gh repo view` 2026-09-01) — there is no second,
scrubbed remote. So `make-public` builds a distribution that has never been the thing
anyone pulls, and 66 files on `origin/main` already carry workspace and client names. That
is a larger question than this entry: **is the intended posture "the repo is public and the
names are acceptable", or "the repo should have been the scrubbed copy all along"?** The
two answers imply very different work and the tree currently asserts both. Filed separately
rather than resolved here, because it is a decision, not a defect.

### N69 · `verify` silently discards unknown flags, so a justification can be written to nothing — **S1** — **OPEN**

Found 2026-09-14, auditing this session's own verification events.

`verify`'s documented flag is `--reason` (`cli.mjs:84`, parsed at `cli.mjs:2718` via
`get("--reason")`). `--notes` exists, but only for `drain` (`cli.mjs:45`). **There is no
unknown-flag rejection anywhere in the arg parser.** So `verify --edge X --disposition
no-change-needed --apply --note "<the whole justification>"` is accepted, exits 0, prints
`✓ <edge> no-change-needed → CLEAN` with an event id — and the note is silently dropped on
the floor.

**Measured, in this machine's own store:**

```
events in store                     2771
carrying a `reason`                 2629   (95%)
written 2026-09-14 with `--note`      20
  ... carrying any justification       0
```

Twenty verification events — 5 `both-reconciled`, 15 `no-change-needed`, closing a real
15-edge cascade — landed with no record of *why*. The measurements that justified them
("0 matches for the changed claim in this downstream", and the per-edge reasoning for each
override) exist now only in a chat transcript. The store is append-only, so they cannot be
repaired in place; they can only be superseded by re-emitting.

**This is the file's own root-defect section, in a new place.** The command reported
success, wrote a well-formed row, and the only signal that anything was lost is that the
`reason` field is absent — visible solely by reading the JSONL. A caller cannot distinguish
"I chose not to give a reason" from "I gave one and the tool ate it".

**Two fixes, and the second is the one that generalises.** Accept `--note` as an alias for
`--reason` (cheap, and it is the obvious word). Then **reject unknown flags across every
subcommand** — a typo'd or misremembered flag must exit non-zero, not proceed with a silently
different meaning. `rule:discernment-checks` §2: absence must be attributable. A dropped
argument is an absence that currently attributes to nothing.

**Test it can fail:** invoke `verify` with a bogus flag and assert a non-zero exit; and
invoke it with `--note` and assert the written event carries the text in `reason`. Both
assertions must be made against the **event row**, not against stdout — stdout was correct
and reassuring throughout this incident.

**The 20 lost justifications, recorded here because the store will not take them back.**
Re-emitting was attempted and **refused**, correctly: `verify --edge fa432c23 --disposition
both-reconciled --reason "..."` returns *"both-reconciled only applies to a DIVERGED edge;
this edge is CLEAN"*. The edges resolved, so their state no longer admits the disposition
that was recorded against them — which means a justification lost at write time can **never**
be attached later by any supported path. That raises the severity of N69: it is not a
cosmetic gap pending a backfill, it is unrecoverable the moment the command returns.

| edge | disposition | the reason that was dropped |
|---|---|---|
| `fa432c23` | both-reconciled | INVENTORY + DATA_GAPS both edited 2026-09-14; DATA_GAPS named SarvarthaChintamani, JaiminiSutras, JatakaTattvam as undigitised, all three held since 2026-09-04 (astroacharya `ab381b6`) |
| `e82c6e94` | both-reconciled | `reference.md`'s chapter workflow was stale three ways — a Youvan BPHS path that no longer holds BPHS, `split_chapters.py` (0 found), and `english_meaning`/`hindi_meaning` (banned, 0 occurrences). Rewritten in `58c69a7` |
| `e377000b` | both-reconciled | Both restructured together in sanskrit-texts `e7de37b`; `check_inventory.py` now fails if they disagree |
| `2cb348a4` | no-change-needed | `list_sources.py` derives `text_id → path` at runtime (`rglob`, line 321); its own comment at line 282 records that re-hardcoding was tried and rejected |
| `6a114165` | both-reconciled | Both stale in the same direction, both now defer to INVENTORY §"Acquisition status" |
| `044c244c` `443b497a` `7ba9fb83` `eabf9f7f` `4a1ed4dd` `d637fc1b` `c4ea2ba6` `0ff35726` `c560f4a7`† `ddb50853`† | no-change-needed | Workspace `CLAUDE.md` was edited independently (`53ea6a8`, a stale Vedic held-count replaced by the command that derives it). None of these ten sources moved; the edge read REVERSED only because the downstream post-dates it |
| `dba8ae6a`† `f86b500c`† `0def67b0`† `e2488f80`† | no-change-needed | Measured against each downstream: **0 matches** for `29 held`, `24 Upanisad`, `51 mapped` or `mukhya`. Nothing there restates the changed claim |
| `c0e01c6d`† | both-reconciled | Both edited and read together; neither claim depends on the other |

**† = written with `--out-of-order`** (7 edges). Each was blocked by an upstream that is
`NEVER_VERIFIED` — a baseline gap, not a known-wrong source — and each disposition rested on a
direct measurement of the *downstream*, not on the upstream being correct. **That fact is
recoverable only from this table; the events themselves record nothing (N70).**

### N70 · `--out-of-order` leaves no trace, so an overridden verification is indistinguishable from a clean one — **S1** — **OPEN**

Found 2026-09-14, alongside N69.

`verify` refuses (exit 3) when an edge's source is itself unsettled, and `--out-of-order`
deliberately overrides that refusal. The skill documents the override as the sanctioned
escape hatch. **But the flag is recorded nowhere in the emitted event.**

```
fields ever seen across 2771 events:
  edge_id node_id disposition by event_id ts hash_alg observed_on_ref
  source_content downstream_content reason observed_at_commit observed_on_branch
  observed_dirty by_kind downstream_on_ref downstream_at_commit
  downstream_on_branch downstream_dirty source_git_blob

events carrying `out_of_order` / `override`:   0 of 2771
```

So an edge pinned against a source that was **known to be unsettled at the time** reads,
forever after, exactly like one verified against a settled source. `status` shows CLEAN for
both. The ordering guard exists precisely because verifying out of order "pins content
against an unconfirmed source" — and the record of having done so is discarded at the moment
it is created.

**Why S1 rather than S3.** This is N19's shape (terminal status with no Transition, no audit
trail) applied to the one operation the tool treats as dangerous enough to refuse by default.
It also defeats review: `rule:adversarial-review-reads-the-ledger` says to read the ledger
before trusting a green result, and the ledger cannot answer "which of these were forced?".
Seven such overrides were written on 2026-09-14 and none is recoverable from the store — a
subsequent agent searching the events for them concluded, reasonably and wrongly, that the
cascade had never happened.

**Fix:** persist the override as a first-class field (`out_of_order: true` plus the blocking
upstream edge ids that were bypassed), and surface it — `status`/`graph` should mark a CLEAN
edge whose last verification was forced, because that is a weaker claim than an ordinary
CLEAN and currently renders identically.

### N71 · `NEVER_VERIFIED` is reported for edges that were examined and deferred, and the remediation offered is wrong for all of them — **S1** — **RESOLVED 2026-09-15**

Found 2026-09-14, after it caused a full round of duplicated work.

`status` renders:

```
142 edges · 110 verified · 31 never verified · 1 need attention
  never verified (31) — a baseline gap, not drift. `bootstrap` to triage.
```

Measured against the event store, all 31 of those edges carry an event:

```
edges reported NEVER_VERIFIED : 31
  ...of which HAVE events      : 31
  ...genuinely never touched   : 0
dispositions: {'deferred': 31}   dates: {'2026-09-10': 31}
```

Every one was read, judged, and deliberately deferred four days earlier, each with a
substantive `reason`. Not one is a baseline gap.

**The data is not missing — the summary discards it.** `reconcile --json` returns a full
`deferred` object beside the state for these edges (`{disposition: "deferred", by:
"<user>", observed_at_commit: fc4564df…}`), exactly as `lib/edges/reconcile.mjs:283`
declares (`state, since, last, deferred`). `status` reads that structure and prints only
the state name.

**Internally the state machine is defensible** — `lib/edges/migrate-ledger.mjs:507` records
that deferred is deliberately "A FLAG, NOT A NINTH STATE", and `last` is genuinely `null`
because no *verifying* disposition was applied. The defect is entirely in what the user is
told.

**What it cost.** Believing the summary, a session filed the 31 as a baselining backlog,
confirmed via two `bootstrap --baseline-from-git` dry-runs that **0** were `baselineable`,
then dispatched four subagents to hand-verify 26 of them. Three lanes returned before the
duplication was noticed, and every finding they produced **already existed in the deferred
reasons from 2026-09-10** — re-derived from scratch at roughly 390k subagent tokens.

The re-derivation did earn two things, which is the only reason this is not a total loss:
the recorded reasons were independently confirmed accurate, and one was found to carry a
**wrong supporting timeline** (`d4496acc`/`ae4de1cd`/`4ec364cb` assert `-mb`'s
`Appointment.js` postdates VK's model by three weeks; `git log --follow` shows two commits,
the first `ad1ce8c` 2026-05-13, which *predates* it by six days — the conclusion stands on
the import/enum evidence, the sequencing argument does not).

**This is N68's shape and `rule:discernment-checks` §2 again: "not looked at" and "looked at
and parked" rendering identically.** It is the third instance in this file.

**Fix.** Split the count and the advice. "Never verified" must mean *no event of any kind*;
edges carrying a `deferred` flag want their own line — `31 deferred (examined, not resolved)
— see \`why <edge>\`` — and must not be offered `bootstrap`.

**CORRECTED 2026-09-15 — this sentence used to end "which cannot touch them", and that was
false.** `bootstrap --baseline-all` filtered on `state === "NEVER_VERIFIED"` and the word
`deferred` appeared nowhere in `lib/edges/bootstrap.mjs`, so it could overwrite a deliberate
defer with a baseline. That is the S1 fixed in #14 — filed a day later, by someone who went
looking rather than believing this line. An issue asserting a safety property the code does
not enforce is `rule:safety-flag-needs-a-test` one level up: the unverified claim was in the
tracker instead of in a flag, and it is *more* dangerous there, because a flag at least gets
read at the call site. If
splitting the rendering is deferred, the minimum is to stop printing remediation that is
provably wrong for every edge in the bucket.

**Test it can fail:** defer an edge in a fixture, then assert `status` does not describe it
as never-verified and does not recommend `bootstrap` for it.

---

**RESOLVED.** Two commits, because the defect had two halves and only the first was visible
from this entry.

| | |
|---|---|
| `d167be6` (#13) | `status` splits the count: `316 never verified · 33 deferred`, and stops offering `bootstrap` where it cannot help |
| `6da8b72` (#14) | `bootstrap` genuinely cannot touch a deferred edge — the split happens **before** any policy branch, so no future flag re-opens the hole |

The second is the one this entry's own text argued was unnecessary. Reading the guard at the
call site, rather than the sentence describing it, is what found it.

### N72 · The restatement pairer anchors on the heading, so real restatements are never examined — **S2** — **OPEN**

Found 2026-09-15, while judging the 15 entries Phase 2a handed over.

`checkRules` reports the line where a rule's fingerprint matched. For the `tool-priority`
fingerprint that line is very often a section title — `## MCP: code-review-graph` — or the
HTML comment above it. `splitBlocks` correctly classes both as structure rather than a
claim, so `findClaimBlock` returns no block and the entry is reported UNPAIRED.

That reporting is honest. The problem is what it hides.

```
15 corpus entries
   5  paired and judged
  10  unpaired  ← 9 anchored on a heading or comment, 1 a genuine filename false positive
```

**Two of those ten carry a real restatement in the paragraph directly below the anchor**,
which the lane never read:

| file | what sits 2 lines under the anchor |
|---|---|
| `Rupali/Obsidian/CLAUDE.md` | "this repo has the `code-review-graph` **pre-commit** git hook installed, so its graph refreshes on commit — not on file change, and never for uncommitted work" |
| `Vipin Kaushik/VipinKaushik/CLAUDE.md` | "run `code-review-graph status` to check the built commit is an ancestor of HEAD before trusting it" |

Both restate the rule, both are accurate, and both were ruled `consistent` **only because a
human read the file**. Effective automated coverage of this corpus is 5 of 15, and nothing
in the output distinguishes "the anchor was structure" from "this file does not restate the
rule" — which is the same two-states-worn-as-one shape as N71 and N68
(`rule:discernment-checks` §2), now in the pairer.

The severity is in the direction of the error. An unpairable entry is reported and visible;
a real restatement sitting under it is **invisible**, and would stay invisible through any
future drift.

**Fix.** `findClaimBlock` should walk forward from a structure anchor to the next judgeable
block rather than giving up — a heading is a *label for* the prose beneath it, so that prose
is the natural claim candidate. Bound the walk (one or two blocks) so it cannot drag in an
unrelated section.

**Test it can fail:** a fixture whose `## Heading <fingerprint>` is followed by a paragraph
that restates the rule; assert it PAIRS and that the paired block is the paragraph, not the
heading. Then mutate the walk away and confirm it goes back to unpaired.

### N73 · A verdict written for an unpairable entry was inert — **S2** — **RESOLVED 2026-09-15**

Found 2026-09-15 by grepping for callers of a function that had just been built.

`unpairedSha` was added in #16 so an entry the pairer cannot pair could still be
dispositioned, and `tests/unit/claims-verdict.test.mjs` asserts it yields "a valid
`block_sha`, so a verdict can key to it". **Nothing ever keyed one.** `restateStatus` built
`judgedByKey`, consulted it for `pairs`, and returned `unpaired` verbatim — so every verdict
written for an unpairable entry was a no-op, and the same entries would re-report on every
run forever. The lane could not converge, which is the single thing the hash was introduced
to fix.

Identity built, unit-tested, no consumer: `rule:enforcement-watches-itself`. The tests passed
identically whether or not a consumer existed, because they tested the hash rather than the
wiring. **Grepping for callers of what you just built is the check that catches this shape,
and it costs one command** — the same move that found the dead `radar.mjs` and the
zero-caller filesystem walk recorded in that rule.

Caught before it cost anything: the defect was found while preparing the first 15 verdicts,
so no inert verdict was ever written.

**Fixed.** Each unpaired entry now carries `against` (the derived fact's sha), and
`restateStatus` splits unpaired into `judged` / `awaiting` / `undispositionable` — the third
because an entry whose rule will not load has no fact, `validateClaim` refuses a `finding`
without an `against`, and advertising it as "awaiting judgment" would promise work nobody can
do.

**Guards** (`tests/unit/claims-restate.test.mjs`): a verdict moves an entry out of awaiting;
the same entry with an EMPTY store stays awaiting (so the first test measures something); a
fact-less entry is undispositionable rather than awaiting. Mutation-checked — disabling the
lookup fails exactly one test with the stated message, and the revert is byte-identical.

### N74 · The restatement walk pairs the FIRST judgeable block, which is often the citation — **S3** — **OPEN**

Found 2026-09-16, immediately after N72's fix landed, by judging what it produced.

N72 made `findClaimBlock` walk forward from a structure anchor to the next judgeable
block. That raised coverage from 5 of 15 to 8 of 15. But it takes the FIRST judgeable
block, and in this corpus the first block under a `## MCP: code-review-graph` heading
is very often a pointer line rather than the restatement.

Worked example, `Rupali/Obsidian/CLAUDE.md`:

```
## MCP Tools: code-review-graph          <- anchor (structure)
See `rule:tool-priority` for general …   <- block the walk pairs: a CITATION
Local: this repo has the `code-review-   <- the actual restatement, one block further
graph` **pre-commit** git hook installed …
```

So the entry pairs, gets judged `unrelated` — correctly, *for that block* — and the
real restatement below it remains unexamined. The verdict is not wrong; it is about
the wrong text. That is a subtler failure than N72's, because the lane now reports
the file as handled.

**Not worth widening the bound.** Walking further would pair headings with
arbitrary later prose, which N72's own fixture deliberately guards against. The fix
is candidate SELECTION, not distance: among judgeable blocks within the bound,
prefer the one whose text actually matches the rule's fingerprint most strongly,
rather than the first one encountered. A bare `See rule:x.` line matches a
fingerprint only incidentally.

**Test it can fail:** a heading followed by a pointer line and THEN a restating
paragraph must pair the paragraph. That fixture does not exist today — N72's
fixtures all place the restatement first.

### N75 · `plans --check` counts subagent plan-mode artifacts as authored plans — **S2** — **OPEN**

Found 2026-09-16, the day `plans --check` was built, by running it on the real corpus.

Of 11 post-template plans it flagged, **5 are `*-agent-<id>.md`** — files written
automatically when a subagent inherits plan mode and drafts a plan it never executes.
One more is a design doc that merely lives in `plans/`. Only a handful were authored
by a person as plans.

Those artifacts will never carry an arrival condition and should not. Worse, the
count rises every time a subagent enters plan mode — **eight times in the session
that built this checker**. That is exactly the shape prior learning
`count-ratchet-over-growing-population` names: *"a raw COUNT over a population that
grows with authorship measures output, not debt — it trips when you write, not when
quality drops."* The lane was built specifically to avoid that trap via the
2026-09-14 date gate, and then walked into it through a different door.

**Fix.** Classify `*-agent-<id>.md` as its own kind and report it as a separate
count, never folded into the conformance total. Do NOT simply exclude it silently —
"0 flagged because we stopped looking at half the corpus" is the failure this repo
keeps paying for. Report it as `N agent-generated (not graded — not authored plans)`,
the same way the lane already reports what doc-kind excluded and why.

**Note the naming is a convention, not a guarantee.** The `-agent-<hex>` suffix is
produced by the harness; a future change to it would silently re-merge the two
populations. Assert the pattern in a test so the drift is visible.

### N82 · The workspace census cannot tell "looked and found nothing" from "looked at nothing" — two empty directories pass, one real repo is invisible — **S1** — **OPEN**

Found 2026-09-17. Two symptoms, one root: the layout report tests for **presence of a
path**, never for contents, and enumerates only what it already knows about.

**RAISED S2 -> S1 on 2026-09-23, on a third symptom that is worse than the two it was
filed on.** `doctor`'s conformance check over an EMPTY POPULATION renders as a pass:

```
{"kind":"pass","label":"workspaces conform to the v3 propagation layout","detail":"0/0 conform"}
```

The predicate is `rep.offenders.length === 0`, which is **vacuously true over an empty
set**. So it is not only that an empty directory passes — the whole check passes having
examined nothing, and prints the emptiness as though it were the result. Reproduced
directly while building slice 1, by constructing a `Reporter` and running
`checkDiscovery` in an environment where `SEARCH_ROOTS` is `[]`.

**Why S1 rather than S2.** This repo's scale: S1 is "silently wrong (you cannot tell it
happened)". A green tick reading `0/0 conform` is indistinguishable from a green tick
reading `22/22 conform` to anyone scanning the report, and `GOALS.md` goal 1 names
`propagate doctor` as its derivation — so an unmeasurable tree currently satisfies a goal
by returning nothing. Nothing about the output says which happened.

**Symptom 2 is now addressed** (`b164a9f`, N87 slice 1): the census is owner-based and
`propagate` appears in it as a half-migrated offender. Symptom 1 and this third one
remain, and both belong to the doctor slice-2 work in
`docs/plans/2026-09-23-doctor-slices-2-3.md` — a check whose predicate can be satisfied by
an empty input becomes `inconclusive`, never `pass`.

**Symptom 1 — an empty directory is reported conformant.** Measured:

```
Khushboo/propagation/state/workspace/   0 entries   ECOSYSTEM.md: "**Layout** — conformant."
Rishabh/propagation/state/workspace/    0 entries   ECOSYSTEM.md: "**Layout** — conformant."
```

`rollup`'s conformance check asserts `state/` **exists**. Both directories do exist and
hold nothing. Counted properly across the tree: **17 `propagation/state/workspace/`
directories, 15 non-empty, and only 10 carrying the `STATE.md` the rule requires.** All
four of Tushar's projects have a `.sidecar.yml` and neither `STATE.md` nor `DECISIONS.md`.
`rule:discernment-checks` §2 in one sentence: found-nothing and looked-at-nothing must not
render alike.

**And the tool that defines the standard fails it.** `propagate` itself is one of only two
NON-CONFORMANT workspaces, missing **4 of 5** required items (`README.md`, `INDEX.md`,
`refs/snapshot.json`, `refs/lifecycle.jsonl`); `propagate/propagation/` holds only
`state/`. `rule:enforcement-watches-itself`, landing on the repo whose job is catching
exactly this.

**Symptom 2 — `firstmate/` is enumerated nowhere.** A real git repo at the hub root,
absent from `propagate status --all`, from `ECOSYSTEM.md`, and from the hub `CLAUDE.md`
repo map. It has no `propagation/`. `Motion-Graphics` at least gets a NON-CONFORMANT row;
`firstmate` gets no row at all.

Its remote is `github.com/kunchenguid/firstmate` — **not** a `Rupali59/*` repo — so it may
well be a vendored clone that *should* be exempt. **That is the finding, not a mitigation
of it:** there is no way to tell a deliberate exemption from an invisible repo by reading
any report. Both render as silence.

**Why these are one issue.** Fixing the conformance check to read contents would still
leave `firstmate` unlisted, and listing `firstmate` would still leave two empty
directories green. The shared root is that the census has **no vocabulary for absence** —
no "present but empty", no "exempt, because —", no "found, not enumerated". Three
different silences currently render identically.

**Expected consequence of fixing symptom 1, so nobody is surprised:** two workspaces flip
from green to red. That is the check starting to work, not a regression.

**Test it can fail:** create an empty `state/workspace/` in a fixture and assert the
conformance line does NOT read `conformant`. Today it does.

**Derive, do not trust the counts above** — `propagate rollup --check`, plus a `node` walk
of `*/propagation/state/workspace/`. Not `grep`: the ugrep shim honours the hub's `/*`
`.gitignore` and returns false zeros, measured again during this very census (a reference
search returned 1 file by `grep -rl` and 41 by `find | xargs grep`).

---

### N83 · Hub `CLAUDE.md` currency is enforced for 4 of 16 workspaces — the other nine can rot invisibly — **S3** — **OPEN**

Found 2026-09-17. The hub's repo map describes every workspace. Only four workspaces
declare an edge that would notice when their row goes stale.

**Declared `<workspace>/CLAUDE.md -> CLAUDE.md`:** Divyansh, Keerti (×3), Motherboard.
**Not declared:** Vipin Kaushik, Tathya, PanditPawanKaushik, Rupali, Tushar, Anushka,
ManavDaehi, and the rest.

This is exactly the failure the `Rupali/.propagates-cross.yml` edge was added to close on
2026-09-14 — after `claude-usage-sample` ran unregistered for four days — and the closure
was never generalised beyond the one workspace that had just been bitten.

**Evidence the rot is real, not theoretical.** The hub `CLAUDE.md`'s own `Rupali/` row
carries a note that it *"was wrong about presence in both directions"* — three projects
listed as live and absent, two listed as gone and present — and says why that is worse than
being merely stale: **neither error is detectable by reading it.**

**Not recommending the sweep.** Generalising means nine new declarations across nine repos
with independent branch lines and pre-existing uncommitted work — the convention rollout
declined on 2026-09-17. Filed so the exposure is visible and the decision is deliberate.

**Test it can fail:** edit a workspace's `CLAUDE.md` identity section and assert
`check --changed` names the hub `CLAUDE.md`. True for four workspaces today, false for nine.

---

### N84 · Every in-tree ledger is empty and all 2839 events live outside every git remote — undecided, undocumented — **S3** — **OPEN**

Found 2026-09-17 while mapping what a workspace owns.

**Measured:** all **17** `ledger.jsonl` files in the tree hold **0 rows**. The cross-ledger
(`propagation/PROPAGATION_CROSS_LEDGER.jsonl`) has **never** recorded an entry — its
rendered `.md` says *"Last entry: never"*. The live store is `~/.propagate/events/` —
**2839 events**, outside the tree, outside every git remote, and outside every backup that
follows a repo.

**The consequence, stated plainly: a full-tree clone on another machine restores zero
verification history.** Every disposition, every `no-change-needed` with its hand-written
reasoning, every `both-reconciled` asserting a human looked — none of it travels with the
repos it describes.

**This may well be correct.** A machine-local event store is a defensible design: the
events record what *this* machine verified, and `REFERENCE.md` §"`manifest`" exists
precisely to stand a workspace up elsewhere. The `archive/ledger-v1-*.jsonl` files in-tree
are explicitly FROZEN history.

**The issue is that no document says which.** There is no `DECISIONS.md` entry stating
"the event store is deliberately machine-local, and here is what that costs". So a reader
finding 17 empty ledgers cannot tell a deliberate design from a migration that stalled —
the same ambiguity as N82, one layer down.

**The deliverable is a decision record, not code.** Whichever way it goes, write it down.
If machine-local is intended, say so and name what a second machine is expected to do. If
the ledgers should carry rows, they have been empty since at least the v2 cutover and that
is a real gap.

### N81 · Five more files colocate a machine-parsed grammar with append-only churn — N77's shape, before it bites — **S3** — **OPEN**

Found 2026-09-17 by a census run to answer whether N77 is one bad edge or a pattern. It is
a pattern, and the useful part is that **four of the five are not yet costing anything.**

**The discriminator.** A file is an instance only if BOTH hold: the spec region is
materially more stable than the file around it, AND something mechanically depends on the
spec. A long file with a header nothing parses is just a long file.

| file | lines | spec region | spec last moved | file / 60d commits | parsed by | declared edge? |
|---|---|---|---|---|---|---|
| `HANDOVERS.md` | 2374 | close protocol, L1–97 | 2026-08-28 | 2026-09-16 / **46** | `lib/report/handovers.mjs` | **yes — this is N77** |
| `propagate/…/workspace/DECISIONS.md` | 1183 | `What/Why/Affects/Refs`, L3–7 | 2026-08-10, never since | 2026-08-31 / 19 | `lib/report/decisions.mjs`, `graph-index.mjs` | no — latent |
| `Vipin Kaushik/…/sanskrit-texts/GOTCHAS.md` | 1769 | `**Trigger:**` grammar, L1–4 | 2026-08-24, never since | **2026-09-17** / **50** | `hooks/gotcha-guard.mjs` | no — latent |
| `Vipin Kaushik/…/marketing-intel/GOTCHAS.md` | 846 | L1–7 | 2026-08-24, never since | 2026-09-02 / 21 | same | no — latent |
| `Vipin Kaushik/…/workspace/GOTCHAS.md` | 491 | L1–9 | 2026-08-24 | 2026-09-14 / 8 | same | no — latent |
| `Motherboard/…/workspace/GOTCHAS.md` | 413 | L1–11 | 2026-08-21 | 2026-08-30 / 7 | same | edge exists but scoped to the G-list, not the header |

**The finding that changes the fix: none of the five has a declared `kind: code` edge on
the header.** So none is currently manufacturing `no-change-needed` dispositions the way
N77's does. This is *"fix it before someone declares an edge"*, not *"six live N77s"*. The
day anyone declares one to keep a header honest, it starts firing on every `### G-n` append.

**What the five GOTCHAS.md files actually did.** They independently restated the
`### heading` / `**Trigger:**` / `**Fires on:**` grammar that `gotcha-guard.mjs` depends on,
inline, at the top of their own append-only file. That grammar is already canonical in
`rule:every-project-carries-gotchas`. So this is the restatement failure that rule exists to
prevent, committed inside the files the rule governs.

**And the correct pattern already exists in the same tree, which is why this is cheap.**
`Vipin Kaushik`'s three `DECISIONS.md` files carry **no** grammar paragraph — they point at
`rules/conventions/STATE_MANAGEMENT.md`, where the contract lives beside `decisions-check.sh`
that enforces it. `propagate`'s own `DECISIONS.md` restates it inline instead. The model and
the defect are both in this repo's tree; the fix is to copy the model.

**Recommended, per file, one line each:**

- `HANDOVERS.md` — N77's own recommendation; move the ~31-line protocol out, leave a pointer.
- `propagate/…/DECISIONS.md` — move the `What/Why/Affects/Refs` grammar to `docs/` beside the
  `decisions-check.sh` contract; leave a one-line pointer. Copy what Vipin Kaushik does.
- The five GOTCHAS.md headers — **delete the restated grammar, cite
  `rule:every-project-carries-gotchas`.** Nothing to relocate; the canonical text already
  exists. This is the cheapest of the three and removes five future N77s.

**Rejections are part of the result.** `ISSUES.md` (including the file this entry lives in)
FAILS the discriminator — `lib/report/backlog.mjs` parses individual `### N81 ·` entries
structurally, and nothing parses the header or severity legend. `ECOSYSTEM.md` fails by
construction: it is regenerated wholesale, so header and body always move together and a
hand-edit is refused by the footer hash. `NORTH_STAR.md` is not an instance — it is the
TARGET pattern, a stable spec correctly kept out of a churning file. The hub `CLAUDE.md`
placement test has the stability gap but nothing parses it, so it is prose, not a contract.

**One claim from the census was checked and REJECTED.** It reported that
`.propagates.yml`'s `NORTH_STAR.md -> CLAUDE.md` edge cites a section, *"§The client
boundary"*, that no longer exists. It does exist — `## The client boundary` is in
`NORTH_STAR.md`, which is what the `why` means by *"**its** §The client boundary"*. The
check had been run against `CLAUDE.md`. Recorded because a phantom "declared edge cites a
dead section" finding would have sent someone editing a correct sidecar.

**Test it can fail:** for each file above, assert the spec region's last-changed commit is
older than the file's, and that the region is reachable by the parser that depends on it.
When a file stops satisfying the first, it has stopped being an instance.

### N80 · `readGotchas` computes the trigger count and `row()` drops it, so gotcha LIVENESS reaches no reader — **S3** — **OPEN**

Found 2026-09-17 during a promotion/liveness audit. A three-line defect sitting directly
beneath a docstring about this exact class of mistake.

**The mechanism.** `lib/report/registers.mjs:244` computes it:

```js
const triggered = parseEntries(file).entries.length;
return row({ kind: "gotchas", file, lines, entries: heads.length, …, triggered });
```

`row()` at :122 destructures
`{ kind, file, lines, entries, live, finished, rotatable, reason, unread, error }` and
returns exactly those. **`triggered` is not among them.** It is computed, passed, and
discarded — no consumer can ever see it.

**Why it matters, and why it is not cosmetic.** `every-project-carries-gotchas` makes the
whole argument that presence is easy and LIVENESS is what counts: *"a `GOTCHAS.md` can be
present, current and correctly reconciled while delivering nothing, because its entries
carry executable triggers and a trigger that cannot fire is a hazard documented but not
delivered."* The per-file triggered/total ratio is the number that distinguishes those two
states, and it is the one field that does not survive the row.

Measured tree-wide today: **427 entries across 23 files, of which 216 (~51%) carry a
`**Trigger:**`.** The spread per file is enormous and invisible —
`Divyansh/…/AuroraV3` is 29 of 33 triggered, while
`PanditPawanKaushik/…/gemastrology-shopify` is 4 of 29 and
`propagate`'s own is 16 of 69. Nothing surfaces that.

**The irony is local.** The comment immediately above `row()` explains that `reason` is
load-bearing because *"0 rotatable because every entry is live"* and *"0 rotatable because
this file did not parse"* are different facts (`rule:discernment-checks` §2). The author
was thinking about exactly this hazard in the function where the drop happens.

**Two things this issue explicitly does NOT claim:**

- **The 49% without a trigger are not a defect.** `LIFECYCLE.md` makes untriggered the
  correct default — *"most gotchas have no mechanical trigger and inventing one makes
  noise."* The ratio is worth SEEING, not worth driving to 100%.
- **Trigger liveness itself is currently healthy.** `selftestProblems()` run across all 20
  content files plus the global one reports **0 problems** — every entry declaring a
  `**Trigger:**` also declares a `**Fires on:**` literal that its own regex matches. So the
  inert entries N45 found have since been fixed.

  **`cli.mjs:1073` is NOT stale and must not be "corrected".** The audit that produced this
  issue recommended editing it; that recommendation was wrong and is recorded here because
  the distinction matters. The comment reads *"N45 measured 3 of 10 inert while --selftest
  reported green"* — past tense, attributing a historical measurement to explain **why the
  check exists**. A justification-by-history is not a claim about the present, and deleting
  it would remove the only record of why anyone bothered to tally liveness at all. The same
  reason the hub `CLAUDE.md` preserves its 2026-06-28 cleanup note. Leave it.

**Test it can fail:** assert `row()`'s return carries `triggered` for a gotchas file, and
that a file with 10 entries and 2 triggers renders differently from one with 10 entries and
10 triggers. Today both render identically.

**Related but separate:** `doctor`'s `86 live gotcha(s)` is **cwd-scoped**, not tree-wide —
`lib/report/doctor/registers.mjs` deliberately uses `sourcesFor(process.cwd())`, i.e. "what
would fire HERE" (propagate's 69 + hub workspace 2 + global 15 = 86). The tree-wide figure
is **426 live**. Both are legitimate answers to different questions; the label does not say
which question it answered.

### N79 · `rules list` reports a RELEVANCE verdict from a scan of one file type, and calls the three most-cited rules in the tree `unexercised` — **S2** — **OPEN**

Found 2026-09-17 while answering "how do we keep the hub and the workspaces relevant to
each other". The answer had to start by admitting the instrument that reports hub
relevance is measuring the wrong population.

**What it prints.** `rules list` gives every rule a `status` and closes with
`5 rule(s) unexercised`, explained as *"fingerprint matched nothing and nothing references
them."*

**What is actually true.** `rules check` — which `rules list` derives that column from —
scans files literally named `CLAUDE.md`, 53 of them. Citations counted tree-wide instead
(`node` walk over `.md`/`.mjs`/`.yml`/`.sh`/`.json`, excluding `rules/` itself):

| rule | files citing it | of which `CLAUDE.md` | `rules list` says |
|---|---|---|---|
| `discernment-checks` | **256** | 2 | adopted |
| `state-and-decisions` | 118 | 10 | firing |
| `safety-flag-needs-a-test` | **77** | **0** | **unexercised** |
| `enforcement-watches-itself` | **68** | **0** | **unexercised** |
| `adversarial-review-reads-the-ledger` | **55** | **0** | **unexercised** |
| `model-routing` | 12 | 0 | firing |
| `browser-only-when-asked` | 2 | **0** | **unexercised** |
| `no-waiting-on-deploys` | **0** | 0 | **unexercised** |

**Six rules have zero `CLAUDE.md` footprint and 215 citations between them.** Exactly ONE
of the five reported unexercised is genuinely unused, and the report cannot tell it apart
from the three most-cited rules in the tree. For `safety-flag-needs-a-test` the 77 break
down as **32 code files**, 12 `DECISIONS.md`, 5 `GOTCHAS.md`, 3 plans, 2 `ISSUES.md` — it
is cited in source comments and tests, which is the most load-bearing place a rule can be
cited and the one place this scan will never look.

**The irony is load-bearing, not decorative.** `docs/LIFECYCLE.md` names
`rules/safety-flag-needs-a-test.md` as *"a mechanism produced by PROMOTE"* — the one
worked example of the promotion path succeeding. The tool reports that success as
unexercised.

**The scan is not the defect.** `CLAUDE.md` is the right corpus for the question
`rules check` exists to answer: which instruction files RESTATE a rule instead of citing
it, because that is where divergence causes harm (measured 2026-08-14: 9 inline copies of
tool-priority making 4 mutually exclusive claims). The defect is that `rules list`
overloads that one narrow scan into a **relevance verdict**, and then states it in words
the scan cannot support. `nothing references them` is a claim about the whole tree made
from a sample of one filename.

**Two candidate fixes; they are not equivalent and this issue does not choose.**

1. **Widen the scan corpus.** Tempting and probably wrong. Restatement in a `DECISIONS.md`
   or a code comment is not the same failure as restatement in a `CLAUDE.md` — the latter
   is an instruction another agent will follow. Widening would also flood
   `referencedRestatements`, and N35 already records the cost of a fingerprint wide enough
   to flag 8 files to find 1.
2. **Keep the scan, fix the vocabulary.** `unexercised` becomes something that says what
   was measured — `no CLAUDE.md footprint` — and the summary sentence stops asserting
   "nothing references them", because it does not know that. Optionally print the tree-wide
   citation count beside it as a separate, separately-derived number.

**Recommended: the second.** It is honest, it is cheap, and it does not change what
`rules check` means. `rule:discernment-checks` §2 — absence must be attributable, and
"no hits in the corpus I scanned" and "nothing references this" are different facts.

**Test it can fail:** assert that a rule cited in a non-`CLAUDE.md` file and in no
`CLAUDE.md` is NOT reported with wording that claims nothing references it.
`safety-flag-needs-a-test` is the live fixture — 77 files, 0 of them `CLAUDE.md`.

**Derive the numbers, never trust the ones above** (`rule:state-and-decisions`): a `node`
walk counting `rule:<id>` per file, split by whether the basename is `CLAUDE.md`. Do NOT
use `grep` — the ugrep shim honours the hub's `/*` `.gitignore` and returns false zeros;
that flaw has now fired four times in this tree.

### N78 · A code-only merge is undeliverable — both delivery mechanisms gate on VERSION, and only `doctor` reads content — **S2** — **RESOLVED 2026-09-24**

Found 2026-09-17, one minute after merging #21, by the `# Delivery` section that #19
added for exactly this.

**The measurement.** #21 merged four commits changing `cli.mjs`, `lib/rules/rules-check.mjs`
and a skill doc. It did not bump VERSION, because it was a fix, not a release. On a
clean tree immediately after:

```
$ claude plugin update propagate@tathya
✔ propagate is already at the latest version (0.6.1).

$ node cli.mjs doctor      # Delivery
! version 0.6.1 matches but cli.mjs differs (served 52f4553a0cf2, source bdaf944fb0bd)
```

The update command **succeeded and shipped nothing.** Three commits of merged code
stayed unserved, and the only reason anyone knew is that one check reads file content.

**Both delivery paths share the same gate, and it is not code identity:**

| mechanism | fires when |
|---|---|
| `.githooks/post-merge` | `git diff-tree ORIG_HEAD HEAD` names `VERSION` |
| `claude plugin update` | the served version STRING differs from source |

So a merge that changes code without touching VERSION is invisible to both. The hook
does not run; the update no-ops. **Neither mechanism can observe that the code moved.**

**This is not the 2026-09-16 incident repeating — it is its mirror.** That one was a
bump nobody followed with an update (four PRs, plugin stuck at 0.5.0 for two days).
This one is an update that *cannot* work without a bump. Same hole, approached from
the other side, which is why fixing the first did not prevent the second: the fix
added a trigger on VERSION-change and a detector on content, and left the gap between
them open.

**`# Delivery` is doing its job and cannot close this.** It reads the served `cli.mjs`
hash against source, so it caught the `incoherent` state — version agrees, content does
not — within a minute. It is a detector, not a delivery path. `rule:enforcement-watches-itself`
in its useful direction for once: the check that watches delivery correctly reported
that delivery had not happened.

**Worked around today by bumping to 0.6.2** (`28e655a`), which delivered and was verified
by hash, not by version string: `source=bdaf944fb0bd served=bdaf944fb0bd`.

**The decision this needs.** Bumping VERSION on every code merge is one answer and it is
not obviously the right one — it makes the version number a commit counter and pushes the
problem onto whoever forgets. Alternatives worth weighing before building anything:

- Make `post-merge` fire on **any change under the served tree**, not just VERSION, and
  let it re-copy when the hashes differ. Moves the gate from version to content, which is
  what `# Delivery` already proves is the correct predicate.
- Have `doctor`'s `incoherent` row print the exact remediation for this case — today it
  says "either uncommitted edits (normal while developing) or an update half-applied",
  and on a CLEAN tree after a merge it is neither. The wording sent me to `git status`,
  which was clean, which is the least informative answer available.
- Accept the bump discipline and enforce it: a CI check that fails a PR touching
  `cli.mjs`/`lib/**` without a VERSION change.

**Test it can fail:** merge a commit that changes `cli.mjs` and not `VERSION`, then assert
the served `cli.mjs` hash equals source. Today that assertion fails and nothing runs it.

**Related:** the cache now holds 3 trees (0.5.0, 0.6.1, 0.6.2). Doctor says persistent
duplicates mean one was never cleaned up; 0.5.0 has been there since the original
incident. Not urgent, not deleted here — removing directories from someone's plugin cache
is their call.

**Decided.** Both delivery mechanisms (`.githooks/post-merge`'s `VERSION`-diff trigger and
`claude plugin update`'s version-string comparison) key on the VERSION string, and neither
can observe that code moved without it. The fix, settled by the plugin-delivery review
(`docs-plans-2026-09-23-reminders-todo-bri-playful-dawn.md`, decisions D3-D8/D12):

- **State-branched remediation text** (D3) — `doctor`'s `# Delivery` section now branches by
  verdict state instead of pointing at `git status`, which is clean in exactly the state that
  misled this entry's own author. `stale` keeps `claude plugin update <plugin>@<mkt>`;
  `incoherent` names both verified paths (bump `VERSION` for a release, or
  `claude plugin marketplace update` + uninstall/install otherwise).
- **A digest over the shipped file set, read from committed content** (D4, D6) — replaces the
  single `cli.mjs` hash with `treeDigest` over all shipped paths, sourced from `git ls-tree -r
  HEAD` / `git hash-object --stdin-paths` rather than the working tree, so an in-progress edit
  can't move the verdict and a `missing` file fails at any distance.
- **Shipped-path-only commit/day bounds** (D5) — `deliveryLag` counts only commits touching the
  shipped pathspec, so doc-only and test-only churn (this repo's 2026-08-27 decision explicitly
  allows both without a version bump) never reddens the gate.
- **A CI bump-gate on shipped paths** (D7) — a job in `.github/workflows/test.yml` fails a PR
  that touches the shipped pathspec without changing `VERSION`; `post-merge`'s existing trigger
  then delivers automatically. The pathspec is exported once from `delivery.mjs` and CI derives
  it rather than restating it (D12), so the two cannot drift the way `.githooks/post-merge`'s
  own hardcoded completeness list already had (see N78's sibling gap, resolved by widening that
  list rather than sharing a definition — D8).

**Of N78's own three candidate remedies, two were taken and one was not.** Taken: "have
`doctor`'s `incoherent` row print the exact remediation" (the state-branched text above) and
"accept the bump discipline and enforce it" (the CI bump-gate above). **Not taken:** "make
`post-merge` fire on any change under the served tree … and let it re-copy when the hashes
differ." Rejected at D7 in favor of the CI bump-gate because it would silently mutate the
installed plugin on every qualifying merge, from a hook whose exit code git already discards —
so a failed re-install would be visible only to someone reading scrollback, which is the same
silent-failure shape this whole register exists to catch.

**Deferred, not built:** sharing one completeness definition between `post-merge`'s file list
and `delivery.mjs`'s digest (D8 — widened the hardcoded list instead) and the fifth
version-manifest location, `skills-marketplace/.claude-plugin/marketplace.json` (D1). Both
filed as TODOs.

### N87 · `doctor` reports healthy because its population excludes the failures, its checks test properties a broken thing satisfies, and 354 warnings bury the one that fires — **S1** — **RESOLVED 2026-09-25**

**RESOLVED 2026-09-25 — and it had been resolved in code for a day without this line saying so.**
All three mechanisms this entry names now have a landed slice AND a test that pins it:

| mechanism | slice | landed | pinned by |
|---|---|---|---|
| the population excluded the failures | 1 | `b164a9f` | `tests/cli/doctor-census-parity.test.mjs` |
| checks tested properties a broken thing satisfies | 2a, 2c | `4063bb0`, `c1acb2b` | `tests/unit/doctor-reporter.test.mjs` |
| severity declared per section, so one signal is findable | 2b | `de53a45` | `tests/unit/doctor-severity.test.mjs` |
| 354 warnings buried the one that fires | 3 | `a7548a1` | `tests/unit/doctor-warn-labels.test.mjs` |

`lib/report/doctor/reporter.mjs:46-124` carries the new fourth entry kind: `inconclusive` is in
`ENTRY_KINDS`, its `reason` is mandatory and **throws** when empty, and it increments `problems` —
so a check that could not run stops reporting success. Seven section modules declare `severity`.

**Why the delay is worth recording rather than quietly fixing.** This entry is *about* a register
reporting a state that is not real, and for a day it was one: slices landed 2026-09-23/24 and this
line read `OPEN` on 2026-09-25, while the file was edited that same morning for an unrelated entry.
Anything consulting it to answer "is N87 done" would have been told no. That is the same defect one
level up, and it is the reason `rule:enforcement-watches-itself` exists.

Found while scoping PR-007, which is filed as sequenced behind slice 2 and is the first real consumer
of `inconclusive` — a TCC denial is "could not look", which is neither pass nor fail. Nearly reported
as still open: a first pass grepping `severity` under `lib/report/doctor/` returned **zero** hits
through the ugrep shim (G-A); `/usr/bin/grep` found seven files.

**Step 4 of the original fix order — "only then add checks for other defects" — is deliberately not
claimed here.** It was never part of closing these three mechanisms, and N87 measured 6 of 8 real
findings that week having no corresponding check. That remains open work, separate from this entry.

Filed 2026-09-17 in answer to a direct question: *"how are we running a system with this
many defects, and doctor doesn't report it?"* Eight issues were filed in two days (N79-N86).
`doctor` reports **1 problem**. This entry is why, and it is three independent mechanisms,
each individually sufficient.

---

**1 · THE POPULATION EXCLUDES THE FAILURES.**

`doctor` prints `✓ workspaces conform to the v3 propagation layout — 16/16 conform`.
`rollup` writes `NON-CONFORMANT` for **2** workspaces into `ECOSYSTEM.md`. Both are in this
repo. They disagree because they enumerate different sets:

```
in rollup, MISSING from doctor:   Motion-Graphics, propagate
in doctor, missing from rollup:   calibration-sampler-52226, ubersicht-widget-52226
```

**The two workspaces doctor omits are exactly the two that fail.** `16/16` is not "checked
sixteen and all passed"; it is "enumerated sixteen, and the failures were not among them".
Doctor also counts two *worktree checkouts* as workspaces, inflating the denominator with
copies of trees already counted.

**`propagate` excluding itself is `rule:enforcement-watches-itself` at the population
level** — not a check that fails to cover its own toolchain, but a census that does not
list the repo it runs in. The rule's own worked examples include *"a drift gate installed
in seven repos and not in the one that authored it"*. This is that, one layer up.

---

**2 · THE CHECKS TEST PROPERTIES A BROKEN THING STILL SATISFIES.**

```
✓ ledger JSONL parseable   0 rows, 0 open
```

Every one of the 17 in-tree ledgers holds **0 rows** (N84). An empty file is trivially
parseable, so the check passes and prints the emptiness as though it were a result.
`rule:discernment-checks` §2: *found nothing* and *looked at nothing* must not render
alike — here they render as the same green tick, with the count right there in the detail
text and no threshold behind it.

Same shape in the conformance check itself (N82): it asserts `state/` **exists**, not that
it holds anything, so two empty directories pass.

---

**3 · 354 WARNINGS ACROSS 299 DISTINCT KINDS, AND ONE FAILURE.**

Counted from a live run: **515 assertion lines — 160 ✓, 354 warn, 1 ✗.** The warnings are
not a handful of repeated problems; they are **299 distinct kinds**, mostly per-branch rows.

No one reads a 515-line report where 69% of the lines are warnings. `gotchas-global.md`
states the principle for its own admission bar — *"otherwise this file becomes the noise
that hides the four that matter"* — and `doctor` is past that threshold by two orders of
magnitude. Even a correct new signal would not be seen.

---

**AND THE CHECK SURFACE IS SMALL.** Doctor has **14 distinct check classes**. Mapped
against the eight issues filed this week:

| finding | doctor check? |
|---|---|
| N79 relevance corpus | none |
| N80 trigger count dropped | none |
| N81 colocated specs | none |
| N82 conformance presence-only | **exists, passes** — tests presence |
| N83 CLAUDE.md currency 4/16 | none — undeclared is invisible |
| N84 ledgers empty | **exists, passes** — tests parseability |
| N85 104 noisy edges | none — counts `actionable`, never the no-op ratio |
| N86 forked gate | none — nothing compares duplicate implementations |

**6 of 8 have no corresponding check. Both that do, pass.** So the honest reading of a
green doctor is *"the fourteen things it checks, over the workspaces it enumerated, are as
expected"* — which is a much narrower claim than the one a green report implies.
`rule:adversarial-review-reads-the-ledger`'s corollary already says this about the family:
*"status, check and doctor answer 'is anything declared drifting' — never 'is anything
undeclared wrong'."* N87 is the measured version of that sentence.

---

**S1, and the severity is about trust, not any one defect.** Every issue above is
individually survivable. What is not survivable is a health command that returns green
while the tree holds a forked contract gate, 17 empty ledgers, and 104 majority-no-op
edges — because the green is what stops anyone looking. A check that cannot fail is worse
than no check (`rule:discernment-checks` §1); a *suite* that cannot fail is the same thing
with a reassuring summary line.

**Fix order matters and is not "add eight checks".**

1. **Reconcile the two populations first.** Until `doctor` and `rollup` enumerate the same
   workspaces, every count either produces is unfalsifiable. This is the cheapest fix and
   it flips `16/16` to something honest by itself.
2. **Make the existing checks assert the thing they are named for** — non-empty, not
   parseable; contents, not presence. Expect green to go red; that is the check starting
   to work.
3. **Cut the warning channel down** before adding any new signal, or the new signal joins
   299 others. A warning nobody reads is not a warning.
4. **Only then** consider checks for N85/N86-class defects.

**Test it can fail:** assert `doctor`'s workspace set equals `rollup`'s. Today they differ
by four entries in both directions. And assert `ledger JSONL parseable` does not report ✓
for a file with 0 rows.

**Derive all of it:** `node cli.mjs doctor` and `node cli.mjs rollup --check`, then diff
the `# Workspace:` headings against `ECOSYSTEM.md`'s `### ` headings. Do not trust the
numbers in this entry — they are a snapshot of a report that changes daily.

### N86 · The DECISIONS.md gate is a CONTRACT living in two client workspaces, forked, with cutoff dates five weeks apart — **S2** — **OPEN**

Found 2026-09-17 by the adversarial review of the hub↔workspace diagnosis, which had
missed it. It is the cleanest instance of that diagnosis's own thesis, and it was invisible
to the diagnosis because the diagnosis read files while this is a property of the **edges**.
`rule:adversarial-review-reads-the-ledger`, doing exactly what it claims to do.

**The measurement.** Two copies on disk, both inside client workspaces, none at the hub:

| fork | bytes | lines | cutoff date | control flow |
|---|---|---|---|---|
| `Vipin Kaushik/scripts/decisions-check.sh` | 7235 | 180 | **2026-06-09** | differs |
| `PanditPawanKaushik/scripts/decisions-check.sh` | 3856 | 107 | **2026-07-16** | differs |

Different sizes, different hashes, different control flow, and **enforcement cutoffs five
weeks apart** — so a `DECISIONS.md` entry that passes under one fork may fail under the
other, depending purely on which workspace's copy a reader happens to invoke.

**Who depends on it: 54 files across 6 workspaces** — PanditPawanKaushik (12),
`Vipin Kaushik` (26), Rupali (6), Tushar (3), **propagate (6)**, and **`rules/` (1)**.

**`propagate`'s own `DECISIONS.md` header names the PanditPawanKaushik copy explicitly:**

> `**Affects:**` is machine-read — it drives cross-repo relay rows and is enforced as a
> pre-commit gate by `PanditPawanKaushik/scripts/decisions-check.sh`.

So the tool that defines the propagation standard has its own decision-record format
enforced by a script owned by a client workspace, in the shorter of two divergent forks.

**Why this is the thesis and not just duplication.** The hub owns contracts; workspaces own
instances. A *format gate* is a contract by definition — it decides what a valid entry is,
for six workspaces. It lives in two instances. `rule:state-and-decisions` already records
this exact shape one level over: *"two carried a `scripts/hygiene/` stack forked between
them — 5 of 8 shared libs diverged. Every divergence was individually reasonable. Together
they meant no check could be written once."*

**What makes it S2 rather than S3.** A forked linter is an annoyance. A forked **gate**
with different cutoff dates means the tree has **two different definitions of a valid
DECISIONS.md entry** and no way to tell which one any given file was validated against.
That is not drift between a doc and its code — it is drift between two enforcers, which no
declared edge in the tree currently watches.

**Not proposing the fix here.** Moving it to the hub is the obvious move and is not free:
54 citations across six workspaces would need repointing, and the two forks must first be
reconciled — which requires deciding whose cutoff is right, a judgement, not a merge.
Note also that a hub-owned gate does not automatically get invoked; `rule:enforcement-watches-itself`
records a drift gate installed in seven repos and not in the one that authored it.

**Test it can fail:** hash every `decisions-check.sh` in the tree and assert there is at
most one distinct implementation. Today there are two.

**Derive it, do not trust the table:**
`find ~/Documents/GitHub -name decisions-check.sh -not -path '*/node_modules/*'` then
`md5` each. Not `grep` — the ugrep shim honours the hub's `/*` `.gitignore` and this
script lives inside workspaces it would skip.

### N85 · 83% of edges with ENOUGH history to have a ratio are majority `no-change-needed` — N77 is not an outlier — **S2** — **OPEN**

Measured 2026-09-17 by parsing all 2844 events over 1564 distinct edge ids, to answer
whether N77 was one bad edge. **It is not.** This supersedes N77's framing while leaving
N77's own diagnosis intact.

**The number.** Of the **125 edges with ≥4 recorded dispositions**, **104 (83%)** are
≥50% `no-change-needed`. They span **46 distinct source files across 14 workspaces**.
**31 edges are at 100%** — every judgement ever made on them was "nothing needed to
happen". The worst cluster is a single source, `Vipin Kaushik:docs/measurement/MEASUREMENT.md`,
carrying **12** noisy edges.

N77's own edge sits at 70%, which puts it **mid-table**, not at the extreme.

**MIND THE DENOMINATOR — corrected 2026-09-17 on adversarial review.** This entry's first
title read *"83% of edges with any history"*, which is false and is the exact
`rule:discernment-checks` §5 error the entry is about. **1564** edges have at least one
disposition; only **125** have ≥4, which is the minimum to have a meaningful ratio at all.
The 83% is of those 125. As a share of every edge with any history, the noisy set is
**6.6%**. Both numbers are real and they answer different questions: *"among edges we have
judged repeatedly, how often was the answer no?"* (83%) versus *"how much of the graph is
noisy?"* (6.6%). The first is the one that matters for reviewer attention; say which one
you mean.

**THE HYPOTHESIS IN N77 IS REFUTED, and the strong evidence is the same-source spread —
not the aggregate.** N77 said the cause was a high-churn source.

**The disproof, which holds churn constant by construction.** One file, six declared edges:

```
sanskrit-texts:docs/INVENTORY.md   (49 commits/60d)
  e82c6e94  0.75      a9d43537  0.63      e377000b  0.18
  fa432c23  0.75      91daecfb  0.10
  2cb348a4  0.75
texts:docs/INVENTORY.md            0.78, 0.78, 0.33
```

Same source, same commit history, **a 7.5× spread in noise ratio across its own
downstreams.** Source churn cannot explain a variable it is constant across. Whatever
drives the ratio is on the downstream side.

**The aggregate comparison points the same way and is much weaker evidence — stated
second on purpose.** Noisy-edge sources average **7.3** commits/60d against **12.7** for
non-noisy ones, i.e. noisy sources churn *less*. But the non-noisy group is only **15**
sources, and both groups are defined by the very outcome under test, so this is
suggestive, not probative. **Do not cite the means without the same-source spread** — an
earlier draft of this entry led with them, which is the shape of an argument that looks
statistical and is not.

**So the predictor is not how often the source changes. It is WHICH SLICE of the source
the downstream actually depends on.** A downstream that tracks a *stable derived fact* —
a pointer line, a count, a format grammar, a canon list — gets a re-check on every
unrelated edit to the file that happens to contain it. That is N77's real mechanism,
stated correctly and generalised: **granularity mismatch between the declaration and the
dependency**, of which "header inside an append-only file" is one special case.

**Six causes, classified with evidence:**

| cause | example | why it is noisy |
|---|---|---|
| stable pointer inside a hub file | 7 clusters → `CLAUDE.md`, 24 edges | the edge asserts a one-line pointer stays consistent; most edits don't touch it |
| stable slice of a churning catalog | `INVENTORY.md` → canon tracker | new texts change the catalog, not the canon list |
| shared constant | `Makefile`/`go.work` → `CLAUDE.md` | doc restates a *count* (14 targets); targets change, count rarely |
| aggregate restated in a rule | `mongo.yml` → `secrets-source-of-truth.md` | rule repeats one four-project figure |
| glob broadcast | `gotchas-global.md` → `*/docs/GOTCHAS.md` | one rule edit, N per-project obligations, few real changes |
| **stale declaration (new)** | `Motherboard:docs/{HISTORY,GOTCHAS}.md` | source migrated to `propagation/state/workspace/` in the v3 layout move; the old edge_id's history remains and **can never close** |

**Repeated reasons are widespread, not a tell of one edge.** 51 of 125 edges (41%) carry
at least one pair of dispositions whose reason text shares ≥50% of its wording — 46 of
those 51 are in the noisy set. One 2026-08-19 batch wrote near-identical reasoning across
**15+ unrelated edges within hours**. N77 spotted this on one edge and read it as
significant; it is the house style of a bulk disposition pass.

**Why this is S2 while N77 is S3.** A single noisy edge wastes a little attention. A
ledger where 83% of judged edges are majority-no-op **trains the reader to answer "no"
without looking**, and the eighth time is the one where the header actually moved. It also
makes `actionable` a poor priority signal, which is the number the monitor reports.

**What this does NOT say.** It does not say those 104 edges are wrong to exist — most
assert a real coupling. It says the declaration is coarser than the dependency. And the
fix is NOT the region-scoped edge rejected in N77 finding 4: that was rejected on
architecture (git-blob whole-file identity), and 104 edges does not change that argument,
it raises the stakes on finding a different answer.

**Candidate directions, none chosen:**

- **Declare the derived fact, not the file.** Where a downstream depends on a count or a
  pointer, the honest source is often a smaller generated artifact, not the big doc.
- **Let a disposition express "and expect this again".** A `no-change-needed` that records
  *why re-firing is expected* could suppress the next N identical prompts without hiding
  a real change — closer to a calibration than a silence.
- **Reap stale declarations.** The orphaned `Motherboard:docs/*` edges can never close and
  should be retired outright; that is pure noise with no coupling behind it.

**Test it can fail:** recompute the ratio table; assert no edge with ≥4 dispositions is
≥90% `no-change-needed` without a recorded justification for why re-firing is expected.
31 edges are at 100% today.

**Derive, never trust the table above:** parse `~/.propagate/events/*.jsonl` with `node`
(never `grep -c` — it counts lines, and a disposition word inside reason prose is not an
event; that exact error produced N77's wrong denominator). Exclude
`events/archive/` — it is frozen v1 history, not a worklist.

### N77 · A `kind: code` edge fires on the whole file while coupling only a HEADER — 7 of 10 dispositions on one edge are `no-change-needed` — **S3** — **OPEN**

Found 2026-09-16 while disposing `HANDOVERS.md -> propagate/lib/report/handovers.mjs`
(`4e8d1c1c`) after the N76 work.

**The measurement — CORRECTED 2026-09-17.** Every disposition ever recorded against that
edge, counted by parsing the event store rather than by grepping `why --all`:

| disposition | count |
|---|---|
| `no-change-needed` | **7** |
| `baselined` | 1 |
| `propagated` | 1 |
| `source-corrected` | 1 |
| **total** | **10** |

**70% of the judgements on this edge are "nothing needed to happen", and the last three in
a row are.**

> **The original filing said "7 of 12" and the denominator was wrong.** It came from
> `why 4e8d1c1c --all | grep -oE '<disposition names>' | sort | uniq -c`, which counts
> every occurrence of a disposition WORD in the rendered output — including words appearing
> inside the reason prose — not events. The real count is 10.
> `rule:discernment-checks` §4: when a number is surprising, suspect the ruler. The ratio
> got *worse* under re-measurement (58% → 70%), so the finding stands; the arithmetic
> behind it did not. Two of those three carry near-identical hand-written reasons,
independently arrived at weeks apart — 2026-09-10 said *"This edge governs the HEADER
… None of that was touched"*, and today's said the same thing after re-deriving it
from scratch.

**Why.** The sidecar declares the source as `HANDOVERS.md` — the whole file — while
the `why:` it carries scopes the coupling precisely:

> HANDOVERS.md's header is the prose spec of the close protocol this module parses.
> Changing the marker spelling, the placement rule or MARKER_WINDOW here must be
> reflected in the header, and vice versa.

`HANDOVERS.md` is append-only by design: its own header says *"add dated sections,
never edit past ones"*. So the file changes often and the header almost never does.
The edge fires on every entry append and the answer is nearly always the same.

**This is the shape `rule:delegation-criteria` §2 names** — the 60-second watcher that
ran 4,420 times and found nothing in 4,384 of them. Same defect one level up: not a
component polling too often, but a *declaration* whose granularity does not match the
coupling it asserts, so a human is asked to judge something that could not have
changed. Manufacturing dispositions is the opposite of what the ledger is for, and it
erodes the signal: an edge whose answer is "no" seven times trains the reader to
answer "no" the eighth time without looking — which is the time the header moves.

**ESTABLISHED 2026-09-17 — region scoping does not exist, and it is not cheap.** The
previous version of this issue left this open and said so; here is the answer.

**1 · The edge schema admits exactly four keys.** `propagates.schema.json`:
`path`, `why`, `kind`, `authority` — with `additionalProperties: false` at all three
levels (root, source object, edge object). There is no anchor, heading or line-range
selector, and an undeclared key is rejected rather than ignored.

**2 · Section anchors exist in the schema and nothing resolves them.** `concepts:` —
a sibling of `propagates_to` — is documented as *"per-section concept tags … Keys are
section anchors"*, and it is live: `lib/claims/check.mjs` reads it, 5 of 43 sidecars
declare it. But `findDeadConceptTokens` **never locates the section**. It lowercases
the WHOLE source file and substring-matches each token against all of it; the `section`
key is carried into the finding as a reporting label only. So the vocabulary for
addressing a region is present and the machinery is not.

**3 · Content identity is whole-file by construction, and that is the expensive part.**
`contentId(absPath)` hashes a file, and `batchTrackedBlobs` / `batchRefBlobs` take
identity from **git blob hashes**, batched through one `git ls-tree` per repo. A slice
of a file has no git blob hash. Scoping an edge to a region therefore means writing an
anchor resolver AND dropping those edges off the batch fast path the whole module is
built around — hashing a computed range per edge, per run.

**So the three options, now costed:**

| option | cost | effect |
|---|---|---|
| Scope the edge to the header | New anchor resolver + those edges leave the git-blob fast path | Correct, and the most machinery |
| Keep paying the tax, documented | One sidecar comment | Noise continues; the 8th disposition still gets derived from scratch |
| **Move the close-protocol spec out of the churning file** | ~31 lines relocated | **Makes the existing whole-file edge correct rather than working around it** |

**Recommended: the third.** `HANDOVERS.md` is 2374 lines, of which the header —
`## Two markers, and the difference matters` plus the preamble — is about 31. That
section is the entire coupled surface. Move it to a file that does not receive dated
appends, point the edge at that file, and leave `HANDOVERS.md`'s header as a pointer to
it. The edge then fires when the protocol changes, which is what it was declared to
watch, and stops firing on entries, which it was never about.

It also needs no new propagate machinery, which matters: the alternative buys precision
by making the tool's fastest path slower for everyone, to fix one edge's granularity.

**Do not just delete the edge.** It was declared 2026-08-26 *"after the two ends
disagreed for as long as both existed and nothing could see it"*, and one of its 12
dispositions is a real `propagated` and one a real `source-corrected` — so it has
caught genuine drift twice. The defect is the noise ratio, not the coupling.

**Test it can fail:** append a dated entry to `HANDOVERS.md` that touches no header
line, and assert the edge does NOT enter an actionable state. Today that assertion
fails, which is the issue.

**SUPERSEDED IN SCOPE 2026-09-17 — see N85.** A full census of the event store found
**104 edges (83% of all with ≥4 dispositions)** are majority `no-change-needed`, and
**refuted this entry's stated cause**: noisy sources churn LESS than non-noisy ones
(mean 7.3 vs 12.7 commits/60d). The real predictor is which SLICE of the source the
downstream depends on, not how often the source changes. This edge's diagnosis
(header vs whole file) is correct and is one special case of that. Read N85 first.

**GENERALISED 2026-09-17 — see N81.** A census found **five more files** with the same
shape: a machine-parsed grammar colocated with append-only churn. The important
difference is that **none of the five has a declared `kind: code` edge on its header**, so
none is costing review cycles yet — this edge is the only live instance. Four of the five
restate the `**Trigger:**`/`**Fires on:**` grammar that is already canonical in
`rule:every-project-carries-gotchas`, so their fix is a deletion and a citation, not a
relocation.

### N76 · The rule fingerprints are self-quotations, so `rules check` detects COPY-PASTE, not restatement — **S2** — **RESOLVED 2026-09-16**

Found 2026-09-16 while investigating whether Phase 2b was worth building. It is the
structural reason N35 has stayed open, and it is larger than N35.

**The measurement.** Take a rule, write its substance in your own words the way
another author's `CLAUDE.md` would, and test the live fingerprint against it.
Across 12 rules, with two independent sets of samples (a subagent's, then the
reviewer's own, written without seeing the first), **11 of 12 do not fire.**

The one that fires is `tool-priority`, and it fires for a reason that proves the
point rather than contradicting it: its fingerprint contains `code-review-graph` —
a **proper noun**. Nobody paraphrases a vendor string, so the token survives
rewording. Its claim does not.

Look at what the fingerprints actually are:

```
safety-flag-needs-a-test   safety flag is a claim|unsafe path is unreachable|A flag that promises
no-waiting-on-deploys      waiting on a Vercel deploy|do not poll .vercel list.|push.{0,20}move on
model-routing              Opus plans|Sonnet executes|opus for plan|sonnet.{0,30}(execut|implement)
```

Every alternation is a phrase lifted verbatim from the rule's own body. **A detector
built from a document's own sentences can only find copies of that document.** It
cannot find a restatement, because a restatement is by definition the same claim in
different words.

**What this means for the numbers everyone has been reading.** `rules check` reports
`0 silent restatements`, and that zero is TRUE as a statement about fingerprint hits
— verified today, every hit in the tree is cited. But it has been read as "nobody is
restating rules uncited", and it does not support that reading. The honest statement
is: *nobody has copy-pasted a rule without citing it.* Whether anyone has restated
one in their own words is **unknown and currently unknowable**, which is exactly the
unknown-vs-clean collapse N35 names — now shown to apply to the detector itself, not
just to the unexercised rules.

It also explains the distribution nobody had explained: `tool-priority` carries 12
restatements while most rules carry 0 or 1. That is not because tool-priority is
restated twelve times more often. It is because it is the only rule whose fingerprint
keys on something that survives paraphrase.

**Do not "fix" this by widening fingerprints speculatively** — N35 already records
the opposite error costing 8 files flagged to find 1. The fix N35 itself prescribes
is a per-rule known-positive probe: for each of 18 rules, hand-construct a real-style
restatement and widen that one fingerprint until it fires on the sample and still
does not fire on ordinary prose. Eighteen units of bounded work, one rule at a time,
each independently verifiable — not a heuristic over 936 pairs.

**Test it can fail:** for any rule, assert its fingerprint fires on a hand-written
paraphrase held in a fixture beside the rule. `--selftest` today asserts only that a
fingerprint matches its own body, which is the tautology this issue is about.

---

**RESOLVED 2026-09-16 — all 18 rules probed, and the fix found what the defect was
hiding.**

`rules/_probes.yml` now carries, for every one of the 18 active rules, two
paraphrases that MUST fire and four near-misses that MUST NOT, and each fingerprint
was widened until all four gates pass: positives fire, negatives stay silent, the
rule's own body still matches, and any change in corpus hits was opened and read
rather than counted. `selftest` runs the probes and reports UNPROBED as its own
state — proven by removing one entry and confirming it renders `17 of 18 rules
probed, 1 UNPROBED` rather than a silent pass.

**The shape of the fix.** Every fingerprint is now `<self-quote>|<structural>`. The
first half keeps the selftest's own-body assertion honest; the second matches the
claim's shape in someone else's words. Splitting them is what stops a widening from
quietly breaking the thing it was meant to preserve.

**The mandatory negative earned its place immediately.** Every entry carries the line
`See rule:<id> before doing X.` — because a rule's hyphenated id contains its own key
words and hyphens are word boundaries, so a loose pattern matches its own citation and
scores a reference as a restatement. It fired during construction on
`enforcement-watches-itself`, whose id supplied `watches` to a structural alternation
containing `watch`. Caught before shipping, in the rule about checks that do not cover
themselves.

**What it found: 2 restatements where the tool previously reported 0.**

| Rule | File | Verdict |
|---|---|---|
| `skill-routing` | `Divyansh/AuroraV3/CLAUDE.md:70` | **Confirmed restatement.** The whole routing table, with `/` separators and `→ invoke /skill` arrows |
| `delegation-criteria` | `ManavDaehi/CLAUDE.md` | **Borderline — needs a human.** "v2 derives state from content on demand … do not add a watcher" is mostly compliance, but the imperative is scoped reasoning from the rule's §2 |

The AuroraV3 hit is the satisfying one: `rule:skill-routing`'s own body predicted this
exact class — *"misses the other 7, which say `Product ideas`, `Ideas / brainstorming`,
and similar"* — and could not see it. The widened fingerprint accepts either separator
and now does.

**A stale count in that rule fell out of the same work, and the instrument lied while
establishing it.** The rule claimed 11 files used the canonical wording. Re-measured:
**1** `CLAUDE.md` in the tree contains `Product ideas` at all, against **17** that cite
the rule — so 17 of the 2026-08-14 census of 18 were converted, and the survivor is a
workspace added *after* the consolidation. `grep` reported **0**, because it is the
ugrep shim honouring the hub's `/*` `.gitignore`; a `node` walk found 1. That is
`rule:discernment-checks` §4 firing for the third recorded time on the same shim. The
rule now names the derivation command instead of carrying the number.

**Two defects in the reporting path, both found by using the fix rather than by
reading it:**

- `selftest`'s renderer had no branch for probe checks, so all 108 fell through the
  fingerprint/override ternary and printed as `override true  undefined` — the newest
  half of the check was simultaneously invisible and wrong on screen, while the summary
  line claimed only that fingerprints fire.
- `checkRules` decides a file restates a rule by testing the WHOLE text, then locates it
  by testing each line. A paraphrase that wraps matches the file and no single line, so
  the report rendered `ManavDaehi/CLAUDE.md:` — a file:line reference pointing nowhere,
  on the first real finding the widened detectors ever produced. Prose wraps; that is the
  point of a structural fingerprint. Now reported as `spansLines`, with a test whose
  mutation gate was re-run after the first attempt proved invalid (the fixture used
  `name:` where `loadRules` requires `id:`, so the test was failing before the mutation
  and its going red proved nothing).

**Still open, deliberately:** N35 is NOT closed by this. `claims restate`'s corpus is
cited-and-restated pairs; the unexercised-rule set is uncited. Disjoint by construction,
as recorded on N35 itself. What this changes is that a rule reporting `restated 0` now
means something — the detector has been shown to fire on paraphrase — where before it
meant only that nobody copy-pasted.

### N88 · Discovery counts abandoned git worktrees as workspaces, and their warnings are indistinguishable from real ones — **S3** — **OPEN**

Found 2026-09-17 while building the widget's HEALTH rows, which is the point: the
defect was invisible in doctor's own output and obvious the moment the same data was
rendered as a list of workspaces.

`doctor` reports **16** workspace sections. Two of them are not workspaces:

```
Workspace: calibration-sampler-52226   → ~/Documents/GitHub/worktrees/calibration-sampler-52226
Workspace: ubersicht-widget-52226      → ~/Documents/GitHub/worktrees/ubersicht-widget-52226
```

Both are real git worktrees created 10 Sep on branches `spec/calibration-sampler-52226`
and `spec/ubersicht-widget-52226`, abandoned a week ago, and still carrying a `.git`
file that discovery treats exactly like a repository root.

**What it costs.** 14 of the 350 workspace warnings come from these two, and a reader
has no way to tell them from the other 336. The denominator is wrong in the same
direction everywhere it is used: "0 of 16 clean" is really 0 of 14, and any future
adoption ratio computed against 16 is quietly off by 14%. This is the
`rule:discernment-checks` §5 shape — the population is not what the claim is about.

**Why it is S3 rather than S2.** Nothing is lost and no write is affected; the count
is merely wrong. But it is the class of wrong that gets published, because 16 is a
plausible number and nothing about the output invites checking it.

**The fix is not "filter out `worktrees/`".** That path is a convention of one
machine's layout, not a property of a worktree. A worktree's `.git` is a FILE
containing `gitdir: …`, where a real repository's is a directory — so discovery can
tell them apart structurally, on any layout. Whether to then EXCLUDE them or label
them is a separate question worth asking: a long-lived worktree with its own
propagation state might legitimately want a section, and `scripts/worktree-new.sh`
makes them routinely.

Two abandoned worktrees are also their own small finding — `worktree-rm.sh` exists and
was not run.

### N89 · `fixOrder`'s within-layer sort orders by name, and it already disagrees with `STATE_SEVERITY` today — not only as a future risk — **S2** — **RESOLVED 2026-09-21 — STATE_SEVERITY moved to lib/graph/graph.mjs and fixOrder sorts by severityRank; graph-html.mjs now imports the one ranking instead of holding the only copy. Mutation-gated in tests/unit/queue-order.test.mjs.**

Filed from the follow-ups list in `~/.claude/plans/okay-to-make-propagation-resilient-rivest.md`,
which framed this as "DIVERGED / DRIFTED / REVERSED happen to sort the same way alphabetically
as by severity — a coincidence, not a design." Verified, and the claim is wrong in the
direction that matters: **they do not currently sort the same way.**

`fixOrder` (`lib/graph/graph.mjs:490`) breaks ties within a layer with
`a.state.localeCompare(b.state)`. The severity ranking lives 90 lines away in a different
file, `lib/graph/graph-html.mjs:40-47`:

```js
const STATE_SEVERITY = [
  "DIVERGED", "REVERSED", "DRIFTED", "UNMATCHED",
  "UNRESOLVABLE", "NOT_PRESENT_ON_REF", "NEVER_VERIFIED", "CLEAN",
];
```

The four states `fixOrder` actually emits are `ACTIONABLE` (`lib/graph/graph.mjs:56`):
`DRIFTED`, `REVERSED`, `DIVERGED`, `UNMATCHED`. Sorted alphabetically that is `DIVERGED,
DRIFTED, REVERSED, UNMATCHED` — verified with `Array.prototype.sort` directly, not by eye.
Sorted by `STATE_SEVERITY` (worst first) it is `DIVERGED, REVERSED, DRIFTED, UNMATCHED`.
**DRIFTED and REVERSED are swapped between the two orderings, right now, with no new state
needing to be added.** Alphabetical sort puts the less-severe DRIFTED ahead of the
more-severe REVERSED; the severity table says the opposite.

This is not hypothetical. `node cli.mjs graph --json` against this tree today
(2026-09-21) reports both states populated: `DRIFTED: 15, REVERSED: 22` in `stats.byState`
— plenty of live edges of each kind, so the misordering condition (both states present in
the same topological layer) is a real, not theoretical, possibility on every run.

**The signal.** The new UI's READY division (per the plan, Phase D) presents `fixOrder`'s
output as "the top row is always the next action" — a worklist a person is meant to work
strictly top-down. Nothing on screen indicates that within a layer the ordering is
alphabetical rather than severity-ranked; it reads exactly like a correctly-ordered list.
Per `rule:discernment-checks` §6, "no result" and "the wrong result" must be
distinguishable — here they are not: a REVERSED edge sorted below a DRIFTED one in the same
layer looks identical to a REVERSED edge that is genuinely lower priority.

**The cost.** Someone working the list in good faith, at every layer boundary where the two
co-occur, fixes the less-severe DRIFTED edge first and the more-severe REVERSED edge
second — the reverse of what the project's own severity table says should happen — for as
long as this goes unnoticed, which by construction it cannot be noticed from the UI alone.

**Severity — argued, not asserted.** This repo's own scale: S1 "silently wrong (you cannot
tell it happened)", S2 "noisy or misleading". A case can be made for S1 — a human trusting
"top of the list is next" has no way to detect the swap without independently deriving
`STATE_SEVERITY` order and comparing, which is exactly what a worklist exists to save
someone from doing. Filed at S2 because the underlying data (`state`, `edge_id`, `layer`)
is correct and inspectable — nothing is lost or misreported, only the presentation order —
and because the fix is small: import `STATE_SEVERITY` (or a copy of it) into `graph.mjs`
and sort on `STATE_SEVERITY.indexOf(a.state) - STATE_SEVERITY.indexOf(b.state)` instead of
`localeCompare`. Note `graph.mjs` does not currently import from `graph-html.mjs` (only the
reverse), so the array likely needs to move to `graph.mjs` and be imported by
`graph-html.mjs`, not the other way around, to avoid inverting that dependency.

### N90 · `duplicatePairs` has no disposition path — a finding the tool can name but never let a human close — **S3** — **OPEN**

Filed from the same follow-ups list. `lib/graph/graph.mjs:329-350` builds `duplicatePairs`
from the edge index — two declarations of the same `(from, to)` with different `why`
strings — and says plainly in its own comment: *"which of the two `why` strings is right is
a human's call."* It is reported through `status` (`cli.mjs:1222-1224`), the graph JSON
(`cli.mjs:4460`), and `doctor`'s summary count (`cli.mjs:4488-4490`), but nowhere does the
tool offer a verb to resolve one — no `verify --disposition`, no `drain --close`, nothing.

**Verified live count today: 0.** `node cli.mjs graph --json` reports `stats.duplicatePairs:
0` and an empty `duplicatePairs` array — so this is **latent, not active**, exactly as
flagged going in. Nothing is currently sitting unresolved.

**Why it is a real gap even at zero.** Every other actionable graph state (DIVERGED,
DRIFTED, REVERSED, UNMATCHED) flows through one lifecycle: `fixOrder` surfaces it, `verify
--disposition` records a decision, the event store closes it. A duplicate pair has no
state at all in that model — `fixOrder` never emits it, because it isn't an edge state, so
it cannot reach the new UI's READY worklist even in principle. The only way to make the
`doctor`/`status` count change is to find the sidecar declaring the second `(from, to)` pair
and hand-edit it out — with no record anywhere that doing so was a resolution to this
specific finding, as opposed to an unrelated edit that happened to remove a row.

**The signal, if it recurs.** The code comment cites a real historical instance, measured
2026-08-17: 711 edge records over 710 distinct pairs — one genuine duplicate. At that
count it would have sat in every subsequent `doctor`/`status` run as an unchanging "1
duplicate declaration(s)" line until someone stumbled on it by hand; there is no mechanism
by which the count would ever self-correct or by which a person could mark it seen-and-
accepted.

**Cost, stated honestly since it's zero today:** currently nothing, because nothing is
duplicated. If it recurs, the cost is a permanently-open, permanently-unactionable finding
sitting in every health check indefinitely — the same shape as this register's own `E2`
(declare-ahead warnings that never expire) and `C1` (nothing reports what is not declared):
a real finding with no closing mechanism eventually gets read as noise and stops being
checked at all.

**Fix direction, not built:** either fold a duplicate pair into `verify` as a pseudo-edge
state that a disposition can target (closest to the existing lifecycle), or give `drain`/
`doctor` a narrower "acknowledge duplicate — kept `<edge_id>`, discarded `<edge_id>`" verb
that edits the sidecar and records why. Not attempted here — this entry only establishes
that the gap is real and currently harmless.

### N91 · `doctor.duration_ms` spikes recur at 18-24 minutes, most recently in the last 24 hours — **S2** — **OPEN**

Filed from the same follow-ups list, which flagged the metric's all-time max
(1,446,450 ms / 24m6s) as "unexplained." Re-measured against `~/.propagate/metrics.jsonl`
directly (841 rows, `metrics["doctor.duration_ms"]` is a dotted key nested one level under
`metrics`, not a top-level field — worth noting since a shallow read of the JSON looks like
the field doesn't exist). **The plan's numbers check out exactly:** max 1,446,450 ms at
`2026-09-17T15:23:32.496Z` (run `b2e7a71b…`), min 280 ms (`2026-08-13T19:44:32.487Z`).

**What the plan did not have yet: this is not a one-off, and it is not four days old.**
17 of 841 runs (2%) exceed 100 seconds, clustered in bursts rather than spread evenly:

| when | runs >100s | range |
|---|---|---|
| 2026-08-20, ~90 min window | 4 | 109,753 – 143,527 ms |
| 2026-09-01, ~2 hr window | 5 | 104,661 – 223,998 ms |
| 2026-08-29 / 2026-08-31 | 1 each | 114,801 / 219,535 ms |
| **2026-09-17T15:23** | 1 | **1,446,450 ms** (the plan's outlier) |
| 2026-09-20T09:23 | 1 | 109,601 ms |
| **2026-09-20T15:27** | 1 | **1,082,398 ms** (18m) |
| **2026-09-21T00:53** | 1 | **1,155,574 ms** (19.3m) |
| 2026-09-21T03:14 | 1 | 130,256 ms |

The three worst runs — 24.1m, 19.3m, 18.0m — are the three most recent minutes-long spikes
in the file, landing 2026-09-17, 2026-09-20, and **last night (2026-09-21, today)**. This is
a live, recurring hazard, not a historical curiosity from four days ago.

**A shared trait across the three worst runs:** all three post-date the workspace census
growing to 16-18 discovered workspaces / 43-44 loaded sidecars, roughly double the 7
workspaces / 21 sidecars in place when this metric was first captured (2026-08-13) — so the
absolute amount of per-workspace work `doctor` does today is larger than when the metric
baseline was established.

**A candidate mechanism, offered as a lead and not confirmed by reproduction.** `doctor`
still shells out to at least two external processes with no timeout:
`execSync("launchctl list", { encoding: "utf8" })` (`lib/report/doctor/environment.mjs:129`)
and, once per discovered workspace, `execFileSync("git", ["-C", ws.root, "remote"], ...)`
(`lib/report/doctor/workspaces.mjs:79`) — 18 calls on today's tree. This is the identical
shape this register's own **N16** found and fixed for a different call (`claude mcp list`,
measured at 17,793 ms / 94% of a run, bounded to a 2s timeout with a 1hr cache): *"an
unbounded subprocess inside a health check is a liveness risk... a hung binary would hang
`doctor` itself, indefinitely, with no distinguishing signal."* Neither of these two call
sites has that protection. Separately, **N50** measured this exact machine under concurrent
`node --test` load producing "load average: 33.6, mostly I/O wait" and real `git` calls
taking 27.4s where they normally take under 1s — the same failure mode (slow `git` under
load), recurring inside `doctor`'s unbounded call across an 18-workspace fan-out, would
produce spikes of exactly this shape and size. Per `rule:discernment-checks` §4, this is
correlation, not a confirmed cause — nobody has caught a spike live with a subprocess
timer attached.

**Cost.** `doctor` is the health check both a human and the new UI/widget lean on for "is
the system fine" (per STATE.md: "the 37s cache, on the monitor's existing tick"). An
18-24 minute run is long enough to exceed any reasonable caller's patience; invoked from
anything with its own timeout — a hook, a pre-push gate, CI — it would read as a failure
indistinguishable from a real one. It also means the widget's "last checked" data can be
stale by tens of minutes with no visible explanation, which is exactly the kind of silent
staleness `rule:discernment-checks` §2 says a check must never produce.

**Fix direction, not built:** bound both call sites the way N16 bounds `claude mcp list` —
an explicit `timeout` plus a distinct `status: "timeout"` outcome that is never read as a
pass — and instrument `doctor`'s own phases so the next spike names which subprocess it was
waiting on, rather than only a total.

### N92 · The plugin-file pathspec answers two different questions with one list, so a docs-only commit counts toward the release bound — **S3** — **OPEN**

Filed 2026-09-24 from the plugin-delivery work, immediately after landing it. `shippedPathspec()`
(`lib/report/doctor/delivery.mjs`) excludes exactly `tests/**`, `docs/**` and `propagation/**`, which
means every repo-root markdown file is inside the shipped set:

```sh
node --input-type=module -e 'import("./lib/report/doctor/delivery.mjs").then(m=>console.log(m.shippedPathspec()))'
git ls-files | grep -E '^[^/]+\.md$'      # DESIGN.md  README.md  SKILL.md
```

`SKILL.md` belongs there — it is the plugin's skill entry and a change to it genuinely changes what
the plugin does. `README.md` and `DESIGN.md` do not.

**Why that is a defect and not a quibble.** The same list is used for two different questions:

| question | consumer | is `README.md` a correct member? |
|---|---|---|
| what does the plugin SHIP, so a served copy can be compared? | `treeDigest`, and the `missing` set | **yes** — it is copied into the served tree, so its absence is a real difference |
| what counts as a RELEASE-worthy change, for the staleness bound? | `deliveryLag`'s `git rev-list … -- <pathspec>` | **no** — the 2026-08-27 decision is that a doc-only addition is not a release |

So eleven commits touching only `README.md` would push `commitsBehind` past `deliveryMaxCommits` and
fail `doctor`, for a reason the bound was explicitly designed to exclude. That is a false positive in
a gate, and `lib/report/doctor/delivery.mjs`'s own header names the consequence: *"A health check
that goes red during ordinary development trains people to ignore it."*

**S3 rather than S2 because reaching it takes a run of 11+ commits touching only those two files**,
which has not happened; the day this was filed the count was 37 and every contributing commit touched
real code. It is a latent false positive, not a live one.

**A hazard met while filing this, worth recording next to it.** This entry's own heading originally
read "The shipped pathspec …" and the backlog reader counted it CLOSED — because `shipped` is in
`CLOSING_WORDS` (`lib/docs/tokens.mjs`), and the incidental word beat the explicit `**OPEN**` marker
in the same heading. Measured after rewording: 0 of the 30 currently-`**OPEN**` headings carry a
closing word, so this is latent rather than live, but the word collides badly with the vocabulary of
a repo about shipping. Check a new heading with `hasClosingWord()` before filing, not after the count
looks wrong.

**Not fixed on filing, deliberately.** D12 of the delivery review made this ONE exported definition
precisely so CI and `doctor` could not disagree, and splitting it into "ships" and "release-worthy"
partly revisits that. Whoever takes this should decide whether the second question deserves its own
derived list (`shippedPathspec()` minus non-functional root docs) or whether the bound should simply
not count `.md` outside `SKILL.md`. Do not solve it by adding a second hand-maintained list — that is
N78's and [[PR-012]]'s shape.

### N93 · `docs/SYSTEMS.md`'s `gotcha-guard` probe cannot run, and its row makes three false claims about a component that is alive — **S2** — **OPEN**

Found 2026-09-24 while exploring for the plugin-delivery review. `docs/SYSTEMS.md:51` registers
`gotcha-guard` with an artifacts field naming `~/.claude/hooks/gotcha-guard.mjs` and a
`liveness_probe` of three commands it says are **all** needed. Measured:

| the row claims | actually |
|---|---|
| artifact `~/.claude/hooks/gotcha-guard.mjs` | **absent.** `~/.claude/hooks/` exists but holds only `obsidian-commit-log.py` and `stop-context-check.sh` |
| "registered in `~/.claude/settings.json`" | **not there.** No `gotcha-guard` string in that file; it is registered by the plugin's own `hooks/hooks.json` |
| probe 1 `node --test ~/.claude/hooks/` | **throws** a module-loader error — there is nothing there to test |
| probe 2 `node ~/.claude/hooks/gotcha-guard.mjs --selftest` | cannot run — that path does not exist |
| probe 3 `tail ~/.claude/gotcha-guard.log` | **works**, and shows the component is fine |

**The component is alive.** `~/.claude/gotcha-guard.log` is 4.5 MB and its last line the day this was
filed reads `2026-09-24T11:29:15.786Z tool=Bash sources=4 entries=34 bad=0 hits=0`. So this is not a
dead hook — it is a live hook whose registered way of proving it is alive is itself dead. An auditor
running the documented probe concludes the opposite of the truth.

**This is the twelfth referrer of the 2026-08-22 plugin cutover**, and [[N43]] is the eleven. The file
moved into the plugin that day, is served from
`~/.claude/plugins/cache/tathya/propagate/<version>/hooks/gotcha-guard.mjs`, and this row still names
the pre-cutover path. N43's own text says `docs/SYSTEMS.md` is *where a liveness probe per background
component is supposed to live*, and asks whether "these entries have no probe, or the probe has never
run." For this row the answer is now measured: the probe exists and has never run, because it cannot.

**The fix is not simply repointing the path.** G63 is explicit that a `--selftest` run from the source
repo proves nothing about production, because Claude Code serves a COPY — so the probe must target the
served tree, which is version-keyed and therefore not a fixed path. That makes this a real design
question rather than a typo: derive the served path (the delivery work added `activeInstallPath()` in
`lib/report/doctor/delivery.mjs`, which answers exactly this) or accept that the probe can only ever
check the log. `rule:enforcement-watches-itself` — the register built to make components verifiable
contains an unverifiable entry for the component its own text calls "the one most likely to become
decorative."

### N94 · A gotcha trigger matches command text inside a commit message, so writing about a hazard fires it — **S3** — **OPEN**

Found 2026-09-25 while promoting G-P. `hooks/gotcha-guard.mjs` matches a `**Trigger:**` regex
against the Bash call's whole command string, which includes heredoc bodies. A commit message
*quoting* a hazardous command therefore fires the entry about it: writing the G-P commit — whose
body quotes `git checkout -- <file>` — triggered both G-O and G-P at once.

Harmless in itself, and the cost of a good trigger rather than a bad one: narrowing to "the
command as executed" means parsing shell, and a guard that tries to be clever about quoting will
miss the real thing. But it is worth knowing before anyone widens a trigger, because the noise
scales with how often the hazard is discussed, and the entries most discussed are the ones most
recently paid for.

The honest options are to accept it, or to skip matching inside a heredoc body specifically —
which is a narrow, testable rule rather than general shell parsing.

### N95 · `fs.existsSync` gets a non-string somewhere in the digest path, and the source is unlocated — **S3** — **OPEN**

`~/.propagate/digest.stderr.log` carries, on every recent run:

```
(node:48423) [DEP0187] DeprecationWarning: Passing invalid argument types to fs.existsSync is deprecated
```

Something calls `existsSync` with a value that is not a string or URL — most likely `null` or
`undefined` from a config field that is legitimately unset on this machine, of which
`INTEGRATIONS.marketplaceDir` is the known example (PR-016). `lib/skills/skills-scan.mjs:464`
guards its own call with `!marketplaceDir ||` first, so it is not that one.

**Not reproduced.** `node --trace-deprecation cli.mjs inventory` does not surface it, so the call
sits on a path `inventory` does not reach. Recorded rather than guessed, because a plausible
attribution here would be exactly the "reader invents an answer" failure `rule:discernment-checks`
§6 describes. The next person should run the digest itself under `--trace-deprecation`.

Latent rather than harmful today: Node has deprecated the coercion, so a future major turns this
into a throw on a path nobody has identified.

### N96 · The three components that deliver and verify rules each compute the rules directory independently — **S2** — **OPEN**

Measured 2026-09-25. `lib/core/config.mjs` already exports 37 symbols including `RULES_DIR`,
`STATE_DIR`, `SKILL_DIR`, `HUB_ROOT` and an `INTEGRATIONS` record — so the config module is not
missing, it is **bypassed**. 62 path literals sit outside it across 29 files.

Counted by path, `config.mjs` against everywhere else:

| path | in config | elsewhere | files |
|---|---|---|---|
| `~/.claude/rules` | 1 | **3** | 3 |
| `~/.propagate` | 4 | **10** | 9 |
| `~/.claude/CLAUDE.md` | 0 | 4 | 3 |
| `~/.claude/plugins` | 0 | 3 | 2 |
| `~/.claude/settings.json` | 0 | 2 | 2 |
| `~/.claude/skills` | 1 | 2 | 2 |
| `~/.claude` (bare) | 0 | 2 | 1 |
| `~/.agents` | 0 | 1 | 1 |

**The first row is the defect, not the tally.** The three files that recompute
`~/.claude/rules` are `lib/report/doctor/discovery.mjs:531`, `hooks/load-rules.mjs` and
`hooks/rule-guard.mjs:66` — the check that verifies rules, the hook that reports them at session
start, and the hook that pushes them at tool time. Each decides for itself where rules live. They
agree today by coincidence, and the failure mode if one ever drifts is silent and total: rules
load from one directory while the checker reads another, and both report success.

That is `rule:tool-priority`'s own history — nine divergent copies making four mutually exclusive
claims — reproduced in code rather than prose, inside the tool built to detect it.

**Paths that exist in no config at all**, each defined where it is used:
`gotchas-global.md` and `gotcha-guard.log` (`lib/gotchas/parse.mjs:43-44`), `rule-guard.log`
(`hooks/rule-guard.mjs:67`), `skills-registry.off` (`lib/skills/skills-lifecycle.mjs:87`),
`~/.claude/skills` and `~/.agents/.skill-lock.json` and `~/.claude/projects`
(`lib/skills/skills-scan.mjs:47-53`), `~/.claude/plugins/cache` and `installed_plugins.json`
(`lib/report/doctor/delivery.mjs:277,312`), `DAILY.md` (`lib/report/inventory.mjs:76`).

**Why this matters beyond tidiness.** Two of this session's findings were path-location failures
that a single registry would have made structural rather than accidental: the hub's task list was
invisible because `lib/report/backlog.mjs:117` matches the filename `TODOS.md` literally
(landed 2026-09-25), and `gateVersionManifests` had to grow a cross-repo path by hand for the
fifth manifest (PR-016). Both were "a path decided at the point of use".

The fix is a registry that grows by declaration — add a name, not a `path.join` — and a test
asserting no path literal for a known root appears outside it. Without that assertion the
registry becomes the 39th symbol nobody reaches for, which is the same failure one level up.

### N97 · Seven declared colour pairs sat under 4.5:1 in the light theme, and the guard could not see any of them — **S2** — **RESOLVED 2026-09-25**

**This entry was filed naming ONE pair. A derived check found SEVEN, which is the finding.**
Filed against `--dim` on `--field` at 4.40; then, instead of fixing that value, the check was widened
first — and it immediately returned five more, across five distinct token combinations, every one in
the light theme and none in dark:

| contrast | rule | pair |
|---|---|---|
| **3.60** | `.badge.none` | `--dim` on `--line` |
| **3.85** | `.vin-resolved` | `--st-ok` on `--ok-quiet` |
| **4.00** | `.vin-unresolved` | `--st-warn` on `--warn-quiet` |
| 4.40 | `.vin-absent` · `.vin-unknown` · `.reason` · `kbd` | `--dim` on `--field` |

Three of the seven were added the same day by the stream-panel work, in a change that ran the full
suite and shipped green.

**Fixed by derivation, not by eye** — `lib/report/color.mjs`'s own `contrast()` solved for each
threshold, then took headroom:

- `--dim` light **.546 → .490** (.495 is the threshold against `--line`). One change cleared five of
  the seven. Now 4.57 on `--line` through 6.24 on `--card`. The dark `--dim` is a separate
  declaration and is untouched.
- `--warn-quiet` and `--ok-quiet` light offsets **+.38 → +.44** (.433 and .432 are the thresholds).
  Now 4.58 and 4.60. Their only other consumer, `.banner`, puts `--fg` on `--warn-quiet`, so a
  lighter ground only improves it.

**The guard was widened before the values were touched**, which is why this entry is worth reading:
`tests/unit/theme.test.mjs` now carries *"every colour/background pair ui.css DECLARES clears 4.5:1,
both themes"* — it reads the stylesheet, finds every rule declaring both a `color` and a
`background`, and checks that pair. It names no tokens, so adding a rule adds coverage and there is
no list to remember to extend. It refuses to run on fewer than 12 pairs, because a regex that stops
matching would otherwise report a clean sweep of nothing.

**Mutation-proven:** reverting `--dim` to `.546` turns it red naming all five affected rules with
their measured values and the line *"15 pairs checked in 2 themes"*. Restored, green. General form
filed as **G70**.

**Measured 2026-09-25** with the repo's own `contrast()` from `lib/report/color.mjs`, resolving
`commands/ui.css` in both themes:

| pair | light | dark |
|---|---|---|
| `--fg` on `--bg` | 16.71 | 14.37 |
| `--dim` on `--bg` | 4.72 | 5.65 |
| `--fg` on `--card` | 17.43 | 13.08 |
| `--dim` on `--card` | 4.92 | 5.14 |
| `--fg` on `--field` | 15.59 | 14.95 |
| **`--dim` on `--field`** | **4.40** | 5.88 |

Everything clears except that one pair, in light only. `DESIGN.md` §"The three things a colour must
survive" sets the floor at **4.5:1 against its own declared ground, both themes**.

**Three rules declare exactly that pair**, all at small sizes, so the 3.0 large-text allowance does
not apply (large means ≥18.66px bold or ≥24px):

```
commands/ui.css:289  .vin-absent  { background: var(--field); color: var(--dim); border: 1px dashed var(--line); }
commands/ui.css:292  .vin-unknown { background: var(--field); color: var(--dim); }
commands/ui.css:332  .reason      { font-size: 12.5px; color: var(--dim); background: var(--field); ... }
```

**Two of the three were added on 2026-09-25**, by the stream-panel work, in a change that ran the
full suite and shipped green — because nothing checks this pair. `tests/unit/theme.test.mjs` runs
19 tests including contrast in both themes, but every colour assertion iterates `SEMANTIC`
(`:120-121`), which is **seven** tokens; `ui.css` uses **46**. `--dim`, `--field` and every other
token carrying real interface text are outside the population. Filed as **G70**.

**It is a 0.1 miss, and that is the point.** Nobody would catch 4.40 by eye, which is exactly what
a derived floor is for. The fix is a lightness nudge on `--dim` in the light branch, or a different
ground for those three rules — but it should not be applied without extending the guard first, or
the next 0.1 lands the same way.

**Fix order:** widen the check before fixing the value. A number corrected by hand under a guard
that still cannot see it is the same defect with a fresh timestamp.
