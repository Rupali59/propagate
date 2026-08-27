# Converged size caps — one checker, tree-wide, ratcheted

Status: ACTIVE
Reviewed by `/plan-eng-review` 2026-08-27 (8 decisions, D1–D8)
Owner: `propagate`

## Context

Twelve context-budget files are over cap by **4,168 lines**, and nothing reported it.
`Vipin Kaushik/scripts/hygiene/lib/size-caps.sh:63` reads `proj_files=("CLAUDE.md" "STATE.md")`
at each project's **pre-move repo path**, which since the 2026-08-21 relocation is a 14-line
pointer stub. The gate ran on all 15 commits that took
`marketing-intel/STATE.md` from 225 to 471 lines in a single day and named zero `STATE.md`
files. Filed as N53 (S1, open).

The review found the more interesting defect underneath it: **two forks of one library each
hold an improvement the other lacks**, 80 lines apart, and the union is strictly better than
either.

| capability | `Vipin Kaushik` | `PanditPawanKaushik` |
|---|---|---|
| Excludes auto-rendered `HYGIENE_RENDER` blocks | **yes** | no |
| `SIZE_CAPS_MEASURE=index` — reads the staged blob | no | **yes** (`size-caps.sh:106`) |
| Reports `measured_from` | no | **yes** |
| Reads `STATE.md` at the pre-move path (N53) | broken | broken |

The launchd jobs `com.tathya.hygiene.collect` / `.verify` run from `vipinkaushik-hygiene`, so
**the scheduled implementation is the one without index-reading**.

That matters beyond tidiness: `rules/conventions/CONTEXT-BUDGET.md` justifies warn-only caps
on the grounds that *"a caller that reads the committed ref cannot see a fix that exists only
in the working tree."* PPK's index-reading retired that argument and nobody propagated it.

## Decisions taken in review

| # | Decision |
|---|---|
| D2 | **Checker first, content second.** The 4,168-line backlog is not touched by this plan. |
| D3 | **Caps move into `propagate`**, beside `registers`, which already walks all 30 registers tree-wide and already emits `c.entries` / `c.lines` per file (`commands/registers.mjs:74`). |
| D4 | **Enumerate `propagation/state/*/`, fall back to in-repo, always report the source.** |
| D5 | **Ratchet: block growth only.** A capped file may commit if it did not get longer. |
| D6 | **Cap every register, including `GOTCHAS.md`** — overriding the standing exemption. |
| D7 | **`GOTCHAS.md` is capped by ENTRY COUNT** (`### ` headings), not lines, and ratcheted on that. |
| D8 | **Net-zero.** Editing an over-cap file means trimming at least as much as you add. |

D8 is what makes D5 more than a freeze. The objection raised against the ratchet — *"it bounds
the damage without repairing it"* — only holds if edits are rare. Net-zero editing means each
routine update carries one routing decision, so the backlog drains through ordinary work
instead of waiting on a cleanup nobody schedules. Once a file drops under cap the constraint
lifts by itself.

## Architecture

Two paths, deliberately separate. **The pre-commit path must never call the tree walker** —
that separation is the entire performance design, not an implementation detail.

```
PRE-COMMIT PATH  (a human is waiting — hard budget)

  git diff --cached --numstat ............ 1 subprocess, ~20ms, ALL staged files
      │
      ├── path not capped ──────────────────────────────────► pass, no further calls
      └── path capped;  net = added - deleted
              ├── net <= 0 ─────────────────────────────────► pass  (shrank or held)
              └── net > 0
                     git show :path | wc -l ... 1 more call, ONLY this file
                        ├── new <= cap ────────────────────► pass
                        └── new  > cap ────────────────────► BLOCK

  Common case: 1 subprocess.  Worst case: 2.
  GOTCHAS.md substitutes entry count for line count on both sides of the comparison.


DAEMON / REPORT PATH  (background — cost irrelevant)

  propagate caps
      └── for each workspace: enumerate propagation/state/*/
              ├── found ──────────────► measure real file      source: propagation-state
              ├── not found, in-repo ─► measure in-repo        source: in-repo
              ├── legacy holds a stub ► SKIP, never a pass     source: stub-legacy
              └── neither ────────────► absent                 source: absent
```

`source` is mandatory on every record. *"I looked at a stub"* and *"this file is 14 lines"*
must be different outputs — `rule:discernment-checks` §2 and §6. N53 measured two projects
(93 and 38 real lines) that pass **by accident**, which is what makes the three genuine
breaches hard to see.

### Three populations the resolver must handle

Do not simply repoint the path. N53's measurement:

| population | example | shape |
|---|---|---|
| moved, stub at legacy path | 5 projects | real file at `propagation/state/<p>/` |
| moved **only on a feature branch** | `astroacharya` | legacy path holds *stale real content*, not a stub |
| never migrated | `VipinKaushik` | 78 real lines in-repo, no `propagation/state/` entry |

### Ledger — propagate computes, the hygiene daemon still writes

`collect.sh` swaps `bash lib/size-caps.sh` for `propagate caps --json` and keeps emitting the
identical row: same `category: size-cap`, same `transition_id` hash of
`(category, project, file, severity)`. Row schema, notification dedup and the v1→v2 SQLite
migration contract are untouched, and there stays exactly **one writer**.

Rejected: propagate writing its own event. That walks into propagate's own open issues —
**A2** ("the same drift can be open in two ledgers at once") and **N19** ("39 Event rows carry
a terminal status with no Transition — no audit trail"). Adding an event type to a store with
open audit-trail defects is the wrong trade. Also matches `rule:delegation-criteria` §2:
derive on demand, persist where persistence already lives.

## What already exists (reuse, do not rebuild)

| Exists | Where | Used for |
|---|---|---|
| Tree-wide register walk with per-file `entries` + `lines` | `propagate/commands/registers.mjs:74` | the whole daemon path — cap comparison is a filter over output that already exists |
| Index reading + `index-deleted` handling | `PanditPawanKaushik/scripts/hygiene/lib/size-caps.sh:106-127` | port verbatim; its comment on the delete case is the spec |
| `HYGIENE_RENDER` block exclusion (fail-safe on unclosed) | `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh` `canonical_lines()` | port verbatim |
| Cap + override + yellow-threshold TOML parse | same file, lines 30-50 | port; caps table moves to a propagate-owned location |
| Ledger row schema and `transition_id` | `rules/conventions/CONTEXT-BUDGET.md` §Ledger row schema | unchanged — do not touch |
| Integration fixtures naming size-caps | `scripts/hygiene/fixtures/integration/expected.sh`, both workspaces | starting point for R1–R3 |

## Cap table (D6 + D7)

Implement the hub policy as written, plus the two D6/D7 additions.

| File | Cap | Metric |
|---|---|---|
| workspace `CLAUDE.md` | 220 | lines |
| project `CLAUDE.md` | 180 | lines |
| workspace / project `STATE.md` | 200 | lines |
| workspace **and project** `TODOS.md` | 150 | lines |
| `MEMORY.md` | 40 | lines |
| `ISSUES.md` | 800 | lines |
| handover register | 800 | lines |
| **`GOTCHAS.md`** | **80** | **entries (`### ` headings)** |

**The gotchas cap must sit above the current maximum.** Measured 2026-08-27: 18 files, largest
is `propagate/propagation/state/workspace/GOTCHAS.md` at **67 entries** / 1376 lines. A cap of
80 leaves headroom; anything at or below 67 freezes the largest file on day one and
contradicts D5's "passable day one" principle, which is the property that stops people
reaching for `--no-verify`.

Accepted cost of D7, recorded so it is not rediscovered: once a `GOTCHAS.md` reaches its entry
cap, admitting the next hazard is blocked until a `RETIRED` entry is collapsed to a tombstone —
and that lands on whoever is mid-incident. This was raised and chosen deliberately.

## Failure modes

| # | Codepath | Realistic production failure | Test? | Error handling? | User sees |
|---|---|---|---|---|---|
| F1 | `resolveStateFile` | returns a stub's 14 lines as a passing count | **R1** | explicit `skipped: stub-legacy` + path | clear |
| F2 | numstat parse | a **rename** row (`R100 old new`) misattributes the delta, so growth passes | needed | must parse rename form | **silent if unhandled** |
| F3 | numstat parse | binary rows are `-\t-\tpath`; `-` coerced to 0 reads as "no growth" | needed | reject non-numeric, do not default | **silent if unhandled** |
| F4 | `countEntries` | a fenced code block containing `### ` inflates the entry count | needed | strip fences before counting | **silent if unhandled** |
| F5 | `collect.sh` → propagate | propagate errors; no ledger row is written and the absence reads as "no size issues" | needed | emit row with `severity: error` | clear once handled |
| F6 | `capFor` | no cap declared for a kind, rendered as green | needed | `SKIP`, distinct from green | clear once handled |

**F4 is a critical gap and a known repeat.** propagate's own **N51** is exactly this bug one
file over — *"`parseHandovers` reads fenced examples as real sections"* — and it shipped. Any
`^### ` counter written the obvious way reintroduces it. Strip fences first; assert with a
fixture whose fenced block contains a decoy `### ` heading.

F2 and F3 are critical until handled: all three of "grew", "shrank" and "unparseable" would
otherwise render as pass.

## Test plan

Coverage today is **0/22 paths**. `propagate/tests/` has no test for `registers`, `doctor` or
`backlog` — the walker being reused is untested at command level, which is its own finding.

### Mandatory regression tests (no approval needed — REGRESSION RULE)

N53 is a regression: a working checker was broken by the relocation.

- **R1 — the test N53 never had.** Fixture: 14-line stub at the legacy path, 586-line real file
  at `propagation/state/<p>/STATE.md`, cap 200. Assert `status: red` **and**
  `source: propagation-state`. Then mutate the resolver to prefer the legacy path and assert
  it goes red *for the stated reason*. Confirm the mutation actually applied —
  `rule:discernment-checks` §4 records a `sed` and a `re.sub(count=1)` both silently no-opping
  this exact check.
- **R2 — green must be distinguishable from green-by-stub.** The fixture set must include a
  project genuinely under cap via the new path (Astroclarity's 93 lines is the real case).
  Without R2, R1 passes on a checker that reports everything red.
- **R3 — the ratchet is a safety claim.** Per `rule:safety-flag-needs-a-test`: snapshot the
  repo, run the gate on a growth commit, assert it blocks **and that nothing was written**.
  Loop across every capped file kind — the bug class here is one path honouring a rule while
  another does not, so a single-kind test would pass.

### Remaining coverage

Every `[GAP]` in the review's coverage diagram becomes a test: five resolution branches, three
counting branches (render block, unclosed render block, fenced-heading decoy), two cap-lookup
branches, six ratchet branches including delete-in-commit and add-over-cap, and two ledger
branches. Seven are marked `[→E2E]` — the pre-commit flows, which must be exercised through an
actual staged commit rather than by calling the function.

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding.

- [ ] **T1 (P1, human: ~2 days / CC: ~1h)** — `propagate/commands/caps.mjs` — port cap lookup, override table and yellow threshold from the shell forks
  - Surfaced by: Architecture A1 — two forks, 80 lines apart, neither complete
  - Files: `propagate/commands/caps.mjs`, `propagate/lib/report/` , cap table location
  - Verify: `node propagate/cli.mjs caps --json | jq '.[0]'` returns cap, actual, status, source
- [ ] **T2 (P1, human: ~1.5 days / CC: ~45min)** — `caps.mjs` — `resolveStateFile` over the three populations, always returning `source`
  - Surfaced by: Architecture A2 / N53 — five of seven projects resolve to stubs
  - Files: `propagate/commands/caps.mjs`, reuse `commands/registers.mjs` walker
  - Verify: R1 + R2 red on mutation, green on the real tree
- [ ] **T3 (P1, human: ~2 days / CC: ~1h)** — pre-commit ratchet on `git diff --cached --numstat`, incl. rename and binary rows
  - Surfaced by: A3 / D5, failure modes F2 + F3
  - Files: `Vipin Kaushik/scripts/hygiene/precommit-check.sh`, `PanditPawanKaushik/…/precommit-check.sh`
  - Verify: R3; and time it — must stay ≈1 subprocess in the common case
- [ ] **T4 (P1, human: ~4h / CC: ~15min)** — `countEntries` for `GOTCHAS.md`, stripping fenced blocks first
  - Surfaced by: D7 + failure mode F4, which is propagate's own N51 one file over
  - Files: `propagate/commands/caps.mjs`
  - Verify: fixture whose fenced block contains a decoy `### ` heading; count must not move
- [ ] **T5 (P2, human: ~4h / CC: ~15min)** — `collect.sh` calls `propagate caps --json`; identical ledger row and `transition_id`
  - Surfaced by: the ledger constraint — one writer, schema untouched
  - Files: `scripts/hygiene/collect.sh` in both workspaces
  - Verify: diff a ledger row before and after; only `source` provenance may differ
- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — replace the per-file `python3` spawn with bash arithmetic
  - Surfaced by: Code quality C1 — 17 spawns × 50ms ≈ 850ms/run to compute `cap × 0.9`
  - Files: `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh:130,171,194`
  - Verify: time the daemon run before and after
- [ ] **T7 (P2, human: ~1 day / CC: ~30min)** — reconcile the three disagreeing cap lists into one table (D6)
  - Surfaced by: Code quality C3 — policy names `ISSUES.md`/handovers, TOML has neither, code checks four kinds
  - Files: `rules/conventions/CONTEXT-BUDGET.md`, both workspace `CONTEXT-BUDGET.md`
  - Verify: `propagate caps` emits a row for every kind in the table, and no kind lacks a cap
- [ ] **T8 (P3, human: ~1 day / CC: ~30min)** — first command-level tests for `registers` / `doctor` / `backlog`
  - Surfaced by: Test review — the walker being reused has no test
  - Files: `propagate/tests/cli/`
  - Verify: `npm test`

## Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| T1, T2, T4 | `propagate/commands/`, `propagate/lib/` | — |
| T7 | `rules/conventions/`, workspace `docs/conventions/` | — |
| T3, T5 | `<workspace>/scripts/hygiene/` ×2 | T1, T2 |
| T6 | `Vipin Kaushik/scripts/hygiene/lib/` | — |
| T8 | `propagate/tests/` | T1, T2 |

```
Lane A: T1 → T2 → T4   (sequential, shared propagate/commands/)
Lane B: T7             (independent — policy docs only)
Lane C: T6             (independent — interim shell patch)
        ─────────── barrier: T1+T2 must land ───────────
Lane D: T3 → T5        (sequential, shared scripts/hygiene/)
Lane E: T8             (independent once T1+T2 land)
```

Launch A + B + C in parallel worktrees. Merge. Then D + E.

**Conflict flag:** T3, T5 and T6 all touch `scripts/hygiene/` in the same two workspaces. T6 is
an interim patch to a file T3 also edits — land T6 first or fold it into T3.

## NOT in scope

| Deferred | Why |
|---|---|
| Routing the 4,168-line backlog out of the 12 over-cap files | D2 — trimming against a gauge that reads stubs cannot be verified. Under D8 this now drains through ordinary editing rather than needing a scheduled pass. |
| A `STATE.md` row in the register-rotation table | Follows the content work, not the checker. |
| Installing the checker in the six workspaces with no hygiene daemon | D3 makes this free at the report layer (propagate is tree-wide). Installing *pre-commit hooks* there is separate. |
| **N54** — the gotchas liveness probe counts pointer stubs as inert files | Same root cause (readers left at old paths), already filed, S3. Confirmed again here: four `GOTCHAS.md` of 15-20 lines with 0 entries are legacy stubs. |
| **N55** — the refs registry's new owner is wired to nothing | Same root cause family, S1, already filed. |
| Retiring `size-caps.sh` entirely | Keep both forks running until `propagate caps` has R1–R3 green; delete in a follow-up. |
| Cross-workspace SQLite ledger mirror (v2) | The v1→v2 contract is preserved but not exercised by this work. |

## Open risks

1. **The gotchas entry cap is a guess.** 80 is chosen as "above the current max of 67". Nothing
   validates that number; revisit after one quarter of real use.
2. **D7's mid-incident block is accepted, not solved.** If it fires in practice and someone
   skips recording a hazard because of it, that is the signal to revisit — and the cost will be
   invisible, so it must be asked about rather than waited for.
3. **The shell→Node port is where behaviour silently changes.** Port `canonical_lines` and the
   index handling verbatim, including PPK's `index-deleted` case; do not re-derive them.

4. **`[active_lines]` is one knob with eleven consumers, and it moves while propagation
   stabilises.** The canonical-guard's "expected branch" is not a hard rule — it reads
   `[active_lines].workspace` from `docs/conventions/CONTEXT-BUDGET.md`
   (`canonical-guard.sh:32,77`, defaulting to `main`), so pointing it at a feature branch is a
   supported move during the migration. **But the same key drives ten other readers**, including
   `size-caps.sh:94`:

   ```bash
   canonical_lines() { local repo="$1" active="$2" relpath="$3"
     local ref="$active"        # the file is read AT the active line
   ```

   So repointing `active_lines` to unblock a commit **also repoints the size checker at that
   branch**, and every cap number moves for a reason unrelated to anyone editing content. Under
   the ratchet that is worse than cosmetic: the baseline the gate compares against changes
   underneath it, so a file can read as having grown or shrunk without any edit.

   **What the resolver must do about it.** D4 already requires every record to carry its
   `source`; extend that to carry the **ref it was read at**, and treat an `active_line` that is
   not the repo's default as a reportable condition rather than a silent input. The other ten
   consumers are: `worktree-doctor.sh`, `worktree-inventory.sh`, `decisions-check.sh`,
   `hygiene/collect.sh`, `lib/{state-index,state-shape,state-staleness,branch-registry,ref-resolver,worktree-resolver}.sh`.
   Anything that changes this key should say which of them it just moved.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 8 issues, 3 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** ENG reviewed — 8 findings raised, all 8 decided (D1–D8). Three critical failure
modes (F2 rename rows, F3 binary rows, F4 fenced-heading miscount) are specified with tests and
must be handled before T3/T4 land. Outside voice skipped: `codex_reviews` is `disabled`.

NO UNRESOLVED DECISIONS
