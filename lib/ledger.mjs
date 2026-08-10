/**
 * Ledger store: append-only JSONL of propagation events, with a rendered
 * Markdown view alongside.
 *
 * - JSONL is the authoritative store. Every event = one line. Status
 *   updates are appended as separate `status_change` records, never
 *   in-place edits.
 * - Markdown is regenerated on every write from the JSONL. Includes the
 *   "last entry N days ago" tripwire header.
 */

import { appendFile, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

import { acquireLock } from "./lock.mjs";

/**
 * @typedef {Object} WorktreeStamp
 * @property {string|null} branch - simplified branch name, or null when detached
 * @property {string} commit - short SHA (12 chars by convention)
 */

/**
 * @typedef {Object} DownstreamEntry
 * @property {string} path - absolute or repo-relative path to the downstream
 * @property {string} why - one-line reason; usually a section anchor
 * @property {string} kind - "prose" | "code"
 * @property {WorktreeStamp} [worktree] - only set for secondary worktrees;
 *   absent means the canonical worktree (or no worktree context — e.g.
 *   workspace docs). Drain consumers should treat absence as canonical.
 */

/**
 * @typedef {Object} LedgerRow
 * @property {string} type - "drift" | "status_change" | "code_drift" | "wontfix-bulk"
 * @property {string} id - stable row id (e.g. "001")
 * @property {string} timestamp - ISO 8601
 * @property {string} [source] - relative path that changed
 * @property {string} [change] - one-line summary
 * @property {DownstreamEntry[]} [downstream]
 * @property {"open"|"partial"|"done"|"wontfix"} [status]
 * @property {string} [notes]
 * @property {boolean} [pending_graph_augment] - V2 flag
 *
 * @property {WorktreeStamp} [source_worktree] - only set when the SOURCE of
 *   the drift came from a secondary worktree (not canonical). Lets drain
 *   report "edited on branch X". Absent for canonical-source rows.
 *
 * @property {string} [correlation_id] - logical-file identity across
 *   worktrees, format `<repo-basename>:<repo-relative-path>` (e.g.
 *   "VipinKaushik:lib/pricing.ts"). Multiple rows sharing this id are
 *   the same logical change observed in different worktrees. Drain
 *   groups by this key so the user verifies a logical change once,
 *   not per-worktree. Absent for rows outside any tracked repo
 *   (workspace docs, orphan files).
 */

/**
 * Append a new drift event row.
 * @param {string} jsonlPath
 * @param {Omit<LedgerRow, "timestamp">} row
 */
export async function appendRow(jsonlPath, row) {
  const stamped = {
    ...row,
    timestamp: new Date().toISOString(),
  };
  // proper-lockfile lstat's the target before locking — file must exist.
  if (!existsSync(jsonlPath)) {
    await appendFile(jsonlPath, "");
  }
  const release = await acquireLock(jsonlPath, { retries: 8 });
  if (!release) {
    throw new Error(
      `propagate: could not acquire lock on ${jsonlPath} after retries; another writer is holding it`,
    );
  }
  try {
    await appendFile(jsonlPath, JSON.stringify(stamped) + "\n");
  } finally {
    await release();
  }
}

/**
 * Mark a row done. Appends a status_change record; does not mutate prior lines.
 * @param {string} jsonlPath
 * @param {string} rowId
 * @param {string} status
 * @param {string} [notes] - optional audit-trail note, written into the
 *   status_change record when provided. `readLedger` only copies `status`
 *   off a status_change row, so this field is inert for every existing
 *   reader — it persists on disk as history without changing any current
 *   consumer's output. Intended for future consumers: migration provenance,
 *   "defer with a note".
 */
export async function markStatus(jsonlPath, rowId, status, notes) {
  const row = {
    type: "status_change",
    id: rowId,
    status,
  };
  if (notes !== undefined) row.notes = notes;
  await appendRow(jsonlPath, row);
}

/**
 * Atomic id-mint + append. Acquires the ledger lock ONCE, computes the next id
 * from the on-disk file under the lock, appends the stamped row, returns the id.
 * Use for the cross-ledger, which has many writers per watcher fire (adv M3) —
 * the nextId()+appendRow() check-then-act race would otherwise collide ids.
 * @returns {Promise<string>} the minted id
 */
/**
 * Append-time dedup for mtime-driven drift noise: returns true if an OPEN drift
 * row already exists with the same source and the same downstream path-set.
 * Only drift rows count; status_change/cross rows are ignored. Lets the watcher
 * skip re-logging identical drift on every mtime bump (the 8-dup class) without
 * touching `correlation_id` (which the worktree-drain grouping owns).
 */
export async function hasOpenDuplicateDrift(jsonlPath, source, downstreamPaths) {
  if (!existsSync(jsonlPath)) return false;
  const rows = await readLedger(jsonlPath);
  const statusById = new Map();
  const driftById = new Map();
  for (const r of rows) {
    if (r.type === "drift") {
      statusById.set(r.id, r.status || "open");
      driftById.set(r.id, r);
    } else if (r.type === "status_change" && r.id) {
      statusById.set(r.id, r.status);
    }
  }
  const key = [...downstreamPaths].sort().join("|");
  for (const [id, r] of driftById) {
    if (statusById.get(id) !== "open") continue;
    if (r.source !== source) continue;
    const rk = (r.downstream || []).map((d) => d.path).sort().join("|");
    if (rk === key) return true;
  }
  return false;
}

export async function appendRowWithId(jsonlPath, rowWithoutId) {
  if (!existsSync(jsonlPath)) await writeFile(jsonlPath, "");
  // Multi-writer path: many cross-repo passes may contend for this one ledger.
  // Each hold is sub-ms (readLedger + appendFile on a small file), so retry hard
  // with tight backoff to drain a burst rather than exhausting the default budget.
  const release = await acquireLock(jsonlPath, { retries: 50, minDelayMs: 20, maxDelayMs: 200 });
  if (!release) throw new Error(`appendRowWithId: could not lock ${jsonlPath}`);
  try {
    const rows = await readLedger(jsonlPath);
    const maxId = rows.reduce((m, r) => Math.max(m, parseInt(r.id, 10) || 0), 0);
    const id = String(maxId + 1).padStart(3, "0");
    const stamped = { ...rowWithoutId, id, timestamp: new Date().toISOString() };
    await appendFile(jsonlPath, JSON.stringify(stamped) + "\n");
    return id;
  } finally {
    await release();
  }
}

/**
 * Read all rows from JSONL, reduce status_change records to current status,
 * and report parse/shape stats alongside. `readLedger` is implemented in
 * terms of this and still returns just the array, so its five existing call
 * sites are unaffected.
 * @param {string} jsonlPath
 * @returns {Promise<{rows: Array<LedgerRow & {status: string}>, malformed: number, unknownTypes: Record<string, number>}>}
 */
export async function readLedgerWithStats(jsonlPath) {
  if (!existsSync(jsonlPath)) return { rows: [], malformed: 0, unknownTypes: {} };
  const raw = await readFile(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const drifts = new Map(); // id -> row
  let malformed = 0;
  const unknownTypes = {};
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (row.type === "status_change") {
      const existing = drifts.get(row.id);
      if (existing) existing.status = row.status;
    } else if (row.type === "drift" || row.type === "code_drift") {
      drifts.set(row.id, {
        ...row,
        status: row.status || "open",
      });
    } else {
      const t = row.type === undefined ? "(missing)" : String(row.type);
      unknownTypes[t] = (unknownTypes[t] || 0) + 1;
    }
  }
  const rows = [...drifts.values()].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : 1,
  );
  return { rows, malformed, unknownTypes };
}

/**
 * Read all rows from JSONL, reduce status_change records to current status.
 * @param {string} jsonlPath
 * @returns {Promise<Array<LedgerRow & {status: string}>>}
 */
export async function readLedger(jsonlPath) {
  const { rows } = await readLedgerWithStats(jsonlPath);
  return rows;
}

/**
 * Timestamp of the last physical line in the ledger, regardless of record
 * type — bypasses `readLedger`'s reduction, which drops `status_change` rows
 * from its output AND sorts by drift timestamp, so
 * `rows[rows.length-1].timestamp` reflects the newest DRIFT, not the newest
 * EVENT. Walks backwards from the end so a trailing malformed/truncated line
 * doesn't blank out an otherwise-good result.
 * @param {string} jsonlPath
 * @returns {Promise<string|null>} ISO timestamp, or null if missing/empty/unparseable
 */
export async function lastActivityAt(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;
  const raw = await readFile(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row && typeof row.timestamp === "string") return row.timestamp;
  }
  return null;
}

/**
 * Next id (zero-padded 3 digits). Reads JSONL to find max existing.
 */
export async function nextId(jsonlPath) {
  const rows = await readLedger(jsonlPath);
  const max = rows.reduce((acc, r) => {
    const n = parseInt(r.id, 10);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return String(max + 1).padStart(3, "0");
}

/**
 * Render PROPAGATION_LEDGER.md from the JSONL. Overwrites the MD file.
 */
export async function renderMarkdown(jsonlPath, mdPath, opts = {}) {
  const rows = await readLedger(jsonlPath);
  const now = Date.now();
  const lastTs = rows.length
    ? new Date(rows[rows.length - 1].timestamp).getTime()
    : 0;
  const daysAgo =
    lastTs === 0
      ? null
      : Math.max(0, Math.floor((now - lastTs) / (1000 * 60 * 60 * 24)));
  const tripwire = daysAgo === null
    ? "**Last entry: never** — first write incoming. Run `/propagate status` if this persists."
    : daysAgo > 30
      ? `**⚠️ Last entry: ${daysAgo} days ago.** Watcher may be dead. Run \`/propagate doctor\`.`
      : daysAgo === 0
        ? "**Last entry: today.** Watcher healthy."
        : `**Last entry: ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago.** Watcher healthy.`;

  const lines = [
    "# Propagation Ledger",
    "",
    tripwire,
    "",
    "Append-only. Watcher writes drift rows; `/propagate drain` marks them done.",
    "JSONL store is authoritative — see `PROPAGATION_LEDGER.jsonl`. This file is rendered.",
    "",
    "| ID | Date | Source | Change | Downstream | Status |",
    "|----|------|--------|--------|------------|--------|",
  ];
  for (const r of rows) {
    const date = r.timestamp.slice(0, 10);
    const downstream = (r.downstream || [])
      .map((d) => `\`${d.path}\``)
      .join(", ") || "—";
    const source = r.source ? `\`${r.source}\`` : "—";
    const change = (r.change || "").replace(/\|/g, "\\|");
    const statusBadge =
      r.status === "done"
        ? "✓ done"
        : r.status === "wontfix"
          ? "wontfix"
          : r.status === "partial"
            ? "~ partial"
            : "open";
    lines.push(
      `| ${r.id} | ${date} | ${source} | ${change} | ${downstream} | ${statusBadge} |`,
    );
  }
  if (rows.length === 0) {
    lines.push("| — | — | — | _no drift events yet_ | — | — |");
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Idempotent write. The tripwire above is time-derived, so this file must be
  // re-rendered on every fire or a ledger that goes silent freezes its own
  // staleness banner at whatever it said the day it died — the alarm would only
  // be updatable by the thing it is meant to detect.
  //
  // But an unconditional write ticks mtime and re-triggers launchd via
  // WatchPaths (the B0 feedback loop). So: compare the rendered BODY, excluding
  // the generated-at footer, and write only when it actually changed. A silent
  // ledger then writes exactly once per day (when daysAgo increments) instead of
  // never or every fire.
  const body = lines.join("\n");
  let prevBody = null;
  try {
    prevBody = stripGeneratedFooter(await readFile(mdPath, "utf8"));
  } catch {
    prevBody = null; // missing file — fall through to write
  }
  if (prevBody !== null && prevBody === body) return false;

  await writeFile(
    mdPath,
    `${body}\nGenerated by propagate watcher at ${new Date().toISOString()}.\n`,
  );
  return true;
}

/**
 * Strip the trailing "Generated by propagate watcher at <ts>." line so two
 * renders of identical content compare equal despite differing timestamps.
 */
function stripGeneratedFooter(text) {
  return text
    .replace(/Generated by propagate watcher at [^\n]*\n?$/, "")
    .replace(/\n$/, "");
}
