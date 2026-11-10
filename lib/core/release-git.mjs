/**
 * release-git.mjs — the git reads release-kind needs (#234): the last release tag and the commit messages since it.
 * Shared by the commit-msg hook (cli/release-kind.mjs), `release notes`, and the release-kind gate.
 *
 * The tag is found with `git describe --tags --abbrev=0 --match 'v*' --match 'propagate-v*' HEAD`. `--tags` matters:
 * without it describe sees only ANNOTATED tags, and propagate's legacy tags are mostly lightweight (v0.15.59 is; plain
 * `git describe` failed on it).
 */
import { spawnSync } from "node:child_process";
import { readOnlyGitEnv } from "./git-env.mjs";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: readOnlyGitEnv() });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: (r.stderr ?? "").trim() };
}

/**
 * The version a release tag names: `v0.17.0` and `propagate-v0.17.0` both give `0.17.0`.
 * From the first release under rule:release-versioning (#238) new tags are `propagate-vX.Y.Z` and match no `v*` glob,
 * so lastTag matches BOTH forms; matching only `v*` would keep answering v0.17.0 forever and make every later
 * release look as if it held all the commits since then.
 */
export function tagVersion(tag) {
  return String(tag ?? "").replace(/^(?:propagate-)?v/, "");
}

/** @returns {{tag: string|null, reason?: string}} */
export function lastTag(cwd, rev = "HEAD") {
  const r = git(cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*", "--match", "propagate-v*", rev]);
  return r.ok && r.out ? { tag: r.out } : { tag: null, reason: r.err || "no v* or propagate-v* tag reachable" };
}

/** The full sha a rev names, or null. */
export function revParse(cwd, rev) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return r.ok && r.out ? r.out : null;
}

/** True when `cwd` is inside a git work tree. */
export function isGitRepo(cwd) {
  return git(cwd, ["rev-parse", "--git-dir"]).ok;
}

/**
 * The release tag an install would be upgrading FROM: the last version tag reachable from HEAD, unless that tag is on
 * HEAD itself (the release is already tagged, e.g. a re-run after tagging), in which case the one before it.
 * @returns {{tag: string|null, reason?: string}}
 */
export function previousReleaseTag(cwd) {
  const t = lastTag(cwd, "HEAD");
  if (!t.tag) return t;
  const head = revParse(cwd, "HEAD");
  if (head && revParse(cwd, t.tag) === head) {
    const before = lastTag(cwd, "HEAD^");
    return before.tag ? before : { tag: null, reason: `${t.tag} is on HEAD and no version tag precedes it` };
  }
  return t;
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
