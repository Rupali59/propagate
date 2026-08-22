# STATE — curate-docs

What is true now. Why past choices were made: `docs/DECISIONS.md`. What will bite you:
`docs/GOTCHAS.md`. Build plan: `~/.claude/plans/claude-we-need-to-resilient-valiant.md`.

## Now

Phase 2 complete, 2026-08-19. The tool is generic (proven against seven real repos, not
claimed), carries a declared lifecycle, and writes only behind `--apply`.

**Do not quote a count from this file.** Derive it:

```bash
node ~/.claude/skills/curate-docs/cli.mjs report <dir> [--extra-root <workspace>]
node --test 'tests/*.test.mjs'     # quoted glob; the bare directory form is GOTCHAS G1
```

## The pipeline

```
1 DERIVE ──▶ 2 DECLARE ──▶ 3 SALVAGE ──▶ 4 DRAIN ──▶ 5 RECONCILE
  report       state --set   merge live    drain       report again
  impact       --apply       facts fwd     --apply
```

`impact <doc>` before archiving anything: it names the documents whose **only** inbound edge
is that one. `drain` refuses unless the status is declared **and** `impact` is empty — you
cannot delete what you have not declared dead.

## Active

- **Read-only except `state --apply` and `drain --apply`.** Both gated by a test that
  snapshots every byte of the tree across every disposition; both mutations verified red.
- **propagate preferred, not required.** Absent, kinds come from `.curate-docs.yml`; the
  report always names the provider in force.
- **Discovery is git-first** (`ls-files` ∪ untracked), filesystem fallback, symlinks walked
  separately, instrument named in every report.
- **Refusals are loud and typed:** exit 4 = no reachable hub (grading suppressed *with the
  reason*), exit 5 = Obsidian vault or a drain precondition failure.
- **Verified across seven repos** in `tests/repos.test.mjs` — Motherboard, VipinKaushik,
  SSJK-mb, propagate, keerti-job-radar, Obsidian, Youvan. A repo absent from the machine is
  named and counted as skipped, never silently passed.

## Pending

- **marketing-intel triage has not been done.** Today: 77 docs, 8 orphans (7 untriaged plans
  + `docs/market-signals.md`), 1 detached, 1 `UNLINKED-INDEX` (`docs/README.md`), 20 dangling,
  14 ambiguous, 19 external. `marketing-intel/STATE.md:176` declares the invariant this
  measures and notes no `docs/archive/` exists.
- **The other repos are unmeasured as work, only as tests.** VipinKaushik shows 203 dangling
  citations; most are workspace-relative and need `--extra-root`, but that is a guess until run.
- **No `PreToolUse` guard** against new orphans. Cannot be justified until one real triage
  cycle has happened.
- **Declared limitations, each with a GOTCHAS entry, not fixes:** backticked paths containing
  a space are invisible (G8) · a path quoted as an example is indistinguishable from a
  citation (G11) · staleness resets on a typo fix · `introducedBy` is weak in squash-merging
  repos · anchors (`foo.md#gone`) are never validated · provenance is capped at 60 docs and
  says so.

## Corrections this phase made to its own plan

Recorded because the plan is cited above and would otherwise mislead:

- The plan expected `keerti-job-radar` to be **hubless**. Measured, its README does link —
  the *survey* was wrong, not the tool. The genuinely hubless repo is `Tushar/Youvan`.
- The plan called the inbound extractor an inversion of propagate's `brokenPathCitations`.
  It is **new code**: `CITED_PATH` cannot see markdown links (G6).
- propagate's export is `kindOf`, not `resolveKind`.
