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
  `docs/archive/com.tathya.propagate.watcher.plist.retired-2026-08-14` and is
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

**`GOTCHAS.md` resolves from BOTH layouts, deliberately.** `lib/gotchas/parse.mjs`'s
`sourcesFor()` looks in `<repo>/docs/GOTCHAS.md` *and*
`<workspace>/propagation/state/<project>/GOTCHAS.md`, nearest first. The migration is
partial by design — measured 2026-08-23, **2 of 9 files could move**; four are blocked on
their workspace gaining a `propagation/state/`, and three are standalone repos with no
workspace, which are exempt. A resolver that understood only the new layout would stop
delivering the other seven, and the failure would be silent.

**Never leave a stub at the old path.** `parseEntries()` reads any `GOTCHAS.md` it finds,
so a pointer stub parses as a real hazard file carrying zero triggered entries — present,
adopted, and inert. Record the move in `.sidecar.yml`'s `owns` / `pre_move` instead.

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
ls commands/*.mjs                    # command bodies extracted out of it
```

Command *implementations* now live in `commands/`; the dispatch that routes to
them stays in `cli.mjs`.

| Command | What it does |
|---|---|
| `status` | List open drift rows, scoped to the workspace at cwd by default. `--all` for every workspace, `--cross` for the cross-repo ledger, `--json` for machine-readable output. |
| `doctor` | Health check: launchd plist loaded (`launchctl list \| grep <label>`), heartbeat age (warn >1h during active periods, fail >1 day), all `.propagates.yml` sidecars pass schema validation, sidecar downstream paths resolve on disk (warn-only), `state.json` parseable with `.bak` present, ledger JSONL parseable. |
| `init <dir> [--workspace\|--edges-only]` | Scaffold `.propagates.yml`. `--workspace` (default) writes `workspace: true` and verifies the directory becomes discoverable, exiting non-zero if not (N15). **No longer touches the plist** — that moved to `reload` (N14). |
| `reload` | **Obsolete as of 2026-08-14** — its only purpose was regenerating the (now retired) watcher's plist and reloading it into launchd; `lib/core/plist.mjs` has never generated any other plist (grep confirms it — the digest plist is installed by a separate mechanism it never touches, see "Canonical state" above). Not removed from `cli.mjs` by this change (out of scope — no live launchd command was run to verify/enact this), but there is no remaining reason to run it. |
| `check` | Commit-time drift gate. Flags below. |
| `check --changed` | Default when no range/staged flag given: working tree + staged vs HEAD, unioned. |
| `check --range <a>..<b>` | Explicit git range (for CI or a hook). |
| `check --staged` | Staged files only (pre-commit use). |
| `check --strict` | Exit 1 (not 0) if any coupling is found — combine with any of the above. |
| `check --json` | Machine-readable output: `{generatedAt, repoRoot, changedFiles, strict, exitCode, couplings}` — combine with any of the above. |
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

`check`'s coupling lookup, for each changed file:
- **forward** — is it a declared `.propagates.yml` source? → list its
  downstreams to re-verify.
- **reverse** — is it a `kind: code` downstream? → list the upstream doc(s)
  to re-verify (the case that let #43 slip).
- **ledger cross-ref** — does it already have an open drift row in its
  workspace's ledger?

Output is grouped and human-readable:

```
⚠ 1 coupled file in this change:
  lib/engine.ts → verify: SPEC.md
```

**Default = warn, exit 0.** `--strict` makes couplings a hard failure
(exit 1). No couplings → exit 0, no output.

**Known limitation:** glob `kind: code` downstreams (e.g. `lib/**/*.ts`) are
deferred — `synthesizeKindCodeEntries` logs and skips them, same as the
watcher — so `check` won't warn on a glob-declared code edge. Declare
non-glob `kind: code` edges for files you want the commit-time gate to
actually catch.

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
`commands/setup.mjs` returns when nothing was given to walk:

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

`setup --hub <path>` records where your code lives. Five things derive from it and
are **not** configured separately: `searchRoots` (when not declared), the skills
marketplace directory, and the three execution registries — `scripts/execution/`'s
`ports.yml`, `deploy.yml` and `mongo.yml`. Derive the list rather than trusting this
sentence: they are exactly the `underHub()` call sites in `lib/core/config.mjs`.

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
#    docs/archive/com.tathya.propagate.watcher.plist.retired-2026-08-14, so the
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
touch "$HOME/Documents/GitHub/Vipin Kaushik/docs/VIPIN.md"
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
