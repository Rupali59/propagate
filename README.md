# propagate

**Some files have to move together.** A pricing constant and the doc that quotes it. An
env var and the client that reads it. A rule and the twelve files that restate it. Nothing
in git knows that, so the second file goes stale quietly and you find out later, from a bug.

propagate lets you **declare those couplings**, derives drift **from content on demand**,
and records every verification in an **append-only ledger**.

**It never edits a downstream file.** Every close, edit and dismissal is a human making the
call. The ledger is a record of that decision, not an automation that makes it.

## Install

As a Claude Code plugin (Claude Code 2.1.275+):

```
/plugin install propagate --marketplace Rupali59/propagate
```

From a clone, for use outside Claude Code too:

```bash
git clone https://github.com/Rupali59/propagate-skill
cd propagate-skill && npm install
node cli.mjs setup --roots ~/path/to/your/code
node cli.mjs bootstrap --baseline-from-git --apply
node cli.mjs doctor
```

`setup` **exits non-zero unless discovery then finds at least one workspace** — an install
that reports success while finding nothing is the exact failure this tool exists to catch.

**Step 3 is the one people miss.** `setup` succeeding is a *configured* install, not a
finished one: nothing is verified yet, and `doctor` stays red until you baseline.

## Declare a coupling

A `.propagates.yml` beside the file:

```yaml
workspace: true
sources:
  docs/PRICING.md:
    propagates_to:
      - path: lib/pricing.ts
        why: the constant must match the published price
        kind: code          # bidirectional: the code moving fires back at the doc
```

`kind: prose` is one-directional. `path` may be a glob.

## Use it

```bash
node cli.mjs status      # open drift, this workspace
node cli.mjs check       # commit-time gate: changed a source, didn't change its downstream?
node cli.mjs graph       # the DAG, led by a root-to-leaf fix order
node cli.mjs doctor      # health check
node cli.mjs drain       # walk open rows and close them
```

Wire `check` into a pre-commit hook and it warns before the coupling goes stale rather
than after.

## It watches itself

The clearest example is its own release version, which lives in four files:

```yaml
sources:
  VERSION:
    propagates_to:
      - { path: package.json, ... }
      - { path: .claude-plugin/plugin.json, ... }
      - { path: .claude-plugin/marketplace.json, ... }
```

Bump `VERSION` and forget a manifest, and `check` names the ones you missed at commit
time. Before that edge existed, the same mistake produced silence.

## What it covers

The command surface is grouped into these areas, and `propagate help` lists the same groups:

- **Is anything drifting?** read-only views of declared couplings, goals, plans, services and docs.
- **Settle drift** the gates and verbs that record a human's decision on an edge.
- **Health and release** the glance, doctor, usage, cost, sprint and release checks.
- **Set up and move things** install, scaffold, migrate, roll up and broadcast.
- **Who works where** live sessions and the work queue.
- **Skills** the skill census and lifecycle.
- **Claims and reminders** checking what documents assert, and reminders.

## Commands

The list below is generated from the command table (`lib/core/commands.mjs`); do not edit it by hand.
Regenerate it with `npm run readme:commands`.

<!-- commands:start -->

**Is anything drifting?**

- `propagate status` — are any declared file couplings drifting
- `propagate check` — drift check scoped to a change (--changed, --range, --staged)
- `propagate reconcile` — derive every edge's state from the ledger and the files
- `propagate why` — explain one edge: what declared it and what happened to it
- `propagate queue` — the disposition backlog, once, as text or JSON
- `propagate surface` — edges, registers and machinery health as one payload
- `propagate backlog` — open work recorded across STATE, TODOS and handovers
- `propagate goals` — arrival conditions declared across the tree
- `propagate goals allow` — approve one goal's exact Derived by: command so check-done may run it
- `propagate goals check` — standing check: active-goal limit, appetite and retro, board items carry an active goal and their fields; exit 0 pass, 1 violations, 2 could not check
- `propagate goals check-done` — run the approved Derived by: commands; exit 0 = met; writes Resolved only with --apply
- `propagate services` — which units use which external service, and what is wrong with how each is described (offline)
- `propagate kb standards` — which standards apply, which rows need re-verifying against the tool version in use (offline; status is derived, never written)
- `propagate kb standards versions` — the cached tool versions; --refresh runs each registry probe and writes them (the only command that spawns a tool)
- `propagate kb standards adopt` — record that a project adopted a standard in its sidecar (dry run unless --apply; detection proposes, adoption stays)
- `propagate kb standards decline` — record that a detected standard does not apply to a project, with a reason (dry run; --apply needs approvals, slice S4)
- `propagate kb standards remove` — record the removal of an adopted standard, with a reason (dry run; --apply needs approvals, slice S4)
- `propagate kb migrate` — rename each sidecar's legacy standards: key to kb: (dry run unless --apply; a sidecar with both keys is a conflict and is never rewritten)
- `propagate kb references` — the knowledge base's outside sources, ids shown as ref:<id> (offline)
- `propagate kb search` — search the standards rows, references and evaluator's registers in one derived pass (no index); hits are std:/ref:/reg: with path:line and checked date
- `propagate standards` — deprecated: which standards apply, which rows need re-verifying against the tool version in use (offline; status is derived, never written)
- `propagate standards versions` — deprecated: the cached tool versions; --refresh runs each registry probe and writes them (the only command that spawns a tool)
- `propagate standards adopt` — deprecated: record that a project adopted a standard in its sidecar (dry run unless --apply; detection proposes, adoption stays)
- `propagate standards decline` — deprecated: record that a detected standard does not apply to a project, with a reason (dry run; --apply needs approvals, slice S4)
- `propagate standards remove` — deprecated: record the removal of an adopted standard, with a reason (dry run; --apply needs approvals, slice S4)
- `propagate plans` — plan documents and their lifecycle
- `propagate docs` — document kinds, structure and supersession
- `propagate journal` — ledger events in a time window

**Settle drift**

- `propagate settle` — one file's worklist and the exact verify commands (read-only)
- `propagate check-curator` — the doc-curator gate: refuse unquoted, misquoted or structural claims; passing claims are inferred (read-only)
- `propagate check-review` — the adversarial-reviewer gate: coverage of declared edges, real file:line, demos re-run through the agent guard (read-only)
- `propagate verify` — record a disposition on an edge (dry-run unless --apply)
- `propagate rekey` — carry an edge's history to its new id after a reworded why or a renamed file (dry-run unless --apply)
- `propagate drain` — list and close open propagation rows
- `propagate graph` — the fix-order worklist, or one file's neighbourhood (--node)
- `propagate bootstrap` — turn NEVER_VERIFIED edges into an honest baseline
- `propagate ui` — local web UI over the disposition queue

**Health and release**

- `propagate glance` — what is working, what is broken, what needs you, from files already written (never reruns reconcile or doctor; exit 0 working, 1 broken or needs you, 2 nothing to read)
- `propagate glance ack` — acknowledge glance items, or snooze them with --until: shown as acked, not notified, verdict unchanged
- `propagate glance unack` — remove an acknowledgement or snooze from glance items
- `propagate doctor` — health checks over the install, workspaces and ledgers
- `propagate monitor` — one monitor pass (--dry-run to preview)
- `propagate usage` — which commands are run and how often they fail (--backfill derives history from transcripts)
- `propagate release` — release gate checks (--check); never publishes
- `propagate release notes` — Keep a Changelog draft from the commits since the last tag (--write fills CHANGELOG.md; --write --version X releases it)
- `propagate caps` — context-budget caps derived tree-wide (report only)
- `propagate instructions` — per-directory session instruction budget (--calibrate against a load log)
- `propagate hooks instructions-gate` — add the instruction-budget gate to every repo tracking CLAUDE.md/AGENTS.md/GEMINI.md (dry run; --apply)
- `propagate context` — gotcha-guard injection volume per compaction window, from a session transcript
- `propagate search-usage` — external-search use per source, failures by kind, ToolSearch loads and repeat rate, from session transcripts (read-only; exit 2 on a blind scan)
- `propagate costs lanes` — lane cost rows grouped by agent_type, last row per agent, lanes that ran commands in the background flagged (read-only)
- `propagate costs window` — tokens and minutes for a window of a main-session transcript, between two anchors (read-only)
- `propagate day open` — is there enough Ready work for today's budget, across every board (read-only)
- `propagate day close` — groom the boards for tomorrow: promotions, refusals, closed-not-Done, cost gaps (writes only with --apply)
- `propagate sprint plan` — does the Ready work fit the usage left until the sprint ends: budget in week-% points, uncalibrated Sizes counted not summed (read-only)
- `propagate sprint review` — done against planned per board for the last ended Sprint, calibration gain, missing cost fields; carry-over moves only with --apply (read-only by default)
- `propagate rules` — canonical-rules lifecycle: list, check, selftest, promote
- `propagate inventory` — what was built: skills, plugins, repos, standalone artifacts, with status (read-only)

**Set up and move things**

- `propagate setup` — install and configure propagate
- `propagate init` — scaffold a sidecar in a directory
- `propagate reload` — regenerate the v1 watcher plist (obsolete since 2026-08-14)
- `propagate manifest` — how to stand a workspace up on another machine
- `propagate migrate` — move a workspace to the v3 layout (dry-run unless --apply)
- `propagate migrate-refs` — migrate a workspace's ref snapshots (dry-run unless --apply)
- `propagate migrate-ledger` — copy a ledger to the v3 layout (dry-run by default)
- `propagate relocate-ledger` — relocate a ledger (dry-run by default)
- `propagate freeze-ledger` — freeze a v1 ledger (dry-run by default)
- `propagate registers` — issue and todo registers
- `propagate rollup` — generate the ecosystem rollup
- `propagate graph-index` — emit the graph as sqlite or cypher
- `propagate tasks` — move open TODOS/ISSUES register entries to GitHub issues (read-only plan; --apply creates the issues and delegates the register)
- `propagate broadcast new` — publish one piece of work to many workspaces: a hub parent issue and one child per repo (dry run unless --apply)
- `propagate broadcast status` — progress of each open broadcast, folded from GitHub sub-issues; exit 2 when GitHub could not be read

**Who works where**

- `propagate sessions` — which Claude Code sessions are live, in which folder, on which goal and item (read-only; reads claude agents --json)
- `propagate sessions show` — one session: live row, association and history, repos, guidance files, and the next command
- `propagate sessions assoc` — record which goal and board item a live session serves (the one write; --from derives the goal from the dispatch snapshot)
- `propagate sessions new` — start a background Claude Code session on a board item: folder, goal and name derived (dry run unless --apply; --apply runs claude --bg, never with a bypass flag)
- `propagate sessions stop` — stop a background session (claude stop); --force sends SIGTERM to an interactive session by its pid, re-verified first (dry run unless --apply)
- `propagate sessions rm` — remove a stopped or done background session (claude rm; dry run unless --apply)
- `propagate work list` — the work event queue: items by kind and state; never prints a claim token (propagate#150)
- `propagate work sync` — make the queue match the open labelled issues of the hub repo (reads GitHub; writes only the local queue)
- `propagate work claim` — take the oldest pending item of a kind for this session; prints the token ack and release need
- `propagate work ack` — finish a claimed item (needs the claim's --token)
- `propagate work release` — give a claimed item back; --refusal counts toward parking (needs the claim's --token)
- `propagate work unpark` — return a parked item to pending
- `propagate work prune` — delete acked and expired items and their events older than --older-than days (dry run unless --apply)

**Skills**

- `propagate skills` — skill census
- `propagate skills-create` — create a skill from an intent
- `propagate skills-promote` — promote a skill
- `propagate skills-demote` — demote a skill
- `propagate skills-reap` — reap dormant skills

**Claims and reminders**

- `propagate claims check` — check claims
- `propagate claims judge` — judge claims in a file
- `propagate claims render` — render claims into a file
- `propagate claims contradict` — find claims contradicting an authored file
- `propagate claims restate` — find restated claims
- `propagate claims verdict` — apply verdicts read from stdin
- `propagate claims answer` — record a run's answer
- `propagate reminders` — reminders read path
- `propagate reminders sync` — sync reminders (dry-run unless --apply)

<!-- commands:end -->

## Design notes

- **State is derived, never stored.** An observation is only valid for the content it was
  made against, so a file changing invalidates its own verification. Nothing to keep in sync.
- **The ledger is append-only.** Migration is close-and-re-emit, never rewrite.
- **Absence is attributable.** "No result" and "no result *because*" are different facts,
  and the output always says which.
- **A red `doctor` is doing its job.** Fix the data; never tune the check until it passes.

## Docs

| File | For |
|---|---|
| `SKILL.md` | The skill contract, modes, and rules |
| `docs/REFERENCE.md` | Exact paths, flags, install sequence |
| `docs/GOTCHAS.md` | What these mistakes cost last time |
| `docs/ISSUES.md` | Known defects, with severity and evidence |
| `docs/DECISIONS.md` | Why it works this way (append-only) |

`docs/GOTCHAS.md` is the unusual one: ~50 entries, each with the signal you'd see and what
it cost. Most of this tool's design is downstream of something in that file.

## Where its state lives

Everything propagate records is in `~/.propagate/`: the append-only verification ledger, `config.yml`, the
identity map used to scrub the public tree, and the journals of runs such as `release --check` and
`tasks export`. Set `PROPAGATE_STATE_DIR` to put it elsewhere; the test suite does, so tests never touch your
real store.

That is the tool's runtime state. The project's *working* state — its STATE, DECISIONS, GOTCHAS, ISSUES and
TODOS registers, and its plans and audits — is not in this repository: it is public and carries only the tool,
so those documents live in a private repo that surrounds a maintainer's checkout. The files you find at
`propagation/state/workspace/`, `docs/DECISIONS.md` and `docs/plans/` are short pointer stubs saying so; tests that
read the moved files skip, with the reason printed, when that private copy is not beside the clone. The branch
registry (`propagation/refs/`) is machine-local and gitignored: `propagate migrate-refs <workspace> --apply`
writes it.

It is deliberately **not** in Claude Code's `${CLAUDE_PLUGIN_DATA}`. That directory is meant for caches and
installed dependencies and is deleted when the plugin is uninstalled, while the ledger is a record that has to
survive an uninstall — and propagate also runs outside Claude Code (from a shell, or on a schedule), where that
variable does not exist.

## Requirements

Node — see `engines` in `package.json` (22.13 or later). `node:sqlite` (the work queue's store, experimental on the 22.x line) is the binding constraint; `fs.globSync` (22.0) is looser.

## Licence

MIT.
