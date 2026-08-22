# eng — the instrument half

*Section of the parent skill — Read this file when the situation below applies. It is deliberately NOT a discoverable skill: as one it declared the bare name `eng`, which squats a generic global name.*

**When this applies:** Use when you need to run a curate-docs command and aren't sure which mode answers your question, or when a run refused, printed a surprising count, or flagged a citation you believe is fine. Triggers on "which curate-docs mode", "curate-docs returned 0 orphans", "why is this reported dangling", "the doc report looks wrong", "curate-docs exited 4".

Parent skill: `curate-docs` (premise, pipeline, Contract). This skill is how to drive the
tool and how to tell a real finding from an artefact of the instrument.

Deciding what a verdict *means* — should this doc exist, did the plan ship — is the
`design` skill.

## Which mode answers which question

```bash
node ~/.claude/skills/curate-docs/cli.mjs <mode> <dir> [--extra-root <workspace>]
```

| Mode | Answers |
|---|---|
| `report` (default) | the whole map — every doc, its verdict |
| `orphans` | which docs nothing cites |
| `detached` | which are cited only from outside every entry point's reach |
| `dangling` | which citations resolve nowhere |
| `graph` | the link graph itself; `--json` is the only count worth trusting |
| `state` | the derived lifecycle view (also the writer — see below) |
| `impact` | what orphans if this doc stops citing (`design` owns when to run it) |
| `drain` | `git rm`, once the preconditions hold |

Flags: `--json` · `--stale-days N` · `--out PATH` · `--extra-root DIR` ·
`--exclude-unreviewed` · `--apply`

## The two writes

```bash
curate-docs state <doc> --set archived   --because shipped|dropped|merged-forward --apply
curate-docs state <doc> --set superseded --superseded-by <path> --apply
curate-docs drain <doc> --apply      # git rm; recoverable from history
```

`state` writes frontmatter keys only. `active` is the default and carries no key, so only
non-default states appear in the diff.

`drain` **enforces** two preconditions: the status is declared `archived`/`superseded`, and
`impact` reports the doc is not the sole caller of anything. You cannot delete what you have
not declared dead.

## Configuration

`.curate-docs.yml` in the repo, `~/.curate-docs.yml` for defaults. **`skipDirs` merges, it
does not replace.**

**Pass `--extra-root <workspace>` for any sub-repo.** Without it, correct cross-repo
citations like `../STATE.md` are misreported.

## Refusals are typed, never quiet

- **exit 4** — no reachable hub. Grading is suppressed **and the reason is printed**,
  because with no hub every doc would read as an orphan.
- **exit 5** — an Obsidian vault (a `[[wikilink]]` corpus this extractor cannot see), or a
  `drain` precondition failure.

**`0 orphans` from a suppressed run is not a clean run**, and the tool says so. Read the
refusal line before reading the count.

## How citations resolve

**resolved** · **external** (outside the repo — fine) · **ambiguous** (the basename exists
but the written path does not resolve — usually a real wrong path, not noise) · **dangling**
(resolves nowhere). *Citations that lost their path* names the single obvious target when
there is one — the signature of a moved file.

## When a count surprises you

| Symptom | Cause |
|---|---|
| A second tool disagrees | a basename `rg` reported a true orphan as "mentioned in 5 files" — all five were *other* `README.md`s, one in `node_modules`. Count from `graph --json`. |
| Sub-repo citations all look broken | missing `--extra-root` |
| `ambiguous` dismissed as noise | usually a real wrong path — `STATE.md` citing `` `DESIGN.md` `` when the file is at `docs/design/DESIGN.md` |
| `0 orphans` read as healthy | it means every doc has a caller. It says nothing about whether any is true. |

## Known limits — read before reporting a clean run

- **Backticked paths containing a space are never matched.** Workspace dirs here have spaces
  (`Vipin Kaushik/`), so some real broken citations are invisible (`docs/GOTCHAS.md` G8).
- **A path quoted as an example is indistinguishable from a citation** — docs *about* paths
  report high dangling counts that are not defects (G11).
- **Only `.md` is graphed**; code citations are propagate's job. `.mdx`/`.rst`/`.adoc` are
  out of scope — measured, zero authored in this tree.
- **Obsidian vaults are refused, not supported.**
- **Staleness resets on a typo fix**, `introducedBy` is weak in squash-merging repos, and
  anchors are never validated. Provenance is capped at 60 flagged docs and says so.
- `docs/GOTCHAS.md` holds 19 instrument failures paid for during these two phases. Read it
  before trusting a surprising number.
