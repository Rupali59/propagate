/**
 * A citation to a file that exists on another branch is not broken — it is EARLY.
 *
 * Found twice in one session on marketing-intel, both times about to be mis-reported:
 *   - `CLAUDE.md` and `docs/DECISIONS.md` cite `docs/local-scheduler.md`. Absent on the
 *     current branch, **present (155 lines) on `feat/social-post-ingest`**. Reported as
 *     DANGLING, the obvious "fix" is to delete the citation — which would delete a correct
 *     forward reference to unmerged work.
 *   - Writing up that very finding cited `docs/plans/instagram-app-review.md`, which is also
 *     only on that branch. The report immediately called the write-up broken.
 *
 * `rule:discernment-checks` §2: absence must be attributable. "Absent" and "absent on THIS
 * branch" are different facts, and this repo squash-merges, so the difference is routine.
 *
 * Cost is bounded: one `git ls-tree` per ref, not one lookup per citation.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Every local branch plus every origin branch, current one excluded. */
export function otherRefs(root) {
  const out = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/", "refs/remotes/origin/"]);
  if (out === null) return { status: "no-git", refs: [] };
  const current = git(root, ["branch", "--show-current"])?.trim();
  const refs = out.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((r) => r !== current && r !== "origin/HEAD" && r !== "origin");
  return { status: "ok", refs };
}

/**
 * Which of these paths exist on some other ref?
 * @returns {{status:string, found:Map<string,string[]>, refsChecked:number}}
 *          found: repo-relative path -> refs carrying it
 */
export function existsOnOtherRefs(root, relPaths) {
  const found = new Map();
  const { status, refs } = otherRefs(root);
  if (status !== "ok" || refs.length === 0) return { status, found, refsChecked: 0 };

  const want = new Set(relPaths);
  let checked = 0;
  for (const ref of refs) {
    const tree = git(root, ["ls-tree", "-r", "--name-only", ref]);
    if (tree === null) continue; // an unreadable ref is skipped, and refsChecked reflects it
    checked++;
    for (const line of tree.split("\n")) {
      if (!want.has(line)) continue;
      if (!found.has(line)) found.set(line, []);
      found.get(line).push(ref);
    }
  }
  return { status: "ok", found, refsChecked: checked };
}

/**
 * Split a dangling list into genuinely-broken and merely-unmerged.
 *
 * A citation is resolved against the citing doc's directory AND the repo root, exactly as the
 * link graph does — a forward reference is written the same way a live one is.
 */
export function classifyDangling(root, dangling) {
  const candidates = new Map(); // rel path -> dangling entries that would resolve to it
  for (const d of dangling) {
    const target = d.cites.split("#")[0];
    for (const base of [path.dirname(d.from), root]) {
      const abs = path.resolve(base, target);
      if (!abs.startsWith(root + path.sep)) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (!candidates.has(rel)) candidates.set(rel, []);
      candidates.get(rel).push(d);
    }
  }

  const { status, found, refsChecked } = existsOnOtherRefs(root, [...candidates.keys()]);
  const unmergedSet = new Map();
  for (const [rel, refs] of found) {
    for (const d of candidates.get(rel) ?? []) unmergedSet.set(d, { rel, refs });
  }

  return {
    status,
    refsChecked,
    broken: dangling.filter((d) => !unmergedSet.has(d)),
    unmerged: dangling.filter((d) => unmergedSet.has(d)).map((d) => ({ ...d, ...unmergedSet.get(d) })),
  };
}
