/**
 * Which markdown files are this repo's documentation?
 *
 * git first, filesystem fallback, and the instrument in force is always REPORTED — a count
 * means nothing until you know which ruler produced it (rule:discernment-checks §4).
 *
 * WHY GIT. It respects `.gitignore` inherently (it reads the index, so ignored files were
 * never added), excludes worktrees twice over (gitignored AND a separate index), and
 * excludes submodules (a gitlink, mode 160000). The filesystem walk it replaces
 * double-counted 8 files under `.worktrees/` and needed a hand-maintained ignore list to
 * approximate what git already knows.
 *
 * WHAT GIT DOES NOT FIX. Symlinks. git records them as mode-120000 blobs and never
 * traverses them, exactly like `readdirSync`. `~/.claude/skills` carries 28 intentional
 * symlinks, so this module walks them itself, inode-guarded, and reports the count.
 *
 * THE TRAP THIS IS BUILT AGAINST. `~/Documents/GitHub` is itself a git repo with an
 * allowlist-shaped `.gitignore` ("a container of independent git repos, not a monorepo").
 * Asking git for markdown there returns 46 files against a real 2,876. So the git root is
 * accepted ONLY when it equals the target directory; a target below its repo root falls
 * back to the walk rather than inheriting an index that describes a different tree.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { isSkipped } from "./config.mjs";

function git(dir, args) {
  try {
    // stdio pipe on stderr is deliberate: a `fatal:` must not reach the user's terminal
    // when it is an expected probe. Exit 128 is the answer, not the message.
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000,
    });
  } catch {
    return null; // never throws; the caller decides what absence means
  }
}

/**
 * The git root, but only if it IS this directory.
 * @returns {{root: string|null, reason: string}}
 */
export function gitRootFor(dir) {
  const inside = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return { root: null, reason: "not a git repository" };
  const top = git(dir, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return { root: null, reason: "git present but no work tree" };
  // A worktree's --show-toplevel reports the MAIN repo; --git-common-dir differing from
  // --git-dir is how you tell. Either way the equality check below is what protects us.
  let same = false;
  try { same = realpathSync(top) === realpathSync(dir); } catch { same = top === dir; }
  if (!same) {
    return { root: null, reason: `below the repo root (${top}) — scanning this directory only` };
  }
  return { root: top, reason: "git" };
}

const isMd = (p) => p.toLowerCase().endsWith(".md");

/** Does any path segment get skipped by config? */
function pathSkipped(relPosix, cfg) {
  return relPosix.split("/").slice(0, -1).some((seg) => isSkipped(seg, cfg));
}

/**
 * Walk the filesystem, following symlinks with an inode guard.
 * Symlinks are followed because neither git nor readdirSync does, and this tree has 28.
 */
function walk(root, cfg, counts) {
  const out = [];
  const seen = new Set();
  // `underSymlink` propagates DOWN the recursion. In git mode only these entries are
  // added, because git already listed everything else — and adding the walk's full result
  // there re-admitted gitignored files, defeating the single best property of using git.
  (function rec(dir, underSymlink) {
    let realDir;
    try { realDir = realpathSync(dir); } catch { return; }
    if (seen.has(realDir)) { counts.cyclesSkipped++; return; }
    seen.add(realDir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        if (!cfg.followSymlinks) continue;
        let st;
        try { st = statSync(full); } catch { continue; } // broken symlink: not a finding here
        isDir = st.isDirectory(); isFile = st.isFile();
      }
      const via = underSymlink || e.isSymbolicLink();
      if (isDir) {
        if (isSkipped(e.name, cfg)) continue;
        rec(full, via);
      } else if (isFile && isMd(e.name)) {
        out.push({ path: full, viaSymlink: via });
      }
    }
  })(root, false);
  return out;
}

/**
 * @returns {{docs:string[], instrument:"git"|"filesystem", describe:string,
 *            counts:{tracked:number,untracked:number,symlinksFollowed:number,cyclesSkipped:number}}}
 */
export function discover(root, cfg) {
  const counts = { tracked: 0, untracked: 0, symlinksFollowed: 0, cyclesSkipped: 0 };
  const { root: gitRoot, reason } = gitRootFor(root);
  let docs = [];
  let instrument = "filesystem";
  let note = reason;

  if (gitRoot) {
    instrument = "git";
    const tracked = (git(root, ["ls-files", "-z", "--", "*.md"]) ?? "").split("\0").filter(Boolean);
    const untracked = (git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "*.md"]) ?? "")
      .split("\0").filter(Boolean);
    // git knows what is ignored; it does not know that .worktrees is not documentation.
    const keep = (rels) => rels.filter((r) => !pathSkipped(r, cfg));
    const t = keep(tracked), u = keep(untracked);
    counts.tracked = t.length; counts.untracked = u.length;
    docs = [...t, ...u].map((r) => path.resolve(root, r));

    // Symlinked subtrees are invisible to the index. Add ONLY those — everything else git
    // already listed, and re-adding the walk's full result would resurrect ignored files.
    if (cfg.followSymlinks) {
      const known = new Set(docs);
      for (const e of walk(root, cfg, counts)) {
        if (!e.viaSymlink || known.has(e.path)) continue;
        docs.push(e.path); known.add(e.path); counts.symlinksFollowed++;
      }
    }
    note = `git (${counts.tracked} tracked` +
      (counts.untracked ? ` + ${counts.untracked} untracked` : "") +
      (counts.symlinksFollowed ? `, ${counts.symlinksFollowed} via symlink` : "") + ")";
  } else {
    const found = walk(root, cfg, counts);
    docs = found.map((e) => e.path);
    counts.symlinksFollowed = found.filter((e) => e.viaSymlink).length;
    note = `filesystem walk — ${reason}`;
  }

  if (counts.cyclesSkipped) note += ` · ${counts.cyclesSkipped} symlink cycle(s) skipped`;
  // An empty result is a STATED result. 0 docs -> 0 orphans must never read as "clean".
  if (docs.length === 0) note += " · no markdown found";

  return { docs: [...new Set(docs)].sort(), instrument, describe: note, counts };
}
