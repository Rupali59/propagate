/**
 * cited-commits.mjs — the guard behind `verify --apply` (#354).
 *
 * `verify` pins the CONTENT of the working tree. A `--reason` that cites a
 * commit as evidence is a claim that the commit is part of what is being
 * pinned; if the checkout does not contain it (or is behind its upstream), the
 * append-only row records content the evidence never described, and cannot be
 * rewritten. Measured cost: an edge settled against a checkout 44 commits
 * behind origin.
 *
 * Pure of the CLI: takes a reason and the directories whose repos matter, and
 * returns problems (refuse) and warnings (proceed, loudly). Dry run and
 * `--apply` call the same function, so the preview cannot promise a write the
 * apply then refuses.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

// 7-40 hex characters as a whole token, containing at least one digit. The digit
// requirement keeps ordinary words made of a-f ("defaced", "feedbed") from being read
// as commit ids; an all-letter abbreviated SHA is possible but rare, and the cost of
// missing one is the status quo.
const SHA_RE = /(?<![0-9a-zA-Z])[0-9a-f]{7,40}(?![0-9a-zA-Z])/gi;

export function extractShas(reason) {
  if (typeof reason !== "string") return [];
  const out = new Set();
  for (const m of reason.matchAll(SHA_RE)) if (/[0-9]/.test(m[0])) out.add(m[0].toLowerCase());
  return [...out];
}

function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
  } catch (err) {
    return { ok: false, status: err.status, out: "" };
  }
}

/** Distinct git toplevels for the given file paths (files outside any repo are skipped). */
export function repoRootsOf(paths) {
  const roots = new Set();
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue; // an unmatched glob has no downstream path
    const r = git(dirname(p), ["rev-parse", "--show-toplevel"]);
    if (r.ok && r.out) roots.add(r.out);
  }
  return [...roots];
}

/**
 * @param {string|undefined} reason
 * @param {string[]} repoRoots
 * @returns {{problems: Array<{kind:string, sha:string, message:string}>, warnings: Array<{kind:string, root:string, message:string}>}}
 */
export function checkCitedCommits(reason, repoRoots) {
  const problems = [];
  const warnings = [];
  const shas = extractShas(reason);

  for (const sha of shas) {
    let resolvedIn = 0;
    const misses = [];
    let contained = false;
    for (const root of repoRoots) {
      if (!git(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).ok) continue;
      resolvedIn++;
      if (git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]).ok) { contained = true; break; }
      misses.push({ root, head: git(root, ["rev-parse", "HEAD"]).out });
    }
    if (contained) continue;
    if (resolvedIn === 0) {
      problems.push({
        kind: "unresolvable",
        sha,
        message: `cited commit ${sha} resolves to no commit in ${repoRoots.length ? repoRoots.join(", ") : "any checkout"} ` +
          `(a typo, a commit from another clone, or not fetched here); if "${sha}" is not a commit id, reword it`,
      });
    } else {
      for (const m of misses) {
        problems.push({
          kind: "not-in-head",
          sha,
          message: `cited commit ${sha} is not an ancestor of HEAD ${m.head} in ${m.root}; ` +
            `this checkout does not contain the evidence it would pin (pull or check out the right branch, then retry)`,
        });
      }
    }
  }

  for (const root of repoRoots) {
    const up = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (!up.ok) continue;
    const behind = git(root, ["rev-list", "--count", "HEAD..@{u}"]);
    const n = Number(behind.out);
    if (behind.ok && n > 0) {
      warnings.push({
        kind: "behind-upstream",
        root,
        message: `${root} is ${n} commit(s) behind ${up.out}; verify pins the working tree, so this records content that is not current (as of the last fetch)`,
      });
    }
  }
  return { problems, warnings };
}
