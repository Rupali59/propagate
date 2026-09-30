> Entry point: [`../skills/propagate/SKILL.md`](../skills/propagate/SKILL.md) · Index: [`README.md`](./README.md)

# Propagate — issue register

> **Disposition vocabulary, added 2026-09-29.** Every `### N…` heading ends in exactly one
> of these, in bold. Derive the tally; never restate it:
>
> **A disposition carries its EVIDENCE, not only its verdict.** The commonest defect in this
> register is a disposition measured on a proxy — file existence for a live hazard ([[n26]]),
> an open GitHub issue for an unfixed defect ([[n16]]), a sentence's shape for a severity
> ([[n84]]). Seven instances in two days, and `OPEN` alone cannot be audited where
> `OPEN (4 files still on disk)` can — which is how two of those were caught, by their own
> author re-reading his own line. Named by `rule:measure-the-claim-not-a-proxy` since
> 2026-09-30.
>
> ```sh
> node -e 'const l=require("fs").readFileSync("propagation/state/workspace/ISSUES.md","utf8").split("\n").filter(t=>/^### N\d+/.test(t));
> const D=/\*\*(OPEN|RESOLVED|BLOCKED|ACCEPTED|APPLIED, UNVERIFIED|WITHDRAWN|MOOT)\b/;
> console.log(l.length+" headings, "+l.filter(t=>!D.test(t)).length+" undispositioned");'
> ```
>
> | word | means |
> |---|---|
> | `OPEN` | live, and nobody is on it |
> | `BLOCKED` | cannot proceed; the precondition is named beside it |
> | `ACCEPTED` | the cost was taken deliberately and will not be reverted |
> | `APPLIED, UNVERIFIED` | the change was made; the verification is outstanding |
> | `RESOLVED <date>` | closed, with the measurement or code path that closed it |
> | `MOOT` | the thing it describes no longer exists to be wrong |
>
> **The vocabulary exists because the count was unmeasurable.** `PR-005` reported 18
> undispositioned entries using `/\*\*OPEN\*\*/` — so seven that DID carry a disposition
> were counted as carrying none, because they said `— OPEN` unbolded, `**OPEN (TODO)**`,
> `**ACCEPTED, NOT REVERTED**`, `**BLOCKED (on Phase D)**` or
> `**APPLIED 2026-08-29, VERIFICATION PENDING**`. Those seven were not sloppiness: `BLOCKED`,
> `ACCEPTED` and `APPLIED, UNVERIFIED` are real states this register needed and had no word
> for, so people invented one each time. A register whose own tally is an artifact of its
> matcher is `rule:discernment-checks` §4 living inside the defect register — which is the
> same sentence `PR-005` used about §2, one level further in.

> **Triage pass, 2026-08-20.** Every entry marked RESOLVED or MOOT below carries the
> measurement or code path that closed it, not a judgement. **Nine of the twenty-five
> "open" issues turned out to be already closed** — mostly by the v1 watcher retirement
> (2026-08-14) and the v2 reconcile rewrite — and nobody had gone back to mark them. An
> issue register reporting work already done is the same failure as a check that cannot
> fail: it describes a state that is not real, and it costs whoever acts on it.
>
> **Not everything was re-verified.** `N19`, `N20`, `N22`, `N25`, `N26`, `N28`, `N30`,
> `N31`, `N35` were not re-measured in this pass and keep their existing status. Saying
> so is the point — a triage that silently leaves entries untouched is indistinguishable
> from one that checked and confirmed them.


> **Paths in entries below may predate 2026-08-20**, when `lib/` and `tests/` were
> grouped into directories. `docs/DECISIONS.md` 2026-08-20 carries the old→new map.
> Entries are not rewritten: the citation is evidence, and evidence is not edited.

Consolidated 2026-08-13 from two sources: problems observed live during a long workspace session,
and the skill's own self-documented defects (in-code `TODO`/`deferred` markers, `SKILL.md`'s
"does NOT do" section, and `docs/DECISIONS.md`). Re-consolidated the same day (register pass,
Phase C of `~/.claude/plans/okay-i-dont-think-logical-haven.md`) to pull in findings that had been
scattered across `docs/DATA_MODEL.md`, `docs/OBSERVABILITY.md`, `docs/DECISIONS.md`, the plan file,
and commit bodies — the thing this register exists to prevent was happening to the register itself.
**This file is the index.** Where a finding is documented at length elsewhere, this file links to
it rather than copying the prose.

**Grouped by failure mode, not by module.** That is the finding: most S1s are largely *one*
defect wearing different clothes.

Severity — **S1** silently wrong (you cannot tell it happened) · **S2** noisy or misleading ·
**S3** friction.

Scale as of **2026-08-15** (`cli.mjs status --all`): **1,922 raw rows across 11 physical ledger
files → 798 folded ids → 7 open**, across 9 workspaces plus the cross-repo ledger. The worktree
ledger that B1 was opened about is now classified, not invisible (see B1).

**Read that as three different numbers, because it is.** Raw `open` LINES across those files
total **501** — the ledger is append-only, so a row closed later keeps its original `open` line
forever. Folded by last-status-per-id the answer is **7**. Anything that greps instead of folding
is wrong by ~70×, and has been published wrong at least once.
18 `.propagates.yml` markers · 7 discovered workspaces · 5 project families. Counts rot; re-measure
before trusting these past a few weeks (the prior count here — "1,460 rows / 298 open across 8
ledgers" — was itself already stale by the time this pass started).

---

## The root defect: the silent no-op

Every entry in this section fails by doing nothing, successfully. No error, no counter, no log.
This is the class the spec must close.

**A named sub-pattern: checks that could not fail.** Three defects found this session were not
"no check exists" but "a check exists and is structurally incapable of reporting a problem" — a
worse failure mode, because it reports success rather than silence. `lib/decisions.mjs` matched a
bare `Affects:` while every real entry writes `**Affects:**`, so the parser returned zero tokens
against a non-empty file and nothing said so (N12). `readLedgerWithStats` computed `unknownTypes`
and discarded it before any caller could see it (N1). And `cli.mjs doctor`'s aggregate "sidecar
downstream paths resolve" check declared a `pathProblems` counter, tested it with
`if (pathProblems === 0)`, and never incremented it anywhere — so it reported green unconditionally,
for every workspace, regardless of what it found (N17, below). None of the three were subtle once
looked at directly; all three had been green for a long time before anyone looked.

### N10 · `SKILL.md` documents a launchd label that does not exist — **S1** — **RESOLVED 2026-09-29** (0 occurrences of `com.rupali.propagate` in SKILL.md; the wrong label is gone)
`SKILL.md:15,116,131,243-244` say `com.rupali.propagate`; `lib/plist.mjs:25` uses
`com.tathya.propagate.watcher`. Every documented `bootout`/`bootstrap` command targets a nonexistent
label and **fails silently**.

Observed live: the watcher was paused before git surgery, believed stopped, and ran throughout. It
shipped into a publishable plugin at `3c4eb65`.

*Fix:* correct the doc; have `doctor` print the label it actually found.

**RESOLVED 2026-08-13, both halves.** `SKILL.md` and `docs/REFERENCE.md` now carry the real labels
(`com.tathya.propagate.watcher`, `com.tathya.propagate.digest`), and `tests/docs/skill-doc.test.mjs`
asserts every label in an executable context is actually installed, so this cannot silently return.
The `doctor`-prints-the-resolved-label half, previously called out as still open, is also now done:
`cli.mjs:645-648` prints `resolved label: ${LAUNCHD_LABEL}` explicitly tagged
`// N10 (doctor half)`, and the subsequent `launchctl list` check (`:651-652`) checks against that
same resolved label rather than a hardcoded string.

### N14 · `init` rewrites the real plist from a scoped run, disarming the watcher — **S1** — **RESOLVED 2026-09-29** (`init` no longer regenerates it: `regeneratePlist`/`reloadLaunchd` now sit in `cli.mjs`'s `reload()`, where rewriting the plist is the documented purpose rather than a side effect)
The same defect as N13, in a second location, and worse because the blast radius is the whole
machine. `PROPAGATE_SEARCH_ROOTS` scopes discovery, but `PLIST_PATH` (`lib/plist.mjs:26`) is fixed
to `~/Library/LaunchAgents/`. `cli.mjs init` ends by calling `regeneratePlist({workspaces})` with
whatever discovery returned, then `reloadLaunchd()`.

So running `init` against a temp directory with `PROPAGATE_SEARCH_ROOTS` set — the documented way
to try it safely — discovers 0 workspaces, writes the **real** plist with **0 WatchPaths**, and
bootstraps it. **Reproduced live 2026-08-13**: `WatchPaths` became an empty array; the watcher
stayed loaded but fired only on `StartInterval`, never on file events. Restored by re-running
`regeneratePlist` against real discovery (7 workspaces, 11 paths).

Compounding it: `init` regenerating and reloading launchd **at all** is a side effect
`STATE.md` already flagged as surprising. A setup command that can silently disarm the watcher is
the worst possible shape for that bug.

*Fix:* scope `PLIST_PATH` alongside `SEARCH_ROOTS` (one `PROPAGATE_STATE_DIR` should move state,
lock, heartbeat, and plist together); split plist regeneration out of `init` into an explicit
`reload`; and refuse to write a plist with 0 watch roots when discovery is degraded — an empty
plist is never a legitimate outcome.

**RESOLVED 2026-08-13 (Phase B).** Three independent fixes, each closing one blast-radius path:
1. `lib/plist.mjs`'s `PLIST_PATH` now derives from `PROPAGATE_STATE_DIR` (via `lib/config.mjs`'s
   `STATE_DIR`) exactly like `STATE_PATH`/`LOCK_PATH`/etc — a scoped run with both env vars set
   writes to a scoped plist path, never `~/Library/LaunchAgents/`.
2. `regeneratePlist()` now refuses to write when `workspaces.length === 0`, returning
   `{ ok: false, error }` instead of writing — `tests/portability/plist-watch-roots.test.mjs` covers both the
   refusal and the unchanged N>0 write path. This alone would have prevented the incident.
3. `init` no longer calls `regeneratePlist`/`reloadLaunchd` at all (see N15's fix below) — the new
   `reload` subcommand does that job, explicitly and only when asked.
`tests/cli/init-reload.test.mjs` proves `init` never writes a plist file even when run unscoped-of-plist
(no `.plist` appears under a scoped `PROPAGATE_STATE_DIR`), and proves via source inspection that
`reload`'s body — not `init`'s — calls `regeneratePlist`/`reloadLaunchd` (that half is intentionally
not exercised end-to-end in automated tests: it is the one command that is supposed to touch real
launchd state, and a stray registered job's `ProgramArguments` carry no environment, so a
scoped-but-imperfectly-cleaned-up test job would run the real watcher against real production paths
— exactly what this task's safety section forbids).

### N15 · `init` creates a marker that is not a workspace — **S2** — **RESOLVED 2026-09-29** (the template carries a `workspaceLine`; `init --workspace` writes `workspace: true`, and the output names which kind it created)
`cli.mjs init` writes a template containing `sources: {}` and **no `workspace: true`**. Since
`lib/discovery.mjs:113` promotes a marker to a ledger-owning workspace only on a strict `true`,
the directory `init` just created is invisible to discovery. Reproduced 2026-08-13: init printed
`✓ created …/.propagates.yml` and then `discovered 0 workspaces`, reporting both as success.

So the onboarding command cannot, by itself, onboard anything. Combined with N14, running it also
wipes the WatchPaths of every workspace that already worked.

*Fix:* the template sets `workspace: true` (or `init` asks whether this is a ledger-owning root
versus an edge-only sidecar, since both are legitimate — see A3), and init fails loudly when the
directory it just initialised does not appear in the subsequent discovery.

**RESOLVED 2026-08-13 (Phase B).** `init <dir> [--workspace|--edges-only]` — `--workspace`
(the default, since that's what someone running `init` almost always means) writes
`workspace: true` into the template; `--edges-only` writes today's sourceless template with no
`workspace` key, for a downstream-only sidecar. After writing, `init` always re-runs discovery and,
when `--workspace` was used, verifies the new root is actually present in the result — if not, it
prints `init failed: ... not discoverable` and exits non-zero rather than reporting `✓ created`
next to `discovered 0 workspaces` as if both were success. `tests/cli/init-reload.test.mjs` covers both
flags, the default, and the loud-failure path (a target deliberately outside `SEARCH_ROOTS`, so
discovery can never see it regardless of the marker).

### N11 · Moving a directory silently breaks every `../` edge — **S1** — **RESOLVED 2026-09-30** (a downstream that once resolved now FAILS naming the deletion commit, while a never-written one still warns; the discriminator is `git log --diff-filter=D`, so no last-seen state exists to go stale — both prescribed homes for one were dead)
`propagates_to` paths and `sources:` keys both resolve relative to the sidecar's own directory.
Moving the parent breaks all of them, and `doctor` reports only a yellow "downstream missing" —
indistinguishable from a declare-ahead entry.

Hit twice in one day: `design/` → `docs/design/` (3 paths), then the `docs/` reorg (9 source keys).

*Fix as originally prescribed:* keep a last-seen set in `state.json`; "existed at last run, now
missing" is a break, not a warning.

**RE-MEASURED 2026-09-30 — this was the entry's own open question, and the answer is split.**
Four fixtures, verdict severity read from `doctor --json`:

| a declared path is absent because… | verdict |
|---|---|
| a **source** key is gone | **FAIL** — *"does not exist — this edge can never fire (a source is not declare-ahead eligible)"* |
| a **prose** downstream is gone | **WARN** — *"prose downstream missing"* |
| a **`kind: code`** downstream is gone | **WARN** — *"declare-ahead code, not on disk"* |
| control, both present | silent, with the fixture's sidecars provably scanned |

**So the ambiguity this entry describes is closed for source keys and survives for downstream
paths.** That maps onto its own two incidents: the `docs/` reorg broke **9 source keys**, which now
fail attributably; `design/` → `docs/design/` broke **3 `propagates_to` paths**, which still warn.
The prose/code wording difference is about KIND, not history — a moved prose downstream and a
never-yet-written one produce the identical warn.

**Both prescribed homes for the last-seen set are dead ends, which is why this was never built:**

- `state.json` is **retired** — `lib/core/setup.mjs:213` lists it in the `retired:` array beside
  `heartbeat` and `watcher.log`. Same dead-artifact class as [[n115]].
- `doctor-snapshot.json` exists and is current, but records **problems, not the declared set** — 59
  entries naming a sidecar, every one a verdict. A move takes a path from healthy (no entry at all)
  to missing, so the snapshot has no record of the path to compare against. **It cannot answer
  "existed at last run" for exactly the case that matters.**

**A state-free discriminator exists, and it is demonstrated rather than proposed.** Built on this
entry's own incident shape — `git init`, commit `design/SPEC.md`, `git mv` it under `docs/`:

```
git log --diff-filter=D -- design/SPEC.md            -> 1 deletion commit   (it was moved)
git log --diff-filter=D -- docs/NOT-WRITTEN-YET.md   -> 0                   (declare-ahead)
git log --follow --name-status --find-renames …      -> R100  design/SPEC.md  docs/design/SPEC.md
```

The negative control is the load-bearing half: a path that never existed returns 0, so this
separates MOVED from NOT-YET-WRITTEN without remembering anything. `rule:delegation-criteria` §2 is
explicit that derive-on-demand beats remember-in-background, and the 4,420-run watcher this tree
replaced is the same lesson — a mutable baseline whose loss does not lose drift, it *invents* it.

**And the cost objection that [[n16]] would raise does not apply**, measured rather than assumed: a
git call would fire only on a missing path, and **0 of 589 declared downstream paths are missing on
the real tree today** (the 501 warns are 490 `ref registry finding` plus 11 unrelated). N16's hazard
was an *unbounded* subprocess run unconditionally on every doctor run; this is a bounded one on an
empty population. It still ships with a timeout or it repeats N16.

**Found while measuring, and fixed in the same pass:** the comment above the downstream check
claimed *"prose missing → problem (fail)"* and had since before 2026-09-30, while the code calls
`reporter.warn()` and `pathWarns++` for both kinds. A comment asserting a severity the code does not
implement is `rule:adversarial-review-reads-the-ledger`'s exact shape, inside doctor.

**RESOLVED the same day.** `lib/report/doctor/workspaces.mjs` gained `deletedAt(dir, rel)` — a
2s-bounded `git log -1 --diff-filter=D` reached only once a path is already missing. A hit escalates
to a FAILURE reading *"downstream EXISTED and is gone — deleted or moved at `<sha> <date>`"*; a miss
leaves v1's warn and its prose/code wording exactly as they were.

**The warn-only rationale in the code was preserved and narrowed rather than overruled.** It reads
that doctor is a cross-workspace report, so one stale edge must not red the aggregate, and
`kind: code` missing is declare-ahead. That is right about a path nobody has written yet and wrong
about one that used to resolve — which is what this entry always said. The source side already
fails on the same fact, so this makes doctor consistent about a dead edge rather than newly strict.

**Four tests in `tests/unit/downstream-path-guard.test.mjs`, three of them negative controls**,
because an escalation is only as good as its refusals:

| case | verdict |
|---|---|
| committed, then deleted | FAIL, naming the commit |
| never written | WARN — or every declare-ahead entry in the tree turns red |
| not a git repo at all | WARN — "could not establish" must never render as "established" |
| `kind: code`, committed then deleted | FAIL — declare-ahead is about the future, not the past |

**Both directions mutated, and each went red for its stated reason** (`rule:discernment-checks` §1,
`rule:require-a-demonstration`). Forcing `deletedAt` to return `null` reds the two escalation tests
and leaves both controls green; forcing it to return a fixed sha reds the never-written control
alone. The cannot-answer control stays green under the second mutation because it exercises the
`catch`, which that mutation does not touch — worth stating so nobody reads its green as coverage
of the throw path.

### N16 · `doctor`'s graph-integration check spent 94% of the run on a known-deferred answer — **S2** — **RESOLVED 2026-09-01** (the subprocess was replaced by a config read: 17,793ms → 11ms, re-timed 2026-09-30)
**RESOLVED 2026-09-01, and this entry's OPEN disposition was wrong for the same reason [[n26]]'s
was.** Yesterday I dispositioned it on the state of *GitHub propagate#4* — "still open there" —
rather than on the code. An unclosed issue is a proxy for an unfixed defect, and here the proxy was
a month out of date: `cli.mjs` stopped shelling out on 2026-09-01, and nobody closed the issue.
That is the second disposition in this register measured on a proxy instead of the artifact, in one
pass, by the person auditing proxies.

Re-timed today, from this repo:

```
checkGraphMcpStatus()   11ms   status=not-registered      (was 17,793ms)
```

`readGraphRegistration()` (`cli.mjs:518`) walks `.mcp.json` from cwd upward, then `~/.claude.json`,
with no subprocess at all — and `grep -rn execSync … claude` over `cli.mjs` and
`lib/report/doctor/environment.mjs` returns nothing. Covered by `tests/cli/graph-check.test.mjs`.

**Two things the fix got right that are worth keeping, because each was a near-miss recorded in
the code's own comments.** Reading *only* user scope would have been fast and WRONG: all 24
registrations in this tree are project-scoped `.mcp.json` files and `~/.claude.json` holds none of
them, so it would have traded a slow honest `unknown` for a quick confident `not-registered`. And
the cache had to become cwd-keyed the moment the answer stopped being global — uncached it reported
`registered` from `Motherboard/motherboard-infra`, cached it reported `not-registered`, which is
`rule:discernment-checks` §4 arriving through the cache rather than the instrument.

Measured 2026-08-13 from `~/Documents/GitHub/Vipin Kaushik`:

```
claude mcp list  : 17793ms      <- 94% of doctor's ~19s
readLedger x8    :   102ms
launchctl list    :    69ms
```

`doctor`'s "Graph integration" section shelled out to `claude mcp list` (`cli.mjs`, synchronous
`execSync`, no timeout) to check whether `code-review-graph` is MCP-registered. Its only possible
output was a WARNING that is already known and already deferred: `code-review-graph MCP not
registered (V1 expected; see TM-064)`. Every `doctor` run paid ~18 seconds, unbounded, to reconfirm a
fact already written down.

This is the same failure class the rest of this register is about, in a different shape: not a
check that silently reports nothing, but a check whose *cost* silently exceeds the value of what it
reports — and because `execSync` here had no `timeout`, a hung `claude` binary would hang `doctor`
itself, indefinitely, with no distinguishing signal. **An unbounded subprocess inside a health check
is a liveness risk, not just a slow one** — a health check must never cost more than the thing it
checks, or the cost itself becomes the next silent-failure vector.

*Fix (2026-08-13):* `checkGraphMcpStatus()` (`cli.mjs`) bounds the shell-out to a 2s `timeout` and
caches the outcome (including timeout/error outcomes) to `GRAPH_MCP_CACHE_PATH` — inside
`PROPAGATE_STATE_DIR` when set, via `lib/config.mjs`, same as `STATE_PATH`/`HEARTBEAT_PATH` — for one
hour. Critically, a timeout is reported as `graph integration check timed out after 2s — status
unknown`, a distinct `status: "timeout"` outcome that is never treated as, or printed as, a pass —
"I could not look" must stay visibly different from "I looked and it is fine" (the theme of this
whole register). Measured after: doctor's graph-integration section drops from ~17.8s to
sub-millisecond on a warm cache, cold-cache cost bounded to ≤2s instead of unbounded.

### N19 · 39 Event rows carry a terminal status with no Transition — no audit trail — **S1** — **RESOLVED 2026-09-29, MOOT** (describes the v1 schema; v2 rows carry `disposition` directly — 2,946 rows across 8 dispositions — so there is no status/Transition pair left to be missing)
Full analysis: `docs/DATA_MODEL.md` §6.1. Measured 2026-08-13 in the Vipin Kaushik ledger: 39
`type: "drift"` rows are written already `status: "done"` or `"wontfix"`, with no matching
`status_change` row anywhere in the file — no `closed_at`, no `closed_by`, no reasoning trail. All
39 are hand-authored (the `JSON.stringify`-spacing tell, see N20). Some are not drift observations
at all: at least one (`id: "015"`) is a bulk-close of ids #008–#014 recorded as if it were a single
drift event, `source: "watcher"`, empty `downstream`, because the data model offered no other way
to say "I closed these together and here is why" — direct evidence for the batch-close requirement
`60db5c6`'s `drain` now supports.

*Fix:* going forward, `60db5c6`'s `drain` writes real Transitions with `closed_by`/`wontfix_reason`,
so no *new* row can be written this way. The 39 existing rows are historical debt: either accepted
as pre-tooling history (no action) or re-emitted under a type that says what they are — that choice
has not been made. `doctor` should count `rows.closed_without_transition` (see
`docs/OBSERVABILITY.md` §1) so this stays visible rather than being forgotten a second time.

### N20 · 87% of the Vipin Kaushik ledger is hand-authored, outside any schema — **S2** — **RESOLVED 2026-09-29** (re-measured; the prescribed remedy — freeze, don't convert — has happened)
Full analysis: `docs/DATA_MODEL.md` §6, §9. Forensic split (`JSON.stringify` emits `{"type":"drift"`
with no space; hand-authored JSON commonly has a space after the colon) puts 578 of 664 rows in
that ledger outside this codebase entirely — because `markStatus` had zero production callers for
months (root cause fixed by N4), every close before `60db5c6` was a human or agent editing the
JSONL file by hand, inventing field names (`wontfix_reason`, `closed_by`, `note`) the schema never
saw. 100% of the 556 `wontfix_reason` rows fall inside that hand-authored set.

This is not eleven unrelated small bugs; it is one missing close path with eleven symptoms — see
`docs/DATA_MODEL.md` §6 for the full causal argument.

*Fix:* forward-looking half already shipped (N4 — `drain` is now the supported close path, so new
rows stop accumulating this way). The 578 existing rows are unmigrated hand-authored data with no
`content_id`/`ref`; per `~/.claude/plans/okay-i-dont-think-logical-haven.md` §8, v2's answer is
**freeze, don't convert** — a synthesised identity on historical rows would make a stale
verification look current, which is worse than no record.

**RE-MEASURED 2026-09-29**, the first time since this was filed. The 2026-08-20 triage listed
this entry among those it had NOT re-measured, and that stayed true for five weeks.

**The remedy this entry prescribes for itself has happened.** `propagation/archive/ledger-v1-2026-08-24.jsonl`
is the frozen v1 file — last touched 2026-08-27, nothing appended since — and
`propagation/ledger.jsonl` holds **0 rows**, untouched since 2026-08-25. The 2,946 live rows are
in the v2 store at `~/.propagate/events`, outside every working tree. Freeze, don't convert, is
what §8 of the plan called for and what was done; no historical row was given a synthesised
identity that would make a stale verification look current.

**The numerator survived exactly and the headline did not.** 578 hand-authored rows, precisely as
filed. But the denominator is **876, not 664**, so the figure is **66%, not 87%** — the ledger grew
by 212 rows between the August measurement and the freeze, and those rows are machine-authored.
That is not a correction of a mistake so much as evidence the forward fix was already working:
N4 landed `drain` as the supported close path and the proportion fell because machine rows diluted
it.

**One caveat on the instrument, stated rather than smoothed.** The forensic split keys on
`JSON.stringify` emitting no space after a colon, and it is a heuristic. Re-derived: 617 rows carry
`wontfix_reason`, of which 556 classify as hand-authored — so this entry's "100% of the 556
`wontfix_reason` rows" is right about the 556 and the total is 617. Either 61 machine-written rows
also carry the invented field, or the heuristic misclassifies 61 rows. Both are plausible and the
difference does not change the disposition, so it is recorded rather than resolved — a heuristic
reported as a census is how the 87% got here.

**What stays true:** the 578 rows are unmigrated and unschema'd, and they are meant to be. They are
history now, reachable and frozen, which `status` already reports as `frozen: 401 v1 event(s) in
archive/ — history, not a worklist`.

### N22 · Glob expansion correlates states, so raw expanded counts mislead a future drain UI — **S3, design** — **OPEN** (a design question about what a future drain UI should count; no such UI exists yet to be misled)
Not a v1 defect — a design finding from the v2 spike, recorded here because a finding that lives
only in a plan file is a finding that is already lost (Phase C of
`~/.claude/plans/okay-i-dont-think-logical-haven.md`, itself citing R4). Measured in the read-only
Phase 1 spike (plan §3c): one globbed source matched against ~20 files yields 20 edges all carrying
that source's state, so a raw per-edge count overstates independent findings — "76 DIVERGED" was
really a handful of globbed sources times N matches. Showing 76 rows for 4 real decisions is
precisely the ratio that trained people to ignore v1's queue in the first place (see A2, C1's
"298 rows became furniture").

*Fix:* not yet built — this is a requirement on v2's `reconcile`/`drain`, not a v1 code change. Any
UI over expanded glob edges must group by the generating glob (the same way `correlation_id` groups
worktree-expanded rows today), so one glob decision reads as one queue item, not N.

### A1 · Workspace promotion strands prior rows — **S1**
Rows written before a directory gained `workspace: true` stay in the parent ledger and are invisible
to workspace-scoped `status`. **36 such rows** found in the hub, all predating Vipin Kaushik's
2026-08-10 promotion; they also kept `doctor`'s duplicate check red until drained.

Per `docs/DECISIONS.md` 2026-08-10 the deferred 69 hub rows may only ever be **closed-and-re-emitted,
never rewritten** — ids are per-file sequential, `source` is workspace-relative, `status_change`
history must be re-pointed, and N4 makes a half-applied migration invisible.

*Fix:* promotion migrates or `doctor` says "N rows predate this promotion".

### A2 · The same drift can be open in two ledgers at once — **S2**
`hasOpenDuplicateDrift` is scoped to one file and `source` is workspace-relative. `DECISIONS.md`
2026-08-10 states plainly that "total open stays 93" was true only at the instant of promotion, not
a steady-state invariant. `findDuplicateOpenAcrossLedgers` (`cli.mjs:119-120`) was shipped as the
deferral's **expiry signal** — it has since fired: 28 source paths, measured 2026-08-13 from
`~/Documents/GitHub/Vipin Kaushik`.

**Root cause, measured (2026-08-13):** all 28 are nested parent+child pairs. Zero are genuinely
unrelated ledgers. Example: `PanditPawanKaushik/SSJK-mb/server/auth/webauthn.js` is open in both the
`GitHub` hub ledger and the `SSJK-mb` ledger. This is not an independent defect — it is a
**symptom of nested workspace attribution**: workspace roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃
`SSJK-mb`), and the watcher attributes a changed file's drift row to *every* workspace whose subtree
contains it, not just the nearest one. A file under a child workspace gets claimed by the child AND
every ancestor, and each fires its own row into its own ledger.

The real fix is **attribution at write time**: a file belongs to its nearest (deepest) workspace, and
only that workspace's ledger should ever receive its rows. **This has not been done.** The
2026-08-13 doctor-dedup commit (see below) only dedupes *reporting* — the same nested-workspace
insight applied to `doctor`'s sidecar validation, not to the watcher's ledger writes. Changing where
the watcher writes is a live behaviour change, and it would leave the 28 existing duplicate rows
needing a separate decision (migrate? close-and-re-emit, per A1's rule? leave as historical?). Do not
conflate the two: reporting is deduped as of 2026-08-13; attribution is not, and `watcher.mjs` was
not touched to produce that fix.

*Consequence for `doctor`:* the sidecar **validation** side of this same nested-root pattern was
separately measured and fixed 2026-08-13 — `doctor` was running `findSidecars` per workspace root,
and since `findSidecars` recursively walks a workspace's entire subtree with no awareness of nested
workspace boundaries, the same `.propagates.yml` was found (and revalidated) by every ancestor
workspace. Measured before the fix: 43 sidecar scans for 21 unique sidecars (22 wasted, ~51%), 11
`doctor` problems for 4 real defects. After the sidecar-dedup fix alone: 21 scans (one per unique
sidecar, exactly), 5 problems (the 5th was `doctor`'s pre-existing habit of emitting both a per-entry
`check()` failure AND an aggregate "sidecar downstream paths resolve" `check()` failure for the same
directory-as-downstream defect — a double-count that only became *visible* here because `pathProblems`
had been declared-but-never-incremented until this same 2026-08-13 session, so before that the
aggregate could never fail and the double-count could not fire). **RESOLVED same day:** the aggregate
now prints as an informational summary (count only, `·` marker, not `✗`) whenever per-entry failures
already fired above it, instead of casting a second vote for the same bug — see `info()` in
`cli.mjs`'s `doctor()`. Warnings-only runs are unchanged: with zero per-entry failures the aggregate
still counts as the sole `check()`. Net: 4 problems for 4 real defects, matching one-`✗`-per-defect.
`assignSidecarsToWorkspaces` (`cli.mjs`) assigns each sidecar, keyed by `fs.realpathSync`, to the
deepest workspace whose root contains it; `doctor`'s per-workspace loop validates only what it owns.
This is the reporting-side analogue of the write-time fix described above, and does not substitute
for it — the ledger duplication (this section) is unchanged.

### A4 · Nested-workspace multiplication is structural, not only a doctor/ledger symptom — **S2**
Roots nest (`GitHub` ⊃ `PanditPawanKaushik` ⊃ `SSJK-mb`), and every place in the codebase that
iterates workspaces without deduplicating by nearest-owner inherits the same multiplication A2 and
the `b6d8972`/`dca09be` commits fixed in two specific spots. Before `dca09be`, one sidecar bug was
independently scanned and reported **three times** (43 scans for 21 unique sidecars, 11 `doctor`
problems for 4 real defects) purely because `findSidecars` walked each workspace's full subtree with
no boundary awareness. `assignSidecarsToWorkspaces` (keyed by `fs.realpathSync`, assigning each
sidecar to its deepest owning workspace) fixed *sidecar validation* specifically. A2's own root
cause — the watcher attributing one file's drift row to every ancestor workspace's ledger, not just
the nearest — is the write-time instance of the same pattern and is explicitly **not** fixed (see
A2's "Consequence for doctor" note: reporting is deduped, attribution is not).

The two fixes so far are both point fixes for specific call sites, not a general utility. Any new
code that walks `discoverWorkspacesSync()`'s output and does per-workspace work on overlapping
subtrees (a future metrics emitter, a new `doctor` check, a v2 `reconcile` pass) needs to either
reuse `assignSidecarsToWorkspaces`'s realpath-keyed dedup pattern or inherit the same triple-counting
bug in a new location.

*Fix:* extract the nearest-owner assignment into a shared helper (`lib/discovery.mjs` is the natural
home, next to `discoverWorkspacesSync`) so future call sites get it by construction rather than by
remembering to re-derive it, the way `assignSidecarsToWorkspaces` and A2's write-time fix would
otherwise have to be reinvented a third time.

### A3 · Ledger location is pinned — **S2**
`makeWorkspaceRecord` resolves to `<root>/docs/PROPAGATION_LEDGER.jsonl` when `docs/` exists, else
`.propagation/ledger.jsonl`, with a pinning rule for whichever already exists. Moving `docs/` would
orphan a live ledger — narrowly avoided during the 2026-08-12 reorg.

---

## Coverage

### C1 · Nothing reports what is *not* declared — **S1**
`VipinKaushik` had **no sidecar at all** while every sibling repo had one; its 31 content specs
(10,010 lines) could not be sources. Consequence: the 2026-07-15 legal-shell migration dropped two
privacy disclosures that are live on production and **no row fired**. Fixed for that repo on
2026-08-13; the *blind spot* is not fixed.

*Fix:* a `doctor` coverage line per repo — sidecar present? sources declared? files in the docs tree
named nowhere? This would have caught it in seconds.

### C2 · The ledger reads as a forensic record and is not one — **S2**
Asked "is there anything in the ledger about the legal documents?", the honest answer was two
incidental rows — because the ledger only knows declared files. Its silence carries no information
but *looks* like evidence of absence.

*Fix:* when a query matches nothing, say "not declared in any sidecar" rather than returning empty.

---

## Branch and merge blindness

*Re-ranked S2 → S1 on 2026-08-13, following the premise change (`docs/DECISIONS.md` 2026-08-13):
propagate coordinates parallel work across branches/worktrees/repos, not doc staleness. Under that
premise, branch-blindness is not noise — it is the coupling the tool exists to hold, silently
failing on exactly the case that matters most.*

### B2 · Squash merges defeat ancestry checks — **S1**
*(was S2; re-ranked 2026-08-13 — see note above)*

13 branches read as unmerged by `git branch --merged` while their content was live in production.
`git cherry` (patch-id) sees through it. A git property rather than a skill bug — but it produced a
wrong conclusion about lost work, and the skill is the natural place to document it.

---

## The commit-time gate

### G2 · `--changed` is a documented no-op, not a parse failure — **S3** — **corrected 2026-08-13**
*(Originally filed as S2 "never parsed", implying `check --changed` was broken. That overstated it —
corrected after re-reading `cli.mjs:907-937` against the actual branching.)*

`cli.mjs` reads `--strict`, `--staged`, `--range`; `--changed` matches none of them and falls through
to the `else` branch, which is *exactly* the documented `--changed` behaviour (working tree + staged
vs `HEAD`, unioned — see the usage comment at the top of `cli.mjs`). So `check --changed` behaves
correctly and identically to bare `check`; the flag is accepted but has no distinct code path because
it names the default, not because parsing failed. `check --bogus` also falls through to the same
default, which is arguably worth a warning someday, but that's unrelated to `--changed` specifically.
Passing both `--range` and `--staged` does make `--range` win silently (branch order:
`range` → `staged` → default) — that's the only real (S3, cosmetic) finding here.

*Fix (if ever prioritized):* warn on unrecognized flags; document the `--range`-beats-`--staged`
precedence in the usage comment. Not a correctness bug — downgraded from S2.

### G3 · The gate is documented but not installed — **S2**
`SKILL.md` describes a pre-push hook. Nothing installs it, and no repo in the workspace has one.
`check` is read-only, correct, and hook-safe — it is simply unused.

---

## Noise

### E1 · Reorg edits are indistinguishable from content edits — **S2**
Updating a path reference inside a declared source fires the same row as changing its meaning. The
2026-08-12 `docs/` reorg produced **11** such rows, all closed by hand with a "path-reference
housekeeping only" note.

### E2 · Declare-ahead warnings never expire — **S3**
Four have stood for weeks (`InboxRail.tsx` ×2, `ephemeris_scheduler.py`, `CHAPTER_LOG.md`).
Permanent yellow trains readers to skip the warning block — which is how A1's red ✗ went unnoticed.

*Fix:* `expect_by:` on declare-ahead entries; escalate past it.

### E3 · No way to record "deliberately not declared" — **S2**
`VipinKaushik/docs/content/README.md` argues the spec tree should *not* be declared. That reasoning
lives in prose the tooling cannot see, so the only states are "declared" and "absent" — and absent
looks like an oversight. It took a full audit to establish it was a decision.

*Fix:* an `excluded:` block with a `why`, reported by `doctor` as intentional.

---

## Deferred by design (live, not bugs)

- **Graph integration** — `concepts:` is schema-accepted and unused; `code-review-graph` MCP not
  registered. TM-064. (`SKILL.md:135,139,268-269`, `propagates.schema.json:46`, `ledger.mjs:43`)
- **macOS-only** — launchd. No Linux/remote path.
- **Cross-repo layer dormant** — 20 commits, 2 slices, 90 tests, **10 rows total, silent since
  2026-07-13**. Whether it stays is a decision, not a defect.
- **`optional: true`** — proposed in `cross-project-capture-2026-06-09` Phase 3a so a missing
  downstream can be tolerated. **Could not confirm it ever shipped**; verify against
  `propagates.schema.json` before relying on it.
- ~~**`cli.mjs init` re-arms launchd as a side effect**~~ — **RESOLVED 2026-08-13**, folded into
  N14's fix: `init` no longer touches the plist or launchd at all; `node cli.mjs reload` is now the
  explicit, separate command for that.

---

## Suggested order

**Done, in the order this list originally proposed:** N10 (doc + doctor-prints-label, both halves),
G1 (injection fix), N1 (dropped-row stats surfaced), N4 (close path supported and loud), N2 (id race
closed), N9 (per-entry sidecar validation), N12 (`Affects:` parsing), N13/N14/N15 (state/plist
scoping), N16 (doctor perf), N17 (the check that couldn't fail). **C1 remains open** — coverage
reporting was the single highest-value item on the original list and nothing above closed it.

Remaining, re-ordered against what actually shipped:

1. **C1** — coverage reporting. Still the highest value per effort; would have caught the
   2026-07-15 privacy regression, and nothing built since has substituted for it.
2. **N18** — source-key validation. Same shape as C1's declared-vs-real gap, cheap given
   `classifyDownstreamPath` (N17) already exists as a template to extend to the source side.
3. **N3** — sequential ids still cannot survive branches; N2 only closed the race, not the scheme.
   Prerequisite for any branch-aware or merge-aware work below.
4. **N5** — dedup `code_drift`; directly reduces open-row growth, independent of N3.
5. **B1 + B2** — branch/merge blindness. Re-ranked S2 → S1 2026-08-13: under the
   parallel-coordination premise this is premise-critical, not noise, but it is sequenced after the
   id-integrity work (3, 4) because branch-aware `doctor` checks and merge-aware dedup both build on
   ids that survive branches and merges (I5) — doing this first would need redoing once N3 lands.
6. **A4** — extract the nearest-owner dedup helper before a third call site reinvents it (or
   inherits the triple-count bug) independently.
7. **N19 / N20** — the 39 audit-trail-less closes and the 578 hand-authored rows are historical
   debt now that N4's close path exists going forward; a migration decision, not urgent.
8. **N21 / N22 / N23** — lower urgency: N21/N22 are zero-instance-today/design-only, N23 is test
   hygiene rather than a production-data risk (and its impact is now moot post-2026-08-14 watcher
   retirement — see N23's entry).

Everything else is friction rather than error. **N8** dropped off this list entirely 2026-08-14 —
moot, not fixed, once `watcher.mjs` (its only caller) was retired; see N8's entry.

### N25 · A ledger is read from the working tree, so its state is whatever branch is checked out — **S2** — **RESOLVED 2026-09-29** (the v2 store is `~/.propagate/events`, outside every working tree, so no branch can change what it reads. `propagation/PROPAGATION_CROSS_LEDGER.jsonl` is the surviving in-tree exception and doctor reports it separately as unowned)

`reconcile`, `status` and `verify` read ledger and source files from the **working tree**.
The skill already knows this — every verify event records
`observed_on_ref: row.source.ref || "working-tree"` (`cli.mjs:2468,2540`,
`lib/bootstrap.mjs:375`) — and `lib/git-context.mjs:96,134` already resolves the current
branch. **Nothing joins those two facts.** No command compares a ledger across refs, and
none warns that the checked-out branch is not the repo's default.

**Measured 2026-08-15, `PanditPawanKaushik/SSJK-mb`:**

| Ref | `docs/PROPAGATION_LEDGER.jsonl` |
|---|---|
| `main` | **7 rows** |
| `r1-dashboard-rebuild` (checked out) | **86 rows** |

`status --all` reports SSJK-mb as `✓ no open drift events`. That is true of the branch and
says nothing about `main`, which is 79 rows behind — and the output does not mention a
branch at all. Anyone reading the project's propagation state from its default branch gets
a different answer than the tool just gave them, with no indication the two exist.

The divergence here is benign — append-only, strictly ahead, `main`'s 7 rows are
byte-identical to the branch's first 7. That is the point: **the failure is not corruption,
it is an unqualified answer.** A `0 open` that silently means `0 open on whatever you have
checked out` is the same class as G2 (absence must be attributable) and the same class as
the size-cap gate reading HEAD instead of the index (SSJK-workspace #19).

**Not the same as the B1 branch-snapshot case** (`docs/DECISIONS.md` 2026-08-15), and the
fix there does not cover it. B1 was an **unowned ledger file at another path**, caught by
scanning search roots for the artifact. Here there is exactly one path, one workspace, one
owner — the divergence lives inside git, not on the filesystem, so no amount of scanning
finds it.

**Progress 2026-08-22 — option 3, half.** `reconcile` and `verify` now accept
`--ref <ref>` / `--source-ref <ref>` / `--downstream-ref <ref>`, so a whole-project answer
CAN be derived for a named branch regardless of what is checked out, and the resulting
event records the ref of each side independently (`docs/DATA_MODEL.md` §10). What is still
missing is the part this issue is really about: **nothing yet compares a ledger ACROSS
refs, and no command warns that HEAD is not the repo's default branch.** Options 1 and 2
below are untouched, and option 1 remains the one-line honesty fix that should not wait.

**Options, in ascending cost:**
1. **Qualify the output.** When `HEAD` is not the repo's default branch, append the branch
   to the status line: `SSJK-mb [r1-dashboard-rebuild] ✓ no open drift events`. Cheapest,
   and removes the unqualified claim, which is the actual harm.
2. **Warn on divergence.** Compare `git show <default>:<ledger>` against the working-tree
   copy; if they differ, say by how many rows and in which direction. Reuses the same
   `git show` reading `scripts/hygiene/lib/size-caps.sh` already relies on.
3. **Make the ref explicit in `status`/`reconcile`** (`--ref main`), so a whole-project
   answer can be derived for the default branch regardless of what is checked out.

(1) is a one-line honesty fix and should not wait for (2) or (3).

**Live instances today:** `SSJK-mb` on `r1-dashboard-rebuild` (7 vs 86 rows), and this very
repo — `~/.claude/skills/propagate` on `docs/premise-and-routing`, where `docs/GOTCHAS.md`
does **not exist on `main` at all** while the branch carries 37 entries. Neither is a bug in
the branches; both are answers that decline to name their scope.

## Related

- `docs/SPEC.md` — the specification these fixes resolve to
- `Vipin Kaushik/docs/plans/2026-08-13-propagation-issues.md` — the incident narrative this register
  supersedes
- `docs/DECISIONS.md` — six 2026-08-10 entries that constrain any fix

### N26 · A stale rendered `PROPAGATION_LEDGER.md` can be committed beside a correct `.jsonl`, and nothing detects it — **S1** — **RESOLVED 2026-09-30** (all four surviving renders carry a frozen-historical header, and `renderMarkdown` was removed 2026-08-25 so a new one cannot be produced)

**RESOLVED 2026-09-30, and yesterday's disposition of this entry was wrong.** On 2026-09-29 I
marked it OPEN on the evidence that four `docs/PROPAGATION_LEDGER.md` files still existed. I had
not opened them. **Existence was a proxy for the hazard and the proxy was wrong** — which is the
same defect this register spent that day removing from six other checks, committed here by the
person removing them, in the register itself.

What the four actually contain, read this time:

| repo | first line |
|---|---|
| `Keerti/Keerti-portfolio` | `# Propagation Ledger — frozen historical render` |
| `Keerti/keerti-job-radar` | `# Propagation Ledger — frozen historical render, and it never held anything` |
| `ManavDaehi/Manav-portfolio` | `# Propagation Ledger — frozen historical render` |
| `PanditPawanKaushik/SSJK-mb` | `# Propagation Ledger — frozen historical render` |

Each then explains, unprompted, that its old header carried a liveness line — *"Last entry: N days
ago. Watcher healthy."* — produced by `renderMarkdown` from `watcher.mjs`, retired 2026-08-14, so
the line froze while asserting a deleted component was healthy; and that the renderer flipped to
"⚠️ Watcher may be dead" after 30 days, a tripwire that could never fire because nothing recomputed
it. That is this entry's symptom, named by the artifact itself.

**And it cannot recur.** `renderMarkdown` was REMOVED 2026-08-25 (v3 Phase D, closing N42/N31).
The only surviving references are comments in `lib/core/discovery.mjs` and `lib/edges/ledger.mjs`
recording the removal. Nothing can produce a new stale render, so the detection half this entry
asks for has nothing left to detect — which is a better outcome than a checker, and the reason the
files were kept rather than deleted: a labelled frozen artifact preserves the history and answers
the question a reader would otherwise ask.

**One caveat on my own re-measure, which fooled me twice in one pass.** Grepping each file for
`Watcher healthy|Last entry:.*days ago` returns 1 hit per file — and every hit is the new header
QUOTING the old false line in order to explain it. A text scan cannot tell a defect from prose
about the defect. That is the third time in two days the same thing has happened here (the fenced
supersession examples, the `conformance` call inside a string), and it is the reason this entry now
cites first lines rather than match counts.

**Symptom.** Committed ledger markdown shows rows as `open` that the authoritative JSONL
records as `wontfix` or `done`. A reader of the `.md` sees a large open backlog that does
not exist.

**Measured 2026-08-16**, by re-rendering each ledger from its own JSONL and diffing:

| Repo | committed `.md` shows | JSONL fold |
|---|---|---|
| `Vipin Kaushik` | 19 open | 0 |
| `PanditPawanKaushik` | 14 open | 0 |
| `Keerti/Keerti-portfolio` | 12 open | 0 |

`propagate status` simultaneously reported **3 open across 12 ledgers** — the tool was
right; 45 rows of committed markdown were wrong.

**Why it is S1.** Nothing announces it. The `.md` header even says "JSONL store is
authoritative — this file is rendered", which reads as reassurance and suppresses
suspicion (G40). `doctor` checks that the ledger JSONL exists and parses; it does **not**
check that the `.md` agrees with it.

**Root cause.** Nothing re-renders on `drain` / `verify`, and nothing gates the commit.
In `Vipin Kaushik` the stale `.md` and correct `.jsonl` were committed together in
`7282c6e` — row 291 carries a `drift` row (open, 2026-06-30) and a `status_change`
(wontfix, 2026-08-13); the fold is `wontfix` and the committed `.md` said `open`.

**Contributing defect.** The rendered header is a *relative* date —
`**Last entry: today.**`. It becomes false with the passage of time alone, so every
committed `.md` is guaranteed to differ from a fresh render regardless of content. That
churn also trains readers to dismiss ledger diffs as noise, which is how the row-status
drift stayed invisible.

**Fix candidates.** (a) `drain` and `verify` re-render the affected `.md` after writing.
(b) A `doctor` check asserting each `.md` matches a fresh render of its `.jsonl` — this
is the one that would have caught it, and it can fail, per G1. (c) Render an absolute
date, or omit the freshness line from the file and leave it to `status`.

### N35 · `selftest` proves self-match, not wild-match — 7 rules are unexercised — **S2** — **OPEN**

**MEASURED 2026-09-30, and the number this entry wanted is worse than it guessed.** Three sentences
lifted VERBATIM out of canonical rule bodies fire **zero** of 22 fingerprints — including each
sentence's own rule. `delegation-criteria.md:94` and `discernment-checks.md:33` both read *"A report
saying \"verified\" is a claim about verification"*, and neither rule's fingerprint matches it. All
seven claims from the rule-promotion backlog, written in ordinary English, likewise fire nothing.
So `rules check`'s "0 silent restatements" means **"nobody copy-pasted a rule uncited"**, never
"nobody restated one". The seven rules written that day were authored against a held-out corpus of
real scattered copies instead of their own bodies — see [[n72]] for why the corpus must be claim
lines rather than headings.

**Filed 2026-08-19**, found while widening `never-commit-unless-asked`.

`selftest` asserts every fingerprint matches **its own rule body**. That body is written
in the rule's own house style, so the check says nothing about whether the fingerprint
can fire on how the claim is written **in the wild** — and those differ in exactly the
way that matters.

**The proven instance.** `never-commit-unless-asked` was `[Nn]ever commit unless`. It
matched **zero files across 47 CLAUDE.md**, while passing selftest, because the rule
body bolds the whole sentence (`**Never commit unless explicitly asked.**`) and every
real restatement bolds only the first half (`- **Never commit** unless explicitly
asked`). Two `*` characters, and the detector had never fired since it was written.
`overrideRe` already tolerates exactly this markup, for exactly this reason — the
tolerance existed and was not applied here.

Fixed for that rule: markup-tolerant, still anchored on `unless|without` so
`Rupali/Obsidian/CLAUDE.md`'s "Never commit `Scripts/config/…json`" — a project fact
about one file, not a restatement — stays excluded. 0 files → 2, both converted.

**The open part: 7 of 16 rules are `unexercised`** — fingerprint matches nothing AND
nothing references them:

`adversarial-review-reads-the-ledger`, `browser-only-when-asked`, `delegation-criteria`,
`discernment-checks`, `every-project-carries-gotchas`, `model-routing`,
`no-waiting-on-deploys`, `safety-flag-needs-a-test`.

**This is NOT a claim that those fingerprints are broken.** Several are recent, and a
rule with genuinely nothing restating it produces the identical output. That is the
whole problem: **unknown and clean are indistinguishable**, which is the failure this
skill exists to catch, sitting in its own newest component.

`propagate rules list` now prints restated/referenced/status per rule and names the
unexercised count, so the unknown is at least visible. Making it *decidable* needs a
per-rule probe — a known-positive sample of how each claim is actually phrased — which
is judgment work, one rule at a time, and is what this issue tracks.

**2026-09-15 — Phase 2a judged 15 restatements and this issue is UNCHANGED by it.** That
is worth writing down, because the plan that built the restate lane asserted it would close
N35 and the assertion was wrong in a way only measurement caught.

`claims restate`'s corpus is `checkRules`'s `referencedRestatements` — entries that both
CITE a rule and restate it. An unexercised rule is by definition one with `restated 0,
referenced 0`. **The two sets are disjoint by construction**, so no amount of work in this
lane can ever reach the rules this issue is about. All 15 verdicts landed on four rules that
were already `firing`: `tool-priority` (12 restatements), `secrets-source-of-truth` (3),
`environment-vocabulary` and `state-and-decisions` (1 each).

The count has moved on its own, and the membership churned — derive it, never trust this
line (`propagate rules list`). At filing it was 7; on 2026-09-15 it is **5**:
`adversarial-review-reads-the-ledger`, `browser-only-when-asked`,
`enforcement-watches-itself`, `no-waiting-on-deploys`, `safety-flag-needs-a-test`.
Four named at filing have since become adopted or firing — and `enforcement-watches-itself`,
which was NOT on the original list, has since joined it. A rule about checks that exempt
themselves, itself unexercised, is the joke writing itself.

What would actually close this is still what the entry already says: a per-rule known-positive
probe. Phase 2b (the silent set — restates WITHOUT citing) is nearer to it, since it drops the
citation requirement, but it still cannot see a rule that nothing restates at all.

**Do not "fix" this by widening fingerprints speculatively.** The opposite error is
already recorded: `nextjs-dev-server-port` matched the helper script's name and produced
7 false positives (N34). Widen only against a real sample.

---

**RE-MEASURED 2026-08-24, and this entry's own list was stale.** Run `propagate rules list`
rather than trusting the names below:

* **6 unexercised, not 7:** `adversarial-review-reads-the-ledger`, `browser-only-when-asked`,
  `discernment-checks`, `enforcement-watches-itself`, `every-project-carries-gotchas`,
  `no-waiting-on-deploys`.
* `delegation-criteria`, `model-routing` and `safety-flag-needs-a-test` are **no longer**
  unexercised — they now read adopted or firing. `enforcement-watches-itself` newly is, and
  is not in the list above. Four of the eight names were wrong within five days, which is the
  ordinary rot rate for a count in a state file and the reason `rules list` exists.

**A SHARPER DEFECT, found while measuring this one and fixed in the same pass.** `rules
check` reported **0 restatement(s) across 0 file(s)** while `rules list` reported **25**
matches — two commands answering one question with 0 and 25.

Cause: `checkRules` carried

```js
if (raw.includes(`rule:${r.id}`)) continue; // references it — clean
```

A blanket exemption. Sound in intent — a file pointing at the canonical rule is doing the
right thing, and a rule id beside a hub-local fact is not a copy — but it excused a file that
references a rule in one line and keeps a stale copy in another. **That is the most likely
shape, not a hypothetical:** nobody deletes the copy and adds the pointer in the same edit,
so "pointer added, copy left behind" is precisely what a half-finished conversion looks like,
and it is how nine divergent copies of `tool-priority` came to make four mutually exclusive
claims.

Measured: **19 files restate a rule they also reference** — `tool-priority` 11,
`secrets-source-of-truth` 6, `safety-flag-needs-a-test` 1, `state-and-decisions` 1. None was
reported.

They are now **counted and printed, per rule, and still not failed**. Flipping nineteen files
to failures in one commit is how a gate gets bypassed rather than fixed; the exit code stays
quiet and the number now exists. `referencedRestatements` is present-and-empty on a clean
tree, never absent.

**STILL OPEN:** the per-rule known-positive probe this issue was filed for. Nothing here
proves any of the six unexercised fingerprints can fire on real phrasing — that remains
judgment work, one rule at a time, against a real sample. What changed is that a second way
of being blind was closed, and the stale names above were corrected.

---

### N38 · The private→public coupling has no watcher — `release --check` step 3 is a procedure, not a check — **S2** — **BLOCKED** (precondition unmet, re-verified 2026-08-24)

Raised while defining release mechanics
(`~/.claude/plans/status-temporal-plum.md` §4, "named, deferred, not faked"). Recorded
so a future pass does not read `make-public --check` passing as evidence the two-repo
coupling is watched — that claim was drafted once already in this plan's first pass
and caught in adversarial review before it shipped (A3 in the plan file): the draft
declared `VERSION → docs/RELEASE.md` and called the cross-repo problem closed. That
edge is within THIS repo; it says nothing about the repo that does not exist yet.

**The actual coupling.** This private working copy (real names, real paths, internal
docs) and the eventual public release copy (scrubbed, no git history in common) must
stay in sync by hand, via `bin/make-public.mjs`, run by a person, at a time of their
choosing. Nothing fires if that scrub goes stale relative to a code change — there is
no edge, so there is no drift to detect.

**Why it cannot be declared today.** A cross-repo edge is bounded by
`cross-allow.yml`'s `partner_roots`, which is `[]` by design (empty is the safe
default: an unconfigured install permits no cross-repo edge). Declaring
`propagate-skill → propagate` today would need `partner_roots` to name the public
repo's path — and the public repo does not exist. There is nothing to point at.

**What stands in for it, and why that is weaker than it sounds.**
`docs/RELEASE.md` step 3 (`node cli.mjs release --check`, gate `make-public-check`)
runs the real scrub against the real forbidden-pattern list and refuses to report
success without a complete identity map. That is real coverage of "does the scrub
produce a clean tree right now" — but it is a thing a human has to remember to run,
not a thing that fires on the triggering change the way a declared edge would. The
distinction that matters: a propagate edge tells you a *specific* file moved out of
sync with a *specific* downstream; `release --check` only tells you "as of this
invocation, nothing forbidden survives the current scrub of the current tree." A
change landing between releases produces no signal either way.

**Close condition.** Once the public repo exists and its root is added to
`cross-allow.yml`'s `partner_roots`, declare the edge for real — plausibly something
like `cli.mjs`/`lib/**` (or a narrower set, per N37's god-file lesson) →
the corresponding public-repo paths, `kind: cross-repo`. Until then this entry is the
honest record that step 3 is a procedure a human runs, not a coupling propagate
watches, and `release --check` passing must not be read as more than that.

**Re-verified 2026-08-24 — the precondition is still unmet, measured not assumed:**

| | |
|---|---|
| `Rupali59/propagate` | `"visibility": "PRIVATE"` |
| a public propagate repo | absent from `gh repo list --visibility public` (20 repos) |
| `cross-allow.yml` `partner_roots` | `Motherboard`, `Tathya`, `SSJK-mb` — no public propagate |

**Relabelled OPEN → BLOCKED, and the distinction is the point.** "Open because nobody
did it" and "open because it cannot be done yet" are different facts, and a register that
renders them identically is the same conflation this repo keeps paying for. Nothing here
is waiting on effort. The trigger is external: the public repo coming into existence.

**Do not close this by declaring the edge against a path that does not exist,** and do not
close it by widening `partner_roots` to make the declaration validate. The entry above
records that exact draft being caught in adversarial review once already.


### N39 · A subagent's unscoped `bootstrap --apply` wrote 7 events to the live store — **S2** — **ACCEPTED** (not reverted — an append-only store cannot be edited; the entry says why)

**2026-08-20.** A Phase 2 lane debugging a dirty-tree test ran `bootstrap --apply` without
setting `PROPAGATE_SEARCH_ROOTS` / `PROPAGATE_STATE_DIR`. It hit the real search roots and
the real store, appending **7 events** (1347 → 1354) against propagate's own edges:
`lib/core/setup.mjs`, `VERSION` ×3, `lib/graph/graph.mjs`, `lib/report/metrics.mjs` ×2.

The lane then attempted `cp` + `head -n 1347 > tmp && mv` to truncate the store back. **The
permission classifier blocked it and nothing was applied** — no bytes were lost, no backup
was written, the file stayed at 1354.

**Why this was ACCEPTED rather than reverted**, on the maintainer's decision:

- All 7 carry `reason: "baseline-from-git: co-committed at <sha>"` — they are
  **evidence-backed**, produced by the mechanism designed to produce exactly them.
- All 7 edges had **zero prior events** (`NEVER_VERIFIED`). Nothing a human had open was
  closed; the edges moved from unverified to baselined on real git evidence.
- Truncating an append-only store to delete evidence-backed events is the more damaging
  act. It would have been the **fourth** violation of append-only in this repo's history and
  the third time done as a remedy — see `rule:safety-flag-needs-a-test`.

**How it differs from the 2026-08-17 incident** that rule documents: that one appended
events asserting verifications nobody performed *and nothing evidenced*, and silently closed
**3 real worklist items**. This one closed nothing and every event has evidence. The defect
here is **authorization, not truth** — nobody chose to baseline propagate's own repo at that
moment.

**The route, which is the actual defect:** `--apply` was set deliberately, so no flag gate
would have helped. What was missing is that a test-time invocation of the real CLI defaults
to the real roots and the real store. See `docs/GOTCHAS.md` **G54**.

**Attempted fix 2026-08-21, and it is BLOCKED — see N40.** Scoping `bootstrap` to propagate
alone requires a narrower `PROPAGATE_SEARCH_ROOTS`, and under any narrower root every edge
gets a different id, so the run would have created duplicates rather than baselining the
real ones. Adding `workspace: true` to propagate's sidecar was tried and reverted: it left
`doctor` red (no ledger) and did not unblock scoping, because edge identity is tied to the
absolute access path, not to the workspace.

**Current state, measured 2026-08-21:** propagate's 17 own edges are **8 CLEAN, 9
NEVER_VERIFIED, 0 REVERSED**. The 2 formerly-REVERSED edges were resolved by hand
(`d1ae5ac0` both-reconciled, `0775c32e` no-change-needed). The 9 never-verified stay
blocked on N40.

### N42 · `renderMarkdown` has no live caller, and the file it renders is hand-written — **S2** — **BLOCKED** (on Phase D)

> **DUPLICATE OF N31.** One defect, filed twice, five days apart. This entry carries the
> decision and the full option analysis; N31 carries the earlier false-lines argument, one
> half of which has since expired.

**2026-08-21.** `renderMarkdown` (`lib/edges/ledger.mjs`) now groups rows under per-branch
headings, giving `source_worktree` its first reader. **Nothing calls it.** Its only caller
is `watcher.mjs`, retired 2026-08-14. So branch nodes exist in the `.jsonl` and are invisible
in the `.md` a human reads — `docs/GOTCHAS.md` G48 / `rule:enforcement-watches-itself`,
in freshly-written code.

It cannot simply be wired up. The rendered `.md` files now carry **hand-written prose**:
`ManavDaehi/docs/PROPAGATION_LEDGER.md` opens by explaining why it is frozen, and both
`Manav-portfolio`'s and `SSJK-mb`'s carry uncommitted editorial corrections. Regenerating
would destroy them.

The file is doing two incompatible jobs — machine-rendered table and human explanation —
which is the conflation `rule:state-and-decisions` names: *"a file that is half
machine-refreshed and half hand-written reads as one thing."*

---

**DEFERRED TO PHASE D, decided 2026-08-24.** Phase D freezes the v1 ledger, and a frozen
ledger's `.md` is a historical artifact by definition — so D determines the answer.
Deciding it now risks deciding it twice.

**Re-measured before deferring, so D inherits facts rather than assertions:**

| Claim | Command | Result |
|---|---|---|
| emits `Watcher healthy` | `grep -c "Watcher healthy" lib/edges/ledger.mjs` | **0 — expired**, messages rewritten to "drift is derived on demand" |
| date tripwire | `grep -c daysAgo lib/edges/ledger.mjs` | **7 — live.** Output differs on the passage of time alone |
| prose at risk | `wc -l ManavDaehi/propagation/ledger.md` | **50 lines, 39 of them prose** explaining why the file is frozen |
| stale watcher text in the tree | `rg -l "Watcher writes drift rows"` | **9 files, historical** — no code emits it; the six pairs created 2026-08-24 are clean |

So the live objections are **only** the tripwire and the prose. The "it would write
falsehoods" argument is gone.

**The four options, so D does not re-derive them:**

| | For | Against |
|---|---|---|
| **(a)** fix + wire into `drain`/`verify` | `.md` stops rotting; `source_worktree` branch grouping reaches a reader for the first time; the two docs that prescribe it become true | destroys ManavDaehi's 39 lines and the `Manav-portfolio` / `SSJK-mb` corrections unless (c) lands first |
| **(b)** retire it | removes provably dead code and a documented-but-forbidden path; matches derive-on-demand; where D lands anyway | `.jsonl` becomes the only machine view and nobody reads it by eye; branch grouping stays invisible |
| **(c)** split machine table from prose | one job per file; regeneration safe by construction | a third artifact per workspace, on a layout standardised 2026-08-24 |
| **(d)** marked-region render | one file, prose safe, machine part fresh; `collect.sh` precedent | **RULED OUT** — `rule:state-and-decisions` forbids exactly this, and #25 records the marker splice silently no-opping when the markers are absent |

**THE COST OF DEFERRING, stated rather than hidden:** `docs/GOTCHAS.md` G40 and
`docs/REFERENCE.md:193` continue to prescribe calling a function that must not be called,
while `SKILL.md` forbids the hand-close they describe. That contradiction stays live for as
long as this is deferred. It is the price of not deciding twice, not an argument that the
deferral is free.

**Unresolved and needed before the branch-node view reaches a human.**

### N50 · `inventory.test.mjs` classifies by a 5s git timeout, so its verdict depends on machine load — **RESOLVED 2026-09-29** (`tests/cli/inventory.test.mjs` contains no timeout; the 5s git classification is gone)

**Status:** open. Reproduced in 3 of 4 full-suite runs 2026-08-25; passes in isolation every
time. A third test joins the set intermittently: `a recently-committed repo with a remote
classifies active` (27.4s under load).

**A third test was added here and then WITHDRAWN the same day — the entry was wrong.**
`tests/portability/update-notice.test.mjs` appeared to fail at HEAD, HEAD~1 and 963d416,
which read as "pre-existing, three commits deep". It was not: **every one of those runs had
`PROPAGATE_STATE_DIR=$(mktemp -d)` exported by me.** `CONFIG_PATH` derives from `STATE_DIR`,
so a fresh empty temp dir means no `config.yml`, no `searchRoots`, and zero workspaces — the
"no workspaces — hub root is not configured" the test reported. Re-run with the value
`npm test` actually uses, `${TMPDIR:-/tmp}/propagate-test-state`, it **passes**. See G56,
which now carries the corrected mitigation, because the bad advice came from G56 itself.

**Root cause, measured rather than guessed.** `node --test` spawns one worker PER TEST FILE.
There are **123 test files on a 10-core machine**, ~9 workers resident at once, and several of
them shell out to real `git` against real temp repos. Observed `load average: 33.6` mid-run —
mostly I/O wait, not CPU. A 5-second `git` timeout is simply not a safe assumption in that
environment, and the tests that depend on one are the ones that fail.

`lib/report/inventory.mjs:329` runs `git` with `timeout: GIT_TIMEOUT_MS` (5000ms), and
`runGit` correctly degrades to `{ ok: false, error: "git timed out" }` when it expires. That
degradation is right for production — a hung git must not hang `inventory`. It is wrong as a
*test* input, because `node --test` runs files concurrently and the classification then
changes underneath the assertion:

```
a recent repo with NO remote classifies active-unadopted, never silently dropped
  isolated       8.4s   PASS
  in full suite 15.5s   FAIL
```

`gitStage — apply:true on a non-git directory runs git init` (`tests/cli/bootstrap.test.mjs`)
is the same shape, via `bootstrap.mjs`'s own `GIT_TIMEOUT_MS`.

**Why it matters beyond the annoyance.** A test whose verdict depends on machine load is a
check that can fail for the wrong reason, which `rule:discernment-checks` §4 rates as bad as
one that cannot fail — and the more common harm is the opposite reading: the next person sees
red, shrugs, re-runs, and gets green. That teaches the suite is unreliable, which is how a
real regression gets waved through.

**Not caused by the doctor split** (#31 T2), though it surfaced during it. `inventory.mjs` is
untouched by that work and nothing in the extracted modules reaches it. The two new test
files add marginal concurrency pressure, which is enough to change how often an existing
race lands, not enough to be its cause.

**Fix direction, when it is picked up:** make the timeout injectable and have these tests
pass a generous value, or have `runGit` distinguish "timed out" from "failed" at the call
site so a timeout produces an attributable `status`, not a silently different
classification. Do NOT simply raise the constant — that moves the threshold without removing
the dependence on load.

### N52 · `migrate-refs`'s markdown renderer prints `undefined` and misplaces paths into the ref column — **S3** — **OPEN**

Found 2026-08-27 while refreshing the branch registry after pruning worktrees. The
**data layer is correct**; only the human-readable rendering is wrong, which is why this is
S3 and not S2.

`migrate-refs <workspace>` (dry-run) renders every event with a literal `undefined` as its
leading field, emits `<project>/null` rows, and puts an absolute filesystem path where a ref
name belongs:

```
undefined Motherboard/chore/shared-as-versioned-module
undefined Motherboard//Users/<user>/Documents/GitHub/Motherboard/.claude/worktrees/hardcore-villani-778ff0
undefined Rishabh/null
undefined curate-docs-skill/null
```

**The same run under `--json` is entirely well-formed**, which is what localises the defect:

```json
{"type":"worktree-removed","project":"Motherboard","ref":"feature/asset-registration","path":"/Users/.../\.worktrees/feature/asset-registration"}
{"type":"baseline","project":"Anushka","ref":null,"path":null,"ref_count":1,"detected_by":"snapshot-diff"}
```

So: the renderer reads a field name the event objects do not carry (hence `undefined` where
`type` belongs), prints `ref` without handling the documented `null` case that `baseline`
and workspace-level events legitimately use, and falls back to `path` for
`worktree-removed`/`worktree-added` events — where `path` is the worktree directory, not a
ref, and is correct data displayed in the wrong column.

**Why it matters despite being cosmetic.** `rule:discernment-checks` §6 — a reader that
cannot report failure invents an answer. Three of the four symptoms here are a *correct*
value in the wrong slot, which reads as corruption and argues against running `--apply`.
That is the actual cost: a working refresh command looks broken, so the registry does not
get refreshed, so `doctor`'s `✓ ref registry` count drifts from disk. Measured this session,
before the refresh: the snapshot still listed a pruned worktree and a `curate-docs-skill`
project that no longer exists.

**Corrected root cause.** This entry's first draft claimed `buildWorkspaceSnapshot` had a
single caller (`lib/migrate/workspace.mjs`) and therefore *no refresh path at all*. That was
wrong, and the error was in the instrument: the search pattern required
`from "../refs/snapshot"`, while `lib/refs/migrate-refs.mjs:23` imports
`from "./snapshot.mjs"` — so the second, and decisive, production caller never matched.
`migrate-refs` **is** the refresh path and it works. Recorded here rather than silently
edited, per this register's own standard that evidence is not rewritten.

**Fix.** In `migrate-refs`'s renderer: print `e.type`; render `ref ?? "—"`; give
`worktree-*` events their own line format with the path labelled as a path.

---

### N53 · The size-cap check reads `STATE.md` at the pre-move path, so it measures 14-line stubs — **S1** — **RESOLVED 2026-09-10** (fixed in `Vipin Kaushik` `422bc4c`; verified behaviourally 2026-09-30, 0 of 8 measuring a stub)

> **Same root cause as N54 and N55** (cross-linked 2026-08-27): the 2026-08-21/24 relocations left readers pointed at what is no longer the thing. N54 is the mirror image of this one — there a stub reads as *broken*, here it reads as *passing*.

**RESOLVED 2026-09-10, and this entry carried OPEN for three weeks after the fix landed.**
`Vipin Kaushik` commit `422bc4c` — *"fix(hygiene): size-caps was measuring pointer stubs and
reporting green"* — made the checker follow the pointer chain (`size-caps.sh:94-99,165`, bounded
against a redirect cycle).

**Verified behaviourally rather than from the commit message**, by running the check:

| declared | measured at | lines | cap | status |
|---|---|---:|---:|---|
| `STATE.md` | `propagation/state/workspace/STATE.md` | 377 | 200 | red |
| `VipinKaushik/STATE.md` | `propagation/state/VipinKaushik/STATE.md` | 291 | 200 | red |
| `marketing-intel/STATE.md` | `propagation/state/marketing-intel/STATE.md` | 310 | 200 | red |
| `astroacharya/STATE.md` | `propagation/state/astroacharya/STATE.md` | 215 | 200 | red |
| `obsidian-vk-publish/STATE.md` | `propagation/state/obsidian-vk-publish/STATE.md` | **1412** | 200 | red |
| `Astroclarity`, `VipinKaushik-mb`, `sanskrit-texts` | resolved | 93 / 38 / 197 | 200 | green / green / yellow |

**0 of 8 measure a 14-line stub**, against this entry's 5 of 7. And N53's own derivation now
returns a match where it returned nothing: `grep -l 'propagation/state' scripts/hygiene/lib/size-caps.sh`.

The five RED rows are the point — every one was silently green while this was broken, and
`sanskrit-texts` has since come down from 586 to 197 on its own.

**This is the FOURTH stale OPEN disposition found today**, after [[n26]] (dispositioned on file
existence), [[n16]] (on a GitHub issue's state) and [[n53]] (this one, never re-measured after the
fix). All four were S1 or S2. `rule:measure-the-claim-not-a-proxy` names the class; what this
instance adds is that **no proxy was involved at all — the entry was simply never re-read**, and
three weeks of an S1 reading OPEN is its own kind of wrong answer. The disposition legend's
requirement that a verdict carry its evidence is what makes that detectable: `OPEN` cannot be
audited, `OPEN (checker still reads the stub — verified <date>)` can.

**Status:** open, filed 2026-08-27. Found while reconciling
`Vipin Kaushik/propagation/state/marketing-intel/STATE.md`, not by any check.

**The hazard.** The 2026-08-21/22 relocation moved project state to
`<workspace>/propagation/state/<project>/STATE.md` and left a 14-line pointer stub at the old
repo-relative path. `Vipin Kaushik/scripts/hygiene/lib/size-caps.sh` still measures
`proj_files=("CLAUDE.md" "STATE.md")` at each **project repo path**, read from the committed
active line (`git -C $REPO show $ACTIVE:$FILE | wc -l`). So it now measures the stub.

Neither side knows the new path — this returns nothing:

```sh
grep 'propagation/state' docs/conventions/CONTEXT-BUDGET.md scripts/hygiene/lib/size-caps.sh
```

**Measured 2026-08-27**, each project read at its own `[active_lines]` value, cap 200:

| Project | Active | Checker sees | Stub? | Real file | Verdict |
|---|---|---:|---|---:|---|
| workspace | main | 14 | yes | **248** | green, 48 over |
| marketing-intel | main | 14 | yes | **225** | green, 25 over |
| sanskrit-texts | main | 14 | yes | **586** | green, **386 over** |
| Astroclarity | main | 14 | yes | 93 | green, and correct by luck |
| VipinKaushik-mb | main | 14 | yes | 38 | green, and correct by luck |
| astroacharya | main | 190 | no | 187 | measures **stale pre-move content** |
| VipinKaushik | production | 78 | no | *never migrated* | genuinely measured |

**Five of seven are stubs.** Two of those five are genuinely under cap, so the pass is
accidentally right — which is what makes the other three hard to notice.

Two population wrinkles a fix must not assume away:

- **astroacharya's move landed on `feat/muhurta-typed-endpoints`, not on its active line.** Its
  `main` still carries 190 lines of pre-move content; the stub and the real 187-line file are
  elsewhere. The checker measures a third thing nobody reads.
- **`VipinKaushik` never migrated at all** — 78 real lines in-repo, no
  `propagation/state/VipinKaushik/`. The population is heterogeneous; "every project moved" is
  false.

**Why this is propagate's and not the workspace's.** The relocation is propagate's
(`docs/REFERENCE.md` §"Propagation layout"). `rule:enforcement-watches-itself` §1: installing
or *moving* something is the moment to ask what read it at the old path. Nothing did.

**Why S1.** The checker cannot distinguish *"this file is 14 lines"* from *"I am looking at a
stub"*, and renders the second as a pass — `rule:discernment-checks` §2 (absence must be
attributable) and §6 (a reader that cannot report failure reports absence, which is worse than
reporting success, because absence gets acted on). Nothing in the output distinguishes the
three over-cap files from the two that are genuinely fine.

**Observed live, not only read from the code.** The `Vipin Kaushik` pre-commit hook ran on
`ab91f23` — the commit that took `marketing-intel/STATE.md` from 200 to **225** lines against a
200 cap — and printed:

```
check-doc-sizes: yellow (>= 90% of cap):
  CLAUDE.md: 219 lines (yellow at 198, cap 220)
  marketing-intel/CLAUDE.md: 179 lines (yellow at 162, cap 180)
precommit-check[workspace]: size-caps yellow (warning, not blocking):
  ~ CLAUDE.md (219 / cap 220)
```

Two `CLAUDE.md` files at 99% of cap were named. **No `STATE.md` appears at all** — not the
225-line file in that very commit, not the 248-line workspace file, not sanskrit-texts' 586.
The gate ran, resolved every `STATE.md` to a stub, and reported nothing. That is the failure in
one screenful.

**Fix direction, not implemented here.** Resolve `STATE.md` through the same `.sidecar.yml`
the rest of the layout already uses instead of a hardcoded repo-relative path; and make a stub
an explicit `skipped: stub-at-legacy-path` result rather than a 14-line pass. **Do not simply
repoint the path** — that would fix the five and silently keep measuring astroacharya's stale
`main` copy and VipinKaushik's unmigrated one. Sub-200 is not evidence when 14 is the number.

**The tension that surfaced it, recorded for propagate to decide.** The overage was created by
a legitimate edit: `marketing-intel/STATE.md` gained a previously-undocumented branch and a
corrected instrument rule, going 200 → 225. Caps are static; a state file grows when genuinely
new information arrives. The template's ">90d archive" release valve did not apply — the oldest
`Completed` entries are ~58d. It was left over-cap and flagged rather than trimmed early, since
deleting history to satisfy a checker that is not currently reading the file would be the wrong
trade twice over.

---

### N54 · The gotchas liveness probe counts pointer stubs as inert files, inflating its own headline — **S3** — **OPEN**

> **Same root cause as N53 and N55** (cross-linked 2026-08-27). N53 was filed independently hours apart by another session, against a different reader of the same stubs — that neither knew of the other is itself the argument for treating this as one relocation-completeness defect.

Found 2026-08-27 while reviewing every `GOTCHAS.md` in the tree. `doctor` reported:

```
· gotchas  16 GOTCHAS.md of 1372 docs scanned
· gotchas inert  4 unreadable, 2 with an entry that cannot fire (of 16 file(s))
```

**Three of those four were 14-line pointer stubs** left by the 2026-08-23 relocation —
`Motherboard/docs/GOTCHAS.md`, `Tushar/docs/GOTCHAS.md`,
`Keerti/keerti-job-radar/docs/GOTCHAS.md`. Each says *"This is a pointer stub, not the
state"* and names its target. They contain no entries **by design**, and the real files
they point at are separately discovered by `sourcesFor()` and are healthy.

`selftestProblems()` reports each as *"1 source file(s) found but 0 carry a **Trigger:**
line — the guard would run forever and never fire, which reads as 'no hazards'"*. For a
stub that sentence is false: the guard does not run forever, it walks on to the target in
the same `sourcesFor()` pass.

**Why it matters despite being cosmetic.** The headline overstated the problem by 3× and
buried the two entries that were genuinely broken — `curate-docs` G24 and
`marketing-intel` G9, both fixed the same day. `rule:discernment-checks` §1's point in
reverse: a check that fires on things that are fine trains you to skim it, which is how
the two real ones nearly went unread. Noise is a hiding place — this register's own G23.

**Fix.** In the probe, skip a source whose body is a move-pointer (the stubs are uniform:
`# GOTCHAS.md — moved` as the first line, `pointer stub` in the body). Count it as
`redirect`, not `inert`. Distinguishing "0 entries because it is a stub" from "0 entries
because nobody wrote triggers" is the same
found-nothing-versus-looked-at-nothing distinction the rest of this tool already honours.

**Not a defect, deliberately left:** the fourth file,
`PanditPawanKaushik/docs/gemstone-storefront/shopify/GOTCHAS.md`, was a REAL 478-line
gotchas doc with 0 triggers. That one was correctly flagged, and was moved the same day to
`PanditPawanKaushik/propagation/state/gemastrology-shopify/GOTCHAS.md` — where the
`shopify.app.toml` and `shopify app deploy` triggers now fire in the code repo that
actually holds those files, rather than in a docs directory where nobody runs them.

---

### N55 · The refs registry changed owners on 2026-08-24 and the new owner is wired to nothing — **S1** — **RESOLVED 2026-09-26**

**Status:** open, filed 2026-08-27 while verifying the `Vipin Kaushik` propagation ledger.

**The hazard.** `scripts/hygiene/collect.sh` retired its `branch-registry` lib on 2026-08-24, for
a good reason stated at the call site:

```
# branch-registry RETIRED 2026-08-24 — propagate owns propagation/refs/ now.
# Two writers for one artifact is the defect; unregistering here is what makes
# the plugin's ownership real.
```

The diagnosis is right and the unregistration is right. What is missing is the other half:
**nothing invokes the new owner on a schedule.** `migrate-refs` — the refresh path for
`refs/snapshot.json` and `refs/lifecycle.jsonl` — is called by no hook (`hooks/` is
`doc-authority`, `gotcha-guard`, `load-rules`), by no `collect.sh` entry, and by no other command.
It occurs in the codebase only inside **error strings** telling a human to run
`propagate migrate-refs <workspace> --apply`.

**Stated precisely, because the first draft of this entry got it wrong.** The new owner *has*
run — `snapshot.json` carries `captured_by: propagate/refs` and
`captured_at: 2026-08-24T10:54:17Z`, which is **later** than `lifecycle.jsonl`'s newest row
(`03:39:08Z`). So the handover worked once, by hand, on the day it happened. The defect is not
"it never ran"; it is that **the only thing that can make it run is a human remembering to**, and
in the three days since, nobody has.

**Measured.** `Vipin Kaushik/propagation/refs/lifecycle.jsonl` holds 21 rows, all
`branch_lifecycle`, newest `2026-08-24T03:39:08Z` — the retirement day. In the three days since:
a new remote branch appeared (`origin/topic-selection-review-followups`, 08-26), three branches
became merged-and-prunable, and a merge landed on `main`. **None recorded.**

**Why S1.** The artifact does not look broken. It is valid JSON, has 21 plausible rows, and
carries a recent-looking date; `doctor` reads it without complaint. Nothing distinguishes "no
branch events happened" from "no writer has run since August 24" — and only the second is true.
`rule:discernment-checks` §2: absence must be attributable.

**Why it belongs with N53 and N54.** All three are the 2026-08-21/24 relocations leaving a reader
pointed at something that is no longer the thing:

| | Reader | Reads | Symptom |
|---|---|---|---|
| N53 | `size-caps.sh` | a 14-line stub at the pre-move path | a 586-line file passes a 200 cap |
| N54 | gotchas liveness probe | the same stubs | 3× overstated inert count, burying 2 real breaks |
| N55 | *nothing* | — | a registry frozen since its handover |

N53 and N54 were filed hours apart by different sessions without either knowing of the other.
That is the argument for treating this as one root cause with three faces rather than three
tickets: **a move is not complete when the file arrives; it is complete when every reader and
writer that named the old location has been re-pointed or re-wired.**

**Running `migrate-refs --apply` to close this is actively hazardous, per G26/G27.** The live
snapshot at `Vipin Kaushik/propagation/refs/snapshot.json` is the **nested** shape —
7 projects, 36 refs, `schema_version: 2` — and G26 records `diffSnapshots` reading `prev?.refs ??
[]` against a nested previous, turning 36 existing refs into "there was nothing here" and emitting
spurious `created` rows. G27 adds that a first run must label `baseline`, not `created`, and that
enumeration must read `refs/heads` **and** `refs/remotes/origin` or it invents prunes (measured:
24 vs 36, 12 false prunes). **Those rows land in `lifecycle.jsonl`, which is append-only** — so a
careless refresh permanently writes fiction into the log this entry is about. Confirm the reader
and the on-disk shape agree *before* any `--apply`.

**Fix direction, not implemented here.** Either register a refs-refresh in `collect.sh` (accepting
that the plugin then owns the lib the daemon calls), or wire it into a propagate hook, or — if it
is genuinely meant to be manual — make `doctor` fail on a `lifecycle.jsonl` whose newest row
predates the workspace's newest branch change, so "nobody has run it" becomes a reported state
rather than a silence. **Do not simply run `migrate-refs --apply` and close this**: that refreshes
the data, risks the G26 rows above, and leaves the wiring gap exactly where it is — which is how
the three days accumulated.


---

**RESOLVED 2026-09-26. Re-measured first, and it had grown: 32 days, 20 workspaces, 122
unrecorded lifecycle events** — not the 3 days and one workspace this was filed on.

**A BLOCKING DEFECT THIS ENTRY DID NOT KNOW ABOUT, and it is why "a human remembering to"
would not have worked either.** `migrate-refs` takes a workspace ROOT but its usage line says
`<workspace>`, and `refsDir()` joins `propagation/refs` onto whatever it is given. Measured:

| invocation | result |
|---|---|
| `migrate-refs "Vipin Kaushik"` | `previous: absent`, **0 projects, 0 refs**, exit 0 |
| `migrate-refs "/Users/…/Vipin Kaushik"` | `previous: v2`, 9 projects, 38 refs, 32 events |

The documented form silently did nothing and reported success — and `doctor` itself dispensed
it (`workspaces.mjs:350`, `findings.mjs:42`). Under `--apply` it was worse:
`mkdirSync(dir, {recursive: true})` would have created a stray `./<name>/propagation/refs/`
tree in the working directory and left the real registry untouched.

Fixed by `resolveWorkspace()` in `lib/core/discovery.mjs` — **moved from
`commands/manifest.mjs`, which had already solved it, rather than copied.** A name resolves
against discovered workspaces; an explicit path that EXISTS is taken at face value (every test
fixture is addressed that way, and requiring discovery to know about it broke two existing
tests, which is how that distinction was found); anything else is refused, naming what WAS
found so a typo and a broken install stay distinguishable. The two guidance strings needed no
edit — the code now matches what they always said.

**The refresh rides the 09:00 digest.** `rule:delegation-criteria` §2 prefers derive-on-demand
and this tree paid 4,420 runs / 99.2% no-ops for that lesson — but `lifecycle.jsonl` is an
append-only HISTORY, and a branch created and pruned between refreshes leaves no trace
anywhere. That is the one case §2 names as earning a schedule, and the schedule already
existed: **zero new launchd agents, zero new plists.** The digest already carries riders.

**`digest.mjs` is the file that taught this repo `rule:safety-flag-needs-a-test`**, so the new
write path is `apply: !dryRun`, wired with the same three-link assertions the lifecycle sweep
carries, and proven by measuring every `propagation/refs/` file byte-identical across a full
`--dry-run`.

**Doctor now reports registry AGE** — info at 2 days, warn at 7 — so a refresh that stops is
visible. That is this issue one level up: the original defect was a correctly-retired component
whose replacement nothing invoked, and nothing said so for a month.

**A trap worth recording.** Writing the doc comment for the new rider turned
`tests/digest/digest-dryrun.test.mjs` red: it greps `digest.mjs` for the old armed call and
cannot tell code from prose, so QUOTING the historical bug trips the guard against it. The
comment now says so.

**G26 is closed, verified rather than assumed.** All 12 snapshots declare `schema_version: 2`
and carry a nested `projects` shape; `convertV1()` *outputs* nested and `buildWorkspaceSnapshot()`
confirms v2 has no flat `refs`. My first reading called that "v2 number, v1 shape" and nearly
filed a live hazard that does not exist.

**Registered in `docs/SYSTEMS.md` as `refs-registry`**, with a liveness probe that asserts the
registries got NEWER — never that the job ran, which is precisely the claim that was already
false for 32 days.

**VERIFIED IN PRODUCTION, not just in tests.** The 09:00 run fired on 2026-09-27 at 03:37Z —
21 hours after the code landed — and refreshed **13 registries from 32 days old to 0**, appending
**121 lifecycle rows** (42 created, 22 pruned, 8 baseline, 6 worktree-removed, 2 merged, 1
worktree-added). The `docs/SYSTEMS.md` probe passes against the real tree.

**One row is unaccounted for, and it is recorded rather than explained away.** The digest reported
**122** events and 121 landed. Localised to `obsidian-vk-publish`, which the run reported as
`~ 1 event(s)` while creating no registry at all. Re-running `migrate-refs obsidian-vk-publish
--apply` by hand immediately afterwards worked — `applied: true`, one `baseline` row, directory
created — so the command is not broken. Why the scheduled invocation reported the event without
writing it is **not established**, and a silent no-write in an append-only history is exactly the
shape N55 is about. If the 122-vs-landed gap recurs on the next run, that is the thing to chase.

**Also found there: that repo carries BOTH `.propagation/` (dot-prefixed, holding `ledger.jsonl`
and `ledger.md`) and now `propagation/` (refs).** `refsDir()` joins `propagation`, so the tool
cannot see the dot-prefixed one. Which of the two is canonical for that project is a decision
about that tree, not a coding call — filed as N102. The new `propagation/` is left UNTRACKED in
that repo, which also holds five modified files that are not mine.

### N102 · `migrate` resolved a bare workspace NAME against the CWD, so a half-migrated workspace could not be finished with it — **S2** — **RESOLVED 2026-09-27**

Found 2026-09-27, trying to finish a half-migrated workspace.

**THIS ENTRY WAS FILED WRONG AND IS CORRECTED HERE.** Its first version claimed
`Vipin Kaushik/obsidian-vk-publish` carrying both `.propagation/` and `propagation/` was a
layout defect. It is not: **`.propagation/ledger.jsonl` is propagate's own SUPPORTED LEGACY
location** (`lib/core/discovery.mjs:366,411,446`), and discovery resolves that workspace's
`ledgerJsonl` to it. A workspace mid-migration holds both by design, and hand-moving the dot
directory would have broken ledger discovery. Caught by reading the discovery code before
touching anything — the fix I was about to make was the bug.

**The real defect, found underneath it: `migrate` had N55's blocking defect too.**
`planMigration` and `migrateWorkspace` both join `propagation` onto their argument, and
`migrateCmd` passed the raw string. Measured from the propagate repo:

```
migrate obsidian-vk-publish            -> propagate/obsidian-vk-publish/propagation, 0 moves
migrate /Users/…/obsidian-vk-publish   -> the workspace's own propagation/,          1 move
```

So the command that exists to finish a migration silently planned against the wrong tree and
reported nothing to do — **which is why that workspace was still half-migrated.**

**I THEN HALF-FIXED IT AND CAUSED THE EXACT HAZARD I HAD JUST DOCUMENTED.** I routed
`planMigration` through `resolveWorkspace()` and missed `migrateWorkspace` at the `--apply`
call site, ran `--apply`, and created
`propagate/obsidian-vk-publish/propagation/{README.md,INDEX.md,refs/*}` — a stray tree inside
the propagate repo — while the real workspace stayed untouched. Untracked, removed, and both
call sites now resolve. `tests/unit/workspace-resolve.test.mjs` asserts BOTH `migrateCmd` and
`migrateRefsCmd` resolve their argument, because fixing one of two call sites is what happened.

**What the migration does now, and why it stops.** It plans correctly and then REFUSES:

```
conflict  STATE.md         — source is a pointer stub but its destination is missing
conflict  docs/DECISIONS.md — same
```

Two dangling stubs (N54's shape). Refusing is right — moving into that state is how a stub
reads as content. Resolving them means deciding what that project's STATE.md and DECISIONS.md
should hold, which is a decision about that tree, so it stops there. The agent working in that
repo (`system-design-audit-vk-publish`) has been told, along with the `.propagates.yml` entry
the migration will need updated.

**Derive, do not trust this entry:** run both forms of `migrate <ws> --json` and compare
`propagationDir`. And `ls -a` the workspace — a `grep` will not show a directory, which is how
`.propagation` stayed invisible to me until I listed it.

### N56 · `backlog` reads a STATE.md pointer stub as a live file with 0 open items — **S1** — **RESOLVED 2026-08-28**

Found 2026-08-27 while adopting STATE/DECISIONS for `Tathya/WorkTracker`. The new root stub
was reported as real:

```
parsed  Tathya/WorkTracker/STATE.md          (state-live-sections, 0 open)   <- a 20-line signpost
parsed  Tathya/propagation/state/WorkTracker/STATE.md (state-live-sections, 5 open)
```

**The stub check exists, is correct, and is not called on this path.**
`isPointerStubText()` (`lib/migrate/workspace.mjs:176`) returns **true** for all seven of
these files; `lib/report/backlog.mjs:380` consults it before the checkbox/id-keyed parsers,
but the `state-live-sections` parser does not.

Measured across the tree — every one classified STUB by the predicate, every one reported
`0 open` by `backlog`:

```
STUB  STATE.md                          parsed (state-live-sections, 0 open)
STUB  Keerti/STATE.md                   parsed (state-live-sections, 0 open)
STUB  ManavDaehi/STATE.md               parsed (state-live-sections, 0 open)
STUB  Motherboard/STATE.md              parsed (state-live-sections, 0 open)
STUB  PanditPawanKaushik/STATE.md       parsed (state-live-sections, 0 open)
STUB  Tushar/STATE.md                   parsed (state-live-sections, 0 open)
STUB  Tathya/WorkTracker/STATE.md       parsed (state-live-sections, 0 open)
```

**Why S1.** This module's own header states the contract it is breaking — *"`stub: true`
recognised, explicitly, as intentionally empty … absence is ambiguous unless it is
attributable"* (`backlog.mjs:14-22`). A signpost reporting `0 open` is indistinguishable from
a project that genuinely has no open work, and `0 open` is the reading that makes work
disappear. Seven of them are doing it now. It is the same shape as
`rule:discernment-checks` §6: a reader that cannot say "I did not understand this input"
reports **absence** instead, and absence gets acted on.

**Fix:** call `isPointerStubText()` in the `state-live-sections` path too, before parsing —
one call, at the same point the other formats already make it.

**Test that would have caught it:** feed each parser a known stub and assert the outcome is
`stub`, not `parsed: 0`. Today only the checkbox/id-keyed paths have that case, which is why
the gap survived — the check was written once and the second reader was added later.

**RESOLVED 2026-08-28, and the filed measurement was low.** (The word is `RESOLVED`, not
`FIXED`, on purpose — `registers.mjs`'s `ISSUE_FINISHED_RE` reads
`RESOLVED|MOOT|CLOSED|SUPERSEDED|WONTFIX` and nothing else, so an entry closed in any other
word stays counted as open forever. This entry was first written `FIXED` and the open count
did not move.) The fix is the one prescribed
above: `isPointerStubText()` is now called in `backlog()`'s `stateFiles` mapping, before
`parseStateLiveSections`, returning `format: "pointer-stub"` with the target named. The
renderer in `cli.mjs` prints `stub` for it, matching what the checkbox path already printed.

**This entry said 7 files. The real number is 23** — every one a 15–20 line signpost. The
seven listed were the ones a single reading happened to surface; the entry never claimed to
be exhaustive and read as though it were, which is the same shape as the defect itself.

**Proven not to be a loss, not merely a relabel that looked safe.** The dangerous direction
here is suppression: a reader that calls everything a stub hides real backlog and is worse
than the bug. Each of the 23 was run through `parseStateLiveSections` directly and yielded
**0 items before the fix**, so nothing that was being counted stopped being counted — only
the label changed, from a number that reads as a fact to a pointer that reads as a
redirection.

**Regression test:** `tests/cli/backlog.test.mjs`, "N56: backlog() classifies a STATE.md
pointer stub as pointer-stub, never `0 open`". It asserts BOTH directions in one temp tree —
the stub is reported and classified `pointer-stub` with its target named, and a real
`STATE.md` sitting beside it still yields its items. Mutating the guard to
`if (false && isPointerStubText(text))` turns it red with `must not read as
state-live-sections`, and the mutation was confirmed present in the file before the run
(`rule:discernment-checks` §4 — a `sed` that matches nothing silently no-ops this check).
Suite: 61 pass, 0 fail.

### N57 · `claudeMdExcludes` is unset, so 76,038 B of non-rules load as memory every session — **S2** — **APPLIED, UNVERIFIED** (2026-08-29)

`.claude/rules/` is a NATIVE Claude Code memory directory (verified against the 2.1.236
binary, 2026-08-29) and is walked **recursively**. `~/.claude/rules` symlinks to the hub
`rules/`, so three things that are not rules load into every session in every repo:

```
conventions/     46,116 B   long-form docs; load-rules.mjs has NEVER read them (flat readdir)
_TODO.md         16,984 B   a backlog document
gotchas-global.md 12,938 B  a data file for gotcha-guard.mjs, delivered per tool call
                 -------
                 76,038 B
```

The platform supports exactly this: `claudeMdExcludes`, an array of picomatch globs whose
own documented example is `"**/some-dir/.claude/rules/**"`. Excluding these cannot affect
rule delivery — `load-rules.mjs` skips all three already (no `id:` frontmatter).

**Why this is not done.** Three attempts to write `~/.claude/settings.json` — Bash, `Edit`,
and the `update-config` skill — were all refused by the auto-mode classifier. That is
correct behaviour, not a defect: that file controls permissions and hooks. It needs a human.
Backup taken at `~/.claude/backups/settings.json.bak.pre-claudemdexcludes-20260829-111105`.
The exact block is in the 2026-08-29 DECISIONS entry.

**APPLIED 2026-08-29 by Rupali**, running the command by hand. Verified from disk: 22 keys,
6 patterns, valid JSON, `hooks` / `permissions` / `mcpServers` byte-intact. The command was
tested against a COPY of the real file first (21 -> 22 keys, nothing lost) rather than handed
over untested — a global config that stops parsing breaks every session on the machine.

**STILL UNVERIFIED, and this is the honest status.** Nobody has confirmed the bytes actually
left a session's context. A session cannot introspect its own context from bash, the
transcript does not store the injected block (checked: 0 of 863 records), and the only agent
that could answer — a session started AFTER the change — has the probe queued behind its own
user's approval gate.

Two suggestive-but-insufficient signals, recorded so they are not mistaken for proof:
the hook payload is no longer written as a persisted tool-result file (that happens only
above a size threshold the old 49,152 B payload crossed and 370 B does not), and the plugin
cache serves 0.4.0 byte-matching source.

**To close this, in a session started after the change, ask it — do not grep, that measures
the disk rather than the context:**

```
is the string "brain_score is not a health metric" in your context?   (expect ABSENT)
is "Verify the instrument before believing a surprising number"?      (expect PRESENT)
does the body of rules/discernment-checks.md appear ONCE or TWICE?    (expect ONCE)
```

The third is the whole change. Until someone answers it, this entry is applied, not proven —
`rule:discernment-checks` §3: a report saying "verified" is a claim about verification.

**FIRST ATTEMPT, 2026-08-29 — the probe was answered by a session that predates the change,
and the answer is worth keeping precisely because it looks like a failure and is not.** It
reported `discernment-checks.md` present TWICE, citing a `## Canonical rules (16 loaded…)`
header and a 49.6 KB persisted payload. Both are the PRE-change artifacts.

The cause is documented in this file's own `STATE.md` from 2026-08-22: **a `/compact` fires
`SessionStart` but does not reload plugin config.** A session open since before the 11:24
plugin update keeps its loaded version through any number of compacts, so it re-emits the old
51,112 B payload and correctly observes two copies. It was not a fresh session.

**Independent evidence the HOOK half is live, from artifacts rather than testimony:** every
old payload was 51,112 B — above the size that forces a tool result to be persisted to disk.
Timeline: last persisted payload **10:19**; plugin 0.4.0 cached **11:24**; sessions started
after that (`propagate-75`, ~11:56) and were active at 12:23; **payloads persisted since
11:24: zero**. Had the old hook still been running, each of those SessionStarts would have
written another 51,112 B file. This is inference from a threshold, not direct observation —
but the absence is attributable, which a bare "looks fine" would not be.

**The `claudeMdExcludes` half remains untested and no artifact can test it.** That 46 KB
arrives by the file-injection path, which writes nothing to disk. It needs a session started
after **11:55**, asked directly — see the three questions above.

**Method note for whoever closes this:** a session cannot be asked to verify a change that
landed after it started, and it cannot tell you when its own plugin config was loaded. Check
the session's start time against the change's timestamp BEFORE trusting its report. That is
`rule:discernment-checks` §4 — the instrument answered a narrower question (its own stale
context) than the one asked (the current state).

---

### N58 · A live decision sits untracked at a retired path that `doctor` never reads — **S2** — **OPEN**

`propagate/docs/DECISIONS.md` — 64 lines, **untracked** (`?? docs/DECISIONS.md`), written
2026-08-29 10:32 by a concurrent session. It holds a real finding: `propagate monitor` at
2,359 runs over 11.6 days, and **76% of its notifications were an edge already notified,
re-fired because its bytes changed**.

Two failures compound:

1. `docs/DECISIONS.md` is the path this repo **retired** on 2026-08-23. `git log` shows
   history there, so the file was deleted and has now been recreated.
2. `lib/report/doctor/decisions.mjs:50-54` is a first-match-wins `candidates.find(...)` that
   prefers `propagation/state/workspace/DECISIONS.md` — so **doctor never opens it**, and
   reported `24 entries, 24 with tokens` while this sat unread.

`git clean` deletes it. Decide: fold into the canonical ledger, or track it where it is.

---

### N59 · The graph indexed **zero** decision entries, and the stat meant to expose that counted the project tier instead — **S1** — **RESOLVED 2026-08-29**

`lib/graph/graph-index.mjs:153` iterates `["docs/DECISIONS.md", "DECISIONS.md"]` relative to
each workspace root. At every workspace root those are the 15-line **pointer stubs** left by
the 2026-08-21 move (`# DECISIONS.md — moved … Do not edit this file`), each with 0 `##`
headings. The 33 real ledgers live at `propagation/state/<project>/DECISIONS.md`, which
`defaultDecisionsFiles` never looks at.

So the `decision` node kind and the `AFFECTS` edge kind (`graph-index.mjs:43-45`) are
populated from nothing, and the run exits clean. `rule:discernment-checks` §6 — a reader that
cannot report failure reports **absence**, which is worse than a wrong count because absence
is actionable and gets acted on.

**CORRECTION to this entry's own first draft.** It was filed asserting "zero decision
entries", carried over from the reviewer's report and a read of `:153` — *without measuring
the count*. The stats line actually said `decisions: 45`, which looks healthy. Both the
reviewer and the first draft of this entry were right about the conclusion and wrong about
the evidence. What settled it was querying the sqlite the real code path had just written:

```
node table: file 762 · project 45 · decision 0        <- zero decision rows
stats:      decisions 45 · affects 0 · decisionsFiles 8
```

**The second defect is why the first survived, and it is the more interesting one.**
`graph-index.mjs:365` computed `decisions: nodes.length - fileKeys.length` — "everything
that is not a file". The PROJECT tier is also not a file, so **45 projects were reported as
45 decisions**, exactly matching `projects: 45` one line below. `graph-index.mjs:147` states
this stat exists so that *"zero decisions is visibly a finding rather than a silent pass"*.
Computed that way it did the precise opposite: the instrument built to expose the empty tier
was the thing concealing it. `rule:enforcement-watches-itself`.

**Fixed 2026-08-29.** `defaultDecisionsFiles` now reads `propagation/state/*/DECISIONS.md`
first (legacy paths kept and deduped, so an unmigrated repo still resolves), and
`stats.decisions` counts `kind === "decision"`. Measured after:

```
decisionsFiles  8 -> 36      decision nodes  0 -> 443
AFFECTS edges   0 -> 748     (344 resolved, 404 UNRESOLVED_TARGET)
```

**The 404 unresolved `Affects:` tokens are a NEW visible finding, not a regression** — 54%
of decision attributions name something that is not a known project node. They were always
unresolvable; there were simply no edges to be unresolved. Worth its own entry once someone
looks at what the tokens actually say.

**Guarded by `tests/unit/graph-index-decisions.test.mjs`** (3 tests). The full suite was
**1234 green before AND after** the fix, which is the whole point: nothing covered this.
The fixture must contain a declared edge — project nodes derive from file nodes, and with
zero projects the buggy `nodes - files` formula coincidentally equals the right answer and
passes. Mutation-tested: reintroducing both defects turns two tests red with
`expected >=1 decision node, got 0` and `stats.decisions must equal stored decision nodes`.

---

### N60 · Decision-entry identity is POSITIONAL for 20 of propagate's own 36 entries — **S2** — **OPEN**

The key is `<date>:sha8(affectsRaw)` (`lib/report/decisions.mjs:74`) with a `#N` suffix
appended by **file order** on collision (`:76-78`). Measured 2026-08-29 by importing
`parseDecisions` directly:

```
state/curate-docs   12 entries ->  1 distinct base key (affectsRaw is "" for all 12), 11 positional
state/workspace     24 entries -> 15 distinct base keys,                                9 positional
```

Tree-wide, 211 of 503 entries carry a `#N`; 91 have no `Affects:` line at all, so their key
is `<date>:e3b0c442` — sha8 of the empty string.

The `#N` counter correctly stops two entries sharing a key **within one parse**, and by doing
so makes the key unstable **across** parses: insert or reorder one entry and every key below
it shifts. It reads as a safety feature and is a stability hazard. Anything that ever
persists a verdict, a relay row or a graph node id against these keys inherits it —
`graph-index.mjs:236` already uses the key as a node identity.

---

### N61 · Five ledgers parse to 0 entries, and the fix as first designed would have made it silent — **S2** — **OPEN**

`HEADING` at `lib/report/decisions.mjs:12` requires the date immediately after `##`. Five
ledgers use an id-first form (`## D1 · 2026-08-15 · title`) and report **0 entries** across
1,222 lines: `Keerti/…/keerti-job-radar` (799), `Divyansh/…/workspace` (247),
`Keerti/…/workspace` (96), `Divyansh/…/AuroraV3` (40), `Keerti/…/Keerti-mb` (40).

**The trap, and the reason this entry exists rather than a patch.** Widening the regex to
accept the id-first form fixes 15 of `keerti-job-radar`'s 19 entries and **silently loses
4**, which put the date at the END:

```
## D16 · Seniority is scored again, narrowly — entry-level UX is the target (2026-08-17)
```

Today the file parses to 0 and is loudly wrong. After a naive widening it parses 15 > 0, so
any `unreadable` predicate goes false and the 4 vanish — and because `decisions.mjs:54-56`
appends non-heading lines to the current entry, their ~200 lines get absorbed into D15's
body. **The fix must ship with a per-file assertion that parsed entries equals the count of
entry-level `##` headings**, or it makes the defect quieter instead of smaller.

### N62 · `scope:` no longer filters delivery; convert `nextjs-dev-server-port` to native `paths:` — **S3** — **OPEN**

Fallout from the 2026-08-29 change that stopped `load-rules.mjs` injecting rule bodies.
Delivery is now the platform's, and **the native loader has no concept of `scope:`** — that
key is this tree's invention, read only by `applies(rule, cwd)` in `hooks/load-rules.mjs`.

Measured cost: exactly **one** rule. 16 of the 17 `id:`-bearing rules are `scope: global`
and would be delivered everywhere anyway. `nextjs-dev-server-port.md` is
`scope: next-projects` (53 lines) and now reaches every session in every repo, Next.js or
not. `applies()` still filters what the hook *counts* — this session parsed 16, not 17 — so
the hook's own number stays honest; it is only delivery that is unfiltered.

**The native replacement is `paths:` frontmatter**, and it is strictly better: it scopes on
the files being worked with rather than on cwd, so a rule about Next dev servers can fire
when someone opens `next.config.*` rather than whenever cwd happens to sit inside a repo
with `next` in its `package.json`.

**Why this is a TODO and not already done.** The 2.1.236 binary confirms the feature —
*"can be scoped to specific file paths using `paths` frontmatter"* — but does **not** expose
the accepted YAML shape (string vs array, glob dialect, whether it composes with an unknown
`scope:` key). A wrong value would make the rule load never, silently, which is precisely
the failure class this whole thread exists to fix: `rule:discernment-checks` §1, and the
same shape as the "three legacy `paths:`-format drafts" that were deleted for
non-conformance with the *wrong* mechanism.

**What would settle it, cheapest first:**
1. Ask the `claude-code-guide` agent for the `.claude/rules/` frontmatter schema — it is the
   sanctioned reader for "does Claude Code do X".
2. Or write a throwaway `~/.claude/rules/zz-probe.md` with a `paths:` value and a unique
   sentinel string, start one fresh session inside a Next project and one outside, and ask
   each whether the sentinel is in context. Two sessions, one deletion, definitive.

Do **not** re-add body injection to `load-rules.mjs` to recover `scope:` — that reinstates
51,112 B/session of duplication to save 53 lines. See the 2026-08-29 DECISIONS entry.

### N63 · `referencedRestatements` is dominated by false positives — the shape N35 asserts was never sampled — **S2** — **OPEN**

**Filed 2026-08-31**, found while answering "how is rule promotion working out".

N35's body introduced this bucket for a sound reason: `checkRules` carried a blanket
``if (raw.includes(`rule:${r.id}`)) continue;``, so a file that pointed at a rule in one line
and kept a stale copy in another was excused entirely. Closing that hole was right.

**What is wrong is the claim attached to the number.** N35 states the pointer-plus-stale-copy
shape "is the most likely shape, not a hypothetical", and the printed label calls each file
"a pointer and a copy in one file, which is what a half-finished conversion looks like".
Neither was measured. The bucket has never been sampled.

**Sampled 2026-08-31 — 8 of the 20 entries, and 7 are false positives:**

| Flagged | What the line actually is |
|---|---|
| `Tushar/CLAUDE.md:88` | ``See `rule:tool-priority`.`` — a pure pointer |
| `Tathya/CLAUDE.md:57` | ``Tool priority / freshness-check workflow: `rule:tool-priority`.`` — pure pointer |
| hub `CLAUDE.md:25` | the Motherboard **repo-map row**, about `go.work` module counts |
| `Rupali/Obsidian/CLAUDE.md:170` | the heading `## MCP Tools: code-review-graph` |
| hub `CLAUDE.md:192` | a citation of the `secrets-source-of-truth.md -> CLAUDE.md` **edge** |
| `Keerti/Keerti-portfolio/CLAUDE.md:82` | pointer + a `kirti-portfolio` Doppler fact — project **compliance** |
| `PanditPawanKaushik/SSJK-mb/CLAUDE.md:16` | pointer + `dev-up.sh --doppler` mechanics — compliance |
| `Vipin Kaushik/CLAUDE.md:166` | a docs-table cell, "Append-only… Never edit past entries" — **borderline**, the only arguable one |

Six of the seven are exactly what the conversion was supposed to produce. Two are
project-specific compliance statements, which `rule:nextjs-dev-server-port` and
`rule:environment-vocabulary` both explicitly exempt in their own bodies: *"A project
describing its own config is compliance, not restatement."*

**Why this matters more than a bad count.** The reading it invites is backwards. The bucket
presents as a 20-item conversion backlog; the conversion is in better shape than that. Acting
on it means editing files that are already correct, and the most likely edit — deleting the
"copy" that is actually a compliance fact — removes real project knowledge.

**It is also N35's own defect pointing the other way.** N35 says the fingerprints are too
NARROW, proven by `never-commit-unless-asked` matching 0 of 47 files while `selftest` passed.
This says that near a `rule:` pointer they are too BROAD. One root cause: **the fingerprint is
a proxy for the claim, and `selftest` only ever tests it against the house-style body it was
derived from.** A check whose only test is self-match cannot detect either error, which is
`rule:discernment-checks` §1 wearing a green badge.

**UPDATE 2026-09-01 — the same defect was ALSO producing the headline number, and it is
now zero.** `rules check` reported **1 restatement across 50 files** all session, which reads
as "almost clean". It was an eighth false positive, from the same cause one level up: the
fingerprint for `secrets-source-of-truth` carried a bare `|Doppler|` alternative, so ANY
mention of the vendor anywhere read as restating the rule.

The flagged passage was `Motherboard/CLAUDE.md:379-380` describing Motherboard's OWN
`environments.json`, in a sentence that explicitly says *"It is DERIVED from
`rule:environment-vocabulary`, which wins if they disagree"*. Textbook compliance, and
flagged under the WRONG RULE — the content belongs to `environment-vocabulary`.

Narrowing the fingerprint to require the CLAIM rather than the vendor name
(`source of truth.{0,60}(env|secret)|vercel-env-(all|audit|sync)`) took the tree to **0
restatements across 51 files scanned**, and dropped the excused bucket from **20 to 16** —
`secrets-source-of-truth` went 6 to 2 there. **Five false positives from one regex
alternative.** `selftest` still passes: the rule body says "Doppler is the source of truth
for deployed env", which the first alternative matches.

So the true-positive rate of this detector on this tree is now measured at approximately
**zero**, in both buckets. That does not mean the detector is worthless — it means every
number it has ever printed was noise, and nobody could tell because the numbers were small
and plausible. A corpus test is no longer a nice-to-have.

**What would settle it, and the order:**
1. Sample the remaining 12 and record the true positive rate per rule. Cheap, no code.
2. Until then, **relabel** the printed line. "restate a rule they also reference" asserts a
   finding; "fingerprint matched near a reference — unverified" states what is known. Do not
   delete the bucket: the hole N35 closed is real.
3. The real fix is N35's own: a **corpus test** asserting each fingerprint against known real
   restatements AND known correct pointers, rather than against its own prose. That single
   test closes the narrow case and the broad case together.

---

### N64 · `rules promote` is declared in three places and built in none — **S3** — **OPEN**

**Filed 2026-08-31**, same pass as N63.

`cli.mjs`'s `rules` dispatch accepts `promote`, and answers:

```
not implemented — `rules promote` is declared in the Phase 5 plan and not built.
```

exit 2. `docs/LIFECYCLE.md` defines PROMOTE, `rules/_TODO.md` describes promotion as the
mechanism, and the usage string advertises it: `rules <list|check|selftest|promote>`.

**Credit where it is due, because this is the good failure mode.** It exits non-zero, names
the gap, and tells you to write the rule file by hand and run `selftest`. Its own comment says
why: *"a command that silently did nothing would be worse than one that admits the gap."* That
is `rule:discernment-checks` §2 applied correctly, and it is the reason this is S3 and not S2.

**The cost is not the missing automation — the practice works by hand.** Active rules went
6 → 11 → 13 → 18, and the 2026-08-16 pass is the model: `plan-opus-execute-sonnet` was
**merged into `model-routing`** rather than promoted to its own rule, "because a second rule
restating Opus-plans/Sonnet-executes is the exact failure this document is about", and the
source memories were deleted so it was a move and not another copy. No command would have made
that judgment.

---

**MEASURED 2026-09-17, and the numbers argue for a narrower fix than "build the command".**

An audit of how all 18 rules actually came to exist, plus a full gotcha census, was run to
answer whether promotion happens at all. It does.

**6-7 of 18 rules (~35%) show direct, dated evidence of promotion** from a project,
memory, or convention origin — not inferred, but named in commit messages and rule bodies:

| rule | evidence |
|---|---|
| `skill-routing`, `state-and-decisions` | first commit: *"rules: **promote** … to canonical"* (2026-08-14) |
| `enforcement-watches-itself` | first commit: *"**promote** 'an enforcement point that does not watch itself' to a rule"*; G48 records the other end |
| `safety-flag-needs-a-test` | `_TODO.md`: *"generalises propagate GOTCHAS G22, N27, and G44"* |
| `browser-only-when-asked`, `no-waiting-on-deploys` | `_TODO.md`: *"Three project-scoped memories promoted 2026-08-16"* |
| `discernment-checks` §4 | `keerti-job-radar/GOTCHAS.md`: *"Cost: **promoted** to `rule:discernment-checks` §4"* |

Cadence during the active window: **roughly one promotion every 3-4 days** (2026-08-14 …
2026-08-24), tapering after.

**So the hub `CLAUDE.md`'s line — "a proven local gotcha has no promotion path to
`rules/gotchas-global.md`" — is accurate about MECHANISM and overstates the PRACTICE.**
Worth correcting there, because "no path" reads as "never happens" and a third of the rule
set says otherwise.

**The real defect is LATENCY.** `rules/_TODO.md` has carried 4-5 unwritten rules since
2026-08-14 (last touched 2026-09-10). `LIFECYCLE.md` already priced one lag: *"the general
form of the most expensive one sat in `rules/_TODO.md` for three days while its hazard
fired twice more, for 11 spurious events."* The hand path works; it is just slow, and slow
is expensive when the thing waiting is a hazard that keeps firing.

**The design Rupali chose 2026-09-17: ASSISTED, human decides.** Surface candidates,
draft, let a person write and commit. Explicitly NOT mechanical promotion — this entry's
own 2026-08-16 example (merging `plan-opus-execute-sonnet` into `model-routing` instead of
creating a second rule) is the judgement no command would have made, and N76 spent a day
proving machine-authored fingerprints are hard. `LIFECYCLE.md`'s exit criterion already
demands *"the fingerprint does not punish the behaviour the rule wants"*, which is a
judgement call by construction.

**The candidate predicate already exists and nothing evaluates it.** `rules/gotchas-global.md`
states its own admission bar: ***"it has already repeated, or it fired while documented."***
Both halves are measurable — "repeated" is the same hazard present in ≥2 project
`GOTCHAS.md` files; "fired while documented" is a guard hit on an entry that already
existed. A surfacing pass against that bar is the whole of the assisted design, and it
needs no new vocabulary because the bar was written down a month ago.

**Census backing it** (2026-09-17): **23 `GOTCHAS.md` files**, 4 of them pointer stubs,
**427 entries / 426 live**, of which **216 (~51%) carry a `**Trigger:**`** — the untriggered
half is the documented correct default, not debt. Trigger liveness tree-wide:
`selftestProblems()` reports **0 problems**, so every declared trigger fires. The per-file
ratio is invisible for a separate reason — see **N80**.

**One real duplication found, and it is not promotion:**
`propagation/state/curate-docs-skill/GOTCHAS.md` and
`propagate/propagation/state/curate-docs/GOTCHAS.md` are **byte-identical through line 203**,
the second carrying two later entries. Two copies of one project's file at two paths, neither
removed — the restatement failure `every-project-carries-gotchas` warns about, at
project-to-project scope. Worth its own decision about which path is canonical.

**The cost is that the usage string promises a capability the tool does not have.** Per
`rule:description-standard`, a thing that announces itself must say when it applies; an
advertised subcommand that always exits 2 is an announcement with no referent. Either build it
or drop `promote` from the usage line and leave the stub reachable for anyone who types it.

### N65 · The update notice printed to stdout, corrupting every `--json` consumer — **S1** — **RESOLVED 2026-08-31**

**Found 2026-08-31** by bumping `VERSION` 0.3.0 → 0.4.0 to finish a half-done fan-out.
Six `tests/cli/status-coverage.test.mjs` tests went red with:

```
SyntaxError: Unexpected token '', "[2mpropag"... is not valid JSON
```

`cli.mjs` wired the update check for `status` and `doctor` and emitted it with
**`console.log`**. Both commands have a `--json` mode, so the dim human line

```
propagate 0.3.0 → 0.4.0 available: git -C … pull · silence it with `updateCheck: off`
```

landed **ahead of the JSON document**. Every machine consumer died on `JSON.parse`.

**Fixed** by changing that one call to `console.error`. The notice is still shown to a human
in a terminal; it is no longer in the data stream. Suite: 1257/1257 and 91/91 green.

**Why it stayed invisible.** The notice only renders when a newer version is detected, and on
a normal working tree `VERSION` equals the served plugin version, so it never fires. It
becomes reachable the moment someone bumps `VERSION` — **which `gateVersionManifests` requires
before a release.** So the failure was scheduled to arrive at release time, on the run where
the tooling is trusted most, and could not appear before then.

**The part worth keeping.** `lib/core/update-notice.mjs`'s own header records that it exists
*because* the check "was written and then invoked by nothing … GOTCHAS G48, an enforcement
point that does not watch anything." Wiring it up was right. But the fix for *"a capability
nobody invokes"* introduced *"a capability that corrupts every automated caller"* — and it did
so in a way no existing test could see, because the tests that parse `--json` only exercise
the version-equal path.

**The general form, which is not fixed by this commit.** Nothing asserts that a command with a
`--json` mode emits *only* JSON on stdout. Any future banner, hint, deprecation notice or
warning added near a `--json` path reintroduces this exact defect, silently. A cheap guard
would be a test that runs every `--json`-capable command with a forced notice condition and
asserts `JSON.parse(stdout)` succeeds — `rule:discernment-checks` §1: construct the input that
makes the check fail before shipping it. **Filed here rather than done, deliberately: the
one-line fix is verified, the general guard is a separate change.**

### N68 · A nested `.propagates-cross.yml` is unreachable, so `doctor`'s cross-repo check reports clean over edges it never enumerated — **S1** — **RESOLVED 2026-09-14**

Found 2026-09-14, draining the worklist in `Vipin Kaushik/astro-studio`.

`discoverCrossReposSync` (`lib/edges/cross-repo.mjs:138`) stops descending the moment it finds
a cross sidecar:

```js
if (existsSync(path.join(dir, FILE_NAME))) {
  out.push({ name: path.basename(dir), root: dir });
  return; // don't recurse below a found cross repo
}
```

`Vipin Kaushik/.propagates-cross.yml` exists, so the walk returns at that directory and
`Vipin Kaushik/astro-studio/.propagates-cross.yml` — **7 declared cross edges** — was never
enumerated. Not a `maxDepth` problem; reproduced at `maxDepth: 5` on a two-level fixture,
2 sidecars on disk, 1 discovered.

**Why it is S1 rather than S3.** `doctor` has a check for exactly this failure and it was
GREEN throughout: `✓ cross-repo edges resolve  4 edges, 0 missing, 0 outside-allowlist`.
Meanwhile all 7 undiscovered edges resolved `{ok:false, reason:"missing"}` — they pointed at
`~/.hermes/hermes-agent`, a repo absent from the machine, through a `../../../` that lands in
`~/Documents` rather than `~/`, for an integration removed around 2026-09-02. The count stayed
at `4 edges` after the file was deleted, which is how the gap was confirmed.

So this is not "a check that is missing". It is `rule:discernment-checks` §2 and
`rule:enforcement-watches-itself` together: **"found nothing" and "looked at nothing" rendered
identically**, and the one that was true read as a pass. A reviewer trusting that line would
have concluded the tree's cross edges were healthy.

**FIXED, same day.** Two changes, both in this entry's own terms:

1. `lib/edges/cross-repo.mjs` — the walk no longer `return`s after pushing a found sidecar. A
   sidecar marks a participating directory, not a subtree boundary.
2. `cli.mjs` `checkCrossRepo` — now returns `sidecars` and `unreadable` alongside the edge
   counts, and doctor leads its detail line with the CORPUS:
   `✓ cross-repo edges resolve  2 sidecar file(s) scanned — 4 edges, 0 missing, 0 outside-allowlist`.
   An `unreadable` sidecar now FAILS the check rather than being skipped in silence — a check
   declining to look must never render as a pass.

**Verified against the real tree, not only fixtures.** The deleted
`astro-studio/.propagates-cross.yml` was restored from `b91f494` and `checkCrossRepo` re-run
over the hub:

| | sidecars | edges | missing | doctor |
|---|---|---|---|---|
| before the fix | *(not reported)* | 4 | 0 | ✓ green |
| after the fix | 3 | 11 | **7** | ✗ red, naming all 7 |

The same tree, the same file: a silent green became a correct red. That comparison is the
evidence, because the edge count *alone* did not move once the offending file was deleted —
`2 sidecars, 4 edges, 0 missing` looks identical before and after, and only the corpus figure
distinguishes them. Which is the whole point of adding it.

**Guards, 4 of them** (`tests/unit/cross-repo.test.mjs`, `tests/cli/cross-doctor.test.mjs`):
nesting is discovered; nesting is discovered at `maxDepth` 2 AND 5, so a future "fix" that only
widens the bound still fails; `checkCrossRepo` reaches the nested sidecar and reports
`sidecars === 2`; an unparseable sidecar counts as `unreadable`, never as clean. All four were
written FIRST and confirmed red on the old code. Re-mutating the `return` back turns exactly
the three nesting guards red and leaves the orthogonal `unreadable` one green.

### N67 · `rotted-citation` cannot tell a live citation from a recorded supersede — **S3** — **OPEN**

Found 2026-09-10 while fixing the very thing it reports, in `Vipin Kaushik`.

`findDeadBranchCitations` fires on any literal occurrence of an absent branch name. It has no
way to distinguish **"cited as if the branch still exists"** from **"explicitly recorded as
gone, and here is where the work landed"** — and a supersede note *must* name the branch, or
a reader cannot tell what was superseded.

Measured: three `rotted-citation` findings on `docs/constitution/VIPIN.md` and
`docs/design/DESIGN.md`. Fixing all three — rewriting each citation to say the branch is gone
and to name the merge commit that carries the work (`b0ce3fc`, `df63c32`/PR #185) — moved the
count **4 → 3**. Only the self-line citation cleared. The three dead-branch findings survive
their own fix, because the fixed text still contains the branch name.

**The perverse incentive is the point.** The only way to satisfy this check is to delete the
branch name, which destroys the information the supersede note exists to carry. A checker
that rewards making a record less useful will be ignored, and then it protects nothing.

**Suggested:** treat a citation as settled when the branch name is adjacent to a supersede
marker — a merge SHA, "no longer exists", "superseded", "landed in". Narrow is fine; the
current behaviour has a 100% false-positive rate on correctly-superseded citations.

**A second defect in the same check, found in the same pass.** For
`DESIGN.md:1000` → `feat/hero-v4-rebuild`, `resolveRepo` resolved the CITING file to the
workspace repo (`repoRoot: Vipin Kaushik`, branches: `main` only) and checked there — but that
branch only ever existed in `VipinKaushik/`. The verdict came out right **by luck, not by
mechanism**. The latent form: a workspace doc citing any live sibling-repo branch — including
`` `production` ``, which does not exist in the workspace repo — reports as dead. This is the
citation-side analogue of G13, "`check --changed` only sees the repo it runs from".

**Related, cosmetic but easy to trip over.** `asQuestions` (`lib/claims/judge.mjs:105`) emits
`kind_hint` from the *structural* block kind — `prose` / `list-item`. A verdict's `kind` wants
a CLAIM kind (`fact` / `policy` / `quote` / `impression` / `aspiration`). Passing the hint
straight through is rejected by `validateClaim`, which is the good outcome; the bad one is a
reader assuming the tool has pre-classified the claim. Two vocabularies, one field name.

## Rotated to archive

Closed entries live in [`archive/ISSUES-2026-08.md`](archive/ISSUES-2026-08.md), byte-identical.
One line each so an id stays findable from here.

- N1 · Unknown row types are dropped, and the stats are discarded — **S1** — **RESOLVED 2026-08-13**
- N2 · `nextId` is check-then-act racy **and** type-blind — **S1** — **RESOLVED 2026-08-13**
- N3 · Sequential ids cannot survive branches — **S1** — **RESOLVED 2026-08-20**
- N4 · `markStatus` no-ops on an absent or misordered id — **S1** — **RESOLVED 2026-08-13**
- N5 · `hasOpenDuplicateDrift` cannot see `code_drift` — **S1** — **MOOT 2026-08-20**
- N6 · Glob `kind: code` edges silently never fire — **S1** — **RESOLVED 2026-08-20**
- N7 · A missing `PROPAGATE_SEARCH_ROOTS` reports healthy forever — **S1** — **RESOLVED 2026-08-20**
- N8 · Worktree enumeration swallows failure — **S1** — **MOOT 2026-08-14 (watcher retired)**
- N9 · Schema rejection stops a sidecar's edges silently — **S1** — **RESOLVED 2026-08-13**
- N12 · Every `Affects:` line in `DECISIONS.md` parses to nothing — **S1** — **RESOLVED 2026-08-20**
- N13 · `PROPAGATE_SEARCH_ROOTS` does not scope state, so testing the watcher corrupts production — **S1** — **RESOLVED 2026-08-20**
- N17 · `pathProblems` was declared but never incremented — the aggregate check could not fail — **S1** — **RESOLVED 2026-08-13**
- N18 · Source keys are never validated to exist — **S1** — **RESOLVED 2026-08-20**
- N21 · A glob matching zero files must report UNMATCHED, not let its edge vanish — **S2** — **RESOLVED by v2**
- N23 · `WATCHER_LOG` is not test-scoped — `npm test` writes into the production log — **S2** — **impact moot 2026-08-14 (watcher retired)** — **RESOLVED 2026-08-20**
- B1 · Sidecars are branch-local; `doctor` is not branch-aware — **S1** — **RESOLVED 2026-08-15**
- G1 · `check --range` interpolates argv into a shell — **S1, security** — **RESOLVED 2026-08-13**
- N24 · `init` leaves a workspace that `doctor` immediately fails — **S2** — **RESOLVED 2026-08-22**
- N27 · `verify` writes on first invocation while `bootstrap` is dry-run by default — **RESOLVED 2026-08-17**
- N32 · `check` cannot gate a repo that has a sidecar but is not a workspace root — **S1** — **RESOLVED 2026-08-19**
- N33 · Three `lib/*.mjs` carry a literal NUL byte and are invisible to code search — **S2** — **RESOLVED 2026-08-19**
- N34 · Rule restatements — 15 reported, 7 real, 0 remaining — **S2** — **RESOLVED 2026-08-19**
- N36 · The commit-time gate is silently dead for any repo under a symlinked path — **S1** — **RESOLVED 2026-08-20**
- N37 · propagate declares 3% of itself, and the god-file is why — **S2** — **PARTIALLY RESOLVED 2026-08-20**
- N40 · Edge identity is tied to the absolute access path, so the same coupling has different ids by route — **S1** — **PARTIALLY RESOLVED 2026-08-22**
- N41 · ~~S2~~ · **RESOLVED 2026-08-24** · Cross-branch dedupe silently discarded a differing disposition
- N43 · The plugin cutover broke ELEVEN referrers of one deleted directory — **S2** — **PARTIALLY RESOLVED 2026-08-22**
- N44 · The RED phase of a validator test appended two events to the production ledger — **S2** — **RESOLVED 2026-08-22**
- N45 · ~~S2~~ · **RESOLVED 2026-08-24 (fix 2)** · Gotchas documented as auto-firing could not fire, and `--selftest` passed anyway
- N46 · ~~S3~~ · **RESOLVED 2026-08-24** · `watchPathsFor()` hardcoded `docs/`, and stale watch paths were undetectable
- N51 · `parseHandovers` reads fenced examples as real sections — **S2** — **RESOLVED 2026-08-26**

### N66 · `make-public` refuses because its watchlist does not recognise propagate's own directories — **S2** — **OPEN**

**Found 2026-09-01**, while checking whether the publishable tree could be rebuilt before
pushing the claims lane. `bin/make-public.mjs --out <tmp> --check` never reaches the scrub:

```
3 WATCHLIST DIRECTORIES ARE UNMAPPED:
   Divyansh
   propagate
   propagation
```

Two of those three **are this tool's own directories.** The watchlist source is every
depth-1 directory under `SEARCH_ROOTS` — chosen deliberately, and correctly, over workspace
discovery, because real client names leak into docs without carrying a `.propagates.yml`
marker (`tests/portability/make-public-watchlist.test.mjs` states that reasoning). But the
hub root holds `propagate/` and `propagation/`, which are the plugin and its ledger, not
identities. So the check demands they be mapped to pseudonyms or allow-listed, and until
someone does that by hand on each machine the release path cannot run at all.

`Divyansh` is a genuine gap of the intended kind — a workspace added after the map was
last written, which is exactly what the watchlist exists to catch. The other two are the
mechanism failing to exempt itself.

**Why S2 and not S3.** `rule:enforcement-watches-itself` names this shape directly: *"a
mechanism that enforces a property on others and is exempt from it reports success
forever"* — here it is the mirror, a mechanism that cannot complete because it does not
recognise itself, which is the same missing question. And the consequence is not cosmetic:
the scrub is the only thing standing between the private working copy and a public
distribution, so a scrub that never runs is a scrub nobody notices is absent. The CI job
asserts `make-public` exits 2 *without* an identity map; it does not assert that it exits
**0 with one**, so a green suite is compatible with a release path that has never
completed on any machine.

**The fix is mechanical, not data.** Adding `propagate` and `propagation` to a per-machine
`allow` array works and is wrong — it must be re-done on every clone, and a per-machine
data edit is invisible to the next reader. The tool knows its own repo root (`REPO`) and
its ledger directory; both should be exempt by construction, with `Divyansh` left to fail
loudly as designed. Then assert it: a test that runs `--check` against a harness root
containing a directory named like the tool's own and expects exit 0.

**Note the scope this does NOT cover.** `origin` for this working copy IS the public repo
(`Rupali59/propagate`, verified PUBLIC via `gh repo view` 2026-09-01) — there is no second,
scrubbed remote. So `make-public` builds a distribution that has never been the thing
anyone pulls, and 66 files on `origin/main` already carry workspace and client names. That
is a larger question than this entry: **is the intended posture "the repo is public and the
names are acceptable", or "the repo should have been the scrubbed copy all along"?** The
two answers imply very different work and the tree currently asserts both. Filed separately
rather than resolved here, because it is a decision, not a defect.

### N69 · `verify` silently discards unknown flags, so a justification can be written to nothing — **S1** — **RESOLVED 2026-09-26**

Found 2026-09-14, auditing this session's own verification events.

`verify`'s documented flag is `--reason` (`cli.mjs:84`, parsed at `cli.mjs:2718` via
`get("--reason")`). `--notes` exists, but only for `drain` (`cli.mjs:45`). **There is no
unknown-flag rejection anywhere in the arg parser.** So `verify --edge X --disposition
no-change-needed --apply --note "<the whole justification>"` is accepted, exits 0, prints
`✓ <edge> no-change-needed → CLEAN` with an event id — and the note is silently dropped on
the floor.

**Measured, in this machine's own store:**

```
events in store                     2771
carrying a `reason`                 2629   (95%)
written 2026-09-14 with `--note`      20
  ... carrying any justification       0
```

Twenty verification events — 5 `both-reconciled`, 15 `no-change-needed`, closing a real
15-edge cascade — landed with no record of *why*. The measurements that justified them
("0 matches for the changed claim in this downstream", and the per-edge reasoning for each
override) exist now only in a chat transcript. The store is append-only, so they cannot be
repaired in place; they can only be superseded by re-emitting.

**This is the file's own root-defect section, in a new place.** The command reported
success, wrote a well-formed row, and the only signal that anything was lost is that the
`reason` field is absent — visible solely by reading the JSONL. A caller cannot distinguish
"I chose not to give a reason" from "I gave one and the tool ate it".

**Two fixes, and the second is the one that generalises.** Accept `--note` as an alias for
`--reason` (cheap, and it is the obvious word). Then **reject unknown flags across every
subcommand** — a typo'd or misremembered flag must exit non-zero, not proceed with a silently
different meaning. `rule:discernment-checks` §2: absence must be attributable. A dropped
argument is an absence that currently attributes to nothing.

**Test it can fail:** invoke `verify` with a bogus flag and assert a non-zero exit; and
invoke it with `--note` and assert the written event carries the text in `reason`. Both
assertions must be made against the **event row**, not against stdout — stdout was correct
and reassuring throughout this incident.

**The 20 lost justifications, recorded here because the store will not take them back.**
Re-emitting was attempted and **refused**, correctly: `verify --edge fa432c23 --disposition
both-reconciled --reason "..."` returns *"both-reconciled only applies to a DIVERGED edge;
this edge is CLEAN"*. The edges resolved, so their state no longer admits the disposition
that was recorded against them — which means a justification lost at write time can **never**
be attached later by any supported path. That raises the severity of N69: it is not a
cosmetic gap pending a backfill, it is unrecoverable the moment the command returns.

| edge | disposition | the reason that was dropped |
|---|---|---|
| `fa432c23` | both-reconciled | INVENTORY + DATA_GAPS both edited 2026-09-14; DATA_GAPS named SarvarthaChintamani, JaiminiSutras, JatakaTattvam as undigitised, all three held since 2026-09-04 (astroacharya `ab381b6`) |
| `e82c6e94` | both-reconciled | `reference.md`'s chapter workflow was stale three ways — a Youvan BPHS path that no longer holds BPHS, `split_chapters.py` (0 found), and `english_meaning`/`hindi_meaning` (banned, 0 occurrences). Rewritten in `58c69a7` |
| `e377000b` | both-reconciled | Both restructured together in sanskrit-texts `e7de37b`; `check_inventory.py` now fails if they disagree |
| `2cb348a4` | no-change-needed | `list_sources.py` derives `text_id → path` at runtime (`rglob`, line 321); its own comment at line 282 records that re-hardcoding was tried and rejected |
| `6a114165` | both-reconciled | Both stale in the same direction, both now defer to INVENTORY §"Acquisition status" |
| `044c244c` `443b497a` `7ba9fb83` `eabf9f7f` `4a1ed4dd` `d637fc1b` `c4ea2ba6` `0ff35726` `c560f4a7`† `ddb50853`† | no-change-needed | Workspace `CLAUDE.md` was edited independently (`53ea6a8`, a stale Vedic held-count replaced by the command that derives it). None of these ten sources moved; the edge read REVERSED only because the downstream post-dates it |
| `dba8ae6a`† `f86b500c`† `0def67b0`† `e2488f80`† | no-change-needed | Measured against each downstream: **0 matches** for `29 held`, `24 Upanisad`, `51 mapped` or `mukhya`. Nothing there restates the changed claim |
| `c0e01c6d`† | both-reconciled | Both edited and read together; neither claim depends on the other |

**† = written with `--out-of-order`** (7 edges). Each was blocked by an upstream that is
`NEVER_VERIFIED` — a baseline gap, not a known-wrong source — and each disposition rested on a
direct measurement of the *downstream*, not on the upstream being correct. **That fact is
recoverable only from this table; the events themselves record nothing (N70).**

### N70 · `--out-of-order` leaves no trace, so an overridden verification is indistinguishable from a clean one — **S1** — **RESOLVED 2026-09-26**

Found 2026-09-14, alongside N69.

`verify` refuses (exit 3) when an edge's source is itself unsettled, and `--out-of-order`
deliberately overrides that refusal. The skill documents the override as the sanctioned
escape hatch. **But the flag is recorded nowhere in the emitted event.**

```
fields ever seen across 2771 events:
  edge_id node_id disposition by event_id ts hash_alg observed_on_ref
  source_content downstream_content reason observed_at_commit observed_on_branch
  observed_dirty by_kind downstream_on_ref downstream_at_commit
  downstream_on_branch downstream_dirty source_git_blob

events carrying `out_of_order` / `override`:   0 of 2771
```

So an edge pinned against a source that was **known to be unsettled at the time** reads,
forever after, exactly like one verified against a settled source. `status` shows CLEAN for
both. The ordering guard exists precisely because verifying out of order "pins content
against an unconfirmed source" — and the record of having done so is discarded at the moment
it is created.

**Why S1 rather than S3.** This is N19's shape (terminal status with no Transition, no audit
trail) applied to the one operation the tool treats as dangerous enough to refuse by default.
It also defeats review: `rule:adversarial-review-reads-the-ledger` says to read the ledger
before trusting a green result, and the ledger cannot answer "which of these were forced?".
Seven such overrides were written on 2026-09-14 and none is recoverable from the store — a
subsequent agent searching the events for them concluded, reasonably and wrongly, that the
cascade had never happened.

**Fix:** persist the override as a first-class field (`out_of_order: true` plus the blocking
upstream edge ids that were bypassed), and surface it — `status`/`graph` should mark a CLEAN
edge whose last verification was forced, because that is a weaker claim than an ordinary
CLEAN and currently renders identically.

---

**RESOLVED 2026-09-26, both together, because they are one defect wearing two hats: `verify`
writes a row that looks complete and is not.**

**The fix is a table, not a check.** `lib/core/commands.mjs` holds every subcommand as data —
its usage text AND its flag kinds. `renderUsage()` builds the help line from it and
`validateFlags()` validates against it, so the two cannot disagree. The obvious alternative,
an allowlist beside the parser, is a second list, and this repo has paid twice for a second
list that drifts (G70, G71).

**The refactor is provably behaviour-preserving.** `renderUsage()` was asserted byte-identical
to the 1756-character literal captured from HEAD *before* anything else changed, and that
frozen string is embedded in the test rather than re-read from HEAD — a test that read the
current file would compare the new thing against itself and pass forever.

**N69:** `--note` is now an alias for `--reason`, and `--reason`/`--note` given with DIFFERENT
text is refused rather than silently resolved. An unknown flag exits 2, names the nearest
known flag, and writes nothing. `--flag=value` is refused too: `get()` reads
`args[indexOf(flag)+1]`, so the `=` form has never worked, and accepting it would recreate this
issue in a new place.

**N70:** the event now carries `out_of_order: true` and `bypassed_upstreams` — the upstream
edge ids that were unsettled AT THE TIME. "It was forced" is weaker information than "it was
forced past these", and only the second survives once those upstreams resolve and stop looking
like blockers. The blockers are now computed on the override path; previously `blockedBy()` ran
only inside `if (!opts.outOfOrder)`, so the very thing being overridden was never calculated.
`status` counts forced CLEANs within `verified` and marks them, because it is a weaker claim,
not a failure.

**Every assertion is against the EVENT ROW, never stdout** — this file records that stdout "was
correct and reassuring throughout", so a stdout test would have passed on all twenty.

**Five mutations confirm the guards fail.** The sharpest is M2: removing the dispatch validator
makes the unknown-flag test report `expected exit 2, got 0` — N69 itself, reproduced on demand.

**WHAT THE DERIVATION FOUND, which is the part worth keeping.** Building the allowlist from the
usage text broke 25 tests, because the usage string under-documents what the CLI accepts. A
sweep of what `commands/*.mjs` actually reads from argv closed it, and the arithmetic is the
finding:

| | count |
|---|---|
| modes `cli.mjs` dispatches | 41 |
| modes the usage string named | 33 |
| flags accepted but documented nowhere | **39** |

`--out-of-order` was one of the 39 — read from argv, in no usage string at all, which is half of
why an override could be used for months with nobody able to search for it. Documenting it was
forced by the validator rather than remembered.

Both populations are now NAMED, bounded sets asserted by tests (`UNVALIDATED`, `UNDOCUMENTED` in
`tests/unit/cli-commands.test.mjs`) that may shrink and never grow. Eight modes still skip flag
validation because their flag lists were never enumerated; four of them WRITE, so guessing an
allowlist from a skim would break a repair tool at the moment it is needed. That is deliberate
and it is the remaining work.


### N71 · `NEVER_VERIFIED` is reported for edges that were examined and deferred, and the remediation offered is wrong for all of them — **S1** — **RESOLVED 2026-09-15**

Found 2026-09-14, after it caused a full round of duplicated work.

`status` renders:

```
142 edges · 110 verified · 31 never verified · 1 need attention
  never verified (31) — a baseline gap, not drift. `bootstrap` to triage.
```

Measured against the event store, all 31 of those edges carry an event:

```
edges reported NEVER_VERIFIED : 31
  ...of which HAVE events      : 31
  ...genuinely never touched   : 0
dispositions: {'deferred': 31}   dates: {'2026-09-10': 31}
```

Every one was read, judged, and deliberately deferred four days earlier, each with a
substantive `reason`. Not one is a baseline gap.

**The data is not missing — the summary discards it.** `reconcile --json` returns a full
`deferred` object beside the state for these edges (`{disposition: "deferred", by:
"<user>", observed_at_commit: fc4564df…}`), exactly as `lib/edges/reconcile.mjs:283`
declares (`state, since, last, deferred`). `status` reads that structure and prints only
the state name.

**Internally the state machine is defensible** — `lib/edges/migrate-ledger.mjs:507` records
that deferred is deliberately "A FLAG, NOT A NINTH STATE", and `last` is genuinely `null`
because no *verifying* disposition was applied. The defect is entirely in what the user is
told.

**What it cost.** Believing the summary, a session filed the 31 as a baselining backlog,
confirmed via two `bootstrap --baseline-from-git` dry-runs that **0** were `baselineable`,
then dispatched four subagents to hand-verify 26 of them. Three lanes returned before the
duplication was noticed, and every finding they produced **already existed in the deferred
reasons from 2026-09-10** — re-derived from scratch at roughly 390k subagent tokens.

The re-derivation did earn two things, which is the only reason this is not a total loss:
the recorded reasons were independently confirmed accurate, and one was found to carry a
**wrong supporting timeline** (`d4496acc`/`ae4de1cd`/`4ec364cb` assert `-mb`'s
`Appointment.js` postdates VK's model by three weeks; `git log --follow` shows two commits,
the first `ad1ce8c` 2026-05-13, which *predates* it by six days — the conclusion stands on
the import/enum evidence, the sequencing argument does not).

**This is N68's shape and `rule:discernment-checks` §2 again: "not looked at" and "looked at
and parked" rendering identically.** It is the third instance in this file.

**Fix.** Split the count and the advice. "Never verified" must mean *no event of any kind*;
edges carrying a `deferred` flag want their own line — `31 deferred (examined, not resolved)
— see \`why <edge>\`` — and must not be offered `bootstrap`.

**CORRECTED 2026-09-15 — this sentence used to end "which cannot touch them", and that was
false.** `bootstrap --baseline-all` filtered on `state === "NEVER_VERIFIED"` and the word
`deferred` appeared nowhere in `lib/edges/bootstrap.mjs`, so it could overwrite a deliberate
defer with a baseline. That is the S1 fixed in #14 — filed a day later, by someone who went
looking rather than believing this line. An issue asserting a safety property the code does
not enforce is `rule:safety-flag-needs-a-test` one level up: the unverified claim was in the
tracker instead of in a flag, and it is *more* dangerous there, because a flag at least gets
read at the call site. If
splitting the rendering is deferred, the minimum is to stop printing remediation that is
provably wrong for every edge in the bucket.

**Test it can fail:** defer an edge in a fixture, then assert `status` does not describe it
as never-verified and does not recommend `bootstrap` for it.

---

**RESOLVED.** Two commits, because the defect had two halves and only the first was visible
from this entry.

| | |
|---|---|
| `d167be6` (#13) | `status` splits the count: `316 never verified · 33 deferred`, and stops offering `bootstrap` where it cannot help |
| `6da8b72` (#14) | `bootstrap` genuinely cannot touch a deferred edge — the split happens **before** any policy branch, so no future flag re-opens the hole |

The second is the one this entry's own text argued was unnecessary. Reading the guard at the
call site, rather than the sentence describing it, is what found it.

### N72 · The restatement pairer anchors on the heading, so real restatements are never examined — **S2** — **OPEN**

**MEASURED 2026-09-30 on the rule that DEFINES the discipline.** `discernment-checks`'s own
fingerprint matches 7 lines of its own body, and the first four are all `## ` headings:

```
HEADING  ## 1 · A check that cannot fail is worse than no check
HEADING  ## 2 · Absence must be attributable
HEADING  ## 3 · Verify the work, not the report
HEADING  ## 4 · Verify the instrument before believing a surprising number
```

Its selftest is green because it matched structure. The claim two lines under §3 is invisible to it —
which is this entry's defect, in the rule that names it.

**One distinction this measurement forced, worth recording before the fix:** a heading whose text IS
the claim verbatim (`delegation-criteria.md:92`) is CORRECT to match. The harm is anchoring on a
heading that states nothing, because then the pairer returns UNPAIRED and the claim below is never
read. A fix that suppresses all heading matches would lose real detections.

Found 2026-09-15, while judging the 15 entries Phase 2a handed over.

`checkRules` reports the line where a rule's fingerprint matched. For the `tool-priority`
fingerprint that line is very often a section title — `## MCP: code-review-graph` — or the
HTML comment above it. `splitBlocks` correctly classes both as structure rather than a
claim, so `findClaimBlock` returns no block and the entry is reported UNPAIRED.

That reporting is honest. The problem is what it hides.

```
15 corpus entries
   5  paired and judged
  10  unpaired  ← 9 anchored on a heading or comment, 1 a genuine filename false positive
```

**Two of those ten carry a real restatement in the paragraph directly below the anchor**,
which the lane never read:

| file | what sits 2 lines under the anchor |
|---|---|
| `Rupali/Obsidian/CLAUDE.md` | "this repo has the `code-review-graph` **pre-commit** git hook installed, so its graph refreshes on commit — not on file change, and never for uncommitted work" |
| `Vipin Kaushik/VipinKaushik/CLAUDE.md` | "run `code-review-graph status` to check the built commit is an ancestor of HEAD before trusting it" |

Both restate the rule, both are accurate, and both were ruled `consistent` **only because a
human read the file**. Effective automated coverage of this corpus is 5 of 15, and nothing
in the output distinguishes "the anchor was structure" from "this file does not restate the
rule" — which is the same two-states-worn-as-one shape as N71 and N68
(`rule:discernment-checks` §2), now in the pairer.

The severity is in the direction of the error. An unpairable entry is reported and visible;
a real restatement sitting under it is **invisible**, and would stay invisible through any
future drift.

**Fix.** `findClaimBlock` should walk forward from a structure anchor to the next judgeable
block rather than giving up — a heading is a *label for* the prose beneath it, so that prose
is the natural claim candidate. Bound the walk (one or two blocks) so it cannot drag in an
unrelated section.

**Test it can fail:** a fixture whose `## Heading <fingerprint>` is followed by a paragraph
that restates the rule; assert it PAIRS and that the paired block is the paragraph, not the
heading. Then mutate the walk away and confirm it goes back to unpaired.

### N73 · A verdict written for an unpairable entry was inert — **S2** — **RESOLVED 2026-09-15**

Found 2026-09-15 by grepping for callers of a function that had just been built.

`unpairedSha` was added in #16 so an entry the pairer cannot pair could still be
dispositioned, and `tests/unit/claims-verdict.test.mjs` asserts it yields "a valid
`block_sha`, so a verdict can key to it". **Nothing ever keyed one.** `restateStatus` built
`judgedByKey`, consulted it for `pairs`, and returned `unpaired` verbatim — so every verdict
written for an unpairable entry was a no-op, and the same entries would re-report on every
run forever. The lane could not converge, which is the single thing the hash was introduced
to fix.

Identity built, unit-tested, no consumer: `rule:enforcement-watches-itself`. The tests passed
identically whether or not a consumer existed, because they tested the hash rather than the
wiring. **Grepping for callers of what you just built is the check that catches this shape,
and it costs one command** — the same move that found the dead `radar.mjs` and the
zero-caller filesystem walk recorded in that rule.

Caught before it cost anything: the defect was found while preparing the first 15 verdicts,
so no inert verdict was ever written.

**Fixed.** Each unpaired entry now carries `against` (the derived fact's sha), and
`restateStatus` splits unpaired into `judged` / `awaiting` / `undispositionable` — the third
because an entry whose rule will not load has no fact, `validateClaim` refuses a `finding`
without an `against`, and advertising it as "awaiting judgment" would promise work nobody can
do.

**Guards** (`tests/unit/claims-restate.test.mjs`): a verdict moves an entry out of awaiting;
the same entry with an EMPTY store stays awaiting (so the first test measures something); a
fact-less entry is undispositionable rather than awaiting. Mutation-checked — disabling the
lookup fails exactly one test with the stated message, and the revert is byte-identical.

### N74 · The restatement walk pairs the FIRST judgeable block, which is often the citation — **S3** — **OPEN**

Found 2026-09-16, immediately after N72's fix landed, by judging what it produced.

N72 made `findClaimBlock` walk forward from a structure anchor to the next judgeable
block. That raised coverage from 5 of 15 to 8 of 15. But it takes the FIRST judgeable
block, and in this corpus the first block under a `## MCP: code-review-graph` heading
is very often a pointer line rather than the restatement.

Worked example, `Rupali/Obsidian/CLAUDE.md`:

```
## MCP Tools: code-review-graph          <- anchor (structure)
See `rule:tool-priority` for general …   <- block the walk pairs: a CITATION
Local: this repo has the `code-review-   <- the actual restatement, one block further
graph` **pre-commit** git hook installed …
```

So the entry pairs, gets judged `unrelated` — correctly, *for that block* — and the
real restatement below it remains unexamined. The verdict is not wrong; it is about
the wrong text. That is a subtler failure than N72's, because the lane now reports
the file as handled.

**Not worth widening the bound.** Walking further would pair headings with
arbitrary later prose, which N72's own fixture deliberately guards against. The fix
is candidate SELECTION, not distance: among judgeable blocks within the bound,
prefer the one whose text actually matches the rule's fingerprint most strongly,
rather than the first one encountered. A bare `See rule:x.` line matches a
fingerprint only incidentally.

**Test it can fail:** a heading followed by a pointer line and THEN a restating
paragraph must pair the paragraph. That fixture does not exist today — N72's
fixtures all place the restatement first.

### N75 · `plans --check` counts subagent plan-mode artifacts as authored plans — **S2** — **OPEN**

Found 2026-09-16, the day `plans --check` was built, by running it on the real corpus.

Of 11 post-template plans it flagged, **5 are `*-agent-<id>.md`** — files written
automatically when a subagent inherits plan mode and drafts a plan it never executes.
One more is a design doc that merely lives in `plans/`. Only a handful were authored
by a person as plans.

Those artifacts will never carry an arrival condition and should not. Worse, the
count rises every time a subagent enters plan mode — **eight times in the session
that built this checker**. That is exactly the shape prior learning
`count-ratchet-over-growing-population` names: *"a raw COUNT over a population that
grows with authorship measures output, not debt — it trips when you write, not when
quality drops."* The lane was built specifically to avoid that trap via the
2026-09-14 date gate, and then walked into it through a different door.

**Fix.** Classify `*-agent-<id>.md` as its own kind and report it as a separate
count, never folded into the conformance total. Do NOT simply exclude it silently —
"0 flagged because we stopped looking at half the corpus" is the failure this repo
keeps paying for. Report it as `N agent-generated (not graded — not authored plans)`,
the same way the lane already reports what doc-kind excluded and why.

**Note the naming is a convention, not a guarantee.** The `-agent-<hex>` suffix is
produced by the harness; a future change to it would silently re-merge the two
populations. Assert the pattern in a test so the drift is visible.

### N82 · The workspace census cannot tell "looked and found nothing" from "looked at nothing" — two empty directories pass, one real repo is invisible — **S1** — **RESOLVED 2026-09-26**

Found 2026-09-17. Two symptoms, one root: the layout report tests for **presence of a
path**, never for contents, and enumerates only what it already knows about.

**RAISED S2 -> S1 on 2026-09-23, on a third symptom that is worse than the two it was
filed on.** `doctor`'s conformance check over an EMPTY POPULATION renders as a pass:

```
{"kind":"pass","label":"workspaces conform to the v3 propagation layout","detail":"0/0 conform"}
```

The predicate is `rep.offenders.length === 0`, which is **vacuously true over an empty
set**. So it is not only that an empty directory passes — the whole check passes having
examined nothing, and prints the emptiness as though it were the result. Reproduced
directly while building slice 1, by constructing a `Reporter` and running
`checkDiscovery` in an environment where `SEARCH_ROOTS` is `[]`.

**Why S1 rather than S2.** This repo's scale: S1 is "silently wrong (you cannot tell it
happened)". A green tick reading `0/0 conform` is indistinguishable from a green tick
reading `22/22 conform` to anyone scanning the report, and `GOALS.md` goal 1 names
`propagate doctor` as its derivation — so an unmeasurable tree currently satisfies a goal
by returning nothing. Nothing about the output says which happened.

**Symptom 2 is now addressed** (`b164a9f`, N87 slice 1): the census is owner-based and
`propagate` appears in it as a half-migrated offender. Symptom 1 and this third one
remain, and both belong to the doctor slice-2 work in
`docs/plans/2026-09-23-doctor-slices-2-3.md` — a check whose predicate can be satisfied by
an empty input becomes `inconclusive`, never `pass`.

**Symptom 1 — an empty directory is reported conformant.** Measured:

```
Khushboo/propagation/state/workspace/   0 entries   ECOSYSTEM.md: "**Layout** — conformant."
Rishabh/propagation/state/workspace/    0 entries   ECOSYSTEM.md: "**Layout** — conformant."
```

`rollup`'s conformance check asserts `state/` **exists**. Both directories do exist and
hold nothing. Counted properly across the tree: **17 `propagation/state/workspace/`
directories, 15 non-empty, and only 10 carrying the `STATE.md` the rule requires.** All
four of Tushar's projects have a `.sidecar.yml` and neither `STATE.md` nor `DECISIONS.md`.
`rule:discernment-checks` §2 in one sentence: found-nothing and looked-at-nothing must not
render alike.

**And the tool that defines the standard fails it.** `propagate` itself is one of only two
NON-CONFORMANT workspaces, missing **4 of 5** required items (`README.md`, `INDEX.md`,
`refs/snapshot.json`, `refs/lifecycle.jsonl`); `propagate/propagation/` holds only
`state/`. `rule:enforcement-watches-itself`, landing on the repo whose job is catching
exactly this.

**Symptom 2 — `firstmate/` is enumerated nowhere.** A real git repo at the hub root,
absent from `propagate status --all`, from `ECOSYSTEM.md`, and from the hub `CLAUDE.md`
repo map. It has no `propagation/`. `Motion-Graphics` at least gets a NON-CONFORMANT row;
`firstmate` gets no row at all.

Its remote is `github.com/kunchenguid/firstmate` — **not** a `Rupali59/*` repo — so it may
well be a vendored clone that *should* be exempt. **That is the finding, not a mitigation
of it:** there is no way to tell a deliberate exemption from an invisible repo by reading
any report. Both render as silence.

**Why these are one issue.** Fixing the conformance check to read contents would still
leave `firstmate` unlisted, and listing `firstmate` would still leave two empty
directories green. The shared root is that the census has **no vocabulary for absence** —
no "present but empty", no "exempt, because —", no "found, not enumerated". Three
different silences currently render identically.

**Expected consequence of fixing symptom 1, so nobody is surprised:** two workspaces flip
from green to red. That is the check starting to work, not a regression.

**Test it can fail:** create an empty `state/workspace/` in a fixture and assert the
conformance line does NOT read `conformant`. Today it does.

---

**RESOLVED 2026-09-26. All three symptoms, verified individually rather than assumed from this
entry — two of them turned out to be already fixed.**

| symptom | state on 2026-09-26 |
|---|---|
| 2 — a real repo enumerated nowhere | already fixed; `firstmate` appears in `notStarted` |
| 3 — `0/0 conform` as a green tick | already fixed; `discovery.mjs` calls `reporter.inconclusive()` with a mandatory reason |
| **1 — an empty directory reports conformant** | **live, and what this change fixes** |

**The root was named correctly in this entry and that is what got fixed.** Not the boolean —
the vocabulary. `conformance()` now returns `empty` as a list SEPARATE from `missing`, because
"the path is not there" and "the path is there and hollow" are different facts, and merging
them recreates this issue one level in: a reader told `state/` is MISSING goes to create what
already exists.

`hasProjectDir` became `hasPopulatedProjectDir`, and the rename IS the fix — it was documented
as *"exists and holds at least one subdirectory"*, which is exactly what it checked and exactly
what was wrong.

**`conformanceReport` gained a fourth bucket, and it was not optional.** With `empty` reported
but no bucket for it, Khushboo landed in `offenders` with an EMPTY missing list and `doctor`
printed `Khushboo lacks ` with nothing after "lacks" — this issue's own failure, arriving one
level in, caught by looking at the output rather than the counts. Four states now, four words:

```
conforming 15   offenders Sindhu propagate   hollow Khushboo Rishabh
notStarted Grid obsidian-vk-publish Motion-Graphics firstmate
```

**The prediction held exactly.** This entry said "two workspaces flip from green to red. That is
the check starting to work, not a regression." Measured: 17 of 23 -> 15 of 23, and the two are
Khushboo and Rishabh. Nothing else moved.

**A stricter predicate was measured and REFUSED, with a reason.** Also requiring
`state/workspace/STATE.md` would flip seven, but three of the five extra hits are
`Obsidian` and two **git worktree copies** — so it would make a different defect louder while
attributing it to this one. Filed separately as N100.

`doctor` now reads: `2 half-migrated — … A partial migration is the state that loses data.
2 present but EMPTY — Khushboo's state/ holds no state; … The directory exists, so this reads
as migrated and is not.` Two clauses because they are two different repairs.

### N100 · Git worktree copies are counted as workspaces, so the same tree is graded twice — **S3** — **OPEN**

Found 2026-09-26, while measuring a stricter conformance predicate for N82.

`ownerCandidates()` enumerates 23 workspace candidates, and two of them are worktrees:

```
calibration-sampler-52226 -> worktrees/calibration-sampler-52226
ubersicht-widget-52226    -> worktrees/ubersicht-widget-52226
```

A worktree is a checkout of a repo already in the census, not a workspace of its own. Each
carries its own conformance verdict, its own row, and its own contribution to the denominator —
so the same tree is measured twice and the ratio is quietly wrong in both directions.

**Why S3 rather than S2.** Both currently CONFORM, so nothing is misreported today; the count is
inflated and that is all. It becomes sharper the moment any predicate tightens — under N82's
rejected option B these two were 2 of the 5 extra failures, which is how they were found.

**Not a silent exclusion.** `rule:discernment-checks` §2: dropping them without a word would make
the census smaller for an unstated reason, which is the shape N82 was filed about. A worktree
should be *named and excluded*, with the repo it belongs to, the same way `notStarted` names what
it is not grading.

**Derive, do not trust the two above:** `git worktree list` per repo, or `ownerCandidates()`
filtered on a `worktrees/` path segment. The `-NNNNN` name suffix is a convention of
`scripts/worktree-new.sh`, not a guarantee — asserting on it alone would go blind if that script
changed.

**Derive, do not trust the counts above** — `propagate rollup --check`, plus a `node` walk
of `*/propagation/state/workspace/`. Not `grep`: the ugrep shim honours the hub's `/*`
`.gitignore` and returns false zeros, measured again during this very census (a reference
search returned 1 file by `grep -rl` and 41 by `find | xargs grep`).

---

### N83 · Hub `CLAUDE.md` currency is enforced for 4 of 16 workspaces — the other nine can rot invisibly — **S3** — **OPEN**

Found 2026-09-17. The hub's repo map describes every workspace. Only four workspaces
declare an edge that would notice when their row goes stale.

**Declared `<workspace>/CLAUDE.md -> CLAUDE.md`:** Divyansh, Keerti (×3), Motherboard.
**Not declared:** Vipin Kaushik, Tathya, PanditPawanKaushik, Rupali, Tushar, Anushka,
ManavDaehi, and the rest.

This is exactly the failure the `Rupali/.propagates-cross.yml` edge was added to close on
2026-09-14 — after `claude-usage-sample` ran unregistered for four days — and the closure
was never generalised beyond the one workspace that had just been bitten.

**Evidence the rot is real, not theoretical.** The hub `CLAUDE.md`'s own `Rupali/` row
carries a note that it *"was wrong about presence in both directions"* — three projects
listed as live and absent, two listed as gone and present — and says why that is worse than
being merely stale: **neither error is detectable by reading it.**

**Not recommending the sweep.** Generalising means nine new declarations across nine repos
with independent branch lines and pre-existing uncommitted work — the convention rollout
declined on 2026-09-17. Filed so the exposure is visible and the decision is deliberate.

**Test it can fail:** edit a workspace's `CLAUDE.md` identity section and assert
`check --changed` names the hub `CLAUDE.md`. True for four workspaces today, false for nine.

---

### N84 · Every in-tree ledger is empty and all 2839 events live outside every git remote — undecided, undocumented — **S3, and the severity was wrong** — **RESOLVED 2026-09-30** (decided and recorded in DECISIONS.md; store mirrored to the private hub; recurring refresh is [[n107]])

Found 2026-09-17 while mapping what a workspace owns.

**RESOLVED 2026-09-30. The entry asked for a decision record and got one — `DECISIONS.md`,
2026-09-30 — plus the mirror, because one measurement made the answer obvious and reclassified the
severity.**

**Re-measured today.** The event count has grown from 2839 to **2,946**, plus **11 that survive only
in `events/archive/2026-08.jsonl.pre-truncate-2026-08-17`** — verified by comparing `event_id` sets,
which also cleared `~/.propagate/2026-08.jsonl.pre-reinit-2026-08-22` as **1,435 events with 0
absent from the live store**, i.e. fully redundant. The "17 ledger.jsonl files" is now **20**, of
which 19 hold 0 rows; `Vipin Kaushik/obsidian-vk-publish/.propagation/ledger.jsonl` holds 28. My
first sweep today said 18 files because it used `-maxdepth 4`; depth 6 finds 20. **G-L, third
instance in two days**, in the same pass that re-measured it.

**Half the answer was already in the code, written fluently, doing nothing.**
`lib/report/doctor/workspaces.mjs:149-152`: *"`ensureLedgerPair` does
`writeFileSync(ledgerJsonl, "")` and NOTHING in this repo appends a row to any ledger file."* So an
empty in-tree ledger is the ONLY state the code can produce — it is not a stalled migration, and
this entry's central ambiguity was resolved in a comment on a retired doctor check. That comment
answers *"are empty ledgers a defect?"* (no) and not *"should the store be backed up?"*, which is
why it sat on top of an open entry for thirteen days. `rule:enforcement-watches-itself`.

**The severity was wrong, and the mechanism is worth naming.** This entry says *"the deliverable is
a decision record, not code"* and *"this may well be correct"*, which frames it as governance —
so it was filed S3. The measurable fact is **611 KB of hand-written reasoning across 2,793 of 2,946
events**, single-copy, in a directory with no `.git`. An entry phrased as a pending DECISION reads
as lower-risk than the same entry phrased as a MEASUREMENT; the hazard did not change, the sentence
shape did. On content it was the only irreversible-loss item in the register.

**And it was invisible to the tree's own detector.** Hub `CLAUDE.md` §"No-git-remote inventory
(data-loss risk)" derives its list with `find ~/Documents/GitHub -maxdepth 6 -name .git`.
`~/.propagate` is outside that root, so the section written for exactly this risk class cannot see
its largest instance — `rule:discernment-checks` §5, the check being fine and the population not.

**Done:** mirrored to `workspace-hub` at `propagation/events-backup/` (private; propagate is public
and `reason`/`node_id` carry private identifiers), under the original filenames so git stores
deltas and history becomes the dated series, with a README stating what it is, why it is not called
`events/` (`readEvents()` globs `*.jsonl` flat over `EVENTS_DIR`), how to restore, and that two
stores must never be merged by concatenation. Hashes verified both sides. **Uncommitted — the
commit is Rupali's.**

**Not done:** the refresh is a manual `cp`. See [[n107]]. Until that lands this is half-delivered,
and a stale backup reads as protection — the same shape as [[n26]]'s frozen liveness banner.


**Measured:** all **17** `ledger.jsonl` files in the tree hold **0 rows**. The cross-ledger
(`propagation/PROPAGATION_CROSS_LEDGER.jsonl`) has **never** recorded an entry — its
rendered `.md` says *"Last entry: never"*. The live store is `~/.propagate/events/` —
**2839 events**, outside the tree, outside every git remote, and outside every backup that
follows a repo.

**The consequence, stated plainly: a full-tree clone on another machine restores zero
verification history.** Every disposition, every `no-change-needed` with its hand-written
reasoning, every `both-reconciled` asserting a human looked — none of it travels with the
repos it describes.

**This may well be correct.** A machine-local event store is a defensible design: the
events record what *this* machine verified, and `REFERENCE.md` §"`manifest`" exists
precisely to stand a workspace up elsewhere. The `archive/ledger-v1-*.jsonl` files in-tree
are explicitly FROZEN history.

**The issue is that no document says which.** There is no `DECISIONS.md` entry stating
"the event store is deliberately machine-local, and here is what that costs". So a reader
finding 17 empty ledgers cannot tell a deliberate design from a migration that stalled —
the same ambiguity as N82, one layer down.

**The deliverable is a decision record, not code.** Whichever way it goes, write it down.
If machine-local is intended, say so and name what a second machine is expected to do. If
the ledgers should carry rows, they have been empty since at least the v2 cutover and that
is a real gap.

### N81 · Five more files colocate a machine-parsed grammar with append-only churn — N77's shape, before it bites — **S3** — **OPEN**

Found 2026-09-17 by a census run to answer whether N77 is one bad edge or a pattern. It is
a pattern, and the useful part is that **four of the five are not yet costing anything.**

**The discriminator.** A file is an instance only if BOTH hold: the spec region is
materially more stable than the file around it, AND something mechanically depends on the
spec. A long file with a header nothing parses is just a long file.

| file | lines | spec region | spec last moved | file / 60d commits | parsed by | declared edge? |
|---|---|---|---|---|---|---|
| `HANDOVERS.md` | 2374 | close protocol, L1–97 | 2026-08-28 | 2026-09-16 / **46** | `lib/report/handovers.mjs` | **yes — this is N77** |
| `propagate/…/workspace/DECISIONS.md` | 1183 | `What/Why/Affects/Refs`, L3–7 | 2026-08-10, never since | 2026-08-31 / 19 | `lib/report/decisions.mjs`, `graph-index.mjs` | no — latent |
| `Vipin Kaushik/…/sanskrit-texts/GOTCHAS.md` | 1769 | `**Trigger:**` grammar, L1–4 | 2026-08-24, never since | **2026-09-17** / **50** | `hooks/gotcha-guard.mjs` | no — latent |
| `Vipin Kaushik/…/marketing-intel/GOTCHAS.md` | 846 | L1–7 | 2026-08-24, never since | 2026-09-02 / 21 | same | no — latent |
| `Vipin Kaushik/…/workspace/GOTCHAS.md` | 491 | L1–9 | 2026-08-24 | 2026-09-14 / 8 | same | no — latent |
| `Motherboard/…/workspace/GOTCHAS.md` | 413 | L1–11 | 2026-08-21 | 2026-08-30 / 7 | same | edge exists but scoped to the G-list, not the header |

**The finding that changes the fix: none of the five has a declared `kind: code` edge on
the header.** So none is currently manufacturing `no-change-needed` dispositions the way
N77's does. This is *"fix it before someone declares an edge"*, not *"six live N77s"*. The
day anyone declares one to keep a header honest, it starts firing on every `### G-n` append.

**What the five GOTCHAS.md files actually did.** They independently restated the
`### heading` / `**Trigger:**` / `**Fires on:**` grammar that `gotcha-guard.mjs` depends on,
inline, at the top of their own append-only file. That grammar is already canonical in
`rule:every-project-carries-gotchas`. So this is the restatement failure that rule exists to
prevent, committed inside the files the rule governs.

**And the correct pattern already exists in the same tree, which is why this is cheap.**
`Vipin Kaushik`'s three `DECISIONS.md` files carry **no** grammar paragraph — they point at
`rules/conventions/STATE_MANAGEMENT.md`, where the contract lives beside `decisions-check.sh`
that enforces it. `propagate`'s own `DECISIONS.md` restates it inline instead. The model and
the defect are both in this repo's tree; the fix is to copy the model.

**Recommended, per file, one line each:**

- `HANDOVERS.md` — N77's own recommendation; move the ~31-line protocol out, leave a pointer.
- `propagate/…/DECISIONS.md` — move the `What/Why/Affects/Refs` grammar to `docs/` beside the
  `decisions-check.sh` contract; leave a one-line pointer. Copy what Vipin Kaushik does.
- The five GOTCHAS.md headers — **delete the restated grammar, cite
  `rule:every-project-carries-gotchas`.** Nothing to relocate; the canonical text already
  exists. This is the cheapest of the three and removes five future N77s.

**Rejections are part of the result.** `ISSUES.md` (including the file this entry lives in)
FAILS the discriminator — `lib/report/backlog.mjs` parses individual `### N81 ·` entries
structurally, and nothing parses the header or severity legend. `ECOSYSTEM.md` fails by
construction: it is regenerated wholesale, so header and body always move together and a
hand-edit is refused by the footer hash. `NORTH_STAR.md` is not an instance — it is the
TARGET pattern, a stable spec correctly kept out of a churning file. The hub `CLAUDE.md`
placement test has the stability gap but nothing parses it, so it is prose, not a contract.

**One claim from the census was checked and REJECTED.** It reported that
`.propagates.yml`'s `NORTH_STAR.md -> CLAUDE.md` edge cites a section, *"§The client
boundary"*, that no longer exists. It does exist — `## The client boundary` is in
`NORTH_STAR.md`, which is what the `why` means by *"**its** §The client boundary"*. The
check had been run against `CLAUDE.md`. Recorded because a phantom "declared edge cites a
dead section" finding would have sent someone editing a correct sidecar.

**Test it can fail:** for each file above, assert the spec region's last-changed commit is
older than the file's, and that the region is reachable by the parser that depends on it.
When a file stops satisfying the first, it has stopped being an instance.

### N80 · `readGotchas` computes the trigger count and `row()` drops it, so gotcha LIVENESS reaches no reader — **S3** — **OPEN**

Found 2026-09-17 during a promotion/liveness audit. A three-line defect sitting directly
beneath a docstring about this exact class of mistake.

**The mechanism.** `lib/report/registers.mjs:244` computes it:

```js
const triggered = parseEntries(file).entries.length;
return row({ kind: "gotchas", file, lines, entries: heads.length, …, triggered });
```

`row()` at :122 destructures
`{ kind, file, lines, entries, live, finished, rotatable, reason, unread, error }` and
returns exactly those. **`triggered` is not among them.** It is computed, passed, and
discarded — no consumer can ever see it.

**Why it matters, and why it is not cosmetic.** `every-project-carries-gotchas` makes the
whole argument that presence is easy and LIVENESS is what counts: *"a `GOTCHAS.md` can be
present, current and correctly reconciled while delivering nothing, because its entries
carry executable triggers and a trigger that cannot fire is a hazard documented but not
delivered."* The per-file triggered/total ratio is the number that distinguishes those two
states, and it is the one field that does not survive the row.

Measured tree-wide today: **427 entries across 23 files, of which 216 (~51%) carry a
`**Trigger:**`.** The spread per file is enormous and invisible —
`Divyansh/…/AuroraV3` is 29 of 33 triggered, while
`PanditPawanKaushik/…/gemastrology-shopify` is 4 of 29 and
`propagate`'s own is 16 of 69. Nothing surfaces that.

**The irony is local.** The comment immediately above `row()` explains that `reason` is
load-bearing because *"0 rotatable because every entry is live"* and *"0 rotatable because
this file did not parse"* are different facts (`rule:discernment-checks` §2). The author
was thinking about exactly this hazard in the function where the drop happens.

**Two things this issue explicitly does NOT claim:**

- **The 49% without a trigger are not a defect.** `LIFECYCLE.md` makes untriggered the
  correct default — *"most gotchas have no mechanical trigger and inventing one makes
  noise."* The ratio is worth SEEING, not worth driving to 100%.
- **Trigger liveness itself is currently healthy.** `selftestProblems()` run across all 20
  content files plus the global one reports **0 problems** — every entry declaring a
  `**Trigger:**` also declares a `**Fires on:**` literal that its own regex matches. So the
  inert entries N45 found have since been fixed.

  **`cli.mjs:1073` is NOT stale and must not be "corrected".** The audit that produced this
  issue recommended editing it; that recommendation was wrong and is recorded here because
  the distinction matters. The comment reads *"N45 measured 3 of 10 inert while --selftest
  reported green"* — past tense, attributing a historical measurement to explain **why the
  check exists**. A justification-by-history is not a claim about the present, and deleting
  it would remove the only record of why anyone bothered to tally liveness at all. The same
  reason the hub `CLAUDE.md` preserves its 2026-06-28 cleanup note. Leave it.

**Test it can fail:** assert `row()`'s return carries `triggered` for a gotchas file, and
that a file with 10 entries and 2 triggers renders differently from one with 10 entries and
10 triggers. Today both render identically.

**Related but separate:** `doctor`'s `86 live gotcha(s)` is **cwd-scoped**, not tree-wide —
`lib/report/doctor/registers.mjs` deliberately uses `sourcesFor(process.cwd())`, i.e. "what
would fire HERE" (propagate's 69 + hub workspace 2 + global 15 = 86). The tree-wide figure
is **426 live**. Both are legitimate answers to different questions; the label does not say
which question it answered.

### N79 · `rules list` reports a RELEVANCE verdict from a scan of one file type, and calls the three most-cited rules in the tree `unexercised` — **S2** — **OPEN**

**MEASURED 2026-09-30, and it is worse than "one file type" suggests — but the obvious fix is wrong.**

Ran all 30 fingerprints over every markdown file in the tree (4,105 files, node walk not grep — the
ugrep shim's `--ignore-files` has produced a confident zero twice):

```
532 (rule, file) hits across the tree
 20   4%  CLAUDE.md  <- all rules check can see
512  96%  invisible to it: STATE/DECISIONS/TODOS 82 · other RULE files 73 · docs 70
          · GOTCHAS 47 · plan docs 39 · ISSUES 17 · other 184
```

**And it falsified the premise the work was proposed on.** I had expected many of the 22 pre-existing
fingerprints to be effectively dead — self-quoting, unable to fire on real prose. **0 of 30 fire only
on their own body.** Every one fires on between 2 and 107 other files. So [[n35]]'s worry about
self-quotation is largely answered by measurement: the fingerprints work. The defect is the corpus.

**But widening the corpus naively would flood the output, and a 12-hit sample of the invisible 96%
says why.** Judged individually rather than counted — because "does the fingerprint fire" is a proxy
for "does this file restate the rule", which is [[n26]]'s error and now
`rule:measure-the-claim-not-a-proxy`:

| verdict | n | example |
|---|---|---|
| legitimate citation or project compliance | 6 | `NORTH_STAR.md:108` cites `rule:delegation-criteria` §2 and quotes it |
| **real finding** | 3 | `SSJK-mb/docs/DEPLOY.md:26` *"Doppler is the single source of truth"* — uncited |
| worktree duplicate | 1 | the same `propagation/INDEX.md` counted twice ([[n100]], [[n88]]) |
| false positive | 1 | `Rupali/Obsidian/Calendar/2026/September/19-09-2026.md` — a daily journal note |

So roughly a quarter of the invisible hits are actionable, and the rest are noise of three distinct
kinds. **The fix is a considered corpus, not more files:** decide which file KINDS carry a
restatement worth converting. `docs/` and `GOTCHAS.md` plainly do — one of the three real findings is
in each. A personal calendar note plainly does not. A worktree copy is the same file twice.

**One result worth keeping as validation of the authoring method.** `measure-the-claim-not-a-proxy`,
written hours earlier against a held-out corpus, fired on
`Rupali/Experiments/HandReader/DESIGN.md:1470` — *"The pipeline work was right; it answered a
different question."* Someone else's words, in a design doc, predating the rule. That is the property
a self-quoting fingerprint does not have, demonstrated on prose nobody wrote for the test.

Found 2026-09-17 while answering "how do we keep the hub and the workspaces relevant to
each other". The answer had to start by admitting the instrument that reports hub
relevance is measuring the wrong population.

**What it prints.** `rules list` gives every rule a `status` and closes with
`5 rule(s) unexercised`, explained as *"fingerprint matched nothing and nothing references
them."*

**What is actually true.** `rules check` — which `rules list` derives that column from —
scans files literally named `CLAUDE.md`, 53 of them. Citations counted tree-wide instead
(`node` walk over `.md`/`.mjs`/`.yml`/`.sh`/`.json`, excluding `rules/` itself):

| rule | files citing it | of which `CLAUDE.md` | `rules list` says |
|---|---|---|---|
| `discernment-checks` | **256** | 2 | adopted |
| `state-and-decisions` | 118 | 10 | firing |
| `safety-flag-needs-a-test` | **77** | **0** | **unexercised** |
| `enforcement-watches-itself` | **68** | **0** | **unexercised** |
| `adversarial-review-reads-the-ledger` | **55** | **0** | **unexercised** |
| `model-routing` | 12 | 0 | firing |
| `browser-only-when-asked` | 2 | **0** | **unexercised** |
| `no-waiting-on-deploys` | **0** | 0 | **unexercised** |

**Six rules have zero `CLAUDE.md` footprint and 215 citations between them.** Exactly ONE
of the five reported unexercised is genuinely unused, and the report cannot tell it apart
from the three most-cited rules in the tree. For `safety-flag-needs-a-test` the 77 break
down as **32 code files**, 12 `DECISIONS.md`, 5 `GOTCHAS.md`, 3 plans, 2 `ISSUES.md` — it
is cited in source comments and tests, which is the most load-bearing place a rule can be
cited and the one place this scan will never look.

**The irony is load-bearing, not decorative.** `docs/LIFECYCLE.md` names
`rules/safety-flag-needs-a-test.md` as *"a mechanism produced by PROMOTE"* — the one
worked example of the promotion path succeeding. The tool reports that success as
unexercised.

**The scan is not the defect.** `CLAUDE.md` is the right corpus for the question
`rules check` exists to answer: which instruction files RESTATE a rule instead of citing
it, because that is where divergence causes harm (measured 2026-08-14: 9 inline copies of
tool-priority making 4 mutually exclusive claims). The defect is that `rules list`
overloads that one narrow scan into a **relevance verdict**, and then states it in words
the scan cannot support. `nothing references them` is a claim about the whole tree made
from a sample of one filename.

**Two candidate fixes; they are not equivalent and this issue does not choose.**

1. **Widen the scan corpus.** Tempting and probably wrong. Restatement in a `DECISIONS.md`
   or a code comment is not the same failure as restatement in a `CLAUDE.md` — the latter
   is an instruction another agent will follow. Widening would also flood
   `referencedRestatements`, and N35 already records the cost of a fingerprint wide enough
   to flag 8 files to find 1.
2. **Keep the scan, fix the vocabulary.** `unexercised` becomes something that says what
   was measured — `no CLAUDE.md footprint` — and the summary sentence stops asserting
   "nothing references them", because it does not know that. Optionally print the tree-wide
   citation count beside it as a separate, separately-derived number.

**Recommended: the second.** It is honest, it is cheap, and it does not change what
`rules check` means. `rule:discernment-checks` §2 — absence must be attributable, and
"no hits in the corpus I scanned" and "nothing references this" are different facts.

**Test it can fail:** assert that a rule cited in a non-`CLAUDE.md` file and in no
`CLAUDE.md` is NOT reported with wording that claims nothing references it.
`safety-flag-needs-a-test` is the live fixture — 77 files, 0 of them `CLAUDE.md`.

**Derive the numbers, never trust the ones above** (`rule:state-and-decisions`): a `node`
walk counting `rule:<id>` per file, split by whether the basename is `CLAUDE.md`. Do NOT
use `grep` — the ugrep shim honours the hub's `/*` `.gitignore` and returns false zeros;
that flaw has now fired four times in this tree.

### N78 · A code-only merge is undeliverable — both delivery mechanisms gate on VERSION, and only `doctor` reads content — **S2** — **RESOLVED 2026-09-24**

Found 2026-09-17, one minute after merging #21, by the `# Delivery` section that #19
added for exactly this.

**The measurement.** #21 merged four commits changing `cli.mjs`, `lib/rules/rules-check.mjs`
and a skill doc. It did not bump VERSION, because it was a fix, not a release. On a
clean tree immediately after:

```
$ claude plugin update propagate@tathya
✔ propagate is already at the latest version (0.6.1).

$ node cli.mjs doctor      # Delivery
! version 0.6.1 matches but cli.mjs differs (served 52f4553a0cf2, source bdaf944fb0bd)
```

The update command **succeeded and shipped nothing.** Three commits of merged code
stayed unserved, and the only reason anyone knew is that one check reads file content.

**Both delivery paths share the same gate, and it is not code identity:**

| mechanism | fires when |
|---|---|
| `.githooks/post-merge` | `git diff-tree ORIG_HEAD HEAD` names `VERSION` |
| `claude plugin update` | the served version STRING differs from source |

So a merge that changes code without touching VERSION is invisible to both. The hook
does not run; the update no-ops. **Neither mechanism can observe that the code moved.**

**This is not the 2026-09-16 incident repeating — it is its mirror.** That one was a
bump nobody followed with an update (four PRs, plugin stuck at 0.5.0 for two days).
This one is an update that *cannot* work without a bump. Same hole, approached from
the other side, which is why fixing the first did not prevent the second: the fix
added a trigger on VERSION-change and a detector on content, and left the gap between
them open.

**`# Delivery` is doing its job and cannot close this.** It reads the served `cli.mjs`
hash against source, so it caught the `incoherent` state — version agrees, content does
not — within a minute. It is a detector, not a delivery path. `rule:enforcement-watches-itself`
in its useful direction for once: the check that watches delivery correctly reported
that delivery had not happened.

**Worked around today by bumping to 0.6.2** (`28e655a`), which delivered and was verified
by hash, not by version string: `source=bdaf944fb0bd served=bdaf944fb0bd`.

**The decision this needs.** Bumping VERSION on every code merge is one answer and it is
not obviously the right one — it makes the version number a commit counter and pushes the
problem onto whoever forgets. Alternatives worth weighing before building anything:

- Make `post-merge` fire on **any change under the served tree**, not just VERSION, and
  let it re-copy when the hashes differ. Moves the gate from version to content, which is
  what `# Delivery` already proves is the correct predicate.
- Have `doctor`'s `incoherent` row print the exact remediation for this case — today it
  says "either uncommitted edits (normal while developing) or an update half-applied",
  and on a CLEAN tree after a merge it is neither. The wording sent me to `git status`,
  which was clean, which is the least informative answer available.
- Accept the bump discipline and enforce it: a CI check that fails a PR touching
  `cli.mjs`/`lib/**` without a VERSION change.

**Test it can fail:** merge a commit that changes `cli.mjs` and not `VERSION`, then assert
the served `cli.mjs` hash equals source. Today that assertion fails and nothing runs it.

**Related:** the cache now holds 3 trees (0.5.0, 0.6.1, 0.6.2). Doctor says persistent
duplicates mean one was never cleaned up; 0.5.0 has been there since the original
incident. Not urgent, not deleted here — removing directories from someone's plugin cache
is their call.

**Decided.** Both delivery mechanisms (`.githooks/post-merge`'s `VERSION`-diff trigger and
`claude plugin update`'s version-string comparison) key on the VERSION string, and neither
can observe that code moved without it. The fix, settled by the plugin-delivery review
(`docs-plans-2026-09-23-reminders-todo-bri-playful-dawn.md`, decisions D3-D8/D12):

- **State-branched remediation text** (D3) — `doctor`'s `# Delivery` section now branches by
  verdict state instead of pointing at `git status`, which is clean in exactly the state that
  misled this entry's own author. `stale` keeps `claude plugin update <plugin>@<mkt>`;
  `incoherent` names both verified paths (bump `VERSION` for a release, or
  `claude plugin marketplace update` + uninstall/install otherwise).
- **A digest over the shipped file set, read from committed content** (D4, D6) — replaces the
  single `cli.mjs` hash with `treeDigest` over all shipped paths, sourced from `git ls-tree -r
  HEAD` / `git hash-object --stdin-paths` rather than the working tree, so an in-progress edit
  can't move the verdict and a `missing` file fails at any distance.
- **Shipped-path-only commit/day bounds** (D5) — `deliveryLag` counts only commits touching the
  shipped pathspec, so doc-only and test-only churn (this repo's 2026-08-27 decision explicitly
  allows both without a version bump) never reddens the gate.
- **A CI bump-gate on shipped paths** (D7) — a job in `.github/workflows/test.yml` fails a PR
  that touches the shipped pathspec without changing `VERSION`; `post-merge`'s existing trigger
  then delivers automatically. The pathspec is exported once from `delivery.mjs` and CI derives
  it rather than restating it (D12), so the two cannot drift the way `.githooks/post-merge`'s
  own hardcoded completeness list already had (see N78's sibling gap, resolved by widening that
  list rather than sharing a definition — D8).

**Of N78's own three candidate remedies, two were taken and one was not.** Taken: "have
`doctor`'s `incoherent` row print the exact remediation" (the state-branched text above) and
"accept the bump discipline and enforce it" (the CI bump-gate above). **Not taken:** "make
`post-merge` fire on any change under the served tree … and let it re-copy when the hashes
differ." Rejected at D7 in favor of the CI bump-gate because it would silently mutate the
installed plugin on every qualifying merge, from a hook whose exit code git already discards —
so a failed re-install would be visible only to someone reading scrollback, which is the same
silent-failure shape this whole register exists to catch.

**Deferred, not built:** sharing one completeness definition between `post-merge`'s file list
and `delivery.mjs`'s digest (D8 — widened the hardcoded list instead) and the fifth
version-manifest location, `skills-marketplace/.claude-plugin/marketplace.json` (D1). Both
filed as TODOs.

### N87 · `doctor` reports healthy because its population excludes the failures, its checks test properties a broken thing satisfies, and 354 warnings bury the one that fires — **S1** — **RESOLVED 2026-09-25**

**RESOLVED 2026-09-25 — and it had been resolved in code for a day without this line saying so.**
All three mechanisms this entry names now have a landed slice AND a test that pins it:

| mechanism | slice | landed | pinned by |
|---|---|---|---|
| the population excluded the failures | 1 | `b164a9f` | `tests/cli/doctor-census-parity.test.mjs` |
| checks tested properties a broken thing satisfies | 2a, 2c | `4063bb0`, `c1acb2b` | `tests/unit/doctor-reporter.test.mjs` |
| severity declared per section, so one signal is findable | 2b | `de53a45` | `tests/unit/doctor-severity.test.mjs` |
| 354 warnings buried the one that fires | 3 | `a7548a1` | `tests/unit/doctor-warn-labels.test.mjs` |

`lib/report/doctor/reporter.mjs:46-124` carries the new fourth entry kind: `inconclusive` is in
`ENTRY_KINDS`, its `reason` is mandatory and **throws** when empty, and it increments `problems` —
so a check that could not run stops reporting success. Seven section modules declare `severity`.

**Why the delay is worth recording rather than quietly fixing.** This entry is *about* a register
reporting a state that is not real, and for a day it was one: slices landed 2026-09-23/24 and this
line read `OPEN` on 2026-09-25, while the file was edited that same morning for an unrelated entry.
Anything consulting it to answer "is N87 done" would have been told no. That is the same defect one
level up, and it is the reason `rule:enforcement-watches-itself` exists.

Found while scoping PR-007, which is filed as sequenced behind slice 2 and is the first real consumer
of `inconclusive` — a TCC denial is "could not look", which is neither pass nor fail. Nearly reported
as still open: a first pass grepping `severity` under `lib/report/doctor/` returned **zero** hits
through the ugrep shim (G-A); `/usr/bin/grep` found seven files.

**Step 4 of the original fix order — "only then add checks for other defects" — is deliberately not
claimed here.** It was never part of closing these three mechanisms, and N87 measured 6 of 8 real
findings that week having no corresponding check. That remains open work, separate from this entry.

Filed 2026-09-17 in answer to a direct question: *"how are we running a system with this
many defects, and doctor doesn't report it?"* Eight issues were filed in two days (N79-N86).
`doctor` reports **1 problem**. This entry is why, and it is three independent mechanisms,
each individually sufficient.

---

**1 · THE POPULATION EXCLUDES THE FAILURES.**

`doctor` prints `✓ workspaces conform to the v3 propagation layout — 16/16 conform`.
`rollup` writes `NON-CONFORMANT` for **2** workspaces into `ECOSYSTEM.md`. Both are in this
repo. They disagree because they enumerate different sets:

```
in rollup, MISSING from doctor:   Motion-Graphics, propagate
in doctor, missing from rollup:   calibration-sampler-52226, ubersicht-widget-52226
```

**The two workspaces doctor omits are exactly the two that fail.** `16/16` is not "checked
sixteen and all passed"; it is "enumerated sixteen, and the failures were not among them".
Doctor also counts two *worktree checkouts* as workspaces, inflating the denominator with
copies of trees already counted.

**`propagate` excluding itself is `rule:enforcement-watches-itself` at the population
level** — not a check that fails to cover its own toolchain, but a census that does not
list the repo it runs in. The rule's own worked examples include *"a drift gate installed
in seven repos and not in the one that authored it"*. This is that, one layer up.

---

**2 · THE CHECKS TEST PROPERTIES A BROKEN THING STILL SATISFIES.**

```
✓ ledger JSONL parseable   0 rows, 0 open
```

Every one of the 17 in-tree ledgers holds **0 rows** (N84). An empty file is trivially
parseable, so the check passes and prints the emptiness as though it were a result.
`rule:discernment-checks` §2: *found nothing* and *looked at nothing* must not render
alike — here they render as the same green tick, with the count right there in the detail
text and no threshold behind it.

Same shape in the conformance check itself (N82): it asserts `state/` **exists**, not that
it holds anything, so two empty directories pass.

---

**3 · 354 WARNINGS ACROSS 299 DISTINCT KINDS, AND ONE FAILURE.**

Counted from a live run: **515 assertion lines — 160 ✓, 354 warn, 1 ✗.** The warnings are
not a handful of repeated problems; they are **299 distinct kinds**, mostly per-branch rows.

No one reads a 515-line report where 69% of the lines are warnings. `gotchas-global.md`
states the principle for its own admission bar — *"otherwise this file becomes the noise
that hides the four that matter"* — and `doctor` is past that threshold by two orders of
magnitude. Even a correct new signal would not be seen.

---

**AND THE CHECK SURFACE IS SMALL.** Doctor has **14 distinct check classes**. Mapped
against the eight issues filed this week:

| finding | doctor check? |
|---|---|
| N79 relevance corpus | none |
| N80 trigger count dropped | none |
| N81 colocated specs | none |
| N82 conformance presence-only | **exists, passes** — tests presence |
| N83 CLAUDE.md currency 4/16 | none — undeclared is invisible |
| N84 ledgers empty | **exists, passes** — tests parseability |
| N85 104 noisy edges | none — counts `actionable`, never the no-op ratio |
| N86 forked gate | none — nothing compares duplicate implementations |

**6 of 8 have no corresponding check. Both that do, pass.** So the honest reading of a
green doctor is *"the fourteen things it checks, over the workspaces it enumerated, are as
expected"* — which is a much narrower claim than the one a green report implies.
`rule:adversarial-review-reads-the-ledger`'s corollary already says this about the family:
*"status, check and doctor answer 'is anything declared drifting' — never 'is anything
undeclared wrong'."* N87 is the measured version of that sentence.

---

**S1, and the severity is about trust, not any one defect.** Every issue above is
individually survivable. What is not survivable is a health command that returns green
while the tree holds a forked contract gate, 17 empty ledgers, and 104 majority-no-op
edges — because the green is what stops anyone looking. A check that cannot fail is worse
than no check (`rule:discernment-checks` §1); a *suite* that cannot fail is the same thing
with a reassuring summary line.

**Fix order matters and is not "add eight checks".**

1. **Reconcile the two populations first.** Until `doctor` and `rollup` enumerate the same
   workspaces, every count either produces is unfalsifiable. This is the cheapest fix and
   it flips `16/16` to something honest by itself.
2. **Make the existing checks assert the thing they are named for** — non-empty, not
   parseable; contents, not presence. Expect green to go red; that is the check starting
   to work.
3. **Cut the warning channel down** before adding any new signal, or the new signal joins
   299 others. A warning nobody reads is not a warning.
4. **Only then** consider checks for N85/N86-class defects.

**Test it can fail:** assert `doctor`'s workspace set equals `rollup`'s. Today they differ
by four entries in both directions. And assert `ledger JSONL parseable` does not report ✓
for a file with 0 rows.

**Derive all of it:** `node cli.mjs doctor` and `node cli.mjs rollup --check`, then diff
the `# Workspace:` headings against `ECOSYSTEM.md`'s `### ` headings. Do not trust the
numbers in this entry — they are a snapshot of a report that changes daily.

### N86 · The DECISIONS.md gate is a CONTRACT living in two client workspaces, forked, with cutoff dates five weeks apart — **S2** — **OPEN**

Found 2026-09-17 by the adversarial review of the hub↔workspace diagnosis, which had
missed it. It is the cleanest instance of that diagnosis's own thesis, and it was invisible
to the diagnosis because the diagnosis read files while this is a property of the **edges**.
`rule:adversarial-review-reads-the-ledger`, doing exactly what it claims to do.

**The measurement.** Two copies on disk, both inside client workspaces, none at the hub:

| fork | bytes | lines | cutoff date | control flow |
|---|---|---|---|---|
| `Vipin Kaushik/scripts/decisions-check.sh` | 7235 | 180 | **2026-06-09** | differs |
| `PanditPawanKaushik/scripts/decisions-check.sh` | 3856 | 107 | **2026-07-16** | differs |

Different sizes, different hashes, different control flow, and **enforcement cutoffs five
weeks apart** — so a `DECISIONS.md` entry that passes under one fork may fail under the
other, depending purely on which workspace's copy a reader happens to invoke.

**Who depends on it: 54 files across 6 workspaces** — PanditPawanKaushik (12),
`Vipin Kaushik` (26), Rupali (6), Tushar (3), **propagate (6)**, and **`rules/` (1)**.

**`propagate`'s own `DECISIONS.md` header names the PanditPawanKaushik copy explicitly:**

> `**Affects:**` is machine-read — it drives cross-repo relay rows and is enforced as a
> pre-commit gate by `PanditPawanKaushik/scripts/decisions-check.sh`.

So the tool that defines the propagation standard has its own decision-record format
enforced by a script owned by a client workspace, in the shorter of two divergent forks.

**Why this is the thesis and not just duplication.** The hub owns contracts; workspaces own
instances. A *format gate* is a contract by definition — it decides what a valid entry is,
for six workspaces. It lives in two instances. `rule:state-and-decisions` already records
this exact shape one level over: *"two carried a `scripts/hygiene/` stack forked between
them — 5 of 8 shared libs diverged. Every divergence was individually reasonable. Together
they meant no check could be written once."*

**What makes it S2 rather than S3.** A forked linter is an annoyance. A forked **gate**
with different cutoff dates means the tree has **two different definitions of a valid
DECISIONS.md entry** and no way to tell which one any given file was validated against.
That is not drift between a doc and its code — it is drift between two enforcers, which no
declared edge in the tree currently watches.

**Not proposing the fix here.** Moving it to the hub is the obvious move and is not free:
54 citations across six workspaces would need repointing, and the two forks must first be
reconciled — which requires deciding whose cutoff is right, a judgement, not a merge.
Note also that a hub-owned gate does not automatically get invoked; `rule:enforcement-watches-itself`
records a drift gate installed in seven repos and not in the one that authored it.

**Test it can fail:** hash every `decisions-check.sh` in the tree and assert there is at
most one distinct implementation. Today there are two.

**Derive it, do not trust the table:**
`find ~/Documents/GitHub -name decisions-check.sh -not -path '*/node_modules/*'` then
`md5` each. Not `grep` — the ugrep shim honours the hub's `/*` `.gitignore` and this
script lives inside workspaces it would skip.

### N85 · 83% of edges with ENOUGH history to have a ratio are majority `no-change-needed` — N77 is not an outlier — **S2** — **OPEN**

Measured 2026-09-17 by parsing all 2844 events over 1564 distinct edge ids, to answer
whether N77 was one bad edge. **It is not.** This supersedes N77's framing while leaving
N77's own diagnosis intact.

**The number.** Of the **125 edges with ≥4 recorded dispositions**, **104 (83%)** are
≥50% `no-change-needed`. They span **46 distinct source files across 14 workspaces**.
**31 edges are at 100%** — every judgement ever made on them was "nothing needed to
happen". The worst cluster is a single source, `Vipin Kaushik:docs/measurement/MEASUREMENT.md`,
carrying **12** noisy edges.

N77's own edge sits at 70%, which puts it **mid-table**, not at the extreme.

**MIND THE DENOMINATOR — corrected 2026-09-17 on adversarial review.** This entry's first
title read *"83% of edges with any history"*, which is false and is the exact
`rule:discernment-checks` §5 error the entry is about. **1564** edges have at least one
disposition; only **125** have ≥4, which is the minimum to have a meaningful ratio at all.
The 83% is of those 125. As a share of every edge with any history, the noisy set is
**6.6%**. Both numbers are real and they answer different questions: *"among edges we have
judged repeatedly, how often was the answer no?"* (83%) versus *"how much of the graph is
noisy?"* (6.6%). The first is the one that matters for reviewer attention; say which one
you mean.

**THE HYPOTHESIS IN N77 IS REFUTED, and the strong evidence is the same-source spread —
not the aggregate.** N77 said the cause was a high-churn source.

**The disproof, which holds churn constant by construction.** One file, six declared edges:

```
sanskrit-texts:docs/INVENTORY.md   (49 commits/60d)
  e82c6e94  0.75      a9d43537  0.63      e377000b  0.18
  fa432c23  0.75      91daecfb  0.10
  2cb348a4  0.75
texts:docs/INVENTORY.md            0.78, 0.78, 0.33
```

Same source, same commit history, **a 7.5× spread in noise ratio across its own
downstreams.** Source churn cannot explain a variable it is constant across. Whatever
drives the ratio is on the downstream side.

**The aggregate comparison points the same way and is much weaker evidence — stated
second on purpose.** Noisy-edge sources average **7.3** commits/60d against **12.7** for
non-noisy ones, i.e. noisy sources churn *less*. But the non-noisy group is only **15**
sources, and both groups are defined by the very outcome under test, so this is
suggestive, not probative. **Do not cite the means without the same-source spread** — an
earlier draft of this entry led with them, which is the shape of an argument that looks
statistical and is not.

**So the predictor is not how often the source changes. It is WHICH SLICE of the source
the downstream actually depends on.** A downstream that tracks a *stable derived fact* —
a pointer line, a count, a format grammar, a canon list — gets a re-check on every
unrelated edit to the file that happens to contain it. That is N77's real mechanism,
stated correctly and generalised: **granularity mismatch between the declaration and the
dependency**, of which "header inside an append-only file" is one special case.

**Six causes, classified with evidence:**

| cause | example | why it is noisy |
|---|---|---|
| stable pointer inside a hub file | 7 clusters → `CLAUDE.md`, 24 edges | the edge asserts a one-line pointer stays consistent; most edits don't touch it |
| stable slice of a churning catalog | `INVENTORY.md` → canon tracker | new texts change the catalog, not the canon list |
| shared constant | `Makefile`/`go.work` → `CLAUDE.md` | doc restates a *count* (14 targets); targets change, count rarely |
| aggregate restated in a rule | `mongo.yml` → `secrets-source-of-truth.md` | rule repeats one four-project figure |
| glob broadcast | `gotchas-global.md` → `*/docs/GOTCHAS.md` | one rule edit, N per-project obligations, few real changes |
| **stale declaration (new)** | `Motherboard:docs/{HISTORY,GOTCHAS}.md` | source migrated to `propagation/state/workspace/` in the v3 layout move; the old edge_id's history remains and **can never close** |

**Repeated reasons are widespread, not a tell of one edge.** 51 of 125 edges (41%) carry
at least one pair of dispositions whose reason text shares ≥50% of its wording — 46 of
those 51 are in the noisy set. One 2026-08-19 batch wrote near-identical reasoning across
**15+ unrelated edges within hours**. N77 spotted this on one edge and read it as
significant; it is the house style of a bulk disposition pass.

**Why this is S2 while N77 is S3.** A single noisy edge wastes a little attention. A
ledger where 83% of judged edges are majority-no-op **trains the reader to answer "no"
without looking**, and the eighth time is the one where the header actually moved. It also
makes `actionable` a poor priority signal, which is the number the monitor reports.

**What this does NOT say.** It does not say those 104 edges are wrong to exist — most
assert a real coupling. It says the declaration is coarser than the dependency. And the
fix is NOT the region-scoped edge rejected in N77 finding 4: that was rejected on
architecture (git-blob whole-file identity), and 104 edges does not change that argument,
it raises the stakes on finding a different answer.

**Candidate directions, none chosen:**

- **Declare the derived fact, not the file.** Where a downstream depends on a count or a
  pointer, the honest source is often a smaller generated artifact, not the big doc.
- **Let a disposition express "and expect this again".** A `no-change-needed` that records
  *why re-firing is expected* could suppress the next N identical prompts without hiding
  a real change — closer to a calibration than a silence.
- **Reap stale declarations.** The orphaned `Motherboard:docs/*` edges can never close and
  should be retired outright; that is pure noise with no coupling behind it.

**Test it can fail:** recompute the ratio table; assert no edge with ≥4 dispositions is
≥90% `no-change-needed` without a recorded justification for why re-firing is expected.
31 edges are at 100% today.

**Derive, never trust the table above:** parse `~/.propagate/events/*.jsonl` with `node`
(never `grep -c` — it counts lines, and a disposition word inside reason prose is not an
event; that exact error produced N77's wrong denominator). Exclude
`events/archive/` — it is frozen v1 history, not a worklist.

### N77 · A `kind: code` edge fires on the whole file while coupling only a HEADER — 7 of 10 dispositions on one edge are `no-change-needed` — **S3** — **OPEN**

Found 2026-09-16 while disposing `HANDOVERS.md -> propagate/lib/report/handovers.mjs`
(`4e8d1c1c`) after the N76 work.

**The measurement — CORRECTED 2026-09-17.** Every disposition ever recorded against that
edge, counted by parsing the event store rather than by grepping `why --all`:

| disposition | count |
|---|---|
| `no-change-needed` | **7** |
| `baselined` | 1 |
| `propagated` | 1 |
| `source-corrected` | 1 |
| **total** | **10** |

**70% of the judgements on this edge are "nothing needed to happen", and the last three in
a row are.**

> **The original filing said "7 of 12" and the denominator was wrong.** It came from
> `why 4e8d1c1c --all | grep -oE '<disposition names>' | sort | uniq -c`, which counts
> every occurrence of a disposition WORD in the rendered output — including words appearing
> inside the reason prose — not events. The real count is 10.
> `rule:discernment-checks` §4: when a number is surprising, suspect the ruler. The ratio
> got *worse* under re-measurement (58% → 70%), so the finding stands; the arithmetic
> behind it did not. Two of those three carry near-identical hand-written reasons,
independently arrived at weeks apart — 2026-09-10 said *"This edge governs the HEADER
… None of that was touched"*, and today's said the same thing after re-deriving it
from scratch.

**Why.** The sidecar declares the source as `HANDOVERS.md` — the whole file — while
the `why:` it carries scopes the coupling precisely:

> HANDOVERS.md's header is the prose spec of the close protocol this module parses.
> Changing the marker spelling, the placement rule or MARKER_WINDOW here must be
> reflected in the header, and vice versa.

`HANDOVERS.md` is append-only by design: its own header says *"add dated sections,
never edit past ones"*. So the file changes often and the header almost never does.
The edge fires on every entry append and the answer is nearly always the same.

**This is the shape `rule:delegation-criteria` §2 names** — the 60-second watcher that
ran 4,420 times and found nothing in 4,384 of them. Same defect one level up: not a
component polling too often, but a *declaration* whose granularity does not match the
coupling it asserts, so a human is asked to judge something that could not have
changed. Manufacturing dispositions is the opposite of what the ledger is for, and it
erodes the signal: an edge whose answer is "no" seven times trains the reader to
answer "no" the eighth time without looking — which is the time the header moves.

**ESTABLISHED 2026-09-17 — region scoping does not exist, and it is not cheap.** The
previous version of this issue left this open and said so; here is the answer.

**1 · The edge schema admits exactly four keys.** `propagates.schema.json`:
`path`, `why`, `kind`, `authority` — with `additionalProperties: false` at all three
levels (root, source object, edge object). There is no anchor, heading or line-range
selector, and an undeclared key is rejected rather than ignored.

**2 · Section anchors exist in the schema and nothing resolves them.** `concepts:` —
a sibling of `propagates_to` — is documented as *"per-section concept tags … Keys are
section anchors"*, and it is live: `lib/claims/check.mjs` reads it, 5 of 43 sidecars
declare it. But `findDeadConceptTokens` **never locates the section**. It lowercases
the WHOLE source file and substring-matches each token against all of it; the `section`
key is carried into the finding as a reporting label only. So the vocabulary for
addressing a region is present and the machinery is not.

**3 · Content identity is whole-file by construction, and that is the expensive part.**
`contentId(absPath)` hashes a file, and `batchTrackedBlobs` / `batchRefBlobs` take
identity from **git blob hashes**, batched through one `git ls-tree` per repo. A slice
of a file has no git blob hash. Scoping an edge to a region therefore means writing an
anchor resolver AND dropping those edges off the batch fast path the whole module is
built around — hashing a computed range per edge, per run.

**So the three options, now costed:**

| option | cost | effect |
|---|---|---|
| Scope the edge to the header | New anchor resolver + those edges leave the git-blob fast path | Correct, and the most machinery |
| Keep paying the tax, documented | One sidecar comment | Noise continues; the 8th disposition still gets derived from scratch |
| **Move the close-protocol spec out of the churning file** | ~31 lines relocated | **Makes the existing whole-file edge correct rather than working around it** |

**Recommended: the third.** `HANDOVERS.md` is 2374 lines, of which the header —
`## Two markers, and the difference matters` plus the preamble — is about 31. That
section is the entire coupled surface. Move it to a file that does not receive dated
appends, point the edge at that file, and leave `HANDOVERS.md`'s header as a pointer to
it. The edge then fires when the protocol changes, which is what it was declared to
watch, and stops firing on entries, which it was never about.

It also needs no new propagate machinery, which matters: the alternative buys precision
by making the tool's fastest path slower for everyone, to fix one edge's granularity.

**Do not just delete the edge.** It was declared 2026-08-26 *"after the two ends
disagreed for as long as both existed and nothing could see it"*, and one of its 12
dispositions is a real `propagated` and one a real `source-corrected` — so it has
caught genuine drift twice. The defect is the noise ratio, not the coupling.

**Test it can fail:** append a dated entry to `HANDOVERS.md` that touches no header
line, and assert the edge does NOT enter an actionable state. Today that assertion
fails, which is the issue.

**SUPERSEDED IN SCOPE 2026-09-17 — see N85.** A full census of the event store found
**104 edges (83% of all with ≥4 dispositions)** are majority `no-change-needed`, and
**refuted this entry's stated cause**: noisy sources churn LESS than non-noisy ones
(mean 7.3 vs 12.7 commits/60d). The real predictor is which SLICE of the source the
downstream depends on, not how often the source changes. This edge's diagnosis
(header vs whole file) is correct and is one special case of that. Read N85 first.

**GENERALISED 2026-09-17 — see N81.** A census found **five more files** with the same
shape: a machine-parsed grammar colocated with append-only churn. The important
difference is that **none of the five has a declared `kind: code` edge on its header**, so
none is costing review cycles yet — this edge is the only live instance. Four of the five
restate the `**Trigger:**`/`**Fires on:**` grammar that is already canonical in
`rule:every-project-carries-gotchas`, so their fix is a deletion and a citation, not a
relocation.

### N76 · The rule fingerprints are self-quotations, so `rules check` detects COPY-PASTE, not restatement — **S2** — **RESOLVED 2026-09-16**

Found 2026-09-16 while investigating whether Phase 2b was worth building. It is the
structural reason N35 has stayed open, and it is larger than N35.

**The measurement.** Take a rule, write its substance in your own words the way
another author's `CLAUDE.md` would, and test the live fingerprint against it.
Across 12 rules, with two independent sets of samples (a subagent's, then the
reviewer's own, written without seeing the first), **11 of 12 do not fire.**

The one that fires is `tool-priority`, and it fires for a reason that proves the
point rather than contradicting it: its fingerprint contains `code-review-graph` —
a **proper noun**. Nobody paraphrases a vendor string, so the token survives
rewording. Its claim does not.

Look at what the fingerprints actually are:

```
safety-flag-needs-a-test   safety flag is a claim|unsafe path is unreachable|A flag that promises
no-waiting-on-deploys      waiting on a Vercel deploy|do not poll .vercel list.|push.{0,20}move on
model-routing              Opus plans|Sonnet executes|opus for plan|sonnet.{0,30}(execut|implement)
```

Every alternation is a phrase lifted verbatim from the rule's own body. **A detector
built from a document's own sentences can only find copies of that document.** It
cannot find a restatement, because a restatement is by definition the same claim in
different words.

**What this means for the numbers everyone has been reading.** `rules check` reports
`0 silent restatements`, and that zero is TRUE as a statement about fingerprint hits
— verified today, every hit in the tree is cited. But it has been read as "nobody is
restating rules uncited", and it does not support that reading. The honest statement
is: *nobody has copy-pasted a rule without citing it.* Whether anyone has restated
one in their own words is **unknown and currently unknowable**, which is exactly the
unknown-vs-clean collapse N35 names — now shown to apply to the detector itself, not
just to the unexercised rules.

It also explains the distribution nobody had explained: `tool-priority` carries 12
restatements while most rules carry 0 or 1. That is not because tool-priority is
restated twelve times more often. It is because it is the only rule whose fingerprint
keys on something that survives paraphrase.

**Do not "fix" this by widening fingerprints speculatively** — N35 already records
the opposite error costing 8 files flagged to find 1. The fix N35 itself prescribes
is a per-rule known-positive probe: for each of 18 rules, hand-construct a real-style
restatement and widen that one fingerprint until it fires on the sample and still
does not fire on ordinary prose. Eighteen units of bounded work, one rule at a time,
each independently verifiable — not a heuristic over 936 pairs.

**Test it can fail:** for any rule, assert its fingerprint fires on a hand-written
paraphrase held in a fixture beside the rule. `--selftest` today asserts only that a
fingerprint matches its own body, which is the tautology this issue is about.

---

**RESOLVED 2026-09-16 — all 18 rules probed, and the fix found what the defect was
hiding.**

`rules/_probes.yml` now carries, for every one of the 18 active rules, two
paraphrases that MUST fire and four near-misses that MUST NOT, and each fingerprint
was widened until all four gates pass: positives fire, negatives stay silent, the
rule's own body still matches, and any change in corpus hits was opened and read
rather than counted. `selftest` runs the probes and reports UNPROBED as its own
state — proven by removing one entry and confirming it renders `17 of 18 rules
probed, 1 UNPROBED` rather than a silent pass.

**The shape of the fix.** Every fingerprint is now `<self-quote>|<structural>`. The
first half keeps the selftest's own-body assertion honest; the second matches the
claim's shape in someone else's words. Splitting them is what stops a widening from
quietly breaking the thing it was meant to preserve.

**The mandatory negative earned its place immediately.** Every entry carries the line
`See rule:<id> before doing X.` — because a rule's hyphenated id contains its own key
words and hyphens are word boundaries, so a loose pattern matches its own citation and
scores a reference as a restatement. It fired during construction on
`enforcement-watches-itself`, whose id supplied `watches` to a structural alternation
containing `watch`. Caught before shipping, in the rule about checks that do not cover
themselves.

**What it found: 2 restatements where the tool previously reported 0.**

| Rule | File | Verdict |
|---|---|---|
| `skill-routing` | `Divyansh/AuroraV3/CLAUDE.md:70` | **Confirmed restatement.** The whole routing table, with `/` separators and `→ invoke /skill` arrows |
| `delegation-criteria` | `ManavDaehi/CLAUDE.md` | **Borderline — needs a human.** "v2 derives state from content on demand … do not add a watcher" is mostly compliance, but the imperative is scoped reasoning from the rule's §2 |

The AuroraV3 hit is the satisfying one: `rule:skill-routing`'s own body predicted this
exact class — *"misses the other 7, which say `Product ideas`, `Ideas / brainstorming`,
and similar"* — and could not see it. The widened fingerprint accepts either separator
and now does.

**A stale count in that rule fell out of the same work, and the instrument lied while
establishing it.** The rule claimed 11 files used the canonical wording. Re-measured:
**1** `CLAUDE.md` in the tree contains `Product ideas` at all, against **17** that cite
the rule — so 17 of the 2026-08-14 census of 18 were converted, and the survivor is a
workspace added *after* the consolidation. `grep` reported **0**, because it is the
ugrep shim honouring the hub's `/*` `.gitignore`; a `node` walk found 1. That is
`rule:discernment-checks` §4 firing for the third recorded time on the same shim. The
rule now names the derivation command instead of carrying the number.

**Two defects in the reporting path, both found by using the fix rather than by
reading it:**

- `selftest`'s renderer had no branch for probe checks, so all 108 fell through the
  fingerprint/override ternary and printed as `override true  undefined` — the newest
  half of the check was simultaneously invisible and wrong on screen, while the summary
  line claimed only that fingerprints fire.
- `checkRules` decides a file restates a rule by testing the WHOLE text, then locates it
  by testing each line. A paraphrase that wraps matches the file and no single line, so
  the report rendered `ManavDaehi/CLAUDE.md:` — a file:line reference pointing nowhere,
  on the first real finding the widened detectors ever produced. Prose wraps; that is the
  point of a structural fingerprint. Now reported as `spansLines`, with a test whose
  mutation gate was re-run after the first attempt proved invalid (the fixture used
  `name:` where `loadRules` requires `id:`, so the test was failing before the mutation
  and its going red proved nothing).

**Still open, deliberately:** N35 is NOT closed by this. `claims restate`'s corpus is
cited-and-restated pairs; the unexercised-rule set is uncited. Disjoint by construction,
as recorded on N35 itself. What this changes is that a rule reporting `restated 0` now
means something — the detector has been shown to fire on paraphrase — where before it
meant only that nobody copy-pasted.

### N88 · Discovery counts abandoned git worktrees as workspaces, and their warnings are indistinguishable from real ones — **S3** — **OPEN**

Found 2026-09-17 while building the widget's HEALTH rows, which is the point: the
defect was invisible in doctor's own output and obvious the moment the same data was
rendered as a list of workspaces.

`doctor` reports **16** workspace sections. Two of them are not workspaces:

```
Workspace: calibration-sampler-52226   → ~/Documents/GitHub/worktrees/calibration-sampler-52226
Workspace: ubersicht-widget-52226      → ~/Documents/GitHub/worktrees/ubersicht-widget-52226
```

Both are real git worktrees created 10 Sep on branches `spec/calibration-sampler-52226`
and `spec/ubersicht-widget-52226`, abandoned a week ago, and still carrying a `.git`
file that discovery treats exactly like a repository root.

**What it costs.** 14 of the 350 workspace warnings come from these two, and a reader
has no way to tell them from the other 336. The denominator is wrong in the same
direction everywhere it is used: "0 of 16 clean" is really 0 of 14, and any future
adoption ratio computed against 16 is quietly off by 14%. This is the
`rule:discernment-checks` §5 shape — the population is not what the claim is about.

**Why it is S3 rather than S2.** Nothing is lost and no write is affected; the count
is merely wrong. But it is the class of wrong that gets published, because 16 is a
plausible number and nothing about the output invites checking it.

**The fix is not "filter out `worktrees/`".** That path is a convention of one
machine's layout, not a property of a worktree. A worktree's `.git` is a FILE
containing `gitdir: …`, where a real repository's is a directory — so discovery can
tell them apart structurally, on any layout. Whether to then EXCLUDE them or label
them is a separate question worth asking: a long-lived worktree with its own
propagation state might legitimately want a section, and `scripts/worktree-new.sh`
makes them routinely.

Two abandoned worktrees are also their own small finding — `worktree-rm.sh` exists and
was not run.

### N89 · `fixOrder`'s within-layer sort orders by name, and it already disagrees with `STATE_SEVERITY` today — not only as a future risk — **S2** — **RESOLVED 2026-09-21 — STATE_SEVERITY moved to lib/graph/graph.mjs and fixOrder sorts by severityRank; graph-html.mjs now imports the one ranking instead of holding the only copy. Mutation-gated in tests/unit/queue-order.test.mjs.**

Filed from the follow-ups list in `~/.claude/plans/okay-to-make-propagation-resilient-rivest.md`,
which framed this as "DIVERGED / DRIFTED / REVERSED happen to sort the same way alphabetically
as by severity — a coincidence, not a design." Verified, and the claim is wrong in the
direction that matters: **they do not currently sort the same way.**

`fixOrder` (`lib/graph/graph.mjs:490`) breaks ties within a layer with
`a.state.localeCompare(b.state)`. The severity ranking lives 90 lines away in a different
file, `lib/graph/graph-html.mjs:40-47`:

```js
const STATE_SEVERITY = [
  "DIVERGED", "REVERSED", "DRIFTED", "UNMATCHED",
  "UNRESOLVABLE", "NOT_PRESENT_ON_REF", "NEVER_VERIFIED", "CLEAN",
];
```

The four states `fixOrder` actually emits are `ACTIONABLE` (`lib/graph/graph.mjs:56`):
`DRIFTED`, `REVERSED`, `DIVERGED`, `UNMATCHED`. Sorted alphabetically that is `DIVERGED,
DRIFTED, REVERSED, UNMATCHED` — verified with `Array.prototype.sort` directly, not by eye.
Sorted by `STATE_SEVERITY` (worst first) it is `DIVERGED, REVERSED, DRIFTED, UNMATCHED`.
**DRIFTED and REVERSED are swapped between the two orderings, right now, with no new state
needing to be added.** Alphabetical sort puts the less-severe DRIFTED ahead of the
more-severe REVERSED; the severity table says the opposite.

This is not hypothetical. `node cli.mjs graph --json` against this tree today
(2026-09-21) reports both states populated: `DRIFTED: 15, REVERSED: 22` in `stats.byState`
— plenty of live edges of each kind, so the misordering condition (both states present in
the same topological layer) is a real, not theoretical, possibility on every run.

**The signal.** The new UI's READY division (per the plan, Phase D) presents `fixOrder`'s
output as "the top row is always the next action" — a worklist a person is meant to work
strictly top-down. Nothing on screen indicates that within a layer the ordering is
alphabetical rather than severity-ranked; it reads exactly like a correctly-ordered list.
Per `rule:discernment-checks` §6, "no result" and "the wrong result" must be
distinguishable — here they are not: a REVERSED edge sorted below a DRIFTED one in the same
layer looks identical to a REVERSED edge that is genuinely lower priority.

**The cost.** Someone working the list in good faith, at every layer boundary where the two
co-occur, fixes the less-severe DRIFTED edge first and the more-severe REVERSED edge
second — the reverse of what the project's own severity table says should happen — for as
long as this goes unnoticed, which by construction it cannot be noticed from the UI alone.

**Severity — argued, not asserted.** This repo's own scale: S1 "silently wrong (you cannot
tell it happened)", S2 "noisy or misleading". A case can be made for S1 — a human trusting
"top of the list is next" has no way to detect the swap without independently deriving
`STATE_SEVERITY` order and comparing, which is exactly what a worklist exists to save
someone from doing. Filed at S2 because the underlying data (`state`, `edge_id`, `layer`)
is correct and inspectable — nothing is lost or misreported, only the presentation order —
and because the fix is small: import `STATE_SEVERITY` (or a copy of it) into `graph.mjs`
and sort on `STATE_SEVERITY.indexOf(a.state) - STATE_SEVERITY.indexOf(b.state)` instead of
`localeCompare`. Note `graph.mjs` does not currently import from `graph-html.mjs` (only the
reverse), so the array likely needs to move to `graph.mjs` and be imported by
`graph-html.mjs`, not the other way around, to avoid inverting that dependency.

### N90 · `duplicatePairs` has no disposition path — a finding the tool can name but never let a human close — **S3** — **OPEN**

Filed from the same follow-ups list. `lib/graph/graph.mjs:329-350` builds `duplicatePairs`
from the edge index — two declarations of the same `(from, to)` with different `why`
strings — and says plainly in its own comment: *"which of the two `why` strings is right is
a human's call."* It is reported through `status` (`cli.mjs:1222-1224`), the graph JSON
(`cli.mjs:4460`), and `doctor`'s summary count (`cli.mjs:4488-4490`), but nowhere does the
tool offer a verb to resolve one — no `verify --disposition`, no `drain --close`, nothing.

**Verified live count today: 0.** `node cli.mjs graph --json` reports `stats.duplicatePairs:
0` and an empty `duplicatePairs` array — so this is **latent, not active**, exactly as
flagged going in. Nothing is currently sitting unresolved.

**Why it is a real gap even at zero.** Every other actionable graph state (DIVERGED,
DRIFTED, REVERSED, UNMATCHED) flows through one lifecycle: `fixOrder` surfaces it, `verify
--disposition` records a decision, the event store closes it. A duplicate pair has no
state at all in that model — `fixOrder` never emits it, because it isn't an edge state, so
it cannot reach the new UI's READY worklist even in principle. The only way to make the
`doctor`/`status` count change is to find the sidecar declaring the second `(from, to)` pair
and hand-edit it out — with no record anywhere that doing so was a resolution to this
specific finding, as opposed to an unrelated edit that happened to remove a row.

**The signal, if it recurs.** The code comment cites a real historical instance, measured
2026-08-17: 711 edge records over 710 distinct pairs — one genuine duplicate. At that
count it would have sat in every subsequent `doctor`/`status` run as an unchanging "1
duplicate declaration(s)" line until someone stumbled on it by hand; there is no mechanism
by which the count would ever self-correct or by which a person could mark it seen-and-
accepted.

**Cost, stated honestly since it's zero today:** currently nothing, because nothing is
duplicated. If it recurs, the cost is a permanently-open, permanently-unactionable finding
sitting in every health check indefinitely — the same shape as this register's own `E2`
(declare-ahead warnings that never expire) and `C1` (nothing reports what is not declared):
a real finding with no closing mechanism eventually gets read as noise and stops being
checked at all.

**Fix direction, not built:** either fold a duplicate pair into `verify` as a pseudo-edge
state that a disposition can target (closest to the existing lifecycle), or give `drain`/
`doctor` a narrower "acknowledge duplicate — kept `<edge_id>`, discarded `<edge_id>`" verb
that edits the sidecar and records why. Not attempted here — this entry only establishes
that the gap is real and currently harmless.

### N91 · `doctor.duration_ms` spikes recur at 18-24 minutes, most recently in the last 24 hours — **S2** — **OPEN**

**CALIBRATED 2026-09-30 (PR-029): `doctor.duration_ms < 30 min` is asserted on every run**, which
makes this the first thing in the codebase that can fail on N91. Deliberately NOT the design's
p95 < 5s target — 95.8% of 1,092 runs exceed 5s, so asserting it would be permanently red and
therefore ignored. 30 min sits ~5x above p99 (367s) and below all four real outliers.

**RE-MEASURED 2026-09-30 with `doctor --since 7d` — the first thing that command was used for —
and the range is far wider than this heading says:**

```
doctor.duration_ms   92842 -> 105043   (+12201)   min 32940   max 11272497
                     uncalibrated - target is p95 < 5s (docs/OBSERVABILITY.md)
```

**Max 11,272,497 ms = 188 minutes**, across 207 runs in seven days — not 18-24. The median run is
also ~100s against a stated target of **5s**, so the ordinary case is 20x over and the worst 2,254x.
The heading's range came from a narrower window and should not be trusted as the bound.

Two things this changes. The entry is no longer "spikes recur" — the whole distribution sits far
above target, with occasional three-hour outliers. And it is the natural first item for PR-029 (six
metrics carry no expectation): `doctor.duration_ms` is the one where a target already exists in the
design doc and nothing asserts it.

Filed from the same follow-ups list, which flagged the metric's all-time max
(1,446,450 ms / 24m6s) as "unexplained." Re-measured against `~/.propagate/metrics.jsonl`
directly (841 rows, `metrics["doctor.duration_ms"]` is a dotted key nested one level under
`metrics`, not a top-level field — worth noting since a shallow read of the JSON looks like
the field doesn't exist). **The plan's numbers check out exactly:** max 1,446,450 ms at
`2026-09-17T15:23:32.496Z` (run `b2e7a71b…`), min 280 ms (`2026-08-13T19:44:32.487Z`).

**What the plan did not have yet: this is not a one-off, and it is not four days old.**
17 of 841 runs (2%) exceed 100 seconds, clustered in bursts rather than spread evenly:

| when | runs >100s | range |
|---|---|---|
| 2026-08-20, ~90 min window | 4 | 109,753 – 143,527 ms |
| 2026-09-01, ~2 hr window | 5 | 104,661 – 223,998 ms |
| 2026-08-29 / 2026-08-31 | 1 each | 114,801 / 219,535 ms |
| **2026-09-17T15:23** | 1 | **1,446,450 ms** (the plan's outlier) |
| 2026-09-20T09:23 | 1 | 109,601 ms |
| **2026-09-20T15:27** | 1 | **1,082,398 ms** (18m) |
| **2026-09-21T00:53** | 1 | **1,155,574 ms** (19.3m) |
| 2026-09-21T03:14 | 1 | 130,256 ms |

The three worst runs — 24.1m, 19.3m, 18.0m — are the three most recent minutes-long spikes
in the file, landing 2026-09-17, 2026-09-20, and **last night (2026-09-21, today)**. This is
a live, recurring hazard, not a historical curiosity from four days ago.

**A shared trait across the three worst runs:** all three post-date the workspace census
growing to 16-18 discovered workspaces / 43-44 loaded sidecars, roughly double the 7
workspaces / 21 sidecars in place when this metric was first captured (2026-08-13) — so the
absolute amount of per-workspace work `doctor` does today is larger than when the metric
baseline was established.

**A candidate mechanism, offered as a lead and not confirmed by reproduction.** `doctor`
still shells out to at least two external processes with no timeout:
`execSync("launchctl list", { encoding: "utf8" })` (`lib/report/doctor/environment.mjs:129`)
and, once per discovered workspace, `execFileSync("git", ["-C", ws.root, "remote"], ...)`
(`lib/report/doctor/workspaces.mjs:79`) — 18 calls on today's tree. This is the identical
shape this register's own **N16** found and fixed for a different call (`claude mcp list`,
measured at 17,793 ms / 94% of a run, bounded to a 2s timeout with a 1hr cache): *"an
unbounded subprocess inside a health check is a liveness risk... a hung binary would hang
`doctor` itself, indefinitely, with no distinguishing signal."* Neither of these two call
sites has that protection. Separately, **N50** measured this exact machine under concurrent
`node --test` load producing "load average: 33.6, mostly I/O wait" and real `git` calls
taking 27.4s where they normally take under 1s — the same failure mode (slow `git` under
load), recurring inside `doctor`'s unbounded call across an 18-workspace fan-out, would
produce spikes of exactly this shape and size. Per `rule:discernment-checks` §4, this is
correlation, not a confirmed cause — nobody has caught a spike live with a subprocess
timer attached.

**Cost.** `doctor` is the health check both a human and the new UI/widget lean on for "is
the system fine" (per STATE.md: "the 37s cache, on the monitor's existing tick"). An
18-24 minute run is long enough to exceed any reasonable caller's patience; invoked from
anything with its own timeout — a hook, a pre-push gate, CI — it would read as a failure
indistinguishable from a real one. It also means the widget's "last checked" data can be
stale by tens of minutes with no visible explanation, which is exactly the kind of silent
staleness `rule:discernment-checks` §2 says a check must never produce.

**Fix direction, not built:** bound both call sites the way N16 bounds `claude mcp list` —
an explicit `timeout` plus a distinct `status: "timeout"` outcome that is never read as a
pass — and instrument `doctor`'s own phases so the next spike names which subprocess it was
waiting on, rather than only a total.

### N92 · The plugin-file pathspec answers two different questions with one list, so a docs-only commit counts toward the release bound — **S3** — **OPEN**

Filed 2026-09-24 from the plugin-delivery work, immediately after landing it. `shippedPathspec()`
(`lib/report/doctor/delivery.mjs`) excludes exactly `tests/**`, `docs/**` and `propagation/**`, which
means every repo-root markdown file is inside the shipped set:

```sh
node --input-type=module -e 'import("./lib/report/doctor/delivery.mjs").then(m=>console.log(m.shippedPathspec()))'
git ls-files | grep -E '^[^/]+\.md$'      # DESIGN.md  README.md  SKILL.md
```

`SKILL.md` belongs there — it is the plugin's skill entry and a change to it genuinely changes what
the plugin does. `README.md` and `DESIGN.md` do not.

**Why that is a defect and not a quibble.** The same list is used for two different questions:

| question | consumer | is `README.md` a correct member? |
|---|---|---|
| what does the plugin SHIP, so a served copy can be compared? | `treeDigest`, and the `missing` set | **yes** — it is copied into the served tree, so its absence is a real difference |
| what counts as a RELEASE-worthy change, for the staleness bound? | `deliveryLag`'s `git rev-list … -- <pathspec>` | **no** — the 2026-08-27 decision is that a doc-only addition is not a release |

So eleven commits touching only `README.md` would push `commitsBehind` past `deliveryMaxCommits` and
fail `doctor`, for a reason the bound was explicitly designed to exclude. That is a false positive in
a gate, and `lib/report/doctor/delivery.mjs`'s own header names the consequence: *"A health check
that goes red during ordinary development trains people to ignore it."*

**S3 rather than S2 because reaching it takes a run of 11+ commits touching only those two files**,
which has not happened; the day this was filed the count was 37 and every contributing commit touched
real code. It is a latent false positive, not a live one.

**A hazard met while filing this, worth recording next to it.** This entry's own heading originally
read "The shipped pathspec …" and the backlog reader counted it CLOSED — because `shipped` is in
`CLOSING_WORDS` (`lib/docs/tokens.mjs`), and the incidental word beat the explicit `**OPEN**` marker
in the same heading. Measured after rewording: 0 of the 30 currently-`**OPEN**` headings carry a
closing word, so this is latent rather than live, but the word collides badly with the vocabulary of
a repo about shipping. Check a new heading with `hasClosingWord()` before filing, not after the count
looks wrong.

**Not fixed on filing, deliberately.** D12 of the delivery review made this ONE exported definition
precisely so CI and `doctor` could not disagree, and splitting it into "ships" and "release-worthy"
partly revisits that. Whoever takes this should decide whether the second question deserves its own
derived list (`shippedPathspec()` minus non-functional root docs) or whether the bound should simply
not count `.md` outside `SKILL.md`. Do not solve it by adding a second hand-maintained list — that is
N78's and [[PR-012]]'s shape.

### N93 · `docs/SYSTEMS.md`'s `gotcha-guard` probe cannot run, and its row makes three false claims about a component that is alive — **S2** — **OPEN**

Found 2026-09-24 while exploring for the plugin-delivery review. `docs/SYSTEMS.md:51` registers
`gotcha-guard` with an artifacts field naming `~/.claude/hooks/gotcha-guard.mjs` and a
`liveness_probe` of three commands it says are **all** needed. Measured:

| the row claims | actually |
|---|---|
| artifact `~/.claude/hooks/gotcha-guard.mjs` | **absent.** `~/.claude/hooks/` exists but holds only `obsidian-commit-log.py` and `stop-context-check.sh` |
| "registered in `~/.claude/settings.json`" | **not there.** No `gotcha-guard` string in that file; it is registered by the plugin's own `hooks/hooks.json` |
| probe 1 `node --test ~/.claude/hooks/` | **throws** a module-loader error — there is nothing there to test |
| probe 2 `node ~/.claude/hooks/gotcha-guard.mjs --selftest` | cannot run — that path does not exist |
| probe 3 `tail ~/.claude/gotcha-guard.log` | **works**, and shows the component is fine |

**The component is alive.** `~/.claude/gotcha-guard.log` is 4.5 MB and its last line the day this was
filed reads `2026-09-24T11:29:15.786Z tool=Bash sources=4 entries=34 bad=0 hits=0`. So this is not a
dead hook — it is a live hook whose registered way of proving it is alive is itself dead. An auditor
running the documented probe concludes the opposite of the truth.

**This is the twelfth referrer of the 2026-08-22 plugin cutover**, and [[N43]] is the eleven. The file
moved into the plugin that day, is served from
`~/.claude/plugins/cache/tathya/propagate/<version>/hooks/gotcha-guard.mjs`, and this row still names
the pre-cutover path. N43's own text says `docs/SYSTEMS.md` is *where a liveness probe per background
component is supposed to live*, and asks whether "these entries have no probe, or the probe has never
run." For this row the answer is now measured: the probe exists and has never run, because it cannot.

**The fix is not simply repointing the path.** G63 is explicit that a `--selftest` run from the source
repo proves nothing about production, because Claude Code serves a COPY — so the probe must target the
served tree, which is version-keyed and therefore not a fixed path. That makes this a real design
question rather than a typo: derive the served path (the delivery work added `activeInstallPath()` in
`lib/report/doctor/delivery.mjs`, which answers exactly this) or accept that the probe can only ever
check the log. `rule:enforcement-watches-itself` — the register built to make components verifiable
contains an unverifiable entry for the component its own text calls "the one most likely to become
decorative."

### N94 · A gotcha trigger matches command text inside a commit message, so writing about a hazard fires it — **S3** — **OPEN**

Found 2026-09-25 while promoting G-P. `hooks/gotcha-guard.mjs` matches a `**Trigger:**` regex
against the Bash call's whole command string, which includes heredoc bodies. A commit message
*quoting* a hazardous command therefore fires the entry about it: writing the G-P commit — whose
body quotes `git checkout -- <file>` — triggered both G-O and G-P at once.

Harmless in itself, and the cost of a good trigger rather than a bad one: narrowing to "the
command as executed" means parsing shell, and a guard that tries to be clever about quoting will
miss the real thing. But it is worth knowing before anyone widens a trigger, because the noise
scales with how often the hazard is discussed, and the entries most discussed are the ones most
recently paid for.

The honest options are to accept it, or to skip matching inside a heredoc body specifically —
which is a narrow, testable rule rather than general shell parsing.

### N95 · `fs.existsSync` gets a non-string somewhere in the digest path, and the source is unlocated — **S3** — **OPEN**

`~/.propagate/digest.stderr.log` carries, on every recent run:

```
(node:48423) [DEP0187] DeprecationWarning: Passing invalid argument types to fs.existsSync is deprecated
```

Something calls `existsSync` with a value that is not a string or URL — most likely `null` or
`undefined` from a config field that is legitimately unset on this machine, of which
`INTEGRATIONS.marketplaceDir` is the known example (PR-016). `lib/skills/skills-scan.mjs:464`
guards its own call with `!marketplaceDir ||` first, so it is not that one.

**Not reproduced.** `node --trace-deprecation cli.mjs inventory` does not surface it, so the call
sits on a path `inventory` does not reach. Recorded rather than guessed, because a plausible
attribution here would be exactly the "reader invents an answer" failure `rule:discernment-checks`
§6 describes. The next person should run the digest itself under `--trace-deprecation`.

Latent rather than harmful today: Node has deprecated the coercion, so a future major turns this
into a throw on a path nobody has identified.

### N96 · The three components that deliver and verify rules each compute the rules directory independently — **S2** — **OPEN**

Measured 2026-09-25. `lib/core/config.mjs` already exports 37 symbols including `RULES_DIR`,
`STATE_DIR`, `SKILL_DIR`, `HUB_ROOT` and an `INTEGRATIONS` record — so the config module is not
missing, it is **bypassed**. 62 path literals sit outside it across 29 files.

Counted by path, `config.mjs` against everywhere else:

| path | in config | elsewhere | files |
|---|---|---|---|
| `~/.claude/rules` | 1 | **3** | 3 |
| `~/.propagate` | 4 | **10** | 9 |
| `~/.claude/CLAUDE.md` | 0 | 4 | 3 |
| `~/.claude/plugins` | 0 | 3 | 2 |
| `~/.claude/settings.json` | 0 | 2 | 2 |
| `~/.claude/skills` | 1 | 2 | 2 |
| `~/.claude` (bare) | 0 | 2 | 1 |
| `~/.agents` | 0 | 1 | 1 |

**The first row is the defect, not the tally.** The three files that recompute
`~/.claude/rules` are `lib/report/doctor/discovery.mjs:531`, `hooks/load-rules.mjs` and
`hooks/rule-guard.mjs:66` — the check that verifies rules, the hook that reports them at session
start, and the hook that pushes them at tool time. Each decides for itself where rules live. They
agree today by coincidence, and the failure mode if one ever drifts is silent and total: rules
load from one directory while the checker reads another, and both report success.

That is `rule:tool-priority`'s own history — nine divergent copies making four mutually exclusive
claims — reproduced in code rather than prose, inside the tool built to detect it.

**Paths that exist in no config at all**, each defined where it is used:
`gotchas-global.md` and `gotcha-guard.log` (`lib/gotchas/parse.mjs:43-44`), `rule-guard.log`
(`hooks/rule-guard.mjs:67`), `skills-registry.off` (`lib/skills/skills-lifecycle.mjs:87`),
`~/.claude/skills` and `~/.agents/.skill-lock.json` and `~/.claude/projects`
(`lib/skills/skills-scan.mjs:47-53`), `~/.claude/plugins/cache` and `installed_plugins.json`
(`lib/report/doctor/delivery.mjs:277,312`), `DAILY.md` (`lib/report/inventory.mjs:76`).

**Why this matters beyond tidiness.** Two of this session's findings were path-location failures
that a single registry would have made structural rather than accidental: the hub's task list was
invisible because `lib/report/backlog.mjs:117` matches the filename `TODOS.md` literally
(landed 2026-09-25), and `gateVersionManifests` had to grow a cross-repo path by hand for the
fifth manifest (PR-016). Both were "a path decided at the point of use".

The fix is a registry that grows by declaration — add a name, not a `path.join` — and a test
asserting no path literal for a known root appears outside it. Without that assertion the
registry becomes the 39th symbol nobody reaches for, which is the same failure one level up.

### N97 · Seven declared colour pairs sat under 4.5:1 in the light theme, and the guard could not see any of them — **S2** — **RESOLVED 2026-09-25**

**This entry was filed naming ONE pair. A derived check found SEVEN, which is the finding.**
Filed against `--dim` on `--field` at 4.40; then, instead of fixing that value, the check was widened
first — and it immediately returned five more, across five distinct token combinations, every one in
the light theme and none in dark:

| contrast | rule | pair |
|---|---|---|
| **3.60** | `.badge.none` | `--dim` on `--line` |
| **3.85** | `.vin-resolved` | `--st-ok` on `--ok-quiet` |
| **4.00** | `.vin-unresolved` | `--st-warn` on `--warn-quiet` |
| 4.40 | `.vin-absent` · `.vin-unknown` · `.reason` · `kbd` | `--dim` on `--field` |

Three of the seven were added the same day by the stream-panel work, in a change that ran the full
suite and shipped green.

**Fixed by derivation, not by eye** — `lib/report/color.mjs`'s own `contrast()` solved for each
threshold, then took headroom:

- `--dim` light **.546 → .490** (.495 is the threshold against `--line`). One change cleared five of
  the seven. Now 4.57 on `--line` through 6.24 on `--card`. The dark `--dim` is a separate
  declaration and is untouched.
- `--warn-quiet` and `--ok-quiet` light offsets **+.38 → +.44** (.433 and .432 are the thresholds).
  Now 4.58 and 4.60. Their only other consumer, `.banner`, puts `--fg` on `--warn-quiet`, so a
  lighter ground only improves it.

**The guard was widened before the values were touched**, which is why this entry is worth reading:
`tests/unit/theme.test.mjs` now carries *"every colour/background pair ui.css DECLARES clears 4.5:1,
both themes"* — it reads the stylesheet, finds every rule declaring both a `color` and a
`background`, and checks that pair. It names no tokens, so adding a rule adds coverage and there is
no list to remember to extend. It refuses to run on fewer than 12 pairs, because a regex that stops
matching would otherwise report a clean sweep of nothing.

**Mutation-proven:** reverting `--dim` to `.546` turns it red naming all five affected rules with
their measured values and the line *"15 pairs checked in 2 themes"*. Restored, green. General form
filed as **G70**.

**Measured 2026-09-25** with the repo's own `contrast()` from `lib/report/color.mjs`, resolving
`commands/ui.css` in both themes:

| pair | light | dark |
|---|---|---|
| `--fg` on `--bg` | 16.71 | 14.37 |
| `--dim` on `--bg` | 4.72 | 5.65 |
| `--fg` on `--card` | 17.43 | 13.08 |
| `--dim` on `--card` | 4.92 | 5.14 |
| `--fg` on `--field` | 15.59 | 14.95 |
| **`--dim` on `--field`** | **4.40** | 5.88 |

Everything clears except that one pair, in light only. `DESIGN.md` §"The three things a colour must
survive" sets the floor at **4.5:1 against its own declared ground, both themes**.

**Three rules declare exactly that pair**, all at small sizes, so the 3.0 large-text allowance does
not apply (large means ≥18.66px bold or ≥24px):

```
commands/ui.css:289  .vin-absent  { background: var(--field); color: var(--dim); border: 1px dashed var(--line); }
commands/ui.css:292  .vin-unknown { background: var(--field); color: var(--dim); }
commands/ui.css:332  .reason      { font-size: 12.5px; color: var(--dim); background: var(--field); ... }
```

**Two of the three were added on 2026-09-25**, by the stream-panel work, in a change that ran the
full suite and shipped green — because nothing checks this pair. `tests/unit/theme.test.mjs` runs
19 tests including contrast in both themes, but every colour assertion iterates `SEMANTIC`
(`:120-121`), which is **seven** tokens; `ui.css` uses **46**. `--dim`, `--field` and every other
token carrying real interface text are outside the population. Filed as **G70**.

**It is a 0.1 miss, and that is the point.** Nobody would catch 4.40 by eye, which is exactly what
a derived floor is for. The fix is a lightness nudge on `--dim` in the light branch, or a different
ground for those three rules — but it should not be applied without extending the guard first, or
the next 0.1 lands the same way.

**Fix order:** widen the check before fixing the value. A number corrected by hand under a guard
that still cannot see it is the same defect with a fresh timestamp.

### N98 · `GOALS.md` is the one register with no update mechanism — every goal reports `open` forever, and nothing can say a goal's premise rotted or that a project has none — **S2** — **OPEN**

**The three-state parse has no state for "I checked."** `lib/report/handovers.mjs:129`:

```js
status = resolved ? "closed" : doneWhen ? "open" : "unknown"
```

`open` means *"this entry has a `Done when:` line"*. It does **not** mean the condition is unmet —
nothing ever evaluates the condition. `closed` requires a human to hand-write `Resolved:`. So the
header line `15 goal(s) — 15 open · 0 closed · 0 unknown` is a statement about **markup present in
three files**, and it reads as a statement about work outstanding.

**`Derived by:` commands are never executed.** The report says so in its own header —
*"(read-only; `Derived by:` commands are printed, never run)"* — and it is true: no `execSync`,
`spawnSync` or `exec(` in `lib/report/goals.mjs` or `commands/goals.mjs`. Every entry names a
runnable check and nothing runs any of them. **11 of 15 goals name a command. Zero have ever been
run by the tool that collects them.**

**And `doctor` does not read goals at all.** The only reference to goals under `lib/report/doctor/`
is `delivery.mjs` naming `commands/goals.mjs` as a *file that must be served* — the 2026-09-16
incident. Nothing checks goal health. `goals` is a standalone report a human must remember to run.

**`goals.mjs` has no notion of staleness, coverage, project, or when an entry was last looked at.**
Grepped for all four; the only hits on `project` are in unrelated path handling.

## The two failures this produced, both found by hand on 2026-09-25

Neither is expressible in the current model, which is the point — they were found by a person
reading the file, and nothing would have surfaced either.

**1 · An entry's argument rotted within hours of being written, and stayed for eleven days.**
`Vipin Kaushik/propagation/state/workspace/GOALS.md` entry 3 argued at length that whether
embeddings work on classical Sanskrit *"is neither impossible nor fine — it is UNMEASURED, and
this goal closes only when someone measures it here."* It was created in a single commit on
2026-09-14. `sanskrit-texts/docs/EMBEDDING_EVAL.md` took **five commits the same day** — from a
pre-registered protocol to a negative result — and was superseded on the 15th. `GOALS.md` was
never touched again. The goal was still correctly `open`, but its stated closing condition was
discharged and the live one (*nothing serves retrieval yet*) appeared only in the eval file.

**`rule:state-and-decisions` warns that a count in a state file rots fastest. What rotted here was
an ARGUMENT** — and an argument does not look stale the way a number does. It reads as reasoning
and gets believed. A staleness signal was available and unread: the file the entry cites moved six
times while the entry did not move at all.

**2 · The workspace's busiest project had no arrival condition, and the tool has no way to say so.**
`obsidian-vk-publish` was cloned into `Vipin Kaushik` on 2026-09-22 and registered by the hygiene
tick as that workspace's **eighth** project on 2026-09-25, carrying its largest project `STATE.md`
(615 lines). Since `GOALS.md` was written it has taken **210 commits — 2.5× the next busiest
project and more than every other project in the workspace combined.** It had no goal.

Worse, **entry 1's arrival condition routes through it** — *"a piece published on
vipinkaushik.com carries a canonical citation nobody pre-selected"*, and that pipeline is what
publishes to vipinkaushik.com. Its citation candidates come from `JYOTISH_DIR =
"Source/concepts/jyotish/"`, a walk of 52 notes in the author's own vault, and nothing in `src/`
or `main.js` references `3150`, `/v1/texts` or `astroacharya`. So entry 1 could never close for a
reason entry 1 did not mention, and no check could have connected the two.

## What is missing, in fix order

1. **`goals --derive` — run the commands.** Report `met` / `not-met` / **`could-not-run`**, which
   the current three-state model has no room for. **The entries already write this distinction in
   prose and nothing reads it**: Vipin Kaushik's entry 2 says *"`404` means the route is absent —
   the not-met reading. `000` means the server is not running, which is `could not run`, not a
   result."* That is `rule:discernment-checks` §2 hand-written into a document because the tool
   cannot express it. Both of that entry's checks return `000` today.
2. **Staleness against the cited target.** An entry whose `Derived by:` path or cited file has
   moved since the entry last moved is a re-read candidate. Failure 1 fires on this immediately
   and cheaply — no execution required, just two mtimes or two git log dates.
3. **Span against the project registry.** `propagation/INDEX.md` already lists every registered
   project per workspace. Crossing it against the goal set makes "this project has no arrival
   condition" a derivable finding. Failure 2 fires the day the project registers.
4. **A push, not a pull.** `rule:every-project-carries-gotchas` is explicit that `STATE.md` and
   `DECISIONS.md` are pull artifacts and `GOTCHAS.md` earns its keep by being *pushed* at the
   moment of risk. **`GOALS.md` is a pull artifact with no moment of risk to attach to** — which
   is why eleven days passed. The candidate trigger is the one that already exists: a goal's cited
   file changing is exactly a `.propagates.yml` edge, and declaring `EMBEDDING_EVAL.md ->
   GOALS.md` would have fired drift on 2026-09-14.

## Why this is filed here and not in the workspace

**`rule:enforcement-watches-itself`.** The hub's own `GOALS.md` entry 5 is *"Every workspace's
direction has an arrival condition"* — marked **judgement, no command claimed**. That is precisely
the span check in item 3. The tool that would derive the hub's goal about goals does not have it,
and the goal declares itself underivable rather than naming the check that is missing.

Three `GOALS.md` files now exist (hub, `Sindhu`, `Vipin Kaushik`) with **15 entries, 0 closed
since the first was written**. That is either a young register or a register nothing updates, and
**nothing in the tool can tell those two apart** — `rule:discernment-checks` §6.

### N99 · A `--apply` test wrote a fixture line into a real register in another repo, because the reminders lane derived the hub from `HOME` and no scoping reached it — **S1** — **RESOLVED 2026-09-25**

**What happened.** `npm test` inserted `### PR-001 · a ccusage item` — a literal fixture
record from `tests/cli/reminders-sync.test.mjs`'s `RECORDS` array — into
`Rupali/propagation/state/claude-usage-widget/TODOS.md`, a human-authored file in a
different repository. Found by comparing the file's md5 against a value taken before the
run; it would otherwise have been a plausible-looking staged item nobody filed.

**Why the existing isolation did not catch it.** Every test in that file scopes
`PROPAGATE_STATE_DIR` and snapshots the whole state directory before and after. None of
that could see this, because **the register path was never derived from the state dir**:
`lib/reminders/sync.mjs` computed `path.join(HOME, "Documents/GitHub")` directly. Scoping
the store does not scope the tree.

**The test's safety rested on a sentence about the filesystem.** Its header said, in
terms: *"both real tags resolve to REFUSALS on this tree ... no test here ever needs
`--apply` against a real register path."* That was true when written and it was
load-bearing. The same session then created a register so `#ccusage` reminders had
somewhere to land — which is the fix for a different issue — and the premise silently
became false. A comment cannot hold an invariant that a later, unrelated, correct change
can falsify.

**This is G56's family one level worse.** There, a bare `node --test` wrote the production
*ledger*. Here a fully-scoped `npm test` wrote a production *register* in another repo. In
both cases the safety property lived somewhere no reader of the test file could see.

**Fixed, in three parts:**

1. `lib/reminders/{tags,sync}.mjs` resolve the hub from the configured `HUB_ROOT` when
   there is one, so `PROPAGATE_HUB_ROOT` now reaches this lane at all. The `HOME` guess
   remains only as a last resort and `tagTableStatus()` reports which source was used, so
   it can never be silent about having guessed.
2. Every test in `tests/cli/reminders-sync.test.mjs` builds its own temp hub with
   `makeHub()` and passes `PROPAGATE_HUB_ROOT`. The real tree is unreachable **by
   construction**, not by a comment.
3. Each of those tests asserts, in `t.after`, that the real register is byte-identical —
   so if containment ever breaks again it is named at the point of failure rather than
   discovered by someone reading their own TODOS.md.

The inserted line was removed and the file verified byte-identical to its pre-incident
md5 (`e9bd9ebbe5c057809adab408314fdfdd`).

**A side benefit worth keeping.** With a safe register to write into, that file now covers
the real `--apply` insert path and idempotency end-to-end through the CLI — coverage its
own header previously declared as a deliberate gap.

**What remains, and it is the reason this entry names the general form.** Switching the
lane to a strict configured hub broke **17 tests at once**, because the suite's reminders
coverage had been resting on that `HOME` guess throughout — not just the one test that
wrote. The fallback keeps them passing today. Removing it needs each of those tests to
declare its own hub first, and until that happens `propagate`'s test suite still READS the
real tree in places it does not announce. Reading is not writing, but it is the same
unscoped seam.

### N101 · `rollup` wrote `ECOSYSTEM.md` to whichever search root sorted first, so the one every doc cites became unregenerable — **S2** — **RESOLVED 2026-09-26**

Found 2026-09-26, while regenerating `ECOSYSTEM.md` after N82 changed two of its rows.

`artifactPath()` (`commands/rollup.mjs`) returned `SEARCH_ROOTS[0]`. But **`searchRoots` is a
DISCOVERY setting** — the list of places to walk looking for `.propagates.yml`, ordered for the
walk and not to name the tree. `config.yml` lists:

```yaml
hubRoot: /Users/rupali.b/Documents/GitHub
searchRoots:
  - /Users/rupali.b/Documents/GitHub/Rupali/Experiments   <- sorts first
  - /Users/rupali.b/Documents/GitHub
```

So the artifact resolved to `Rupali/Experiments/ECOSYSTEM.md` — **a file that has never
existed** — while the real one, tool-generated (`2d5ec40` "the first generated ECOSYSTEM.md")
and cited by four documents, sat at the hub root untouched since 2026-09-01.

**Nothing moved the file.** A config key was added for an unrelated reason and a derived path
followed it. That is G24's shape through the other door, and the symptom was the giveaway:
`rollup --check` exited **2 (could-not-run)** with *"…/Rupali/Experiments/ECOSYSTEM.md does not
exist yet"* — a command reporting it cannot find an artifact it would itself create, while the
artifact it was actually maintaining went stale in silence.

**Why it went unnoticed: `artifactPath()` had NO TEST AT ALL.** Not a weak one — none. The
function that decides where the tool's only generated artifact lands was unasserted, so a path
change produced no red anywhere.

**Fixed:** `artifactPath({ hubRoot = HUB_ROOT, roots = SEARCH_ROOTS })` prefers the DECLARED
HUB, falls back to the first root, and returns `null` with neither — a could-not-run, never a
crash and never a guess. `ECOSYSTEM.md` rolls up the WHOLE tree and `hubRoot` is the declared
name for that tree, so writing it inside one nested search root is incoherent whatever the
ordering. A preference, not a sort.

`tests/unit/rollup-artifact-path.test.mjs` asserts the preference, and its negative control is
the one that matters: **reordering `searchRoots` must not move the file.** Under the old code
those two calls agreed — both wrong — so the control would have passed while the defect stood.

After the fix, `rollup --check` went 2 -> 1 (stale, correctly) -> 0 (current) once regenerated:
734 -> 959 lines at the hub root.

### N107 · The event-store mirror has no refresh, so it will silently become a backup of 2026-09-30 — **S2** — **RESOLVED 2026-09-30** (rides the 09:00 digest, hash-gated, and reports PROTECTION separately from freshness)
**RESOLVED 2026-09-30, same day, and the design gained one thing the plan did not anticipate.**
`eventsBackupSnapshot()` rides the existing 09:00 digest — zero new plists, zero launchd changes.

**The addition: freshness and protection are reported as SEPARATE facts, and the second is the one
that matters.** The plan copied `refsSnapshot()`'s shape, and writing it surfaced that the model is
insufficient for a *backup*. `refsUncommitted()` answers "is the output uncommitted" — and this
morning the hub carried MODIFIED `propagation/refs/{snapshot.json,lifecycle.jsonl}` from 2026-09-27
and 2026-09-29. Fresh files, in a dirty tree, protecting nothing. For a registry that is a nuisance;
for a backup it is total failure, because **the bytes that survive a lost disk are the ones on the
remote.** So `mirrorProtection()` reports `dirty` AND `unpushed`, and a committed-but-unpushed mirror
is reported as UNPROTECTED — a state the refs rider cannot express at all.

**Hash-gated, which is a correctness property rather than an optimisation.** The store is 2.7 MB and
the digest fires daily. An unconditional copy would rewrite the mirror every morning and leave the
hub permanently dirty — precisely the state `refs-registry` leaves its registries in, and it destroys
the signal. Copying only on a hash mismatch means a quiet day leaves the destination CLEAN, so a
dirty tree genuinely means "there are new events to adopt". The destination is also re-hashed after
writing: `copyFileSync` not throwing is a claim about the call, not about the bytes.

**Exercised, not just asserted** (`rule:name-what-no-test-executes`). Its neighbours in
`tests/digest/digest-dryrun.test.mjs` are source-asserted because running `reap()` would delete real
skills; this path only reads, hashes and copies, so it is run for real:

| check | result |
|---|---|
| `digest.mjs --dry-run` against the live mirror | every file byte-and-mtime identical |
| armed path in isolation | 3 shards · 0 copied · 3 unchanged · `{dirty:0, unpushed:0}` |
| staged anything in the hub (N104) | **0** |
| committed-not-pushed vs pushed, on a real git fixture with a bare origin | told apart |
| `HUB_ROOT = null` (G24) | named refusal `hub-root-unconfigured`, not an empty result |

**Three mutations, each red for its stated reason and nothing else** — removing the `dryRun` gate
(2 tests), forcing `unpushed` to 0 (1 test, the `COMMITTED IS NOT PROTECTED` assertion), and letting
unreadable git state read as clean (1 test). Suite 2317 + 94, 0 failures; production event store
byte-identical across the run.

**Still not earned, and the row says so as a hard gate.** `docs/SYSTEMS.md`'s `adoption_date` stays
BLANK until events have actually been RESTORED from `origin/main` into a scratch state dir and read
back. `ssjk-mongo-backup` is the precedent two rows up: active, exit 0, and it has produced zero
backups in its entire existence. A backup that has never been restored from is a backup nobody has
tested.

Filed 2026-09-30 as the named residual of [[n84]]. The store is now mirrored to
`workspace-hub:propagation/events-backup/`, verified byte-identical — **by a manual `cp`**. Nothing
re-runs it.

**A backup nobody refreshes is worse than no backup, because it reads as protection.** That is
[[n26]]'s shape exactly: a liveness banner that froze while continuing to assert health. On the day
this matters the mirror will be however many weeks old nobody noticed.

**The host already exists and must be reused, not added to.** `com.tathya.propagate.digest` fires
daily at 09:00 and already carries riders (`reminders-bridge`, the skill reaper —
`docs/SYSTEMS.md:40,41,51`). `rule:delegation-criteria` §2 is explicit that a new scheduled
component must justify itself against derive-on-demand, and this one cannot: nothing needs the
mirror to exist *before* someone asks. So it is a rider, and **no plist is touched** — G-O records a
plist truncated to 94 bytes that stayed `launchctl list`-green for seven days.

**The probe is "the mirror got newer", never "the job ran"**, per the `reminders-bridge` row's own
model and for the reason [[n55]] exists: a component correctly retired whose replacement nothing
invoked. A row in `docs/SYSTEMS.md` is part of the deliverable, not a follow-up.

**Two hazards specific to this rider, both already paid for in this repo.** It writes into ANOTHER
repository's working tree, so it must never stage or commit — N104 is the entry where
`migrate --apply` staged into a colleague's index and their next commit adopted 189 lines of it.
And `digest.mjs` is the file that taught this repo `rule:safety-flag-needs-a-test`: its `--dry-run`
promised *"print, write NO state"* while `lifecycleSweep()` called `reap(…, {apply: true})`
unconditionally. **`dryRun` must be threaded and proven inert by snapshotting the mirror's bytes,
not by reading stdout.**

### N108 · The leftover-cache check names the first stale tree it finds, not the population — **S3** — **OPEN**
Found 2026-09-30, immediately after `claude plugin update propagate@tathya` took the served plugin
from 0.15.0 to 0.15.5. Doctor reported **one** leftover cache tree:

```
! served plugin has a LEFTOVER cache tree  tathya/propagate 0.5.0 at
  ~/.claude/plugins/cache/tathya/propagate/0.5.0 is not the served install
```

There are **six** version-keyed directories under `~/.claude/plugins/cache/tathya/propagate/` —
`0.5.0`, `0.6.1`, `0.6.2`, `0.6.3`, `0.15.0`, `0.15.5` — each with a `package.json` declaring its
own version. Five are stale, and the update just created the fifth. The check reports a single
example where it should report a count, which is the same defect shape as the `head -4` read as a
total earlier this week: an instrument answering a narrower question than the one asked
(`rule:discernment-checks` §4).

Harmless in itself — a stale cache tree is inert, and the check's own text says so. It matters
because **a warning that names one instance trains the reader to fix one instance**, and the pile
grows by one on every update.

### N109 · `digest.mjs`'s `GITHUB_ROOT` is `SEARCH_ROOTS[0]`, which is not the hub — the disk section measures 12% of the tree — **S2** — **OPEN**
Found 2026-09-30 while wiring [[n107]], which needed a hub path and therefore had to establish which
constant actually holds one.

```
digest.mjs:83   const GITHUB_ROOT = SEARCH_ROOTS[0];

SEARCH_ROOTS[0] = …/Documents/GitHub/Rupali/Experiments
HUB_ROOT        = …/Documents/GitHub
equal?          false
```

`SEARCH_ROOTS` is an ORDERED list of roots and nothing promises the hub is first. On this machine it
is second, because `Rupali/Experiments` is a nested search root and sorts ahead. The only consumer is
`discoverProjectDirs()` (`digest.mjs:188`), which shells out to
`find "$GITHUB_ROOT" -maxdepth 4 -name package.json`, so the digest's disk section enumerates:

| root scanned | package.json dirs found |
|---|---|
| `SEARCH_ROOTS[0]` — `Rupali/Experiments` (what it uses) | **6** |
| `HUB_ROOT` — the hub (what it means) | **49** |

So the disk report covers 12% of the tree and reads as complete. This is the same class as
[[n26]] and [[n16]] earlier today — an instrument answering a narrower question than the one asked —
but arriving through a new door: not a bad query, a **plausible-looking index into an ordered list
whose order is not part of its contract**.

**Why it is not fixed here.** `HUB_ROOT` is the obvious substitution and it changes what the digest
REPORTS — 6 project dirs becoming 49 will move the disk section's numbers and may trip its
thresholds. That is a deliberate change to a daily report's content, not a typo fix, and it belongs
with a look at whether the section wants the hub or genuinely wants every search root (the honest
answer is probably `SEARCH_ROOTS` entire, not either single root). `GITHUB_ROOT` was left untouched by
N107, which derives its own destination from `HUB_ROOT` directly.

**The general form, which is the part worth keeping:** `SEARCH_ROOTS[0]` appears to name the hub and
does not. Any `[0]` into a configured list is an assumption about ordering that the config never
made — and `lib/core/release.mjs:135` already records the same lesson in the same repo, warning that
the hub marketplace's propagate entry is *"never `.plugins[0]`, which on this hub is `quarantine`"*.
That comment exists because someone already paid for this once.

### N113 · A Next.js bracket path was classified as a glob, so an existing file read as "matched 0 files" — **S2** — **RESOLVED 2026-09-30**
Found 2026-09-30 by RUNNING the new sidecar-source check against the real tree rather than reviewing
it (`rule:name-what-no-test-executes`). Its one and only finding was a false positive:

```
! sidecar SOURCE glob matched 0 files   Manav-portfolio/.propagates.yml: src/app/work/[slug]/page.tsx
```

The file is on disk. `[slug]` is a Next.js App Router **dynamic segment** — a literal directory name —
and `globSync` reads `[slug]` as a character class, so it searches `work/s/page.tsx` and finds nothing:

```
existsSync("src/app/work/[slug]/page.tsx")  ->  true
globSync(same path)                          ->  []
```

**The DOWNSTREAM check had the identical bug from the start, at
`lib/report/doctor/workspaces.mjs`'s `/[*?[\]]/.test(d.path)`.** It had never surfaced because no
declared downstream happened to be a bracket path — an unknown reading as clean, which is [[n35]]'s
shape in a different component. My new source check simply gave the tree a bracket path to trip over.

**Fixed by defining the predicate ONCE**, literal-first, and using it on both sides:

```js
const isGlob = (rel, dir) => /[*?[\]]/.test(rel) && !existsSync(path.join(dir, rel));
```

A path that exists is not a pattern, whatever characters it contains. Two copies of that test are two
chances to disagree, which is the same source-versus-downstream asymmetry this file already paid for.

Covered by `tests/unit/sidecar-source-guard.test.mjs`, whose fixture declares a bracket path as BOTH
source and downstream so one case proves both call sites; reverting to the naive predicate turns
exactly that test red. Real tree after the fix: **0 findings**, which is a result rather than silence
because the check is proven to fire on a fixture.

### N114 · The seven new rules found 6 convertible restatements — **S3** — **RESOLVED 2026-09-30** (all six converted; `rules check` 7 -> 1, and one further site left alone with reason)
**RESOLVED 2026-09-30. All six converted; `rules check` went 7 -> 1**, the survivor being
`Divyansh/AuroraV3` which is Divyansh's fork and permanent by decision. Coverage moved with it:
`absence-claims-need-state-and-branch` from `restated 5 / referenced 1` to `1 / 5`, and
`derive-dont-curate` from `2 / 0` to `1 / 2` — both now `firing`.

**Each conversion kept the LOCAL measurement and replaced only the GENERAL claim.** That split is
`rule:nextjs-dev-server-port`'s own test: a file describing its own situation is compliance, not
restatement. So Motherboard keeps *"`git cherry` said 14 unmerged here when the content was
identical"*, Vipin Kaushik keeps *"four repos sit on feature branches and VK deploys from
`production`"*, and obsidian-vk-publish keeps its whole measured story about a hardcoded-paths list
that was wrong in both directions. Only the sentences stating the rule became pointers.

**One of the six was a REPOINT, and it is the class worth remembering.** `obsidian-vk-publish`'s
"do not restate the count here — derive it" already carried a correct citation — at
`rule:state-and-decisions`, which no longer owns that claim. **A citation aimed at a superseded
owner is invisible to every check**: `rules check` sees a reference and is satisfied. Promotion
creates that class of stale pointer by construction and nothing looks for it.

**A seventh site exists and was left alone deliberately.** `Keerti/CLAUDE.md:136` restates the
rule — and, remarkably, already CITED it before it was written, a forward reference to the id
backlogged in `rules/_TODO.md:208`. The file carries 31 uncommitted insertions that are not mine,
and editing it would put my change into someone else's next commit — G-N, and N104 in reverse. Left
for whoever owns that work.

**Checked while there and found nothing, which is worth recording as a result:** every `rule:<id>`
citation in the tree resolves to a real rule file. Zero dangling. I had expected a gap there — that
a pointer at a non-existent rule would read as compliance — and the measurement says there is none.

**And the pass cost one real mistake, recorded as G72 — plus two wrong reports OF that mistake.**
A multi-line bash block committed and pushed in `Vipin Kaushik`; the commit failed on another live
session's `index.lock`, nothing stopped the block, and the push published commits that were not
mine. Disclosed immediately. Rupali reviewed it and let it stand — only `GOTCHAS.md`, `STATE.md`,
`TODOS.md` and `.gitignore`, no vault content and nothing secret-shaped.

**Then three corrections, each to a confident account of a small event:**

1. **My mechanism was inverted.** I reported `&&` as having "moved past" the failure. `&&` would
   have PREVENTED it — the hazard is its absence. Corrected only after reproducing it in a
   throwaway repo, and the peer noted the inverted version was the more dangerous record because it
   would have had the next reader removing the one construct that helps.
2. **My count was wrong, then the peer's correction was wrong, then my correction of that was
   wrong.** I said three commits and named one already on the remote. They said six, and
   attributed one of their own to me. `git reflog show origin/main` fixed the TIMING — the tip had
   been `40519b6` since 09:10 and the 09:49:35 push advanced it to `0e369a2`, so one or two commits
   — and I then declared both theirs. **`0e369a2` is a THIRD session's**: its files are `TODOS.md`
   and `propagation/state/sanskrit-texts/STATE.md`, and that session spent the morning re-deriving
   sanskrit-texts figures. So my push carried at most ONE of the peer's commits and possibly none.
   **The reflog answers WHEN, not WHOSE**, and I filled whose by inference — authored during their
   lock, therefore theirs — when a lock is anonymous. Git offers three instruments that look like
   they answer ownership and none does: `--author` is uniform in this tree, the lock is anonymous,
   the reflog is agentless. **The file list is the only column that distinguishes sessions.**
3. **The gotcha's emphasis was wrong**, and the peer supplied the better framing: the dangerous half
   is not the missing `set -e`, it is that the push **exits 0 and reports success**, printing nothing
   that distinguishes publishing your commit from publishing whatever `HEAD` was. Fix only the
   chaining and the silent publish returns on the next commit that fails for another reason.

`rule:verify-work-not-report` and `rule:require-a-demonstration` both applied to their own author,
on the day they were written, three times in one incident.

Filed 2026-09-30 as the named residual of the rule-promotion pass. `rules check` went from **1**
restatement to **7**; the one it found before is `Divyansh/AuroraV3`, which is Divyansh's fork and
permanent by decision. The other six are new, real, and each names a conversion:

| file | line | what it says | convert to |
|---|---|---|---|
| `Vipin Kaushik/CLAUDE.md` | 126 | *"Say \"absent on `<branch>`\", never bare \"absent\" (G10)."* — **verbatim** | `rule:absence-claims-need-state-and-branch` |
| `Motherboard/CLAUDE.md` | 426 | *"**Squash merges lie about ancestry** — `git cherry` said 14 unmerged"* | same |
| hub `CLAUDE.md` | 46 | *"the row had drifted in both directions"* | same |
| `obsidian-vk-publish/CLAUDE.md` | 230 | *"wrong about presence in both directions is worse than a stale one"* | same |
| hub `CLAUDE.md` | 177 | *"The `ws.length<10` line is a **floor**: a derived population…"* | `rule:derive-dont-curate` |
| `obsidian-vk-publish/CLAUDE.md` | 224 | *"Do not restate the count here — derive it, per `rule:state-and-decisions`"* | **repoint** the citation to `rule:derive-dont-curate` |

The last row is the subtlest and the most useful: it already carries a pointer, at the rule that used
to own the claim. A correct citation aimed at a superseded owner is invisible to every check —
`rules check` sees a reference and is satisfied — so promotion creates this class of stale pointer by
construction and nothing looks for it.

**Not done here deliberately:** five files across three repos, two of them workspaces holding
uncommitted work that is not mine (N104 is the entry where staging into someone else's tree cost a
colleague's commit). The pass that wrote the rules should not also edit five other repositories.

**One measured lesson from authoring, kept because it will recur.** The first
`derive-dont-curate` fingerprint carried `derive it, never` and `never trust this number`, and those
two alternations produced **3 hits, all compliance and zero restatements** — hub `CLAUDE.md:25`,
`Tushar/texts:52` and `Vipin Kaushik:59`, each telling the reader to derive ITS OWN number, which is
the rule being followed. Dropped before shipping. `rule:nextjs-dev-server-port` records the identical
trade in its own fingerprint note — the wide version flagged 8 files to find 1 — and the general form
is that **a fingerprint matching a rule's IMPERATIVE catches compliance; only one matching its CLAIM
catches restatement.**

### N115 · `state.tracked_files` has read 0 on 831 consecutive runs because it measures a deleted file — **S2** — **RESOLVED 2026-09-30** (retired, with a declared-retirement mechanism so the removal is attributable; the general check it asked for now ships in `--since`)
**RESOLVED 2026-09-30. Retired, not re-pointed** — nothing replaced the watcher's baseline
(`reconcile` / `check` / the monitor do its job and none keeps one), so there was no subject to aim
it at. Removed from the collector, from `UNCALIBRATED`, and from the emitted record.

**The removal needed a mechanism first, which is the part worth keeping.** `detectVanishedKeys` had
no notion of a deliberate retirement, so deleting the key would have printed `metric still emitted:
state.tracked_files` as a doctor FAILURE — a real defect reported for an intentional change, and the
next reader investigating nothing. `RETIRED_METRICS` now carries the key, the date and the reason;
`detectVanishedKeys` skips those, and `doctor` reports them **as retired** rather than suppressing
them. Absence stays attributable; which of the two facts it is, is now answerable. Verified live:
`· metric retired: state.tracked_files  withdrawn 2026-09-30`.

**And the general check this entry asked for now ships.** It closed with *"the general check is
'does each gauge's subject still exist', and nothing asks it"*. `doctor --since` now names every
gauge that did not move in the window and splits them by whether `EXPECTATIONS` asserts the value —
an asserted constant is known good, an unasserted one is only unexamined. On 30 days it reports:

```
9 gauge(s) did not move; 7 of those are asserted, so a constant is known good
unmoved and NOT in EXPECTATIONS — check whether an inline doctor check covers each:
  plist.watchpaths = 0 across all 502 run(s) — may be covered by an inline check()
  rows.open = 0 across all 502 run(s) — declared UNCALIBRATED, so genuinely unexamined
```

**That report overclaimed in its first version and was narrowed within the hour**, which belongs in
the record because it is this register's own recurring defect. It said *"nothing would notice if
their subject disappeared"* — measured as "absent from `EXPECTATIONS`", a proxy for "asserted
nowhere". Wrong: `plist.watchpaths` IS asserted, by an inline `check()` in
`lib/report/doctor/discovery.mjs`, proven failable by `doctor.test.mjs`'s G20 test. So the line now
claims only what it can see and says where to look next. `rule:measure-the-claim-not-a-proxy`,
written this morning, inside the feature built to surface that class.

Found 2026-09-30 while calibrating the six uncalibrated metrics (PR-029). The distribution is not
noisy, it is a cliff:

```
208  on every run 2026-08-13 .. 2026-08-19
  0  on every run 2026-08-20 .. today — 831 runs, no exceptions
```

`STATE_PATH` is `~/.propagate/state.json`, the **retired watcher's mtime baseline**, and that file
does not exist. So the gauge has faithfully reported zero for six weeks about a subject removed with
the watcher — and it was `UNCALIBRATED`, exempt from assertion, which is exactly why nothing could
say so. A metric with no expectation is unfalsifiable, so it can die in silence. That is
`docs/OBSERVABILITY.md`'s own closing line — *"a metric without an expectation is decoration"* — with
a cost attached.

**`detectVanishedKeys` cannot catch this, and the reason generalises.** That check fires when a KEY
present last run is absent this run. Here the key is present on every run; it is the SUBJECT that is
gone, and a reader of a deleted file returns a clean, plausible zero rather than an error. Same
family as [[n26]] and `rule:measure-the-claim-not-a-proxy` — the instrument worked perfectly and
answered a question about nothing.

**The fix is retirement, not a threshold.** N13's wanted *">20% run-over-run drop"* is moot for the
same reason: there is no subject to drop. Decide whether the metric is removed outright (it costs a
`readFile` per doctor run to report a constant) or re-pointed at whatever replaced the watcher's
baseline, if anything did.

**And worth asking of the other eleven.** This was found only because PR-029 went looking. A metric
measuring a deleted artifact is invisible by construction, so the general check is *"does each
gauge's subject still exist"* — and nothing asks it.

### N110 · `supersedes:` is frontmatter that no code reads — every rule declares it and nothing acts on it — **S3** — **OPEN**
Found 2026-09-30 while planning the rule-promotion pass. All 22 rules at the time carried a
`supersedes:` key in frontmatter. `grep -n supersedes lib/rules/rules-check.mjs` returns **nothing** —
the loader does not read it, `checkRules` does not consult it, `selftest` does not assert on it.

**Why it matters rather than being cosmetic.** A promotion is exactly the moment the field would earn
its place: `verify-work-not-report` took a claim that three other rules stated, and a reader asking
"which rule superseded that clause" has no machine-readable answer. Worse, the field's presence
implies the question was answered. `rule:enforcement-watches-itself` names the shape — a declaration
that looks machine-checked and is not.

**Not fixed here, and the reason is a real design question rather than effort.** Superseding is not
rule-to-rule in this tree; it is clause-to-rule. `verify-work-not-report` did not supersede
`discernment-checks` — it took over one section's claim while that rule kept its sentence and gained a
pointer. A field whose only honest value is `[]` for every promotion so far should either express
clauses or be removed, and both are decisions.

### N111 · `selftest` PASSES a rule with no probes, so its headline result is weaker than the line beside it — **S2** — **OPEN**
Found 2026-09-30 while reviewing the rule-promotion plan, and then reproduced accidentally the same
day, which is the useful part.

`lib/rules/rules-check.mjs`:

```js
const probe = probes[r.id];
if (!probe) {
  checks.push({ kind: "probe", id: r.id, pass: true, unprobed: true });
  continue;
}
```

So **`selftest PASS` is satisfiable with zero probes on every rule.** The only signal is a separate
count line, and it is easy to read past:

```
selftest PASS — every fingerprint can fire; … 25 of 26 rules probed, 1 UNPROBED
```

That output is real: it is what `absence-claims-need-state-and-branch` produced between its rule file
landing and its probes being written. The word PASS is doing the opposite of its job — and the probe
mechanism exists precisely because self-match was too weak a test (N76 / propagate#18), so a PASS that
does not require probes reintroduces the gap the probes were built to close.

**The right fix is arguable and that is why this is filed rather than patched.** Failing on an
unprobed rule makes adding a rule a two-file atomic change, which is defensible but a behaviour
change for anyone mid-authoring. The minimum honest fix is that `PASS` becomes `PASS (N unprobed)` in
the headline itself, so the caveat cannot be read past. **Until then: the acceptance criterion is
`N of N rules probed`, never `selftest PASS`.** The seven rules written 2026-09-30 were gated on the
count line for this reason.

### N116 · A source check with tests since 2026-08-20 was reported absent, a duplicate shipped, and the false claim is published in a pushed commit — **S2** — **RESOLVED 2026-09-30**
Found 2026-09-30 by the author of the defect, one commit later, while writing the test for it.

**The claim.** `1979c2d` (pushed to `origin/main`) opens *"MEASURED BEFORE WRITING, because
workspace-hub#8 asked for exactly that: can propagate already detect a sidecar entry whose source
path is absent? No. … there was no source-side check anywhere — no check, no doctor section, no
test."*

**Every clause of that is false.** The check landed in `360ecb9`, **2026-08-20**, whose subject is
*"fix(doctor): surface dead source keys and unenforced glob-code edges"*, filed as N18, and it
shipped with `tests/cli/doctor-source-keys.test.mjs` — 81 lines, two tests, still green. It is a
**failure**, not a warning, and that file's header already carried the reasoning the duplicate
re-derived: *"A downstream may legitimately not exist yet — that is declare-ahead… A SOURCE cannot:
the edge fires when the source changes, so a source that is not there is an edge that is already
dead."*

**And this register already held the answer.** The archive section of this same file carries
`N18 · Source keys are never validated to exist — **S1** — **RESOLVED 2026-08-20**` — one line,
with the disposition and the date, five weeks before the claim that no such check existed. It was
not read, because the search was for a string in `lib/` rather than for the question in the
register.

**How the measurement went wrong.** `lib/` was grepped for the *label* `source paths resolve`. That
returned nothing, and nothing was read as absence. The source check emits **no section label** — its
output is one `✗` line per offending entry — so it is invisible to a label grep by construction. The
grep was correct about the string and answered a different question than the one asked:
`rule:measure-the-claim-not-a-proxy`, and the eighth instance of it.

**What the wrong answer cost.**
- A second, warn-level source check shipped, so **one dead source printed twice** — G20. Removed.
- The original was **glob-blind, but latently — zero live instances**, and the first version of this
  entry said "five weeks of glob sources reported as missing files", which was a third proxy in the
  same episode: the false positive was measured on a fixture I built and then written down as though
  it had been firing. Derived the same day, with a floor: **49 sidecars · 294 literal source keys
  (0 missing) · 0 glob source keys**. Exactly one source key in the tree contains a glob
  metacharacter — one client portfolio's sidecar declaring a Next.js dynamic segment,
  `src/app/work/[slug]/page.tsx` — and it is a literal that looks like a glob, which
  `existsSync` resolves correctly. **So the
  pre-existing check had no live defect at all.** The bracket false positive ([[n113]]) came from the
  duplicate's `globSync`-first ordering and was never in the original.
- **Three proxies, one episode, each one narrowing the claim:** a label for a behaviour ("no check
  exists"), then a fixture for live impact ("glob sources were being reported dead"), and in between
  a crashed run for a clean one ("six fixtures, zero verdicts"). Each was caught only by measuring
  the thing the sentence was actually about.
- The commit attributes the asymmetry to **G71**, which is about a shape-based extraction going
  blind and says nothing about one-directional checks.
- The first merge attempt then **crashed doctor on every workspace** — `isGlob` declared inside one
  of the two `for (const sc of sidecars)` loops, `ReferenceError` in the other. `node --check`
  passed, because scope is not syntax. It was read as *six fixtures reporting zero verdicts*, i.e. a
  crash rendered as a clean pass, which is `rule:discernment-checks` §6 **inside the harness built to
  verify the fix**. The harness now carries a `RUN` column, and that column was itself wrong first
  (`found 1 sidecar` against a two-sidecar fixture) until it was measured rather than assumed.

**Why nothing caught the glob bug for five weeks.** `workspace()` in the pre-existing test file takes
one `sourceKey` and creates exactly that file, so *"a pattern matching two files"* was inexpressible
from inside it — `rule:mutate-behind-the-fixture-builder` exactly. The four cases added today are
built from literals for that reason and say so in a comment.

**Resolved by:** one glob-aware check at `lib/report/doctor/workspaces.mjs`, predicate shared with
the downstream side at function scope; the duplicate deleted; `tests/unit/sidecar-source-guard.test.mjs`
folded into `tests/cli/doctor-source-keys.test.mjs` (6 tests, including an exactly-once double-print
guard); `rule:refactor-updates-sidecar-same-commit` corrected in the same change.

**What is NOT fixed, and cannot be:** `1979c2d` is pushed. A commit body asserting its own
measurement is the worst carrier for a proxy, because the assertion is what stops the next reader
checking. This entry and the corrected rule are the only counterweight.


### N112 · `description-standard`'s fingerprint matches its body but no single LINE, so a real restatement would report line 0 — **S3** — **OPEN**
Found 2026-09-30 while establishing how `checkRules` matches, before authoring seven fingerprints.

The two are different by design and it is not documented anywhere:

| step | scope | code |
|---|---|---|
| the GATE — is this file a restatement | **whole file** | `if (!re.test(raw)) continue;` |
| the REPORT — which line | **per line** | `raw.split(/\r?\n/).findIndex((l) => re.test(l)) + 1` |

So a fingerprint that only matches ACROSS a newline fires the gate and then `findIndex` returns `-1`,
making the reported line `0`. Swept all rules for it: **1 of 22** is in that state,
`description-standard`. It has never surfaced because nothing has restated that rule, which is the
same unknown-versus-clean problem N35 is about.

**The general form, which is the part worth keeping:** a matcher used for two purposes at two scopes
will disagree with itself at the boundary, and the disagreement surfaces as a plausible value (`0`)
rather than an error. The seven fingerprints authored this day were each tested per-line for exactly
this reason, and one of them — `derive-dont-curate` — needed an extra alternation because the claim it
targets wraps mid-sentence in its source.

### N106 · A v1 ledger frozen under its ORIGINAL name would be indexed as live rows — containment rests on naming, not structure — **S3** — **OPEN** (0 instances tree-wide today; the invariant is a convention with no check)
Found 2026-09-30 while closing GitHub propagate#3, and the finding is that my own close was one step
short. That issue tracked an ambiguous append-only row in a workspace's v1 ledger. I closed it as
*contained*, on the evidence that every live reader resolves a ledger by exact path
(`lib/core/discovery.mjs:362`) or by basename **with a parent directory named** `propagation` /
`.propagation` (`lib/skills/index-db.mjs:79-87`), and a file at
`propagation/archive/ledger-v1-<date>.jsonl` satisfies neither.

**That is true, and it is true because of how the file was NAMED.** `sweepFilesystem`'s
`EXCLUDE_DIR_NAMES` contains `_archive` and **not** `archive`, and its `LEDGER_FILENAMES` set matches
`PROPAGATION_LEDGER.jsonl` and `PROPAGATION_CROSS_LEDGER.jsonl` **by basename anywhere in the tree**.
So a v1 ledger frozen under its original name inside `archive/` would be swept — and its rows
inserted into `ledger_row` unconditionally, because the insert loop runs BEFORE the reachability
test at `index-db.mjs:481`. It would also be flagged `found-by-sweep-not-discovery`, so it is
attributable — but attributable and inert are different, and only the second is what "contained"
claims.

**Measured across the tree: 0 instances.** Every frozen artifact in all seven `propagation/archive/`
directories carries a version-or-date suffix — `ledger-v1-2026-08-24.jsonl`,
`PROPAGATION_CROSS_LEDGER-v1-2026-08-24.jsonl`, `STATE-marketing-intel-2026-09.md`,
`STATE_2026-09-14-drain.md`, `ISSUES-2026-08.md`. The discipline is real and universal. It is also
written down nowhere and enforced by nothing.

**The obvious fix is wrong, and that is why this is filed rather than patched.** Adding `archive` to
`EXCLUDE_DIR_NAMES` would make the containment structural — and would break the reason
`sweepFilesystem` exists. Its own header states it: *"This sweep walks the raw tree directly, so its
result can be diffed against discovery to catch the next blind spot instead of trusting the same
function that caused the last one."* The sweep is deliberately WIDER than discovery so that a ledger
discovery cannot reach surfaces as a coverage gap. Narrowing it would convert
`found-by-sweep-not-discovery` — a gap a human reads — into silence, which is the exact trade
`rule:discernment-checks` §2 exists to forbid. **Do not "fix" this by excluding the directory.**

**So the remedy is a check on the naming convention, not on the walker**: assert that no file matching
a live-ledger name sits under an `archive/` directory, derived over the real roots rather than a
fixture, and stated as the invariant it is. Left open because writing it is a doctor check rather
than a line, and because the population is currently empty — which is exactly when a guard is cheap
and exactly when nobody writes one (G70).


### N105 · The guard that keeps junk out of an append-only log had no test, and a pointer comment said it did — **S2** — **RESOLVED 2026-09-28**

**Found by applying a shape the session in `obsidian-vk-publish` had just named**, from an instance
of their own: they wrote an intake test asserting *"a pass cannot declare a workflow state"*, built
the input through their own validator, and the mutation stayed **GREEN** — the validator constructs a
fresh object holding only known fields, so the violating key never reached the module under test.
Their generalisation: *"two layers both enforce the property, and each has to be tested against
input that can actually express the violation; routing the second layer's test through the first
makes it decorative."*

`assertKnownShape` (`lib/refs/snapshot.mjs:309`) is propagate's instance, and the stake is on the
record. It exists because of **G26**, which cost real rows: two producers wrote different shapes both
labelled `schema_version: 1`, `diffSnapshots` read a flat snapshot's 36 refs as *"there was nothing
here"*, and emitted **4 spurious `created` events** into `refs/lifecycle.jsonl` — append-only, so
they are still there. Its own message names what it prevents: *"treating an unrecognised shape as
empty would emit spurious lifecycle events into an append-only log."*

**Zero of 2261 tests exercised its refusal.** The only mention anywhere in the suite was a handoff
comment in `tests/unit/refs-snapshot.test.mjs`:

```
foreign shape refused -> assertKnownShape now keys on schema_version, tested there
```

*Tested there* meant `refs-workspace-snapshot.test.mjs`, and no such test was ever written in it. The
pointer is the reason nobody looked: coverage was believed to have moved and never arrived. A promise
in one file that another file has to keep — `rule:adversarial-review-reads-the-ledger`, occurring
inside the test suite rather than between docs and code, which is a place that rule had not been
pointed at before.

**And it could not have been written there**, which is the peer's point exactly. That file builds
every input through

```js
const snap = (projects, at) => ({ schema_version: WORKSPACE_SNAPSHOT_SCHEMA, …, projects, skipped: [] });
```

The helper hardcodes the valid version and always supplies `projects`, so no test authored in that
file can express the violation; its earlier cases use `buildWorkspaceSnapshot()`, the real producer,
which likewise only emits valid shapes. The guard was unreachable from the suite **by construction,
not by oversight** — and a reviewer skimming that file would see thorough coverage, because it is
thorough about everything the helper can say.

`tests/unit/refs-shape-guard.test.mjs`, 9 cases, fixtures as RAW LITERALS with a note not to
refactor them onto a shared builder, since that is the defect. It covers G26's two real shapes
separately (they need different remedies), an unknown version, `schema_version: 2` with `projects`
lost to a truncated write, that all three hints DIFFER, that the `next` argument is guarded and not
only `prev`, and the negative control that a null previous snapshot still diffs — because a guard
that refused null would fail every first run and the obvious fix would be to delete it.

**The load-bearing assertion is on the EFFECT, not the throw:** refusing must return no events. A
guard that threw after pushing rows would satisfy every message assertion and still put junk in the
log. Three mutations, each red for its own reason — removing the guard fails 7 of 9; removing it from
the `next` argument alone fails exactly **1**, which is the test that exists for the
`rule:safety-flag-needs-a-test` shape of one path gated and one not; collapsing the three hints into
one fails 5.

**The general form is now `rule:mutate-behind-the-fixture-builder`, and it is deliberately NOT
stated here.** Two instances in two repos from opposite directions cleared this tree's bar for
promoting a project finding to a global rule, so the reasoning lives in the rule and this entry keeps
only what is local to propagate. Restating it here is what produced nine divergent copies of
tool-priority.

**My first framing was wrong and the peer's correction is the reason the rule is useful.** I proposed
widening `rule:discernment-checks` §1 — "ask of every guard test whether its input could ever have
been refused". Their objection: the obligation to mutate is ALREADY in place, in §1 and
`rule:safety-flag-needs-a-test` step 4, and both instances were found by satisfying it. So the gap was
never that nobody knew to mutate; a widened §1 would have added a manual review step duplicating a
mechanical check people already own, *"and it will be skipped in exactly the sessions that skip the
mutation."* What was missing was the signal of WHERE to aim, because nobody mutates every guard — the
sample is chosen by intuition. It landed as a greppable targeting heuristic beside
`rule:name-what-no-test-executes` instead.

### N104 · `migrate --apply` stages into another repo's index with no pre-flight, and took a colleague's commit — **S2** — **RESOLVED 2026-09-28**

**This one I caused, and it is the mirror image of what was reported to me hours earlier.**

`migrate obsidian-vk-publish --apply` ran while a live session in that repo had four uncommitted
files. `git mv` plus `git add` staged two paths into ITS index — the moved register and the pointer
stub. It committed forty seconds later, and `aeee151 feat(review): the JSON payload a review pass
writes, and its refusals` carries 189 of its 728 changed lines as a propagation-layout move.

**My error of practice:** that session had told me its tree was clean, and I treated a statement
about the past as a fact about the present instead of re-reading `git status` immediately before
writing. It was clean when they said so and four files dirty by the time I ran.

**But the practice error is not the defect, and fixing only that would leave this open.** The
refresh hazard they reported to me — *"one `-A` away from being authored by whoever commits next"* —
is about a tool that WRITES. This one STAGES, which is strictly worse: an unstaged file needs
`git add -A` to be swept, a staged one needs only `git commit`. And `git mv` cannot decline to
stage, so no care at the write site helps. The check has to be at the front.

**It took two defects, and they identified theirs before I could.** They had been committing with
`git add <explicit paths> && git commit`, treating the path list as scoping the commit — it does
not, because `git commit` commits the INDEX, whatever else is in it. Their fix is
`git commit -- <paths>`, a pathspec commit that ignores index state. Either defect alone was
harmless; mine put files in an index that could not refuse them.

**The guard: REFUSE, with its own flag.** `dirtyPaths()` before anything is written; any dirt at
all stops the migration, names up to ten paths, and writes nothing. Two decisions worth stating:

- **Refuse rather than warn**, which is the OPPOSITE of the refs refresh's answer in §2, and the
  asymmetry is the point. That refresh warns because it is a scheduled job whose silence recreates
  N55. This is a one-shot operation a person just invoked and is watching, so stopping costs them
  one command and cannot cost anyone their authorship.
- **Refuse on ANY dirt, with no attempt to attribute it.** Their suggestion, and stronger than my
  first draft: deciding whether dirt is "ours" needs a model of what our own writes look like, and
  that model is one more population read from the wrong place — §6's shape again. "Three
  uncommitted files, commit or stash and re-run" needs no such model, and a dirty tree that IS
  yours is also worth stopping on.

**`--allow-dirty`, NOT `--force`.** `--force` already means "hoist a directory that looks like an
undeclared workspace". Overloading it would mean an operator hoisting a subdirectory silently
bypassed a guard against taking a colleague's authorship — one flag serving two situations, which
is the defect N103 spent the previous day removing in four other places. A test asserts `--force`
does NOT waive this.

**`migrate` also left the unvalidated-flags set**, which is the direction `cli-commands.test.mjs`
permits. It had to: a write command that grew a safety flag is the worst place to skip validation,
because a typo'd `--allow-dirtty` would have been accepted in silence and the guard bypassed
without a word. Enumerating its flags makes the typo an error.

**Three pre-existing tests failed for the right reasons and one of them is the best thing here.**
`backlog-proposed-corpus.test.mjs`'s R4 case names two real register files in the tree, and its own
comment says it is a separate test *"so their disappearance from the tree (a migration, a rename) is
itself a loud failure rather than a silent drop"*. My migration moved one of them and it went red
naming the file — the only check in 2261 that noticed the corpus had moved underneath it. Its target
now follows the CONTENT to the v3 path rather than the old path, because the stub left behind is a
different artifact with a different correct classification, and asserting against the old path would
have kept passing while measuring something else.

Five fixtures in `migrate-workspace.test.mjs` now pass `allowDirty: true` explicitly. Their hub
fixture is dirty by construction — it holds a nested git repo that git cannot index, and unlike a
real workspace it does not gitignore it. Measured before weakening anything: **0 of 4 real
workspaces show a nested repo as untracked**, so this is a fixture property and not a production
false positive. Saying so at the call site beat loosening the guard to make tests pass.

**What is left, and it is not mine:** `aeee151` was already pushed when my warning reached them, so
the cheap fix was gone. They chose to leave it and name the mislabelling in their next commit
message rather than force-push a branch other sessions may track — the right trade, and their
correction to my framing of the cost is worth keeping: it is not only mislabelled authorship, it is
that anyone bisecting that feature now has to know to ignore two files. Three files of mine are
still untracked in their repo (`propagation/README.md`, `propagation/INDEX.md`,
`propagation/state/workspace/.sidecar.yml`) and they have declined to sweep them.

### N103 · A pointer stub that points OUT of its repo was reported as dangling, and the refresh wrote into dirty trees without saying so — **S2** — **RESOLVED 2026-09-27**

Both reported by the session working in `Vipin Kaushik/obsidian-vk-publish`, and both verified
here before acting. A peer finding two real defects in one message is the best argument yet for
`rule:adversarial-review-reads-the-ledger` — neither was visible from inside this repo.

**1 · The stub check asked the wrong question.** `planMigration` only ever asked *does MY
computed destination exist?* For a project inside a workspace that keeps state at
`<workspace>/propagation/state/<project>/`, the real file is one level UP and outside the repo
entirely — so a correct, deliberate stub was reported `dangling stub` and the migration refused.

That is backwards for the layout `rule:state-and-decisions` now makes the DEFAULT. Per-repo
`STATE.md` is the deviation; the stub IS the intended end state. Verified on the real pair:

```
obsidian-vk-publish/STATE.md          -> ../propagation/state/obsidian-vk-publish/STATE.md     EXISTS (889 lines)
obsidian-vk-publish/docs/DECISIONS.md -> ../../propagation/…/DECISIONS.md                      EXISTS (511 lines)
```

`stubTarget()` / `stubTargetResolves()` now read the path the stub DECLARES and resolve it
relative to the stub — `../` from the repo root and `../../` from `docs/` are the same
destination at two depths. Both now report *"already migrated, nothing to move"*, naming the
target. The negative control is the load-bearing one: a stub pointing at nothing is STILL a
conflict, and an unreadable target reads as unresolved rather than fine — otherwise the fix
would silence genuinely broken signposts instead of correcting the question.

**2 · The refresh wrote into dirty trees silently, and it had already cost something.** The
refs refresh created `propagation/refs/*` in that repo while it had uncommitted work, and the
next `git add -A` swept those files into an unrelated commit (`824d079`). In the reporter's
words: *"one `-A` away from being authored by whoever commits next."*

**Warned, not refused, and that is deliberate.** Refusing would stop the refresh for any
workspace with uncommitted work — most of them, most of the time — and a refresh that silently
stops happening is N55, the issue this rider exists to fix. So it writes, and the digest names
the workspace. Unreadable git state is its own outcome, never "clean".

**Refined the same day, on the reporter's second message, and their version is better.** The
first fix sampled the tree BEFORE the write, which is correct for the question *"was it dirty
when we wrote?"* — and that turned out to be the wrong question. Their argument:

> "The warning is most useful **after** the write, addressed to whoever commits next, and it
> currently goes to the log of a 09:00 job nobody reads. If the files it wrote are still
> untracked on the next run, that is the moment worth warning at — the first warning was
> advice, the second is evidence it went unread."

So `treeDirty()` is gone and `refsUntracked()` replaced it: `git ls-files --others
--exclude-standard -- propagation/refs`, sampled AFTER the write. Three things change. The
warning repeats every run until the files are committed and **stops by itself** once they are,
so it cannot become permanent furniture. It no longer fires on a tree that is dirty for reasons
that are nobody's business but the owner's — only on output this tool produced. And a tree that
is dirty at write time but committed by evening never warns at all, which is the case where the
old warning was pure noise.

The test moved with it, from a source assertion to a real one: `refsUntracked` is exported and
run against a temp repo through all four states — empty, freshly written, unrelated-work-present,
committed — plus the unreadable path, which must be `null` and never `0`. It was a read-only
`git` call all along, so there was never a reason not to execute it
(`rule:name-what-no-test-executes`). Both mutations go red for their own stated reason: making
unreadable return `0` fails the §2 assertion, and dropping the `-- propagation/refs` pathspec
fails *"the warning is about OUR output, not about the state of their tree."*

**3 · The baseline evidence string read as a complaint, and someone deleted the file.** Also
theirs, and it had already cost something before it was reported: a session read a first-run
baseline snapshot as an accusation that something had gone wrong and removed it — which
silently restarts drift detection from zero. In their words: *"I read three things that were
each true as one thing that was false — something wrote a bogus baseline in the wrong place."*
The replacement wording is theirs verbatim; they named its load-bearing parts as the last clause
and the word "expected". `lib/refs/snapshot.mjs` now says a baseline is expected on a first run,
not a gap, that future runs diff against it, and that deleting it restarts detection from zero.

**4 · SETTLED, and the answer exposed a defect in fix 1.** Rupali: *"yes that is a workspace
under vk."* The peer's read was the opposite — a project inside `Vipin Kaushik` that carries a
sidecar only because it has nineteen real edges to declare — and they questioned whether
propagate infers workspace-hood from a sidecar's presence. **It does not, and checking rather
than relaying that was the right call:** `classifyMarker` requires a strict `workspace: true`
and `obsidian-vk-publish/.propagates.yml:15` declares exactly that. Nothing was inferred; the
file says so, and discovery lists it as workspace 18 of 20.

So the classification was never ambiguous in the data — and with it settled, fix 1 is wrong in
a way that only this answer could reveal:

| | says |
|---|---|
| `.propagates.yml:15` | `workspace: true` |
| discovery | workspace, 18 of 20 |
| its own `propagation/refs/` | present — the per-workspace artifact |
| its STATE / DECISIONS / GOTCHAS | **133 KB in `Vipin Kaushik/propagation/state/obsidian-vk-publish/`** — the PROJECT slot |
| its own `propagation/state/` | **does not exist** |
| the stubs' own text | *"propagation/ owns state and decisions for every project in this workspace"* |
| `migrate`, before today | *"already migrated, nothing to move"* |

`stubTargetResolves` asks *does the declared target exist?* and stops. It cannot distinguish a
PROJECT pointing out to `<workspace>/propagation/state/<name>/`, which is the default layout and
correct, from a WORKSPACE pointing at its parent's project slot, which is a misplacement. Both
resolve. `rule:discernment-checks` §6 — a reader answering a narrower question than the one
asked, and answering it reassuringly. It is the same shape as **G71, blind in both directions**,
applied to a predicate: the check was defended against resolving to *nothing* and not against
resolving to the *wrong kind of place*.

`stubPlacement(stubPath, root)` now returns `inside` / `outside` / `dangling` / `not-a-stub` —
four words, because the caller's decision differs for each — and `declaresWorkspace()` reads the
marker through `classifyMarker`, the same function discovery uses, so the two cannot answer
"is this a workspace" differently. An outward stub in a declared workspace is now a **conflict**
naming both readings: *"the stub says project, the marker says workspace."*

**Conflict rather than an automatic move, deliberately.** The real files are large, live, and in
a different repo; relocating them silently would be this command settling a question about
another tree. The test pair is the whole point — same stub, same target, one line of marker
different, and the correct verdict inverts. The peer's case is asserted still working, and a
typo'd `workspace: "true"` promotes nothing, matching discovery's strictness.

**5 · AND THE STATE DOES NOT MOVE — which made the new conflict correct in shape and wrong in
this instance.** Rupali, relayed the same hour: the consolidation stays, `workspace: true` stands.
So `obsidian-vk-publish` is a declared workspace that consolidates its state UPWARD into
`Vipin Kaushik`, deliberately. `rule:state-and-decisions` carries the reason and it is not local
to that pair: seven projects, seven git repos, six branches, and every check that read per-repo
state needed bespoke cross-repo, cross-branch machinery. Moving 148 KB back out would undo exactly
that and strand this state on a feature branch in a second repo.

Nothing had to be undone, because nothing was moved — the decision was left to a person, which is
the one part of this sequence that went right first time. What had to change is the VERDICT: fix 4
would have reported a correct tree as two conflicts forever, and
`lib/report/doctor/workspaces.mjs:340-343` already records why that is its own defect — *a
permanently-red check trains people to ignore it.* Naming a real shape is worth nothing if the
name is wrong in the instance you ship it against.

`consolidatesUpward()` closes it: an outward stub aimed at the parent workspace's own slot for
this repo is a LAYOUT, reported as a skip that says *"consolidated upward deliberately"* so the
next reader does not "fix" it. Any other outward target is still a conflict, which is what keeps
the check meaningful.

**DERIVED, not declared, and that was the choice worth making.** The peer offered a sidecar
opt-out key as the fallback. Every consolidating workspace would have had to remember it, and the
ones that forgot would read as faults — G70, a curated inclusion list silently fails to grow,
where a derived population grows for free. So it asks the disk instead: the parent must itself
declare `workspace: true` AND own the slot for this basename. The negative control is the
load-bearing test — with an undeclared parent it is still a conflict, without which consolidation
would be inferred from path shape alone and every outward stub excused.

**6 · The stub-driven check was blind to anything that left no signpost.** Found by Rupali running
the dry run and the plan's silence being read rather than skimmed. `STATE.md` and
`docs/DECISIONS.md` have stubs, so fix 4 saw them. **`GOTCHAS.md` — 53 KB, the largest of the
three — has no stub anywhere in that repo** (confirmed with `git ls-files`, not `find`, per G-L),
so it produced ZERO rows. Acting on that plan would have addressed two artifacts and left the
biggest silently behind, and the silence was indistinguishable from "no such file" —
`rule:discernment-checks` §2 again, two levels deep in the same fix.

The population is now DERIVED from the parent's slot rather than from local signposts. Under a
deliberate consolidation a parked artifact is not a fault, so it is a **note**, not a conflict —
but it is still reported, and the finding it carries is real and is about that repo rather than
about propagate: *STATE and DECISIONS are findable from inside the plugin repo and GOTCHAS.md is
not, so a reader standing there cannot discover it.* The peer is rewriting the stub text, which
says "every project in this workspace" about something that is not a project — the sentence that
made the layout look deliberate to both of us, in the one way it was not.

**7 · And the replacement check was itself too narrow — caught before it ever shipped.** Found
2026-09-28 while deciding what to stage, by reading the hub's own working tree rather than trusting
the check: the scheduled refresh had modified **two TRACKED files** under
`~/Documents/GitHub/propagation/refs/`, and `refsUntracked` reported **0**.

`git ls-files --others` answers "what is untracked". The hazard is `git add -A`, and `-A` sweeps a
modified tracked file exactly as it sweeps an untracked one. Worse, modified is the COMMON case: a
registry is untracked exactly once, on the run that creates it, and modified on every run after —
so the check would have gone quiet permanently after the first adoption, on the very repos where
the refresh runs most often. It is now `git status --porcelain -- propagation/refs`, which covers
untracked, unstaged and staged-not-committed; all three are swept and all three are still
unadopted. `refsUncommitted`, not `refsUntracked`, because that is the question.

The test gained the two cases the old one could not reach — modify a committed registry, then stage
it — and both must still report 1. Staging is not committing.

**Four defects, one shape, inside thirty hours:** a string written for one situation applied
to a second (the peer's baseline), a predicate written for one situation applied to a second
(`stubTargetResolves`), and a population read from signposts rather than from the ground
(`GOTCHAS.md`). Each was right where its author was looking. G71's *blind in both directions*
generalises past extraction: every one of them failed by matching the wrong thing, not nothing,
and so returned a pass.

