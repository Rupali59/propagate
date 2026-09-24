# Plan: collapse 24 markdown parsers into one, and measure whether a database was needed

PR-003 asked whether propagation state wants a schema rather than files. Answered 2026-09-24:
**not yet.** Collapse the parsers, derive an index on demand, leave the files authored.

Rupali accepted that with one condition, and it is the most important line here:

> *"make sure we measure this, because otherwise we wont know whether the db is required or
> not."*

So this plan carries a falsification contract. Baselines were taken BEFORE any change; if a
tripwire fires, the answer was a database and we learn it from numbers rather than from feel.

## Why not a schema — the argument is a measurement, not a preference

`doctor` reports, today: **17/23 conform, 2 half-migrated, 4 never begun**, and propagate is
one of the two half-migrated. **The v3 propagation-layout migration is not finished.**
Starting a storage migration now means two incomplete migrations across ~20 repos, and *"a
partial migration is the state that loses data"* — `doctor`'s own words.

And the evidence does not indict files; it indicts having 24 readers of them. Every defect in
the 2026-09-23/24 sessions was a PARSER defect: a `## Finished` convention documented in two
files and unimplementable for id-keyed entries; a prose line that wrapped into a heading and
closed every entry below it (G69); a reader counting 87 prose tokens as 68 items (PR-006).
G26 is the sharpest — two `refs/snapshot.json` shapes **both stamped `schema_version: 1`**. A
schema field did not give them a schema. Storage would not have prevented one of these.

## Baselines, measured 2026-09-24

| metric | today | derive it |
|---|---|---|
| full-tree register parse | **0.27 s** (cold 0.60 s) | `time node cli.mjs backlog --json` |
| register files reached | **105** — 63 parsed, 39 stubs, **3 unparsed** | `node cli.mjs backlog` |
| modules parsing markdown | **24** | walk `lib/` for `.md` reads with `/^` regexes |
| line-anchored regexes | **97** | see §Verification |
| format/parse defects on record | **11** + 3 this session | `grep -E "^### N" ISSUES.md` |
| distinct CLI commands | **32** (37 dispatch arms) | depth-aware split of the usage string |
| `cli.mjs` | **225 KB, one file** | `du cli.mjs` |
| events outside any git remote | **2892** (N84) | `readEvents().events.length` |

`0.27 s` is what justifies on-demand: `rule:delegation-criteria` §2 replaced a 4,420-run
watcher with a command deriving the same answer in **1.2 s**.

## The measurement contract

| # | tripwire — if this fires, the DB was needed | baseline |
|---|---|---|
| T1 | full derive exceeds **3 s** | 0.27 s |
| T2 | the index acquires a **cache, state file or staleness check** | none exists |
| T3 | format/parse defects do not fall in the two months after | 11 + 3 |
| T4 | `unparsed` register files stay above 0 | 3 |
| T5 | a question needs a new bespoke parser after §3c | 24 parsers |
| T6 | line-anchored regexes in `lib/` do not fall below 40 | 97 |

**T2 is decisive, and it is the test set against the recommendation itself.** Persistence
creep means the derive-on-demand premise failed, which is exactly what a database is for.

## The collapse

**`handovers.mjs` is the parser to generalise**, because it is the one that got things wrong
in public and was hardened for it: `MARKER_WINDOW = 3` (*"WITHOUT THIS BOUND THE PARSER LIES,
and it did"* — it reported 2 sections closed and both were false) and `FENCE_RE` (documenting
the marker protocol inside `HANDOVERS.md` minted a **phantom section** reporting **closed**,
N51). G69 is precisely the defect `FENCE_RE` prevents, in a file whose parser lacks it.

It is also already the de-facto shared reader: self-contained, imported by both `backlog.mjs`
and `goals.mjs`. The hierarchy exists by accident; this makes it deliberate.

1. **`lib/docs/tokens.mjs`** — heading scan with depth and fence awareness, `markerWindow(n)`,
   closing-word detection in ONE place (today at least three), and **a refusal rather than a
   zero when a shape is unrecognised**.
2. **Route the readers through it, smallest blast radius first**: `goals` → `adoption` →
   `gotchas/parse` → `caps` → `backlog` (last: four item shapes, most consumers). Each step
   snapshots the live-tree parse, re-routes, asserts the snapshot is unchanged, then deletes
   the local regexes. **A step that changes a count stops and gets explained, never tuned.**
3. **`kindOf()` becomes authoritative.** `lib/report/doc-kind.mjs` already classifies
   documents and **no register parser imports it** — the system has one answer to "what kind of
   document" and 24 to "what is in it".
4. **`propagate index`** — derived, writing no cache and keeping no state. Not an
   optimisation: it is the property that makes it correct.

## Corrected 2026-09-24 while executing 3b — two of this plan’s own numbers were proxies

**`goals.mjs` was already collapsed.** The plan ordered it first of five parsers to route.
It does not parse structure at all: line 44 imports `parseHandovers` and line 145 calls it,
and its only local regexes (`DERIVED_BY_RE`, `WAIVED_RE`, `PROVENANCE_RE`) are CONTENT
markers. Nothing to route.

**So "24 parsers with 97 anchored regexes" was the wrong denominator.** A content marker
like `/^\s*\*{0,2}Derived by:?\*{0,2}\s*:?\s*(.*)$/im` is line-anchored and is exactly what
a tokenizer should be HANDED, not what it replaces. Counting it as duplication inflated the
target and mis-ordered the work. Re-measured by what each module actually implements:

| duplicated logic | modules |
|---|---|
| heading scan | **12** |
| fence handling | 4 -> **3** (handovers routed) |
| closing words | 3 — `backlog`, `registers`, `rollup` |
| marker window | 2 -> **1** (the logic; the VALUE stays per document kind) |

**The revised order follows the duplication, not the guess.** The window was the smallest
and most complete collapse (two copies to one) and is done. Heading scan across 12 modules
is the bulk and should go next, smallest consumer first. Closing words is 3 modules and is
where the `## Finished` divergence lived.

**T6 is therefore retired and replaced.** "Anchored regexes under 40" measured the wrong
population; it would have been satisfied by deleting legitimate marker patterns. The
replacement counts STRUCTURE carriers — modules implementing their own heading scan, fence
rule, window or closing-word list — and the target is 1 each. Baseline at this commit:
heading 12, fence 3, closing 3, window 1. Derive with the walk in Verification below.
## 3c WITHDRAWN 2026-09-24 — there are TWO taxonomies, and unifying them loses information

The plan said: *"`kindOf()` becomes authoritative. A document whose kind is `unclassified` is
reported as such and parsed by nobody."* Measured against the real files, that is a
REGRESSION, not a refactor:

| file | `kindOf()` | `registers.mjs` |
|---|---|---|
| HANDOVERS.md | **`kind: null, source: "undeclared"`** | `handovers` |
| TODOS.md | **`state`** | `todos` |
| ISSUES.md · GOTCHAS.md · STATE.md | agree | agree |

Making `kindOf` authoritative today would make every handover file unclassified and therefore
**parsed by nobody** — silently dropping the register that `HANDOVERS.md` exists to be. And
`doc-kind.mjs:86` groups `TODOS.md`/`TODO.md`/`CHANGELOG.md` under `state` DELIBERATELY.

**Because the two answer different questions.** `kindOf` classifies for CURATION — is this
document current, how does it rot. `registers.mjs` classifies for COUNTING — how many entries,
how many live. A `TODOS.md` rots exactly like a `STATE.md` (both are "what is true now"), and
also has entries a `STATE.md` does not. Both classifications are correct about their own
question, and collapsing them would answer neither.

**What IS a real gap: `HANDOVERS.md` is `undeclared`.** It has no kind at all, while being one
of the most-parsed document shapes in the tree. Whether it earns a KIND is a taxonomy
judgement with a stated admission bar — `doc-kind.mjs:33` records that `gotchas` cleared it by
being "the third member of the STATE / DECISIONS / GOTCHAS set and fit none of the other
eight". That is a decision for Rupali, filed rather than guessed, like PR-001 and PR-009.

**So 3c becomes: document the boundary, and close the HANDOVERS gap on a decision.** Not
"one classifier to rule them all", which was the fifth premise in this plan to turn out to be
a proxy for something subtler.
## Feature: which commands are used, and how often they fail

Requested by Rupali 2026-09-24. **The substrate exists, is live, and records the wrong
things**, so this is wiring.

`~/.propagate/runs` holds **330 records, 0 malformed**, every one shaped
`durationMs, edge_counts, refs, roots, run_id, ts`. There is exactly **one** `appendRun` call
(inside `reconcile`) and **one** production reader (`lib/claims/runs.mjs`). So **1 of 32
commands is instrumented, it does not record its own name, and nothing records a failure.**

`docs/SYSTEMS.md` already has the status `installed-never-invoked`, assigned today by a human
guessing. `rule:enforcement-watches-itself`: *"A capability nobody invokes is
indistinguishable from one that was never built, and its tests pass either way."* This makes
that status derivable.

- add `command`, `outcome` (`ok` | `refused` | `error`), `exit_code`, `argv_shape` (flag NAMES
  only — no paths, no values, no secrets), `duration_ms`
- **one wrapper at the dispatch boundary**, so all 32 commands record rather than 1
- **`refused` is not `error`.** `verify` declining a DIVERGED edge and `rollup` refusing a
  hand-edited file (exit 3) are the tool working; counting them as failures would bury the
  real ones — the same noise problem N87 is about
- `propagate usage`: invocations, failure rate, refusal rate, p50/p95 duration, and the
  **never-invoked list**
- a command with zero invocations is `never-invoked`, **not `0% failure`**
- existing 330 records stay valid: absent `command` reads as `reconcile`, stated not inferred

It also serves the contract: T3 and T5 are judged today by reading issue titles; with
per-command outcomes both become countable.

## Not in scope, named rather than dropped

`cli.mjs`'s 225 KB (blocks edge declarations — its own plan) · durability of the 2892 events
(separate, and first) · `CROSS_LEDGER_JSONL`'s two locations behind a migration flag (audit) ·
human-authored prose, where only machine-read MARKERS go through the tokenizer · finishing the
v3 migration, which is the constraint rather than the work.

## Goal state

**Done when:** one tokenizer serves every register reader, `kindOf()` is authoritative,
`propagate usage` reports per-command invocations and failure rate including the never-invoked
list, and none of T1–T6 has fired.
**Derived by:** `npm test` · `time node cli.mjs backlog --json` · `node cli.mjs usage`
