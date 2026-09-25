/**
 * snapshot.mjs — doctor's answer, cached, because deriving it costs 37 seconds.
 *
 * WHY A CACHE AT ALL, GIVEN `rule:delegation-criteria` §2. That rule kills
 * background components that could be derived on demand, and it is right: it
 * records a 60-second watcher that ran 4,420 times and found nothing in 4,384 of
 * them. The exemption here is earned by measurement, not asserted —
 * `doctor` takes **36,926 ms**, which genuinely breaks a glance surface, while
 * `queue --json` takes 239 ms and stays live.
 *
 * And the answer is NOT a new scheduled thing. The monitor already runs every
 * 1800 s and is already registered in `docs/SYSTEMS.md`; this rides on it. The
 * precedent is in this tree: `claude-usage-widget` pairs a slow sampler with a
 * `collect.sh` that only reads the file (0.17 s).
 *
 * ── THE FAILURE MODE THIS FILE EXISTS TO PREVENT ───────────────────────────
 *
 * A snapshot that fails and leaves the previous file in place is the worst of
 * the three options: the reader sees plausible numbers and no reason to doubt
 * them. Deleting it is better but loses the last good answer. So a failed run
 * writes an error object that CARRIES the previous payload's timestamp, letting
 * a reader say "last good 4h ago, and the latest attempt failed because X" —
 * which is the only one of the three that is both honest and useful
 * (`rule:discernment-checks` §2: absence must be attributable).
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "../../core/config.mjs";
import { stateDir } from "../../core/paths.mjs";

/** Same root as the event store and `notified.jsonl`, and deliberately NOT the
 *  plugin directory — a marketplace update destroys that (N13/N14). */
const ROOT = STATE_DIR || stateDir();

export const SNAPSHOT_PATH = process.env.PROPAGATE_DOCTOR_SNAPSHOT || path.join(ROOT, "doctor-snapshot.json");

/**
 * Read the snapshot.
 *
 * Every failure is NAMED rather than collapsing to a null: "no snapshot yet",
 * "unreadable", and "doctor failed on its last run" are three different facts
 * and only one of them means the reader should go set something up.
 *
 * @returns {Promise<{ok: boolean, reason?: string, payload?: object, ageMs?: number|null}>}
 */
export async function readSnapshot(file = SNAPSHOT_PATH) {
  if (!existsSync(file)) return { ok: false, reason: "no snapshot yet — the monitor has not run since this was added" };
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    return { ok: false, reason: `snapshot unreadable — ${err.message}` };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A corrupt snapshot must never read as "no problems". Say what it is.
    return { ok: false, reason: "snapshot is not valid JSON — a write was interrupted or the file was edited" };
  }
  const stamp = payload?.generatedAt ?? payload?.lastGoodAt ?? null;
  const ageMs = stamp ? Date.now() - Date.parse(stamp) : null;
  if (payload?.error) {
    return { ok: false, reason: `doctor failed on its last run — ${payload.error}`, payload, ageMs };
  }
  return { ok: true, payload, ageMs };
}

/**
 * Run doctor and persist the structured result.
 *
 * `runDoctor` is injected so a test never pays doctor's 37 seconds, and so the
 * failure path can be exercised at all — a snapshot writer whose error branch is
 * unreachable in tests is a branch nobody has ever seen run.
 *
 * Written via a temp file + rename so a reader can never observe a half-written
 * snapshot; the read path would report "not valid JSON" rather than lying, but a
 * torn file is still a needless way to get there.
 *
 * @param {{runDoctor: () => Promise<object>, file?: string}} opts
 */
export async function writeSnapshot({ runDoctor, file = SNAPSHOT_PATH }) {
  const prev = await readSnapshot(file);
  const lastGoodAt = prev.ok ? prev.payload?.generatedAt ?? null : prev.payload?.lastGoodAt ?? null;

  let payload;
  try {
    const result = await runDoctor();
    payload = { ...result, generatedAt: result?.generatedAt ?? new Date().toISOString() };
  } catch (err) {
    // Carry the previous good timestamp forward so the reader can distinguish
    // "never worked" from "worked at 04:00 and has failed since".
    payload = {
      error: String(err?.message ?? err),
      generatedAt: new Date().toISOString(),
      lastGoodAt,
      sections: null,
      totals: null,
      problems: null,
    };
  }

  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(payload));
  await rename(tmp, file);
  return payload;
}
