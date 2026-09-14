/**
 * lib/claims/runs.mjs — the answering-RUN log: a record that an attempt to
 * judge a file happened, separate from any verdict it produced.
 *
 * WHY THIS IS NOT A CLAIM. `store.mjs`'s own header explains why a claim
 * verdict is not an event: "a claim has ONE subject and ONE hash. Supplying a
 * second, invented hash would put a fabricated pair inside a store whose
 * stated premise is X." The same argument applies one level up: a run record
 * has no `block_sha` at all — it is not a judgment about a piece of text, it
 * is a fact about an ATTEMPT ("something tried to answer this file, and here
 * is how it went"). Coercing it into `validateClaim`'s shape would mean
 * inventing a `block_sha` and a `kind` for a record that has neither, which is
 * exactly the fabrication `store.mjs` already refused once. So: a third,
 * separate append-only store, following the template `contradict.mjs` set —
 * one file, one subject, no schema forced to serve two purposes.
 *
 * WHY A START RECORD MATTERS (Reviewer Concern 2). Recording only an outcome
 * cannot distinguish "nobody ever tried" from "something tried and crashed
 * before it could say how it went" — both would read as zero end-records. A
 * caller writes `appendRunStart` before doing any work and `appendRunEnd`
 * when it finishes; `summarizeRunsForFile` reports a run with a start and no
 * matching end as `crashed`, a state distinguishable from `never` (no run
 * recorded at all) and from `completed` (a real outcome). This does not make
 * a crash impossible to miss — a caller that crashes before even the START
 * write is still invisible — it only shrinks the invisible window to "before
 * the very first write", which is the best this store can do without probing
 * anything (Premise 1: propagate never calls out to check).
 *
 * IDENTITY. `run_id` is a ULID from the same minter `store.mjs` uses
 * (`mintEventId`) — one id scheme in this repo, not two. A start and its end
 * are two distinct lines correlated by `run_id`, exactly as an append-only
 * log requires: neither record is ever edited in place.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide whether a run's outcome
 * means a block is judged, unjudged, or unanswerable — that reclassification
 * is `judge.mjs`'s job, using `summarizeRunsForFile`'s output as one more
 * input alongside the verdict store. This module only records and folds runs.
 */
import { existsSync } from "node:fs";
import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { CLAIMS_DIR, canonicalFile } from "./store.mjs";
import { mintEventId } from "../edges/events.mjs";
import { acquireLock } from "../core/lock.mjs";

/** Nested under the claims store's own directory — same install, sibling subject. */
export const RUNS_DIR = path.join(CLAIMS_DIR, "runs");

/**
 * The only outcomes an answering run can report. Closed and validated, same
 * posture as `CLAIM_KINDS` — a caller does not get to invent a fourth.
 */
export const RUN_OUTCOMES = Object.freeze(["ok", "no-brain", "error"]);
const OUTCOME_SET = new Set(RUN_OUTCOMES);

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/; // same alphabet mintEventId() produces

/** Reject before the lock, before disk — same posture as `validateClaim`. */
export function validateRunRecord(rec, at = "(unminted)") {
  const tag = `run ${at}`;
  if (!rec || typeof rec !== "object") throw new Error(`${tag}: not an object`);
  if (!rec.file) throw new Error(`${tag}: missing "file" — a run must name the document it was answering`);
  if (!ULID_RE.test(String(rec.run_id ?? ""))) {
    throw new Error(`${tag}: "run_id" must be a ULID (mint with the same minter as claim ids)`);
  }
  if (rec.phase !== "start" && rec.phase !== "end") {
    throw new Error(`${tag}: "phase" must be "start" or "end", got ${JSON.stringify(rec.phase)}`);
  }
  if (rec.phase === "start") {
    if (rec.outcome !== undefined && rec.outcome !== null) {
      throw new Error(`${tag}: a "start" record must not carry an "outcome" — that belongs on the "end" record`);
    }
  } else {
    if (!OUTCOME_SET.has(rec.outcome)) {
      throw new Error(`${tag}: "end" record needs "outcome", one of: ${RUN_OUTCOMES.join(", ")}`);
    }
    if ((rec.outcome === "no-brain" || rec.outcome === "error") && !rec.reason) {
      throw new Error(`${tag}: outcome "${rec.outcome}" requires a "reason" — say what could not be answered and why`);
    }
  }
  return true;
}

/** Dry validation for a preview path: the message, or null. Mirrors `dryValidateClaim`. */
export function dryValidateRunRecord(rec) {
  try { validateRunRecord(rec); return null; } catch (err) { return err.message; }
}

function shardFileForTs(ts) {
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  return `${iso.slice(0, 7)}.jsonl`;
}

export function runShardPathForTs(ts) {
  return path.join(RUNS_DIR, shardFileForTs(ts));
}

async function appendRunRecord(rec, opts) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ts = now.toISOString();
  const stamped = { ...rec, file: canonicalFile(rec.file), ts };
  validateRunRecord(stamped, stamped.run_id);

  const shardPath = runShardPathForTs(ts);
  await mkdir(RUNS_DIR, { recursive: true });
  if (!existsSync(shardPath)) await appendFile(shardPath, "");

  const release = await acquireLock(shardPath, { retries: 50, minDelayMs: 20, maxDelayMs: 200 });
  if (!release) throw new Error(`appendRunRecord: could not acquire lock on ${shardPath} after retries`);
  try {
    await appendFile(shardPath, JSON.stringify(stamped) + "\n");
  } finally {
    await release();
  }
  return stamped;
}

/**
 * Write a START record. Call this BEFORE doing any answering work, so a crash
 * mid-run leaves a trace (Reviewer Concern 2). Returns the minted `run_id` —
 * the caller must pass it to `appendRunEnd`.
 *
 * @param {string} file
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{run_id: string, record: object}>}
 */
export async function appendRunStart(file, opts = {}) {
  const run_id = mintEventId();
  const record = await appendRunRecord({ file, run_id, phase: "start" }, opts);
  return { run_id, record };
}

/**
 * Write an END record for a run already started.
 *
 * @param {string} file
 * @param {string} run_id from `appendRunStart`
 * @param {"ok"|"no-brain"|"error"} outcome
 * @param {{reason?: string, now?: Date}} [opts]
 */
export async function appendRunEnd(file, run_id, outcome, opts = {}) {
  const { reason, ...rest } = opts;
  return appendRunRecord({ file, run_id, phase: "end", outcome, reason }, rest);
}

/**
 * Read run records across all shards. Never throws for an absent store — "no
 * run has ever been recorded" is the fresh-machine state, mirrored from
 * `readClaims`.
 *
 * @param {{file?: string}} [filter]
 */
export async function readRuns(filter = {}) {
  const runs = [];
  let malformed = 0;
  if (!existsSync(RUNS_DIR)) return { runs, malformed, storeExists: false };

  const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    let raw;
    try { raw = await readFile(path.join(RUNS_DIR, file), "utf8"); } catch { malformed++; continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { malformed++; continue; }
      if (filter.file && rec.file !== canonicalFile(filter.file)) continue;
      runs.push(rec);
    }
  }
  return { runs, malformed, storeExists: true };
}

/**
 * Fold run records for ONE file into the shape `judge.mjs` needs: how many
 * distinct attempts were recorded, and what the most recent one resolved to.
 *
 * THREE STATUSES, NEVER COLLAPSED (`rule:discernment-checks` §2):
 *   `never`     — no run record exists for this file at all
 *   `crashed`   — the most recently STARTED run has no matching end record
 *   `completed` — the most recently STARTED run has an end record; `outcome`
 *                 carries its value
 *
 * "Most recently started" (not "most recently touched") is deliberate: a run
 * is one attempt, identified by its start. Ranking by the end record's own
 * timestamp would let a slow, still-open run mask a newer crash.
 *
 * @param {Array<object>} runs from `readRuns` — ALREADY FILTERED to one file,
 *   or containing records for other files too (this function ignores `file`
 *   and expects the caller to have scoped it; it does not re-filter, so a
 *   caller with a global `runs` array must slice it first).
 */
export function summarizeRunsForFile(runs) {
  const byId = new Map();
  for (const r of runs) {
    if (!byId.has(r.run_id)) byId.set(r.run_id, { start: null, end: null });
    const entry = byId.get(r.run_id);
    if (r.phase === "start") entry.start = r;
    else if (r.phase === "end") entry.end = r;
  }

  const count = byId.size;
  if (count === 0) return { count: 0, status: "never", outcome: null, runId: null };

  // Latest attempt = the one with the latest start ts. A run missing its start
  // (an end record with no matching start — possible only if a shard was
  // pruned or hand-edited) is ordered last so it cannot masquerade as current.
  let latestId = null;
  let latestTs = null;
  for (const [id, entry] of byId) {
    const ts = entry.start?.ts ?? "";
    if (latestTs === null || ts > latestTs) { latestTs = ts; latestId = id; }
  }
  const latest = byId.get(latestId);

  if (!latest.end) return { count, status: "crashed", outcome: null, runId: latestId };
  return { count, status: "completed", outcome: latest.end.outcome, runId: latestId };
}
