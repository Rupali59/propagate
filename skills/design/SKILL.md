---
name: design
description: Use when deciding what should happen to a document — triaging an orphan, judging whether a plan landed or was dropped, salvaging facts before anything is archived, or working out what breaks if a doc goes away. Triggers on "should this doc exist", "did this plan ship", "is this still true", "what depends on this doc", "can I archive this".
---

# design — the judgment half

Parent skill: `curate-docs` (premise, pipeline, Contract). This skill is what happens
*after* the instrument has produced a verdict and *before* anything is written or removed.

The instrument half — which command to run, what a flag does, why a count is surprising —
is the `eng` skill.

## The verdict is a question, not an answer

`eng` reports the verdict. Every one of them is really a question that only a human, or a
human's evidence, can close:

| Verdict | The question it asks |
|---|---|
| `ORPHAN` | should this exist? |
| `DETACHED` | is this cluster still live? |
| `UNLINKED-INDEX` | findable only if you already know it — who is meant to find it? |
| `NO-STATE` | did it land, or was it dropped? |
| `STALE` | it describes something still standing, gone quiet. Is it still true? |
| `BAD-STATUS` | a `status:` outside the taxonomy — a typo reading as healthy |

A document nothing calls is not wrong. It is **undecided**, and this skill is how the
decision gets made.

## Before archiving: `impact`

```bash
curate-docs impact <doc>
```

It names the documents whose **only** inbound edge is this one — the ones that orphan the
moment it stops citing them. Run it before declaring anything dead. This check existing is
why archiving no longer cascades.

## Salvage — the step that must not be skipped

Docs are companions to code, design and concepts. Before draining, ask what the document
contained and whether it is still true, against four anchors:

| Anchor | How |
|---|---|
| **The code it describes** | grep the identifiers and paths the doc names. The strongest signal by far: `resolveEntities` present in six ingesters → shipped; zero hits for `TrackedSource` → dropped |
| **`DECISIONS.md` entries citing it** | already parsed; `supersedes:` gives the inverse index free |
| **`STATE.md`'s own claims** | it often already names the debt |
| **Ledger / sidecar edges** | thin, but decisive when present |

Facts still true are **merged forward** into the companion doc or `DECISIONS.md` *before*
the source is drained. Nothing is deleted that has not first been read.

## Two rules for stating a verdict

**A verdict states what it rests on.** *"ARCHIVED — superseded by `lib/entities/resolve.ts`,
shipped per STATE.md 2026-07-10"* is checkable. *"ARCHIVED — looks done"* is not.

**When the evidence is genuinely mixed, say so and stop.** *"Undecided, and here is what I
found on each side"* is a permitted verdict. A lean dressed as a finding is not.

## Reconcile

After the write, re-run. The count must move **for the reason you intended**, and no orphan
may appear that `impact` did not predict. An orphan you did not predict means the salvage
step missed an edge — go back to it rather than declaring the new orphan too.
