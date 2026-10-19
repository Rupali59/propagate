/**
 * Reading the work that moved to GitHub back into propagate (#104, R4).
 *
 * `backlog()` is synchronous and offline: doctor, the monitor, digest, the dashboard and the rollup
 * all call it. So the network read is a separate, ASYNC step that leaves its result in a cache
 * (`tracker-cache.json`, see `tracker-cache.mjs`), and `backlog()` merges that cache without ever
 * spawning gh. Who refreshes: `propagate backlog` (unless --offline), the monitor's scheduled run,
 * and the dashboard's refresh button. Everyone else reads the cache and prints its age.
 *
 * TWO THINGS LEARNED ON 2026-10-18, both load-bearing:
 *
 *  1. READ THROUGH REST, NOT GRAPHQL. `gh issue list` spends the GraphQL budget; two read-only
 *     agents exhausted it and blocked every write. `gh api repos/O/R/issues --paginate` spends the
 *     REST core budget (5,000/h), which is separate. The REST list includes pull requests, so
 *     anything carrying a `pull_request` key is dropped.
 *  2. EVERY gh CALL HAS A TIMEOUT. A hung `gh issue close` blocked a session for 15 minutes. Each
 *     call gets `perCallMs`, and the whole refresh gets `deadlineMs`; a tracker that timed out reads
 *     `unreadable: timed out after Ns` and keeps its previous rows, marked stale.
 *
 * Every tracker ends in exactly one of: counted / unreadable (reason) / unsupported (reason) /
 * not-fetched (no cache yet). None of them is ever rendered as 0 (rule:discernment-checks §2, §6).
 *
 * INJECTION SEAM: `gh` is a path (default $PROPAGATE_GH_BIN, else "gh") or a function
 * `(args) => Promise<{status, stdout, stderr, timedOut?}>`. The real gh path is exercised only by
 * the parent's real run (rule:name-what-no-test-executes); the tests use fakes.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { stateDir as defaultStateDir } from "../core/paths.mjs";
import { parseGithubIssuesUrl, trackerKey } from "../report/backlog.mjs";
import { readTrackerCache, trackerCachePath, TRACKER_CACHE_VERSION } from "./tracker-cache.mjs";

export { readTrackerCache, trackerCachePath, formatAge, TRACKER_CACHE_FILE } from "./tracker-cache.mjs";

export const DEFAULT_DEADLINE_MS = 20_000;
export const DEFAULT_PER_CALL_MS = 15_000;
export const DEFAULT_PARALLEL = 4;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

const firstLine = (s) => String(s ?? "").trim().split("\n")[0];

/** The cache key for a delegated destination, and its parsed target (null when it is not a GitHub issues list). */
export function keyForDestination(delegatedTo) {
  const target = parseGithubIssuesUrl(delegatedTo);
  return target ? { key: trackerKey(target), target } : { key: "unsupported|" + String(delegatedTo ?? ""), target: null };
}

/** The `gh api` argv for one tracker. Exported so a test can pin the REST shape (and that it is not `issue list`). */
export function ghArgsFor(target) {
  let endpoint = `repos/${target.repo}/issues?state=open&per_page=100`;
  if (target.labels?.length) endpoint += "&labels=" + target.labels.map(encodeURIComponent).join(",");
  return ["api", endpoint, "--paginate"];
}

/**
 * `gh api --paginate` prints each page's array in turn, so a multi-page read is `[...][...]`, which is
 * not one JSON document. Split at top-level value boundaries (string-aware) and parse each; require
 * every one to be an array. Throws with a reason on anything else.
 */
export function parsePaginatedArrays(text) {
  const s = String(text ?? "");
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1, seen = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[" || c === "{") { if (depth === 0) start = i; depth++; continue; }
    if (c === "]" || c === "}") {
      depth--;
      if (depth < 0) throw new Error("gh output was not JSON");
      if (depth === 0) {
        let v;
        try { v = JSON.parse(s.slice(start, i + 1)); } catch { throw new Error("gh output was not JSON"); }
        if (!Array.isArray(v)) throw new Error("gh output was not a JSON array");
        out.push(...v);
        seen = true;
      }
      continue;
    }
    if (depth === 0 && !/\s/.test(c)) throw new Error("gh output was not JSON");
  }
  if (depth !== 0 || inStr || !seen) throw new Error("gh output was not JSON");
  return out;
}

/** One REST issue -> the fields propagate keeps. Pull requests are not issues: null. */
function shapeIssue(i) {
  if (!i || typeof i !== "object" || i.pull_request) return null;
  return {
    number: typeof i.number === "number" ? i.number : null,
    title: String(i.title ?? ""),
    url: typeof i.html_url === "string" ? i.html_url : null,
    labels: (Array.isArray(i.labels) ? i.labels : []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
    createdAt: i.created_at ?? null,
    updatedAt: i.updated_at ?? null,
  };
}

/** Spawn gh asynchronously with a hard timeout. Resolves, never rejects. A timed-out child is SIGKILLed and not waited for. */
function spawnGh(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let out = "", err = "", bytes = 0;
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
    } catch (e) {
      return resolve({ status: 127, stdout: "", stderr: `${bin}: ${e?.code || e?.message}` });
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      // Do not wait for 'close': an orphaned grandchild can hold the pipe open for ever.
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* ignore */ }
      finish({ status: null, stdout: "", stderr: "", timedOut: true });
    }, Math.max(1, timeoutMs));
    child.stdout.on("data", (d) => { bytes += d.length; if (bytes <= MAX_STDOUT_BYTES) out += d; });
    child.stderr.on("data", (d) => { if (err.length < 8192) err += d; });
    child.on("error", (e) => finish({ status: 127, stdout: "", stderr: `${bin}: ${e?.code || e?.message}` }));
    child.on("close", (code) => finish({ status: code ?? 1, stdout: bytes > MAX_STDOUT_BYTES ? "" : out, stderr: bytes > MAX_STDOUT_BYTES ? "gh output exceeded 64 MB" : err }));
  });
}

async function fetchOne(runGh, target, timeoutMs) {
  const r = await runGh(ghArgsFor(target), timeoutMs);
  if (r.timedOut) return { ok: false, reason: `timed out after ${timeoutMs < 10000 ? (timeoutMs / 1000).toFixed(1) : Math.round(timeoutMs / 1000)}s` };
  if (r.status !== 0) return { ok: false, reason: `gh exited ${r.status}: ${firstLine(r.stderr || r.stdout) || "no output"}` };
  let list;
  try { list = parsePaginatedArrays(r.stdout); } catch (e) { return { ok: false, reason: e.message }; }
  const issues = list.map(shapeIssue).filter(Boolean);
  return { ok: true, issues };
}

/**
 * Refresh the cache from GitHub. Async, bounded, and it writes the cache atomically
 * (tmp file + rename) so a reader never sees half a file.
 *
 * @param {object} o
 * @param {Array<{file: string, delegatedTo: string}>} o.delegated  backlog().totals.delegated
 * @param {number} [o.deadlineMs]   total wall-clock budget for the whole refresh
 * @param {number} [o.perCallMs]    budget for one gh call (also bounded by what is left of the deadline)
 * @param {number} [o.parallel]     concurrent gh calls
 * @param {string|Function} [o.gh]  see INJECTION SEAM above
 * @param {string} [o.stateDir]
 * @param {() => number} [o.now]
 * @param {boolean} [o.write]       false: compute and return, write nothing
 * @returns {Promise<{ok: boolean, fetched: number, failed: number, skipped: number, unsupported: number,
 *                    deadlineHit: boolean, writtenAt: string, path: string, wrote: boolean, error: string|null}>}
 */
export async function refreshTrackers({
  delegated,
  deadlineMs = DEFAULT_DEADLINE_MS,
  perCallMs = DEFAULT_PER_CALL_MS,
  parallel = DEFAULT_PARALLEL,
  gh = process.env.PROPAGATE_GH_BIN || "gh",
  stateDir = defaultStateDir(),
  now = Date.now,
  write = true,
} = {}) {
  const t0 = now();
  const runGh = typeof gh === "function" ? (args, ms) => gh(args, ms) : (args, ms) => spawnGh(gh, args, ms);
  const prev = readTrackerCache({ stateDir, now: t0 });
  const next = { ...prev.entries };

  // One job per (repo, filter): registers sharing a repo are fetched once.
  const jobs = new Map();
  let unsupported = 0;
  for (const { delegatedTo } of delegated ?? []) {
    const { key, target } = keyForDestination(delegatedTo);
    if (jobs.has(key)) continue;
    jobs.set(key, { key, target, delegatedTo });
  }
  const stamp = new Date(t0).toISOString();
  const queue = [];
  for (const j of jobs.values()) {
    if (!j.target) {
      unsupported++;
      next[j.key] = { key: j.key, delegatedTo: j.delegatedTo, status: "unsupported", reason: "not a GitHub issues URL: " + j.delegatedTo, checkedAt: stamp, stale: false, issues: [] };
    } else queue.push(j);
  }

  let fetched = 0, failed = 0, skipped = 0, deadlineHit = false;
  const deadlineAt = t0 + deadlineMs;
  const markFailed = (j, reason, at) => {
    const old = next[j.key];
    next[j.key] = {
      key: j.key, repo: j.target.repo, ...(j.target.labels ? { labels: j.target.labels } : {}), delegatedTo: j.delegatedTo,
      status: "unreadable", reason, fetchedAt: old?.fetchedAt ?? null, checkedAt: at,
      // The rows survive a failed read, marked stale, so a blip greys them out instead of deleting them.
      stale: (Array.isArray(old?.issues) && old.issues.length > 0) || old?.status === "counted",
      issues: Array.isArray(old?.issues) ? old.issues : [],
    };
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const j = queue[cursor++];
      const left = deadlineAt - now();
      if (left <= 0) {
        deadlineHit = true; skipped++;
        markFailed(j, `not attempted: the ${Math.round(deadlineMs / 1000)}s refresh deadline was reached`, new Date(now()).toISOString());
        continue;
      }
      const r = await fetchOne(runGh, j.target, Math.min(perCallMs, left));
      const at = new Date(now()).toISOString();
      if (r.ok) {
        fetched++;
        next[j.key] = {
          key: j.key, repo: j.target.repo, ...(j.target.labels ? { labels: j.target.labels } : {}), delegatedTo: j.delegatedTo,
          status: "counted", open: r.issues.length, capped: false, fetchedAt: at, checkedAt: at, stale: false, issues: r.issues,
        };
      } else {
        failed++;
        markFailed(j, r.reason, at);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, queue.length || 1)) }, worker));

  const writtenAt = new Date(now()).toISOString();
  const file = trackerCachePath(stateDir);
  let wrote = false, error = null;
  if (write) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: TRACKER_CACHE_VERSION, writtenAt, trackers: next }, null, 1) + "\n");
      try { renameSync(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
      wrote = true;
    } catch (e) {
      error = `could not write ${file}: ${String(e?.message ?? e)}`;
    }
  }
  return { ok: !error && failed === 0 && skipped === 0, fetched, failed, skipped, unsupported, deadlineHit, writtenAt, path: file, wrote, error };
}
