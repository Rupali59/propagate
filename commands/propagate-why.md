---
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" why:*)
description: Find out why one file is declared to follow another, and what verified it last
---

## Your task

Run the command below for the edge the user names. It needs an edge id:

```
node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" why <edge_id> [--all] [--json]
```

If the user gave a file rather than an edge id, run `propagate status` or `reconcile`
first to find the id, then come back.

Report the declared reason (`why`) and the verification state. **`NEVER_VERIFIED` means
the coupling was declared and never checked** — it is not a pass, and it is the state a
fresh declaration starts in.
