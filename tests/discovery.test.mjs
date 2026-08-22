import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discover } from "../lib/discovery.mjs";
import { loadConfig } from "../lib/config.mjs";

const cfg = (root) => loadConfig(root, { home: mkdtempSync(path.join(tmpdir(), "cd-h-")) });
const git = (d, ...a) => execFileSync("git", ["-C", d, ...a], { stdio: ["ignore", "pipe", "ignore"] });

function repo() {
  const d = mkdtempSync(path.join(tmpdir(), "cd-git-"));
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  return d;
}
const rel = (root, ds) => ds.map((p) => path.relative(root, p).split(path.sep).join("/")).sort();

test("in a git repo, tracked docs are found and the instrument is named", () => {
  const d = repo();
  writeFileSync(path.join(d, "README.md"), "# r");
  mkdirSync(path.join(d, "docs")); writeFileSync(path.join(d, "docs/a.md"), "# a");
  git(d, "add", "-A"); git(d, "commit", "-qm", "init");
  const r = discover(d, cfg(d));
  assert.equal(r.instrument, "git");
  assert.deepEqual(rel(d, r.docs), ["README.md", "docs/a.md"]);
  assert.match(r.describe, /^git \(/);
});

test("gitignored docs are excluded without any hand-maintained ignore list", () => {
  const d = repo();
  writeFileSync(path.join(d, ".gitignore"), "secret/\n");
  writeFileSync(path.join(d, "README.md"), "# r");
  mkdirSync(path.join(d, "secret")); writeFileSync(path.join(d, "secret/x.md"), "# x");
  git(d, "add", "-A"); git(d, "commit", "-qm", "init");
  assert.deepEqual(rel(d, discover(d, cfg(d)).docs), ["README.md"]);
});

test("untracked-but-real docs are included and counted separately", () => {
  const d = repo();
  writeFileSync(path.join(d, "README.md"), "# r");
  git(d, "add", "-A"); git(d, "commit", "-qm", "init");
  writeFileSync(path.join(d, "NEW.md"), "# new");
  const r = discover(d, cfg(d));
  assert.deepEqual(rel(d, r.docs), ["NEW.md", "README.md"]);
  assert.equal(r.counts.tracked, 1);
  assert.equal(r.counts.untracked, 1);
});

test("a non-git directory falls back to the filesystem walk and SAYS which instrument ran", () => {
  const d = mkdtempSync(path.join(tmpdir(), "cd-nogit-"));
  writeFileSync(path.join(d, "README.md"), "# r");
  const r = discover(d, cfg(d));
  assert.equal(r.instrument, "filesystem");
  assert.match(r.describe, /not a git repository/);
  assert.deepEqual(rel(d, r.docs), ["README.md"]);
});

test("a repo with no commits does not error — ls-files reads the index, not HEAD", () => {
  const d = repo();
  writeFileSync(path.join(d, "README.md"), "# r");
  const r = discover(d, cfg(d));
  assert.equal(r.instrument, "git");
  assert.deepEqual(rel(d, r.docs), ["README.md"]);
});

test("an empty repo is a STATED result, never a quiet clean run", () => {
  const r = discover(repo(), cfg("/tmp"));
  assert.equal(r.docs.length, 0);
  assert.match(r.describe, /no markdown found/);
});

test("skipDirs apply under git too — git does not know .worktrees is not documentation", () => {
  const d = repo();
  writeFileSync(path.join(d, "README.md"), "# r");
  mkdirSync(path.join(d, ".worktrees/f"), { recursive: true });
  writeFileSync(path.join(d, ".worktrees/f/dup.md"), "# dup");
  git(d, "add", "-Af"); git(d, "commit", "-qm", "init");
  assert.deepEqual(rel(d, discover(d, cfg(d)).docs), ["README.md"]);
});

test("symlinked doc trees are followed, and the count is reported (F5)", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "cd-out-"));
  writeFileSync(path.join(outside, "linked.md"), "# linked");
  const d = mkdtempSync(path.join(tmpdir(), "cd-sym-"));
  writeFileSync(path.join(d, "README.md"), "# r");
  symlinkSync(outside, path.join(d, "ext"));
  const r = discover(d, cfg(d));
  assert.deepEqual(rel(d, r.docs), ["README.md", "ext/linked.md"],
    "git records symlinks as mode-120000 blobs and never traverses them — neither did readdirSync");
  assert.equal(r.counts.symlinksFollowed, 1);
});

test("a symlink cycle terminates and is reported, not hung or silently pruned", () => {
  const d = mkdtempSync(path.join(tmpdir(), "cd-cyc-"));
  writeFileSync(path.join(d, "README.md"), "# r");
  mkdirSync(path.join(d, "sub"));
  writeFileSync(path.join(d, "sub/b.md"), "# b");
  symlinkSync(d, path.join(d, "sub/loop"));
  const r = discover(d, cfg(d));
  assert.deepEqual(rel(d, r.docs), ["README.md", "sub/b.md"]);
  assert.ok(r.counts.cyclesSkipped >= 1, "a pruned cycle must be counted, not silent");
});

test("the hub trap: discovery never resolves a git root ABOVE the target directory", () => {
  // ~/Documents/GitHub has an allowlist-shaped .gitignore and IS a git repo; asking git
  // there returns 46 .md against a real 2,876. A subdirectory must be scanned on its own.
  const outer = repo();
  writeFileSync(path.join(outer, ".gitignore"), "/*\n!/keep\n");
  writeFileSync(path.join(outer, "root.md"), "# root");
  mkdirSync(path.join(outer, "child"));
  writeFileSync(path.join(outer, "child/inner.md"), "# inner");
  git(outer, "add", "-Af"); git(outer, "commit", "-qm", "init");
  const r = discover(path.join(outer, "child"), cfg(outer));
  assert.deepEqual(rel(path.join(outer, "child"), r.docs), ["inner.md"],
    "must not inherit the parent repo's index or its allowlist .gitignore");
  assert.equal(r.instrument, "filesystem");
  assert.match(r.describe, /below the repo root/);
});
