---
name: propagate
description: Manage the propagation ledger — drain open drift events, check system health (event store + reconcile — the retired watcher's replacement), declare sidecars, init new directories. Triggers on "/propagate", "drain propagation", "what depends on this", "propagation status", or any reference to PROPAGATION_LEDGER.
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

**The v1 launchd watcher is retired (2026-08-14; `docs/DECISIONS.md`).** The
background `com.tathya.propagate.watcher` (`StartInterval 60`) that used to
detect drift by remembering file mtimes is gone — measured 4,420 runs, 4,384
no-ops (99.2% found nothing), and its state baseline caused two incidents in
one day. Drift is now derived from content, on demand: run `reconcile` (or
let `check` / the daily digest run it for you) instead of waiting for a
background fire. `watcher.mjs` stays on disk as history and refuses to run
directly. The one thing this trades away is sub-daily proactive
notification — nothing pings you mid-day anymore; see `docs/DECISIONS.md`
2026-08-14 for the full tradeoff. `doctor` and the digest report the
replacement's health (event store + reconcile), not the retired watcher's.

## Contract

- **Only stop for:** a `drain`-style decision (apply / defer / wontfix a row),
  a `declare` edit to a `.propagates.yml` sidecar, or a genuine one-way door
  (migrating ledger rows, or anything touching launchd/plists — the v1
  watcher was one such one-way door; see the retirement note below).
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
| you're dividing this work up, or asking what state a hazard is in and how it leaves | `docs/LIFECYCLE.md` |

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
- **`doctor`** — health check: v2 event store readable + non-empty and
  `reconcile` completes (the retired watcher's replacement — its plist/
  heartbeat checks are now informational only, never a failure), sidecar
  schema validity, ledger parseability.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs doctor
  ```
- **`init <dir>`** — scaffold an empty `.propagates.yml` at `<dir>`. Does
  **not** touch the plist or launchd — run `reload` after, if the watcher
  were still live (it isn't; see the retirement note above — `reload`
  regenerates the now-retired watcher's plist and has no live purpose today).
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
- **`graph`** — the DAG over the declared couplings, derived from `reconcile`.
  Read-only. Leads with the **fix order**: every actionable edge sorted by its
  source's layer, so working top to bottom never pins a downstream against a
  source that is itself unsettled. Also names the structural defects a
  per-edge view cannot see — cycles, the same pair declared twice, globs
  matching nothing.
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs graph                      # this workspace
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs graph --all                # every workspace
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs graph --node <path>        # upstream + downstream of one file
  node ${CLAUDE_PLUGIN_ROOT}/cli.mjs graph --all --html out.html  # self-contained page
  ```
  `NEVER_VERIFIED` edges are excluded from the worklist by default
  (`--include-unverified` to show them) — they are a baseline gap, not
  movement. They still count as unsettled when deciding what blocks what, and
  the excluded count is always printed.
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
parallel-coordination behaviour, not a nicety. (v1 rows: when the — now
retired — watcher fired from a non-canonical worktree, rows carried
`correlation_id` (`<repo>:<path>`, e.g. `VipinKaushik:lib/pricing.ts`) and
`source_worktree` (`{branch, commit}`); those rows and this grouping logic
are unaffected by the retirement and `drain --group` still works on them.)
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

- **`verify` is dry-run by default. `--apply` writes.** This holds for every
  disposition, not just `decoupled`. Before 2026-08-17 it gated only the
  `decoupled` sidecar edit and the other seven wrote on invocation — which cost
  11 events asserting verifications nobody performed (`docs/GOTCHAS.md` G44).
  The preview runs the real validator, so a refusal shown in the dry run is a
  refusal `--apply` would also give.
- **Fix root-to-leaf.** Verifying an edge whose source is itself an unsettled
  downstream pins content against a source nobody has confirmed. `verify`
  refuses with exit 3 and names every blocking upstream; `--out-of-order`
  overrides when you mean it. `deferred` and `decoupled` are exempt (neither
  pins); `wontfix` and `baselined` are **not**. `graph` prints the whole
  worklist already ordered.
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
