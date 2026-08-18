/**
 * monitor.mjs — proactive notification, without the baseline that damned v1.
 *
 * See ~/.claude/plans/okay-pln-these-out-zany-rain.md and the 2026-08-14
 * retirement entry in docs/DECISIONS.md.
 *
 * WHY THIS IS NOT THE RETIRED WATCHER. The v1 launchd watcher detected drift by
 * diffing against a remembered `state.json` mtime baseline. It had to *catch*
 * the change: miss the moment and the information was gone, and a corrupt
 * baseline did not lose drift, it **invented** it — one bad state file fired
 * ~120 spurious rows. Measured over its life: 4,420 runs, 4,384 no-ops (99.2%).
 *
 * This module detects nothing. `reconcile()` derives the answer from content in
 * ~790ms warm / **~5.1s cold under launchd** (measured 2026-08-17, first
 * production run: 724 edges, 5088ms — a bare launchd environment with no warm
 * filesystem cache costs 6.4x the interactive figure), so:
 *
 *   - a missed or coalesced trigger costs NOTHING; the next run derives the same
 *     answer. There is no moment to catch.
 *   - there is no baseline to corrupt, so no run can invent drift.
 *   - it writes no drift rows. Not to a ledger, not to the v2 event store —
 *     that store records decisions a HUMAN made, and a machine observation must
 *     never be indistinguishable from one.
 *
 * THE ONLY THING IT REMEMBERS is what it has already told you, keyed on the
 * CONTENT TRIPLE `(edge_id, source_content, downstream_content)` — the same
 * triple `knownGoodPairs()` uses in lib/events.mjs. That is the load-bearing
 * choice:
 *
 *   - mtime-keyed memory going wrong INVENTS drift (v1's failure).
 *   - content-keyed memory going wrong costs exactly one duplicate
 *     notification, because the key is derived from the bytes it describes.
 *
 * Delete `notified.jsonl` and the worst case is being told once more about
 * something that is genuinely still true. That is the entire blast radius.
 */

import { appendFile, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { STATE_DIR } from "./config.mjs";
import { isActionable } from "./graph.mjs";

/**
 * Same fallback as lib/events.mjs: `~/.propagate`, deliberately NOT the plugin
 * directory, because a marketplace update destroys that (N13/N14) and this is
 * state that should survive one — losing it is harmless but re-notifying every
 * open finding after every update is noise.
 */
const ROOT = STATE_DIR || path.join(os.homedir(), ".propagate");

export const NOTIFIED_PATH = process.env.PROPAGATE_NOTIFIED || path.join(ROOT, "notified.jsonl");
export const MONITOR_LOG = process.env.PROPAGATE_MONITOR_LOG || path.join(ROOT, "monitor.log");

/**
 * Bound on retained notification records. This file is append-only and read on
 * every run; unbounded growth is the failure GOTCHAS G3 names (an ever-growing
 * store nobody reads). Trimming only ever costs a duplicate notification for a
 * finding older than the cap, which is the same cost as deleting the file.
 */
export const NOTIFIED_CAP = 5000;

// ---------------------------------------------------------------------------
// the key
// ---------------------------------------------------------------------------

/**
 * The content triple. `null` content is preserved rather than coerced — an
 * UNMATCHED glob has no downstream bytes, and `edge|sha|null` is a perfectly
 * stable identity for "this generator still matches nothing".
 *
 * @param {{edge_id: string, source: {contentId: string|null}, downstream: {contentId: string|null}}} row
 */
export function notifyKey(row) {
  const s = row?.source?.contentId ?? "null";
  const d = row?.downstream?.contentId ?? "null";
  return `${row?.edge_id}|${s}|${d}`;
}

// ---------------------------------------------------------------------------
// selection — PURE, so the whole decision is testable without launchd or disk
// ---------------------------------------------------------------------------

/**
 * Split reconcile's rows into what to tell the human about and what to hold.
 *
 * `isActionable` comes from lib/graph.mjs so the monitor, `graph`'s worklist and
 * `drain`'s hint can never disagree about what counts as work — two commands
 * reporting different totals for "what needs doing" is worse than either being
 * slightly wrong, and that already happened once (23 vs 21).
 *
 * @param {Array} rows - reconcile() output
 * @param {Set<string>} alreadyNotified - keys from readNotified()
 * @returns {{toNotify: Array, suppressed: Array, actionable: Array}}
 */
export function selectToNotify(rows, alreadyNotified = new Set()) {
  const actionable = rows.filter((r) => isActionable(r.state));
  const toNotify = [];
  const suppressed = [];
  for (const r of actionable) {
    if (alreadyNotified.has(notifyKey(r))) suppressed.push(r);
    else toNotify.push(r);
  }
  return { toNotify, suppressed, actionable };
}

/**
 * The notification body. Names edges, not just a count — "3 edges need
 * attention" sends nobody anywhere, and a count is the least actionable thing a
 * notification can carry.
 *
 * @param {Array} toNotify
 * @param {{root?: string}} [opts]
 */
export function formatNotification(toNotify, opts = {}) {
  const root = opts.root ? (opts.root.endsWith("/") ? opts.root : opts.root + "/") : "";
  const rel = (p) => (root && p && p.startsWith(root) ? p.slice(root.length) : p || "(glob)");
  const shown = toNotify.slice(0, 3);
  const lines = shown.map((r) => `${r.state} ${path.basename(rel(r.source.path))} → ${path.basename(rel(r.downstream.path) || "glob")}`);
  if (toNotify.length > shown.length) lines.push(`+${toNotify.length - shown.length} more`);
  const title = toNotify.length === 1 ? "propagate: 1 edge needs attention" : `propagate: ${toNotify.length} edges need attention`;
  return { title, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// persistence — the only mutable thing, and it is not an input to detection
// ---------------------------------------------------------------------------

/** Keys already notified. A missing or corrupt file yields an EMPTY set — the
 *  fail-open direction is "tell them again", never "stay quiet". */
export async function readNotified(file = NOTIFIED_PATH) {
  if (!existsSync(file)) return new Set();
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return new Set();
  }
  const keys = new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.key) keys.add(r.key);
    } catch {
      // A malformed line means one duplicate notification, not a crash and not
      // silence. Deliberately not counted: unlike the event store, nothing here
      // is authoritative about the world.
    }
  }
  return keys;
}

/** Record what we just told them. Trimmed to NOTIFIED_CAP, oldest first. */
export async function recordNotified(rows, file = NOTIFIED_PATH, now = new Date()) {
  if (rows.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  const ts = now.toISOString();
  const lines = rows.map((r) =>
    JSON.stringify({ key: notifyKey(r), edge_id: r.edge_id, state: r.state, ts }),
  );
  await appendFile(file, lines.join("\n") + "\n");

  try {
    const all = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    if (all.length > NOTIFIED_CAP) {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, all.slice(-NOTIFIED_CAP).join("\n") + "\n");
      await rename(tmp, file);
    }
  } catch {
    /* trimming is housekeeping; failing to trim must never fail the run */
  }
}

/**
 * One telemetry line per invocation, ALWAYS — including runs that notify
 * nothing.
 *
 * This is what makes the three states distinguishable: never ran (no file),
 * ran and found nothing (`notified=0`), ran and told you (`notified>0`).
 * Without it a monitor that died silently looks exactly like a quiet week —
 * `rule:discernment-checks` §2, and the same absence that let a zombie
 * LaunchAgent write 37 MB of stderr for six weeks before anyone noticed.
 */
export async function logRun(stats, file = MONITOR_LOG, now = new Date()) {
  const line =
    `${now.toISOString()} ran=1 rows=${stats.rows} actionable=${stats.actionable} ` +
    `notified=${stats.notified} suppressed=${stats.suppressed} ms=${stats.ms}` +
    (stats.error ? ` error=${JSON.stringify(stats.error)}` : "");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, line + "\n");
  } catch {
    /* logging must never be why the monitor fails */
  }
  return line;
}
