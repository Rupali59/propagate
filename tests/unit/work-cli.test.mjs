/**
 * cli/work.mjs and lib/work/prune.mjs (propagate#150, Task 4). Every test makes its own mkdtemp dir and passes it as
 * stateDirPath (R17); the gh seam is an injected stub, never the real gh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { workCmd } from "../../cli/work.mjs";
import { openDb } from "../../lib/work/db.mjs";
import { enqueue, claim, ack, release, expire } from "../../lib/work/queue.mjs";
import { prune } from "../../lib/work/prune.mjs";

// I4: any entry point that falls back to the real state dir fails loudly (ENOTDIR) instead of touching it.
process.env.PROPAGATE_STATE_DIR = "/dev/null/work-tests-pass-a-dir";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-cli-"));
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 1);

/** Runs workCmd with captured io; returns {code, out, err, json}. */
async function cli(argv, inject = {}) {
  const out = [];
  const err = [];
  const io = { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) };
  const code = await workCmd(argv, { io, now: () => T0, env: { CLAUDE_CODE_SESSION_ID: "sess-A" }, ...inject });
  const text = out.join("\n");
  let json = null;
  if (argv.includes("--json")) { try { json = JSON.parse(text); } catch { /* not json */ } }
  return { code, out: text, err: err.join("\n"), json };
}

const stub = (issues, labels = ["kind:evaluate"]) => (args) => {
  if (args[0] === "label") return { status: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: "" };
  return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
};
const issue = (number, body) => ({ number, title: `issue ${number}`, body, labels: [{ name: "kind:evaluate" }] });

async function seed(dir, n = 1) {
  const r = await cli(["sync", "--kind", "evaluate", "--hub", "acme/hub", "--json"], {
    stateDirPath: dir,
    gh: stub(Array.from({ length: n }, (_, i) => issue(i + 1, `see https://example.com/tool-${i + 1}`))),
  });
  assert.equal(r.code, 0, r.err);
  return r;
}

test("list on a fresh state dir: 0 items, created_now, exit 0; text prints the store-created line", async () => {
  const dir = tmp();
  const j = await cli(["list", "--json"], { stateDirPath: dir });
  assert.equal(j.code, 0);
  assert.deepEqual([j.json.items, j.json.created_now], [[], true]);
  const dir2 = tmp();
  const t = await cli(["list"], { stateDirPath: dir2 });
  assert.equal(t.code, 0);
  assert.match(t.out, /store created now: acked\/parked history before this point is not known/);
  assert.match(t.out, /^0 work items$/m);
  // the second list on the same dir is not "created now"
  const again = await cli(["list", "--json"], { stateDirPath: dir2 });
  assert.equal(again.json.created_now, false);
});

test("sync, claim, list, ack, double ack: the happy path and its exit codes", async () => {
  const dir = tmp();
  const s = await seed(dir);
  assert.equal(s.json.enqueued, 1);
  assert.equal(s.json.created_now, true);

  const c = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir });
  assert.equal(c.code, 0);
  assert.equal(c.json.item.state, "claimed");
  assert.ok(c.json.item.token, "claim --json carries the token");
  const text = await cli(["claim", "--kind", "evaluate"], { stateDirPath: dir });
  assert.equal(text.out, "nothing pending for evaluate");

  const a = await cli(["ack", c.json.item.id, "--token", c.json.item.token], { stateDirPath: dir });
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^acked /);
  const again = await cli(["ack", c.json.item.id, "--token", c.json.item.token, "--json"], { stateDirPath: dir });
  assert.equal(again.code, 0);
  assert.equal(again.json.already, true);
});

test("list never prints a claim's token, in text or in --json", async () => {
  const dir = tmp();
  await seed(dir);
  const c = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir });
  const token = c.json.item.token;
  for (const argv of [["list"], ["list", "--json"], ["list", "--kind", "evaluate", "--state", "claimed", "--json"]]) {
    const r = await cli(argv, { stateDirPath: dir });
    assert.equal(r.code, 0);
    assert.ok(!r.out.includes(token) && !r.err.includes(token), `${argv.join(" ")} leaked the token`);
    assert.ok(!/"token"/.test(r.out), `${argv.join(" ")} has a token key`);
  }
  const r = await cli(["list", "--json"], { stateDirPath: dir });
  assert.equal(r.json.items[0].effective_state, "claimed");
});

test("claim with no session is exit 2 WORK_USAGE", async () => {
  const dir = tmp();
  await seed(dir);
  const r = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir, env: {} });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, "WORK_USAGE");
});

test("ack by the wrong session is exit 1 WORK_NOT_CLAIMANT", async () => {
  const dir = tmp();
  await seed(dir);
  const c = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir });
  const r = await cli(["ack", c.json.item.id, "--token", c.json.item.token, "--session", "sess-B", "--json"], { stateDirPath: dir });
  assert.equal(r.code, 1);
  assert.equal(r.json.code, "WORK_NOT_CLAIMANT");
  assert.ok(r.json.next);
  const noToken = await cli(["ack", c.json.item.id], { stateDirPath: dir });
  assert.equal(noToken.code, 2);
  assert.match(noToken.err, /^WORK_USAGE: --token is required/);
});

test("release --refusal twice parks the item; unpark returns it; unpark of a pending item is exit 2", async () => {
  const dir = tmp();
  await seed(dir);
  let parkedId;
  for (let i = 0; i < 2; i++) {
    const c = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir });
    const r = await cli(["release", c.json.item.id, "--token", c.json.item.token, "--refusal", "--reason", "no fit", "--json"], { stateDirPath: dir });
    assert.equal(r.code, 0, r.err);
    parkedId = c.json.item.id;
    assert.ok(!("token" in r.json.item));
  }
  const l = await cli(["list", "--state", "parked", "--json"], { stateDirPath: dir });
  assert.equal(l.json.items.length, 1);
  const u = await cli(["unpark", parkedId], { stateDirPath: dir });
  assert.equal(u.code, 0, u.err);
  const bad = await cli(["unpark", parkedId, "--json"], { stateDirPath: dir });
  assert.equal(bad.code, 2);
  assert.equal(bad.json.code, "WORK_USAGE");
});

test("sync: a missing label is stated, exit 0; a gh failure is WORK_GITHUB_FAILED exit 2; no hub is WORK_HUB_UNKNOWN", async () => {
  const dir = tmp();
  const missing = await cli(["sync", "--kind", "evaluate", "--hub", "acme/hub"], { stateDirPath: dir, gh: stub([], ["bug"]) });
  assert.equal(missing.code, 0);
  assert.match(missing.out, /label kind:evaluate does not exist on acme\/hub: looked at nothing/);
  const down = await cli(["sync", "--kind", "evaluate", "--hub", "acme/hub", "--json"], { stateDirPath: dir, gh: () => ({ status: 1, stdout: "", stderr: "boom" }) });
  assert.equal(down.code, 2);
  assert.equal(down.json.code, "WORK_GITHUB_FAILED");
  const noHub = await cli(["sync", "--kind", "evaluate", "--json"], { stateDirPath: dir, hub: "not a repo", gh: stub([]) });
  assert.equal(noHub.code, 2);
  assert.equal(noHub.json.code, "WORK_HUB_UNKNOWN");
  const noKind = await cli(["sync", "--hub", "acme/hub"], { stateDirPath: dir, gh: stub([]) });
  assert.equal(noKind.code, 2);
});

test("an unknown argument or subcommand is exit 2 WORK_USAGE", async () => {
  const dir = tmp();
  for (const argv of [["list", "--bogus"], ["frobnicate"], [], ["list", "extra"], ["ack"], ["claim", "--kind"]]) {
    const r = await cli(argv, { stateDirPath: dir });
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /^WORK_USAGE: /, argv.join(" "));
  }
  const j = await cli(["list", "--bogus", "--json"], { stateDirPath: dir });
  assert.deepEqual(Object.keys(j.json), ["ok", "code", "what", "next"]);
});

test("workCmd with no stateDirPath, under the sentinel, fails loudly: exit 2 and a WORK_ code, never 0", async () => {
  for (const argv of [["list"], ["claim", "--kind", "evaluate"], ["prune"]]) {
    const r = await cli(argv, {});
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, /^WORK_[A-Z_]+: /, argv.join(" "));
  }
});

test("openDb warnings are printed on stderr and carried in --json", async () => {
  const dir = tmp();
  const probe = () => { throw new Error("df exploded"); };
  const o = openDb(tmp(), { mountProbe: probe });
  const had = o.warnings.length > 0;
  o.db.close();
  assert.ok(had, "the probe failure must produce a warning (Task 1 contract)");
  const realOpen = (d, opts) => openDb(d, { ...opts, mountProbe: probe });
  const t = await cli(["claim", "--kind", "evaluate"], { stateDirPath: dir, openDb: realOpen });
  assert.match(t.err, /^warning: /m);
  const j = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir, openDb: realOpen });
  assert.ok(j.json.warnings.length > 0);
});

// ---- a locked database -------------------------------------------------------------------------------------------

const HOLDER = `
const sqlite = await import("node:sqlite");
const D = sqlite.Database ?? sqlite.DatabaseSync;
const db = new D(process.argv[1] + "/work/queue.db");
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
process.stdout.write("ready\\n");
process.stdin.resume();
process.stdin.on("end", () => { try { db.exec("ROLLBACK"); } catch {} process.exit(0); });
`;

test("a locked database: a WRITE subcommand is exit 2 WORK_STORE_UNREADABLE, while list still returns rows", async () => {
  const dir = tmp();
  await seed(dir, 2);
  const child = spawn(process.execPath, ["--input-type=module", "-e", HOLDER, dir], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("holder never got ready")), 10_000);
      child.stdout.on("data", (d) => { if (String(d).includes("ready")) { clearTimeout(t); resolve(); } });
      child.on("error", reject);
    });
    const w = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir, busyMs: 50 });
    assert.equal(w.code, 2);
    assert.equal(w.json.code, "WORK_STORE_UNREADABLE");
    const r = await cli(["list", "--json"], { stateDirPath: dir, busyMs: 50 });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.items.length, 2, "WAL readers do not wait");
  } finally {
    child.stdin.end();
    await new Promise((res) => child.on("close", res));
  }
});

test("a raw SQLITE_BUSY from BEGIN or COMMIT is mapped to WORK_STORE_UNREADABLE, never surfaced raw", async () => {
  const dir = tmp();
  await seed(dir);
  for (const failOn of ["BEGIN", "COMMIT"]) {
    const wrapped = (d, opts) => {
      const o = openDb(d, opts);
      const real = o.db;
      const lock = () => Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" });
      return {
        ...o,
        db: {
          exec: (sql) => { if (sql.startsWith(failOn)) throw lock(); return real.exec(sql); },
          prepare: (sql) => real.prepare(sql),
          close: () => real.close(),
        },
      };
    };
    const r = await cli(["claim", "--kind", "evaluate", "--json"], { stateDirPath: dir, openDb: wrapped });
    assert.equal(r.code, 2, failOn);
    assert.equal(r.json.code, "WORK_STORE_UNREADABLE", failOn);
  }
});

// ---- prune -------------------------------------------------------------------------------------------------------

/** One byte-comparable snapshot of every table (node:sqlite has no .dump). */
function snapshot(dir) {
  const { db } = openDb(dir);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
  } finally { db.close(); }
}

/** Items created at `created`; `state` reached with its last event at `last`. */
function fixture(dir) {
  const o = (n) => ({ now: () => n, stateDirPath: dir });
  const mk = (key, at) => enqueue({ kind: "evaluate", scope: "acme/hub", dedupe_key: `evaluate:${key}`, payload: { issue_repo: "acme/hub", issue_number: 1, canonical_url: key }, ttlMs: 1000 * DAY }, o(at)).item.id;
  const ackAt = (id, session, claimAt, ackAt_) => {
    const c = claim({ kind: "evaluate", session }, o(claimAt));
    assert.equal(c.id, id, "claim order");
    ack(id, { session, token: c.token }, o(ackAt_));
  };
  const old = T0 - 400 * DAY;
  const oldAcked = mk("old-acked", old);
  ackAt(oldAcked, "s", old + 1000, old + 2000); // last event 400 days ago
  const longLived = mk("created-long-ago-acked-yesterday", old + 10);
  ackAt(longLived, "s", T0 - DAY - 1000, T0 - DAY); // created 400 days ago, last event 1 day ago (R19)
  const oldPending = mk("old-pending", old + 20);
  const oldClaimed = mk("old-claimed", old + 30);
  // claim picks the oldest pending: oldPending first, so release it back, then claim oldClaimed
  const first = claim({ kind: "evaluate", session: "s2" }, o(old + 40));
  assert.equal(first.id, oldPending);
  release(oldPending, { session: "s2", token: first.token }, o(old + 41));
  return { oldAcked, longLived, oldPending, oldClaimed };
}

test("prune: the dry run leaves every table byte-identical; --apply removes exactly the old acked and expired items", async () => {
  const dir = tmp();
  const ids = fixture(dir);
  // expired old item
  const o = { now: () => T0 - 400 * DAY + 50, stateDirPath: dir };
  const exp = enqueue({ kind: "evaluate", scope: "acme/hub", dedupe_key: "evaluate:old-expired", payload: {}, ttlMs: 1000 * DAY }, o).item.id;
  expire(exp, { reason: "issue closed" }, o);

  const before = snapshot(dir);
  const dry = await cli(["prune", "--json"], { stateDirPath: dir });
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.json.dry_run, true);
  assert.deepEqual([...dry.json.ids].sort(), [ids.oldAcked, exp].sort());
  assert.equal(snapshot(dir), before, "a dry run must not change any table");
  const txt = await cli(["prune"], { stateDirPath: dir });
  assert.match(txt.out, /^dry run: would remove 2 /);
  assert.equal(snapshot(dir), before);

  const real = await cli(["prune", "--apply", "--json"], { stateDirPath: dir });
  assert.equal(real.code, 0, real.err);
  assert.equal(real.json.dry_run, false);
  assert.equal(real.json.items, 2);
  assert.ok(real.json.events >= 4, "the removed events are counted");
  const left = (await cli(["list", "--json"], { stateDirPath: dir })).json.items.map((i) => i.id).sort();
  assert.deepEqual(left, [ids.longLived, ids.oldPending, ids.oldClaimed].sort());
  // the survivors keep their events
  const { db } = openDb(dir);
  try {
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE id = ?").get(ids.longLived).n >= 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE id = ?").get(ids.oldAcked).n, 0);
  } finally { db.close(); }
});

test("prune: an item created 200 days ago and acked yesterday survives a 180-day prune (R19)", () => {
  const dir = tmp();
  const { db } = openDb(dir);
  try {
    const o = (n) => ({ now: () => n, db });
    const id = enqueue({ kind: "evaluate", scope: "acme/hub", dedupe_key: "evaluate:x", payload: {}, ttlMs: 1000 * DAY }, o(T0 - 200 * DAY)).item.id;
    const c = claim({ kind: "evaluate", session: "s" }, o(T0 - DAY - 5));
    ack(id, { session: "s", token: c.token }, o(T0 - DAY));
    const r = prune(db, { olderThanDays: 180, apply: true }, { now: () => T0 });
    assert.equal(r.items, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_items").get().n, 1);
  } finally { db.close(); }
});

test("prune: a bad --older-than is exit 2 WORK_USAGE", async () => {
  const dir = tmp();
  for (const v of ["abc", "-3"]) {
    const r = await cli(["prune", "--older-than", v, "--json"], { stateDirPath: dir });
    assert.equal(r.code, 2, v);
    assert.equal(r.json.code, "WORK_USAGE");
  }
});
