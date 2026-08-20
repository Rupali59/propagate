/**
 * Derived SQLite index over the ecosystem's ledgers and authored docs.
 *
 * Read-only over the corpus: this file never writes to a ledger, STATE.md, or
 * DECISIONS.md. The only thing it writes is `index.db` itself, which is
 * derived and disposable — see docs/DECISIONS.md and STATE.md for why writes
 * stay local to each repo while reads get one place.
 *
 * REBUILD SEMANTICS: full re-read every time; DROP + CREATE every table. No
 * incremental logic — incremental state is exactly the class of bug that
 * orphaned 5 of 8 ledgers (discoverWorkspacesSync's blind spot). Because the
 * index is disposable, it can never itself become the thing that drifts.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { discoverWorkspacesSync } from "../core/discovery.mjs";
import { scanSkills, probeTranscripts } from "./skills-scan.mjs";

// ─────────────────────────────────────────────────────────────────────────
// Filesystem sweep — deliberately NOT discoverWorkspacesSync. That function
// halted at the hub's root .propagates.yml marker and orphaned 5 of 8
// ledgers until the 2026-08-10 Part A fix. This sweep walks the raw tree
// directly, so its result can be diffed against discovery to catch the next
// blind spot instead of trusting the same function that caused the last one.
// ─────────────────────────────────────────────────────────────────────────

const EXCLUDE_DIR_NAMES = new Set(["node_modules", ".next", ".git", "_archive"]);

// `.propagation` is a dot-directory that legitimately holds a real ledger
// (`**/.propagation/ledger.jsonl` is one of the four patterns we must match),
// so it is the one dot-dir the sweep is allowed to descend into. Every other
// dot-directory (`.git`, `.claude`, `.vercel`, ...) is skipped — that is how
// the three worktree-copy ledgers under
// `PanditPawanKaushik/.claude/worktrees/*/docs/PROPAGATION_LEDGER.jsonl` stay
// out of the index entirely, per the task brief.
const DOT_DIR_ALLOWED = ".propagation";

const LEDGER_FILENAMES = new Set([
  "PROPAGATION_LEDGER.jsonl",
  "PROPAGATION_CROSS_LEDGER.jsonl",
]);

/**
 * Walk `roots` (each an absolute directory) collecting ledger/STATE/DECISIONS
 * paths. Never throws — an unreadable directory is silently skipped (surfaced
 * later, if it matters, via coverage_gap for files we DID find but couldn't
 * read).
 */
export function sweepFilesystem(roots) {
  const ledgers = [];
  const stateFiles = [];
  const decisionFiles = [];
  const seenDirs = new Set();

  function walk(dir) {
    const real = path.resolve(dir);
    if (seenDirs.has(real)) return; // guard against symlink loops / duplicate roots
    seenDirs.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
        if (e.name.startsWith(".") && e.name !== DOT_DIR_ALLOWED) continue;
        walk(full);
      } else if (e.isFile()) {
        if (LEDGER_FILENAMES.has(e.name)) {
          ledgers.push({ path: full, kind: e.name });
        } else if (e.name === "ledger.jsonl" && path.basename(dir) === ".propagation") {
          ledgers.push({ path: full, kind: ".propagation/ledger.jsonl" });
        } else if (e.name === "STATE.md") {
          stateFiles.push(full);
        } else if (e.name === "DECISIONS.md") {
          decisionFiles.push(full);
        }
      }
    }
  }

  for (const root of roots) {
    if (existsSync(root)) walk(root);
  }

  return { ledgers, stateFiles, decisionFiles };
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger parsing — deliberately separate from lib/ledger.mjs's readLedger:
// that function silently DROPS rows whose type isn't drift/code_drift/
// status_change. This index must surface those (ledger_unknown), so it keeps
// its own reduction pass that captures the raw row instead of discarding it.
// Same reduction semantics otherwise (status_change updates the matching
// drift row's status; unmatched status_change rows are inert, matching
// existing behavior).
// ─────────────────────────────────────────────────────────────────────────

export function parseLedgerFile(jsonlPath) {
  if (!existsSync(jsonlPath)) return { rows: [], unknown: [] };
  const raw = readFileSync(jsonlPath, "utf8");
  const lines = raw.split("\n");
  const drifts = new Map();
  const unknown = [];

  lines.forEach((lineRaw, idx) => {
    const line = lineRaw.trim();
    if (!line) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      unknown.push({
        raw_type: "(malformed)",
        raw_id: null,
        raw_json: line,
        line_no: idx + 1,
      });
      return;
    }
    if (row.type === "status_change") {
      const existing = drifts.get(row.id);
      if (existing) existing.status = row.status;
    } else if (row.type === "drift" || row.type === "code_drift") {
      drifts.set(row.id, { ...row, status: row.status || "open" });
    } else if (row.type === "manual") {
      // Known terminal-only type; not a drift and not unknown. Mirrors the
      // fold in lib/ledger.mjs — kept in step deliberately, because one
      // guarded path plus one unguarded path in the same codebase is the
      // shape of every safety-flag defect in docs/GOTCHAS.md.
    } else {
      unknown.push({
        raw_type: row.type === undefined ? "(missing)" : String(row.type),
        raw_id: row.id ?? null,
        raw_json: line,
        line_no: idx + 1,
      });
    }
  });

  return { rows: [...drifts.values()], unknown };
}

// ─────────────────────────────────────────────────────────────────────────
// DECISIONS.md parsing — "## YYYY-MM-DD: <title>" blocks with bold
// **What:**/**Why:**/**Gotchas:**/**Affects:**/**Refs:** fields. Gotchas is
// optional; the others are usually present but parsing tolerates absence.
// ─────────────────────────────────────────────────────────────────────────

const DECISION_HEADING = /^## (\d{4}-\d{2}-\d{2}):\s*(.+)$/gm;
const FIELD_RE = /\*\*(What|Why|Gotchas|Affects|Refs):\*\*/g;

function extractFields(blockText) {
  const matches = [...blockText.matchAll(FIELD_RE)];
  const out = {};
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : blockText.length;
    // Strip a trailing "---" section-separator line (and surrounding
    // whitespace) that belongs to the file's rendering, not the field value.
    out[name] = blockText
      .slice(start, end)
      .replace(/\n+---\s*$/, "")
      .trim();
  }
  return out;
}

export function parseDecisionsFile(text) {
  const headings = [...text.matchAll(DECISION_HEADING)];
  const out = [];
  for (let i = 0; i < headings.length; i++) {
    const m = headings[i];
    const date = m[1];
    const title = m[2].trim();
    const blockStart = m.index + m[0].length;
    const blockEnd = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const block = text.slice(blockStart, blockEnd);
    const fields = extractFields(block);
    const affectsRaw = fields.affects || "";
    const affects = affectsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({
      date,
      title,
      what: fields.what || "",
      why: fields.why || "",
      gotchas: fields.gotchas || "",
      refs: fields.refs || "",
      affects,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// STATE.md parsing — only the "Last updated: YYYY-MM-DD" header line.
// ─────────────────────────────────────────────────────────────────────────

export function parseStateHeaderDate(text) {
  const m = /Last updated:\s*(\d{4}-\d{2}-\d{2})/i.exec(text);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Workspace label inference for decision/state_doc rows (display-only —
// the cross-cutting `affects` query keys off decision_affects.target, which
// stores the raw Affects tokens verbatim, not this inferred label).
// ─────────────────────────────────────────────────────────────────────────

export function inferWorkspace(filePath, roots, skillDir) {
  const resolved = path.resolve(filePath);
  if (skillDir && resolved.startsWith(path.resolve(skillDir) + path.sep)) return "propagate";
  for (const root of roots) {
    const rroot = path.resolve(root);
    if (resolved === rroot) return "hub";
    if (resolved.startsWith(rroot + path.sep)) {
      const rel = path.relative(rroot, resolved);
      let dir = path.dirname(rel);
      if (dir === ".") return "hub";
      if (dir === "docs") return "hub";
      if (dir.endsWith(path.sep + "docs")) dir = dir.slice(0, -("docs".length + 1));
      return dir;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────

const TABLES = ["ledger_row", "ledger_unknown", "decision", "decision_affects", "state_doc", "source_file", "coverage_gap", "skill"];

const SCHEMA_SQL = `
CREATE TABLE ledger_row (
  id TEXT,
  ledger_path TEXT,
  workspace TEXT,
  type TEXT,
  source TEXT,
  change TEXT,
  status TEXT,
  timestamp TEXT,
  correlation_id TEXT,
  downstream_json TEXT,
  pending_graph_augment INTEGER
);
CREATE INDEX idx_ledger_row_status ON ledger_row(status);
CREATE INDEX idx_ledger_row_ledger_path ON ledger_row(ledger_path);

CREATE TABLE ledger_unknown (
  ledger_path TEXT,
  workspace TEXT,
  raw_type TEXT,
  raw_id TEXT,
  raw_json TEXT,
  line_no INTEGER
);

CREATE TABLE decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,
  title TEXT,
  what TEXT,
  why TEXT,
  gotchas TEXT,
  refs TEXT,
  source_file TEXT
);
CREATE INDEX idx_decision_date ON decision(date);

CREATE TABLE decision_affects (
  decision_id INTEGER,
  target TEXT
);
CREATE INDEX idx_decision_affects_target ON decision_affects(target);

CREATE TABLE state_doc (
  path TEXT,
  workspace TEXT,
  header_last_updated TEXT,
  file_mtime TEXT
);

CREATE TABLE source_file (
  path TEXT,
  kind TEXT,
  bytes INTEGER,
  mtime TEXT,
  row_count INTEGER
);
CREATE INDEX idx_source_file_path ON source_file(path);

CREATE TABLE coverage_gap (
  path TEXT,
  reason TEXT
);

-- Skill inventory. Derived like everything else here: dropped and rebuilt from
-- the filesystem + ~/.claude.json + transcripts on every rebuild, so it can
-- never become the thing that drifts.
--
-- never_invoked is stored rather than computed at query time because it is the
-- AND of two probes with different availability (transcripts can be
-- unreachable), and a query recomputing it would silently change meaning when
-- one probe is missing.
CREATE TABLE skill (
  id TEXT,
  dir TEXT,
  installer TEXT,
  declared_name TEXT,
  name_mismatch INTEGER,
  dangling INTEGER,
  source_url TEXT,
  installed_at TEXT,
  usage_count INTEGER,
  last_used_at TEXT,
  transcript_count INTEGER,
  transcript_sessions INTEGER,
  never_invoked INTEGER
);
CREATE INDEX idx_skill_id ON skill(id);
CREATE INDEX idx_skill_never ON skill(never_invoked);
`;

export function openDb(dbPath) {
  return new DatabaseSync(dbPath);
}

function dropAndCreateTables(db) {
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const t of TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
  db.exec(SCHEMA_SQL);
}

// ─────────────────────────────────────────────────────────────────────────
// Rebuild
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.dbPath - path to write the SQLite file (or ":memory:")
 * @param {string[]} opts.roots - filesystem roots to sweep (e.g. [~/Documents/GitHub])
 * @param {string} opts.skillDir - propagate's own skill dir (also swept)
 * @param {(roots: string[]) => {workspaces: Array}} [opts.discover] - injectable for tests
 * @param {Function|null} [opts.scanSkillsFn] - skill sweep; OFF by default, see below
 * @param {Function|null} [opts.probeTranscriptsFn] - injectable transcript probe
 * @returns {{db, timingsMs, counts, coverageGaps}}
 *
 * The skill sweep defaults to OFF rather than to the real scanner. Unlike every
 * other input here, which is confined to `roots`, it reads global machine state
 * (~/.claude/skills, ~/.claude.json, ~/.claude/projects). A default-on sweep
 * would silently make every existing test in tests/index.test.mjs depend on
 * whatever is installed on the developer's machine, and would re-scan 861 MB of
 * transcripts per test. Production opts in explicitly; pass
 * `{scanSkillsFn: scanSkills, probeTranscriptsFn: probeTranscripts}`.
 */
export function rebuildIndex({
  dbPath,
  roots,
  skillDir,
  discover = discoverWorkspacesSync,
  scanSkillsFn = null,
  probeTranscriptsFn = null,
}) {
  const t0 = Date.now();

  const sweepRoots = [...roots, skillDir].filter(Boolean);
  const sweep = sweepFilesystem(sweepRoots);
  const tSweep = Date.now();

  const discovery = discover(roots);
  const discoveredLedgerPaths = new Set(
    (discovery.workspaces || []).map((w) => path.resolve(w.ledgerJsonl)),
  );

  const db = openDb(dbPath);
  dropAndCreateTables(db);

  const insertLedgerRow = db.prepare(
    `INSERT INTO ledger_row (id, ledger_path, workspace, type, source, change, status, timestamp, correlation_id, downstream_json, pending_graph_augment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLedgerUnknown = db.prepare(
    `INSERT INTO ledger_unknown (ledger_path, workspace, raw_type, raw_id, raw_json, line_no)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertDecision = db.prepare(
    `INSERT INTO decision (date, title, what, why, gotchas, refs, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDecisionAffects = db.prepare(
    `INSERT INTO decision_affects (decision_id, target) VALUES (?, ?)`,
  );
  const insertStateDoc = db.prepare(
    `INSERT INTO state_doc (path, workspace, header_last_updated, file_mtime) VALUES (?, ?, ?, ?)`,
  );
  const insertSourceFile = db.prepare(
    `INSERT INTO source_file (path, kind, bytes, mtime, row_count) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertCoverageGap = db.prepare(
    `INSERT INTO coverage_gap (path, reason) VALUES (?, ?)`,
  );
  const insertSkill = db.prepare(
    `INSERT INTO skill (id, dir, installer, declared_name, name_mismatch, dangling,
       source_url, installed_at, usage_count, last_used_at, transcript_count,
       transcript_sessions, never_invoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const counts = {
    ledger_row: 0,
    ledger_unknown: 0,
    decision: 0,
    decision_affects: 0,
    state_doc: 0,
    source_file: 0,
    coverage_gap: 0,
    skill: 0,
  };

  // ── Ledgers ──────────────────────────────────────────────────────────
  for (const { path: ledgerPath } of sweep.ledgers) {
    const workspace = inferWorkspace(ledgerPath, roots, skillDir);
    let parsed;
    let statInfo;
    try {
      statInfo = statSync(ledgerPath);
      parsed = parseLedgerFile(ledgerPath);
    } catch (err) {
      insertCoverageGap.run(ledgerPath, `unreadable: ${err.message}`);
      counts.coverage_gap++;
      continue;
    }

    for (const row of parsed.rows) {
      insertLedgerRow.run(
        row.id ?? null,
        ledgerPath,
        workspace,
        row.type ?? null,
        row.source ?? null,
        row.change ?? null,
        row.status ?? null,
        row.timestamp ?? null,
        row.correlation_id ?? null,
        JSON.stringify(row.downstream ?? []),
        row.pending_graph_augment ? 1 : 0,
      );
      counts.ledger_row++;
    }
    for (const u of parsed.unknown) {
      insertLedgerUnknown.run(ledgerPath, workspace, u.raw_type, u.raw_id, u.raw_json, u.line_no);
      counts.ledger_unknown++;
    }

    insertSourceFile.run(ledgerPath, "ledger", statInfo.size, statInfo.mtime.toISOString(), parsed.rows.length + parsed.unknown.length);
    counts.source_file++;

    if (!discoveredLedgerPaths.has(path.resolve(ledgerPath))) {
      insertCoverageGap.run(ledgerPath, "found-by-sweep-not-discovery");
      counts.coverage_gap++;
    }
  }

  // ── Decisions ────────────────────────────────────────────────────────
  for (const filePath of sweep.decisionFiles) {
    let text, statInfo;
    try {
      statInfo = statSync(filePath);
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      insertCoverageGap.run(filePath, `unreadable: ${err.message}`);
      counts.coverage_gap++;
      continue;
    }
    let entries;
    try {
      entries = parseDecisionsFile(text);
    } catch (err) {
      insertCoverageGap.run(filePath, `parse-failed: ${err.message}`);
      counts.coverage_gap++;
      entries = [];
    }
    for (const e of entries) {
      const result = insertDecision.run(e.date, e.title, e.what, e.why, e.gotchas, e.refs, filePath);
      const decisionId = Number(result.lastInsertRowid);
      counts.decision++;
      for (const target of e.affects) {
        insertDecisionAffects.run(decisionId, target);
        counts.decision_affects++;
      }
    }
    insertSourceFile.run(filePath, "decisions", statInfo.size, statInfo.mtime.toISOString(), entries.length);
    counts.source_file++;
  }

  // ── STATE docs ───────────────────────────────────────────────────────
  for (const filePath of sweep.stateFiles) {
    let text, statInfo;
    try {
      statInfo = statSync(filePath);
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      insertCoverageGap.run(filePath, `unreadable: ${err.message}`);
      counts.coverage_gap++;
      continue;
    }
    const workspace = inferWorkspace(filePath, roots, skillDir);
    const headerDate = parseStateHeaderDate(text);
    insertStateDoc.run(filePath, workspace, headerDate, statInfo.mtime.toISOString());
    counts.state_doc++;
    insertSourceFile.run(filePath, "state", statInfo.size, statInfo.mtime.toISOString(), null);
    counts.source_file++;
  }

  // ── Skills ───────────────────────────────────────────────────────────
  // Injectable so tests can drive this without touching the real
  // ~/.claude/skills or ~/.claude.json.
  if (scanSkillsFn) {
    const tx = probeTranscriptsFn ? probeTranscriptsFn() : { byName: {} };
    const { skills: found } = scanSkillsFn({ transcripts: tx.byName });
    for (const s of found) {
      insertSkill.run(
        s.id,
        s.dir,
        s.installer,
        s.declaredName,
        s.nameMismatch ? 1 : 0,
        s.dangling ? 1 : 0,
        s.provenance?.sourceUrl ?? null,
        s.provenance?.installedAt ?? null,
        s.usageCount,
        s.lastUsedAt ? new Date(s.lastUsedAt).toISOString() : null,
        s.transcriptCount,
        s.transcriptSessions,
        s.neverInvoked ? 1 : 0,
      );
      counts.skill++;
    }
  }

  const tEnd = Date.now();

  return {
    db,
    timingsMs: {
      sweep: tSweep - t0,
      total: tEnd - t0,
    },
    counts,
    discovery,
    sweep,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Read helpers reused by both digest.mjs and index.mjs's CLI.
// ─────────────────────────────────────────────────────────────────────────

/** Latest mtime (ISO string) recorded in source_file for any file under `dir`. Null if none. */
export function latestMtimeUnderDir(db, dir) {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const rows = db
    .prepare(`SELECT path, mtime FROM source_file WHERE path LIKE ?`)
    .all(prefix + "%");
  let max = null;
  for (const r of rows) {
    if (max === null || r.mtime > max) max = r.mtime;
  }
  return max;
}

// ─────────────────────────────────────────────────────────────────────────
// Canned queries
// ─────────────────────────────────────────────────────────────────────────

export function queryOpenDrift(db) {
  return db
    .prepare(
      `SELECT ledger_path, workspace, id, source, change, status, timestamp
       FROM ledger_row WHERE status = 'open'
       ORDER BY ledger_path, timestamp`,
    )
    .all();
}

export function queryDecisionsSince(db, { from = null, to = null } = {}) {
  let sql = `SELECT id, date, title, source_file FROM decision WHERE 1=1`;
  const params = [];
  if (from) {
    sql += ` AND date >= ?`;
    params.push(from);
  }
  if (to) {
    sql += ` AND date <= ?`;
    params.push(to);
  }
  sql += ` ORDER BY date`;
  return db.prepare(sql).all(...params);
}

export function queryAffects(db, repo) {
  return db
    .prepare(
      `SELECT d.id, d.date, d.title, d.source_file, d.refs
       FROM decision d
       JOIN decision_affects da ON da.decision_id = d.id
       WHERE da.target = ? OR da.target LIKE ?
       ORDER BY d.date`,
    )
    .all(repo, `%${repo}%`);
}

export function queryStaleState(db) {
  return db
    .prepare(
      `SELECT path, workspace, header_last_updated, file_mtime FROM state_doc ORDER BY path`,
    )
    .all();
}

export function queryOpenOlderThan(db, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `SELECT ledger_path, workspace, id, source, change, status, timestamp
       FROM ledger_row WHERE status = 'open' AND timestamp < ?
       ORDER BY timestamp`,
    )
    .all(cutoff);
}

/**
 * Skills neither probe has ever seen used. This is the reaper's candidate list,
 * so it deliberately excludes nothing -- callers apply their own tier and age
 * policy rather than having it baked into the query.
 */
export function querySkillsNeverInvoked(db) {
  return db
    .prepare(
      `SELECT id, installer, dir, source_url
       FROM skill WHERE never_invoked = 1
       ORDER BY installer, id`,
    )
    .all();
}

/** Skills with no recorded provenance -- nothing says where they came from. */
export function querySkillsNoProvenance(db) {
  return db
    .prepare(
      `SELECT id, installer, dir FROM skill
       WHERE source_url IS NULL AND installer = 'handmade'
       ORDER BY id`,
    )
    .all();
}

/**
 * Skills seen in transcripts but absent from skillUsage. Expected to be empty:
 * skillUsage is meant to be a superset. A nonzero result means the primary
 * probe has lost events and should stop being treated as authoritative.
 */
export function querySkillProbeDisagreement(db) {
  return db
    .prepare(
      `SELECT id, usage_count, transcript_count FROM skill
       WHERE usage_count = 0 AND transcript_count > 0
       ORDER BY transcript_count DESC`,
    )
    .all();
}

export function queryUnknownTypes(db) {
  return db
    .prepare(
      `SELECT ledger_path, workspace, raw_type, COUNT(*) as count
       FROM ledger_unknown GROUP BY ledger_path, raw_type ORDER BY ledger_path`,
    )
    .all();
}

export function tableCounts(db) {
  const out = {};
  for (const t of TABLES) {
    out[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).all()[0].c;
  }
  return out;
}

const WRITE_SQL_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i;

export function isWriteStatement(sql) {
  return WRITE_SQL_RE.test(sql);
}

export function runReadOnlySql(db, sql) {
  if (isWriteStatement(sql)) {
    throw new Error("propagate-index: refusing to run a write statement via --sql");
  }
  return db.prepare(sql).all();
}

export { TABLES };
