/**
 * lib/work/db.mjs and errors.mjs (propagate#150, Task 1). Every test makes its own mkdtemp dir (R17): none touches the
 * real state dir or another test file's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  openDb, openDbReadOnly, dbPath, LEASE_MS, PARK_AFTER, SCHEMA_VERSION, sqliteClass, wrapEmitWarning, assertStoreSafe, defaultMountProbe,
} from "../../lib/work/db.mjs";
import { CODES, WorkError, fail } from "../../lib/work/errors.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_URL = new URL("../../lib/work/db.mjs", import.meta.url).href;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-db-"));
const rows = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r })); // node:sqlite rows have a null prototype
const thrown = (fn) => { try { fn(); } catch (e) { return e; } assert.fail("expected a throw"); };

test("constants are the specified values", () => {
  assert.equal(LEASE_MS, 30 * 60 * 1000);
  assert.equal(PARK_AFTER, 2);
  assert.equal(SCHEMA_VERSION, 1);
});

test("errors: fail throws a WorkError with code, what, next and exit; misuse throws a plain Error", () => {
  const e = thrown(() => fail("WORK_NOT_FOUND", "no such item", "propagate work list"));
  assert.ok(e instanceof WorkError);
  assert.deepEqual([e.code, e.what, e.next, e.exit], ["WORK_NOT_FOUND", "no such item", "propagate work list", 1]);
  assert.equal(e.message, "WORK_NOT_FOUND: no such item. Next: propagate work list");
  assert.deepEqual(e.toJSON(), { ok: false, code: "WORK_NOT_FOUND", what: "no such item", next: "propagate work list" });
  const bogus = thrown(() => fail("WORK_BOGUS", "x", "y"));
  assert.ok(!(bogus instanceof WorkError));
  const empty = thrown(() => fail("WORK_USAGE", "x", ""));
  assert.ok(!(empty instanceof WorkError));
  assert.equal(Object.keys(CODES).length, 12);
});

test("openDb creates work/queue.db with all tables; a second open leaves the schema unchanged", () => {
  const dir = tmp();
  const a = openDb(dir);
  assert.equal(a.created_now, true);
  assert.ok(fs.existsSync(dbPath(dir)));
  assert.equal(dbPath(dir), path.join(dir, "work", "queue.db"));
  const schema = () => rows(a.db, "SELECT type, name, sql FROM sqlite_master ORDER BY name");
  const before = schema();
  const names = before.map((r) => r.name);
  for (const n of ["work_items", "work_events", "sync_marks", "work_dedupe", "work_claimable"]) assert.ok(names.includes(n), n);
  const cols = rows(a.db, "PRAGMA table_info(work_items)").map((c) => c.name);
  for (const c of ["token", "parked_label_seen", "refusals", "claims", "lease_until"]) assert.ok(cols.includes(c), c);
  a.db.close();
  const b = openDb(dir);
  assert.equal(b.created_now, false);
  assert.deepEqual(rows(b.db, "SELECT type, name, sql FROM sqlite_master ORDER BY name"), before);
  b.db.close();
});

test("the CHECK constraint refuses an unknown state", () => {
  const { db } = openDb(tmp());
  const ins = (state) => db.prepare(
    "INSERT INTO work_items(id,kind,dedupe_key,payload,created,expires_at,state) VALUES (?,?,?,?,?,?,?)",
  ).run(`i-${state}`, "k", `d-${state}`, "{}", 1, 2, state);
  assert.equal(ins("pending").changes, 1);
  assert.throws(() => ins("bogus"), /CHECK/);
  db.close();
});

test("the dedupe index frees a key only when the holder is expired", () => {
  const { db } = openDb(tmp());
  const ins = (id, state) => db.prepare(
    "INSERT INTO work_items(id,kind,dedupe_key,payload,created,expires_at,state) VALUES (?,?,?,?,?,?,?)",
  ).run(id, "k", "k:same", "{}", 1, 2, state);
  ins("a", "pending");
  assert.throws(() => ins("b", "acked"), /UNIQUE/);
  db.prepare("UPDATE work_items SET state='expired' WHERE id='a'").run();
  assert.equal(ins("b", "pending").changes, 1);
  db.close();
});

test("busy_timeout reads back 5000 and journal_mode reads back wal; busyMs is honoured", () => {
  const { db } = openDb(tmp());
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();
  const { db: d2 } = openDb(tmp(), { busyMs: 1234 });
  assert.equal(d2.prepare("PRAGMA busy_timeout").get().timeout, 1234);
  d2.close();
});

test("a null session and null lease round-trip (binding rule: null and integers, never undefined or booleans)", () => {
  const { db } = openDb(tmp());
  db.prepare("INSERT INTO work_items(id,kind,scope,dedupe_key,payload,created,expires_at,state,session,lease_until,parked_label_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("n", "k", null, "k:n", "{}", 1, 2, "pending", null, null, 0);
  const r = { ...db.prepare("SELECT * FROM work_items WHERE id='n'").get() };
  assert.equal(r.session, null);
  assert.equal(r.scope, null);
  assert.equal(r.token, null);
  assert.equal(r.parked_label_seen, 0);
  db.close();
});

test("opening prints no ExperimentalWarning (R6), and a different warning still prints", () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, ["-e",
    `import(${JSON.stringify(DB_URL)}).then(m => { m.openDb(${JSON.stringify(dir)}).db.close(); process.emitWarning("kept", "ExperimentalWarning"); })`,
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /SQLite/);
  // Only the SQLite one is dropped: the unrelated ExperimentalWarning raised after the import still reaches stderr.
  assert.match(r.stderr, /ExperimentalWarning: kept/);
});

test("the warning filter drops only the SQLite ExperimentalWarning (R6), for string and options forms", () => {
  const seen = [];
  const emit = wrapEmitWarning((w, ...a) => seen.push([String(w?.message ?? w), a[0]?.type ?? a[0]]));
  emit("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
  emit("SQLite is an experimental feature", { type: "ExperimentalWarning" });
  const w = new Error("SQLite is an experimental feature"); w.name = "ExperimentalWarning";
  emit(w);
  assert.deepEqual(seen, [], "all three SQLite forms are dropped");
  emit("Watch mode is experimental", "ExperimentalWarning");
  emit("SQLite deprecation", "DeprecationWarning");
  emit("something else entirely");
  assert.equal(seen.length, 3, "everything that is not the SQLite ExperimentalWarning is forwarded");
});

// ---- C7 / R4: migrations ----------------------------------------------------------------------------------------

test("a new database reads user_version 1", () => {
  const { db } = openDb(tmp());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  db.close();
});

test("a database newer than the code is WORK_STORE_TOO_NEW, never opened or altered", () => {
  const dir = tmp();
  const { db } = openDb(dir);
  db.exec("PRAGMA user_version = 99");
  db.close();
  const e = thrown(() => openDb(dir));
  assert.equal(e.code, "WORK_STORE_TOO_NEW");
  assert.equal(e.exit, 2);
  const { db: raw } = { db: new (sqliteClass())(dbPath(dir)) };
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 99);
  raw.close();
});

test("a v0 database with no tables, and a 0-byte file, migrate to 1 and report created_now", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "work"));
  fs.writeFileSync(dbPath(dir), ""); // 0 bytes
  const a = openDb(dir);
  assert.equal(a.created_now, true);
  assert.equal(a.db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(rows(a.db, "SELECT name FROM sqlite_master WHERE name='work_items'").length, 1);
  a.db.close();
  const dir2 = tmp();
  fs.mkdirSync(path.join(dir2, "work"));
  const raw = new (sqliteClass())(dbPath(dir2));
  raw.exec("CREATE TABLE unrelated(x)"); // a v0 file with some other content, no work tables
  raw.close();
  const b = openDb(dir2);
  assert.equal(b.created_now, true);
  assert.equal(rows(b.db, "SELECT name FROM sqlite_master WHERE name='work_events'").length, 1);
  b.db.close();
});

test("an unreadable file (not SQLite) is WORK_STORE_UNREADABLE, exit 2", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "work"));
  fs.writeFileSync(dbPath(dir), "this is not a sqlite database, it is longer than a header".repeat(5));
  const e = thrown(() => openDb(dir));
  assert.equal(e.code, "WORK_STORE_UNREADABLE");
  assert.equal(e.exit, 2);
});

const BARRIER_CHILD = `
  const [url, dir, start] = process.argv.slice(1);
  const m = await import(url);
  while (Date.now() < Number(start)) {}
  try { const r = m.openDb(dir, { busyMs: 8000 }); console.log(JSON.stringify({ ok: true, created_now: r.created_now })); r.db.close(); }
  catch (e) { console.log(JSON.stringify({ ok: false, err: String(e.message) })); process.exit(1); }
`;

function runBarrier(dir, n = 3) {
  const start = Date.now() + 400;
  return Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", BARRIER_CHILD, DB_URL, dir, String(start)]);
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out: out.trim() }));
  })));
}

test("concurrent first opens all succeed, once-created, one schema (R4: 3 openers at a barrier, 10 rounds)", async () => {
  for (let i = 0; i < 10; i++) {
    const dir = tmp();
    const results = await runBarrier(dir);
    for (const r of results) assert.equal(r.code, 0, `round ${i}: ${r.out}`);
    assert.equal(results.filter((r) => JSON.parse(r.out).created_now).length, 1, `round ${i}: exactly one creator`);
    const { db } = openDb(dir);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(rows(db, "SELECT name FROM sqlite_master WHERE name='work_items'").length, 1);
    db.close();
  }
});

// ---- C6b: unsafe stores -----------------------------------------------------------------------------------------

test("a state dir under Library/CloudStorage or Library/Mobile Documents is WORK_STORE_UNSAFE, and so are Dropbox-style segments", () => {
  const base = tmp();
  const never = () => { throw new Error("the mount probe must not run once the path rules refuse"); };
  for (const sub of ["Library/CloudStorage/GoogleDrive-x/state", "Library/Mobile Documents/com~apple~CloudDocs/s", "Dropbox/s", "Google Drive/s", "OneDrive/s"]) {
    const e = thrown(() => openDb(path.join(base, sub), { mountProbe: never }));
    assert.equal(e.code, "WORK_STORE_UNSAFE", sub);
    assert.equal(e.exit, 2);
    assert.match(e.next, /PROPAGATE_STATE_DIR/);
    assert.ok(!fs.existsSync(path.join(base, sub)), `${sub} must not be created on refusal`);
  }
});

test("a mount probe reporting a non-local volume is WORK_STORE_UNSAFE; a probe failure warns and opens; a real temp dir passes", () => {
  const e = thrown(() => openDb(tmp(), { mountProbe: () => ({ local: false }) }));
  assert.equal(e.code, "WORK_STORE_UNSAFE");
  const probeFails = openDb(tmp(), { mountProbe: () => { throw new Error("df not found"); } });
  assert.equal(probeFails.warnings.length, 1);
  assert.match(probeFails.warnings[0], /could not run.*df not found.*not refused/);
  probeFails.db.close();
  const real = openDb(tmp());
  assert.deepEqual(real.warnings, [], "the real default probe passes on a local temp dir");
  real.db.close();
  assert.deepEqual(assertStoreSafe(tmp(), { mountProbe: () => ({ local: true }) }), []);
});

test("the mount parser reads macOS lines from the right (spaces in the mount point; no local flag) and Linux network types", () => {
  const mac = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "//user@nas on /Volumes/My Share (smbfs, nodev, nosuid, mounted by user)",
    "/dev/disk4s1 on /Volumes/My Disk (apfs, local, nodev, nosuid, journaled)",
  ].join("\n");
  const probe = (mp) => defaultMountProbe("/x", { platform: "darwin", readMounts: () => mac, mountPoint: () => mp });
  assert.equal(probe("/Volumes/My Share").local, false);
  assert.equal(probe("/Volumes/My Disk").local, true);
  assert.equal(probe("/").local, true, "read-only is not a signal; only the local flag is");
  assert.throws(() => probe("/nowhere"), /no mount entry/);
  const linux = "server:/export /mnt/nfs\\040data nfs4 rw,relatime 0 0\n/dev/sda1 / ext4 rw 0 0";
  const lp = (mp) => defaultMountProbe("/x", { platform: "linux", readMounts: () => linux, mountPoint: () => mp });
  assert.equal(lp("/mnt/nfs data").local, false);
  assert.equal(lp("/").local, true);
});

// ---- R10: node floor --------------------------------------------------------------------------------------------

test("an injected SQLite import failure is WORK_NODE_TOO_OLD naming the floor, also through openDb", () => {
  const e = thrown(() => sqliteClass(null, new Error("No such built-in module: node:sqlite")));
  assert.equal(e.code, "WORK_NODE_TOO_OLD");
  assert.equal(e.exit, 2);
  assert.match(e.what, /22\.13/);
  assert.match(e.what, /No such built-in module/);
  assert.equal(thrown(() => sqliteClass({}, null)).code, "WORK_NODE_TOO_OLD");
  assert.equal(typeof sqliteClass(), "function", "the real import resolves on this Node");
});

test("engines.node and the pinned CI floor job agree", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const m = /^>=(\d+\.\d+)$/.exec(pkg.engines.node);
  assert.ok(m, `engines.node ${pkg.engines.node} is not of the form >=MAJOR.MINOR`);
  const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
  // The job block: from its key to the next top-level job key (two-space indent) or the end. A missing block is
  // "job not found", never a pass. Pin and run step are asserted INSIDE it, so a comment elsewhere cannot satisfy them.
  const start = yml.search(/^  work-node-floor:\s*$/m);
  assert.ok(start >= 0, "job not found: test.yml has no `work-node-floor:` job");
  const after = yml.slice(start).split("\n").slice(1);
  const end = after.findIndex((l) => /^  [A-Za-z0-9_-]+:\s*$/.test(l));
  const job = after.slice(0, end < 0 ? after.length : end);
  assert.ok(job.length >= 5, `job block for work-node-floor is only ${job.length} lines: the extraction has gone blind`);
  const code = job.filter((l) => !/^\s*#/.test(l)).join("\n");
  const pin = /node-version:\s*"(\d+\.\d+\.\d+)"/.exec(code);
  assert.ok(pin, "work-node-floor has no exact node-version pin");
  assert.equal(pin[1], `${m[1]}.0`, `work-node-floor is pinned to ${pin[1]}, engines.node says ${m[1]}`);
  assert.ok(
    /^\s*(?:run:\s*)?(?:-\s*run:\s*)?.*node --test\b.*tests\/unit\/work/m.test(code),
    "work-node-floor has no run step executing `node --test tests/unit/work...`",
  );
});

// ---- C4 / R7: the read-only open --------------------------------------------------------------------------------

test("openDbReadOnly: a missing file is unknown and creates nothing", () => {
  const dir = tmp();
  const r = openDbReadOnly(dir);
  assert.deepEqual(r, { status: "unknown", reason: "no store" });
  assert.ok(!fs.existsSync(path.join(dir, "work")), "nothing may be created");
});

test("openDbReadOnly: reads rows while a writer in another process holds BEGIN IMMEDIATE, in under 100 ms", async () => {
  const dir = tmp();
  const w = openDb(dir);
  w.db.prepare("INSERT INTO work_items(id,kind,dedupe_key,payload,created,expires_at,state) VALUES ('r1','k','k:r1','{}',1,2,'pending')").run();
  w.db.close();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const m = await import(${JSON.stringify(DB_URL)});
    const { db } = m.openDb(${JSON.stringify(dir)});
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO work_items(id,kind,dedupe_key,payload,created,expires_at,state) VALUES ('r2','k','k:r2','{}',1,2,'pending')").run();
    console.log("locked");
    process.stdin.resume();
    process.stdin.on("end", () => { db.exec("ROLLBACK"); db.close(); });
  `]);
  try {
    await new Promise((res, rej) => { child.stdout.once("data", res); child.on("error", rej); });
    const t0 = performance.now();
    const r = openDbReadOnly(dir);
    assert.ok(r.db, JSON.stringify(r));
    const got = rows(r.db, "SELECT id FROM work_items ORDER BY id");
    const ms = performance.now() - t0;
    r.db.close();
    assert.deepEqual(got, [{ id: "r1" }], "the reader sees committed rows only, not the writer's pending one");
    assert.ok(ms < 100, `read-only open + select took ${ms.toFixed(1)} ms`);
  } finally {
    child.stdin.end();
    await new Promise((res) => child.on("close", res));
  }
});

test("openDbReadOnly: a newer store, and an open that throws SQLITE_BUSY, are unknown, never an empty list", () => {
  const dir = tmp();
  const { db } = openDb(dir);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.deepEqual(openDbReadOnly(dir), { status: "unknown", reason: "store too new" });
  const dir2 = tmp();
  openDb(dir2).db.close();
  const Busy = class { constructor() { throw new Error("database is locked"); } };
  const r = openDbReadOnly(dir2, { Db: Busy });
  assert.equal(r.status, "unknown");
  assert.match(r.reason, /database is locked/);
  assert.equal(r.db, undefined);
});
