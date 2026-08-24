---
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" doctor:*)
description: Diagnose the propagation setup end to end when something looks wrong, or after changing where files live
---

## Health check

!`node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" doctor`

## Your task

Report the failing checks and what each one means.

**This command is not read-only.** Unlike `status`, `backlog` and `why`, it appends a
record to `~/.propagate/metrics.jsonl` on every run. That is stated here rather than
left for someone to discover, because a command grouped with the readers and silently
writing is the exact mislabelling `rule:safety-flag-needs-a-test` is about.

Two failure shapes worth naming when they appear:

- **`source "<path>" does not exist — this edge can never fire`** — a sidecar names a
  file that moved. The declaration looks machine-checked and is not.
- **half-migrated workspaces** — a partial layout migration is the state that loses
  data, so this is a real failure, not noise.
