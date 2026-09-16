<!-- Promoted 2026-09-16 from ~/.claude/plans/okay-to-make-propagation-resilient-rivest.md
     Renamed on promotion: lib/report/doc-kind.mjs:89 classifies a file as kind "plan"
     only when it sits under plans/ AND its basename carries a date, so the generated
     session name would have promoted into invisibility — present in the repo and
     classified as nothing. The convention at Vipin Kaushik/docs/plans/README.md says
     `git mv`, which cannot work here: ~/.claude/plans is not a git repo. -->

# Plan: give plans arrival conditions — `plans --check`, then backfill the live set

Supersedes the v0.6.1 / claims-lane plan, which shipped as PR #17.
Reviewed by `/plan-eng-review` 2026-09-16 — 7 decisions, all folded in below.

## Context

The idea was: read plan headlines to derive goals, because `GOALS.md` has almost no
input. Investigation replaced that with something better grounded.

**The forward fix already exists and nobody holds it.** `.templates/PLAN.md`
(2026-09-14) already mandates a `## Goal state` section carrying `**Done when:**` and
`**Derived by:**`, parsed three-state by `lib/report/goals.mjs`. **Nothing enforces
it** — zero files under `lib/`, `commands/`, `cli.mjs`, `hooks/` or `skills/` reference
`PLAN.md`. Prose describing a contract no code checks, in the repo whose job is catching
exactly that (`rule:enforcement-watches-itself`).

Measured across all 200 in-tree plan files:

| | count |
|---|---|
| have an H1 headline | 199 |
| carry `Done when:` | **0** |
| carry `Derived by:` | 1 |

**Withdrawn: generating goals from the 199 headlines.** A headline states an intention;
a goal needs an arrival condition, and `0 of 200` carry one. Machine-generating them
would fabricate the judgment half — and at 199 stubs it is 25× the "eight files authored
in one sitting by one person" failure `GOALS.md` refuses in its own header.

**Also corrected during review: this does NOT close N35.** `claims restate`'s corpus is
`referencedRestatements` — cited AND restated. An unexercised rule has `restated 0,
referenced 0`. Disjoint by construction. Recorded on the N35 entry in PR #17.

## How a goal is recorded into propagation — the dry run

A goal is not a new record type. It is an entry in a `GOALS.md`, and that file is
already a declared downstream — hub `.propagates.yml:381`:

```
NORTH_STAR.md  ──kind: prose──▶  propagation/state/workspace/GOALS.md
```

1. **Write** the entry (`## N · <title>`, `**Done when:**`, `**Derived by:**`).
2. **Drift fires when the SOURCE moves** — edit `NORTH_STAR.md` and `check --changed`
   names `GOALS.md` as a downstream that did not follow. **Decision 4 adds the reverse
   edge**, so a goal edit now fires too.
3. **`propagate goals`** renders open / closed / **unknown**, plus claimed / waived /
   **none** — a goal asserting a condition nobody can check that does not admit it.
4. **`doctor`** carries the tree-wide census under `# Goals`.
5. **Nothing executes `Derived by:`** — pinned by a canary in `tests/unit/goals.test.mjs`.
   Running shell written inside a markdown file is the hole `lib/report/handovers.mjs`
   refuses in those words.
6. **Closure is an event**, via `verify --edge <id> --disposition … --apply`, into the
   append-only store — never an edit to the goal.

Rehearse read-only before writing anything:

```bash
node cli.mjs goals --json       # current parse; expect 1 GOALS.md, hub only
node cli.mjs doctor             # the `# Goals` census line
# then: touch NORTH_STAR.md, run `check --changed`, confirm GOALS.md is named, revert
```

That last step proves the edge fires rather than assuming it
(`rule:adversarial-review-reads-the-ledger`).

## Goal state

Added 2026-09-16, and the reason is unflattering: `plans --check` was run against
its own corpus the day it was built and flagged **this file**. A plan whose subject
is "plans must declare an arrival condition" had none. `rule:enforcement-watches-itself`,
arriving on schedule.

**Done when:** `plans --check --root ~/.claude/plans` reports **0 flagged** among
authored plans — that is, every post-2026-09-14 plan that a person actually wrote
carries a `## Goal state`. Machine-generated `*-agent-<id>.md` files are excluded
from that target and are tracked separately (see N74); they are byproducts of a
subagent inheriting plan mode, not authored plans, and will never have arrival
conditions.

**Derived by:** `node ~/Documents/GitHub/propagate/cli.mjs plans --check --root ~/.claude/plans`
— the `conformance` line under `totals`.

**Done when:** the plugin anyone runs is the code in this repo — `doctor`'s
`# Delivery` section reports `current` for every served tree, with no `stale` and
no version-matches-content-differs row.

**Derived by:** `node ~/Documents/GitHub/propagate/cli.mjs doctor`, the `# Delivery`
section. Note this cannot see a *running process* holding older code in memory; only
the timestamp of the process against the cache can, and nothing derives that yet.

**Judgement, not derivable:** whether the 11 currently-flagged plans are worth
backfilling at all. Five are subagent artifacts, one is a design doc that happens to
live in `plans/`, and the rest are session scratch that may never be returned to.
The count is mechanical; the decision to spend time on any given file is not, and
pretending otherwise would manufacture work.

## CORRECTIONS — outside voice, 2026-09-16, independently re-verified

An outside-voice pass challenged this plan and four of its claims were confirmed by
re-reading the code. **The plan proceeds by explicit decision (D2) with these folded in.**

**1 · The corpus predates the rule. The headline number answers the wrong question.**
Newest dated plan in the tree: **2026-09-01**. `.templates/PLAN.md` first commit:
**2026-09-14** (`e24b0c1`). Zero plans have been authored since the template landed, so
"0 of 200 carry `Done when:`" is `0 of 0 applicable`. **Consequence for the build:** gate
the count on file date ≥ 2026-09-14, or it reports 200 pre-existing files as debt forever
instead of ratcheting from zero.

**2 · `doc-kind` requires a DATED basename** (`doc-kind.mjs:85`, `DATED.test(n)`). Under
D2 the corpus is ~112 of 201, not 200 — the rest are routers and files nested below
`plans/`. **Report what the classifier excluded and why.**

**3 · `declaredState`'s `finished` branch cannot fire** — 0 of 201 plans live under
`archive/`. A class that is structurally always zero must not be advertised as a finding
(`rule:discernment-checks` §1).

**4 · `declaredState` is called with `seeds[0]` only** (`curate-docs/cli.mjs:163`) while
`link-graph.mjs:104` builds a multi-seed array; propagate has 3 seeds. This plan cited that
line as proven prior art and inherited the narrowing silently.

**5 · T1 is WITHDRAWN and was never a dependency.** `declaredState()` makes zero git calls.
`gather()` is already capped — `curate-docs/cli.mjs:172` `CAP = 60`, whose own comment
names the ~1,500-spawn figure, so it is O(1) not O(corpus). The refactor also could not
have worked: `git log --follow` hard-fails on more than one pathspec, so a batched pass
cannot preserve rename-following, and `--name-only` emits nothing for merge commits
without `-m`. The agent was killed mid-flight. **T2 is unblocked.**

**6 · Also folded in:** the corpus spans 16 git repos, so per-repo grouping needs 16
`buildLinkGraph` calls; and `report.mjs:50-62` orders ORPHAN/DETACHED *before*
declared-state, so most plans flag ORPHAN first.

**What this cost, and the general form.** Three separate instrument bugs were caught and
corrected while measuring this corpus — and none of that discipline asked whether the
*population* was the right one. Verifying **how** you counted is not verifying **what** you
counted. `rule:discernment-checks` §4 covers the first; this is the second, and it is
the more expensive half.

## Decisions from the engineering review

| # | Decision |
|---|---|
| D1 | Build `propagate plans --check` as its own lane (not a curate-docs predicate) |
| 1 | Reach it via **`await import()`** in cli.mjs's dispatch arm — never a top-level import |
| 2 | In-repo corpus classified through **`lib/report/doc-kind.mjs` KINDS**, never a second definition |
| 2b | **`--root <path>`, repeatable and general** — no directory special-cased by name |
| 3 | Live/finished from the **link graph**, `Status:` only as a refinement, with a documented precedence rule |
| 4 | Declare the **reverse edge** `GOALS.md → NORTH_STAR.md` |
| 5 | A bad `--root` **exits non-zero naming the path**; an empty-but-valid root is a different output |
| 6b | **Batch the evidence** — one `git log` pass per repo — and fix curate-docs' per-file helpers at source |

## The work, in dependency order

**1 · Batch the evidence reader in curate-docs (D6b).** `skills/curate-docs/lib/evidence.mjs`
asks git **per file** — `introducedBy` and `lastTouched` each spawn `isGitRepo` plus a
`git log`, so ~5 spawns per file, ~1,300 across the corpus. Replace with one
`git log --format=… --name-only` pass per repo, memoising `isGitRepo`. Both callers get
faster; there is one git reader, not two. Do this first — everything downstream consumes it.

**2 · `commands/plans.mjs` + `lib/report/plans.mjs`.** Split the same way
`commands/goals.mjs` / `lib/report/goals.mjs` already are: `lib/` derives, `commands/`
renders and never accumulates (`commands/ansi.mjs`'s house rule — no `lib/` module prints).

- **One `classifyPlan()` entry point.** The fork between doc-kind (in-repo) and
  path-based (external roots, where 0 of 54 carry frontmatter) lives in that one
  function, never scattered.
- **Report by class, never one number.** `live / finished / undeclared`, each with its
  own count, plus `unreadable` separately. G61 prescribes this for `bootstrap`'s residue
  and prior learning `count-ratchet-over-growing-population` is the reason: a raw count
  over a population that grows with authorship measures output, not debt.
- Reuse `lib/report/backlog.mjs`'s discovery walk (l.118-123) and
  `skills/curate-docs/lib/evidence.mjs`'s `declaredState` (l.132) — with the prebuilt
  graph, not `gather()`.

**3 · Declare two edges (D4).** `GOALS.md → NORTH_STAR.md`, and `.templates/PLAN.md → `
the new checker, so a required section added to the template without the check following
is caught by the tool itself.

**4 · Backfill the live plans only.** Author `Done when:` / `Derived by:` for plans the
checker reports as live. **Do not restate the count here — derive it** with
`node cli.mjs plans --check`; the "22" measured during scoping came from the `Status:`
scraper that D3 just replaced, and that instrument was wrong three times while I used it.

**Out of scope:** indexing `~/.claude/plans` into gbrain (separate, unrelated to the
checker now that `--root` reaches it); Phase 2b's 954 silent pairs; the 7 pre-existing
CI failures.

## What already exists — reuse, do not rebuild

| Exists | Where | Used for |
|---|---|---|
| Doc taxonomy / `KINDS` | `lib/report/doc-kind.mjs:39` | what counts as a plan (D2) |
| `plan` → `declared-state` staleness rule | `skills/curate-docs/lib/taxonomy.mjs:127` | precedent that age is the wrong axis for a plan |
| `declaredState()` | `skills/curate-docs/lib/evidence.mjs:132` | live / archived / undeclared (D3) |
| `NO-STATE` verdict flag | `skills/curate-docs/lib/report.mjs:59` | the shape to copy for a `NO-GOAL` flag |
| Three-state `Done when:` parse | `lib/report/goals.mjs` | open / closed / unknown |
| Discovery walk | `lib/report/backlog.mjs:118-123` | finding the corpus |
| `commands/goals.mjs` split | `commands/` renders, `lib/` derives | the module shape to mirror |

**Not reused, deliberately:** `gather()` — it bundles git-spawning helpers this lane does
not need. D6b replaces its per-file pattern rather than routing around it.

## Verification

```bash
npm test                        # NEVER bare `node --test` — G56 writes the PRODUCTION ledger
node cli.mjs plans --check      # population split, not one number
node cli.mjs goals              # unchanged by 1-3; changes only after 4
node cli.mjs release --check    # four manifests agree
```

- **The checker must fail on its own corpus first.** Run it before fixing any plan; a
  clean report on a tree with `0 of 200` arrival conditions is broken, not passing
  (`rule:discernment-checks` §1).
- **Three outputs, never conflated:** `no roots` ≠ `roots scanned, no plans` ≠
  `plans found, none flagged`. Slice the report section before asserting — prior learning
  `doctor-section-assertions-need-section-slicing` (9/10): doctor's sections share
  near-identical absence wording, so a full-output assertion passes regardless.
- **The lazy-import guard is a real test.** Assert `cli.mjs` has no top-level import of
  `plans.mjs`; mutate it to an eager import and the test must go red. Nothing else can
  catch that regression — it is invisible to `npm test` and to any output diff.
- **Mutation gate:** delete a required section from a fixture plan and confirm the checker
  names *that section*, not just a count.

## Test coverage — 17 paths, all new

```
CODE PATHS                                              CLASSIFICATION
[+] commands/plans.mjs · plansCmd()                     [+] classifyPlan()  (single entry point)
  ├── arg parse: --check / --root* / --json               ├── [GAP] in-repo  → doc-kind KINDS says "plan"
  │   ├── [GAP] no --root → SEARCH_ROOTS default          ├── [GAP] in-repo  → doc-kind says NOT plan → skipped
  │   └── [GAP] --root repeated → both walked             └── [GAP] external → path-based (0/54 frontmatter)
  ├── root validation  (exit non-zero)
  │   ├── [GAP] nonexistent  → exit≠0, names the path   [+] LIVE / FINISHED
  │   ├── [GAP] not a directory → exit≠0                  ├── [GAP] hub-linked            → live
  │   ├── [GAP] unreadable   → exit≠0                     ├── [GAP] under archive/        → finished
  │   └── [GAP] exists+empty → exit 0, "scanned,          ├── [GAP] neither               → undeclared
  │              none found"  ← MUST differ from above    └── [GAP] PRECEDENCE: hub-linked + Status: shipped
  ├── per-plan grade
  │   ├── [GAP] Done when: + Derived by:  → conforms     [+] EVIDENCE  (batched, D6b)
  │   ├── [GAP] neither                   → flagged       ├── [GAP] one git log pass per repo
  │   ├── [GAP] Done when:, no Derived by → partial       ├── [GAP] isGitRepo memoised
  │   └── [GAP] unreadable file → attributable, not 0     └── [GAP] repo with no git → degrades, not throws
  └── [GAP] reached via await import()
            ← assert cli.mjs has NO top-level import of plans.mjs

COVERAGE: 0/17 paths tested (0%)  |  all new code  |  GAPS: 17 (0 E2E, 0 eval)
```

No regressions — all new code, so the regression rule does not fire.

## Failure modes

| Codepath | Realistic production failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| root validation | typo'd `--root` reports 0 findings as success | planned | D5: exit non-zero | **would be silent without D5** |
| batched git reader | repo with no git history → empty map read as "never touched" | planned | must degrade to mtime, as `lastTouched` already does | **critical if unhandled** |
| `classifyPlan` | doc-kind mis-kinds a plan → silently ungraded | planned | report skipped-by-kind count | **yes — needs the count** |
| precedence rule | hub-linked + `Status: shipped` → class flips between runs | planned | documented rule, asserted | no |
| lazy import | eager import taxes every `status` | planned | n/a | **yes — invisible to tests without the guard** |

**Two critical gaps** if the plan is implemented without their stated handling: the
batched git reader degrading to "never touched" on a git-less repo, and `classifyPlan`
silently dropping files doc-kind did not recognise. Both must report a count, never a zero.

## Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| 1 · batch evidence | `skills/curate-docs/lib/` | — |
| 2 · plans lane | `commands/`, `lib/report/`, `cli.mjs`, `tests/` | 1 |
| 3 · declare edges | `.propagates.yml` (hub) | — |
| 4 · backfill | `**/docs/plans/*.md` | 2 |

```
Lane A: step 1 → step 2 → step 4   (sequential — 2 consumes 1, 4 consumes 2)
Lane B: step 3                      (independent — sidecar only)
```

Launch A and B in parallel. No shared module directories, so no conflict flag.

## Implementation Tasks

- [ ] **T1 (P1, human: ~3h / CC: ~40min)** — curate-docs — batch the evidence reader
  - Surfaced by: Performance §Issue 6b — ~5 git spawns per file, ~1,300 across the corpus
  - Files: `skills/curate-docs/lib/evidence.mjs`, its tests
  - Verify: spawn-count assertion, not a duration assertion (a timing test gets deleted the first time CI hiccups)
- [ ] **T2 (P1, human: ~2h / CC: ~25min)** — plans lane — `commands/plans.mjs` + `lib/report/plans.mjs`
  - Surfaced by: Architecture §Issue 2 — corpus definition must come from doc-kind
  - Files: `commands/plans.mjs`, `lib/report/plans.mjs`, `cli.mjs` dispatch
  - Verify: `node cli.mjs plans --check` prints the class split
- [ ] **T3 (P1, human: ~20min / CC: ~5min)** — cli.mjs — lazy-import guard
  - Surfaced by: Architecture §Issue 1 + prior learning `extracting-cli-code-can-make-lazy-imports-eager`
  - Files: `cli.mjs`, `tests/unit/plans-lazy-import.test.mjs`
  - Verify: mutate to eager import, test goes red
- [ ] **T4 (P2, human: ~30min / CC: ~8min)** — plans lane — root validation, three-state
  - Surfaced by: Code quality §Issue 5
  - Files: `commands/plans.mjs`, `tests/cli/plans-roots.test.mjs`
  - Verify: nonexistent root exits non-zero; empty-but-valid root exits 0 with different wording
- [ ] **T5 (P2, human: ~20min / CC: ~5min)** — hub sidecar — declare two edges
  - Surfaced by: Architecture §Issue 4
  - Files: `~/Documents/GitHub/.propagates.yml`
  - Verify: edit `GOALS.md`, `check --changed` names `NORTH_STAR.md`
- [ ] **T6 (P3, human: ~3h / CC: ~30min)** — backfill live plans
  - Surfaced by: Context — 0 of 200 carry an arrival condition
  - Files: the plans `plans --check` reports as live
  - Verify: re-run `plans --check`; the live-without-goal count falls
- [ ] **T7 (P2, human: ~20min / CC: ~5min)** — GOTCHAS.md — the BSD `sed` `\s` hazard
  - Surfaced by: TODO 1 — three instrument flaws while sizing the corpus, this the most repeatable
  - Files: `propagation/state/workspace/GOTCHAS.md`
  - Verify: `--selftest` proves the entry's `**Trigger:**` fires on its `**Fires on:**` literal.
    An entry whose regex cannot be shown to fire is a hazard documented and not delivered.
  - Scope: the `\s` one only. `\s` works in `grep -E`, perl, node and GNU sed, so BSD sed is
    the surprising case. The `awk`-matched-`$0` and space-in-path flaws are generic and belong
    to `rule:discernment-checks` §4, not restated here.
- [ ] **T8 (P2, human: ~30min / CC: ~8min)** — gbrain — index `~/.claude/plans`
  - Surfaced by: TODO 2 — all 25 gbrain sources sit inside `~/Documents/GitHub`, so 54 session
    plans including this week's are unsearchable
  - Files: gbrain source registration; no repo code
  - **Carry the concern that was raised and overridden:** session plans are scratch with no
    `archive/` convention, so an abandoned or explicitly rejected plan can surface as current.
    Decide how a dead session plan is marked *before* the first search relies on this index —
    a hit that reads as live when it was rejected is worse than no hit.
  - Verify: `gbrain search` returns a known session-plan headline. Note this worktree is not
    pinned (`/sync-gbrain --full`), so search falls back to Grep here until it is.

## NOT in scope

| Deferred | Why |
|---|---|
| Generating goal stubs from the 199 plan headlines | A headline is an intention; a goal needs an arrival condition. `0 of 200` carry one, so the machine would fabricate the judgment half |
| Closing N35 | `claims restate`'s corpus and the unexercised-rule set are disjoint by construction — no work in this lane can reach it |
| Phase 2b (954 silent restatement pairs) | Filed, independent of this plan |
| The 7 pre-existing CI failures | Env-sensitive, fail on ubuntu runners only, predate this branch |
| N72 — the heading-anchor pairing gap | Filed in PR #17, unrelated to plans |
| A `NO-GOAL` flag inside curate-docs' `verdict()` | Considered as the minimal alternative (D1); rejected in favour of a native propagate lane since propagate owns the taxonomy |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | `codex`, plan-review phase | Independent 2nd opinion | 1 | disabled | not run — `codex_reviews disabled` |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 6 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** provider `codex`, phase `plan-review`, status **disabled** — the user
has `codex_reviews disabled`, so no outside process ran and no subagent fallback was
dispatched (disabled is a terminal branch, not a provider failure). This plan carries no
outside-model coverage; re-enable with `gstack-config set codex_reviews enabled`.

**VERDICT:** ENG CLEARED — ready to implement. CEO, Design and DX reviews not run and not
required for an internal tooling change with no user-facing surface.

Two premises I asserted during this review were wrong and were corrected in-flight, both
of the shape `rule:discernment-checks` §7 names — a wrong premise inside a question gets
ratified rather than corrected:

- I claimed `rule:state-and-decisions:22` excluded gstack artifacts from checking. It does
  not; that line governs **precedence**, not eligibility. Corrected, and `--root` was
  generalised as a result.
- I framed Issue 6 as fast-without-evidence vs slow-with-evidence. That was a false
  dichotomy — the cost is the per-file spawn pattern, not the evidence. Reopened as 6b.

NO UNRESOLVED DECISIONS
