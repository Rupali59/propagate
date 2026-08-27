# GOTCHAS — curate-docs

What will bite you here, and what it cost. Every entry below was paid for during the
build on 2026-08-19; none is hypothetical.

Format per `rule:every-project-carries-gotchas`. An entry opts into `gotcha-guard.mjs`
delivery by declaring a `**Trigger:**`; most of these have no mechanical trigger and
correctly have none — inventing one makes noise.

---

### G1 · `node --test tests/` silently fails to discover a directory
**Trigger:** `node\s+--test\s+[A-Za-z0-9_./-]+/\s*$`
**Fires on:** `node --test tests/`
It exits non-zero with `MODULE_NOT_FOUND` and an empty `requireStack`, which reads as
"your code is broken" when it means "I did not find any tests". Use the glob form:
`node --test 'tests/*.test.mjs'` (quoted, so node expands it, not the shell).
**Cost:** ten minutes debugging a `link-graph.mjs` that was already correct. Classic
`rule:discernment-checks §4` — the instrument answered a different question.

### G2 · Four of the first mutations proved nothing, because the fixture lacked the input
Removing the self-link guard left **9/9 green**. Enabling the unique-basename fallback
left **9/9 green**. Both tests were vacuous: no fixture doc cited itself, and no dangling
citation had a basename that existed elsewhere. A check that cannot fail reports success
(`rule:discernment-checks §1`).
**The fix is a fixture input, not a better assertion.** `docs/specs/api.md` now cites its
own path; `docs/cluster/a.md` now carries a citation that escapes the repo root.
**Cost:** would have shipped two decorative tests guarding the two rules most likely to
be "simplified" away later.

### G3 · A module-level cache makes the loud-failure path unreachable
`loadTaxonomy` cached in a bare `let cached`. Once any successful load had happened, the
absent-propagate branch could never run again in that process — so the test asserting a
loud failure passed only when run first. Cache **per resolved candidate set**.
**Cost:** caught by the test on its first run. The shape is general: any memoised
resolver whose failure path you also want to assert.

### G4 · `raw.includes(rel)` is a substring match, and `docs/README.md` ends with `README.md`
`declaredIn` reported the root `README.md` as "named in STATE.md" because STATE.md cites
`docs/README.md`. The check fired on a **different file** and read as evidence.
The first fix — a left-boundary regex — then **rejected the true hit** `./docs/README.md`,
because the character before `docs/` is the `/` of `./`.
**Both failures are why this is now a token scan** (`pathTokens` + whole-token compare),
not a regex. Two boundary attempts, two opposite errors.
**Cost:** two wrong implementations before the right instrument.

### G5 · A backticked label inside a markdown link is not a second citation
marketing-intel's `STATE.md` writes every linked plan as
``[`2026-07-13-demand-signal-model.md`](./docs/plans/2026-07-13-demand-signal-model.md)``.
Scanning the raw text for backticked paths matched the **label**, which does not resolve
from the citing doc's directory — so the same citation was reported as AMBIGUOUS by one
pass and resolved by the other. One citation, two contradictory verdicts in one report.
Backticks are now scanned on the text with markdown links removed.

### G6 · propagate's `CITED_PATH` cannot see the dominant doc-to-doc citation form
It is exported nowhere, it matches **backticked paths only**, it requires an alphanumeric
first character, and it requires a `/`. So it misses `[text](./a.md)`, `` `../TODOS.md` ``
and `` `CLAUDE.md` `` alike.
**Do not "reuse" it for an inbound graph.** Measured on marketing-intel: the narrow form
produced **16 orphans, 6 of them false**. The correct count is 11.
CITED_PATH must stay narrow in propagate — it admits `.ts`/`.json`/`.sh`/`.yaml`, which is
where `feat/hero-v4-rebuild`, `0.0.0.0/0` and `next/image` produced 603 findings. This
skill's pattern is anchored on `.md`, so it cannot match those.

### G7 · A citation pointing outside the repo is correct, not broken
`CLAUDE.md` citing `../STATE.md` at the workspace root is a real, resolving reference.
Without an `external` category those became **23 "ambiguous" rows on marketing-intel**,
most of them correct prose. A check that fires 23 times on correct input gets ignored, and
then it guards nothing (propagate GOTCHAS G23).
`external` = resolves to a file that exists, outside the analysed root. Neither a defect
nor an edge.

### G8 · Known silent miss: backticked paths containing a space
`docs/DECISIONS.md:171` cites
`` `Vipin Kaushik/docs/plans/2026-07-08-marketing-intel-ia-reorg.md` `` — a genuinely
broken citation that this tool does **not** report, because the pattern excludes spaces.
Admitting spaces would match ordinary prose between backticks.
**This is declared rather than fixed, on purpose** (`rule:discernment-checks §2`): a
silent miss you have written down is a known limit; one you have not is a false clean.
Workspace directories in this tree have spaces (`Vipin Kaushik/`), so this will recur.

### G9 · The hub cannot be its own orphan, and two numbers for one fact is the tell
`verdict()` flagged `STATE.md` as ORPHAN (in-degree 0 — nothing links the root) while
`graph.orphans` correctly excluded it. The rendered report therefore printed
"**2 orphan**" in its header and three `**ORPHAN**` rows in its tables.
**The disagreement is the finding.** When one document states a count twice, assert they
match — `tests/report.test.mjs` now does (`rule:discernment-checks §5`).

### G10 · A basename `rg` is not an independent check
Verifying the orphan list, `rg -F README.md` reported `docs/README.md` as "mentioned in 5
other files". All five were *other* `README.md` files, plus one hit inside
`node_modules/`. The tool was right and the check was wrong.
**Search the path, exclude `node_modules`, and re-read the hits** before believing a
second method that disagrees.

### G11 · A path quoted as an example is indistinguishable from a citation
This skill's own `SKILL.md` and `GOTCHAS.md` report ~26 dangling and 2 ambiguous citations.
Every one is prose *discussing* a path (`` `../STATE.md` ``, `` `docs/cluster/a.md` ``), not
citing one. Docs about docs are the worst case, and there is no reliable way to tell the two
apart from the text.
**Do not chase these on a doc whose subject is paths.** Chase them on `DECISIONS.md`,
`CLAUDE.md` and specs, where a backticked path is nearly always a real reference — which is
where the genuine ones surfaced in marketing-intel (`docs/local-scheduler.md`,
`GA4_REGISTRY.md`, two deleted `2026-06-20-*` plans).

### G12 · Running the tool on itself is what found the biggest false-positive class
The first dogfood run reported **16 docs, 11 of them detached** — and 11 were its own test
fixtures. Nothing in the marketing-intel runs would have shown this, because that repo has
no markdown fixtures.
**Run a docs tool on its own repo before believing it on someone else's.** The same run is
what forced `fixtures`, `testdata`, `__snapshots__` and `.gstack` into the skip list, and
forced the skip to be *reported* rather than silent.

---

## Phase 2 — 2026-08-19

### G13 · Archiving by MOVING a doc breaks every relative link it owns
**Trigger:** `git\s+mv\s+.*\bdocs/.*\barchive`
**Fires on:** `git mv docs/a.md docs/archive/a.md`
Proven: hub→A, A→{B,C}. `git mv docs/a.md docs/archive/` turns `./b.md` and `./c.md` into
paths that resolve nowhere, so B and C orphan and STATE.md's link to A dangles — **three
findings from one action.**
**The archival act is `status:` in the frontmatter, not the move.** Declaring costs nothing
and cannot desync; moving rewrites every relative path the doc owns and buys nothing once the
state is in the file. `curate-docs state <doc> --set archived --because shipped --apply`.
**Cost:** the entire S1 finding of the phase-2 adversarial review, plus one wrong test that
asserted the move was harmless.

### G14 · Skipping a directory and exempting it from grading are different operations
Conflating them is what made archiving self-amplifying. An archived doc must stay
**discovered and parsed** — its outbound edges are what hold its children in the graph — and
be exempt only from *verdicts*. `archiveDirs` is therefore a separate config key from
`skipDirs`, and `archive` is deliberately **not** in the skip defaults.

### G15 · `require()` in an ESM file, inside a try/catch, fails silently forever
`cli.mjs`'s `repoRootFor` called `require("node:fs").existsSync` in a `.mjs` module. That is a
`ReferenceError` on every iteration, swallowed by the `catch`, so the walk never matched a
marker and every lookup fell back to the file's own directory. `impact` then reported
`cited by: nothing` for a document the hub linked directly — a confident wrong answer about
the exact relationship the command exists to report.
**A `try/catch` around a lookup hides the difference between "not found" and "this code cannot
run".** Catch the specific failure you expect, or assert the happy path in a test.
**Cost:** caught only because a drain test asserted `callers` contained `STATE.md`.

### G16 · Supplementing a git file list with a filesystem walk re-admits ignored files
git discovery misses symlinked trees, so the walk runs alongside it. The first version added
*everything* the walk found — which put every `.gitignore`d markdown file straight back, and
destroyed the single best property of using git. Only entries reached **through a symlink**
may be added; the flag has to propagate down the recursion, not be tested at the leaf.

### G17 · Scraping the rendered report to count documents counts rows, not documents
A cross-repo test asserted "no path appears twice" by regexing table rows out of the markdown.
It found **173 rows for 65 documents** — because a doc legitimately appears in its kind
section, in `Dangling`, and in `Citations that lost their path`.
**Count from `graph --json`, which is one row per document.** Third instance of
`rule:discernment-checks` §4 in this skill alone: the ruler was wrong, not the number.

### G18 · A memoised loader makes its own failure path untestable
`loadTaxonomy` cached in a bare `let`. Once any successful load had happened the
propagate-absent branch could never run again in the process, so the test asserting a loud
failure passed only when it ran first. Cache **per resolved candidate set**. Any memoised
resolver whose failure you also want to assert has this shape.

### G19 · A seed with no inbound edge is a real finding that seeding hides
Making `docs/README.md` a BFS seed was correct — it is the true hub in VipinKaushik and
propagate. But it silently converted "the docs index and nothing points at it" from a finding
into `ok`. That is now `UNLINKED-INDEX`: it works as a starting point only for someone who
already knows it exists. **When you exempt something from a check, ask what the exemption
stops reporting.**

### G20 · A citation to a file on another branch is EARLY, not broken
**Trigger:** `git\s+(rm|checkout)\s+.*local-scheduler`
**Fires on:** `git rm docs/local-scheduler.md`
`CLAUDE.md` and `docs/DECISIONS.md` cite `docs/local-scheduler.md`; it is absent on the
current branch and **present, 155 lines, on `feat/social-post-ingest`**. Reported as DANGLING,
the obvious fix is to delete the citation — deleting a *correct forward reference* to unmerged
work. It happened twice in one hour: writing up that finding cited
`docs/plans/instagram-app-review.md`, also only on that branch, and the report immediately
called the write-up broken.
`lib/branches.mjs` now splits `dangling` into **broken** and **unmerged**, naming the ref.
**Cost:** would have silently deleted 6 correct citations across 5 files.

### G21 · Every absence claim must name the branch
A drift audit run on one branch reported `components/dashboard/forecast/` as empty and the
Forecast spec as describing an unbuilt surface. True on `main`; **`ForecastDeck.tsx` exists on
`feat/phase3a-opportunities`.** Three branches carry **49 code files and zero `.md` on any
branch**, so a working-tree audit will keep re-reporting those surfaces as unbuilt forever.
**Measure with `git grep <ref>` / `git ls-tree <ref>` across every ref, and say "absent on
`<branch>`", never bare "absent".** Use `git cherry`, not `origin/main..<branch>` — squash
merges make ancestry lie.

### G22 · `grep -c` exits 1 on a zero count, so `|| fallback` fires on a valid answer
Building the branch table, `n=$(git cherry main "$b" | grep -c '^+' || echo '?')` printed `?`
for the branch with zero unmerged commits — a correct `0` replaced by an error marker, in a
table used to decide what was merged. Use `|| true`, never `|| <fallback-value>`, after any
counting grep. Already `~/.claude/gotchas-global.md` G-E; the guard fired and it still landed.

### G23 · zsh does not word-split an unquoted variable — fourth instance
`BRANCHES="a b c"; for b in $BRANCHES` iterates **once**, over the whole string, and the loop
body silently produced one row of zeros for a six-branch table. bash splits; zsh does not.
`rule:discernment-checks` §4 records this biting three times in one earlier session; this is
the fourth. **Use an explicit list or an array, never a list-in-a-string.**

### G24 · The verdict is computed in `report.mjs`, not in link-graph's `exempt()`

**Trigger:** `isEntryPoint|exempt\(|verdict\(`
**Fires on:** `const exempt = (d) => {`

There are two readers of "should this doc be graded":

| Where | What it feeds |
|---|---|
| `lib/link-graph.mjs` `exempt()` | the `graph.orphans` / `graph.detached` ARRAYS |
| `lib/report.mjs` `verdict()` | the `ORPHAN` / `DETACHED` **flag the CLI prints** |

They are not wired together. `verdict()` re-derives from `row.inDegree === 0` and
consults its own set of exemptions.

**Signal:** you add an exemption, the flag it depends on is provably set, the
predicate provably honours it — and the output does not change by a single line.
Measured 2026-08-27: a generated-artifact exemption added to `exempt()` was
verified three ways (regex matched both files, `isGenerated` set, `exempt()`
returned true) and moved the orphan count by **zero**, because `orphans` from
`report.mjs` is what `cli.mjs` prints.

**Cost:** an hour, and very nearly a "fixed" claim about a change that did
nothing. It survived a direct regex test and a predicate read; only diffing the
actual CLI output caught it.

**Instead:** classify in `report.mjs:verdict()`. If you must touch `exempt()`,
change both or neither — and check the CLI output, never the intermediate flag.
The general form is `rule:discernment-checks` §3: verify the work, not the report.
Here the "report" was my own instrumentation agreeing with me.
