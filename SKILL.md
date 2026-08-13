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
| you're changing behaviour and need to know why | `docs/DECISIONS.md` |
| you need exact paths, flags, or the install sequence | `docs/REFERENCE.md` |
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

**`drain` — walk through open ledger rows.** ⚠️ **There is no supported close
path today.** `markStatus` (`lib/ledger.mjs:97`) has zero production callers —
it appears only in its own definition and two test files. Nothing in
`cli.mjs`, `watcher.mjs`, or `digest.mjs` calls it. The only mechanism that
actually closes a row is an LLM hand-writing a node script against a ledger
path it resolved itself (see `docs/REFERENCE.md` § Ledger resolution).
`docs/SPEC.md` §6 already specifies `cli drain` as "new, and required" — it
does not exist yet. See `docs/ISSUES.md` for the tracked gap.

The procedure, such as it is, for each open row:
1. Read the source doc near the section that drifted (git log to find the
   most recent commit touching that doc).
2. Read each downstream file.
3. Decide with the user: apply the change, defer with a note, or mark wontfix.
4. On apply: edit the downstream, then hand-write a `markStatus` call (see
   `docs/REFERENCE.md`).
5. On defer: note in the row's `notes`, leave open.
6. On wontfix: `markStatus(rowId, "wontfix")` with a justification in notes.

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

- **Never hardcode a ledger path.** Resolve via discovery from the workspace
  `status` reported the row under. `markStatus` against the wrong ledger
  silently no-ops and the row stays open.
- **Never rewrite a ledger row.** Append-only; migration is close-and-re-emit.
- **Schema before field.** `propagates.schema.json` is
  `additionalProperties: false` — a sidecar gaining an undeclared field is
  rejected silently and every edge in it stops firing.
- **Never edit a downstream automatically.**
- **Re-run `status` after closing.** If the row is still there, you wrote to
  the wrong ledger.
