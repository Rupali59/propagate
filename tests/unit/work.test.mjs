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

// ======================================================================================================================
// Task 2: queue operations (lib/work/queue.mjs)
// ======================================================================================================================
import {
  enqueue, enqueueInTx, claim, claimInTx, ack, ackInTx, release, releaseInTx, unpark, unparkInTx, expire, expireInTx, list,
  DEFAULT_TTL_MS,
} from "../../lib/work/queue.mjs";

// I4: any entry point that falls back to the real state dir fails loudly (ENOTDIR) instead of touching it.
process.env.PROPAGATE_STATE_DIR = "/dev/null/work-tests-pass-a-dir";

const clock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t }; return c; };
const mk = () => { const dir = tmp(); const c = clock(); return { dir, c, o: { stateDirPath: dir, now: c.now } }; };
const item = (key, extra = {}) => ({ kind: "evaluate", scope: "acme/hub", dedupe_key: key, payload: { n: 1 }, ttlMs: 10 * LEASE_MS, ...extra });
const events = (dir) => {
  const { db } = openDb(dir);
  try { return rows(db, "SELECT seq, id, op, session, detail FROM work_events ORDER BY seq"); } finally { db.close(); }
};
const itemRows = (dir) => {
  const { db } = openDb(dir);
  try { return rows(db, "SELECT * FROM work_items ORDER BY created, id"); } finally { db.close(); }
};

test("queue: a second enqueue with the same key is created:false with one row; after expire the key enqueues anew", () => {
  const { dir, o } = mk();
  const a = enqueue(item("evaluate:github.com/acme/x"), o);
  assert.equal(a.created, true);
  assert.equal(a.item.state, "pending");
  assert.equal(a.item.payload, JSON.stringify({ n: 1 }));
  const b = enqueue(item("evaluate:github.com/acme/x"), o);
  assert.equal(b.created, false);
  assert.equal(b.item.id, a.item.id);
  assert.equal(itemRows(dir).length, 1);
  expire(a.item.id, { reason: "issue closed" }, o);
  const c = enqueue(item("evaluate:github.com/acme/x"), o);
  assert.equal(c.created, true);
  assert.notEqual(c.item.id, a.item.id);
  assert.equal(itemRows(dir).length, 2);
});

test("queue: the default ttl and the default id shape", () => {
  const { o, c } = mk();
  const { item: it } = enqueue({ kind: "evaluate", dedupe_key: "k1" }, o);
  assert.equal(it.expires_at, c.t + DEFAULT_TTL_MS);
  assert.match(it.id, /^w_[0-9a-z]+_[0-9a-f]{12}$/);
  assert.equal(it.scope, null);
  const x = enqueue({ kind: "evaluate", dedupe_key: "k2", newId: () => "w_fixed" }, o);
  assert.equal(x.item.id, "w_fixed");
});

test("queue: claim on an empty queue returns null, and a claim of another kind does not see the item", () => {
  const { o } = mk();
  assert.equal(claim({ kind: "evaluate", session: "s1" }, o), null);
  enqueue(item("k1"), o);
  assert.equal(claim({ kind: "other", session: "s1" }, o), null);
});

test("queue: FIFO, the older item is claimed first", () => {
  const { o, c } = mk();
  const first = enqueue(item("k-old"), o).item;
  c.t += 5;
  const second = enqueue(item("k-new"), o).item;
  assert.equal(claim({ kind: "evaluate", session: "s1" }, o).id, first.id);
  assert.equal(claim({ kind: "evaluate", session: "s2" }, o).id, second.id);
  assert.equal(claim({ kind: "evaluate", session: "s3" }, o), null);
});

test("queue: claim returns state claimed, a lease, a token and claims+1", () => {
  const { o, c } = mk();
  enqueue(item("k1"), o);
  const got = claim({ kind: "evaluate", session: "s1" }, o);
  assert.equal(got.state, "claimed");
  assert.equal(got.session, "s1");
  assert.equal(got.lease_until, c.t + LEASE_MS);
  assert.equal(got.claims, 1);
  assert.match(got.token, /^[0-9a-f-]{20,}$/);
});

test("queue P3: a late ack after a re-claim is WORK_LEASE_EXPIRED naming `work list --kind`; the new claimant owns it", () => {
  const { dir, o, c } = mk();
  const it = enqueue(item("k1"), o).item;
  const a = claim({ kind: "evaluate", session: "A" }, o);
  c.t += LEASE_MS + 1;
  const b = claim({ kind: "evaluate", session: "B" }, o);
  assert.equal(b.id, it.id);
  assert.equal(b.claims, 2);
  assert.notEqual(b.token, a.token);
  const e = thrown(() => ack(it.id, { session: "A", token: a.token }, o));
  assert.ok(e instanceof WorkError);
  assert.equal(e.code, "WORK_LEASE_EXPIRED");
  assert.match(e.next, /propagate work list --kind evaluate/);
  assert.match(e.next, /before redoing any side effect/);
  assert.equal(itemRows(dir)[0].state, "claimed");
  assert.equal(ack(it.id, { session: "B", token: b.token }, o).state, "acked");
});

test("queue P3: an expired lease nobody re-claimed still accepts its own token, for ack and for a refusal", () => {
  const { o, c } = mk();
  const i1 = enqueue(item("k1"), o).item;
  const a1 = claim({ kind: "evaluate", session: "A" }, o);
  c.t += LEASE_MS + 10;
  assert.equal(ack(i1.id, { session: "A", token: a1.token }, o).state, "acked");
  c.t += 5;
  const i2 = enqueue(item("k2"), o).item;
  const a2 = claim({ kind: "evaluate", session: "A" }, o);
  c.t += LEASE_MS + 10;
  const r = release(i2.id, { session: "A", token: a2.token, refusal: true, reason: "not a fit" }, o);
  assert.equal(r.refusals, 1);
  assert.equal(r.state, "pending");
});

test("queue R11: two lanes sharing one session id are fenced by token", () => {
  const { o, c } = mk();
  const it = enqueue(item("k1"), o).item;
  const lane1 = claim({ kind: "evaluate", session: "S" }, o);
  c.t += LEASE_MS + 1;
  const lane2 = claim({ kind: "evaluate", session: "S" }, o);
  assert.equal(lane2.claims, 2);
  const e = thrown(() => ack(it.id, { session: "S", token: lane1.token }, o));
  assert.equal(e.code, "WORK_LEASE_EXPIRED");
  assert.equal(ack(it.id, { session: "S", token: lane2.token }, o).state, "acked");
});

test("queue: ack by the wrong session is WORK_NOT_CLAIMANT; an unknown id is WORK_NOT_FOUND", () => {
  const { o } = mk();
  const it = enqueue(item("k1"), o).item;
  const a = claim({ kind: "evaluate", session: "A" }, o);
  const e = thrown(() => ack(it.id, { session: "B", token: "made-up" }, o));
  assert.equal(e.code, "WORK_NOT_CLAIMANT");
  const e2 = thrown(() => ack(it.id, { session: "B", token: a.token }, o));
  assert.equal(e2.code, "WORK_NOT_CLAIMANT");
  const e3 = thrown(() => ack("w_nope", { session: "A", token: a.token }, o));
  assert.equal(e3.code, "WORK_NOT_FOUND");
  const e4 = thrown(() => ack(it.id, { session: "A", token: "wrong" }, o));
  assert.equal(e4.code, "WORK_NOT_CLAIMANT");
});

test("queue R18: a double ack with the same token is idempotent (already:true) and writes no second event", () => {
  const { dir, o } = mk();
  const it = enqueue(item("k1"), o).item;
  const a = claim({ kind: "evaluate", session: "A" }, o);
  const first = ack(it.id, { session: "A", token: a.token }, o);
  assert.equal(first.already, undefined);
  const again = ack(it.id, { session: "A", token: a.token }, o);
  assert.equal(again.state, "acked");
  assert.equal(again.already, true);
  assert.equal(events(dir).filter((e) => e.op === "ack").length, 1);
  const other = thrown(() => ack(it.id, { session: "A", token: "another" }, o));
  assert.equal(other.code, "WORK_NOT_CLAIMANT");
});

test("queue R12: ack or release of an item past its ttl is WORK_ITEM_EXPIRED (issue closed, nothing to do)", () => {
  const { o, c } = mk();
  const it = enqueue(item("k1", { ttlMs: 1000 }), o).item;
  const a = claim({ kind: "evaluate", session: "A" }, o);
  c.t += 2000;
  const e = thrown(() => ack(it.id, { session: "A", token: a.token }, o));
  assert.equal(e.code, "WORK_ITEM_EXPIRED");
  assert.match(e.next, /nothing to do/);
  assert.equal(thrown(() => release(it.id, { session: "A", token: a.token }, o)).code, "WORK_ITEM_EXPIRED");
  // and an item the sync expired explicitly
  c.t = 1_000_000;
  const it2 = enqueue(item("k2"), o).item;
  const a2 = claim({ kind: "evaluate", session: "A" }, o);
  expire(it2.id, { reason: "issue closed" }, o);
  assert.equal(thrown(() => ack(it2.id, { session: "A", token: a2.token }, o)).code, "WORK_ITEM_EXPIRED");
});

test("queue: two refusals park the item, claim skips it, unpark makes it claimable again", () => {
  const { o } = mk();
  const it = enqueue(item("k1"), o).item;
  let g = claim({ kind: "evaluate", session: "A" }, o);
  let r = release(it.id, { session: "A", token: g.token, refusal: true, reason: "no" }, o);
  assert.deepEqual([r.state, r.refusals, r.session, r.token, r.lease_until], ["pending", 1, null, null, null]);
  g = claim({ kind: "evaluate", session: "B" }, o);
  r = release(it.id, { session: "B", token: g.token, refusal: true }, o);
  assert.deepEqual([r.state, r.refusals], ["parked", PARK_AFTER]);
  assert.equal(claim({ kind: "evaluate", session: "C" }, o), null);
  const u = unpark(it.id, o);
  assert.equal(u.state, "pending");
  assert.equal(claim({ kind: "evaluate", session: "C" }, o).id, it.id);
});

test("queue: a non-refusal release returns the item to pending with refusals unchanged", () => {
  const { o } = mk();
  const it = enqueue(item("k1"), o).item;
  const g = claim({ kind: "evaluate", session: "A" }, o);
  const r = release(it.id, { session: "A", token: g.token }, o);
  assert.deepEqual([r.state, r.refusals], ["pending", 0]);
  assert.equal(thrown(() => release(it.id, { session: "A", token: g.token }, o)).code, "WORK_LEASE_EXPIRED");
});

test("queue: every transition writes exactly one work_events row with its op", () => {
  const { dir, o, c } = mk();
  const it = enqueue(item("k1"), o).item;
  enqueue(item("k1"), o); // a conflict is not a transition
  const g1 = claim({ kind: "evaluate", session: "A" }, o);
  release(it.id, { session: "A", token: g1.token, refusal: true, reason: "r1" }, o);
  const g2 = claim({ kind: "evaluate", session: "B" }, o);
  release(it.id, { session: "B", token: g2.token, refusal: true, reason: "r2" }, o);
  unpark(it.id, o);
  const g3 = claim({ kind: "evaluate", session: "C" }, o);
  ack(it.id, { session: "C", token: g3.token }, o);
  const it2 = enqueue(item("k2"), o).item;
  expire(it2.id, { reason: "issue closed" }, o);
  assert.deepEqual(
    events(dir).map((e) => [e.id === it.id ? "i1" : "i2", e.op, e.session]),
    [["i1", "enqueue", null], ["i1", "claim", "A"], ["i1", "release", "A"], ["i1", "claim", "B"], ["i1", "release", "B"],
      ["i1", "unpark", null], ["i1", "claim", "C"], ["i1", "ack", "C"], ["i2", "enqueue", null], ["i2", "expire", null]],
  );
  assert.equal(JSON.parse(events(dir).find((e) => e.op === "expire").detail).reason, "issue closed");
  assert.equal(JSON.parse(events(dir).filter((e) => e.op === "release")[1].detail).parked, true);
  assert.ok(c.t > 0);
});

test("queue: a null session and a null scope round-trip (every optional is bound as null, never undefined)", () => {
  const { dir, o } = mk();
  const it = enqueue({ kind: "evaluate", dedupe_key: "k1", payload: undefined, scope: undefined, ttlMs: undefined }, o).item;
  assert.equal(it.scope, null);
  assert.equal(it.payload, "{}");
  const g = claim({ kind: "evaluate", session: undefined }, o);
  assert.equal(g.session, null);
  assert.equal(events(dir).find((e) => e.op === "claim").session, null);
  const a = ack(it.id, { session: null, token: g.token }, o);
  assert.equal(a.state, "acked");
  assert.equal(a.session, null);
  // flags bind as integers: a refusal given as a boolean and as a truthy non-boolean both work
  const i2 = enqueue(item("k2"), o).item;
  const g2 = claim({ kind: "evaluate", session: "A" }, o);
  assert.equal(release(i2.id, { session: "A", token: g2.token, refusal: true, reason: undefined }, o).refusals, 1);
});

test("queue: list reports effective_state, pending for an expired lease and expired past the ttl; plain objects", () => {
  const { dir, o, c } = mk();
  const a = enqueue(item("k-a"), o).item;
  c.t += 1;
  const b = enqueue(item("k-b", { ttlMs: LEASE_MS * 2 }), o).item;
  c.t += 1;
  enqueue(item("k-c", { kind: "other" }), o);
  claim({ kind: "evaluate", session: "A" }, o);
  claim({ kind: "evaluate", session: "A" }, o);
  const eff = () => Object.fromEntries(list({ kind: "evaluate" }, o).map((r) => [r.id, r.effective_state]));
  assert.deepEqual(eff(), { [a.id]: "claimed", [b.id]: "claimed" });
  c.t += LEASE_MS + 1;
  assert.deepEqual(eff(), { [a.id]: "pending", [b.id]: "pending" });
  c.t += LEASE_MS; // past b's ttl
  assert.deepEqual(eff(), { [a.id]: "pending", [b.id]: "expired" });
  assert.deepEqual(list({ kind: "evaluate", state: "expired" }, o).map((r) => r.id), [b.id]);
  assert.deepEqual(list({ state: "pending" }, o).map((r) => r.id).sort(), [a.id, list({ kind: "other" }, o)[0].id].sort());
  const r0 = list({ kind: "evaluate" }, o)[0];
  assert.equal(Object.getPrototypeOf(r0), Object.prototype);
  // a read-only handle (R7)
  const ro = openDbReadOnly(dir);
  assert.ok(ro.db);
  try { assert.equal(list({ kind: "evaluate" }, { db: ro.db, now: c.now }).length, 2); } finally { ro.db.close(); }
});

test("queue R8: the *InTx forms run inside the caller's transaction and open none; a rollback undoes row and event", () => {
  const dir = tmp();
  const c = clock();
  const { db } = openDb(dir);
  try {
    db.exec("BEGIN IMMEDIATE");
    const { item: it, created } = enqueueInTx(db, item("k1"), { now: c.now });
    assert.equal(created, true);
    const g = claimInTx(db, { kind: "evaluate", session: "A" }, { now: c.now });
    assert.equal(g.id, it.id);
    assert.equal(ackInTx(db, it.id, { session: "A", token: g.token }, { now: c.now }).state, "acked");
    const it2 = enqueueInTx(db, item("k2"), { now: c.now }).item;
    const g2 = claimInTx(db, { kind: "evaluate", session: "A" }, { now: c.now });
    assert.equal(releaseInTx(db, it2.id, { session: "A", token: g2.token, refusal: true }, { now: c.now }).refusals, 1);
    assert.equal(expireInTx(db, it2.id, { reason: "x" }, { now: c.now }).state, "expired");
    const it3 = enqueueInTx(db, item("k3"), { now: c.now }).item;
    claimInTx(db, { kind: "evaluate", session: "A" }, { now: c.now });
    assert.ok(it3);
    assert.equal(rows(db, "SELECT * FROM work_events").length > 0, true);
    db.exec("ROLLBACK");
    assert.equal(rows(db, "SELECT * FROM work_items").length, 0);
    assert.equal(rows(db, "SELECT * FROM work_events").length, 0);
    // unparkInTx on a parked item
    db.exec("BEGIN IMMEDIATE");
    const p = enqueueInTx(db, item("kp"), { now: c.now }).item;
    for (const s of ["A", "B"]) {
      const g = claimInTx(db, { kind: "evaluate", session: s }, { now: c.now });
      releaseInTx(db, p.id, { session: s, token: g.token, refusal: true }, { now: c.now });
    }
    assert.equal(unparkInTx(db, p.id, { now: c.now }).state, "pending");
    db.exec("COMMIT");
  } finally { db.close(); }
});

test("queue: unpark of a missing id is WORK_NOT_FOUND, of a non-parked item WORK_USAGE; expire of an expired item is a no-op", () => {
  const { dir, o } = mk();
  assert.equal(thrown(() => unpark("w_nope", o)).code, "WORK_NOT_FOUND");
  assert.equal(thrown(() => expire("w_nope", { reason: "x" }, o)).code, "WORK_NOT_FOUND");
  const it = enqueue(item("k1"), o).item;
  assert.equal(thrown(() => unpark(it.id, o)).code, "WORK_USAGE");
  expire(it.id, { reason: "a" }, o);
  const again = expire(it.id, { reason: "b" }, o);
  assert.equal(again.state, "expired");
  assert.equal(events(dir).filter((e) => e.op === "expire").length, 1);
});

test("R17 guard: no work test file uses the shared state dir (floor: files scanned)", () => {
  const unitDir = path.join(ROOT, "tests", "unit");
  const files = fs.readdirSync(unitDir).filter((f) => /^work(-[\w-]+)?\.test\.mjs$/.test(f));
  // The real number of work test files, named so a stray match (workspace-resolve, worktrees) cannot satisfy it.
  const EXPECTED = ["work-claim-race.test.mjs", "work-cli.test.mjs", "work-sync.test.mjs", "work.test.mjs"];
  assert.ok(files.length >= 4, `only ${files.length} work test files found, the scan has gone blind`);
  assert.deepEqual([...files].sort(), EXPECTED, "the work test files are not the expected set: update EXPECTED with the new file");
  const shared = ["propagate", "test", "state"].join("-"); // built, so this guard does not match itself
  for (const f of files) {
    const src = fs.readFileSync(path.join(unitDir, f), "utf8");
    assert.ok(!src.includes(shared), `${f} uses the shared state dir`);
    assert.ok(src.includes('process.env.PROPAGATE_STATE_DIR = "/dev/null/'), `${f} does not set the unwritable state-dir sentinel`);
    // a call with no dir falls back to the real state dir (no-argument openDb, list with no opts); comments are not calls
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const bare = [...code.matchAll(/\bopenDb\(\s*\)|(?<![.\w])list\(\s*(?:\{[^{}]*\})?\s*\)/g)].map((m) => m[0]);
    assert.deepEqual(bare, [], `${f} calls openDb or list without a state dir`);
  }
});

test("R17 runtime guard: with the sentinel state dir, an entry point that forgets its dir fails loudly", () => {
  assert.match(process.env.PROPAGATE_STATE_DIR, /^\/dev\/null\//);
  assert.throws(() => Reflect.apply(openDb, null, []),/ENOTDIR|not a directory|EACCES|ENOENT|WORK_/i);
});
