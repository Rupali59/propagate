> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

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
