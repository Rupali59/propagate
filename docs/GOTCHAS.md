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

### G20 · A second reporting mechanism duplicates the first unless you delete the first
Three times in one session I added a second way to report a fact and left the first
one running: `pathProblems` (an aggregate restating per-entry `check()` failures),
the directory-as-downstream aggregate, and then `doctor`'s `EXPECTATIONS` table
asserting the same five subjects an inline `check()` already asserted. The count is
the tell every time: 4 genuinely distinct defects rendered as 5 printed problems,
found only by reading the output and noticing the extra ✗ line, never by reasoning
about the code in the abstract. An inflated count is not neutral — it is exactly how
a red check becomes background noise nobody re-reads.

**Do:** when a metric already gets computed and reported somewhere, adding a second
place that reports it is a rewrite, not an addition — the old one must be deleted or
demoted to informational (never a `✗`) in the same change. Before shipping a new
assertion, grep for the fact it asserts; if it already has a home, that's the one
place it gets to fail from.

### G21 · Cleaning up test leakage with `rm -rf` on tomorrow's production path
Building the v2 event store, an agent's tests leaked writes into the real default
`~/.propagate/events`. It noticed, fixed the scoping — and cleaned up with
`/bin/rm -rf ~/.propagate`, having inspected only the `events/` subdirectory.

**It was harmless, and only by timing.** `~/.propagate` held nothing but that
session's test leakage; v1's state lives under `SKILL_DIR` and was untouched
(verified: `state.json` 208 tracked files, heartbeat fresh, every ledger intact).
But `~/.propagate` is *precisely* where the v2 store lives once it is wired in. The
same command, run a month later, destroys every verification the system has.

Note the shape: the leak itself is G10 again (a tool that cannot be tested safely
will be tested unsafely), but the **cleanup** is the new hazard. Remediation reached
for a bigger hammer than the mess required.

**Do:** delete exactly what you created, never its parent. Prefer a scoped temp dir
you own outright over cleaning up inside a real path. Before any recursive delete,
ask what that path will hold *next release*, not just what it holds now — a cleanup
that is safe today and catastrophic later is a landmine with a timer.

**Update 2026-08-14:** `~/.propagate/events` now holds **379 baselined events** —
the v2 store went live with `bootstrap --apply`. The window this entry described as
hypothetical has closed. The same command run today destroys every verification the
system has.

### G22 · A safety flag is a claim, and claims need a test
`digest.mjs`'s header promised `--dry-run — print, write NO state`. It was false.
`dryRun` existed only inside `runDigest()`, gating state-writing and delivery, while
`buildSnapshot()` → `lifecycleSweep()` called `lc.reap(candidates, { apply: true })`
**unconditionally**. Running the documented preview performed an armed skill
deletion.

Nothing was lost, and only by luck: zero skills were quarantined when a subagent
found it — while refusing to run `--dry-run` on production precisely *because* it had
read the code first rather than trusting the flag.

Note what the inner guards did and did not do. `reap()` archives before deleting and
refuses when disarmed, so the blast radius was bounded and recoverable. Neither guard
makes the *documented* claim true, and both are invisible to the person reading
`--dry-run` and reasonably concluding it is safe.

**Do:** every safety flag gets a test asserting the unsafe path is unreachable when
it is set. A flag is an API promise, and this codebase's whole subject is promises
drifting from behaviour. Inner mitigations bound damage; they do not substitute for
the guarantee on the label. When a flag threads through several layers, assert each
link — this failed because a parameter did not reach its call site, not because
anyone misunderstood the intent.

---

## On instruments — the tools you measure with

Added 2026-08-14/15. Every entry below cost a wrong answer that was *published* before
being caught, and several were caught only because a second method disagreed. The theme:
**when a number surprises you, suspect the ruler before the data.**

### G23 · `awk -F'|'` cannot parse a Markdown table, and its noise conceals real defects
Table cells escape pipes as `\|`. `awk -F'|'` splits on those too, so column counts come
out wrong for rows that are perfectly well-formed.

Twice, one week apart. First it reported `docs/SYSTEMS.md` columns "inconsistent" when
every row was correct. Then — after that lesson was recorded — a new row was added with an
**unescaped shell pipe inside a `liveness_probe` command**, a genuine 10-column defect, and
`awk` reported 9/10/11 across the table. The one real fault was indistinguishable from the
usual false ones.

**Do:** split on unescaped pipes only — `re.split(r'(?<!\\)\|', line)`. A noisy instrument
is not merely useless; it is a hiding place.

### G24 · `grep -c` exits 1 when the count is zero, so `|| fallback` fires on a valid answer
`n=$(git cherry main "$b" | grep -c '^+' || echo "?")` prints **`0`** *and then* `?`,
because `grep -c` returning `0` is still exit status 1. The branch table came out as
interleaved `0` / `?` lines and had to be thrown away.

**Do:** `|| true`, never `|| <fallback-value>`, after any counting grep. Related to the
standing one: `cmd | head; echo $?` reads `head`'s status, not `cmd`'s.

### G25 · `--` before a grep pattern turns every later flag into a path
`command grep -rn -- "--accent" --include="*.md" "Vipin Kaushik"` searches **everything**,
including `node_modules`. `--` ends option parsing, so `--include=*.md` is read as a file
argument. Caught only because the output was 233 KB when a handful of lines was expected.

**Do:** put `--include` *before* `--`, or use `-e "--accent"` for a leading-dash pattern.

### G26 · `git ls-files <dir>` takes a path relative to the repo root, not to `cwd`
A tree-wide backing audit called every Motherboard sub-service `NO-REPO` — including
`motherboard-api` — because the path was resolved against the wrong base. The nine core
services of the largest repo in the tree read as unbacked.

**Do:** `cd "$d" && git ls-files .`, or pass a root-relative path. And when a sweep says
something implausible about a well-known directory, distrust the sweep first.

### G27 · Absence at the path a document *guessed* is not absence
`TODOS.md` said "author `scripts/smoke/prod-smoke.sh`". `test -f` on that path failed, and
it was reported as never built. It exists at
`motherboard-infra/infrastructure/smoke/prod-smoke.sh`. Same error for `bootstrap.sh`,
`deploy.sh`, and the compose core/plugins split — **four "missing" deliverables, all
present**, inverting the finding: that backlog was not a list of undone work, it was a
list of finished work nobody ticked.

**Do:** search for the **artifact** (`find . -name "*smoke*.sh"`), never for the path a
plan predicted. A backlog records where someone *intended* to put a file.

### G28 · An append-only ledger's `open` lines are not its open rows
A row closed later keeps its original `open` line forever. `grep -c open` across the tree
gave **501**; folded by last-status-per-id the answer was **8** — wrong by 62×, and
published before it was caught.

**Do:** fold, never count. `readLedger` exists for this. Any figure derived by counting
raw lines in an event log is a different quantity than the one you meant.

### G29 · Reconciling plans by task-id citation under-reports in four independent ways
`git log --grep="(T5)"` against the `(T<n>)` convention produced a table that read
authoritative and called delivered work abandoned:

- **Ranges** — `feat(hygiene): T22–T27` ships six tasks; `grep "(T25)"` finds nothing.
- **Repo-locality** — the plan lives in `Tushar/`, the commits in `Youvan-mb`.
- **Divergent schemes** — astroacharya uses `(Task N)`; Tushar uses `TE1-TE11`.
- **No git trace at all** — one task landed in `~/.claude/settings.json`.

Tushar's plan scored 0 of 20 and had in fact shipped completely.

**And the inverse is the sharper lesson:** the two GA4 plans had the *healthiest* citation
ratios in the tree and the most wrong premise — both targeted a GA4 property that did not
exist, costing ten days of conversion data. **Citation density measures convention
compliance, not delivery, and never correctness.**

### G30 · Assertions against CLI output must strip ANSI first
A test asserting `/✗\s*no unowned ledger files/` failed while the check was firing
perfectly. Raw stdout is `\x1B[31m✗\x1B[0m no unowned ledger files` — the escape sequence
sits between the glyph and the label. The terminal had stripped it; `spawnSync` had not.

**Do:** `const plain = (s) => s.replace(/\x1B\[[0-9;]*m/g, "")` before matching. The bug
looks like the feature is broken, which sends you to fix working code.

### G31 · `find -type f` does not follow symlinks
`Motherboard/skills/` reported **0 files**. It holds **35 symlinks** into
`.agents/skills/`. Nearly written up as an empty directory.

**Do:** `find -L` when a directory is legitimately a link farm — and note that
`readdirSync(dir, {withFileTypes:true})` has the same shape of trap: a `Dirent` for a
symlinked directory answers `isSymbolicLink()`, **not** `isDirectory()`.

### G32 · Fixing an under-count by counting everything produces an over-count
`status --all` reported 4 open where the tree had 8, because two ledgers were unreachable.
The obvious fix — count them — would have been wrong: one of those ledgers is a
**branch-time snapshot** whose 40 ids all exist in its parent, and whose single `open` row
is already `done` upstream. Counting it moves 4 → 8 when the truth is **7**.

**Do:** classify before aggregating. `rule:discernment-checks` §5 — state what the
measurement is over, and check it is the same thing the claim is about. Two ledgers that
both contain "id 39" are not two findings.

### G33 · A backup in a job-scoped temp directory is not a backup
Three pre-edit `CLAUDE.md` files were saved to `~/.claude/jobs/<id>/tmp/unversioned-backup/`
before being rewritten, because their source directories (`Keerti/`, `Tathya/`) are not git
repos and there was nowhere else to put them. It was flagged the same day with *"if these are
not brought under version control soon"*. A day later both sources were still unversioned and
that temp directory was still the only copy — and it is deleted with the job.

The wording is what let it sit: **"soon" is not a deadline and "should be" is not an owner.**
An item whose completion condition cannot be evaluated cannot be found incomplete, so it never
appears on any list of outstanding work.

**Do:** when the only copy of something lands anywhere ephemeral, either move it somewhere
durable in the same session or write the item with a condition a later reader can *test* —
"`Keerti/.git` exists" is checkable; "brought under version control soon" is not. Same failure
mode as G14: the record was written correctly and still decayed, because nothing re-read it.

### G34 · Relocating a risk is not resolving it, and the doc will imply otherwise
`rupali-varga-charts/` — 30 files, no `.git` at all, called *"the highest data-loss risk in the
tree"* by the hub `CLAUDE.md` — was moved from the top level to `Rupali/` as a personal project.
Every reference updated, a row added where it had none. It is exactly as unbacked as before:
`Rupali/` is a *container* of independent repos, not a repo.

The hazard is that the move generates a flurry of legitimate-looking activity — commits,
updated tables, a new row — none of which touches the actual exposure. A later reader sees a
tidied entry and infers it was handled.

**Do:** state the residual risk in the same edit that performs the move, in the entry itself,
not only in the commit message. `rule:discernment-checks` §2 — absence must be attributable;
so must non-resolution.
