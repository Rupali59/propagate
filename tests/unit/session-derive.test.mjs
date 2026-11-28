/**
 * session-derive.test.mjs — lib/sessions/derive.mjs (propagate#442): the board item a Bash command is work on.
 * Literal commands in, literal items out. Repos are fake (o/r); the origin reader is injected except where a test builds a
 * real temp checkout to prove the .git/config read.
 */
// @size small — pure parsing plus a temp checkout
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { deriveItem, originRepo, repoFromUrl } from "../../lib/sessions/derive.mjs";

const origin = (r) => ({ readOrigin: () => r, readBranch: () => null });
const D = (cmd, o = "o/r") => deriveItem(cmd, "/w/x", origin(o));

test("an issue write is a signal: close, comment, edit, reopen, develop", () => {
  for (const sub of ["close", "comment", "edit", "reopen", "develop"]) {
    assert.deepEqual(D(`gh issue ${sub} 5 -R o/r`, null), { item: "o/r#5", signal: `gh issue ${sub}` }, sub);
  }
  assert.deepEqual(D("gh issue close #7"), { item: "o/r#7", signal: "gh issue close" }, "origin repo, #n form");
  assert.deepEqual(D("gh issue comment -R a/b 12 --body 'done 99'"), { item: "a/b#12", signal: "gh issue comment" }, "a flag value is not the number");
  assert.deepEqual(D("gh issue close https://github.com/c/d/issues/3", null), { item: "c/d#3", signal: "gh issue close" }, "an issue URL names its own repo");
});

test("a PR write is a signal through Closes #n, else through its branch", () => {
  assert.deepEqual(D(`gh pr create --title t --body "Closes #9"`), { item: "o/r#9", signal: "gh pr create" });
  assert.deepEqual(D("gh pr create --head fix/12-thing --fill"), { item: "o/r#12", signal: "gh pr create" });
  assert.deepEqual(D("gh pr merge feat/4-x --squash"), { item: "o/r#4", signal: "gh pr merge" });
  assert.deepEqual(deriveItem("gh pr create --fill", "/w/x", { readOrigin: () => "o/r", readBranch: () => "docs/31-notes" }), { item: "o/r#31", signal: "gh pr create" }, "the checked-out branch");
});

test("a branch start is a signal: switch -c, checkout -b, worktree add -b, worktree-new.sh", () => {
  assert.deepEqual(D("git switch -c fix/9-x"), { item: "o/r#9", signal: "git switch -c" });
  assert.deepEqual(D("git checkout -b feat/21-add-thing"), { item: "o/r#21", signal: "git checkout -b" });
  assert.deepEqual(D("git worktree add -b chore/8-tidy .claude/worktrees/chore-8-tidy"), { item: "o/r#8", signal: "git worktree add -b" });
  assert.deepEqual(D("scripts/worktree-new.sh test/15-cover"), { item: "o/r#15", signal: "worktree-new.sh" });
});

test("reads and mentions are not signals: gh issue view/list, echo, a commit message, a heredoc", () => {
  assert.equal(D("gh issue view 7 -R o/r"), null);
  assert.equal(D("gh issue list -R o/r"), null);
  assert.equal(D("echo gh issue close 9"), null);
  assert.equal(D(`git commit -m "gh issue close 9 && gh issue comment 9"`), null);
  assert.equal(D("cat <<'EOF'\ngh issue close 9\nEOF"), null);
  assert.equal(D("gh project item-edit --id PVTI_x --field-id f"), null);
});

test("-R wins over the origin; with neither, the result is null", () => {
  assert.equal(D("gh issue close 5 -R a/b", "c/d").item, "a/b#5");
  assert.equal(D("gh issue close 5", null), null);
  assert.equal(D("git switch -c fix/9-x", null), null);
});

test("in a compound command the last signal wins, and a quoted && does not split", () => {
  assert.equal(D("gh issue close 5 && git switch -c fix/9-x").item, "o/r#9");
  assert.equal(D("git switch -c fix/9-x; gh issue comment 5").item, "o/r#5");
  assert.equal(D(`gh issue comment 5 --body "a && gh issue close 6"`).item, "o/r#5");
});

test("a branch that does not match <type>/<n>-<slug> gives null", () => {
  for (const b of ["wip", "fix/no-number", "fix/9", "hotfix/9-x", "feat/9-UPPER", "main"]) assert.equal(D(`git switch -c ${b}`), null, b);
});

test("repoFromUrl reads ssh and https remotes", () => {
  assert.equal(repoFromUrl("git@github.com:o/r.git"), "o/r");
  assert.equal(repoFromUrl("https://github.com/o/r"), "o/r");
  assert.equal(repoFromUrl("https://example.com/o/r.git"), null);
});

test("originRepo reads .git/config, and a linked worktree follows its commondir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "derive-"));
  const main = path.join(root, "main");
  mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(path.join(main, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:o/r.git\n');
  assert.equal(originRepo(main), "o/r");
  writeFileSync(path.join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const wt = path.join(root, "wt");
  mkdirSync(path.join(wt, "sub"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  assert.equal(originRepo(path.join(wt, "sub")), "o/r");
  assert.equal(originRepo(root), null, "no checkout above: null, never a guess");
});
