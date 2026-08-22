# Deferred — two-tier, ref-aware propagation ledgers

**Status:** deferred. The *provenance wedge* is being built now (see `STATE.md`); the
two-tier relocation and `sync` are not.

**Why this file exists.** This design was produced by `/office-hours` on 2026-08-20 and
reviewed by `/plan-eng-review` the same morning. Both outputs lived only under
`~/.gstack/projects/Rupali59-propagate-skill/`, and the reviewed plan — carrying decisions
D3–D9 — was written to a plan file that was subsequently **overwritten**, leaving those
seven decisions in a session transcript only. gstack artifacts are session-bridged scratch
and never authoritative (`rule:state-and-decisions`). This is the authoritative copy.

Original design: `rupali.b-main-design-20260820-150553.md` (gstack, may not survive).
Review record: `main-reviews.jsonl` — `mode: design`, `issues_found: 7`, `status: CLEAR`,
`commit 360ecb9`. **The review prose was never saved by gstack**; D3–D9 below were
recovered from the transcript.

---

## The proposal

Decouple ledgers from individual repos into a **two-tier** structure — a global ledger at
the hub and a workspace ledger at each parent — each covering every repo beneath it across
all branches and worktrees, and each able to answer **both** "what is the status of this
item" and "what decisions led us there".

Scale it rests on: 111 branches, 34 worktree checkouts, 32 repos; 1347 events; 793 edges;
35–37% of edges cross a repo boundary.

## Premises (agreed in session)

1. **The store is already unified** — one file, 1347 events, all workspaces. Nothing to
   centralize; only to version.
2. ~~**The ref model is stubbed, not absent** — `observed_on_ref` on every event,
   `source.ref`/`downstream.ref` on every row, all inert.~~ **Half closed 2026-08-22.**
   The premise understated the problem: the row model carried a ref PER SIDE while the
   event model carried a single scalar taken from the source, so the two were not merely
   inert, they were different shapes. Events now carry `downstream_on_ref` and its three
   position siblings (`validateEvent` requires both refs as present keys), and
   `reconcile`/`verify` take `--ref` / `--source-ref` / `--downstream-ref`, wiring the
   `refs: {source, downstream}` parameter that had existed unused since v2. Field set and
   the absent/null/`"working-tree"` trichotomy: `docs/DATA_MODEL.md` §10. Still inert:
   `--all-refs`, blocked by N41.
3. **Reading a ref never checks out.**
4. ~~The ledger should live outside anything that forks.~~ **Revised twice.** First to
   "sharding makes forking non-fatal". Then corrected by Rupali: **union merge solves
   storage conflicts, not semantic ones.** The doc calls that correction "the core of this
   design."
5. **Per-writer sharding is required**, not a nicety:
   `events/2026-08/<date>.<host>.<pid>.jsonl`, so merges are unions by construction.
6. **The existing events are not backfilled** — they keep `observed_on_ref:
   "working-tree"`, because their ref is genuinely unknown.

## The core distinction

- **Storage conflict — solved by sharding.** Two writers appending to one JSONL clash
  textually on every merge, and the correct resolution is always "take both", which git
  cannot know.
- **Semantic conflict — NOT solved by sharding.** Branch A verifies edge E as
  `propagated`; branch B verifies the same edge as `wontfix`. Union storage faithfully
  preserves both, and the ledger now holds two contradictory human decisions about one edge.

**Post-merge re-derivation is already automatic** and falls out of v2's existing design:
state is derived by comparing current content against the `contentId` an observation was
made against. A merge produces content neither branch observed, so both `contentId`s stop
matching and the edge drops to DRIFTED/NEVER_VERIFIED on its own.

> **An observation is only ever valid for the content it was made against.**

That invariant is what makes merging safe, and is the strongest argument for keeping
derived state rather than stored state.

## The review's seven decisions — D3–D9

D1 and D2 were scope questions; D2 found that `refsForEdge()` and `reconcile`'s `refs`
parameter are **both already built and simply unconnected** — "the expensive-sounding half
of this design is mostly a wiring job." Decision: review all three, **ship refs-wiring
first**.

| # | Issue | Sev/conf | Decision |
|---|---|---|---|
| **D3 — DONE** | `observed_on_ref` must distinguish a failed lookup from a real working-tree read. `row.source.ref \|\| "working-tree"` written verbatim at three call sites | P1, 9/10 | **Distinguish, and centralize the rule.** One helper: resolved ref as-is, genuine working tree as `"working-tree"`, failed resolution as `null` plus the `error` `resolveSide` already returns |
| **D4** | Which tier records an edge that crosses tiers? Measured: **782 edges inside one tier, 11 crossing**, all global→workspace | P1, 9/10 | **The tier that owns the SOURCE owns the edge.** One writer per edge, no duplication; the workspace picture is a documented two-file read. *(Presentation remains open.)* |
| **D5** | `CONTESTED` would be derived from a different input than every other state | P2, 8/10 | **`CONTESTED` becomes a flag on the row, not a ninth state.** The edge keeps its real content state and carries `contested: true` plus the conflicting dispositions; `graph` and `drain` opt in |
| **D6** | `sync` puts a network operation behind an append that currently cannot fail; two launchd jobs run unattended | P1, 9/10 | **Append stays local and unconditional; `sync` separate and deferred**, safe to re-run, reports what it could not push rather than dropping it |
| **D7** | `cli.mjs` is ~4,700 lines, ~22 subcommands in one if/else chain, and this design adds `sync` and `why` | P2, 9/10 | **Commands move out of `cli.mjs`, including existing ones** — new ones as lib modules, existing bodies follow, `cli.mjs` becomes dispatch |
| **D8** | The union-merge premise is unverified | — | **RED-first two-clone test.** Clone twice, append a different event in each, merge, assert zero conflicts and both present. **Run against today's single `2026-08.jsonl` first and watch it conflict.** Covers same-second same-host shard collision |
| **D9** | The `--all-refs` cost estimate | — | **`ls-tree` per ref, and sweep everything by default.** Open Question 1 closed |

## The cost correction — the design's own figure was wrong by ~100x

The design estimated `--all-refs` at *"111 branches × 793 edges ≈ 88k content reads"* and
flagged it as possibly unaffordable. That is wrong, and the uncorrected figure is still in
the gstack original.

> To hash content at a git ref, do NOT read files. `git ls-tree -r <ref>` returns the blob
> SHA for every file in ONE spawn, and **a blob SHA IS the content identity**. Measured on
> the Motherboard repo: 1180 files in 0.02s; all 34 branches in 0.79s.
> `lib/edges/content-id.mjs`'s `batchTrackedBlobs` already does this for the working tree
> via `git ls-files -s`. This turned an estimated 88k content reads for multi-ref reconcile
> into ~111 spawns.
>
> — `learnings.jsonl`, key `blob-sha-is-content-identity`, confidence 9, observed,
> 2026-08-20T09:56:20.997Z

For comparison, `reconcile --all` today is ~1.71s.

## Approaches considered

- **A · Ref-first, publish later.** Populate `observed_on_ref`, add
  `reconcile --ref/--all-refs`, shard per writer. Store stays local; a derived snapshot is
  published. ~2 days human / ~3 hrs CC. Risk low. Completeness 4/10 — covers the confusion,
  not sharing.
- **B · The store IS the repo (two-tier).** Global and workspace ledgers, each a
  single-branch-safe store with per-writer shards, `propagate sync` = commit/pull/push,
  state derived per (edge, ref). ~1 week human / ~1 day CC. Risk medium. Completeness 10/10.
- **C · git notes with `cat_sort_uniq`.** **Verified working in session** — gives
  union-plus-dedupe natively, and `refs/notes/*` sits outside `refs/heads/*` so notes do not
  fork with branches. **Rejected** on two grounds, neither technical: it re-scatters the
  ledger across 32 repos, the opposite of the ask; and `git push` does not push notes by
  default, which is a live footgun.

**Recommended: B, delivered in A's order** — A is a strict subset of B, so ref-awareness
ships first and answers the cost question before the sync layer depends on it.

## Still open

1. ~~Cost of `--all-refs`~~ — **closed by D9.**
2. **Which decisions surface in "what led us here"** — every event, or only disposition
   changes? *(Resolved for the current wedge only: `propagate why` shows disposition
   changes, full history behind `--all`. The general question for the two-tier renderer
   stays open.)*
3. **Does the workspace tier duplicate the global tier**, or does global hold only
   cross-workspace edges? D4 settled *ownership*; **presentation is still open**.
4. **Gotchas and todos** propagate too and carry the same ref question. **Their edge model
   is named and never designed.** Untouched.
5. ~~Sync failure semantics~~ — **settled by D6.** The review added a new one:
   **first-clone bootstrap for the store repo.**

## Success criterion named in the design

> `propagate why <edge>` renders the decision chain, including the branch each decision was
> made on.

Note the design defines **no** `last_reconciled_at` field, watermark, or "reconciliation
point" concept. Provenance is carried entirely by `observed_on_ref` per event, the
`contentId` an observation was made against, and the append-only chain rendered by `why`.

## The assignment the design set, not yet done

> Replay G11 by hand, before writing any code. Take the workspace where `STATE.md` hit 417
> lines against a 200 cap, check out the committed branch, and diff the two numbers
> yourself. Then write down the one sentence propagate would have had to print to stop it.
>
> That sentence is the spec for `observed_on_ref`. If you cannot write it in one line, the
> two-tier store will not save you — and if you can, you will have the acceptance test for
> the whole first phase before you have written a line of it.

## Ancestor issue

**N25** (`docs/ISSUES.md`) — "a ledger is read from the working tree, so its state is
whatever branch is checked out". The design cites it as "this issue's ancestor; closes with
it". Measured 2026-08-15 on SSJK-mb: `main` 7 rows vs the checked-out branch's 86, with
`status --all` reporting no open drift and naming no branch.

Confirmed again 2026-08-20 on `PanditPawanKaushik`: branch
`worktree-client-answers-propagation` carries 40 distinct rows with **1 open**, while
`main` holds a different 468-line ledger at the same path. The worktree directory was
emptied 2026-08-15; the rows survive only on the ref.

## Related learnings worth keeping

- **`propagate-no-close-path`** (confidence 9, 2026-08-13): `markStatus` has zero
  production callers — only its definition and two tests. *"Any plan touching propagate
  drain must treat this as missing code, not missing docs."*
- **`propagate-edges-are-cross-repo`** (confidence 10, 2026-08-13): 35% of declared edges
  connect files in **different git repos with independent branch sets**. *"Any design
  keying edge state on a single ref is wrong for a third of the graph."* Also caps
  automatic baselining at 31%, since co-commit evidence is impossible for those by
  construction.
- **`derived-state-survives-merges`** (confidence 8, 2026-08-20): the invariant quoted
  above; union-merged ledgers need no merge-resolution logic for STATE, only for
  contradictory human dispositions.
