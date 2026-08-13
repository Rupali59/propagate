---
name: propagate
description: Manage the propagation ledger — drain open drift events, check watcher health, declare sidecars, init new directories. Triggers on "/propagate", "drain propagation", "what depends on this", "propagation status", or any reference to PROPAGATION_LEDGER.
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

**Hard non-goal:** propagate never writes to a downstream file on its own
initiative. Every close, edit, or dismissal is a human (or an agent acting on a
human's behalf) making the call — the ledger is a record of that decision, not
an automation that makes it.

## Contract

- **Only stop for:** a `drain`-style decision (apply / defer / wontfix a row),
  a `declare` edit to a `.propagates.yml` sidecar, or a genuine one-way door
  (disabling the watcher, migrating ledger rows).
- **Never stop for:** running `status`, `doctor`, or `check` — just run them
  and report what they say.
- **Never do:** edit a downstream file automatically, rewrite a ledger row,
  or hand-invent a ledger path instead of resolving it via discovery.

## Read this first

| When | Read this |
|---|---|
| you need the premise, and what this refuses to do | this file's identity block (canonical); `docs/SPEC.md` §1 for the evidence |
| a row won't close after you marked it done | `docs/REFERENCE.md` § Ledger resolution |
| something is broken, or a doctor check fails | `docs/ISSUES.md` |
| you're about to change a check, a default, or anything live | `docs/GOTCHAS.md` — what these mistakes cost last time |
| you need to know what signal would have caught a failure | `docs/OBSERVABILITY.md` |
| you're changing behaviour and need to know why | `docs/DECISIONS.md` |
| you need exact paths, flags, or the install sequence | `docs/REFERENCE.md` |
| a field on a ledger row looks unused, or you need the real (not spec'd) row shape | `docs/DATA_MODEL.md` |
| you want current status / what's in flight | `STATE.md` |
| you're adding a background component | `docs/SYSTEMS.md` |

## Modes

Invoke this skill with one of the modes below. Default mode if none given: `status`.

### CLI commands

These are real `cli.mjs` subcommands — run them directly. Full flags in
`docs/REFERENCE.md`.

- **`status`** — list open drift rows, scoped to the workspace at cwd by
  default (`--all` for every workspace, `--cross` for the cross-repo ledger).
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs status
  ```
- **`doctor`** — health check: plist loaded, heartbeat age, sidecar schema
  validity, ledger parseability.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs doctor
  ```
- **`init <dir>`** — scaffold an empty `.propagates.yml` at `<dir>` and add it
  to the watcher's `WatchPaths`.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs init <dir>
  ```
- **`check`** — commit-time drift gate: for changed files, warns when a
  declared coupling (forward or `kind: code` reverse) didn't also change.
  `--changed` (working tree + staged vs HEAD) is the default, so the flag is
  optional.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs check --changed
  ```
- **`drain`** — the supported close path. Bare, it lists open rows grouped by
  `correlation_id` (read-only). With `--close`/`--group` it writes the closes.
  Requires `--reason` for a wontfix and verifies each row actually closed,
  exiting non-zero if not. See the walkthrough under Agent workflows below.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs drain                    # list, grouped
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs drain --group <corr-id> --status done
  ```

### Agent workflows (not commands)

These are prose procedures an agent walks through — not `cli.mjs` subcommands.

**`declare <file>`** — bootstrap a sidecar. Open the parent directory's
`.propagates.yml` (create if missing), add an entry under `sources:` keyed by
the file's basename, list known downstreams by hand (no graph queries yet —
deferred to V2 per TM-064):

```yaml
sources:
  <filename>:
    propagates_to:
      - path: <relative path to downstream>
        why: <one-line reason>
        kind: prose  # or "code"
```

`path` may be a glob (e.g. `style/pages/**/*.md`) to declare a "this shared
doc feeds a whole tree" edge without hand-listing every consumer; a glob
matching 0 files is skipped with a log warning. `kind: code` is bidirectional
— the doc changing fires forward (verify the code), and the code file
changing fires a `code_drift` row back at the doc — for non-glob entries only;
glob `kind: code` on the code→doc direction is deferred (logged and skipped).

**`drain` — walk the human through open rows.** The *decisions* are the agent's
job; the *writing* is `cli drain`'s (see CLI commands above). Never hand-write a
`markStatus` call — that is how rows landed in the wrong ledger for months.

For each open row, or each correlation group:
1. Read the source doc near the section that drifted (git log to find the
   most recent commit touching that doc).
2. Read each downstream file.
3. Decide **with the user**: apply, defer, or wontfix. Never decide alone — a
   close asserts "I verified this downstream", which is the user's call.
4. On apply: edit the downstream, then
   `cli.mjs drain --close <id> --status done`.
5. On defer: leave it open. An open row is honest.
6. On wontfix: `--status wontfix --reason "<why>"`. The reason is required and
   the command will refuse without it.

Prefer `--group <correlation_id>` over closing ids one at a time, and pass one
shared `--reason` for a batch. Bulk is the real workload: before the command
existed, people recorded bulk closes by hand as counterfeit drift rows
(`docs/DATA_MODEL.md` §6.1).

**Correlation grouping matters under the premise above** — this is the
parallel-coordination behaviour, not a nicety. When the watcher fires from a
non-canonical worktree, rows carry `correlation_id` (`<repo>:<path>`,
e.g. `VipinKaushik:lib/pricing.ts`) and `source_worktree` (`{branch, commit}`).
Group open rows by `correlation_id` before presenting them — rows sharing an
id are the same logical change observed on different branches. Present one
verification prompt per group, listing every `source_worktree`, and close the
whole group together when the user verifies. Rows without `correlation_id`
(workspace docs, orphan files) are handled per-row.

### Out of scope

The `skills-*` command family (`skills`, `skills-create`, `skills-promote`,
`skills-demote`, `skills-reap`) is a skill-lifecycle manager riding in the
same CLI; it is being split out. See `docs/DECISIONS.md`.

## Important Rules

- **Close through `cli drain`, never by hand.** It resolves the ledger via
  discovery and verifies the row actually closed. `markStatus` now throws on an
  id it cannot find (so a typo is loud), but an id that happens to exist in the
  *wrong* ledger will still misfile — and hand-built paths are how that kept
  happening.
- **Never rewrite a ledger row.** Append-only; migration is close-and-re-emit.
- **Schema before field.** `propagates.schema.json` is
  `additionalProperties: false` — a sidecar gaining an undeclared field is
  rejected silently and every edge in it stops firing.
- **Never edit a downstream automatically.**
- **A red `doctor` is doing its job.** As of 2026-08-13 it fails on unknown row
  types and on sources open in more than one ledger — both are real, both were
  invisible before. Fix the data or file the issue; never tune the check until
  it passes.
