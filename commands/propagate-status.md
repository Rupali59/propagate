---
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" status:*)
description: Check whether any declared file coupling has drifted, before editing a doc that other files must follow
---

## Current propagation status

!`node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" status`

## Your task

Report what the output says, in one or two lines.

**`✓ no open drift` does not mean the tree is healthy.** It means nothing *declared*
is drifting. An artifact with no declared edges has had no coupling review at all, and
this command cannot tell those apart — see `rule:adversarial-review-reads-the-ledger`.
If the user is about to trust a green result, say which of the two it is.
