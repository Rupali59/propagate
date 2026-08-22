# DECISIONS — curate-docs

Append-only. Never edit a past entry; supersede it with a new dated one.
(`rule:state-and-decisions`)

---

## 2026-08-19 — In-degree plus hub-reachability, not PageRank

**What:** the "does this doc have a calling node" question is answered by two numbers —
`inDegree` (how many docs cite it) and `hubDistance` (BFS hops from `STATE.md`) — and
explicitly **not** by PageRank or any eigenvector centrality.

**Why:** the request was framed as "a calling node, like PageRank", and PageRank is the
wrong instrument for it. Measured in marketing-intel:
`docs/plans/dashboard-godmode/README.md` fans out to **52** leaves, so every leaf would
inherit a large score from one node, while `docs/ARCHITECTURE.md` — 478 lines, the largest
doc in the repo and the one a "how does this work" question reaches for — has **one**
inbound edge and would score near zero. The ranking would measure fan-out, not importance.

`hubDistance` is what in-degree alone misses: the 51 files under `dashboard-godmode/`
mutually cite each other, so every one has in-degree > 0 and looks healthy while the whole
cluster is unreachable from the hub. That is the `DETACHED` verdict.

**Rejected alternatives:** PageRank (above); out-degree depth (propagate GOTCHAS **G45**
records substituting out-depth for layer-from-root as a defect in that codebase — the same
error was available here).

**Refs:** `lib/link-graph.mjs`, `docs/GOTCHAS.md` G6.

---

## 2026-08-19 — A sibling skill, but the taxonomy is imported, never restated

**What:** `curate-docs` is a separate skill under `~/.claude/skills/`, not a mode inside
`propagate`. Its `lib/taxonomy.mjs` imports `KINDS`, `kindOf`, `frontmatter`,
`parseSupersedes`, `buildSupersessionIndex` and `brokenPathCitations` from
`propagate/lib/doc-kind.mjs` and asserts that surface exists on load.

**Why:** Rupali chose a sibling after being shown that propagate already owns the doc-kind
taxonomy, doc authority, the sidecar edge graph and broken-citation detection. The standing
counter-argument is propagate `docs/GOTCHAS.md` **G20** — *a second mechanism duplicates
the first unless you delete the first*. Importing rather than restating is what keeps that
from happening: there is one taxonomy with two consumers. The precedent is
`~/.claude/hooks/doc-authority.mjs`, which already imports propagate's libs from outside
the skill.

**The consequence, accepted deliberately:** `curate-docs` does not work without propagate
installed, and says so loudly (exit 3, with every path it tried). A local fallback
taxonomy was rejected — that is exactly how the second copy gets born, and a fallback that
quietly classified everything `undeclared` would read as "no findings".

**Refs:** `lib/taxonomy.mjs`, `tests/taxonomy.test.mjs`.

---

## 2026-08-19 — The verdict for an orphan is "declare a state", never "add a link"

**What:** the tool is read-only. It does not regenerate `docs/README.md`, move files to
`docs/archive/`, or stamp frontmatter. It reports, with provenance, and a person decides:
**active**, **archived**, or **superseded**.

**Why:** `propagate/lib/docs.mjs:8-12` argues against orphan-finding outright, and is right
about the part it argues — *"only 4 of 79 VipinKaushik docs are referenced by nothing.
`PRIVACY-CONTENT.md` was reachable from STATE.md, DECISIONS.md and docs/README.md — and was
still not read, because nobody was looking for an index. Reachable is not read."*

Auto-generating an index entry would turn every count green without anyone deciding whether
the doc should exist. So reachability is used only as the **detector**; `lib/evidence.mjs`
supplies what the decision needs (introducing commit, branches, ledger/sidecar mentions,
declared state) and the decision stays with a person.

This also matches what `marketing-intel/STATE.md:176` already demands and no tool supplied:
*"every non-reference file in `docs/` is either linked here or sits in `docs/archive/`."*

---

## 2026-08-19 — Citations resolve into four buckets, not two

**What:** `resolved` · `external` · `ambiguous` · `dangling`.

**Why:** a two-bucket version (resolved / broken) reported **23 "ambiguous"** rows on
marketing-intel, most of which were correct workspace-relative references such as
`CLAUDE.md` citing `../STATE.md`. A check that fires 23 times on correct input gets
ignored (propagate GOTCHAS **G23**).

- `external` — resolves to a file that exists outside the analysed root. Not a defect.
- `ambiguous` — the basename exists in the doc set but the written path does not resolve.
  A wrong relative path is a real defect, and this is where the genuine ones surfaced:
  `STATE.md` cites `` `DESIGN.md` `` when the file is at `docs/design/DESIGN.md`.
- **No unique-basename fallback.** A basename match is reported as `ambiguous`, never
  silently promoted to an edge — that is how an exploratory pass over-counted `fixes.md`
  and `STATE.md`.

**Measured effect on marketing-intel:** 16 orphans → 11 (6 were false, from a too-narrow
extractor); 23 ambiguous → 15 (all remaining ones inspected and real).

---

## 2026-08-19 — No edit-time hook in v1

**What:** no `PreToolUse` guard blocking creation of a new `.md` without a caller, even
though `~/.claude/hooks/doc-authority.mjs` is a working precedent.

**Why:** it cannot be justified until the report has run once and the existing 11 orphans
in marketing-intel have been triaged. Shipping a blocker against *new* orphans while 11
old ones sit undecided guards the cheap case and leaves the expensive one. Revisit after
one real triage cycle.

---

## 2026-08-19 — Lifecycle state lives in frontmatter; the manifest view is derived

**What:** `status: active | archived | superseded` in the document's own YAML frontmatter,
with `superseded_by`, `archived_on`, `archived_because`. `active` is the default and carries
**no key**. Precedence: frontmatter > filename suffix > directory. `curate-docs state --all`
renders the whole-tree view on demand; **nothing is stored**.

**Why:** state inferred from a directory desyncs the instant a file moves, and that is the S1
cascade — proven, hub→A, A→{B,C}, archiving A produced two orphans and a dangling citation
with no attribution. State in the file travels with the content, so a move cannot orphan
children as a side effect.

**Why not a manifest file:** a second source of truth that a rename desyncs silently — the
coupling failure `rule:adversarial-review-reads-the-ledger` is about. Local proof: `ports.yml`
declared itself the canonical registry while **0 of 48** `CLAUDE.md` files cited it.
**Why not propagate's `index.db` `state_doc` table:** it is a derived cache with a manual
rebuild and no scheduler, so a rebuild loses authoritative state; and it is machine-local, so
the state never travels with the repo.

**Why `active` is implicit:** measured, 3,750 `.md` in this tree carry 17 `status:` keys total.
Writing `status: active` everywhere is 3,750 diffs that say nothing. Only non-default states
are recorded — ~28 files in Vipin Kaushik.

**Backfill is mechanical:** `git log --diff-filter=R -M --name-status` already encodes
`-shipped-<date>`, `-superseded-<date>`, `_stale-<date>` in the new names.

---

## 2026-08-19 — The tool writes, narrowly, and enforces the pipeline order

**What:** `state --apply` writes only frontmatter keys. `drain --apply` runs `git rm`, and
**refuses** unless (a) the doc's status is declared `archived`/`superseded` and (b) `impact`
reports it is not the only document citing something else.

**Why:** Rupali's framing — *"create current state from the existing docs, then for archived
items check what they contained, after setting the state properly, then remove the archive and
reconcile"* — makes the archive a staging area to be drained. A tool that only reported would
leave "state is maintained" depending on someone running a script every time, which is how a
convention decays.

**The preconditions are enforced, not documented.** You cannot delete what you have not
declared dead; salvage happens between declaring and draining, and skipping it deletes content
nobody read. `rule:safety-flag-needs-a-test`: both write modes have a test that snapshots every
byte of the tree, runs every disposition **without** `--apply`, and asserts nothing changed —
and a mutation confirming that gate goes red when removed.

**Supersedes** the 2026-08-19 "read-only by contract" entry in its consequence clause only.

---

## 2026-08-19 — propagate preferred, config-declared kinds as a fallback

**What:** propagate's `kindOf` remains the taxonomy provider. Without it, kinds resolve from
the repo's own `.curate-docs.yml` `kinds:` globs, and **the report always names the provider
in force** — `taxonomy: propagate` / `.curate-docs.yml (N globs)` / `none — every kind
undeclared`.

**Why:** the hard exit-3 made the skill unusable on any machine without propagate, which
defeats "generic". What the earlier entry rejected was a **silent** local taxonomy; a declared
one that announces itself is a different thing (`rule:discernment-checks` §2).

**Supersedes** the 2026-08-19 "A sibling skill, but the taxonomy is imported, never restated"
entry in its consequence clause only. The taxonomy is still imported and never restated.

---

## 2026-08-19 — git is the discovery instrument, with a filesystem fallback

**What:** `git ls-files` ∪ `--others --exclude-standard`, falling back to a walk in non-git
directories. The instrument is named in every report.

**Why:** git respects `.gitignore` inherently, excludes worktrees twice over (gitignored *and*
a separate index) and excludes submodules — the walk it replaces double-counted 8 files under
`.worktrees/` and needed a hand-maintained list to approximate what git already knows.

**Two traps coded against:** the git root is accepted only when it *equals* the target
directory, because `~/Documents/GitHub` is itself a repo with an allowlist `.gitignore` and
returns **46** `.md` against a real 2,876; and symlinked trees are walked separately, because
git records symlinks as mode-120000 blobs and never traverses them.

---

## 2026-08-19 — No Claude queue, on structural grounds

**What:** per-document triage does not run through `scripts/claude-next.sh`.

**Why:** not merely that it is disarmed, has no plist and has not run since 2026-07-29, nor
that its UI is unauthenticated local RCE (`QUEUE-RUNNER-ISSUES.md` C4). The disqualifier is
structural: **salvage is multi-turn code exploration** and headless `--resume --print` does one
turn then marks the session complete (H1/H2); and **draining is deletion**, precisely what
`DENYLIST_REGEX` exists to stop. Using the queue means weakening the fence around the one step
it guards. Derivation takes ~1s, so there is nothing worth scheduling.

---

## 2026-08-19 — Obsidian vaults are refused, not analysed

**What:** a root `.obsidian/` exits 5 naming the reason; `.obsidian` is also in `skipDirs` for
vaults nested inside ordinary repos.

**Why:** the corpus is `[[wikilink]]`-shaped and this extractor cannot see a single one of
Obsidian's 554 files. Analysing it would produce a confident clean run over an entirely
invisible tree, which is the exact failure this skill exists to catch. Wikilink support was
considered and declined (Rupali, 2026-08-19): exclusion, not a second dialect.

---

## 2026-08-19 — `dangling` splits into broken and unmerged

**What:** `lib/branches.mjs` classifies every dangling citation against all other local and
`origin/` refs. A target present on another ref is reported as **unmerged**, naming the branch,
in its own report section — not as a broken link.

**Why:** measured on marketing-intel, 6 of 24 "dangling" citations across 5 files pointed at
`docs/local-scheduler.md` and `docs/plans/instagram-app-review.md`, both present on
`feat/social-post-ingest`. The natural repair for a dangling citation is to delete it, which
would have destroyed six correct forward references to unmerged work. This repo squash-merges
and carries five unmerged branches, so the case is routine rather than exotic.

**Bounded cost:** one `git ls-tree` per ref, not one lookup per citation.
**Attribution:** `refsChecked` is reported. Zero refs searched and zero found are different
facts, and a non-git directory leaves every citation broken rather than silently excused.
