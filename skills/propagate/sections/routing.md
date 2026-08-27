# routing — which command answers which question

*Section of the parent skill — Read this file when the situation below applies. It is deliberately NOT a discoverable skill: as one it declared the bare name `routing`, which squats a generic global name.*

**When this applies:** Use when you need to run a propagate `cli.mjs` command and aren't sure which one answers your question — checking status, health, rule conformance, install state, or what depends on what.

Parent skill: `propagate` (premise, Contract, Important Rules). Full flags for
every command below: `docs/REFERENCE.md`.

## Command table

| Command | Answers | Notes |
|---|---|---|
| `status` | What drift is open? | Scoped to the workspace at cwd; `--all` for every workspace, `--cross` for the cross-repo ledger. |
| `doctor` | Is the install healthy? | Event store readable + non-empty, `reconcile` completes, sidecar schema valid, ledger parseable. |
| `check --changed` | Did I forget to update something? | Commit-time gate: for changed files, warns when a declared coupling didn't also change. `--changed` (working tree + staged vs HEAD) is the default. |
| `graph` | What depends on what, and in what order should I fix it? | See Worklist semantics below. `--all`, `--node <path>`, `--html out.html`. |
| `drain` | What's open, grouped for closing? | Bare = read-only list grouped by `correlation_id`. Writing closes is the `reconcile` skill's job, not this one's. |
| `rules <list\|check\|selftest\|promote>` | Does a `CLAUDE.md` restate a canonical rule instead of referencing it? | See Rules check below. |
| `registers` | Has a register grown past the point anyone opens it? | Read-only. Reports which `ISSUES.md` / `TODOS.md` / handover / `GOTCHAS.md` files are hot, which carry finished work that could rotate out, and which could not be read at all. **Gotchas never rotate** — a hazard does not expire. There is deliberately no writer: rotation is `git mv` into `archive/` plus an index line. `--json`, `--all`. |
| `setup [--roots …]` | Install-time bootstrap, once per machine. | Writes `~/.propagate/config.yml`; exits non-zero unless discovery then finds ≥1 workspace. Safe to re-run. |
| `init <dir>` | Scaffold an empty `.propagates.yml`. | Configures one directory, not the machine — `setup` is for that. |
| `reload` | (No live purpose.) | Regenerates the v1 watcher's plist; the watcher is retired. |

```bash
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs status
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs doctor
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs check --changed
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs graph --all --node <path>
node ${CLAUDE_PLUGIN_ROOT}/cli.mjs rules check
```

## Worklist semantics (`graph`)

`graph` derives the DAG from `reconcile` and leads with the **fix order**:
every actionable edge sorted by its source's layer (longest path from root),
so working top to bottom never pins a downstream against a source that is
itself unsettled. `NEVER_VERIFIED` edges are excluded from the worklist by
default (`--include-unverified` to show them) — they're a baseline gap, not
movement — but they still count as unsettled when deciding what blocks what,
and the excluded count is always printed. `graph` also names structural
defects a per-edge view can't see: cycles (condensed, not dropped), the same
pair declared twice, globs matching nothing.

## Rules check

`rules check` finds `CLAUDE.md` files that restate a canonical rule instead of
referencing it as `rule:<id>`. A declared `overrides: <id>` is printed but
never failed — the escape hatch exists precisely so divergence stays visible.
**It exits non-zero when it scanned NOTHING**, not only when it found
something — "no files scanned" is not a clean result.

**A file that references a rule AND restates it is counted, not excused.** It
still does not fail the run, because flipping every such file to a failure at
once is how a gate gets bypassed rather than fixed — but the count is printed
per rule, because a pointer sitting beside a stale copy is what a half-finished
conversion looks like, and it used to be invisible (19 files, measured
2026-08-24, while the summary line read "0 restatement(s) across 0 file(s)").

`selftest` proves every rule's fingerprint can fire against that rule's own
body — **which is not the same as firing on how the claim is phrased in the
wild**, and that gap is `docs/ISSUES.md` N35. Use `rules list` for the per-rule
restated / referenced / status table and the unexercised count; a rule nothing
restates and nothing references is an UNKNOWN, not a pass.

## Out of scope here

`declare` and `drain`'s decision-making (apply/defer/wontfix) are agent
workflows, not routing — see the `reconcile` skill. The `skills-*` command
family (skill lifecycle: create/promote/demote/reap) is a separate manager
riding the same CLI; see `docs/DECISIONS.md`.
