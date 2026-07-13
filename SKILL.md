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
- Ledger (JSONL, authoritative): `Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl`
- Ledger (Markdown, rendered): `Vipin Kaushik/docs/PROPAGATION_LEDGER.md`
- Sidecars: `Vipin Kaushik/**/.propagates.yml`
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
node ~/.claude/skills/propagate/cli.mjs status
```

Lists all drift rows with `status: open`, grouped by source doc, with row IDs.
Use this at the start of a session in any subtree that touches constitution docs.

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
decision, append a `status_change` record by calling the helper:

```javascript
import { markStatus } from "~/.claude/skills/propagate/lib/ledger.mjs";
await markStatus(
  "/Users/rupali.b/Documents/GitHub/Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl",
  "003",
  "done",
);
```

Then re-render the MD view:
```javascript
import { renderMarkdown } from "~/.claude/skills/propagate/lib/ledger.mjs";
await renderMarkdown(
  "/Users/rupali.b/Documents/GitHub/Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl",
  "/Users/rupali.b/Documents/GitHub/Vipin Kaushik/docs/PROPAGATION_LEDGER.md",
);
```

### `doctor` — health check

Run via the bash entry below. Reports:
- launchd plist loaded? (`launchctl list | grep com.rupali.propagate`)
- Heartbeat age (warn if > 1 hour during a likely-active period; fail if > 1 day)
- All `.propagates.yml` sidecars pass schema validation
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
- Code → prose drift detection (no git post-commit hooks; deferred).
- Cross-workspace propagation (skill is general but only `Vipin Kaushik` is
  configured in `lib/config.mjs`).
- Linux/remote dev support (macOS-only via launchd).

## Architecture summary (for future-you)

- Watcher invoked per file event by launchd `WatchPaths` (no daemon process)
- `proper-lockfile` serializes concurrent invocations
- 3s mtime re-verify guards against atomic-replace partial reads
- State + sidecars + ledger all atomic-write via temp+rename
- Heartbeat file is the fallback if macOS notification permission is denied
- JSONL is authoritative for the ledger; MD is regenerated on every change

If something breaks, check `~/.claude/skills/propagate/watcher.log` first.
