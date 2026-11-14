#!/usr/bin/env node
/**
 * SessionStart hook (propagate#272, lane D): tells a session which folder, repos, goal and item it serves, and which
 * guidance files to read first.
 *
 * DEPENDENCY-FREE ON PURPOSE (node builtins only). `lib/sessions/resolve.mjs` imports `lib/core/config.mjs`, which runs
 * workspace discovery at module load, and `assoc.mjs` imports proper-lockfile: measured, importing resolve.mjs alone
 * adds about 0.2 s to a process whose bare start is about 0.14 s on this machine. The CEO review (S7) caps the hook,
 * so it re-implements the three small reads it needs; tests/hooks/session-guide.test.mjs asserts parity with
 * `readCheckouts`, `fold` and `folderOf`, so the copies cannot drift unnoticed.
 *
 * WHAT IT READS: `$STATE/sessions/checkouts.json` (the CLI refreshes it; the hook never builds it) and
 * `$STATE/sessions/assoc.jsonl`. It NEVER calls `claude`, `readLive`, the network, or git, except ONE
 * `git rev-parse --git-common-dir` when the cwd is inside `.claude/worktrees/`. Workspace and hub are found by reading
 * `.propagates.yml` markers on the ancestors of cwd and `hubRoot` (env or `$STATE/config.yml`), never by discovery.
 *
 * FAILS OPEN AND SILENT: any error appends one line to `$STATE/sessions/errors.log` and exits 0 with no output.
 * Output is one `additionalContext` block of at most 2,000 characters (the platform ignores over 10,000).
 * Takes effect only after `/reload-plugins` or a new session.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stateDir } from "../lib/core/paths.mjs";

export const CAP = 2000;

// The state dir comes from the path registry, never a literal (tests/portability/path-registry-literals). paths.mjs imports
// only node builtins, so this costs the hook nothing; config.mjs (discovery at load) stays out.
const stateDirOf = () => stateDir();

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** null when absent or unreadable. Same contract as resolve.readCheckouts. */
function readCache(dir) {
  const m = JSON.parse(readFileSync(path.join(dir, "sessions", "checkouts.json"), "utf8"));
  if (!Array.isArray(m?.checkouts)) throw new Error("checkouts.json has no checkouts array");
  return m;
}

/** The latest `associate` per rowKey not followed by `forgotten`; then the newest one whose row carries this session id. */
function associationFor(dir, sessionId) {
  let text;
  try {
    text = readFileSync(path.join(dir, "sessions", "assoc.jsonl"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const cur = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // an unreadable line is skipped, as fold() does
    }
    if (!ev || typeof ev.event !== "string" || typeof ev.rowKey !== "string") continue;
    if (ev.event === "associate") cur.set(ev.rowKey, ev);
    else if (ev.event === "forgotten") cur.set(ev.rowKey, null);
  }
  let best = null;
  for (const a of cur.values()) {
    if (a && a.row?.sessionId === sessionId && (!best || String(a.ts) > String(best.ts))) best = a;
  }
  return best;
}

/** A linked worktree's main checkout. Called only when cwd is inside `.claude/worktrees/`. */
function mainCheckout(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  const common = r.status === 0 ? r.stdout.trim() : null;
  if (!common || path.basename(common) !== ".git") return cwd;
  return path.dirname(common);
}

const isWorkspaceDir = (dir) => {
  try {
    return /^workspace:\s*true\s*(#.*)?$/m.test(readFileSync(path.join(dir, ".propagates.yml"), "utf8"));
  } catch {
    return false;
  }
};

function hubRootOf(dir) {
  const env = process.env.PROPAGATE_HUB_ROOT;
  const raw = env && env.trim() ? env.trim() : (() => {
    try {
      return readFileSync(path.join(dir, "config.yml"), "utf8").match(/^hubRoot:\s*["']?([^"'#\n]+?)["']?\s*(#.*)?$/m)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  if (!raw) return null;
  return real(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
}

/**
 * Same answer as resolve.folderOf, from the cache plus marker files. `{unplaced: true}` outside every workspace.
 * The owner is the nearest ancestor of cwd carrying `workspace: true`.
 */
export function placeOf(cwdIn, cache, dir) {
  const hub = hubRootOf(dir);
  const cwd = real(/[\\/]\.claude[\\/]worktrees[\\/]/.test(cwdIn) ? mainCheckout(cwdIn) : cwdIn);
  if (hub && cwd === hub) return { workspace: "hub", project: "(all)", repos: [], all: true, workspaceRoot: hub, cwd };
  let owner = null;
  for (let d = cwd; ; d = path.dirname(d)) {
    if (isWorkspaceDir(d)) {
      owner = d;
      break;
    }
    if (d === path.dirname(d)) break;
  }
  if (!owner) return { unplaced: true };
  const rel = path.relative(owner, cwd);
  const project = rel ? rel.split(path.sep)[0] : "(workspace root)";
  const repos = new Set();
  let containing = null;
  for (const c of cache.checkouts) {
    if (!c.repo) continue;
    const cp = real(c.path);
    if (within(cp, cwd)) repos.add(c.repo);
    else if (within(cwd, cp) && within(cp, owner) && (!containing || cp.length > containing.cp.length)) containing = { cp, repo: c.repo };
  }
  if (containing) repos.add(containing.repo);
  return { workspace: path.basename(owner), project, repos: [...repos].sort(), workspaceRoot: owner, cwd, hub };
}

/** The guidance files, same walk as show.guidanceFor. */
export function guidance(folder) {
  const top = folder.all ? folder.cwd : folder.hub && within(folder.cwd, folder.hub) ? folder.hub : folder.workspaceRoot;
  const out = [];
  for (let d = folder.cwd; ; d = path.dirname(d)) {
    const f = path.join(d, "CLAUDE.md");
    if (existsSync(f)) out.push(f);
    if (d === top || d === path.dirname(d)) break;
  }
  if (!folder.all && folder.project && !folder.project.startsWith("(")) {
    for (const base of new Set([folder.workspaceRoot, folder.hub].filter(Boolean))) {
      for (const name of ["STATE.md", "DECISIONS.md", "GOTCHAS.md"]) {
        const f = path.join(base, "propagation", "state", folder.project, name);
        if (existsSync(f)) out.push(f);
      }
    }
  }
  return out;
}

/**
 * Build the block, at most CAP characters. Repos are dropped from the end first ("+N more"), then guidance files.
 * @returns {string|null}
 */
export function buildBlock({ folder, assoc, sessionId, files }) {
  const sid = String(sessionId).slice(0, 8);
  const head = folder.all ? "Session: hub (all repos)" : `Session: ${folder.project} (${folder.workspace})`;
  const tail = assoc
    ? ` · goal ${assoc.goal ?? "-"} · item ${assoc.item ?? "-"}`
    : ` · unassociated: propagate sessions assoc ${sid} --from owner/repo#n`;
  const more = (n) => ` +${n} more: propagate sessions show ${sid}`;
  const reads = (fs) => (fs.length ? `. Read first: ${fs.join(", ")}.` : ".");
  const repos = folder.repos;
  // The pointer is the LAST thing in the block, so a cut list always ends by saying where the rest is.
  const line = (n, fs) => {
    const r = folder.all || n === 0 ? "" : ` · repos: ${repos.slice(0, n).join(", ")}`;
    return `${head}${r}${tail}${reads(fs)}${n < repos.length && !folder.all ? more(repos.length - n) : ""}`;
  };
  let n = repos.length;
  let fs = files;
  let text = line(n, fs);
  while (text.length > CAP && n > 0) text = line(--n, fs);
  while (text.length > CAP && fs.length > 0) text = line(n, (fs = fs.slice(0, -1)));
  return text.length > CAP ? text.slice(0, CAP) : text;
}

function logError(dir, err) {
  try {
    const f = path.join(dir, "sessions", "errors.log");
    mkdirSync(path.dirname(f), { recursive: true });
    appendFileSync(f, `${new Date().toISOString()} session-guide: ${String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 300)}\n`);
  } catch {
    // nothing left to try; the hook still exits 0
  }
}

/** @returns {string|null} the additionalContext text, or null for "inject nothing" */
export function run(payload, dir = stateDirOf()) {
  let cache;
  try {
    cache = readCache(dir);
  } catch (e) {
    if (e.code === "ENOENT") return null; // no cache: the CLI has not run yet, so there is nothing to say
    throw e;
  }
  const cwd = payload?.cwd || process.env.CLAUDE_PROJECT_DIR;
  if (!cwd) return null;
  const folder = placeOf(cwd, cache, dir);
  if (folder.unplaced) return null;
  const sessionId = String(payload?.session_id ?? "");
  const assoc = sessionId ? associationFor(dir, sessionId) : null;
  return buildBlock({ folder, assoc, sessionId: sessionId || "<id>", files: guidance(folder) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = stateDirOf();
  try {
    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = "";
    }
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const text = run(payload, dir);
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  } catch (e) {
    logError(dir, e);
  }
  process.exit(0);
}
