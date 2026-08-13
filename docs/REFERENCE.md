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
- Worktree helpers: `${CLAUDE_PLUGIN_ROOT}/lib/worktrees.mjs` — as of
  2026-08-14 `enumerateWorktrees`/`enumerateCanonicalRepos` (the
  worktree-expansion path used at watcher-fire time) has **no live caller
  left**; the watcher was its only consumer (`docs/ISSUES.md` N8). The
  smaller `correlationKey`/`worktreeStamp` helpers are still reused for id
  conventions elsewhere (`lib/reconcile.mjs`).
- launchd plists (installed, confirmed via `launchctl list` 2026-08-13,
  **before** the watcher plist's separate unload — see `docs/DECISIONS.md`
  2026-08-14 for that step, done outside this doc's scope):
  `~/Library/LaunchAgents/com.tathya.propagate.watcher.plist` (retired
  component's plist — unload/disable is a separate operational step, not a
  file-content change this repo makes) and
  `~/Library/LaunchAgents/com.tathya.propagate.digest.plist` (still active —
  the digest is not retired, only the watcher is). The watcher plist's label
  is owned by `lib/plist.mjs:25`:
  `export const LABEL = process.env.PROPAGATE_LABEL || "com.tathya.propagate.watcher"` —
  override with `PROPAGATE_LABEL` if you ever rename it again, and update this
  file and `doctor`'s checks in the same change. `lib/plist.mjs` only ever
  generated the watcher's plist — see the `reload` entry in "Complete CLI
  surface" below for what that means now.
- Ledger (JSONL, authoritative): **per-workspace, resolved by
  `lib/discovery.mjs` `makeWorkspaceRecord`** —
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

## Ledger resolution

⚠️ **Resolve the ledger path from the workspace the row belongs to — do NOT
hardcode a path.** A row shown under `# <Name>` by `status` lives in THAT
workspace's ledger (see "Canonical state" above). Writing to any other ledger
silently no-ops and the row stays open. Derive it via discovery so it always
matches what `status` reads:

```javascript
import { markStatus, renderMarkdown } from "${CLAUDE_PLUGIN_ROOT}/lib/ledger.mjs";
import { discoverWorkspacesSync } from "${CLAUDE_PLUGIN_ROOT}/lib/discovery.mjs";
import { SEARCH_ROOTS } from "${CLAUDE_PLUGIN_ROOT}/lib/config.mjs";

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

## Complete CLI surface

Source of truth: the `mode === "..."` dispatch chain in `cli.mjs` (~line
1131), not the usage string — the usage string's nested `[--a|--b]` groups
contain pipes that look like more commands than actually exist.

| Command | What it does |
|---|---|
| `status` | List open drift rows, scoped to the workspace at cwd by default. `--all` for every workspace, `--cross` for the cross-repo ledger, `--json` for machine-readable output. |
| `doctor` | Health check: launchd plist loaded (`launchctl list \| grep <label>`), heartbeat age (warn >1h during active periods, fail >1 day), all `.propagates.yml` sidecars pass schema validation, sidecar downstream paths resolve on disk (warn-only), `state.json` parseable with `.bak` present, ledger JSONL parseable. |
| `init <dir> [--workspace\|--edges-only]` | Scaffold `.propagates.yml`. `--workspace` (default) writes `workspace: true` and verifies the directory becomes discoverable, exiting non-zero if not (N15). **No longer touches the plist** — that moved to `reload` (N14). |
| `reload` | **Obsolete as of 2026-08-14** — its only purpose was regenerating the (now retired) watcher's plist and reloading it into launchd; `lib/plist.mjs` has never generated any other plist (grep confirms it — the digest plist is installed by a separate mechanism it never touches, see "Canonical state" above). Not removed from `cli.mjs` by this change (out of scope — no live launchd command was run to verify/enact this), but there is no remaining reason to run it. |
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
(`lib/reconcile.mjs`'s `inboundRows` — no new computation, no second event
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

# 2. Load launchd plist — HISTORICAL. Do not run: the watcher is retired,
#    and re-loading its plist re-arms the exact background job that was
#    retired for cause (docs/DECISIONS.md 2026-08-14). The live unload is a
#    separate, later operational step outside this repo's automated changes.
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tathya.propagate.watcher.plist
launchctl list | grep com.tathya.propagate.watcher   # confirm loaded

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
`lib/plist.mjs` never generated the digest's plist even when the watcher was
live — it is, and always was, installed by a separate mechanism.)

## Disable temporarily — watcher: superseded by full retirement; digest: still applies

For the watcher, this is now moot — it is retired outright, not merely
disabled, and the live unload is a separate operational step done outside
this repo's automated changes (see `docs/DECISIONS.md` 2026-08-14). Kept for
the digest, and as a record of the pre-retirement command shape:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tathya.propagate.watcher.plist
```

Re-enable: same `bootstrap` command as above — but re-enabling the watcher
means re-arming a component that was retired for cause; read
`docs/DECISIONS.md` 2026-08-14 in full before doing so. Ledger and sidecars
persist regardless.

## Architecture summary (for future-you)

v1 (historical, RETIRED 2026-08-14 — see `docs/DECISIONS.md`):

- Watcher invoked per file event by launchd `WatchPaths` (no daemon process).
- `proper-lockfile` serializes concurrent invocations.
- 3s mtime re-verify guards against atomic-replace partial reads.
- Heartbeat file is the fallback if macOS notification permission is denied.

v2 (current):

- `reconcile` (`lib/reconcile.mjs`) derives drift from content — git blob ids
  on both sides of an edge plus the v2 event store (`lib/events.mjs`) — on
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
