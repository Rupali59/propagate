/**
 * lib/glance/digest-run.mjs — the digest's run record (propagate#462). digest.mjs writes `{started, finished}` to
 * `<state>/digest-run.json` around every real run; the glance reads it and flags a run that began and never ended.
 *
 * Why: one unclicked notification held the digest for 9 days and nothing reported a digest that never finished.
 * THE DIGEST RUNS TWICE A DAY (09:00 and 21:00, lib/core/plist.mjs), so STUCK = started more than 2 x 12 h ago with
 * no finish at or after it. THREE STATES, NONE OF THEM 0 (rule:discernment-checks §2):
 *   no record        -> skip, "digest never ran" (not stuck: nothing started)
 *   unreadable       -> unknown
 *   started, no finish, older than 24 h -> broken, "digest stuck"
 * A run still inside the window is simply running. Pure but for fs: no config import (tests/unit/glance.test.mjs T-V10).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

export const DIGEST_INTERVAL_MS = 12 * 3600000;
export const DIGEST_STUCK_AFTER_MS = 2 * DIGEST_INTERVAL_MS;
export const RUN_FILE = "digest-run.json";

const age = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 48 * 3600000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`);

function put(dir, rec) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, RUN_FILE);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, file);
}

/** Record that a run began. Overwrites the previous record: the question is only about the latest run. */
export function recordDigestStart(dir, now = Date.now()) {
  put(dir, { started: new Date(now).toISOString(), finished: null, pid: process.pid });
}

/** Record that the run ended (clean or not); `ok` says which. A record from another run is never finished by this one. */
export function recordDigestFinish(dir, now = Date.now(), ok = true) {
  let rec;
  try { rec = JSON.parse(readFileSync(path.join(dir, RUN_FILE), "utf8")); } catch { rec = null; }
  if (!rec || rec.pid !== process.pid) return;
  put(dir, { ...rec, finished: new Date(now).toISOString(), ok });
}

/** @returns {{skip: string} | {unknown: {what: string, cause: string}} | {broken: {what: string, cause: string}} | {working: {what: string, time: string}}} */
export function digestRunRow({ dir, now }) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(path.join(dir, RUN_FILE), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { skip: "digest never ran" };
    return { unknown: { what: "digest run record unreadable", cause: `${RUN_FILE} could not be parsed` } };
  }
  const started = Date.parse(rec?.started);
  if (!Number.isFinite(started)) return { unknown: { what: "digest run record unreadable", cause: `${RUN_FILE} has no valid started time` } };
  const finished = rec.finished ? Date.parse(rec.finished) : NaN;
  if (Number.isFinite(finished) && finished >= started) return { working: { what: `digest finished ${age(now - finished)} ago`, time: age(now - finished) } };
  if (now - started > DIGEST_STUCK_AFTER_MS) return { broken: { what: `digest stuck: started ${age(now - started)} ago, never finished`, cause: "a digest run began more than 24 h ago and has no finish" } };
  return { working: { what: `digest running since ${age(now - started)} ago`, time: age(now - started) } };
}
