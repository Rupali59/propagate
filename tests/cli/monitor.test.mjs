/**
 * lib/monitor.mjs — proactive notification without a baseline.
 *
 * The whole reason this component is allowed to exist is that it CANNOT do what
 * the retired v1 watcher did. So the tests are about the absence of that
 * capability, not about notification cosmetics:
 *
 *   - it is idempotent: same edge, same finding, silent second run, WHATEVER its bytes do
 *     (propagate#296 re-keyed it from the content triple to `edge:<edge_id>`; these tests were rewritten, not
 *     deleted, and the additions-only / 24 h hold rule is tested in tests/unit/glance-notify.test.mjs)
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

import { notifyKey, selectToNotify, formatNotification, selectDefectsToNotify, formatDefectNotification, heldIds } from "../../lib/report/monitor.mjs";
import { decideChannel, mergeChannel, HOLD_MS } from "../../lib/glance/notifications.mjs";
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

test("the key is the EDGE ID, never the content triple (propagate#296)", () => {
  const a = row("DRIFTED", { edge: "x", src: "aaa", dn: "bbb" });
  const c = row("DRIFTED", { edge: "x", src: "CHANGED", dn: "bbb" });
  assert.equal(notifyKey(a), "edge:x");
  assert.equal(notifyKey(a), notifyKey(c), "changed bytes are the SAME finding: the edge, still drifted");
  // FAILING INPUT: put the content back in the key and the second assertion fails. That was the
  // 2026-08-17 design; it re-notified on every edit cycle (76% of notifications, measured 2026-08-29).
});

test("null content changes nothing — an UNMATCHED glob has the same stable identity", () => {
  const u = { edge_id: "g", source: { contentId: "aaa" }, downstream: { contentId: null } };
  assert.equal(notifyKey(u), "edge:g");
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

test("changed bytes do NOT re-notify an edge already told about", () => {
  const before = row("DRIFTED", { edge: "a", src: "v1", dn: "d" });
  const seen = new Set([notifyKey(before)]);

  const after = row("DRIFTED", { edge: "a", src: "v2", dn: "d" });
  const { toNotify } = selectToNotify([after], seen);
  assert.equal(toNotify.length, 0, "the source moved again, but the finding is the same edge: still drifted");
});

test("a fixed-then-broken edge is notified again once the 24 h hold has passed", () => {
  // drift → human fixes it → it drifts again later. Decided by decideChannel, the way cli.mjs composes it.
  const t0 = Date.parse("2026-11-16T00:00:00Z");
  const pass = (read, rows, now) => {
    const ids = selectToNotify(rows).actionable.map(notifyKey);
    const d = decideChannel({ read, channel: "edges", ids, now });
    return { n: selectToNotify(rows, heldIds(ids, d.notify)).toNotify.length, read: { status: "ok", state: mergeChannel(read, "edges", d.next) } };
  };
  let r = pass({ status: "ok", state: { channels: { edges: { seeded_at: "x", last_run: "x", ids: {} } } } }, [row("DRIFTED", { edge: "a", src: "v1", dn: "d1" })], t0);
  assert.equal(r.n, 1);
  r = pass(r.read, [row("CLEAN", { edge: "a" })], t0 + 3600000);
  r = pass(r.read, [], t0 + 7200000);
  r = pass(r.read, [row("DRIFTED", { edge: "a", src: "v2", dn: "d2" })], t0 + 7200000 + HOLD_MS + 1);
  assert.equal(r.n, 1, "it cleared and came back after the hold: a new finding");
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
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const f = path.join(dir, "monitor.log");
  const { logRun } = await import("../../lib/report/monitor.mjs");

  const quiet = await logRun({ rows: 700, actionable: 0, notified: 0, suppressed: 0, ms: 780 }, f);
  const broken = await logRun({ rows: 0, actionable: 0, notified: 0, suppressed: 0, ms: 5, error: "git exploded" }, f);

  assert.doesNotMatch(quiet, /error=/);
  assert.match(broken, /error="git exploded"/, "absence must be attributable");
});

// ---------------------------------------------------------------------------
// Backlog defects — added 2026-08-26 when the monitor gained a second subject.
// ---------------------------------------------------------------------------

test("a backlog defect notifies ONCE, then is suppressed", () => {
  // The whole value of the notified store. A defect that re-fires every run is
  // a defect nobody reads.
  const d = { kind: "unparsed", file: "/x/TODOS.md", detail: "…", key: "backlog:unparsed:/x/TODOS.md" };
  const first = selectDefectsToNotify([d], new Set());
  assert.equal(first.toNotify.length, 1);
  assert.equal(first.suppressed.length, 0);

  const second = selectDefectsToNotify([d], new Set([d.key]));
  assert.equal(second.toNotify.length, 0, "already sent — stay quiet");
  assert.equal(second.suppressed.length, 1, "and say it was suppressed, not that there was nothing");
});

test("open items produce ZERO notifications — only defects reach the channel", () => {
  // The load-bearing property, asserted at the monitor layer as well as at
  // backlogDefects(). 500 open items is the normal state of a working tree; if
  // it notified, the channel would be muted and the one line that matters would
  // go unread. selectDefectsToNotify is only ever handed defects, and an empty
  // defect list must therefore produce silence no matter how much work is open.
  assert.deepEqual(selectDefectsToNotify([], new Set()).toNotify, []);
  assert.deepEqual(selectDefectsToNotify(undefined, new Set()).toNotify, [], "a missing list is silence, not a throw");
});

test("notifyKey honours a defect's precomputed key, so both kinds share one store", () => {
  // A defect's identity is its FILE, not content: it should stay quiet until
  // fixed, not re-fire when the file's bytes change. Edges now follow the same rule.
  assert.equal(notifyKey({ key: "backlog:unparsed:/x/TODOS.md" }), "backlog:unparsed:/x/TODOS.md");
  // ...and an edge row, which has no `key`, still derives one as before.
  const row = { edge_id: "abc123", source: { contentId: "s" }, downstream: { contentId: "d" } };
  assert.equal(notifyKey(row), "edge:abc123", "an edge derives its stable id");
  assert.equal(notifyKey({ key: "", edge_id: "e" }), "edge:e", "an empty key is not a key");
});

test("the defect notification NAMES files — a count sends nobody anywhere", () => {
  const mk = (f) => ({ kind: "handover-unscoped", file: `/root/${f}`, detail: "…", key: `k${f}` });
  const { title, body } = formatDefectNotification([mk("a.md"), mk("b.md"), mk("c.md"), mk("d.md")], { root: "/root" });
  assert.match(title, /4 backlog files/);
  assert.match(body, /handover-unscoped a\.md/, "paths are shown relative to the root");
  assert.match(body, /\+1 more/, "the body is capped at 3 and says how many it hid");

  const one = formatDefectNotification([mk("a.md")], { root: "/root" });
  assert.match(one.title, /1 backlog file holds/, "singular reads as singular");
});

// ---------------------------------------------------------------------------
// the message must DISAMBIGUATE, not merely name
// ---------------------------------------------------------------------------

/**
 * The fixture is the point. The pre-existing test above uses `/x/CLAUDE.md` and
 * `/y/README.md` — distinct basenames — so it passed while the real tree could
 * not be read at all: 53 files are named `CLAUDE.md`, and among 44 actionable
 * rows `CLAUDE.md → CLAUDE.md` was the correct rendering of SEVEN different
 * edges. A test whose fixture lacks the colliding property cannot see the bug.
 */
test("two edges that differ only by workspace must render differently", () => {
  const opts = { root: "/Users/x/GitHub/" };
  const a = row("DRIFTED", { from: "/Users/x/GitHub/Motherboard/CLAUDE.md", to: "/Users/x/GitHub/CLAUDE.md" });
  const b = row("DRIFTED", { from: "/Users/x/GitHub/Vipin Kaushik/VipinKaushik/CLAUDE.md", to: "/Users/x/GitHub/CLAUDE.md" });

  const bodyA = formatNotification([a], opts).body;
  const bodyB = formatNotification([b], opts).body;

  assert.notEqual(bodyA, bodyB, "same basenames, different edges — the lines must differ");
  assert.match(bodyA, /Motherboard/, "the workspace is the discriminator and must survive");
  assert.match(bodyB, /Vipin Kaushik/);
});

test("two edges INSIDE one workspace must still render differently", () => {
  // The case the first fix missed, caught by rendering the real actionable set:
  // eliding to `workspace/…/file` made `VipinKaushik/CLAUDE.md` and
  // `astroacharya/CLAUDE.md` identical, because both ends of an edge often sit in
  // the SAME workspace and the workspace segment separates nothing there.
  const opts = { root: "/r/" };
  const a = row("DRIFTED", { from: "/r/W/CLAUDE.md", to: "/r/W/VipinKaushik/CLAUDE.md" });
  const b = row("DRIFTED", { from: "/r/W/CLAUDE.md", to: "/r/W/astroacharya/CLAUDE.md" });
  assert.notEqual(formatNotification([a], opts).body, formatNotification([b], opts).body);
  assert.match(formatNotification([a], opts).body, /VipinKaushik/);
  assert.match(formatNotification([b], opts).body, /astroacharya/);
});

test("a deep path is elided in the middle, never at the workspace or the filename", () => {
  const { body } = formatNotification(
    [row("DIVERGED", { from: "/r/Vipin Kaushik/propagation/state/sanskrit-texts/GOTCHAS.md", to: "/r/x.md" })],
    { root: "/r/" },
  );
  assert.match(body, /Vipin Kaushik/, "workspace kept");
  assert.match(body, /GOTCHAS\.md/, "filename kept");
  assert.doesNotMatch(body, /propagation\/state/, "the middle is what gets elided");
});
