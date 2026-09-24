/**
 * doctor's `# Delivery` section — is the plugin anyone RUNS the same code as this repo,
 * and is it stale enough to fail the run?
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A VERSION COMPARISON. On 2026-09-16 the served
 * plugin was 0.5.0 while source was 0.6.1 — four merged PRs authored and not
 * delivered, with `commands/goals.mjs` and `lib/claims/restate.mjs` absent from the
 * served tree. Every check in the repo stayed green because every check reads SOURCE.
 *
 * On 2026-09-24 (N78) BOTH manifests read `0.6.2` while `cli.mjs` still differed —
 * 48 commits landed on shipped paths with no VERSION bump, so neither delivery
 * trigger fired, and `claude plugin update` reported "already at the latest version"
 * over a week-stale served tree. That review (decision ledger in
 * `~/.claude/plans/docs-plans-2026-09-23-reminders-todo-bri-playful-dawn.md`) is what
 * this file now pins:
 *
 *   - the whole shipped file set is compared, not one file (a one-file hash can only
 *     catch an absent module by luck);
 *   - the source side is read from COMMITTED content at HEAD, never the working tree
 *     — a dirty file must not move the verdict (the exact regression that got this
 *     module's first failing version reverted);
 *   - doctor FAILS once the served tree is stale past a threshold (commits or days),
 *     or at ANY distance when a shipped path is missing from the served tree;
 *   - remediation text branches by state and never points at `git status` for
 *     `incoherent`, where the tree is reliably clean.
 *
 * TESTS USE REAL GIT REPOS, not just fixture directories with a couple of files —
 * D6's whole point is that the source side reads `git ls-tree -r HEAD`, so a fixture
 * that is not a real git repo cannot exercise the code path this file exists to pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  classifyServed,
  servedTrees,
  checkDelivery,
  shippedPathspec,
  treeDigest,
  changedPaths,
  servedCommit,
  deliveryLag,
  sourceHashesAtHead,
  servedHashesFor,
  activeInstallPath,
} from "../../lib/report/doctor/delivery.mjs";
import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { DELIVERY_MAX_COMMITS, DELIVERY_MAX_DAYS } from "../../lib/core/config.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────

/** Thin `git -C <dir> ...` wrapper, matching the idiom in tests/unit/refs-snapshot.test.mjs. */
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * A REAL git repo with an initial commit. `date` (ISO-ish, anything `git`
 * accepts for GIT_*_DATE) lets tests build commits a controlled number of days
 * apart, which `deliveryLag`'s day bound needs to be testable at all.
 */
function gitRepo(t, { version = "1.0.0", files = {}, date } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "delivery-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFiles(root, { VERSION: `${version}\n`, ...files });
  git(root, "add", "-A");
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"], { encoding: "utf8", env });
  const headSha = git(root, "rev-parse", "HEAD").trim();
  return { root, headSha };
}

/** One more commit on an existing `gitRepo` fixture. Returns the new HEAD sha. */
function commitMore(root, { files = {}, message = "more", date } = {}) {
  writeFiles(root, files);
  git(root, "add", "-A");
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  execFileSync("git", ["-C", root, "commit", "-q", "-m", message], { encoding: "utf8", env });
  return git(root, "rev-parse", "HEAD").trim();
}

/**
 * Served cache tree(s). NOT a git repo — this is what a plain copy on disk is.
 *
 * A real served install carries its own `VERSION` file matching the directory
 * name (verified against the live `.../propagate/0.6.2/VERSION` on this
 * machine), so it is part of the shipped digest like any other file. Defaulted
 * here rather than requiring every fixture to restate it, so a test about
 * something else does not accidentally report `missing: ["VERSION"]`.
 */
function cacheFixture(t, trees) {
  const root = mkdtempSync(path.join(tmpdir(), "delivery-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const { marketplace, version, files = {} } of trees) {
    const dir = path.join(root, marketplace, "propagate", version);
    mkdirSync(dir, { recursive: true });
    writeFiles(dir, { VERSION: `${version}\n`, ...files });
  }
  return root;
}

function installedPluginsFixture(t, pluginsMap) {
  const dir = mkdtempSync(path.join(tmpdir(), "installed-plugins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const p = path.join(dir, "installed_plugins.json");
  writeFileSync(p, JSON.stringify({ version: 2, plugins: pluginsMap }));
  return p;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ── treeDigest: pure, over fixtures — no served tree required ─────────────

test("treeDigest: identical hash maps produce the identical digest (equal -> the passing shape)", () => {
  const fileList = ["a.mjs", "b.mjs"];
  const d1 = treeDigest(fileList, { "a.mjs": "h1", "b.mjs": "h2" });
  const d2 = treeDigest(fileList, { "a.mjs": "h1", "b.mjs": "h2" });
  assert.equal(d1.digest, d2.digest);
  assert.deepEqual(d1.missing, []);
  assert.equal(d1.checked, 2);
});

test("treeDigest: one differing hash changes the digest — THE FAILING BRANCH", () => {
  const fileList = ["a.mjs", "b.mjs"];
  const same = treeDigest(fileList, { "a.mjs": "h1", "b.mjs": "h2" });
  const different = treeDigest(fileList, { "a.mjs": "h1", "b.mjs": "DIFFERENT" });
  assert.notEqual(same.digest, different.digest, "a single byte of drift must move the digest");
});

test("treeDigest: a path in fileList absent from hashes is MISSING, not silently skipped", () => {
  const fileList = ["a.mjs", "b.mjs", "c.mjs"];
  const d = treeDigest(fileList, { "a.mjs": "h1", "c.mjs": "h3" }); // b.mjs never hashed
  assert.deepEqual(d.missing, ["b.mjs"]);
  assert.equal(d.checked, 3);
});

test("treeDigest: EMPTY fileList is a STATED REFUSAL, not a clean digest over zero files", () => {
  const d = treeDigest([], { "a.mjs": "h1" });
  assert.equal(d.digest, null, "no digest may be reported over nothing");
  assert.match(d.refused, /empty/i);
  // The failure this guards: two independently-empty digests must not "match".
  const d2 = treeDigest([], {});
  assert.equal(d.digest, d2.digest, "both are null, which is a refusal, never a passing comparison");
  assert.ok(d.refused && d2.refused, "both calls must say WHY, not just return null");
});

test("changedPaths: only paths present on both sides with a differing hash", () => {
  const fileList = ["a.mjs", "b.mjs", "c.mjs"];
  const source = { "a.mjs": "h1", "b.mjs": "h2", "c.mjs": "h3" };
  const served = { "a.mjs": "h1", "b.mjs": "CHANGED" }; // c.mjs missing entirely — not "changed"
  assert.deepEqual(changedPaths(fileList, source, served), ["b.mjs"]);
});

// ── sourceHashesAtHead / servedHashesFor: batched git plumbing, real repos ─

test("sourceHashesAtHead excludes tests/docs/propagation and returns one hash per shipped file", (t) => {
  const { root } = gitRepo(t, {
    files: {
      "cli.mjs": "content-a",
      "lib/x.mjs": "content-b",
      "tests/unit/x.test.mjs": "should not appear",
      "docs/PLAN.md": "should not appear",
      "propagation/state/workspace/STATE.md": "should not appear",
    },
  });
  const hashes = sourceHashesAtHead(root);
  assert.ok("cli.mjs" in hashes);
  assert.ok("lib/x.mjs" in hashes);
  assert.ok("VERSION" in hashes);
  assert.ok(!("tests/unit/x.test.mjs" in hashes), "tests/ must be excluded");
  assert.ok(!("docs/PLAN.md" in hashes), "docs/ must be excluded");
  assert.ok(!Object.keys(hashes).some((p) => p.startsWith("propagation/")), "propagation/ must be excluded");
});

test("sourceHashesAtHead on a directory with no HEAD returns null — could-not-look, not zero files", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "delivery-norepo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(sourceHashesAtHead(root), null);
});

test("servedHashesFor batches into ONE spawn and matches plain `git hash-object` for present files", (t) => {
  const { root } = gitRepo(t, { files: { "cli.mjs": "hello", "lib/x.mjs": "world" } });
  const hashes = sourceHashesAtHead(root);
  const fileList = Object.keys(hashes);
  const served = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "hello" } }]);
  const servedRoot = path.join(served, "m", "propagate", "1.0.0");
  const servedHashes = servedHashesFor(servedRoot, fileList);
  assert.equal(servedHashes["cli.mjs"], hashes["cli.mjs"], "a byte-identical file must hash identically to the git blob hash");
  assert.ok(!("lib/x.mjs" in servedHashes), "a file absent from the served tree must not appear in the map at all");
});

// ── servedCommit ────────────────────────────────────────────────────────

test("servedCommit: sha present and well-formed is returned", () => {
  const json = { plugins: { "propagate@tathya": [{ scope: "user", gitCommitSha: "28e655a3b17ccd7dd3e1a91db06d62f5cf9a323e" }] } };
  assert.equal(servedCommit(json, "propagate@tathya"), "28e655a3b17ccd7dd3e1a91db06d62f5cf9a323e");
});

test("servedCommit: absent key, null json, and a malformed sha all return null (never a guess)", () => {
  assert.equal(servedCommit({ plugins: {} }, "propagate@tathya"), null);
  assert.equal(servedCommit(null, "propagate@tathya"), null);
  assert.equal(
    servedCommit({ plugins: { "propagate@tathya": [{ scope: "user", gitCommitSha: "not-a-sha" }] } }, "propagate@tathya"),
    null,
  );
  assert.equal(servedCommit({ plugins: { "propagate@tathya": [] } }, "propagate@tathya"), null);
});

// ── deliveryLag ─────────────────────────────────────────────────────────

test("deliveryLag: ancestor true, N shipped-path commits and correct day count", (t) => {
  const tenDaysAgo = daysAgo(10);
  const { root, headSha: servedSha } = gitRepo(t, { files: { "cli.mjs": "v1" }, date: tenDaysAgo });
  commitMore(root, { files: { "cli.mjs": "v2" }, message: "shipped change 1" });
  commitMore(root, { files: { "cli.mjs": "v3" }, message: "shipped change 2" });

  const lag = deliveryLag({ servedSha, repoRoot: root });
  assert.equal(lag.ancestor, true);
  assert.equal(lag.commitsBehind, 2);
  assert.ok(lag.daysBehind >= 9 && lag.daysBehind <= 11, `expected ~10 days, got ${lag.daysBehind}`);
});

test("deliveryLag: served commit NOT an ancestor of HEAD — worded differently, not folded into ordinary lag", (t) => {
  const { root, headSha: mainSha } = gitRepo(t, { files: { "cli.mjs": "v1" } });
  // An orphan branch's commit is a real, valid git object — NOT an error case —
  // it is simply unreachable from main's HEAD. That distinction is the point:
  // this must be a confident "no", not a "could not tell".
  git(root, "checkout", "-q", "-b", "other");
  writeFiles(root, { "cli.mjs": "unrelated" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "unrelated history");
  const otherSha = git(root, "rev-parse", "HEAD").trim();
  git(root, "checkout", "-q", "main");
  assert.equal(git(root, "rev-parse", "HEAD").trim(), mainSha, "sanity: main is back at its own head");

  const lag = deliveryLag({ servedSha: otherSha, repoRoot: root });
  assert.equal(lag.ancestor, false, "a real, valid, but unreachable commit is a confident NO, not null");
  assert.equal(lag.commitsBehind, null, "a non-ancestor must not report a commit count — it would not mean lag");
  assert.equal(lag.daysBehind, null);
});

test("deliveryLag: an unreadable sha (never existed in this repo) is `ancestor: null` — could not tell, not a confident no", (t) => {
  const { root, headSha } = gitRepo(t, {});
  void headSha;
  const lag = deliveryLag({ servedSha: "0000000000000000000000000000000000dead", repoRoot: root });
  assert.equal(lag.ancestor, null);
});

test("deliveryLag: docs-only commits after the served commit do NOT increment commitsBehind", (t) => {
  const { root, headSha: servedSha } = gitRepo(t, { files: { "cli.mjs": "v1" } });
  commitMore(root, { files: { "docs/NOTES.md": "note 1" }, message: "docs only" });
  commitMore(root, { files: { "tests/unit/x.test.mjs": "t()" }, message: "tests only" });
  commitMore(root, { files: { "docs/NOTES.md": "note 2" }, message: "docs only again" });

  const lag = deliveryLag({ servedSha, repoRoot: root });
  assert.equal(lag.ancestor, true);
  assert.equal(lag.commitsBehind, 0, "three doc/test-only commits landed and none of them may count");

  // Now land ONE shipped-path commit and confirm it — and only it — counts.
  commitMore(root, { files: { "cli.mjs": "v2" }, message: "shipped at last" });
  const lag2 = deliveryLag({ servedSha, repoRoot: root });
  assert.equal(lag2.commitsBehind, 1, "exactly the one shipped-path commit, none of the three doc/test commits");
});

// ── classifyServed ──────────────────────────────────────────────────────

function digestsFor({ sourceHashes, servedHashes, fileList = Object.keys(sourceHashes) }) {
  return { sourceDigest: treeDigest(fileList, sourceHashes), servedDigest: treeDigest(fileList, servedHashes) };
}

test("classifyServed: same version AND same digest is `current`", () => {
  const { sourceDigest, servedDigest } = digestsFor({ sourceHashes: { "a.mjs": "h1" }, servedHashes: { "a.mjs": "h1" } });
  const v = classifyServed({ servedVersion: "1.0.0", sourceVersion: "1.0.0", sourceDigest, servedDigest });
  assert.equal(v.state, "current");
});

test("classifyServed: a different version is `stale` — the shape that cost four PRs", () => {
  const { sourceDigest, servedDigest } = digestsFor({ sourceHashes: { "a.mjs": "h1" }, servedHashes: { "a.mjs": "OLD" } });
  const v = classifyServed({ servedVersion: "0.5.0", sourceVersion: "0.6.1", sourceDigest, servedDigest });
  assert.equal(v.state, "stale");
  assert.match(v.why, /0\.5\.0/);
  assert.match(v.why, /0\.6\.1/, "both versions must be named — a reader should not have to go look one up");
});

test("classifyServed: MATCHING version with DIFFERENT content is `incoherent`, never `current`", () => {
  // The load-bearing case. A version-only comparison returns "current" here,
  // which is exactly how the real incident stayed invisible.
  const { sourceDigest, servedDigest } = digestsFor({ sourceHashes: { "a.mjs": "h1" }, servedHashes: { "a.mjs": "DIFFERENT" } });
  const v = classifyServed({ servedVersion: "0.6.1", sourceVersion: "0.6.1", sourceDigest, servedDigest });
  assert.equal(v.state, "incoherent");
  assert.notEqual(v.state, "current");
});

test("classifyServed: a MISSING shipped path is `incoherent` and names the count — the 2026-09-16 shape", () => {
  const fileList = ["a.mjs", "b.mjs", "c.mjs"];
  const sourceDigest = treeDigest(fileList, { "a.mjs": "h1", "b.mjs": "h2", "c.mjs": "h3" });
  const servedDigest = treeDigest(fileList, { "a.mjs": "h1" }); // b.mjs, c.mjs absent
  const v = classifyServed({ servedVersion: "1.0.0", sourceVersion: "1.0.0", sourceDigest, servedDigest });
  assert.equal(v.state, "incoherent");
  assert.match(v.why, /2 shipped path/);
  assert.deepEqual(v.missing.sort(), ["b.mjs", "c.mjs"]);
});

// ── servedTrees: discovery unchanged by this review ────────────────────

test("servedTrees finds every tree, not just the newest", (t) => {
  const root = cacheFixture(t, [
    { marketplace: "tathya", version: "0.5.0", files: { "cli.mjs": "old" } },
    { marketplace: "tathya", version: "0.6.1", files: { "cli.mjs": "new" } },
  ]);
  const found = servedTrees(root).map((x) => x.version).sort();
  assert.deepEqual(found, ["0.5.0", "0.6.1"], "a half-finished update leaves two — picking one would hide it");
});

test("servedTrees on a missing cache root returns empty, never throws", () => {
  assert.deepEqual(servedTrees(path.join(tmpdir(), "definitely-not-here-" + Date.now())), []);
});

// ── checkDelivery: the whole section, integration-level ────────────────

test("NOT INSTALLED and CURRENT do not render alike", async (t) => {
  const { root: repo } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "same" } });
  const emptyCache = mkdtempSync(path.join(tmpdir(), "delivery-empty-"));
  t.after(() => rmSync(emptyCache, { recursive: true, force: true }));
  const okCache = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "same" } }]);

  const rNone = new Reporter();
  await checkDelivery({ reporter: rNone, repoRoot: repo, cacheRoot: emptyCache });
  const rOk = new Reporter();
  await checkDelivery({ reporter: rOk, repoRoot: repo, cacheRoot: okCache });

  const noneText = JSON.stringify(rNone.entries);
  const okText = JSON.stringify(rOk.entries);
  assert.match(noneText, /not installed/, "an absent plugin must say so in those words");
  assert.doesNotMatch(noneText, /identical/, "absence must never borrow the wording of agreement");
  assert.match(okText, /identical/);
  assert.equal(rOk.entries.find((e) => e.kind === "pass" || e.kind === "fail")?.kind, "pass");
  assert.notEqual(noneText, okText);
});

test("an unreadable VERSION is attributable, never a silent pass", async (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), "delivery-noversion-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const cache = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "x" } }]);
  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache });
  assert.match(JSON.stringify(r.entries), /could not read|cannot be judged/);
});

test("a missing gitCommitSha is INCONCLUSIVE with a reason — never a pass (T6-f)", async (t) => {
  const { root: repo } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v1" } });
  const cache = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "DIFFERENT" } }]);
  // installed_plugins.json exists but has no entry for propagate@m at all.
  const installedPluginsPath = installedPluginsFixture(t, {});

  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });

  const lagEntry = r.entries.find((e) => /delivery lag/.test(e.label));
  assert.ok(lagEntry, `expected a delivery-lag entry; got ${JSON.stringify(r.entries)}`);
  assert.equal(lagEntry.kind, "inconclusive", "absent gitCommitSha must never read as a pass");
  assert.match(lagEntry.detail, /no gitCommitSha|installed_plugins/, "the reason must be stated, not just the null");
  assert.ok(r.problems > 0, "inconclusive must still count toward doctor's exit code — 'never a pass' means never zero cost either");
});

test("a served commit NOT an ancestor of HEAD gets DISTINCT wording, not an ordinary lag message (T6-h)", async (t) => {
  const { root: repo, headSha: mainSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v1" } });
  git(repo, "checkout", "-q", "-b", "other");
  writeFiles(repo, { "cli.mjs": "unrelated" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "unrelated");
  const otherSha = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", "main");
  assert.equal(git(repo, "rev-parse", "HEAD").trim(), mainSha);

  const cache = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "DIFFERENT" } }]);
  const installedPluginsPath = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: otherSha }] });

  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });

  const lagEntry = r.entries.find((e) => /delivery lag/.test(e.label));
  assert.ok(lagEntry);
  assert.equal(lagEntry.kind, "inconclusive");
  assert.match(lagEntry.detail, /not.*an ancestor/i);
  assert.doesNotMatch(lagEntry.detail, /\d+ shipped-path commit\(s\)/, "must not read like an ordinary N-commits-behind message");
});

test("a shipped path MISSING from the served tree FAILS at ANY distance — even at zero commits behind (T6-c)", async (t) => {
  const { root: repo, headSha } = gitRepo(t, {
    version: "1.0.0",
    files: { "cli.mjs": "v1", "lib/x.mjs": "v1" },
  });
  // The served tree is missing lib/x.mjs entirely — the literal 2026-09-16 shape —
  // while the served commit IS the current HEAD (zero commits behind).
  const cache = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "v1" } }]);
  const installedPluginsPath = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: headSha }] });

  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });

  const e = r.entries.find((x) => x.kind === "pass" || x.kind === "fail");
  assert.ok(e, `expected a pass/fail verdict entry; got ${JSON.stringify(r.entries)}`);
  assert.equal(e.kind, "fail", "missing at zero commits behind must still fail — 'at any distance' means this exact case");
  assert.match(e.detail, /lib\/x\.mjs/, "the missing path itself must be named");
});

test("THE REGRESSION: a dirty working tree at zero shipped-path commits behind must still PASS", async (t) => {
  const { root: repo, headSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v1", "lib/x.mjs": "v1" } });
  const cache = cacheFixture(t, [
    { marketplace: "m", version: "1.0.0", files: { "cli.mjs": "v1", "lib/x.mjs": "v1" } }, // byte-identical to the COMMIT
  ]);
  const installedPluginsPath = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: headSha }] });

  // Dirty the working tree AFTER committing — uncommitted, never staged.
  // This is exactly the state that reverted this module's first failing
  // version: cli.mjs edited since the last delivery, mid-work, nothing wrong.
  writeFiles(repo, { "cli.mjs": "mid-edit, not committed" });

  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });

  const e = r.entries.find((x) => x.kind === "pass" || x.kind === "fail" || x.kind === "warn");
  assert.ok(e, `expected a verdict entry; got ${JSON.stringify(r.entries)}`);
  assert.equal(e.kind, "pass", "an uncommitted edit must not move the verdict — the source side reads HEAD, not disk");
});

test("fail vs warn at the bound: past DELIVERY_MAX_COMMITS fails; within it warns (T6-j)", async (t) => {
  const recent = daysAgo(1); // keep the day bound out of play for this test
  const { root: repo, headSha: servedSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v0" }, date: recent });

  // Land DELIVERY_MAX_COMMITS + 1 shipped-path commits — must FAIL.
  let sha = servedSha;
  for (let i = 0; i < DELIVERY_MAX_COMMITS + 1; i++) {
    sha = commitMore(repo, { files: { "cli.mjs": `v${i + 1}` }, message: `shipped ${i + 1}`, date: recent });
  }
  const cacheOver = cacheFixture(t, [{ marketplace: "m", version: "9.9.9", files: { "cli.mjs": "v0" } }]); // deliberately STALE version too
  const installedOver = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: servedSha }] });
  const rOver = new Reporter();
  await checkDelivery({ reporter: rOver, repoRoot: repo, cacheRoot: cacheOver, installedPluginsPath: installedOver });
  const overEntry = rOver.entries.find((x) => x.kind === "pass" || x.kind === "fail" || x.kind === "warn");
  assert.equal(overEntry.kind, "fail", `${DELIVERY_MAX_COMMITS + 1} commits behind must fail; got ${JSON.stringify(overEntry)}`);
  assert.match(overEntry.detail, new RegExp(`${DELIVERY_MAX_COMMITS + 1} shipped-path commit`));

  // A fresh repo, ONE shipped-path commit behind — must WARN, not fail.
  const { root: repo2, headSha: servedSha2 } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v0" }, date: recent });
  commitMore(repo2, { files: { "cli.mjs": "v1" }, message: "one shipped commit", date: recent });
  const cacheUnder = cacheFixture(t, [{ marketplace: "m", version: "9.9.9", files: { "cli.mjs": "v0" } }]);
  const installedUnder = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: servedSha2 }] });
  const rUnder = new Reporter();
  await checkDelivery({ reporter: rUnder, repoRoot: repo2, cacheRoot: cacheUnder, installedPluginsPath: installedUnder });
  const underEntry = rUnder.entries.find((x) => x.kind === "pass" || x.kind === "fail" || x.kind === "warn");
  assert.equal(underEntry.kind, "warn", `1 commit behind (bound is ${DELIVERY_MAX_COMMITS}) must warn, not fail`);
});

test("the day bound fails independently of the commit bound", async (t) => {
  const old = daysAgo(DELIVERY_MAX_DAYS + 2);
  const { root: repo, headSha: servedSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v0" }, date: old });
  // Exactly ONE shipped commit (well under the commit bound) but the served
  // commit itself is old enough to cross the day bound alone.
  commitMore(repo, { files: { "cli.mjs": "v1" }, message: "one shipped commit" });

  const cache = cacheFixture(t, [{ marketplace: "m", version: "9.9.9", files: { "cli.mjs": "v0" } }]);
  const installedPluginsPath = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: servedSha }] });
  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });
  const e = r.entries.find((x) => x.kind === "pass" || x.kind === "fail" || x.kind === "warn");
  assert.equal(e.kind, "fail", `${DELIVERY_MAX_DAYS + 2} days behind must fail on the day bound alone`);
});

test("remediation branches by state: `stale` names `plugin update`; `incoherent` names BOTH verified paths; NEITHER ever cites git status", async (t) => {
  const recent = daysAgo(1);
  // stale: version differs.
  const { root: staleRepo, headSha: staleSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v0" }, date: recent });
  commitMore(staleRepo, { files: { "cli.mjs": "v1" }, message: "shipped", date: recent });
  const staleCache = cacheFixture(t, [{ marketplace: "tathya", version: "0.5.0", files: { "cli.mjs": "v0" } }]);
  const staleInstalled = installedPluginsFixture(t, { "propagate@tathya": [{ scope: "user", gitCommitSha: staleSha }] });
  const rStale = new Reporter();
  await checkDelivery({ reporter: rStale, repoRoot: staleRepo, cacheRoot: staleCache, installedPluginsPath: staleInstalled });
  const staleEntry = rStale.entries.find((x) => x.kind === "warn" || x.kind === "fail");
  assert.match(staleEntry.detail, /claude plugin update propagate@tathya/);
  assert.doesNotMatch(staleEntry.detail, /git status/i);

  // incoherent: version matches, content differs.
  const { root: incRepo, headSha: incSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v0" }, date: recent });
  commitMore(incRepo, { files: { "cli.mjs": "v1" }, message: "shipped", date: recent });
  const incCache = cacheFixture(t, [{ marketplace: "tathya", version: "1.0.0", files: { "cli.mjs": "v0" } }]);
  const incInstalled = installedPluginsFixture(t, { "propagate@tathya": [{ scope: "user", gitCommitSha: incSha }] });
  const rInc = new Reporter();
  await checkDelivery({ reporter: rInc, repoRoot: incRepo, cacheRoot: incCache, installedPluginsPath: incInstalled });
  const incEntry = rInc.entries.find((x) => x.kind === "warn" || x.kind === "fail");
  assert.match(incEntry.detail, /bump VERSION/);
  assert.match(incEntry.detail, /claude plugin marketplace update tathya/);
  assert.match(incEntry.detail, /claude plugin uninstall propagate@tathya/);
  assert.match(incEntry.detail, /claude plugin install propagate@tathya/);
  assert.doesNotMatch(incEntry.detail, /git status/i, "the incoherent branch must never point at git status — the tree is reliably clean here");
});

test("doctor's exit code IS affected once a served tree fails delivery — a deliberate correction to this module's first version", async (t) => {
  // The module's very first version never failed doctor at all (see the
  // module header). That was itself a correction to an EARLIER version that
  // failed unconditionally on `incoherent` and fired on ordinary development.
  // This is the third position: fail only past the threshold.
  const recent = daysAgo(1);
  const { root: repo, headSha: servedSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v0" }, date: recent });
  let sha = servedSha;
  for (let i = 0; i < DELIVERY_MAX_COMMITS + 1; i++) {
    sha = commitMore(repo, { files: { "cli.mjs": `v${i + 1}` }, message: `shipped ${i + 1}`, date: recent });
  }
  void sha;
  const cache = cacheFixture(t, [{ marketplace: "m", version: "1.0.0", files: { "cli.mjs": "v0" } }]);
  const installedPluginsPath = installedPluginsFixture(t, { "propagate@m": [{ scope: "user", gitCommitSha: servedSha }] });
  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });
  assert.ok(r.problems > 0, "a served tree past the staleness bound must contribute to doctor's exit code");
});

// ── T5: config defaults (G24) ───────────────────────────────────────────

test("DELIVERY_MAX_COMMITS/DELIVERY_MAX_DAYS resolve to explicit built-in defaults, never null (G24)", () => {
  // This test's own environment (npm run test:propagate's PROPAGATE_STATE_DIR)
  // has no config.yml, which is exactly the "nobody configured this" case G24
  // warns about: a key read with no built-in fallback resolves to undefined the
  // moment nobody has written a config file, and undefined fails every numeric
  // bound comparison silently rather than loudly disabling the gate.
  assert.equal(DELIVERY_MAX_COMMITS, 10, "an unconfigured install must still get a real bound, not null/undefined");
  assert.equal(DELIVERY_MAX_DAYS, 7);
  assert.equal(typeof DELIVERY_MAX_COMMITS, "number");
  assert.equal(typeof DELIVERY_MAX_DAYS, "number");
});

// ── T10: the shipped pathspec is exported once, and CI must derive it ──────

test("shippedPathspec is exported and CI's workflow contains no hardcoded shipped-path list", () => {
  assert.ok(Array.isArray(shippedPathspec()) && shippedPathspec().length > 0);

  const workflowPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "test.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  assert.doesNotMatch(
    workflow,
    /:\(exclude\)/,
    "a literal pathspec-exclude token in the workflow means the shipped-path list was restated in YAML instead of derived from delivery.mjs (D12/T10)",
  );
  assert.match(workflow, /shippedPathspec/, "the workflow must actually call the exported definition, not merely avoid the literal token");
});

// ── only the LIVE served tree can fail a run (leftover cache trees) ──────
//
// Measured 2026-09-24, after the failing branch landed: this machine's cache held
// 0.5.0, 0.6.1 and the live 0.6.2, and judging all three alike rendered ONE real
// problem as THREE `✗` rows. A leftover is stale by definition, so gating on it
// manufactures false positives — the noise this module's header says trains people
// to ignore the check. `installed_plugins.json` already records `installPath`.

test("activeInstallPath resolves the served install, and refuses what it cannot determine", async (t) => {
  assert.equal(
    activeInstallPath({ plugins: { "propagate@m": [{ scope: "user", installPath: "/a/b/0.6.2" }] } }, "propagate@m"),
    path.resolve("/a/b/0.6.2"),
  );
  assert.equal(activeInstallPath({ plugins: {} }, "propagate@m"), null, "no entry must be null, not a guess");
  assert.equal(activeInstallPath(null, "propagate@m"), null, "an unreadable file must be null");
  assert.equal(
    activeInstallPath({ plugins: { "propagate@m": [{ scope: "user" }] } }, "propagate@m"),
    null,
    "an entry with no installPath must be null rather than undefined leaking into a path compare",
  );
  // Same selection rule as servedCommit, so the two can never disagree about which entry they mean.
  const twoScopes = {
    plugins: { "propagate@m": [{ scope: "project", installPath: "/proj" }, { scope: "user", installPath: "/user" }] },
  };
  assert.equal(activeInstallPath(twoScopes, "propagate@m"), path.resolve("/user"), "user scope wins, as in servedCommit");
});

test("a LEFTOVER cache tree warns and does NOT fail the run — only the live tree gates", async (t) => {
  const { root: repo, headSha } = gitRepo(t, { version: "1.0.0", files: { "cli.mjs": "v1" } });
  const cache = cacheFixture(t, [
    { marketplace: "m", version: "0.9.0", files: { "cli.mjs": "ANCIENT" } },
    { marketplace: "m", version: "1.0.0", files: { "cli.mjs": "v1" } },
  ]);
  const activeRoot = path.join(cache, "m", "propagate", "1.0.0");
  const installedPluginsPath = installedPluginsFixture(t, {
    "propagate@m": [{ scope: "user", installPath: activeRoot, gitCommitSha: headSha }],
  });

  const r = new Reporter();
  await checkDelivery({ reporter: r, repoRoot: repo, cacheRoot: cache, installedPluginsPath });

  const leftover = r.entries.filter((e) => /LEFTOVER/.test(String(e.label)));
  assert.equal(leftover.length, 1, `exactly one leftover entry expected; got ${JSON.stringify(r.entries.map((e) => e.label))}`);
  assert.equal(leftover[0].kind, "warn", "a leftover is a cleanup fact about the machine, not a delivery failure");
  assert.match(leftover[0].detail, /0\.9\.0/, "the detail must name which tree is the leftover");
  assert.doesNotMatch(String(leftover[0].label), /0\.9\.0/, "a warning's label is its KIND, not the row (N87 slice 3)");

  // The live tree is byte-identical here, so nothing should fail at all.
  const failures = r.entries.filter((e) => e.kind === "fail");
  assert.equal(failures.length, 0, `a leftover alone must not fail the run; failed on ${JSON.stringify(failures)}`);
});
