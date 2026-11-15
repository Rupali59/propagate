/**
 * The work queue's database (propagate#150): one SQLite file, `<state dir>/work/queue.db`, WAL, with a busy timeout and
 * versioned migrations. `node:sqlite` is experimental on the 22.x line, so this module is the one place that loads it.
 *
 * Facts this file leans on (Node docs read 2026-11-15, and measured):
 *  - `DatabaseSync` was renamed `Database` in v26.11.0 and stays as an alias; `Database` does not exist on 22.x.
 *  - the `timeout` constructor option is v22.16+, so the busy timeout is set with a PRAGMA, which works on 22.13.
 *  - binding `undefined` or a boolean fails on 22.x: bind `null` and integers.
 *  - WAL readers never wait on a writer.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stateDir } from "../core/paths.mjs";
import { fail, WorkError } from "./errors.mjs";

export const LEASE_MS = 30 * 60 * 1000;
export const PARK_AFTER = 2;
export const SCHEMA_VERSION = 1;

// R6: drop ONLY node:sqlite's ExperimentalWarning. A `process.on("warning")` listener cannot stop Node's default print,
// so the filter wraps emitWarning for the duration of the import and restores it in `finally`. Every other warning,
// including other ExperimentalWarnings, still prints.
let sqlite = null;
let sqliteLoadError = null;

/**
 * The filter, exported so it is testable on a Node that prints no SQLite warning at all (26.x does not): returns an
 * `emitWarning` that drops ExperimentalWarnings whose message names SQLite and forwards everything else to `original`.
 */
export function wrapEmitWarning(original) {
  return function (warning, ...args) {
    const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
    const message = typeof warning === "string" ? warning : warning?.message;
    const name = typeof warning === "object" && warning ? warning.name : undefined;
    if ((type === "ExperimentalWarning" || name === "ExperimentalWarning") && /SQLite/.test(message ?? "")) return;
    return original.call(this, warning, ...args);
  };
}

{
  const original = process.emitWarning;
  process.emitWarning = wrapEmitWarning(original);
  try {
    sqlite = await import("node:sqlite");
  } catch (e) {
    sqliteLoadError = e;
  } finally {
    process.emitWarning = original;
  }
}

/** R10: the SQLite import failing is an old Node, never an untyped crash. Both arguments are injectable for tests. */
export function sqliteClass(mod = sqlite, loadError = sqliteLoadError) {
  const Db = mod?.Database ?? mod?.DatabaseSync;
  if (!Db) {
    fail(
      "WORK_NODE_TOO_OLD",
      `node:sqlite is not available on Node ${process.versions.node}${loadError ? ` (${loadError.message})` : ""}; the work queue needs Node >= 22.13`,
      "upgrade Node to 22.13 or later",
    );
  }
  return Db;
}

/** `<dir>/work/queue.db`. */
export function dbPath(dir = stateDir()) {
  return path.join(dir, "work", "queue.db");
}

// ---- C6b: the store must not live on a synced folder or a network volume -----------------------------------------

const SYNCED_PAIRS = [["Library", "Mobile Documents"], ["Library", "CloudStorage"]];
const SYNCED_SEGMENTS = new Set(["Dropbox", "Google Drive", "OneDrive"]);
const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smbfs", "smb3", "afpfs", "webdav", "davfs"]);

/** The real path of `p`, resolving the nearest existing ancestor and appending the rest. */
function realPathLoose(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** The synced-folder path rules, the primary check: no filesystem type can reveal iCloud, it is a local APFS volume. */
export function syncedFolderHit(realPath) {
  const segs = realPath.split(path.sep).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (SYNCED_SEGMENTS.has(segs[i])) return segs[i];
    if (SYNCED_PAIRS.some(([a, b]) => segs[i] === a && segs[i + 1] === b)) return `${segs[i]}/${segs[i + 1]}`;
  }
  return null;
}

/** The mount point of the volume holding `p`: `df -P`, whose last column is the mount point (it may hold spaces). */
function mountPointOf(p) {
  const out = execFileSync("df", ["-P", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const line = out.trim().split("\n").at(-1);
  const m = /\s\d+%\s+(.*)$/.exec(line);
  if (!m) throw new Error(`cannot read a mount point from df output: ${line}`);
  return m[1];
}

/**
 * Is the volume holding `p` local? `{local: true|false, detail}`. Throws when it cannot tell. Lines are parsed from the
 * right because a mount point may hold spaces, and nothing keys on `read-only`.
 */
export function defaultMountProbe(p, { platform = process.platform, readMounts, mountPoint = mountPointOf } = {}) {
  const mp = mountPoint(p);
  if (platform === "darwin") {
    const out = readMounts ? readMounts() : execFileSync("mount", { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const open = line.lastIndexOf(" (");
      if (open < 0 || !line.endsWith(")")) continue;
      const head = line.slice(0, open);
      if (!head.endsWith(` on ${mp}`)) continue;
      const flags = line.slice(open + 2, -1).split(",").map((s) => s.trim());
      return { local: flags.includes("local"), detail: line };
    }
    throw new Error(`no mount entry for ${mp}`);
  }
  if (platform === "linux") {
    const out = readMounts ? readMounts() : fs.readFileSync("/proc/mounts", "utf8");
    for (const line of out.split("\n")) {
      const f = line.split(" ");
      if (f.length < 6) continue;
      const mpHere = f[f.length - 5].replace(/\\040/g, " ");
      if (mpHere !== mp) continue;
      const type = f[f.length - 4];
      return { local: !NETWORK_FS.has(type), detail: line };
    }
    throw new Error(`no mount entry for ${mp}`);
  }
  throw new Error(`no mount probe for platform ${platform}`);
}

/**
 * Refuse a state dir on a synced folder or a network volume (WORK_STORE_UNSAFE); WAL is not safe there. If the mount
 * probe cannot run, return a warning instead of refusing, and say so. Returns the warnings.
 * @returns {string[]}
 */
export function assertStoreSafe(dir, { mountProbe = defaultMountProbe } = {}) {
  const real = realPathLoose(dir);
  const next = "set PROPAGATE_STATE_DIR to a directory on a local disk outside any synced folder";
  const hit = syncedFolderHit(real);
  if (hit) fail("WORK_STORE_UNSAFE", `the state dir ${real} is inside a synced folder (${hit}); WAL is unsafe there`, next);
  // The probe needs an existing path.
  let probePath = real;
  while (!fs.existsSync(probePath) && path.dirname(probePath) !== probePath) probePath = path.dirname(probePath);
  try {
    const r = mountProbe(probePath);
    if (r.local === false) {
      fail("WORK_STORE_UNSAFE", `the state dir ${real} is on a network volume; WAL is unsafe there`, next);
    }
  } catch (e) {
    if (e instanceof WorkError) throw e;
    return [`store safety probe could not run (${e.message}); the state dir was not refused`];
  }
  return [];
}

// ---- schema and migrations ---------------------------------------------------------------------------------------

/** Ordered migrations: MIGRATIONS[n] takes a database from version n to n + 1. */
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT,
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','claimed','acked','expired','parked')),
        session TEXT,
        lease_until INTEGER,
        claims INTEGER NOT NULL DEFAULT 0,
        refusals INTEGER NOT NULL DEFAULT 0,
        token TEXT,
        parked_label_seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS work_dedupe ON work_items(dedupe_key) WHERE state <> 'expired';
      CREATE INDEX IF NOT EXISTS work_claimable ON work_items(kind, state, created);
      CREATE TABLE IF NOT EXISTS work_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        op TEXT NOT NULL,
        at INTEGER NOT NULL,
        session TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_marks (
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY(kind, scope)
      );
    `);
  },
];

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const isBusy = (e) => /locked|busy/i.test(String(e?.message ?? e));

/** R4: WAL conversion takes a lock; retry it while another opener holds the lock, until the busy budget runs out. */
function enableWal(db, busyMs) {
  const deadline = Date.now() + busyMs;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      sleepMs(5);
    }
  }
}

/**
 * Open (creating if needed) the queue database. `created_now` is true when `user_version` read 0 inside the migration
 * transaction, so a 0-byte or v0 file also reports an unknown history. Idempotent, and safe for concurrent first opens.
 * `warnings` carries non-refusing notes (a mount probe that could not run).
 * @returns {{db: object, created_now: boolean, warnings: string[]}}
 */
export function openDb(dir = stateDir(), { busyMs = 5000, mountProbe, Db } = {}) {
  const Database = Db ?? sqliteClass();
  const warnings = assertStoreSafe(dir, mountProbe ? { mountProbe } : undefined);
  const file = dbPath(dir);
  let db;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    const ms = Math.max(0, Math.trunc(Number(busyMs)));
    db.exec(`PRAGMA busy_timeout = ${ms}`); // FIRST: everything below may wait on another opener
    enableWal(db, ms);
    let createdNow = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      let v = db.prepare("PRAGMA user_version").get().user_version;
      if (v > SCHEMA_VERSION) {
        fail(
          "WORK_STORE_TOO_NEW",
          `${file} is schema version ${v}, newer than this code's ${SCHEMA_VERSION}`,
          "upgrade propagate, or point PROPAGATE_STATE_DIR at another directory",
        );
      }
      createdNow = v === 0;
      if (v < SCHEMA_VERSION) {
        for (; v < SCHEMA_VERSION; v++) MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); // last, so a failed migration leaves the old version; never written when current (M1: a read-only command must not change bytes)
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction left to roll back */ }
      throw e;
    }
    return { db, created_now: createdNow, warnings };
  } catch (e) {
    try { db?.close(); } catch { /* already closed */ }
    if (e instanceof WorkError) throw e;
    return fail(
      "WORK_STORE_UNREADABLE",
      `cannot open ${file}: ${e.message}`,
      "check the file is a SQLite database and not locked by a stuck process, or set PROPAGATE_STATE_DIR elsewhere",
    );
  }
}

/**
 * R7: a reader that never waits and never creates the database. WAL readers do not block on a writer, so this returns
 * rows promptly even while a writer holds BEGIN IMMEDIATE. A missing file, a newer schema, or any open or read error is
 * `{status: "unknown", reason}`, never an empty list. `-wal` and `-shm` creation is accepted: they are state files.
 * @returns {{db: object} | {status: "unknown", reason: string}}
 */
export function openDbReadOnly(dir = stateDir(), { Db } = {}) {
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return { status: "unknown", reason: "no store" };
  let db;
  try {
    const Database = Db ?? sqliteClass();
    db = new Database(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 0");
    const v = db.prepare("PRAGMA user_version").get().user_version;
    if (v > SCHEMA_VERSION) {
      db.close();
      return { status: "unknown", reason: "store too new" };
    }
    if (v === 0) {
      db.close();
      return { status: "unknown", reason: "store not initialised" };
    }
    return { db };
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    return { status: "unknown", reason: `cannot read store: ${e.message}` };
  }
}
