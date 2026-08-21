/**
 * lib/core/runs.mjs — an append-only record of "a reconcile ran".
 *
 * §3 of ~/.claude/plans/status-temporal-plum.md (lane W3), building on the
 * provenance wedge (D3/§2, lane W1) and the deferred two-tier design
 * (docs/deferred/2026-08-20-two-tier-ref-aware-ledger.md), which explicitly
 * names NO `last_reconciled_at` field or watermark concept — this store is
 * what makes "when was this last reconciled, and what did it find" answerable
 * at all, without touching that design's scope.
 *
 * `lib/edges/reconcile.mjs`'s own header states it is READ-ONLY ("THIS PHASE
 * IS READ-ONLY ... it writes nothing"). This module is deliberately NOT
 * imported by reconcile.mjs and does not touch it — the CALLER (cli.mjs's
 * `reconcile` command) appends one run record per invocation, after
 * reconcile() has already returned. Breaking that read-only contract was an
 * explicit hard constraint of this lane.
 *
 * Discipline is copied from lib/edges/events.mjs, the only other store in
 * this repo with the same shape of requirement (append-only, must survive a
 * marketplace update, must never let one bad line take down a read):
 *
 *   - $PROPAGATE_STATE_DIR/runs/<year>-<month>.jsonl, sharded by UTC month
 *     (same shardFileForTs scheme as events.mjs, independent store).
 *   - Append is lock-then-write via lib/core/lock.mjs's acquireLock, same
 *     high-retry-budget rationale as events.mjs (§ appendEvent) — many
 *     writers may contend for one shard in a burst.
 *   - A read that hits a line it cannot JSON.parse COUNTS it in `malformed`
 *     and continues; it never throws and never silently drops the row
 *     (GOTCHAS G1: a check that cannot fail is worse than no check).
 *   - Root default is $PROPAGATE_STATE_DIR, or ~/.propagate when unset —
 *     NOT SKILL_DIR, for the same reason events.mjs gives: a marketplace
 *     update destroys the plugin install directory, and this history must
 *     survive one.
 */

import { appendFile, readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { acquireLock } from "./lock.mjs";
import { STATE_DIR } from "./config.mjs";

const DEFAULT_RUNS_ROOT = path.join(os.homedir(), ".propagate");

/** $STATE_DIR/runs (or ~/.propagate/runs when PROPAGATE_STATE_DIR is unset). */
export const RUNS_DIR = path.join(STATE_DIR || DEFAULT_RUNS_ROOT, "runs");

/** Mint a run id. Not content-addressed (a run is an event, not a fact about
 *  content) — a random UUID is sufficient and needs no read of prior state,
 *  same reasoning as events.mjs's ULID choice (no read-then-mint race). */
export function mintRunId() {
  return crypto.randomUUID();
}

/** `2026-08.jsonl` for an ISO timestamp or Date — same sharding key as events.mjs. */
function shardFileForTs(ts) {
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  return `${iso.slice(0, 7)}.jsonl`;
}

/** Absolute shard path for an ISO timestamp or Date. */
export function shardPathForTs(ts) {
  return path.join(RUNS_DIR, shardFileForTs(ts));
}

/**
 * Validate one run record before it is written. Kept intentionally narrow —
 * this store answers "did a run happen, when, over what, with what result",
 * not "was the run correct", so there is no disposition-style vocabulary to
 * enforce the way events.mjs enforces DISPOSITIONS.
 */
function validateRun(run, runId) {
  if (!Array.isArray(run.roots)) {
    throw new Error(`appendRun: run ${runId} — "roots" must be an array (got ${JSON.stringify(run.roots)})`);
  }
  if (run.refs == null || typeof run.refs !== "object" || Array.isArray(run.refs)) {
    throw new Error(`appendRun: run ${runId} — "refs" must be an object keyed by repo root`);
  }
  if (run.edge_counts == null || typeof run.edge_counts !== "object" || Array.isArray(run.edge_counts)) {
    throw new Error(`appendRun: run ${runId} — "edge_counts" must be an object keyed by state`);
  }
}

/**
 * Append one reconcile-run record. Mints `run_id` and `ts` (ISO 8601, "now"
 * unless `opts.now` is supplied — same test-only hook as appendEvent, for
 * exercising month sharding deterministically).
 *
 * @param {object} run
 * @param {string[]} run.roots - the search roots this reconcile scanned.
 * @param {Object<string,string|null>} run.refs - resolved ref per repo root
 *   (see lib/edges/provenance.mjs's resolveObservedRef — the same three
 *   outcomes apply: a real ref, "working-tree", or null on genuine failure).
 * @param {Object<string,number>} run.edge_counts - edge count by STATE.
 * @param {number} [run.durationMs] - reconcile()'s own stats.durationMs,
 *   which callers currently drop on the floor (plan §3) — pass it through
 *   rather than re-timing.
 * @param {{now?: Date}} [opts]
 * @returns {Promise<object>} the stamped, written record
 */
export async function appendRun(run, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const runId = mintRunId();

  validateRun(run, runId);

  const ts = now.toISOString();
  const stamped = { ...run, run_id: runId, ts };

  const shardPath = shardPathForTs(ts);
  await mkdir(RUNS_DIR, { recursive: true });
  if (!existsSync(shardPath)) {
    await appendFile(shardPath, "");
  }
  const release = await acquireLock(shardPath, { retries: 50, minDelayMs: 20, maxDelayMs: 200 });
  if (!release) {
    throw new Error(`appendRun: could not acquire lock on ${shardPath} after retries`);
  }
  try {
    await appendFile(shardPath, JSON.stringify(stamped) + "\n");
  } finally {
    await release();
  }

  return stamped;
}

/**
 * Read run records across all shards. Corrupt/unparseable lines are COUNTED
 * in `malformed` and skipped — same discipline as readEvents.
 *
 * @param {{since?: string}} [filter] - `since`: ISO timestamp, keeps runs
 *   with `ts >= since` (safe as string comparison, both ISO 8601 UTC).
 * @returns {Promise<{runs: object[], malformed: number}>}
 */
export async function readRuns(filter = {}) {
  const { since } = filter;
  const runs = [];
  let malformed = 0;

  if (!existsSync(RUNS_DIR)) return { runs, malformed };

  const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith(".jsonl")).sort();

  for (const file of files) {
    const raw = await readFile(path.join(RUNS_DIR, file), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (since && !(typeof row.ts === "string" && row.ts >= since)) continue;
      runs.push(row);
    }
  }

  return { runs, malformed };
}
