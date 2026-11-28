> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# propagate — Reference

Paths, the complete CLI surface, install/disable sequence, and architecture.
For "what do I do right now," go back to `SKILL.md`.

## Canonical state

- Watcher script: `${CLAUDE_PLUGIN_ROOT}/watcher.mjs` — **RETIRED
  2026-08-14** (`docs/DECISIONS.md`). Kept on disk as history; the file
  refuses to run directly (`node watcher.mjs`) unless
  `PROPAGATE_ALLOW_RETIRED_WATCHER=1` is explicitly set. Its exported
  functions are still imported directly by several tests — that import path
  is unaffected, only running it as a script is blocked. `reconcile`,
  `check`, and the daily digest's DRIFT/INBOUND sections are the
  replacement; see the retirement note in `SKILL.md`.
- Worktree helpers: `${CLAUDE_PLUGIN_ROOT}/lib/core/worktrees.mjs` — as of
  2026-08-14 `enumerateWorktrees`/`enumerateCanonicalRepos` (the
  worktree-expansion path used at watcher-fire time) has **no live caller
  left**; the watcher was its only consumer (`docs/ISSUES.md` N8). The
  smaller `correlationKey`/`worktreeStamp` helpers are still reused for id
  conventions elsewhere (`lib/edges/reconcile.mjs`).
- launchd plists (confirmed via `launchctl list` 2026-08-14, **after** the
  watcher's unload). Exactly one is installed now:
  `~/Library/LaunchAgents/com.tathya.propagate.digest.plist` — the digest is
  not retired, only the watcher is. The watcher's plist was booted out and
  deleted 2026-08-14; the archived copy lives at
  `propagation/docs/propagate/archive/com.tathya.propagate.watcher.plist.retired-2026-08-14`
  in the private hub (this repo's `docs/archive/` is a pointer stub) and is
  deliberately **not** written as a `~/Library/LaunchAgents/…` path, because a
  path in that form reads as installed and is one copy-paste from being so.
  The retired label is still owned by `lib/core/plist.mjs:25`:
  `export const LABEL = process.env.PROPAGATE_LABEL || "com.tathya.propagate.watcher"` —
  override with `PROPAGATE_LABEL` if you ever rename it again, and update this
  file and `doctor`'s checks in the same change. `lib/core/plist.mjs` only ever
  generated the watcher's plist — see the `reload` entry in "Complete CLI
  surface" below for what that means now.
- Ledger (JSONL, authoritative): **per-workspace, resolved by
  `lib/core/discovery.mjs` `makeWorkspaceRecord`** —
  `<workspace-root>/docs/PROPAGATION_LEDGER.jsonl` when `<root>/docs/` exists,
  otherwise `<workspace-root>/.propagation/ledger.jsonl`. There is NOT one
  global ledger. Examples: `Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl` (has
  `docs/`), but the **GitHub hub** workspace (`~/Documents/GitHub`, which any
  sub-project without its own registered workspace resolves to via
  `currentWorkspace()`) has no `docs/`, so its ledger is
  `~/Documents/GitHub/.propagation/ledger.jsonl`.
- Ledger (Markdown, rendered): the sibling `…/PROPAGATION_LEDGER.md` or
  `…/.propagation/ledger.md`.
- Sidecars: `<workspace-root>/**/.propagates.yml` (every discovered
  workspace).
- State: `${CLAUDE_PLUGIN_ROOT}/state.json` (with `.bak` rotation).
- Heartbeat: `${CLAUDE_PLUGIN_ROOT}/heartbeat`.
- Logs: `${CLAUDE_PLUGIN_ROOT}/watcher.log`, `watcher.stdout.log`,
  `watcher.stderr.log`.
- Tests: `${CLAUDE_PLUGIN_ROOT}/tests/` — run with `npm test`.

## Testing — which tests to run

This repo has no `CLAUDE.md`, so the tiers live here. Three tiers, cheapest first:

| Tier | Command | When |
|---|---|---|
| working | `npm run test:affected` | while editing: the tests the change can reach, each with the dependency that pulled it in |
| release | `npm test`, `release --check` | before a release or merge: everything, `curate-docs` included |
| CI | `.github/workflows/test.yml` | every push, across the node matrix |

`test:affected` reads `tests/impact-map.json` (static imports plus a recorded preload,
`scripts/test-impact/`; why: DECISIONS 2026-10-17). `--files a,b` names the changes, `--base <ref>` diffs against a
ref, `--all` runs everything, `--large` includes the `// @size large` tests it skips by default. It runs the FULL
suite, and says why, when the map is missing, was recorded on a non-ancestor commit, or meets a file it does not
know. After adding or moving a test, run `npm run test:record` (a full recorded run) to rebuild the map. What it
can still miss: GOTCHAS G79. Always run `npm test` or `npm run test:propagate`, never a bare `node --test` (G56).

## Watcher cadence (post-2026-06-08) — historical, watcher RETIRED 2026-08-14

This section describes v1 behaviour that no longer runs in production. Kept
for anyone reading old ledger rows or debugging `watcher.mjs`'s source —
**do not treat any of it as current operational behaviour.** See
`docs/DECISIONS.md` 2026-08-14 for what replaced it (`reconcile` on demand,
`check` at pre-push, the daily digest's DRIFT/INBOUND sections).

- launchd `WatchPaths` fired on changes inside watched roots (FSEvents-backed,
  bubbling up nested file changes).
- launchd `StartInterval: 60` guaranteed a fire every 60s regardless of file
  events. Caught deep-nested edits FSEvents might miss.
- The watcher SKIPPED `renderMarkdown` when no events fired that run —
  without that guard, every no-drift fire would have re-ticked the ledger MD
  and cascade-triggered the watcher every ~5s.

## Worktree-awareness (post-2026-06-08) — the row shape is still live, the firing mechanism is not

The **row shape** described here (`correlation_id`, `source_worktree`) is
still what `status`/`drain` read and group by — it is unaffected by the
retirement, because it describes data already on disk, not the watcher's
runtime. What retired is the **mechanism that produced new rows this way**:

- Sidecar paths stay canonical (e.g. `../VipinKaushik/lib/pricing.ts`). The
  (retired) watcher expanded these at runtime via
  `git worktree list --porcelain` per canonical repo; no live writer does
  this today.
- Historical rows from edits in non-canonical worktrees carry
  `source_worktree: {branch, commit}`.
- All rows pointing at the same logical file across worktrees share a
  `correlation_id` (e.g. `VipinKaushik:lib/pricing.ts`) — `drain --group`
  still groups on this for existing open rows.
- First-observation of a sibling-worktree file used to silently seed
  `state.json` without firing drift (bootstrap behaviour) — moot now that
  nothing populates `state.json` from a live fire.

## Propagation layout — one `propagation/` folder per workspace

**Canonical. Every workspace, including the hub, keeps all propagation items in
`<workspace>/propagation/`** — one folder, at depth 1, **never per sub-project**: a
sub-project's edges roll up to its workspace.

**Do not restate these paths anywhere else — cite this section.** `rule:model-routing`
named a literal path and was wrong the moment the layout moved on 2026-08-21.

```
<workspace>/propagation/
  README.md              generated  — what this folder is; cites this section
  INDEX.md               derived    — the state index
  ledger.{jsonl,md}      scaffolded — created EMPTY by `init` (ensureLedgerPair,
                                      lib/core/discovery.mjs) and asserted by `init`
                                      and `doctor` ("ledger JSONL exists"). Nothing
                                      appends to it: the events live in the
                                      machine-local store (PR-009). Its absence is
                                      the defect, its emptiness is not.
  refs/
    snapshot.json        derived    — branch registry: per project a base_ref, and per
                                      ref its head, merge_state, upstream, upstream_track,
                                      last_commit_iso, worktrees, is_active_line.
                                      Carries schema_version.
    lifecycle.jsonl      append-only — branch created / merged / pruned, each with
                                      detected_by and evidence
  state/<project>/
    STATE.md             daily-open — what is true now
    DECISIONS.md         append-only — why past choices were made
    GOTCHAS.md           on-demand  — what will bite you, and what it cost last time.
                                      Added 2026-08-23, completing the three-file set.
                                      Unlike the other two it is a PUSH artifact:
                                      hooks/gotcha-guard.mjs resolves it on every
                                      Bash/Edit/Write and puts the matching entry in
                                      front of whoever is about to trigger it.
    .sidecar.yml         which project these belong to; see below
  archive/
    ledger-v1.{jsonl,md} FROZEN     — the v1 drift rows, never appended
```

The workspace's own state lives at `state/workspace/`.

**`state/` conforms only when at least one project directory HOLDS something.** An empty
`state/<project>/` is scaffolding, not state, and until 2026-09-26 it satisfied the check:
`Khushboo` and `Rishabh` each held all four other required items plus a 0-entry
`state/workspace/` and were reported fully migrated (ISSUES N82, S1). The report now
distinguishes the two cases in the words it uses — a path that is **missing** and a path that
is **present but empty** are different facts, and telling someone `state/` is missing sends
them to create what is already there.

**`GOTCHAS.md` resolves from BOTH layouts, deliberately.** `lib/gotchas/parse.mjs`'s
`sourcesFor()` looks in `<repo>/docs/GOTCHAS.md` *and*
`<workspace>/propagation/state/<project>/GOTCHAS.md`, nearest first. The migration is
partial by design — measured 2026-08-23, **2 of 9 files could move**; four are blocked on
their workspace gaining a `propagation/state/`, and three are standalone repos with no
workspace, which are exempt. A resolver that understood only the new layout would stop
delivering the other seven, and the failure would be silent.

**A pointer stub at the old path is the design, and it is safe.** It used to be forbidden: until
`N54` was fixed, `parseEntries()` read a stub as a real hazard file with zero triggered
entries, so the selftest reported a successfully migrated project as "inert". `selftestProblems`
now partitions stubs by `isPointerStubText` (`lib/migrate/workspace.mjs`) and counts them apart
from live files, and `sourcesFor()` appends stubs AFTER every live source, so a signpost in the
nearer directory never outranks the hazards it points at. A stub is therefore what a repo leaves
where its state used to be, and it is the pointer a lone clone reads: `# <FILE> — moved`, the words
"pointer stub", and prose naming where the file lives — no path that resolves only on one
machine. `.sidecar.yml`'s `owns` / `pre_move` records the move for the machine reading the
destination.

**The public repo carries only the tool (2026-10-19, propagate #12).** propagate is a public repo, so
its own state and working documents live in the PRIVATE hub that surrounds a maintainer's checkout:

| Moved file | Lives in the hub at | Left behind |
|---|---|---|
| `STATE.md`, `DECISIONS.md`, `GOTCHAS.md`, `ISSUES.md`, `TODOS.md`, `archive/` | `propagation/state/propagate/` (beside the other projects' state, with its own `.sidecar.yml`) | a stub at each `propagation/state/workspace/` path |
| the curate-docs skill's register | `propagation/state/curate-docs-skill/` (its sidecar's `repo_root` names `propagate/skills/curate-docs`) | a stub at each `propagation/state/curate-docs/` path |
| `docs/plans/`, `docs/archive/`, `docs/deferred/`, `docs/AUDIT-*.md` | `propagation/docs/propagate/` — the hub has no `docs/` of its own, and creating one relocates its ledger (its `.gitignore` says so), so its documents sit under `propagation/` | one stub per directory (`docs/plans/README.md`, …) and one for the audit |

`gotcha-guard` finds the hub copy by walking up from a cwd inside the checkout and probing
`<ancestor>/propagation/state/<child>/GOTCHAS.md` (`sourcesFor`), so hazards are delivered on
the maintainer's machine and not on a clone elsewhere — which is intended. Code that reads a moved
file (`lib/core/hub-state.mjs`) derives the hub path from the repo's PARENT and checks the hub
sidecar's `repo_root`; tests that read a moved file skip with a stated reason when it is absent
rather than pass on a stub.

**`refs/snapshot.json` and `refs/lifecycle.jsonl` are not tracked** (same date): they enumerate every
branch of every workspace on the machine that wrote them. They are gitignored in this repo and
regenerated by `propagate migrate-refs <workspace> --apply`. `conformance()` reads their absence as
`regenerated` — not `missing` — ONLY where the workspace's own `.gitignore` names them, so a gap in
a workspace that does not ignore them is still a gap.

### `.sidecar.yml`

One per project directory under `state/`. A **separate file** — never a key in
`.propagates.yml`, whose schema is `additionalProperties: false`, so an undeclared key
silently kills every edge in the file it appears in.

| Field | Why it is there |
|---|---|
| `project`, `repo_root` | Which project these files belong to, and where its repo is |
| `remote` | The project's own git remote. Needed because these files live in the WORKSPACE repo, so `git remote get-url` run beside them answers for the wrong repo |
| `active_line` | The canonical branch |
| `ready`, `note` | `false` means the move is deliberately blocked, and why |
| `pre_move.{sha,branch,history}` | Git history does **not** follow across a repo boundary. These make the old history findable |
| `owns`, `stubs` | What this directory holds, and what pointer files were left behind |

### Deviating

A repo or workspace that genuinely differs declares it **in its own `CLAUDE.md`**, using
the `overrides:` form `rule:description-standard` defines. Not here, and not in
`propagation/README.md`: `rules-check.mjs` only scans files named `CLAUDE.md`, so a
declaration anywhere else is inert decoration that *looks* machine-checked.

Note the detector matches the literal token wherever it appears in a `CLAUDE.md` — so a
file cannot *describe* a declaration it is removing without re-declaring it.

### What this replaced

`docs/PROPAGATION_LEDGER.*` and `.propagation/ledger.*` are superseded. Discovery still
resolves them so nothing breaks, and `doctor` **fails** if a workspace has live ledger
files at more than one candidate — a half-finished relocation is loud, not silent. Move one
with `relocate-ledger`, never by hand: `git mv` alone makes discovery fall through to the
`docs/`-exists heuristic and mint a fresh empty ledger while the real one goes unowned.

Until 2026-08-22 a **brand-new** workspace was given one of those superseded layouts —
`docs/` if that directory happened to exist, `.propagation/` otherwise — so `init` could not
produce the canonical layout at all. `docs/DECISIONS.md` had recorded that cause as
contained but not removed. It is removed now; `makeWorkspaceRecord` pins `propagation/` for
the no-ledger-anywhere case, and the pinning rule still wins for anything holding data.

**Dated records keep the old path.** An archived session note or a `DECISIONS.md` entry
describes what was true then; `rule:state-and-decisions` forbids editing past entries. Only
live pointers are repointed.

## Docs layout — one folder per project, in its workspace

**Canonical for `rule:workspace-docs-layout`, which states ownership and cites this for
location.** A sub-project's documentation lives at:

```
<workspace>/docs/<project>/     one folder per project, flat; plans/ may be a subfolder
<workspace>/docs/<project>/README.md    that project's documentation index
```

The project repo keeps its root `README.md`, its walk-up agent files (`CLAUDE.md`,
`AGENTS.md`), any file a script, test or build reads, its fixtures, and a stub headed
"moved" at each path a doc left. An edge between project code and a moved doc is declared
in the **workspace** `.propagates.yml`, its project-side path prefixed with the project
directory: `check --changed` run inside the project repo cannot see it, `reconcile` at the
workspace can. A standalone repo with no workspace keeps its `docs/`.

Added 2026-10-16. Before that date the rule sent single-project docs the other way, into
their repo; dated records describing that layout keep it.

**The hub is the one workspace with no `docs/`.** Its `.gitignore` records that creating a hub
`docs/` would silently relocate the propagation ledger, so the hub's per-project folders sit at
`propagation/docs/<project>/` (alongside `propagation/state/<project>/`). propagate's moved plans,
archive, deferred designs and audit are at `propagation/docs/propagate/` (2026-10-19, #12). A
reader looking for `<workspace>/docs/<project>/` in the hub will not find it; this is why.

## `propagate refs record-pruned`: record a branch an outside tool prunes (propagate#448)

```
propagate refs record-pruned --workspace <dir|name> --branch <name> --head <sha> --evidence <json> --detected-by cleaner [--project <p>] [--apply] [--json]
```

`refs/lifecycle.jsonl` is written by the snapshot diff, which stamps `detected_by: snapshot-diff`. A tool that deletes branches records them here instead of appending to the file, so the shape check (`detected_by` and `evidence` on every record) cannot be bypassed. **The order is snapshot, then record, then delete, and a non-zero exit means do not delete.**

- **Accepted** only when the branch is in the current snapshot and `--head` equals the snapshot's head for it, which proves it is the same ref about to go. A branch that exists in several projects with that head needs `--project`.
- **Dry run unless `--apply`.** Without it nothing is written (no lock directory either), for an accepted and a refused case alike; `tests/unit/refs-record-pruned.test.mjs` asserts the refs directory is byte-identical.
- **With `--apply`** it takes the lock on `lifecycle.jsonl`, re-reads under it, and appends one `schema: 2` line: `type: pruned`, `project`, `ref`, `head`, `detected_by`, `evidence` (the parsed JSON), `recorded_before_delete: true`, `at`. It never rewrites `snapshot.json`. `migrate-refs --apply` takes the same lock around its append.

| Exit | Meaning |
|---|---|
| `0` | recorded, or a dry run that would be accepted |
| `1` | refused, with a code below |
| `2` | could not run: usage, no or unreadable snapshot or lifecycle, an unknown snapshot shape (a v1 or flat one: convert it with `migrate-refs`), or the lock held elsewhere. A missing snapshot is never read as an empty one. |

Refusal codes: `REFS_PRUNE_HEAD_MISMATCH` (the head differs), `REFS_PRUNE_UNKNOWN_BRANCH` (the snapshot has never seen it), `REFS_PRUNE_DUPLICATE` (a `pruned` with this branch and head is already recorded, checked before the snapshot), `REFS_PRUNE_DETECTED_BY` (not allowlisted), `REFS_PRUNE_EVIDENCE` (not valid JSON, or empty), `REFS_PRUNE_AMBIGUOUS` (several projects match; pass `--project`).

**Who may record.** `ALLOWED_DETECTORS` in `lib/refs/record-pruned.mjs` is `cleaner` only; `snapshot-diff` stays internal. To admit another tool, add its name there and to this paragraph in one commit.

**The next snapshot reconciles** (`migrate-refs`, through `reconcileOutsidePrunes`):

- the delete went through: the diff's own `pruned` for that branch and head is dropped, so the branch is recorded once;
- the delete failed: the branch is still present at the same head, so one `prune-incomplete` event is emitted, carrying the record's `evidence`, `recorded_by` and `recorded_at`. It is deduped by project, ref and head, and the record is never silently cleared. `doctor` warns `prune incomplete` while the branch is still there at that head; a delete that lands later closes it, because the state is derived from the snapshot;
- the branch was re-created at a different head: nothing is added here; the diff's own events say so.

## The digest never waits on a notification (propagate#462)

`notify()` (`lib/report/notify.mjs`) spawns `terminal-notifier` detached and `unref()`ed and resolves on the spawn, never on the exit: with `-execute` the notifier stays alive until the notice is clicked, and awaiting it held the digest for 9 days. The osascript fallback runs only when the spawn itself fails (ENOENT, EACCES), and every path is bounded by `NOTIFY_TIMEOUT_MS` (10 s).

A real digest run (not `--dry-run`, not `--stdout`) writes `{started, finished, pid}` to `<state dir>/digest-run.json` (`lib/glance/digest-run.mjs`). The glance carries one `digest` signal over it: a run that started more than 24 h ago (2 x the 12 h schedule) with no finish reads `digest stuck: started <age> ago, never finished` (broken); a start inside the window reads as running; no record at all is skipped as `digest never ran`, never stuck; an unreadable record is unknown.

## `propagate worktrees`: run the cleaner over lane worktrees, and its glance row (propagate#274, #446)

```
propagate worktrees [<repo-or-worktree>...] [--apply] [--json]
```

propagate calls the cleaner's worktree collector (contract C1) and passes its verdict through; it never classifies a worktree itself. Set the cleaner checkout with `PROPAGATE_CLEANER_DIR`, or `integrations.cleanerDir` in `~/.propagate/config.yml` (no default: it is a separate repo). With no paths it hands the cleaner the git root of every discovered workspace, deduplicated by git common dir.

- **Dry run unless `--apply`.** The cleaner is called with `--json` and, only when `--apply` was given, `--apply`. Routes (below) are listed as `would-post` and nothing is posted. `tests/unit/worktrees-cleaner.test.mjs` proves both on the argv a stub cleaner and a stub `gh` record.
- **Routes (C4).** A route `{kind: "issue-comment", repo, issue, body}` in the cleaner's result is posted with `gh issue comment` (`PROPAGATE_GH_BIN` overrides the binary), only under `--apply`, and once per `<repo>#<issue>@<head>`: the ledger is `$STATE/cleaner/routes-posted.jsonl`. A route with no `head` is keyed by a hash of its body. A malformed route is reported as `invalid`; a failed `gh` call is named and counted, is not written to the ledger, and is retried on the next `--apply`.
- **Exit.** The cleaner's `0` (clean or applied) and `1` (findings, or refused) pass through; a clean `0` with a failed route comment becomes `1`. `2` is could not run, and is the answer for: no cleaner configured (`cleaner not configured`), no `worktree-gc.sh`, an exit outside 0/1/2, output that is not JSON, or no repository to hand over (discovery found none: a blind scan, not a clean one).

**The glance row.** `propagate glance` carries one `cleaner` signal read from `<cleanerDir>/logs/last-audit.json` (C3) and never recomputes it: `disk <free> free · worktrees: awaiting-merge <n> · Tier B <n> · stale-lock <n> (audit <age>)`. Each domain is dated by its own `at`; the `worktrees` domain older than 24 h reads `worktrees audit stale (<age> old)`. The three absences are three texts and none is 0: an unset cleanerDir is skipped with `cleaner not configured` (in `skipped`), a missing file reads `cleaner never run`, a `null` count reads `not built`. Free disk is `free_kb`, else `statfs` of the cleaner directory.

## Ledger resolution

⚠️ **Resolve the ledger path from the workspace the row belongs to — do NOT
hardcode a path.** A row shown under `# <Name>` by `status` lives in THAT
workspace's ledger (see "Canonical state" above). Writing to any other ledger
silently no-ops and the row stays open. Derive it via discovery so it always
matches what `status` reads:

```javascript
import { markStatus, renderMarkdown } from "${CLAUDE_PLUGIN_ROOT}/lib/edges/ledger.mjs";
import { discoverWorkspacesSync } from "${CLAUDE_PLUGIN_ROOT}/lib/core/discovery.mjs";
import { SEARCH_ROOTS } from "${CLAUDE_PLUGIN_ROOT}/lib/core/config.mjs";

// pick the workspace whose root contains the row's source file (nearest ancestor)
const ws = discoverWorkspacesSync(SEARCH_ROOTS)
  .filter((w) => sourceAbsPath === w.root || sourceAbsPath.startsWith(w.root + "/"))
  .reduce((best, w) => (w.root.length > (best?.root.length ?? -1) ? w : best), null);

await markStatus(ws.ledgerJsonl, "003", "done");
await renderMarkdown(ws.ledgerJsonl, ws.ledgerMd); // re-render the sibling MD
```

**Superseded 2026-08-13.** `cli.mjs drain` is now the supported close path and
resolves the ledger this way itself — prefer it over hand-writing this. The
snippet stays because it documents *how* resolution works, and because the
v1 `markStatus` path still exists; it is no longer the only mechanism.

Quick sanity check after closing: re-run `status` — the row should be gone.
If it isn't, you wrote to the wrong ledger file.

## `manifest` — standing a workspace up on another machine

`propagate manifest "<workspace>"` (`--json`) answers: which repos, on which
branches, where they go, and what is not in git at all.

**Report only.** It never clones, never writes, never touches the network.

**Phased on purpose.** It reads `.sidecar.yml` files INSIDE the workspace repo, so
on a bare machine it cannot be the first thing you run — the repo it reads is not
there yet. Phase 0 (clone the hub, install the plugin, `propagate setup --hub`) is
by hand; from phase 2 the command describes the rest itself.

**Toolchain comes from the LOCKFILE, never `package.json.packageManager`.**
Measured 2026-08-26 across `Vipin Kaushik`'s seven units, the lockfile resolves 6
and the field resolves 1 — and the field's absence is *not* npm. `Astroclarity`
and `marketing-intel` carry a `package.json` with no field, and rendering those as
npm reproduces the failure that workspace's `CLAUDE.md` records ("`npm install` in
a pnpm project breaks CI silently"). Unknown stays `none`.

**The unit, not the project, is the row.** `VipinKaushik-mb` has no root
`package.json`; it is `server` (3152) and `ui` (3153). The three registries
(`ports.yml`, `deploy.yml`, `mongo.yml`) key on `<Workspace>/<unit-path>`, which
is the same identity, so they join without new storage.

### Gap kinds — four facts, deliberately not one

| kind | meaning |
|---|---|
| `cannot-clone` | no `remote:`, and not a git repo of its own here. Must be copied out of band |
| `remote-undeclared` | on disk WITH a remote the sidecar does not record. A stale declaration — the output names the exact line to add |
| `would-be-missed` | a repo on disk no sidecar declares; a new machine silently would not get it |
| `not-cloned-here` | declared, absent locally. **Informational** — a fresh machine is entirely this |

### Frameworks, analytics and credential stores

Per unit, `manifest` now also reports:

- **`framework`** — derived from the unit's `package.json` (`dependencies` plus
  `devDependencies`) and `go.mod`: `next`, `react`, `next-auth`, `@clerk/*`,
  `@auth0/*`, `mongoose`, `pg`, `prisma`, `express`, `gin`. The population is the
  units discovery already found; only the recognised names are a list. `-` means
  none of those, not "no framework".
- **`analytics`** — joined from `scripts/execution/access.yml` (`PROPAGATE_ACCESS_FILE`).
  Its rows sit under `properties:` (siblings `conventions:` and `robots:` are not
  rows), keyed `<Workspace>/<unit-path>` like the other registries.
- **`svc`** — the external services the unit uses, from `scripts/execution/services.yml`
  (`PROPAGATE_SERVICES_FILE`; pages in `rules/conventions/services/`, `PROPAGATE_SERVICES_DIR`). Shown only when
  that file is configured. A unit using a service that needs credentials, with no `credentials:` entry in its
  project's sidecar, adds the gap `service-no-credential-location`. `propagate services` gives the full matrix and
  findings (UNPAGED, STUB-IN-USE, STALE-LIMIT, HAZARD-UNTRIGGERED, NO-CREDENTIAL-LOCATION, ENV-UNKNOWN,
  SCAN-SKIPPED, UNIT-NOT-ON-DISK; exit 0 clean · 1 findings · 2 could not run). A registry row keyed by a project
  root matches a unit below it only when that project has one unit.

**`credentials:` in `.sidecar.yml`** records where a project's credentials live.
Locations only, never values; read leniently (no schema):

```yaml
credentials:
  deployed: {see: deploy.yml#"Vipin Kaushik/VipinKaushik"}
  database: {see: mongo.yml#"Vipin Kaushik/VipinKaushik"}
  analytics: {see: access.yml#properties.vipinkaushik}
  local: [{store: .env.local, authoritative: false}]   # relative to the project root
  out_of_tree: [{store: "~/.pgpass", host: "localhost:5436"}]
```

`see:` pointers are carried as written, not resolved. Stores are **detected by
name and `stat`ed, never opened**: `.env*` files are found with a directory
listing, and a test plants a sentinel string in them and asserts it never reaches
the output.

New gap kinds (all blocking):

| kind | meaning |
|---|---|
| `credential-undeclared` | a `.env*` file (not `.env.example`/`.sample`/`.template`; `.env.bak*` counts) found by walking each project root, names only, never opened (skips `node_modules`, `.git`, `.next`, `dist`, `vendor`, `.worktrees`; depth 6; the workspace repo itself is walked too, stepping over other declared projects). Attributed to its nearest unit, else the project, and exempt only if that has a `deploy.yml` Doppler binding or a `credentials.local` entry naming the path relative to the project root. One row per file |
| `store-missing` | a declared `local` store (judged only when the project is on disk) or `out_of_tree` store (`~` expanded) fails `stat` |
| `store-loose` | an `out_of_tree` store's mode has bits beyond 0600 |

**Floor.** If 0 units were scanned the command prints `scan has gone blind` and
exits 3 (`--json` carries `blind: true`, `unitsScanned`); it never reports clean.

### `external:` — the one thing that cannot be derived

Nothing on disk distinguishes a required gitignored directory from scratch. It has
to be declared, in the project's `.sidecar.yml`:

```yaml
external:
  - path: sanskrit-texts-sources
    bytes_approx: 369000000
    why: source scans feeding the canon; deliberately out of git
    transfer: out of band — copy from a machine that has it
```

Without it, a fresh machine gets `sanskrit-texts` with its entire 369 MB corpus
missing and nothing indicating anything is absent.

### What it does NOT get you

Cloned, on the right branches, toolchains and ports known, every missing piece
named — **not running**. Env values come from Doppler (`rule:secrets-source-of-truth`
routes those through Rupali), `external:` payloads move by hand, and the
`.nvmrc`-says-22 / machine-runs-25.9 conflict is reported, not settled.

## `gotcha-guard` — what a hit delivers (#225)

`hooks/gotcha-guard.mjs` fires on a Bash command or an Edit/Write path matching an entry's `**Trigger:**` and puts
the entry in front of the model as `hookSpecificOutput.additionalContext` (and, identically, as `systemMessage`
for the human; only the first costs model context).

**A hit is compact when the entry has a remedy.** It renders as `gotcha · <title>`, the entry's remedy, and
`full entry: <source>#<id>`. The remedy is `remedyOf(entry)` in `lib/gotchas/parse.mjs`: the first paragraph that
starts `**Instead:**`, `**Do:**`, `**Fix:**` or `**Use:**`, ending at a blank line or the next `**Label:**` line,
capped at about 250 chars and cut on whole lines with `…` when cut. **An entry with no remedy renders in the full
form** (body, truncation notice, source path), because there is nothing shorter that still says what to do. Before
#225 every hit re-sent the full body: one session's transcript carried 830,198 chars of it in 538 showings.

`node hooks/gotcha-guard.mjs --selftest` fails on a trigger that cannot fire (`selftestProblems`) and **warns,
without failing,** on two things (`selftestWarnings`): a duplicate id within one source (the `#<id>` pointer then
names two entries) and a triggered entry with no remedy (every hit pays the full body).

`propagate context --transcript <path.jsonl> [--json]` reports, per `compact_boundary` window of a session
transcript, the gotcha injections, showings and characters that reached the model. It counts only
`hook_additional_context` attachments; the `hook_system_message` twin of the same text costs no context and
counting it doubles every figure. Exit 2 when it could not read the file or found no parseable line.

## Complete CLI surface

Source of truth: the `mode === "..."` dispatch chain in `cli.mjs`, not the usage
string — the usage string's nested `[--a|--b]` groups contain pipes that look
like more commands than actually exist.

**Derive the location, do not cite a line number.** This paragraph read
"~line 1131" from before 2026-08-13 until 2026-08-25, by which point the chain
had moved to ~3900 — the pointer was ~2800 lines wrong and nothing could notice,
because a stale line number is indistinguishable from a fresh one. `cli.mjs`
changed in 46 of the last 30 days, which is also exactly why the
`cli.mjs` -> `REFERENCE.md` edge is deliberately NOT declared in
`.propagates.yml` (the reason is recorded there). An undeclared edge means this
check is the reader's, so make it one command:

```sh
grep -n 'mode === ' cli.mjs          # the dispatch chain
ls cli/*.mjs                    # command bodies extracted out of it
```

Command *implementations* now live in `cli/`; the dispatch that routes to
them stays in `cli.mjs`.

| Command | What it does |
|---|---|
| `status` | List open drift rows, scoped to the workspace at cwd by default. `--all` for every workspace, `--cross` for the cross-repo ledger, `--json` for machine-readable output. |
| `glance [--json] [--no-write] [--no-color]` | **What is working, what is broken, what needs you** (#295), from files other commands already wrote; never runs reconcile, doctor or `gh`, so a standalone run takes well under a second. Prints ONE line per source, `<badge> <source>: <count> <verdict> (<top subjects>) · <fix>` (at most 80 characters, no word cut, needs-you sources first, at most 5 source lines then `+N more sources`, working sources as one `OK` line), `[OK] all clear · N signals checked · HH:MM`, or `[UNKNOWN] glance: nothing to read yet`. Badges are coloured on a TTY; `NO_COLOR`, `--no-color` or piped output print the plain `[BROKEN]` word. Writes `<state dir>/glance.json` atomically and prunes guard-log months older than 90 days; `--no-write` writes and deletes nothing. `--json` prints exactly the `glance.json` object. **Exit 0** working, **1** broken or needs you (an unknown counts as broken), **2** nothing could be read, or a usage error. A text run ends with one `test-queue:` line (#428) read from the machine-wide queue, `${TEST_QUEUE_DIR:-~/.local/state/test-queue}` (never the state dir; files only, no lock is probed): `gate running 12m (<project>); 3 waiting; last cpu 34%`, `idle`, `N queued or running (not lock-checked)`, `not used on this machine`, or `could not read part of the queue (<why>)`. It is information, not a signal: it does not move the exit code, and `--json` stays exactly the `glance.json` object. See "The glance" below. |
| `glance ack <id>... [--until <date\|date-time\|Nh\|Nd>] [--json]` | **Acknowledge or snooze glance items** (#296), by id (`propagate glance --json` lists them). Writes `<state dir>/glance-acks.json` only. Without `--until` the ack holds for the item's current episode (it applies while the item's `since` is at or before the ack); with it, until that instant (a bare date means the end of that UTC day). An acked item is shown as acked and is not notified; **its verdict, the glance verdict and `needs_you_ids` are unchanged.** Ids must be id-shaped (no spaces or shell characters). Exit 0 written, 2 usage error. See "Notifications" under "The glance". |
| `glance unack <id>... [--json]` | Remove an ack or snooze (#296). Ids with none are reported, not refused. |
| `waiting [--json]` | **Every merge, approval and decision waiting on the maintainer** (#411), one row each with a recommendation and a one-word answer (`merge`/`approve`/`defer`/`lane`/`rater`). Since #428 it also reads the test queue (files only): a **suspect failure** from the last 7 days (a *failed* run that saw a busy machine; a pass under load is never suspect) answers `lane`, recommending a quiet re-run; a **refused** run (exit 75, it never ran) answers `defer`; a gate pass recorded with `--no-run-evidence` answers `approve` (accept the reason, or re-gate). A record that does not parse is a `COULD NOT READ` line and exit 2, never fewer rows; a missing queue directory is a named source (`test-queue not used on this machine`). Exit 2 when a source could not be read. |
| `waiting gate-pass <full sha> --suite <summary> (--run <id> [--repo-dir <dir>]\|--no-run-evidence <why>) [--apply] [--json]` | **Record that the suite passed on a PR's exact head** (the only write; a dry run without `--apply`). A pass needs evidence (#428). `--run <id>` names a `test-runs/<id>.json` record and is accepted only when **all four** hold: `exit === 0`, `dirty === false`, the PR head `<sha>` is an ancestor of the run's `head` (`git merge-base --is-ancestor`, run in `--repo-dir`, default the cwd), and the run was not refused; every unmet condition is listed. The check also runs on a dry run. A pass recorded under load is accepted. Without `--run`, `--no-run-evidence "<why>"` is required; neither, or both, exits **1** naming both flags. The gate record stays `schema_version: 1`; `run_id`, `run_tree`, `cpu_peak` and `no_run_evidence` are optional fields, and a record without them still reads. |
| `doctor [--full] [--json] [--since <span\|date>]` | **Default view is folded (#107):** failures (`✗`), inconclusive (`?`) and unknown-kind (`?!`) lines are always printed verbatim; repeated `!` warnings with one label in a section become one `! <label> ×N  <first detail> (+N-1 more: doctor --full)` line; `✓`/`·` lines become one `· N ok · N info` count per section; the first line states `showing folded view: N lines of M`. The fold is applied to the rendered lines (the same capture `--json` uses), so it cannot omit a section, and the exit code is identical to `--full`. **`--full`** prints every line (the pre-#107 output); `--json` is unchanged. Lines doctor writes to stderr are not folded and may appear out of place. Not done: a severity threshold (warnings at or above a level shown individually), because the rendered lines do not carry the module's severity. Health check: launchd plist loaded (`launchctl list \| grep <label>`), heartbeat age (warn >1h during active periods, fail >1 day), all `.propagates.yml` sidecars pass schema validation, sidecar downstream paths resolve on disk (warn-only), `state.json` parseable with `.bak` present. **No longer asserts that an in-tree ledger parses** — retired 2026-09-24 (PR-009): it passed unconditionally for a file `ensureLedgerPair` creates empty and nothing appends to, so it reported success for having read nothing. The row count is now an `info`, and a genuine read failure is still a check. **`# Unrecorded work`** (#131, `lib/report/doctor/unrecorded.mjs`): per repo in the discovery census (`ownerCandidates`) plus repos nested under it, record files (STATE, DECISIONS, GOTCHAS, HANDOVERS, TODOS, TODO, ISSUES, `.propagates.yml`, `.sidecar.yml`, ledgers, markdown under `plans/` or `rules/`, matched by name or pattern) that are modified, staged or untracked with an mtime at least `PROPAGATE_UNRECORDED_DAYS` days old (default 7); files edited on today's local day are always excluded. Also local branches with commits on no remote: ahead of their upstream, upstream gone, or no upstream (printed as such, never as zero); a no-upstream branch whose commits are all on some remote is counted in the summary, not listed. Worktrees of one repo list shared branches once. Output names repo, branch, file and age. **Warn-only: it never votes on the exit code**, because uncommitted work is the normal state of a working day and #129 recorded an always-red doctor going unread; the issue's "makes doctor fail" is deliberately not followed. Zero repos scanned prints `scan is blind`, never a clean line. |
| `doctor` § `# Retirement candidates` | **#298, `lib/report/doctor/retirement.mjs`.** Lists unadopted systems from every discovered `SYSTEMS.md`: `<workspace>/docs/SYSTEMS.md`, `<workspace>/docs/<project>/SYSTEMS.md`, `<workspace>/propagation/docs/<project>/SYSTEMS.md`, and propagate's own `docs/SYSTEMS.md`. The files are read by `scanSystems` in `lib/report/adoption.mjs`, the one scan the digest's ADOPTION ask and the glance also use; each applies its own rule. Tables are parsed **by header name**, so column order and count do not matter; `id`, `status`, `last_verified` and `adoption_date` are required. **Two rules (2026-11-16).** A retirement candidate (`classifyRetirementRows`) has a status that starts with `active` once emphasis is stripped, so plain `active`, `active-unadopted` and prose such as `active, and since …` all count. It also has a blank `adoption_date`, and more than 30 days (`RETIREMENT_MIN_DAYS`) have passed since the earliest ISO date in `last_verified`. `retired`, `dormant`, `proposed` and `installed-never-invoked` rows are not candidates. The digest's one ADOPTION ask keeps the narrow rule (`classifyAdoptionRows`): status exactly `active-unadopted` or `installed-never-invoked`, with a blank `adoption_date`. A row that qualifies but has no date prints `unknown: no start date`, never a candidate. A worktree copy of a file (same git common dir and path) is counted once, and the main checkout wins. A file with no table carrying the required headers prints `SYSTEMS.md unreadable` with its path, never 0 candidates. No file at all prints `retirement: no SYSTEMS.md found in N workspaces scanned`. **Warn-only:** the section never votes on the exit code. |
| `init <dir> [--workspace\|--edges-only]` | Scaffold `.propagates.yml`. `--workspace` (default) writes `workspace: true` and verifies the directory becomes discoverable, exiting non-zero if not (N15). **No longer touches the plist** — that moved to `reload` (N14). |
| `reload` | **Obsolete as of 2026-08-14** — its only purpose was regenerating the (now retired) watcher's plist and reloading it into launchd; `lib/core/plist.mjs` has never generated any other plist (grep confirms it — the digest plist is installed by a separate mechanism it never touches, see "Canonical state" above). Not removed from `cli.mjs` by this change (out of scope — no live launchd command was run to verify/enact this), but there is no remaining reason to run it. |
| `check` | Commit-time drift gate. Flags below. |
| `backlog [--json] [--brief] [--verbose] [--affects <scope>] [--trackers] [--offline]` | Open work across every `STATE.md`, `TODOS.md`, `ISSUES.md` and handover, **plus the open GitHub issues of every register that delegates to a tracker** (#104, since 0.15.40). `backlog` **refreshes first** (async, 20 s budget, `$PROPAGATE_GH_BIN` overrides `gh`), then reads; `--offline` runs no `gh` and reads the cache; `--trackers` is kept as an alias for the default. The read is `gh api repos/O/R/issues?state=open&per_page=100 --paginate` (REST, so it does not spend the GraphQL budget), pull requests dropped, once per (repo, label filter). The result is `<state dir>/tracker-cache.json`, written atomically; **`backlog()` never spawns `gh`**, it merges the cache, so doctor, digest, rollup and the dashboard read it too and print its age. Each open issue is a `ranked` row `{id: "#n", repo, url, text, priority, file: <delegating register>, line: null, kind: "github"}`; priority comes only from a `priority:P0..P3` label. `kind:handover` issues are not ranked: they are counted in `handovers.github`. `totals.trackers` carries each register's status (`counted` / `unreadable` / `unsupported` / `not-fetched`) and the cache age; an unread tracker is never `0`, and one that failed after a good read keeps its rows marked `stale`. Refreshers: `backlog`, the monitor's scheduled run (skipped on `--dry-run`; a failure there is a log line, never a notification), and the dashboard's refresh button. **A delegated head link may carry a label filter** — `…/issues?q=label:project:<name>` — and each (repo, filter) is fetched and counted once: a register sharing another's tracker, or whose filter sits inside a bare repo link, is listed but not summed. Handover sections read `open` / `closed` / **`moved`** (`**Moved:** <date> → <url>`, work that left — never counted as closed) / `unknown`. `--affects <scope>` narrows the view to items filed about one repo or workspace, elsewhere-first. |
| `tasks export (--file <path> \| --all) [--json] [--apply [--budget <n>]]` | Moves open register work to GitHub issues. **Without `--apply` it is a read-only plan** (since 0.15.35): per register, each open item with its target repo (the repo the file is committed in, or the routed repo), labels (`task`, `kind:todo\|issue\|handover`, `project:<name>`, `priority:`/`severity:`/`upstream`), the hidden key `<!-- propagate-task key=<file>#<id> -->` that makes a rerun create nothing, and the body that would be posted. Every item it will not move is **held with a reason**, never dropped: `duplicate-id`, `staged`, `issues-disabled`, `other-owner`, `no-remote`, `no-identity-map`, `forbidden`, `oversize`, `unknown-status`, `delegated`. A heading quoted inside a fence is not an entry (counted as `skipped: fenced`). Calls `gh` for `repo view` only. **With `--apply` (since 0.15.36 for TODOS/ISSUES; handovers since R3)** it reads each target repo (`issue list --state all`, `label list`, the linked Project), creates missing labels and issues, adds each issue to the repo's linked Project, journals every issue in `<state dir>/tasks-export.jsonl` (append-only, last row per repo+key wins), and rewrites a register **only when every open item in it has an issue and nothing in the file is held** (a file with any held item creates nothing). The rewrite cuts each moved block (fence-aware), inserts a delegated head and one `**MOVED**` pointer line per item under `## Finished`, and is refused, file untouched, unless a re-parse reads `delegated` at the head's URL, every kept line keeps its fenced status and order, fences stay balanced, bytes add up, and each id has exactly one pointer line. Writes are spaced 2 s apart (`PROPAGATE_TASKS_THROTTLE_MS` overrides, for tests) and capped by `--budget` (default 400): the run stops before the next write and a rerun continues. **Handover files (since R3)** are append-only logs, so they are neither delegated nor cut: each `open` section gets one issue (`kind:handover`, target = the repo the file is committed in, routes applied; never inferred from body paths) and **one line directly under its heading, `**Moved:** <YYYY-MM-DD> → <issue url>`, followed by a blank line**, which puts it inside the parser's 3-line window so the section then reads `moved` (precedence Resolved > Moved > Done when). `unknown` sections are held and untouched, `closed`/`moved` skipped. Sections are independent, so a file may be marked partially (a failed or budget-stopped run marks the sections that have a URL; a rerun does the rest); each file is one atomic write. The edit is refused, file untouched, unless a re-parse of a same-named candidate shows the section count unchanged, every marked section `moved` at its URL, every other section's status/title/date unchanged, the original lines an in-order subsequence of the output with only the inserted lines extra, and fences balanced; it is also refused if the file changed while its issues were being created. After a rewrite or marking it lists the `.propagates.yml` edges touching the file, to `verify` or `decouple`. Exit 0 done or stopped at the budget; 1 a file failed or was refused; 2 usage. **Routes**: `tasks: { routes: { "<OWNER/NAME>": "<OWNER/NAME>" } }` in `config.yml` sends one repo's registers to another repo (an explicit table, never inferred; other-owner and issues-disabled are not held for a routed source repo, `project:` still comes from the source file, and the key is prefixed with the source repo). Plan: `~/.claude/plans/ticklish-gathering-brook.md`. |
| `hooks instructions-gate [--apply] [--owned <a,b>] [--json]` | Put the `instructions --gate` ratchet into the pre-commit of every repo that tracks a `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` (#221). **Dry run by default**: derives the population (discovery's workspaces plus `listRepos`' nested-repo census, linked worktrees dropped) with a floor, and prints per repo its owner, `core.hooksPath`, whether `pre-commit` exists and calls the gate, and the action it would take. **Ownership**: only repos whose `origin` owner is in the allowlist (`--owned` > env `PROPAGATE_HOOKS_OWNED_REMOTES` > config `hooks.ownedRemotes`; default empty = report only, `--apply` writes nothing). Actions: create `.githooks/pre-commit` and set `core.hooksPath` only when unset; append to an existing hook (before its first column-0 `exit`); a `hooksPath` set elsewhere inside the repo is appended to and never repointed; one outside the repo is skipped; an unset `hooksPath` with a real `.git/hooks/pre-commit` appends there instead of orphaning it; husky's generated `.husky/_` resolves to `.husky`. The hook finds propagate with no relative path: `$PROPAGATE_CLI`, else the installed plugin's `installPath` from `~/.claude/plugins/installed_plugins.json`, else it prints a skip notice and allows. Blocks only on exit 1; prints exit 2. `--apply` never commits and never pushes. `doctor` warns (S3) per repo missing the gate. |
| `rollup` | Derive **what exists and what is open** across every workspace and WRITE it to `<HUB_ROOT>/ECOSYSTEM.md` (it said `<SEARCH_ROOTS[0]>` until 2026-09-30, which is what N101 fixed in the code and this sentence outlived — `searchRoots` is ordered for the walk, not to name the tree). It exists because every other cross-project answer here is command-shaped and agents read files, not commands. Reuses `backlog()` + `inventory()` — no second walk. A hand edit is REFUSED, never clobbered. |
| `rollup --check` | Read-only. **Four exit codes carrying three distinct facts plus a pass:** `0` current · `1` stale (exists, tree moved past it) · `2` could-not-run (**absent** — nothing to check; a fresh clone hits this by construction) · `3` hand-edited. `1` and `2` were conflated until 2026-08-31, and 1336 tests passed anyway because they asserted the message rather than the code. |
| `rollup --force` | Discard a hand edit and regenerate. NOT a safety flag — it enables the write rather than promising to withhold it — so `rule:safety-flag-needs-a-test` governs `--dry-run`, not this. |
| `claims check` | Five **deterministic** checks over the declared-edge corpus: expired dates, literals against declared downstreams, footer-vs-newest-inline date, rotted citations (self-line, dead branch, dead path), and `concepts:` tokens that can never fire. `lib/claims/check.mjs` may import no model client and make no network call, and a test asserts that against the module's own source. It reports CANDIDATES — the judgment step is a later lane, deliberately. |
| `claims judge <file>` | Partition one document's blocks against the verdict store: `judged` / `unjudged` / `unanswerable` / `structure` / `orphaned`. Identity IS the sha of the normalised block text, so editing a block re-opens it automatically — no staleness field. `orphaned` is the store's decay mode: verdicts whose block no longer exists. |
| `claims answer <file> start` | Record that an answering attempt BEGAN, returning a run id. |
| `claims answer <file> end --run <id> --outcome <o>` | Close that attempt with what it concluded. A run that starts and never ends reads as `crashed`, which is what makes `unanswerable` distinguishable from never-attempted (`rule:discernment-checks` §2). |
| `claims restate` | Hold a rule's own text against the copy a `CLAUDE.md` restates — the **excused** set (cites AND restates). Poses questions and writes nothing. Entries whose fingerprint lands on a heading, table or comment are reported UNPAIRED with a reason, never silently judged. |
| `claims verdict [--apply]` | **The write path** — the only claims subcommand that mutates the store. Reads a JSON array on stdin. Dry-run by default; one invalid row refuses the WHOLE batch, because an append-only store cannot be half-written. |
| `claims contradict <authored-file>` | Hold an authored document against a derived fact. |
| `claims render <file> [--apply]` | Write each block's recorded verdict beside it in the document. |
| `check --changed` | Default when no range/staged flag given: working tree + staged vs HEAD, unioned. |
| `check --range <a>..<b>` | Explicit git range (for CI or a hook). |
| `check --staged` | Staged files only (pre-commit use). |
| `check --strict` | Exit 1 (not 0) if any coupling is found — combine with any of the above. |
| `check --json` | Machine-readable output: `{generatedAt, repoRoot, changedFiles, strict, exitCode, couplings}` — combine with any of the above. |
| `settle <file> [--json]` | **Read-only worklist for one file** (2026-10-02). The edges into AND out of it, in fix order re-derived on every run; per edge: state, the diff since the last *pinning* verify against the working tree (both sides — `deferred` pins nothing, so it never moves the baseline), prior reasons, the dispositions `allowedDispositions` permits right now, what blocks it (a NEVER_VERIFIED upstream is shown, with a `settle` route), and the exact `verify --edge <id> --disposition <d> --reason '<what you checked, as file:line>' --apply` command. A file whose edges are all NEVER_VERIFIED says so. A relative `<file>` that names a declared file under the cwd wins outright; otherwise it is matched like `graph --node`, and an ambiguous match lists candidates (exit 2), no match exits 1. `--json` adds `walk_started`, `session_id` and `reason_placeholder`; each item's `diff` is `{source, downstream}`, two parallel sides. **Never writes** (`tests/cli/settle.test.mjs` snapshots the event store); the interactive walk is the /propagate skill's `sections/settle.md`. **`--check <proposals.json>`** (#251) gates the `edge-settler` agent's proposals: the edge-id set must equal the worklist's, each disposition must be in `allowed`, each reason non-placeholder, each SHA real and touching one side; then each accepted command runs through `verify` without `--apply`. Exit 0 all passed, 1 anything refused, 2 unreadable proposals. |
| `rekey --to <new_edge_id> [--from <old_edge_id>] [--reason "<text>"] [--apply] [--json]` | **Carry an edge's verification history to its new id** (2026-10-29, v0.15.44). An edge id is `sha8(node_id, downstream, why)`, so rewording a sidecar `why:` or renaming a coupled file mints a new id: the old id's verdicts stay behind and the new id reads NEVER_VERIFIED (a DIVERGED edge would read as "never judged"). Without `--from` it **lists** orphaned candidates (events in the store, declared by no sidecar, sharing the new edge's `node_id` or its files' current content; events do not record the downstream path, so content equality stands in), newest first, and writes nothing. With `--from` it is a **dry run** that prints the event it would write and the predicted state; `--apply` appends ONE `rekeyed` event on the new id carrying `from_edge_id` and the old edge's latest pinned pair and position, so CLEAN stays CLEAN and DIVERGED stays DIVERGED. Nothing existing is edited. Refusals, each its own exit code: `11` `--to` not declared, `12` `--to` already has events, `13` `--from` still declared (not a rename), `14` `--from` has nothing to carry (only `deferred`, or last pin `decoupled`), `15` `--from` already rekeyed onward, `16` no candidates; `2` is usage. `why <new>` follows the `from_edge_id` chain and `settle` counts predecessors in "judged Nx". `rekeyed` is not a verdict: `verify --disposition rekeyed` is refused and `allowedDispositions` never offers it. See GOTCHAS G84, DECISIONS 2026-10-29. |
| `context --transcript <path.jsonl> [--json]` | **Gotcha-guard injection volume per compaction window**, from one session transcript: injections, showings and characters of `hook_additional_context` that reached the model. Read-only. Exit 2 (could not run) on a missing or unparseable transcript. See the `gotcha-guard` section above. |
| `rules check [--json]` | **Which CLAUDE.md files restate a canonical rule** (#219), judged against the one accepted-findings registry (`healthExceptionsFile`, `scripts/execution/health-exceptions.yml`, check id `rules-restated`, subject `<rule>@<hub-relative path>`) that `doctor` and the session-start banner also read. Output: failing, `accepted (not drift)` with each entry's reason and since, stale entries, declared deviations, and a coverage line `N failing · N accepted · N excused (not checked, #81)` so a green result states what it did not read. **Exit 0** nothing failing and nothing stale; **1** a failing restatement (no registry entry) or a stale entry (its finding no longer fails; the list may not outlive its reason); **2** could not run: no rules, roots missing, no CLAUDE.md scanned, or the registry missing or unparseable (`registry-missing` / `registry-broken`), never read as clean. `--json` adds `failing`, `accepted[{finding,key,reason,since}]`, `stale`, `excusedCount`, `registry`. Raw scan: `checkRules`; adjudicated: `checkRulesAdjudicated` in `lib/rules/rules-check.mjs`. |
| `costs window --transcript <path.jsonl> --from <ts\|anchor:re> --to <ts\|anchor:re> [--since <ts>] [--until <ts>] [--json]` | **Tokens and minutes for a window of a main-session transcript** (#233; the cost ledger holds only subagent lanes). Read-only. Tokens are usage summed once per `message.id` (input, output, cache_create, cache_read) over messages with `from <= ts <= to`; minutes is `round((to-from)/60000)`. Bounds, in order: `since <= from <= to <= until`. Exit 2, with no numbers printed, on an unmatched anchor, `from` after `to`, or an unreadable transcript. Always ends with the upper-bound line (concurrent work in the window is counted). Without `--transcript` it picks the newest `.jsonl` under the project's `~/.claude/projects/` directory and says so. **Traps it avoids:** (1) anchors on an issue number run to the end of the session, so anchors are explicit commands, and `--since` stops an anchor matching an earlier session-day; (2) Claude Code writes one line per content block under one `message.id`, so a per-line dedupe drops tool calls and a per-line sum over-counts: messages are grouped, timestamped by their earliest line, and searched across all their blocks; (3) the command's own text would match its anchors, so `until` defaults to just before the latest message containing `costs window` (exclusive; an explicit `--until` is inclusive and overrides); (4) a resumed lane writes one cumulative ledger row per stop, so `readCosts({lanesOnly:true})` keeps the last row per `agent_id` and reports `superseded`. |
| `sprint plan [--approvals <n>] [--json]` | **Does the Ready work fit the usage left until the sprint ends?** (#190) Read-only: no GitHub write, no ledger write; nothing cached. **Budget** is in week-% points, never dollars: `min(100 - week_pct, cap - used today + floored cap x later days)` to `min(sprint end, weekly reset)`. The cap rule is the usage widget's, imported from `<usage widget dir>/src/collect/{daily-cap,day-used}.mjs`, where the dir is `$PROPAGATE_USAGE_WIDGET_DIR`, else `integrations.usageWidgetDir` in `~/.propagate/config.yml` (no default: the widget is a separate repo); unset or unimportable is exit 2, `could not compute (daily-cap source not configured: set PROPAGATE_USAGE_WIDGET_DIR, or integrations.usageWidgetDir in ~/.propagate/config.yml)`. **Exit 2, with the reason, when:** no `ok:true` sample at most 6 h old; the 7-day `ok:false` rate is above 50% (the rate is always printed); today's baseline sample is of a different `week_resets_at` (a delta across a reset is refused); today's use spans a skipped day (not bridged). **Demand** is every Ready item on every open board (server-side `status:Ready`, `first:100` per board, truncation reported), with the count in the current Sprint beside it. A Size is calibrated only with 5 or more Done items of ONE cost basis: `lane` (a ledger lane row for `#N` with the same total tokens as the board's Tokens) or `main-or-unknown`; bases are never pooled, and only `lane` converts to points, via the ledger's tokens per week-% (5 usable lane rows needed). Uncalibrated and unsized items are counted and listed, never summed. **Exit:** 0 fits and nothing uncalibrated; 1 over, with a cut list ordered by `priority:P0..P3` label, then milestone, then board; 2 could not compute, or `cannot judge fit: K of N Ready items calibrated`. **Resource checks:** GitHub GraphQL and REST remaining (from `rate_limit`, free); `needs:mac|vm|rupali|github` counts; concurrent Mac lanes and VM jobs print `not derivable yet (#150)`; `--approvals N` is her number, else `not given`. **GraphQL is spent, so it is counted:** two calls (a board listing with each board's Ready count, then items for only the boards with Ready items); it refuses to start under 100 remaining, or under `10 + 40 x boards` before the item call; the calls made are printed. |
| `sprint review [--sprint <title>] [--apply] [--json]` | **Done against planned, per board, for a Sprint that has ended.** (#191) Read-only unless `--apply`. Default sprint per board: the most recently ended iteration (`completedIterations` plus `iterations`), or the current one marked `not ended`; `--sprint <title>` picks by title and skips boards without it. **Per board:** planned (items whose Sprint is that iteration), done (Status Done and `Finished` inside the iteration's dates), carry-over (planned, not Done), and `done without Finished in the window` (Status Done but Finished missing or outside; counted, never done, never moved). Boards that disagree on the iteration's dates are reported per board and each is judged on its own dates. **Added mid-sprint is not derivable** (GitHub records no timestamp for entering an iteration); the output says so. **Also:** totals; the Size-calibration gain (this sprint's Done items with Size and Tokens, by Size and cost basis, against the floor of 5); Done items missing Tokens or Minutes and Status-Done items missing Finished (`rule:record-completion-cost`). **`--apply`** moves each carry-over item to the earliest later iteration on its board, by updating only its Sprint value, in board then issue order; it prints the moves and the mutation text first, never re-prioritises (#141 rule 6), and a board with no later iteration is reported, not moved. Without `--apply` no write method is reachable (tested by snapshot). **Exit:** 0 reviewed; 2 could not compute, with the reason (GraphQL under 100 remaining, or under `10 + 40 x boards` before the item call; no board with a Sprint field; an unknown flag). **GraphQL:** one listing call plus one item call for all boards, plus one write call per 20 moves; the calls made are printed. |
| `release notes [--since <tag>] [--write] [--version <X.Y.Z>]` | **Keep a Changelog draft from the commits since the last `v*` tag** (#234). Without `--write` it prints the draft and writes nothing. `--write` fills or refreshes `## [Unreleased]` at the top of `CHANGELOG.md` (Breaking / Added / Fixed / Changed); `--write --version X` renames `[Unreleased]` to `## [X] — date`, keeps any text already there, opens an empty `[Unreleased]`, and refuses when `[X]` exists. Exit 2 with nothing written on no tag (pass `--since`), a duplicate version, or an empty release. Unprefixed subjects are listed by name, never counted as fixes. `release --check` is unchanged and gains the `release-kind` gate; the bump itself is enforced by `.githooks/commit-msg`. Rule and steps: `docs/RELEASE.md`. |
| `usage [--origin <interactive\|widget\|monitor\|hook\|backfill\|all>] [--backfill [--apply]] [--json]` | **Which commands are run, and how often they fail** (2026-10-15, D13). Plain `usage` aggregates the runs store through `lib/report/usage.mjs`; default view is `origin=interactive`, and records written before the field existed count as interactive and are reported as `legacyOrigin`. Every `cli.mjs` run appends ONE line `{ts, command, outcome, duration_ms, origin, kind:"command"}` to `$PROPAGATE_STATE_DIR/runs/<YYYY-MM>.jsonl` from a synchronous `process.on('exit')` hook (the CLI calls `process.exit` in ~80 places, so only that sees every exit). `outcome`: exit 0 `ok`, exit 3 `refused`, anything else including an uncaught exception `error`. **Never argv** (a verify note is a justification); the command is resolved against the registry and an unresolvable one is `unknown`, a help request is `help`. `origin` comes from `PROPAGATE_ORIGIN` (`widget` set by the queue panel's `QueueRunner.swift` in claude-usage-widget, `monitor` in the monitor plist, `hook` in `.githooks/pre-commit`; unset = `interactive`; any other value is `interactive`). **Skipped when `NODE_TEST_CONTEXT` is set**, and a write failure is swallowed so it can never change an exit code. `--backfill` derives history once from Claude transcripts: it counts Bash tool calls that ran `cli.mjs <registry command>` (deduped per tool call, keyed by `tool_use` id so a re-run adds nothing) and stores COUNTS ONLY with `origin: "backfill"` and `outcome: null`, never command text. **Dry run unless `--apply`** (`tests/cli/usage-recorder.test.mjs`). A backfill count is not an `ok`: it is reported as `unrecorded` and excluded from failure rates. |
| `help [command]` · `<command> --help` · `-h` | Answered from the same `COMMANDS` table the flag validator reads, ahead of it — so `verify --help` is answered rather than refused as an unknown flag. No argument: commands grouped, one line each. A command: its usage and every declared flag. The seven commands whose flags are not yet enumerated (`args: null`) say so. An unknown command exits 2. |
| `exclude:` (sidecar key) | **Drop files from a glob downstream** (2026-10-03, v0.15.17). Optional array on a `propagates_to` entry whose `path` is a glob; entries are paths or globs relative to the sidecar. An excluded file mints no edge, and the remaining edge ids are unchanged (ids key on the concrete downstream path + `why`, not the declaration). Editing a `why` or renaming a file does change an id; `rekey` (above) carries the history across. All matches excluded → one `UNMATCHED` row, as for a zero-match glob. `doctor` FAILS on `exclude:` with a literal `path` and on an entry matching none of the glob's matches. One expander, `expandDownstream` in `lib/edges/reconcile.mjs`, serves both `reconcile` and `verify`'s declaration lookup. |
| `verify --disposition decoupled` on a glob match | **Refused, exit 3** (N118), in dry run and `--json` too: decoupling splices out the whole `propagates_to` entry, unwatching every sibling the glob matches. The refusal names the sibling count and points at `exclude:`. Decoupling an `UNMATCHED` glob (one that watches nothing) is still allowed. |
| `verify` refusals | An out-of-order refusal (exit 3) now leads with the *upstream's* own `propagate verify --edge <blocker> …` command, then `--out-of-order`; `--json` carries them as `fix_first`. A DIVERGED refusal keeps "a human must look at both sides first" and prints the `both-reconciled` command. Every printed command selects with `--edge`, never `--glob` (G74), and shell-quotes a reason. `decoupled` is now refused on a DIVERGED edge like every other non-`both-reconciled` disposition — it used to branch off before the guard. |
| `drain` | **The supported close path** (added 2026-08-13; `SPEC.md` §6). Bare, it lists open rows grouped by `correlation_id`, read-only. `--all` widens to every workspace, `--json` for machine-readable output. |
| `drain --close <id>[,<id>...]` | Close one or more rows. Requires `--status`. Ids are checked against the open set *before* any write — an unknown id is an error, never a silent no-op. |
| `drain --group <correlation_id>` | Close every open row sharing a `correlation_id` — the same logical change seen on several branches — in one action with one reason. |
| `drain --status <done\|wontfix\|partial>` | The transition to write. |
| `drain --reason "<why>"` | Becomes `wontfix_reason`. **Required** when `--status wontfix`; the command refuses without it (`SPEC.md` §5). |
| `drain --notes "<text>"` · `--closed-by <who>` | Optional notes; `closed_by` defaults to `drain` and is validated against `drain\|commit-evidence\|wontfix`. |
| `skills` | Inventory of `~/.claude/skills` with provenance and liveness. `--json` for machine-readable output. Part of the skill-lifecycle family — see `docs/DECISIONS.md` for the split-out decision. |
| `skills-create <kebab-name> <intent>` | Scaffold a new skill under quarantine, gated by `creationAllowed`. |
| `skills-promote <name>` | Promote a quarantined skill. |
| `skills-demote <name>` | Demote a promoted skill back to quarantine. |
| `skills-reap [--apply]` | Sweep dead quarantined skills; dry-run without `--apply`. |
| `docs <file>` | What governs this file, and why — the derive-on-demand half of doc authority; `--all` for every declared edge in the tree. `--json` for machine-readable output on every mode below. |
| `docs --kinds` | Census of doc kinds across every workspace's `docs/`, sourced from `KINDS` in `lib/report/doc-kind.mjs`; prints a truncated undeclared preview and points at `--undeclared`. |
| `docs --undeclared` | The FULL undeclared worklist — never the 8-of-988 truncation `--kinds` prints — each row carrying a best-guess kind (`guessKind`, heuristic only, never fed back into classification). |
| `docs --doctrine [kind]` | The per-kind guideline table — `what`/`create`/`maintain`/`link`/`never`, read straight from `KINDS`. No argument lists every kind's `what`; a kind name prints its full guidance. |
| `docs --structure [--tables]` | Broken-citation census per project; `--tables` also scans whole-cell table paths (opt-in — see `lib/report/doc-kind.mjs`'s own note on why). |
| `docs --superseded [file]` | Declared supersession index — bare, every declared supersession; with a file, what (if anything) overrules it. |
| `docs --reference` | Regenerate the generated **"Doc kind guidelines"** section of THIS file (`docs/REFERENCE.md` itself) from `KINDS` — every kind's guidelines plus a tier-precedence example verified live via `kindOf()`, not hand-typed. Reuses `lib/report/rollup.mjs`'s `bodyHash`/`parseFooter`/`compareInputs` under its own marks (`lib/report/doc-reference.mjs`) rather than a second hash-footer implementation (G20). |
| `docs --reference --check` | Read-only. Same four-exit-code vocabulary as `rollup --check`: `0` current · `1` stale (the tree moved past it — always `lib/report/doc-kind.mjs`, the sole input) · `2` could-not-run (REFERENCE.md absent, or exists with no generated section yet) · `3` hand-edited. |
| `docs --reference --force` | Discard a hand edit to the generated section and regenerate; everything else in this file is untouched either way — only the marked span is ever rewritten. |
| `docs --reference --dry-run` | Preview the generated section on stdout without writing. |

`check`'s coupling lookup, for each changed file:
- **forward** — is it a declared `.propagates.yml` source? → list its
  downstreams to re-verify.
- **reverse** — is it a `kind: code` downstream? → list the upstream doc(s)
  to re-verify (the case that let #43 slip).

Each coupled path is annotated with its edge's state, in the action words
(`judge`, `pick-a-side`, `parked`, `never-judged`, `broken`), from the one
reconcile run `check` makes (the same run feeds the inbound advisory). A done
(CLEAN or DECOUPLED) edge prints bare. The frozen v1 ledger is no longer read.
If reconcile cannot run, the coupling lines print unannotated and
`edge states unknown — reconcile failed: <reason>` follows them; the exit code
never depends on any of it.

Output is grouped and human-readable:

```
⚠ 1 coupled file in this change:
  lib/engine.ts → verify: SPEC.md (judge)
```

**Default = warn, exit 0.** `--strict` makes couplings a hard failure
(exit 1). No couplings → exit 0, no output.

**Known limitation:** glob `kind: code` downstreams (e.g. `lib/**/*.ts`) are
deferred — `synthesizeKindCodeEntries` logs and skips them, same as the
watcher — so `check` won't warn on a glob-declared code edge. Declare
non-glob `kind: code` edges for files you want the commit-time gate to
actually catch.

## `propagate goals allow` and `goals check-done`: goals can close (propagate#55)

`propagate goals` stays read-only and runs nothing. These two run a goal's `Derived by:` command, and only an
approved one.

`propagate goals allow <GOALS.md> <goal-id>` approves one goal's **exact** command text: its SHA-256 goes to
`$PROPAGATE_STATE_DIR/goals/trusted.json` with the file, the goal and the date. Run it yourself; it is the trust
decision. An edit to the command changes the hash, so the goal is untrusted again (the `direnv allow` pattern).
Exit 2 when the goal does not exist or names no command.

**A `Derived by:` command must exit non-zero while the goal is unmet, and exit 2 below a floor** (a scan that read
too little is "could not run", never "met"). `check-done` reads exit 0 as met, so a command that cannot fail closes
its goal on a report (#383). `lib/report/goals-run.mjs` `failurePath(command)` is a conservative static lint for the
definite no-failure shapes: a last statement after `;` or `&&` that is `echo`, `printf` or `true`; a trailing
`|| true`, `|| :` or `|| echo`; a pipeline ending in `tail`, `head`, `cat`, `sort`, `wc`, `tee` or `grep -c`; an inline
`node -e` with no `process.exit` of a computed code, `exitCode` or `throw`; an `awk` program whose only exits are bare,
0 or 2. It cannot prove a command honest (plain `grep` is left alone). `goals allow` **refuses** a flagged command
with exit 3; `--force --reason '<text>'` overrides it and the reason is stored on the trust entry as `override`.
`goals check` lists each flagged open goal as a `derived-by-cannot-fail` violation (its only grade is violation, exit 1).

`propagate goals check-done [--apply] [--timeout <s>] [--json]` reads every GOALS.md under the search roots.
- **A trusted command runs** with `bash -c`, cwd = the GOALS.md's git root, a 120 s timeout (`--timeout <s>` for a long suite). On a timeout the whole process
  group is killed, so a suite's children never outlive it. Exit 0 is **met**;
  anything else is **unmet**, with the exit code and the last output lines. Every verdict carries the last 3 lines of
  output (`output_tail` in `--json`); the text output prints them under each `met` row, so a person can see what was
  read as a pass. A timeout is unmet and says so.
- **Never run:** an untrusted or edited command (reported with the `goals allow` line to approve it), a
  `Judgement, not derivable` goal (it needs a person), a parked goal, a closed goal.
- **`--apply`** writes one line per met goal, directly under its heading:
  `**Resolved:** <date> · derived: `<cmd>` exited 0 (propagate goals check-done)`. Under the heading, because the
  reader takes a marker only from the first 3 non-empty lines (`MARKER_WINDOW`). Nothing else in the file changes.
  Without `--apply` the files are byte-identical (tested by snapshot, across every outcome).
- **Exit:** 0 ran; 1 a met goal's section could not be found, so nothing was written for it; 2 no GOALS.md found.

**Parked** is a status of its own: a `**Parked (cycle N, date):** <reason>; returns when <condition>` line in
the same 3-line window. It is never counted as open. A later `Resolved:` wins.

## `propagate goals check` (propagate#264)

`propagate goals check [--json]` is the standing check behind the goal workflow. It is read-only: it reads every
GOALS.md under the search roots and the Ready and In progress items of every open board (the same read as
`propagate day open`), then checks them against each other. `day open` prints a one-line `goals:` summary computed by
the same function from the boards it already read, with no second GraphQL read. The check itself is the pure function
`checkGoals({ files, boards, now })` in `lib/report/goals-check.mjs`.

**Line formats** (in GOALS.md; the goal's id is its heading's, `## G2 · …`, and a board's Goal field carries that id):

| Line | Where | Meaning |
|---|---|---|
| `**Active since 2026-11-13 · appetite 4 weeks**` | in the 3-line marker window under the heading (`markerInWindow`, fenced lines consume it) | the goal is active; its appetite ends that many weeks after the date. The appetite part is optional: `**Active since 2026-11-13** (approved by …)` parses as active with no appetite |
| `**Retro 2026-11-15:** continue` (or `reshape`, `stop`) | anywhere in the section body, never inside a fenced block | a retro decision; the latest date counts |
| `**Parked (cycle N, date):** …` | the same window (propagate#55) | not active |

**Active** means an Active-since line, and the goal is neither closed nor parked. Where its Done when sits does not
matter (8e14732: astro-darpan's G2 wrapped its Active-since paragraph past the 3-line window and read inactive).

**Clauses** (each violation carries `clause`, `subject`, `reason`):

| clause | A violation when |
|---|---|
| `active-goals` | 0 active goals, or more than 3 across all files |
| `goal-undeclared` | a Ready or In progress item's Goal names a goal that no file declares active (the reason says declared-but-not-active or declared nowhere) |
| `item-fields` | a Ready or In progress item lacks Goal (or its Goal is Parked or Idea), Priority, Model, Size or a stated "Done when"; **Ready items also need Order**, In progress items carry none by design (finish first) |
| `appetite` | an active goal records no appetite ("no appetite recorded"), or is past it (its end date is before today) with no Retro line dated on or after the end |
| `plan-goal` | a plan approved in the last 7 days named a goal that is not active now (parked or closed since). Read from `<state dir>/plans/approvals.jsonl`, which the plan-goal hook writes |

**Not checked, never passed:**
- `no plan approval recorded in 7 days` when the approval log is missing or holds nothing recent. Otherwise the
  output summarises the week's approvals per goal and names each `goal_reason` override; an override is **listed,
  never a violation**, because it is the sanctioned escape.
- A board with no Goal field is named, and its items are not counted clean.
- A GOALS.md the reader could not parse is named.

**Floors and exit:** 0 pass (the `notChecked` lines are not passes); 1 violations; 2 could not check: no GOALS.md
found, or no board read (a rate limit, a listing that returned 0 open boards, an item with no field values). A blind
scan never exits 0.

<a id="propagate-standards"></a>

## `propagate kb` (propagate#269, renamed from `propagate standards` in #322)

This section was `propagate standards`; its old anchor `propagate-standards` still resolves. `propagate standards` is a deprecated alias of `propagate kb standards`; the old name is removed in the release after 0.21.0.

Standards are rule-like documents that name a tool or a practice and carry checkable rows. This section records what
is **built** on `feat/269-standards-core`; the reasons and the phasing are in the design, not here:
`propagation/docs/propagate/plans/2026-11-15-standards-design.md` (§2.1 storage, §2.2 adoption, §2.3 doctor, §2.12
phasing), and the build plan `2026-11-15-standards-increment-1.md`. Decisions made after the design are on
propagate#290 and #291 and are cited below. Where the code and the design differ, the code is described.

**Offline.** `kb standards`, `kb standards adopt|decline|remove`, `kb references`, `kb migrate` and doctor's `# Knowledge base` make no network call.
The one spawn is the tool-version probe, and only `kb standards versions --refresh` runs it. `adopt --apply` reads the
GitHub login with `gh api user`.

### Where it is configured

| Key | Env | Default | Holds |
|---|---|---|---|
| `kbStandardsFile` | `PROPAGATE_KB_STANDARDS_FILE` | `<hub>/scripts/execution/kb-standards.yml` | the standards registry |
| `kbStandardsDir` | `PROPAGATE_KB_STANDARDS_DIR` | `<hub>/kb/standards` | the pages the registry names |
| `kbReferencesFile` | `PROPAGATE_KB_REFERENCES_FILE` | `<hub>/scripts/execution/kb-references.yml` | the references registry (`kb references`) |
| `registersDir` | `PROPAGATE_REGISTERS_DIR` | none (null) | a folder of `*.md` register files, each entry a `### <id> · <title>` block with an optional `**Checked:** YYYY-MM-DD`; read only by `kb search` |
| `kbContact` | `PROPAGATE_KB_CONTACT` | none (null) | the contact address sent as `mailto` to OpenAlex and Crossref (their polite pools); read by `kb discover` (and `kb fetch`, for Unpaywall); never guessed, and with none set the command says so |
| `kbReviewsDir` | `PROPAGATE_KB_REVIEWS_DIR` | none (null); `kb review` falls back to `reviews/` beside `kbStandardsDir` | the folder of review directories, one `<date>-<slug>/` each |
| `kbTiersFile` | `PROPAGATE_KB_TIERS_FILE` | none (null) | the source-tier table `{schema_version: 1, domains: {<host>: 1\|2\|3}, official_docs: [<host>]}`; without it `kb review check` exits 2 rather than treating every source as tier 3 |
| `standardsFile` | `PROPAGATE_STANDARDS_FILE` | `<hub>/scripts/execution/standards.yml` | deprecated, read until the release after 0.21.0; use `kbStandardsFile` |
| `standardsDir` | `PROPAGATE_STANDARDS_DIR` | `<hub>/standards` | deprecated, read until the release after 0.21.0; use `kbStandardsDir` |

Each value resolves in this order: the new env variable or key, the old env variable or key, the new default path if it
exists, the old default path if it exists, otherwise null. An old key that supplied a value is named by doctor's
`LEGACY-NAME` finding.

`kbReferencesFile` has the same fallback: when only the old `<hub>/scripts/execution/references.yml` exists, it is used, so
an unmoved hub never reads as "not configured". An explicit old override (`standardsFile` or `standardsDir`) pinned to an
old hub path must be renamed before the hub's move lands, because the old key outranks the new default and would keep
pointing at the path that moved.

The registry is `schema_version: 1` plus a `standards:` mapping, each entry `{kind, page, authority, detect, service,
probe, pointer_globs}`. A null path reads as "standards not configured", never as zero standards, and an empty
`standards:` mapping is "a shape this reader does not recognise" (`rule:discernment-checks` §6). A missing or broken
page is a problem naming its file; the other standards still load.

### The page and the row

A page is YAML frontmatter plus rows. Frontmatter keys read: `id` (must equal the registry key), `kind`, `authority`
(a list of `{name, url, scope}`), `version_probe` (the key in the versions cache, defaulting to the id), `supersedes`
and `extends`.

```
### acme-tool-007 · A stuck wait is capped
**State:** adopted
**Source:** acme-tool API docs · **Version:** acme-tool 3.4.1 · **Checked:** 2026-11-14
**Apply:** cap waits in the integration helpers so a stuck screen fails and names the step
**Check:** test: **/integration/support.dart contains boundedWait
**Fails when:** the cap is removed
**Broadcast:** no
**Superseded by:** —
```

- A row heading is `### <id> · <title>`; a hub row id is `<standard id>-<nnn>`, and the registry reader reports a
  mismatch. Fields are bold-key lines and a continuation line extends the previous field.
- **State** is `draft`, `adopted` or `retired`. **Check** is `kind` or `kind: target`, with kind one of `command`,
  `test`, `propagate`, `gate`, `review`, `none`; `command` and `test` need a target. **Checked** must be `YYYY-MM-DD`.
- The parser never throws on content. Every defect (unknown field, unknown state or check kind, a duplicate row id
  with both rows kept, a heading that looks like a row but is not, a field outside any row, frontmatter that does not
  parse) lands in `problems`, so a broken page is reported as broken, never as zero rows.
- **Not built:** the design's projection hash and the fixed section checks (Authority, Rows, Plan, Retired rows).

**A project page extends a hub standard (#290).** Frontmatter `extends: std:acme-tool` (one entry or a list). A row
there is one of:

| Row | State | Rule |
|---|---|---|
| `**Applies:** std:acme-tool-007`, with a project check path | **inherited** from the hub row | no `State:` line is written; when the hub retires the row every project follows with no edit |
| `local-<n>` (as the row id, or as `Applies:`) | **defaults to adopted** | retiring one needs a `**Reason:**` field |
| a hub-page row | explicit | a missing `State:` is a problem |

`Applies:` must be `std:<id>-NNN` or `local-<n>`, and the page must extend that standard. Whether the named row
exists is checked only when the caller passes `extendedRows`. Rejected on #290: a `State:` line on every row, and one
on local rows only.

### Status is derived

Never written onto a row. `lib/kb/standards/status.mjs` `rowStatus`:

| Status | When |
|---|---|
| `unchecked` | the row's check kind is `review` or `none` (decided first, so a review row is never `verified`) |
| `unverifiable` | no version in use (`version not read (kb standards versions --refresh)`), or either side has no comparable number (`GA4`, `2026-11`) |
| `re-verify` | the version in use is newer than the row's `Version`, by major.minor of the first `N.N` found in each |
| `verified` | the same, or an older, major.minor |

A standard's row status is the worst across its detected projects (and each project's across its units). `retired`
rows are left out. A row with a check kind that runs (`command`, `test`) is **not run** by the report: status says
whether the row was written against the version in use, not that its check passed.

`kb standards --json` carries per standard `rows`, `projects` (each unit with its `version` and `source`),
`projectCounts`, `counts`, `detected`, `adopted` and `versionSource` (`lockfile`, `probe`, `mixed` or null).

### Versions and probes

A registry entry may carry `probe: {cmd, args, parse}`. `parse` is a regex whose first group (else the whole match)
is the version; the default is the first `N.N[.N]`. `kb standards versions --refresh` is the only caller of the spawn
(30 s timeout) and writes `<state dir>/kb/versions.json`; doctor and `kb standards` only read it. A probe that
fails is recorded as `{version: null, error}`, never left out. `--refresh` with no probe declared anywhere is
`STANDARDS_NO_PROBES` and leaves the cache as it was.

Version in use for a unit, in order: its own `pubspec.lock` (`sdks.<probe key>`), then the machine probe, else none.
**Known gap (recorded on #290):** `spawnRun` calls `spawnSync(cmd, args)` with **no `cwd`**. So a project-local tool,
such as one installed in a project's `node_modules`, is never read from the project. Only a machine-installed tool is
read correctly, and the probe is the same for every unit. Reading a project-local version per unit from its lockfile
(or with `cwd` set to the unit) is not built; only the `pubspec.lock` branch exists.

### Detection and adoption

Detection proposes, adoption decides, and the adoption stays (design §2.2). A standard detects units from its own
`detect` (`deps`, `files`, `env`) or reuses a service's through `service:` (read from `services.yml`); a `global` or
`production` standard detects every unit with code. The unit scan reuses `services.mjs` and has a floor
(`MIN_UNITS`): below it the report is `STANDARDS_BLIND`, never "0 detected".

| Command | Does |
|---|---|
| `kb standards [--json] [--std <id>] [--project <p>]` | the report above |
| `kb standards versions [--refresh] [--json]` | the cached versions; `--refresh` probes |
| `kb standards adopt <std> <project\|workspace/project> [--units a,b] [--evidence <text>] [--apply]` | record the adoption |
| `kb standards decline <std> <project\|workspace/project> --reason <r>` | record "detected, does not apply" |
| `kb standards remove <std> <project\|workspace/project> --reason <r>` | record the removal of an adoption |
| `kb references [--json]` | the references registry, each id shown as `ref:<id>` |
| `kb search <terms> [--kind standard\|reference] [--json]` | one derived search (no index) over standards rows, references and the register files in `registersDir`; ids are `std:<row>`, `ref:<id>`, `reg:<id>`; every term must match; ranked id, then title, then summary fields, then detail, then body; each hit shows `path:line` and its checked date. `--kind` narrows to standards or references (registers appear only without it). No hits is exit 0; 0 entries parsed from every source is exit 2 `KB_BLIND` ("the scan has gone blind") |
| `kb discover <dir> "<query>" [--sources academic\|code\|skills\|all] [--engine <id>] [--limit n] [--lane <name>] [--json]` | deterministic scholarly search. With neither `--engine` nor `--sources` it asks OpenAlex, Semantic Scholar, arXiv and Crossref in that order (`--sources academic`). `--sources code` asks GitHub (through `gh api search/repositories`, `PROPAGATE_GH_BIN` overrides the binary, 2.1 s apart; the query is the search terms of the question plus `in:name,description,topics`, sorted by stars, retried once with the first 2 terms on 0 rows, each row recording `matched_query`) and npm (terms only, over-fetched, kept when a term matches a whole word of name, description or keywords, ranked by search score); `--sources skills` asks skills.sh, the Claude marketplaces list (filtered client-side, ranked by stars), the MCP registry and `clihub`, CLI-Hub, the CLI registry of CLI-Anything (`HKUDS/CLI-Anything`, Apache-2.0): its `registry.json` and `public_registry.json` are both fetched, filtered client-side on the query's search terms across name, display name, description and category and ranked by terms matched, and if either file fails the engine fails, never a partial list (rows are `kind: cli`, key `clihub:<name>`, with an `install` command); `all` is every group, and a comma list is allowed. Those rows add `kind` (repo, package, skill, plugin-marketplace, mcp-server, cli) and `url`; a GitHub repo and a marketplace for the same repo share the key `gh:<owner/repo>` and so are one row (a DOI query goes to Crossref as a single-work lookup). Writes `<dir>/discovered.json` (`{engine, id, doi, title, year, venue, is_peer_reviewed_hint, oa_url, abstract?}`, merged and de-duplicated on engine and id) and appends `{lane?, engine, query, date, hits}` to `<dir>/searches.json` for each engine that answered. Keys: `OPENALEX_API_KEY`, `S2_API_KEY` (sent in a header, redacted from every output and file; a missing key prints one line and runs keyless). Limits: OpenAlex 10 req/s keyless and 30 with a key, $1/day; arXiv one request per 3 s; a per-second 429 backs off by `Retry-After` (at most 2 retries), a `daily_budget` 429 is not retried. Exit 0 hits and every engine answered; 1 zero hits from every engine (stated per engine); 2 could not run, including any engine whose response it could not understand or that hit its daily budget (results from the other engines are still written) |
| `kb fetch <dir> <url...> [--json]` | reads each source itself, not through a summariser. Node `fetch` (redirects followed by hand, each hop checked against robots.txt, `Accept: text/markdown`), a fixed HTML-to-text step, `pdftotext` for PDFs, `gh api` for github.com repo, blob, issue and pull URLs. arXiv, OpenReview and ACL Anthology URLs resolve to their PDFs; a DOI resolves to a legal open-access URL through Unpaywall (contact address from `PROPAGATE_KB_CONTACT` or `kbContact` under `integrations:`; none set means Unpaywall is skipped and the record says so). Writes `<dir>/fetched.json` records `{url, final_url, status, type, sha256, date, classification, reason?, detail?, note?}; every record that is not `ok` carries `reason` (`login_page`, `cross_host`, `robots`, `http_<code>`, `timeout`, `citation_only`, `unexpected`) and a `detail` sentence, and `note` repeats `detail` for older readers; `kb review check` counts `not_retrieved` by `reason` (`derived.not_retrieved_by_reason`) and `brief.md` states it`; the stored text is `$STATE/kb/fetched/<sha256>` and is never written into the repo or `<dir>` (a store inside either is refused). Classification: `ok`; `not_retrieved` (a 200 on another host or a login or consent page, robots.txt disallow, 401/403, a paywall with no open-access copy, a body under 40 characters of text or one that is only a bibliographic line: `reason: citation_only`, with `text_chars` and `floor_chars` on the record); `stale` or `hallucinated` for a 404, 410 or unresolvable host, by the Wayback availability API (a snapshot means stale, none means hallucinated; Wayback unreachable stays `not_retrieved`). No shadow library is ever used. Exit 0 every URL ok; 1 some URL not ok; 2 could not run (usage, `pdftotext` or `gh` missing or logged out when needed, unsafe store). Nothing is written on a 2. `lib/research/quotes.mjs` is the shared normaliser and `findQuote` the gate imports |
| `kb survey "<question>" [--sources academic\|code\|skills\|all] [--engine <id>] [--limit n] [--fetch] [--json] [--dir <d>] [--timeout <s>]` | one call for an agent: runs `kb discover` into `$STATE/kb/surveys/<date>-<slug>/` (or `--dir`) and prints `{question, dir, sources_run, sources_failed:[{engine, code, message}], items:[{kind, key, title, url, updated, engines, body_path?, status?, reason?}], counts:{items, by_kind, fetched_ok?, not_retrieved?}}`. The default is `--sources all` (discover's is `academic`), because a survey is meant to be broad. `--fetch` reads each item that has a URL through `kb fetch` and adds `body_path` (ok only) and `status` (`ok` or `not_retrieved`, with `reason`). `--timeout` (default 120 s) is the overall wall clock; sources that never finished are reported as `SURVEY_TIMEOUT`. Exit: 0 at least one item and no source failed; 1 no item and no source failed; 2 any source failed, a usage error or an unwritable folder (items the other sources found are still printed). Writes only the survey folder, `$STATE/kb/fetched` and discover's last-request time; never the knowledge base, the hub or the event store |
| `kb survey verify <claims.json> [--json]` | input `{claims:[{text, quotes:[{text, body_path \| sha256}]}]}`, where `sha256` resolves to `$STATE/kb/fetched/<sha>`. Per quote: the 6-15 word length rule, then `findQuote` against the body. Output per quote `{claim, quote, ok, reason?}`, `reason` one of `too_short`, `too_long`, `not_found`, `body_missing`. Exit 0 all ok, 1 any not ok, 2 unreadable input. Pure: writes nothing |
| `kb watch add <name> --query "<q>" [--sources …] [--repo o/r] [--pypi name] [--feed url]` \| `list` \| `check [<name>] [--json]` \| `mark <name> <key…\|--all-new>` \| `rm <name>` | what is new since the last look (propagate#402, in progress: the survey skill names these subcommands ahead of the command landing on main). The store is `$STATE/kb/watch/<name>.json` (`{query, sources, cursor, seen}`), written atomically; an unreadable store is exit 2 and is never overwritten. `check` is pure: it lists items whose key is not in `seen`, using a source's own "since" where it has one, and writes nothing, so a crashed agent loses nothing; `mark` records items as seen after they were used. No background job: a watch is derived when someone runs `check` |
| `skills/survey/SKILL.md` | the skill that tells an agent to call `kb survey --json`, read each `body_path`, quote and run `kb survey verify`, and bracket a research task with `kb watch check` and `kb watch mark`. `literature-review` links to it as the cheap first pass; only the gated review writes the knowledge base |

**Registries `kb survey` and `kb watch` leave out, each with the reason (probed 2026-11-26):**

| Registry | Why it is not an engine |
|---|---|
| PyPI search | PyPI has no search API; a named package is watched through its release RSS (`kb watch add --pypi`) |
| Smithery | returned HTTP 500 when probed |
| Glama | needs a key and carries an attribution licence |
| MCP Market | returned 403 and has no public API |
| GitHub code search | limited to 10 requests a minute and needs a token; repository search (`--sources code`) is used instead |

| `kb review new <slug> --decision <text> --decider <name> [--json]` | creates `<reviewsDir>/<today>-<slug>/protocol.md` from the template (front matter: type, supersedes, questions, restrictions, stopping, inclusion, exclusion, sources, upkeep, approved; body: Kitchenham's sections). `<reviewsDir>` is `kbReviewsDir` (`PROPAGATE_KB_REVIEWS_DIR`), else `reviews/` beside `kbStandardsDir`. Exit 0 written; 1 the directory exists (never overwritten); 2 not configured or usage |
| `kb review assemble <dir> [--json]` | merges `lanes/<id>.json` with `searches.json`, `fetched.json` and the protocol into `brief.json`, the only file it writes (atomically, and only after `validateBrief` passes). A lane file is the researcher's JSON plus three fields the coordinator writes around it: `model`, `round` (1 first pass, 2 the snowball round) and `handed` (the shas it gave that lane, so a lane cannot widen its own source set); optional `from` (the round-1 included sources a snowball lane started from), `brief`, `model_version`, `secondary_review`. It refuses, listing every problem and writing nothing: `LANE_NOT_HANDED` (a sha screened, cited or flagged that was not handed), `LANE_NOT_FETCHED`, `LANE_UNSCREENED` (handed, no decision), `SOURCE_UNSCREENED` (fetched, handed to no lane), `LANE_HANDED_TWICE`, `LANE_CLAIM_SOURCE`, `LANE_SUGGESTION_SOURCE`, `QUOTE_LENGTH` (6-15 words), `REASON_MISSING`, `LANE_RQ_UNKNOWN`, `LANE_ID_MISMATCH`, `SNOWBALL_EXCEEDED` (a round beyond `restrictions.snowball_rounds`, or one started from a snowball lane's source), `SNOWBALL_SOURCE_EXCLUDED` (started from a source no round-1 lane included), `ALREADY_APPLIED` (`brief.md` exists), `BRIEF_INVALID`. Fetches that were not `ok` become `not_retrieved` rows (lane `fetch`), counted and never hidden. It never judges a quote against its body: that is `check`. Exit 0 written; 1 refused; 2 an input could not be understood (`LANE_UNREADABLE` prose or not JSON, `LANE_SHAPE`, `INPUT_UNREADABLE`, `LANES_MISSING`, `KB_REVIEW_NO_GIT`) |
| `kb review check <dir> [--refetch] [--json]` | the gate. Reads `protocol.md`, `brief.json`, `fetched.json`, `searches.json`, `discovered.json`, `agreement.json` and the bodies under `$STATE/kb/fetched`, and writes nothing. Refusal codes: `PROTOCOL_UNAPPROVED`, `PROTOCOL_INVALID`, `PROTOCOL_SHA_MISMATCH`, `PROTOCOL_UNCOMMITTED`, `PROTOCOL_AFTER_SEARCH`, `SUPERSEDES_INVALID`, `BRIEF_INVALID`, `SEARCH_UNLOGGED`, `SOURCE_NOT_FETCHED`, `QUOTE_NOT_FOUND` (6-15 words, `findQuote`), `CITATION_MISMATCH`, `STANDARD_ROW_TIER`, `DUPLICATE_REFERENCE`, `SCREENING_UNRELIABLE` (kappa below 0.8), `SCREENING_KAPPA_UNDEFINED` (either rater gave every sampled item one label, so kappa has no value; never read as 0 or as a pass), `SCREENING_RATER_UNKNOWN` (the record has no `rater` / `rater_kind`; never assumed human), `SCREENING_RATER_NOT_HUMAN` (a `model` rater where the protocol requires a person: true unless its `## Quality` section says `second reviewer: model`). A missing agreement is the warning `SCREENING_UNSAMPLED` here and a refusal in `apply`. Tiers come from recorded data and the table at `kbTiersFile` (`PROPAGATE_KB_TIERS_FILE`): peer-reviewed venue, official docs, arXiv preprint, table, default. Claims are `quote_verified`: the quote exists in the saved source. `--refetch` re-fetches each source and warns on drift, never refuses. Exit 0 ok; 1 refused; 2 could not run (`KB_TIERS_NOT_CONFIGURED`, no git, no such directory) |
| `kb review agree <dir> [--record <file> --rater <name> --rater-kind human\|model\|model-referenced [--override <decision-id>]\|--rater-brief\|--disagreements\|--adjudicate <file>] [--apply] [--json]` | without `agreement.json`, prints the blind sample: every `excluded` entry plus 20% (at least 1) of the `included` entries of `screened[]`, and 20% of claims for support, seeded by `protocol_sha` so a re-run draws the same items. `not_retrieved` rows are never drawn or scored (no one read them); the output gives their count. `--record <file>` validates `{screening: {<url>: include\|exclude}, support: {<claim_id>: supports\|does-not-support}}` against the sample and writes `agreement.json` only with `--apply`; it requires `--rater` and `--rater-kind` and stores both (`rater`, `rater_kind`, `date`; schema_version 2), so `check` can tell a human second reviewer from a second model (#376). With one recorded, prints the rater, raw agreement, Cohen's kappa (threshold 0.8, our own choice) and the support failures, which are reported and not a refusal in v1. When either rater's labels are all one class, kappa is `null` with a `reason` and the verdict is `undefined`, which is not a pass (#377). Exit 0 sample printed, recorded, or reliable; 1 unreliable, undefined, stale or invalid answers. **Model second rater (#412).** `--rater-kind model-referenced`: the rater answers each protocol criterion with a 6-15 word quote and code derives `include` (an I-criterion met, every met criterion quote found by `findQuote`, no E-criterion met), `exclude` (an E-criterion met with a found quote) or `cannot-rate` (anything else; a third answer that is listed and never scored, kappa runs over include/exclude only and the count is reported). `--record` then takes `{model, screening: {<url>: {criteria: [{id, met, quote, reason}], reason}}, support}`, and writes `rater.json` (answers, quotes, reasons, the model id and the sha256 of `agents/literature-rater.md`) beside `agreement.json`. `--override <decision-id>` records `override: {by, decision, why, date}`, so `check` warns `SCREENING_RATER_MODEL_OVERRIDE` instead of refusing `SCREENING_RATER_NOT_HUMAN` where the protocol still names a person; new protocols say `second reviewer: model`. `--rater-brief` (pure) prints JSON, per sampled item its url, saved-body path and the protocol criteria verbatim, nothing else. `--disagreements` (pure) lists each lane-vs-rater disagreement on one line (title, lane call, rater call, deciding criterion, both reasons), always shows the lane-excluded and rater-included ones first, and prints the tolerable count, the largest number of disagreements this sample absorbs with kappa >= 0.8 in the worst split (derived from the sample's own class counts; the formula is in `lib/kb/review/disagree.mjs`). Over it: exit 1, re-run with a widened sample (T7) and a changed brief, recorded as `reruns` in `agreement.json`; after 2 re-runs, exit 1 "stuck". One class empty (kappa `null`): exit 1 with its own message, never the kappa < 0.8 path. `--adjudicate <file>` takes `{<url>: lane\|rater}` for listed disagreements only and writes `adjudication.json` only with `--apply`; `brief.screened` is never edited, kappa stays scored before adjudication, and `apply` uses the lane decision unless an adjudication says `rater` |
| `kb review apply <dir> [--json]` | re-runs the gate and refuses, writing nothing, on any refusal and on `SCREENING_UNSAMPLED`. Otherwise writes, in order: `brief.md`, new `reference` proposals appended to `kb-references.yml` (verdict `evaluate`, `added: {date, by, ask}`; existing entries byte-unchanged), `candidates.md`, and, when `supersedes:` is set, the old review's `status.json` (`{schema_version: 1, status: superseded, by: <this review dir>, date}`, through a temp file and a rename; the only write outside the review's directory). An approved `protocol.md` is never edited after approval: its front-matter `status` is the status at approval only, and the live status is `status.json` (none means `current`). `check` refuses `SUPERSEDES_INVALID` when the target's `status.json` already says superseded by a different review, and an old review that is `superseded` or `retired` still checks normally, with the warning `REVIEW_NOT_CURRENT` naming its replacement. Exit 0 written; 1 refused; 2 could not run |
| `kb migrate [--apply] [--json]` | rename each sidecar's `standards:` key to `kb:`; a dry run unless `--apply`; a sidecar holding both keys is a conflict (exit 1) and is never merged |

**Every adoption command is a dry run unless `--apply`.** The dry run prints the entry, the rows with their status,
and the `command` / `test` checks adoption would run; **`adopt` does not run them**, so their output goes in with
`--evidence`. `--apply` is accepted for `adopt` only. For `decline` and `remove` it is refused with
`STANDARDS_APPROVAL_UNAVAILABLE` until approvals exist (S4). `--apply` writes `by` from `gh api user`; if that cannot
be read the command stops with `STANDARDS_IDENTITY_UNKNOWN` and never writes a blank. Re-adopting refreshes
`verified_on` (and `units` and `evidence` when given) and keeps `since` and `by`. The sidecar is found through
discovery's workspace roots by the sidecar's `project:` field, never built from a directory name. A bare project name
that several workspaces share (every workspace's root unit is `workspace`) is refused with `STANDARDS_PROJECT_AMBIGUOUS`,
which lists `<workspace>/<project>` candidates; pass the qualified form. Units come from that workspace only.

Refusals: `STANDARDS_USAGE`, `STANDARDS_UNKNOWN`, `STANDARDS_PROJECT_UNKNOWN`, `STANDARDS_PROJECT_AMBIGUOUS`, `STANDARDS_ALREADY_ADOPTED` (decline
of an adopted standard), `STANDARDS_NOT_ADOPTED` (remove of one not adopted), `STANDARDS_UNREADABLE`,
`STANDARDS_WRITE_REFUSED` (the sidecar changed since the plan was made), `STANDARDS_NOT_CONFIGURED`,
`STANDARDS_BLIND`, `STANDARDS_UNKNOWN_PROJECT`. Each prints `<CODE>: <what>. Next: <command>` on stderr, or
`{ok:false, code, what, next}` with `--json`.

**Exit codes** of `kb standards`: 0 a report and no problems; 1 a report with problems (a page or sidecar could not be
read); 2 could not run (not configured, registry unreadable, blind, usage). The adoption commands exit 0 or 2.

### The sidecar `kb:` block

The record lives in the project's `propagation/state/<project>/.sidecar.yml`, never in `.propagates.yml` (its schema
is closed; an extra key would disable every edge in the file). Only the `kb:` pair (a legacy `standards:` key is read until `kb migrate` renames it) is rewritten, and every
other byte of the sidecar is kept; the cost is that comments **inside** the block are regenerated away.

```yaml
kb:
  adopted:
    - {standard: acme-tool, units: [apps/acme-app], since: 2026-11-16, by: acme-dev, verified_on: "acme-tool 3.4.1", evidence: "..."}
  overrides:            # {standard, row, reason}
  declined:             # {standard, reason}
  removed:              # {standard, on, by, reason, approved_pr: null}
  reviews: []           # reserved for `kb standards review` (not built)
  local_page: docs/acme-ws/reference/ACME-TOOL.md
```

`local_page` is read and kept, **but no code reads the page it names yet**: the report does not parse a project page,
so `extends:`, `Applies:` and `local-<n>` rows are parsed (by `parsePage`) but not yet reported on. `reviews:` is read
and preserved so the review command needs no schema change.

### doctor: `# Knowledge base`

`lib/report/doctor/kb.mjs`, offline (the section was `# Standards` before #322). Not configured is `info` and skipped (the normal state on another
machine). Could not run is `inconclusive`, which votes. A finding that is documentation debt is `warn`, which is never
counted, so a tree with only warnings leaves doctor's problem count unchanged. A declaration error is `check(false)`,
which is counted.

| Finding | Reported as | Meaning |
|---|---|---|
| `STANDARDS-UNREADABLE` | inconclusive | a registry, page or sidecar problem, a non-list `overrides:` or `declined:`, a blind scan, or an exception inside the section (`standards could not run`); one defect is one entry |
| `RE-VERIFY` | warn | rows whose `Version` is older than the version in use |
| `VERSION-NOT-READ` | info | rows with no version in use; counted apart from re-verify |
| `UNCHECKED-ROW` | info | a count of review and none rows |
| `CHECK-CANNOT-FAIL` | warn | a `command` or `test` row with no `Fails when:` |
| `DETECTED-NOT-ADOPTED` | warn | detected, neither adopted nor declined; a name shared by two workspaces is listed as `<workspace>/<project>` |
| `ADOPTED-UNDETECTED` | warn | adopted, detector finds nothing |
| `UNIT-NOT-ON-DISK` | warn | an adopted unit not on disk (never "not detected") |
| `LEGACY-NAME` (S3) | warn | one per old config key that supplied a value (`<name> uses the old name; rename it to <replacement>`) and one per sidecar still carrying `standards:` (`<file> uses the old name; run propagate kb migrate`) |
| `OVERRIDE-NO-REASON`, `OVERRIDE-STALE`, `DECLINE-NO-REASON` | check, fails | a declaration error; stale = standard not adopted, or the row retired or missing |

The two adoption findings apply to `kind: tool` standards only: a `global` or `production` standard detects every
code unit, so each project would warn and the finding would carry nothing. The section's `SEVERITY` is a single `S2`
(`doctor-severity.test.mjs` requires one value per section). `FINDING_SEVERITY` holds the per-finding values of the
design (S1 to S3, info); **nothing reads it yet, so it is documentation, not behaviour**.

### Units (#291)

Detection reads the manifest's unit walk (`lib/report/manifest.mjs`). Decided 2026-11-17: **a workspace repo's root
with its own lockfile is a unit, with or without a workspace sidecar.** With a sidecar, the root is probed for its own
lockfile only and its nested units stay with their projects; without one, the root becomes a project named
`workspace`. `pubspec.lock` is a lockfile (toolchain `dart`), and pub workspace members count as units. The walk goes
through directories that are not units down to depth 2, and never into a unit.

The undeclared-repo walk ("would be missed") is **unbounded**, limited only by discovery's skip set (`isSkippedDir`),
and **stops at any other discovered workspace's root**, the same ownership rule as the cross-repo owner check.

### Not built yet

| Not built | Where it lands |
|---|---|
| `kb standards review <row-id> [--apply]`: records who, when, tool version and evidence in the sidecar `reviews:` list; `verified` while the version is unchanged and the review is younger than a limit (proposed 90 days, open), `re-verify` when either changes, `unchecked` until the first review (decided 2026-11-17, #290; **Task 6b**) | until then `UNCHECKED-ROW` stays an info count |
| edges: drift of a standard's rows into projects, `adopt --apply` pinning an edge, `ADOPTED-UNSETTLED` | S3 |
| approvals: applying `decline` and `remove`, `UNAPPROVED-CHANGE`, `APPROVALS-NOT-CONFIGURED` | S4 |
| delivery: pointers into agent files, `POINTERS-DRIFT` | S5 |
| migration of rules to standards | S6 |
| plans in the standards flow | S7 |
| per-unit versions from a project's lockfile, or a probe run with `cwd` set to the unit | #290 |
| repo-level detect files | #316 |
| `AUTHORITY-UNRESOLVED` and `kb standards audit --online` | online slice |

## `propagate sessions`: who works where (propagate#272)

Which Claude Code sessions are live, in which folder, on which goal and item. Live state is derived from `claude agents --json` on every call and never cached; propagate stores only the association and a folder cache, both in the state directory (`$PROPAGATE_STATE_DIR/sessions/`), never in a repo.

```
propagate sessions [--json]
propagate sessions show <id|name> [--json]
propagate sessions assoc <id> (--from owner/repo#n [--goal G<n>] | --goal G<n> --item owner/repo#n) [--json]
propagate sessions new (--from owner/repo#n | <folder> --goal G<n> --item owner/repo#n) [--name <n>] [--again] [--apply] [--json]
propagate sessions stop <id|name> [--force] [--apply] [--json]
propagate sessions rm <id|name> [--apply] [--json]
```

- **The table:** grouped by workspace, columns `project`, `goal`, `item`, `state`, `since`, then `id` and `name`. A session with no association says `unassociated` in the item column, and the table closes with `assoc: propagate sessions assoc <id> --from owner/repo#n`. An empty list prints `0 live sessions (claude agents read <ts>)`. A cwd at the hub root reads `hub (all)`; one outside every workspace is grouped as `unplaced`.
- **Row key and one row per session id (#318):** a row's key is `(kind, id || sessionId, pid)`, but `claude agents --json` lists one session id as both a background and an interactive row (a resumed or renamed session keeps its stale background row and name). `sessions` shows ONE row per `sessionId`: the most recently started (a tie goes to the interactive row), with that row's current name. The other rows stay on it as `rows`, so `show`/`assoc` selectors naming a sibling (its background id, its pid) still find the session. `assoc` writes to the shown row's key. A session's association is the newest one recorded under any of its row keys or carrying its session id.
- **Selecting a session:** `pid:<n>`, then the background `id`, then `sessionId` (exact, or a prefix of 6+ characters), then the name. The first form that matches wins; more than one match inside it is `SESSION_AMBIGUOUS`.
- **Repos:** a session works in every repo whose checkout is at or below its folder, plus the deepest checkout containing it. The repo to checkout map is `$STATE/sessions/checkouts.json`, rebuilt on every CLI read from discovery plus `git remote get-url origin`; a linked worktree resolves to its main checkout through `git rev-parse --git-common-dir`.
- **Ended:** an association whose session is absent from `claude agents --json` reads `ended (not in claude agents)` and is never dropped. The text view lists the 10 newest; `--json` lists all.
- **`assoc --from`:** reads the goal from the dispatch snapshot (`$STATE/day/items.json`, written by `day open`). A null or missing goal refuses with `SESSION_GOAL_UNKNOWN`; a snapshot older than 24 h warns and does not refuse.
- **`--json`:** `{ok, readAt, sessions, ended, counts: {live, unassociated, unplaced, unknown, ended}}`.
- **Testing:** `PROPAGATE_CLAUDE_BIN` names the binary (default `claude`); `PROPAGATE_CLAUDE_TIMEOUT_MS` overrides the 15 s read timeout. `claude --bg --help` starts a session rather than printing help, so no test and no code path may pass `claude` anything but `agents --json` from this half; `lib/sessions/live.mjs` is the only place `claude` is run.

**The act half (create and delete).** `new`, `stop`, `rm` and `stop --force` are a dry run unless `--apply`; the dry run starts, stops and signals nothing and writes nothing to `assoc.jsonl` (`stop`, `rm` and `--force` still READ `claude agents --json` to find their session; `new` makes no `claude` call at all).
- **`new`:** `--from owner/repo#n` derives the folder (the one checkout whose origin is that repo), the goal (the dispatch snapshot; a null goal is `SESSION_GOAL_UNKNOWN`) and the name `<project> · G<n> · #<n>`; a positional `<folder>`, `--goal` and `--name` override. The dry run prints the derived facts, the snapshot age and the exact argv. `--apply` takes ONE lock on `assoc.jsonl` across: read live, refuse `SESSION_ITEM_LIVE` when a live session already serves the item (unless `--again`), append `approved`, run `claude --bg -n <name> <prompt>` in the folder (30 s bound), identify the session (parse `backgrounded · <id>`, else join `claude agents --json` on name + cwd + startedAt at or after the launch, within 10 s), append `created` and `associate`, release. The argv never carries a permission-mode, bypass or help flag. The prompt carries references only (the issue URL and the guidance file paths), never an issue body. `--apply --json` prints `{ok, sessionId, id, name, cwd, state}`.
- **`stop` / `rm`:** background sessions only (`claude stop <id>`, `claude rm <id>`); `rm` is refused unless the session is `stopped` or `done`. Intent events (`stop-requested`, `rm-requested`) are appended before the call, `stopped` / `removed` after it.
- **`stop --force`:** sends SIGTERM to an interactive session by its pid, never SIGKILL. Immediately before the signal the list is re-read and the same pid + sessionId + cwd must still be listed, else `SESSION_PID_CHANGED` and 0 signals were sent. The current session (Claude Code's own session-id environment variable), this process and its parent are refused. The list is then re-read for up to 10 s; still listed is `SESSION_STILL_PRESENT`.
- **Events in `assoc.jsonl`:** `approved`, `created`, `create-failed`, `unknown`, `stop-requested`, `stop-aborted`, `stop-unconfirmed`, `stopped`, `rm-requested`, `removed`.

**Errors.** Every failure prints `<CODE>: <what>. Next: <command>` on stderr, or with `--json` `{ok:false, code, what, next, side_effects}`. Exit 2 = could not read, or usage; exit 1 = refused.

| Code | Exit | Meaning |
|---|---|---|
| `SESSION_READER_FAILED` | 2 | `claude agents --json` is missing, exited non-zero, timed out, or printed non-JSON |
| `SESSION_SHAPE_UNKNOWN` | 2 | it printed JSON whose shape is not understood (rows need string `cwd`, `kind`, `sessionId`); never an empty list |
| `SESSION_USAGE` | 2 | wrong arguments |
| `SESSION_ASSOC_UNREADABLE` | 2 | `assoc.jsonl` exists but cannot be read |
| `SESSION_NOT_FOUND` | 1 | no live session (or ended association) matches |
| `SESSION_AMBIGUOUS` | 1 | more than one session matches; the `Next:` names a `pid:` selector |
| `SESSION_GOAL_UNKNOWN` | 1 | `assoc --from` found no goal for the item in the dispatch snapshot |
| `SESSION_ASSOC_WRITE_FAILED` | 1 | the association line could not be appended; nothing changed |
| `SESSION_ITEM_LIVE` | 1 | `new --apply`: a live session already serves the item; `--again` starts another |
| `SESSION_LOCKED` | 1 | `new --apply`: another create holds the association lock; nothing was started |
| `SESSION_FOLDER_UNKNOWN` | 1 | `new`: no checkout, more than one checkout, or a folder outside every workspace |
| `SESSION_LAUNCH_FAILED` | 1 | `claude --bg` exited non-zero |
| `SESSION_LAUNCH_TIMEOUT` | 1 | `claude --bg` did not return within 30 s; a session may have started |
| `SESSION_FOLDER_UNTRUSTED` | 1 | `claude --bg` refused: the folder has never been trusted (measured 2026-11-14: it refuses in ~1.6 s, it does not hang); no session started. Next: open `claude` once there and accept the prompt |
| `SESSION_ID_UNKNOWN` | 1 | the launch returned no id and the join found 0 or more than 1 row; a session started and is not retried |
| `SESSION_WRONG_KIND` | 1 | `stop` / `rm` on an interactive session, or `--force` on a background one |
| `SESSION_NOT_STOPPED` | 1 | `rm` on a session that is not stopped or done |
| `SESSION_SELF` | 1 | the target is the current session, or this process or its parent |
| `SESSION_PID_CHANGED` | 1 | `--force`: pid + sessionId + cwd no longer match at the re-read; 0 signals sent |
| `SESSION_STILL_PRESENT` | 1 | `--force` (still listed 10 s after SIGTERM) or `rm` (still listed after `claude rm`) |
| `SESSION_ACT_FAILED` | 1 | `claude stop` / `claude rm` failed, or the signal could not be sent |

**Launches with no known session.** A create whose outcome is not a known session (its last event is `approved`, or `unknown`: a session may have started but no id was joined) is listed under `launches with no known session` and counted in `counts.unknown`. It is never hidden and never retried. It drops out once a later association for the same item exists.

**No test can run the real `claude`.** `lib/sessions/live.mjs` `runClaude` is the only new spawner. Under the test runner (`NODE_TEST_CONTEXT`, set by node in every test process and the processes it spawns) with no `PROPAGATE_CLAUDE_BIN`, it refuses rather than fall back to `claude`, so a test that loses its stub fails instead of launching a session (GOTCHAS G91: `claude --bg --help` starts one).

**The session-guide hook** (SessionStart, every source: startup, resume, clear, compact, fork) tells the session its folder, repos, goal and item, and which guidance files to read first:

```
Session: <project> (<workspace>) · repos: a, b · goal G<n> · item owner/repo#n. Read first: <files>.
```

- With no association it says `unassociated: propagate sessions assoc <id> --from owner/repo#n`.
- **Associated without `assoc` (#318, #442):** two hooks append `associate` lines for a session (`rowKey` `session:<session_id>`, one O_APPEND line each, through `lib/sessions/assoc-write.mjs`), and **the newest wins**: a session with no association, or one holding a DIFFERENT item, gets a new line; the same item is a no-op; the fold's history keeps every line, so `sessions show` lists both. This supersedes #318's "never overwrites". Each line carries `source` (`dispatch` or `derived`) and `signal`.
  - **`dispatch` (`dispatch-model`):** an allowed Agent/Task dispatch naming a board item in today's day snapshot. A deny, a missing session id or an item with no goal writes nothing.
  - **`derived` (`agent-nudge`, PostToolUse on Bash):** the item the session's own successful command works on, read by `lib/sessions/derive.mjs`. PostToolUse fires only on success, so a failed command never associates. Never in a subagent (`agent_type` set): a lane's commands are not the coordinator's work.
  - **The goal** of a derived line comes from today's day snapshot when the item is in it; otherwise it is null with `goal_source: "not in today's snapshot"`, never guessed.

  | Signal (a write or a start of work) | Example |
  |---|---|
  | issue write | `gh issue close`, `comment`, `edit`, `reopen`, `develop` `<n> [-R o/r]` |
  | PR write | `gh pr create` / `merge`, with `Closes #n` in its arguments, else the `--head` or checked-out branch's `<n>` |
  | branch start | `git switch -c`, `git checkout -b`, `git worktree add -b`, or `scripts/worktree-new.sh`, with `<type>/<n>-<slug>` (`rule:branch-and-worktree-names`) |

  Reads never count (`gh issue view`, `gh issue list`), nor does text that only mentions a command (`echo gh issue close 9`, a commit message, a heredoc body), nor `gh project item-edit` (its `PVTI_` id needs the network). The repo is `-R`/`--repo`, else the cwd's git origin read from `.git/config` (a linked worktree follows its `commondir`), with no subprocess and no network; with neither, nothing is written. In a compound command (`&&`, `;`, `||`, newline) the last signal wins. `sessions assoc` stays the manual override.
- **The session title (#442):** the `session-title` hook (UserPromptSubmit) reads the session's association by `session_id` and returns `hookSpecificOutput.sessionTitle` = `owner/repo#n · <rest>`, where `<rest>` is the payload's `session_title` with any earlier `owner/repo#n · ` prefix stripped (a `/rename` name survives). It is silent with no association, when the title already starts with the item, in a subagent and on any error. It builds on Claude Code's own display: the session title is shown in agent view, `/resume`, the statusline `session_name` and `claude agents --json` `name`, and a UserPromptSubmit hook may set it with `sessionTitle` ([hooks](https://code.claude.com/docs/en/hooks)); `PostToolUse` fires only on success and `PostToolUseFailure` on failure. Claude Code has no issue field or per-session metadata, which is why the association log stays the `sessionId -> item` map. A new registration needs `/reload-plugins`.
- The block is at most 2,000 characters; a long repo list ends with `+N more: propagate sessions show <id>`.
- It reads only `$STATE/sessions/checkouts.json` (refreshed by the sessions CLI), `assoc.jsonl` and `.propagates.yml` markers up the cwd ancestry. Its state dir comes from `lib/core/paths.mjs`.
- It never calls `claude`, the network or git, except one `git rev-parse --git-common-dir` when cwd is inside `.claude/worktrees/`.
- A cwd outside every workspace, or no cache, injects nothing.
- Any error appends one line to `$STATE/sessions/errors.log`, and the hook exits 0 silently.
- Plugin hook registrations: count them in `hooks/hooks.json`. It applies after `/reload-plugins`, and does not run under `--bare` or in cloud sessions.

### Broadcast delivery (propagate#267 phase 2)

The same hook adds one `Broadcast:` line for the open broadcast items in the repos a session works in. It reads a local index, so there is no network call and no second hook.

- **The index.** `$STATE/broadcast/index.json` holds the OPEN children of every open broadcast, from ONE GraphQL search (`is:open label:broadcast user:<owner>`, the owner derived from the hub's origin) that covers every hub. Only that full read replaces the file: `propagate broadcast status` with no number, and `propagate day open` (through its own fetcher, counted in the GraphQL-calls line). `broadcast status <n>` and `broadcast new --apply` only MERGE their own parent and never shrink the rest. A failed search writes nothing and says so. More than 50 broadcasts, or more than 100 sub-issues in one, sets `truncated: true`.
- **The line.** Grouped by parent: `Broadcast: hub#7 "<title, 60 characters>" → 2 here: web#11, api#12 · propagate broadcast status`. Repo names match case-insensitively; a worktree reads as its main checkout. An index older than 24 hours adds `may be stale (Nd)`; older than 7 days the items are dropped and only `stale` plus the pointer is shown.
- **The hub session** gets a summary (`Broadcast: N open across M repos`) and records no shown rows.
- **Cut order inside the 2,000-character cap:** the broadcast items, then the whole broadcast line, then repos, then guidance files. Each line ends with its own pointer.
- **A broadcast failure is isolated.** A corrupt index drops only the broadcast line and logs one `sessions/errors.log` line; the session line still prints.
- **The shown record.** `$STATE/broadcast/shown-YYYY-MM.jsonl` (UTC month of the row), one row per child the line COVERED (not only the ones listed): `{ts, session_id, source, repo, child, listed, attended, entrypoint}`, written in one append per injection. `attended` and `entrypoint` come from Claude Code's attended-session and entrypoint environment variables (hooks/session-guide.mjs names them) when set, so a lane or `-p` run can be told from a person. A full index write prunes the months with no open child left.
- **Contexts, not sessions.** compact keeps the session id; clear and fork make a new one, so `status` counts contexts and says so: `shown 2d (3 contexts, 1 attended)`, or `not shown`. A child open more than 2 days and never shown prints `not shown (Nd)` plus only a cause `status` can establish (no index yet, the child is absent from the index, or the index is 7+ days old), else neutral wording: hub sessions, lines cut by the cap and cloud or `--bare` sessions record no row either. An unreadable shown record prints `shown: not read` (`shownRead: false` in `--json`), never `not shown`. The index also carries each child's board Goal (null when unset) from the same single search, and the hook line and `status` print `goal not set`. `status <n>` merges only an open issue labelled `broadcast`. "Shown" means the text was injected into a session; it does not mean read or acknowledged.
- **Not relied on.** Cloud and `--bare` sessions run no hooks, so their children read `not shown`. There is no push to a running session and no acknowledgement state beyond shown.
- **`broadcast status --json` changed shape:** each child carries `title`, `number` and `shown`; the header counts come from the children's states; `missing` is gone (the phase 1 body comparison printed false lines for a scrubbed public parent).
- **Goal.** A `--to` child, and a `--from goals-check` child with no item evidence, no longer take the hub's goal: Goal is the workspace's single active goal, else unset (`Goal: not set` in the dry run; no board write).

## `propagate work`: the work event queue (propagate#150)

A local queue of work for sessions to claim, one item per labelled GitHub issue. The queue is a **view over GitHub**: `work sync` reads the open issues that carry a kind's label and makes the queue match; nothing in `work` ever writes to GitHub. The first kind is `evaluate` (what a session evaluates and why: the evaluator design, `propagation/docs/propagate/plans/2026-11-15-evaluator.md`, which this section does not restate).

```
propagate work list [--kind k] [--state s] [--json]
propagate work sync --kind k [--hub owner/repo] [--json]
propagate work claim --kind k [--session id] [--json]
propagate work ack <id> --token t [--session id] [--json]
propagate work release <id> --token t [--session id] [--refusal] [--reason r] [--json]
propagate work unpark <id> [--json]
propagate work prune [--older-than <days>] [--apply] [--json]
```

**Where it lives.** One SQLite file, `$PROPAGATE_STATE_DIR/work/queue.db` (default `~/.propagate/work/queue.db`), in WAL mode, with a 5 s busy timeout. **`queue.db`, `queue.db-wal` and `queue.db-shm` are state, not cache.** A cleaner that removes "cache entries older than N days" must exclude the whole state directory; deleting the file loses every acked and parked row, and the next `work sync` rebuilds only the open issues, as `pending`. The store lives on a local disk: `openDb` refuses a synced folder or a network mount (`WORK_STORE_UNSAFE`) and warns when its probe cannot run.

**One machine per state dir.** SQLite locks do not work across machines, and two machines each syncing and claiming would double-claim. Share the queue by sharing GitHub (each machine syncs its own), never the file.

### States and fields

`pending` -> `claimed` (session, token, `lease_until`) -> `acked`, or `expired` (the issue closed, its URL changed, or its ttl passed), or `parked`.

- **Item:** `id`, `kind`, `scope` (the repo), `dedupe_key`, `payload` (JSON; for `evaluate`: `issue_repo`, `issue_number`, `url`, `canonical_url`), `created`, `expires_at`, `state`, `session`, `lease_until`, `claims` (a receive count), `refusals`. Times are epoch milliseconds in the database and ISO in the output.
- **Lease:** 30 minutes. A claimed item whose lease ran out is claimable again, and `list` shows it as `pending (lease expired)`. Expiry is the only release for a dead run.
- **Token (the fence):** every claim mints a random `token`, printed by `claim` and carried by `claim --json`. `ack` and `release` must present it, and they are fenced by session **and** token, never by the clock: lanes of one session share a session id, so the session alone cannot tell two claims apart. A lease that ran out but was not re-claimed still accepts its own token. After a re-claim, the old token gets `WORK_LEASE_EXPIRED`, and its `next` says to run `propagate work list --kind <k>` before redoing any side effect. **`list` never prints a token**, in text or `--json`: a stale lane must not be able to copy the current claimant's.
- **Park rule:** the 2nd `release --refusal` parks the item (`PARK_AFTER = 2`); a parked item is never claimed. It leaves `parked` by `work unpark <id>`, or when `sync` sees the `evaluate:parked` label on the issue go away after it had been seen there.
- **Dedupe rule:** the key is `<kind>:<canonical_url>`, held by a partial unique index; only `expired` frees a key. `acked` keeps it held, so a re-sync of a still-open issue adds nothing. A URL is canonicalised before it becomes a key (`lib/work/canonical.mjs`): the scheme, `www.`, query, fragment and trailing slash are dropped, a closing sentence mark or markdown `)` is not part of it, and a `github.com` URL collapses to `github.com/<owner>/<repo>` (lowercased, no `.git`, no deeper path), so a repo and its `tree/main/docs` page are one thing; any other host keeps its path's case. The URL is the first one in the issue body; **when the body has none, a URL in the title is used.** An issue with neither is listed under `unparsed` by `sync` and never queued.
- **At-least-once, not exactly-once.** A run can finish its side effect and then die or outlive its lease before `ack`; a second session then redoes it. **Every consumer of a kind must be idempotent, with its effect keyed by the item's `dedupe_key`** (each `KINDS` entry declares `idempotent_by`).

### Subcommands and exit codes

Exit 0 = ok; 1 = refused; 2 = could not run (usage, a store that cannot be read, GitHub). "Looked at nothing" is never a silent 0: it is stated.

| Command | Does | Notes |
|---|---|---|
| `list` | the items, with `effective_state` | an empty queue prints `0 work items`. On a store created by this call it also prints `store created now: acked/parked history before this point is not known` (`--json`: `created_now: true`). Reads without waiting (WAL), so it answers while a claim holds the write lock |
| `sync --kind k` | enqueue new items, expire items whose issue closed or whose URL changed, unpark | `--hub` defaults to the hub root's `origin`. Two `gh` calls (`label list`, `issue list`, limit 1000), then one transaction. A missing label reads `label kind:evaluate does not exist on <repo>: looked at nothing` (exit 0, `label_missing: true`). A result at the limit is `WORK_SYNC_TRUNCATED`. A fetch older than the stored `sync_marks` row is not applied (`stale: true`) |
| `claim --kind k` | take the oldest pending item for this session | session = `--session`, else `CLAUDE_CODE_SESSION_ID`; neither is `WORK_USAGE`. An empty queue prints `nothing pending for <k>` and exits 0 |
| `ack <id> --token t` | finish it | a repeated ack with the same token is `already: true`, exit 0 |
| `release <id> --token t` | give it back; `--refusal` counts toward parking | `--reason` is recorded in the event |
| `unpark <id>` | parked -> pending, refusals reset | any other state is `WORK_USAGE` |
| `prune` | delete finished history | below |

`--json` failures are `{ok:false, code, what, next}`; text failures are `<CODE>: <what>. Next: <command>` on stderr. A raw `SQLITE_BUSY` (a lost lock at BEGIN or COMMIT) is always `WORK_STORE_UNREADABLE`, never surfaced raw. Warnings from opening the store (for example a safety probe that could not run) go to stderr and into `--json` `warnings`.

### `work prune`

`work_events` is append-only **except** `work prune --apply`. It deletes the events of `acked` and `expired` items whose **last event** is older than `--older-than` days (default 180; the item's `created` is not its age). An `expired` item's row goes too; an `acked` row stays as a tombstone. It never touches `pending`, `claimed` or `parked` items, of any age. Without `--apply` it is a dry run that changes no row; both forms print and `--json`-report the counts (`items`, `events`). One consequence to know before applying:

- **An acked row is never deleted** (R22 overrides C9b), so its dedupe key stays held and acked work is never re-queued, however old.
- **A stale token after a prune.** Prune deletes the events that record which token a session held, so a late `ack` on an item whose row was removed (an expired one) reads `WORK_NOT_FOUND`. A late ack with the right token on a still-held acked row stays `already: true`.

### Known limits (stated, not built)

- **A reopened issue after ack is not re-queued.** The acked item still holds the dedupe key, by design, and prune never removes it. A requeue path is not built; to redo the work, file a new issue.
- **A backup restore without `queue.db-wal` loses rows silently.** In WAL mode the recent writes live in the `-wal` file until a checkpoint; restoring `queue.db` alone returns an older, consistent-looking database. No cheap detector exists. Back up the three files together, or none.
- **The store is recreated empty if the file is lost** (the `created_now` line is the only sign).

### The `evaluate` kind

Reads open issues labelled `kind:evaluate` on the hub repo; an issue also labelled `evaluate:parked` is skipped and marks a parked item as seen. An item expires after 30 days. Its claim pattern follows goqite and sqliteq (one `UPDATE ... WHERE id = (SELECT ...) RETURNING *` statement, a receive count, a visibility timeout); the database is Node's built-in `node:sqlite` (Node 22.13 or later), with no new dependency.

### Error codes

| Code | Exit | Meaning |
|---|---|---|
| `WORK_USAGE` | 2 | wrong arguments, an unknown kind, or no session id |
| `WORK_STORE_UNREADABLE` | 2 | the database cannot be opened, read or locked in time |
| `WORK_STORE_UNSAFE` | 2 | the state dir is on a synced folder or a network mount |
| `WORK_STORE_TOO_NEW` | 2 | the file's schema is newer than this propagate |
| `WORK_NODE_TOO_OLD` | 2 | `node:sqlite` is unavailable (Node older than 22.13) |
| `WORK_SYNC_TRUNCATED` | 2 | the issue list hit its 1000 limit, so nothing was expired |
| `WORK_GITHUB_FAILED` | 2 | a `gh` call failed or printed something other than a list |
| `WORK_HUB_UNKNOWN` | 2 | no hub repo could be derived; pass `--hub owner/repo` |
| `WORK_NOT_FOUND` | 1 | no item with that id |
| `WORK_NOT_CLAIMANT` | 1 | this session and token do not hold a claim on the item |
| `WORK_LEASE_EXPIRED` | 1 | the claim was lost (the lease ran out and the item was claimed again) |
| `WORK_ITEM_EXPIRED` | 1 | the item expired: its issue closed, its URL changed or its ttl passed; nothing to do |

## `propagate day`: day open and day close (propagate#240)

`propagate day open [--json]` is read-only.
- **Budget:** today's daily cap minus today's use, from the usage widget (`PROPAGATE_USAGE_WIDGET_DIR`, else `integrations.usageWidgetDir` in `~/.propagate/config.yml`).
- **Supply:** the Ready items across every open board whose Status uses Backlog / Ready / In progress / Done. A board with other options is named and skipped.
- **Costing:** a calibrated Size is costed per Size. Everything else uses a **count basis** derived each run: the week-% consumed over 7 days, divided by the items with a Finished date in those 7 days. The output labels it, because it costs every item the same whatever its Size.
- **Also listed:** In progress carry-over, and Ready items with no Size.
- **Per active goal (propagate#240):** one block per active goal in the GOALS.md files (the same files and the same `active` flag as `goals check`), built from the boards already read, with no extra GraphQL call. It shows the goal id and title, the appetite and days left (`no appetite recorded` when none), and the counts of In progress, Ready, Backlog and Done items whose Goal is that id. A group the reader could not fully page (see paging below) prints as `≥N`, never as a total. Then **Ready by Order**: each Ready item with Order (`–` when unset), Priority, Model, Size, ref and title, in the promotion order below. Then one line naming the Ready items not under an active goal. The same data is in the `--json` result (`goalBlocks`, `readyNotUnderActiveGoal`). The budget, supply and verdict lines are unchanged.
- **Sessions per goal (propagate#272):** under every goal block, one `sessions: <project> · #<n> (<state>, <since>)` line per live session associated with that goal (`sessions: none` when there are none), then `no session: #a, #b` for that goal's Ready items no live associated session covers (omitted when every Ready item is covered). The sessions come from `claude agents --json` joined to `propagate sessions assoc` records, read once per run. If that read fails, one line `sessions: could not read (<CODE>: <what>)` follows the goal blocks. **The exit code is the same whether the reader succeeds, returns nothing or fails:** sessions are information beside the capacity verdict. `--json`: each `goalBlocks` entry carries `sessions: {live:[{project,item,state,since}], uncovered:["owner/repo#n"]}`, or `sessions: {error:{code,what}}`.
- **Verdict:** `short by ~N points` (with the top promotable Backlog items), `enough` (budget ≤ supply ≤ 2× budget), or `over` (with what will not fit).
- **Exit:** 0 enough; 1 short or over; 2 cannot judge (no good sample, no count basis, the rate limit too low, or the read went blind).
- **The glance (propagate#295):** `day open` computes the glance after its broadcast refresh and writes `glance.json`, which also deletes `<state dir>/guard/YYYY-MM.jsonl` files whose month ended more than 90 days ago (the prune moved into the glance; see "The glance" and "The background-guard log" below). It is local, runs whatever the verdict, and leaves any other file name alone. A removal is one `note: guard log: removed N month file(s) …` line; a failure is a `glance not written (…)` note. Neither moves the exit code.

`propagate day close [--apply] [--json]` is a dry run unless `--apply`. It proposes:
- **(a) Promotions** from Backlog to Ready. An item qualifies when it is open, in Backlog, **is under an active goal**, has a Size and a stated "Done when", is not an Epic, and has no block / question / decision / waiting / needs- label. Each board is topped up to 3 Ready.
  - **Goal gaps:** no Goal value is `no Goal`; a Goal of Parked or Idea (any case), or a G-id that no active goal carries, is `Goal is <X>, not an active goal`. The Goal is read from the item's Goal field, field name case-insensitive.
  - **Promotions fail closed, with a warning:** when no active goal was read (no GOALS.md, an unreadable one, or none with an active goal), no item is promoted and `day close` prints `WARNING: promotions skipped: …` first, also as `promotionsSkipped` in `--json`. Closed → Done and the cost gaps still run, and `--apply` writes only those. The refusal list then names only Size and Done-when gaps, since one warning covers the goal gap. A skip does not change the exit code (2026-11-13, the owner chose "skip with warning" over stopping).
  - **Order:** the Order field ascending (unordered after ordered), then the Priority field P0 to P3, then the priority label as the tie-breaker, then smaller Size, then lower number.
- **(b) Refused candidates,** each naming what is missing: Size, Done when, and the goal gap above.
- **(c) Closed items whose Status is not Done:** set to Done, with Finished set to closedAt's local date.
- **(d) Cost gaps:** a missing Finished, Tokens or Minutes on an item closed today is named, never filled.
- **(e) In progress items** to comment on, or to move back.

`--apply` writes only (a) and (c), 20 per request. It then reads each written item back by node id and prints MATCH n/n, or the mismatches with exit 1.

### The catch-up: `day close` runs itself (propagate#339)

The first SessionStart of each day starts `day close --apply` **detached**, if the last close has not run today. The hook (`hooks/session-guide.mjs` `dayCloseStep`, logic in `lib/report/day-close-auto.mjs`, node builtins only) reads `$STATE/day/last-close.json`, takes `$STATE/day/close.lock` (an atomic create; a lock whose process is dead or older than 2 hours is taken over) and spawns the run without waiting. Nothing else becomes automatic: `--apply` still writes only (a) and (c), read back by node id.
- **`last-close.json`** is written by EVERY `day close` run: `{date, mode, promoted, closedToDone, inProgress, exit, status, finishedAt, reason, caughtUpDate, partial?, failureLabel?}`. `caughtUpDate` is the date of the last clean `--apply`; a dry run or a failure never moves it, so a hand-run dry run cannot make the catch-up believe the day was closed. The run's output is `close-<date>.txt` (a dry run writes `close-<date>.dry.txt`, so it never overwrites an apply).
- **Decision:** start when `caughtUpDate` is not today. A transient failure today is retried by the next session after 10 minutes; any other failure waits for tomorrow. An unreadable record starts a run.
- **The guide line**, in every session's SessionStart block, just above the glance line: `day close <date>: N promoted, M closed → Done, K In progress to look at (close-<date>.txt)`, or `rate-limited, will retry next session`, `github unavailable (HTTP 504), will retry next session` (the actual status, or `ETIMEDOUT` / `ECONNRESET`), `partial: N of M written, the rest next session`, or `failed (exit N): <reason>`. A record it cannot read says so.
- **Off:** `PROPAGATE_DAY_CLOSE_AUTO=0` (the env var wins when set, `=1` re-enables for a session) or `dayCloseAuto: false` in `config.yml`. The guide line then says `auto catch-up is off` and why.
- **Refusals** (rate limit, any 5xx, ETIMEDOUT or ECONNRESET): `day close` waits 60 seconds and retries once. A board read that is still refused falls back to the Projects REST API (`users/{owner}/projectsV2/{n}/items`, writes by PATCH with `fields`); writes GraphQL refuses twice finish over REST (re-planned, so written items are skipped). If that fails too, the record says which. A write that stops partway records `partial` and the next run finishes the rest: it is idempotent, since written items no longer qualify.
- **Board reads are reused:** `day open` also writes `day/board-read.json`; a `day close` the same local day reads that instead of every board and calls GitHub only for the writes and their read-back (the output says so). `day close --fresh` re-reads.
- **Tests never reach a board:** the hook's child is replaceable with `PROPAGATE_DAY_CLOSE_CMD`, and under the node test runner with no replacement the hook refuses to spawn (the `runClaude` rule, gotcha G91).

"Done when" counts only when it is **stated**. The matcher strips fenced code and backtick spans, then needs a heading, a bold marker or a sentence that starts with the phrase. The workspace-hub#13 false positive is the case it excludes. Each item connection is read with `first:100` and not paged, and a truncated connection is noted in the output.

## Board reads page past 100 (propagate#214)

`day open`, `day close`, `goals check` and the dispatch snapshot share one reader (`lib/report/day.mjs`
`readBoards`). Each status group is read 100 at a time and **paged** with its own cursor and the same filter:
- **Up to 10 pages per group** (1,000 items). Past that, the group stays in `truncated` as `board N group: X of Y`.
- **The rate limit is checked before every page.** Below 100 remaining, paging stops for that group and every later
  one, a note names the stop, and their `truncated` entries stay. It is never a failure.
- Every follow-up page counts in the printed GraphQL call count.

## The plan-goal check at plan approval (G3; the mechanism #244 will extend)

`hooks/plan-goal.mjs` runs on PreToolUse for `ExitPlanMode` and is silent for every other tool.
- **Plan text:** `tool_input.plan`; otherwise the newest `*.md` modified in the last 15 minutes in the plans directory
  (`plansDirectory` in `~/.claude/settings.json`, else `~/.claude/plans`). None → allowed, "plan goal not checked: no
  plan text found".
- **Active goals:** the same discovery and `active` flag as `goals check`. None readable → allowed, "plan goal not
  checked: no active goal was read". A missing goals file never blocks a plan.
- **The rule:** the plan has a line `Goal: G<n>` (bold or plain, any case) naming an active goal → allowed, and one row
  `{ts, plan, goal}` goes to `<state dir>/plans/approvals.jsonl`. Otherwise **denied**, naming the active ids and both
  fixes, unless a `goal_reason: <why>` line is present: then it is allowed and logged with `goal: null`.
- **Fails open on its own bugs**, saying so in `additionalContext`. A missing section is not a bug: it blocks.
- **#244's own clause** (a UI plan must carry `design deps` output) is not built: it needs #243. It belongs in this hook.

### The plan grammar: Surface, Need, References checked (#297)

The same hook also requires every plan to declare what a person will read or click:

```
Goal: G<n>                 (or goal_reason: <why>)
Surface: none              (or ui | widget | command | job | skill | notification | hook)
```

- **`Surface:`** is bold or plain, any case, optionally a list item (`**Surface:** widget`, `Surface: UI`). `none`
  means the plan adds nothing a person reads. `command` covers a new command or changed output. Any other value is
  refused, naming the allowed ones.
- **When it is not `none`**, the plan needs both sections, at heading level `##` (or `###`):

  ```
  ## Need

  - Question: <what the person asks that this answers>
  - Decision: <what they decide from it>
  - Today: <what they do now, without it>
  - Retire when: <the signal that it is no longer needed>

  ## References checked

  - <library, standard or reference>: <why it did or did not fit>
  ```

  The four labels count only inside `## Need`, which ends at the next heading of its level or higher, and each needs
  real text after the colon. `## References checked` needs at least one entry of real text. **A placeholder is not
  text:** a value that is empty, only `<...>` placeholders, punctuation (`?`, `-`), or `TODO`/`TBD` is refused as
  `## Need unfilled (<labels>)` or `## References checked unfilled`, so the pasted template never passes as-is. Anything inside a fenced code
  block is ignored, so a quoted template never satisfies the gate.
- **Override:** a line `surface_reason: <why>` allows the plan whatever its Surface, and is logged as
  `surface_reason` in the `approvals.jsonl` row (which also gains `surface`, the declared value or `null`).
- **One denial** covers Goal and Surface together. It starts `this plan is missing: <Goal, Surface, ## Need (...),
  ## References checked>`, gives each fix, and carries the template above to paste.
- **Every path with plan text runs it.** When no active goal can be read, the goal is "not checked" but the Surface
  is still checked and can still deny. With no plan text at all, both are "not checked" and the plan is allowed.
- **Grace:** until `SURFACE_ENFORCE_FROM` (2026-11-30: `SURFACE_GRACE_START` 2026-11-16 plus `SURFACE_GRACE_DAYS` 14,
  constants in the hook), a plan with **no** `Surface:` line is allowed with a warning naming that date. A plan that
  declares a Surface but lacks its sections is denied from day one.
- **`Surface: none` mismatch (#301):** a `Surface: none` plan whose text names a surface marker (any case: `notify(`, `hooks/`, `widget`/`widgets` as a word, `launchd`/`.plist`/`LaunchAgents`; case-sensitive: the identifier `COMMANDS` or `lib/core/commands.mjs`, never the prose word "commands") is **warned, never denied**, naming each marker and the kind it suggests (notification, hook, widget, command, job), and logged with verdict `warn-surface-mismatch` and `missing` = the markers.
- **Denial log:** every deny and every warn appends one row `{ts, session, verdict: "deny"|"warn", missing: [...]}`
  to `<state dir>/plan-gate/YYYY-MM.jsonl` (month of `ts`, UTC). No plan text is written. A failed write is named in
  the hook's output and never turns a deny into an allow.
- **Test seam:** `PROPAGATE_PLAN_GATE_NOW` (an ISO date) replaces the clock for the grace decision and the log.
- **Off switch:** `hooks.planSurfaceGate: on|off` in `config.yml`, overridden by `PROPAGATE_PLAN_SURFACE_GATE=on|off`
  (also `true|false|yes|no|1|0`). **Unset, the gate is on only in the owner's tree** — a declared hub (`hubRoot` /
  `PROPAGATE_HUB_ROOT`, the root goal discovery walks) or an existing `<state dir>/plans/approvals.jsonl` — and off
  everywhere else, where it neither warns, denies nor logs. Off skips the Surface half only; the Goal check is
  unchanged. Resolved by `planSurfaceGate()` in `lib/core/config.mjs`; if that cannot be read the hook says
  `Surface not checked` and allows.

## The dispatch model check (propagate#265, #214 part 2)

`propagate day open` also writes `<state dir>/day/items.json`: `{ generatedAt, items: { "<owner/repo>#<n>": { model, goal, status, projectId, itemId, statusFieldId, inProgressOptionId } } }`, one entry per item it read on every board, written atomically from the read it already holds (no extra GraphQL call). A write failure is a note in the day open output, never a failed run.

`hooks/dispatch-model.mjs` runs on PreToolUse for `Agent` and `Task` and reads that file, so a dispatch costs no read:
- **The served issue (#346, #273):** a prompt may cite many issues as reading material, and only the one the dispatch serves is checked, moved, overridden or associated. A lane brief should carry a line `issue: owner/repo#N` (case-insensitive, at the start of a line); `issue: #N` is accepted when the prompt names exactly one repo to resolve it against, and otherwise is allowed with "model not checked". Without a marker the text is used only when it names exactly one issue (`owner/repo#n` and github.com issue URLs; a bare `#n` counts only when the prompt names exactly one repo). With several and no marker the dispatch is **denied**, asking for the `issue:` line. Cited issues are never moved, overridden or associated. No ref: silent, exit 0.
- **Not checked, allowed, and said so:** no snapshot, an unreadable one, or one not generated today ("model not checked: no day snapshot from today (run propagate day open)"); a ref not on a board; an item with no Model.
- **Mismatch:** the item's Model (case-insensitive) against `tool_input.model`. An omitted model is a mismatch, because the subagent would inherit the parent's. Without a `model_reason: <text>` line at the start of a prompt line the dispatch is **denied**, naming the ref, both models and both fixes. With one it is allowed and a row `{ts, ref, expected, actual, reason, subagent_type}` is appended to `<state dir>/day/overrides.jsonl`. The override row is recorded against the served issue only.
- **The one write:** on an allow, an item in Backlog or Ready is set to In progress (one `updateProjectV2ItemFieldValue` through `gh api graphql`, 5 s timeout; `PROPAGATE_GH_BIN` overrides the binary). A deny writes nothing; In progress, In review and Done are never written. A failed write is reported in `additionalContext` and the dispatch is still allowed. After a success the snapshot's status is updated so a second dispatch does not write again.
- **Fails open on its own bugs**, reporting the error in `additionalContext`. Exit code is always 0.

## The background-guard log (propagate#294)

`hooks/background-guard.mjs` (PreToolUse, Bash) appends one row per **`deny`** and per **`allow-bg`** (a backgrounded
main-session call that rule 1 would have denied in the foreground) to `<state dir>/guard/YYYY-MM.jsonl`, the UTC month
of the row's `ts`. The state dir is `$PROPAGATE_STATE_DIR`, default `~/.propagate`. A plain call writes nothing.
- **`allow-bg` is main-session only.** A subagent's foreground heavy call (exempt by rule 4) writes no row.
- **Fields, exactly:** `{ts, session, event, rule, label, program, command_hash, timeout_ms}`.
  - `session`: the payload's `session_id`, or `null`.
  - `rule`: `timeout | heavy | shell-bg | sub-bg`.
  - `label`: from the fixed HEAVY or network table, `&` or `nohup` for `shell-bg`, else `null`.
  - `program`: the basename of the first word after every `NAME=value` prefix (`/usr/local/bin/npm` is `npm`, never a
    path), kept only if it matches `^[\w.-]{1,32}$`, else `null`.
  - `command_hash`: the first 16 hex characters of the sha256 of the whitespace-normalised command.
  - `timeout_ms`: the call's `timeout`, or `null`.
- **Never command text.** No command head, no cwd, no `NAME=value` value: `SECRET=x npm test` stores `program: "npm"` and a hash.
- **Order and failure:** the deny JSON goes to stdout first. The append then runs in its own `try`, so a failed
  append (unwritable state dir, `guard` not a directory, full disk) never changes the decision. The hook still exits 0.
- **One write per row.** `guard/` is created on the first logged event; an install without it works unchanged.
- **Pruning belongs to the CLI, never the hook:** `lib/guard/log.mjs` `pruneGuard`, run by every glance write
  (`propagate glance`, the monitor, CLI `doctor`, `day open`; #295), deletes month files that ended more than 90 days ago.

## The glance (propagate#295)

One answer to *what is working, what is broken, what needs me*, as a terminal command (`propagate glance`), a file
(`<state dir>/glance.json`) and the session-start line. Code: `lib/glance/` (`signals.mjs` the definitions,
`verdict.mjs` the daily rule, `compute.mjs` the readers, `store.mjs` the file, `render.mjs` the line).

**Where it is computed, always from inputs already held.** The monitor, after its doctor snapshot, from its own
reconcile rows and doctor result; CLI `doctor` (default and `--json`), from its in-memory result; `day open`, after the
broadcast refresh; and `propagate glance` itself. None of them lets the glance run reconcile, doctor or `gh`. Without
reconcile rows the edges item is carried from the previous glance while that glance is under 6 h old, else unknown.
A glance failure is one stderr line or note; it never moves the caller's exit code. CLI `doctor` also prints its
verdict line first now.

**Signals.** `kind` decides what unknown means: a *heartbeat* is unknown when its source is missing, unreadable or
older than its threshold; an *event log*'s missing or empty file is 0 events, working, never unknown for being quiet.

| Signal | kind | Source | Failure | Stale after |
|---|---|---|---|---|
| doctor | heartbeat | the caller's doctor JSON, else `doctor-snapshot.json` | a red check; with the `human` marker it is needs-you | 26 h |
| metrics | heartbeat | `doctor.problems` in `metrics.jsonl` | today more than twice the 7-day median and at least 3 | 26 h |
| monitor | heartbeat | `monitor.log` | the last run logged `error=` | 3 x 1800 s |
| edges | heartbeat | the caller's reconcile rows, through `actionOf` (`lib/edges/states.mjs`) | `broken` (UNMATCHED, UNRESOLVABLE, NOT_PRESENT_ON_REF); judge, pick-a-side and blocked are working | 6 h (carried) |
| hooks | event log | `sessions/errors.log`, `costs/errors.log` | an error-shaped line; `skipped:` and `row written without it` traces are not | — |
| guard | event log | `guard/YYYY-MM.jsonl` | a `deny` with no `allow-bg` of the same session and `command_hash` within 10 minutes | — |
| jobs | heartbeat | the doctor result's `# Scheduled jobs` section | a warned job (no live pid and a non-zero exit, or a daily job not run in 26 h); a running job's past exit is not a failure | with doctor |
| broadcast | heartbeat | `broadcast/index.json` and the shown rows | needs-you: an open child not shown for more than 2 days | 7 days |
| work | heartbeat | the work queue (`work/queue.db`) | needs-you: an item in `parked` | — |

A signal whose source is not set up on the install (no broadcast index, no work store, no scheduled-jobs section, not
macOS) is listed in `skipped` with its reason and not counted. One reader throwing makes that signal unknown with the
reason; the rest still run.

**Verdicts.** Per UTC data day (a day with no data is absent, never 0): fewer than 3 prior days is `learning`; broken is
more than twice the median of up to 7 prior days and at least 3, or failures on each of the last 3 data days. Every item
carries `owner` (`propagate` retries it, `you` must act); a propagate-owned item still broken after 6 monitor runs is
promoted to needs-you. `since` is carried from the previous glance by id. Ids carry no numbers:
`doctor:<section>:<check_id or label slug>`, `job:<label>`, `work:<id>`, `edges:broken`, `broadcast:unattended`.

**Doctor markers.** A Reporter entry's `{human: true}` and `{check_id}` cross the text seam in-band, as one trailing
`  ⚑ human id=<check_id>` marker placed before any `⇒` action, anchored at the end; `structure.mjs` parses it back.

**The `glance.json` contract** (`schema_version: 1`):

```
{ schema_version: 1, generatedAt: "<ISO 8601 UTC>", stale_after_s: 21600,
  verdict: "working|broken|needs_you|blind", signals_checked, needs_you_ids: [...], skipped: [{signal, reason}],
  items: [{ id, signal, kind, verdict: "working|broken|needs_you", flag: null|"unknown"|"learning",
            owner: "propagate|you", subject, what, line, why, fix: {text, command|null},
            since, looked_at, source, ...signal extras (count, subjects, failures_today, carried) }] }
```

- Written atomically (`glance.json.<pid>.tmp`, then rename); last writer wins. `source` is a name, never a path.
- Additive changes only within a major. A reader meeting a newer `schema_version` refuses: `glance format newer than
  this reader`. An absent file reads as not computed, an unparsable one as unavailable; neither reads as clear.
- The age is derived by each reader from `generatedAt`, never stored; past `stale_after_s` everything is unknown (stale).

**The terminal view** (`lib/glance/render.mjs`) groups items by SOURCE: one line per signal, never one per item, so
six doctor fails cannot push three failing jobs off the screen. Within a verdict, user-impacting sources
(`SOURCE_RANK`: jobs, work, broadcast, hooks, guard, then monitor, edges, doctor history, doctor) come first. Counted
sources (doctor, jobs, work) show `N <noun> failing (<tags>)`; tags are added while they fit and the rest is `…`,
never a cut word. The per-item detail stays in the items array and `--json`; the grouping is rendering only.

**Badges** are drawn with node:util `styleText` (no dependency): fixed-width (11), bold, `NEEDS YOU` black on
yellow, `BROKEN` white on red, `UNKNOWN` black on grey, `LEARNING` black on cyan, `OK` black on green; the source
name follows, then the count, then the subjects and fix dim. Colour only when stdout is a TTY and neither `NO_COLOR`
nor `--no-color` is set (`FORCE_COLOR` turns it on for a non-TTY; `NO_COLOR` still wins). Without colour the badge is
the bracketed word padded to the same width, so the 80-character rule holds either way.

**The session line** (`hooks/session-guide.mjs`, through `readGlanceCopy`, parity-tested against `readGlance`): one line,
at most 140 characters, at most 3 SOURCES plus the age (`as of HH:MM`, or `Nh ago` past 1 h), ending
`Run: propagate glance`. It uses PLAIN bracketed badges (`[BROKEN] jobs: 3 failing`) and never an escape code: hook
output is read by Claude, not shown in a terminal. Its source order is a copy of `SOURCE_RANK`, parity-tested. Absent: `glance: not computed yet; run propagate glance`. It is the last line of the block and
last to be cut, and it prints in unplaced folders, with no checkouts cache, and on the hook's fail-open path.

### Notifications (propagate#296)

The monitor sends at most three notifications per run, each replacing the previous one of its kind (`-group`), and
each opening a view of `propagate ui` when clicked. **They fire on ADDITIONS ONLY**, decided by
`lib/glance/notifications.mjs` `decideChannel` over `<state dir>/notify-state.json`:

| Channel | Ids | Sent | Click opens |
|---|---|---|---|
| `edges` | `edge:<edge_id>` for every actionable edge (`isActionable`) | first, before doctor | one edge: `/judge?edge=<id>`; several: `/judge` |
| `backlog` | `backlog:<kind>:<path>` for each backlog defect | after edges | `/backlog` |
| `glance` | the glance's needs-you and broken items (an unknown counts as broken), minus the `edges` signal, which the edge channel already covers | after doctor and the glance write | one item: `/glance/<id>`; several: `/glance` |

- **An id has no content hash and no number.** An edge whose bytes change on every run is one id. This supersedes the
  content-triple key `(edge_id, source_content, downstream_content)`, which re-notified on every edit cycle.
- **Present on the previous run:** silent. **Left and back within 24 h:** silent. **Otherwise:** notified once.
  **Removal** never notifies.
- **The first run with no record of a channel seeds it silently**, so upgrading does not replay every open finding. A
  **corrupt** store is not an upgrade: every present id is notified once and the store is rewritten. Neither throws.
- **Acked ids** are recorded as present but their notification is owed, not sent; a snooze that runs out sends it.
- `notified.jsonl` stays as the audit log of what was sent (with `run_id`); it no longer suppresses anything. The
  Judge "new" dot still keys on the content triple (`monitor.mjs` `contentKey`), because "have I seen these bytes" is
  the right question for a row being judged.
- **Copy.** One glance item: title `<Needs you|Broken|Unknown>: <subject>: <what>`, body its fix command. Several:
  `propagate: 2 need you, 1 broken`, then one line per distinct subject and fix, at most 3, then `+N more`.
- **The digest** notification's body is the glance verdict line (the first line `propagate glance` prints), never the
  digest's timestamp heading; an absent or unreadable glance says so. Its click opens `/glance`.
- `--dry-run` sends nothing and writes no `notify-state.json`.

**How a click resolves its URL.** `notify()`'s `open` option takes `{route}` built by `uiRoute(kind, id)` from the
fixed vocabulary above, with the id percent-encoded and the result checked against a pattern that admits no quote,
space or shell character. terminal-notifier's `-execute` then runs
`PROPAGATE_STATE_DIR=<state> PROPAGATE_CLI=<plugin>/cli.mjs /bin/bash <plugin>/widget/open-ui.sh <route>`: the same
script the widget's buttons run. It reads the running server's URL and token from `<state dir>/ui-url`, starts
`propagate ui` when none is up, replaces a stale one it can verify, and opens `<url>#<route>`; the client routes on
the fragment. Item text never reaches the command. Without terminal-notifier the osascript fallback has no click.

### The web glance view (propagate#296)

`propagate ui` → **GLANCE** (the TODAY group). `GET /api/glance` returns `glance.json` with each problem item's `ack`
re-derived from `glance-acks.json` at read time; an absent or unreadable file is a named state, never an empty list.
`POST /api/glance/ack` takes `{action: "ack"|"unack", ids: [...], until: null|"24h"|"7d"|<ISO>}`, validated whole
before anything is written. Both sit behind the same token, Host and Origin guard as every `/api` route.

- **List:** one row per item, needs-you first; filters by verdict and by source (`#/glance?verdict=broken&source=jobs`,
  so a reload keeps them); columns verdict badge, item, source, since, next (with a copy button).
- **Row menu:** right-click, the ContextMenu key or Shift+F10: open detail, copy fix, acknowledge, snooze 24 h or 7 days,
  remove ack.
- **Selection:** a checkbox per problem row and select-all; the bulk bar acknowledges, snoozes or unacks every
  selected id in one request.
- **Detail pane, a route per item:** `#/glance/<id>` shows why, the fix, the source, since, how much was looked at, the
  ack and the id.
- **Badges** are `.badge.gl-<kind>` and always show an icon, a word and a count (`! NEEDS YOU 1`), so state is never
  colour alone; fills are the semantic status tokens. A status strip above the filters is drawn with Observable Plot
  when it loaded, and says so when it did not.

## Subagents (propagate#251)

propagate ships subagents in `agents/`, registered as `propagate:<name>`. **An agent proposes; the parent acts only on what a deterministic check accepts.** Rupali, 2026-11-12: *"if we are replacing a functionality, it better have a deterministic check at the end"*. Mechanical work stays in code: an agent exists only for a judgment, and that judgment is gated.

| Agent | Proposes | The check |
|---|---|---|
| `edge-settler` | a disposition, reason and SHA evidence for every edge on one file | `settle <file> --check <proposals.json>`: the id set equals the worklist; each disposition is in `allowed` (none that needs `--out-of-order`); each SHA is real, touched one side, and **postdates the last verify**; then a `verify` dry run |
| `doc-curator` | whether a doc's CONTENT still holds: `stale` or `current` claims, each with the doc's statement and a quoted evidence line | `propagate check-curator <proposals.json>`: both files exist; the statement is in the doc; the quote is byte-exact at `file:line` (within 5 lines). A **structural** claim (orphan, unlinked, broken link) is refused with the curate-docs command that derives it. A passing claim is INFERRED: shown, never applied. An empty list exits 1 |
| `adversarial-reviewer` | findings on one artifact and on every edge declared for it, each with a read-only demonstration | `propagate check-review <artifact> <report.json>`: `edges_reviewed` equals the declared edges, derived by propagate's reconcile, never by the report; each finding is at a real `file:line`. Each `demo_cmd` passes the agent guard's `decide()`, then re-runs (30 s) and must match `expect`. Outcomes: verified, unverified (listed, not counted) or refuted (fails). An artifact with 0 declared edges fails as vacuous coverage unless `--allow-undeclared` |

**Delegation is offered by a hook, not remembered.** Rupali: *"the session takes care of itself, it asks the agent to be run on a hook"*. `hooks/agent-nudge.mjs` (PostToolUse, Bash) adds one line of context after a main-session `settle <file> --json` lists 3 or more edges that are not all NEVER_VERIFIED. The line names `propagate:edge-settler` and the `--check` gate. It is silent inside subagents and never blocks.

**Cost per agent:** `propagate costs lanes [--since <ts>] [--agent-type <t>] [--json]` groups lane rows by `agent_type`, taking the last row per `agent_id`. It counts lanes that ran a tool with `run_in_background` as BACKGROUNDED: such a lane ended rather than waited. The `backgrounded` field comes from the lane transcript, by `subagent-cost.mjs`. A row from before #251 has no such field and reads as unknown, never as 0.

**Read-only is enforced, not declared.** Plugin agents cannot carry `hooks` or `permissionMode` (Claude Code docs). `hooks/agent-guard.mjs` (PreToolUse on Bash, Write, Edit, NotebookEdit) reads the payload's `agent_type` and, for a name in its `READ_ONLY` list, allows only recognised read commands: an allowlist that fails closed. The main session and every other agent pass through untouched. `tests/unit/agents.test.mjs` fails when an agent with no write tool is missing from `READ_ONLY`.

## Cross-repo edges (propagate#117)

There is **one format**: an ordinary `.propagates.yml`. A downstream (or a source key) may be a path that
leaves the repo, and `reconcile`, `status` and `check --changed` treat it like any other edge; the row
carries `sameRepo: false`. Nothing needs an allowlist to fire.

**Client isolation is a doctor check, not a load-time gate.** `doctor` reads the `reconcile()` rows it already
computed and fails on any cross-repo edge that joins two **different client workspaces** with no shared platform
root at either end (`crossClientViolations`, `lib/edges/cross-repo.mjs`). Owner of a path is the discovered
workspace that is a direct child of `hubRoot` and contains it (by realpath); the hub itself and tooling have no
owner, so hub-to-client and a client to its own nested repo always pass. The platform roots are `partner_roots`
in `cross-allow.yml` (existing roots only, realpath'd), minus any root that contains the hub. A scan over fewer
than 10 workspaces, or one that finds no cross-repo rows, is reported `inconclusive` (and fails doctor), never
as a pass. With no `hubRoot` configured there is no client boundary, and doctor says so as an info line.

**`.propagates-cross.yml` is retired.** Its `platform_contracts` and `shared_conventions` entries never fired:
no command read them for drift. The file is still parsed (`propagates-cross.schema.json`) only so `doctor` can
fail on every entry left in one: "declared in a format nothing fires; move it to `.propagates.yml`". Move an
entry into the sidecar of the repo holding its source and delete the file in the same commit. The
`status --cross` ledger (decision relay) is unaffected.

**Upgrade note:** `.propagates-cross.yml` entries now fail `doctor`; move them to `.propagates.yml`.

## The inbound view — delivery for cross-repo drift (2026-08 plan Part 2)

An edge crossing a repo boundary records its drift wherever it fired — in the
event store, keyed by the edge, not by "who should hear about this." Working
in the downstream repo, nothing told you an upstream file had changed
underneath you; the two directions of a bidirectional cross-repo coupling
even split across two separate ledgers, so neither side ever held the whole
picture (measured: `Keerti`'s ledger held 0 rows for `content.ts` while
`Keerti-portfolio`'s held 7 — same coupling, invisible from either repo
alone).

The inbound view answers one question: *"has anything upstream drifted into
what I'm about to touch?"* It is a pure filter over `reconcile()`'s own rows
(`lib/edges/reconcile.mjs`'s `inboundRows` — no new computation, no second event
store, no write into any repo):

```
inbound(repoRoot) = rows where downstream.path is under repoRoot
                      AND source.path is NOT under repoRoot
```

Three surfaces read that same filter:

- **`propagate reconcile --inbound`** — on demand, scoped to the repo
  containing cwd. Composes with `--json` and `--group-by`.
- **`propagate check`** — prints inbound `DRIFTED`/`DIVERGED` edges as an
  **advisory** warning alongside its existing coupling output. It never
  changes `check`'s exit code, `--json`'s `inbound` field included — the
  merge gate stays flagged off on purpose (a gate people learn to bypass is
  worse than none).
- **The daily digest** — an `INBOUND (n)` section, rendered only when a
  cross-repo edge has actually drifted or diverged; silent otherwise (a
  section that always prints becomes furniture nobody reads, same failure
  the digest's whole diff-first design exists to avoid).

**What this does not do — pull-based, not push-based.** Nothing here writes
a marker file, opens an issue, or notifies another repo. If you never work in
the downstream repo, and never read the digest, this drift never reaches
you — that is an accepted limit of a single-operator tool, not an oversight
to patch later. The existing cross-repo layer (`flow: decision`,
`CROSS_LEDGER_JSONL`) is a decision relay and solves a different problem;
it is untouched by this view and the two should not be conflated.

## `propagate ui`: the access token

`propagate ui` binds `127.0.0.1` only. Access needs a token, and the token is **stable**:

- **Where.** `<state dir>/ui-token` (`~/.propagate/ui-token` by default): 64 lowercase hex characters,
  mode `0600`, created on first start and reused by every later one. A file left wider than `0600` is
  tightened and the startup line says so. A file that is not exactly 64 hex characters **refuses to start**,
  names the file, and is never regenerated silently.
- **Browser.** The first visit to `/?token=<token>` answers `302 /` and sets an `HttpOnly; SameSite=Strict`
  `ptok` cookie (one year), so the address bar and history carry no secret afterwards. The clean URL is
  bookmarkable and survives restarts. Every response carries `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Rotation.** `propagate ui --rotate-token` writes a fresh token (same atomic `0600` write) and exits
  without starting a server. The next widget click sees that the running server still holds the old
  token (`ui-url` and `ui-token` differ), replaces it, and sets the new cookie; open tabs and bookmarks
  work again once that page has been opened.
- **Why stable.** What stops other websites is the loopback Host check, the same-Origin check (run before
  the token or cookie, so a valid cookie on a cross-origin request is still 403) and `SameSite=Strict`.
  Anything running as you can read `~/.propagate` anyway, so a per-start token bought nothing against it and
  killed every bookmark at every restart.
- `widget/open-ui.sh` writes `ui-url`, `ui-pid` and `ui.log` at `0600` (the log holds the token URL).

## `propagate ui`: the machinery and page endpoints (2026-10-16/17)

Source of truth: the `/api/` branch of `cli/ui.mjs` and `lib/report/machinery.mjs`, not this list. Every one is
`GET`, read-only and behind the token and Origin checks above, **except `POST /api/trackers/refresh`** (last row). **They never run a write or a verdict**; a page that offers a
command copies it.

| endpoint | answers | notes |
|---|---|---|
| `/api/machinery` | one block per source: claims, rules, caps, skills, backlog, goals | each block is `{status, reason, count, of, label, top}`. A source that throws, or ran and looked at nothing, is `status:"error"` with its reason **inside a 200 body**, so one bad source never blanks the other five; a failed source is never `count: 0`. `ok`, `generatedAt` and `ttlMs` ride beside the blocks |
| `/api/claims` | the claims check's findings, with `kinds` and a coverage `summary` | |
| `/api/rules` | each hub rule with its coverage (adopted, firing, restated, unexercised) and where it is restated | **replaced the old raw endpoint**, which returned the hub rules check unprocessed (whole file bodies in `lines`, no coverage status) and had no caller. Anything that read the old shape must read this one |
| `/api/caps` | instruction-budget caps, worst first (over, yellow, exempt) | |
| `/api/skills` | skill usage, never-invoked then dormant first | "dormant" is a used skill whose last use is over `DORMANT_DAYS` ago; the response carries the constant |
| `/api/backlog` | the ranked backlog items (priority and kind) and handover summaries | the floor caveat is `priorityCaveat` in `lib/report/backlog.mjs`, shared with `backlog --brief`. GitHub rows (`kind: "github"`) carry `url`, `repo`, `labels` and `stale`; only an `https:` URL is passed through. `summary.github` names the trackers' state and `asOfText`, read from the cache |
| `/api/goals` | goals and plans, two tables from one response | a plans failure is carried **inside** the response and does not fail the goals; plans are read from this repo only |
| `/api/history` | the last **recorded** doctor, monitor and release results | page-only: it has no tile and is not in `/api/machinery`. It reads what each left on disk and **runs none of them**: doctor from its snapshot, monitor from `monitor.log` (the last 20 runs), release from `release-checks.jsonl` in the state dir (the per-gate result `release --check` records, see `docs/RELEASE.md`) plus the command ledger. A run with a record shows its overall result, version and every gate (status, detail); a ledger run with no record stays listed as "exit status only" with the reason it has no gate result; a corrupt line in the file is a visible row with its line number. Each part settles on its own: an unreadable part is an error state with its reason |
| `POST /api/trackers/refresh` | re-reads the GitHub trackers behind the Backlog page and returns `{ok, fetched, failed, skipped, unsupported, deadlineHit, wrote, error}` | **The one POST here.** It spends the GitHub REST budget and writes `<state dir>/tracker-cache.json`, so it is behind the same loopback Host, same-Origin and token checks as every route, and a `GET` is a 404. Async and bounded (20 s total, per-call timeout); concurrent clicks share one refresh. An unreadable tracker is a `200` with `ok:false` and the counts, never a 500. It re-primes the machinery cache, so the page's next read is not the minute-old answer. It touches no register file |

**One cached run.** The six tile sources and `history` are computed together and reused for `MACHINERY_TTL_MS` (60 s), so a
tile and its page are one answer and cannot disagree; concurrent callers on a cold cache share one computation. **Why
60 s:** claims (~1.2 s) and skills (~1.6 s) are slow, and none of the sources changes second to second (they read the
tree's docs, not the ledger), so a minute turns a page that re-polls into one real computation, while a longer window would
show a just-fixed file as still broken. The figures are measurements from 2026-10-17; re-measure rather than trust them.
**`?fresh=1`** bypasses the cache, on `/api/machinery` and on every page endpoint above. A response in which every source
failed is not kept, so an outage is not held for a minute.

**The 502 convention.** A page endpoint whose source failed answers **502 `{ok:false, error}`** with the source's reason,
which the page shows as a banner; an empty table is reserved for a source that ran and found nothing, and it names what was
examined. An unexpected exception is a 500 with the same shape. `/api/machinery` itself stays 200 and reports the
failure per block (above), because the Overview needs the five good tiles.

**Hash parameters** (the query rides in the fragment, which the server never sees). The ones the Judge view reads:
`#/judge?edge=<id>` opens one edge; `#/judge?tick=<id>,<id>` pre-ticks edges for a bulk verdict. `tick` accepts only edge-id
characters (letters, digits, `_`, `-`; each id at most 64 long; at most 200 ids) and **rejects the whole value on one bad
piece**; ids Judge does not list are named in a note, not dropped silently. `#/unblock?focus=together` opens Unblock at the
settle-together groups. A pre-tick **ticks and sends nothing**; the verdict still goes through the guarded bulk path (reason of
12+ characters, the 5 s hold, `u` undo). Other deep links in use are `section=` (Health), `state=`, `chip=`, `ws=`, `age=`,
`source=` (Judge); parsing is `parseHash` in `cli/ui.client.js`, and a value the view does not know is ignored.

## What each verdict means

The web UI (`propagate ui`) prints this one-line meaning under every verdict button. The wording is
the owner's approved copy (2026-10-16); `tests/unit/ui-client.test.mjs` holds it word for word.

| Verdict | What it means |
|---|---|
| `propagated` | Downstream updated to match |
| `no-change-needed` | Checked: the downstream is still right |
| `source-corrected` | Source was wrong and is now fixed |
| `both-reconciled` | Both changed and now agree |
| `decoupled` | Not related: remove the link |
| `deferred` | Later: park it with a reason |
| `wontfix` | Accepted: it stays different (reason needed) |
| `baselined` | First check: accept today as the start (reason needed) |

The header reads "N links between files · M file pairs checked": the first is the declared couplings,
the second those expanded to concrete file pairs. A row that crosses the hub/workspace line says
"crosses workspaces".

## Verification is per content, not per branch (propagate#122)

`verify` pins the content of both files, and `reconcile` compares whatever is checked out against that pin. It does not
know about branches. After a checkout of a sibling branch whose files differ, edges settled on the other branch read
DRIFTED, REVERSED or DIVERGED, and they are: the content really does differ. Their states are unchanged.

`status` adds attribution only. For each edge that needs attention it compares the branch the last pinning event
recorded (`observed_on_branch` for the source, `downstream_on_branch` for the downstream) with the branch checked out
now in that file's repo, and prints one line per repo and branch pair under "needs attention". The line names the repo
whose branch moved, never the reader: run from the hub, the edges are often in another repo on another branch.

```
10 of 104 in Keerti/retail-restock-fiori were last verified on issue-57-verification-gate; that repo is now on issue-61-shared-standards. Settling them there now would pin issue-61-shared-standards's content (GOTCHAS G87).
```

The edges the line does not cover are ordinary drift. `status --json` carries the same data as an additive top-level
`branch_attribution` object: `otherBranch` (`edge_id`, `repo`, `verifiedOn`, `currentBranch`, `side`) and `unknown`, the count of
moved edges that could not be attributed (an event with no branch field, verified on a detached HEAD, or an unreadable
repo). Unknown is never read as "same branch". A detached HEAD now reads `detached`.

**Remedy:** do not settle on the sibling branch, because that pins the other branch's content and the edges drift again
on merge. Settle on the branch that merges, or after the merge. See GOTCHAS G87 for the measured cost.

## git pre-push hook

The injection this hook used to be blocked on (`docs/ISSUES.md` G1 — `range`
from hook stdin reaching a shell string via `execSync`) was fixed 2026-08-13:
`gitDiffNames` now runs `execFileSync("git", [...argv])`, so no shell is ever
spawned and a hostile `--range` value cannot execute anything. This hook is
safe to drop in as-is.

```bash
#!/usr/bin/env bash
# .git/hooks/pre-push (chmod +x)
remote="$1"
zero=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue   # branch deletion — nothing to check
  if [ "$remote_sha" = "$zero" ]; then
    range="$local_sha"                      # new branch — no remote base yet
  else
    range="$remote_sha..$local_sha"
  fi
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs check --range "$range" --strict || exit 1
done
exit 0
```

Drop this at `<repo>/.git/hooks/pre-push` (or `.githooks/pre-push` if the
repo uses `core.hooksPath`) and mark it executable. Omit `--strict` for a
non-blocking nudge instead of a hard gate.

**CI (secondary, documented not built in v1):** the same `check --range`
command runs unchanged in a GitHub Action once this skill (or just `cli.mjs`
+ `lib/`) is available in the runner — e.g. checkout this repo as a step,
then `node cli.mjs check --range "${{ github.event.before }}..${{ github.sha }}" --strict`.
No CI wiring is built here; this is a pointer for when that's worth doing.

## Install (current) — `setup`

Two commands on a fresh machine:

```bash
cd <skill-dir> && npm install
node cli.mjs setup                      # probes common layouts
node cli.mjs setup --roots ~/path/to/code   # or say where your repos live
```

`setup` writes `~/.propagate/config.yml` (override the location with
`PROPAGATE_STATE_DIR`), then **re-reads that file and runs discovery over what it
says** — verifying the artifact, not the intent. It exits non-zero unless discovery
finds at least one workspace, so an install that does not work cannot report that it
does. That is the whole point of the command: the failure it exists to prevent is
`status` printing nothing and exiting 0 on a machine where nothing is configured.

Each outcome names its own fix, because they need different ones. The set is split
across two modules — `lib/core/setup.mjs` returns all but `no-roots`, which
`cli/setup.mjs` returns when nothing was given to walk:

| `reason` | Means | Fix |
|---|---|---|
| `ok` | ≥1 workspace discovered | — |
| `no-roots` | nothing given and no common layout exists | re-run with `--roots` |
| `roots-missing` | the configured path does not exist | config error — `setup --force --roots <dir>` |
| `no-markers` | roots exist, no `.propagates.yml` beneath them | onboarding — `init <dir> --workspace` |
| `markers-rejected` | markers found, none yielded a workspace | sidecar schema / missing `workspace: true` — run `doctor` |

Re-running is safe and never clobbers an existing `config.yml`; `--force`
regenerates it. `--json` emits the same result machine-readably.

**Precedence is env > `config.yml` > built-in default.** `PROPAGATE_SEARCH_ROOTS`
in your shell still wins over the file, so `setup` cannot silently change
behaviour that already works on a machine that exports it.

### `hubRoot` — the one declared fact

`setup --hub <path>` records where your code lives. Things derive from it and are
**not** configured separately: `searchRoots` (when not declared), the skills
marketplace directory, the four execution registries — `scripts/execution/`'s
`ports.yml`, `deploy.yml`, `mongo.yml` and `instruction-budget.yml` (absent means `doctor` skips
the budget gate as info) — and the **cross-repo ledger**. Derive the
list rather than trusting this sentence: the four registries and the marketplace are
exactly the `underHub()` call sites in `lib/core/config.mjs`; `searchRoots` falls back
to `[HUB_ROOT]` directly, and the cross-ledger goes through `crossLedgerRoot()`.
Neither of those last two is an `underHub()` call site, so a grep for `underHub` is a
floor on this list and not the list.

(This sentence said all five were `underHub()` call sites until 2026-09-10, so
deriving it returned four and disagreed with its own list. It said **five** things
until 2026-09-30, when the cross-ledger joined them — N117: it had been resolving
from `SEARCH_ROOTS[0]`, which on one machine is a nested root, so it named a file
that never existed while the real ledger was owned by nobody.)

**The cross-ledger's cascade is three-way, and the middle case is load-bearing:**
`HUB_ROOT`, else `SEARCH_ROOTS[0]`, else `null`. The fallback is not laziness — an
install predating `hubRoot:` declares only `searchRoots`, and removing the fallback
reddened eight tests including the regression guard for `status --cross` reporting
`0 open` against real rows. `artifactPath()` keeps the same cascade, deliberately, so
the two hub-derived paths cannot disagree.

It exists because that path was previously restated four times, each independently
overridable and each defaulting to one author's layout — so `portsFile` had to be
fixed twice in one day as the registry moved, and the restatements nobody remembered
to update failed *silently*: they resolved to `null`, and `null` reads as "not
configured" rather than "configured wrong".

| Hub resolves from | When |
|---|---|
| `PROPAGATE_HUB_ROOT` | always wins |
| `config.yml` `hubRoot:` | declared by `setup --hub` |
| `config.yml` `searchRoots:` | **only when exactly one is declared** — an install predating this key. The diagnostic says `inferred` |
| `null` | nothing declared, or two-plus roots (ambiguous) |

**Unconfigured is a value, never a guess.** There is deliberately no built-in
default: a plausible wrong hub finds zero workspaces and then reports healthy, which
is the exact failure this tool exists to catch. Commands needing a hub exit non-zero
naming `propagate setup --hub <path>`, and `HUB_ROOT_DIAGNOSTIC` carries the reason.
Resolution never throws — a throw at config load bricks the CLI and the UI together.

**Scheduling is optional.** `setup` records the platform default (`launchd` on
macOS, `none` elsewhere). `none` is supported, not degraded — the v1 watcher is
retired and `reconcile` derives drift from content on demand; without a scheduler
you lose proactive notification and nothing else.

Distinct from two neighbouring verbs, deliberately: `init <dir>` scaffolds **one**
sidecar, `bootstrap` baselines **edges**, `setup` configures **the machine**.

### `deliveryMaxCommits` / `deliveryMaxDays` — when an undelivered plugin FAILS doctor

`doctor`'s `# Delivery` section compares the served plugin under
`~/.claude/plugins/cache/<marketplace>/propagate/<version>/` against this repo, and fails the run
once the served tree is too far behind. Two bounds decide "too far".

**Not when propagate is served in place (2026-10-17).** If `~/.claude/plugins/known_marketplaces.json`
has a `directory` marketplace whose realpath is this repo and `propagate@<it>` is installed, Claude
Code loads the working tree: there is no copy to lag, so the section passes ("served in place; edits
apply on `/reload-plugins`") and every cache tree is only a LEFTOVER warning. The bounds below then
apply to nothing; they are for a plugin installed from a marketplace that copies.

| key | env override | built-in default | meaning |
|---|---|---|---|
| `deliveryMaxCommits` | `PROPAGATE_DELIVERY_MAX_COMMITS` | `10` | commits touching **shipped** paths between the served commit and `HEAD` |
| `deliveryMaxDays` | `PROPAGATE_DELIVERY_MAX_DAYS` | `7` | age of the served commit |

Both carry a **built-in default on purpose** — per `docs/GOTCHAS.md` G24, a config key added without
one resolves to `null` and silently switches off everything derived from it while `status` stays
green. Precedence is the usual env > `config.yml` > built-in default.

**Three things about the bounds are load-bearing, and each was a decision:**

- **Only commits touching shipped paths count.** A doc-only or test-only commit must not move the
  number, because a doc-only addition is not a release (decision of 2026-08-27). The shipped set is
  `shippedPathspec()` in `lib/report/doctor/delivery.mjs` — **one definition**, which
  `.github/workflows/test.yml`'s bump-gate derives rather than restating.
- **A shipped path MISSING from the served tree fails at any distance**, below either bound. That is
  the literal shape of the 2026-09-16 incident, where two modules were absent from the served tree
  while every version string agreed.
- **The comparison reads COMMITTED content at `HEAD`, never the working tree.** An earlier failing
  version of this check was reverted because it went red on its first run over ordinary uncommitted
  edits. A dirty tree at zero shipped-path commits behind still passes.

A **leftover** cache tree — a version-keyed directory that is not the `installPath` recorded in
`installed_plugins.json` — warns rather than fails. It is stale by definition, and gating on it
turned one real problem into three failing rows.

### `PROPAGATE_ACCEPTANCE_EXPECT` — the real-tree acceptance corpus, held outside the repo

`tests/cli/claims-check-known-positives.test.mjs` runs `claims check --json` against a
**real document tree** and asserts that hand-found positives are still found. A run that
reports none of them is broken, not clean (`rule:discernment-checks` §1) — which is
precisely what a fixture-only suite cannot tell you.

**The corpus and its expectations both live outside this repo**, named by one env var
pointing at a JSON file:

```sh
PROPAGATE_ACCEPTANCE_EXPECT=/path/to/claims-known-positives.json npm test
```

```json
{
  "corpusRoot": "/abs/path/to/tree",
  "expect": [
    { "name": "label used in the failure message",
      "count": 1,
      "match": { "check": "expired-date", "file~": "NOTES.md", "reason/": "table sep" } }
  ]
}
```

A plain key means strict equality, a `~` suffix substring, a `/` suffix regex. Plain JSON
with the operator in the key, so an expectations file is data — there is nothing to
evaluate and a malformed entry is a data error rather than an injection point.

**Why the split, and it is not only privacy.** The value of that test is *"the five checks
fire on a real tree"*, which is mechanism and general. *Which* positives a given tree holds
is a fact about that tree — often someone's private working notes, their pricing, their
branch names — and generalises to nobody. Holding both in one file meant a public repo
asserting a stranger's vocabulary in order to test a property that has nothing to do with
them, and it meant the only way to drop the exposure was to drop the acceptance coverage.

**Unset ⇒ every test in that file SKIPS WITH A REASON. Set-but-broken ⇒ the suite FAILS.**
Those are different facts and collapsing them is the failure this whole tool is about: a
typo'd path that reads as "no corpus configured" is a check that cannot fail. `--check`-
style silence is not available here.

**The suite is expected to go red as the corpus is repaired.** If a flagged gap is fixed or
an expired window resolves, the acceptance lane SHOULD fail — that failure is the ledger
doing its job. Update the expectations file, never the corpus.

## Initial install (once per machine) — watcher steps are HISTORICAL, RETIRED 2026-08-14

Steps 2–4 below install/verify the v1 watcher and no longer apply — step 3 in
particular (`node watcher.mjs`) now **refuses to run** by design (see
"Canonical state" above and `docs/DECISIONS.md` 2026-08-14). Kept verbatim as
a record of what v1 install looked like; do not follow steps 2–4 for a fresh
machine setup today. Step 1 (deps) and the digest install (unaffected by this
retirement — the digest is still active) remain current.

```bash
# 1. Install deps — still current.
cd ${CLAUDE_PLUGIN_ROOT} && npm install

# 2. Load launchd plist — HISTORICAL, and no longer runnable as written. The
#    watcher was booted out and its plist deleted from ~/Library/LaunchAgents
#    on 2026-08-14. A copy is archived at
#    propagation/docs/propagate/archive/com.tathya.propagate.watcher.plist.retired-2026-08-14
#    in the private hub, so the
#    retirement is reversible — but restoring it re-arms a component retired
#    for cause (docs/DECISIONS.md 2026-08-14). The commands are deliberately
#    not reproduced in runnable form here: a copy-pasteable line is how a
#    retired daemon comes back by accident.

# 3. First-run smoke test — HISTORICAL, and now actively blocked: this
#    exits non-zero and refuses unless PROPAGATE_ALLOW_RETIRED_WATCHER=1 is
#    set (never for routine use — see watcher.mjs's header).
node ${CLAUDE_PLUGIN_ROOT}/watcher.mjs
# Should print nothing to stdout but write a "run complete" line to
# ${CLAUDE_PLUGIN_ROOT}/watcher.log

# 4. Verify by touching a watched file — HISTORICAL; nothing listens for
#    this anymore. Use `node cli.mjs reconcile` to check drift on demand
#    instead.
touch "$HOME/Documents/GitHub/Vipin Kaushik/docs/the constitution doc"
# Within ~10s, a notification should appear and a new row added to
# Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl
```

The digest agent installs independently, against
`com.tathya.propagate.digest.plist` — **still current**, the digest is not
retired, only the watcher is. (The "installs the same way" framing this line
used to carry was already slightly loose before this change: `reload`/
`lib/core/plist.mjs` never generated the digest's plist even when the watcher was
live — it is, and always was, installed by a separate mechanism.)

## Disable temporarily — watcher: superseded by full retirement; digest: still applies

For the watcher this is moot — it was retired outright rather than disabled,
and the unload was completed 2026-08-14 (`launchctl bootout`, plist removed,
archived under `docs/archive/`). Only the digest remains disableable:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tathya.propagate.digest.plist
```

Re-enable with the matching `bootstrap`. Note the digest is now the **only**
scheduled component and the sole proactive channel — disabling it leaves
`reconcile` and `check` as the only ways drift ever reaches you, both of which
require someone to ask. Ledger, sidecars and the event store persist
regardless.

## Architecture summary (for future-you)

v1 (historical, RETIRED 2026-08-14 — see `docs/DECISIONS.md`):

- Watcher invoked per file event by launchd `WatchPaths` (no daemon process).
- `proper-lockfile` serializes concurrent invocations.
- 3s mtime re-verify guards against atomic-replace partial reads.
- Heartbeat file is the fallback if macOS notification permission is denied.

v2 (current):

- `reconcile` (`lib/edges/reconcile.mjs`) derives drift from content — git blob ids
  on both sides of an edge plus the v2 event store (`lib/edges/events.mjs`) — on
  demand, not from a remembered baseline. No daemon, no background process.
- State + sidecars + ledger all atomic-write via temp+rename (unchanged from
  v1; still true for the v1 rows `status`/`drain` still read).
- JSONL is authoritative for the ledger; MD is regenerated on every change
  (unchanged).

If something breaks with a v1 row or historical data, check
`${CLAUDE_PLUGIN_ROOT}/watcher.log` first (its production content stops
growing once the watcher plist is actually unloaded, per the separate,
later operational step). For everything else, `node cli.mjs doctor`'s "v2
replacement" section is the first place to look.

## attention: jump to the Ghostty tab that needs you (propagate#445)

When several Claude Code sessions run in Ghostty tabs, a session that needs input only rings the bell. `attention` queues those sessions and takes you to the one that has waited longest. It pulls, never pushes: nothing switches tabs while you type.

| Command | What |
|---|---|
| `attention next` | focus the Ghostty tab of the oldest waiting session whose tab still exists, and mark it handled. Exit 0 focused, 1 nothing waiting, 2 could not run (osascript or Ghostty absent, Automation denied; the reason is printed). |
| `attention list [--json]` | the waiting sessions, oldest first: age, session, folder, message. Read-only. |
| `attention clear [--apply]` | mark every waiting session handled. A dry run without `--apply`. |

A session whose tab is gone is skipped, printed as `skipped <session> (tab closed)`, and recorded handled with reason `stale`.

**How it works.** The `Notification` hook `scripts/attention-queue/hook.mjs` appends `{ts, session_id, tty, cwd, message, notification_type}` to `$PROPAGATE_STATE_DIR/attention/queue.jsonl` (append-only; a handled session gets a `handled` line, nothing is rewritten). It finds the tty by walking parent pids with `ps -o ppid=,tty=`. A session already waiting is not queued twice. It is silent in a subagent and on any error. `next` lists Ghostty's terminals through AppleScript (`id` and `tty` of every terminal) and runs `focus` on the match. Tests stub the binary with `PROPAGATE_OSASCRIPT_BIN`; the hook's `ps` is `PROPAGATE_PS_BIN`.

**Bind a global hotkey** to `node <plugin root>/cli.mjs attention next`. A Ghostty keybind cannot run a script, so use one of:

- Raycast: a script command whose body is that command.
- macOS Shortcuts: a "Run Shell Script" action, then give the shortcut a keyboard shortcut.
- skhd: `cmd + alt - n : node <plugin root>/cli.mjs attention next`.

**One-time permission.** The first `next` makes macOS ask whether the calling app (Terminal, Raycast, skhd) may control Ghostty. Allow it (System Settings, Privacy and Security, Automation). If it was denied, `next` exits 2 and prints the denial; re-enable it there.

A tab you focus by hand stays queued until `next` passes it or `clear` runs. Needs `/reload-plugins` after the hook is added.

<!-- propagate:docs-reference:body:start -->

## Doc kind guidelines (generated)

Generated by `propagate docs --reference` from `KINDS` in `lib/report/doc-kind.mjs` — the single source (plan `i-saw-it-what-starry-sparkle.md` §5). **Do not hand-edit this section** — run `propagate docs --reference` to regenerate, or `propagate docs --reference --check` to verify this section still matches the tree without writing anything.

### The kinds

| kind | what | create | maintain | link | never |
|---|---|---|---|---|---|
| `decision-log` | append-only; never edit a past entry, supersede it | when a choice is made that will need to be justified later and could plausibly be revisited | append-only — editing a past entry destroys the record of what was believed at the time; supersede instead | the entry it supersedes, if any, by anchor | rewrite or delete a past entry to make the log read as though the earlier choice was never made |
| `state` | what is true now; rots fastest, so name commands not counts | when a project needs one place that answers "what is true now" without reading code or history | age — a stale STATE.md reads as current, so silence itself is the defect it must never have | the DECISIONS.md entry that explains why the current state is what it is | restate a count that a command can derive — name the command instead |
| `plan` | a change over time; STALE BY DESIGN once it lands or is superseded | when a change is scoped enough to execute against and needs a written spec before touching code | declared-state — going quiet is correct once the change lands; its defect is having no declared disposition, not age | the STATE.md entry recording whether it landed, and the code it changed | keep serving as the source of truth for a change that has already shipped |
| `page-spec` | governs one rendered surface; must never go stale silently | when a rendered surface exists that someone else must build or extend consistently | age — the surface still exists, so a surface change with no doc change is drift, not a natural lifecycle | the surface it governs and the design doc that specialises its system | describe a surface that no longer renders, or drift silently from one that still does |
| `functionality-spec` | governs a service, endpoint or schema; must never go stale | when a service, endpoint or schema exists that another team or service must integrate against correctly | age — the service still runs, so an undocumented behaviour change is an outage risk, not a lifecycle event | the code it governs and the client or SDK that consumes it | describe an endpoint or schema shape the running service no longer implements |
| `design` | design/IA intent; follows its surface | when a rendered surface exists that someone else must extend consistently | reference-integrity — it names components, tokens and files that must exist; a name that resolves to nothing is a decided design the build never received (age is only the fallback when a doc asserts no names) | the surface it governs; the canonical playbook it specialises | restate the playbook's token or component vocabulary — specialise, or diverge with a reason |
| `ops` | environment and deploy; stale when the deploy changes | when an environment or deploy path exists that someone other than its author must operate | age — a deploy changes silently underneath it, so age is the only signal that it may no longer match reality | the registry or config it describes (ports, secrets, deploy targets) | hardcode a value a registry already owns — point at the registry instead |
| `router` | routes to other docs and must not restate them | when a directory or topic has enough documents that a newcomer needs one place to start | completeness — its job is coverage, not freshness — a router is stale when it misses a doc, not when it ages | every doc in its scope, and nothing else | restate the content of a doc it routes to |
| `gotchas` | hazards and their triggers; can be current and still INERT if a trigger cannot fire | when something costs more than ten minutes for a reason that was not obvious | none — hazards do not expire with age; its defect is an inert trigger, checked by lib/gotchas/parse.mjs, not by mtime | the code or command whose trigger it declares, and the incident that paid for it | describe a hazard with no trigger and no cost — that is advice, not a gotcha |
| `issues` | a register of numbered entries with statuses; rots by reporting closed work as open | when a defect needs a numbered, re-triageable status rather than a narrative update | none — an old open issue is still open; age says nothing, only re-triage by a person can | the STATE.md or code that the issue's resolution will change | let an entry's status go stale after the underlying work is actually done |
| `standard` | a rule or practice other docs and code are held to; declares its authority and how it is checked | when a practice must be applied the same way in more than one project and someone must be able to say what backs it | reference-integrity — a standard rots when the tool, version or source it cites moves; age alone says nothing | the authority it rests on, and the projects or checks that apply it | state a practice with no authority and no way to check it |

### Tier precedence — a trap worth naming

`kindOf()` resolves a kind in tiers, and **frontmatter always wins** over both:

1. **frontmatter** `kind:` declared in the doc itself — always wins; inference is a
   default for docs nobody has classified, never an override of someone who did.
2. **filename** (tier 1) — `DECISIONS.md`; `STATE.md`/`TODOS.md`/`TODO.md`/`CHANGELOG.md`;
   `GOTCHAS.md`; `ISSUES.md`; a dated file under `plans/`; `README.md`.
3. **directory** (tier 2) — `/content/`; `/design/` (or `/design-process/`, `/ia/`);
   `/sdk/` or `/specs/`; a runbook/deploy/env/infra name.

**Filename beats directory** — the trap. Putting a doc inside `docs/design/` does not
make it a `design` doc if its own filename already resolves to something else:

```
docs/design/README.md    ->  router   (filename tier)
docs/design/TODOS.md     ->  state    (filename tier)
docs/design/OVERVIEW.md  ->  design   (directory tier)
```

The rows above are computed by calling `kindOf()` at generation time, not typed by
hand — `docs/design/README.md` resolves `router` and `docs/design/TODOS.md` resolves
`state`, **not** `design`, which is the opposite of what "put it in `docs/design/`"
implies.


<!-- propagate:docs-reference:inputs v1
alg: sha256-12
body: 4a87c8f24267
generator: propagate docs --reference v0.19.0
walk: n/a — single-source render, no tree walk
inputs:
  lib/report/doc-kind.mjs :: 1ab6002bb761
-->
