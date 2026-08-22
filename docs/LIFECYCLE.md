> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# Lifecycle — the two machines, and how work divides

Written 2026-08-17, after the convertibility audit
([`AUDIT-2026-08.md`](./AUDIT-2026-08.md)) applied five dispositions to 29
hazards by hand with no written definition of what any of them meant.

This document names the states, says how a thing *leaves* each one, and derives
the work lanes from that. It is a map, not a mechanism — there is no
`propagate hazard` command, deliberately (see the end).

**It restates nothing.** The edge states are defined in `lib/reconcile.mjs`'s
module docstring, the dispositions in `lib/events.mjs`'s. Two copies of one
state list is [G20](./GOTCHAS.md); `DATA_MODEL.md` §7 is this project's own
cautionary tale of a doc that drifted from the code it described.

---

## Four machines, three of them written down

| Machine | Defined in | Subject |
|---|---|---|
| **Edge** | `lib/reconcile.mjs` `STATES` | one declared coupling between two files |
| **Disposition** | `lib/events.mjs` `DISPOSITIONS` | the verbs that move an edge |
| **Skill** | `lib/skills-lifecycle.mjs` | quarantine → 3 uses → promoted → demoted → reaped@14d |
| **Hazard** | *this document* | one thing that has cost someone time |

---

## The composed cycle

```
                    work
                     │
                     ▼  costs >10 min for a non-obvious reason
              ┌─ RECORDED ──────────────────────────────┐
              │   entry + the cost                      │
              │                                         │
              ▼  triage: exactly one disposition        │ recurs
        ┌─────┴─────┬──────────┬─────────┬──────────┐   │ (the entry
     RETIRE      PROMOTE   ELIMINATE  DETECT    DELIVER │  was right
   superseded     rule      design     check    trigger │  and was
        │           │          │         │         │    │  re-paid)
        │           └──────────┴────┬────┴─────────┘    │
        │                           ▼                   │
        │                      MECHANISM ───────────────┘
        │                           │
        ▼                           │ a mechanism is an artifact,
     (terminal)                     │ and artifacts have couplings
                                    ▼
                        ┌─── EDGE MACHINE ─── lib/reconcile.mjs ───┐
                        │  NEVER_VERIFIED                          │
                        │        │ baselined                       │
                        │        ▼                                 │
                        │      CLEAN ⇄ DRIFTED    source moved     │
                        │            ⇄ REVERSED   downstream moved │
                        │            ⇄ DIVERGED   both moved       │
                        │        │ decoupled                       │
                        │        ▼                                 │
                        │    (edge removed)                        │
                        │                                          │
                        │  ── not-a-verdict, by design ──          │
                        │  UNMATCHED           glob matches 0      │
                        │  NOT_PRESENT_ON_REF  absent at this ref  │
                        │  UNRESOLVABLE        no-repo / lfs /     │
                        │                      is-dir / read-error │
                        └──────────────────────────────────────────┘
                                    │
                     repeated DIVERGED on one coupling
                     is evidence of a hazard ───────────► RECORDED
```

**The join is the point.** A disposition produces a *mechanism* — a rule, a
check, a trigger, a design change. A mechanism is a file. Files have couplings.
So every mechanism this system produces enters the other machine and can drift
from the thing it guards.

That is observed, not theorised. On the day this was written,
`rules/safety-flag-needs-a-test.md` — a mechanism produced by PROMOTE —
appeared in `check --changed` as an untracked file within minutes of being
created, and `lib/graph.mjs → SKILL.md` was a coupling that could not be
declared at all (`ISSUES.md` N29).

**RECORDED is the only state entered by default, and the only one with no exit
criterion of its own.** That is the whole trap. 29 of 47 entries sat in it, and
the general form of the most expensive one sat in `rules/_TODO.md` for three
days while its hazard fired twice more, for 11 spurious events.

---

## Hazard states

### RECORDED
**Enter:** something cost more than ten minutes for a reason that was not
obvious, and an entry was written with **the cost**. The cost is load-bearing —
`rule:every-project-carries-gotchas` — because an entry without it reads as
pedantry and gets skipped.

**Leave:** by triage into exactly one disposition. Nothing else.

**Failure mode:** staying. An entry here is doing nothing except waiting to be
re-paid.

### RETIRE
**For:** an entry that is no longer *true* — distinct from one that feels
obvious now, which stays.

**Exit:** a dated supersede banner naming what replaced it, with the original
text kept beneath. `GOTCHAS.md` says never delete; the incident outlives the
advice.

**Worked example:** G39 said `verify` writes immediately and advised *"never run
it to see what it would do"* — the opposite of correct once `--apply` gated
every disposition.

### PROMOTE
**For:** a hazard whose general form applies beyond this project.

**Why it matters most:** a project `GOTCHAS.md` loads when someone opens it.
`~/.claude/rules/` loads **every session**, via `~/.claude/hooks/load-rules.mjs`. The general
form belongs where it loads.

**Exit:** the rule file exists with `id`/`scope`/`status`/`fingerprint`
frontmatter, `_check.mjs --selftest` is green, **and the fingerprint does not
punish the behaviour the rule wants.** That last clause is not decorative:
`every-project-carries-gotchas`'s fingerprint contained the bare literal
`docs/GOTCHAS.md`, so every project that *cited* its own gotchas file was
reported as restating the rule.

The gotcha keeps the *incident* and gains a one-line pointer up. Never both.

### ELIMINATE
**For:** a hazard the design can make impossible.

**Exit:** the change, plus a test whose mutation goes red **for the stated
reason** — and proof the mutation applied. A `sed` that matched nothing and a
`re.sub(count=1)` that hit the wrong one of two identical blocks have each
silently no-op'd this check before.

**Worked example:** G44. `--apply` now gates every disposition, so the hazard
cannot recur; the entry is history.

### DETECT
**For:** a hazard with a mechanical signature but no design fix.

**Exit:** a `doctor` expectation following the `graph.cycles` shape in
`lib/metrics.mjs`, carrying a dated `basis`, plus its failing fixture. Absence
must be attributable — a metric that cannot distinguish "clean" from "did not
run" is not a check (see `graph.cycles` returning **null**, never 0, when
reconcile fails).

### DELIVER
**The fallback, not the default.** Reached only after ELIMINATE and DETECT have
been considered and rejected *in writing*.

**For:** a fact about a tool that is not ours — the mistake is in a command, not
in the tree.

**Exit:** a `**Trigger:**` and a `**Fires on:**` literal that
`gotcha-guard --selftest` asserts, in the index the guard can actually reach.

**The trap:** the guard walks *up* from cwd. A trigger written into
`~/.claude/skills/propagate/docs/GOTCHAS.md` is unreachable from anywhere anyone
works. Shell and git hazards go in `~/.claude/gotchas-global.md`; only
project-specific ones go in a project's file.

---

## Three kinds of work

Not every backlog item is a hazard. This is the distinction that makes the
backlog assignable:

| Kind | Question | Examples |
|---|---|---|
| **Instance** | resolve *this* edge or *this* hazard | the current worklist; the SSJK-mb cycle; the duplicate declaration |
| **Mechanism** | build the thing that resolves instances | the coverage ratchet; `propagate gotcha`; retrofitting triggers |
| **Machine** | fix the machine itself | N29; `doc-authority`'s dead delivery channel |

**Machine work outranks the other two.** A broken machine reports success while
not looking: N29's five declared edges moved the edge count 711 → 711, and
`doc-authority`'s non-blocking notes have reached nobody for as long as it has
existed — found only by instrumenting `gotcha-guard`'s own delivery.

---

## Lanes

Five dispositions do **not** give five parallel lanes. By the files each one
touches:

```
RETIRE     docs/GOTCHAS.md
DELIVER    ~/.claude/gotchas-global.md   + docs/GOTCHAS.md (pointers)
PROMOTE    ~/Documents/GitHub/rules/     + docs/GOTCHAS.md (pointers)
DETECT     lib/metrics.mjs, cli.mjs, tests/
ELIMINATE  lib/*.mjs,       cli.mjs, tests/
```

`docs/GOTCHAS.md` is shared by three; `cli.mjs` by the other two. Per
`rule:model-routing`, stages sharing a file run sequentially. So:

| Lane | Order | Model | Exit |
|---|---|---|---|
| **Docs** | RETIRE → DELIVER → PROMOTE | Haiku · Haiku · Opus | banner + superseded-by · `gotcha-guard --selftest` proves every `**Fires on:**` · `_check.mjs --selftest` green and the fingerprint does not punish adoption |
| **Code** | ELIMINATE → DETECT | Opus designs, Sonnet executes | mutation red for the stated reason, mutation provably applied, full suite green |

The two lanes are disjoint and run in parallel. Within a lane, sequential.

---

## Where the backlog sits

Assignments, not estimates. Instance work is listed by its command rather than
by a count, because a count in a doc rots faster than anything else in it
(`rule:state-and-decisions`).

**Machine — do first**

| Item | Lane |
|---|---|
| ~~N29~~ · **RESOLVED 2026-08-17** — the skill's own `.propagates.yml` exists and `reconcile --all` resolves 9 edges under it. Verified 2026-08-17; this row was the stale copy, the issue was already closed | — |
| **N31** · `renderMarkdown` has no live caller and would regress the tree if called — decide: fix its three false lines and wire it into `drain`, or retire it and adopt ManavDaehi's frozen-banner pattern. **2026-08-22:** its sole caller `watcher.mjs` was deleted, so it is now provably dead rather than merely uncalled; decide with the `cli.mjs` split | Code · ELIMINATE or DELIVER |
| **N30** · `ledger.unknown_types` — needs a disambiguation strategy for duplicate id `256` **and** a test pinning which row wins, not just folding the `manual` type | Code · DETECT · human call |
| `doc-authority`'s `note:` path reaches nobody (stderr on exit 0) | Code · ELIMINATE |
| `edge_id` churn — a rename or a `why` rewrite mints a new edge and discards its history. **Narrowed 2026-08-22 (N40):** relocating a checkout no longer churns ids — the downstream half is repo-relative and all nine derivation sites share `edgeIdFor()`. Rename/`why`-rewrite churn remains, as does a checkout *renamed* on disk (`node_id` still embeds `basename(repoRoot)`) | Code · design first, disposition unclear for the remaining cases |
| `UNMATCHED` is `ACTIONABLE` in `lib/graph.mjs:52` but declared a permanent adoption gauge in the hub sidecar — needs an exemption or a distinct state, else the worklist reads 1-of-N forever | Code · DETECT |

**Mechanism**

| Item | Lane |
|---|---|
| `gotchas.coverage` ratchet (derivation kept at `docs/deferred/gotchas-census.mjs`) | Code · DETECT |
| G33 · job-tmp paths cited in durable docs | Code · DETECT |
| G37 · `[[ -x ]]` githook dispatch hides a missing exec bit | Code · DETECT |
| `NEW-PROJECT-CHECKLIST` §2 + a first-entry flow | Docs · PROMOTE |
| Retrofit triggers: job-radar (13), ppk-shopify (29), global | Docs · DELIVER |
| G27 → `absence-claims-need-state-and-branch` | Docs · PROMOTE |
| The 16 undeclared `rules/` files | Docs · PROMOTE |

**Instance** — `propagate graph --all` for the worklist in dependency order; the
SSJK-mb cycle and the duplicate declaration are named by `propagate doctor`.
The `NEVER_VERIFIED` baseline gap is a `bootstrap --baseline-from-git` pass.

**Unclassified, still real:** the four `TODOS.md` files `propagate backlog` reports as `unparsed` (SSJK-mb, Tathya, thesis-frontend, VipinKaushik); `DATA_MODEL.md`
describing v1 only; the skills-probe findings (a dangling `SKILL.md` symlink, 47
`skillUsage` keys with no directory, the unexplained 169 → 92 → 61 trajectory).

---

## Why there is no `propagate hazard` command

The states above are *derivable* from content — does the entry carry a
`**Trigger:**`? is it cited by a test? does a rule point at it? — exactly as
`reconcile` derives edge state. If it is ever built, it must be derived and not
stored: `rule:delegation-criteria` §2, and the v1 watcher that ran 4,420 times,
found nothing in 99.2% of them, and whose mutable baseline *invented* drift.

It is not built because a document divides the work and a command is a second
surface to keep true. Build it when the counting becomes the bottleneck, not
before.
