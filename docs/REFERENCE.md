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
| `doctor [--full] [--json] [--since <span\|date>]` | **Default view is folded (#107):** failures (`✗`), inconclusive (`?`) and unknown-kind (`?!`) lines are always printed verbatim; repeated `!` warnings with one label in a section become one `! <label> ×N  <first detail> (+N-1 more: doctor --full)` line; `✓`/`·` lines become one `· N ok · N info` count per section; the first line states `showing folded view: N lines of M`. The fold is applied to the rendered lines (the same capture `--json` uses), so it cannot omit a section, and the exit code is identical to `--full`. **`--full`** prints every line (the pre-#107 output); `--json` is unchanged. Lines doctor writes to stderr are not folded and may appear out of place. Not done: a severity threshold (warnings at or above a level shown individually), because the rendered lines do not carry the module's severity. Health check: launchd plist loaded (`launchctl list \| grep <label>`), heartbeat age (warn >1h during active periods, fail >1 day), all `.propagates.yml` sidecars pass schema validation, sidecar downstream paths resolve on disk (warn-only), `state.json` parseable with `.bak` present. **No longer asserts that an in-tree ledger parses** — retired 2026-09-24 (PR-009): it passed unconditionally for a file `ensureLedgerPair` creates empty and nothing appends to, so it reported success for having read nothing. The row count is now an `info`, and a genuine read failure is still a check. **`# Unrecorded work`** (#131, `lib/report/doctor/unrecorded.mjs`): per repo in the discovery census (`ownerCandidates`) plus repos nested under it, record files (STATE, DECISIONS, GOTCHAS, HANDOVERS, TODOS, TODO, ISSUES, `.propagates.yml`, `.sidecar.yml`, ledgers, markdown under `plans/` or `rules/`, matched by name or pattern) that are modified, staged or untracked with an mtime at least `PROPAGATE_UNRECORDED_DAYS` days old (default 7); files edited on today's local day are always excluded. Also local branches with commits on no remote: ahead of their upstream, upstream gone, or no upstream (printed as such, never as zero); a no-upstream branch whose commits are all on some remote is counted in the summary, not listed. Worktrees of one repo list shared branches once. Output names repo, branch, file and age. **Warn-only: it never votes on the exit code**, because uncommitted work is the normal state of a working day and #129 recorded an always-red doctor going unread; the issue's "makes doctor fail" is deliberately not followed. Zero repos scanned prints `scan is blind`, never a clean line. |
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
| `usage [--origin <interactive\|widget\|monitor\|hook\|backfill\|all>] [--backfill [--apply]] [--json]` | **Which commands are run, and how often they fail** (2026-10-15, D13). Plain `usage` aggregates the runs store through `lib/report/usage.mjs`; default view is `origin=interactive`, and records written before the field existed count as interactive and are reported as `legacyOrigin`. Every `cli.mjs` run appends ONE line `{ts, command, outcome, duration_ms, origin, kind:"command"}` to `$PROPAGATE_STATE_DIR/runs/<YYYY-MM>.jsonl` from a synchronous `process.on('exit')` hook (the CLI calls `process.exit` in ~80 places, so only that sees every exit). `outcome`: exit 0 `ok`, exit 3 `refused`, anything else including an uncaught exception `error`. **Never argv** (a verify note is a justification); the command is resolved against the registry and an unresolvable one is `unknown`, a help request is `help`. `origin` comes from `PROPAGATE_ORIGIN` (`widget` in `widget/collect.sh`, `monitor` in the monitor plist, `hook` in `.githooks/pre-commit`; unset = `interactive`; any other value is `interactive`). **Skipped when `NODE_TEST_CONTEXT` is set**, and a write failure is swallowed so it can never change an exit code. `--backfill` derives history once from Claude transcripts: it counts Bash tool calls that ran `cli.mjs <registry command>` (deduped per tool call, keyed by `tool_use` id so a re-run adds nothing) and stores COUNTS ONLY with `origin: "backfill"` and `outcome: null`, never command text. **Dry run unless `--apply`** (`tests/cli/usage-recorder.test.mjs`). A backfill count is not an `ok`: it is reported as `unrecorded` and excluded from failure rates. |
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
| `docs --reference` | Regenerate the generated **"Doc kind guidelines"** section of THIS file (`docs/REFERENCE.md` itself) from `KINDS` — the ten kinds' guidelines plus a tier-precedence example verified live via `kindOf()`, not hand-typed. Reuses `lib/report/rollup.mjs`'s `bodyHash`/`parseFooter`/`compareInputs` under its own marks (`lib/report/doc-reference.mjs`) rather than a second hash-footer implementation (G20). |
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

`propagate goals check-done [--apply] [--timeout <s>] [--json]` reads every GOALS.md under the search roots.
- **A trusted command runs** with `bash -c`, cwd = the GOALS.md's git root, a 120 s timeout (`--timeout <s>` for a long suite). On a timeout the whole process
  group is killed, so a suite's children never outlive it. Exit 0 is **met**;
  anything else is **unmet**, with the exit code and the last output lines. A timeout is unmet and says so.
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

## `propagate day`: day open and day close (propagate#240)

`propagate day open [--json]` is read-only.
- **Budget:** today's daily cap minus today's use, from the usage widget (`PROPAGATE_USAGE_WIDGET_DIR`, else `integrations.usageWidgetDir` in `~/.propagate/config.yml`).
- **Supply:** the Ready items across every open board whose Status uses Backlog / Ready / In progress / Done. A board with other options is named and skipped.
- **Costing:** a calibrated Size is costed per Size. Everything else uses a **count basis** derived each run: the week-% consumed over 7 days, divided by the items with a Finished date in those 7 days. The output labels it, because it costs every item the same whatever its Size.
- **Also listed:** In progress carry-over, and Ready items with no Size.
- **Per active goal (propagate#240):** one block per active goal in the GOALS.md files (the same files and the same `active` flag as `goals check`), built from the boards already read, with no extra GraphQL call. It shows the goal id and title, the appetite and days left (`no appetite recorded` when none), and the counts of In progress, Ready, Backlog and Done items whose Goal is that id. A group the reader could not fully page (see paging below) prints as `≥N`, never as a total. Then **Ready by Order**: each Ready item with Order (`–` when unset), Priority, Model, Size, ref and title, in the promotion order below. Then one line naming the Ready items not under an active goal. The same data is in the `--json` result (`goalBlocks`, `readyNotUnderActiveGoal`). The budget, supply and verdict lines are unchanged.
- **Verdict:** `short by ~N points` (with the top promotable Backlog items), `enough` (budget ≤ supply ≤ 2× budget), or `over` (with what will not fit).
- **Exit:** 0 enough; 1 short or over; 2 cannot judge (no good sample, no count basis, the rate limit too low, or the read went blind).

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
- **Fails open on its own bugs**, saying so in `additionalContext`.
- **#244's own clause** (a UI plan must carry `design deps` output) is not built: it needs #243. It belongs in this hook.

## The dispatch model check (propagate#265, #214 part 2)

`propagate day open` also writes `<state dir>/day/items.json`: `{ generatedAt, items: { "<owner/repo>#<n>": { model, goal, status, projectId, itemId, statusFieldId, inProgressOptionId } } }`, one entry per item it read on every board, written atomically from the read it already holds (no extra GraphQL call). A write failure is a note in the day open output, never a failed run.

`hooks/dispatch-model.mjs` runs on PreToolUse for `Agent` and `Task` and reads that file, so a dispatch costs no read:
- **Refs:** `owner/repo#n` and github.com issue URLs in the prompt. A bare `#n` counts only when the prompt names exactly one repo. No ref: silent, exit 0.
- **Not checked, allowed, and said so:** no snapshot, an unreadable one, or one not generated today ("model not checked: no day snapshot from today (run propagate day open)"); a ref not on a board; an item with no Model.
- **Mismatch:** the item's Model (case-insensitive) against `tool_input.model`. An omitted model is a mismatch, because the subagent would inherit the parent's. Without a `model_reason: <text>` line at the start of a prompt line the dispatch is **denied**, naming the ref, both models and both fixes. With one it is allowed and a row `{ts, ref, expected, actual, reason, subagent_type}` is appended to `<state dir>/day/overrides.jsonl`. With several refs, any unreasoned mismatch denies the whole dispatch.
- **The one write:** on an allow, an item in Backlog or Ready is set to In progress (one `updateProjectV2ItemFieldValue` through `gh api graphql`, 5 s timeout; `PROPAGATE_GH_BIN` overrides the binary). A deny writes nothing; In progress, In review and Done are never written. A failed write is reported in `additionalContext` and the dispatch is still allowed. After a success the snapshot's status is updated so a second dispatch does not write again.
- **Fails open on its own bugs**, reporting the error in `additionalContext`. Exit code is always 0.

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

<!-- propagate:docs-reference:body:start -->

## Doc kind guidelines (generated)

Generated by `propagate docs --reference` from `KINDS` in `lib/report/doc-kind.mjs` — the single source (plan `i-saw-it-what-starry-sparkle.md` §5). **Do not hand-edit this section** — run `propagate docs --reference` to regenerate, or `propagate docs --reference --check` to verify this section still matches the tree without writing anything.

### The ten kinds

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
body: 7aec7f344ac8
generator: propagate docs --reference v0.19.0
walk: n/a — single-source render, no tree walk
inputs:
  lib/report/doc-kind.mjs :: 8ca30ad52f91
-->
