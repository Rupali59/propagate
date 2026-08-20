# propagate

**Some files have to move together.** A pricing constant and the doc that quotes it. An
env var and the client that reads it. A rule and the twelve files that restate it. Nothing
in git knows that, so the second file goes stale quietly and you find out later, from a bug.

propagate lets you **declare those couplings**, derives drift **from content on demand**,
and records every verification in an **append-only ledger**.

**It never edits a downstream file.** Every close, edit and dismissal is a human making the
call. The ledger is a record of that decision, not an automation that makes it.

## Install

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

## Requirements

Node — see `engines` in `package.json`. `fs.globSync` is the binding constraint.

## Licence

MIT.
