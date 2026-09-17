# Hub and workspace — which owns what, and how a lesson travels between them

**Written 2026-09-17**, after N77 asked a narrow question (why does one edge keep
producing `no-change-needed`?) whose answer turned out to be architectural.

**Do not restate the propagation layout or the PROMOTE criteria here.** They are canonical
in `REFERENCE.md` §"Propagation layout" and `LIFECYCLE.md` §PROMOTE. This file is about the
*relationship* between the two halves, which neither of those states.

---

## The line

**The hub owns contracts. Workspaces own instances.**

| | hub (`~/Documents/GitHub`) | workspace |
|---|---|---|
| holds | `rules/`, `scripts/execution/*.yml`, `.templates/`, the schemas, `propagate/docs/` | `propagation/state/<project>/` — STATE · DECISIONS · GOTCHAS — and `.propagates.yml` |
| changes | rarely, deliberately | constantly |
| checked by | `rules check`, declared edges | `doctor`, `status`, `rollup` |

Almost every defect below is that line crossed in one direction or the other: a contract
living inside an instance file, or an instance never becoming a contract.

## The two-way flow

```
                    contracts propagate DOWN
   hub  ──── declared edges, rules check ────▶  workspace
        ◀─── PROMOTE (by hand) ──────────────
                    lessons promote UP
```

**Down works.** 57 of 1003 expanded edges cross the boundary — 5.7%. Of the 47 outbound,
**37 are glob fan-out from four patterns** in the hub sidecar; only 10 are hand-declared.
The globs are the part that scales: they pick up new workspaces automatically as those
workspaces adopt the layout, and a glob matching nothing is skipped with a warning rather
than failing.

**Up works too, by hand, and that is the surprise.** The hub `CLAUDE.md` says *"a proven
local gotcha has no promotion path"*. That is true of *mechanism* and wrong about
*practice*: **6-7 of 18 rules carry direct, dated evidence of promotion** from a project,
a memory, or a convention doc — roughly one every 3-4 days during the active build window.
`rules promote` is a stub (N64) and always was.

**So the defect in the upward path is latency, not absence.** `rules/_TODO.md` has carried
4-5 unwritten rules since 2026-08-14. `LIFECYCLE.md` already priced that lag once: *"the
general form of the most expensive one sat in `rules/_TODO.md` for three days while its
hazard fired twice more, for 11 spurious events."* A hub that learns three days late
learns too late.

## What is measured, and by what

Every number below is derived, not remembered. **Run the command; do not trust the
figure** — `rule:state-and-decisions`, whose own worked example is a state file asserting
149 open rows the day a drain made it 8.

| question | command |
|---|---|
| which rules are restated vs referenced | `propagate rules list` |
| do the fingerprints fire on paraphrase | `propagate rules selftest` — 18 of 18 probed |
| what crosses the boundary | `propagate reconcile --all --json`, classify `rows[]` by top-level dir |
| workspace layout conformance | `propagate rollup`, the per-workspace line in `ECOSYSTEM.md` |
| gotcha presence and liveness | `propagate doctor` — but read N80 first, the per-file trigger ratio never reaches you |

**One trap worth stating once.** `reconcile --json` emits `edges: 493` and
`expanded: 1003`. The first is declarations, the second is after glob expansion. Comparing
one against the other is `rule:discernment-checks` §5 — and it has already been done in
this tree, by a sidecar audit that found "0 duplicate edges" comparing declared paths while
`reconcile` found 1 comparing expanded ones.

## Where the line is currently crossed

Filed as issues; this is the index, not the detail.

| # | what | which direction |
|---|---|---|
| **N85** | **83% of edges with any history are majority `no-change-needed`** — the declaration is routinely coarser than the dependency | the boundary is declared at the wrong grain |
| **N77** | a contract (the handover close protocol) lives inside a 2374-line append-only instance file — one special case of N85 | contract stuck in an instance |
| **N81** | five more files do the same — four restating a grammar that is already canonical in `rule:every-project-carries-gotchas`. **None has a declared edge yet**, so none is costing anything: fix before it bites | same, latent |
| **N79** | `rules list` reports a relevance verdict from a scan of `CLAUDE.md` only, and calls the three most-cited rules in the tree `unexercised` | the hub cannot see its own reach |
| **N80** | the gotcha trigger count is computed and dropped before any reader sees it | liveness invisible |
| **N82** | two empty directories pass the conformance check; one real repo is enumerated nowhere | absence has no vocabulary |
| **N83** | hub `CLAUDE.md` currency is enforced for 4 of 16 workspaces | nine rows can rot invisibly |
| **N84** | all 17 in-tree ledgers are empty; 2839 events live outside every remote, undocumented | undecided, unwritten |
| **N64** | `rules promote` is a stub; the manual path works but is backlog-prone | instance → contract, slow |

### The finding that reframes the rest

N85 is the one to read first, because it **refutes the obvious explanation**. The intuition
— noisy edges have high-churn sources — is measurably false: noisy-edge sources average
**7.3** commits/60d against **12.7** for non-noisy ones. The disproof is a single file.
`sanskrit-texts:docs/INVENTORY.md` (49 commits) carries noisy edges at 0.75 *and* quiet
ones at 0.10, to different downstreams.

**What predicts noise is which SLICE of the source the downstream depends on.** A
downstream tracking a stable derived fact — a pointer line, a count, a format grammar, a
canon list — gets re-checked on every unrelated edit to whatever file happens to contain
it. The hub↔workspace boundary is declared at file granularity while most real couplings
are finer, and that mismatch is the dominant behaviour of the ledger, not an exception.

This is why **"declare more edges" is not automatically an improvement**, and why the 17
undeclared rules below are a per-rule judgement rather than a sweep. An edge declared at
the wrong grain adds review cost without adding safety.

**17 of 19 rule files are declared as a propagation source nowhere** — only
`discernment-checks.md` and `gotchas-global.md` are. Per
`rule:adversarial-review-reads-the-ledger`'s own corollary, *"a green propagate on an
undeclared artifact is not evidence"*, so 17 rules have had no coupling review at all.
Declaring all 17 is **not** obviously right — a rule with no downstream has nothing to
declare — so this is a per-rule judgement, not a sweep. `LIFECYCLE.md` carries it as a
backlog row with a now-stale count of 16.

## The pattern that works, when you need a model

`Vipin Kaushik`'s three `DECISIONS.md` files carry **no** format grammar. They point at
`rules/conventions/STATE_MANAGEMENT.md`, where the contract sits beside the
`decisions-check.sh` that enforces it. `propagate`'s own `DECISIONS.md` restates the same
grammar inline instead, and is therefore an N81 instance.

Both the model and the defect are in this tree. **Cite, don't restate** is not a new
principle to introduce — `REFERENCE.md` §"Propagation layout" says it in those words, and
`rules check` enforces it for rules. The gap is that nothing enforces it for *formats*.

## Adversarial review of this diagnosis, 2026-09-17

Run against the diagnosis immediately after writing it, per
`rule:adversarial-review-reads-the-ledger` — which says to review the **edges**, not just
the file. That is what found the largest miss.

**It found one thing the diagnosis missed entirely: N86.** The `DECISIONS.md` format gate
exists as **two divergent forks**, both inside client workspaces, with enforcement cutoffs
**five weeks apart** (`Vipin Kaushik` 2026-06-09 / `PanditPawanKaushik` 2026-07-16),
depended on by 54 files across 6 workspaces — including `propagate` itself, whose own
`DECISIONS.md` header names the shorter fork. A contract living in two instances. It is the
purest example of this file's thesis and the file-by-file pass could not see it, because
"who depends on this" is a property of the graph.

**It found two defects in the diagnosis's own numbers**, both corrected on N85:

- The entry was titled *"83% of edges with any history"*. **1564** edges have ≥1
  disposition; **125** have ≥4. The 83% is of the 125 — as a share of everything with
  history it is **6.6%**. Comparing unlike populations (`rule:discernment-checks` §5) in
  the title of an issue about measurement discipline.
- It led with the **weak** evidence. The aggregate churn table (n=15 non-noisy sources,
  groups defined by the outcome under test) is suggestive at best. The strong evidence is
  the same-source spread, where churn is constant by construction:
  `sanskrit-texts:docs/INVENTORY.md` carries six edges at **0.75, 0.75, 0.75, 0.63, 0.18,
  0.10**. Reordered.

**And it declines the remedy the rule prescribes, on the diagnosis's own evidence.**
`rule:adversarial-review-reads-the-ledger` closes by saying a review that ends without new
declarations *"found defects but left the mechanism intact"*. This file is undeclared, and
the obvious fix is an edge from `REFERENCE.md` to it.

**That edge would be a textbook N85 defect.** `REFERENCE.md` is 632 lines across 13
sections; this file depends on **one** of them. Declaring at file granularity would
re-prompt a human on every unrelated `REFERENCE.md` edit, and the answer would be
`no-change-needed` nearly every time — which is exactly the 83% this diagnosis documents.
So the declaration is deferred **deliberately and on record**, not forgotten. It is
unblocked the moment N85 produces a way to declare the dependency at its real grain.

Stating it here rather than silently skipping it, because an undeclared artifact with no
explanation is indistinguishable from an oversight — the same failure N82 names.

## What this file deliberately does not decide

- Whether to widen `rules check`'s corpus beyond `CLAUDE.md`. It would change what
  "restatement" means; N79 argues for fixing the vocabulary instead.
- Whether `firstmate/` should be enumerated. The real gap is that a deliberate exemption
  and an invisible repo render identically, which `rule:discernment-checks` §2 forbids.
- Whether verification history should live in the tree. All 17 in-tree `ledger.jsonl` are
  empty and the 2839 real events sit in `~/.propagate/`, outside every git remote, so a
  clone restores no history. That may be correct and deliberate; no document says so, and
  that silence is the thing to fix first.
