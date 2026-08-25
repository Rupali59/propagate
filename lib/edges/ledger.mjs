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

import { appendFile, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { acquireLock } from "../core/lock.mjs";
import { loadGitBackfillSidecar } from "../core/git-context.mjs";

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
 * @property {string} type - "drift" | "status_change" | "code_drift" | "manual"
 *   | "wontfix-bulk". Note "manual" is terminal-only and never enters the
 *   drift fold (see readLedgerWithStats); "wontfix-bulk" is legacy.
 * @property {string} id - stable row id (e.g. "001")
 * @property {string} timestamp - ISO 8601. On an Event, when the drift FIRED.
 *   On a Transition, when it CLOSED — the fold carries this forward onto the
 *   folded Event as `closed_at`, distinctly named so it never shadows this
 *   field (see `closed_at` below).
 * @property {string} [source] - relative path that changed
 * @property {string} [change] - one-line summary
 * @property {DownstreamEntry[]} [downstream]
 * @property {"open"|"partial"|"done"|"wontfix"} [status]
 * @property {string} [notes] - free-text note. On a Transition, written by
 *   `markStatus`'s options object; on a `code_drift` Event, an upstream-note
 *   join. The fold (`readLedgerWithStats`) now carries the Transition-side
 *   value forward onto the folded Event (previously dropped — see
 *   `docs/DATA_MODEL.md` §4-§5). If a Transition also carries the legacy
 *   `note` (singular) field, the fold concatenates it into `notes` rather
 *   than dropping either.
 * @property {string} [note] - legacy singular alias for `notes`, hand-authored
 *   (556-row-adjacent vocabulary, no writer in this codebase). Present only
 *   on some Transition rows on disk; folded into `notes` on read, never
 *   written by `markStatus`.
 * @property {string} [wontfix_reason] - required on a Transition whose
 *   `status` is `"wontfix"` (enforced by `markStatus`). Carried forward onto
 *   the folded Event by the fold.
 * @property {"drain"|"commit-evidence"|"wontfix"} [closed_by] - required on a
 *   Transition whose `status` is terminal (`"done"` or `"wontfix"`), enforced
 *   by `markStatus`. Carried forward onto the folded Event by the fold.
 * @property {string} [closed_at] - fold-only field, never written directly:
 *   the *Transition's* `timestamp` (when the close happened), copied onto the
 *   folded Event by `readLedgerWithStats` so it never overwrites the Event's
 *   own `timestamp` (when the drift fired). Absent on rows with no
 *   Transition, or on raw unfolded rows read straight off disk.
 * @property {boolean} [pending_graph_augment] - V2 flag
 * @property {{sha: string, branch: string|null, dirty: boolean}} [git] -
 *   stamped at fire time by `watcher.mjs` via `lib/git-context.mjs`
 *   (`getGitContext`), on every new Event row. Absent on rows fired before
 *   stamping shipped, and absent whenever the source resolved outside any
 *   git repo. NEVER set from a reconstruction — see `git_reconstructed`.
 * @property {{sha: string, branch: string|null, reconstructed: true, method: string}} [git_reconstructed] -
 *   fold-only field, never written to disk: attached by `readLedgerWithStats`
 *   from the per-workspace `git-backfill.jsonl` sidecar
 *   (`lib/git-context.mjs`) when a row has no stamped `git`. Always carries
 *   `reconstructed: true` and a `method` string so it can never be mistaken
 *   for a stamped value. Only a proposal — never implies the row was
 *   answered or closed.
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
 * Every row this module writes declares its era.
 *
 * TWO LIVE WRITERS, not one: `appendRow` (which `markStatus` also routes
 * through) and `appendRowWithId`. Stamping only the obvious one is the exact
 * "one guarded path plus one unguarded path in the same command" shape
 * rule:safety-flag-needs-a-test was written for — all three of its recorded
 * instances had that shape.
 *
 * `migrate-ledger.mjs`'s `appendVerbatim` deliberately does NOT stamp: it
 * relocates existing rows and must copy them byte-for-byte, era included.
 *
 * Throws rather than silently overwriting when a caller supplies a different
 * schema — a caller trying to write v1 through the live path is a defect, and
 * quietly rewriting its row to `2` would relabel history instead of refusing it.
 */
function assertEraWritable(row, fn) {
  if (row && row.schema !== undefined && row.schema !== LEDGER_SCHEMA) {
    throw new Error(
      `${fn}: refusing to write a row declaring schema ${JSON.stringify(row.schema)}; ` +
        `the live ledger only accepts schema ${LEDGER_SCHEMA}. Frozen v1 rows belong in archive/.`,
    );
  }
  return row;
}

/**
 * Append a new drift event row.
 * @param {string} jsonlPath
 * @param {Omit<LedgerRow, "timestamp">} row
 */
export async function appendRow(jsonlPath, row) {
  const stamped = {
    ...assertEraWritable(row, "appendRow"),
    schema: LEDGER_SCHEMA,
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

const TERMINAL_STATUSES = new Set(["done", "wontfix"]);
const VALID_CLOSED_BY = new Set(["drain", "commit-evidence", "wontfix"]);

/**
 * Mark a row done. Appends a status_change record; does not mutate prior lines.
 *
 * SPEC §5 close-path rules, enforced here (not just documented):
 * - `status === "wontfix"` REQUIRES `wontfix_reason`.
 * - Every terminal close (`"done"` or `"wontfix"`) REQUIRES `closed_by`, one
 *   of `"drain" | "commit-evidence" | "wontfix"`.
 * - `"partial"` and `"open"` require neither.
 *
 * @param {string} jsonlPath
 * @param {string} rowId
 * @param {string} status
 * @param {string|{notes?: string, closed_by?: "drain"|"commit-evidence"|"wontfix", wontfix_reason?: string}} [opts]
 *   Legacy form: a bare string is treated as `notes` (kept working for
 *   existing callers). Preferred form: an options object. Detected via
 *   `typeof opts === "string"` vs `typeof opts === "object"`.
 *   The fold (`readLedgerWithStats`) now carries `notes`, `closed_by`, and
 *   `wontfix_reason` forward onto the folded Event — previously only
 *   `status` crossed the fold (see `docs/DATA_MODEL.md` §4-§6).
 *
 * N4 (SPEC I1): a `status_change` naming an id with no matching Event used to
 * be appended happily and then silently discarded by the fold (`readLedgerWithStats`'s
 * `if (existing)` with no `else`). That is the writer succeeding at nothing —
 * throw here instead, at write time, so the caller finds out immediately.
 * `cli drain`'s `drainClose` already pre-checks ids against open rows before
 * calling this, so in the normal drain path this throw is a backstop against
 * a race (row closed between pre-check and write) rather than the primary
 * guard; callers outside drain get no pre-check at all, which is exactly why
 * this needs to live here, not only at the CLI layer.
 */
export async function markStatus(jsonlPath, rowId, status, opts) {
  let notes;
  let closed_by;
  let wontfix_reason;
  if (typeof opts === "string") {
    notes = opts;
  } else if (opts && typeof opts === "object") {
    ({ notes, closed_by, wontfix_reason } = opts);
  }

  const existingRows = await readLedger(jsonlPath);
  if (!existingRows.some((r) => r.id === rowId)) {
    throw new Error(
      `markStatus: no Event with id "${rowId}" in ledger ${jsonlPath} — refusing to append a ` +
        `status_change the fold would silently discard (SPEC I1). Check the id and the ledger ` +
        `path: writing to the wrong ledger is this system's most common failure.`,
    );
  }

  if (status === "wontfix" && !wontfix_reason) {
    throw new Error(
      `markStatus: row ${rowId} — status "wontfix" requires wontfix_reason (SPEC §5)`,
    );
  }
  if (TERMINAL_STATUSES.has(status)) {
    if (!closed_by) {
      throw new Error(
        `markStatus: row ${rowId} — terminal status "${status}" requires closed_by (one of ${[...VALID_CLOSED_BY].join(" | ")})`,
      );
    }
    if (!VALID_CLOSED_BY.has(closed_by)) {
      throw new Error(
        `markStatus: row ${rowId} — closed_by "${closed_by}" is not valid; must be one of ${[...VALID_CLOSED_BY].join(" | ")}`,
      );
    }
  }

  const row = {
    type: "status_change",
    id: rowId,
    status,
  };
  if (notes !== undefined) row.notes = notes;
  if (closed_by !== undefined) row.closed_by = closed_by;
  if (wontfix_reason !== undefined) row.wontfix_reason = wontfix_reason;
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
    const stamped = {
      ...assertEraWritable(rowWithoutId, "appendRowWithId"),
      schema: LEDGER_SCHEMA,
      id,
      timestamp: new Date().toISOString(),
    };
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
 * @returns {Promise<{rows: Array<LedgerRow & {status: string}>, malformed: number, unknownTypes: Record<string, number>, manual: LedgerRow[]}>}
 */
export async function readLedgerWithStats(jsonlPath) {
  // THE SINGLE CHOKE POINT for a null path, and it is here on purpose.
  // `CROSS_LEDGER_JSONL` is derived from the hub, so it is null when no hub is
  // declared. Six call sites in cli.mjs reach a ledger read with that value;
  // review 2026-08-23 found two of them guarded and four not, because the fix
  // had been applied to the sites where a crash was OBSERVED rather than to the
  // class. Guarding here means the next call site added cannot reintroduce it.
  //
  // `existsSync(null)` does not throw today — it emits DEP0187 and is slated to
  // throw outright in a later Node release, so this is a latent break, not a
  // style point.
  //
  // `reason` keeps "no ledger configured" distinguishable from "ledger is
  // empty" (rule:discernment-checks §2). Both yield zero rows; only one is a
  // fact about the data.
  if (jsonlPath === null || jsonlPath === undefined) {
    return { rows: [], malformed: 0, unknownTypes: {}, manual: [], reason: "unconfigured" };
  }
  if (!existsSync(jsonlPath)) return { rows: [], malformed: 0, unknownTypes: {}, manual: [], reason: "absent" };
  const raw = await readFile(jsonlPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const drifts = new Map(); // id -> row
  let malformed = 0;
  const unknownTypes = {};
  const manual = [];
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
      if (existing) {
        existing.status = row.status;
        // Carry the vocabulary forward — previously only `status` crossed
        // the fold (docs/DATA_MODEL.md §4-§6). Later transitions overwrite
        // earlier ones for the same id, matching `status`'s behaviour.
        if (row.closed_by !== undefined) existing.closed_by = row.closed_by;
        if (row.wontfix_reason !== undefined) existing.wontfix_reason = row.wontfix_reason;
        // Fold legacy singular `note` into `notes` on read (never rewritten
        // on disk — SPEC I2). If a row somehow carries both, concatenate
        // rather than silently dropping either.
        let notes = row.notes;
        if (row.note !== undefined) {
          notes = notes !== undefined ? `${notes}; ${row.note}` : row.note;
        }
        if (notes !== undefined) existing.notes = notes;
        // The Event's own `timestamp` is when drift FIRED; this Transition's
        // `timestamp` is when it CLOSED. Name it distinctly so it never
        // shadows the Event's timestamp — this is the only time-to-close
        // signal in the data.
        if (row.timestamp !== undefined) existing.closed_at = row.timestamp;
      }
    } else if (row.type === "drift" || row.type === "code_drift") {
      drifts.set(row.id, {
        ...row,
        status: row.status || "open",
      });
    } else if (row.type === "manual") {
      // Terminal-only: a hand-authored annotation of a workspace event
      // (e.g. a rename), always written with a closed `status`. It carries
      // no open state, so it is recognised here but deliberately NOT folded
      // into `drifts`.
      //
      // Not folding is the load-bearing part, not an omission. The one
      // instance in the tree (Vipin Kaushik ledger line 470) shares `id`
      // "256" with a real `drift` row four lines later — docs/ISSUES.md N2.
      // Admitting it to the `drifts` map would let the two silently
      // overwrite each other by file order, converting an invisible row
      // (N1) into a corrupted one. Returned separately so callers can see
      // it without it entering the drift fold.
      manual.push(row);
    } else {
      const t = row.type === undefined ? "(missing)" : String(row.type);
      unknownTypes[t] = (unknownTypes[t] || 0) + 1;
    }
  }
  const rows = [...drifts.values()].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : 1,
  );

  // Attach backfilled git context from the sidecar (lib/git-context.mjs),
  // if one exists next to this ledger. Trivially distinguishable from a
  // stamped value: a stamped row carries `git` (set by the watcher at fire
  // time, see docs/DATA_MODEL.md §4); a sidecar-derived row carries
  // `git_reconstructed` (always `{..., reconstructed: true}`) instead. A
  // row that already has a stamped `git` is never touched — a
  // reconstruction must never pass as, or overwrite, a stamped value
  // (Phase 5 constraint). No existing row is mutated on disk; this only
  // affects the in-memory folded object.
  const backfillMap = loadGitBackfillSidecar(jsonlPath);
  if (backfillMap.size > 0) {
    for (const row of rows) {
      if (!row.git && backfillMap.has(row.id)) {
        row.git_reconstructed = backfillMap.get(row.id);
      }
    }
  }

  return { rows, malformed, unknownTypes, manual };
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
 * The era a ledger line belongs to.
 *
 * WHY THIS EXISTS. `status` used to print "frozen: N v1 events, all closed" on
 * the strength of `rows.filter(r => r.status === "open").length === 0` — it read
 * no version field, because no ledger row had one. So "frozen history" and
 * "nothing happens to be open right now" rendered IDENTICALLY, and appending a
 * single open event turned 1,850 rows of settled history back into a worklist.
 * A freeze inferred from a filter returning empty is not a freeze.
 *
 * Ported from `readLifecycle` (lib/refs/snapshot.mjs) rather than re-derived —
 * GOTCHAS G27 records what re-deriving a tool's behaviour from its shape costs.
 */
export const LEDGER_SCHEMA = 2;

/** `<propagation>/archive/` — where frozen v1 rows live. See lib/core/v3-layout.mjs. */
export function ledgerArchiveDir(jsonlPath) {
  return path.join(path.dirname(jsonlPath), "archive");
}

/**
 * The frozen-v1 archive name for a given ledger, DERIVED FROM ITS OWN BASENAME.
 *
 * Not a fixed `ledger-v1-*` glob. The hub keeps TWO ledgers in one directory —
 * `propagation/ledger.jsonl` and `propagation/PROPAGATION_CROSS_LEDGER.jsonl` —
 * so a folder-wide glob folded the hub's 401 archived workspace rows into the
 * CROSS ledger's census. doctor caught it instantly: "56 rows missing partner"
 * against a 16-line file, and a count larger than the file is the tell.
 *
 * Deriving from the basename keeps each ledger's history its own, and lets both
 * live in `archive/` beside Phase E's `migration-<project>-*.json` records
 * without any of the three colliding.
 */
export function archivePrefixFor(jsonlPath) {
  return path.basename(jsonlPath).replace(/\.jsonl$/, "") + "-v1-";
}

/**
 * Read a ledger's PHYSICAL LINES, saying which era each belongs to.
 *
 * Note "physical lines", not rows: `readLedgerWithStats` REDUCES `status_change`
 * records into a current status and drops them from its output, so it returns
 * ~405 rows where Vipin Kaushik's file has 791 lines. Era is a property of the
 * line, so this reader deliberately works at the level `readLedger` collapses.
 *
 * FOUR OUTCOMES, never conflated:
 *   current  — declares `schema: 2`. Written by `appendRow`.
 *   v1       — lives in `archive/ledger-v1-*.jsonl`.
 *   refused  — parses as nothing recognisable, or sits in the LIVE ledger
 *              without declaring an era. Named with a reason, never skipped.
 *   total    — every line seen, so `current + v1 + refused === total` and a
 *              dropped line is arithmetically impossible to hide.
 *
 * THE ONE DIVERGENCE FROM `readLifecycle`, and it is deliberate. Lifecycle v1
 * has a POSITIVE marker (`type: "branch_lifecycle"`), so it can be recognised
 * in place. Ledger v1 has none — its four types (`status_change`, `drift`,
 * `code_drift`, `manual`) are the SAME names v2 uses. So v1 is identified by
 * LOCATION, which is exactly why the freeze relocates rather than relying on a
 * discriminator that does not exist. After the freeze, an unstamped line in the
 * live ledger is not v1 — it is a writer that bypassed `appendRow`, and calling
 * it "history" would hide a live defect.
 *
 * @param {string} jsonlPath
 * @returns {Promise<{current: object[], v1: object[], refused: object[], total: number, file: string, archives: string[], reason?: string}>}
 */
export async function readLedgerByEra(jsonlPath) {
  // `all` is EVERY successfully-parsed row, whatever era it declares. Callers
  // asking a question about row CONTENT (does each drift row carry a partner?)
  // must use it: era buckets answer "which version wrote this", and filtering by
  // era to ask a content question silently drops the rows that have not been
  // frozen yet. doctor's G7 did exactly that and went green on ZERO rows.
  const out = { current: [], v1: [], refused: [], all: [], total: 0, file: jsonlPath, archives: [] };
  if (!jsonlPath) return { ...out, reason: "unconfigured" };

  const scan = (text, file, onRow) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      out.total++;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        out.refused.push({ file, line: line.slice(0, 120), reason: "not valid JSON" });
        continue;
      }
      out.all.push(row);
      onRow(row, line, file);
    }
  };

  // ── the live ledger ──────────────────────────────────────────────────────
  // Absent is a real state, distinct from empty and again from unreadable.
  // Report it rather than returning a hollow "nothing here".
  if (!existsSync(jsonlPath)) {
    out.reason = "absent";
  } else {
    let text;
    try {
      text = await readFile(jsonlPath, "utf8");
    } catch (err) {
      return { ...out, reason: `unreadable: ${err?.message ?? err}` };
    }
    scan(text, jsonlPath, (row, line, file) => {
      if (row.schema === LEDGER_SCHEMA) out.current.push(row);
      else {
        out.refused.push({
          file,
          line: line.slice(0, 120),
          reason: `declares no schema ${LEDGER_SCHEMA}; frozen v1 rows belong in archive/, not the live ledger`,
        });
      }
    });
  }

  // ── frozen history ───────────────────────────────────────────────────────
  const dir = ledgerArchiveDir(jsonlPath);
  const prefix = archivePrefixFor(jsonlPath);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl")).sort();
  } catch {
    names = []; // no archive/ is normal: a workspace that never had v1 rows.
  }
  for (const name of names) {
    const file = path.join(dir, name);
    out.archives.push(file);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      out.refused.push({ file, line: "", reason: `archive unreadable: ${err?.message ?? err}` });
      continue;
    }
    scan(text, file, (row) => out.v1.push(row));
  }

  return out;
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
 * `renderMarkdown` was REMOVED 2026-08-25 — v3 Phase D, closing N42 and N31.
 *
 * It rendered `propagation/ledger.md` from the JSONL and had **no live caller**:
 * its only references were the watcher (retired 2026-08-14) and its own tests.
 * Two documents prescribed calling it anyway, while `SKILL.md` forbade the
 * hand-close they described — a contradiction that stayed live for eight days.
 *
 * It could not simply be wired up: the `.md` files had accumulated hand-written
 * prose (ManavDaehi's is 50 lines, 39 of them explaining why the file is frozen),
 * and regenerating would have destroyed it — the half-machine/half-hand-written
 * conflation `rule:state-and-decisions` names.
 *
 * Phase D settled it. The freeze moves each v1 `.md` into
 * `propagation/archive/ledger-v1-<date>.md` beside its `.jsonl`, so the prose is
 * preserved as history rather than destroyed, and no live `.md` remains to rot.
 * The machine view is `status` and `graph`, derived on demand.
 *
 * Do not reinstate it. If a rendered view is wanted again, it renders from
 * schema-2 rows into a file nobody hand-edits — never back into `ledger.md`.
 */


/**
 * Strip the trailing "Generated by propagate at <ts>." line so two renders of
 * identical content compare equal despite differing timestamps.
 *
 * Matches the legacy "propagate watcher at" wording too. The v1 watcher was retired
 * 2026-08-14 and the footer stopped naming it on 2026-08-18; every already-rendered
 * ledger on disk still carries the old form. Without tolerating both, the first render
 * after the change would see the old footer as body content, compare unequal, and
 * rewrite every ledger in the tree — a spurious diff in an append-only artifact.
 */
function stripGeneratedFooter(text) {
  return text
    .replace(/Generated by propagate (?:watcher )?at [^\n]*\n?$/, "")
    .replace(/\n$/, "");
}

/**
 * Every ledger file on disk that no discovered workspace owns.
 *
 * This exists because a ledger can be real, non-empty, and completely invisible
 * to the tool. Measured 2026-08-15: a 79-row ledger with 1 open row sat at
 * `PanditPawanKaushik/.claude/worktrees/client-answers-propagation/docs/` and
 * contributed 0 to every total, for two independent reasons — it is below
 * `DEFAULT_MAX_DEPTH` (2), and its sidecar never opted in with `workspace: true`.
 *
 * Deliberately NOT solved by raising the depth limit. Depth finds today's
 * worktree and misses tomorrow's; scanning for the artifact itself cannot be
 * outrun by nesting, by a naming convention, or by a missing flag. The skip set
 * therefore does NOT include `.claude` or `.worktrees` — those are precisely
 * where the orphans hide (contrast `findAllSidecarsRecursive` in edges.mjs,
 * which skips them on purpose: it is answering a different question).
 *
 * `rule:discernment-checks` §2 — absence must be attributable. A ledger the tool
 * cannot reach has to be reported as unreachable, never silently dropped.
 *
 * @param {string[]} searchRoots
 * @param {string[]} ownedJsonlPaths  ledger paths already owned by a workspace
 * @returns {Promise<string[]>} absolute paths, sorted
 */
export async function findUnownedLedgers(searchRoots, ownedJsonlPaths) {
  const { readdir, realpath } = await import("node:fs/promises");
  const path = (await import("node:path")).default;

  const SKIP = new Set([
    "node_modules", ".git", ".next", "dist", "build",
    ".venv", "venv", "__pycache__", ".gstack",
  ]);
  const isLedger = (name) =>
    name === "PROPAGATION_LEDGER.jsonl" ||
    name === "ledger.jsonl" ||
    name === "PROPAGATION_CROSS_LEDGER.jsonl";

  // `path.resolve` is lexical — it does not resolve symlinks. A ledger reachable
  // by two names (a real path and a symlinked path into the same file, e.g.
  // `propagate-skill` / `rules` symlinked into this tree) is one inode, but two
  // distinct strings under `path.resolve`. Compare by realpath on both sides so
  // the same file is recognized as owned regardless of which name found it;
  // fall back to the lexical value when realpath throws (broken symlink, or a
  // race where the file vanished between readdir and here) — a missing target
  // must not crash the check, per `doctor`'s "reporting must never break doctor".
  async function realOrLexical(p) {
    const abs = path.resolve(p);
    try {
      return await realpath(abs);
    } catch {
      return abs;
    }
  }

  const owned = new Set(await Promise.all(ownedJsonlPaths.map((p) => realOrLexical(p))));
  const found = new Map(); // real/lexical path -> original discovered path (returned to the caller)

  async function walk(dir, depth) {
    if (depth > 8) return; // a bound, not a filter — deep trees are pathological
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not a finding; the caller sees what was scanned
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && isLedger(e.name)) {
        const abs = path.resolve(full);
        const key = await realOrLexical(full);
        if (!owned.has(key) && !found.has(key)) found.set(key, abs);
      }
    }
  }

  for (const root of searchRoots) await walk(root, 0);
  return [...found.values()].sort();
}

/**
 * Folded open-row count for a ledger — the number of ids whose LAST status is
 * `open`, which is not the number of lines saying `open`.
 *
 * The ledger is append-only: a row closed later keeps its original `open` line
 * forever. Counting lines across the tree gave 501 where the truth was 8.
 */
export async function openCount(jsonlPath) {
  if (!existsSync(jsonlPath)) return 0;
  const rows = await readLedger(jsonlPath);
  return rows.filter((r) => r.status === "open").length;
}

/**
 * Classify an unowned ledger: is it independent work, or a stale branch-time copy
 * of a ledger that IS owned?
 *
 * This distinction is not cosmetic. Measured 2026-08-15: the worktree ledger at
 * `PanditPawanKaushik/.claude/worktrees/client-answers-propagation/` holds 40 ids,
 * **all 40 of which exist in the parent workspace's ledger**, and its single `open`
 * row (`#039`) is already `done` upstream. It is a snapshot taken when the branch
 * was cut, not a second source of truth.
 *
 * Counting it would have swapped one error for another — under-reporting 4-of-8
 * for over-reporting 8-when-7. `rule:discernment-checks` §5: state what the
 * measurement is over, and check it is the same thing the claim is about.
 *
 * @returns {Promise<{kind: "snapshot"|"orphan", of: string|null, ids: number, openRows: number}>}
 */
export async function classifyUnownedLedger(jsonlPath, ownedJsonlPaths) {
  const rows = await readLedger(jsonlPath);
  const myIds = new Set(rows.map((r) => String(r.id)));
  const open = rows.filter((r) => r.status === "open").length;

  for (const owned of ownedJsonlPaths) {
    if (!existsSync(owned)) continue;
    const ownedIds = new Set((await readLedger(owned)).map((r) => String(r.id)));
    if (myIds.size > 0 && [...myIds].every((i) => ownedIds.has(i))) {
      return { kind: "snapshot", of: owned, ids: myIds.size, openRows: open };
    }
  }
  return { kind: "orphan", of: null, ids: myIds.size, openRows: open };
}

// ─── moved from cli.mjs 2026-08-25 (#31 T2) — see the git log for why ───

/**
 * Given every ledger's open rows, find absolute source paths open in more
 * than one ledger — the expiry signal for the deferred hub-row migration
 * (docs/DECISIONS.md 2026-08-10, "the 69 misfiled hub rows are deferred").
 * @param {Array<{workspaceRoot: string, ledgerPath: string, rows: Array}>} ledgerEntries
 * @returns {{count: number, examples: Array<{path: string, ledgers: string[]}>}}
 */
export function findDuplicateOpenAcrossLedgers(ledgerEntries) {
  const bySource = new Map(); // absPath -> Set(ledgerPath)
  for (const { workspaceRoot, ledgerPath, rows } of ledgerEntries) {
    for (const row of rows) {
      if (row.status !== "open" || !row.source) continue;
      const abs = path.resolve(workspaceRoot, row.source);
      if (!bySource.has(abs)) bySource.set(abs, new Set());
      bySource.get(abs).add(ledgerPath);
    }
  }
  const dups = [...bySource.entries()].filter(([, set]) => set.size > 1);
  return {
    count: dups.length,
    examples: dups.slice(0, 5).map(([abs, set]) => ({ path: abs, ledgers: [...set] })),
  };
}
