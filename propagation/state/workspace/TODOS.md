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

### PR-003 · Brainstorm whether propagation state wants a schema rather than files

Raised by Rupali 2026-09-23. The question is whether ledgers, issues, goals and refs should
live in a queryable store instead of markdown and JSONL parsed by convention. Five independent
pieces of evidence already sit in this tree:

| source | what it shows |
|---|---|
| N84 | every in-tree ledger holds 0 rows; 2892 events live outside every git remote |
| N19 / N20 | 39 event rows carry a terminal status with no transition; 87% of the Vipin Kaushik ledger is hand-authored, outside any schema |
| N81 | five more files colocate a machine-parsed grammar with append-only churn |
| G26 | two incompatible `refs/snapshot.json` shapes both declare `schema_version: 1`, costing 4 spurious records in an append-only file |
| 2026-09-23 | the backlog reader counted 87 prose `N\d+` tokens as 68 issues, because the schema is markdown headings |

G26 is the sharpest: a version field that cannot distinguish two live formats is what a schema
looks like when it is a convention. This is architectural and partly upstream of N87 — it wants
its own brainstorm, not a fold-in.

### PR-004 · Clear the `gbrain serve` process holding the PGLite lock

Measured 2026-09-23: PID 22608 (`bun gbrain serve`), alive 31.6 h, last heartbeat 26.1 h prior,
parented by a `claude` session at PID 22249 that is also 31.6 h old. PGLite is single-writer, so
that process blocks four of `gbrain-check.sh`'s probes (STALE, CODEPAGES, EMBED, CLAIM) and is
why gbrain's MCP reported `CONNECTION_CLOSED` this session.

Needs a human: killing another session's process is Rupali's call, and that terminal may be in
use. Re-run `bash ~/Documents/GitHub/scripts/gbrain-check.sh` afterwards for the four real
answers.

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

### PR-008 · Find the suite run that loses 91 tests instead of failing one

Observed once, 2026-09-23, during N87 slice 1: `npm test` reported `tests=1860 pass=1855
fail=1` where three runs either side of it reported `tests=1951 pass=1947 fail=0`, exit 0.
Re-running never reproduced it, and no `✖` line named a test.

**The signature is the interesting part: 91 tests went MISSING, rather than one failing.**
That is a sub-suite ending early — a timeout, an unhandled rejection, or a process exiting
before its file finished — and the aggregate line renders it as an ordinary failure count.
A suite that can lose 91 tests while reporting `fail=1` cannot be trusted to say a run was
complete, which is the same shape as N87 mechanism 2 one level out: the number is about a
population nobody checked was whole.

Derive the expected total before trusting any single run:

```sh
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)' | awk '{s[$2]+=$3} END {for(k in s) print k, s[k]}'
```

Worth pairing with N91, which tracks `doctor.duration_ms` spikes of 18-24 minutes — an
intermittent slowdown and an intermittently truncated suite may be the same cause.

### PR-010 · gbrain writes a heartbeat nothing reads, so "alive but silent" has no name

Measured 2026-09-24: `gbrain serve` (PID 22608) stayed alive **50.8 hours** while its last
heartbeat was **45.3 hours** old. It heartbeat for roughly its first 5.5 hours, stopped, and
then held the PGLite single-writer lock for another 45 — blocking four `gbrain-check` probes
and closing gbrain's MCP for every session in between.

**`gbrain-check.sh` already has the number.** It printed `heartbeat 163089s ago` in the very
message explaining why it could not run. It has the age and no rule that turns it into a
finding, so a 45-hour silence rendered as "this is normal, not a fault".

**The pattern to copy is in this tree, for a different component.** `docs/SYSTEMS.md`'s
`claude-usage-sample` row specifies four exit codes — `0` fresh · `3` stale · `4` never ran ·
`5` unreadable — *"because 'never ran' and 'ran and went quiet' are different facts and only one
is a launchd problem"*. Code `3` is exactly the state gbrain has no name for. That row also
warns the probe reads the OUTPUT and so cannot tell you the process is loaded: pair it with a
process check.

**Root cause worth keeping:** gbrain is an stdio MCP server
(`mcpServers.gbrain` = `gbrain serve`), spawned per session and spoken to over pipes. When its
client goes away it can sit alive holding the lock with nobody reading. So the fix is a
stale-heartbeat verdict, NOT a manual restart — hand-starting a standalone `gbrain serve`
recreates this exact state.

Also surfaced the moment the lock cleared, and hidden by it: the memory corpus is **32 days
old** (newest 2026-08-23, threshold 14d). `/sync-gbrain` is the fix.


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
