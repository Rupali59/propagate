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
import { loadGitBackfillSidecar } from "./git-context.mjs";

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
  const { readdir } = await import("node:fs/promises");
  const path = (await import("node:path")).default;

  const SKIP = new Set([
    "node_modules", ".git", ".next", "dist", "build",
    ".venv", "venv", "__pycache__", ".gstack",
  ]);
  const isLedger = (name) =>
    name === "PROPAGATION_LEDGER.jsonl" ||
    name === "ledger.jsonl" ||
    name === "PROPAGATION_CROSS_LEDGER.jsonl";

  const owned = new Set(ownedJsonlPaths.map((p) => path.resolve(p)));
  const found = new Set();

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
        if (!owned.has(abs)) found.add(abs);
      }
    }
  }

  for (const root of searchRoots) await walk(root, 0);
  return [...found].sort();
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
