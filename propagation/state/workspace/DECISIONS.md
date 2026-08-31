> Entry point: [`../skills/propagate/SKILL.md`](../skills/propagate/SKILL.md) · Index: [`README.md`](./README.md)

# propagate — Decisions

Append-only. Newest last. Each entry: **What / Why / Affects / Refs.**
`**Affects:**` is machine-read — it drives cross-repo relay rows and is enforced
as a pre-commit gate by `PanditPawanKaushik/scripts/decisions-check.sh`.

---

## 2026-08-10: renderMarkdown is idempotent; the staleness banner can no longer freeze

**What:** `renderMarkdown` now diffs the rendered body against the file,
excluding the generated-at footer, and returns `false` without writing when
nothing changed. Loop protection moved out of the callers' event-count
bookkeeping and into the renderer; all three call sites (one workspace, two
cross-ledger) now render unconditionally.

**Why:** the MD header carries a time-derived tripwire, but the render was gated
on "this workspace produced new events." A ledger that went silent therefore
froze its own banner — `PROPAGATION_CROSS_LEDGER.md` read *"Last entry: today.
Watcher healthy."* for four weeks. **The alarm was only updatable by the thing it
was meant to detect.**

**Gotchas:** calling it unconditionally was not an option — that reintroduces the
B0 feedback loop (write ticks mtime → launchd `WatchPaths` re-triggers → ~5s fire
loop). A naive content-compare also fails, because the footer stamps a fresh ISO
timestamp every render. Hence the footer-excluded body diff. Both *cross-ledger*
call sites had the same gate; fixing only the workspace one would have left the
ledger that motivated the finding still frozen.

**Verified:** live cross-ledger self-corrected in production from "today" to
"28 days ago". 80/80 tests pass, 4 new.

**Affects:** propagate
**Refs:** `lib/ledger.mjs`, `watcher.mjs`, `tests/ledger-render-staleness.test.mjs`, commit `9cb5e34`

---

## 2026-08-10: workspace roots become explicit, rather than inferred from marker presence

**What:** add an optional `workspace: boolean` to `propagates.schema.json`.
`discoverWorkspacesSync` keys on that field instead of on the mere existence of
`.propagates.yml`, and **always descends** rather than halting at the first
marker found.

**Why:** `.propagates.yml` currently means two different things — "here are edge
declarations" (19 places on disk) and "here is a ledger boundary" (7 places).
Discovery read the first as the second, so the hub's own root marker halted the
walk and swallowed five workspaces. Result: 93 open rows with 71 misfiled into
the hub ledger under foreign `source` paths.

**Gotchas:** the obvious fix — recurse past the marker — is **worse**. It
promotes all 19, including `Vipin Kaushik/docs/`, which has no `docs/docs`, so
`makeWorkspaceRecord` resolves it to `docs/.propagation/ledger.jsonl` — a brand
new empty ledger beside the real 327-row one, orphaning it. Same bug one level
deeper and much harder to see. Schema must ship before any marker gains the
field, because `additionalProperties: false` makes `loadSidecar` reject it and
the watcher then **silently** stops firing that sidecar's edges.

**Affects:** propagate, Vipin Kaushik, PanditPawanKaushik, ManavDaehi, Keerti
**Refs:** `lib/discovery.mjs:84-101`, `lib/config.mjs:24-44`, `propagates.schema.json:52`

---

## 2026-08-10: the local web UI is cut; ship machine-readable output and a pushed digest instead

**What:** a designed local web UI (Node, port 8791, own token and LaunchAgent)
was **removed from the plan before implementation**. Replaced by
`cli.mjs status --all --json` plus a daily since-last-run digest delivered to a
surface already in use.

**Why:** its direct precedent has never been used. `~/.claude/pending-queue.json`
mtime *equals* its birth time; the queue UI's token was created **16 minutes
after the last write that queue ever received**; its log was deleted by macOS for
inactivity while the process still held it open; and
`claude-queue-ui.py:255` is `def log_message(self, *a): pass` — it is
architecturally unable to emit the `last_invoked` field an adoption probe needs.
Seven write endpoints, 11+ days, zero writes.

The workload is also not per-row: `Vipin Kaushik`'s ledger holds **269 wontfix
rows across 38 distinct seconds, 66 in one second** — scripted bulk dismissal. A
per-row triage UI would serve a workload never once handled per-row.

The real complaint behind "no UI" was that the system was invisible — because
**5 of 8 ledgers were invisible to `status`**, not because output went to a
terminal. Part A fixes that; `--json` and a digest make it consumable.

**Gotchas:** any future UI is gated on (1) retrofitting request logging to the
existing queue UI so the adoption question can be settled with evidence, and (2)
two weeks of demonstrated engagement with the digest. If built, it should be a
tab in the existing process — the "different blast radii" argument for a separate
one was inverted, since 8790 exposes the switch that arms unattended autonomous
execution while a propagate surface is append-only.

**Affects:** propagate, scripts
**Refs:** `~/.claude/plans/claude-we-have-a-memoized-acorn.md` Phase 1a

---

## 2026-08-10: the 69 misfiled hub rows are deferred, and may only ever be closed-and-re-emitted

**What:** fix discovery now; leave the 71 existing hub rows (69 of which belong
to other workspaces) where they are. When migrated, it must be append-only
close-and-re-emit with a manifest and a rollback path — never an in-place rewrite.

**Why:** ids are per-file sequential; `source` is workspace-relative and must be
re-written per destination; `status_change` history would have to be re-pointed;
and `markStatus` against the wrong file **silently no-ops**, so a half-applied
migration is invisible. Once discovery is correct, new drift files correctly and
the old rows are honest history.

**Gotchas:** because `hasOpenDuplicateDrift` is scoped to a single file and
`source` is workspace-relative, the same drift can now be open in two ledgers
simultaneously — one row per subsequent edit of an affected file. So "total open
stays 93" is true only at the instant of promotion, **not** a steady-state
invariant. A `duplicateOpenAcrossLedgers` doctor check ships in the same phase so
the deferral has an expiry signal.

**Affects:** propagate
**Refs:** `lib/ledger.mjs:110`, `watcher.mjs:220`

---

## 2026-08-10: Part A landed — 7 workspaces discovered, verified by the system routing its own drift

**What:** shipped the `workspace: true` predicate, always-descend walk, ledger
path pinning, `{workspaces, markersSeen, degraded, suspiciousMarkers}` return
shape, 5 new doctor checks, and `status --all --json`. WORKSPACES 2 → 7. Tests
80 → 116.

**Why it is believed correct, not just green:** after promotion the watcher fired
and wrote two `code_drift` rows for `SSJK-mb/.env.example` and
`server/config/index.js` into **SSJK-mb's own ledger**, with `source` relative to
SSJK-mb rather than to the hub. Those are rows that would previously have been
misfiled. Cross-checking every open row's resolved absolute path across all
ledgers found **zero** files open in more than one ledger, so this is correct
routing rather than the duplicate class. Discovery previously had **zero** test
coverage, which is why 80/80 green had never been evidence of anything here.

**Gotchas:**
- Open rows went 93 → 95. That is legitimate new drift, and 93 was only ever an
  at-the-instant-of-promotion figure. `duplicateOpenAcrossLedgers` is the check
  that would catch the real regression.
- `cli.mjs init` calls `regeneratePlist` + `reloadLaunchd` as a side effect and
  will silently re-arm launchd. An agent hit this while testing. It should be
  split so `init` scaffolds and `reload` reloads.
- The plist's `WatchPaths` had already drifted to list neither current workspace
  root — the system had been running on `StartInterval 60` alone. Now regenerated
  and covered by a doctor check.
- `DISCOVERY_DEGRADED` intentionally still trips only on total collapse; partial
  loss is surfaced through `suspiciousMarkers` instead, so one workspace dropping
  out is loud rather than invisible.

**Affects:** propagate, Vipin Kaushik, PanditPawanKaushik, ManavDaehi, Keerti
**Refs:** `lib/discovery.mjs`, `lib/config.mjs`, `lib/edges.mjs`, `cli.mjs`, `tests/discovery.test.mjs`, `tests/edges-nesting.test.mjs`, `tests/cli-json.test.mjs`

---

## 2026-08-10: a derived index — distributed writes, centralised reads

**What:** `index.db`, a SQLite projection over all 8 ledgers and 31 authored
STATE/DECISIONS files. Gitignored, full rebuild every run (~400ms), no
incremental logic. Seven tables: `ledger_row`, `ledger_unknown`, `decision`,
`decision_affects`, `state_doc`, `source_file`, `coverage_gap`. Rebuilt at the
start of each digest run.

**Why:** authored docs and ledgers stay distributed, because git colocation is
what keeps decision records honest — an entry lands in the same commit as the
change it explains, and the three workspaces with fresh docs are exactly the
ones where that holds. But cross-cutting reads then cost 20+ file-opens; this
audit answered "what happened today across the ecosystem" by hand. The
resolution is a read/write split: writes stay local, reads get one place.

**Because it is derived it cannot drift.** Verified: `rm index.db && --rebuild`
reproduces byte-identical query output. A hand-maintained central store would
have rotted exactly like the docs it indexes.

**Gotchas:**
- It deliberately does **not** use `discoverWorkspacesSync` for discovery. That
  is the function whose blind spot orphaned 5 of 8 ledgers until this morning.
  It sweeps the filesystem directly and records any disagreement in
  `coverage_gap` — that disagreement is itself the finding. It currently reports
  one: the cross-ledger, which discovery legitimately does not return
  (federated path, not workspace-discovered). Flagged rather than
  special-cased, so the check stays honest.
- Dot-directories are excluded, which keeps the 3 worktree-copy ledgers under
  `PanditPawanKaushik/.claude/worktrees/` from being indexed as real ledgers.
- `state_doc` stores `header_last_updated` and `file_mtime` **separately** and
  they must never be collapsed. `Vipin Kaushik/STATE.md` reads 2026-07-16 in its
  header with a 2026-08-10 mtime — that gap is how "touched by tooling, not by
  hand" becomes visible instead of inferred.

**Found immediately:** `ledger_unknown` surfaced the one `type:"manual"` row
(Vipin Kaushik ledger, id 256, line 470) that has been invisible to every reader
since 2026-06-20 because `readLedger` silently drops unknown types. It documents
the `Campaigner/` -> `marketing-intel/` rename with six downstream references.

**Verified:** 99 open rows in the index matches `cli.mjs status --all --json`
exactly, per-ledger. 154/154 tests. No ledger, STATE or DECISIONS file modified.

**Affects:** propagate, hub
**Refs:** `index.mjs`, `lib/index-db.mjs`, `tests/index.test.mjs`, `digest.mjs`

---

## 2026-08-13: the premise is parallel coordination, not doc staleness

**What:** `SKILL.md`'s identity block now states the premise explicitly and
canonically: propagate coordinates parallel work — across branches and
worktrees inside a repo, and across repos in the workspace — by declaring the
couplings that matter, watching them, and keeping an append-only ledger tied to
git workflow, so every stream can see what moved, where, and on which branch.
It never edits a downstream; it tells a human. `docs/SPEC.md` §1 quotes that
sentence verbatim as a blockquote, under a note that `SKILL.md` is canonical
and the copy is enforced by `tests/skill-doc.test.mjs`.

**Why:** the skill previously had no stated premise anywhere, and the
implicit one a reader would infer from the docs was staleness — "a coupled
doc went stale, prompt someone." That reading made the cross-repo layer read
as a peripheral, dormant subsystem (`docs/SPEC.md` §8, pre-2026-08-13 wording)
and made `docs/ISSUES.md` B1 (sidecars are branch-local; `doctor` is not
branch-aware) and B2 (squash merges defeat ancestry checks) read as low-grade
noise at S2. Both readings are wrong under the coordination premise: B1/B2 are
the exact failure mode the tool exists to prevent, and the cross-repo layer is
the direct mechanism for the majority workload.

**What this supersedes:** the implicit staleness framing. Nothing was ever
written down as "propagate is about staleness" — there was no premise
statement to supersede formally — but every downstream doc's tone assumed it,
and this entry is the record that the assumption was wrong and has been
replaced.

**Evidence:** `docs/SPEC.md` §5's own measurement, run against the 19 open
rows in the Vipin Kaushik ledger on 2026-08-13: 17 of 19 (89%) span two repos,
where a single commit can never answer both sides. Only 2 of 19 are
intra-repo. A staleness-of-a-doc framing has no explanation for why the
overwhelming majority of real drift is cross-repo; a parallel-coordination
framing predicts it directly.

**Consequent doc changes, same pass:** `docs/ISSUES.md` B1/B2 re-ranked S2 →
S1, `## Suggested order` updated in the same edit so severity and order do not
disagree; `docs/SPEC.md` §8 sub-grouped into standing limitations vs. three
questions the premise change raises but does not answer (detection trigger
vs. I3, whether a row should key to `(coupling, branch)`, whether the
cross-repo layer ships — default flipped to *ships*, call still open).

**Affects:** propagate
**Refs:** `SKILL.md`, `docs/SPEC.md` §1 §8, `docs/ISSUES.md`, `tests/skill-doc.test.mjs`,
`~/.claude/plans/okay-i-dont-think-logical-haven.md` Phase 0

---

## 2026-08-13: the skill-lifecycle command family is a separate concern, split out by decision (no code moved)

**What:** decided that `skills`, `skills-create`, `skills-promote`,
`skills-demote`, `skills-reap`, their event log `SKILLS_LIFECYCLE.jsonl`, and
`lib/skills-*.mjs` should live in their own skill, distinct from propagate's
ledger/coupling concern. **This decision moves no code.** It records the call
and the doc boundary only — `SKILL.md` gets one line naming the skills-*
family as riding in the same CLI but out of scope of this skill's premise.

**Why:** the skill-lifecycle family shares no premise with ledger
propagation. Different data model (quarantine → promote → reap directory-move
lifecycle vs. declared-coupling rows), its own append-only event log
(`SKILLS_LIFECYCLE.jsonl`, not `PROPAGATION_LEDGER.jsonl`), no ledger rows, no
declared couplings, no `.propagates.yml` sidecars. Bundling it under
propagate's docs is why `docs/SPEC.md` (pre-2026-08-13) never mentioned it and
`SKILL.md` documented it without explaining why a coupling-watcher also
manages skill lifecycle — the honest answer being "no reason, it just landed
in the same CLI."

**Dependency to untangle before any code moves:** the skills-lifecycle code
reuses `appendRowWithId` from `lib/ledger.mjs` for its own atomic mint+append.
A future split has to either fork that helper or extract it to a shared
module neither skill owns exclusively — it cannot stay as "skills-* imports
from propagate's ledger lib" once the two are separate skills.

**Tests:** `skills-create`, `skills-lifecycle`, and `skills-scan` test files
travel with the code when it moves — they exercise the lifecycle concern, not
the ledger.

**Gotchas:** because no code moved in this pass, `cli.mjs` still dispatches
`skills*` commands today and will continue to until the split is actually
implemented. This entry is not a changelog for a completed migration; it is
the record that the decision was made and why, so a future implementer does
not have to re-litigate whether the split is warranted.

**Affects:** propagate
**Refs:** `SKILL.md`, `lib/skills-create.mjs`, `lib/skills-promote.mjs`,
`lib/skills-demote.mjs`, `lib/skills-reap.mjs`, `lib/skills-scan.mjs`,
`SKILLS_LIFECYCLE.jsonl`, `lib/ledger.mjs` (`appendRowWithId`),
`tests/skills-create.test.mjs`, `tests/skills-lifecycle.test.mjs`,
`tests/skills-scan.test.mjs`,
`~/.claude/plans/okay-i-dont-think-logical-haven.md` Phase 1

---

## 2026-08-13: sidecar validation is per-entry — a schema constraint must not disable a file that previously worked

**What:** `loadSidecar` (`lib/frontmatter.mjs`) no longer rejects an entire
`.propagates.yml` for a schema violation confined to one downstream entry.
When every ajv error's `instancePath` points inside a
`/sources/<key>/propagates_to/<i>/...` entry, that entry is pruned from a
copy of the parsed object, the copy is re-validated (never returned unless
proven valid), and the prune is reported via a new `problems: []` field on
the return value. Anything else — malformed YAML, `sources` not an object, a
source missing `propagates_to` entirely, any top-level shape violation —
stays fatal and still throws `SidecarError`, because whole-file rejection is
the only correct response to damage that cannot be partially recovered.
`cli.mjs doctor` surfaces every `problems[]` entry as its own FAILURE,
naming the sidecar, the source key, and the offending path — pruning must
not trade one silent failure for another.

**Why:** the 2026-08-10 entry above ("workspace roots become explicit...")
added `additionalProperties: false` and is the reason `SKILL.md` states
schema must ship before any marker gains a field — reject unknown shapes
before they're written, not after. This entry is that rule's mirror. We
proved the failure ourselves on 2026-08-13: tightening the schema to reject
a downstream `path` ending in `/` (the directory-as-downstream guard) turned
`PanditPawanKaushik/SSJK-mb/.propagates.yml` from *"loads, with one path
that does not resolve"* into *"does not load at all"* — 40 declared edges
across 10 sources went inert, 224 `skip broken sidecar` lines in
`watcher.log`, dark for roughly two hours (docs/ISSUES.md N9). A validator
that can take a working file offline is a bigger outage than the defect it
catches. Therefore: **validation is per-entry; whole-file rejection is
reserved for structural damage that genuinely cannot be partially
recovered.** Any future schema tightening is weighed against the sidecars
already on disk, not just against the shape it's meant to catch.

**Verified:** SSJK-mb's sidecar now loads all 10 sources with exactly 1
problem reported (the `flows/` trailing-slash entry); its other 39 edges
fire again. `doctor` turns the same finding into a named per-entry FAILURE
instead of a whole-sidecar rejection, and — as a side effect of the file no
longer being rejected outright — also surfaces the previously-hidden
`admin/app` directory-as-downstream bug that was masked behind the total
failure.

**Affects:** propagate, PanditPawanKaushik
**Refs:** `lib/frontmatter.mjs` (`loadSidecar`, `partitionErrors`), `cli.mjs`
(doctor sidecar-loop), `docs/ISSUES.md` N9,
`tests/sidecar-prune.test.mjs`,
`~/.claude/plans/okay-i-dont-think-logical-haven.md` Phase A

---

## 2026-08-13: v1's implicit ledger creation stays; the fix belongs to v2's bootstrap

**What:** Nothing in v1 explicitly creates a ledger. It materialises on the
first `appendFile`, and its location is *inferred* by `makeWorkspaceRecord`
(`lib/discovery.mjs:149-174`) from whether `docs/` happened to exist at that
moment — which is why the code carries a "never relocate a live ledger because
a `docs/` dir later appears" guard. We are **not** fixing that in v1.

**Why:** The approved v2 design abolishes per-workspace ledgers entirely —
events move to one owned store at `$PROPAGATE_STATE_DIR`, created once and
explicitly at bootstrap. Declaring the ledger path in each marker would mean a
schema change to 18 live sidecars (and N9 says schema changes are how sidecars
break) in service of a structure v2 removes. Work with a known expiry.

**Gotchas:** Two real consequences stay live until v2 bootstrap lands. A freshly
initialised workspace has **no ledger at all** until something drifts, so
`status` and `doctor` read a path that does not yet exist. And the location
remains an accident of directory layout at first-write time — the guard contains
the damage but does not remove the cause.

**Affects:** propagate
**Refs:** `lib/discovery.mjs` (`makeWorkspaceRecord`), `lib/ledger.mjs:107,241`,
`~/.claude/plans/okay-i-dont-think-logical-haven.md` §5 (bootstrap git stage)

---

## 2026-08-13: `persona/profile.md` deleted across all 7 workspaces

**What:** Removed `profile.md` from every `<Workspace>/persona/`. All 7 were
archived first to `~/Documents/GitHub/_archive/profile-md-2026-08-13/`. The
`profile.yaml` sources are untouched.

**Why:** Each was a *rendered* artifact whose generator no longer exists —
`Utility/scripts/generate-personas.js` is gone; `Utility/` now contains only
`chaukidar/`. Every copy was stale against its own source (ManavDaehi's by three
months: yaml 2026-08-10, md 2026-05-09), **none** was declared as a downstream
of `profile.yaml` in any sidecar, and nothing in any `CLAUDE.md` referenced one.
A derived file with no renderer, unread for months, that still reads as
authoritative is worse than no file — and this is the identity root, the
highest-fan-out node in the graph.

**Gotchas:** **4 of the 7 were untracked** (Keerti, Khushboo, Rishabh, Tathya),
so `git checkout` would not restore them — hence the archive, which is the only
copy. The 3 tracked ones (ManavDaehi, PanditPawanKaushik, Tushar) now show as
deletions in their own repos and need committing or reverting there; that is a
per-repo decision, not made here.

If a readable view is wanted again, it should be regenerated from
`profile.yaml` **and declared** as a `kind: code` downstream so the drift that
went unnoticed for three months would fire next time.

**Affects:** propagate, Keerti, Khushboo, ManavDaehi, PanditPawanKaushik, Rishabh, Tathya, Tushar
**Refs:** `_archive/profile-md-2026-08-13/`, `<Workspace>/persona/.propagates.yml`,
`~/.claude/plans/okay-i-dont-think-logical-haven.md` §6

---

## 2026-08-14: the v1 launchd watcher is retired

**What:** `watcher.mjs` (launchd `com.tathya.propagate.watcher`, `StartInterval
60`) is retired. The file is not deleted — it carries a header recording the
retirement and refuses to run directly (`node watcher.mjs`) unless
`PROPAGATE_ALLOW_RETIRED_WATCHER=1` is explicitly set, so it cannot silently
write v1 rows into ledgers nothing else maintains. `cli.mjs doctor` no longer
reports plist-loaded / heartbeat-age as failures — both are now informational
(`·`, never `✗`), explicitly labeled RETIRED — and instead asserts the
replacement's health: the v2 event store is readable and non-empty, and
`reconcile()` completes. `digest.mjs`'s `broken` check and its `watcher: ...`
summary line follow the same rule — heartbeat staleness no longer trips
`broken`; `reconcile()` failing to complete does. The actual launchd
unload/disable is a separate, later step, done outside this change.

**Why:** measured over the watcher's production lifetime: **4,420 runs,
4,384 no-ops — 99.2% found nothing.** Its `state.json` mtime baseline caused
two incidents in one day (docs/GOTCHAS.md G10/G11/G13): a state wipe that
fired ~120 spurious rows, and repeated plist overwrites. v2 derives drift
from content instead of remembering it (docs/GOTCHAS.md G19 "deriving beats
remembering"), so `reconcile` answers "what has drifted" from scratch in
~1.2s (measured: `node cli.mjs doctor`, "reconcile completes" check, this
repo, 2026-08-14) and cannot miss a change that happened while nothing was
watching. Replacement coverage is in place, not merely proposed: `reconcile`
on demand, `check` at the pre-push moment, and the daily digest's DRIFT +
INBOUND sections (commit `45a5e63`). Production holds **379 baselined
events** in the v2 event store (`~/.propagate/events`, via `bootstrap
--apply`), so drift is actually derivable today, not just in principle.

**What is genuinely lost, not just traded:** sub-daily proactive
notification. The watcher fired on every file event plus a 60s floor,
regardless of whether anyone was about to look; `reconcile`/`check`/the
digest are on-demand or once-daily. A file that drifts and is never touched
again, and that nobody runs `reconcile` or reads the digest for, will sit
undetected for up to a day (digest) or indefinitely (reconcile, if nobody
ever runs it) — the watcher would eventually have caught it within
`StartInterval`. This is an accepted tradeoff given the 99.2% no-op rate and
the incident cost, not a claim that nothing changed.

**Gotchas:** per docs/GOTCHAS.md G2 ("absence is ambiguous — make it
attributable"), the watcher's doctor checks were changed to informational
rather than deleted outright — a reader who notices "plist loaded" is gone
must not be left to wonder whether that's a bug or a decision. Per G20 ("a
second reporting mechanism duplicates the first unless you delete the
first"), no second place was added to report plist/heartbeat state — the
existing `check()`/`info()` call sites were converted in place, not
duplicated. v1's reader path (`status`, `drain`, ledger reads) is untouched
by this change — only the writer (`watcher.mjs`) and the doctor/digest
checks that graded its health were touched. 152 (measured 2026-08-14: 149
across the 7 discovered workspaces + 3 cross-repo) open v1 rows remain real,
unmigrated work; retiring the writer does not touch them.

**Verified:** 470/470 tests pass (was 465 before this change: -1 test
removed for behavior that's now intentionally wrong, +6 new — 3 for
digest's reconcile-based broken check, 1 for doctor's retirement reporting,
2 source-inspection tests for watcher.mjs's refusal guard). `node cli.mjs doctor`:
watcher section prints informational only (no `✗`), replacement section
shows `event store readable — 379 event(s), 0 malformed`, `event store
non-empty`, `reconcile completes — ~1.2s`. `node cli.mjs status --all`
still lists the same v1 open rows it did before this change.

**Affects:** propagate
**Refs:** `watcher.mjs` (header + `_invokedDirectly` guard), `cli.mjs`
(`doctor`'s launchd/heartbeat section + new "v2 replacement" section),
`digest.mjs` (`computeDiff`, `formatDigest`), `tests/digest.test.mjs`,
`tests/doctor.test.mjs`, `tests/watcher-retired.test.mjs`, commit `45a5e63`

---

## 2026-08-15: a worktree ledger is a branch snapshot, not a workspace — classify it, do not adopt it

**What:** `status --all` now includes the cross-repo ledger and prints a
whole-project total, and `doctor` gains a `no unowned ledger files` check that
scans the search roots for ledger files no workspace owns. An unowned ledger is
then **classified** before it is counted: if every id in it is also present in an
owned ledger, it is a *branch snapshot* — reported, but its rows are **not** added
to any total. Only a genuine orphan fails the check.

Branch-local worktrees will **not** be made ledger-owning workspaces, and
`DEFAULT_MAX_DEPTH` stays at 2.

**Why:** `status --all` reported **4** open where the tree had **8**. Two
independent causes: `PROPAGATION_CROSS_LEDGER` was read by `status --cross` and
by `digest.mjs` but never by `--all`; and a 79-row ledger sat at
`PanditPawanKaushik/.claude/worktrees/client-answers-propagation/docs/`, invisible
because it is below the depth limit *and* its sidecar never set `workspace: true`.
Half the open work was missing and nothing said so — the exact failure this skill
exists to catch, in its own tooling.

Raising the depth limit was rejected: it finds today's worktree and misses
tomorrow's, and the cost is paid on every invocation. Scanning for the artifact
cannot be outrun by nesting, naming, or a missing flag.

**Classification is the load-bearing half, and it was not in the original plan.**
Counting the worktree's rows would have replaced under-reporting with
over-reporting. Measured: all **40** of its ids exist in the parent workspace's
ledger, and its single `open` row (`#039`) is already **`done`** upstream — a
snapshot taken when the branch was cut, not a second source of truth. The honest
whole-project figure is **7 open**, not 8 and not 4. A ledger that lives on a
branch merges back with the branch; treating one as authoritative would let a
stale row resurrect a closed finding (`rule:discernment-checks` §5 — compare like
with like).

**Affects:** propagate

**Refs:** `cli.mjs` (status rollup, `no unowned ledger files`),
`lib/ledger.mjs` (`findUnownedLedgers`, `openCount`, `classifyUnownedLedger`),
`tests/whole-project-ledger.test.mjs` (4 tests: the doctor check failing *and*
passing, disclosure in `--all`, and a fold-not-count fixture where raw `open`
lines exceed folded open — the 501-vs-8 shape in miniature). Closes **B1** in
`docs/ISSUES.md`.

---

## 2026-08-15: discovery does not follow symlinks — now by report, not by accident

**What:** `discoverWorkspacesSync` continues to skip symlinked directories. It is not
changed. Instead `doctor` gains an `info` line naming every symlinked directory in a
search root that it did not descend into, and **escalating** any that carries a
`.propagates.yml` — those are workspaces being ignored.

`propagate journal` takes the opposite decision deliberately: it **does** follow symlinks
(`lib/journal.mjs` `enumerateRepos`, cycle-safe via realpath). The two answer different
questions, and conflating them is what caused the error below.

**Why.** `~/Documents/GitHub/propagate-skill` is a symlink to this repo. `discovery.mjs`
filters on `e.isDirectory()`, and a `Dirent` for a symlinked directory answers
`isSymbolicLink()` instead — so the walk never descends. The same is true of
`find -name .git`, which every sweep in the 2026-08-15 session used.

The cost was not hypothetical. The day's activity was reported as **95 commits across 21
repos**; `propagate-skill`'s 14 commits were invisible. Corrected to 109/22, then — after
a second, unrelated bug in the date window — to **118/24**, confirmed by two independent
implementations before anything was rewritten.

**Why not simply follow symlinks in discovery too.** Two reasons, and the first is
narrower than it first appeared:

1. `propagate-skill` carries **no `.propagates.yml`**. It never asked to be a workspace,
   so discovery would find nothing there even if it descended. "Propagate cannot see its
   own repository" was the wrong framing; nothing is currently lost.
2. The skill directory is deliberately outside `SEARCH_ROOTS` (`lib/config.mjs:162`,
   "to avoid discovery/feedback"). The symlink puts it back inside one. Making discovery
   follow links would re-create exactly the feedback the config avoids — the tool
   watching its own ledger writes.

**What was actually wrong** was that the exclusion happened *by accident of `Dirent`
semantics*, so a symlinked directory that DID declare a workspace would be dropped in
silence. That is now reported. Absence must be attributable
(`rule:discernment-checks` §2); an undocumented accident is not a decision.

**Affects:** propagate

**Refs:** `cli.mjs` (doctor symlink reporting), `lib/journal.mjs` (`enumerateRepos`),
`tests/journal.test.mjs` (7 tests: symlink found, absent without the link, cycle
terminates, doctor names it, doctor escalates a marker-bearing link, bare dates rejected,
attribution carried). GOTCHAS **G31**.

---

## 2026-08-17: propagate has a DAG; ordering is derived from it, and `verify` is dry-run by default

**What:** Three changes that arrive together because they are one idea.

1. **`lib/graph.mjs`** derives a graph from `reconcile()`'s rows: Tarjan SCC,
   condensation, longest-path-from-root layering, Kahn topological order,
   `blockedBy` (transitive unsettled ancestors of an edge's source) and
   `fixOrder` (the root→leaf worklist). Pure — rows in, graph out, no I/O.
   `propagate graph` exposes it as text, `--json`, `--node <path>`, and
   `--html <path>` (a self-contained page, `lib/graph-html.mjs`).
2. **`verify` gained an ordering guard.** Verifying an edge whose SOURCE is
   itself an unsettled downstream pins content against a source nobody has
   confirmed. That now warns, names every blocking upstream edge, and exits 3
   unless `--out-of-order` is passed. `deferred` and `decoupled` are exempt by
   construction; `wontfix` and `baselined` are not, because both pin.
3. **`verify` is dry-run by default for every disposition.** `--apply` now
   gates the event write, not just the `decoupled` sidecar edit.

**Why:** Measured on the tree the day this landed: 561 nodes, 711 edges over 710
distinct pairs, 67 roots, 461 leaves, 33 interior, depth 4 — and **4 of the 23
non-CLEAN edges had a source that was itself a dirty downstream.** Nothing could
see that, because every consumer treated each edge as an independent fact.

(3) is not a feature, it is an incident report. Before this change `--apply`
gated only `decoupled`, and `cli.mjs`'s own header said "does NOT touch the file
unless `--apply` is given" — true of the sidecar, false of the event store. A
session read it the second way, ran the guard's behaviour matrix without
`--apply`, and appended **11 events asserting verifications nobody performed**;
three real worklist items closed themselves and the worklist read 21 instead of
24. The events were removed (see below) and the flag now means what every other
command in this CLI means by it. A verification is a claim a human is making; it
must never be the default side effect of asking a question.

**Append-only was deliberately broken once.** The 11 events were the contiguous
tail of `~/.propagate/events/2026-08.jsonl` and were truncated rather than
compensated, because no disposition means "the last one was wrong" — leaving
them would have stood 9 false verifications permanently, and re-arming those
edges would have required waiting for their content to change. Backup at
`~/.propagate/2026-08.jsonl.pre-truncate-2026-08-17`, 869 → 858 lines, worklist
restored to 24. Recorded here rather than done quietly, per
`rule:discernment-checks` §2: an unrecorded deletion from an append-only store is
indistinguishable from corruption.

**Two doctor expectations added**, both sole-source and both with a real
instance on the tree: `graph.cycles == 0` (one mutually-declared pair of SSJK-mb
plan specs) and `graph.duplicate_pairs == 0` (`brand-system.md →
components/README.md` declared twice, two edge ids over one coupling — 711
records over 710 pairs). The graph derivation shares the existing
`reconcile completes` check rather than adding a label of its own, so it adds no
new G1 debt to `tests/doctor-check-coverage.test.mjs`. When reconcile fails both
metrics are **null**, never 0 — a 0 would assert "no cycles" about a graph
nobody built.

**Layering is longest-path-from-root, not out-depth.** The exploratory pass that
produced the baseline measured out-depth, which is the mirror image: on `A→B`,
`A→C`, `C→B` it puts B at 0 where the correct layer is 2. A fix order needs "a
node may only be verified once every inbound edge is settled".

**Affects:** propagate

**Refs:** `lib/graph.mjs`, `lib/graph-html.mjs`, `cli.mjs` (`graphCmd`, the
guard in `verifyCmd`, `buildEventPayload`, the dry-run branch in
`runDispositionBatch`, graph metrics in `doctor`), `lib/metrics.mjs`
(`graph.cycles`, `graph.duplicate_pairs`), `lib/events.mjs`
(`dryValidateEvent`), `lib/reconcile.mjs` (rows now carry `kind` and `why`).
Tests: `tests/graph.test.mjs` (22), `tests/graph-html.test.mjs` (13),
`tests/verify-ordering.test.mjs` (9). GOTCHAS **G44**, **G45**, **G46**.

---

## 2026-08-17: gotchas get a disposition, not just an entry — and the general form goes where it loads

**What:** `docs/GOTCHAS.md`'s 29 prose-only entries were each given one of five
dispositions, recorded in `docs/AUDIT-2026-08.md`: **RETIRE** (no longer true),
**PROMOTE** (the general form belongs in `~/.claude/rules/`), **ELIMINATE**
(change the design), **DETECT** (a check that fails when present), **DELIVER**
(a `**Trigger:**` for `gotcha-guard`). `DELIVER` is the fallback, reached only
after the first four are rejected in writing.

Shipped this pass: G39 superseded in place; `rule:safety-flag-needs-a-test`
written; G30/G38/G43 eliminated with tests; G8/G24/G25/G26/G36 delivered as
`gotchas-global.md` G-C/G-E/G-F/G-G/G-H; five COVERED entries given a
`**Guarded by:**` line; G19 and G42 reduced to pointers at the rules that already
generalise them.

**Why:** the corpus held **the same hazard at three levels of abstraction with
the general form unenforced**. G22 ("a safety flag is a claim, and claims need a
test", 2026-08-14, `digest --dry-run` ran an armed deletion) generalises N27
(filed 08-16, not fixed) which generalises G44 (08-17, 11 spurious events and 3
falsely-closed edges). `rules/_TODO.md` had backlogged the general form as
`safety-flag-needs-a-test` **on the day of the first incident**. Three days
between backlogged and written is what the other two instances cost.

**Where the general form lives is the decision.** A project `GOTCHAS.md` loads
when someone opens it; `~/.claude/rules/` loads every session via
`load-rules.mjs`. So a hazard with a general form moves to `rules/` and the
gotcha keeps the *incident* — the cost, the wrong theory held first, and the
signal that was visible at the time. Restating is forbidden either way; the
gotcha gets a one-line pointer up.

**RETIRE supersedes, never deletes.** `GOTCHAS.md` says "never delete one because
it feels obvious now". G39 is not obvious-now, it is **wrong** now — its `Do:`
advised against the dry run that is now the correct way to preview. Superseded in
place with the original beneath, because the incident outlives the advice.

**Four corrections found while auditing**, each an instance of the thing being
audited:

1. **Citation is not coverage.** The 29 came from matching `\bG\d+\b` across the
   source; seven entries were already guarded or already promoted, so the real
   figure was **22**. `rule:discernment-checks` §5.
2. **Two of the audit's own probes were false positives** — "drain points at
   verify" matched unrelated JSDoc, "ANSI helper is shared" matched two inline
   copies. Both caught by re-reading, not re-grepping. That is G42 firing inside
   the audit of G42.
3. **`rule:every-project-carries-gotchas`'s fingerprint contained the bare
   literal `docs/GOTCHAS.md`**, so `_check.mjs` reported any project that *cites*
   its own gotchas file as restating the rule — **the check punished adoption.**
   Narrowed; the false positive is gone and the fingerprint still matches its own
   body.
4. **The four shell/git triggers were first added to propagate's own
   `GOTCHAS.md`, where the guard can never reach them** — it walks *up* from cwd
   and `~/.claude/skills/propagate/` is not on the path from anywhere anyone
   works. Moved to `gotchas-global.md`, which was already the stated rationale
   one entry earlier for G8.

**Also:** `drain`'s no-rows message now names `graph`/`verify` when derived edges
are unsettled, and reuses `graph.mjs`'s `isActionable` rather than re-deriving
"not CLEAN" — the hand-rolled filter said 23 where `graph` said 21, and two
commands disagreeing about what needs work is worse than either being wrong.

**Affects:** propagate

**Refs:** `docs/AUDIT-2026-08.md` (the disposition table),
`~/Documents/GitHub/rules/safety-flag-needs-a-test.md`, `rules/_TODO.md` (row
struck), `~/.claude/gotchas-global.md` G-E–G-H, `tests/helpers/plain.mjs`,
`tests/audit-conversions.test.mjs` (8 tests, both ELIMINATE conversions
mutation-proven red for their stated reason). GOTCHAS **G39** superseded.
Not done this pass: the G33 and G37 DETECT checks, and `absence-claims-need-state-and-branch` (G27) is mapped but unwritten.

---

## 2026-08-17: a symlink that declares a marker is walked; the lifecycle is written down

**What:** two changes that arrived together because the second exposed the first.

1. **`docs/LIFECYCLE.md`** — the hazard machine (RECORDED → RETIRE / PROMOTE /
   ELIMINATE / DETECT / DELIVER), its composition with the edge machine, the
   three kinds of work (instance / mechanism / **machine**), and the two ordered
   lanes the backlog divides into. It restates neither state list: `STATES` lives
   in `lib/reconcile.mjs`, `DISPOSITIONS` in `lib/events.mjs`.

2. **N29 fixed by candidate (b)** — `listDirs` (`lib/discovery.mjs`) and
   `findAllSidecarsRecursive` (`lib/edges.mjs`) now descend a symlinked directory
   **when it carries a `.propagates.yml`**, with a realpath-keyed visited set per
   walk.

**Why (2) followed from (1):** LIFECYCLE.md's subject is three files —
`reconcile.mjs`, `events.mjs`, `skills-lifecycle.mjs` — any of which can silently
falsify it. That is precisely the drift the document warns about, and it could
not be declared, because the skill sits outside `SEARCH_ROOTS` and the only path
in is a symlink neither walk would follow.

**The marker is the opt-in, and that is the whole safety argument.** Following
links by default invites cycles and duplicate workspaces. Requiring a
`.propagates.yml` means the ~dozen incidental symlinks in the tree behave exactly
as before, and a link that declares one is asking to be walked. Verified: the
skill did **not** become an 8th ledger-owning workspace (it is an edge-only
marker), workspace count stayed 11, and `no unowned ledger files` stayed green.

**Fixing one walk proved nothing.** After `discovery.mjs` alone the expanded edge
count was still **711 → 711** and `doctor` still reported IGNORED. Two
independent walks existed for two different jobs — workspaces and sidecars — and
only fixing both made it real: **711 → 720**, 9 edges, 12 of the skill's own
files in the graph. The verification is what caught it; the change looked
complete after the first edit.

**Three stale assertions found by making the change:**

- `doctor` still printed `** declares .propagates.yml and is being IGNORED **`
  when the link was, by then, being followed.
- `tests/journal.test.mjs` asserted that same message. Inverted in place rather
  than deleted — the fixture that used to prove the gap is the strongest
  evidence the fix works — and joined by a new test that an unmarkered link is
  still skipped.
- `gotchas-global.md` G-C's trigger used `[^|]*`, which matches newlines, so a
  `$?` three commands later fired it. Narrowed to `[^|\n]{0,40}`; the true
  positive still fires and the multi-line false positive is silent. **Second
  false-positive trigger of the day** — the first was
  `every-project-carries-gotchas`'s fingerprint punishing adoption.

**Known limit, recorded not fixed:** `check --changed` is repo-scoped, and the
skill is its own git repo, so `check` run from the hub cannot see its diffs. The
edges are live in `reconcile`/`graph` regardless, because those derive from
content rather than from git.

**Affects:** propagate

**Refs:** `docs/LIFECYCLE.md`, `lib/discovery.mjs` (`MARKER`, `listDirs`,
walk cycle guard), `lib/edges.mjs` (`findAllSidecarsRecursive` symlink branch),
`cli.mjs` (doctor symlink line), `.propagates.yml` (restored from
`docs/deferred/own-sidecar.yml`, plus LIFECYCLE and AUDIT edges),
`tests/journal.test.mjs` (2 tests). `docs/ISSUES.md` **N29** resolved.

---

## 2026-08-17: a background monitor lands three days after one was retired — and why that is not a reversal

**What:** `propagate monitor` — a launchd agent (`com.tathya.propagate.monitor`,
`WatchPaths` on discovered workspace roots, `ThrottleInterval` 300,
`StartInterval` 1800) that runs `reconcile`, notifies on anything actionable, and
writes **no drift anywhere**. Generated by `monitor --install`; **not loaded** —
arming it is a separate human step.

**Why this is not the retired watcher.** The v1 watcher was retired 2026-08-14 on
measured grounds: 4,420 runs, 4,384 no-ops (99.2%), and a `state.json` mtime
baseline that caused two incidents in one day — a wipe that fired ~120 spurious
rows. The retirement entry is explicit that it cost something real: *"What is
genuinely lost, not just traded: sub-daily proactive notification."* This closes
that gap without restoring the mechanism, and the whole argument is one property:

| | v1 watcher | monitor |
|---|---|---|
| Detection | diff against a remembered mtime baseline | `reconcile`, derived from content |
| A missed trigger | **information gone** — it had to *catch* the change | costs nothing; derive later |
| Corrupt state | **invents drift** | one duplicate notification |
| Writes | drift rows → a queue to drain | telemetry only |

**v1 was harmful because it had to catch the moment.** A stateless derivation has
no moment to catch, which is what makes the same trigger mechanism safe.

**The no-op ratio will be just as bad, and that is fine.** 48 runs/day against
v1's 1,440 minimum, each ~770ms. What damned 4,384 no-ops was not waste — it was
that each touched mutable state that could invent drift. A no-op here reads files
and exits.

**The one thing it remembers is what it TOLD you**, keyed on the content triple
`(edge_id, source_content, downstream_content)` — the same key
`knownGoodPairs()` uses. That choice is load-bearing: mtime-keyed memory going
wrong invents drift; content-keyed memory going wrong costs exactly one duplicate
notification, because the key is derived from the bytes it describes. Measured in
`tests/monitor.test.mjs`, not asserted.

**A separate label, deliberately.** `lib/plist.mjs`'s `LABEL` still defaults to
the retired watcher's name. Generating through `regeneratePlist` would have
written over the retired job's plist, resurrected its label, and broken `doctor`'s
retired-watcher assertions — three bad outcomes from one convenience. The monitor
gets `writeMonitorPlist`, its own label and path, and reuses only the WatchPaths
derivation and the N14 zero-watch-root refusal.

**`WatchPaths` alone is not enough, and the plist already said so.**
`lib/plist.mjs` records that WatchPaths fires only on direct-child changes, which
is exactly why v1 carried `StartInterval 60`. A floor is still required; it is
1800s rather than 60s, and a missed trigger no longer costs anything.

**Liveness distinguishes three states or it is not a probe:** never ran (no log),
ran and found nothing (`notified=0`), ran and told you (`notified>0`). `doctor`
reports it as **informational**, because "generated but not armed" is the expected
state and must not read as broken. `docs/SYSTEMS.md`'s `adoption_date` is BLANK
until a notification it sent resolves an edge sooner than the daily digest would
have — firing is not helping, and that is the distinction the v1 watcher failed.

**Affects:** propagate

**Refs:** `lib/monitor.mjs`, `cli.mjs` (`monitorCmd`, `--dry-run`, `--install`,
the doctor liveness probe), `lib/plist.mjs` (`writeMonitorPlist`,
`watchPathsFor`, `MONITOR_LABEL`), `tests/monitor.test.mjs` (13 tests; three
mutations — keying on `edge_id` alone, notifying on `NEVER_VERIFIED`, logging only
when notified — each red for its stated reason). `docs/SYSTEMS.md` row added.

### Correction, same day: the cost figure was measured warm

`~770ms` above describes an **interactive** run with a warm filesystem cache. The
first production run under launchd was **5088ms** for 724 edges — 6.4x — because
launchd gives a bare environment and nothing is cached. Re-measured at the same
moment for comparison: 792ms and 798ms interactively.

So the daily budget is **48 × ~5s ≈ 4 minutes of CPU**, not the ~37 seconds this
entry originally claimed. Still modest against the retired watcher's 1,440
runs/day, and the argument for the design is unchanged — but the number was
wrong by 6.4x and quoted in three files, so it is corrected rather than left to
be re-derived by someone who trusts it.

`rule:discernment-checks` §4: a figure measured under conditions that differ from
production is a different quantity than the one being claimed. The honest form
names both and says which is which.

---

## 2026-08-20 — `lib/` and `tests/` grouped into directories

**Affects:** propagate

**Every `lib/…` and `tests/…` path in entries ABOVE this line is pre-move.** This entry
is the map. Past entries are not edited — `rule:state-and-decisions` is append-only, and
rewriting 66 historical citations would destroy the evidence trail those incident
write-ups exist for. Read an older path by looking it up here.

| `lib/core/` | `config.mjs`, `discovery.mjs`, `setup.mjs`, `which.mjs`, `lock.mjs`, `state.mjs`, `git-context.mjs`, `worktrees.mjs`, `plist.mjs` |
| `lib/edges/` | `edges.mjs`, `frontmatter.mjs`, `reconcile.mjs`, `events.mjs`, `ledger.mjs`, `content-id.mjs`, `refs.mjs`, `code-canonical.mjs`, `cross-repo.mjs`, `bootstrap.mjs`, `journal.mjs` |
| `lib/graph/` | `graph.mjs`, `graph-html.mjs`, `graph-index.mjs` |
| `lib/report/` | `docs.mjs`, `doc-kind.mjs`, `decisions.mjs`, `metrics.mjs`, `adoption.mjs`, `inventory.mjs`, `backlog.mjs`, `monitor.mjs`, `notify.mjs` |
| `lib/skills/` | `skills-create.mjs`, `skills-lifecycle.mjs`, `skills-scan.mjs`, `index-db.mjs` |
| `lib/rules/` | `rules-check.mjs` |

`tests/` moved from flat to `unit/`, `cli/`, `digest/`, `docs/`, `portability/`,
`watcher/`, keeping `helpers/`. Grouped by **what a test exercises**, not by mirroring
`lib/`: a large share are CLI-level and touch several lib concerns at once, so filing
them under whichever module they import first would misdescribe them. Anything
unclassified stayed visible rather than being swept into a default bucket.

**Why now.** Zero events referenced any `propagate-skill/` path — its own edges are all
`NEVER_VERIFIED`, never baselined. `edgeId` is derived from the source path, so the same
move after baselining would silently reset every verification. It was free today and
would not have been later.

---

## 2026-08-20 — `bin/make-public.mjs`: watchlist completeness (Lane B, plan §2)

**Affects:** propagate

`make-public --check` previously refused only when `identity-map.json` was missing or
empty — never when it was *incomplete*. A new client name appearing later would be
scrubbed by nothing and leak silently.

**Watchlist source: depth-1 directory names under `SEARCH_ROOTS`** (`lib/core/config.mjs`),
not discovered workspaces. Discovery was tried first and is wrong — it only sees
directories carrying a `.propagates.yml` marker, and three real names that leak in the
production tree have none: `Tathya` (11 files), `Khushboo` (4), `Tushar` (4). Directory
names cover all seven; this was verified before writing the code, per the plan's explicit
instruction not to substitute a different source.

**Map format extended, backward compatible:**
```jsonc
{ "names": { "Some Client": "workspace-a" }, "allow": ["Motherboard", "rules", "scripts", "_archive"] }
```
A flat object with no `"names"` key (every map on disk today) is treated as
`{ names: <that object>, allow: [] }` — `normalizeMap()` in `bin/make-public.mjs`. No
migration required for the one production map file.

Every depth-1 directory must be a `names` key or an `allow` entry, or the build exits 2
naming the specific unmapped directories (not just "something is unmapped"). Verified
RED-first: `tests/portability/make-public-watchlist.test.mjs` — 2 refusal cases (fresh
map shape, flat legacy shape) failed before `checkWatchlistCoverage()` existed (exit 0,
should have been nonzero), and 3 pass cases (allow-listed, name-mapped, flat-legacy-fully-covered)
were green throughout, proving the RED cases were the code path under test and not a
harness bug.

`lib/core/config.mjs` is imported for `SEARCH_ROOTS` only (a pre-computed export); no new
side effect is added to its module-load path.

**Cost paid, recorded honestly.** Seven distinct path-depth classes had to be fixed, each
found only by running the suite: quoted specifiers, segment-form `path.join`,
trailing-`".."` constants, `new URL()` arguments, double-bumped `helpers/`,
non-recursive `readdirSync`, and `SKILL_DIR`'s own `".."` count. Then two defects caused
by the fixes themselves — see `docs/GOTCHAS.md` G51. `SKILL_DIR` now walks up to a
marker (`package.json` + `SKILL.md`) instead of counting, so the next regrouping cannot
repeat that one.

`.propagates.yml` was updated in the same commit; `check --changed` names all five moved
sources at their new paths, so no edge died in the move.


---

## 2026-08-21: `rules check` reported a declared deviation only if the file also restated the rule

**What:** in `lib/rules/rules-check.mjs`, the override test now runs **before** the
fingerprint gate. Previously the loop read:

```js
if (!re.test(raw)) continue;      // fingerprint gate
if (ov.test(raw)) { ...overrides.push... }
```

so a `CLAUDE.md` was considered for override detection **only if it also matched the
rule's fingerprint** — that is, only if it restated the rule.

**Why that is backwards.** The rules directory exists to make files *reference* a rule
(`rule:<id>`) rather than restate it; restatement is the failure it was built to end,
after 9 copies of tool-priority carrying 4 mutually exclusive claims. The `overrides:`
escape hatch exists so that genuine divergence stays **visible**. Gating it behind the
fingerprint meant **the cleaner the file, the less likely its declared deviation would
ever be seen** — the two mechanisms worked against each other, and the failure was silent.

**Found in the field, not by reading.** `Motherboard/CLAUDE.md` declared
`overrides: state-and-decisions` and `rules check` reported one deviation in the tree,
Vipin Kaushik's. The Motherboard declaration only appeared after its paragraph was
reworded to state what the rule requires — i.e. after adding a restatement, which is the
thing the whole system discourages. That workaround has now been removed and the
declaration is still detected, which is the end-to-end proof: the file does **not** match
the fingerprint and the deviation is still reported at `CLAUDE.md:8`.

**Test first, and it failed for the stated reason.** `tests/cli/rules-check.test.mjs`
gains *"a declared override is reported even when the file does NOT restate the rule"*.
It went red at `0 !== 1` before the change and green after. The pre-existing override test
was not wrong, but its fixture happened to contain the fingerprint (*"Doppler is the
source of truth elsewhere"*), which is exactly why the gap survived: **the only test
covering overrides could not distinguish the two orderings.**

Full suite after the change: **881 tests, 881 pass, 0 fail.**

**Not changed:** `overrideRe` itself. Its near-miss cases still hold — `rule:<id>` does
not count as an override, prose mentioning both words does not, and a longer id
(`<id>-extended`) must not match. Only the ordering moved.

**Affects:** propagate-skill, Motherboard, Vipin Kaushik
**Refs:** `lib/rules/rules-check.mjs`, `tests/cli/rules-check.test.mjs`

## 2026-08-22: the consolidation merge orphans edge history, and that is accepted rather than mitigated
**Affects:** propagate-skill, curate-docs-skill

**Decision:** the planned subtree merge of `curate-docs-skill` into this repo will reset every
edge id, orphaning all prior verification history. We accept this, record it here, and do **not**
build an id remap.

**Why the obvious mitigation does not work.** The consolidation plan sequenced "fix N40 first" on
the stated grounds that stable edge identity would carry verification history across the move.
Measured, that reasoning is wrong. `toNodeId` is already repo-relative — `basename(repoRoot):relPath`
— and N40's defect was only that the *downstream* half was minted from an absolute path. Fixing that
(done, same day) makes identity survive a **checkout moving between mounts**, which is the failure
that actually fired twice when this repo was flipped hub <-> skills-folder. It does nothing for a
subtree merge, because that move changes the repo-relative path itself: `docs/X.md` becomes
`skills/propagate/docs/X.md`, and the repo basename changes too. Repo-relative identity cannot save a
path whose repo-relative form is what moved.

**Why not remap.** Neither existing tool covers it. `migrate-ledger` renumbers every id for what is
only a file move (and its `--all-refs` mode is under an open S2, N41, for silently discarding
differing dispositions). `relocate-ledger` moves the ledger file with ids untouched precisely
*because* paths survive a same-workspace move — its own header says so. There is no
`previous_edge_id` concept in the event schema. Building one would mean deliberately rewriting an
append-only store, which is the exact operation that produced 11 spurious events and 3 falsely-closed
edges on 2026-08-17 (docs/GOTCHAS.md G44, rule:safety-flag-needs-a-test).

**Consequence, stated so it is not mistaken for something else.** After the merge, edges will read as
unverified. That means "verified before the 2026-08 consolidation", not "never verified" — this entry
is the distinction, since the store itself cannot express it. Re-verification is affordable at the
current ledger size; it would not have been at ten times the size, and that is the condition under
which this decision should be revisited.

**Also landed with this:** `watcher.mjs` deleted (797 lines, retired 2026-08-14) along with the four
test files that imported it and `watcher-retired.test.mjs`, whose assertions are preserved by the
2026-08-14 entry above. Both reusable halves had already been relocated to `lib/edges/edges.mjs` and
`lib/edges/cross-repo.mjs`, each independently covered, so no live behaviour lost its tests.

## 2026-08-22: the repo is renamed propagate-skill -> propagate, orphaning 30 edges

**Affects:** propagate, workspace-hub

**Decision:** rename the repository, the local checkout and the GitHub remote from
`propagate-skill` to `propagate`. Accept that ~30 events lose their edge identity.

**Why now.** The repo stopped being a skill today. It is a plugin that CONTAINS two skills
(`propagate`, `curate-docs`) plus three hooks. Every other identifier already said
`propagate` — `.claude-plugin/plugin.json`'s `name`, the `tathya` marketplace entry, and both
routers' frontmatter. The repo name was the last thing contradicting them, and `-skill`
encoded a packaging decision that has now changed once.

**The cost, measured before deciding.** `toNodeId()` derives `basename(repoRoot):relPath`, so
the directory name is part of every edge id in this repo. Constructing the same file under
both names confirms it: `propagate-skill:docs/A.md` vs `propagate:docs/A.md`. That is N40's
deliberately-unfixed residual, and this is exactly the case it predicted.

Blast radius **30 of 1,912 events (1.6%)** — the ledger is dominated by other repos
(PanditPawanKaushik 1014, Vipin Kaushik 334, SSJK-mb 97). The 477 baselines written earlier
today are almost all in other repos and are unaffected. Had the ratio been reversed this
rename would not have been worth it.

**Why not fix N40's residual first.** A stable repo identifier needs a decision about repos
with no remote, of which this tree has several. Renaming 30 edges is cheaper than designing
that now, and the residual stays recorded rather than silently paid.

**What was updated, and what deliberately was not.** 106 mentions across 45 files; only
**four were functional**: the marketplace `source`, the `skills-marketplace/propagate-skill`
symlink, a declared edge in `rules/.propagates.yml` (`../propagate-skill/docs/GOTCHAS.md`),
and two paths in `skills/curate-docs/tests/repos.test.mjs`. Plus three metadata URLs.

The rest are **history and stay unrewritten** — `docs/DECISIONS.md`, `docs/ISSUES.md`,
`propagation/ledger.md` and the Obsidian dailies describe a repo that WAS called
`propagate-skill` at the time they were written. Rewriting an append-only record to match a
later name is the failure those files exist to prevent.

**Side effect worth naming:** `curate-docs-skill/.propagates.yml` declared
`../propagate/lib/report/doc-kind.mjs`, which `doctor` reported as "declare-ahead, not on
disk". The rename made that path real, so the warning cleared by coincidence rather than by
intent. Recorded so nobody reads it as a fix.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## 2026-08-22: Rupali59/curate-docs-skill is archived

**Affects:** propagate, curate-docs

**Decision:** archive the standalone repo. Its content ships inside this plugin at
`skills/curate-docs/`, and its marketplace entry has been removed.

**Verified before archiving, not after.** Three files existed in the standalone and not in
the vendored copy, and all three are deliberate supersessions:

| Only in standalone | Superseded by |
|---|---|
| `skills/design/SKILL.md` | `sections/design.md` — H1 identical, body 484 -> 541 words (the when-line was added) |
| `skills/eng/SKILL.md` | `sections/eng.md` — H1 identical, body 668 -> 721 words |
| `.github/workflows/test.yml` | the merged matrix here, which runs `npm test --prefix skills/curate-docs` |

Nothing was only-in-standalone in the sense of being lost. The repo was clean and fully
pushed at the moment of archiving.

**Archived, not deleted, and that is the point.** An archived GitHub repo stays clonable
read-only, so `source: url` still resolves and the rollback survives. Deleting would have
spent that safety margin for no gain. The local checkout at `~/Documents/GitHub/curate-docs-skill`
is kept for now — it holds the only copy of that git history on this machine.

**Side note recorded so it is not misread as a fix:** that repo's sidecar declared
`../propagate/lib/report/doc-kind.mjs`, which `doctor` reported as declare-ahead. The
propagate-skill -> propagate rename made that path real, so the warning cleared by
coincidence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

---

## 2026-08-29: `.claude/rules/` is native; load-rules stops injecting and keeps only detection

**What:** `hooks/load-rules.mjs` no longer emits rule bodies. It emits one 370-byte
summary line plus the restatement findings. Claude Code delivers the rules. Plugin
0.3.0 -> 0.4.0 (both `marketplace.json` entries too, per G63), cache updated and
byte-verified against the served path.

**Why:** `.claude/rules/` is a **native Claude Code memory directory**, not a
convention this tree invented. Verified against the CLI binary (2.1.236), which
documents it as *"organizing instructions into `.claude/rules/` as separate focused
files … These are loaded automatically alongside CLAUDE.md"*, walked *"including
nested directories"*, scopable via `paths` frontmatter. `~/.claude/rules` is a
symlink to this tree's `rules/`, so every file under it was already in every
session's context labelled *"(user's private global instructions for all projects)"*.
This hook, written 2026-08-14, closed a gap the platform had already closed.

**Measured 2026-08-29, one session:** hook payload 51,112 B (16 rules) + file-side
132,228 B (19 flat + 4 `conventions/`) + CLAUDE.md chain 28,263 B ~= 211,600 B
(~53k tokens) before a single tool call. The 16 rule bodies appeared **twice**.
STATE.md's open question *"confirm rules are injected once, not twice"* is answered:
twice, for 15 days. Hook payload is now **370 B**.

**Gotchas:** deleting the hook was the obvious move and would have been wrong — it is
also the **restatement detector**, the thing that catches the 9-divergent-copies
failure the rules layer exists for, and that has no native equivalent. Delivery moved
to the platform; detection stayed. Cost paid: `applies(r, cwd)` can no longer filter
what a session *receives* (native has no `scope:`), so `nextjs-dev-server-port`
(`scope: next-projects`, 53 lines) now reaches every session. The native fix is
`paths:` frontmatter, which is finer-grained — **not** re-adding body injection.

**Also corrected:** `load-rules.mjs:18` and `rules/_TODO.md` called
`motherboard-integration.md` / `nextjs.md` / `tailwind.md` *"legacy `paths:`-format
drafts … inert by construction"*. `paths:` is the NATIVE scoping key. Those three
files were written for the real mechanism and judged non-conforming by this one;
all three have since been deleted from the tree.

**Verified:** 1234/1234 tests pass. The replaced assertion (`/Canonical rules/`, "the
rules themselves must still load") became an attributability assertion plus a
regression guard against re-injection — mutation-tested by re-adding a `### rule:`
body and confirming it goes red for the stated reason.

**Not done, and gated on a human:** `claudeMdExcludes` in `~/.claude/settings.json`
(~67 KB of `conventions/`, `_TODO.md` and `gotchas-global.md` that are not rules).
Three attempts — Bash, Edit, and the `update-config` skill — were all refused by the
auto-mode classifier, which is correct: that file controls permissions and hooks.

**Affects:** propagate
**Refs:** `hooks/load-rules.mjs`, `tests/hooks/load-rules-drift.test.mjs`,
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`skills-marketplace/.claude-plugin/marketplace.json`
