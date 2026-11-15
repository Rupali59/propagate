/**
 * lib/work/canonical.mjs and lib/work/sync.mjs (propagate#150, Task 3). Every test makes its own mkdtemp dir (R17). The
 * gh seam is an injected stub that records its argv; the real gh is never called and GitHub is never written to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalUrl, firstUrl } from "../../lib/work/canonical.mjs";
import { KINDS, syncKind } from "../../lib/work/sync.mjs";
import { openDb } from "../../lib/work/db.mjs";
import { enqueue, claim, ack, release, list, expire } from "../../lib/work/queue.mjs";

const DB_URL = new URL("../../lib/work/db.mjs", import.meta.url).href;
const QUEUE_URL = new URL("../../lib/work/queue.mjs", import.meta.url).href;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "work-sync-"));
const thrown = (fn) => { try { fn(); } catch (e) { return e; } assert.fail("expected a throw"); };
const REPO = "acme/hub";
const DAY = 24 * 3600 * 1000;

const issue = (number, body, labels = ["kind:evaluate"], title = `issue ${number}`) =>
  ({ number, title, body, labels: labels.map((name) => ({ name })) });

/** A gh stub: `label list` answers from `labels`, `issue list` from `issues` (a value or a function). Records argv. */
function makeStub({ issues = [], labels = ["kind:evaluate", "evaluate:parked"], onIssueList, failIssueList = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "label") return { status: 0, stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: "" };
    if (args[0] === "issue") {
      if (failIssueList) return { status: 1, stdout: "", stderr: "gh: HTTP 502" };
      if (onIssueList) onIssueList();
      return { status: 0, stdout: JSON.stringify(typeof issues === "function" ? issues() : issues), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  gh.calls = calls;
  return gh;
}

const clock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };
const sync = (dir, gh, c, extra = {}) => syncKind("evaluate", { repo: REPO, gh, stateDirPath: dir, now: c.now, ...extra });
const dump = (dir) => {
  const { db } = openDb(dir);
  try {
    const q = (s) => db.prepare(s).all().map((r) => ({ ...r }));
    return JSON.stringify([q("SELECT * FROM work_items ORDER BY id"), q("SELECT * FROM work_events ORDER BY seq"), q("SELECT * FROM sync_marks")]);
  } finally { db.close(); }
};
const items = (dir) => list({ kind: "evaluate" }, { stateDirPath: dir });

// ---- canonicalUrl ------------------------------------------------------------------------------------------------

test("canonicalUrl: github urls collapse to owner/repo, lowercased, without .git, slash or deeper path", () => {
  for (const u of [
    "https://github.com/LocalSend/localsend/", "see https://github.com/LocalSend/localsend/tree/main/docs now",
    "https://github.com/localsend/localsend.git", "http://www.github.com/LocalSend/LocalSend?tab=readme#top",
  ]) assert.equal(canonicalUrl(u), "github.com/localsend/localsend", u);
});

test("canonicalUrl R20: markdown parens, owner-only github, gist not collapsed, www dropped", () => {
  assert.equal(canonicalUrl("[repo](https://github.com/Acme/Tool)"), "github.com/acme/tool");
  assert.equal(canonicalUrl("(https://example.com/a/b)."), "example.com/a/b");
  assert.equal(canonicalUrl("https://github.com/Acme"), "github.com/acme");
  assert.equal(canonicalUrl("https://gist.github.com/Acme/AbC123"), "gist.github.com/Acme/AbC123");
  assert.equal(canonicalUrl("https://www.Example.com/Page"), "example.com/Page");
});

test("canonicalUrl C9a: non-github keeps the path case, drops query, fragment and trailing slash; two paths differ", () => {
  assert.equal(canonicalUrl("https://Tool.example.org/?ref=x"), "tool.example.org");
  assert.equal(canonicalUrl("https://tool.example.org/Docs/Intro/?a=1#frag"), "tool.example.org/Docs/Intro");
  assert.notEqual(canonicalUrl("https://tool.example.org/a"), canonicalUrl("https://tool.example.org/b"));
  assert.equal(canonicalUrl("no link here"), null);
  assert.equal(canonicalUrl(""), null);
  assert.equal(canonicalUrl(null), null);
  assert.equal(firstUrl("x https://a.example/p?q=1, y https://b.example"), "https://a.example/p?q=1");
});

test("KINDS: every entry declares label, parkedLabel, ttlMs and idempotent_by (C1)", () => {
  const entries = Object.entries(KINDS);
  assert.ok(entries.length >= 1, "KINDS is empty, the scan has gone blind");
  for (const [k, v] of entries) {
    assert.ok(v.label && v.parkedLabel, `${k} lacks a label`);
    assert.ok(Number.isFinite(v.ttlMs) && v.ttlMs > 0, `${k} lacks ttlMs`);
    assert.ok(typeof v.idempotent_by === "string" && v.idempotent_by.length > 0, `${k} declares no idempotent_by`);
  }
  assert.equal(KINDS.evaluate.label, "kind:evaluate");
  assert.equal(KINDS.evaluate.parkedLabel, "evaluate:parked");
  assert.equal(KINDS.evaluate.ttlMs, 30 * DAY);
  assert.equal(KINDS.evaluate.idempotent_by, "dedupe_key: one register entry per canonical URL");
});

// ---- syncKind ----------------------------------------------------------------------------------------------------

test("sync: 2 labelled issues give 2 items with the right payloads; a re-sync enqueues 0; gh argv is read-only", () => {
  const dir = tmp(), c = clock();
  const gh = makeStub({ issues: [issue(1, "eval https://github.com/LocalSend/localsend/ please"), issue(2, "https://tool.example.org/Docs/?ref=x")] });
  const r = sync(dir, gh, c);
  assert.deepEqual({ ...r, unparsed: r.unparsed }, { enqueued: 2, skipped: 0, expired: 0, unparked: 0, unparsed: [], stale: false, label_missing: false });
  const got = items(dir).sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key)); // same created ms, random ids
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((i) => i.dedupe_key), ["evaluate:github.com/localsend/localsend", "evaluate:tool.example.org/Docs"]);
  assert.equal(got[0].scope, REPO);
  assert.equal(got[0].expires_at, c.t + 30 * DAY);
  assert.deepEqual(JSON.parse(got[0].payload), {
    issue_repo: REPO, issue_number: 1, url: "https://github.com/LocalSend/localsend/", canonical_url: "github.com/localsend/localsend",
  });
  assert.equal(sync(dir, gh, c).enqueued, 0);
  assert.equal(items(dir).length, 2);
  const issueCall = gh.calls.find((a) => a[0] === "issue");
  assert.deepEqual(issueCall, ["issue", "list", "-R", REPO, "--label", "kind:evaluate", "--state", "open", "--limit", "1000", "--json", "number,title,body,labels"]);
  for (const a of gh.calls) for (const bad of ["create", "edit", "close", "comment"]) assert.ok(!a.includes(bad), `argv has ${bad}`);
});

test("sync: an issue with no URL is unparsed and creates no item", () => {
  const dir = tmp();
  const r = sync(dir, makeStub({ issues: [issue(5, "no link here", undefined, "Look at this")] }), clock());
  assert.deepEqual(r.unparsed, [{ number: 5, title: "Look at this" }]);
  assert.equal(r.enqueued, 0);
  assert.equal(items(dir).length, 0);
});

test("sync C9a: two different paths on one host give two items", () => {
  const dir = tmp();
  const r = sync(dir, makeStub({ issues: [issue(1, "https://tool.example.org/a"), issue(2, "https://tool.example.org/b")] }), clock());
  assert.equal(r.enqueued, 2);
});

test("sync Review Focus 4: the issue left the open list, so the pending item is expired (reason issue closed)", () => {
  const dir = tmp(), c = clock();
  sync(dir, makeStub({ issues: [issue(1, "https://a.example/x"), issue(2, "https://a.example/y")] }), c);
  c.t += 1000;
  const r = sync(dir, makeStub({ issues: [issue(2, "https://a.example/y")] }), c);
  assert.equal(r.expired, 1);
  const byUrl = Object.fromEntries(items(dir).map((i) => [JSON.parse(i.payload).issue_number, i.state]));
  assert.deepEqual(byUrl, { 1: "expired", 2: "pending" });
  const { db } = openDb(dir);
  const ev = db.prepare("SELECT detail FROM work_events WHERE op = 'expire'").all();
  db.close();
  assert.equal(JSON.parse(ev[0].detail).reason, "issue closed");
});

test("sync: a claimed item whose issue closed is expired too", () => {
  const dir = tmp(), c = clock();
  const gh = makeStub({ issues: [issue(1, "https://a.example/x")] });
  sync(dir, gh, c);
  claim({ kind: "evaluate", session: "S" }, { stateDirPath: dir, now: c.now });
  assert.equal(sync(dir, makeStub({ issues: [] }), c).expired, 1);
  assert.equal(items(dir)[0].state, "expired");
});

test("sync Review Focus 5 and the carried fix: an acked item is not re-enqueued while its issue is open, and a closed issue never expires it", () => {
  const dir = tmp(), c = clock();
  const gh = makeStub({ issues: [issue(1, "https://a.example/x")] });
  sync(dir, gh, c);
  const got = claim({ kind: "evaluate", session: "S" }, { stateDirPath: dir, now: c.now });
  ack(got.id, { session: "S", token: got.token }, { stateDirPath: dir, now: c.now });
  const again = sync(dir, gh, c);
  assert.equal(again.enqueued, 0);
  assert.equal(items(dir).length, 1);
  // the issue closes: the acked item keeps its state and its dedupe key
  const closed = sync(dir, makeStub({ issues: [] }), c);
  assert.equal(closed.expired, 0);
  assert.equal(items(dir)[0].state, "acked");
  // even a ttl pass does not touch it
  c.t += 40 * DAY;
  sync(dir, makeStub({ issues: [issue(1, "https://a.example/x")] }), c);
  assert.equal(items(dir).length, 1);
  assert.equal(items(dir)[0].state, "acked");
});

test("queue expire never touches an acked item (it would free the dedupe key and re-queue finished work)", () => {
  const dir = tmp(), c = clock();
  const o = { stateDirPath: dir, now: c.now };
  enqueue({ kind: "evaluate", scope: REPO, dedupe_key: "evaluate:x", payload: {} }, o);
  const got = claim({ kind: "evaluate", session: "S" }, o);
  ack(got.id, { session: "S", token: got.token }, o);
  const e = expire(got.id, { reason: "issue closed" }, o);
  assert.equal(e.state, "acked");
  assert.equal(items(dir)[0].state, "acked");
  assert.equal(enqueue({ kind: "evaluate", scope: REPO, dedupe_key: "evaluate:x", payload: {} }, o).created, false);
});

test("sync R1: a parked item with no label stays parked; with the label seen and then gone it unparks", () => {
  const dir = tmp(), c = clock();
  const o = { stateDirPath: dir, now: c.now };
  const open = [issue(1, "https://a.example/x")];
  sync(dir, makeStub({ issues: open }), c);
  for (const s of ["A", "B"]) {
    const g = claim({ kind: "evaluate", session: s }, o);
    release(g.id, { session: s, token: g.token, refusal: true }, o);
  }
  assert.equal(items(dir)[0].state, "parked");
  sync(dir, makeStub({ issues: open }), c);
  sync(dir, makeStub({ issues: open }), c);
  assert.equal(items(dir)[0].state, "parked", "nothing applied the label in Stage 1, so it must stay parked");
  // the label appears: seen = 1, still parked, counted as skipped
  const labelled = [issue(1, "https://a.example/x", ["kind:evaluate", "evaluate:parked"])];
  assert.equal(sync(dir, makeStub({ issues: labelled }), c).skipped, 1);
  assert.equal(items(dir)[0].state, "parked");
  assert.equal(items(dir)[0].parked_label_seen, 1);
  // and then it is removed: pending
  const r = sync(dir, makeStub({ issues: open }), c);
  assert.equal(r.unparked, 1);
  assert.equal(items(dir)[0].state, "pending");
  assert.equal(items(dir)[0].parked_label_seen, 0);
});

test("sync: an issue carrying the parked label is skipped and never enqueued", () => {
  const dir = tmp();
  const r = sync(dir, makeStub({ issues: [issue(1, "https://a.example/x", ["kind:evaluate", "evaluate:parked"])] }), clock());
  assert.deepEqual([r.enqueued, r.skipped], [0, 1]);
  assert.equal(items(dir).length, 0);
});

test("sync R2: an item past its ttl with its issue open is expired (ttl) and a fresh item is claimable", () => {
  const dir = tmp(), c = clock();
  const gh = makeStub({ issues: [issue(1, "https://a.example/x")] });
  sync(dir, gh, c);
  c.t += 30 * DAY + 1;
  const r = sync(dir, gh, c);
  assert.deepEqual([r.expired, r.enqueued], [1, 1]);
  const states = items(dir).map((i) => i.state).sort();
  assert.deepEqual(states, ["expired", "pending"]);
  const got = claim({ kind: "evaluate", session: "S" }, { stateDirPath: dir, now: c.now });
  assert.ok(got, "the fresh item must be claimable");
  const { db } = openDb(dir);
  const reasons = db.prepare("SELECT detail FROM work_events WHERE op = 'expire'").all().map((e) => JSON.parse(e.detail).reason);
  db.close();
  assert.deepEqual(reasons, ["ttl"]);
});

test("sync R15: a parked item of a closed issue expires", () => {
  const dir = tmp(), c = clock();
  const o = { stateDirPath: dir, now: c.now };
  sync(dir, makeStub({ issues: [issue(1, "https://a.example/x")] }), c);
  for (const s of ["A", "B"]) { const g = claim({ kind: "evaluate", session: s }, o); release(g.id, { session: s, token: g.token, refusal: true }, o); }
  assert.equal(items(dir)[0].state, "parked");
  assert.equal(sync(dir, makeStub({ issues: [] }), c).expired, 1);
  assert.equal(items(dir)[0].state, "expired");
});

test("sync R9: an item scoped to another repo survives a sync of this one", () => {
  const dir = tmp(), c = clock();
  enqueue({ kind: "evaluate", scope: "other/repo", dedupe_key: "evaluate:other.example/z", payload: { issue_number: 1 } }, { stateDirPath: dir, now: c.now });
  const r = sync(dir, makeStub({ issues: [] }), c);
  assert.equal(r.expired, 0);
  assert.equal(items(dir)[0].state, "pending");
});

test("sync R13: an edited issue body expires the old item (url changed) and enqueues one new item", () => {
  const dir = tmp(), c = clock();
  sync(dir, makeStub({ issues: [issue(1, "https://a.example/x")] }), c);
  const r = sync(dir, makeStub({ issues: [issue(1, "https://a.example/y")] }), c);
  assert.deepEqual([r.expired, r.enqueued], [1, 1]);
  const got = items(dir).map((i) => [i.dedupe_key, i.state]).sort();
  assert.deepEqual(got, [["evaluate:a.example/x", "expired"], ["evaluate:a.example/y", "pending"]]);
  assert.equal(sync(dir, makeStub({ issues: [issue(1, "https://a.example/y")] }), c).enqueued, 0);
});

test("sync R3: exactly 1000 issues expires nothing and fails WORK_SYNC_TRUNCATED, rows unchanged", () => {
  const dir = tmp(), c = clock();
  sync(dir, makeStub({ issues: [issue(5000, "https://keep.example/me")] }), c);
  const before = dump(dir);
  const many = Array.from({ length: 1000 }, (_, i) => issue(i + 1, `https://bulk.example/${i}`));
  const e = thrown(() => sync(dir, makeStub({ issues: many }), c));
  assert.equal(e.code, "WORK_SYNC_TRUNCATED");
  assert.equal(e.exit, 2);
  assert.equal(dump(dir), before);
  // 999 is fine
  assert.equal(sync(dir, makeStub({ issues: many.slice(0, 999) }), c).enqueued, 999);
});

test("sync R25: a missing label is reported as looked-at-nothing, not as zero issues", () => {
  const dir = tmp(), c = clock();
  const gh = makeStub({ labels: ["bug"], issues: [issue(1, "https://a.example/x")] });
  const r = sync(dir, gh, c);
  assert.equal(r.label_missing, true);
  assert.match(r.message, /label kind:evaluate does not exist on acme\/hub: looked at nothing/);
  assert.equal(gh.calls.filter((a) => a[0] === "issue").length, 0, "the issue list must not be asked for when the label is absent");
  assert.equal(items(dir).length, 0);
});

test("sync R14: a fetch older than the stored mark is not applied and reports stale", () => {
  const dir = tmp(), c = clock(2_000_000);
  sync(dir, makeStub({ issues: [issue(1, "https://a.example/x")] }), c);
  c.t = 1_000_000;
  const before = dump(dir);
  const r = sync(dir, makeStub({ issues: [] }), c);
  assert.equal(r.stale, true);
  assert.deepEqual([r.enqueued, r.expired], [0, 0]);
  assert.equal(dump(dir), before);
});

test("sync R8: one sync with 2 enqueues and 1 expiry commits exactly once", () => {
  const dir = tmp(), c = clock();
  sync(dir, makeStub({ issues: [issue(9, "https://a.example/old")] }), c);
  const { db } = openDb(dir);
  const log = [];
  const proxy = new Proxy(db, { get(t, p) {
    if (p === "exec") return (sql) => { log.push(sql); return t.exec(sql); };
    const v = t[p]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const r = sync(dir, makeStub({ issues: [issue(1, "https://a.example/1"), issue(2, "https://a.example/2")] }), c, { db: proxy });
  db.close();
  assert.deepEqual([r.enqueued, r.expired], [2, 1]);
  assert.equal(log.filter((s) => s === "BEGIN IMMEDIATE").length, 1);
  assert.equal(log.filter((s) => s === "COMMIT").length, 1);
});

test("sync: the gh stub failing throws WORK_GITHUB_FAILED and the database is unchanged", () => {
  const dir = tmp(), c = clock();
  sync(dir, makeStub({ issues: [issue(1, "https://a.example/x")] }), c);
  const before = dump(dir);
  const e = thrown(() => sync(dir, makeStub({ failIssueList: true }), c));
  assert.equal(e.code, "WORK_GITHUB_FAILED");
  assert.equal(e.exit, 2);
  assert.equal(dump(dir), before);
});

test("sync: an unknown kind is WORK_USAGE", () => {
  assert.equal(thrown(() => syncKind("nope", { repo: REPO, gh: makeStub(), stateDirPath: tmp() })).code, "WORK_USAGE");
});

// ---- C3: no transaction spans the network call -------------------------------------------------------------------

test("sync C3: while the gh stub runs no sync event exists yet and another process can claim (no lock held across the fetch)", () => {
  const dir = tmp(), c = clock();
  enqueue({ kind: "evaluate", scope: "other/repo", dedupe_key: "evaluate:other.example/c3", payload: {} }, { stateDirPath: dir, now: c.now });
  const child = `
    const [dir] = process.argv.slice(1);
    const { openDb } = await import(${JSON.stringify(DB_URL)});
    const { claim } = await import(${JSON.stringify(QUEUE_URL)});
    const { db } = openDb(dir, { busyMs: 300 });
    const it = claim({ kind: "evaluate", session: "child" }, { db, now: () => 1_000_000 });
    db.close();
    process.stdout.write(JSON.stringify({ id: it && it.id }));
  `;
  let probe = null;
  const gh = makeStub({
    issues: [issue(1, "https://a.example/x")],
    onIssueList() {
      const { db } = openDb(dir);
      const syncEvents = db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE op = 'enqueue' AND id <> (SELECT id FROM work_items WHERE scope = 'other/repo')").get().n;
      db.close();
      const t0 = Date.now();
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", child, dir], { encoding: "utf8", timeout: 20_000 });
      probe = { syncEvents, ms: Date.now() - t0, status: r.status, out: r.stdout, err: r.stderr };
    },
  });
  sync(dir, gh, c);
  assert.ok(probe, "the stub never ran");
  assert.equal(probe.syncEvents, 0, "this sync had already written events while fetching");
  assert.equal(probe.status, 0, `the child's claim failed while the stub ran (a transaction spans the fetch): ${probe.err}`);
  assert.ok(JSON.parse(probe.out).id, "the child claimed nothing");
  assert.ok(probe.ms < 1000 + 2000, `the child took ${probe.ms} ms`);
});
