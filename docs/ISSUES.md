> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# Propagate — issue register

Consolidated 2026-08-13 from two sources: problems observed live during a long workspace session,
and the skill's own self-documented defects (in-code `TODO`/`deferred` markers, `SKILL.md`'s
"does NOT do" section, and `docs/DECISIONS.md`).

**Grouped by failure mode, not by module.** That is the finding: eleven S1s are largely *one*
defect wearing different clothes.

Severity — **S1** silently wrong (you cannot tell it happened) · **S2** noisy or misleading ·
**S3** friction.

Scale at time of writing: 1,460 rows / 298 open across 8 ledgers · 16 markers · 7 workspaces ·
5 project families. Open rows tripled in three days.

---

## The root defect: the silent no-op

Every entry in this section fails by doing nothing, successfully. No error, no counter, no log.
This is the class the spec must close.

### N1 · Unknown row types are dropped, and the stats are discarded — **S1**
`lib/ledger.mjs:171-203` folds three cases and sends everything else to an `unknownTypes` counter —
then `readLedger` (`:210-213`) throws that counter away and returns only rows. **Every caller is
blind to both `unknownTypes` and `malformed`.**

Cost, measured: a `type: "manual"` row at `Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl` line 470 has
been invisible to `readLedger`, `renderMarkdown`, `nextId`, `hasOpenDuplicateDrift`, `check`, and
every drain path **since 2026-06-20**. Type counts in that file: `drift 215`, `status_change 312`,
`code_drift 136`, `manual 1`.

*Fix:* return stats to callers; `doctor` reports non-zero `unknownTypes`/`malformed` as a failure.

### N2 · `nextId` is check-then-act racy **and** type-blind — **S1**
`lib/ledger.mjs:244-251` computes `max+1` over *visible* rows with no lock. `appendRowWithId`
(`:144-161`) exists precisely to fix this race and its docstring says so — but `watcher.mjs:227`
still uses `nextId()` + `appendRow()` for the primary per-workspace ledger. Only the cross-ledger
path uses the atomic variant.

Cost, measured: because N1 hid the `manual` row's id, **id 256 exists twice** in the Vipin Kaushik
ledger — line 470 (`manual`) and line 474 (`drift`, source `docs/MEASUREMENT.md`) — with a single
`status_change` at line 507 that is ambiguous by construction.

Also: `parseInt("256abc")` is `256`; ids are never validated.

*Fix:* watcher uses `appendRowWithId`; ids become non-sequential (see N3).

### N3 · Sequential ids cannot survive branches — **S1**
Ids derive from file content, so two branches each appending from `max=255` both mint `"256"`. On
merge, `readLedger`'s id-keyed `drifts` Map collapses them last-line-wins, and they share one
`status_change` namespace. Not hypothetical — N2 produced the same collision by another route.

*Fix:* ULID or content-hash for new rows; existing ids are strings and stay.

### N4 · `markStatus` no-ops on an absent or misordered id — **S1**
The writer always succeeds; the drop is in the reader. `lib/ledger.mjs:186-188`:

```js
if (row.type === "status_change") {
  const existing = drifts.get(row.id);
  if (existing) existing.status = row.status;
}
```

No `else`, no counter, no warning. A `status_change` for a nonexistent id vanishes. So does one that
appears *before* its drift row, since folding is a single forward pass. It isn't even counted in
`unknownTypes`.

**And `markStatus` has no production callers** — grep finds it only in its own definition and
`tests/dedup-pathcheck.test.mjs`. Every status transition on 1,460 rows was written from outside the
skill. There is no supported close path.

*Fix:* throw on absent id; add a supported drain/close interface.

### N5 · `hasOpenDuplicateDrift` cannot see `code_drift` — **S1**
`lib/ledger.mjs:121-142`: the loop's `if (r.type === "drift")` excludes `code_drift` from
`driftById`, and the `else if` excludes it from `statusById` too. Two reasons stack, so **all 136
`code_drift` rows are outside the dedup window** — every mtime bump appends a new row.

Visible today: `astroacharya/app/api/calendar.py` and `calendar_combined.py` each hold **3 open
rows** in the Vipin Kaushik ledger.

*Fix:* dedup on `(type, source, downstream-set)`.

### N6 · Glob `kind: code` edges silently never fire — **S1**
`lib/edges.mjs:184-190` logs and skips. `check` passes no logger (`cli.mjs:848` → `noopLogger`), so
the deferral isn't even printed. A doc declaring `path: lib/**/*.ts, kind: code` gets **zero**
coverage in both watcher and gate while looking declared.

Self-documented in five places (`SKILL.md:161,199-205,278`, `edges.mjs:161,216-218`,
`tests/code-drift.test.mjs:59`) as "documented limitation, not a bug" — but the user-visible effect
is indistinguishable from a working edge.

*Fix:* until implemented, `doctor` lists glob-code edges as **unenforced**.

### N7 · A missing `PROPAGATE_SEARCH_ROOTS` reports healthy forever — **S1**
On a machine that keeps code outside `~/Documents/GitHub`, discovery finds zero workspaces and the
watcher reports healthy. Named in `lib/config.mjs`'s own comment as "precisely the *abandoned
automation reports itself healthy* failure this skill exists to catch." Mitigated by the override
(`3c4eb65`), not closed — zero-workspace discovery is still a silent success.

*Fix:* zero discovered workspaces is a `doctor` failure, not a quiet pass.

### N8 · Worktree enumeration swallows failure — **S1**
`lib/worktrees.mjs:181-185` — bare `catch { return []; }`, no log, no stderr. The watcher then
falls back to canonical-only silently. `watcher.mjs:569-572` has its own logging catch, but layer 1
already swallowed, so that catch is dead code.

*Fix:* surface the failure; keep the fallback.

### N9 · Schema rejection stops a sidecar's edges silently — **S1**
`additionalProperties: false` means a marker carrying a field the schema doesn't know is rejected by
`loadSidecar`, and that sidecar's edges simply stop firing. Recorded in `docs/DECISIONS.md`
2026-08-10 as the reason schema must ship *before* any marker gains a field.

**We triggered this ourselves on 2026-08-13, and it is live right now.** Tightening the schema to
reject a `path` ending in `/` (the directory-as-downstream guard) turned
`PanditPawanKaushik/SSJK-mb/.propagates.yml` from *"loads, with one path that does not resolve"*
into *"does not load at all"*. Every edge in that sidecar has stopped firing. Visible in
`watcher.log`:

```
synthesizeKindCodeEntries: skip broken sidecar .../SSJK-mb/.propagates.yml:
  schema violation: /sources/…task-engine-v2.md/propagates_to/5/path must NOT be valid
```

Net effect is **worse than the bug it catches** — one malformed path was traded for a wholly
disabled sidecar. The lesson generalises beyond us: N9 makes *any* schema tightening a potential
outage for existing markers, so the rule recorded on 2026-08-10 ("schema before field") needs its
mirror image: **a schema constraint must not be able to disable a file that previously worked.**

*Fix:* validation must be per-entry, not per-file — a malformed `path` invalidates that downstream
and reports it, while the sidecar's other edges keep firing. Rejecting the whole file makes the
validator a bigger outage than the thing it validates. Until that lands, weigh any new constraint
against the sidecars already on disk.

*Fix:* rejected sidecars are a loud `doctor` failure naming the file and field.

### N10 · `SKILL.md` documents a launchd label that does not exist — **S1**
`SKILL.md:15,116,131,243-244` say `com.rupali.propagate`; `lib/plist.mjs:25` uses
`com.tathya.propagate.watcher`. Every documented `bootout`/`bootstrap` command targets a nonexistent
label and **fails silently**.

Observed live: the watcher was paused before git surgery, believed stopped, and ran throughout. It
shipped into a publishable plugin at `3c4eb65`.

*Fix:* correct the doc; have `doctor` print the label it actually found.

**Doc half RESOLVED 2026-08-13.** `SKILL.md` and `docs/REFERENCE.md` now carry the real labels
(`com.tathya.propagate.watcher`, `com.tathya.propagate.digest`), and `tests/skill-doc.test.mjs`
asserts every label in an executable context is actually installed, so this cannot silently return.
The `doctor`-prints-the-resolved-label half is still open.

### N12 · Every `Affects:` line in `DECISIONS.md` parses to nothing — **S1**
`lib/decisions.mjs:58` matches `/^Affects:\s*(.+)$/m` — a bare `Affects:` at line start. All 8
entries in `docs/DECISIONS.md` write `**Affects:**` in markdown bold. Zero match.

Measured 2026-08-13 by running the parser against the live file: **8 entries found, 0 with tokens**;
`affectsRaw` and `tokens` come back empty for every entry, old and new alike. The hub `CLAUDE.md`
describes this field as "machine-parsed by `lib/decisions.mjs` and gated by an external pre-commit
script" — so the gate has been evaluating an empty token set and passing everything.

This is I1's failure mode inside the decision log itself: the mechanism that records *why* a choice
was made cannot read its own attribution field, and nothing said so. Found while appending the
premise and skills-split entries, not by any check.

*Fix:* accept both forms (`/^\*{0,2}Affects:\*{0,2}\s*(.+)$/m`) and make a zero-token parse of a
non-empty file a `doctor` failure rather than a silent empty array. Add a test that parses the real
`docs/DECISIONS.md`, not only synthetic fixtures — `tests/decisions.test.mjs` passes 4/4 today
precisely because its fixtures use the bare form the live file never uses.

### N13 · `PROPAGATE_SEARCH_ROOTS` does not scope state, so testing the watcher corrupts production — **S1**
`lib/config.mjs:86-88` fixes `STATE_PATH`, `LOCK_PATH` and `HEARTBEAT_PATH` to `SKILL_DIR` with no
env override, while `SEARCH_ROOTS` *is* overridable. So the documented way to exercise the watcher
safely — point it at a temp tree — silently rewrites the real mtime baseline with the temp tree's.

**Caused a live incident on 2026-08-13.** A verification run of
`PROPAGATE_SEARCH_ROOTS=/tmp/watcher-verify node watcher.mjs` overwrote `state.json`. The next
launchd run saw all 203 tracked files as unseen and fired **120 events (40 drift, 80 code_drift)**
into the Vipin Kaushik ledger between 11:15:26Z and 11:18:45Z. Ruled out as the cause: no branch
checkout in either repo since 2026-08-12, and `state.json` re-seeded to 203 entries afterward,
consistent with a wipe-then-reseed rather than genuine drift.

Every one of those 120 rows is indistinguishable from real drift — same shape, same fields. The
ledger has no way to say "this fired because the baseline was lost."

*Fix:* scope state to the search roots, or add `PROPAGATE_STATE_DIR` alongside
`PROPAGATE_SEARCH_ROOTS` so the two move together. Relates to the deferred state-relocation item
(state living inside the plugin dir is also destroyed by a marketplace plugin update). Until then,
**there is no safe way to run the watcher by hand** — say so wherever the manual invocation is
documented.

### N14 · `init` rewrites the real plist from a scoped run, disarming the watcher — **S1**
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

### N15 · `init` creates a marker that is not a workspace — **S2**
`cli.mjs init` writes a template containing `sources: {}` and **no `workspace: true`**. Since
`lib/discovery.mjs:113` promotes a marker to a ledger-owning workspace only on a strict `true`,
the directory `init` just created is invisible to discovery. Reproduced 2026-08-13: init printed
`✓ created …/.propagates.yml` and then `discovered 0 workspaces`, reporting both as success.

So the onboarding command cannot, by itself, onboard anything. Combined with N14, running it also
wipes the WatchPaths of every workspace that already worked.

*Fix:* the template sets `workspace: true` (or `init` asks whether this is a ledger-owning root
versus an edge-only sidecar, since both are legitimate — see A3), and init fails loudly when the
directory it just initialised does not appear in the subsequent discovery.

### N11 · Moving a directory silently breaks every `../` edge — **S1**
`propagates_to` paths and `sources:` keys both resolve relative to the sidecar's own directory.
Moving the parent breaks all of them, and `doctor` reports only a yellow "downstream missing" —
indistinguishable from a declare-ahead entry.

Hit twice in one day: `design/` → `docs/design/` (3 paths), then the `docs/` reorg (9 source keys).

*Fix:* keep a last-seen set in `state.json`; "existed at last run, now missing" is a break, not a
warning.

---

## Ledger attribution

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
deferral's **expiry signal** — it has since fired.

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

### B1 · Sidecars are branch-local; `doctor` is not branch-aware — **S1**
*(was S2; re-ranked 2026-08-13 — see note above)*

16 of VipinKaushik's 31 specs exist only on `feat/hero-v4-rebuild`. A sidecar landing with that
branch shows unresolved paths from production's perspective, indistinguishable from N11.

**Caught live, 2026-08-13 — it is worse than "sidecars".** A whole *ledger* is branch-local and
undiscovered:
`PanditPawanKaushik/.claude/worktrees/client-answers-propagation/docs/PROPAGATION_LEDGER.jsonl`,
79 rows, **1 of them open**. `discoverWorkspacesSync` returns 7 workspaces and that path is not
among them, so the row appears in no `status --all` and no `doctor` run. Discovery never descends
into `.claude/worktrees/<name>/`.

The sharpest part: `doctor`'s `duplicateOpenAcrossLedgers` assertion passes over this, because it
cannot see the second ledger to compare against. A check whose failure case is invisible to it
reports success either way — I1, inside the safety net built to catch I1.

Found only because a data-model census walked the filesystem directly rather than asking discovery.
See `docs/DATA_MODEL.md` §9.

*Fix (superset of the sidecar case):* discovery enumerates worktrees via `git worktree list` — the
machinery already exists in `lib/worktrees.mjs` for expanding sidecar paths — and either adopts
worktree ledgers or reports them as unreachable. Silently not-looking is the one option I1 forbids.

### B2 · Squash merges defeat ancestry checks — **S1**
*(was S2; re-ranked 2026-08-13 — see note above)*

13 branches read as unmerged by `git branch --merged` while their content was live in production.
`git cherry` (patch-id) sees through it. A git property rather than a skill bug — but it produced a
wrong conclusion about lost work, and the skill is the natural place to document it.

---

## The commit-time gate

### G1 · `check --range` interpolates argv into a shell — **S1, security** — **RESOLVED 2026-08-13**
`cli.mjs:923`: `` execSync(`git diff --name-only ${range}`) `` — no validation, no `execFileSync`.
Any shell metacharacter in `--range` executes. This is a tool explicitly intended for git hooks and
CI, i.e. for hostile-ish input.

*Fix:* `gitDiffNames` now takes an argv array and runs `execFileSync("git", args, {cwd, encoding})` —
no shell is ever spawned, so a hostile `--range` value (e.g. `x; touch ...`, `x$(...)`, `` `...` ``)
is passed to git as one literal argument, which git rejects as an invalid revision; `check` exits 2
with no side effect. All four call sites (`check`'s `--range`/`--staged`/default-`--changed` paths)
converted. Verified: pre-fix, `node cli.mjs check --range 'HEAD; touch /tmp/x'` created `/tmp/x`;
post-fix it does not (`tests/check-injection.test.mjs`, 5 tests, including a legitimate-range
regression test proving behaviour is otherwise unchanged). The other `execSync` calls in `cli.mjs`
(`:245`, `:446`, `:578` — `launchctl list`, `launchctl list`, `claude mcp list 2>&1`; `:934` — `git
rev-parse --show-toplevel`) are fixed literal strings with no argv interpolation and were left as-is.
The `docs/REFERENCE.md` pre-push-hook blocker note tied to this issue is removed — see that doc.

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
- **`cli.mjs init` re-arms launchd as a side effect** — flagged in the skill's own `STATE.md` and
  `DECISIONS.md` as surprising, should be split into a `reload` mode. Unfiled until now.

---

## Suggested order

1. **N10** — one-line doc fix; removes an invisible failure mode already shipped in a plugin.
2. **G1** — injection in a hook-facing tool.
3. **C1** — coverage reporting. Highest value per effort; would have caught the privacy regression.
4. **N1 + N4** — surface dropped rows; make close supported and loud.
5. **N2 + N3** — id integrity, prerequisite for any branch-aware or merge-aware work.
6. **N5** — dedup `code_drift`; directly reduces open-row growth.
7. **B1 + B2** — branch/merge blindness. Re-ranked S2 → S1 2026-08-13: under the parallel-coordination
   premise this is premise-critical, not noise, but it is sequenced after the id-integrity work
   (5, 6) because branch-aware `doctor` checks and merge-aware dedup both build on ids that survive
   branches and merges (I5) — doing this first would need redoing once N2/N3 land.

Everything else is friction rather than error.

## Related

- `docs/SPEC.md` — the specification these fixes resolve to
- `Vipin Kaushik/docs/plans/2026-08-13-propagation-issues.md` — the incident narrative this register
  supersedes
- `docs/DECISIONS.md` — six 2026-08-10 entries that constrain any fix
