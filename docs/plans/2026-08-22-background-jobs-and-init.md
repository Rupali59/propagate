# 2026-08-22 — the ref pair, `init`'s layout, and two dead background jobs

**Status: done.** Commits `fd322cd`, `eddfb35`, `7dc0729` plus hub `134d087`. Recorded here
because `~/.claude/plans/` is session scratch and rots — `docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md`
exists precisely because a reviewed plan carrying seven decisions was overwritten and
survived only in a transcript.

The launchd measurements below are reproduced **verbatim** and are the reason this file
exists: they cannot be reconstructed now that the plists are regenerated and the logs have
started moving again.

---

## What was actually wrong

Four defects, three of them found while verifying the first. They share a shape:
**propagate described each failure fluently, in prose, and detected none of them.**

| # | Defect | Where it was already written down |
|---|---|---|
| 1 | An event named the ref of one end while pinning the content of two | `reconcile.mjs:16` described the two-sided context correctly |
| 2 | `init` created a **superseded** ledger layout in both branches | `DECISIONS.md`: *"the location remains an accident of directory layout at first-write time"* |
| 3 | `doctor`'s monitor probe could not fail | `cli.mjs` and `SYSTEMS.md` both described the exact failure |
| 4 | The cutover's rollback cited a deleted path | — |

---

## 1 · The event ref is a pair (`fd322cd`)

Three ref shapes coexisted, and the event had the only one that could not express a
cross-repo observation:

```
ROW    pair  — source.ref / downstream.ref      reconcile.mjs:251
RUN    map   — keyed by repo root               runs.mjs:79
EVENT  scalar— observed_on_ref                  provenance.mjs:164
```

`reconcile()` had always accepted `refs:{source,downstream}`; nothing ever set it.

- `observed_*` keeps meaning the **source** end. Renaming to `source_*` would orphan 1,912
  existing events for cosmetic symmetry.
- `validateEvent` requires both refs as **present keys**, not truthy values: `null` is
  meaningful (resolution failed, carrying its own `*_error`), so absent / `null` /
  `"working-tree"` stay three distinguishable facts.
- **Nothing backfilled.** The 1,912 pre-existing events keep their absent downstream fields
  because their downstream ref is genuinely unknown.

Field set: `docs/DATA_MODEL.md` §10 — the v2 event schema, which until this change was
documented in **no** file.

Re-measured while doing it: **114 of 860 edges (13.3%)** are cross-repo, not the 113/13.2%
carried in `STATE.md`.

## 2 · `init` and the canonical layout (`eddfb35`)

N24 said `init` doesn't create the ledger pair. It does — at a **superseded path in both
branches**. Measured on temp workspaces before the change:

```
no docs/   ->  .propagation/ledger.{jsonl,md}
has docs/  ->  docs/PROPAGATION_LEDGER.{jsonl,md}
```

Neither is canonical, so **`init` could not produce the canonical layout at all** — every
stranger install minted a third layout while the 2026-08-21 consolidation was cleaning up
the first two.

Safe because only the no-ledger-anywhere branch moved; the pinning rule is untouched.
**Measured after: all 7 live workspaces already canonical, 0 relocated.**

`init` now asserts the pair and exits 1 naming the missing files. Verified against a
read-only directory.

**Two tests were pinning the accident**, each naming it in its own comment ("the legacy
convention applies"). That pairing is why it survived: the decision record said it was
wrong and the tests said it was expected.

## 3 · The monitor probe can now fail (`7dc0729`)

It was `info(...)`, printing the last run's timestamp **without comparing it to now**.

**The gate is the PLIST, not the log.** The old comment was right that "not armed" must
never fail a fresh install — that constraint is real and is why this stayed toothless. But
it treated *armed* and *ran recently* as the same unknowable thing, when armed is one
`existsSync`.

**The crash tell** is the cheaper half: `monitor.log` records only SUCCESSES, so a dead
agent's log is indistinguishable from an idle one's, while `monitor.stderr.log` keeps
growing. Two mtimes distinguish *loaded and failing* from *merely quiet*.

Known limitation, documented not fixed: the crash tell is **sticky** — stderr stays newer
until the next successful run, so between a fix and the next interval it still reports
crashing. Bounded by one interval, and errs toward alarming rather than silent.

---

## The launchd evidence — verbatim, and unreconstructable

**Before.** Both plists pointed at `~/.claude/skills/propagate/`, deleted by the plugin
cutover. `SKILL_DIR` self-locates (`config.mjs:77-93`), so the plists were stale artifacts,
not a code defect.

```
$ launchctl list | grep propagate
-	0	com.tathya.propagate.digest     # stale exit code, from Aug 21
-	1	com.tathya.propagate.monitor    # actively failing

monitor.log         mtime 22 Aug 13:36   last line 2026-08-22T08:06:09.505Z
monitor.stderr.log  mtime 22 Aug 16:25   35 KB of identical MODULE_NOT_FOUND
DAILY.md            mtime 21 Aug 10:47   ≈30h, against a declared 25h probe
propagate-digest-state.json  lastRunAt 2026-08-21T05:17:00.738Z

Error: Cannot find module '/Users/rupali.b/.claude/skills/propagate/cli.mjs'
  code: 'MODULE_NOT_FOUND'
```

**`doctor` reported `all green` throughout.**

**The regeneration.** Run from the repo working tree so `SKILL_DIR` bakes in a path that
never moves; both jobs are read-only derivations writing only to `~/.propagate/`.

```
node cli.mjs monitor --install     # wrote the plist, 12 watch path(s)
node digest.mjs --install          # wrote the plist
```

Neither touches `launchctl` — `plist.mjs`'s stated contract keeps launchd the human's.
Rupali ran the four `bootout` / `bootstrap` commands.

**After.**

```
$ launchctl print gui/$(id -u)/com.tathya.propagate.monitor
	arguments = { /opt/homebrew/bin/node
	              /Users/rupali.b/Documents/GitHub/propagate/cli.mjs
	              monitor }

digest   ran 2026-08-22T11:51:06.975Z  (17:21:06 local) — DAILY.md gained a section
monitor  ran 2026-08-22T12:00:04.931Z  (17:30:04 local) — 860 rows, 0 actionable, 3452 ms

$ node cli.mjs doctor
  ✓ monitor is running on schedule  last run 0 min ago
doctor: all green
```

The 17:26:01 stderr entry between them is the **old** job firing on its interval, between
the plist rewrite (17:19:25) and the bootout. It cleared on the 17:30:04 success — the
sticky-stderr window, observed and self-healing exactly as predicted.

### The finding the reload produced

**`WatchPaths` went 20 -> 12, and all eight dropped paths still exist on disk** —
`Keerti-portfolio`, `keerti-job-radar`, `Manav-portfolio`, `SSJK-mb` and their `docs/`. They
stopped being *workspaces* in the 2026-08-21 consolidation ("one folder, at depth 1, never
per sub-project").

So the old plist carried **two** independent staleness problems and only one announced
itself. The dead script path produced 35 KB of stderr; the eight phantom watch paths
produced nothing, because watching a directory that no longer needs watching is not an
error. Filed as **N46**, which also records that launchd `WatchPaths` is **not recursive** —
so `ws.root` never caught a nested source edit either, and the real trigger has always been
`StartInterval 1800`.

---

## Which job monitors the ledgers

**The digest, not the monitor** — a question worth settling because the obvious answer is
wrong.

```
digest.mjs:477-490   for (const ws of WORKSPACES) ledgerSnapshot(ws.ledgerJsonl)
                     + ledgerSnapshot(CROSS_LEDGER_JSONL)
                     -> open/done/wontfix counts, lastActivityAt,
                        findDuplicateOpenAcrossLedgers(ledgerEntries)

monitor.mjs:21       "it writes no drift rows. Not to a ledger, not to the v2 event store"
                     ^ the only mention of a ledger in the monitor
```

Ledger monitoring was built, wired and running, and stopped on 2026-08-21 10:47 when the
cutover broke the path. This is why widening `watchPathsFor()` to `propagation/` is the
**wrong** fix for the obvious want: the monitor never reads a ledger, and the digest is
time-triggered and needs no `WatchPaths` at all.

---

## Also corrected here

- **`G56` / `N44`**, written earlier the same day, named the wrong cause. `npm test` scopes
  `PROPAGATE_STATE_DIR` (`package.json:test:propagate`); the two junk events landed because
  `node --test <file>` was run **directly**. The same tests are safe or unsafe depending
  only on how the process was launched, and **all eight test files that call `appendEvent`
  have this property** — two were hardened. Residual: the safety lives in a `package.json`
  string that no test asserts.
- **The rollback.** `~/.propagate/uninstall-capture-2026-08-22.json` cited
  `~/Documents/GitHub/propagate-skill`, removed by the rename that FOLLOWED the capture.
  Repaired, and every path it now cites was verified present.

## Left open

- **N41** — cross-branch dedupe discards a differing disposition. Blocks `--all-refs`.
- **N42** — `renderMarkdown` has no live caller.
- **N45** — 3 of 10 gotcha triggers are inert; `--selftest` passes anyway, because it
  validates each regex against a literal its own author wrote.
- **N46** — `watchPathsFor()` hardcodes `docs/`; stale watch paths are undetectable.
- **N35**, **N38**, and the `cli.mjs` split (`STATE.md` item 4).
