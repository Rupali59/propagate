# TODOS — propagate workspace

Open work for propagate. **`STATE.md` is narrative — what is true now; `ISSUES.md` records
defects with severities; this file is the task list.** Created 2026-09-23, because propagate
was carrying open work in three places that were not a task list: prose inside `STATE.md`,
N-entries in `ISSUES.md`, and a session's findings that lived nowhere at all.

**Format is load-bearing, not decoration.** `lib/report/backlog.mjs` recognises four item
shapes; this file uses ID-keyed headings (`### PR-001 · Title`). Two rules keep it readable
by the tool:

- **No checkbox lines anywhere.** Checkbox style is tried first, so a single one makes the
  parser treat the whole file as checkbox format and ignore every `PR-` id.
- **An entry's heading and its first body line must not contain a closing word.** The reader
  checks both, so an open item that merely mentions one reads as finished. Say it in the
  second paragraph instead.

Entries that are done move to the level-2 heading named Finished at the bottom of this
file, which the reader treats as a closed section wholesale — ID-keyed headings inside it
included, since 2026-09-24.

**Never write that heading in this prose as literal markdown.** An earlier version did,
the line wrapped, a line therefore BEGAN with the hashes, and the parser read the
explanation as a real heading — closing every entry below it. The reader said 8 total,
0 open. N51 exactly: prose about the format is not the format, until it accidentally is.

Derive the open count rather than reading one here:

```sh
node cli.mjs backlog --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.totals||{}))})'
```

---

### PR-005 · Give the 18 undispositioned `ISSUES.md` entries a marker — **RESOLVED 2026-09-29**

**Done, and the count in this heading was wrong — by this entry's own instrument.** Its derive
command tests `/\*\*OPEN\*\*/`, so seven entries that DID carry a disposition were counted as
carrying none: `— OPEN` unbolded (N52, N54), `**OPEN (TODO)**` (N62), `**ACCEPTED, NOT REVERTED**`
(N39), `**BLOCKED (on Phase D)**` (N42), `**BLOCKED**` with the qualifier outside the bold (N38),
and `**APPLIED 2026-08-29, VERIFICATION PENDING**` (N57). Genuinely undispositioned: **11**.

Those seven were the more useful finding. `BLOCKED`, `ACCEPTED` and `APPLIED, UNVERIFIED` are real
states the register needed and had no word for, so each author invented one — which is why the
matcher could not see them. `ISSUES.md` now opens with the vocabulary and the derive command.

**The 11, each disposition carrying its evidence** — 6 closed, 5 open:

| | |
|---|---|
| N10 | RESOLVED — 0 occurrences of `com.rupali.propagate` in SKILL.md |
| N14 | RESOLVED — `init` no longer regenerates the plist; it moved to `reload()`, where that IS the job |
| N15 | RESOLVED — the template carries a `workspaceLine`; `init --workspace` writes `workspace: true` |
| N19 | RESOLVED, MOOT — describes the v1 schema; v2 rows carry `disposition` directly |
| N25 | RESOLVED — the v2 store is outside every working tree; the in-tree cross-ledger is the named exception |
| N50 | RESOLVED — no timeout left in `tests/cli/inventory.test.mjs` |
| N11 | OPEN — a design property of sidecar-relative paths, not a bug with a patch |
| N16 | OPEN — the same defect as GitHub propagate#4, still open there |
| N20 | OPEN — not re-measured since the 2026-08-20 triage, which said so itself |
| N22 | OPEN — a design question about a drain UI that does not exist yet |
| N26 | OPEN — 4 rendered ledgers still on disk, in the location the 2026-08-21 move superseded |

**Four of the five still-open ones are open for a reason worth distinguishing from neglect:** N11
and N22 are design questions rather than defects, and N16 is tracked publicly. Only N20 and N26 are
work nobody has done — and N26 gained live evidence today that it is real.

_Original entry:_

### PR-005 · Give the undispositioned `ISSUES.md` entries a marker

Measured 2026-09-23: `ISSUES.md` holds 55 `###` headings — 29 marked `**OPEN**`, 8 marked with a
terminal word, and **18 carrying neither**. Those 18 are indistinguishable from "nobody said",
which is the `rule:discernment-checks` §2 failure living inside this repo's own defect register.

Several are self-described S1: N10, N14, N11, N19. Derive rather than trusting this count:

```sh
node -e 'const t=require("fs").readFileSync("propagation/state/workspace/ISSUES.md","utf8").split("\n").filter(l=>/^### N\d+/.test(l));console.log(t.length, t.filter(l=>/\*\*OPEN\*\*/.test(l)).length)'
```

### PR-006 · Make the backlog reader count issues, not references to them

Measured 2026-09-23: `propagate backlog` reported `68 total, 60 open` for propagate's
`ISSUES.md`. The file holds 55 `###` headings and 87 distinct `N\d+` tokens, so the reader is
matching prose citations as items.

Same family as N72 and N74, which already record the restatement pairer anchoring on the wrong
thing. A reader that cannot tell an item from a reference to an item inflates every register it
touches, and the inflation is invisible because the number looks plausible.

### PR-007 · Build the Reminders bridge as a `propagate-digest` section, after N87 slice 2

Spec at `docs/plans/2026-09-23-reminders-todo-bridge.md`, eng-reviewed 2026-09-23. Reads the
`Claude TODO` Reminders list every 12 hours (09:00 + 21:00), routes tagged items into project
registers, holds untagged ones, and reconciles completion in both directions.

**Sequenced behind N87 slice 2, deliberately.** The review routed this component's failures
into `doctor`, and a TCC denial is `INCONCLUSIVE` — "could not look" — which is exactly the
fourth entry kind N87 slice 2 introduces. Landing the bridge first makes its failures warning
355 of 355. This is the first real consumer of that state.

Three hazards are verified against the live list rather than predicted: exit codes separate
"found nothing" from "could not look" (`-1743` is the TCC denial), tags may be CR-separated
so a `\n`-anchored parser misses them, and `completion date` is the clock while
`modification date` is not — a tag edit bumps the latter.

### PR-008 · Chase the intermittent `ui-client` failure — the 91 "missing" tests were the ruler — **RESOLVED 2026-09-28**

**ROOT CAUSE: one line.** `tests/helpers/mount-client.mjs` ended with
`await new Promise((r) => setTimeout(r, 30))` and called that settled. `node --test`
parallelises across files, so under contention 30ms was not enough for the mount effect's fetch
to resolve and Preact to re-render — assertions then ran against the loading placeholder, which
is the actual value in **every** occurrence this entry records.

That accounts for the whole shape of it and explains what three sessions of looking at aggregates
could not: intermittent, always clean in isolation, ~11 test names across two files, and 2
failures escalating to 6 in a day as mount-based tests were added. Nothing was ever wrong with an
assertion.

**Confirmed before rewriting rather than after:** raising the constant to 400 turned a 6-failure
run into 2306 passing. Then NOT shipped that way — a bigger number is the same bug, re-breaking on
a slower or busier machine with nobody remembering why.

**The fix is a condition:** no fetch in flight, no pending macrotask, the mount has issued its
first call, and the DOM signature (text + attributes + style) unchanged. Four attempts were needed
and the three failures are recorded in the file, because each is a way of getting quiescence
wrong:

1. Text-only signature — missed the chart's `--len`, a style write that changes no text.
2. Counting rAF callbacks — a component that schedules a frame from inside a frame is never
   quiet; 24 of 25 tests timed out.
3. Awaiting in-flight fetches unconditionally — a never-resolving fetch hung forever and the
   timeout below it was unreachable.
4. Allowing quiescence before the mount had fetched — two quiet ticks can pass before Preact's
   double-hop fires the effect, which is the original bug in a different window.

**Verified:** ui-client 25/25 and ui-conflicts 9/9 in isolation, and three consecutive full runs
at 2306 tests / 0 failures where one run had failed six. `tests/unit/mount-client-settle.test.mjs`
covers the harness directly — including the failing case, which found defects 3 and 4 immediately.

**What this entry got right and what it got wrong.** Right: reframing it as file-wide rather than
one assertion, and refusing to accept the aggregate-count instrument. Wrong: it read the widening
name set as evidence of nondeterminism *in the tests*, when the names were widening simply because
every new mount-based test inherited one shared sleep. The corpus grew; the bug did not move.

---

_Original entry, kept for the reasoning that led here:_

### PR-008 · Chase the intermittent `ui-client` failure — the 91 "missing" tests were the ruler

**Half of this landed 2026-09-25.** `package.json`'s `test` script no longer short-circuits:
both sub-suites run unconditionally and both exit codes print, verified by planting a
propagate-side failure and watching curate-docs still run 91/91. The aggregate still fails when
either does.

**The flake itself is untouched, and it is wider than this heading says.** Six full runs that day
produced 2, 0, 2, 1, 0 and 2 failures across **at least six different test names** inside
`tests/unit/ui-client.test.mjs` — `opening a lazy division fetches it, once`, `a per-division
error renders in that division`, `the top row is fixOrder's first`, `a baseline split that does
not add up SAYS so`, `READY collapses a shared node+state into ONE expandable row`. That is
file-wide nondeterminism, plausibly fetch/async ordering, rather than one intermittent
assertion. The singular framing in this heading is the thing to correct first.

**2026-09-27: it is not confined to `ui-client.test.mjs` either — it follows the MOUNT HARNESS.**
A full run failed `the six dispositions render in three groups, each with its count` and
`already-inserted is MUTED, and it is the only muted row`, both in `tests/unit/ui-conflicts.test.mjs`,
a file added two days earlier that shares `tests/helpers/mount-client.mjs` with the others. Both
actual values were the loading placeholder — `reading the reminders list…` — so the assertion ran
against a component that had not settled, which is the same signature as the five names above and
is the most specific evidence yet for the fetch/async-ordering theory. The same file then passed
**3 of 3** in isolation and the whole suite passed on the next full run, 0 of 2244.

**ESCALATING, and this is the line that changes the priority.** A 2306-test run later on
2026-09-28 failed **SIX** at once — the previous maximum across all recorded occurrences was 2 —
and four of the six are names this entry had never listed: `a fatal reconcile renders the reason,
not an empty page`, `BLOCKED offers no disposition buttons, and says why`, `every disposition
button comes from item.allowed, and DIVERGED gets one`, `the top row is fixOrder's first, not a
re-sorted one`. Both files then passed fully in isolation, 25/25 and 9/9.

The name set is now ~11 across two files and still growing, which settles the question this entry
has been circling: **nothing is wrong with any assertion.** What is wrong is that mount-based
tests do not survive being interleaved by the runner.

**The cost has changed, even though nothing is broken.** At 2 failures a full run was still
readable as "green plus the known flake". At 6 it is not: a real regression arriving today would
land inside a set of failures that get waved through, and the suite has stopped being a gate for
exactly the changes most likely to need one. That is the argument for chasing it now rather than
when it reaches 10 — and it is a different argument from the one this entry was filed on.

Recurred again later on 2026-09-28, in a 2306-test run, and this time in BOTH files at once:
`charts render, state their coverage, and name the 47%` (ui-client) and `the six dispositions render
in three groups` (ui-conflicts). Each file then passed in isolation — ui-client 25/25 twice,
ui-conflicts 9/9 — which is now the fourth time isolation has been clean while a full run was red.
The pattern across all occurrences: whichever mount-based test the scheduler happens to interleave
loses, and the actual value is always the loading placeholder. Nothing points at a specific
assertion any more; it points at the harness.

Recurred 2026-09-28 in a 2261-test run: `already-inserted is MUTED, and it is the only muted row`
alone, then 3 of 3 passes in isolation. Second occurrence of the same name, so it is that file's
most reproducible symptom and the place to start.

So the heading should not say `ui-client` at all. Whatever this is, any test that mounts the
client can exhibit it, and every new mount-based test inherits it — which is the argument for
chasing it rather than continuing to route around it one file at a time.

Reframed 2026-09-24 by measuring the two npm sub-suites separately, which is the one thing three
sessions of looking at aggregate lines could not do. **No tests were ever lost.**

`npm test` is `npm run test:propagate && npm run test:curate-docs` — an `&&` chain. Measured that
day: `test:propagate` holds **1911** tests, `test:curate-docs` holds **91**. So one real failure
in the first package makes it exit non-zero, the `&&` short-circuits, and the second package never
runs at all. The arithmetic closes on both recorded occurrences to the unit:

| occurrence | reported | propagate-side | + curate-docs |
|---|---|---|---|
| 2026-09-23 | 1860 of 1951 | 1860 | 1860 + 91 = 1951 |
| 2026-09-24 | 1904 of 1995 | 1904 | 1904 + 91 = 1995 |

**The instrument was the defect, and this register was handing it to the next reader.** The derive
command recommended here summed `^ℹ (tests|pass|fail)` lines with `awk {s[$2]+=$3}` across BOTH
sub-suites. When the second one does not execute there are no lines to sum, so "package B did not
run" rendered as "91 tests disappeared" — `rule:discernment-checks` §6, a reader that cannot
report failure inventing an answer, and the invented answer (a dropped shard) was far more
alarming than the truth. §4 says suspect the ruler when a number is surprising; the ruler here was
written down as the thing to trust, which is why it survived two occurrences.

Derive the two totals SEPARATELY. A single number over an `&&` chain cannot tell you which half
ran:

```sh
npm run test:propagate  2>&1 | grep -E '^ℹ (tests|pass|fail)'
npm run test:curate-docs 2>&1 | grep -E '^ℹ (tests|pass|fail)'
```

**What is still open is the original single failure**, and it is smaller than it looked:
`tests/unit/ui-client.test.mjs:252` — *"a chart path measures itself and hands the length to the
CSS"*. It is `async` and measures a rendered path, so a timing dependency is the suspect. It has
appeared twice and not reproduced on demand; four consecutive full runs since have been green.

Two things worth doing alongside it. **`&&` hides the second package's verdict:** whenever the
propagate suite fails, nobody learns whether curate-docs passes, so a failure there can sit behind
an unrelated one indefinitely. And N91's `doctor.duration_ms` spikes of 18-24 minutes may still
share a cause with an async test that is sensitive to load — that pairing survives the reframe,
because it was never about the count.

### PR-012 · `post-merge`'s completeness list is hand-maintained at 5 of 141 plugin files

Filed 2026-09-24, residual from D8/D9 of the plugin-delivery review
(`docs-plans-2026-09-23-reminders-todo-bri-playful-dawn.md`) — see that review's N78
disposition for the full decision record.

`.githooks/post-merge`'s `for f in …` loop now names 5 files (widened from 3, this
session) against 141 shipped `.mjs` files. A module added later is unchecked by
construction, and that is exactly the shape of the 2026-09-16 incident the hook was
written to catch. D8 chose the 2-line widening over sharing one definition with
`lib/report/doctor/delivery.mjs`'s `treeDigest`, on the grounds that the hook must stay
pure shell with no node dependency and that thirty net new lines was a real cost.

**The fix is a narrow entry point, not a full `doctor` run** — N91 records `doctor` taking
18 to 24 minutes on a bad day, and a git hook that blocks that long (even though git
ignores its exit code, the wait is still real) is not an option. Expose one small node
call that answers only "is the served tree missing any shipped file", built on `treeDigest`,
and have `post-merge` call that instead of its own list. **Depends on `treeDigest` landing
first** — it does not exist standalone yet outside `delivery.mjs`'s internal use.

### PR-013 · 241 of 501 gotcha entries carry no trigger, and propagate's own register is the worst

Measured 2026-09-25 across 26 `GOTCHAS.md` files: 263 entries carry a `**Trigger:**` and can
fire; 241 do not. Not every hazard has a mechanical hook and inventing one makes noise, so the
target is not 100%. The distribution is the finding, not the total:

| register | inert |
|---|---|
| `propagate/propagation/state/workspace` | **55 of 74 (74%)** |
| `propagate/propagation/state/curate-docs` | 21 of 25 (84%) |
| `Vipin Kaushik/…/sanskrit-texts` | 27 of 70 |
| `Sindhu/…/sipl-tms` | 19 of 43 |

The repo that built the trigger mechanism has the highest proportion of entries that cannot use
it — `rule:enforcement-watches-itself`'s shape, in the register rather than the code. 74% is not
a considered ratio, it is an unexamined one. The work is to walk propagate's own 55 and decide,
per entry, whether a trigger exists — not to add 55 triggers.

### PR-014 · `rules promote` stays unbuilt, and the measurement says why

`cli.mjs:1449` prints `not implemented — declared in the Phase 5 plan and not built` and tells
you to file by hand. The standing assumption was that automating promotion would pay for itself.
Measured 2026-09-25, it does not: across 26 `GOTCHAS.md` files and ~500 entries there is exactly
**one** genuinely unpromoted cross-project hazard, and it was promoted by hand the same day
(G-P). One candidate is not a pipeline.

Two corrections worth keeping with this entry. An earlier count of 31 candidates was duplicate
checkouts — `curate-docs-skill` is an archived copy of `curate-docs`, and a `worktrees/` path
without the leading dot escaped the exclusion list. A later count of 2 came from a filter that
globbed for `GOTCHAS.md` and therefore never loaded `gotchas-global.md` at all, so it excluded
nothing and looked like it worked. The true yield is 1.

So the decision this entry records is **to leave the stub standing**, with the number that
justifies it. Revisit if a census ever shows the candidate count in double figures.

### PR-015 · Decide the N35 excused bucket — 17 files the restatement check declines to read

`rules check` reports 1 restatement and separately notes that 17 files "restate a rule they also
reference — excused, not checked". Twelve of those are `tool-priority`, the rule whose whole
origin is nine divergent copies making four mutually exclusive claims. The consolidation that
fixed it left twelve files carrying a pointer and a copy at once, in the one bucket the detector
skips.

Either that is a real conversion backlog or it is a permanently-fine category, and nobody has
decided which. The decision is cheap and the ambiguity is not: a checker that reports 1 while
holding 17 unexamined by design is the N85 shape, where a number gets dismissed because most of
what it covers was never looked at.

Breakdown: `tool-priority` 12 · `secrets-source-of-truth` 2 · `state-and-decisions` 2 ·
`environment-vocabulary` 1.

### PR-016 · `INTEGRATIONS.marketplaceDir` is null here, so the fifth manifest goes unchecked in practice — **RESOLVED 2026-09-26**

`gateVersionManifests` gained the hub `marketplace.json` as a fifth location on 2026-09-25, and
on this machine it never reads it: `INTEGRATIONS.marketplaceDir` is `null`, which
`lib/skills/skills-scan.mjs:464` guards for as a normal state. The gate degrades correctly — the
four in-repo manifests are still checked and `detail` says `hub marketplace.json UNCHECKED:` with
the reason — but the fifth is verified nowhere until a hub is configured.

`propagate setup --hub` derives it. Anything else keyed on `marketplaceDir` is equally inert
locally, including skill lifecycle scans, so this is wider than one gate.

**A hub is configured now, so the fifth manifest is checked here.** Measured 2026-09-26:

```
INTEGRATIONS.marketplaceDir -> /Users/rupali.b/Documents/GitHub/skills-marketplace
HUB_ROOT                    -> /Users/rupali.b/Documents/GitHub  (from ~/.propagate/config.yml hubRoot)
gateVersionManifests()      -> passed — all five manifests agree at 0.11.0
```

It was not theoretical while it lasted: the v0.11.0 bump moved the four in-repo manifests and the
gate went **BLOCKED**, naming `hub marketplace.json=0.10.0` as the disagreement. That is the fifth
location being checked, catching a real miss, on this machine. Closed on the measurement rather
than on the config change, because "a hub is configured" is a fact that can rot — the gate's own
verdict is the thing worth recording.

**What this does NOT close:** a machine with no `hubRoot` still verifies nothing for the fifth, and
`release --check` reports that in `detail` rather than failing. That degradation is deliberate
(`release.mjs:21` — `could-not-run` is never a failure) and is described in PR-011's closure note.

### PR-017 · Decide whether the doc census earns a place in `release --check` at 21 seconds

`docs --kinds` takes **21.03s** over 1513 docs, because `proseOnlySupersession` opens every file.
The 2026-09-25 plan proposed gating it and then chose against: 21 seconds on every release, for a
number with 988 untriaged rows behind it, is how a gate gets routed around (N85).

`--json` and the full `--undeclared` worklist landed, so gating is a one-line change whenever
someone is acting on the number. The prerequisite is PR-018, not more tooling.

### PR-018 · The 988 undeclared docs now have a worklist and nobody has walked it

Of 1513 docs, 988 resolve to `undeclared` and only **13** declare `kind:` in frontmatter; the
rest are filename or directory guesses. `docs --undeclared` emits the full list with a
best-guess kind per row as of 2026-09-25 — before that it printed 8 and "… and 980 more", which
is why nobody could start.

Walking it is judgement per doc, not a sweep. `guessKind()` is advisory and deliberately never
feeds back into `kindOf()`.

### PR-019 · Triage the 63 docs already classified `design`

`design` is the fifth-largest kind and had zero consumers until the guidelines landed. The 63
docs were never triaged against the kind's own rule — `follows its surface`, staleness `age` —
so some of them describe surfaces that have moved.

Sixteen `DESIGN.md` files exist under at least two incompatible conventions (playbook-style token
docs, and `/office-hours`-generated build specs), and `Keerti-portfolio/docs/DESIGN.md` says in
its own text that its `design-tokens.json` is stale.

### PR-020 · The monitor notifies nothing in 89% of its runs

Measured 2026-09-25 over the whole log: **5057 runs, 2041 notified, 168,739 suppressed.** 4502
runs (89%) notified nothing at all, the suppression rate is 98%, and `actionable` has been pinned
at 67 for every recent run.

`rule:delegation-criteria` §2's worked example is a watcher that ran 4,420 times and found
nothing in 4,384 (99.2%), replaced by a command deriving the same answer in 1.2s. This is the
same shape at 89%. The question the rule asks is what breaks if it is computed on demand
instead — and with `actionable` static at 67, plausibly nothing.

### PR-021 · The Reminders bridge cannot reach its stated goal condition — nothing in this repo can INSERT a register line — **RESOLVED 2026-09-25**

**The capability exists.** `lib/registers/insert.mjs` composes `write.mjs`'s atomic mechanics with
`backlog.mjs`'s *exported* parsers — no forked traversal — behind three assertions, each with a
negative control AND a positive control so none is vacuous:

- **A1** rejects an embedded newline. For an insert that corrupts the file's shape, not one line's text.
- **A2** requires a *legal* boundary, not merely an unmoved anchor: mid-entry and under a closed
  heading both refuse.
- **A3** is the one that matters: simulate, reclassify, and assert the format election and every
  pre-existing `{id, closed}` are unchanged. One checkbox-shaped line flips the whole-file election
  and every id-keyed entry vanishes from `items` with **zero bytes changed** — so the guarantee is
  over the PARSE, not the bytes. Both negative controls reproduce it; making the check return true
  unconditionally turns three tests red.

`lib/reminders/sync.mjs` orchestrates it **without modifying `reconcile.mjs`**, whose
`writesToRegister: false` invariant and dry-run tests still stand. Write order is register-first
(R3/D4), so the silent-loss path is unreachable by construction — injecting a failing identity-map
save leaves the register line present and `insertedAt` absent, and swallowing that failure turns the
test red.

**The goal condition is reachable; it is not yet reached for either live tag**, and that is correct
behaviour rather than a gap: `#ccusage` has no register anywhere and `#vipinkaushik`'s canonical
path is absent while a legacy one exists. Both are refused attributably. Which register is canonical
remains a decision about the tree, not a coding call.

**This is the finding of the 2026-09-25 build, and it is a planning defect, not an execution one.**

The spec's goal condition (`docs/plans/2026-09-23-reminders-todo-bridge.md:275-282`) is *"a reminder
tagged `#<project>` in `Claude TODO` appears as an item in that project's register without anyone
running a command by hand."* That requires inserting a line into a `TODOS.md`.

**This entry's own heading was wrong twice, in two different ways, and both were invisible in the
file.** First it was filed CLOSED: the heading quoted the spec's "Done when" clause, and
`lib/report/backlog.mjs:333` matches a bare `\bdone\b` in a heading *and* looks ahead into the
body. Reworded to "goal condition" — and it then parsed under the id **`PR-007`**, because the
heading also named PR-007 and the id is taken from the wrong match, silently colliding with the
real PR-007 entry above.

Recorded rather than quietly fixed, because the shape is the point: the most important finding of
this build was first invisible, then filed under another entry's identity, and **the file looked
correct both times**. An entry is not filed until `backlog --json` says so. This is the same class
as N87 — a register asserting a state that is not real — inside the entry that documents it.

`lib/registers/write.mjs` is the only code in this repo permitted to edit a hand-written register,
and its second stated guarantee is: **"One line changes. Never more. `applyEdit` asserts the line
count is unchanged and that every OTHER line is identical."** It plans a change to exactly one
EXISTING line, identified by its full current text. Inserting is not a narrower case of that — it
is a different operation, and the file says so about `HANDOVERS.md` resolution: *"it is append-only
by its own header, so resolving INSERTS a dated block beneath rather than rewriting, which is a
different operation with a different guarantee. Stage 2."*

So the bridge as built reconciles a reminder's completion state against **its own last recorded
observation of that reminder**, and writes to no register. Every result carries
`writesToRegister: false` so a caller reading the return value cannot miss it. H5's two-writer
tie-break does not fully apply yet either: there is one clock (Reminders), not two, until a
register reader exists.

**Why nothing caught it.** The eng review, the execution plan and five lanes all read the spec,
the doctor slices and the plist generator. None opened `write.mjs`. That is
`rule:adversarial-review-reads-the-ledger` exactly — *a promise in one file that another file
cannot keep*, invisible to any review scoped to a single artifact. The rule's own words: *"Treat
'this document says X' as a claim about another file until you have opened that file."*

**DECIDED 2026-09-25: it should exist.** Rupali, asked directly. Recorded in `DECISIONS.md`
(2026-09-25, append-only) with the reasoning; this entry stays OPEN because the decision is not the
build.

**The decision is NOT "relax `write.mjs`".** It is a second operation with its own guarantees,
because the existing three do not transfer to an insert:

| existing guarantee (edit) | what it becomes (insert) |
|---|---|
| exactly one line changes, every other identical | one line is ADDED — assert a line count of +1, not 0 |
| identified by its full current text | meaningless for a line that does not exist; anchor on the NEIGHBOUR's full current text and refuse when it has moved |
| nothing written that was not previewed | unchanged, and it matters more |

`write.mjs` already anticipated this exact split for `HANDOVERS.md`: *"it is append-only by its own
header, so resolving INSERTS a dated block beneath rather than rewriting, which is a different
operation with a different guarantee. Stage 2."* That is this work.

The hazard the narrowness protects against is still real and still applies: *"a bad write does not
append a junk row — it destroys a sentence somebody meant."* An inserter is safer than an editor in
one respect (it destroys nothing) and worse in another (it multiplies, and nobody reviews an entry
that arrived on its own).

### PR-022 · `reconcileReminders()` is built, tested and mutation-proven, and no CLI verb reaches it — **RESOLVED 2026-09-25**

`propagate reminders sync` now reaches the orchestrator, copying `claims.mjs`'s subverb shape.
Dry-run by default; `--apply` required. The naming problem that blocked this is gone: the verb
reaches `sync.mjs`, which *can* touch a register, so it no longer promises something it cannot do.
Guard proven by snapshotting the whole state directory across every disposition — byte-identical
without `--apply`.

`lib/reminders/reconcile.mjs` exists, is dry-run by default, and its F2 guard is proven across all
six dispositions plus the inconclusive path — mutating the guard turned 8 of 11 tests red. But
`cli.mjs` has no `reminders reconcile` verb and `commands/reminders.mjs` is read-only by design, so
nothing a person can type reaches it.

This is a boundary artifact of the 2026-09-25 lane split: L5 was forbidden `cli.mjs` and
`commands/reminders.mjs` to keep it disjoint from L4, and correctly flagged rather than crossing
the line. The spec's own F2 pseudocode (`runCli(["reminders", "reconcile", ...])`) assumes a CLI
surface that does not exist.

**Deliberately not wired on 2026-09-25**, and the reason is PR-021: exposing a `reconcile` verb
whose name implies register reconciliation, when it cannot touch a register, ships a command that
cannot do what it says. Wire it when PR-021 is settled, and name it for what it does.

### PR-023 · The stream cursor is built and wired to nothing, so every surface shows the 7-day default — **RESOLVED 2026-09-25**

`lib/report/stream.mjs` exports `readCursor`/`writeCursor` — a single disposable ISO string, with
absence and corruption as distinct attributable outcomes, all tested. Nothing calls `writeCursor`.
`/api/stream` takes an optional `?since=`; the widget and `journal --since` take their own. So
"since I last looked" is always "the last 7 days".

The execution plan assigned the cursor to L1 and never assigned its *wiring* to any lane — caught
by L2, which flagged it rather than guessing at scope.

**The design question, which is why this was not just done:** the obvious behaviour — advance the
cursor when the panel is viewed — has a real failure mode. Glance at the panel, the cursor
advances, and the thing you did not read is now "already seen". An explicit "mark as seen" is
safer and needs an affordance nobody specified.

**Resolved with the explicit affordance, decided rather than defaulted.** `/api/stream` now reads
the cursor when no `?since=` is given and attaches `cursor: {status, error}` ALONGSIDE the payload
rather than inside it, so a corrupt cursor is reported next to the window it produced instead of
being smoothed into one. A new `POST /api/seen` route writes it, guarded by `validateSeenBody`.

**The body carries the payload's own `generatedAt`, never the clock**, and `validateSeenBody` has no
default-to-now branch by design: a body with no `at` is a caller bug, refused with 400. Stamping
`now` would mark seen an event that landed between the render and the click — advance-on-view
arriving through the back door, which is the exact behaviour this entry rejected.

`tests/cli/ui-seen-cursor.test.mjs` asserts the NEGATIVE first, and that is the reason the file
exists: reading the stream twice leaves every byte of the state dir unchanged. Marking seen writes
`stream-cursor.json` and nothing else. `windowLabel` distinguishes four cases, so "since you last
looked" and "the last 7 days because there is no cursor" never render alike.

### PR-024 · `propagate surface` text mode omits `changed`; only `--json` carries it — **RESOLVED 2026-09-25**

**This entry's own text said the asymmetry was "arguably correct as-is" and filed it as a decision
on the record. The plan superseded that and asked for it fixed**, which is what happened — noting it
so the entry does not read as still open for debate.

`changedLine()` prints one line beside the headline. The distinction that mattered is preserved:
`0` renders as `0 changed since last look`, while a null renders `could not derive what changed`,
and "no stream" stays distinguishable from "stream error". Zero and unknown are different facts.

`lib/report/surface.mjs` now derives a compact `changed` summary and `--json` carries it via
`JSON.stringify`. `commands/surface.mjs` — the text renderer — was not updated, so the number is
invisible to anyone not passing `--json`.

Arguably correct as-is: that file's own docstring calls the text form *"a fallback, not the point —
the surface is the widget."* Filed so the asymmetry is a decision on the record rather than an
oversight.

### PR-025 · `ui.client.js`'s division separator is a positional index, one insertion from mislabelling — **RESOLVED 2026-09-25**

`const FIRST_REFERENCE = DIVISIONS.findIndex((d) => !d.act)` replaces `i === 4`. The rule the line
always meant is "before the first non-actionable division"; it resolves to 4 today, so rendering is
unchanged. Its test lives in its own file rather than `ui-client.test.mjs`, which PR-008 records as
flaky, and includes a case that inserts a division above the boundary and proves the index **moves**
— which a literal 4 could not. Restoring the literal turns it red.

`commands/ui.client.js:576` renders the group separator on the condition `i === 4`, emitting an
`<hr />` plus a label that reads "reference". Index 4 is `analytics`.

Pre-existing, and preserved correctly when the `stream` division was inserted at index 5 on
2026-09-25. But it is positional: inserting a division *before* index 4 silently moves the
separator and no test asserts where it lands. Key it off the division's identity, not its index.

### PR-026 · The Reminders read path has never actually read — TCC was never granted — RESOLVED 2026-09-25

**Rupali granted Reminders access and the path read on the first try.** `propagate reminders`
against the live list, exit 0 unpiped: **5 items — 4 routed, 1 held-untagged, 0 held-unknown-tag.**

**F5 was vindicated on live data, not on a fixture.** Two completed items carry
`completedAt=2026-09-12` against `modifiedAt=2026-09-23` — **eleven days apart**. Had the clock
been `modification date`, the obvious choice the spec rejected, both would have been reported as
completed on the 23rd. The third item has the two timestamps equal, so a fixture with only that
shape would have proven nothing.

**The held item is the routing rule earning its place:** an untagged fragment of a payment
receipt (`US$236.00 / View invoice and payment details / Invoice number ...`). Not a task, no tag,
and held rather than guessed into the nearest project — written nowhere, as designed.

What remains untested is the failure side: this run proves a GRANTED read works. The seven
inconclusive reasons are still covered only by injection, which is correct — a denial cannot be
provoked on a machine where permission has been given.

Every test injects `readRemindersFn`, `exec` or `fixturePath`, so `readReminders()` composed with a
real `osascript` call has never run to success. One real attempt on 2026-09-25 (incidental, while
verifying a dynamic import resolved) returned `timeout`, not data and not `tcc-denied` — consistent
with a permission prompt nobody answered.

`rule:name-what-no-test-executes` is about exactly this: *"the better the seam, the more completely
the real constructor goes unrun"*, and its corollary names the cost — *"tools that exist for
emergencies... are discovered broken at exactly the moment they are needed."* A bridge that has
never read is a backfill that has never backfilled.

**Needs a human at the keyboard**, because a first-ever grant blocks `osascript` on a GUI dialog
that a non-interactive session cannot dismiss. Until then `doctor` will not attempt it at all — the
PR-007 deployment gate short-circuits before any read while the bridge is uninstalled.

### PR-027 · `PROPAGATE_REMINDERS_FIXTURE` is documented in one file and implemented in another — **RESOLVED 2026-09-25**

`read.mjs` now resolves the env var itself, with an explicit `fixturePath` option taking precedence
— an argument is a stronger statement of intent than an ambient variable, and that precedence is
asserted. `commands/reminders.mjs:35` is now redundant but harmless and was left alone.

**The mutation proving it went further than intended and is worth recording:** reverting the fix left
a test with no `exec` and no `fixturePath` with no seam at all, so it fell through to a real
`osascript` call against the live list — 8 seconds, 5 real items, nothing written. That is the
sharpest possible evidence the seam was genuinely missing. The payoff: `doctor` now returns a real
`pass` from a fixture where this morning it made a live 15-second call.

`lib/reminders/read.mjs:13` documents the env var as an injection seam. Nothing in that file reads
it; the only implementation is `commands/reminders.mjs:35`. So `readReminders()` called directly —
as `checkReminders` does — ignores it entirely, which is how a fixture-injected probe silently
became a live `osascript` call on 2026-09-25.

Either implement it in `read.mjs` beside the `fixturePath` option, or correct the comment to say
where it actually lives. The option seam (`fixturePath` / `exec` / `readRemindersFn`) works and is
what every test uses.

---

## Finished


### PR-033 · Lane worktrees whose work landed by squash are invisible as "done", and `git cherry` cannot see it either
**Open 2026-10-02.** propagate's premise is coordinating parallel streams across branches and
worktrees, and it has no view of the commonest parallel stream in this tree: a subagent lane in
`propagate/.claude/worktrees/agent-*` on branch `worktree-agent-*`.

**Live instances (both landed in `3cb51a8`, v0.15.16):** `worktree-agent-a80535861233b15d5` (Plan 2
plus the scratch integration merge `83d08bc`) and `worktree-agent-a6fdc017342380450` (Plan 3,
`0dadefa`). Both are still on disk; `git branch -d` refuses, because the merge was a squash.

**The obvious detector fails, measured:** `git cherry main <branch>` prints `+` (not upstream)
for all three lane commits. `rule:absence-claims-need-state-and-branch` names `git cherry` as the
method that survives squash merges, and it does — for ONE commit squashed alone. Two lanes plus
a conflict resolution squashed into one commit produce a patch-id matching neither. **What did
answer it:** diff the branch tip against `main` restricted to the files the branch touched
(`git diff --name-only <base> <branch>` then `git diff --name-only <branch> main -- <those>`).
Plan 2's branch: 37 touched, 0 differ. Plan 3's: 26 touched, 3 differ — `cli.mjs`,
`lib/core/commands.mjs`, `tests/unit/cli-commands.test.mjs`, exactly the files the other lane
also edited, so "differs" there means "a sibling added to it", not "not landed".

**Build:** a read-only `doctor` info line (or `inventory` row) listing worktrees under any
discovered repo, each graded `landed` (touched files identical on the default branch) /
`landed-with-siblings` (differ only in files another lane also touched) / `unlanded` / `dirty`,
with the cleanup command printed and never run — removal is `git worktree remove` + `branch -D`,
a destructive step that stays with a human. Floor: a repo with `.claude/worktrees/` present and 0
worktrees parsed is a blind reader, not a clean tree. Mutate: make one touched file differ and
confirm the grade flips to `unlanded`.

**Cost so far:** none lost — the two branches are the only copy of nothing. The risk is the
inverse: an `unlanded` lane that looks like leftover scratch gets deleted with `-D`.

### PR-031 · DONE — Step 2's stated target no longer exists, so the step cannot be built as written

**DONE 2026-09-30, re-pointed and half built.** `run_id` now lands on both monitor outputs — `run=<id>` on the `monitor.log` summary line and `run_id` on each `notified.jsonl` row — minted once per run from the existing `mintRunId`, and on the reconcile-failure path too so a run that could not look is still attributable. That makes the notified-to-run join exact instead of by timestamp proximity, which is the reconstruction PR-020's analysis did by hand. The JSON-log-lines half is DECLINED, not pending: `monitor.log` is key=value, already parseable, and read by doctor with a regex plus an 80-char slice — converting it would break both for nothing the id does not already give. 5 tests, and the two that matter assert what must NOT change: the stats still survive `slice(0, 80)`, and a row without an id stays valid.
**S3.** §6 step 2 is *"`run_id` + JSON log lines"*, scoped as *"`watcher.log` lines still do not
[carry one] (out of scope: watcher.mjs was explicitly off-limits for this build)."*

`watcher.log` was last written **2026-08-21**, and `watcher.mjs` **was deleted** in `2f1612b`
("delete the retired watcher"). The live log producers are `monitor.{log,stdout,stderr}.log` and
`digest.{stdout,stderr}.log`. So the step needs re-pointing before it can be built, and the
question it answers — can a log line be joined to a `doctor` run — is worth asking of the monitor,
which runs 48 times a day.


### PR-030 · DECIDED — The events layer was designed against five issues that no longer need catching

**DECIDED 2026-09-30: none of the eight is being built, and §2 is annotated as superseded rather than deleted.** Five cite issues that are closed (N9, N13, N14, N7, N6), so they would be detectors with no failing input. The three that looked like survivors are not: `row.fired` reintroduces the recorded-moment architecture the watcher retirement removed (4,420 runs, 99.2% no-ops, a baseline that INVENTED ~120 spurious rows) and all 2,949 live events are dispositions because v3 deliberately has no open moment; `row.closed`'s `age_ms` therefore has no defined start, and the derivable form already exists via each event's `observed_at_commit` plus git; `close.rejected` is proven by `tests/unit/ledger-activity.test.mjs:139`, which is where `rule:safety-flag-needs-a-test` says a guard belongs. §6 step 3 stops being pending and step 5's gate drops to 1, 2 and 4.
**S3, and the deliverable is a decision rather than code.** `docs/OBSERVABILITY.md` §2 designs
eight events and §6 step 3 records them as unbuilt. Checked 2026-09-30, every issue the event
table cites is resolved:

| event | cites | status |
|---|---|---|
| `sidecar.rejected` | N9 | RESOLVED 2026-08-13 |
| `state.baseline_changed` | N13 | RESOLVED 2026-08 |
| `plist.regenerated` | N14 | RESOLVED 2026-09-29 |
| `discovery.degraded` | N7 | RESOLVED 2026-08-20 |
| `edge.unenforced` | N6 | RESOLVED 2026-08-20 |

So building them now means building detectors for defects already fixed by other means. The three
without a closed-issue citation — `row.fired`, `row.closed` (with `age_ms`), `close.rejected` —
are the only ones whose stated purpose survives, and `row.closed`'s time-to-close is the one that
answers a question nothing currently can.

Decide: build those three, or record that the events layer is superseded by the metrics layer plus
`doctor`'s checks and stop carrying it as pending. Either way `OBSERVABILITY.md` §2 needs the
closed-issue column, because a design table citing five resolved issues reads as live work.


### PR-029 · DONE — Six of twelve metrics have no expectation, which the design calls decoration

**DONE 2026-09-30.** Four calibrated from 1,092 records, two deliberately not, and one of the two turned out to be a defect rather than a calibration gap. `ledger.malformed == 0` (1,092 clean runs). `doctor.duration_ms < 30 min` — NOT the design's p95 < 5s, which 95.8% of runs miss, because a permanently-red doctor gets ignored; 30 min sits ~5x above p99 and below all four real outliers, so it is the first thing that can fail on N91. `sidecars.problems <= 2` as a ratchet (45 of 1,092 non-zero, max 2). `sidecars.loaded >= 40` as a floor, because N9's failure direction is downward. `rows.open` stays exempt with a corrected reason — it is a trend question and `doctor --since 30d` answers it. And `state.tracked_files` is N115: 831 consecutive zeros because it measures `~/.propagate/state.json`, which does not exist.
**S2.** `doctor` prints `uncalibrated metrics recorded, not asserted  rows.open,
doctor.duration_ms, sidecars.loaded, sidecars.problems, ledger.malformed, state.tracked_files`.
`docs/OBSERVABILITY.md` §6 closes with *"a metric without an expectation is decoration. Every
gauge above ships with the assertion that makes it alertable, or it does not ship."* Six of twelve
do not.

**Not simply "add thresholds."** G3/G16 say an invented number is worse than none, which is why
these were left uncalibrated deliberately. The work is to decide, per metric, whether a real
expectation is derivable from history — 841 records exist — or whether it stays uncalibrated with
that stated. `doctor.duration_ms` is the one with a live defect attached ([[n91]]: spikes at 18-24
minutes, hit three times on 2026-09-30), so it is the natural first.


### PR-028 · DONE — `doctor --since <t>` — the cheapest telemetry item, and the one step 1 points at

**DONE 2026-09-30.** Built as `parseSince` + `summariseSince` (`lib/report/metrics.mjs`) with a renderer in `cli.mjs`; 0.7s against a doctor run's minutes. 13 tests, three mutations each red for their stated reason. Its first real run re-measured N91: `doctor.duration_ms` max over 7 days is **188 minutes**, not the 18-24 that entry records.
**S2.** `docs/OBSERVABILITY.md` §6 step 4, and its own words say why this is first: *"a `--since`
flag is a thin CLI layer over data that already exists, not a new storage problem."*
`readMetricsRecords` and `readLastMetricsRecord` (`lib/report/metrics.mjs`) already read the full
history and the newest record.

It also closes the limitation step 1 states about itself: *"`doctor` is a manual/point-in-time
check; nothing in this codebase runs it on a schedule… a metric that regresses between `doctor`
invocations is invisible until someone runs `doctor` again."* §6 names step 4 as the thing that
closes it.

Acceptance: a window with no records reads as `no records in that window`, never as `nothing
wrong` — `rule:discernment-checks` §2. And the flag must not silently accept an unparseable
timestamp.


### PR-032 · DONE — `docs/SYSTEMS.md` describes a refusal guard on `watcher.mjs`, which is not on disk

**DONE 2026-09-30.** The row corrected. Two of its three artifact claims were false: `watcher.mjs` was deleted in `2f1612b`, and the heartbeat was given at `~/.claude/skills/propagate/heartbeat`, a path the plugin cutover removed (`HEARTBEAT_PATH` resolves to `~/.propagate/heartbeat`, also absent, guarded by `existsSync`). The archived plist is present, verified 2,700 bytes.
**S3.** Found 2026-09-30 while scoping the telemetry items. The row reads *"`watcher.mjs` (kept on
disk, header records the retirement, refuses to run directly without
`PROPAGATE_ALLOW_RETIRED_WATCHER=1`)"*. The file was deleted in `2f1612b`.

A retirement row describing a safety guard on a file that does not exist is the reassuring half of
`rule:enforcement-watches-itself`: the prose is fluent and there is nothing behind it. The fix is
one row, and it matters because that row is the archive record for how the watcher was retired —
`rule:measure-the-claim-not-a-proxy`, where the claim is about a file and nobody statted it.




### PR-011 · A fifth version-manifest location the delivery gate does not check: hub `marketplace.json` pinned at 0.5.0

Filed 2026-09-24, deferred by D1 of the plugin-delivery review
(`docs-plans-2026-09-23-reminders-todo-bri-playful-dawn.md`) rather than folded into that
review's 7-file scope.

`skills-marketplace/.claude-plugin/marketplace.json` (the `tathya` marketplace) pins
propagate at `0.5.0`, last touched 2026-09-01, while the repo's `VERSION` is `0.6.2`.
`gateVersionManifests` (`lib/core/release.mjs:48-55`) checks only the four in-repo version
strings (`VERSION`, `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`) and never reads this fifth, cross-repo one.

**`propagation/state/workspace/DECISIONS.md:1169-1171` overstates what this gap does** —
it claims the gap can "leave the served plugin behind." N78's own transcript refutes that:
the updater reported *"already at the latest version (0.6.1)"* while the hub manifest
still said `0.5.0`, so the marketplace `version` field is stale listing metadata, not
something `claude plugin update` consults to decide whether to re-copy. Correcting
`DECISIONS.md:1169-1171` is part of this work, alongside adding the fifth path to
`gateVersionManifests` and the cross-repo `VERSION` edge that would keep it in step.

**Landed 2026-09-25.** `gateVersionManifests` (`lib/core/release.mjs`) reads the hub manifest as
a fifth location via `INTEGRATIONS.marketplaceDir`, and all five now agree at `0.7.0`. The fifth
degrades alone: an unreachable hub leaves the four in-repo manifests checked and says
`hub marketplace.json UNCHECKED: <reason>` in `detail`, because returning `could-not-run` for the
whole gate stopped it gating at all — `release.mjs:21` says that status is never a failure.
Machines without a configured hub still verify nothing for the fifth; that is PR-016.
The reader treats this section as closed wholesale, so entries move here rather than
being edited in place.

### PR-001 · Decide whether `notStarted` fails the v3 conformance gate

Answered by Rupali 2026-09-24: it fails. Implemented with one carve-out, which is the
part worth remembering — the predicate is adoption ASYMMETRY, not absence. Some
workspaces conforming while others never began is a gap someone chose not to close, and
it fails. Nothing having begun anywhere is a starting point, and failing it would fail
every fresh install by definition; `tests/cli/stranger-install.test.mjs` asserts a
stranger reaches doctor-clean, and the `|| true` that once hid that was deliberately
removed.

The decision lives in `migrationVerdict` (`lib/core/v3-layout.mjs`), pure and unit-tested
in `tests/unit/v3-migration-verdict.test.mjs`, because as three inline branches in
`discovery.mjs` the repo's own coverage audit correctly reported the check as never
having been seen to fail.

### PR-002 · Write the slices 2-3 plan for `doctor`

Written 2026-09-23 as `docs/plans/2026-09-23-doctor-slices-2-3.md` (`87ef7f4`), after
slice 1 landed. It corrected N87 twice while being written: "14 distinct check classes" is
60 `reporter.check` call sites across 8 modules, and the 354 warnings come from NINE static
warn sites, five inside loops that interpolate their LABEL from the row — which is why
"299 distinct kinds" is one row per kind by construction and cannot fold.

### PR-009 · Decide whether an in-tree ledger holding 0 rows is a defect

Answered 2026-09-24: it is not. `ensureLedgerPair` does `writeFileSync(ledgerJsonl, "")` and
NOTHING in this repo appends a row to any ledger file, so an empty in-tree ledger is the only
state the code can produce. Making it fail or go inconclusive would have reddened `doctor`
permanently over a correct condition — the inverse of the G68 fix, not an instance of it.

Rupali chose retirement. The vacuous half is gone (it passed `true` unconditionally); the
catch-branch check stays, because a genuine read throw IS a defect. The row count is now an
`info` naming where the events actually live.

It was already redundant twice over: `discovery.mjs`'s malformed-JSONL counter exists
because *"readLedger silently continues past unparseable lines, so the existing `ledger JSONL
parseable` check above is vacuous"*. Two readers reached that conclusion before this one, and
neither removed the check.

This also settles the open half of N84: in-tree ledgers are v1 scaffolding superseded by the
event store, with the `.md` half already frozen and unrendered.

### PR-003 · Brainstorm whether propagation state wants a schema rather than files

Answered 2026-09-24: **no, not yet** — and it ships with a falsification contract rather than a
preference. Rupali set the condition that decided the shape: *"make sure we measure this, because
otherwise we wont know whether the db is required or not."* So the answer carries six tripwires
with baselines taken before any change, in `docs/plans/2026-09-24-parser-collapse.md`.

The measurement that settled it, re-derived the day this closed: **23 owners, 17 conform to the
v3 layout, 2 half-migrated (Sindhu and propagate itself), 4 never begun.** Starting a storage
migration while a layout migration is unfinished across ~20 repos means two partial migrations at
once, and a partial migration is the state that loses data. That is a number, not a taste:

```sh
node --input-type=module -e 'import {SEARCH_ROOTS,WORKSPACES} from "./lib/core/config.mjs";
import {ownerCandidates} from "./lib/core/discovery.mjs";
import {conformanceReport} from "./lib/core/v3-layout.mjs";
const r=conformanceReport(ownerCandidates(SEARCH_ROOTS,WORKSPACES));
console.log(r.total, r.offenders.length, r.notStarted.length)'
```

What landed instead of a schema:

| slice | what it does |
|---|---|
| 3a | `lib/docs/tokens.mjs` — one fence-aware heading scanner, extracted from the most-hardened parser (`handovers.mjs`) rather than designed fresh |
| 3b | `caps.mjs`, `registers.mjs` and `handovers.mjs` routed through it. Two real bugs fell out: `~~~` fences and unterminated fences were both invisible to `countEntries` |
| 3d | `lib/report/index-view.mjs` — the cross-workspace view, pure, importing nothing, provably cacheless |

**Two parts of the plan were withdrawn after measurement rather than after debate**, which is the
part worth keeping. §3c would have made `kindOf` authoritative — but it gives `HANDOVERS.md` a
null kind, so making it authoritative would have silenced a whole register. T6 counted
line-anchored regexes in `lib/`, which rewards deleting legitimate marker patterns; a metric that
pays you for removing checks is worse than no metric. And `goals.mjs` turned out to be collapsed
already, which invalidated the plan's own parser ordering before it was executed.

**T2 is the decisive tripwire.** If the index ever acquires a cache, a state file or a staleness
check, the derive-on-demand premise failed and a database was the right answer after all.

### PR-010 · gbrain writes a heartbeat nothing reads, so "alive but silent" has no name

Investigated 2026-09-24 and **retired: the premise was wrong, and the prescription had already
been tried upstream and withdrawn for corrupting data.** Recorded rather than deleted, because
the reasoning that produced it was sound and the next person will have the same idea.

The observation was real: PID 22608 lived 50.8 h with a 45.3 h-old heartbeat, held the PGLite
single-writer lock, and closed gbrain's MCP for every session in between. What was wrong was
"so it has no name".

`~/Documents/GitHub/scripts/gbrain-check.sh` carries a section headed *"THERE IS DELIBERATELY NO
'STALE LOCK' CHECK"*, naming the two theories an earlier draft held and refuting both from
gbrain's own lock code:

| the theory | why it is wrong |
|---|---|
| a stale heartbeat means a dead holder | gbrain **#2348 removed** steal-on-stale-heartbeat: the heartbeat runs on the JS event loop, which is BLOCKED during long synchronous imports, so a WORKING holder looks stale. Reaping one corrupted the catalog and pgvector state |
| an abandoned lock file blocks the CLI | `acquireLock` classifies by PID liveness and reaps a dead holder itself (`pglite-lock.ts:239-249`). A dead lock is self-healing; reporting it would be noise |

So the verdict PR-010 asked for is the one that destroys data, and **both verdicts that are
sound already exist**: the heartbeat age is used for ATTRIBUTION — the skip reason reads
`held by a live gbrain serve (PID N, heartbeat Ns ago)` rather than "could not connect", which
is exactly the `rule:discernment-checks` §2 job PR-010 claimed was missing — and an orphaned
serve (`PPID=1`, its session gone) is check **#2 ORPHANS**, already a finding.

**PID 22608 was neither.** Its parent was a live `claude` session at PID 22249, so it was not an
orphan; and it was alive, so no liveness probe could fault it. From outside the process, a
session holding the lock for 50 hours and a session that stopped reading its pipes 45 hours ago
are indistinguishable — which is why the script calls it normal operation and says so
attributably. That is the correct behaviour, not a gap.

**What is left is not gbrain's.** The residual symptom is that a Claude Code MCP server which
fails to spawn stays `CONNECTION_CLOSED` for the whole session and never retries, so clearing
the lock mid-session does not revive it. Verified 2026-09-24: with PID 22608 gone,
`gbrain-check.sh` returns `rc=0, no findings` and no process holds the lock, while this session's
gbrain MCP stayed dead from the spawn that failed before the kill. That is an MCP lifecycle fact,
not a propagate or gbrain defect, and it is the reason this looked like a recurrence.

### PR-004 · Clear the `gbrain serve` process holding the PGLite lock

Cleared 2026-09-24. PID 22608 was sent SIGTERM after Rupali's go-ahead — it had been alive 50.8 h
with a 45.3 h-old heartbeat, holding the PGLite single-writer lock and blocking four
`gbrain-check.sh` probes (STALE, CODEPAGES, EMBED, CLAIM).

Killing it unblocked all four and immediately surfaced two things the lock had been hiding: the
memory corpus was **32 days stale** (newest page 2026-08-23 against a 14-day threshold) and embed
coverage sat at 90%. Both were repaired in the same pass — 943 pages, 6431 chunks — and the
worktree was pinned via `.gbrain-source` -> `gstack-code-propagate` (gitignored) so the next sync
indexes the intended tree. gstack went 1.87.4.0 -> 1.89.0.0 and gbrain 0.50.5.0 -> 0.54.1.1,
15 migrations, verified.

Confirmed on close: `bash ~/Documents/GitHub/scripts/gbrain-check.sh` returns `rc=0, no findings`
and no process matches `gbrain serve`. The one NOT CHECKED line is QUEUE, which has no queue file
— a skipped check named as skipped, which is the correct output rather than a pass.

**This was a symptom, not the disease, and [[PR-010]] is where the disease was investigated and
the obvious fix was refuted.** A manual kill cannot be the answer: gbrain is an stdio MCP server
spawned per session, so hand-starting a standalone `gbrain serve` recreates this exact state.