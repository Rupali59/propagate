/**
 * lib/worktrees/routes.mjs — contract C4 (propagate#446): the cleaner routes a Tier B worktree whose next step belongs
 * to an issue as `{kind: "issue-comment", repo: "<owner/name>", issue: <n>, body: "<evidence line>"}`. propagate posts
 * the comment, once per head, and never decides the verdict.
 *
 * Posts happen ONLY under `apply`: a dry run lists what it would post and calls nothing. The dedupe ledger is
 * `$STATE/cleaner/routes-posted.jsonl`, one line per posted route, keyed `<repo>#<issue>@<head>`; a route with no `head`
 * is refused (status and count head_missing) and never posted: a body hash is not a head. A failed `gh` call is named and
 * counted and is NOT written to the ledger, so the next run retries it.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const ledgerPath = (stateDir) => path.join(stateDir, "cleaner", "routes-posted.jsonl");

const FULL_SHA = /^[0-9a-f]{40}$/;
const headOk = (r) => typeof r.head === "string" && FULL_SHA.test(r.head);

/** The dedupe key of one route; only called for a route with a full 40-char head. */
export function routeKey(r) {
  return `${r.repo}#${r.issue}@${r.head}`;
}

/** Why a route cannot be posted, or null. A malformed route is reported, never silently dropped. */
export function invalidReason(r) {
  if (!r || typeof r !== "object") return "route is not an object";
  if (r.kind !== "issue-comment") return `unsupported kind ${JSON.stringify(r.kind)}`;
  if (typeof r.repo !== "string" || !REPO.test(r.repo)) return `repo ${JSON.stringify(r.repo)} is not owner/name`;
  if (!Number.isInteger(r.issue) || r.issue < 1) return `issue ${JSON.stringify(r.issue)} is not a positive integer`;
  if (typeof r.body !== "string" || !r.body.trim()) return "body is empty";
  return null;
}

/** The set of keys already posted. A missing ledger is empty; an unreadable one throws (the caller exits 2, never posts blind). */
export function loadPosted(stateDir) {
  let text;
  try {
    text = readFileSync(ledgerPath(stateDir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return new Set();
    throw e;
  }
  const keys = new Set();
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try { const k = JSON.parse(l)?.key; if (typeof k === "string") keys.add(k); } catch { /* a torn line posts again rather than hiding a route */ }
  }
  return keys;
}

/**
 * @param {{routes: object[], apply: boolean, stateDir: string, ghBin?: string, spawn?: Function, now?: () => number}} o
 * @returns {{rows: Array<{key: string|null, status: string, repo?: string, issue?: number, error?: string}>, counts: Record<string, number>}}
 */
export function postRoutes({ routes, apply, stateDir, ghBin = process.env.PROPAGATE_GH_BIN || "gh", spawn = spawnSync, now = Date.now }) {
  const posted = loadPosted(stateDir);
  const rows = [];
  for (const r of routes) {
    const bad = invalidReason(r);
    if (bad) { rows.push({ key: null, status: "invalid", error: bad }); continue; }
    if (!headOk(r)) { rows.push({ key: null, repo: r.repo, issue: r.issue, head: null, head_missing: true, status: "head_missing" }); continue; }
    const key = routeKey(r);
    const base = { key, repo: r.repo, issue: r.issue, head: r.head };
    if (posted.has(key)) { rows.push({ ...base, status: "already-posted" }); continue; }
    if (!apply) { rows.push({ ...base, status: "would-post" }); continue; }
    const g = spawn(ghBin, ["issue", "comment", String(r.issue), "-R", r.repo, "--body", r.body], { encoding: "utf8" });
    if (g.error || g.status !== 0) {
      rows.push({ ...base, status: "failed", error: g.error ? g.error.message : (String(g.stderr ?? "").trim() || `gh exited ${g.status}`) });
      continue;
    }
    mkdirSync(path.dirname(ledgerPath(stateDir)), { recursive: true });
    appendFileSync(ledgerPath(stateDir), `${JSON.stringify({ key, ts: new Date(now()).toISOString(), repo: r.repo, issue: r.issue })}\n`);
    posted.add(key);
    rows.push({ ...base, status: "posted" });
  }
  const counts = {};
  for (const x of rows) counts[x.status] = (counts[x.status] ?? 0) + 1;
  return { rows, counts };
}
