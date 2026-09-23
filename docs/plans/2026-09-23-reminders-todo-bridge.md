# Plan: bridge Apple Reminders to project TODOS, on a schedule, in both directions

Requested by Rupali 2026-09-23. Three forks were put to her and settled, and one was put
twice and overruled — recorded below, because the overruled one is this plan's main risk.

## Context — measured, not assumed

The list already exists: **`Claude TODO`**, 5 reminders. Read 2026-09-23 via `osascript`:

| done | title | body tag |
|---|---|---|
| ☐ | `US$236.00 / View invoice / Invoice number L7DN63XC-0018 …` | — |
| ☐ | Add upcoming purnima and amavasya dates in the panchang | `#vipinkaushik` |
| ☑ | Error while reload when process not run -fix this | `#ccusage` |
| ☑ | a section of per day in the week recommended usage vs actual … progress bars … | `#ccusage` |
| ☑ | ccusage — spawnSync npx ETIMEDOUT, stale 38h | `#ccusage` |

Rows 3 and 4 were untagged until this session; Rupali supplied `#ccusage` and they were
written back. **The corpus now has exactly one untagged item, and it is the only entry that
is not a task** — a share-sheet invoice paste with a multi-line title.

Six facts the corpus establishes, each of which contradicts an assumption this plan was
about to make:

1. **The tag lives in the BODY, not the title.** A title-based parser reads nothing.
2. **Tags are project nicknames, not workspace names.** `#vipinkaushik` → `Vipin Kaushik`;
   `#ccusage` → `claude-usage-widget`, which lives under `Rupali/`. A normalization table is
   mandatory and is the artifact most likely to rot.
3. **Not every reminder is a task.** 1 in 5 today. A writer with no reject state converts
   capture noise into a permanent register entry.
4. **Titles are prose, not headings.** *"a section of per day in the week recommended usage
   vs actual and allowed remaining as progress bars instead of numbers"* needs summarising.
   This is the whole of "intelligent"; everything else is plumbing.
5. **Both sides already write `done`.** Rupali ticks reminders; so do working Claude
   sessions — she asked the widget thread to mark its items complete, which is why 3 of 5 are
   ☑. Two live writers, today, with no log and no reconciliation.
6. **Reminder ids are stable UUIDs** — `x-apple-reminder://BC0A7D6C-0935-41CA-9CC6-E89E8C0C8CD6`.
   Identity has a real key; nothing needs to match on title.

## Decisions

| fork | decision |
|---|---|
| when to read | **Every 12 hours, riding `propagate-digest`** — 09:00 + 21:00, no new agent |
| routing | body hashtag is authoritative; **untagged is held, never written** |
| completion | **bidirectional, last-write-wins, with an append-only reconciliation log** |

### The overruled fork, recorded

`rule:delegation-criteria` §2 argues against scheduling: *"Before scheduling anything, ask
what breaks if it is computed on demand instead"*, on the evidence of a watcher that ran
**4,420 times and found nothing in 4,384**. That was put to Rupali with the on-demand
alternative and she chose scheduled twice. It is her call and this plan implements it.

**Settled at every 12 hours** (2026-09-23), down from the 15-minute cadence the option
described. That changes the arithmetic the rule argues from: ~730 runs a year against
~35,000, over a list holding 5 items. The waste the rule objects to becomes negligible, and
the component still has to justify its existence on the same terms.

**Use `StartCalendarInterval` with TWO entries, not `StartInterval: 43200`.** On a laptop that sleeps the
two behave differently: a calendar interval fires on wake when its window was missed, while
a plain interval drifts by the accumulated sleep time and silently wanders away from the
hour it was installed at. `com.tathya.hygiene.collect` uses `StartInterval: 1800`, which is
right for a half-hourly job and wrong for a daily one — do not copy that key across.

**The consequence to accept, stated plainly:** completion latency is now up to 12 hours in
both directions. Tick a reminder on your phone and its TODO stays open until the next run;
finish work in a repo and the reminder stays unticked just as long. Reading at read-time as
well would remove that, and the two are not exclusive — the daily job would then answer only
the question on-demand genuinely cannot, which is "nobody has looked at this in N days".
Recorded as an option, not a reopened argument.

The obligations come with the choice, and she selected the option that names them:

- an entry in `docs/SYSTEMS.md` **from the day it lands**, with a real liveness probe
- the probe runs `plutil -lint` on the **installed plist FILE**, not on the running job

That second point is G-O, and it is not hypothetical: on 2026-09-14
`com.rupali.claude-usage-sample.plist` was truncated from 2846 bytes of XML to 94 bytes of
JSON and **nobody noticed for seven days**, because launchd keeps a bootstrapped job in its
own database and never re-reads the file. `launchctl list` stayed green, the agent kept
running, its own liveness probe kept returning 0.

## Hazards, with fix order

**H1 · TCC will deny Reminders access to a launchd agent, silently.** An agent is not a
terminal; the Reminders grant does not follow. The failure mode is an empty read that looks
identical to "no new reminders" — `rule:discernment-checks` §2, and the reason §2 exists.
**The reader must distinguish `0 reminders` from `could not reach Reminders` and exit
differently.** Establish this BEFORE anything else is built; if the grant cannot be obtained
for a background agent, the scheduled design does not work and the fork reopens.

**H2 · The reconciliation log is append-only and cannot be withdrawn.** N44 cost 2 junk
events permanently; the 2026-08-17 instance cost 11 spurious events and 3 silently-closed
worklist items. `rule:safety-flag-needs-a-test` applies in full: the writer ships dry-run by
default, and a test asserts the log is **byte-identical** before and after a non-`--apply`
run, across every disposition — not that the output says "would".

**H3 · Tags may be separated by CR, not LF.** Found in this session's own write: AppleScript
`return` is CR, so a body reads `…gh ENOENT error\r#ccusage`. A `\n`-anchored parser misses
it. Split on CR, LF and CRLF, and carry the CR case as a fixture.

**H4 · The tag→workspace table is the rot surface.** `#ccusage` resolving to a directory that
no longer exists must fail loudly. A test asserts every tag in the table resolves to an extant
path, and that an unknown tag is held rather than guessed.

**H5 · Two writers, no ordering.** Last-write-wins needs a clock, and Reminders' modification
timestamp is the only one both sides share. Where it is absent or equal, the item is held and
reported — never silently resolved one way.

## Eng review 2026-09-23 — two decisions that change the shape

Reviewed against `docs/SYSTEMS.md`, which the first draft of this plan never consulted.
That file answers most of the questions a new background component raises, and it judged
this one three times.

### D1 · Ride `propagate-digest`. Add no agent.

The first draft proposed a new launchd agent **in the repo that retired one for exactly this
reason**. `docs/SYSTEMS.md` row `propagate`: a 60-second agent, retired 2026-08-14 on
**4,420 runs / 4,384 no-ops (99.2%)**.

`propagate-digest` already exists: launchd, `StartCalendarInterval 09:00`, plist generated
by `writeDigestPlist()` (`lib/core/plist.mjs`), delivering to `~/.claude/DAILY.md` plus an
osascript notification. The 12-hour cadence is a **second calendar entry** on that plist,
and the sync is a digest section.

**Generate the second entry in `writeDigestPlist()`; never hand-edit the plist.** That row
records the digest plist was hand-maintained until 2026-08-20 and hardcoded
`/opt/homebrew/bin/node`. Do not regress it.

| | before | after |
|---|---|---|
| new launchd agents | 1 | **0** |
| new plists | 1 | **0** |
| new delivery channels | 1 | **0** |

### D2 · Failures surface in `doctor`

**A `SYSTEMS.md` row alone does not integrate failure.** `lib/report/adoption.mjs` parses
the `liveness_probe` column and *prints* it — `formatAdoptionLines()`'s own comment reads
*"the machine asks, it does not answer or suggest."* Nothing executes a probe. That is
deliberate for judging ADOPTION and insufficient for detecting FAILURE.

**The tree already contains the realised version of this bug.** `ssjk-mongo-backup` is
*"active, and has produced ZERO backups"* — daily, exit **0**, logging
`SKIP: motherboard-mongodb not running`. Its row states the rule verbatim:

> *"Probe the OUTPUT, never the exit code — this row exists because they disagree."*
> *"skipping is spelled as success."*

A TCC-denied Reminders read is that shape exactly: empty result, exit 0, rendered as "no new
reminders", unnoticed until a human runs a command.

### The ordering dependency D2 creates

**This plan is now a consumer of the N87 fix** (`docs/plans/2026-09-23-doctor-tells-the-truth.md`).

- `doctor` emits 354 warnings across 299 kinds today. A check added before N87 slices 2-3
  land is **warning 355**.
- The bridge's check **declares its severity in the check class**, from day one, per N87
  slice 2's contract.
- **A TCC denial is `INCONCLUSIVE`, not `fail`.** It is "could not look" — precisely the
  fourth entry kind N87 slice 2 introduces. Pass is the defect; fail is also wrong, because
  nothing is broken. This plan is the first real customer for that state.

### Three tests this review adds

1. **The inconclusive path**, which is the one that will actually fire: a fixture simulating
   `rc=1` with `(-1743)`, asserting the run reports INCONCLUSIVE, writes nothing, and does
   **not** render as `0 reminders`. The `ssjk-mongo-backup` case in test form.
2. **The liveness probe's four exit codes**, on the `claude-usage-sample` model: `0` fresh ·
   `3` stale · `4` never ran · `5` output unreadable. Its row says why — *"'never ran'" and
   "'ran and went quiet'" are different facts and only one is a launchd problem"*. Pair with
   `launchctl list` (an output probe cannot tell you the agent is loaded) and `plutil -lint`
   on the installed file (G-O: seven days green while the file was destroyed).
3. **F2's dry-run store snapshot**, already specified below, across every disposition.

## Fixes for the hazards — three verified against the live list, two specified

Probed 2026-09-23. H1, H3 and H5 are no longer predictions.

### F1 · Tell "found nothing" from "could not look" by EXIT CODE, then name the reason

Measured, with the status captured before any pipe (`rule:discernment-checks`, the
`cmd | head` trap):

| case | rc | stdout |
|---|---|---|
| real list, zero matches | **0** | empty |
| missing list | **1** | `…Can not get list "___missing___". (-1728)` |
| bad syntax | **1** | `…(-2753)` |
| healthy read | **0** | data |

So the reader treats `rc = 0 AND empty` as FOUND-NOTHING, and any `rc != 0` as
COULD-NOT-LOOK, parsing the trailing `(-NNNN)` to say which: **-1743 is the TCC denial**,
-600 is app-not-running, -1728 is a missing object.

**This downgrades H1.** A denied grant now announces itself on the first run instead of
rendering as an empty list, so the TCC question is safe to discover in production rather
than being a silent design-invalidator. It does NOT remove the need to find out whether a
launchd agent can hold the grant — it removes the danger of not noticing.

### F2 · The reconciler is dry-run by default, and the test measures the STORE

`rule:safety-flag-needs-a-test` in full: not "the flag is read", not "the happy path
works" — construct the input that would take the unsafe path and assert it does not.

```js
const before = logSnapshot(stateDir);              // every byte of the append-only log
runCli(["reminders", "--reconcile"], env);          // NO --apply
assert.equal(logSnapshot(stateDir), before,
  "reconcile WITHOUT --apply must not touch the log");
```

Run it across every disposition the reconciler can reach, not one — the three recorded
instances of this defect were each one guarded path beside one unguarded path, and a
single-case test passes on all three. Then mutate the guard and confirm the test goes red
**for the stated reason**, checking the mutation actually applied.

### F3 · Split tags on CR, LF and CRLF — with this reminder as the fixture

Proven against the live body, which this session itself wrote:

```
bytes : … O E N T   e r r o r \r # c c u s a g e
split(/\n/)          -> []            <- the tag is INVISIBLE
split(/\r\n|\r|\n/)  -> ["#ccusage"]
```

AppleScript `return` is CR. Any body written by a script that joins with `return` — as
this one did — is unreadable to a `\n`-anchored parser, and the failure is silent: the
item simply routes nowhere, looking identical to an untagged one.

### F4 · The tag table fails loudly when a tag stops resolving

`#ccusage` -> `Rupali/claude-usage-widget`, `#vipinkaushik` -> `Vipin Kaushik`. Two rules,
both tested:

- every tag in the table resolves to a directory that **exists on disk** — a test walks the
  table and asserts it, so a renamed or retired project breaks the build rather than routing
  into a path nobody reads
- an **unknown** tag is HELD and reported, never guessed into the nearest match. A fuzzy
  fallback here is the `rule:discernment-checks` §6 failure: a reader that cannot report
  "I did not understand this" invents an answer

### F5 · Use `completion date`, NOT `modification date`, as the clock

Probed: Reminders exposes `creation date`, `modification date` and `completion date`.

`modification date` is the wrong field and would have been the obvious choice —
**this session bumped it to 15:36 merely by editing a body to add a tag**, on an item whose
completion state did not change. Using it, a tag edit would read as a newer completion and
win a reconciliation it should have lost.

`completion date` is `missing value` while open and a real timestamp when done, so it is a
precise per-item clock for the only transition being reconciled. Where both sides carry a
completion timestamp within the same run and they disagree, the item is **held and
reported** — never resolved silently by tie-break.

## Shape

- read via `osascript` (present; no new dependency). Swift/EventKit is the fallback if H1
  forces a compiled helper with its own TCC identity
- identity: reminder UUID ↔ `PR-0NN`, mapped in one store
- untagged and not-a-task items are listed by a `propagate reminders` command and written
  nowhere
- "intelligent" is scoped to exactly one thing: turning a prose title into a TODO heading
  while preserving the original verbatim in the body. Nothing else is inferred

**The mapping store is provisional.** It is the identity table that PR-003 — whether
propagation state wants a schema rather than files — exists to answer. Build it as JSON, in
one file, behind one reader, so replacing it later touches one module.

## Goal state

**Done when:** a reminder tagged `#<project>` in `Claude TODO` appears as an item in that
project's register without anyone running a command by hand, an untagged reminder appears in
neither, and completing it on either side is reflected on the other by the next run (<= 12 h).
**Derived by:** `node cli.mjs reminders --json` compared against
`osascript -e 'tell application "Reminders" to tell list "Claude TODO" to get {name, completed} of every reminder'`
