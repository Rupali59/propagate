---
name: curate-docs
description: Use when a repo's markdown docs have drifted — orphaned or unreferenced docs, plans nobody triaged, an archive nobody drained, a docs/ directory nobody can navigate, stale architecture or spec docs, broken links between docs, "which doc is current", "why does this doc exist", or before answering an architecture or methodology question from docs you have not verified are current.
---

# curate-docs

<!-- premise:start -->
Every document should have a **calling node** — something that cites it, reachable from an
entry point. A document nothing calls is not necessarily wrong; it is **undecided**, and the
decision is what this drives to.

The decision is recorded **in the document**, and only then is the document moved or removed.
<!-- premise:end -->

## The pipeline

```
1 DERIVE ──▶ 2 DECLARE ──▶ 3 SALVAGE ──▶ 4 DRAIN ──▶ 5 RECONCILE
  report       state --set   merge live    drain       report again
  impact       --apply       facts fwd     --apply
```

```bash
node ~/.claude/skills/curate-docs/cli.mjs <mode> <dir> [--extra-root <workspace>]
```

**Pass `--extra-root <workspace>` for any sub-repo**, or correct cross-repo citations like
`../STATE.md` get misreported.

## Which skill

| You are doing | Skill |
|---|---|
| Deciding what should happen to a doc — triaging an orphan, judging whether a plan landed, salvaging facts, checking what breaks if it goes | `design` |
| Driving the tool — which mode, which flag, why a count or a refusal looks wrong | `eng` |

Steps 1 and 5 are mostly `eng`; steps 2–4 need `design` to decide and `eng` to execute.

## Contract

Two rules both subskills obey, stated once here:

**Declaring is the archival act. Do not `git mv` into `docs/archive/`.** Moving rewrites
every relative path the doc owns — proven, one move produced two orphans and a dangling
citation. Once the state is in the file, the move buys nothing.

**Never regenerate an index to clear the orphan list.** It manufactures a link so the count
goes green while nobody decided anything — the exact failure this skill exists to prevent.

## Reference

`docs/GOTCHAS.md` — 19 instrument failures paid for during the two build phases. Read it
before trusting a surprising number. `docs/DECISIONS.md` — why the pipeline has these five
steps and not others.
