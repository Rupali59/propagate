---
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" backlog:*)
description: See what open work is recorded across every STATE.md, TODOS.md and handover in the tree
---

## Backlog across all discovered workspaces

!`node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" backlog`

## Your task

Summarise what is open. Two things in the output are easy to misread, so name them
explicitly if present:

- **`unparsed`** files are NOT empty. The format was not recognised, so their contents
  are unknown — never fold them into a total as zero.
- **`unknown`** handover sections have neither a `Done when:` nor a `Resolved:` marker.
  Nobody has said what would finish them; that is not the same as done.
