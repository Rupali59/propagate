/**
 * store.mjs — the `glance.json` contract (propagate#295, design §4). Imports node builtins and lib/core/paths.mjs only.
 *
 *   { schema_version: 1, generatedAt, stale_after_s, verdict, signals_checked, needs_you_ids, skipped, items }
 *
 * - Written ATOMICALLY: `<file>.<pid>.tmp` then rename, the pattern of lib/sessions/resolve.mjs writeCheckouts. Last
 *   writer wins; a reader never sees a half-written file.
 * - Additive changes only within a major. A reader meeting a newer `schema_version` REFUSES visibly
 *   ("glance format newer than this reader") rather than guessing at fields it does not know.
 * - The age is derived by every reader from `generatedAt`; it is never stored, because a stored age is wrong the
 *   moment after it is written. Past `stale_after_s` a reader demotes everything to `unknown (stale)`.
 *
 * READERS: hooks/session-guide.mjs carries a COPY of `readGlance` (readGlanceCopy), because a hook stays
 * dependency-free; tests/hooks/session-guide.test.mjs pins the two together on the valid, absent, malformed and newer
 * cases. Change one, change both.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { stateDir } from "../core/paths.mjs";

export const SCHEMA_VERSION = 1;
export const STALE_AFTER_S = 21600;
export const VERDICTS = Object.freeze(["working", "broken", "needs_you", "blind"]);
export const NEWER = "glance format newer than this reader";

export const glancePath = (dir = stateDir()) => path.join(dir, "glance.json");

/** null when absent; THROWS when unreadable, malformed, or of a newer major. */
export function readGlance(dir = stateDir()) {
  let text;
  try {
    text = readFileSync(glancePath(dir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const g = JSON.parse(text);
  if (!g || typeof g !== "object" || typeof g.schema_version !== "number") throw new Error("glance.json has no schema_version");
  if (g.schema_version > SCHEMA_VERSION) throw new Error(NEWER);
  if (typeof g.generatedAt !== "string" || Number.isNaN(Date.parse(g.generatedAt)) || !Array.isArray(g.items)) throw new Error("glance.json has no generatedAt / items");
  return g;
}

/**
 * The reader's view: which of the four states the file is in, plus the age. Never throws.
 * @returns {{state: "absent"|"unavailable"|"newer"|"ok", glance?: object, ageMs?: number, stale?: boolean, reason?: string}}
 */
export function readGlanceState(dir = stateDir(), now = Date.now()) {
  let g;
  try {
    g = readGlance(dir);
  } catch (e) {
    return e.message === NEWER ? { state: "newer", reason: NEWER } : { state: "unavailable", reason: e.message };
  }
  if (!g) return { state: "absent" };
  const ageMs = now - Date.parse(g.generatedAt);
  return { state: "ok", glance: g, ageMs, stale: ageMs > (g.stale_after_s ?? STALE_AFTER_S) * 1000 };
}

/** Atomic write. Throws on failure, leaving no temp file; the caller decides whether that matters. */
export function writeGlance(glance, dir = stateDir()) {
  const target = glancePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(glance, null, 2) + "\n");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}
