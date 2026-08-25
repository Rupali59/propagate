> Entry point: [`../skills/propagate/SKILL.md`](../skills/propagate/SKILL.md) · Index: [`README.md`](./README.md)

# Gotchas — running observations

> **Paths in entries below may predate 2026-08-20**, when `lib/` and `tests/` were
> grouped into directories. `docs/DECISIONS.md` 2026-08-20 carries the old→new map.
> Entries are not rewritten: the citation is evidence, and evidence is not edited.

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
**Delivered as** `~/.claude/gotchas-global.md` G-C, which was written 2026-08-17 as a
duplicate of this entry before the audit noticed. One hazard, two files: the trigger
lives there because the hazard is not propagate-specific; this entry keeps the incident.
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
**Guarded by:** `lib/core/plist.mjs` — `regeneratePlist()` refuses to write a plist with 0
watch roots, citing N14. Cited by function rather than by line range: the line numbers were
correct when written and silently wrong after the 2026-08-20 regrouping, which is what a
citation-resolution check now catches (`tests/docs/doc-citations.test.mjs`).
`regeneratePlist` cheerfully wrote a plist with **0 watch roots** over a working one,
because discovery legitimately found 0 workspaces in a temp tree.

**Do:** refuse the empty case explicitly. One guard would have prevented that
incident entirely.

### G12 · A default that moves loses state silently
**Guarded by:** `tests/portability/config-state-dir.test.mjs` — the unset-case test this entry asks for.
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
**General form:** `rule:delegation-criteria` §2, which loads every session. Kept here
for the v1/v2 instance below; do not restate the rule.
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
**Delivered as** `~/.claude/gotchas-global.md` G-E — the hazard is a shell/git
fact, not propagate's, and the guard cannot reach this file from a normal working
directory. One trigger, one place; this entry keeps the incident.
`n=$(git cherry main "$b" | grep -c '^+' || echo "?")` prints **`0`** *and then* `?`,
because `grep -c` returning `0` is still exit status 1. The branch table came out as
interleaved `0` / `?` lines and had to be thrown away.

**Do:** `|| true`, never `|| <fallback-value>`, after any counting grep. Related to the
standing one: `cmd | head; echo $?` reads `head`'s status, not `cmd`'s.

### G25 · `--` before a grep pattern turns every later flag into a path
**Delivered as** `~/.claude/gotchas-global.md` G-F — the hazard is a shell/git
fact, not propagate's, and the guard cannot reach this file from a normal working
directory. One trigger, one place; this entry keeps the incident.
`command grep -rn -- "--accent" --include="*.md" "Vipin Kaushik"` searches **everything**,
including `node_modules`. `--` ends option parsing, so `--include=*.md` is read as a file
argument. Caught only because the output was 233 KB when a handful of lines was expected.

**Do:** put `--include` *before* `--`, or use `-e "--accent"` for a leading-dash pattern.

### G26 · `git ls-files <dir>` takes a path relative to the repo root, not to `cwd`
**Delivered as** `~/.claude/gotchas-global.md` G-G — the hazard is a shell/git
fact, not propagate's, and the guard cannot reach this file from a normal working
directory. One trigger, one place; this entry keeps the incident.
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
**Guarded by:** `readLedgerWithStats` is the fold; every `doctor` metric reads folded rows.
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

### G35 · The commit trailer records who committed, not who authored
`rule:model-routing` says Opus plans, Sonnet/Haiku executes an approved plan. Building a
pre-commit reminder for it, the obvious first design was "flag commits whose trailer says
Opus but whose diff was actually written by a subagent." That signal has zero discriminating
power: every commit in a PanditPawanKaushik session reads `Co-Authored-By: Claude Opus 5`,
because the parent always performs the commit — including `f42b3db`, which **Sonnet wrote**.
A trailer-based check would flag correctly-delegated work and pass undelegated work
identically. It is uncorrelated with the thing it claims to measure.

The second trap was worse: subagent turns are **invisible to the parent transcript**.
`isSidechain` is `false` for every one of the 8,997 message records the parent transcript
carries this session — not mostly false, **always** false, because subagent turns live in
separate task files the parent never sees. Control test: `THEME_CAPABILITIES.md`, written by
a Sonnet subagent, is absent from the parent's main-loop `Write`/`Edit` set while 40+ sibling
files the parent wrote directly are present. So a hook reading only the parent transcript can
never *positively* attribute a file to a subagent — there is no record of that write to point
at.

The signal that actually varies is the inverted one: the parent transcript reliably records
which files the **main loop** wrote. A staged file *not* in that set was written by something
else — a subagent, a script, or a human — which is exactly the information `rule:model-routing`
needs, read backwards. `scripts/hygiene/lib/worker-routing.sh` reports that set (plus the
count of `Agent` dispatches) and `scripts/check-worker-routing.sh` (pre-commit, warn-only)
compares it against staged files.

**Do:** before building a check, confirm the signal it reads actually **varies** with the
thing being measured. Feed it the case that should read as a violation and the case that
should read as clean, and check the two answers actually differ — a check whose input is
constant (every commit trailer says the same author) cannot fail *or* pass meaningfully, and
a check whose positive case can never be observed (a subagent write in the parent's own
transcript) is not measuring what it claims to measure at all.

### G36 · `${N:-{}}` in bash appends a stray brace, silently corrupting JSON
**Delivered as** `~/.claude/gotchas-global.md` G-H — the hazard is a shell/git
fact, not propagate's, and the guard cannot reach this file from a normal working
directory. One trigger, one place; this entry keeps the incident.
A lib emitted `{"component":"worker-routing",...}` that `jq` rejected. The cause was one
default-value expansion in the emit helper:

```bash
amodels="${6:-{}}"    # WRONG -> {"x":1}}
amodels="${6:-"{}"}"  # right -> {"x":1}
```

Bash parses the first as `${6:-{}` — default value `{` — and then treats the trailing `}` as
an ordinary literal appended **outside** the expansion. So the brace is added *whether or not
argument 6 was supplied*: valid input produced `{"x":1}}` and the empty case produced `{}}`.
The bug is invisible on inspection, because the line reads exactly like the intent.

It stayed hidden because the consumer was tolerant. `precommit-check.sh` only asserts
`type == "object"`, and a downstream `jq` filter on malformed input exits non-zero, which a
warn-only path swallows. It surfaced only when the output was piped to `jq -e` directly.

**Do:** quote any brace-bearing default — `${VAR:-"{}"}` — and never trust a JSON emitter you
have not piped through `jq -e 'type=="object"'` at least once. Related: G8, measuring through
a pipe reads the wrong exit code, and G2 — the tolerant consumer is what made this absence
unattributable.

### G37 · A hook dispatch guarded by `[[ -x ]]` turns a missing exec bit into permanent silence
Every check in `PanditPawanKaushik/.githooks/pre-commit` is dispatched as
`[[ -x scripts/foo.sh ]] && bash scripts/foo.sh`. That guard is deliberate — a check that is
absent should not break a commit. It also means a script committed **without** mode `100755`
never runs, on any clone, forever, and says nothing while not running.

The trap is that it works on the machine that wrote it: the file is executable on disk
locally, so the author sees the check fire. `install-hooks.sh` chmods `.githooks/*` and
**not** `scripts/*`, so nothing repairs it downstream. The check would appear installed,
tested, and green — and be dead for every other checkout.

**Do:** after adding a hook-dispatched script, assert the committed mode, not the on-disk one:
`git ls-files -s scripts/foo.sh` must show `100755`. Set it with
`git update-index --chmod=+x`. Same shape as G2 — the failure is silent, so the check must be
that the thing is *installed*, not that it *ran once here*.

---

## On operating this tool as an agent

Added 2026-08-16 from a session that registered two new workspaces, verified 13 edges
and made four measurement errors doing it. Every entry here cost a wrong statement to
the user before it was caught.

### G38 · `drain` is for ledger rows; derived states need `verify`
`reconcile` derives REVERSED / DRIFTED / DIVERGED / NEVER_VERIFIED from the event store
by comparing content hashes. **None of those are ledger rows.** So the obvious first
move — `cli drain` — is the wrong tool, and it does not say so.

Instance: three edges in `Keerti-portfolio` sat REVERSED. `cli drain` reported
`✓ no open rows` and exited 0. That reads as *nothing to do*, when three edges needed a
human decision. The right command was
`verify --edge <id> --disposition <d>`.

**Do:** `drain` closes rows a watcher wrote. `verify` re-baselines edges `reconcile`
derived. If `status`/`drain` say clean but `reconcile` shows non-CLEAN states, believe
`reconcile` — they are answering different questions.

### G39 · `verify` writes immediately; `bootstrap` is dry by default
> **SUPERSEDED 2026-08-17 by G44.** `--apply` now gates every disposition and the dry
> run executes the real validator, so a predicted refusal matches an actual one. The
> `**Do:**` below was correct until then and is now the **opposite** of correct — the
> dry run is how you preview. Retained for the incident, not the advice.
> **General form:** `rule:safety-flag-needs-a-test`.

The two sit side by side in `SKILL.md` and have **opposite** safety postures.
`bootstrap` needs `--apply` to write. `verify` writes on the first invocation, with no
`--apply` and no dry-run flag. `cli.mjs`'s own bootstrap comment reads "same posture as
verify --apply", which implies a gate that does not exist.

Instance: a run labelled "DRY RUN" in the transcript emitted three event IDs and
re-baselined three edges. The disposition happened to be correct, so nothing was
damaged — the claim of safety was wrong, not the write.

**Do:** treat every `verify` as a write. Decide the disposition *before* invoking, never
"run it to see what it would do". See N27.

### G40 · A rendered artifact committed beside its source drifts, and its own disclaimer hides it
`PROPAGATION_LEDGER.md` says "JSONL store is authoritative — this file is rendered."
That line reads as reassurance and functions as camouflage: it explains away any
discrepancy instead of prompting a re-render.

Instance: **45 rows across three repos** rendered as `open` in committed markdown that
the JSONL records as drained — 19 in `Vipin Kaushik`, 14 in `PanditPawanKaushik`, 12 in
`Keerti-portfolio`. Meanwhile `propagate status` reported **3 open across 12 ledgers**.
In `Vipin Kaushik` the stale `.md` and the correct `.jsonl` were committed together in
one commit (`7282c6e`), so the render simply was not re-run before committing.

**Do:** re-render after any drain or verify, in the same commit
(`renderMarkdown(jsonl, md)` from `lib/ledger.mjs`). Never read a committed `.md` as
current state — ask `status` or `reconcile`. See N26.

### G41 · `baselined` is not `verified`, and most edges can never be baselined
**Guarded by:** `bootstrap` prints the distinction in its own output.
`bootstrap` writes disposition `baselined` with reason `baseline-from-git: co-committed
at <sha>`. The tool is careful about this and prints "disposition \"baselined\" — never
\"verified\"". The evidence is only *these two files were committed together once* — not
*a human read both ends*.

Instance: of 101 NEVER_VERIFIED edges, `bootstrap --apply` baselined **12**. Of the
remaining 89, **69 are ineligible-cross-repo** — co-commit evidence needs one git
history, and an edge from `Keerti/CLAUDE.md` to the hub's `CLAUDE.md` spans two repos.
Those can only reach CLEAN when someone reads both ends and runs `verify`.

**Do:** do not treat a large NEVER_VERIFIED count as a bootstrap backlog. Most of it is
structurally un-bootstrappable. Read both ends and use `no-change-needed` (or the right
disposition) — that is a stronger claim and the only one available cross-repo.

### G42 · The instrument fails more often than the data — four shapes in one session
**General form:** `rule:discernment-checks` §4, which carries 15 rows to this entry's 7
and loads every session. This table is the propagate-local subset — two copies of one
list is G20 exactly, so add new instruments to the rule, not here.
Every one of these produced a confident wrong statement before being caught. They are
listed together because the fix is the same: measure a second way before reporting.

| What was reported | Truth | The flaw |
|---|---|---|
| "Keerti has no ledger" | it has one | `find -maxdepth 3`; the ledger is at depth 4 |
| a workspace list missing `Vipin Kaushik` | it is a workspace | unquoted `$f` in `for` word-split on the space; loop exited 2 |
| "9 case studies" (doc says 6, so doc is wrong) | **6, the doc was right** | `grep -c "slug:"` counted matches outside the array |
| "2 placeholders in design-content.ts" | **1** | `grep -c '"#"'` counted the comment *explaining* the placeholder |
| `reconcile --json` rows all had `status: None` | field is `state` | guessed the field name; the filter matched nothing and dumped all 20 rows |

**Do:** for counts, parse the artifact rather than grepping its text
(`node -p "require('./package.json').dependencies.next"`, or walk to the array's closing
bracket). For paths, use `find -print0` with `while IFS= read -r -d ''`. For JSON, print
the keys before filtering on one. Extends G15 — that entry is about grepping for
*concepts*; this is about grepping to *count*.

### G43 · `check --changed` does not see untracked files, and says nothing about it

Observed 2026-08-17. A brand-new `docs/GOTCHAS.md` with a correctly declared edge
produced **empty output** from `check --changed`. The declaration was fine; the file was
untracked, and `--changed` compares working tree + staged against HEAD.

The failure mode is the one this whole tool exists to prevent: **empty output read as
"no couplings" when it meant "not looking"**. The first instinct is to doubt the
declaration and start editing a sidecar that was already correct.

`git add` the file and it fires immediately. Worth an explicit line in the output —
*"N untracked file(s) not examined"* — because absence must be attributable (G2), and
this is precisely a silent zero.

---

## On the graph layer (added 2026-08-17)

### G44 · A flag that means "write" in one code path and nothing in another
**General form:** `rule:safety-flag-needs-a-test` — written 2026-08-17, after this was
the third instance. **Guarded by:** the `if (!apply)` branch in `runDispositionBatch`
and `tests/cli/verify-ordering.test.mjs`, which snapshots the store byte-for-byte.
`verify --apply` gated **only** the `decoupled` sidecar edit. The other seven
dispositions wrote their event the moment the command was invoked, and
`cli.mjs`'s header comment — *"does NOT touch the file unless `--apply` is
given"* — was true of the sidecar and false of the event store.

A session read it the second way and ran the ordering guard's own eight-case
behaviour matrix without `--apply`, to check exit codes. **Cost: 11 events
appended to the production store asserting verifications nobody performed, 3
real worklist items silently closed, the worklist reading 21 instead of 24, and
a deliberate one-time violation of append-only to remove them.**

The fix was to make `--apply` mean the same thing everywhere. The lesson is
narrower and worse: *the comment was accurate about the thing it was next to*.
Read a flag's guard at the call site that performs the side effect you care
about, not at the one the docs happen to describe.

Corollary now enforced by `tests/cli/verify-ordering.test.mjs`: a dry run must be
asserted by **snapshotting the store before and after**, never by trusting the
word "would" in the output.

### G45 · Out-depth and layer-from-root are mirror images, and only one is a fix order
"How far can I get from here" (out-depth) and "how far is the furthest root from
me" (layering) look interchangeable on a chain and disagree the moment a node
has two inbound paths. On `A→B`, `A→C`, `C→B`, out-depth makes B a sink at 0;
the correct layer is 2, because B must sit below **every** source.

The exploratory pass that produced this project's baseline numbers measured
out-depth. Reusing that code for the worklist would have ordered `B` before `C`
and produced exactly the false-CLEAN the ordering guard exists to prevent.
Cost: caught in review, but the depth histogram in the plan is out-depth and the
one in `graph` is not — they are different numbers and both are correct.

### G46 · A graph of 561 nodes is not a picture
PanditPawanKaushik owns 477 of 711 edges, and four single nodes have out-degree
79, 65, 59 and 58. Any force-directed layout of that is a hairball: it renders,
it looks impressive, and it answers no question anyone has.

What works: condense to workspaces first (~11 boxes, 11 genuinely
cross-workspace edges), expand one on demand into layered columns, and bundle
any fan-out above 20 into a single collapsible node. Decide the aggregation
before the layout, not after.

Related: a duplicate declaration is invisible until you count edges two ways.
711 edge records over 710 distinct `(from, to)` pairs found
`brand-system.md → components/README.md` declared twice with two restatements of
the same reason — two edge ids over one coupling, each verified separately, so
closing one leaves the other open forever.

### G47 · A hub document cannot be settled one inbound edge at a time
`Keerti/CLAUDE.md` has 4 inbound edges. `keerti-job-radar/CLAUDE.md` has 3.
Edit either to satisfy one of them and **every other inbound edge re-arms as
REVERSED**, because the downstream moved and those sources did not.

Working the 2026-08-17 worklist hit this three times in one session. Each time
the fix looked complete, the worklist grew instead of shrinking, and the newly
red edges were ones that had been CLEAN a minute earlier — armed by the fix, not
by any drift.

**The procedure that works:** for an interior node, gather *all* its inbound
sources first, make *every* edit to that node in one pass, then settle all N
inbound edges together. Only then move to its outbound edges. `graph --node
<path>` prints exactly this set (`in: N`), which is what it is for.

This is not a defect — re-arming is correct, and it is the same property that
makes a fix cascade honestly. It is a *sequencing* fact, and it is invisible
per-edge: nothing in a single `verify` tells you the node you are about to edit
has three other suitors.

Related: editing an edge's own `why` mints a **different `edge_id`**
(`sha8(node_id, downstream, why)`), so the old edge disappears and a new
NEVER_VERIFIED one takes its place. On 2026-08-17 that silently laundered a
DIVERGED edge off the worklist — the state was not resolved, the edge was
re-identified. Same mechanism retires 10 edges' history whenever a file is
renamed. If you rewrite a `why`, expect to re-verify, and say so in the reason.

### G48 · An enforcement point that does not watch itself

**General form promoted 2026-08-21 to `rule:enforcement-watches-itself`** — the how-to-apply
and the cross-project instance list live there now. What stays here is what this repo paid.

- **`lib/config.mjs`** documented the silent-zero-discovery failure in prose (`:33-38`,
  "reports healthy forever, which is precisely the failure this skill exists to catch") and
  never implemented the detection. Fixed 2026-08-19.
- **`rules/_check.mjs`** enforced that no `CLAUDE.md` restates a rule while its own `TREE`
  was hardcoded with no env override — on any other machine it scans an empty tree, finds 0
  restatements and **exits 0, reporting success**.
- **`lib/skills-create.mjs:206-209`** is the canonical text of `rule:description-standard`,
  and this skill's own `SKILL.md` description opened by summarising its workflow — exactly
  what that rule forbids.
- **The drift gate installed in seven repos on 2026-08-19 was not installed in this one.**
  Six commits landed here that day without it, including two to `lib/metrics.mjs` — a
  declared source whose two downstreams were DRIFTED the whole time.
- **`bin/propagate-update-check`** was written, verified across five behaviours, and invoked
  by nothing; with a remote deliberately ahead, `doctor` and `status` said "upgrade" zero
  times. Wired 2026-08-20.
- **`findLedgersUnder`** — built specifically to reach ledgers discovery cannot see — had
  zero production callers until 2026-08-20.
- **`bootstrap` printed `0 baselineable · 0 no-co-commit · 0 bound-reached`** where the
  adjacent `status` printed `✗ no workspaces` (2026-08-21). The command that exists to make
  absence attributable rendered "I looked at nothing" identically to "everything is fine".
  Trusting it would have closed N39 as resolved.

**Cost, measured:** `docs.supersession_prose_only` was added to `EXPECTATIONS` with a
threshold and a dated `basis`, and **4 of 8 expectations turned out to be absent from
`docs/OBSERVABILITY.md` §1** — the table that edge exists to keep in sync. The number moved
107 → 105 → 103 → 101 across three sessions and the doc never learned any of it.

**Signal:** you can describe the failure fluently in a comment. Prose about a hazard is not
a check for it, and the fluency is what makes it feel handled.

---

### G49 · A deliberate NUL separator makes the whole file invisible to code search

`` `${a}\u0000${b}` `` is the correct way to build a composite map key — NUL is the
one byte that cannot occur in a path, so it is the only separator that cannot
collide. Three files here use it and all three are right to:

| File | Key |
|---|---|
| `lib/events.mjs:120` | `` `${nodeId}<NUL>${downstreamPath}<NUL>${why}` `` — the edge-id hash |
| `lib/frontmatter.mjs:128,152` | `` `${p.sourceKey}<NUL>${p.index}` `` |
| `lib/graph.mjs:344` | `` `${e.from}<NUL>${e.to}` `` — the duplicate-pair index |

**The hazard is writing it as a raw byte instead of the `\u0000` escape.** One NUL
makes the file "binary" to every search tool in this environment:

- the `grep` shim passes `-I` (skip binary) — **no output, exit 1, no warning**,
  indistinguishable from "that symbol is not in this file";
- plain `grep -n` prints `Binary file … matches` and suppresses every matching line;
- `file` reports `data`.

Node does not care, the module loads, and the suite is green — so nothing else
signals it. Global counterpart: `~/.claude/gotchas-global.md` G-A, second mechanism.

**Signal:** a symbol you are certain exists returns zero matches. That certainty is
the tell; do not resolve it by doubting yourself.

**Cost:** 2026-08-19, while verifying the `lib/graph.mjs → SKILL.md` coupling. `grep`
found `fixOrder` in `lib/graph-html.mjs` and **not** in `lib/graph.mjs`, which
*exports* it. The next step was reporting that graph.mjs had lost its worklist
implementation. Three wrong theories preceded the right one — gitignore, ugrep's
`--ignore-files` (the already-documented mechanism, which was the confident guess),
then binary detection — and only reading the bytes in node settled it. Caught before
publishing, and only because the number was too surprising to accept.

**Do:** write `\u0000`, six ASCII characters, in source. Runtime-identical, and the
file stays text. `tests/portability/no-literal-nul.test.mjs` asserts this across every non-vendor
file, so a new composite key cannot reintroduce it.

**The guard failed to catch itself, and that is the sharpest part of this entry.**
`tests/portability/no-literal-nul.test.mjs` was written with two literal NULs in its own
docstring — the same mistake it exists to catch, made while writing the catcher. It
ran **green**, and the full suite reported 696 pass. It went red only after `git add`,
because it enumerated `git ls-files`, which lists **tracked** files only. A guard that
cannot see a file until someone stages it is blind at precisely the moment a new file
is written, which is when the mistake gets made. Fixed by
`git ls-files --cached --others --exclude-standard`, and proved by dropping an
untracked offender in `lib/` and watching it fail. Same shape as G48.

**Do not** "fix" it by removing the separator. `${a}${b}` collides: `a/b` + `c` and
`a` + `b/c` produce the same key, which for the duplicate-pair index and the edge-id
hash is a correctness bug, not a style one.

---

### G50 · A check that fails for an UNCONFIGURED optional feature fails every fresh install

Two doctor checks were failing new machines for states that are correct on a new
machine, and both read green here only by accident of local history:

| Check | Failed because | Green here because |
|---|---|---|
| `state.json exists` | only `watcher.mjs` ever wrote it, and the watcher was **retired 2026-08-14** — so it can never exist on a machine installed after that date | a **fossil** dated the day of the retirement is still on disk |
| `cross-repo edges resolve` | Phase 2 correctly emptied the shipped `cross-allow.yml`, so all 4 edges are "outside allowlist" | the real allowlist sits in `~/.propagate/cross-allow.yml` |

**The distinction the checks were missing is between UNCONFIGURED and VIOLATED.** An
empty allowlist permits no cross edge — that is the safety property working. An edge
outside a **non-empty** allowlist is a genuine violation. Same verdict for both was
what made "not configured yet" indistinguishable from "someone broke the bound".

**Signal:** the check is green on the machine that wrote it and red on every other
one, and the failing text describes a state you would expect a new install to be in.

**Cost:** two fresh-context agents each concluded "propagate is NOT correctly set up"
on a machine where nothing was actually wrong. The second failure was a regression
introduced by Phase 2 four commits earlier and invisible until someone simulated a new
machine — `doctor` exits 0 here, and did throughout.

**Do:** before a check votes, ask what a correct fresh install looks like. If the
failing state is one a new machine is *supposed* to be in, it is `info` with the
configuring action named — never a ✗. Absence still has to be attributable
(rule:discernment-checks §2), so report it; just do not fail it.

**The general form:** a check inherits its author's machine unless something forces it
off. `HOME=$(mktemp -d)` in a test is that force. Both of these had existed for weeks
with a green suite.

---

### G51 · A blanket `../` bump over a test tree corrupts fixture data, and it looks exactly like a path bug

Moving `tests/x.test.mjs` to `tests/<group>/x.test.mjs` means every relative specifier
needs one more `..`. The obvious sweep is `(["'])\.\./` → `"../../`. It cannot tell an
import specifier from a string that merely *starts* with `../`, and test files are full
of the latter.

**Measured on the real move, 2026-08-20: 123 bumps were correct, 19 were not.** The 19
were fixture data — cross-repo rows like `{ edge_id: "e1", source: "../../up/a.md" }`
and `parseSupersedes` cases. The sharpest one:

```js
assert.deepEqual(parseSupersedes("[../a.md, ../b.md]"), ["../../a.md", "../../b.md"]);
//                                ^ kept ../ (a "[" precedes)   ^ gained ../../ (a quote precedes)
```

The regex rewrote the *expectation* and not the *input*, because one had a quote in
front of it and the other had a bracket.

**Signal — and this is the expensive part: the corruption fails as a path bug.** Seven
distinct depth classes genuinely did need fixing (quoted specifiers, segment-form
`path.join`, trailing-`".."` constants, `new URL()` args, double-bumped `helpers/`,
non-recursive `readdirSync`, `SKILL_DIR`'s own count). After each fix the count improved,
so the next failure read as "one more class I have not found yet". Two of them were not
a class at all — they were the previous fix, applied too widely.

**Cost:** the tests/ move went 725 pass → 423 pass at its worst and took seven
diagnose-fix rounds, of which the last two were self-inflicted.

**Do:** rewrite specifiers *as specifiers*. Match `from "…"`, `import("…")`,
`new URL("…")`, `path.join(…, "..", …)` — never a bare substring that also occurs in
data. Then **classify the diff before running the suite**: every added line, split into
specifier-position and other-position. The 19 were visible in one pass over
`git diff -M --unified=0` and would have cost nothing to catch.

**And derive roots from a marker, not a count.** `SKILL_DIR` was
`path.resolve(import.meta.url, "..", "..")` and became wrong by one level the moment
`lib/config.mjs` became `lib/core/config.mjs` — seventeen tests failed with `ENOENT
.../lib/cross-allow.yml`. It now walks up to `package.json` + `SKILL.md`, which survives
any future regrouping.


### G52 · `SKILL_DIR` cannot be sandboxed by `HOME`, so a test can delete a real repo file
**Trigger:** `LEGACY_STATE|migrateLegacyState|relocateFile`
**Fires on:** `LEGACY_STATE.live`

A test can isolate the migration *destination* perfectly and still destroy the *source*.
`PROPAGATE_STATE_DIR` and a temp `HOME` control where state goes; **`SKILL_DIR` is derived
from `import.meta.url`** and resolves to the real checkout no matter what the environment
says. So any test invoking the real `cli.mjs setup` hands the real repo in as the migration
source.

Anything in `LEGACY_STATE.live` has **move** semantics — copy then unlink. Put a file there
that also has a permanent, version-controlled counterpart at `SKILL_DIR` and a correctly
isolated test will delete it from the working tree, for real.

That happened twice in one session to `cross-allow.yml`, which is `CROSS_ALLOW_SHIPPED`
(`lib/core/config.mjs:444`) — the fallback `CROSS_ALLOW_PATH` resolves to for every install
with no user copy. Both `lib/edges/cross-repo.mjs:70` and `cli.mjs:1315` `readFileSync` it
with no existence guard, so a fresh clone threw ENOENT on every cross-repo path.

**The reason it nearly shipped:** this machine HAS a user copy at
`~/.propagate/cross-allow.yml`, which shadows the shipped one. `doctor` stayed green and
the only things that noticed were the tests — because they point `PROPAGATE_STATE_DIR` at
temp dirs and are therefore the sole stranger-simulators on the machine. A green `doctor`
was not evidence; it was the shadow.

**Fix shape:** `LEGACY_STATE.seedOnly` — copy-if-absent, source never touched. Use move
semantics only for artifacts with no permanent counterpart in the repo.

**Cost:** two real deletions of a tracked file, 13 failing tests, and a fresh-clone install
that would have thrown on first cross-repo use. Caught by reading `git status`, not by any
check.

### G53 · A timing assertion that measures the whole command cannot see the bound it names
**Trigger:** `elapsedMs|Date\.now\(\) - start`
**Fires on:** `const elapsedMs = Date.now() - start`

`graph-check.test.mjs` asserted `elapsedMs < 4000` against a 5s-sleeping stub, named itself
*"a hung `claude mcp list` is bounded to ~2s"*, and measured **all of `doctor`** — the 2s
bound plus every unrelated check. Doctor's floor in that fixture is ~2.6s, so the assertion
lived ~1.4s from flipping and duly flipped when the fixture got heavier.

It then failed *before* reaching the assertion that actually tests the guarantee (that the
`timed out after 2s` line is emitted), so the failure could not distinguish "the bound
broke" from "doctor got slower". Two separate agents read it as flakiness under load; with
the machine idle it still failed.

**The bound was intact the whole time** — verified by hand: 2600ms total, message present.

**Fix shape:** widen the *signal*, not the budget. Stub sleep 5s → 60s, assert `< 15000`.
A held bound costs ~3s, a broken one ~45s, and no growth in doctor's other checks spans
that. Raising 4000 → 8000 would have gone green while quietly losing the ability to detect
a broken bound.

**Cost:** two lanes misdiagnosing it as CPU contention, and a real risk of it being
"fixed" by relaxing the number until the check could no longer fail.

### G54 · A subagent debugging the real CLI writes to the real store unless every env var is set
**Trigger:** `bootstrap\s+--apply|--baseline-from-git`
**Fires on:** `node cli.mjs bootstrap --baseline-from-git --apply`

`PROPAGATE_SEARCH_ROOTS` and `PROPAGATE_STATE_DIR` both **default to production**. A command
run to "see what it does" therefore operates on the real tree and the real append-only store,
and `--apply` is often set deliberately — so no safety-flag gate stands between you and the
write. `rule:safety-flag-needs-a-test`'s corollary is the one that applies: **never run a
command to find out what it would do.**

2026-08-20: a lane debugging a dirty-tree assertion appended **7 events** to the live store
this way (1347 → 1354), then tried to truncate the store to undo it — blocked by the
permission classifier, which is the only reason nothing was lost. Recorded as `docs/ISSUES.md`
**N39**; the events were kept, because they were evidence-backed and truncating an append-only
store is worse than the events.

**The trap in the remedy.** The instinct on discovering spurious appends is to delete them.
That instinct has now fired four times in this repo and been acted on twice. For an
append-only store the question is never "how do I remove this" but "is what it asserts true":
evidence-backed events that closed nothing should stay.

**How to actually avoid it — and the first version of this advice was WRONG.** This entry
originally said "export both vars once, before touching the CLI at all". That does not work
in Claude Code: **shell state does not persist between Bash tool calls.** A lane followed it
exactly, exported in one call, and its next call went out with both vars unset and landed on
the real tree. The export has to be in the SAME call as the command:

```sh
export PROPAGATE_STATE_DIR="$(mktemp -d)"; node cli.mjs <cmd>
```

Isolating `PROPAGATE_STATE_DIR` is the load-bearing half — every write risk is gated by it.
Exporting `PROPAGATE_SEARCH_ROOTS` too has a side effect worth knowing:
`tests/portability/config-file.test.mjs` inherits `process.env` and asserts env-unset
behaviour, so it fails when that var is exported in the parent shell. Isolate the state dir
always; isolate the search roots only for the command that needs it.

One forgotten prefix on one command is all it takes, and the write is silent and successful.

**Cost:** 7 events on a production ledger that cannot be removed without violating its
central invariant, plus an attempted truncation of the only copy.

### G55 · Narrowing `PROPAGATE_SEARCH_ROOTS` does not scope a run — it changes what the edges ARE
**Trigger:** `PROPAGATE_SEARCH_ROOTS=`
**Fires on:** `PROPAGATE_SEARCH_ROOTS="$HOME/.claude/skills" node cli.mjs bootstrap`

The obvious way to limit a `bootstrap` or `verify` to one project is to point
`PROPAGATE_SEARCH_ROOTS` at it. **That silently changes edge identity.** `edgeId` hashes the
absolute downstream path and a `nodeId` built from the traversed `repoRoot`'s basename, so a
narrower root produces a disjoint set of edges that all read `NEVER_VERIFIED` — and every
command reports on them with total confidence.

Matching the directory basename is **not** enough; the absolute path is hashed too. Measured
2026-08-21: three routes to one repo, three disjoint id sets, 17 edges each.

**The symptom that should stop you:** a scoped dry run reporting *more* never-verified edges
than the unscoped one. Under a narrower root propagate showed `17 NEVER_VERIFIED` where the
real tree showed 9 never-verified, 6 clean, 2 reversed. That is not a stricter view of the
same edges; it is a different set wearing the same names.

**How to check before you write:** snapshot `reconcile --json` edge ids under the normal root,
run your scoped command as a dry run, and **diff the id lists**. Identical ids mean you are
looking at the same couplings. Anything else means you are about to create new ones.

**Cost:** would have written 8 baselines against duplicate edges and doubled propagate's edge
set. Caught by a diff, not by any check. Recorded as `docs/ISSUES.md` N40.

### G56 · `node --test <file>` writes to the PRODUCTION ledger — only `npm test` scopes the store
**Trigger:** `node\s+--test\s`
**Fires on:** `node --test tests/watcher/events.test.mjs`

**The store is scoped by the npm SCRIPT, not by the tests.**

```json
"test:propagate": "PROPAGATE_STATE_DIR=\"${TMPDIR:-/tmp}/propagate-test-state\" node --test 'tests/**/*.test.mjs'"
```

`EVENTS_DIR` is a module-level const resolved from `STATE_DIR` **at import time**
(`lib/edges/events.mjs`), so it is fixed by the environment the process started with. Run
`npm test` and every `appendEvent` lands in a tmpdir. Run `node --test tests/x.test.mjs`
directly — to iterate on one file, which is the obvious thing to do — and the same calls
target `~/.propagate/events/`. Nothing in the test files themselves prevents it.

That is invisible for the many tests that only read. It bites the ones that write, and
worst of all it bites `assert.rejects(appendEvent(...))`, which calls the live writer and
relies on **validation** — not isolation — to stop the write. That is fine once the rule
under test exists. It is not fine while you are writing it.

**The trap is that RED looks correct.** On 2026-08-22 two new tests asserting
`validateEvent` rejects an event missing `observed_on_ref` / `downstream_on_ref` were run
before the rule was implemented — via `node --test tests/watcher/events.test.mjs`, to see
them go red on one file. `appendEvent` accepted both, **appended them to
`~/.propagate/events/2026-08.jsonl`**, and only then failed the assertion. The output read
`ℹ fail 2` — RED, for exactly the stated reason — and the ledger had silently grown by two.
The full `npm test` run half an hour later touched nothing, which is the confusing part:
the same tests are safe or unsafe depending only on how the process was launched.

The tell was a line count, noticed by accident an hour later while looking for something
else: the store had gone 1912 -> 1914 with no `verify` run in between. Nothing reported it.
Re-running the same file afterwards showed the store unchanged, because by then the rule
existed and the writes were correctly refused — so the evidence disappears as soon as the
feature lands.

**Fix, in order.** First: **run `npm test`, not `node --test`.** If you must iterate on one
file, pass the variable yourself —
`PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test tests/watcher/events.test.mjs`.

**Use that STABLE path, not `$(mktemp -d)` — corrected 2026-08-25, and this entry
prescribed the wrong one until then.** `CONFIG_PATH` derives from `STATE_DIR`
(`lib/core/config.mjs`), so a FRESH temp dir has no `config.yml`: `searchRoots` is empty,
discovery finds **zero workspaces**, and anything that resolves config fails with
`no workspaces — hub root is not configured`. That is not a flake and not a regression — it
is the harness reporting that it has no install to look at.

**Cost of the bad advice, all on 2026-08-25:** a bisect across three commits chasing a
"pre-existing" failure that was not one, a wrongly-filed issue (N50's third entry, since
withdrawn), and a freshly-extracted `docs` module reported as broken when the command was
fine — that run had a stale `PROPAGATE_STATE_DIR` exported earlier in the same shell block.
`rule:enforcement-watches-itself` names this shape exactly: *"a gotcha entry's own advice was
wrong."* Second recorded instance.

Second, belt-and-braces for the tests that write: scope the store inside the test and assert
on the message, never on the throw alone:

```js
await withScopedStore(async (stateDir) => {
  const script = `… try { await appendEvent(…) } catch (err) { … } …`;
  const out = runInSubprocess(script, { ...process.env, PROPAGATE_STATE_DIR: stateDir });
  assert.equal(out.threw, true);
  assert.match(out.message, /"downstream_on_ref"/);
});
```

Then mutate the guard away and confirm the tests go red **while the store line count stays
put** — that is the assertion that distinguishes this from the version that "worked".

**A test proving a guard rejects something must never be the thing that runs unguarded
against production.** Same family as `rule:safety-flag-needs-a-test`, one level up: there
the flag failed to gate the write, here the *test for the gate* was the write.

**The general form is worse than the instance.** The safety property lives in a string in
`package.json` that no test asserts and no reader of the test files can see. Any of the
eight test files that call `appendEvent` has this behaviour; only two were hardened.

**Cost:** 2 junk events in an append-only store, permanently. Cheap only by luck —
`edge_id e717028e` / `node_id VipinKaushik:lib/pricing.ts` are fixture values matching **0**
declared edges, so nothing was falsely closed. The 2026-08-17 instance of the same family
cost 11 spurious events and 3 real worklist items silently closed. Recorded as N44.

### G57 · `rg` honours `.gitignore`, so it inherits the exact blind spot you reached for it to avoid
**Trigger:** `\brg\s+(?!.*--no-ignore)`
**Fires on:** `rg -l 'docs/GOTCHAS.md'`
G-A records that `grep` here is a ugrep shim honouring `--ignore-files`, and that the hub
`.gitignore` is `/*` — so a tree-wide search silently skips whole workspaces. `rg` is the
tool people switch to *because* of G-A, and it has the same default: it respects
`.gitignore` unless told not to.
**Signal:** a plausible, low count. No error, no warning, no hint that anything was skipped.
**Cost:** 2026-08-22, planning the GOTCHAS move. `rg -l 'docs/GOTCHAS.md'` returned **7**
referrers; `rg --no-ignore -l` returned **87**. The 7 was about to be used to argue the
move's blast radius was trivial.
**Instead:** pass `--no-ignore` for any census over `~/Documents/GitHub`, and treat any
count from a bare `rg`/`grep` as a floor, never a total. Re-measure a different way before
publishing it — `rule:discernment-checks` §4.

### G58 · `inventoryRepos()` cannot see a `.git` nested inside a `.git`
**Trigger:** `inventoryRepos`
**Fires on:** `const inv = inventoryRepos();`
It enumerates the OUTERMOST repo only. `Vipin Kaushik/` and `Keerti/` are git repos that
each contain further git repos (`marketing-intel`, `keerti-job-radar`), and those nested
repos appear in **neither `items` nor `dropped`** — not counted, and not reported as
skipped either.
**Signal:** a repo you know exists is simply not in the output, and nothing says why. The
`dropped` list looks healthy because it only records depth-bound misses.
**Cost:** 2026-08-22, a gotchas census built on it reported **5 of 34** where an
independent filename walk found **9**. Both numbers were defensible; only one was right.
**Instead:** for anything scoped to projects, enumerate `<workspace>/propagation/state/*/`
— that is the declared registry and needs no walking. Use `inventoryRepos` for repo health,
not as a denominator.

### G24 · Removing a config key's built-in default silently nulls every derived path
**Trigger:** `(hubRoot|HUB_ROOT|searchRoots|SEARCH_ROOTS)`
**Fires on:** `grep -n hubRoot lib/core/config.mjs`
`hubRoot` replaced four independent restatements of `~/Documents/GitHub`, and the sentinel —
**no built-in default, unconfigured resolves to `null`** — is deliberate: a plausible wrong hub
finds zero workspaces and then reports healthy, which is the failure this tool exists to catch.

But every install predating the key declares `searchRoots:` and no hub. On the author's own
machine `marketplaceDir` and `portsFile` **both resolved before the change and both were `null`
after** — two integrations silently off, `status` still green at 864 edges, because `null` reads
as "not configured" rather than "configured wrong". That is the same sentinel failure arriving
through the opposite door.

Resolution is therefore four-state, not two: env → `hubRoot:` → **exactly one declared
`searchRoots` entry (inferred, and the diagnostic says so)** → `null`. Two or more roots stay
null; "which of these is the hub" has no answer that is not a guess.

**When you delete a default, enumerate what derived from it and check each on a machine that is
already configured** — not on a fresh fixture, where the old default was never in play.
**Cost:** caught in-session by reading the derived values, not by any test. All 13 hub tests
were green while two integrations were dead, because each one declared its own hub.

### G25 · A wall-clock assertion cannot tell a broken bound from a busy machine
**No trigger, deliberately — 2026-08-24.** It carried one, matching `elapsedMs` and
`assert.ok(… < NNNN)` against the literal
`assert.ok(elapsedMs < 15000, "the bound did not hold")`. That is JavaScript source, and the
guard is only ever handed a Bash `command` or an Edit/Write `file_path` — never file
CONTENT. So the entry looked armed, passed `--selftest`, and could not fire. N45's fix now
reports exactly this, and this is the first entry it caught.
Most gotchas have no mechanical trigger and inventing one makes noise; a timing assertion
lives in code, so this hazard belongs to review rather than to the guard.
Three instances on one assertion. `< 4000` against a 5s stub flipped on fixture weight
(2026-08-20). `< 15000` failed at **23406ms under load average 49** on 2026-08-23 — while a
clean re-measure of the *identical* scenario took **3723ms, unkilled, message emitted**. The
bound was intact every time.

**The obvious fix was wrong, and this is the useful part of the entry.** "A broken bound means
the child is killed, so assert `result.signal === null` — binary, not a duration" is correct
reasoning and still load-dependent, because the *harness's own* 20s spawn cap fires under load
too. It passed 8/8 in isolation and failed in the full suite at 22043ms with an intact bound.
**Relocating a timing dependency reads exactly like removing one.**

**What actually works is asserting the OBSERVABLE the bound produces.** With the bound intact,
`execSync` aborts at 2s and doctor prints `graph integration check timed out after 2s`. With it
broken, the 60s stub runs to completion and its output is parsed as an ordinary result, so that
line never appears — at any load, on any machine. The harness cap moved to 90s and stopped being
an assertion at all; it is now only a runaway guard, which is all a harness timeout should be.

**Do not reason from the elapsed number either.** 23406ms exceeded the 20s spawn timeout, which
looks exactly like "it was killed"; the conclusion "the bound held" was reached twice from
arithmetic and was right only by luck. Re-measure on an idle machine before believing either
verdict — `rule:discernment-checks` §4, verify the instrument.

**Cost:** two false regressions during unrelated work, and a nearly-published claim that a bound
had broken when it had not. **When you assert a timeout works, assert the side effect it
produces — killed vs not — never the duration.**

### G26 · One spec, one conforming implementation, and mine drifting from it
**Trigger:** `snapshot\.json|buildSnapshot|diffSnapshots|branch-registry`
**Fires on:** `node -e "JSON.parse(fs.readFileSync('propagation/refs/snapshot.json'))"`
`lib/refs/snapshot.mjs` writes `{ schema_version, project, repo_root, refs: [ … ] }` — a FLAT
array. The older `hygiene/branch-registry` writes
`{ captured_at, captured_by, projects: { <name>: { refs: { <branch>: {…} } } }, schema_version: 1 }`
— a NESTED map. Both say `1`. One is live at
`Vipin Kaushik/propagation/refs/snapshot.json` with **36 refs across 7 projects**.

**Measured 2026-08-24:** `diffSnapshots(shipped, mine)` returned **4 `created` and zero
`pruned`**, because `prev?.refs ?? []` turned 36 existing refs into "there was nothing here".
Those records append to `refs/lifecycle.jsonl`, which is append-only by design — the same
damage N27 and N44 already cost this project twice.

**The version field cannot save you when both writers claim it.** `assertKnownShape` now
refuses a snapshot whose `refs` is not an array, and names the format it appears to be. A
missing `refs` means UNREADABLE, never EMPTY.

**CORRECTED 2026-08-24, and the correction is the lesson.** The entry above framed this as two
rival formats needing a winner. It is not. `docs/REFERENCE.md:106-110` specified the shape
BEFORE either implementation: *"per project a base_ref, and per ref its head, merge_state,
upstream, upstream_track, last_commit_iso, worktrees, is_active_line."* Compared field by field
as sets, the shell's file matches that **exactly** — 0 missing, 0 extra. The shell implements
the spec. `lib/refs/snapshot.mjs` does not, on two axes: it describes ONE repo where the spec
says per project (**2 refs of 36** on Vipin Kaushik), and it models a worktree as a peer row
where the spec makes it an attribute of a ref.

So there was never a format war. There was a canonical spec, a conforming implementation, and
mine — which I wrote, and then wrote this gotcha blaming the collision instead of opening the
spec. **Before declaring two things in conflict, check whether one of them is already
specified.** The reconciliation you are about to design may already exist as a document.

**The reader still must not accept both silently.** Keying on `schema_version` is how they are
told apart — the shell's files are `1`, propagate's conforming output is `2`.

**And beware the probe.** The first read of that file reported `refs: 0` — a top-level key it
does not have — which is how the empty-snapshot theory survived two messages and got written
into a source comment as fact. `rule:discernment-checks` §4: verify the instrument before
believing a surprising number.
**Cost:** caught before any lifecycle event was written. It would not have been, had `migrate`
run against Vipin Kaushik first.

### G27 · Porting a tool's SHAPE while re-deriving its BEHAVIOUR loses what it learned
**Trigger:** `enumerateRefs|refs/heads|for-each-ref|branch-registry|ref-resolver`
**Fires on:** `git for-each-ref refs/heads`
**FIVE times** in one session, replacing `hygiene/branch-registry.sh` with `lib/refs/`:

| Re-derived wrong | What the shell already knew |
|---|---|
| first run labelled every ref `created` | it emits **`baseline`** — *"ref existence before this moment is unknown"* |
| pruned refs carried no work verdict | **`classifyPruned`**, and *unmeasured is UNSAFE, not fine* |
| enumeration read `refs/heads` only | it reads heads **AND** `refs/remotes/origin`, subtracting locals |

**The third was the expensive one.** Measured 2026-08-24: 24 local heads against the shell's
36. The 12 missing were all remote-only, so the diff reported **12 prunes — 5 classified
`recoverable`, asserting lost work — against a repo where nothing had been deleted.** Caught
only because `--apply` is a separate step; the events would otherwise be permanent in an
append-only log (the N44 damage class, at 6x the size).

`ref-resolver.sh:110` had fixed exactly this and left the reason in place: *"local ref and 7
remote, so six of its own branches were invisible to the tool built to track them. A branch
nobody has checked out locally is still work that exists."*

**And the instrument lied twice on the way.** `git show-ref --verify refs/heads/<name>` said
GONE for all 12 — true, and irrelevant: it answers "is there a LOCAL ref", which was never the
question. Two independent sources agreeing on a *narrower* question is not corroboration
(`rule:discernment-checks` §5, compare like with like).

**When you replace a tool, read what it learned before writing what it does.** Its comments are
the bug reports it already paid for. Port the population and the vocabulary first; the shape is
the easy half.

**Fourth and fifth, 2026-08-24, both in the same phase and both caught by comparing
against the shell rather than by any test:**

| Re-derived wrong | What the shell already knew |
|---|---|
| `merge_state` via `git branch --merged` | `ref-resolver.sh:21` — *"these repos squash-merge, so `--merged` and `origin/main..<ref>` both lie"*. Measured: `git cherry` agreed with the shell on **35 of 35** refs; `--merged` disagreed on **7** |
| `upstream` never populated at all | `enumerateRefs` asked git for `upstream:track` and never `upstream:short`, so all 36 refs read `upstream: null` — i.e. **every pushed branch reported as "work exists only on this machine"** |

**The fifth was found by comparing SETS, not counts.** The ported findings produced 46
rows against the shell's 11. The 11 matched exactly and the 35 extras were one uniform
rule, which named the bug in a single glance. `46 ≠ 11` on its own points nowhere —
`rule:discernment-checks` §5, state what your measurement is *over*.

**And the fourth was only visible because the pre-commit hook still existed.** The
conversion was reported as a no-op on matching populations (36 = 36) and flag counts;
the hook was computing 10 phantom `merged` transitions per commit and discarding them.
The tool about to be deleted as dead weight is what caught it.

### G58 · `branch-registry.sh` WRITES unless you set `BRANCH_REGISTRY_READONLY=1`
**Trigger:** `^(?!.*BRANCH_REGISTRY_READONLY=1).*branch-registry\.sh`
**Fires on:** `bash scripts/hygiene/lib/branch-registry.sh`
The pre-commit hook invokes it read-only, so every *reference* to it in prose describes a
read-only tool. The lib itself defaults the other way: `READONLY="${BRANCH_REGISTRY_READONLY:-0}"`
(`:83`), and `:278` writes the snapshot whenever that is not `1`.

**Signal:** the JSON it prints tells you, but only *after* the write — `"readonly": false,
"snapshot_written": true`. There is no prompt and no error.

**Cost:** 2026-08-24, verifying C1e. Run bare to check the two tools now agreed, it silently
rewrote `propagation/refs/snapshot.json` from propagate's schema 2 back to its own schema 1.
Recovered by re-running `propagate migrate-refs --apply` — v1 is a supported input, and the
`merge_state` values were by then identical, so it cost a format regression and nothing else.
It was cheap only because the fix had already landed; the same keystroke an hour earlier
would have restored 36 `null`s over the values.

**Instead:** `BRANCH_REGISTRY_READONLY=1 bash …`. And more generally — this is the fourth
instance of `rule:safety-flag-needs-a-test`'s corollary, *never run a command to find out what
it would do*. Reasoning by analogy from the neighbouring caller's posture is exactly what the
other three did too.

### G59 · Settling inbound edges before the hub node stops changing costs you the whole set, once per edit

`verify` pins an edge to the CURRENT content pair. So editing a downstream re-REVERSES every
edge that points **into** it — all of them, at once.

Measured 2026-08-25 in `Vipin Kaushik`: `CLAUDE.md` has **nine inbound edges**. It was edited
three times in one session (a content-ownership line; a branch-strategy correction; two
astroacharya path corrections). Each edit re-opened all nine, so nine edges were read,
reasoned about and settled **three times** — 27 verifications for 9 edges, every one of them
honest and 18 of them wasted.

**Signal:** you run `status`, see `0 need attention`, make one more edit to the hub file, and
the same list comes straight back.

**Instead:** on a node with many inbound edges, do all the editing first and settle the
inbound set **last**. `propagate graph` prints the fix order root-to-leaf, which handles the
*dependency* direction; it does not warn you that your own next edit will undo the row you
just closed.

**Corollary — the blocker list is not the whole blocker list.** `graph` excludes
NEVER_VERIFIED edges from the printed worklist while still counting them as blockers, so a
`DIVERGED` row can report `BLOCKED by 3`, and then reveal a fourth (`rules/tool-priority.md`)
only once those three clear. Expect to re-run it after each settlement rather than reading it
once and planning the whole batch.

**Cost:** ~30 minutes, no wrong data. Everything written was true when written; the waste was
ordering, not correctness.

---

### G60 · A relative dynamic import moved out of `cli.mjs` fails SILENTLY, and doctor stays green

**Trigger:** `await import\("\./lib/`
**Fires on:** `await import("./lib/refs/findings.mjs")`

Extracting doctor's per-workspace section (#31 T2) carried
`await import("./lib/refs/findings.mjs")` along with it. That specifier is correct relative
to `cli.mjs` at the repo root and **wrong** relative to `lib/report/doctor/`, where it
resolves to `lib/report/doctor/lib/refs/findings.mjs`.

**Four independent things that should have caught it, and did not:**

| | why not |
|---|---|
| `node --check` | a dynamic import is not resolved at parse time |
| the unit tests | they exercise the module's other paths |
| the full suite | 1097 + 91 green |
| **`doctor` itself** | **exit 0** |

The last one is the point. That region is wrapped in a `try/catch` that reports a failed
probe as `info` — **deliberately**, because "the probe could not run" is a third state
distinct from pass and fail (`rule:discernment-checks` §2). So a missing module rendered as
one dim informational line.

**Signal:** `· ref registry  probe could not run: Cannot find module '…/lib/report/doctor/lib/refs/findings.mjs'`
— one line, dim, in a command that exits 0.

**Measured cost:** doctor's output fell from **465 lines to 241** — the entire branch-registry
section for every one of 13 workspaces, gone — while the command reported success. Caught
only by diffing against a baseline captured before the change.

**The guard:** `tests/unit/doctor-module-imports.test.mjs` resolves EVERY relative dynamic
import in `lib/report/doctor/**` from that module's own location. Deliberately not a grep for
`"./lib/"` — that is a fingerprint for one spelling of the mistake, and resolving catches
spellings nobody has made yet. It also asserts the module list and the specifier count are
non-zero, so an emptied directory cannot pass vacuously.

**The general form, worth more than the instance:** a `try/catch` that correctly distinguishes
"could not run" from "failed" will, just as correctly, absorb a refactor's mistakes. Every
extraction that moves code *into* such a region needs its own resolution check, because the
error handling is working exactly as designed while hiding you.
