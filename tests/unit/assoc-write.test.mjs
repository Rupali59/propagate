/**
 * assoc-write.test.mjs — the newest-wins association writer (propagate#442), tested by the bytes of assoc.jsonl, and the
 * sessions view reading what it wrote. Temp state dirs only (GOTCHAS G56).
 */
// @size small — temp files
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fold } from "../../lib/sessions/assoc.mjs";
import { associateSession, goalFromSnapshot } from "../../lib/sessions/assoc-write.mjs";
import { buildView } from "../../lib/sessions/view.mjs";

const fresh = () => mkdtempSync(path.join(tmpdir(), "assoc-write-"));
const log = (dir) => {
  try {
    return readFileSync(path.join(dir, "sessions", "assoc.jsonl"), "utf8");
  } catch {
    return "";
  }
};
const lines = (dir) => log(dir).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const T = (s) => new Date(`2026-11-28T10:00:${s}Z`);

test("no association: a write happens, with source, signal and rowKey session:<id>", () => {
  const dir = fresh();
  const r = associateSession("s1", { item: "o/r#5", goal: null, source: "derived", signal: "gh issue close", goal_source: "not in today's snapshot" }, dir, T("00"));
  assert.equal(r.written, true);
  const [ev] = lines(dir);
  assert.equal(ev.rowKey, "session:s1");
  assert.equal(ev.item, "o/r#5");
  assert.equal(ev.source, "derived");
  assert.equal(ev.signal, "gh issue close");
  assert.equal(ev.goal, null);
  assert.equal(ev.goal_source, "not in today's snapshot");
  assert.equal(ev.row.sessionId, "s1");
});

test("the same item is a no-op: not one byte appended", () => {
  const dir = fresh();
  associateSession("s1", { item: "o/r#5", source: "derived" }, dir, T("00"));
  const before = log(dir);
  const r = associateSession("s1", { item: "o/r#5", source: "derived" }, dir, T("01"));
  assert.equal(r.written, false);
  assert.match(r.why, /already associated with o\/r#5/);
  assert.equal(log(dir), before);
});

test("a different item is a write, and the history keeps both", () => {
  const dir = fresh();
  associateSession("s1", { item: "o/r#5", source: "derived" }, dir, T("00"));
  const r = associateSession("s1", { item: "o/r#9", source: "derived" }, dir, T("01"));
  assert.deepEqual([r.written, r.from], [true, "o/r#5"]);
  assert.deepEqual(lines(dir).map((e) => e.item), ["o/r#5", "o/r#9"]);
  const entry = fold(dir).byKey.get("session:s1");
  assert.equal(entry.assoc.item, "o/r#9");
  assert.deepEqual(entry.history.map((e) => e.item), ["o/r#5", "o/r#9"]);
});

test("an unreadable log refuses to write", () => {
  const dir = fresh();
  mkdirSync(path.join(dir, "sessions", "assoc.jsonl"), { recursive: true }); // a directory where the log should be: EISDIR
  assert.throws(() => associateSession("s1", { item: "o/r#5" }, dir, T("00")));
  assert.equal(associateSession("", { item: "o/r#5" }, dir).written, false, "no session id: no write");
});

test("goalFromSnapshot reads today's snapshot only, and a missing item is null", () => {
  const dir = fresh();
  mkdirSync(path.join(dir, "day"), { recursive: true });
  const now = new Date(2026, 10, 28, 12, 0, 0);
  writeFileSync(path.join(dir, "day", "items.json"), JSON.stringify({ generatedAt: now.toISOString(), items: { "o/r#5": { goal: "G3" } } }));
  assert.equal(goalFromSnapshot("o/r#5", dir, now), "G3");
  assert.equal(goalFromSnapshot("o/r#6", dir, now), null);
  assert.equal(goalFromSnapshot("o/r#5", dir, new Date(2026, 10, 29, 12, 0, 0)), null, "yesterday's snapshot is not a source");
  assert.equal(goalFromSnapshot("o/r#5", fresh(), now), null, "no snapshot");
});

test("buildView: a later derived event beats an earlier dispatch one, joined by session id (#285 part 1)", () => {
  const dir = fresh();
  associateSession("sess-v", { item: "o/r#290", goal: "G3", source: "dispatch", signal: "dispatch" }, dir, T("00"));
  associateSession("sess-v", { item: "o/r#442", source: "derived", signal: "gh issue comment" }, dir, T("30"));
  const live = {
    readAt: "t",
    rows: [{ key: "interactive:sess-v:7", kind: "interactive", id: "7", pid: 7, name: "n", state: "busy", startedAt: Date.parse("2026-11-28T09:00:00Z"), sessionId: "sess-v", cwd: "/w/acme/repo-a" }],
  };
  const ctx = { workspaces: [{ name: "acme", root: "/w/acme" }], checkouts: [{ path: "/w/acme/repo-a", repo: "o/repo-a" }], hubRoot: "/hub" };
  const view = buildView(live, fold(dir), ctx);
  assert.equal(view.sessions[0].association.item, "o/r#442");
  assert.equal(view.sessions[0].association.source, "derived");
});
