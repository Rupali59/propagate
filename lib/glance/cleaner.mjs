/**
 * lib/glance/cleaner.mjs — the glance's cleaner row (propagate#446, contract C3). Reads ONE file the cleaner wrote,
 * `<cleanerDir>/logs/last-audit.json`, and never recomputes a number:
 *
 *   {schema_version: 1, now, free_kb, domains: {<domain>: {at, tier_a, tier_b, hold, awaiting_merge, stale_lock, ...}}}
 *
 * Each domain is dated by its OWN `at` (the top-level `now` is rewritten by whichever domain ran last), and a domain
 * older than 24 h is stale. THREE ABSENCES, THREE TEXTS, NONE OF THEM 0 (rule:discernment-checks §2):
 *   cleanerDir unset   -> skip, "cleaner not configured"
 *   file missing       -> "cleaner never run"
 *   a null count       -> "not built" (the cleaner has not built that count yet)
 * Pure but for fs: no child_process, no config import (tests/unit/glance.test.mjs T-V10).
 */
import { readFileSync, statfsSync } from "node:fs";
import path from "node:path";

export const AUDIT_STALE_MS = 24 * 3600000;
const AUDIT_FILE = path.join("logs", "last-audit.json");

const age = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 48 * 3600000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`);

/** A count: a number prints as itself, null as "not built", anything else as "invalid" (never 0). */
export function countText(v) {
  if (v === null || v === undefined) return "not built";
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? String(v) : "invalid";
}

const gib = (kb) => `${(kb / 1048576).toFixed(1)}G`;

/**
 * @param {{cleanerDir: string|null|undefined, now: number, statfs?: Function}} o
 * @returns {{skip: string} | {unknown: {what: string, cause: string}} | {working: {what: string, time: string}}}
 */
export function cleanerRow({ cleanerDir, now, statfs = statfsSync }) {
  if (typeof cleanerDir !== "string" || !cleanerDir.length) return { skip: "cleaner not configured: set PROPAGATE_CLEANER_DIR" };
  const file = path.join(cleanerDir, AUDIT_FILE);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { unknown: { what: "cleaner never run", cause: "the cleaner has written no last-audit.json yet" } };
    return { unknown: { what: `audit unreadable (${e.code ?? "error"})`, cause: `last-audit.json could not be read: ${e.message}` } };
  }
  let a;
  try {
    a = JSON.parse(text);
  } catch {
    return { unknown: { what: "audit is not valid JSON", cause: "last-audit.json did not parse" } };
  }
  if (!a || typeof a !== "object" || a.schema_version !== 1) return { unknown: { what: `audit schema ${JSON.stringify(a?.schema_version ?? null)} not understood`, cause: "propagate reads schema_version 1 only" } };
  const d = a.domains?.worktrees;
  if (!d || typeof d !== "object") return { unknown: { what: "no worktrees audit in last-audit.json", cause: "the cleaner has not audited worktrees" } };
  const at = Date.parse(d.at ?? "");
  if (Number.isNaN(at)) return { unknown: { what: "worktrees audit has no valid time", cause: "domains.worktrees.at is missing or not a date" } };
  const ageMs = now - at;
  if (ageMs > AUDIT_STALE_MS) return { unknown: { what: `worktrees audit stale (${age(ageMs)} old)`, cause: "the worktrees audit is older than 24 h" } };
  let free = null;
  if (typeof a.free_kb === "number" && Number.isFinite(a.free_kb) && a.free_kb >= 0) free = gib(a.free_kb);
  else {
    try { const s = statfs(cleanerDir); free = gib((Number(s.bavail) * Number(s.bsize)) / 1024); } catch { free = null; }
  }
  const what = `disk ${free ?? "unknown"} free · worktrees: awaiting-merge ${countText(d.awaiting_merge)} · Tier B ${countText(d.tier_b)} · stale-lock ${countText(d.stale_lock)} (audit ${age(Math.max(0, ageMs))})`;
  return { working: { what, time: age(Math.max(0, ageMs)) } };
}
