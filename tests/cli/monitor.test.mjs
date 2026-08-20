/**
 * lib/monitor.mjs — proactive notification without a baseline.
 *
 * The whole reason this component is allowed to exist is that it CANNOT do what
 * the retired v1 watcher did. So the tests are about the absence of that
 * capability, not about notification cosmetics:
 *
 *   - it is idempotent: same bytes, same finding, silent second run
 *   - it re-notifies when bytes actually change (a real new finding)
 *   - losing its memory costs exactly ONE duplicate, never a storm
 *   - it shares `isActionable` with graph, so the two cannot disagree
 *   - a run that could not look is logged differently from a run that found
 *     nothing
 *
 * Selection is pure (`selectToNotify`), so most of this needs no disk and no
 * launchd. The persistence tests use PROPAGATE_NOTIFIED / PROPAGATE_MONITOR_LOG
 * to stay off the real store — the same isolation discipline the event-store
 * tests use, and the one whose absence cost 11 spurious events on 2026-08-17.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { notifyKey, selectToNotify, formatNotification } from "../../lib/report/monitor.mjs";
import { isActionable } from "../../lib/graph/graph.mjs";

let seq = 0;
function row(state, { edge, src = "s1", dn = "d1", from = "/a.md", to = "/b.md" } = {}) {
  seq++;
  return {
    edge_id: edge || `e${seq}`,
    node_id: `fixture:${from}`,
    source: { path: from, contentId: src, unresolvable: null },
    downstream: { path: to, contentId: dn, unresolvable: null },
    state,
  };
}

// ---------------------------------------------------------------------------
// the key — this is the design, so it gets the most tests
// ---------------------------------------------------------------------------

test("the key is the CONTENT triple, not the edge id", () => {
  const a = row("DRIFTED", { edge: "x", src: "aaa", dn: "bbb" });
  const b = row("DRIFTED", { edge: "x", src: "aaa", dn: "bbb" });
  const c = row("DRIFTED", { edge: "x", src: "CHANGED", dn: "bbb" });

  assert.equal(notifyKey(a), notifyKey(b), "identical bytes are the same finding");
  assert.notEqual(notifyKey(a), notifyKey(c), "changed bytes are a NEW finding");
  // FAILING INPUT: key on edge_id alone and the third assertion fails — a real
  // change would be suppressed as already-seen, which is silence about drift.
});

test("null content is preserved, not coerced — an UNMATCHED glob has a stable identity", () => {
  const u = { edge_id: "g", source: { contentId: "aaa" }, downstream: { contentId: null } };
  assert.equal(notifyKey(u), "g|aaa|null");
  assert.equal(notifyKey(u), notifyKey({ ...u }), "and it is stable across runs");
});

// ---------------------------------------------------------------------------
// idempotence — the core claim
// ---------------------------------------------------------------------------

test("a second run over unchanged bytes notifies nothing", () => {
  const rows = [row("DRIFTED", { edge: "a" }), row("REVERSED", { edge: "b" })];

  const first = selectToNotify(rows, new Set());
  assert.equal(first.toNotify.length, 2, "first run tells you about both");

  const seen = new Set(first.toNotify.map(notifyKey));
  const second = selectToNotify(rows, seen);
  assert.equal(second.toNotify.length, 0, "second run is silent");
  assert.equal(second.suppressed.length, 2, "and says it suppressed two, rather than reporting zero work");
});

test("changed bytes re-notify, even for an edge already seen", () => {
  const before = row("DRIFTED", { edge: "a", src: "v1", dn: "d" });
  const seen = new Set([notifyKey(before)]);

  const after = row("DRIFTED", { edge: "a", src: "v2", dn: "d" });
  const { toNotify } = selectToNotify([after], seen);
  assert.equal(toNotify.length, 1, "the source moved again — that is a new finding");
});

test("a fixed-then-broken edge is notified again", () => {
  // drift → human fixes it → it drifts again with different content.
  const first = row("DRIFTED", { edge: "a", src: "v1", dn: "d1" });
  const seen = new Set([notifyKey(first)]);
  const again = row("DRIFTED", { edge: "a", src: "v2", dn: "d2" });
  assert.equal(selectToNotify([again], seen).toNotify.length, 1);
});

// ---------------------------------------------------------------------------
// blast radius — measured, not asserted
// ---------------------------------------------------------------------------

test("losing the memory costs exactly ONE duplicate, not a storm", () => {
  const rows = [row("DRIFTED", { edge: "a" }), row("DIVERGED", { edge: "b" }), row("REVERSED", { edge: "c" })];

  const seen = new Set(selectToNotify(rows, new Set()).toNotify.map(notifyKey));
  assert.equal(selectToNotify(rows, seen).toNotify.length, 0);

  // memory deleted
  const afterLoss = selectToNotify(rows, new Set());
  assert.equal(afterLoss.toNotify.length, 3, "one duplicate per open finding");

  // and it re-settles immediately
  const reseen = new Set(afterLoss.toNotify.map(notifyKey));
  assert.equal(selectToNotify(rows, reseen).toNotify.length, 0, "quiet again on the very next run");
});

// ---------------------------------------------------------------------------
// it must agree with graph, by construction
// ---------------------------------------------------------------------------

test("the actionable set is graph's, not a second opinion", () => {
  const rows = [
    row("CLEAN"), row("NEVER_VERIFIED"), row("NOT_PRESENT_ON_REF"),
    row("DRIFTED"), row("REVERSED"), row("DIVERGED"), row("UNMATCHED"),
  ];
  const { actionable } = selectToNotify(rows, new Set());
  assert.deepEqual(
    actionable.map((r) => r.state).sort(),
    rows.filter((r) => isActionable(r.state)).map((r) => r.state).sort(),
    "monitor and graph must never report different totals for what needs work",
  );
  assert.equal(actionable.length, 4, "DRIFTED, REVERSED, DIVERGED, UNMATCHED");
});

test("a baseline gap is not movement — NEVER_VERIFIED never notifies", () => {
  // 86 of these exist. Notifying on them would make the monitor unreadable on
  // day one, which is how a signal becomes noise and then gets ignored.
  const { toNotify } = selectToNotify([row("NEVER_VERIFIED"), row("NEVER_VERIFIED")], new Set());
  assert.equal(toNotify.length, 0);
});

// ---------------------------------------------------------------------------
// the message
// ---------------------------------------------------------------------------

test("the notification names edges, not just a count", () => {
  const { title, body } = formatNotification([row("DRIFTED", { from: "/x/CLAUDE.md", to: "/y/README.md" })]);
  assert.match(title, /1 edge/);
  assert.match(body, /CLAUDE\.md/, "a bare count sends nobody anywhere");
  assert.match(body, /README\.md/);
});

test("a long list is truncated with the remainder stated", () => {
  const many = Array.from({ length: 9 }, (_, i) => row("DRIFTED", { from: `/f${i}.md` }));
  const { body } = formatNotification(many);
  assert.match(body, /\+6 more/, "the count of what is not shown must be visible");
});

// ---------------------------------------------------------------------------
// persistence + telemetry, isolated from the real store
// ---------------------------------------------------------------------------

test("readNotified survives a corrupt line and fails OPEN", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mon-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, "notified.jsonl");
  await writeFile(f, '{"key":"a|1|2"}\nnot json at all\n{"key":"b|3|4"}\n');

  const { readNotified } = await import("../../lib/report/monitor.mjs");
  const keys = await readNotified(f);
  assert.ok(keys.has("a|1|2") && keys.has("b|3|4"), "good lines still count");
  assert.equal(keys.size, 2, "the bad line is skipped, not fatal");
  // Failing open means "tell them again", never "stay quiet" — the safe
  // direction for a notifier is a duplicate, not silence.
});

test("every run logs, including one that notifies nothing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mon-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, "monitor.log");
  const { logRun } = await import("../../lib/report/monitor.mjs");

  await logRun({ rows: 700, actionable: 0, notified: 0, suppressed: 0, ms: 780 }, f);
  await logRun({ rows: 700, actionable: 3, notified: 3, suppressed: 0, ms: 790 }, f);
  const out = await readFile(f, "utf8");
  const lines = out.split("\n").filter(Boolean);

  assert.equal(lines.length, 2, "a quiet run must still leave a line");
  assert.match(lines[0], /notified=0/);
  assert.match(lines[1], /notified=3/);
  // FAILING INPUT: log only when notified>0. "Never ran" and "ran, found
  // nothing" then look identical — which is how a dead LaunchAgent goes
  // unnoticed for six weeks (rule:discernment-checks §2).
});

test("a run that could not look is logged differently from one that found nothing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mon-err-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = path.join(dir, "monitor.log");
  const { logRun } = await import("../../lib/report/monitor.mjs");

  const quiet = await logRun({ rows: 700, actionable: 0, notified: 0, suppressed: 0, ms: 780 }, f);
  const broken = await logRun({ rows: 0, actionable: 0, notified: 0, suppressed: 0, ms: 5, error: "git exploded" }, f);

  assert.doesNotMatch(quiet, /error=/);
  assert.match(broken, /error="git exploded"/, "absence must be attributable");
});
