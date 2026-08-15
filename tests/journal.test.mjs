/**
 * The journal, and the two traps that moved its headline figure three times.
 *
 * For 2026-08-14 the day's activity was reported as 95/21, then 109/22, then 63/10,
 * before settling at **118/24** — confirmed by two independent implementations. Each move
 * was one of the traps below, and both are asserted here so neither can come back.
 *
 *   1. SYMLINKS. `find … -name .git` and `readdirSync().filter(e => e.isDirectory())`
 *      both skip symlinked directories — a Dirent for one answers isSymbolicLink().
 *      `~/Documents/GitHub/propagate-skill` is a symlink, so 14 commits were invisible.
 *   2. BARE DATES. `--until=2026-08-15` goes through git's approxidate parser and
 *      admitted commits stamped 2026-08-15.
 *
 * The second is why `commitsIn` throws on a bare date rather than quietly accepting it:
 * this module's whole purpose is producing a number someone will trust.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { enumerateRepos, commitsIn, journal } from "../lib/journal.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

async function repoAt(dir, when) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  await writeFile(path.join(dir, "f.txt"), "x\n", "utf8");
  git(dir, "add", ".");
  execFileSync("git", ["commit", "-q", "-m", "seed"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  return dir;
}

test("a symlinked repo IS enumerated, and is reported as reached via a link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-"));
  const real = await repoAt(path.join(root, "elsewhere", "actual-repo"), "2026-08-14T10:00:00+05:30");
  const visible = path.join(root, "tree");
  await mkdir(visible, { recursive: true });
  await symlink(real, path.join(visible, "linked-repo"));

  const { repos, symlinked } = enumerateRepos([visible]);
  assert.equal(repos.length, 1, "the symlinked repo must be found — plain find/isDirectory misses it");
  assert.equal(symlinked.length, 1, "and must be REPORTED as symlink-reached, not silently folded in");
  assert.match(symlinked[0], /linked-repo$/);
});

test("without the symlink there is nothing to find — proves the fix, not the platform", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-nolink-"));
  const visible = path.join(root, "tree");
  await mkdir(visible, { recursive: true });
  const { repos } = enumerateRepos([visible]);
  assert.deepEqual(repos, []);
});

test("a symlink cycle terminates instead of recursing forever", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-cycle-"));
  const a = path.join(root, "a");
  await mkdir(a, { recursive: true });
  await symlink(root, path.join(a, "loop")); // points at its own ancestor
  const { repos } = enumerateRepos([root]);
  assert.deepEqual(repos, [], "must return, not hang — following symlinks makes cycles possible");
});

test("bare dates are REJECTED — approxidate silently shifted the window", () => {
  assert.throws(
    () => commitsIn(".", "2026-08-14", "2026-08-15"),
    /explicit datetimes/,
    "a bare --until admitted commits stamped 2026-08-15; the caller must be explicit",
  );
  assert.throws(() => commitsIn(".", "2026-08-14T00:00:00+05:30", "2026-08-15"), /explicit datetimes/);
});

test("the window is half-open, and filters on committer date", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-window-"));
  await repoAt(path.join(root, "r1"), "2026-08-14T10:00:00+05:30");
  await repoAt(path.join(root, "r2"), "2026-08-15T10:00:00+05:30");

  const day14 = journal([root], "2026-08-14T00:00:00+05:30", "2026-08-15T00:00:00+05:30");
  assert.equal(day14.commits, 1, "only the 08-14 commit — the 08-15 one must not leak in");
  assert.equal(day14.reposWithActivity, 1);
  assert.equal(day14.reposScanned, 2, "both repos scanned; only one had activity");
});

test("attribution is carried per repo — a count alone is wrong about who did what", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-attr-"));
  const r = await repoAt(path.join(root, "r"), "2026-08-14T10:00:00+05:30");
  await writeFile(path.join(r, "g.txt"), "y\n", "utf8");
  git(r, "add", ".");
  execFileSync("git", ["commit", "-q", "-m", "other-session", "--author", "Someone Else <s@example.com>"], {
    cwd: r,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-08-14T11:00:00+05:30" },
  });

  const out = journal([root], "2026-08-14T00:00:00+05:30", "2026-08-15T00:00:00+05:30");
  assert.equal(out.commits, 2);
  assert.deepEqual(
    out.byRepo[0].authors.sort(),
    ["Someone Else", "Tester"],
    "16 of one repo's commits on 2026-08-15 were a different session; the record must show that",
  );
});
