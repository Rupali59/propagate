/**
 * identity-map.mjs — the provisional UUID <-> PR-0NN identity map (spec's
 * "Shape", `docs/plans/2026-09-23-reminders-todo-bridge.md:271-273`). One
 * JSON file, behind one reader, deliberately NOT a permanent schema: PR-003
 * is the open question of whether propagation state wants one, and building
 * a permanent shape here would be answering that question sideways.
 *
 * WRITES NOTHING BY ITSELF, except `saveIdentityMap` — the one function an
 * `--apply` gate must guard. Everything else here is pure: `assignId` and
 * `recordObservation` return a NEW map object and never touch disk, so a
 * caller can compute the full dry-run preview (including which PR-0NN ids
 * WOULD be minted) without writing anything. That is what makes F2's
 * dry-run-by-default guarantee possible one layer up, in reconcile.mjs.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../core/config.mjs";

/** @param {string} [stateDir] */
export function identityMapPath(stateDir = STATE_DIR) {
  return path.join(stateDir, "reminders", "identity-map.json");
}

/**
 * @param {string} [stateDir]
 * @returns {Promise<{version: number, nextSeq: number, entries: Record<string, {id: string, firstSeen: string, lastObserved: {completed: boolean, completedAt: string|null}|null}>}>}
 */
export async function loadIdentityMap(stateDir = STATE_DIR) {
  const p = identityMapPath(stateDir);
  if (!existsSync(p)) return { version: 1, nextSeq: 1, entries: {} };
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    throw new Error(`identity-map.json at ${p} could not be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A reader that cannot say "I did not understand this" invents an answer
    // (rule:discernment-checks §6) -- a damaged file throws rather than
    // silently returning an empty map, which would go on to re-mint every
    // id a second time and desynchronize from whatever already used the
    // first set.
    throw new Error(`identity-map.json at ${p} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object" || parsed.entries === null) {
    throw new Error(`identity-map.json at ${p} does not have the expected {version, nextSeq, entries} shape`);
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    nextSeq: typeof parsed.nextSeq === "number" ? parsed.nextSeq : 1,
    entries: parsed.entries,
  };
}

/**
 * Pure. Look up or mint a `PR-0NN` id for a reminder id. Never mutates the
 * input map; returns a new one. `minted` tells the caller whether this call
 * actually advanced the sequence, so a dry-run preview can say "would mint
 * PR-004" without it being ambiguous with "already PR-004".
 *
 * @param {ReturnType<typeof loadIdentityMap> extends Promise<infer T> ? T : never} map
 * @param {string} reminderId
 * @param {string} [now] ISO timestamp, injected so a test can pin it
 */
export function assignId(map, reminderId, now = new Date().toISOString()) {
  const existing = map.entries[reminderId];
  if (existing) return { map, id: existing.id, minted: false };
  const id = `PR-${String(map.nextSeq).padStart(3, "0")}`;
  const nextMap = {
    ...map,
    nextSeq: map.nextSeq + 1,
    entries: { ...map.entries, [reminderId]: { id, firstSeen: now, lastObserved: null } },
  };
  return { map: nextMap, id, minted: true };
}

/**
 * Pure. Record what was observed this run against an id that ALREADY has an
 * identity — call `assignId` first if it might be new. Never mutates the
 * input map.
 *
 * @param {*} map
 * @param {string} reminderId
 * @param {{completed: boolean, completedAt: string|null}} observation
 */
export function recordObservation(map, reminderId, observation) {
  const existing = map.entries[reminderId];
  if (!existing) {
    throw new Error(`recordObservation: ${reminderId} has no identity yet — call assignId first`);
  }
  return {
    ...map,
    entries: { ...map.entries, [reminderId]: { ...existing, lastObserved: observation } },
  };
}

/**
 * Pure. Mark an identity as having been INSERTED into a register —
 * `docs/plans/2026-09-23-reminders-todo-bridge.md` "Part 1 — the inserter",
 * "Idempotency is the load-bearing guarantee". Set ONLY inside the same
 * `saveIdentityMap` call that follows a successful register write (R3/D4:
 * register FIRST, then this), and checked before planning a new insert — an
 * entry that already carries `insertedAt` is `already-inserted`, reported
 * like `no-change`, never silently re-inserted and never silently dropped.
 *
 * Requires an existing identity, same discipline as `recordObservation` —
 * call `assignId` first. Never mutates the input map.
 *
 * @param {*} map
 * @param {string} reminderId
 * @param {{insertedAt: string, insertedInto: string}} insertion `insertedAt`
 *   is an ISO timestamp (when this tool wrote the line); `insertedInto` is
 *   the register file path.
 */
export function recordInsertion(map, reminderId, insertion) {
  const existing = map.entries[reminderId];
  if (!existing) {
    throw new Error(`recordInsertion: ${reminderId} has no identity yet — call assignId first`);
  }
  return {
    ...map,
    entries: {
      ...map.entries,
      [reminderId]: { ...existing, insertedAt: insertion.insertedAt, insertedInto: insertion.insertedInto },
    },
  };
}

/**
 * The one function in this module that writes. Atomic write (temp + rename),
 * same shape as lib/core/plist.mjs's regeneratePlist -- never leaves a
 * partial file on disk if the process dies mid-write.
 *
 * @param {*} map
 * @param {string} [stateDir]
 */
export async function saveIdentityMap(map, stateDir = STATE_DIR) {
  const p = identityMapPath(stateDir);
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  await rename(tmp, p);
  return { ok: true, path: p };
}
