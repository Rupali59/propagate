/**
 * Branch-aware migrate-ledger (docs/ISSUES.md N25 — "a ledger is read from
 * the working tree, so its state is whatever branch is checked out").
 *
 * These tests build real, disposable git repos under the OS tmpdir and use
 * ordinary git commands (`checkout -b`, `commit`) to seed fixture branches —
 * that is the only way to exercise `git show <ref>:<path>` behaviour. This
 * is NOT the "never git checkout/switch branch anywhere" constraint from the
 * task brief, which is about the real repos this lane must not touch
 * (`~/Documents/GitHub/...`); these fixtures are throwaway tmp repos created
 * and destroyed within a single test.
 *
 * The tool under test itself never calls `git checkout` — every read here is
 * `git show <ref>:<path>`, asserted indirectly by these tests passing while
 * the fixture's OWN checked-out branch (asserted below) never changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { migrateLedger } from "../../lib/edges/migrate-ledger.mjs";
import { readLedger } from "../../lib/edges/ledger.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function currentBranch(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function readRaw(p) {
  return readFile(p, "utf8");
}

/** A parent workspace dir with a git sub-project inside it, matching the
 * real shape (`<workspace>/sub-project/docs/PROPAGATION_LEDGER.jsonl`). */
async function makeGitWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "migledger-refs-"));
  const subRoot = path.join(root, "sub-project");
  await mkdir(subRoot, { recursive: true });
  git(subRoot, ["init", "-q", "-b", "main"]);
  git(subRoot, ["config", "user.email", "test@example.com"]);
  git(subRoot, ["config", "user.name", "Test"]);
  await writeFile(path.join(subRoot, "README.md"), "seed\n");
  git(subRoot, ["add", "."]);
  git(subRoot, ["commit", "-q", "-m", "init"]);

  const fromPath = path.join(subRoot, "docs", "PROPAGATION_LEDGER.jsonl");
  const intoPath = path.join(root, "docs", "PROPAGATION_LEDGER.jsonl");
  return { root, subRoot, fromPath, intoPath };
}

/** Write ledger rows and commit them on `branch` (creating it from `main` if
 * it doesn't exist yet), then check `main` back out — so by the time the
 * caller runs the tool, the given branch holds the content but is NOT the
 * checked-out branch (unless branch === "main" and leaveCheckedOut). */
async function commitLedgerOnBranch(subRoot, branch, rows, { leaveCheckedOut = false } = {}) {
  const branches = git(subRoot, ["branch", "--list"]);
  if (branch !== "main") {
    if (branches.split("\n").some((b) => b.replace("*", "").trim() === branch)) {
      git(subRoot, ["checkout", "-q", branch]);
    } else {
      git(subRoot, ["checkout", "-q", "-b", branch, "main"]);
    }
  } else {
    git(subRoot, ["checkout", "-q", "main"]);
  }
  const jsonlPath = path.join(subRoot, "docs", "PROPAGATION_LEDGER.jsonl");
  await mkdir(path.dirname(jsonlPath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(jsonlPath, body);
  git(subRoot, ["add", "docs/PROPAGATION_LEDGER.jsonl"]);
  git(subRoot, ["commit", "-q", "-m", `ledger on ${branch}`]);
  if (!leaveCheckedOut && branch !== "main") {
    git(subRoot, ["checkout", "-q", "main"]);
  }
}

function row(id, ts, source, extra = {}) {
  return {
    type: "drift",
    id,
    timestamp: ts,
    source,
    change: "edit",
    downstream: [{ path: `${source}.dep`, why: "consumer", kind: "code" }],
    status: "open",
    ...extra,
  };
}

// ── RED 1: --all-refs picks up a row that exists only on a non-checked-out branch ──

test("--all-refs picks up a row that exists only on a non-checked-out branch", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();

  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);
  await commitLedgerOnBranch(subRoot, "feature-x", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/b.ts"),
  ]);
  // main is checked out; feature-x's second row is invisible to a working-tree read.
  assert.equal(currentBranch(subRoot), "main");

  const workingTreeResult = await migrateLedger({ fromPath, intoPath, apply: false });
  assert.equal(workingTreeResult.migrated, 1, "plain working-tree read only sees main's row");

  const sweepResult = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(currentBranch(subRoot), "main", "the tool must never check out a branch");
  assert.equal(sweepResult.migrated, 2, "the union includes feature-x's row invisible to the working tree");

  const rows = await readLedger(intoPath);
  assert.ok(rows.some((r) => r.source === "sub-project/lib/b.ts"), "feature-x's row was migrated");
});

// ── RED 2: a row present on three branches migrates exactly ONCE ──

test("a row present on three branches migrates exactly once", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();

  const shared = row("001", "2026-01-01T00:00:00.000Z", "lib/shared.ts");
  await commitLedgerOnBranch(subRoot, "main", [shared]);
  // branch-b/branch-c fork off main AFTER it already carries the row — no
  // further commit needed, they inherit it verbatim (the realistic case:
  // append-only branches that share a prefix, per docs/ISSUES.md N25).
  git(subRoot, ["branch", "branch-b", "main"]);
  git(subRoot, ["branch", "branch-c", "main"]);

  const result = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(result.migrated, 1, "one logical row seen on three branches migrates once");
  assert.equal(result.duplicateEventsCollapsed, 2, "the other two sightings are recorded as collapsed duplicates");

  const rows = await readLedger(intoPath);
  assert.equal(rows.length, 1);
});

// ── RED 3: every migrated row carries source_worktree.branch ──

test("every migrated row carries source_worktree.branch naming the ref it came from", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();

  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);
  await commitLedgerOnBranch(subRoot, "feature-y", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-03T00:00:00.000Z", "lib/c.ts"),
  ]);

  await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });

  const rows = await readLedger(intoPath);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.source_worktree, `row ${r.id} (${r.source}) must carry source_worktree`);
    assert.ok(r.source_worktree.branch, "source_worktree.branch is set");
    assert.ok(r.source_worktree.commit, "source_worktree.commit is set");
  }
  const mainRow = rows.find((r) => r.source === "sub-project/lib/a.ts");
  assert.equal(mainRow.source_worktree.branch, "main", "default branch (main) is canonical when both have the row");
  const featureRow = rows.find((r) => r.source === "sub-project/lib/c.ts");
  assert.equal(featureRow.source_worktree.branch, "feature-y");
});

// ── RED 5: dry-run writes nothing, even under --all-refs ──

test("dry-run under --all-refs writes nothing — destination snapshot unchanged", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);
  await commitLedgerOnBranch(subRoot, "feature-z", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/z.ts"),
  ]);

  assert.equal(existsSync(intoPath), false);
  const result = await migrateLedger({ fromPath, intoPath, apply: false, allRefs: true });
  assert.equal(existsSync(intoPath), false, "dry-run must not create the destination file");
  assert.equal(result.migrated, 2, "dry-run still reports what WOULD migrate");
  assert.equal(result.manifestPath, null);
});

// ── RED 6: re-running --apply --all-refs is idempotent ──

test("re-running --apply --all-refs is idempotent", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);
  await commitLedgerOnBranch(subRoot, "feature-w", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/w.ts"),
  ]);

  const first = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(first.migrated, 2);
  const afterFirst = await readLedger(intoPath);
  assert.equal(afterFirst.length, 2);

  const second = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(second.migrated, 0, "no new events migrated on re-run");

  const afterSecond = await readLedger(intoPath);
  assert.equal(afterSecond.length, 2, "row count unchanged — no duplication");
  assert.deepEqual(
    afterSecond.map((r) => r.id).sort(),
    afterFirst.map((r) => r.id).sort(),
  );
});

// ── RED 7: a ref with no ledger at that path is skipped and reported ──

test("a ref with no ledger at that path is skipped and reported, never silently", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);

  // A branch that never touches docs/PROPAGATION_LEDGER.jsonl at all.
  git(subRoot, ["checkout", "-q", "-b", "docs-only", "main"]);
  await writeFile(path.join(subRoot, "OTHER.md"), "unrelated\n");
  git(subRoot, ["add", "OTHER.md"]);
  // Remove the ledger file on this branch entirely so `git show` has nothing to find.
  git(subRoot, ["rm", "-q", "docs/PROPAGATION_LEDGER.jsonl"]);
  git(subRoot, ["commit", "-q", "-m", "docs-only branch, no ledger"]);
  git(subRoot, ["checkout", "-q", "main"]);

  const result = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(result.migrated, 1, "main's row still migrates");
  assert.ok(
    result.skippedRefs.some((s) => s.ref === "docs-only"),
    "the docs-only branch is reported as skipped, not silently dropped",
  );
  const skippedEntry = result.skippedRefs.find((s) => s.ref === "docs-only");
  assert.ok(skippedEntry.reason && skippedEntry.reason.length > 0, "the skip carries a reason");
});

// ── Manifest carries ref-sweep metadata ──

test("the manifest records refsSwept and skippedRefs under --all-refs", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);

  const result = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.ok(result.manifestPath);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.refsSwept));
  assert.ok(manifest.refsSwept.some((r) => r.ref === "main"));
  assert.ok(Array.isArray(manifest.skippedRefs));
});

// ── --from-ref reads exactly one ref, never checks it out ──

test("--from-ref reads exactly one ref and stamps it, without touching the checked-out branch", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  await commitLedgerOnBranch(subRoot, "main", [row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts")]);
  await commitLedgerOnBranch(subRoot, "other-branch", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-05T00:00:00.000Z", "lib/other.ts"),
  ]);
  assert.equal(currentBranch(subRoot), "main");

  const result = await migrateLedger({ fromPath, intoPath, apply: true, fromRef: "other-branch" });
  assert.equal(currentBranch(subRoot), "main", "the tool must never check out a branch");
  assert.equal(result.migrated, 2, "--from-ref reads only the named ref, both its rows");

  const rows = await readLedger(intoPath);
  for (const r of rows) {
    assert.equal(r.source_worktree.branch, "other-branch");
  }
});

// ── Cross-mode idempotence (coordinator-reported defect): a plain migration
// followed by --all-refs must not duplicate rows the plain run already wrote.
// `migrated_from` on those destination rows carries no `ref`, so the
// (ledger, ref, oldId) index alone is blind to them under --all-refs — this
// is the id-independent, mode-independent content-key guard's reason to exist.

test("a row migrated in plain (working-tree) mode is recognized and skipped by a later --all-refs run", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();

  await commitLedgerOnBranch(subRoot, "main", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/b.ts"),
  ], { leaveCheckedOut: true });

  // Step 1: an earlier plain (working-tree) migration — exactly what the
  // original single-source tool always did, before ref-sweeping existed.
  const plainResult = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(plainResult.migrated, 2);
  const afterPlain = await readLedger(intoPath);
  assert.equal(afterPlain.length, 2);
  for (const r of afterPlain) {
    assert.equal(r.migrated_from.ref, undefined, "plain-mode migrated_from carries no ref");
  }

  // Step 2: later, a branch adds one genuinely new row on top of the two
  // already-migrated ones. A --all-refs sweep must recognize 001/002 as
  // already present (by content, since their migrated_from has no ref) and
  // migrate only 003.
  await commitLedgerOnBranch(subRoot, "feature-later", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/b.ts"),
    row("003", "2026-01-03T00:00:00.000Z", "lib/c.ts"),
  ]);

  const sweepResult = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(sweepResult.migrated, 1, "only the genuinely-new row (003) migrates");
  assert.equal(sweepResult.skipped, 2, "the two already-migrated rows are recognized and skipped, not duplicated");

  const finalRows = await readLedger(intoPath);
  assert.equal(finalRows.length, 3, "no duplicates written — destination has exactly 3 distinct rows");
  const sources = finalRows.map((r) => r.source).sort();
  assert.deepEqual(sources, ["sub-project/lib/a.ts", "sub-project/lib/b.ts", "sub-project/lib/c.ts"]);

  // Re-running the same sweep again must still be a no-op — the content-key
  // guard must not itself become a source of drift.
  const rerun = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(rerun.migrated, 0);
  const stillThree = await readLedger(intoPath);
  assert.equal(stillThree.length, 3, "idempotent — no growth on repeated sweeps");
});

// ── Coordinator-reported defect, one level down: transitions must be
// content-guarded the same way rows are, or a status_change belonging to an
// already-present (content-skipped) row is re-appended as a counterfeit
// close-row on every --all-refs --apply.

function statusChange(id, status, timestamp, extra = {}) {
  return { type: "status_change", id, status, timestamp, closed_by: "drain", ...extra };
}

test("a transition belonging to a plain-mode-migrated row is skipped by --all-refs, not re-appended", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();

  await commitLedgerOnBranch(subRoot, "main", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    statusChange("001", "done", "2026-01-01T01:00:00.000Z"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/b.ts"),
    statusChange("002", "done", "2026-01-02T01:00:00.000Z"),
  ]);

  // Step 1: plain (working-tree) migration — matches the real Manav-portfolio
  // history (5 rows migrated this way, migrated_from carrying no ref).
  const plainResult = await migrateLedger({ fromPath, intoPath, apply: true });
  assert.equal(plainResult.migrated, 2);
  assert.equal(plainResult.transitionsMigrated, 2);
  const afterPlain = await readRaw(intoPath);
  const afterPlainTransitionCount = countType(afterPlain, "status_change");
  assert.equal(afterPlainTransitionCount, 2);

  // Step 2: a branch adds one genuinely new row+transition on top of the two
  // already-migrated ones.
  await commitLedgerOnBranch(subRoot, "feature-later", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    statusChange("001", "done", "2026-01-01T01:00:00.000Z"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/b.ts"),
    statusChange("002", "done", "2026-01-02T01:00:00.000Z"),
    row("003", "2026-01-03T00:00:00.000Z", "lib/c.ts"),
    statusChange("003", "wontfix", "2026-01-03T01:00:00.000Z", { wontfix_reason: "not applicable" }),
  ]);

  const sweepResult = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(sweepResult.migrated, 1, "only row 003 is genuinely new");
  assert.equal(sweepResult.transitionsMigrated, 1, "only 003's transition is genuinely new");
  assert.equal(sweepResult.transitionsSkipped, 2, "001 and 002's transitions are recognized as already present");

  const afterSweep = await readRaw(intoPath);
  assert.equal(countType(afterSweep, "status_change"), 3, "no duplicate status_change rows — 2 pre-existing + 1 new, not 5");

  // The unbounded-growth check, on the scenario that actually produced the
  // bug: run the SAME --all-refs --apply again. If transitions were not
  // content-guarded, this would append another 2 counterfeit status_change
  // rows every time it's run.
  const rerunSweep = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(rerunSweep.migrated, 0);
  assert.equal(rerunSweep.transitionsMigrated, 0, "no transitions re-appended on a second identical sweep");
  const afterRerun = await readRaw(intoPath);
  assert.equal(afterRerun, afterSweep, "destination is byte-identical after the second --all-refs --apply — no unbounded growth");
});

test("--all-refs --apply run twice leaves the destination byte-identical the second time (unbounded-growth check)", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();

  await commitLedgerOnBranch(subRoot, "main", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    statusChange("001", "done", "2026-01-01T01:00:00.000Z"),
  ]);
  await commitLedgerOnBranch(subRoot, "feature-x", [
    row("001", "2026-01-01T00:00:00.000Z", "lib/a.ts"),
    statusChange("001", "done", "2026-01-01T01:00:00.000Z"),
    row("002", "2026-01-02T00:00:00.000Z", "lib/b.ts"),
    statusChange("002", "wontfix", "2026-01-02T01:00:00.000Z", { wontfix_reason: "n/a" }),
  ]);

  const first = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(first.migrated, 2);
  assert.equal(first.transitionsMigrated, 2);
  const afterFirst = await readRaw(intoPath);

  const second = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.equal(second.migrated, 0);
  assert.equal(second.transitionsMigrated, 0, "no transitions re-appended on the second run");
  assert.equal(second.transitionsSkipped, 2);
  const afterSecond = await readRaw(intoPath);

  assert.equal(afterSecond, afterFirst, "destination is byte-identical after the second --all-refs --apply — no unbounded growth");
});

function countType(rawText, type) {
  return rawText
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === type).length;
}

/**
 * N41 — a CONTESTED row must be surfaced, never resolved by sort order.
 *
 * `--all-refs` dedupes on `(type, source, timestamp)` because ledger ids are
 * per-file and meaningless across refs. When the same logical row carries a
 * DIFFERENT final status on different branches, the dedupe keeps whichever ref
 * sorts first and discards the rest with no report — so a human decision is
 * overridden by alphabetical order, silently.
 *
 * `docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md` D5 settled the shape:
 * **`contested` is a FLAG on the row, not a ninth state.** The row keeps its
 * real content state and carries the conflicting dispositions alongside, so a
 * person can reconcile them deliberately — "like git workflow, decisions should
 * be amended and reconciled if differentiated" (maintainer, 2026-08-21).
 *
 * Live exposure re-measured 2026-08-24, independently of the original report:
 * exactly one row in `SSJK-mb`, `source=CLAUDE.md`, `open` on
 * `feat/impersonate-lucide-icons` against `done` on the other four branches.
 */
test("N41: differing final status across refs is reported as contested, not silently dropped", async () => {
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  const TS = "2026-02-02T00:00:00.000Z";

  // The SAME logical row (type+source+timestamp) on two branches — CLOSED on
  // main, still OPEN on the feature branch. `main` sorts first, so today the
  // feature branch's `open` is the value that disappears.
  await commitLedgerOnBranch(subRoot, "main", [
    row("001", TS, "lib/contested.ts"),
    statusChange("001", "done", "2026-02-03T00:00:00.000Z"),
  ]);
  await commitLedgerOnBranch(subRoot, "feat/still-open", [row("001", TS, "lib/contested.ts")]);

  const res = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });

  assert.ok(Array.isArray(res.contested), `result must carry a contested list, got ${typeof res.contested}`);
  assert.equal(res.contested.length, 1, `expected exactly one contested row, got ${JSON.stringify(res.contested)}`);

  const c = res.contested[0];
  const byRef = Object.fromEntries(c.dispositions.map((d) => [d.ref, d.status]));
  assert.deepEqual(byRef, { main: "done", "feat/still-open": "open" },
    `both dispositions must be preserved, got ${JSON.stringify(byRef)}`);

  // …AND it must reach the ledger, not only the return value. A report nobody
  // stores is a report that vanishes with the terminal.
  // `endsWith`, not `===`: migration RELOCATES source paths relative to the
  // destination root, so this row reads `sub-project/lib/contested.ts`.
  const raw = await readRaw(intoPath);
  const migrated = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .find((r) => r.source?.endsWith("lib/contested.ts") && r.type === "drift");
  assert.ok(migrated, "the row must still migrate — contested is a flag, not a rejection");
  assert.ok(migrated.contested, "the migrated row must carry the flag");
  assert.equal(migrated.status, "open", "and keep its own content state, unchanged (D5: a flag, not a ninth state)");
});

test("N41: agreement across refs is NOT contested — the flag must be able to stay off", async () => {
  // Otherwise every multi-branch row is flagged and the signal is worthless.
  const { subRoot, fromPath, intoPath } = await makeGitWorkspace();
  const TS = "2026-02-04T00:00:00.000Z";
  const agreed = [row("001", TS, "lib/agreed.ts"), statusChange("001", "done", "2026-02-05T00:00:00.000Z")];

  await commitLedgerOnBranch(subRoot, "main", agreed);
  // The branch carries the SAME logical row with the SAME final status, plus one
  // unrelated row. The extra row is not decoration: a branch cut from main whose
  // ledger is byte-identical produces no diff, and `git commit` then fails with
  // "nothing to commit" — the fixture, not the product.
  await commitLedgerOnBranch(subRoot, "feat/same", [
    ...agreed,
    row("002", "2026-02-06T00:00:00.000Z", "lib/unrelated.ts"),
  ]);

  const res = await migrateLedger({ fromPath, intoPath, apply: true, allRefs: true });
  assert.deepEqual(res.contested ?? [], [], `identical dispositions must not be contested: ${JSON.stringify(res.contested)}`);

  const raw = await readRaw(intoPath);
  const migrated = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .find((r) => r.source?.endsWith("lib/agreed.ts") && r.type === "drift");
  assert.ok(migrated && !migrated.contested, "an agreed row must carry no flag");
});
