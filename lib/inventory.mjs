/**
 * The self-adoption probe: an inventory of everything that was built across
 * the ecosystem -- skills, plugins, repos, standalone artifacts -- each with
 * a classification pulled from `docs/SYSTEMS.md`'s existing vocabulary and,
 * non-negotiably, the evidence that produced it.
 *
 * WHY THIS EXISTS. The concern that motivated it: this probe is itself a
 * tool that could go unadopted -- exactly the pattern it exists to detect.
 * See digest.mjs's INVENTORY section for the other half of that answer (a
 * digest section that reports only what CHANGED, so it cannot become
 * wallpaper the way a standing "74 dormant" line would -- G3).
 *
 * READ-ONLY. `inventory()` never writes, deletes, quarantines, or reaps
 * anything. It reuses `lib/skills-scan.mjs`'s `scanSkills()` /
 * `probeTranscripts()` for the skills population rather than re-implementing
 * a second scanner (G20) -- the repos/plugins/standalone walks below are new
 * populations those functions were never asked to cover, not a duplicate of
 * what they already do.
 *
 * PROBE LIMITS, stated once here and carried into every call's output
 * (`probeLimits`), not buried in a doc (G2):
 *   - Session transcripts (the corroborating liveness probe for skills)
 *     start 2026-03-17 (see `transcriptWindow` below, computed from the
 *     oldest .jsonl mtime found). "Never invoked" therefore means "not seen
 *     in surviving transcripts" -- anything used and never touched again
 *     before that date is indistinguishable from never-used.
 *   - `skillUsage` (~/.claude.json) is never pruned on skill deletion, so an
 *     orphan key is evidence of past churn, not of anything currently on
 *     disk (see skills-scan.mjs's own header).
 *   - The repo walk is bounded (MAX_REPO_DEPTH, REPO_WALK_BUDGET_MS); commit
 *     counts/unpushed counts are bounded per-repo (GIT_LOG_LIMIT) and any
 *     repo where a git subprocess fails or times out reports `status:
 *     unknown`, never a default.
 *   - The standalone-artifact check is SEEDED, not exhaustive: it answers
 *     "how many referrers does *this* file have", applied to a known seed
 *     list (`STANDALONE_SEEDS`) plus any caller-supplied paths. It does not
 *     itself discover every file in the tree that might declare itself
 *     canonical -- that is future work, and this module says so rather than
 *     implying completeness.
 */

import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

import { scanSkills, probeTranscripts, PROJECTS_DIR } from "./skills-scan.mjs";
import { SEARCH_ROOTS, INTEGRATIONS } from "./config.mjs";
import { resolveBin } from "./which.mjs";

const HOME = os.homedir();

export const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
export const DAILY_MD_PATH = path.join(HOME, ".claude", "DAILY.md");
export const PORTS_YML_PATH = INTEGRATIONS.portsFile; // null => the ports check skips

/** Seed list for the standalone-artifact check (task brief §4). Callers may
 *  extend via `inventory({ standaloneSeeds: [...] })`; this module never
 *  discovers more on its own -- see the header note on PROBE LIMITS. */
export const STANDALONE_SEEDS = [DAILY_MD_PATH, PORTS_YML_PATH];

export const STATUS = Object.freeze({
  ACTIVE: "active",
  ACTIVE_UNADOPTED: "active-unadopted",
  PROPOSED: "proposed",
  DORMANT: "dormant",
  RETIRED: "retired",
  INSTALLED_NEVER_INVOKED: "installed-never-invoked",
  UNKNOWN: "unknown",
});

// PATH-resolved, not an Apple-Silicon Homebrew literal: on an Intel Mac
// (/usr/local/bin) or Linux the absolute path made this feature silently dead.
const RG = resolveBin("rg") ?? "rg";
const GIT_TIMEOUT_MS = 5000;
const MAX_REPO_DEPTH = 3;
const REPO_WALK_BUDGET_MS = 20_000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const ONE_EIGHTY_DAYS_MS = 180 * 24 * 60 * 60 * 1000;

const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel",
  "Library", "Trash", ".cache", ".worktrees", "vendor", ".venv", "__pycache__",
]);

/** Read a JSON file, returning `fallback` on any failure -- same total-by-
 *  construction contract as skills-scan.mjs's readJsonSafe. */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function iso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript window -- the "not seen since when" half of every skill's
// evidence string. Derived from the oldest readable .jsonl mtime under
// PROJECTS_DIR, bounded by a single readdir pass (never one stat per session
// beyond what's needed to find the extremes) so this stays cheap even though
// probeTranscripts() itself doesn't compute it.
// ─────────────────────────────────────────────────────────────────────────────

const TRANSCRIPT_WALK_MAX_DEPTH = 8;

export function transcriptWindow({ projectsDir = PROJECTS_DIR } = {}) {
  let oldestMs = null;
  let newestMs = null;
  let scanned = 0;

  // Sessions nest below a project dir (project/<session>.jsonl AND
  // project/<session>/subagents/<agent>.jsonl), so this must recurse rather
  // than assume a fixed depth -- a one-level scan silently missed 794 of
  // 3756 real transcript files and reported a window starting 2026-07-15
  // instead of the true 2026-03-17 (found only by cross-checking against
  // `find`, per G13: verify the work, not the report). Bounded depth guards
  // against a symlink loop or pathological nesting, never assumed shallow.
  function walk(dir, depth) {
    if (depth > TRANSCRIPT_WALK_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        let fst;
        try {
          fst = statSync(full);
        } catch {
          continue;
        }
        scanned += 1;
        const mtime = fst.mtimeMs;
        if (oldestMs === null || mtime < oldestMs) oldestMs = mtime;
        if (newestMs === null || mtime > newestMs) newestMs = mtime;
      }
    }
  }

  if (!existsSync(projectsDir)) return { start: null, end: null, scanned: 0, error: "projects dir unreadable" };
  walk(projectsDir, 0);
  return { start: iso(oldestMs), end: iso(newestMs), scanned, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Skills
// ─────────────────────────────────────────────────────────────────────────────

/** Parse only the `description:` line out of frontmatter -- same technique
 *  as skills-scan.mjs's readFrontmatterName (deliberately not a YAML parse:
 *  one scalar, no new dependency). A skill with no description cannot be
 *  autotriggered by Claude Code -- description-matched activation is how a
 *  skill fires without being named. */
export function readFrontmatterDescription(skillMdPath) {
  if (!skillMdPath) return null;
  let text;
  try {
    text = readFileSync(skillMdPath, "utf8").slice(0, 4096);
  } catch {
    return null;
  }
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  const block = end === -1 ? text : text.slice(0, end);
  const m = block.match(/^description:[ \t]*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function classifySkill(s, window) {
  const invoked = s.usageCount > 0 || s.transcriptCount > 0;
  const hasDescription = Boolean(readFrontmatterDescription(s.resolvedSkillMd));
  const windowNote = window.scanned
    ? `transcripts spanning ${window.start ?? "?"}..${window.end ?? "?"} (${window.scanned} files)`
    : "transcript probe found no session files";

  if (s.dangling) {
    return {
      status: STATUS.UNKNOWN,
      evidence: `SKILL.md symlink dangles at ${s.dir} -- cannot read frontmatter or confirm the skill is real`,
      hasDescription,
      invoked,
    };
  }

  if (invoked) {
    return {
      status: STATUS.ACTIVE,
      evidence: `usageCount=${s.usageCount} (skillUsage, includes autonomous activation), transcriptCount=${s.transcriptCount} across ${s.transcriptSessions} session(s)${s.lastUsedAt ? `, lastUsedAt=${iso(s.lastUsedAt)}` : ""}`,
      hasDescription,
      invoked,
    };
  }

  const autotriggerNote = hasDescription
    ? ""
    : " -- also has NO description frontmatter, so it cannot autotrigger by description match; it can only ever fire if invoked by exact name";
  return {
    status: STATUS.INSTALLED_NEVER_INVOKED,
    evidence: `usageCount=0, transcriptCount=0 -- not seen in ${windowNote}${autotriggerNote}`,
    hasDescription,
    invoked,
  };
}

export function inventorySkills({ skillsDir, usage, lock, transcripts, window } = {}) {
  const tx = transcripts ?? probeTranscripts();
  const win = window ?? transcriptWindow();
  const scan = scanSkills({ skillsDir, usage, lock, transcripts: tx.byName });
  if (scan.error) {
    return {
      items: [],
      error: scan.error,
      probeLimits: { transcriptScanned: tx.scanned, transcriptWindow: win },
    };
  }

  const items = scan.skills.map((s) => {
    const cls = classifySkill(s, win);
    return {
      id: s.id,
      kind: "skill (Claude Code)",
      status: cls.status,
      evidence: cls.evidence,
      artifacts: s.dir,
      nameMismatch: s.nameMismatch,
      declaredName: s.declaredName,
      hasDescription: cls.hasDescription,
      installer: s.installer,
      liveness_probe: `grep skillUsage["${s.id}"] in ~/.claude.json; rg -o '"skill":"${s.id}"' -g '*.jsonl' ~/.claude/projects`,
    };
  });

  return {
    items,
    error: null,
    probeLimits: {
      transcriptScanned: tx.scanned,
      transcriptSearcher: tx.searcher,
      transcriptWindow: win,
      orphanUsageKeys: scan.orphanUsageKeys.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Plugins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `enabledPlugins` in ~/.claude/settings.json. NOTE THE LIMIT explicitly: this
 * flag records whether Claude Code will load the plugin, not whether a human
 * has actually exercised it -- there is no per-plugin usage counter analogous
 * to skillUsage. `true` is therefore classified `active-unadopted` rather than
 * `active`: loaded, but unproven. `false` is `dormant`: present in config,
 * switched off.
 */
export function inventoryPlugins({ settingsPath = SETTINGS_PATH } = {}) {
  const settings = readJsonSafe(settingsPath, null);
  if (!settings || typeof settings !== "object") {
    return { items: [], error: `unreadable or absent: ${settingsPath}` };
  }
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === "object" ? settings.enabledPlugins : {};
  const items = Object.entries(enabled).map(([name, on]) => ({
    id: `plugin:${name}`,
    kind: "plugin (marketplace)",
    status: on === true ? STATUS.ACTIVE_UNADOPTED : STATUS.DORMANT,
    evidence:
      on === true
        ? `enabledPlugins["${name}"] = true in ${settingsPath} -- loaded by Claude Code; no per-plugin invocation counter exists, so "loaded" is the strongest claim this probe can make`
        : `enabledPlugins["${name}"] = false in ${settingsPath} -- present in config, disabled`,
    artifacts: settingsPath,
    liveness_probe: `python3 -c "import json; print(json.load(open('${settingsPath}'))['enabledPlugins']['${name}'])"`,
  }));
  return { items, error: null, total: items.length, enabledCount: items.filter((i) => i.status === STATUS.ACTIVE_UNADOPTED).length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Repos (git + no-git-at-all)
// ─────────────────────────────────────────────────────────────────────────────

function runGit(args, cwd) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, error: err.signal === "SIGTERM" ? "git timed out" : String(err.message || err) };
  }
}

function listDirs(parent) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIR_NAMES.has(e.name))
    .map((e) => path.join(parent, e.name));
}

/** True if `dir` contains at least one non-hidden regular file, one level
 *  deep -- "real files" per the brief's rupali-varga-charts example, without
 *  a full recursive walk. */
function hasRealFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && !e.name.startsWith("."));
}

function classifyGitRepo(root, dropped) {
  const head = runGit(["log", "-1", "--format=%ct"], root);
  const lastCommitMs = head.ok && head.out ? Number(head.out) * 1000 : null;

  const commitCount = runGit(["rev-list", "--count", "HEAD"], root);
  const remotes = runGit(["remote"], root);
  const hasRemote = remotes.ok && remotes.out.length > 0;

  let unpushed = null;
  let unpushedReason = null;
  if (hasRemote) {
    const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
    if (upstream.ok) {
      const count = runGit(["rev-list", "--count", "@{u}..HEAD"], root);
      if (count.ok) unpushed = Number(count.out);
      else unpushedReason = count.error;
    } else {
      unpushedReason = "no upstream tracking branch for current HEAD";
    }
  } else {
    unpushedReason = "no remote configured";
  }

  const now = Date.now();
  const ageMs = lastCommitMs !== null ? now - lastCommitMs : null;

  let status;
  let evidenceBits = [];
  if (!head.ok || !commitCount.ok) {
    status = STATUS.UNKNOWN;
    evidenceBits.push(`git subprocess failed (${head.error || commitCount.error})`);
  } else {
    evidenceBits.push(`${commitCount.out} commits`);
    evidenceBits.push(hasRemote ? `remote present (${remotes.out.split("\n").join(",")})` : "NO REMOTE");
    evidenceBits.push(unpushed !== null ? `${unpushed} unpushed commit(s)` : `unpushed unknown (${unpushedReason})`);
    evidenceBits.push(lastCommitMs !== null ? `last commit ${iso(lastCommitMs)}` : "last commit unknown");

    if (ageMs === null) status = STATUS.UNKNOWN;
    else if (ageMs <= NINETY_DAYS_MS) status = hasRemote ? STATUS.ACTIVE : STATUS.ACTIVE_UNADOPTED;
    else if (ageMs <= ONE_EIGHTY_DAYS_MS) status = STATUS.DORMANT;
    else status = STATUS.DORMANT;
  }

  return {
    id: `repo:${root}`,
    kind: "git repo",
    status,
    evidence: evidenceBits.join("; "),
    artifacts: root,
    hasRemote,
    unpushed,
    commitCount: commitCount.ok ? Number(commitCount.out) : null,
    lastCommitAt: iso(lastCommitMs),
    liveness_probe: `git -C "${root}" log -1 --format=%ct && git -C "${root}" rev-list --count HEAD && git -C "${root}" remote -v`,
  };
}

/**
 * Walk SEARCH_ROOTS to MAX_REPO_DEPTH looking for `.git` (repo) and, for
 * directories that are NOT inside any repo, directories holding real files
 * with no `.git` anywhere in their own tree (the rupali-varga-charts case).
 * Bounded by both depth and a wall-clock budget (REPO_WALK_BUDGET_MS) -- any
 * subtree not reached before the budget expires is recorded in `dropped`,
 * never silently omitted (G3).
 */
export function inventoryRepos({ searchRoots = SEARCH_ROOTS, maxDepth = MAX_REPO_DEPTH, budgetMs = REPO_WALK_BUDGET_MS } = {}) {
  const items = [];
  const dropped = [];
  const seenRepoRoots = new Set();
  const start = Date.now();
  let budgetExceeded = false;

  function walk(dir, depth) {
    if (budgetExceeded) return;
    if (Date.now() - start > budgetMs) {
      budgetExceeded = true;
      dropped.push({ path: dir, reason: "time budget exceeded" });
      return;
    }
    const isRepo = existsSync(path.join(dir, ".git"));
    if (isRepo) {
      const real = (() => {
        try {
          return lstatSync(path.join(dir, ".git")).isDirectory() ? dir : dir; // worktree gitfile still counts as a repo root here
        } catch {
          return dir;
        }
      })();
      if (!seenRepoRoots.has(real)) {
        seenRepoRoots.add(real);
        items.push(classifyGitRepo(real, dropped));
      }
      return; // do not descend into a repo's own subtree looking for nested repos/no-git dirs
    }

    if (depth >= maxDepth) {
      // Log a drop whenever there is ANYTHING unexplored below this point --
      // either real files right here, or child directories we never
      // descended into (which could themselves hold a repo or real files).
      // Checking only hasRealFiles(dir) missed the common case of an
      // intermediate directory that holds no files of its own but has
      // subdirectories that do (G3: never silently truncate).
      if (hasRealFiles(dir) || listDirs(dir).length > 0) {
        dropped.push({ path: dir, reason: `max depth ${maxDepth} reached -- not walked further to check for nested .git or content` });
      }
      return;
    }

    const children = listDirs(dir);
    // A directory with real files and no .git anywhere in *this* subtree, and
    // that is not itself a parent of any repo, is a no-git-at-all case. We
    // can only know "no repo anywhere below" after walking children, so this
    // directory is provisionally recorded and reconciled after descent.
    const before = items.length;
    for (const child of children) walk(child, depth + 1);
    const foundNestedRepo = items.length > before;
    if (!foundNestedRepo && hasRealFiles(dir)) {
      items.push({
        id: `no-git:${dir}`,
        kind: "directory (no .git)",
        status: STATUS.ACTIVE_UNADOPTED,
        evidence: `contains real files, no .git anywhere in this subtree as of the walk to depth ${maxDepth} -- no version-control safety net`,
        artifacts: dir,
        liveness_probe: `test -d "${dir}/.git" ; echo $?  # expect 1 (absent)`,
      });
    }
  }

  for (const root of searchRoots) {
    for (const child of listDirs(root)) walk(child, 1);
  }

  return { items, dropped, budgetExceeded };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Standalone artifacts
// ─────────────────────────────────────────────────────────────────────────────

/** Count referrers of `basename(filePath)` across `.md` files under `roots`,
 *  via a single rg (or grep fallback) invocation -- same tooling choice as
 *  skills-scan.mjs's probeTranscripts, for the same reason (G6: one process
 *  for the whole tree, not one per candidate file). Excludes the file's own
 *  path from its own referrer count. */
export function countReferrers(filePath, { roots = [...SEARCH_ROOTS, path.join(HOME, ".claude")] } = {}) {
  const needle = path.basename(filePath);
  const existingRoots = roots.filter((r) => existsSync(r));
  if (existingRoots.length === 0) return { count: 0, files: [], searcher: null, error: "no search roots exist" };

  const useRg = existsSync(RG);
  const [bin, args] = useRg
    ? [RG, ["--no-heading", "-l", "-F", "-g", "*.md", "--no-ignore", "--hidden", needle, ...existingRoots]]
    : ["/usr/bin/grep", ["-rl", "-F", "--include=*.md", needle, ...existingRoots]];

  let out = "";
  try {
    out = execFileSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    if (err && err.status === 1 && typeof err.stdout === "string") out = err.stdout;
    else return { count: 0, files: [], searcher: bin, error: `search failed: ${err.message}` };
  }

  const files = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => path.resolve(f) !== path.resolve(filePath));

  return { count: files.length, files, searcher: bin, error: null };
}

export function inventoryStandalone({ seeds = STANDALONE_SEEDS, roots } = {}) {
  const items = [];
  for (const filePath of seeds) {
    if (!existsSync(filePath)) {
      items.push({
        id: `standalone:${filePath}`,
        kind: "standalone artifact",
        status: STATUS.UNKNOWN,
        evidence: `file does not exist at ${filePath} -- cannot check referrers`,
        artifacts: filePath,
        liveness_probe: `test -f "${filePath}"`,
      });
      continue;
    }
    const { count, files, searcher, error } = countReferrers(filePath, roots ? { roots } : undefined);
    let mtimeMs = null;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch { /* leave null */ }
    const ageMs = mtimeMs !== null ? Date.now() - mtimeMs : null;
    const recent = ageMs !== null && ageMs <= NINETY_DAYS_MS;

    let status;
    let evidence;
    if (error) {
      status = STATUS.UNKNOWN;
      evidence = `referrer search failed: ${error}`;
    } else if (count > 0) {
      status = STATUS.ACTIVE;
      evidence = `${count} referrer(s) across .md files (searcher: ${searcher}): ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`;
    } else if (recent) {
      status = STATUS.ACTIVE_UNADOPTED;
      evidence = `0 referrers found via ${searcher} across .md files, but file was modified ${iso(mtimeMs)} (within 90d) -- actively maintained without being cross-referenced as canonical anywhere`;
    } else {
      status = STATUS.DORMANT;
      evidence = `0 referrers found via ${searcher} across .md files; last modified ${mtimeMs !== null ? iso(mtimeMs) : "unknown"}`;
    }

    items.push({
      id: `standalone:${filePath}`,
      kind: "standalone artifact",
      status,
      evidence,
      artifacts: filePath,
      liveness_probe: `rg -l -F "${path.basename(filePath)}" -g '*.md' ~/Documents/GitHub ~/.claude`,
    });
  }
  return { items, seeded: true, note: "seed list only -- see module header on PROBE LIMITS; this does not discover new standalone artifacts on its own" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full inventory across all four categories. Read-only; never mutates
 * anything (no writes, no quarantine, no reap). `log` receives one line per
 * bounded/dropped item (G3) -- defaults to console.error so a CLI run and a
 * digest run both see it, but is injectable for tests.
 */
export function inventory({
  skillsDir,
  usage,
  lock,
  transcripts,
  settingsPath,
  searchRoots,
  standaloneSeeds,
  log = (msg) => console.error(`[inventory] ${msg}`),
} = {}) {
  const tx = transcripts ?? probeTranscripts();
  const window = transcriptWindow();

  const skills = inventorySkills({ skillsDir, usage, lock, transcripts: tx, window });
  const plugins = inventoryPlugins({ settingsPath });
  const repos = inventoryRepos({ searchRoots });
  const standalone = inventoryStandalone({ seeds: standaloneSeeds });

  for (const d of repos.dropped) log(`repos: dropped ${d.path} -- ${d.reason}`);
  if (repos.budgetExceeded) log(`repos: walk budget exceeded, results are partial`);
  if (skills.error) log(`skills: ${skills.error}`);
  if (plugins.error) log(`plugins: ${plugins.error}`);

  const categories = { skills: skills.items, plugins: plugins.items, repos: repos.items, standalone: standalone.items };
  const allItems = [...categories.skills, ...categories.plugins, ...categories.repos, ...categories.standalone];

  const counts = { total: allItems.length };
  for (const item of allItems) counts[item.status] = (counts[item.status] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    probeLimits: {
      transcriptScanned: tx.scanned,
      transcriptSearcher: tx.searcher,
      transcriptWindow: window,
      note: "\"never invoked\" for skills means \"not seen in surviving transcripts\" -- transcripts start at transcriptWindow.start; anything used and untouched before that date is indistinguishable from never-used. The repo walk is bounded (see dropped); the standalone-artifact check is seeded, not exhaustive.",
    },
    categories,
    counts,
    dropped: repos.dropped,
    budgetExceeded: repos.budgetExceeded,
  };
}

/** Render one paste-ready SYSTEMS.md row for a single inventory item.
 *  Column order MUST match docs/SYSTEMS.md exactly:
 *  id | kind | status | supersedes / superseded_by | artifacts | liveness_probe | last_verified | adoption_date | retirement_checklist_done
 *
 *  `adoption_date` is always left BLANK here -- this is a machine probe, and
 *  SYSTEMS.md's own column definition requires a human confirming real,
 *  repeated use before that field is filled (see docs/SYSTEMS.md's "Notes on
 *  this seed": filling it early defeats the point). `retirement_checklist_done`
 *  is `n/a` for every non-`retired` row for the same reason.
 */
export function toSystemsRow(item, { verifiedDate = new Date().toISOString().slice(0, 10) } = {}) {
  const cells = [
    item.id,
    item.kind,
    item.status,
    item.supersedes ?? "—",
    item.artifacts,
    item.liveness_probe,
    verifiedDate,
    "BLANK -- machine-probed, not human-confirmed",
    item.status === STATUS.RETIRED ? "not started" : "n/a",
  ];
  return `| ${cells.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
}

export function emitRows(inv, opts) {
  const allItems = [...inv.categories.skills, ...inv.categories.plugins, ...inv.categories.repos, ...inv.categories.standalone];
  return allItems.map((item) => toSystemsRow(item, opts));
}
