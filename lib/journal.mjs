/**
 * What was done, and approximately when — derived from git across every repo.
 *
 * This is the `obsidian-journal` row in docs/SYSTEMS.md, specified 2026-08-14 and unbuilt
 * until now. It exists because the nightly diary reports **pushed activity on default
 * branches**, and in this tree feature-branch and unpushed work is the norm: for
 * 2026-08-14 the diary recorded 35 commits across 3 repos while 109 across 22 had
 * actually happened.
 *
 * ── The symlink trap, which this module exists partly to survive ──────────────
 *
 * `find … -name .git` and `readdirSync(…).filter(e => e.isDirectory())` BOTH skip
 * symlinked directories. `~/Documents/GitHub/propagate-skill` is a symlink to
 * `~/.claude/skills/propagate`, so every sweep that used either missed it — 14 commits on
 * 2026-08-14, 13 more the next day. The figure went into a handover, a reconciliation
 * report, and the ACCEPTANCE TEST for this very module, where it would have certified a
 * broken aggregator as correct because it shared the blindness.
 *
 * `enumerateRepos` therefore follows symlinks and guards against the cycles that follow
 * from doing so. GOTCHAS G31.
 *
 * ── No prose synthesis ───────────────────────────────────────────────────────
 *
 * Every line this produces cites a hash, a path or an id. On 2026-08-11 a model copied
 * its own few-shot example into a real diary entry as a fabricated "26 commits fixing
 * CVE-2025-55182". v1 does not summarise; it reports.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Every git repository under `roots`, FOLLOWING symlinks.
 *
 * Cycle-safe: a symlink that points at an ancestor would otherwise recurse forever, so
 * every directory is keyed by its realpath and visited once.
 *
 * @returns {{repos: string[], symlinked: string[]}} `symlinked` names the repos that were
 *   only reachable through a link — reported, never silently included or dropped, because
 *   that silence is exactly what produced the wrong number.
 */
export function enumerateRepos(roots, maxDepth = 4) {
  const repos = [];
  const symlinked = [];
  const seen = new Set();

  const walk = (dir, depth, viaLink) => {
    if (depth > maxDepth) return;
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return; // broken link or vanished dir — not a finding, but never a silent include
    }
    if (seen.has(real)) return;
    seen.add(real);

    if (existsSync(path.join(dir, ".git"))) {
      repos.push(dir);
      if (viaLink) symlinked.push(dir);
      // Do not return — nested repos are real here (SSJK-mb under PanditPawanKaushik).
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".claude") continue;
      if (["node_modules", "dist", "build", ".next", "venv", "__pycache__"].includes(e.name)) continue;
      // A Dirent for a SYMLINKED directory answers isSymbolicLink(), NOT isDirectory().
      // Filtering on isDirectory() alone is what made propagate-skill invisible.
      const isLink = e.isSymbolicLink();
      if (!e.isDirectory() && !isLink) continue;
      walk(path.join(dir, e.name), depth + 1, viaLink || isLink);
    }
  };

  for (const r of roots) walk(r, 0, false);
  return { repos: [...new Set(repos)], symlinked };
}

/**
 * Commits in `repo` in `[since, until)`, across ALL branches — not just the default.
 *
 * Callers MUST pass explicit ISO datetimes with an offset. A bare `--until=2026-08-15`
 * goes through git's approxidate parser and returned commits stamped 2026-08-15 in this
 * tree: 6 where the explicit form gives 2. That single ambiguity is the difference
 * between the 109 figure and the 63 one, and it is not worth carrying.
 *
 * Note also that `--since`/`--until` filter on COMMITTER date while `%ad` prints AUTHOR
 * date — so a naive report can show timestamps outside the window it claims to cover.
 * `%cd` is used here, matching what was actually filtered.
 */
export function commitsIn(repo, since, until) {
  if (!/[T ]\d\d:/.test(since) || !/[T ]\d\d:/.test(until)) {
    throw new Error(
      `journal: since/until must be explicit datetimes, got "${since}".."${until}" — ` +
        `bare dates go through approxidate and silently shift the window`,
    );
  }
  let out;
  try {
    out = execFileSync(
      "git",
      ["-C", repo, "log", "--all", `--since=${since}`, `--until=${until}`,
       "--format=%H%x00%an%x00%cd%x00%s", "--date=iso-strict"],
      { encoding: "utf8", maxBuffer: 1 << 24, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return []; // not a repo, or git unavailable — the caller counts repos separately
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, author, date, subject] = l.split("\0");
      return { hash: hash.slice(0, 8), author, date, subject };
    });
}

/**
 * The day's work, grouped by repo.
 *
 * `authors` is carried per repo because the record must ATTRIBUTE, not merely count: on
 * 2026-08-15, 16 of PanditPawanKaushik's commits came from a different session. A journal
 * that reports them as one person's day is wrong about who did what.
 */
export function journal(roots, since, until) {
  const { repos, symlinked } = enumerateRepos(roots);
  const byRepo = [];
  let total = 0;
  for (const repo of repos.sort()) {
    const commits = commitsIn(repo, since, until);
    if (commits.length === 0) continue;
    total += commits.length;
    byRepo.push({
      repo,
      viaSymlink: symlinked.includes(repo),
      count: commits.length,
      authors: [...new Set(commits.map((c) => c.author))],
      commits,
    });
  }
  return {
    since,
    until,
    reposScanned: repos.length,
    reposWithActivity: byRepo.length,
    commits: total,
    symlinkedRepos: symlinked,
    byRepo,
  };
}
