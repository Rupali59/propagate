/**
 * R4 (plan "i-saw-it-what-starry-sparkle", CRITICAL) — the regression contract
 * for the reader's third state, `proposed`, added to
 * lib/report/backlog.mjs's `parseTodoLikeFile` for R1.
 *
 * Behaviour to preserve, verbatim from the plan's Accepted scope: "one test
 * parses every discovered register file with the old and new classifier, and
 * asserts that each file containing no proposed heading yields an identical
 * {open, closed, items} -- same format election, same ids, same closed
 * flags. Files that DO contain the heading are the intentional change and are
 * asserted separately."
 *
 * WHY THIS RUNS AGAINST THE REAL TREE, not a fixture matrix: D5 (a hermetic
 * fixture per known TODOS.md convention) was the plan's own first answer, and
 * was REVERSED at D6 in favour of this corpus snapshot -- a hand-written
 * fixture list is exactly the kind of curated population G70 was filed about
 * the same day ("a palette guard whose population is a curated list proves
 * nothing about the tokens outside it"). 14 modules import backlog.mjs,
 * across 107 register files (69 STATE.md + 33 TODOS.md + 5 ISSUES.md,
 * measured 2026-09-25) -- the corpus this change puts at risk is the real
 * one, so the proof has to be too.
 *
 * G56: never a bare `node --test` -- it writes the PRODUCTION event ledger.
 * Run scoped:
 *   PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" \
 *     node --test tests/unit/backlog-proposed-corpus.test.mjs
 *
 * THE TRAP THIS FILE MUST NOT FALL INTO (named directly in the task brief):
 * `discoverBacklogFiles()`'s default `searchRoots` comes from
 * `lib/core/config.mjs`'s `SEARCH_ROOTS`, which is resolved from
 * `$PROPAGATE_STATE_DIR/config.yml` (or `~/.propagate/config.yml`) AT MODULE
 * LOAD TIME. Run this file under the stable scoped state dir above -- which
 * has no config.yml -- and that default silently resolves to `hubRoot: null`
 * -> `SEARCH_ROOTS: []`, so `discoverBacklogFiles()` with no arguments walks
 * ZERO roots and finds ZERO files. That is not "the corpus shrank to zero",
 * it is "this test looked nowhere" -- G2/rule:discernment-checks §6, absence
 * must be attributable, never silently reported as a result.
 *
 * So HUB_ROOT below is derived from this file's OWN location (propagate is
 * always a direct child of the hub, on every machine that has this repo
 * checked out) rather than from config.mjs's env/config.yml-dependent
 * resolution, and is passed EXPLICITLY to `discoverBacklogFiles({
 * searchRoots })` -- bypassing the broken default rather than depending on
 * it. Measured against `~/.propagate/config.yml`'s own declared
 * `searchRoots` (hub + the nested `Rupali/Experiments` root, ordered for a
 * DIFFERENT walk's cycle-guard reasons -- see that file's comment): a
 * hub-only walk finds the identical file set, because `discoverBacklogFiles`
 * has no shared "walked" set the way `discoverWorkspacesSync` does, and
 * `Rupali/Experiments` sits well inside MAX_WALK_DEPTH from the hub root.
 * Verified directly (both HandReader/TODOS.md and obsidian-vk-publish/
 * TODOS.md -- the two sharpest fixtures in the corpus -- are present in the
 * hub-only walk).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverBacklogFiles, parseTodoLikeFile as parseTodoLikeFileNew } from "../../lib/report/backlog.mjs";

/**
 * Registers that legitimately carry a proposed/staging heading. Empty today:
 * nothing in this tree uses the convention yet. Adding one here is a deliberate
 * act by someone who checked; a file appearing WITHOUT being added means the
 * regex widened, not that a register adopted the convention.
 */
/**
 * Registers with one or more entries CURRENTLY STAGED.
 *
 * Named for what the assertion actually measures, which is not what the first
 * version of this list assumed. The branch below keys on `after.proposed` -- a
 * COUNT -- so a register that has adopted the convention but has nothing staged
 * yet reports `proposed: 0`, takes the no-heading branch, and is required to
 * parse identically old vs new. It does, so it counts as `unchanged`.
 *
 * That matters because it was measured wrongly first. `claude-usage-widget`
 * gained a register on 2026-09-25 carrying `## From Reminders (unreviewed)`, and
 * it was added here after R4 reported it -- but R4 was reading the file while a
 * test-fixture line was still sitting in its staging section. Once that line was
 * removed the section was empty, `proposed` went back to 0, and the expectation
 * was wrong in the other direction.
 *
 * So: adopting the heading does NOT belong here. Having something staged does,
 * and since staged entries are triaged out by hand this list should normally be
 * empty. Paths are hub-relative; resolved against HUB_ROOT below.
 */
const EXPECTED_PROPOSED_FILES = [];

const HERE = fileURLToPath(import.meta.url);
// tests/unit/<this file> -> tests/unit -> tests -> propagate (repo root) -> hub.
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const HUB_ROOT = path.resolve(REPO_ROOT, "..");

/**
 * The classifier as it existed at HEAD, before this change -- "the old
 * classifier" the plan asks for. `git show HEAD:lib/report/backlog.mjs`
 * rather than a hand-copied snapshot, so this test compares against what
 * actually shipped last, not against a paraphrase of it that could itself
 * drift from HEAD.
 *
 * Its three relative imports (`../core/config.mjs`, `./handovers.mjs`,
 * `../migrate/workspace.mjs`) are resolved to absolute `file://` specifiers
 * before the source is written to a scratch file and imported -- so the
 * scratch file can live anywhere (never inside lib/report/, which stays
 * exclusively the new file) and still resolve correctly. This is the
 * documented precedent's technique (config.mjs's export-split proof),
 * generalised to imports with import rewriting rather than a same-directory
 * copy.
 */
function loadOldClassifier() {
  const source = execFileSync("git", ["show", "HEAD:lib/report/backlog.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  const rewrites = [
    ['"../core/config.mjs"', JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "lib/core/config.mjs")).href)],
    ['"./handovers.mjs"', JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "lib/report/handovers.mjs")).href)],
    ['"../migrate/workspace.mjs"', JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "lib/migrate/workspace.mjs")).href)],
  ];
  let rewritten = source;
  for (const [from, to] of rewrites) {
    const before = rewritten;
    rewritten = rewritten.split(from).join(to);
    assert.notEqual(rewritten, before, `expected to find and rewrite the import specifier ${from} in HEAD's backlog.mjs -- if this fails, HEAD's import shape changed and this rewrite needs updating, not silently skipping`);
  }
  // Guard against the mutation this rewrite depends on silently not landing
  // (rule:discernment-checks §1 / rule:safety-flag-needs-a-test's corollary:
  // a sed/replace that matches nothing has no error and fails this whole
  // file's premise invisibly).
  assert.ok(!rewritten.includes('"../core/config.mjs"'), "a relative import specifier survived the rewrite");

  const dir = mkdtempSync(path.join(tmpdir(), "backlog-old-classifier-"));
  const scratchFile = path.join(dir, "backlog-old.mjs");
  writeFileSync(scratchFile, rewritten, "utf8");
  return { scratchFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("R4 corpus regression: every discovered TODOS.md/ISSUES.md with no proposed heading parses identically old vs new", async () => {
  const { scratchFile, cleanup } = loadOldClassifier();
  let parseTodoLikeFileOld;
  try {
    const oldModule = await import(pathToFileURL(scratchFile).href);
    parseTodoLikeFileOld = oldModule.parseTodoLikeFile;
    assert.equal(typeof parseTodoLikeFileOld, "function", "HEAD's backlog.mjs must still export parseTodoLikeFile");
  } finally {
    cleanup();
  }

  // Discovery itself is UNCHANGED by this plan item -- reused as-is, from the
  // NEW module, with explicit searchRoots per the trap documented at the top
  // of this file. Both classifiers below run against the identical file list
  // and identical file contents (read once, per file).
  const discovery = discoverBacklogFiles({ searchRoots: [HUB_ROOT] });
  const registerFiles = [...discovery.todosMd, ...discovery.issuesMd];
  const population = {
    stateMd: discovery.stateMd.length,
    todosMd: discovery.todosMd.length,
    issuesMd: discovery.issuesMd.length,
    registerFilesChecked: registerFiles.length,
  };

  // The population sanity floor. This is what stands between "the corpus is
  // small today" (a real, reportable fact) and "this test discovered zero
  // roots" (an instrument failure masquerading as one) -- see the trap note
  // above. 10 is well under the ~38 TODOS.md+ISSUES.md measured 2026-09-25;
  // it exists to catch total discovery failure, not to pin an exact count
  // the real tree will keep moving under.
  assert.ok(
    registerFiles.length > 10,
    `Discovered only ${registerFiles.length} TODOS.md/ISSUES.md files under HUB_ROOT=${HUB_ROOT}. ` +
      `Expected roughly 38 (33 TODOS.md + 5 ISSUES.md, measured 2026-09-25; the number will drift ` +
      `day to day and that is fine -- but a number this low usually means discovery walked zero ` +
      `roots, not that the corpus shrank. Population discovered: ${JSON.stringify(population)}.`,
  );

  let unchanged = 0;
  const regressed = [];
  const withHeading = [];
  const unreadable = [];

  for (const file of registerFiles) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      // A file discoverBacklogFiles() found but this loop cannot read (race,
      // permissions, deleted mid-run) is its own finding -- reported, not
      // silently dropped from the checked population.
      unreadable.push({ file, error: String(err.message || err) });
      continue;
    }

    const before = parseTodoLikeFileOld(text, file);
    const after = parseTodoLikeFileNew(text, file);

    if (!after.proposed) {
      // No proposed heading matched in this file -- R4's guarantee applies:
      // identical format election, same open/closed counts, same items
      // (same ids, same closed flags, same text).
      const beforeShape = { format: before.format, open: before.open, closed: before.closed, items: before.items };
      const afterShape = { format: after.format, open: after.open, closed: after.closed, items: after.items };
      const beforeJson = JSON.stringify(beforeShape);
      const afterJson = JSON.stringify(afterShape);
      if (beforeJson === afterJson) {
        unchanged++;
      } else {
        const field = ["format", "open", "closed", "items"].find(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
        );
        regressed.push({ file, field, before: before[field], after: after[field] });
      }
    } else {
      // Files that DO contain the heading are the intentional change,
      // asserted separately below -- not part of the "no proposed heading"
      // regression guarantee.
      withHeading.push({ file, proposed: after.proposed, open: after.open, closed: after.closed, parsed: after.parsed });
    }
  }

  // Property 2 (plan): report the population examined, not a bare pass. A
  // green tick is indistinguishable from a walk that found nothing to look
  // at (rule:enforcement-watches-itself) unless it says what it looked at.
  console.log(
    `R4 corpus check: ${registerFiles.length} TODOS.md/ISSUES.md files examined under ${HUB_ROOT} ` +
      `(discovery also found ${population.stateMd} STATE.md, not covered by this contract). ` +
      `${unchanged} unchanged, ${withHeading.length} have entries STAGED (intentional change), ` +
      `${regressed.length} regressed, ${unreadable.length} unreadable mid-check.`,
  );
  if (withHeading.length > 0) {
    console.log(`Files with staged entries: ${withHeading.map((w) => w.file).join(", ")}`);
  }

  // Reporting `withHeading` is not enough, and this was measured rather than
  // assumed: broadening PROPOSED_SECTION_RE to /\b(active|now|todo)/i moved
  // SEVENTEEN real files into this bucket and the test still exited 0, because
  // files carrying the heading are excluded from the strict comparison above.
  // That is the R4 contract unable to catch the R1 risk it exists for -- an
  // over-broad regex silently reclassifying real open work is exactly the
  // failure, and it would have arrived as console output nobody reads.
  //
  // So: exactly the registers in EXPECTED_PROPOSED_FILES use the convention,
  // and that is the assertion. When one legitimately adopts it, this list is
  // edited on purpose by someone who looked. An allowlist you must edit to
  // exempt something is safe; a silent report is not (G70).
  //
  // The list is hub-relative and resolved here rather than stored absolute: a
  // test carrying `/Users/<someone>/...` passes on one laptop and fails on
  // every other one, which is a machine-specific assertion wearing a path.
  const expectedAbs = EXPECTED_PROPOSED_FILES.map((rel) => path.join(HUB_ROOT, rel)).sort();
  assert.deepEqual(
    withHeading.map((w) => w.file).sort(),
    expectedAbs,
    `the set of registers with STAGED entries changed.\n` +
      `  got:      ${JSON.stringify(withHeading.map((w) => w.file).sort())}\n` +
      `  expected: ${JSON.stringify(expectedAbs)}\n` +
      `  A register with staged-but-untriaged entries belongs here deliberately; ` +
      `normally the list is empty because staging is triaged by hand. Note this keys ` +
      `on the proposed COUNT, not on the heading's presence — adopting the heading ` +
      `alone does not appear here. If you did not expect this, PROPOSED_SECTION_RE ` +
      `is matching headings it should not.`,
  );
  if (unreadable.length > 0) {
    console.log(`Unreadable mid-check (excluded from the comparison, reported not dropped): ${JSON.stringify(unreadable)}`);
  }

  // Property 1 (plan): the failure message names the file AND the field that
  // moved, and says explicitly this may be an unrelated repo's change --
  // otherwise a corpus-coupled test becomes a flake people learn to ignore,
  // which is worse than no test.
  assert.equal(
    regressed.length,
    0,
    `${regressed.length} file(s) changed parse output with NO proposed heading present. ` +
      `This may mean the proposed-state change in lib/report/backlog.mjs regressed existing ` +
      `behaviour -- OR it may mean an unrelated register file in this tree (not this change) was ` +
      `edited between when this test's "old" baseline (HEAD) and "new" (working tree) were compared. ` +
      `Check the file(s) named below before assuming either cause. Details: ${JSON.stringify(regressed, null, 2)}`,
  );
});

test("R4 sharpest case: HandReader/TODOS.md and obsidian-vk-publish/TODOS.md stay format:unrecognised, unaffected by the proposed-heading change", async () => {
  // "The two files already fail to parse and must still fail identically" --
  // called out explicitly in the task brief because no hand-written fixture
  // would have included them. Asserted as its own test, not left to the
  // generic corpus loop above, so their disappearance from the tree (a
  // migration, a rename) is itself a loud failure rather than a silent drop
  // in what the corpus loop happens to cover.
  const { scratchFile, cleanup } = loadOldClassifier();
  let parseTodoLikeFileOld;
  try {
    const oldModule = await import(pathToFileURL(scratchFile).href);
    parseTodoLikeFileOld = oldModule.parseTodoLikeFile;
  } finally {
    cleanup();
  }

  const discovery = discoverBacklogFiles({ searchRoots: [HUB_ROOT] });
  const targets = ["Rupali/Experiments/HandReader/TODOS.md", "Vipin Kaushik/obsidian-vk-publish/TODOS.md"];

  for (const rel of targets) {
    const file = discovery.todosMd.find((f) => f.endsWith(rel));
    assert.ok(
      file,
      `expected ${rel} to be discovered under ${HUB_ROOT} -- if it is genuinely gone (moved, ` +
        `migrated, deleted), this guard needs a replacement sharp case named in the same commit, ` +
        `not silent deletion of the assertion`,
    );
    const text = readFileSync(file, "utf8");
    const before = parseTodoLikeFileOld(text, file);
    const after = parseTodoLikeFileNew(text, file);
    assert.equal(before.format, "unrecognised", `${rel}: expected HEAD's classifier to still report unrecognised -- if this fails, the fixture itself changed shape and became parseable, which is a different (fine) story than the one this test is pinning`);
    assert.equal(after.format, "unrecognised", `${rel}: the proposed-heading change must not turn a genuinely unparseable file into a false parse`);
    assert.equal(after.open, null, `${rel}: an unrecognised file must make no claim about open`);
    assert.equal(after.closed, null, `${rel}: an unrecognised file must make no claim about closed`);
    assert.equal(after.proposed, null, `${rel}: an unrecognised file must make no claim about proposed either -- G2, no claim is not a zero claim`);
  }
});
