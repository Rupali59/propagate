/**
 * insert-log.mjs — the append-only record of every register insertion this
 * lane has performed. Same pattern as `reconcile-log.mjs`, deliberately not
 * added TO that file: this is a separate store (`insert-log.jsonl`,
 * `docs/plans/2026-09-23-reminders-todo-bridge.md`'s "Part 1 — the
 * inserter", "An append-only insert log") for a different fact — reconcile's
 * log records an OBSERVATION; this one records a WRITE, so a human can
 * reconstruct exactly what was inserted, where, and how to reverse it.
 *
 * "Anchor reversal by content, never by line number" (the plan, verbatim):
 * every row carries the anchor's FULL text at insert time, not its line
 * number — a line number drifts the moment anything lands above it,
 * including a second insert in the same run. A human undoing this by hand
 * greps for `insertedText`, not for a line.
 *
 * WITH NO HUMAN APPROVING BEFOREHAND (this lane runs unattended), the
 * guarantee this log gives is RECONSTRUCTABILITY, not approval — the same
 * shift `reconcile-log.mjs`'s own header names for that store.
 */
import { existsSync } from "node:fs";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../core/config.mjs";

/** @param {string} [stateDir] */
export function insertLogPath(stateDir = STATE_DIR) {
  return path.join(stateDir, "reminders", "insert-log.jsonl");
}

/**
 * Every parseable line. A malformed line is counted, never dropped silently
 * — `rule:discernment-checks` §2.
 *
 * @param {string} [stateDir]
 * @returns {Promise<{rows: object[], malformed: number}>}
 */
export async function readInsertLog(stateDir = STATE_DIR) {
  const p = insertLogPath(stateDir);
  if (!existsSync(p)) return { rows: [], malformed: 0 };
  const raw = await readFile(p, "utf8");
  const rows = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

/**
 * Append ONE insertion record. THE unsafe path this file exists to gate —
 * per R3/D4, called only AFTER the register write and the identity-map save
 * both succeeded, never before.
 *
 * @param {{
 *   ts: string, reminderId: string, prId: string, registerFile: string,
 *   anchorLine: number, anchorText: string, insertedText: string,
 * }} event
 * @param {string} [stateDir]
 */
export async function appendInsertLogEvent(event, stateDir = STATE_DIR) {
  const p = insertLogPath(stateDir);
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(event)}\n`, "utf8");
  return { ok: true, path: p };
}
