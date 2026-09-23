# Plan: make `doctor` tell the truth — census, honesty, legibility, in that order

Answers N87 (S1, open), filed 2026-09-17 against a direct question: *"how are we running
a system with this many defects, and doctor doesn't report it?"*

Brainstormed 2026-09-23. Three forks were put to Rupali and settled: output becomes a
terse gate **plus** severity **plus** kind-folding (not one of the three); severity
attaches to the **check class**, not the kind; a check that cannot run is **INCONCLUSIVE
and fails the gate**.

## Context

**Do not trust the numbers below — they are N87's, measured 2026-09-17, and this plan
does not re-measure them.** `doctor` runs slow enough that N91 records 18–24 minute
spikes, so a re-measure is its own task. Derive before acting:

```sh
node cli.mjs doctor --json                                # doctor own census + per-class counts
grep -c NON-CONFORMANT ~/Documents/GitHub/ECOSYSTEM.md  # rollup verdict — was 2 on 2026-09-23
node cli.mjs rollup --check                             # 0 current · 1 stale · 2 could-not-run · 3 hand-edited
```

N87 establishes three independent mechanisms, each individually sufficient to make
`doctor` report healthy while eight issues were filed in two days:

| # | mechanism | evidence (2026-09-17) |
|---|---|---|
| 1 | the population excludes the failures | `doctor` prints `16/16 conform`; `rollup` writes NON-CONFORMANT for 2. The two `doctor` omits — `Motion-Graphics`, `propagate` — are exactly the two that fail. Two worktree checkouts inflate the denominator |
| 2 | checks test properties a broken thing satisfies | `✓ ledger JSONL parseable — 0 rows` passes on all 17 empty ledgers. Conformance asserts `state/` exists, not that it holds anything |
| 3 | volume buries the signal | 515 assertion lines — 160 ✓, **354 warn across 299 distinct kinds**, 1 ✗ |

**Both commands already call the SAME conformance function. The divergence is the
POPULATION passed to it** — corrected 2026-09-23, after this plan first said "doctor
reimplements conformance", which is false. `lib/report/doctor/discovery.mjs:354` imports
`conformanceReport` from `lib/core/v3-layout.mjs` and calls it with `WORKSPACES`;
`lib/report/rollup.mjs:75` resolves its owners through `nearestOwner`, and says at :49:

> *"THE OWNER SET IS WIDER THAN `discoverWorkspacesSync`'S MARKER-BASED …"*

**So doctor's census is marker-based, and a marker is something a workspace only has once
it has adopted the layout.** The check for "did you adopt the layout" is gated on having
adopted it. A workspace that never started is not reported as failing; it is not reported
at all.

Verified live 2026-09-23, not taken from N87: `WORKSPACES` holds 20 entries and contains
neither `propagate` nor `Motion-Graphics` — exactly the two `rollup` marks
NON-CONFORMANT in `ECOSYSTEM.md`. (N87 said 16; it is 20 today. The number rotted in six
days, which is why this plan derives rather than restates.)

```sh
node -e 'import("./lib/core/config.mjs").then(c=>console.log(c.WORKSPACES.length,
  c.WORKSPACES.some(w=>String(w.root).endsWith("/propagate"))))'
```

`rollup.mjs:86` imports the canonical conformance deliberately, under a comment that says:

> *"the tool that enforces this layout is the tree's least conformant workspace. The
> first render of ECOSYSTEM.md must say so. A render that reports propagate as conformant
> means this check is wrong, not that the tool is clean."*

So mechanism 1 is not a design problem. It is a missing import, in the command whose job
is catching exactly this class of thing — `rule:enforcement-watches-itself` at the
population level, which the rule's own examples already name one layer down (*"a drift
gate installed in seven repos and not in the one that authored it"*).

**Nothing declared `doctor` and `rollup` coupled.** Two commands answer the same question
from different sources and drifted until one was simply wrong, with the right answer one
directory away — `rule:adversarial-review-reads-the-ledger`. Slice 1 closes the drift and
declares the edge so it cannot silently reopen.

## RE-MEASURED 2026-09-23 — N87 mechanism 1 is partly stale, and the plan is rebased

N87 says `doctor` prints `✓ 16/16 conform`. **It does not, today.** The render is
`lib/report/doctor/discovery.mjs:444-452` and its pass condition is
`rep.offenders.length === 0`. Measured now, against doctor own population:

| | value |
|---|---|
| verdict | **FAIL (red)** — not the green N87 describes |
| offenders | `Sindhu` — lacks README.md, INDEX.md, refs/snapshot.json, refs/lifecycle.jsonl |
| notStarted (info only) | `Grid`, `obsidian-vk-publish` |
| population | 20, excluding `propagate` and `Motion-Graphics` |

`Sindhu` joined the tree on 2026-09-22 and turned this check red by arriving. So the
specific claim "doctor is green while the tree is broken" cannot be demonstrated through
this check any more — it went red for an unrelated reason, six days after N87 was filed.

**What survives, and it is the part that matters.** The population still excludes
`propagate`. Added, it is an OFFENDER, not a notStarted — it holds `state/` and lacks the
other four — so it would be a **second half-migrated row**, and the tool still does not
watch itself. `Motion-Graphics` added is `notStarted`, which under the current design is
**info only and never fails the gate**.

**`conformanceReport` already has the three-state taxonomy this plan proposed inventing**
(`conforming` / `offenders` / `notStarted`, `lib/core/v3-layout.mjs:135-153`), under a
comment citing `rule:discernment-checks` §2. Do not add a fourth state called
`unadopted`; an earlier draft of this plan did, and it was wrong.

**Open design question this exposes, for Rupali:** should `notStarted` fail the gate?
Today three workspaces have never begun the migration and produce one `info` line. That is
a documented decision, not a defect — but it is the decision that decides whether slice 4
closes anything.

## Slice 1 — the census

`doctor` keeps calling `conformanceReport` — it already does. It stops calling it with a
marker-gated population.

- enumerate candidates the way `rollup` does (owner-based, `nearestOwner`), not by
  `WORKSPACES` from `lib/core/config.mjs`
- a directory that owns a tree but carries **no marker** becomes its own reported state —
  `unadopted` — never an omission. This is the whole defect: absence currently reads as
  conformance
- exclude worktree checkouts from the denominator (N88's shape: abandoned worktrees
  counted as workspaces, their warnings indistinguishable from real ones)
- `propagate` enters its own population, per `rule:enforcement-watches-itself`

**The acceptance test is cross-instrument, and it is the thing N87 lacked.** A test runs
both censuses and asserts the non-conformant sets are **equal**. Today nothing compares
them, which is the only reason the divergence survived. Written first; it must fail
against current `main` before any fix.

Declare the edge in `.propagates.yml`: `lib/core/v3-layout.mjs -> lib/report/doctor/discovery.mjs`,
alongside the existing rollup consumer, so a future change to the canonical layout
reaches both readers.

**Done when:** `doctor` and `rollup` name the same non-conformant workspace set.
**Derived by:** `npm test` — `tests/cli/doctor-census-parity.test.mjs`

## Slice 2 — honesty

One contract change, three consequences.

`ENTRY_KINDS` (`lib/report/doctor/reporter.mjs:46`, today
`["pass","fail","warn","info","note","header"]`) gains `inconclusive`:

- it carries a **mandatory reason string** — an inconclusive with no reason is the silent
  zero wearing a new hat, and `rule:discernment-checks` §2 is the whole point of the state
- it renders in its own block, never folded into green
- it **contributes to a non-zero exit**: a skipped check is not a passed check

Each check class declares `severity: "S1" | "S2" | "S3"`. A coverage test asserts every
class carries one, so an unclassified check cannot ship. A class emitting two severities
splits — which is normally a class doing two jobs.

Presence-assertions become content-assertions: *ledger parseable* → *ledger has rows*;
*`state/` exists* → *`state/` holds the required items* (N82, N84).

**This turns the gate red and keeps it red.** 17 empty ledgers stop being green ticks.
That is the intended outcome, not a regression — "doctor is green" becomes unachievable
until the tree is actually sound, which is what an S1 of this shape means.

**Done when:** no check reports `pass` on input it did not read, and every check class
declares a severity.
**Derived by:** `npm test` — `tests/cli/doctor-check-coverage.test.mjs`, extended with a
fixture whose ledger is empty and whose expected verdict is not `pass`

## Slice 3 — legibility

Default `doctor`: one line per check class; failures named; warnings only at or above the
declared threshold; the remainder a count with `--full` to read it.

`doctor --full`: today's detail, with the 354 rows folded into their kinds and counted,
rather than printed per branch.

`gotchas-global.md` states the admission bar this is measured against — *"otherwise this
file becomes the noise that hides the four that matter"*. `doctor` is past it by two
orders of magnitude, so even a correct new signal from slices 1 and 2 would not be seen.
Slice 3 is what makes the first two legible; it is last because it is worthless before
them.

**Done when:** default output names every failing class and every warning at threshold,
and nothing else.
**Derived by:** `npm test` — an output-shape assertion on `doctor`'s default render

## Slice 4 — migrate the two, so red is closable

A gate that goes red and cannot go green is a gate people route around. Slices 1-3 make
`doctor` tell the truth; this one makes the truth actionable. Measured 2026-09-23 with
`conformance()` — `V3_REQUIRED` is `["README.md","INDEX.md","refs/snapshot.json","refs/lifecycle.jsonl","state/"]`:

| workspace | missing | shape of the work |
|---|---|---|
| `propagate` | README.md, INDEX.md, refs/snapshot.json, refs/lifecycle.jsonl | has `state/` — 1 of 5. `migrate-refs` produces the `refs/` pair; the two docs are authored |
| `Motion-Graphics` | all five | no `propagation/` at all — full adoption, and it is a 2-commit repo with no CLAUDE.md |

`migrate-refs <workspace> [--apply]` already exists and is wired (`cli.mjs:1699`, under a
comment reading *"WIRED BECAUSE IT WAS NOT"* — the same rule, previously paid for). It is
dry-run by default; `rule:safety-flag-needs-a-test` applies to the `--apply` path and the
test asserting the store is untouched without it must exist before it is run in anger.

**HAZARD, G26 — do not run `migrate-refs --apply` until the snapshot schema is
established.** Two incompatible shapes both declare `schema_version: 1`:
`lib/refs/snapshot.mjs` writes a FLAT `refs: []`; the older `hygiene/branch-registry`
writes a NESTED `projects: { <name>: { refs: {…} } }`. `Vipin Kaushik` holds a live nested
one with 36 refs across 7 projects. Measured 2026-08-24, `diffSnapshots` read those 36 as
absent — `prev?.refs ?? []` — and emitted 4 spurious `created` records into
`refs/lifecycle.jsonl`, which is **append-only**, so they cannot be withdrawn.

**And G27 — both targets are FIRST RUNS, which is the case with a learned answer.** A
first snapshot labels every ref `baseline` ("existence before this moment is unknown"),
never `created`; enumeration reads `refs/heads` AND `refs/remotes/origin` minus locals
(reading heads alone reported 24 against the shell's 36, and 12 spurious prunes); pruned
refs carry a work verdict, where unmeasured is UNSAFE rather than fine. Assert all three
on the migration output before trusting it.

Neither target workspace has a snapshot today, so writing a fresh one is safe in itself;
the hazard is the version number, which cannot distinguish the two readers. Slice 4 must
read the shape before writing and refuse an ambiguous one, rather than trusting
`schema_version`.

**Order matters: migrate AFTER slice 1, never before.** Migrating first would make both
workspaces marker-bearing, so they would enter `WORKSPACES` and the census bug would
become unobservable — fixed by accident, with no test proving it was ever wrong. Slice 1's
parity test must go red against today's tree first.

**Done when:** `conformance()` returns `conforms: true` for both, and the census parity
test still passes.
**Derived by:** `node -e 'import("./lib/core/v3-layout.mjs").then(m=>["/Users/rupali.b/Documents/GitHub/propagate","/Users/rupali.b/Documents/GitHub/Motion-Graphics"].forEach(p=>console.log(p,m.conformance(p).conforms)))'`

## Withdrawn, with reasons

- **One pass over all three causes.** Touches `discovery.mjs`, the Reporter contract, all
  9 section modules and ~19 test files in one diff. Nobody can review that honestly, and
  the census fix — the cheapest and highest-truth-value of the three — would land buried.
- **Contract-first (Reporter vocabulary, then sections, then census).** Defensible, but it
  delays the one change that stops `doctor` lying, and slice 1 is orthogonal to the
  contract anyway.
- **Per-kind severity table (299 rows).** Most precise; 299 judgements up front, and a new
  kind defaults to unclassified, which then needs its own rule. The 299 kinds come from 14
  check classes — classify the emitter.
- **Severity derived from whether a warning invalidates a `Derived by:` command.**
  Principled and self-updating, but only 3 of ~16 workspaces have a `GOALS.md`, so most
  warnings would derive nothing.
- **Writing this spec to `docs/superpowers/specs/`** (the brainstorming skill's default).
  `plans --check` scans `docs/plans/` only — `lib/report/doc-kind.mjs:89` classifies a
  file as kind `plan` only under `plans/` with a dated basename. The skill's default would
  have made this plan invisible to the repo's own tooling, which is the exact failure the
  2026-09-16 plan was written to fix.

## Cost, stated honestly

19 `doctor` test files exist. Slices 2 and 3 change the Reporter's vocabulary and the
default render, so a meaningful number need updating — that is the bulk of the work, not
the production change. Slice 1 is small: imports, an exclusion, and one new test.

## Goal state

**Done when:** `doctor` and `rollup` name the same non-conformant set, and no check
reports `pass` on input it did not read.
**Derived by:** `npm test`
