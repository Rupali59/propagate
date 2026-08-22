> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# Propagate — specification

What the skill is, what it guarantees, and how each guarantee is checked. Derived from
[`ISSUES.md`](./ISSUES.md); constrained by [`DECISIONS.md`](./DECISIONS.md).

Status: **target spec.** Reconciliation against the current implementation is a separate pass.

---

## 1. Purpose

<!-- premise:start -->
> **propagate coordinates parallel work.** Work proceeds in parallel — across
> branches and worktrees inside a repo, and across repos in the workspace — and
> parallel streams lose sight of each other. propagate declares the couplings that
> matter, watches them, and keeps an append-only ledger tied to git workflow, so
> every stream can see what moved, where, and on which branch. It never edits a
> downstream; it tells a human.
<!-- premise:end -->

`SKILL.md` is canonical for this premise; the block above is a verbatim quote.

**Evidence the premise is right:**

| Feature | Read as "staleness" | Read as "parallel coordination" |
|---|---|---|
| `correlation_id`, `source_worktree` | edge case | core — one logical change on two branches |
| SPEC I5, "ids must survive branches and merges" | an invariant | the premise restated |
| §5's measurement: 17 of 19 open rows cross a repo | limits auto-close | confirms cross-repo *is* the workload |
| the cross-repo layer | §8 "dormant" | the point |

**Non-goals**, all previously decided:
- Not type-safe contracts. The pattern is "watch for changes, prompt the human"
  (`cross-project-capture-2026-06-09`).
- Not auto-authoring. Sidecars are author-curated; the skill never invents an edge.
- Not a spec mirror. Declaring every doc floods the ledger; edges are for couplings where drift is
  silent and expensive.
- Not a UI. Cut on evidence 2026-08-10 — the precedent queue UI took 11 days and zero writes.

---

## 2. Invariants

### I1 · No silent no-op
**The** invariant. Eleven S1 issues are instances of it. Every one of these must produce a visible,
attributable signal:

| Event | Required signal |
|---|---|
| Sidecar rejected by schema | `doctor` failure naming file + offending field |
| Row type unrecognised on read | counted, surfaced to caller, `doctor` failure |
| `status_change` for an unknown id | **throw** at write time |
| Edge declared but unenforceable (glob `kind: code`) | listed as *unenforced*, not merely logged |
| Discovery finds zero workspaces | `doctor` failure, never a healthy pass |
| Subprocess fails (`git`, `launchctl`) | logged with stderr; fallback allowed, silence is not |
| Downstream that existed last run is now missing | **break**, distinct from declare-ahead |

*Checked by:* a `doctor` assertion per row. A spec rule that cannot be detected is the failure mode
this document exists to leave behind.

### I2 · Append-only, never rewrite
The ledger is an audit trail. Status changes append; rows are never mutated or deleted. Migration of
misfiled rows is **close-and-re-emit only** (`DECISIONS.md` 2026-08-10) — in-place rewrite is
forbidden because ids are file-local, `source` is workspace-relative, and a half-applied migration is
invisible under I1's absence.

### I3 · One detection trigger
mtime, via launchd `WatchPaths` + `StartInterval`. Git is an **evidence** source (§5), not a second
trigger. This preserves `DECISIONS.md` 2026-07-13 ("the mtime watcher is reused; the filter is a
file allowlist, not a new trigger") and is stated explicitly so §5 is not read as reversing it.

### I4 · The alarm must not depend on the thing it watches
Rendering the MD unconditionally ticks its mtime, which re-triggers launchd — the B0 feedback loop.
Rendering only on new events froze a staleness banner reading "Watcher healthy" for four weeks.
Resolution, already shipped: compare the body **excluding the generated footer**, so a silent ledger
rewrites exactly once per day when the day counter increments.

*Any* future writer to a watched path inherits this constraint.

### I5 · Ids must survive branches and merges
Two branches appending from the same max both mint the same id; `readLedger`'s id-keyed map then
collapses them last-line-wins. Ids must be independent of file position.

---

## 3. Detection

**Trigger:** mtime advance on a declared source, with a 3-second re-verify guarding against reading a
partially-written file mid atomic-replace.

**Scope:** files declared in a `.propagates.yml` under a discovered workspace, plus `kind: code`
downstreams in the reverse direction, plus `.code-canonical.yml` pairs.

**Not detected, and the spec says so plainly:** anything undeclared. The ledger's silence about an
undeclared file carries no information. §6's coverage command exists because that distinction was
repeatedly mistaken for evidence.

---

## 4. Data model

### Row

```
{
  id            ULID                    -- not sequential; see I5
  type          drift | code_drift | status_change | manual
  timestamp     ISO-8601
  source        workspace-relative path
  change        one-line summary
  downstream    [{ path, why, kind: prose|code, worktree? }]
  status        open | partial | done | wontfix
  notes         string
  git           { sha, branch, dirty }  -- NEW, see below
  closed_by     string                  -- who/what closed it
  correlation_id  <repo>:<repo-rel-path>
}
```

**`git` is new and is the precondition for §5.** Today 3 of 664 rows carry any git field, and that
field (`source_worktree`) is set only for *secondary* worktrees and records HEAD-at-scan-time — the
commit before the edit, not the commit containing it. The spec requires `{sha, branch, dirty}`
stamped on **every** row at fire time, canonical checkouts included.

**Undeclared fields already on disk** must be added to the typedef or removed: `wontfix_reason`
(556 rows), `closed_by`, `note` (singular — distinct from `notes`), and the cross-repo quartet
`flow`/`direction`/`origin_repo`/`partner`. None are written by this codebase; they came from
outside. A model that doesn't describe its own data cannot be validated.

**`manual` becomes a first-class type.** One such row has been invisible since 2026-06-20 and caused
a live id collision. Either the reader accepts it or the writer must be prevented from creating it —
silently dropping it is not an option under I1.

---

## 5. Lifecycle: fire → answer → close

### The empirical result, first

The proposal was: a row is *answered* when a commit touches the source and a downstream together.
Tested against the 19 open rows in the Vipin Kaushik ledger on 2026-08-13:

| | count |
|---|---|
| Open rows tested | 19 |
| **Intra-repo** (source + downstream in one git repo) | **2** |
| **Cross-repo** (span two repos — a single commit is impossible) | **17** |
| Would be *proposed* for close under the weaker cross-repo rule | **4** |
| No evidence either side was touched since firing | **15** |

**Single-commit co-occurrence can answer at most 2 of 19 rows.** 89% of edges cross a repo boundary,
where the source and downstream live in different histories and can never share a commit.

And the more important number: **15 of 19 open rows have had neither side touched since they fired.**
The backlog is not stale bookkeeping. It is real, unaddressed work, accurately reported.

So auto-close is a modest hygiene win, **not** the fix for the open-row count. This spec records that
rather than shipping the theory it started with.

### The rule, as it must actually be specified

**Strong evidence — intra-repo.** One commit after `row.git.sha` touches the source *and* ≥1
declared downstream. Auto-close, `closed_by: "commit-evidence"`, record the SHA.
`git log --format=%H --name-only <sha>..HEAD`.

**Weak evidence — cross-repo.** Commits in each repo, after the row fired, touched both sides
independently. This is correlation, not causation — two unrelated commits satisfy it. Therefore
**propose, never auto-close**: surface in the drain queue as *likely answered*, with both SHAs, for a
human to confirm.

**No evidence.** Row stays open. Expected to be the majority.

### Close paths
Every close records `closed_by`. Three are legitimate:
`commit-evidence` (strong only) · `drain` (human, via the interface §6 must provide) ·
`wontfix` (human, requires `wontfix_reason`).

~~There is currently **no supported close path at all** — `markStatus` has no production callers, and
all 1,460 rows' transitions were written from outside the skill.~~ **CLOSED — verified 2026-08-22.**
§6 was built. `drain` (`cli.mjs:5106`) calls `markStatus` (`cli.mjs:3150`) and then **re-reads the
ledger to confirm the row actually left `open`**, treating "did not throw" as insufficient
evidence — the I1 no-silent-no-op rule. 9 tests in `tests/cli/drain.test.mjs`.

This paragraph stood after the hole was closed, and a 2026-08-13 learning
(`propagate-no-close-path`, confidence 9) still asserted the same thing on 2026-08-22 — enough
to nearly justify building a second close path beside the working one. A stale claim about
missing code is more expensive than a missing claim: it invites duplication.

---

## 6. Interfaces

**`watcher`** — invoked per launchd event. Fires rows. Must use `appendRowWithId` (atomic
mint+append) rather than `nextId` + `appendRow`, which is check-then-act racy.

**`cli status`** — open rows for the current workspace. On zero matches for a queried path, must
distinguish *no drift* from *not declared*.

**`cli doctor`** — the safety net. Every I1 row above is an assertion here. Adds:
- **coverage** — per repo: sidecar present? sources declared? docs-tree files named nowhere?
  VipinKaushik ran with zero sidecars while every sibling had one, and nothing said so.
- the resolved launchd label, the resolved ledger path, and the branch it evaluated against.

**`cli check`** — commit-time gate. Read-only, hook-safe, already correct in shape. Must fix: argv
interpolated into `execSync` (injection, `cli.mjs:923`), `--changed` never parsed, and add `--json`.
Then install it as the pre-push hook `SKILL.md` already documents but nothing creates.

**`cli drain`** — *new, and required.* The supported close path. Presents open rows, applies
`markStatus`, records `closed_by`. Must support batch close with a shared reason: the real workload
is demonstrably bulk (269 wontfix rows across 38 distinct seconds, 66 in one second), and pretending
it is per-row is what pushed people to write the ledger by hand.

**`cli init`** — scaffold a marker. Must **not** re-arm launchd as a side effect; that belongs in a
separate `reload`.

---

## 7. Concurrency, discovery, migration

**Locking** is `proper-lockfile`: advisory, single-host, filesystem-based. It gives no protection
across machines or branches. I5 exists because locking cannot solve the branch case.

**Discovery** walks `SEARCH_ROOTS` (env-overridable since `3c4eb65`) for `.propagates.yml`. A marker
is an **edge sidecar**; it becomes a **ledger-owning workspace root** only with explicit
`workspace: true`. Conflating the two orphaned 5 of 8 ledgers — and the obvious fix (recurse past the
marker) is worse, minting empty ledgers beside real ones. Schema must ship **before** any marker
gains a field, or `additionalProperties: false` silently stops that sidecar.

**Migration** of the 1,460 existing rows:
- ids stay as-is (strings); only new rows get ULIDs
- the deferred 69 hub rows: close-and-re-emit with a manifest and rollback, never rewrite
- `git` field is absent on all existing rows; §5's rule simply cannot apply to them, and must say so
  rather than guessing

---

## 8. What this spec does not solve

### 8a. Standing limitations

- **The open-row backlog.** §5 measured it: 15 of 19 are genuine undone work. No mechanism here
  reduces that number honestly; only doing the work does.
- **Graph integration.** `concepts:` remains schema-accepted and unused (TM-064).
- **Linux/remote.** launchd-only.
- **The cross-repo layer.** 20 commits, 90 tests, 10 rows, silent since 2026-07-13. Under the
  staleness reading this looked like a dormant subsystem of unclear value. Under the 2026-08-13
  premise (§1) it is not peripheral — cross-repo coordination is the point, and §5's own measurement
  (17 of 19 open rows cross a repo boundary) is the evidence. It has still been silent since
  2026-07-13; that fact is not softened by the reframing. What changes is the default recorded in
  8b.3 below: ships, not dies, pending the open call.

### 8b. Raised by the 2026-08-13 premise change

These are unresolved. Recorded honestly rather than answered quietly.

1. **Detection trigger.** I3 fixes detection to mtime only and explicitly demotes git to "an
   evidence source, not a second trigger" (§3, §5). But a git-workflow ledgering system, which is
   what §1 now says this is, wants branch/commit/merge as first-class coordination signals, not
   just post-hoc evidence. Either I3 gets an explicit recorded supersede, or the premise means
   "git-informed, mtime-triggered" and the docs should say so plainly. Not both quietly — that is
   the exact silent-disagreement failure this plan exists to remove.
2. **What a row is keyed to.** If parallel streams are first-class, a row arguably belongs to a
   `(coupling, branch)` pair rather than to a file alone — the same source/downstream pair can be
   independently in-flight on two branches at once, and today's schema (§4) has no place to say so
   without overloading `source_worktree`. This is a §4 data-model change. Named and sized here,
   deliberately deferred — not undertaken in this pass.
3. **Whether the cross-repo layer ships or dies.** Still correctly a decision, not a defect (8a).
   Under the staleness reading the default was *dies by neglect* — a silent subsystem nobody had
   evaluated. Under the parallel-coordination premise the default flips to *ships*, since it is the
   direct mechanism for the workload §5 measured as the majority case. The call is still open; this
   records that the default flipped, not that the call was made.

---

## 9. Reconciliation

Not done in this pass, by design. The next step compares each section against the implementation and
produces a delta with a shipping order. `ISSUES.md` §"Suggested order" is the starting hypothesis:
N10 (wrong launchd label, already shipped into a plugin), G1 (injection), C1 (coverage), N1+N4
(integrity and a real close path), N2+N3 (id integrity), N5 (dedup `code_drift`).
