> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# propagate — Release

How a release is cut. Mechanics only, as of the plan that scoped this doc
(`~/.claude/plans/status-temporal-plum.md` §3): this defines the procedure and
gives it a machine-checkable preview (`release --check`). **It does not
publish anything, and it is not meant to yet** — see "Why step 5 has no
flag" below.

## Which bump (#234)

A version number says what KIND of release it is, and the kind is derived from the commits, not curated. Three
published standards are followed; propagate builds them in-repo (`lib/core/release-kind.mjs`) rather than adopting
release-please, and the choice is recorded so a later move is a configuration change:

- **[Semantic Versioning 2.0.0](https://semver.org/)**, item 4: *"Major version zero (0.y.z) is for initial
  development. Anything MAY change at any time."* So before 1.0 the second number carries the weight.
- **[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)**: `fix` is PATCH, `feat` is MINOR,
  and `!` after the type or a `BREAKING CHANGE:` footer is MAJOR whatever the type. Other types do not change the
  version on their own.
- **[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)**: *"Changelogs are for humans, not machines,"*
  with an `Unreleased` section at the top. `CHANGELOG.md` follows it.

**The rule, pre-1.0** (release-please's `bump-minor-pre-major`):

| The commits since the last `v*` tag hold | The release is | Example from 0.15.59 |
|---|---|---|
| any `feat`, or any breaking change (`!` / `BREAKING CHANGE:`) | **minor** (patch resets to 0); a breaking one is also listed under Breaking | `0.16.0` |
| only `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `build`, `ci`, `style`, `revert` | **patch** | `0.15.60` |
| nothing | no release | |

From 1.0, a breaking change is **major**. A bump ABOVE the requirement is allowed; below it is refused. A subject with
no recognised prefix is **listed by name and never counted as a fix**.

**Where it is enforced.** At `release --check` time the release commit does not exist yet, so its type cannot be read
from git; the type and the staged `VERSION` change meet only when the commit is written. So:

- **`.githooks/commit-msg` (blocking)**, only when `VERSION` is staged: it classifies the commits since the last
  `v*` tag AND this commit's own message (a `BREAKING CHANGE:` footer in the body counts), and refuses a bump below
  the requirement, naming the version needed. Bypass, knowingly: `PROPAGATE_SKIP_RELEASE_KIND=1 git commit ...`
  (the refusal says so). The repo's `core.hooksPath` already points at `.githooks`.
- **The `release-kind` gate in `release --check`** reports what it can see: the committed range and `VERSION` against
  the last tag. It fails on a `VERSION` equal to the tag while commits exist since it, and on a bump below what the
  committed subjects need. It states in its detail that the pending commit's own type is checked by the hook.

## The steps

```
0. notes written            → release notes --write --version X, inside the release commit
1. VERSION bumped           → check names the four in-repo manifests (a hub manifest is optional, see below)
2. suite green on the floor → CI matrix; node 20 is the below-floor probe, expected to fail
3. make-public --check      → scrub complete, watchlist satisfied, else refuse
4. stranger install         → HOME=$(mktemp -d): setup → bootstrap → doctor clean
5. human publishes          → never the tool
6. GitHub Release           → gh release create vX --notes-file <section>, by the person publishing
```

Steps 1-4 are `node cli.mjs release --check` — see below. Steps 5 and 6 are a person, on purpose.

### 0 · Notes

`node cli.mjs release notes` prints a Keep a Changelog draft of the commits since the last tag (`--since <tag>` to
choose another). `--write` fills or refreshes `## [Unreleased]` at the top of `CHANGELOG.md`, grouped Breaking /
Added (`feat`) / Fixed (`fix`) / Changed (everything else), as raw material a person edits.
`--write --version X` releases it: `[Unreleased]` becomes `## [X] — YYYY-MM-DD` (the text already there is kept; an
empty one is filled from the commits), a fresh empty `[Unreleased]` opens above it, and it refuses if `[X]` exists.
It covers COMMITTED work, which is why a release is **two commits**, the same shape release-please produces:

1. **The work**: one or more `feat:` / `fix:` / … commits, with `VERSION` left alone. The commit-msg hook does not
   fire, because `VERSION` is not staged.
2. **The release**: `chore(release): vX.Y.Z`, holding `VERSION` and its manifests, the impact-map refresh, and the
   `CHANGELOG.md` section that `release notes --write --version X.Y.Z` builds from step 1's commits. The hook checks
   this commit's bump against those commits, so a `feat:` among them requires the minor bump. **This is the commit the
   tag goes on.**

One commit carrying both the work and the bump would leave the work out of its own notes. Avoid it.

### The tag sits on the release commit

The tag goes on the commit that bumps `VERSION`, never on a follow-up. The impact-map refresh that `release --check`
writes is staged INTO the release commit; v0.15.53's tag landed on a separate `chore(test-impact)` commit instead.
Check it after tagging with `git describe --tags --exact-match HEAD`, which must print the new tag. **`--tags` is
required: propagate's tags are lightweight, and plain `git describe --exact-match` only matches annotated ones**
(it failed on v0.15.59).

### 1 · VERSION bumped

`VERSION` is the single fact; `.propagates.yml` declares its fan-out to three
manifests that must agree with it: `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`.

**Delivery (changed 2026-10-17).** propagate loads in place from this repo: the repo is its own
directory marketplace (`claude plugin marketplace add <this repo>`, then `claude plugin install
propagate@propagate`), so Claude Code serves the working tree. There is no `claude plugin update`
and no hub manifest bump; after a release, run `/reload-plugins` in open sessions. The hub's
`skills-marketplace/` no longer lists propagate, so a fifth manifest only exists on a machine that
still has one (`release --check` reports it as optional). Before 2026-10-17 the hub manifest was the
one `claude plugin update` read: releases 0.15.17-0.15.21 skipped it and the installed plugin stayed
on 0.15.16 for 18 days (2026-10-13). A bump that misses one ships a plugin whose
manifest version does not match its code, or a marketplace listing that lags
what a stranger actually receives. `release --check` reads all four files
directly and reports the exact values when they disagree — it does not defer
to `check`/`reconcile`'s git-diff machinery, because this gate must answer
"do these four files agree right now," not "did this edge fire on the last
commit."

### 2 · Suite green on the floor

The authoritative measurement is `.github/workflows/test.yml`'s matrix — node
20, 22, and 24, with 20 kept in deliberately as the **below-floor probe**: it
is *expected* to fail (`fs.globSync` is the binding constraint, landed in
Node 22), and a matrix where everything passes would tell you nothing about
where the floor actually is. `engines.node` in `package.json` may only claim
what that matrix has measured.

`release --check`'s suite gate runs `npm test` once, on whatever node this
machine has — a single-version local signal, not the floor matrix. It says so
in its own output rather than implying otherwise. Treat a green local run as
"nothing regressed here," and the CI matrix as the actual floor evidence
before tagging a release.

### 3 · `make-public --check`

`scripts/make-public.mjs --out <dir> --check` builds the scrub in memory (never
writing) and refuses if any forbidden pattern — a home-dir username, an
absolute macOS path — survives, or if the identity map's watchlist is
incomplete (a client-workspace directory with no pseudonym). It reads
`$PROPAGATE_STATE_DIR/identity-map.json`, which lives **outside this repo on
purpose**, so it can never itself be published.

**Exit 2 (no identity map, or an empty one) is a refusal, not a failure.**
CI runs with no map by design — the map is operator-local — so CI's own job
asserts the refusal itself (`.github/workflows/test.yml`, "the public build
would be clean") rather than a clean scrub. `release --check` reports that
same exit 2 as **could-not-run**, distinctly from a scrub that ran and found
violations (**failed**) and one that ran clean (**passed**). Collapsing those
three into two would let "nobody has configured this machine to publish"
read as either a pass or a failure, and it is neither.

### 4 · Stranger install

A person who has never touched this machine, following exactly the sequence
in `SKILL.md` § Setup (`npm install` is assumed done; then `setup --roots`,
`bootstrap --baseline-from-git --apply`, `doctor`) against an isolated
`HOME=$(mktemp -d)`, must end up with a clean `doctor`. This is the gate that
would have caught "installs, finds nothing, reports success" before the
`setup` command existed to prevent it (`docs/DECISIONS.md`,
`tests/portability/fresh-machine.test.mjs`).

`release --check` runs this for real against a throwaway git-initialized demo
workspace with one declared edge (so `bootstrap` has something to baseline),
under an isolated `HOME` — never against your real install. It reports
whatever `doctor`'s actual exit code says. **This gate does not force a
pass**: if a genuinely fresh workspace cannot reach a clean `doctor` today,
that is real information about the rest of the tool, and papering over it
here would be exactly the failure `rule:discernment-checks` exists to catch.

### 5 · A human publishes

**Deliberately not automated, and there is no `--apply` flag anywhere in
`lib/core/release.mjs` to make it one.** Two reasons, both load-bearing:

- **Git history is permanent.** A push cannot be un-sent the way a bad file
  write can be reverted. The one-way-door rules this skill already follows
  for its own ledger (`rule:model-routing`, `docs/GOTCHAS.md`) apply at least
  as hard to a public release.
- **This skill's own premise is "it reports, a human acts."** `SKILL.md`'s
  identity block says propagate "never edits a downstream; it tells a
  human." A `release --publish` command would violate that premise for the
  one artifact it would be most consequential to violate it for — the
  skill's own public copy of itself.

So step 5 stays a person, reviewing the tree `make-public.mjs` (without
`--check`) writes, and pushing it by hand.

### 6 · A GitHub Release

After the person has pushed and tagged, they publish the same text as a GitHub Release:

```
awk '/^## \[X\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md > /tmp/notes-X.md   # the [X] section
gh release create vX --notes-file /tmp/notes-X.md --title vX
```

Like step 5 it is not automated: it is outward-facing.

## `release --check`

```
node cli.mjs release --check [--json]
```

Runs gates 1-4 above, plus `release-kind` (see "Which bump") and `plugin-validate` (Claude's own `claude plugin validate --json` on this plugin,
read by `lib/core/plugin-validate.mjs`; the one pinned warning is the `skills/propagate/SKILL.md` symlink, #98), and exits:

| Exit | Meaning |
|---|---|
| `0` | **ready** — every gate passed. |
| `1` | **blocked** — at least one gate failed. |
| `2` | **incomplete** — no gate failed, but at least one could not run (e.g. no identity map on this machine). Never conflated with "ready." |

Each gate reports one of `passed` / `failed` / `could-not-run` (or `skipped`, only for `plugin-validate` when
the `claude` CLI is not installed: stated, and it does not block), always with a
reason or detail line — never a bare status. The `suite` gate reads node:test's junit reporter for both suites
(`npm test` runs `test:propagate` then `test:curate-docs`), sums them, and names failing tests. `--json` emits the full
structured result (`lib/core/release.mjs`'s `runReleaseCheck`).

**It records each run.** After the gates finish, `release --check` (and only that
mode: a usage error never records) appends one line to `release-checks.jsonl` in the
state dir (`$PROPAGATE_STATE_DIR`, default `~/.propagate`):
`{ts, version, overall, exitCode, gates:[{name, status, detail | reason}]}`. `ts` is
the result's `generatedAt`; detail strings are stored whole and a gate's raw child
output is not. The file is append-only and the dashboard's History page reads it.
The write is the command's (`releaseCmd` in `cli.mjs`, via `lib/core/release-record.mjs`),
never `runReleaseCheck`'s, so the release tests cannot write state. A failed write prints a
`warning:` line to stderr and changes neither the verdict nor the exit code. A run killed
before its gates finish records nothing; History lists it from the command ledger as
"exit status only".

## What this does not cover — the two-repo coupling

`RELEASE.md` step 3 is the only thing standing between the private working
copy (this repo) and the public release copy diverging. **It is a
documented procedure, not a propagate-tracked coupling.** propagate cannot
declare the private→public edge until the public repo exists and is added to
`cross-allow.yml`'s `partner_roots` (currently `[]` by design). See
`docs/ISSUES.md` N38 for the honest accounting of that gap — do not read
`make-public --check` passing as evidence the coupling is watched; it is
evidence the scrub is clean *this run*, which is a narrower claim.
