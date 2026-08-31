> **ABANDONED 2026-08-29, same day it was written.** Its premise was that compacting
> decision ledgers would reclaim session context. Measured: `DECISIONS.md` **never**
> auto-loads — 11,475 lines across 33 real ledgers cost a session **0 bytes**. The
> context was going to `rules/` instead (~211,600 B/session, 16 rule bodies duplicated).
> See the 2026-08-29 decision `.claude/rules/ is native`.
>
> Kept, not deleted, because the adversarial review of it stands on its own: 12 confirmed
> findings, including that the proposed parser fix would have SILENTLY DROPPED 4 entries
> in the very file it was written to fix, and that 20 of propagate own 36 decision
> entries are identified by file POSITION. Both outlive the plan.

---

# `propagate decisions` — a derived compact view of the decision history

**Status:** DESIGN, not approved for implementation.
**Date:** 2026-08-29
**Supersedes:** nothing.
**Affects:** propagate

---

## 1 · The problem, and the number that is not the problem

The tree holds 53 `DECISIONS.md`. Reading one to answer *"why is it like this?"* costs up to
2,100 lines. The ask was a mechanism to **compress the decision ledger by compacting trivial
decisions**, plus a definition of trivial.

### 1.1 · What was measured

Measured 2026-08-29 by a node walk of `~/Documents/GitHub` (depth 6, excluding
`node_modules`, `.git`, `.worktrees`, `_archive`). Not `grep` — `rule:gotchas-global` G-A: the
shim honours `--ignore-files` and the hub `.gitignore` is `/*`, which silently drops whole
workspaces.

| Measure | Value |
|---|---|
| `DECISIONS.md` files | 53 |
| …of which pointer stubs (`# DECISIONS.md — moved`) | **25**, holding 371 lines |
| Real ledgers | **28**, holding **11,375 lines** |
| Entries, tolerant parse | **537** |
| Entries, propagate's shipped `parseDecisions` | **502** |
| Entries carrying `Supersedes:` | **16** |
| Entries that are a bullet list with no `What:`/`Why:` label | **109 (20%)** |
| Two largest ledgers | `ManavDaehi/…/Manav-portfolio` 2,100 · `Vipin Kaushik/…/workspace` 2,066 — 35% of the corpus |

**These numbers are a snapshot and will rot.** Per `rule:state-and-decisions`, the deliverable
must name the command that derives them. `propagate decisions --triage` is that command; the
table above exists to justify the design, not to be trusted later.

### 1.2 · Line count is not triviality — the metric that was rejected

The first instinct is to sort entries by length and compact the short ones. **That is
backwards, and the corpus says so.**

- `Vipin Kaushik/…/sanskrit-texts/DECISIONS.md` has a median entry of 8 lines. Those entries
  are full `What:` / `Why:` / `Status:` / `Affects:` records carrying real counts
  (`331 Hora + 28 Samhita files`, `3867→3932`). They are the densest writing in the tree.
- `propagate/propagation/state/workspace/DECISIONS.md` has a median of 45 lines and **no entry
  under 24 lines**.

Sorting by length would compact the best-written files and exempt the worst. This is
`rule:discernment-checks` §4 in its plainest form: the instrument answers a narrower question
(*how long is this?*) than the one asked (*does this still bind anything?*).

### 1.3 · Three findings that constrain the design

**F1 — 35 entries / 1,142 lines are invisible to the shipped parser.**
`lib/report/decisions.mjs:12` is `/^##\s+(\d{4}-\d{2}-\d{2})\b.*$/` — the date must follow `##`
immediately. Three ledgers use an id-first form and therefore report **0 entries**:

| file | lines | headings | parsed |
|---|---|---|---|
| `Keerti/propagation/state/keerti-job-radar/DECISIONS.md` | 799 | 30 | **0** |
| `Divyansh/propagation/state/workspace/DECISIONS.md` | 247 | 8 | **0** |
| `Keerti/propagation/state/workspace/DECISIONS.md` | 96 | 5 | **0** |

`0 entries` in a 799-line file is not a measurement. It is a reader that failed and could not
say so — `rule:discernment-checks` §6. Any classifier built on this parser would report those
three ledgers as already clean.

**F2 — entry identity is `<date>:sha8(affectsRaw)`**, computed at `lib/report/decisions.mjs:74`,
and `lib/core/state.mjs`'s `crossDecisions` map keys the cross-repo relay off it. The title is
excluded from the key on purpose (G4). Therefore:

- rewriting a **title** is free;
- rewriting the **`Affects:` line** re-keys the entry, and the relay fires a row for a decision
  nobody re-made.

**F3 — the mechanism already anticipates archived decisions.**
`pruneCrossDecisions` (`lib/core/state.mjs:120`) keeps a non-live key for 400 days precisely so
that "an archived-then-restored entry" does not re-fire. Removing whole entries was designed
for before it was asked for.

---

## 2 · The definition of trivial

**Compress the What, keep the Why.**

*What we did* is re-derivable from git. *Why we chose it over the alternative* is not.
`rules/conventions/CONTEXT-BUDGET.md` already settled the same question for `GOTCHAS.md`: a
retired mechanism's reasoning still justifies the code that replaced it, so age-based rotation
would discard the argument for current code. The same holds here. **No compression path may
delete a `Why:`.**

### 2.1 · Five classes

| class | test | who decides |
|---|---|---|
| `binding` | **the default for anything unproven** | — |
| `status` (T1) | no `What:`/`Why:` labels, body is a bullet list, and no counterfactual marker (`instead of`, `rather than`, `not X`, `over`, `rejected`) | heuristic **proposes**, human/LLM disposes |
| `superseded` (T2) | a later entry names it in `Supersedes:`, **or** shares ≥1 `Affects:` token and its title contains supersedes / replaces / reverses | heuristic **proposes** |
| `subject-gone` (T3) | every `Refs:` path resolves neither in the worktree nor in `git log --all --diff-filter=A`, **and** every `Affects:` token resolves to no live project | fully mechanical |
| `one-shot` (T4) | decided to *do* a thing once, not to *hold* an invariant | never mechanical |
| `unclassified` | nothing has decided | — |

**T3 requires both halves.** A decision whose refs merely moved is not a decision that stopped
binding; a decision whose `Affects:` names a dead project may still constrain a live one
through its refs. Either half alone is a false positive generator.

**`binding` is the default, deliberately.** The bias is inverted from the usual classifier: an
unclassified decision costs a few lines of output, a wrongly-compacted one costs the reason a
piece of code exists.

### 2.2 · What T1 actually found

T1 is a **misfiling** finding more than a compression one. 109 of 537 entries record what
happened rather than what was chosen — e.g. `## 2026-03-04: Iconography reference created`,
`## 2026-03-13: Sky engineering spec produced`. These are `STATE.md` "Completed" rows filed in
the wrong register. The report says so rather than proposing deletion.

---

## 3 · Architecture

`propagate decisions` is **read-only**. It never writes a `DECISIONS.md`, never moves an entry,
never calls a model. It joins the existing read-only report family (`registers`, `backlog`,
`docs`, `caps`).

```
cli.mjs                          dispatch + usage line
commands/decisions.mjs      NEW  rendering: --brief / --triage / --json
lib/report/decisions.mjs         EXTEND: heading forms, unreadable reporting
lib/report/decisions-triage.mjs  NEW  classification join + T1–T3 heuristics
lib/report/doctor/decisions.mjs  EXTEND: unreadable = FAIL; unclassified/stale = info
propagation/state/<scope>/DECISIONS.triage.yml   NEW artifact (committed)
```

### 3.1 · Parser (`lib/report/decisions.mjs`)

Widen `HEADING` to accept an optional id prefix, covering all four forms present in the tree:

```
## 2026-08-10: title              works today
## 2026-08-20 — title             works today
## D1 · 2026-08-15 · title        3 files, 1,142 lines, currently invisible
## D12 — 2026-08-16 — title
```

The date remains captured by regex, not by position — that property already exists and must be
preserved.

Add `readFailure` reporting. A file with **≥1 `^#{2,3}\s` heading and 0 parsed entries** is
returned as `{ unreadable: true, headings: N, parsed: 0 }`, never as an empty entry list.
`decisionsAttributionReport` gains the same distinction so that `doctor` can fail on it.

### 3.2 · Triage artifact (`DECISIONS.triage.yml`)

Sits beside the ledger it describes, following the `.sidecar.yml` precedent.

```yaml
version: 1
entries:
  "2026-03-04:a1b2c3d4":
    class: status
    why: "records that an icon set was produced; names no rejected alternative"
    body_sha: 7f3a91c2
    by: opus-5
    at: 2026-08-29
```

Keyed by the **same** `<date>:sha8(affectsRaw)` key `crossDecisions` uses (F2), so the triage
file and the relay state agree on entry identity without either knowing the other exists.

`body_sha` is sha8 of the entry body at the moment of classification. Three consequences:

1. Edit an entry body → its verdict reads `stale-classification`, never a stale verdict
   silently applied to changed text.
2. Edit `Affects:` → the entry re-keys, and the old verdict no longer matches any entry. It is
   reported as an **orphan verdict**, and the entry becomes `unclassified`. Both facts are
   printed; neither is silently dropped.
3. The report is a **pure function of (ledger, triage file)**. Same inputs, byte-identical
   output, forever.

### 3.3 · Where the LLM sits, and where it does not

The classifier for T1 and T4 is semantic. It runs **once, at authoring time**, outside the
deterministic read path:

```
propagate decisions --propose <scope>
  → writes DECISIONS.triage.proposed.yml
  → a human (or the model that wrote it) reviews `git diff`
  → rename to DECISIONS.triage.yml, commit
```

The command **never** writes `DECISIONS.triage.yml` directly, and the reporting path **never**
calls a model. Non-determinism is confined to a git-reviewable artifact; the tool that reads it
is reproducible.

This is a memoized judgment cache with `body_sha` as its invalidation key.

### 3.4 · Output

**`--brief`** — the compact view.

- `binding` entries: date, title, and full `Why:`.
- every other class: one line under a class heading, with a count.
- `unclassified`: printed **in full**. The failure mode must be "too much", never "silently
  gone".
- Footer, mirroring `cli.mjs:3803`'s no-silent-caps line:
  `N of M entries listed, K compacted, 0 dropped` — plus `U unreadable file(s)` when any.

**`--triage`** — counts per class per file, and the unclassified work-list that feeds §3.3.

**`--json`** — machine shape, consumed by the doctor section.

**`doctor` `# Decisions`** — unreadable files **FAIL**; unclassified, stale and orphan-verdict
counts are `info`. The existing `# DECISIONS.md attribution` section stays as it is; per its own
header the `withTokens == entries` verdict is owned solely by `lib/report/metrics.mjs` so there
is one mechanism, not two that can disagree. This section must not re-vote on it.

---

## 4 · Testing

Every check ships with the input that makes it fail (`rule:discernment-checks` §1), and each
mutation is asserted to have actually applied.

| # | Test | The failure it catches |
|---|---|---|
| 1 | One fixture per accepted heading form; each parses to exactly 1 entry | F1 regression |
| 2 | **Negative fixture** in a form we deliberately do not accept → asserts `unreadable`, not `0 entries` | the §6 reader-failure class |
| 3 | Run the report twice over identical inputs; assert byte-identical stdout | non-determinism leaking into the read path |
| 4 | Mutate an entry body; assert its verdict flips to `stale-classification` | a stale verdict applied to changed text |
| 5 | Rewrite a title; assert the key is unchanged. Rewrite `Affects:`; assert the key changes, the entry is `unclassified`, and the old verdict is reported as orphaned | F2 — silent relay desync |
| 6 | Assert `listed + compacted == total` for every scope | silent truncation |
| 7 | Point the reporter at a directory with no ledgers; assert it says so rather than printing a clean report | `rule:enforcement-watches-itself` — "found nothing" ≠ "looked at nothing" |
| 8 | Mutate the widened `HEADING` regex and confirm tests 1 and 2 go red **for the stated reason** | a check that cannot fail |

There is **no `--apply`** in this design, so `rule:safety-flag-needs-a-test` has no unsafe path
to gate here. If a writer is ever added, that rule applies in full and the test must snapshot
the ledger bytes, not the tool's own description of itself.

---

## 5 · Scope of the first landing

| Piece | Scope | Why |
|---|---|---|
| Parser widening + unreadable reporting | **tree-wide** | read-only, and F1 must close before anything reads these files to make a compression decision |
| Triage artifacts | **propagate's own two ledgers only** — `propagation/state/workspace` (24 entries), `propagation/state/curate-docs` (12) | `rule:enforcement-watches-itself`: point the check at its own toolchain first. `lib/report/doctor/decisions.mjs` already scopes itself to propagate's own ledger |
| The other 26 ledgers | **not in this landing** | recorded here so the absence is attributable, not forgotten |

---

## 6 · What this does NOT buy, stated plainly

**Zero session-context savings.** Per `rules/conventions/CONTEXT-BUDGET.md`'s 2026-08-28
measurement, `DECISIONS.md` never auto-loads; the tree injects 1,631 lines per session and none
of them come from a decision ledger. Compressing these files reclaims no budget that was being
spent.

What it does buy:

1. *"Why is it like this?"* becomes answerable in ~40 lines instead of 2,100.
2. The 20% of the history that is misfiled status becomes visible as such.
3. Three ledgers stop being invisible to propagate's own tooling.

**It also does not shrink the files on disk.** That was the rotation option, and it was
considered and not taken — see §7.

---

## 7 · Alternatives considered and rejected

| Option | Why not |
|---|---|
| **Rotate entries to `archive/DECISIONS-YYYY-MM.md` with a one-line stub** | This is the policy `CONTEXT-BUDGET.md` already prescribes for every other register kind, and it genuinely shrinks the file. Rejected for the first landing because it mutates an append-only artifact, and because a derived view answers the actual question (*what still binds?*) without the risk. Remains the obvious second landing |
| **Collapse entry bodies in place** | ~50% on-disk shrink, but edits append-only history, and the deleted `What:` is recoverable only from git. `DECISIONS.md`'s own header forbids editing past entries |
| **Mechanical classification only (T2 + T3)** | Fully deterministic and safe, but leaves the 109 status-filed-as-decision entries — the bulk of the problem — untouched |
| **Live LLM call in the read path** | Makes a deterministic tool non-reproducible, and a wrong call silently buries a decision. §3.3 keeps the judgment and confines the non-determinism to a reviewable artifact |
| **Sort by entry length** | §1.2. Compacts the best files, exempts the worst |

---

## 8 · Open questions

1. **Does `--propose` belong in the CLI at all**, or is it a skill? The CLI is deterministic by
   construction everywhere else, and a subcommand that shells out to a model is a new posture
   for this tool even when it only writes a `.proposed.yml`.
2. **T2's weak form** (Affects-overlap plus a title verb) has an unmeasured false-positive rate.
   It should be measured against propagate's own 36 entries before it is trusted anywhere else.
3. **Nothing yet reads `--brief`.** Per `rule:enforcement-watches-itself`, a capability nobody
   invokes is indistinguishable from one never built. The caller should be named before landing.
