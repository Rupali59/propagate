**Open work lives in [GitHub issues](https://github.com/Rupali59/propagate/issues), not in this file.** On 2026-10-12 every
OPEN and BLOCKED entry moved there — full text, client names scrubbed by `lib/core/public-scrub.mjs`, the same
function `make-public` uses, because the repo is public. File new work there. This file keeps the resolved history;
each moved entry left a `**MOVED** → #n` heading so every `N<k>` citation in the tree still resolves.

> Moved: [N22](https://github.com/Rupali59/propagate/issues/23) → #23 · [N35](https://github.com/Rupali59/propagate/issues/24) → #24 · [N38](https://github.com/Rupali59/propagate/issues/25) → #25 · [N42](https://github.com/Rupali59/propagate/issues/26) → #26 · [N52](https://github.com/Rupali59/propagate/issues/27) → #27 · [N54](https://github.com/Rupali59/propagate/issues/28) → #28 · [N58](https://github.com/Rupali59/propagate/issues/29) → #29 · [N60](https://github.com/Rupali59/propagate/issues/30) → #30 · [N61](https://github.com/Rupali59/propagate/issues/31) → #31 · [N62](https://github.com/Rupali59/propagate/issues/32) → #32 · [N63](https://github.com/Rupali59/propagate/issues/33) → #33 · [N64](https://github.com/Rupali59/propagate/issues/34) → #34 · [N66](https://github.com/Rupali59/propagate/issues/35) → #35 · [N67](https://github.com/Rupali59/propagate/issues/36) → #36 · [N72](https://github.com/Rupali59/propagate/issues/37) → #37 · [N74](https://github.com/Rupali59/propagate/issues/38) → #38 · [N75](https://github.com/Rupali59/propagate/issues/39) → #39 · [N77](https://github.com/Rupali59/propagate/issues/40) → #40 · [N79](https://github.com/Rupali59/propagate/issues/41) → #41 · [N80](https://github.com/Rupali59/propagate/issues/42) → #42 · [N81](https://github.com/Rupali59/propagate/issues/43) → #43 · [N83](https://github.com/Rupali59/propagate/issues/44) → #44 · [N85](https://github.com/Rupali59/propagate/issues/45) → #45 · [N86](https://github.com/Rupali59/propagate/issues/46) → #46 · [N88](https://github.com/Rupali59/propagate/issues/47) → #47 · [N90](https://github.com/Rupali59/propagate/issues/48) → #48 · [N91](https://github.com/Rupali59/propagate/issues/49) → #49 · [N92](https://github.com/Rupali59/propagate/issues/50) → #50 · [N93](https://github.com/Rupali59/propagate/issues/51) → #51 · [N94](https://github.com/Rupali59/propagate/issues/52) → #52 · [N95](https://github.com/Rupali59/propagate/issues/53) → #53 · [N96](https://github.com/Rupali59/propagate/issues/54) → #54 · [N98](https://github.com/Rupali59/propagate/issues/55) → #55 · [N100](https://github.com/Rupali59/propagate/issues/56) → #56 · [N106](https://github.com/Rupali59/propagate/issues/57) → #57 · [N108](https://github.com/Rupali59/propagate/issues/58) → #58 · [N109](https://github.com/Rupali59/propagate/issues/59) → #59 · [N110](https://github.com/Rupali59/propagate/issues/60) → #60 · [N111](https://github.com/Rupali59/propagate/issues/61) → #61 · [N112](https://github.com/Rupali59/propagate/issues/62) → #62 · [C1](https://github.com/Rupali59/propagate/issues/63) → #63 · [C2](https://github.com/Rupali59/propagate/issues/64) → #64 · [G2](https://github.com/Rupali59/propagate/issues/65) → #65 · [E1](https://github.com/Rupali59/propagate/issues/66) → #66 · [E2](https://github.com/Rupali59/propagate/issues/67) → #67 · E3 → #2 (duplicate)

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
> const D=/\*\*(OPEN|RESOLVED|BLOCKED|ACCEPTED|APPLIED, UNVERIFIED|WITHDRAWN|MOOT|MOVED)\b/;
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
> | `MOVED` | the entry now lives in a GitHub issue, linked beside it (2026-10-12) |
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

### N22 · Glob expansion correlates states, so raw expanded counts mislead a future drain UI — **S3, design** — **MOVED** → [#23](https://github.com/Rupali59/propagate/issues/23) (2026-10-12; the full entry is there)

## Coverage

### C1 · Nothing reports what is *not* declared — **S1** — **MOVED** → [#63](https://github.com/Rupali59/propagate/issues/63) (2026-10-12, triaged live; the full entry is there)

### C2 · The ledger reads as a forensic record and is not one — **S2** — **MOVED** → [#64](https://github.com/Rupali59/propagate/issues/64) (2026-10-12, triaged live; the full entry is there)

---

## Branch and merge blindness

*Re-ranked S2 → S1 on 2026-08-13, following the premise change (`docs/DECISIONS.md` 2026-08-13):
propagate coordinates parallel work across branches/worktrees/repos, not doc staleness. Under that
premise, branch-blindness is not noise — it is the coupling the tool exists to hold, silently
failing on exactly the case that matters most.*

### B2 · Squash merges defeat ancestry checks — **S1** — **RESOLVED 2026-10-12** (triaged: `lib/refs/snapshot.mjs:103` decides merged refs with `git cherry`, and `rule:absence-claims-need-state-and-branch` documents it)
*(was S2; re-ranked 2026-08-13 — see note above)*

13 branches read as unmerged by `git branch --merged` while their content was live in production.
`git cherry` (patch-id) sees through it. A git property rather than a skill bug — but it produced a
wrong conclusion about lost work, and the skill is the natural place to document it.

---

## The commit-time gate

### G2 · `--changed` is a documented no-op, not a parse failure — **S3** — **corrected 2026-08-13** — **MOVED** → [#65](https://github.com/Rupali59/propagate/issues/65) (2026-10-12, triaged live; the full entry is there)

### G3 · The gate is documented but not installed — **S2** — **RESOLVED 2026-10-12** (triaged: `.githooks/pre-commit` runs `check --staged` via `core.hooksPath`, and doctor checks installed hooks for liveness, `cli.mjs:694`)
`SKILL.md` describes a pre-push hook. Nothing installs it, and no repo in the workspace has one.
`check` is read-only, correct, and hook-safe — it is simply unused.

---

## Noise

### E1 · Reorg edits are indistinguishable from content edits — **S2** — **MOVED** → [#66](https://github.com/Rupali59/propagate/issues/66) (2026-10-12, triaged live; the full entry is there)

### E2 · Declare-ahead warnings never expire — **S3** — **MOVED** → [#67](https://github.com/Rupali59/propagate/issues/67) (2026-10-12, triaged live; the full entry is there)

### E3 · No way to record "deliberately not declared" — **S2** — **MOVED** → [#2](https://github.com/Rupali59/propagate/issues/2) (2026-10-12; the same issue, filed there on 2026-08-18)

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

### N35 · `selftest` proves self-match, not wild-match — 7 rules are unexercised — **S2** — **MOVED** → [#24](https://github.com/Rupali59/propagate/issues/24) (2026-10-12; the full entry is there)

### N38 · The private→public coupling has no watcher — `release --check` step 3 is a procedure, not a check — **S2** — **MOVED** → [#25](https://github.com/Rupali59/propagate/issues/25) (2026-10-12; the full entry is there)

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

### N42 · `renderMarkdown` has no live caller, and the file it renders is hand-written — **S2** — **MOVED** → [#26](https://github.com/Rupali59/propagate/issues/26) (2026-10-12; the full entry is there)

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

### N52 · `migrate-refs`'s markdown renderer prints `undefined` and misplaces paths into the ref column — **S3** — **MOVED** → [#27](https://github.com/Rupali59/propagate/issues/27) (2026-10-12; the full entry is there)

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

### N54 · The gotchas liveness probe counts pointer stubs as inert files, inflating its own headline — **S3** — **MOVED** → [#28](https://github.com/Rupali59/propagate/issues/28) (2026-10-12; the full entry is there)

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

### N57 · `claudeMdExcludes` is unset, so 76,038 B of non-rules load as memory every session — **S2** — **CLOSED 2026-10-02** (applied 2026-08-29; verified in a post-change session)

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

**EVIDENCE 2026-10-02 (a fresh session, observed rather than inferred).** An `InstructionsLoaded`
hook, installed temporarily for the plan `budget-1-rules-headroom` T1 proof and logging to
`~/.propagate/instructions-loaded-T1-20261002.jsonl`, recorded a fresh Tathya session's
`session_start` loads: **35**, set-equal to the 35 files predicted from the disk walk minus
`claudeMdExcludes` (0 missing, 0 extra) — `conventions/`, `_TODO.md` and `gotchas-global.md`
are ABSENT from the log. The startup warning total, `35 files, 152.8k`, matched the predicted
152,788 chars exactly. So the exclusion did take effect in a live session, which is the
direct observation the three-question probe above was waiting for. Same T1 run: adding `paths:`
to `nextjs-dev-server-port` dropped the total to `34 files, 150.2k` (−2,609), and a main-session
Read of a matching file in the cwd project loaded it (`load_reason: path_glob_match`).
**Status line deliberately NOT changed by this agent:** the entry says to close it by asking a
post-change session the three questions, and this evidence is the logged-load equivalent of
the PRESENT/ABSENT answers but not the third question (body appears ONCE vs TWICE) verbatim —
whether that closes N57 is Rupali's call under this register's own rule, so the disposition
is left to her. Revert hazard recorded in `hooks/load-rules.mjs`: dropping `claudeMdExcludes`
re-adds ~60k chars to every session.

**CLOSED 2026-10-02 — the three questions, answered by a session started that day (well after the
2026-08-29 11:55 change; session start checked against the change per the method note above).**

1. *"brain_score is not a health metric" — expect ABSENT.* **The probe had gone blind**: the string
   no longer exists in any file under `rules/` (node walk, 2026-10-02), so "absent" could not fail.
   Answered instead by direct evidence: this session's injected memory lists no file from
   `conventions/`, no `_TODO.md` and no `gotchas-global.md`; and the fresh-session
   `InstructionsLoaded` log above (35 loads, set-equal to the prediction) contains none of them.
2. *"Verify the instrument before believing a surprising number" — expect PRESENT.* **PRESENT** —
   it is `discernment-checks` §4's heading, in this session's injected rules.
3. *Does the body of `rules/discernment-checks.md` appear ONCE or TWICE?* **ONCE** — one injected
   copy; the SessionStart hook says it stopped injecting bodies, and its payload measures
   907 B (`node hooks/load-rules.mjs | wc -c`), not the old 51,112 B.

General form worth keeping: **a closing probe written as a literal string rots with the file it
quotes** — question 1 went blind silently. A probe should name what it checks (a file that must be
absent from the loaded set), not a sentence that may be edited away.

---

### N58 · A live decision sits untracked at a retired path that `doctor` never reads — **S2** — **MOVED** → [#29](https://github.com/Rupali59/propagate/issues/29) (2026-10-12; the full entry is there)

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

### N60 · Decision-entry identity is POSITIONAL for 20 of propagate's own 36 entries — **S2** — **MOVED** → [#30](https://github.com/Rupali59/propagate/issues/30) (2026-10-12; the full entry is there)

### N61 · Five ledgers parse to 0 entries, and the fix as first designed would have made it silent — **S2** — **MOVED** → [#31](https://github.com/Rupali59/propagate/issues/31) (2026-10-12; the full entry is there)

### N62 · `scope:` no longer filters delivery; convert `nextjs-dev-server-port` to native `paths:` — **S3** — **MOVED** → [#32](https://github.com/Rupali59/propagate/issues/32) (2026-10-12; the full entry is there)

### N63 · `referencedRestatements` is dominated by false positives — the shape N35 asserts was never sampled — **S2** — **MOVED** → [#33](https://github.com/Rupali59/propagate/issues/33) (2026-10-12; the full entry is there)

### N64 · `rules promote` is declared in three places and built in none — **S3** — **MOVED** → [#34](https://github.com/Rupali59/propagate/issues/34) (2026-10-12; the full entry is there)

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

### N67 · `rotted-citation` cannot tell a live citation from a recorded supersede — **S3** — **MOVED** → [#36](https://github.com/Rupali59/propagate/issues/36) (2026-10-12; the full entry is there)

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

### N66 · `make-public` refuses because its watchlist does not recognise propagate's own directories — **S2** — **MOVED** → [#35](https://github.com/Rupali59/propagate/issues/35) (2026-10-12; the full entry is there)

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

### N72 · The restatement pairer anchors on the heading, so real restatements are never examined — **S2** — **MOVED** → [#37](https://github.com/Rupali59/propagate/issues/37) (2026-10-12; the full entry is there)

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

### N74 · The restatement walk pairs the FIRST judgeable block, which is often the citation — **S3** — **MOVED** → [#38](https://github.com/Rupali59/propagate/issues/38) (2026-10-12; the full entry is there)

### N75 · `plans --check` counts subagent plan-mode artifacts as authored plans — **S2** — **MOVED** → [#39](https://github.com/Rupali59/propagate/issues/39) (2026-10-12; the full entry is there)

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

### N100 · Git worktree copies are counted as workspaces, so the same tree is graded twice — **S3** — **MOVED** → [#56](https://github.com/Rupali59/propagate/issues/56) (2026-10-12; the full entry is there)

### N83 · Hub `CLAUDE.md` currency is enforced for 4 of 16 workspaces — the other nine can rot invisibly — **S3** — **MOVED** → [#44](https://github.com/Rupali59/propagate/issues/44) (2026-10-12; the full entry is there)

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

### N81 · Five more files colocate a machine-parsed grammar with append-only churn — N77's shape, before it bites — **S3** — **MOVED** → [#43](https://github.com/Rupali59/propagate/issues/43) (2026-10-12; the full entry is there)

### N80 · `readGotchas` computes the trigger count and `row()` drops it, so gotcha LIVENESS reaches no reader — **S3** — **MOVED** → [#42](https://github.com/Rupali59/propagate/issues/42) (2026-10-12; the full entry is there)

### N79 · `rules list` reports a RELEVANCE verdict from a scan of one file type, and calls the three most-cited rules in the tree `unexercised` — **S2** — **MOVED** → [#41](https://github.com/Rupali59/propagate/issues/41) (2026-10-12; the full entry is there)

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

### N86 · The DECISIONS.md gate is a CONTRACT living in two client workspaces, forked, with cutoff dates five weeks apart — **S2** — **MOVED** → [#46](https://github.com/Rupali59/propagate/issues/46) (2026-10-12; the full entry is there)

### N85 · 83% of edges with ENOUGH history to have a ratio are majority `no-change-needed` — N77 is not an outlier — **S2** — **MOVED** → [#45](https://github.com/Rupali59/propagate/issues/45) (2026-10-12; the full entry is there)

### N77 · A `kind: code` edge fires on the whole file while coupling only a HEADER — 7 of 10 dispositions on one edge are `no-change-needed` — **S3** — **MOVED** → [#40](https://github.com/Rupali59/propagate/issues/40) (2026-10-12; the full entry is there)

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

### N88 · Discovery counts abandoned git worktrees as workspaces, and their warnings are indistinguishable from real ones — **S3** — **MOVED** → [#47](https://github.com/Rupali59/propagate/issues/47) (2026-10-12; the full entry is there)

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

### N90 · `duplicatePairs` has no disposition path — a finding the tool can name but never let a human close — **S3** — **MOVED** → [#48](https://github.com/Rupali59/propagate/issues/48) (2026-10-12; the full entry is there)

### N91 · `doctor.duration_ms` spikes recur at 18-24 minutes, most recently in the last 24 hours — **S2** — **MOVED** → [#49](https://github.com/Rupali59/propagate/issues/49) (2026-10-12; the full entry is there)

### N92 · The plugin-file pathspec answers two different questions with one list, so a docs-only commit counts toward the release bound — **S3** — **MOVED** → [#50](https://github.com/Rupali59/propagate/issues/50) (2026-10-12; the full entry is there)

### N93 · `docs/SYSTEMS.md`'s `gotcha-guard` probe cannot run, and its row makes three false claims about a component that is alive — **S2** — **MOVED** → [#51](https://github.com/Rupali59/propagate/issues/51) (2026-10-12; the full entry is there)

### N94 · A gotcha trigger matches command text inside a commit message, so writing about a hazard fires it — **S3** — **MOVED** → [#52](https://github.com/Rupali59/propagate/issues/52) (2026-10-12; the full entry is there)

### N95 · `fs.existsSync` gets a non-string somewhere in the digest path, and the source is unlocated — **S3** — **MOVED** → [#53](https://github.com/Rupali59/propagate/issues/53) (2026-10-12; the full entry is there)

### N96 · The three components that deliver and verify rules each compute the rules directory independently — **S2** — **MOVED** → [#54](https://github.com/Rupali59/propagate/issues/54) (2026-10-12; the full entry is there)

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

### N98 · `GOALS.md` is the one register with no update mechanism — every goal reports `open` forever, and nothing can say a goal's premise rotted or that a project has none — **S2** — **MOVED** → [#55](https://github.com/Rupali59/propagate/issues/55) (2026-10-12; the full entry is there)

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

### N108 · The leftover-cache check names the first stale tree it finds, not the population — **S3** — **MOVED** → [#58](https://github.com/Rupali59/propagate/issues/58) (2026-10-12; the full entry is there)

### N109 · `digest.mjs`'s `GITHUB_ROOT` is `SEARCH_ROOTS[0]`, which is not the hub — the disk section measures 12% of the tree — **S2** — **MOVED** → [#59](https://github.com/Rupali59/propagate/issues/59) (2026-10-12; the full entry is there)

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

### N110 · `supersedes:` is frontmatter that no code reads — every rule declares it and nothing acts on it — **S3** — **MOVED** → [#60](https://github.com/Rupali59/propagate/issues/60) (2026-10-12; the full entry is there)

### N111 · `selftest` PASSES a rule with no probes, so its headline result is weaker than the line beside it — **S2** — **MOVED** → [#61](https://github.com/Rupali59/propagate/issues/61) (2026-10-12; the full entry is there)

### N117 · The cross-repo ledger resolved inside a nested search root, so its rows were ownerless and a `--cross` write would have landed in a gitignored directory — **S2** — **RESOLVED 2026-09-30**
Found 2026-09-30 by following `doctor`'s "1 ledger file(s) on disk that no workspace owns" to its cause
instead of patching the symptom.

**`CROSS_LEDGER_JSONL` was derived from `SEARCH_ROOTS[0]`,** and on this machine that is
`Rupali/Experiments`:

```
CROSS_LEDGER_JSONL -> <hub>/Rupali/Experiments/PROPAGATION_CROSS_LEDGER.jsonl   (never existed)
the real file      -> <hub>/propagation/PROPAGATION_CROSS_LEDGER.jsonl          (owned by nobody)
```

`doctor` builds `ownedLedgers` as `[...WORKSPACES.map(w => w.ledgerJsonl), CROSS_LEDGER_JSONL]`, so the
real file was never in the owned set and its rows were reported invisible to `status`/`reconcile`.
**0 rows today, which is the only reason this cost nothing** — the file is empty.

**The write path is the part that matters.** `freeze-ledger --cross --apply` (`cli.mjs`) sets
`ledgerOverride = { jsonl: CROSS_LEDGER_JSONL, md: CROSS_LEDGER_MD }`, so a cross-repo freeze would
have written into `Rupali/Experiments/` — a **gitignored** directory, untracked, and not the path any
reader of record expects.

**Two comments already asserted the behaviour the code did not have:** `lib/edges/ledger.mjs` —
*"`CROSS_LEDGER_JSONL` is derived from the hub, so it is null when no hub is declared"* — and
`cli.mjs`'s freeze branch — *"the cross-repo one shares the hub's propagation/ dir"*. Neither was
true. Both are true now, which is the direction to fix such a pair in: bring the code to the claim
when the claim is the correct design.

**IT IS [[n101]] IN A SECOND PLACE.** `artifactPath()` resolved `ECOSYSTEM.md` from `SEARCH_ROOTS[0]`
for the same reason and was fixed by taking `hubRoot` explicitly — *"`searchRoots` is a DISCOVERY
setting… ordered for the walk, not to name the tree"*. The class was not swept, so the fix landed at
the site where the symptom had been seen. `lib/edges/ledger.mjs`'s own header describes that exact
failure about a different bug in the same file: *"the fix had been applied to the sites where a crash
was OBSERVED rather than to the class."* Third recorded instance of `SEARCH_ROOTS[0]` standing in for
the hub, counting `rule:measure-the-claim-not-a-proxy`'s instance table.

**Resolved by** a pure `crossLedgerRoot({ hubRoot, roots })` in `lib/core/config.mjs`, mirroring
`artifactPath`'s signature. **It takes `roots` and ignores it deliberately:** the property is "the hub
wins over whichever search root sorts first", and a resolver accepting only `hubRoot` makes the
violating input inexpressible, so the test would assert nothing while looking thorough
(`rule:mutate-behind-the-fixture-builder`). G24's `?? null` sentinel is preserved — an unconfigured
machine must resolve to null and be refused loudly, never to a plausible wrong path.

**5 tests in `tests/unit/cross-ledger-root.test.mjs`**, and two of them exist because the first
draft was wrong:

- the hub wins over a nested `roots[0]`; search-root ORDER cannot move the file; the null sentinel holds
- **the WIRING, on a fixture whose `searchRoots[0]` is not the hub.** The first version of this read
  the LIVE config and opened `if (!HUB_ROOT) return;` — and under `npm test` the scoped state dir has
  no config, so `HUB_ROOT` is null, `SEARCH_ROOTS` is `[]`, and it passed in 0.4ms asserting nothing.
  It was the one test that stayed green under the mutation that reddened the other three. Same trap
  `tests/cli/doctor-census-parity.test.mjs` records about its own first draft.
- **the LEGACY un-relocated layout**, added after the fixture test failed for a reason that was about
  the fixture: `crossLedgerRelocated` stats the FILE, not the directory, so creating only
  `propagation/` fell back to the hub-root filename. That fallback carried the same bug and needed
  its own case — fixing only the relocated branch would leave every un-migrated install pointing into
  a nested root.

Mutating the resolver away reds the unit cases for their stated reasons.

**THE FIRST FIX WAS WRONG, AND THE SUITE CAUGHT WHAT MY UNIT TEST ASSERTED.** I wrote
`hubRoot ?? null`, and my own test asserted that no hub resolves to null "per G24's sentinel".
That reddened **8 pre-existing tests** — 7 in `tests/portability/cross-ledger-cascade.test.mjs`,
including one named *"END TO END: status --cross reports real rows at the root path, not '0 open'
(the exact regression that was caught)"*, plus the config export-surface gate. Those fixtures
configure `PROPAGATE_SEARCH_ROOTS` and **no hub**, which G24 says is every install predating the
`hubRoot` key — so nulling the fallback would have taken the cross-ledger away from all of them.

The correct shape is three-way, and `artifactPath()` already had it:
`hubRoot ?? roots[0] ?? null`. The hub wins when declared (the N117 fix), `roots[0]` remains the
pre-`hubRoot` fallback, and null is reached only when neither exists — which is where G24's
sentinel actually lives. My unit test had encoded a stricter rule than the codebase's own
precedent for the sibling path, and it passed while eight others failed.

**Two things worth keeping from that.** A unit test agreeing with the change it was written
beside is not evidence — it was written from the same wrong premise. And the export-surface gate
(`tests/portability/paths-migration.test.mjs`) refused `crossLedgerRoot` until it was declared,
which is the allowlist direction working: forget to add an entry and the check FIRES, rather than
silently not looking (`rule:derive-dont-curate`).

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


### N112 · `description-standard`'s fingerprint matches its body but no single LINE, so a real restatement would report line 0 — **S3** — **MOVED** → [#62](https://github.com/Rupali59/propagate/issues/62) (2026-10-12; the full entry is there)

### N106 · A v1 ledger frozen under its ORIGINAL name would be indexed as live rows — containment rests on naming, not structure — **S3** — **MOVED** → [#57](https://github.com/Rupali59/propagate/issues/57) (2026-10-12; the full entry is there)

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


### N118 · `verify --disposition decoupled` on a GLOB-matched edge deletes the whole glob entry, unwatching every file it matched — **S2** — **RESOLVED 2026-10-03, v0.15.17** (was: `runDecoupled` → `applyDecoupledEdit` splices `propagates_to[loc.index]` with no glob check, cli.mjs ~3231)
Found 2026-10-03 by a dry run, before applying, while settling the 19 `rules/discernment-checks.md →
*/GOTCHAS.md` edges. The intent was to decouple ONE pointer stub (`Tushar/docs/GOTCHAS.md`,
edge aee21c00). The dry run said:

```
would decouple aee21c00  remove sources."rules/discernment-checks.md".propagates_to[0]
  (downstream: */docs/GOTCHAS.md, ...) from <hub>/.propagates.yml
```

`propagates_to[0]` is the `*/docs/GOTCHAS.md` glob itself. Applied, it would have dropped the
edge for every workspace-level GOTCHAS.md the glob matches, to settle one stub — and the event
would record `decoupled` against a single edge id, so the ledger would describe a narrow act
while the sidecar recorded a wide one.

**Cost: none, by luck of reading the dry-run line.** The printed edit names the glob, but
nothing flags that the declaration covers N other edges; it reads like a per-edge removal.

**Fix shape:** when the located declaration's `path` is a glob, refuse `decoupled` (exit 3)
and name the sibling edges it would also unwatch; the per-file opt-out needs its own mechanism
(see TODOS — glob exclusion / stub skip, O9). Test per `rule:safety-flag-needs-a-test`:
snapshot the sidecar, run `decoupled --apply` on a glob edge, assert the sidecar is unchanged.

**What was done instead:** the three stub edges were recorded `no-change-needed` with the
reason "pointer stub — nothing to restate or contradict; real file watched by the
`*/propagation/state/*/GOTCHAS.md` glob".

**Disposition (2026-10-03, v0.15.17): RESOLVED.** `runDecoupled` now refuses (exit 3, dry run and `--json` included) when the located
declaration is a glob and the row is a concrete match, naming the sibling count and pointing at the new `exclude:` key. The UNMATCHED glob
identity stays decouple-able. Test: `N118: decoupled on a glob-matched edge is refused and neither the sidecar nor the event store changes`
in `tests/cli/verify-refusals-and-stamps.test.mjs`. The per-file opt-out is `exclude:` (`expandDownstream`, `lib/edges/reconcile.mjs`).


### N119 · `verify --disposition decoupled --apply` on an UNMATCHED glob row edits the sidecar, then fails the event write (exit 1) — **S3** — **RESOLVED 2026-10-03** (`runDecoupled`, cli.mjs; reconcile.mjs UNMATCHED `makeRow` carries no `source.contentId`)
Found 2026-10-03 while writing the N118 test for "decoupling an UNMATCHED glob stays allowed". Output:
`sidecar edit landed but the event write failed: appendEvent: event ... — disposition "decoupled" pins a pair and is missing field "source_content"`.
The UNMATCHED row is built with `source: { path, ref }` only, so `payload.source_content` is `null` and `validateEvent` refuses it.
**Cost:** the sidecar loses the dead glob but the ledger has no `decoupled` event, and the run exits 1 — the disagreement N118's own
ordering comment ("sidecar edit first") says to avoid, in the other direction. Pre-existing (the N118 guard does not touch this path);
discovered, not introduced. Fix shape: resolve the source content for an UNMATCHED row (the source exists even though the glob matches
nothing) or let `decoupled` carry a content-less event.

**Resolved 2026-10-03 (v0.15.18), and it was two defects, not one.** (1) `validateEvent` required both content
hashes for every disposition but `deferred`; an UNMATCHED glob has no downstream, so resolving the source (the first fix
shape above) would only have moved the error to `downstream_content`. `decoupled` removes the edge, so nothing reads its
pin: content is now recorded when resolvable and not required (lib/edges/events.mjs). (2) `runDecoupled` built the payload
AFTER the sidecar edit and its dry run never validated — so the preview said 0 for a write that then failed. The payload is
now built and `dryValidateEvent`-checked before anything is written, in dry run and `--apply` alike.
The payload is built TWICE: validated before the edit, then rebuilt after it, because provenance must describe the tree
at the moment of the write (`observed_dirty: true` — the sidecar edit is what dirties it). The first version built it once,
before the edit, and `tests/cli/verify.test.mjs:787` caught `observed_dirty` flipping to false — a full-suite failure the
N119 targeted tests could not see.
Tests: "N118/N119: decoupling an UNMATCHED glob (one that watches nothing) succeeds and is recorded" (exit 0, exactly one
`decoupled` event); "decoupled validates with content, and without it (N119)"; negative control "the N119 relaxation is
decoupled-only". Mutations: relaxation reverted -> the dry run reports the refusal; relaxation AND pre-validation reverted ->
the original bug reproduces (`applied:true`, then the event write fails).

### N120 · The flag allowlist was built from `commands/*.mjs`, so commands implemented in `cli.mjs` REFUSE flags their handler reads — **S3** — **RESOLVED 2026-10-06** (`tests/unit/cli-flag-parity.test.mjs`; 2 flags declared, 1 claim withdrawn)
Found 2026-10-04 while adding `backlog --trackers`: `backlog --brief` exited 2 ("unknown flag
--brief, known flags: --json"). `--brief` and `--affects` shipped 2026-08-27/28 (`0edd23b`,
`1de353e`); the allowlist arrived 2026-09-26 (`156d26a`), built by "sweeping what
`commands/*.mjs` actually reads from argv" (tests/unit/cli-commands.test.mjs). backlog's handler is
`backlogCmd` in `cli.mjs`, outside that population, so its flags were never seen and every one but
`--json` was refused for eight days. Fixed for backlog in v0.15.19 (PR-034).

**Measured the same day** by a scan of the 26 `mode === "…"` dispatch branches in `cli.mjs`
(each handler's body, string-literal `--flags`): 4 handlers read flags their allowlist refuses.
Three are real, each confirmed through `validateFlags` directly and none run:
`migrate-refs --workspace` (read at cli.mjs ~1827), `graph-index --since` (~4144),
`monitor --install` (~4548). The fourth, `check`, is a false positive: `--name-only`,
`--cached` etc. are arguments to `git`. The scan is a heuristic and misses flags read by a
helper rather than the handler body.

**Cost:** `backlog --brief` and `--affects` unusable for eight days; nothing silent (exit 2,
named), which is why it cost little. **Fix shape** (`rule:derive-dont-curate`): a test that DERIVES
each mode's read flags from its handler in `cli.mjs` as well as `commands/*.mjs`, with a floor on
the number of handlers scanned, and fails on a read-but-refused flag. Per flag, decide whether it
is wanted (declare it) or dead (delete the read). Not done here because each of the three is a
call about that command.

**Resolved 2026-10-06 — and this entry's own list was one-third wrong.**
- `migrate-refs --workspace`: real. The handler accepts it as the alternative to the positional
  argument, exactly as `migrate` declares. **Declared.**
- `monitor --install`: real, and the costlier of the two — it is the documented generator of the
  ARMED `propagate-monitor` agent's plist (docs/SYSTEMS.md, DECISIONS 2026-08-17), so since 2026-09-26
  nobody could regenerate that plist. **Declared.**
- `graph-index --since`: **never real.** The scan that produced this list read each handler up to the
  NEXT top-level function; `graphIndexCmd` is the last one in cli.mjs, so its "body" ran into the
  dispatch block and picked up `doctor --since`. Withdrawn — a false positive written into the register
  by the instrument meant to find them (rule:measure-the-claim-not-a-proxy).

**The fix is the derivation, not the three flags.** `tests/unit/cli-flag-parity.test.mjs` derives, for
every mode in cli.mjs's top-level `if (_invokedDirectly)` dispatch, the handler it calls (in cli.mjs or
the commands/*.mjs it imports) and the `"--flag"` literals in that handler's body, and fails on any the
allowlist refuses. Floor: >=20 handlers resolved. Exemptions carry reasons and fail when stale (two kinds:
an argument to a spawned program — `ui` passes `--html` to `cli.mjs graph`; and a shared handler —
`skills-promote/-demote` return before `--apply` is read for `skills-reap`).

Building it found two more blind spots in my own probes, each caught by a negative control rather than
the floor (GOTCHAS G71 — a scan goes blind by matching MORE): `mode === …` inside a handler read as
dispatch (one branch swallowed eight handlers), and `mode === "a" || mode === "b"` left the first mode
with no handler, so `skills-promote` was silently unchecked. Both are now pinned by tests.
Mutation: removing `--install` from monitor's flags fails the parity test naming exactly
`monitor: --install is read by monitorCmd (cli.mjs) but refused`.

### N121 · `make-public`'s home-path pattern was case-insensitive, so a GitHub `/users/` URL read as a private macOS path — **S3** — **RESOLVED 2026-10-04** (v0.15.19, `lib/core/public-forbidden.mjs`)
`FORBIDDEN` in `bin/make-public.mjs` carried `/\/Users\/[a-z]/gi`. A macOS home is `/Users/`, capital U;
with `i` it also matched `https://github.com/users/<owner>/projects/<n>`. The first such URL in a tracked
file was PR-034's link to GitHub Project #3, committed in 7fe37a5, and from that commit three
`make-public-watchlist` tests were red on the committed tree: "1 FILE(S) STILL CARRY PRIVATE CONTENT …
`propagation/state/workspace/TODOS.md` (1x absolute macOS home path)". The two real `/Users/rupali.b` lines
in that file (since 0e20136) were never the hit — the scrubber maps them; the URL survived it.

**How it got onto main:** 7fe37a5 was committed (another session's entry, on its behalf) without a full
suite run, because it "only touched a register". The register is a tracked file the release check reads.
Caught by the next full run, for v0.15.19.

**Fix:** the pattern is now case-sensitive (the username pattern keeps `i`), and `FORBIDDEN` moved to
`lib/core/public-forbidden.mjs` because the script runs on import and its constant could not be tested.
`tests/portability/public-forbidden.test.mjs` pins both directions. Mutation: restoring `i` turns the new
test AND the three original watchlist tests red, and nothing else — the flag alone was the cause.

### N122 · A project nested more than one level under its workspace never gets its gotchas delivered — **S2** — **RESOLVED 2026-10-06** (`lib/gotchas/parse.mjs` `nestedStateDirsFor`)
`sourcesFor()` keys a workspace's `propagation/state/<project>/` by the CHILD directory the walk came up
from (`stateDirFor(dir, basename(child))`). That is right for `<ws>/<project>/` and wrong for anything
deeper. From `Rupali/Experiments/Vipin/Poker` the walk asked the workspace for `state/Experiments/`, so
`state/Poker/GOTCHAS.md` was never read: `sourcesFor(Poker)` returned only the hub's workspace file and
the global index. Found by the delivery check after writing Poker's G1 (`npm ci` after a pull): a
simulated `git pull` in that directory produced no output, and `gotcha-guard --selftest` counted 20
triggered entries, with Poker's absent.

**Why it was silent:** a gotcha that cannot fire looks exactly like a gotcha that has nothing to say.
The sidecar already recorded the answer (`repo_root: Experiments/Vipin/Poker`), and its own note warned
*"Nested two levels under Experiments, deeper than HandReader."* Nothing read it.

**Fix:** step 1b in `sourcesFor` reads each state dir's `.sidecar.yml` `repo_root` and matches the start
directory by path segment (`path.relative`), never string prefix. A `repo_root` that is absolute or
contains `..` is ignored. The top-level `repo_root:` line is read with a regex rather than the `yaml`
package, because this runs on every Bash/Edit/Write.

**Tests** (`tests/unit/gotchas-parse.test.mjs`, 6 new): found from the repo root and from a subdirectory;
outranks the workspace file; a sibling and a `Poker2` lookalike do NOT match; `../` and absolute
`repo_root` are ignored; a sidecar with no `repo_root` matches nothing. 4 failed before the fix for the
stated reason. **Mutations:** a string-prefix match turns only the lookalike test red, and dropping the
escape guard turns only the escape test red.

**Live:** from Poker, `git pull` now fires G1, `npm test` does not, and a `git pull` in the sibling
`Experiments/HandReader` does not. `--selftest`: 21 triggered entries, Poker's file listed.

### N123 · `lib/core/public-forbidden.mjs` and its test contained the literal username, so committing them turned `main` red again — **S3** — **RESOLVED 2026-10-06**
The N121 fix (85fd8a9) moved `FORBIDDEN` into `lib/core/public-forbidden.mjs` and added a test. The module's
comment named the username in backticks, and the test used the literal as its fixture string. Both files are
tracked from that commit, `make-public` reads every tracked file, and three `make-public-watchlist` tests failed
with "2 FILE(S) STILL CARRY PRIVATE CONTENT … (1x home-dir username)".

**Why the suite did not catch it:** the full run (2472/2477, green) happened while both files were UNTRACKED,
and make-public builds its population with `git ls-files`. A green run before `git add` is blind to new files.
That is the general hazard, now GOTCHAS G76 with a commit-time trigger. Same instrument, same week, as N121 —
which was itself the hazard of committing without a suite.

**Fix:** the comment now says "the home-dir username"; the test builds the string at runtime
(`["RUPALI", "B"].join(".")` — split so this line is not itself a match); and the module now warns never to
write the literal. `make-public --check` against the real tree: "clean — no forbidden pattern survives", exit 0.

### N124 · `verify --disposition decoupled --apply` re-serialises the WHOLE sidecar, re-wrapping every long string — **S3** — **RESOLVED 2026-10-12** (v0.15.21)
Found 2026-10-12 retiring one hub edge (e8124882, O12). Removing ONE `propagates_to` item produced a
170-line diff (+87/−83) in `.propagates.yml`: the `yaml` library's default `lineWidth: 80` re-folded
every long double-quoted `why:` and every `>` block in the file. Parsed before and after, the VALUES
were identical (38 → 37 edges, 0 other values changed), so no edge id moved — the cost is review, not
data: a one-line removal arrives buried in other people's reformatted entries, and every other
session's open diff on that sidecar now conflicts.

**Cost:** none recorded, because the hub and Vipin sidecars were rebuilt by hand from HEAD's text
minus the one entry (31 and 18 changed lines), after `decoupled` had written its event.
**Fix shape:** `String(doc)` → `doc.toString({ lineWidth: 0 })` (and the same anywhere else a sidecar is
written back), plus a test: decouple one entry from a fixture with a 120-char `why:` elsewhere and
assert the rest of the file is byte-identical.

**Resolved 2026-10-12, and not the fix this entry proposed.** `toString({ lineWidth: 0 })` was measured first: NO option round-trips these files (the hub sidecar re-printed with zero edits differs on >300 lines under every setting tried). So `applyDecoupledEdit` no longer re-prints at all: the Document only LOCATES the entry, the raw text is cut at whole lines, and the result is re-parsed and compared with what the Document API edit would mean — a mismatch refuses the write. That check fired once in development, on the one-source case (a bare `sources:` parses as null, not `{}`), before anything reached disk. Test: "N124: decoupled removes ONE entry`s lines and leaves every other byte of the sidecar alone". Mutations: restoring `String(doc)` fails it on the byte comparison; an off-by-one cut fails it too.
