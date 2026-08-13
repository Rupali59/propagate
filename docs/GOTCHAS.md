> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# Gotchas — running observations

`docs/ISSUES.md` records **defects**. This records **lessons**: patterns that cost
us something, each with the concrete instance that taught it. Append as they arrive;
never delete one because it feels obvious now.

Every entry must carry its evidence. A gotcha without the incident behind it is
advice, and advice is easy to nod at and ignore.

Started 2026-08-13.

---

## On checks and signals

### G1 · A check that cannot fail is worse than no check
It reports success. A missing check at least leaves a visible hole.

Three instances in one session, all different shapes:
- `lib/decisions.mjs` matched a bare `Affects:` while every entry writes
  `**Affects:**`. 8 entries parsed, **0 tokens**, and a pre-commit gate passing on
  an empty set.
- `readLedgerWithStats` computed `unknownTypes` and `readLedger` threw it away.
  Every caller blind. A `manual` row was invisible for **two months**.
- `pathProblems` was declared, then checked (`if (pathProblems === 0)`), and
  **never incremented**. The "sidecar downstream paths resolve" check could not fail.

**Do:** for every check, ask "what input makes this fail?" and write that test. If
you cannot construct one, the check is decorative.

### G2 · Absence is ambiguous — make it attributable
"No result" and "no result *because* —" are different facts. Conflating them is this
codebase's entire failure class.

Zero open rows meant healthy *or* discovery found nothing. A green `doctor` meant
healthy *or* blind to a second ledger. `markStatus` returning meant closed *or*
written to the wrong ledger. Empty `Affects:` tokens meant no targets *or* a regex
that never matched.

**Do:** every absent value carries a reason — `no-repo`, `not-found`, `timeout`,
`CONTENT_UNAVAILABLE`. Never a bare null. When a check times out, say `status
unknown`; never a pass, never silence.

### G3 · A metric without an expected range is decoration
298 open rows were accurate for months and read by nobody. Accuracy was never the
problem; **actionability** was.

**Do:** ship every gauge with the assertion that makes it alertable. A gauge at zero
means nothing until you have declared it should be non-zero. `close.calls == 0`
would have exposed "there is no close path" as a single number, for months.

### G4 · Nested scopes multiply every finding
Workspace roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃ `SSJK-mb`), and each scanned
its own subtree. **One** sidecar defect printed **three times**; 4 real defects
presented as 11 problems, and 43 scans covered 21 unique files.

**Do:** deduplicate by the *artifact* being reported on, not the scope doing the
reporting, and assign to the nearest owner. Key by `realpath` — symlinks and
worktrees make one file reachable by several paths.

---

## On measurement

### G5 · Measure before optimising. My prediction was wrong.
I claimed deduplicating sidecar scans would make `doctor` faster. It did not.
Measured: `claude mcp list` was **17.8s of a 19s run** — 94%. Ledger reads were
102ms. The work I "optimised" was never the cost.

**Do:** time the parts before choosing one. Record null results — this one is in a
commit message specifically so nobody re-derives it.

### G6 · The cost is usually subprocess spawns, not work
`git hash-object` per file: ~10ms each, **~9s** for a 910-file repo. `git ls-files -s`
returns every tracked blob sha in **10ms**, and hashing all 910 in Node takes 150ms.

**Do:** count spawns before optimising algorithms. One call per repo, not per file.
Assert it with an injected spawn counter, never with timing — a timing-based test is
the flaky test that gets deleted, taking the guarantee with it.

### G7 · A health check must not cost more than the thing it checks
`doctor` spent 94% of its runtime discovering a state that was known, expected and
documented as deferred. An unbounded synchronous shell-out inside a health check is
a liveness risk, not merely slow.

**Do:** bound every subprocess in a health path. Cache the result — **including the
unknown**, rather than fabricating an answer to avoid re-paying the cost.

### G8 · Measuring through a pipe reads the wrong exit code
`cmd 2>&1 | tail -2; echo $?` reports `tail`'s status. I briefly believed a failed
close was exiting 0 — a phantom bug that would have sent someone hunting.

**Do:** measure exit codes directly, no pipe.

---

## On changing a live system

### G9 · A fix can be a bigger outage than the bug
A schema constraint rejecting a trailing `/` turned one bad path into a wholly
non-loading sidecar: **40 edges across 10 sources inert for ~2 hours.**

**Do:** validate per entry, not per file. Ask of any new constraint: *can this
disable something that previously worked?* Weigh it against the files already on
disk, not just the shape you mean to catch. (Mirror of the existing rule, "schema
before field.")

### G10 · A tool that cannot be tested safely will be tested unsafely
`PROPAGATE_SEARCH_ROOTS` scoped discovery but not state, lock, heartbeat, log or
plist. **Four incidents in one day**: a state wipe that fired ~120 spurious rows, a
plist overwritten with 0 WatchPaths (twice), and `npm test` writing fixture paths
into the production log. Every one came from someone — including me — trying to test
safely using the documented method.

**Do:** one override moves *all* the paths together. Until it does, there is no safe
manual run, and the docs must say so.

### G11 · Zero is never a legitimate output for a destructive write
`regeneratePlist` cheerfully wrote a plist with **0 watch roots** over a working one,
because discovery legitimately found 0 workspaces in a temp tree.

**Do:** refuse the empty case explicitly. One guard would have prevented that
incident entirely.

### G12 · A default that moves loses state silently
Adding `PROPAGATE_STATE_DIR` was safe; accidentally relocating `state.json`'s
*default* would have lost the mtime baseline and re-fired every file as
first-observation — the same incident, at full scale, caused by its own fix.

**Do:** when adding an override, test that the unset case resolves byte-identically
to today. That test exists purely to guard the fix.

---

## On verification

### G13 · Verify the work, not the report
Agent reports this session were accurate and still incomplete. Checking directly found:
`DIVERGED` at 39% was inflated by glob expansion (23% on the non-glob subset); the
open-count reconciliation exposed 39 rows closed with no audit trail; and an
exit-code claim I could not reproduce turned out to be my own pipe error.

**Do:** re-run the load-bearing claim yourself. A report saying "verified" is a claim
about verification, not verification.

### G14 · Stale references propagate — including through me
I cited `Utility/scripts/generate-personas.js` in a plan as existing. It does not;
`Utility/` holds only `chaukidar/`. I also argued "not everything watched is in git"
as a design rationale — measured, **zero of 201 edges** have a side outside git. Both
came from reading a stale doc instead of the disk.

**Do:** check the filesystem before citing a path. In a codebase whose defining
problem is documentation drift, quoting its docs as evidence is circular.

### G15 · Grepping for concepts gives false confidence
Auditing which findings were registered, my concept-greps produced three hits that
were adjacent mentions, not entries.

**Do:** grep to find candidates, read to confirm. Never let a match count stand as an
answer.

### G16 · An expected number is a prediction, not a target
I predicted `doctor` would land on 4 problems. It reported 5 — and the extra was a
real pre-existing double-count, surfaced only because the agent explained the
difference instead of tuning toward my number.

**Do:** state expected outcomes as predictions and treat a mismatch as information.
Never tune a check until it produces the expected number.

---

## On this codebase specifically

### G17 · You cannot reconstruct what was never recorded
After the state-wipe incident, "which of these 54 rows are real?" was answerable only
because we had *just* built content hashing. v1 stores no content, so the same
question about any older row is permanently unanswerable.

**Do:** when a post-mortem question cannot be answered from the data, that is a
data-model finding, not a tooling gap.

### G18 · Hand-written data is a symptom, not sloppiness
**87%** of one ledger (578 of 664 rows) was hand-authored — provable from the
`JSON.stringify` spacing tell. The cause: `markStatus` had **zero production
callers**, so there was no supported close path and everyone improvised. A vocabulary
grew that no schema ever saw (`wontfix_reason` on 556 rows, written and read by
nothing).

**Do:** when data is being written around the tool, ask what the tool refuses to do.
The workaround describes the missing feature precisely.

### G19 · Deriving beats remembering
v1 remembers state in one mutable file; losing it does not lose drift, it **invents**
drift. v2 derives state from content, so losing the cache costs one slow run.

**Do:** prefer state that is a pure function of the world plus an append-only log.
Then "what is the state?" and "what was the state?" are the same question.
