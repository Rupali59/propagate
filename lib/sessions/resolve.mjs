/**
 * Which folder, and which repos, a session works in (propagate#272). This module OWNS the repo -> checkout map: the
 * "broadcast phase-2 checkouts map" the plan reuses was never built (Eng finding, 2026-11-14). It is built from
 * propagate's own discovery (workspaces) plus `git remote get-url origin` per checkout, cached at
 * `$STATE/sessions/checkouts.json`. The CLI refreshes the cache on every read; a hook may only READ it.
 *
 * Rule: a session works in EVERY repo whose checkout is at or below its directory, and in the repo whose checkout
 * contains it. A cwd at the hub root covers everything and reads as `hub (all)`, never a long list. A worktree under
 * `.claude/worktrees/` resolves to its main checkout through `git rev-parse --git-common-dir`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HUB_ROOT, SEARCH_ROOTS } from "../core/config.mjs";
import { discoverWorkspacesSync, isSkippedDir, nearestOwner } from "../core/discovery.mjs";
import { stateDir } from "../core/paths.mjs";
import { parseGithubRemote } from "../tasks/plan.mjs";

/** How far below a workspace root a git checkout is looked for. */
const CHECKOUT_DEPTH = 2;

const cachePath = (dir) => path.join(dir, "sessions", "checkouts.json");

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Git checkouts at or below `root`, to CHECKOUT_DEPTH, skipping dot-dirs and vendored dirs. */
function checkoutsUnder(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (existsSync(path.join(dir, ".git"))) out.push(dir);
    if (depth >= CHECKOUT_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || isSkippedDir(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Build the map. One `git remote` call per checkout.
 * @returns {{generatedAt: string, checkouts: Array<{path: string, repo: string|null}>}}
 */
export function buildCheckouts({ workspaces, now = Date.now() } = {}) {
  const ws = workspaces ?? discoverWorkspacesSync(SEARCH_ROOTS).workspaces;
  const seen = new Set();
  const checkouts = [];
  for (const w of ws) {
    for (const p of checkoutsUnder(w.root)) {
      if (seen.has(p)) continue;
      seen.add(p);
      const origin = git(p, ["remote", "get-url", "origin"]);
      checkouts.push({ path: p, repo: origin ? parseGithubRemote(origin) : null });
    }
  }
  checkouts.sort((a, b) => a.path.localeCompare(b.path));
  return { generatedAt: new Date(now).toISOString(), checkouts };
}

/** Atomic write of the cache. Throws on failure; the caller decides whether that matters. */
export function writeCheckouts(map, dir = stateDir()) {
  const target = cachePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}

/** Read the cache. null when absent or unreadable, never a guess. */
export function readCheckouts(dir = stateDir()) {
  try {
    const m = JSON.parse(readFileSync(cachePath(dir), "utf8"));
    return Array.isArray(m?.checkouts) ? m : null;
  } catch {
    return null;
  }
}

/**
 * The resolution context: workspaces, the checkouts map and the hub root. `refresh` rebuilds the map and rewrites the
 * cache (a cache that cannot be written is reported in `warnings`; it does not fail the read).
 * @returns {{workspaces: object[], checkouts: Array<{path: string, repo: string|null}>, hubRoot: string|null, generatedAt: string, warnings: string[]}}
 */
export function loadContext({ stateDirPath = stateDir(), refresh = true, workspaces, hubRoot = HUB_ROOT, now } = {}) {
  const warnings = [];
  const ws = workspaces ?? discoverWorkspacesSync(SEARCH_ROOTS).workspaces;
  let map = refresh ? null : readCheckouts(stateDirPath);
  if (!map) {
    map = buildCheckouts({ workspaces: ws, now });
    try {
      writeCheckouts(map, stateDirPath);
    } catch (e) {
      warnings.push(`checkouts cache not written: ${e.message}`);
    }
  }
  return { workspaces: ws, checkouts: map.checkouts, hubRoot: hubRoot ?? null, generatedAt: map.generatedAt, warnings };
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** A linked worktree's main checkout, via the common git dir. The cwd itself when it is not a worktree or git cannot say. */
export function mainCheckoutOf(cwd) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common || path.basename(common) !== ".git") return cwd;
  const main = path.dirname(common);
  return real(main) === real(cwd) ? cwd : main;
}

/**
 * @param {string} cwd
 * @param {{workspaces: object[], checkouts: Array<{path: string, repo: string|null}>, hubRoot: string|null}} ctx
 * @returns {{workspace: string, project: string, repos: string[], all?: boolean} | {unplaced: true}}
 */
export function folderOf(cwd, ctx) {
  if (!cwd || !ctx) return { unplaced: true };
  const here = real(mainCheckoutOf(cwd));
  const hub = ctx.hubRoot ? real(ctx.hubRoot) : null;
  if (hub && here === hub) return { workspace: "hub", project: "(all)", repos: [], all: true, workspaceRoot: hub, cwd: here };

  const owner = nearestOwner(here, ctx.workspaces);
  if (!owner) return { unplaced: true };
  const rel = path.relative(owner.root, here);
  const project = rel ? rel.split(path.sep)[0] : "(workspace root)";

  // At or below the cwd: every repo. Containing the cwd: only the DEEPEST one, and only when it sits inside the owning
  // workspace. Otherwise the hub's own repo (a checkout above every workspace) would be listed for every session.
  const repos = new Set();
  let containing = null;
  for (const c of ctx.checkouts) {
    if (!c.repo) continue;
    const cp = real(c.path);
    if (within(cp, here)) repos.add(c.repo);
    else if (within(here, cp) && within(cp, real(owner.root)) && (!containing || cp.length > containing.cp.length)) containing = { cp, repo: c.repo };
  }
  if (containing) repos.add(containing.repo);
  return { workspace: owner.name ?? path.basename(owner.root), project, repos: [...repos].sort(), workspaceRoot: owner.root, cwd: here };
}
