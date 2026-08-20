> Entry point: [`../SKILL.md`](../SKILL.md) · Index: [`README.md`](./README.md)

# propagate — Release

How a release is cut. Mechanics only, as of the plan that scoped this doc
(`~/.claude/plans/status-temporal-plum.md` §3): this defines the procedure and
gives it a machine-checkable preview (`release --check`). **It does not
publish anything, and it is not meant to yet** — see "Why step 5 has no
flag" below.

## The five steps

```
1. VERSION bumped           → check names all three manifests (the declared fan-out)
2. suite green on the floor → CI matrix; node 20 is the below-floor probe, expected to fail
3. make-public --check      → scrub complete, watchlist satisfied, else refuse
4. stranger install         → HOME=$(mktemp -d): setup → bootstrap → doctor clean
5. human publishes          → never the tool
```

Steps 1-4 are `node cli.mjs release --check` — see below. Step 5 is a person,
on purpose.

### 1 · VERSION bumped

`VERSION` is the single fact; `.propagates.yml` declares its fan-out to three
manifests that must agree with it: `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`. A bump that misses one ships a plugin whose
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

`bin/make-public.mjs --out <dir> --check` builds the scrub in memory (never
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

## `release --check`

```
node cli.mjs release --check [--json]
```

Runs gates 1-4 above and exits:

| Exit | Meaning |
|---|---|
| `0` | **ready** — every gate passed. |
| `1` | **blocked** — at least one gate failed. |
| `2` | **incomplete** — no gate failed, but at least one could not run (e.g. no identity map on this machine). Never conflated with "ready." |

Each gate reports one of `passed` / `failed` / `could-not-run`, always with a
reason or detail line — never a bare status. `--json` emits the full
structured result (`lib/core/release.mjs`'s `runReleaseCheck`).

## What this does not cover — the two-repo coupling

`RELEASE.md` step 3 is the only thing standing between the private working
copy (this repo) and the public release copy diverging. **It is a
documented procedure, not a propagate-tracked coupling.** propagate cannot
declare the private→public edge until the public repo exists and is added to
`cross-allow.yml`'s `partner_roots` (currently `[]` by design). See
`docs/ISSUES.md` N38 for the honest accounting of that gap — do not read
`make-public --check` passing as evidence the coupling is watched; it is
evidence the scrub is clean *this run*, which is a narrower claim.
