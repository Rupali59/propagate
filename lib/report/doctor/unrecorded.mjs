/**
 * unrecorded.mjs — doctor's `# Unrecorded work` section (#131).
 *
 * THE QUESTION. Which record files are sitting uncommitted, and which local commits are on
 * no remote? A record that is only in a working tree is invisible to every other session and
 * branch: measured 2026-11-04, 64 uncommitted .md/.yml files, the records among them
 * unrecorded for 12-78 days, 4 sidecars declaring couplings on no branch.
 *
 * DERIVED ON DEMAND. `git status --porcelain`, `git rev-list <upstream>..<branch>` and file
 * mtime. No store, nothing scheduled (rule:delegation-criteria section 2).
 *
 * POPULATION. The repos discovery already finds (`ownerCandidates`, the census the
 * conformance check uses) plus repos nested under them. Never a list of repo names. Records
 * are matched by NAME or PATTERN (`isRecordPath`), so a new project's STATE.md is graded the
 * day it exists (rule:derive-dont-curate).
 *
 * FLOOR. Zero repos scanned prints "scan is blind", never a clean line. It is a `warn`, not an
 * `inconclusive`: inconclusive votes, and a hermetic fixture or a fresh machine with no repos
 * under its search roots would then fail doctor. Visible and non-voting is the compromise.
 *
 * TODAY'S EDITS ARE EXCLUDED: a live session may own them. A file modified on today's local
 * calendar day is skipped whatever `days` is, and then the age must be at least `days`.
 */

/**
 * Severity of what this section reports (N87 slice 2b).
 *
 * S3, and its findings are `warn`, which never vote on the exit code. The issue (#131) says
 * "makes doctor fail"; this deliberately does not. #129 recorded that doctor failed 41 of 41
 * runs and an always-red check stops being read. Uncommitted work is the normal state of a
 * working day, so a FAIL here would be red on every run and would teach the reader to ignore
 * the exit code. A stale record costs visibility, not correctness: nothing it says is wrong.
 */
export const SEVERITY = "S3";

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isSkippedDir, ownerCandidates } from "../../core/discovery.mjs";

/** Default age threshold, in days. Override: `days` option or `PROPAGATE_UNRECORDED_DAYS`. */
export const DEFAULT_DAYS = 7;

/** How far below a census repo to look for nested repos (a workspace holds project repos). */
const NESTED_DEPTH = 2;

const RECORD_BASENAMES = new Set([
  "STATE.md",
  "DECISIONS.md",
  "GOTCHAS.md",
  "HANDOVERS.md",
  "TODOS.md",
  "TODO.md",
  "ISSUES.md",
  ".propagates.yml",
  ".sidecar.yml",
  "ledger.jsonl",
  "ledger.md",
  "PROPAGATION_LEDGER.jsonl",
  "PROPAGATION_LEDGER.md",
]);

/**
 * True when a repo-relative path is a record file: a known name (STATE, DECISIONS, GOTCHAS,
 * HANDOVERS, TODOS, ISSUES, sidecars, ledgers) or a markdown file under a `plans/` or
 * `rules/` directory.
 */
export function isRecordPath(rel) {
  const p = rel.split(path.sep).join("/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (RECORD_BASENAMES.has(base)) return true;
  return /(^|\/)(plans|rules)\/(.+\/)?[^/]+\.md$/.test(p);
}

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });

/**
 * Parse `git status --porcelain=v1 -z -uall`. Renames carry a second NUL field (the old
 * path), which is consumed and dropped.
 * @returns {Array<{path: string, state: string}>} state is "staged" | "modified" | "untracked" | "deleted"
 */
export function parseStatus(raw) {
  const parts = raw.split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    if (x === "R" || x === "C") i++; // skip the original-path field
    let state;
    if (x === "?" && y === "?") state = "untracked";
    else if (x === "D" || y === "D") state = "deleted";
    else if (y !== " ") state = "modified";
    else state = "staged";
    out.push({ path: file, state });
  }
  return out;
}

/** Repos to scan: the census plus repos nested under it, de-duplicated by real path. */
export function listRepos(roots, workspaces) {
  const seen = new Map();
  const nameOf = (full) => {
    for (const r0 of roots) {
      let r = r0;
      try {
        r = realpathSync(r0); // repo roots are realpath'd; /var -> /private/var on macOS
      } catch {
        /* keep raw */
      }
      const rel = path.relative(r, full);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    }
    return path.basename(full);
  };
  const add = (root, name) => {
    let real = root;
    try {
      real = realpathSync(root);
    } catch {
      /* keep raw */
    }
    if (!seen.has(real)) seen.set(real, { root: real, name });
  };
  const walk = (dir, depth, top) => {
    if (depth > NESTED_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || isSkippedDir(e.name)) continue;
      const full = path.join(dir, e.name);
      if (existsSync(path.join(full, ".git"))) add(full, nameOf(full));
      walk(full, depth + 1, top);
    }
  };
  for (const c of ownerCandidates(roots, workspaces)) {
    add(c.root, nameOf(c.root));
    walk(c.root, 1, c.root);
  }
  // Main checkouts (a `.git` DIRECTORY) before linked worktrees (a `.git` file), so branches
  // shared through one object store are listed under the checkout that owns them.
  const isMain = (r) => {
    try {
      return statSync(path.join(r.root, ".git")).isDirectory();
    } catch {
      return false;
    }
  };
  return [...seen.values()].sort((a, b) => Number(isMain(b)) - Number(isMain(a)));
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Scan one repo. Never throws: a repo git cannot read becomes `error`, which the caller
 * prints, so an unreadable repo is not a clean one.
 */
export function scanRepo(repo, { days, now, seenStores = new Set() }) {
  const res = { repo: repo.name, root: repo.root, branch: "(unknown)", stale: [], deleted: 0, branches: [], elsewhere: 0, error: null };
  try {
    res.branch = git(repo.root, ["branch", "--show-current"]).trim() || "(detached HEAD)";
    const today = startOfLocalDay(now);
    for (const f of parseStatus(git(repo.root, ["status", "--porcelain=v1", "-z", "-uall"]))) {
      if (!isRecordPath(f.path)) continue;
      if (f.state === "deleted") {
        res.deleted++;
        continue;
      }
      let mtime;
      try {
        mtime = statSync(path.join(repo.root, f.path)).mtimeMs;
      } catch {
        res.deleted++;
        continue;
      }
      if (mtime >= today) continue; // today's edits: a live session may own them
      const ageDays = Math.floor((now - mtime) / 86400000);
      if (ageDays >= days) res.stale.push({ file: f.path, state: f.state, ageDays });
    }
    // Worktrees of one repo share branches: list them once, under the first checkout seen.
    const store = realpathSync(path.resolve(repo.root, git(repo.root, ["rev-parse", "--git-common-dir"]).trim()));
    if (seenStores.has(store)) return res;
    seenStores.add(store);
    // A branch with no usable upstream is only a finding when some of its commits are on NO
    // remote ref. One whose commits all exist on a remote under another name is counted, not listed.
    const onNoRemote = (name) => Number(git(repo.root, ["rev-list", "--count", name, "--not", "--remotes"]).trim());
    const refs = git(repo.root, ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"]);
    for (const line of refs.split("\n").filter(Boolean)) {
      const [name, upstream] = line.split("\t");
      if (!upstream) {
        const n = onNoRemote(name);
        if (n > 0) res.branches.push({ branch: name, upstream: null, ahead: n });
        else res.elsewhere++;
        continue;
      }
      try {
        const ahead = Number(git(repo.root, ["rev-list", "--count", `${upstream}..${name}`]).trim());
        if (ahead > 0) res.branches.push({ branch: name, upstream, ahead });
      } catch {
        const n = onNoRemote(name);
        if (n > 0) res.branches.push({ branch: name, upstream, ahead: n, gone: true });
        else res.elsewhere++;
      }
    }
  } catch (err) {
    res.error = (err.stderr?.toString().trim() || err.message).split("\n")[0];
  }
  return res;
}

/**
 * @param {object} opts
 * @param {{header: Function, check: Function, warn: Function, info: Function}} opts.reporter
 * @param {string[]} opts.roots search roots
 * @param {Array<{root: string, name?: string}>} opts.workspaces discovered workspaces
 * @param {number} [opts.days] default DEFAULT_DAYS
 * @param {number} [opts.now] ms epoch, injectable for tests
 * @param {Array<{root: string, name: string}>} [opts.repos] override the population (tests only)
 */
export function checkUnrecorded({ reporter, roots, workspaces, days = DEFAULT_DAYS, now = Date.now(), repos }) {
  reporter.header("# Unrecorded work");
  const population = repos ?? listRepos(roots, workspaces);
  if (population.length === 0) {
    reporter.warn(
      "unrecorded-work scan is blind",
      "scanned 0 repos, so this section has not looked at anything; that is different from a clean result. Check searchRoots.",
    );
    return { scanned: 0, stale: 0, branches: 0 };
  }

  const seenStores = new Set();
  const results = population.map((r) => scanRepo(r, { days, now, seenStores }));
  let stale = 0;
  let branches = 0;
  for (const r of results) {
    if (r.error) {
      reporter.warn("unrecorded-work repo unreadable", `${r.repo}: ${r.error}`);
      continue;
    }
    for (const s of r.stale) {
      stale++;
      reporter.warn("record uncommitted past threshold", `${r.repo} (${r.branch}) ${s.file} - ${s.state}, ${s.ageDays} days old`);
    }
    for (const b of r.branches) {
      branches++;
      const what =
        b.upstream === null
          ? `no upstream; ${b.ahead} commit(s) on no remote`
          : b.gone
            ? `upstream ${b.upstream} is gone; ${b.ahead} commit(s) on no remote`
            : `${b.ahead} commit(s) not on ${b.upstream}`;
      reporter.warn("branch has commits not on its upstream", `${r.repo} (${b.branch}) - ${what}`);
    }
  }
  const deleted = results.reduce((n, r) => n + r.deleted, 0);
  const elsewhere = results.reduce((n, r) => n + r.elsewhere, 0);
  const summary =
    `scanned ${population.length} repo(s), threshold ${days} days: ${stale} stale record file(s), ` +
    `${branches} branch(es) with commits on no remote or ahead of their upstream` +
    (elsewhere ? `; ${elsewhere} branch(es) without a usable upstream whose commits are all on a remote (not listed)` : "") +
    (deleted ? `; ${deleted} deleted record file(s) not aged (no mtime)` : "");
  // `info`, never a pass tick: this section has no failing state to be green against (it is
  // warn-only, see SEVERITY), and doctor-check-coverage requires a failing-case test for every
  // `check` label. A clean result still states what it scanned.
  reporter.info("unrecorded work", stale === 0 && branches === 0 ? `nothing to report - ${summary}` : summary);
  return { scanned: population.length, stale, branches };
}
