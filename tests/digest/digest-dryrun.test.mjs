/**
 * --dry-run must not delete anything.
 *
 * digest.mjs's header promises "--dry-run — print, write NO state". Until
 * 2026-08-14 that was false: `dryRun` existed only inside runDigest(), where it
 * gated state-writing and delivery, while buildSnapshot() -> lifecycleSweep()
 * called `lc.reap(candidates, { apply: true })` unconditionally. A "preview"
 * ran an armed skill deletion. Nothing was lost only because zero skills were
 * reapable at the time (docs/GOTCHAS.md G22).
 *
 * These are source-level assertions, and that is a deliberate, stated
 * limitation rather than an oversight: exercising the real path means running
 * lifecycle discovery against the live ~/.claude/skills tree, and a test whose
 * failure mode is "deleted one of Rupali's skills" is not a test worth having.
 * The bug was pure wiring — a parameter that did not reach its call site — so a
 * wiring assertion catches exactly the regression that occurred. The behaviour
 * of reap() itself (archives first, refuses when disarmed) is covered by
 * skills-lifecycle's own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { refsUncommittedForTest, mirrorProtectionForTest } from "../../digest.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIGEST = readFileSync(path.join(REPO, "digest.mjs"), "utf8");

test("digest never calls reap with a hardcoded apply:true", () => {
  const armed = DIGEST.match(/reap\([^)]*\{\s*apply:\s*true\s*\}/);
  assert.equal(
    armed,
    null,
    "reap() is hardcoded armed — a --dry-run digest would delete. Gate it on !dryRun.",
  );
});

test("reap is gated on the dryRun flag", () => {
  assert.match(
    DIGEST,
    /lc\.reap\(candidates,\s*\{\s*apply:\s*!dryRun\s*\}\)/,
    "reap must be applied only when this is not a dry run",
  );
});

test("dryRun reaches lifecycleSweep from the CLI entry point", () => {
  // The three links in the chain that was broken. Each is asserted separately
  // so a failure names which link came apart, rather than just "wiring".
  assert.match(DIGEST, /async function buildSnapshot\([^)]*dryRun/, "buildSnapshot must accept dryRun");
  assert.match(DIGEST, /buildSnapshot\(indexDb,\s*\{\s*dryRun\s*\}\)/, "runDigest must pass dryRun to buildSnapshot");
  assert.match(DIGEST, /lifecycleSweep\(dryRun\)/, "buildSnapshot must pass dryRun to lifecycleSweep");
  assert.match(DIGEST, /async function lifecycleSweep\(dryRun/, "lifecycleSweep must accept dryRun");
});

test("a preview-skipped reap is distinguishable from a disarmed one", () => {
  // Two different reasons for the same absence must not collapse into one
  // field, or a preview reads as the kill switch firing (G2).
  assert.match(DIGEST, /reapPreviewOnly/, "preview-skipped reaps need their own field");
  assert.match(DIGEST, /reapBlocked/, "disarm-blocked reaps keep theirs");
});

/* ── the refs rider (ISSUES N55) ────────────────────────────────────────── */

test("the refs refresh is gated on dryRun, and the flag reaches it", () => {
  // Same three-link wiring assertion as lifecycleSweep above, for the same
  // reason: the 2026-08-14 bug was a parameter that did not reach its call
  // site, and this rider is a second write path added to the same file.
  assert.match(DIGEST, /async function refsSnapshot\(dryRun/, "refsSnapshot must accept dryRun");
  assert.match(DIGEST, /refsSnapshot\(dryRun\)/, "buildSnapshot must pass dryRun to refsSnapshot");
  assert.match(
    DIGEST,
    /migrateRefs\(\{\s*workspace:[^}]*apply:\s*!dryRun\s*\}\)/,
    "the registry refresh must be applied only when this is not a dry run",
  );
});

test("the refs refresh is never hardcoded armed", () => {
  // The negative control, mirroring the reap assertion at the top of this file.
  // `[^)]*` deliberately spans the options object so an armed call is caught
  // however its other fields are ordered.
  const armed = DIGEST.match(/migrateRefs\([^)]*apply:\s*true/);
  assert.equal(armed, null,
    "migrateRefs is hardcoded armed — a --dry-run digest would write to every registry");
});

test("a workspace whose refresh FAILS is reported, never skipped", () => {
  // N55 is a component that stopped running while nothing said so. A rider
  // that swallowed per-workspace errors would rebuild that exact silence
  // inside the fix.
  assert.match(DIGEST, /results\.push\(\{\s*workspace:[^}]*ok:\s*false/,
    "a failed workspace must appear in the results with ok:false");
  assert.match(DIGEST, /refsLines\.push\(`! \$\{r\.workspace\}/,
    "and it must reach the rendered digest, not just the snapshot");
});

test("the adoption warning fires AFTER the write, not before it", () => {
  // Reported by the session working in obsidian-vk-publish, from a real
  // incident: the refresh created propagation/refs/* while its repo had
  // uncommitted work, and its next `git add -A` swept those files into an
  // unrelated commit. "One -A away from being authored by whoever commits next."
  //
  // The first fix sampled `treeDirty()` BEFORE the write. They asked for a
  // better one and were right: that warning describes a transient state, fires
  // once into a 09:00 log, and is addressed to nobody. Untracked-after-the-write
  // persists until someone acts on it. "The first warning was advice, the
  // second is evidence it went unread."
  assert.doesNotMatch(DIGEST, /treeDirty/,
    "the dirty-tree check is superseded — warn on files still uncommitted on a LATER run instead");
  assert.match(DIGEST, /const pending = dryRun \? 0 : refsUncommitted\(ws\.root\)/);
  assert.doesNotMatch(DIGEST, /ls-files", "--others/,
    "untracked-only is too narrow: `git add -A` sweeps MODIFIED tracked files too");

  const writeAt = DIGEST.indexOf("await migrateRefs({ workspace: ws.root");
  const checkAt = DIGEST.indexOf("refsUncommitted(ws.root)");
  assert.ok(writeAt > 0 && checkAt > 0, "the refresh block moved — this check has gone blind");
  assert.ok(checkAt > writeAt,
    "the check must run AFTER the write: what it asks is whether what this tool produced is unadopted");

  // WARN, never refuse. Refusing would stop the refresh for any workspace with
  // uncommitted work -- most of them, most of the time -- and a refresh that
  // silently stops is N55, the issue this rider exists to fix.
  assert.doesNotMatch(DIGEST, /if \(pending\)[^\n]*continue;/,
    "uncommitted output must not skip the refresh — that rebuilds the silence N55 is about");

  // Unreadable git state is its own outcome, not "adopted".
  assert.match(DIGEST, /gitUnreadable/,
    "could-not-read must be distinguishable from clean (rule:discernment-checks §2)");
});

test("refsUncommitted RUNS, and tells the cases apart — including a MODIFIED tracked file", () => {
  // Behavioural, unlike its neighbours above, and deliberately so: those are
  // source assertions because executing reap() would delete real skills. This
  // is a read-only `git ls-files`, so there is no excuse for not running it --
  // rule:name-what-no-test-executes. A source assertion here would prove the
  // call is spelled correctly and nothing about whether it answers.
  const root = mkdtempSync(path.join(tmpdir(), "refs-untracked-"));
  try {
    const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");

    assert.equal(refsUncommittedForTest(root), 0, "an empty repo owes nobody an adoption");

    mkdirSync(path.join(root, "propagation", "refs"), { recursive: true });
    writeFileSync(path.join(root, "propagation", "refs", "snapshot.json"), "{}");
    assert.equal(refsUncommittedForTest(root), 1, "a freshly written registry is untracked — warn");

    // Unrelated uncommitted work must NOT trigger it. This is the whole
    // difference from treeDirty(), which counted exactly this as a reason.
    writeFileSync(path.join(root, "unrelated.txt"), "someone else's work in progress");
    assert.equal(refsUncommittedForTest(root), 1,
      "the warning is about OUR output, not about the state of their tree");

    git("add", "propagation");
    git("commit", "-qm", "adopt the registry");
    assert.equal(refsUncommittedForTest(root), 0,
      "once committed the warning must STOP, or it is noise and gets filtered out");

    // THE CASE `ls-files --others` MISSED, and the common one: after the first
    // adoption every later refresh MODIFIES a tracked file. `git add -A` sweeps
    // that identically, so reporting 0 here would be the original hazard back.
    writeFileSync(path.join(root, "propagation", "refs", "snapshot.json"), '{"captured_at":"later"}');
    assert.equal(refsUncommittedForTest(root), 1,
      "a MODIFIED tracked registry is still unadopted — untracked-only answers a narrower question");

    // Staged-but-not-committed is also still swept, and still unadopted.
    git("add", "propagation/refs/snapshot.json");
    assert.equal(refsUncommittedForTest(root), 1,
      "staging is not committing — a staged registry is one `git commit` away from an unrelated commit");

    assert.equal(refsUncommittedForTest(path.join(root, "nope")), null,
      "a path git cannot read is null, never 0 (rule:discernment-checks §2)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT-STORE BACKUP (N84 / N107)
//
// N84 closed on the finding that 2,946 events carrying 611 KB of hand-written
// reasoning lived in one directory with no git remote. The mirror that fixed it
// was a manual `cp`, so N107 made it ride this digest.
//
// The tests below split the way the feature does: WIRING is source-asserted,
// matching this file's existing rationale for the reap() block; BEHAVIOUR is
// executed, because unlike reap() this path only reads, hashes and copies, and
// rule:name-what-no-test-executes gives no excuse for a source assertion where a
// real one is cheap.
// ─────────────────────────────────────────────────────────────────────────────

test("the backup is gated on dryRun, and the flag reaches it", () => {
  assert.match(DIGEST, /eventsBackupSnapshot\(dryRun\)/,
    "the rider must receive the flag, not re-derive it — that was the 2026-08-14 reap() bug exactly");
  assert.match(DIGEST, /if \(dryRun\) \{\s*\n\s*results\.push\(\{ file: src\.rel, action: "would-copy"/,
    "a dry run must report what it WOULD copy and copy nothing");
});

test("the backup never writes unconditionally — every copy is behind the flag", () => {
  // The shape of the original defect: a write reachable on a path the flag does
  // not cover. There is exactly one copyFileSync, and the dryRun branch returns
  // before it.
  const copies = DIGEST.match(/copyFileSync\(/g) ?? [];
  assert.equal(copies.length, 1, "more than one copy site means one of them can escape the flag");
  const flagAt = DIGEST.indexOf('if (dryRun) {\n      results.push({ file: src.rel, action: "would-copy"');
  const copyAt = DIGEST.indexOf("copyFileSync(src.abs, target)");
  assert.ok(flagAt > 0 && copyAt > 0, "the backup block moved — this check has gone blind");
  assert.ok(flagAt < copyAt, "the dryRun return must precede the copy");
});

test("the backup never stages or commits in the destination repo", () => {
  // N104: `migrate --apply` staged into another repo's index and the owner's next
  // commit adopted 189 of its lines 40 seconds later. A scheduled job writing
  // into someone else's working tree does not touch their index.
  const block = DIGEST.slice(
    DIGEST.indexOf("async function eventsBackupSnapshot"),
    DIGEST.indexOf("async function buildSnapshot"),
  );
  assert.ok(block.length > 500, "the backup function moved — this check has gone blind");
  for (const forbidden of ['"add"', '"commit"', '"push"', '"stage"']) {
    assert.ok(!block.includes(forbidden),
      `eventsBackupSnapshot must never run git ${forbidden} — it reports, a human adopts (N104)`);
  }
});

test("freshness and protection are reported as SEPARATE facts", () => {
  // The whole reason this rider is not a copy of refsSnapshot. The refs
  // registries were fresh and uncommitted for days; for a backup that is total
  // failure, because only the remote survives a lost disk.
  assert.match(DIGEST, /unpushed/,
    "committed-but-unpushed must be distinguishable — a backup on one disk is not a backup");
  assert.match(DIGEST, /rev-list", "--count", "@\{u\}\.\.HEAD/);
  assert.doesNotMatch(DIGEST, /events-backup[^\n]*ls-files", "--others/,
    "untracked-only is too narrow: after the first adoption every refresh MODIFIES a tracked file");
});

test("mirrorProtection RUNS, and tells committed-not-pushed apart from pushed", () => {
  // The case refsUncommitted() cannot see at all, and the reason T2 exists.
  const tmp = mkdtempSync(path.join(tmpdir(), "mirror-protect-"));
  try {
    const bare = path.join(tmp, "origin.git");
    const work = path.join(tmp, "work");
    const g = (root, ...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
    spawnSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8" });
    spawnSync("git", ["clone", "-q", bare, work], { encoding: "utf8" });
    g(work, "config", "user.email", "t@t");
    g(work, "config", "user.name", "t");
    // A clone of an empty bare repo has no upstream-tracking HEAD yet, so seed one.
    writeFileSync(path.join(work, "seed.txt"), "seed");
    g(work, "add", "seed.txt");
    g(work, "commit", "-qm", "seed");
    g(work, "push", "-q", "-u", "origin", "HEAD:refs/heads/main");

    const rel = path.join("propagation", "events-backup");
    const shard = path.join(work, rel, "2026-08.jsonl");

    assert.deepEqual(mirrorProtectionForTest(work, rel), { dirty: 0, unpushed: 0 },
      "a repo with no mirror yet owes nobody an adoption");

    mkdirSync(path.dirname(shard), { recursive: true });
    writeFileSync(shard, '{"event_id":"a"}\n');
    assert.equal(mirrorProtectionForTest(work, rel).dirty, 1,
      "a freshly written mirror is untracked — UNPROTECTED");

    // Unrelated uncommitted work must NOT count. The question is about OUR
    // output, not the state of their tree.
    writeFileSync(path.join(work, "unrelated.txt"), "someone else's work");
    assert.equal(mirrorProtectionForTest(work, rel).dirty, 1,
      "the warning is about the mirror, not about their working tree");

    g(work, "add", rel);
    g(work, "commit", "-qm", "adopt the mirror");
    const committed = mirrorProtectionForTest(work, rel);
    assert.equal(committed.dirty, 0, "committing must clear the dirty count");
    assert.equal(committed.unpushed, 1,
      "COMMITTED IS NOT PROTECTED — one unpushed commit is still one disk failure from gone, " +
      "and this is the case refsUncommitted() cannot express");

    g(work, "push", "-q");
    assert.deepEqual(mirrorProtectionForTest(work, rel), { dirty: 0, unpushed: 0 },
      "only pushed counts as protected");

    // THE COMMON CASE after the first adoption: a MODIFIED tracked file.
    writeFileSync(shard, '{"event_id":"a"}\n{"event_id":"b"}\n');
    assert.equal(mirrorProtectionForTest(work, rel).dirty, 1,
      "a modified tracked mirror is unadopted again — new events are unprotected");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mirrorProtection reports UNREADABLE git state as null, never as protected", () => {
  // rule:discernment-checks §2. Claiming protection because the check failed is
  // the reassuring silence this digest is otherwise full of warnings about.
  const notARepo = mkdtempSync(path.join(tmpdir(), "mirror-nogit-"));
  try {
    const p = mirrorProtectionForTest(notARepo, "propagation/events-backup");
    assert.equal(p.dirty, null, "outside a repo, dirty is unknown — not 0");
    assert.equal(p.unpushed, null, "outside a repo, unpushed is unknown — not 0");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("an unconfigured hub is a NAMED refusal, not an empty result", () => {
  // G24: HUB_ROOT has no built-in default and resolves to null, deliberately,
  // because a plausible-but-wrong hub finds zero workspaces and reports healthy.
  // An empty `results` array would render as "nothing to back up" — the exact
  // shape where "found nothing" and "looked at nothing" collapse into one output.
  const emptyState = mkdtempSync(path.join(tmpdir(), "mirror-nohub-"));
  try {
    const script =
      'import("' + pathToFileURL(path.join(REPO, "digest.mjs")).href + '")' +
      '.then(async (m) => { const r = await m.eventsBackupSnapshotForTest(false);' +
      ' process.stdout.write(JSON.stringify({ reason: r.reason, dest: r.dest, n: r.results.length })); })';
    const out = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_STATE_DIR: emptyState },
    });
    const parsed = JSON.parse(out.stdout || "{}");
    assert.equal(parsed.reason, "hub-root-unconfigured",
      `expected a named refusal; got ${out.stdout || out.stderr}`);
    assert.equal(parsed.dest, null);
    assert.equal(parsed.n, 0);
  } finally {
    rmSync(emptyState, { recursive: true, force: true });
  }
});
