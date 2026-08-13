> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# propagate — Reference

Paths, the complete CLI surface, install/disable sequence, and architecture.
For "what do I do right now," go back to `SKILL.md`.

## Canonical state

- Watcher script: `${CLAUDE_PLUGIN_ROOT}/watcher.mjs`
- Worktree helpers: `${CLAUDE_PLUGIN_ROOT}/lib/worktrees.mjs`
- launchd plists (installed, confirmed via `launchctl list` 2026-08-13):
  `~/Library/LaunchAgents/com.tathya.propagate.watcher.plist` and
  `~/Library/LaunchAgents/com.tathya.propagate.digest.plist`. The label is
  owned by `lib/plist.mjs:25`:
  `export const LABEL = process.env.PROPAGATE_LABEL || "com.tathya.propagate.watcher"` —
  override with `PROPAGATE_LABEL` if you ever rename it again, and update this
  file and `doctor`'s checks in the same change.
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

## Watcher cadence (post-2026-06-08)

- launchd `WatchPaths` fires on changes inside watched roots (FSEvents-backed,
  bubbles up nested file changes).
- launchd `StartInterval: 60` guarantees a fire every 60s regardless of file
  events. Catches deep-nested edits FSEvents might miss.
- The watcher SKIPS `renderMarkdown` when no events fired this run — without
  this guard, every no-drift fire would re-tick the ledger MD and
  cascade-trigger the watcher every ~5s.

## Worktree-awareness (post-2026-06-08)

- Sidecar paths stay canonical (e.g. `../VipinKaushik/lib/pricing.ts`). The
  watcher expands at runtime via `git worktree list --porcelain` per canonical
  repo.
- Edits in non-canonical worktrees fire rows with
  `source_worktree: {branch, commit}`.
- All rows pointing at the same logical file across worktrees share a
  `correlation_id` (e.g. `VipinKaushik:lib/pricing.ts`).
- First-observation of a sibling-worktree file silently seeds `state.json`
  without firing drift (bootstrap behaviour).

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
| `reload` | Regenerate the plist from discovery and reload launchd. Refuses to write a plist with 0 watch roots. |
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

## Initial install (once per machine)

```bash
# 1. Install deps
cd ${CLAUDE_PLUGIN_ROOT} && npm install

# 2. Load launchd plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tathya.propagate.watcher.plist
launchctl list | grep com.tathya.propagate.watcher   # confirm loaded

# 3. First-run smoke test
node ${CLAUDE_PLUGIN_ROOT}/watcher.mjs
# Should print nothing to stdout but write a "run complete" line to
# ${CLAUDE_PLUGIN_ROOT}/watcher.log

# 4. Verify by touching a watched file
touch "$HOME/Documents/GitHub/Vipin Kaushik/docs/VIPIN.md"
# Within ~10s, a notification should appear and a new row added to
# Vipin Kaushik/docs/PROPAGATION_LEDGER.jsonl
```

The digest agent installs the same way, against
`com.tathya.propagate.digest.plist`.

## Disable temporarily

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tathya.propagate.watcher.plist
```

Re-enable: same `bootstrap` command as above. Ledger and sidecars persist.

## Architecture summary (for future-you)

- Watcher invoked per file event by launchd `WatchPaths` (no daemon process).
- `proper-lockfile` serializes concurrent invocations.
- 3s mtime re-verify guards against atomic-replace partial reads.
- State + sidecars + ledger all atomic-write via temp+rename.
- Heartbeat file is the fallback if macOS notification permission is denied.
- JSONL is authoritative for the ledger; MD is regenerated on every change.

If something breaks, check `${CLAUDE_PLUGIN_ROOT}/watcher.log` first.
