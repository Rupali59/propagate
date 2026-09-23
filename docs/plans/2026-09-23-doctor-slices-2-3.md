# Plan: doctor slices 2 and 3 — an honest verdict, and a report someone can read

Follows `docs/plans/2026-09-23-doctor-tells-the-truth.md`, whose slice 1 landed in
`b164a9f`. PR-002 in `propagation/state/workspace/TODOS.md`.

## Context — what slice 1 settled, and what it did not

Slice 1 fixed the POPULATION: `doctor` now answers conformance over the same census
`rollup` uses and names itself a half-migrated offender. Two mechanisms remain.

**Do not restate the runtime counts below — they are N87's, measured 2026-09-17, and
this plan does not re-derive them.** `doctor` is slow enough that N91 records 18-24
minute spikes. Derive before acting:

```sh
node cli.mjs doctor --json    # then count entries by kind, and distinct labels within warn
```

### The static surface, measured 2026-09-23 (this IS re-derived)

| module | check | warn | info | note |
|---|---|---|---|---|
| discovery | 24 | 0 | 17 | 0 |
| environment | 15 | 1 | 10 | 2 |
| workspaces | 14 | 4 | 9 | 1 |
| backlog | 2 | 0 | 3 | 2 |
| registers | 2 | 1 | 5 | 0 |
| delivery | 1 | 3 | 2 | 0 |
| decisions | 1 | 0 | 1 | 1 |
| reporter | 1 | 0 | 1 | 0 |
| **total** | **60** | **9** | **48** | **6** |

**This corrects N87's framing twice.** It says "14 distinct check classes"; there are
**60** `reporter.check` call sites. And the 354 warnings it counts come from **9 static
`warn` sites**, not from a wide surface.

### Mechanism 3's root cause, and it is five call sites

**The label carries the IDENTITY and the detail carries the EXPLANATION — backwards.**
Five of the nine warn sites sit inside loops and interpolate their label from the row:

```js
registers.mjs:115   warn(`${row.file} is ${row.lines} lines (cap ${row.cap})`)
workspaces.mjs:239  warn(`${rel}: ${src} -> ${d.path}`, "glob matched 0 files")
workspaces.mjs:340  warn(`  ${f.project}/${f.ref}`, f.why)
workspaces.mjs:378  warn(`  ${e.project}/${e.ref}`, ...)
delivery.mjs:174    warn(...)  // in a loop
```

So "299 distinct kinds" is not a wide problem surface. It is **one row per kind, by
construction** — no two rows can ever fold, because the kind is computed from the row.
Slice 3 is therefore small: swap label and detail at five sites so the label is the
stable kind and the row goes in the detail. Folding then works with no classifier, no
severity table, and no per-kind judgement.

## Slice 2 — an honest verdict

### 2a · `inconclusive` joins `ENTRY_KINDS`

`lib/report/doctor/reporter.mjs:46` freezes
`["pass","fail","warn","info","note","header"]`. Add `inconclusive`, and with it:

- a **mandatory reason string** — an inconclusive with no reason is the silent zero in a
  new costume, and the state exists precisely for `rule:discernment-checks` §2
- its own render block, never folded into green
- it **contributes to a non-zero exit**: a skipped check is not a passed check

`Reporter.problems` is the run-global accumulator that decides the exit code
(`reporter.mjs:54`), so inconclusive increments it. The comment there warns against
double-voting; follow the existing `check()` shape rather than inventing a second path.

### 2b · Severity on the emitter

Each check class declares `severity: "S1" | "S2" | "S3"`. A coverage test asserts every
class carries one, so an unclassified check cannot ship. 60 call sites is too many to
classify individually — severity attaches per SECTION MODULE (8 of them) with a
per-call override, which is the same "classify the emitter, not the kind" argument that
settled the original fork.

### 2c · Content assertions replace presence assertions

**The case that proves this, found while building slice 1 and deliberately left:**

```
{"kind":"pass","label":"workspaces conform to the v3 propagation layout","detail":"0/0 conform"}
```

`rep.offenders.length === 0` is trivially true over an empty population, so "I looked at
nothing" and "I looked and all was well" are the same green tick. Every check whose
predicate can be satisfied by an empty input becomes `inconclusive` instead: conformance
over an empty census, `ledger JSONL parseable` over 0 rows (N84), `state/` exists rather
than holds anything (N82).

## Slice 3 — a report someone can read

1. **Swap label and detail at the five loop sites.** Stable kind in the label, row data
   in the detail. This is the whole of the folding work.
2. **Default render**: one line per check class; failures named; warnings at or above the
   declared severity threshold; the remainder a count with `--full`.
3. **`doctor --full`**: today's detail, folded by kind with counts.

`gotchas-global.md` states the bar this is measured against — *"otherwise this file
becomes the noise that hides the four that matter"*.

## Cost, stated honestly

19 doctor test files exist, and slices 2a and 3 change the Reporter vocabulary and the
default render. A meaningful number will need updating; that is the bulk of the work.
Slice 1 cost five red tests from one semantic change (unconditional self-inclusion), so
budget for the same shape here.

## Goal state

**Done when:** no `doctor` check reports `pass` on input it did not read, every check
class declares a severity, and the default render names every failure and every warning
at threshold and nothing else.
**Derived by:** `npm test`
