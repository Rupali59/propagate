---
name: propagate
description: Use when a change to one file needs to reach files that must move with it — across branches, worktrees, or repos. Triggers on "/propagate", "propagation status", "drain propagation", "what depends on this", "did anything drift", "what did I forget to update", a red or unexplained propagate check, or any reference to PROPAGATION_LEDGER or a .propagates.yml sidecar.
---

# /propagate — Propagation skill

<!-- premise:start -->
**propagate coordinates parallel work.** Work proceeds in parallel — across
branches and worktrees inside a repo, and across repos in the workspace — and
parallel streams lose sight of each other. propagate declares the couplings that
matter, watches them, and keeps an append-only ledger tied to git workflow, so
every stream can see what moved, where, and on which branch. It never edits a
downstream; it tells a human.
<!-- premise:end -->

**v1 launchd watcher retired** (`docs/DECISIONS.md`) — drift derives from content
on demand, never a poll.

## Sections

- Read **`sections/routing.md`** — which `cli.mjs` command answers what.
- Read **`sections/settle.md`** — settle a file's drifted edges.
- Read **`sections/reconcile.md`** — `declare`, legacy `drain`, fix order.

## Setup — once per machine, in this order

| # | Command | Establishes |
|---|---|---|
| 1 | `npm install` in the skill directory | dependencies |
| 2 | `node cli.mjs setup --hub <dir>` | where your code lives. Exits non-zero unless discovery then finds ≥1 workspace |
| 3 | `node cli.mjs bootstrap --baseline-from-git --apply` | the verification baseline. **Skip this and every edge reads `NEVER_VERIFIED`**, `doctor` red. Dry-run without `--apply` |
| 4 | `node cli.mjs doctor` | confirms 2 and 3 took |

**Step 3 is the one people miss** — `setup`/`status` succeeding is configured,
not verified. Outcome table: `docs/REFERENCE.md` § Install.

## Contract

- **Only stop for:** a disposition decision (`settle`, legacy `drain`),
  a `declare` edit to a `.propagates.yml` sidecar, or a genuine one-way door
  (migrating ledger rows, or anything touching launchd/plists).
- **Never stop for:** running `status`, `doctor`, or `check` — just run them
  and report what they say.
- **Never do:** edit a downstream file automatically, rewrite a ledger row,
  or hand-invent a ledger path instead of resolving it via discovery.

## Important Rules

- **`verify` is dry-run by default; `--apply` writes** — for every
  disposition, not just `decoupled` (`docs/GOTCHAS.md` G44: this gap once cost
  11 phantom verification events).
- **Fix root-to-leaf.** Verifying an edge whose source is itself unsettled
  pins content against an unconfirmed source. `verify` refuses (exit 3) and
  names every blocking upstream; `--out-of-order` overrides deliberately.
  `deferred`/`decoupled` are exempt; `wontfix`/`baselined` are not. `graph`
  prints the worklist already ordered.
- **Settle an edge through `verify`, never by hand** — `--apply` appends the
  event and re-reconciles to confirm. `propagate settle <file>`
  prints the exact command per edge. `drain` closes only legacy v1 rows.
- **Never rewrite a ledger row.** Append-only; migration is close-and-re-emit.
- **Schema before field.** `propagates.schema.json` is
  `additionalProperties: false` — an undeclared field is rejected silently and
  every edge in that sidecar stops firing.
- **Never edit a downstream automatically.**
- **A red `doctor` is doing its job.** It fails on unknown row types and
  sources open in more than one ledger — fix the data or file the issue,
  never tune the check until it passes.

## More

`STATE.md` (status) · `docs/DECISIONS.md` (why) · `docs/GOTCHAS.md` (bites)
· `docs/REFERENCE.md` (paths, flags).
