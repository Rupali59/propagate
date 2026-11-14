---
description: a content-accuracy question about a doc dispatches propagate:doc-curator and gates it with check-curator
tags: [agent-routing]
runs: 1
allowed_tools: [Read, Glob, Grep, Bash, Agent, Skill]
max_turns: 20
timeout_seconds: 600
---

Is docs/RELEASE.md still accurate against the code? Tell me which of its statements are stale.
