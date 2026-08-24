# v3 — one propagation standard, applied to every workspace

**Status: approved, not started.** Reviewed by `/plan-eng-review` (2 runs, 7 findings, scope
reduced at Step 0). Successor to `2026-08-22-background-jobs-and-init.md`, which fixed the
plumbing this standard sits on.

**Why this file exists.** `~/.claude/plans/` is session scratch.
`docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md` exists precisely because a reviewed
plan carrying seven decisions was overwritten and survived only in a transcript. The
**measurements** below are the part that cannot be reconstructed — they took a dozen scans
and will be stale a week into Phase A.

---

## The problem, in one line

`~/Documents/GitHub` contains **three overlapping propagation systems and four orphans**.
None agree. Only one of them is read by any tool.

## The measurements — 2026-08-22

### v1 ledgers: 1,834 rows, 453 open

| Workspace | rows | open | done | wontfix |
|---|---|---|---|---|
| `Vipin Kaushik` | 791 | 111 | 58 | **622 (79%)** |
| `PanditPawanKaushik` | 554 | 147 | 352 | 55 |
| hub | 401 | 151 | 172 | 78 |
| `ManavDaehi` | 52 | 26 | 7 | 19 |
| `Keerti` | 36 | 18 | 6 | 12 |
| `Motherboard` | 0 | 0 | 0 | 0 |
| `Rupali/Obsidian` | 0 | 0 | 0 | 0 |
| **total** | **1,834** | **453** | **595** | **786** |

Plus `propagation/PROPAGATION_CROSS_LEDGER.jsonl`, 16 rows. Zero malformed lines anywhere.

`DATA_MODEL.md` §6 traced **556 of Vipin's wontfix rows to hand-authored rows that never came
from this codebase** — the v1 ledger is largely an archive of a previous tool's output, still
counted as live state.

### v2 derivation: 860 edges, 0 DRIFTED

468 CLEAN / 392 NEVER_VERIFIED, from 1,914 events. By source repo:

```
PanditPawanKaushik  473   (55% of the whole graph)   NEVER_VERIFIED 149 / CLEAN 324
Vipin Kaushik        84                              NV 57 / CLEAN 27
SSJK-mb              81                              NV 73 / CLEAN 8
GitHub (hub)         33                              NV 14 / CLEAN 19
keerti-job-radar     32                              NV  4 / CLEAN 28
Motherboard          30                              NV 21 / CLEAN 9
propagate            29                              NV 29 / CLEAN 0
astroacharya         27                              NV 19 / CLEAN 8
Manav-portfolio      21                              CLEAN 21
curate-docs-skill     9   <- ARCHIVED REPO           NV  1 / CLEAN 8
…14 more, each <10
```

**The two systems disagree by construction, not by bug.** v1 *stores* drift rows; v2
*derives* state from content. 453 open vs 0 drifted are answers to different questions, and
nothing reconciles them.

### Cross-repo share

**114 of 860 edges (13.3%)** join files in different repos with independent branch lines.
(An earlier figure of 35% — 70/201, 2026-08-13 — was true of a graph a quarter the size; the
*share* fell because discovery grew the denominator, not because cross-repo edges went away.)

### The third system: `scripts/hygiene/`

| | hygiene libs | `propagation/refs/` | `propagation/state/` |
|---|---|---|---|
| `Vipin Kaushik` | **14** | 2 | 1 |
| `PanditPawanKaushik` | **9** | 0 | 0 |
| `Motherboard` | 0 | 0 | 1 |
| hub, `Keerti`, `ManavDaehi`, `Obsidian` | 0 | 0 | 0 |

**5 of the 8 shared libs have DIVERGED** — `canonical-guard.sh`, `dep-audit.sh`,
`memory-diff.sh`, `size-caps.sh`, `worktree-resolver.sh`.

Only in `Vipin Kaushik`: `active-lines`, `branch-registry`, `dep-audit-selftest`,
`link-check`, `ref-resolver`, `state-index`.
Only in `PanditPawanKaushik`: `worker-routing`.

This is the copy-drift `rules/_TODO.md` was written to stop (9 copies of one rule making 4
contradictory claims), happening in shell.

### Scale, for the registry

~34 repos / ~114 local branches at depth ≤3 from the hub. **A floor, not a total** — that
count double-counts nested workspaces and excludes Motherboard's deeper Go modules. Registry
generation is one `for-each-ref` per repo; the deferred doc already measured all 34
Motherboard branches in **0.79s**.

### The four orphans

**1 · Four rendered ledgers with no `.jsonl` sibling**, all at sub-project level, all in the
four sub-projects that stopped being workspaces in the 2026-08-21 consolidation:

| File | mtime | First line |
|---|---|---|
| `Keerti/Keerti-portfolio/docs/PROPAGATION_LEDGER.md` | 2026-08-16 | *"**Last entry: 2 days ago.** Watcher healthy."* |
| `PanditPawanKaushik/SSJK-mb/docs/PROPAGATION_LEDGER.md` | 2026-08-16 | *"**Last entry: 2 days ago.** Watcher healthy."* |
| `Keerti/keerti-job-radar/docs/PROPAGATION_LEDGER.md` | 2026-08-16 | *"**Last entry: never** — first write incoming. Run `/propagate status` if this persists."* |
| `ManavDaehi/Manav-portfolio/docs/PROPAGATION_LEDGER.md` | 2026-08-17 | *"# Propagation Ledger — frozen historical render"* |

**The watcher was retired 2026-08-14** — two days before two of these files asserted it was
healthy. The third told a reader to run a command if the condition persisted; it persisted
for six days. Only `Manav-portfolio` was caught and re-headed.

**2 · `curate-docs-skill/`** — archived on GitHub, checkout retained deliberately for the N43
rollback, and a **live graph participant: 9 edges, 8 baselined CLEAN**. Its sidecar has
diverged from its vendored twin (`skills/eng/SKILL.md` vs `sections/eng.md`).

**3 · Phantom `WatchPaths`** (N46) — regenerating the monitor plist dropped 8 of 20 paths,
all still on disk.

**4 · The unread prototype** — see below.

---

## The prototype, and why it is a promotion not a cleanup

`Vipin Kaushik/propagation/` carries, and **no other workspace has any of it**:

```
README.md            a real spec — layout, .sidecar.yml field table, why the
                     overrides: line must live in CLAUDE.md and not here
INDEX.md             derived, by scripts/hygiene/lib/state-index.sh
refs/snapshot.json   {captured_at, captured_by: "hygiene/branch-registry",
                      schema_version, projects.<p>.{base_ref, refs.<b>.{head,
                      is_active_line, last_commit_iso, merge_state, upstream,
                      upstream_track, worktrees}}}
refs/lifecycle.jsonl {type: "branch_lifecycle", project, ref, event, ref_count,
                      detected_by: "snapshot-diff", window_seconds, evidence}
state/<project>/     STATE.md + DECISIONS.md + .sidecar.yml, for 6 projects
```

**Nothing in propagate reads any of it** — verified by grep for `lifecycle.jsonl`,
`snapshot.json`, `INDEX.md` and `propagation/state`: zero hits outside docs.

It carries a **`schema_version`. propagate's own event store does not.**

**The registry and today's ref-pair work are two halves of one capability**, built
independently in different languages by the same person, neither aware of the other. Events
can now say *"observed at ref X"* (shipped `fd322cd`); the registry knows which refs exist,
which is active, which are merged, and which were pruned.

---

## What v3 is

```
<workspace>/propagation/
  README.md              generated — cites REFERENCE.md, never restates a path
  INDEX.md               derived   — the state index
  refs/
    snapshot.json        derived   — the prototype schema, verbatim
    lifecycle.jsonl      append-only — created/merged/pruned, with evidence
  state/<project>/       STATE.md  DECISIONS.md  .sidecar.yml
  archive/
    ledger-v1.{jsonl,md} FROZEN, headed as archive, never appended
```

One store (`~/.propagate/events/`), gaining a `schema_version`: today's ref-pair events are
v3 records, the 1,912 before them are v2, **nothing is backfilled**, so that distinction has
to be readable.

---

## Phases

Full text, decisions and verification: `~/.claude/plans/` at time of approval; the operative
summary is below. Each phase is independently shippable.

| | Phase | Key constraint |
|---|---|---|
| **A** | Spec + conformance check + rewrite `rule:state-and-decisions` | **The check must FAIL on 6 of 7 workspaces today.** A conformance check green before the work is not checking. |
| **B** | Branch registry — **reuse, do not port** — and fix N41 | `enumerateRefs` already spawns `worktree list --porcelain` AND `for-each-ref`; the 4 missing fields come from widening one format string at zero extra spawns |
| **C** | ~~Absorb **9** hygiene libs, leave **6**~~ — **re-measured 2026-08-24, see below** | The 6 (`dep-audit`, `link-check`, `size-caps`, `memory-diff`, `worker-routing`, `dep-audit-selftest`) are not propagation |
| **D** | Freeze v1, version the events | Triage the 453 open rows *first*; reuse `relocateLedger` + `migrate-ledger.mjs` (679 lines, already written) |
| **E** | Migrate all 7 workspaces | `ledgerFingerprint` before and after is the rollback. 0-row workspaces first, `Vipin Kaushik` (791) last |
| **F** | The four orphans | `curate-docs-skill` is moved or excluded, **never deleted** — the repaired N43 rollback cites it |


**Phase C, as executed (2026-08-24).** The "9 absorb / 6 leave" split counted libs across
ALL workspaces; `worker-routing` is PanditPawanKaushik-only and absent from
`Vipin Kaushik/scripts/hygiene/lib/`, where C was actually done. Measured there:

| | libs |
|---|---|
| Registered in `collect.sh` | `size-caps`, `state-shape`, `state-staleness`, `decisions-scan`, `dep-audit`, `memory-diff`, `link-check`, `state-index` |
| Live transitive deps | `worktree-resolver` (4 consumers), `active-lines` (3), `ref-resolver` (1), `canonical-guard` (**live — `.githooks/pre-commit:75`, and `core.hooksPath=.githooks`**) |
| Unregistered, deliberately kept | `branch-registry` — the independent oracle that caught `merge_state` being null |

**Three libs were classified wrong on the first pass and corrected by re-measuring.**
`rg -l <name>.sh` conflates docs, comments and invocations, and `collect.sh` dispatches
via `run_lib "$name"` -> `bash "$LIB/$name.sh"`, which no literal-path grep resolves.

**Nothing was absorbed or deleted.** Two readers were repointed and one narrowed, which is
what the phase was for:

- **`state-staleness`** — read pointer stubs, and had three separate ways to go green
  without measuring (stub path; silent `|| return 0` on absence; `results==0` -> green).
  Now enumerates `propagation/state/` via sidecars, reads `ready:false` projects from
  their ACTIVE LINE via `git show`, and emits `scanned`/`skipped` always — zero is an
  error, never a green.
- **`decisions-check.sh`** — hardcoded stub paths. Now discovers, names every file it
  scanned (a bare "6 clean" cannot distinguish six logs from six signposts), reports
  absent declared targets instead of `continue`-ing, and gates deferred projects:
  **6 -> 7 files**, VipinKaushik's 430-line DECISIONS.md checked for the first time.
- **`state-shape`** — **slated for retirement and NOT retired.** The claim that
  propagate's v3 conformance covers it is false: `V3_REQUIRED` is workspace-level and
  asserts nothing per-project. Its `STATE.md` / `docs/DECISIONS.md` assertions were
  vacuous (a pointer stub satisfies presence) and are removed; `docs/plans/README.md` is
  checked by **nothing else in the tree**, and retiring the lib would have silently closed
  a live red — `marketing-intel` is missing it while the other six projects have it.
  The name stays deliberately: `state-shape` is a ledger category in CONTEXT-BUDGET.md and
  a `transition_id` component in the v1->v2 SQLite contract.

### The three decisions the review changed

1. **Phase B is not a port.** The plan said "port `branch-registry.sh`". propagate already
   enumerates refs and worktrees in JS; porting shell would duplicate working code in a
   second language. It is a format widening plus persistence.
2. **Phase C splits 9-in / 6-out.** Absorbing all 23 makes propagate a general repo-hygiene
   tool.
3. **`rule:state-and-decisions` gets rewritten, not overridden.** It says `STATE.md` lives at
   each repo root; v3 says `propagation/state/<project>/`. `Vipin Kaushik/CLAUDE.md:141`
   already declares an `overrides:` for exactly this. **A rule all 7 workspaces override is
   not a rule** — so the rule changes and per-repo `STATE.md` becomes the deviation.

### The one critical gap

**Phase A's conformance check must be proven to fail on today's tree before any migration
runs.** It is the ratchet for B–E, and a ratchet that was never shown to catch anything is
the failure this whole document is about.
