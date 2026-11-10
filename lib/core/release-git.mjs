/**
 * release-git.mjs — the git reads release-kind needs (#234): the last release tag and the commit messages since it.
 * Shared by the commit-msg hook (cli/release-kind.mjs), `release notes`, and the release-kind gate.
 *
 * The tag is found with `git describe --tags --abbrev=0 --match 'v*' HEAD`. `--tags` matters: without it describe
 * sees only ANNOTATED tags, and propagate's tags are lightweight (v0.15.59 is; plain `git describe` failed on it).
 */
import { spawnSync } from "node:child_process";
import { readOnlyGitEnv } from "./git-env.mjs";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: readOnlyGitEnv() });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: (r.stderr ?? "").trim() };
}

/** @returns {{tag: string|null, reason?: string}} */
export function lastTag(cwd, rev = "HEAD") {
  const r = git(cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*", rev]);
  return r.ok && r.out ? { tag: r.out } : { tag: null, reason: r.err || "no v* tag reachable" };
}

/** Full commit messages in `<since>..HEAD` (the whole history when since is null), oldest last as git prints. */
export function messagesSince(cwd, since) {
  const r = git(cwd, ["log", "--format=%B%x00", since ? `${since}..HEAD` : "HEAD"]);
  if (!r.ok) return { ok: false, reason: r.err || "git log failed", messages: [] };
  return { ok: true, messages: r.out.split("\0").map((s) => s.trim()).filter(Boolean) };
}

export function showAt(cwd, spec) {
  const r = git(cwd, ["show", spec]);
  return r.ok ? r.out.trim() : null;
}
