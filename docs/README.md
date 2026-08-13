> Entry point: [`../SKILL.md`](../SKILL.md)

# propagate — docs index

Reader-intent index. Start at `SKILL.md` — it is the only file the agent
loads automatically and carries the canonical premise. Everything here is
one hop deeper, for when you land in `docs/` directly.

| File | Answers |
|---|---|
| [`../SKILL.md`](../SKILL.md) | What is this for? What does it refuse to do? What are the modes? Entry point. |
| [`README.md`](./README.md) | This file — where do I look for X? |
| [`REFERENCE.md`](./REFERENCE.md) | Exact paths, the complete CLI surface and flags, ledger-resolution snippet, install/disable sequence, architecture summary. |
| [`SPEC.md`](./SPEC.md) | What's the target design? What invariants does the system claim, and what's the evidence for the premise? |
| [`ISSUES.md`](./ISSUES.md) | What's broken, tracked, or a known gap (e.g. no `cli drain`, the pre-push injection risk)? |
| [`DECISIONS.md`](./DECISIONS.md) | Why does it work this way — what changed, when, and what did it supersede? |
| [`SYSTEMS.md`](./SYSTEMS.md) | What background components exist (watcher, digest), and what state are they in? |

## Routing table (situations, not topics)

| When | Read this |
|---|---|
| you need the premise, and what this refuses to do | `../SKILL.md` identity block (canonical); `SPEC.md` §1 for the evidence |
| a row won't close after you marked it done | `REFERENCE.md` § Ledger resolution |
| something is broken, or a doctor check fails | `ISSUES.md` |
| you're changing behaviour and need to know why | `DECISIONS.md` |
| you need exact paths, flags, or the install sequence | `REFERENCE.md` |
| you want current status / what's in flight | `../STATE.md` |
| you're adding a background component | `SYSTEMS.md` |
