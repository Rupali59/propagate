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
node cli.mjs backlog --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.stats||{}))})'
```

---

### PR-005 · Give the 18 undispositioned `ISSUES.md` entries a marker

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

### PR-008 · Chase the intermittent `ui-client` failure — the 91 "missing" tests were the ruler

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

## Finished

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
