/**
 * seen-edges.mjs — which (edge, content) pairs the reader has actually SEEN.
 *
 * WHY A SECOND FILE AND NOT THE CURSOR (D12, 2026-10-15). The stream cursor is
 * one timestamp: "everything before this moment was looked at". That cannot say
 * which of today's queue rows are new, because a row that re-drifted an hour ago
 * and one that has sat untouched for a month both predate the cursor... or both
 * postdate it, depending on when you last clicked. The "new" dot in Judge needs
 * a different identity: the CONTENT PAIR. An edge is new when its current
 * `edge_id|sourceContentId|downstreamContentId` triple (the key the monitor
 * already dedupes notifications on, `notifyKey`) is not in this set, so a
 * re-drift shows again and an unchanged row does not.
 *
 * The first design (E4: a `seenEdges` list advanced on open, riding the cursor)
 * was superseded because it contradicted PR-023 -- advance-on-view marks things
 * seen that nobody rendered -- and keyed on the edge, so a re-drift stayed
 * quiet. The client therefore POSTS the triples it actually rendered, on "Mark
 * seen" or on leaving Judge, never on opening it.
 *
 * SEPARATE FROM writeCursor'S FILE, deliberately: the two are written by
 * different clicks, so a shared file would make each erase the other (a
 * read-modify-write by one is a lost update for the other). The path is derived
 * from the cursor's own directory so both honour the same state-dir resolution.
 *
 * BOUNDED. A triple is ~90 bytes; the queue is hundreds of edges and each
 * re-drift mints a new triple, so an unbounded set grows for ever. Oldest are
 * dropped past MAX_TRIPLES, and a single POST is capped at MAX_POST. Dropping
 * the oldest can only make an old, long-quiet row read as "new" again, which is
 * the safe direction (an extra dot, never a missing one).
 */

import path from "node:path";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import { CURSOR_PATH } from "./stream.mjs";

export const SEEN_PATH = process.env.PROPAGATE_SEEN_EDGES || path.join(path.dirname(CURSOR_PATH), "seen-edges.json");

export const MAX_TRIPLES = 20000;
export const MAX_POST = 5000;
const MAX_PART = 600;

/** `edge_id|source|downstream` -- exactly three parts, none containing a pipe. */
export function validateTriples(triples) {
  if (!Array.isArray(triples)) return { ok: false, error: `"triples" must be an array, got ${typeof triples}` };
  if (triples.length === 0) return { ok: false, error: `"triples" is empty — nothing to mark seen` };
  if (triples.length > MAX_POST) return { ok: false, error: `"triples" holds ${triples.length}; at most ${MAX_POST} per request` };
  for (const t of triples) {
    if (typeof t !== "string") return { ok: false, error: `a triple must be a string, got ${JSON.stringify(t)}` };
    const parts = t.split("|");
    if (parts.length !== 3 || !parts[0] || parts.some((p) => p.length > MAX_PART)) {
      return { ok: false, error: `not an edge_id|source|downstream triple: ${JSON.stringify(t.slice(0, 120))}` };
    }
  }
  return { ok: true, triples: [...new Set(triples)] };
}

/**
 * Three outcomes kept distinguishable (rule:discernment-checks §2), like the
 * cursor: "missing" is a first look, "corrupt" is damage, and neither is
 * allowed to read as "everything is new" without saying so.
 */
export async function readSeen(file = SEEN_PATH) {
  if (!existsSync(file)) return { status: "missing", triples: [] };
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (err) { return { status: "corrupt", triples: [], error: `could not read seen-set: ${err.message}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { status: "corrupt", triples: [], error: `seen-set is not valid JSON: ${err.message}` }; }
  if (!Array.isArray(parsed?.triples) || !parsed.triples.every((t) => typeof t === "string")) {
    return { status: "corrupt", triples: [], error: `seen-set has no "triples" string array` };
  }
  return { status: "ok", triples: parsed.triples };
}

// Two POSTs in flight would both read the same file and the second rename would
// drop the first's additions. Serialise within this process.
let chain = Promise.resolve();

/** Merge `triples` into the set, atomically (temp + rename). Caller validates. */
export function addSeen(triples, file = SEEN_PATH) {
  const run = chain.then(async () => {
    const cur = await readSeen(file);
    const merged = [...cur.triples.filter((t) => !triples.includes(t)), ...triples];
    const kept = merged.length > MAX_TRIPLES ? merged.slice(merged.length - MAX_TRIPLES) : merged;
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify({ triples: kept }));
    await rename(tmp, file);
    return { added: triples.filter((t) => !cur.triples.includes(t)).length, total: kept.length, recovered: cur.status === "corrupt" ? cur.error : null };
  });
  chain = run.catch(() => {});
  return run;
}
