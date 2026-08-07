---
name: propagate
description: Manage the propagation ledger — drain open drift events, check watcher health, declare sidecars, init new directories. Triggers on "/propagate", "drain propagation", "what depends on this", "propagation status", or any reference to PROPAGATION_LEDGER.
---

# /propagate — Propagation skill

Companion to the launchd watcher at `~/.claude/skills/propagate/watcher.mjs`.
The watcher detects drift; this skill walks the human through resolving it,
declaring new sidecars, and verifying health.

**Canonical state:**
- Watcher script: `~/.claude/skills/propagate/watcher.mjs`
- Worktree helpers: `~/.claude/skills/propagate/lib/worktrees.mjs`
- launchd plist: `~/Library/LaunchAgents/com.rupali.propagate.plist`
- Ledger (JSONL, authoritative): **per-workspace, resolved by `lib/discovery.mjs` `makeWorkspaceRecord`** —
  `<workspace-root>/docs/PROPAGATION_LEDGER.jsonl` when `<root>/docs/` exists, otherwise
  `<workspace-root>/.propagation/ledger.jsonl`. There is NOT one global ledger. Examples:
  `Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl` (has `docs/`), but the **GitHub hub** workspace
  (`~/Documents/GitHub`, which any sub-project without its own registered workspace resolves to via
  `currentWorkspace()`) has no `docs/`, so its ledger is `~/Documents/GitHub/.propagation/ledger.jsonl`.
  ⚠️ Always resolve the ledger for the row you're closing from the SAME workspace `status`/`doctor`
  reports it under (see the drain note below) — writing `markStatus` to a different workspace's ledger
  silently no-ops (the row never clears).
- Ledger (Markdown, rendered): the sibling `…/PROPAGATION_LEDGER.md` or `…/.propagation/ledger.md`.
- Sidecars: `<workspace-root>/**/.propagates.yml` (every discovered workspace)
- State: `~/.claude/skills/propagate/state.json` (with `.bak` rotation)
- Heartbeat: `~/.claude/skills/propagate/heartbeat`
- Logs: `~/.claude/skills/propagate/watcher.log`, `watcher.stdout.log`, `watcher.stderr.log`
- Tests: `~/.claude/skills/propagate/tests/` — run with `npm test`

**Watcher cadence (post-2026-06-08):**
- launchd `WatchPaths` fires on changes inside watched roots (FSEvents-backed, bubbles up nested file changes).
- launchd `StartInterval: 60` guarantees a fire every 60s regardless of file events. Catches deep-nested edits FSEvents might miss.
- The watcher SKIPS `renderMarkdown` when no events fired this run — without this guard, every no-drift fire would re-tick the ledger MD and cascade-trigger the watcher every ~5s.

**Worktree-awareness (post-2026-06-08):**
- Sidecar paths stay canonical (e.g. `../VipinKaushik/lib/pricing.ts`). The watcher expands at runtime via `git worktree list --porcelain` per canonical repo.
- Edits in non-canonical worktrees fire rows with `source_worktree: {branch, commit}`.
- All rows pointing at the same logical file across worktrees share a `correlation_id` (e.g. `VipinKaushik:lib/pricing.ts`).
- First-observation of a sibling-worktree file silently seeds state.json without firing drift (bootstrap behaviour).

## Modes

Invoke this skill with one of the modes below. Default mode if none given: `status`.

### `status` — what's open

```bash
node ~/.claude/skills/propagate/cli.mjs status          # THIS project (workspace at cwd)
node ~/.claude/skills/propagate/cli.mjs status --all    # every workspace
node ~/.claude/skills/propagate/cli.mjs status --cross  # cross-repo ledger
```

Lists open drift rows grouped by source doc, with row IDs. **Scoped by default** to the
workspace containing the current directory — it won't relay other workspaces' queues.
Open cross-repo rows whose origin lives inside this workspace are surfaced as
"Cross-repo dependencies" (the "unless there's a dependency" case). `--all` restores the
every-workspace view.

### `drain` — walk through open items, apply or skip each

For each open row in the ledger:
1. Read the source doc near the section that drifted (use git log to find the most recent commit touching that doc)
2. Read each downstream file
3. Decide with the user: apply the change, defer with a note, or mark wontfix
4. On apply: edit the downstream, then call `markStatus(rowId, "done")`
5. On defer: note in the row's `notes`, leave open
6. On wontfix: `markStatus(rowId, "wontfix")` with a justification in notes

#### Worktree-aware deduplication

When the watcher fires from edits in a non-canonical git worktree, rows carry:
- `correlation_id` — `<repo-basename>:<repo-relative-path>` (e.g. `VipinKaushik:lib/pricing.ts`). All rows touching the same logical file across worktrees share this id.
- `source_worktree` — `{branch, commit}` for the worktree where the edit happened (absent for canonical).
- Per-downstream `worktree` stamps on entries that expanded into secondary worktrees.

**Drain behaviour for correlated rows:**
1. Group open rows by `correlation_id`. Rows sharing an id are the same logical change observed in different worktrees.
2. Present the user with ONE verification prompt per `correlation_id`, listing every observation's `source_worktree` (so they can see "this file changed on branch X and branch Y").
3. When the user verifies and applies the upstream change, call `markStatus` for every row in the group — drain closes them all together.
4. If the user wants to handle worktrees independently (rare — usually you verify the canonical doc once and that closes all observations), drop into per-row mode by ignoring the grouping.

Rows without `correlation_id` (workspace docs, orphan files) are handled per-row as before.

Drain is a Claude-driven workflow — there is no automated drain command. The
skill walks the human through each item using AskUserQuestion. After each
decision, append a `status_change` record by calling the helper.

⚠️ **Resolve the ledger path from the workspace the row belongs to — do NOT hardcode
a path.** A row shown under `# <Name>` by `status` lives in THAT workspace's ledger
(see the per-workspace rule under "Canonical state"). `markStatus` against any other
ledger silently no-ops and the row stays open. Derive it via discovery so it always
matches what `status` reads:

```javascript
import { markStatus, renderMarkdown } from "~/.claude/skills/propagate/lib/ledger.mjs";
import { discoverWorkspacesSync } from "~/.claude/skills/propagate/lib/discovery.mjs";
import { SEARCH_ROOTS } from "~/.claude/skills/propagate/lib/config.mjs";

// pick the workspace whose root contains the row's source file (nearest ancestor)
const ws = discoverWorkspacesSync(SEARCH_ROOTS)
  .filter((w) => sourceAbsPath === w.root || sourceAbsPath.startsWith(w.root + "/"))
  .reduce((best, w) => (w.root.length > (best?.root.length ?? -1) ? w : best), null);

await markStatus(ws.ledgerJsonl, "003", "done");
await renderMarkdown(ws.ledgerJsonl, ws.ledgerMd); // re-render the sibling MD
```

Quick sanity check after closing: re-run `status` — the row should be gone. If it
isn't, you wrote to the wrong ledger file.

### `doctor` — health check

Run via the bash entry below. Reports:
- launchd plist loaded? (`launchctl list | grep com.rupali.propagate`)
- Heartbeat age (warn if > 1 hour during a likely-active period; fail if > 1 day)
- All `.propagates.yml` sidecars pass schema validation
- **Sidecar downstream paths resolve on disk** (warn-only, cross-workspace): a `prose`
  downstream that no longer exists or a glob matching 0 files is surfaced as a yellow
  warning; `code` downstreams are treated as declare-ahead (warn, never fail). Per-repo
  enforcement is the repo's own pre-commit, not this cross-workspace report.
- `state.json` parseable; `.bak` exists
- Ledger JSONL parseable

```bash
node ~/.claude/skills/propagate/cli.mjs doctor
```

If `propagate doctor` reports issues, fix in this order:
1. plist not loaded → `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rupali.propagate.plist`
2. schema violations → edit the offending `.propagates.yml` per the error message
3. state corruption → the script handles this; just trigger a manual run: `node ~/.claude/skills/propagate/watcher.mjs`

### `declare <file>` — bootstrap a sidecar (V1 manual; V2 graph-augment)

For V1: open the parent directory's `.propagates.yml` (create if missing), add an
entry under `sources:` keyed by the file's basename, list known downstreams by
hand (no graph queries yet — deferred to V2 per TM-064).

Template to append:

```yaml
sources:
  <filename>:
    propagates_to:
      - path: <relative path to downstream>
        why: <one-line reason>
        kind: prose  # or "code"
```

**Glob downstreams:** `path` may be a glob (e.g. `style/pages/**/*.md`) to declare a
"this shared doc feeds a whole tree" edge without hand-listing every consumer. The watcher
fs-expands it (relative to the sidecar dir) and records one summary entry
(`{glob_matched: N, sample: […]}`) rather than N rows. A glob that matches 0 files is
skipped with a log warning (never recorded as a literal path).

**`kind: code` is bidirectional:** the edge fires both ways — the doc changing fires
forward (verify the code), and the code file changing now also fires a `code_drift`
row back at the doc (verify the doc). Non-glob `kind: code` downstreams only; glob
`kind: code` entries are log-and-skipped on the code→doc direction (deferred).

### `init <dir>` — onboard a new directory

For V1: create an empty `.propagates.yml` at `<dir>/.propagates.yml` with just
the header. Add `<dir>` to `WatchPaths` in the plist if it's not already covered
by a parent watch. Reload the plist.

## Initial install (once per machine)

```bash
# 1. Install deps
cd ~/.claude/skills/propagate && npm install

# 2. Load launchd plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rupali.propagate.plist
launchctl list | grep com.rupali.propagate   # confirm loaded

# 3. First-run smoke test
node ~/.claude/skills/propagate/watcher.mjs
# Should print nothing to stdout but write a "run complete" line to
# ~/.claude/skills/propagate/watcher.log

# 4. Verify by touching a watched file
touch "$HOME/Documents/GitHub/Vipin Kaushik/docs/VIPIN.md"
# Within ~10s, a notification should appear and a new row added to
# Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl
```

## Disable temporarily

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.rupali.propagate.plist
```

Re-enable: same `bootstrap` command as above. Ledger and sidecars persist.

## What this skill does NOT do (V1)

- Graph integration. `code-review-graph` MCP is not currently registered; the
  `concepts:` field in sidecars is schema-accepted but unused. Deferred to V2
  (TM-064 in workspace TODOS.md).
- ~~Code → prose drift detection~~ — **exists, two ways**: (1) `.code-canonical.yml`
  per-workspace canonical-pairs fire a `code_drift` row when the declared code path's
  mtime advances. (2) Every `.propagates.yml` `kind: code` downstream is now
  **bidirectional** — a doc's `kind: code` edge previously only fired forward
  (doc changes → verify code); code changes on that same edge now also fire a
  `code_drift` row back at the doc (closes #43's gap: task-engine-v2.md declared a
  `kind: code` downstream, the code changed, and nothing fired). Both sources are
  merged and grouped by code path, so a file declared in both fires ONE row with
  N downstream docs, not N rows. Glob `kind: code` downstreams are still deferred
  (logged and skipped). No git post-commit hooks involved either way — same
  mtime-watch mechanism as everything else in this skill.
- ~~Cross-workspace propagation~~ — **now auto-discovered**: `discovery.mjs` walks
  `~/Documents/GitHub` for `.propagates.yml` markers, so every workspace with sidecars
  (e.g. Vipin Kaushik, PanditPawanKaushik) is watched. `lib/config.mjs` no longer hardcodes one.
- Linux/remote dev support (macOS-only via launchd).

## Architecture summary (for future-you)

- Watcher invoked per file event by launchd `WatchPaths` (no daemon process)
- `proper-lockfile` serializes concurrent invocations
- 3s mtime re-verify guards against atomic-replace partial reads
- State + sidecars + ledger all atomic-write via temp+rename
- Heartbeat file is the fallback if macOS notification permission is denied
- JSONL is authoritative for the ledger; MD is regenerated on every change

If something breaks, check `~/.claude/skills/propagate/watcher.log` first.
