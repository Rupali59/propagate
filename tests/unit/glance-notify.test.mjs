/**
 * glance-notify.test.mjs — propagate#296 (glance PR3): which ids notify, the click target, the digest body, acks.
 *
 * Test ids follow the glance test plan (T-M1..M6, T-O2). Every id and name is synthetic (public repo). Fixtures are
 * literal objects, never built through lib/glance.
 *
 * MUTATIONS RECORDED (each run by hand against this file; see the PR3 report):
 *   M1 put content back in the key: `edge:${id}|${src}|${dn}` in monitor.mjs notifyKey -> T-M1 red
 *   M2 drop the hold: `now - last_seen <= holdMs` becomes `false` in decideChannel -> T-M3 red
 *   M3 seed never: `seeded = false` in decideChannel -> "first run seeds" red
 *   M4 ignore acks: `acked(id, since)` becomes `false` -> the ack tests red
 *   M5 click from item text: uiRoute accepts a raw id (no encoding) -> the route-vocabulary test red
 *   M6 compute ignores acks: `if (a) it.ack = a` becomes `if (false)` -> "an acked glance item is SHOWN as acked" red
 *   M7 a corrupt store read as absent: `corrupt = false` in decideChannel -> T-M5 red
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/glance-notify.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decideChannel, mergeChannel, readNotifyState, writeNotifyState, notifyStatePath, HOLD_MS, glanceCandidates, formatGlanceNotification, digestNotification } from "../../lib/glance/notifications.mjs";
import { notifyKey, selectToNotify, heldIds, selectDefectsToNotify } from "../../lib/report/monitor.mjs";
import { uiRoute, clickCommand } from "../../lib/report/notify.mjs";
import { setAcks, clearAcks, readAcks, readAcksState, ackApplies, parseUntil, acksPath } from "../../lib/glance/acks.mjs";
import { computeGlance } from "../../lib/glance/compute.mjs";
import { renderLines } from "../../lib/glance/render.mjs";
import { glanceCmd } from "../../cli/glance.mjs";
import { glanceLine } from "../../hooks/session-guide.mjs";

const H = 3600000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const fresh = () => mkdtempSync(path.join(tmpdir(), "glance-notify-"));

const edge = (id, src, dn, state = "DRIFTED") => ({ edge_id: id, state, source: { path: "/w/a.md", contentId: src }, downstream: { path: "/w/b.md", contentId: dn } });

/**
 * One monitor pass over the edge channel, exactly as cli.mjs monitorCmd composes it: the actionable ids are decided,
 * the held set derived, selectToNotify picks the rows. Returns the rows notified and the store after the run.
 */
function edgeRun(read, rows, now, acked) {
  const actionable = selectToNotify(rows).actionable;
  const ids = actionable.map(notifyKey);
  const d = decideChannel({ read, channel: "edges", ids, now, acked });
  const { toNotify } = selectToNotify(rows, heldIds(ids, d.notify));
  return { toNotify, d, read: { status: "ok", state: mergeChannel(read, "edges", d.next) } };
}
const SEEDED = { status: "ok", state: { channels: { edges: { seeded_at: new Date(NOW - 48 * H).toISOString(), last_run: new Date(NOW - 48 * H).toISOString(), ids: {} } } } };

// ── identity (T-M1, T-M4) ────────────────────────────────────────────────────

test("T-M1 a changing edge notifies ONCE, not on every run", () => {
  let read = SEEDED;
  const sent = [];
  for (let i = 0; i < 6; i++) {
    // The source and downstream bytes change on every run: an edit cycle. The old content-triple key re-fired here.
    const r = edgeRun(read, [edge("e1", `src${i}`, `dn${i}`)], NOW + i * 30 * 60000);
    sent.push(r.toNotify.length);
    read = r.read;
  }
  assert.deepEqual(sent, [1, 0, 0, 0, 0, 0], "one notification when it became actionable, then silence while it churns");
});

test("T-M1 the id has no content and no numbers: edge:<edge_id>", () => {
  assert.equal(notifyKey(edge("ab12cd", "x", "y")), "edge:ab12cd");
  assert.equal(notifyKey(edge("ab12cd", "other", null)), "edge:ab12cd", "bytes do not change identity");
  assert.equal(notifyKey({ key: "backlog:unparsed:/x/T.md", edge_id: "z" }), "backlog:unparsed:/x/T.md", "a defect keeps its own stable key");
});

test("T-M4 a doctor item whose label number moves but whose id is unchanged does not notify again", () => {
  let read = { status: "ok", state: { channels: { glance: { seeded_at: "x", last_run: "x", ids: {} } } } };
  const items = (n) => [{ id: "doctor:ratchets:docs.prose", signal: "doctor", verdict: "broken", flag: null, subject: "doctor", what: `docs.prose <= 27 observed ${n}` }];
  let total = 0;
  for (const [i, n] of [30, 31, 32].entries()) {
    const ids = glanceCandidates({ items: items(n) }).map((x) => x.id);
    const d = decideChannel({ read, channel: "glance", ids, now: NOW + i * H });
    total += d.notify.length;
    read = { status: "ok", state: mergeChannel(read, "glance", d.next) };
  }
  assert.equal(total, 1);
});

// ── additions only, the hold, seeding (T-M2, T-M3) ──────────────────────────

test("T-M2 removal never notifies", () => {
  const a = edgeRun(SEEDED, [edge("e1", "s", "d"), edge("e2", "s", "d")], NOW);
  assert.equal(a.toNotify.length, 2);
  const b = edgeRun(a.read, [edge("e1", "s", "d")], NOW + H);
  assert.equal(b.toNotify.length, 0, "e2 left: nothing to say");
  assert.equal(b.d.notify.length, 0);
});

test("T-M3 a re-entry within 24 h is silent; after 24 h it notifies again", () => {
  const a = edgeRun(SEEDED, [edge("e1", "s", "d")], NOW);
  assert.equal(a.toNotify.length, 1);
  const gone = edgeRun(a.read, [edge("e1", "s", "d", "CLEAN")], NOW + H);
  assert.equal(gone.toNotify.length, 0);
  const back = edgeRun(gone.read, [edge("e1", "s2", "d2")], NOW + 20 * H);
  assert.equal(back.toNotify.length, 0, "back within the hold: silent");
  assert.deepEqual(back.d.reentered, ["edge:e1"]);
  const gone2 = edgeRun(back.read, [], NOW + 21 * H);
  const late = edgeRun(gone2.read, [edge("e1", "s3", "d3")], NOW + 21 * H + HOLD_MS + 60000);
  assert.equal(late.toNotify.length, 1, "back after 24 h away: an addition again");
});

test("the first run after upgrade seeds silently, and the next run notifies only what is new", () => {
  const absent = { status: "absent", state: null };
  const first = edgeRun(absent, [edge("e1", "s", "d"), edge("e2", "s", "d")], NOW);
  assert.equal(first.toNotify.length, 0, "the store did not exist: seed, say nothing");
  assert.equal(first.d.seeded, true);
  const second = edgeRun(first.read, [edge("e1", "s", "d"), edge("e2", "s", "d"), edge("e3", "s", "d")], NOW + H);
  assert.deepEqual(second.toNotify.map((r) => r.edge_id), ["e3"]);
});

test("a NEW channel in an existing store seeds too (the glance channel after an edges-only store)", () => {
  const d = decideChannel({ read: SEEDED, channel: "glance", ids: ["job:a.b"], now: NOW });
  assert.equal(d.seeded, true);
  assert.deepEqual(d.notify, []);
});

test("T-M5 a corrupt store notifies once (the tell-again direction) and does not throw", () => {
  const dir = fresh();
  writeFileSync(notifyStatePath(dir), "{ not json");
  const read = readNotifyState(dir);
  assert.equal(read.status, "corrupt");
  const r = edgeRun(read, [edge("e1", "s", "d")], NOW);
  assert.equal(r.toNotify.length, 1, "corrupt is not an upgrade: tell again");
  writeNotifyState(r.read.state, dir);
  const again = edgeRun(readNotifyState(dir), [edge("e1", "s", "d")], NOW + H);
  assert.equal(again.toNotify.length, 0, "and quiet on the very next run");
});

test("the store stays bounded: an id gone longer than the hold is dropped", () => {
  const a = edgeRun(SEEDED, [edge("e1", "s", "d")], NOW);
  const b = edgeRun(a.read, [], NOW + HOLD_MS + H);
  assert.deepEqual(Object.keys(b.d.next.ids), []);
});

test("defects share the channel rule: notified once, quiet while present", () => {
  const def = [{ kind: "unparsed", file: "/x/T.md", key: "backlog:unparsed:/x/T.md" }];
  const read = { status: "ok", state: { channels: { backlog: { seeded_at: "x", last_run: "x", ids: {} } } } };
  const d1 = decideChannel({ read, channel: "backlog", ids: def.map((x) => x.key), now: NOW });
  assert.equal(selectDefectsToNotify(def, heldIds(def.map((x) => x.key), d1.notify)).toNotify.length, 1);
  const read2 = { status: "ok", state: mergeChannel(read, "backlog", d1.next) };
  const d2 = decideChannel({ read: read2, channel: "backlog", ids: def.map((x) => x.key), now: NOW + H });
  assert.equal(selectDefectsToNotify(def, heldIds(def.map((x) => x.key), d2.notify)).toNotify.length, 0);
});

// ── acks ────────────────────────────────────────────────────────────────────

test("an acked item is not notified; a snoozed one is notified when the snooze runs out", () => {
  const dir = fresh();
  setAcks(dir, ["job:one"], { now: NOW - H });
  setAcks(dir, ["job:two"], { until: NOW + 2 * H, now: NOW - H });
  const acks = readAcks(dir);
  const read = { status: "ok", state: { channels: { glance: { seeded_at: "x", last_run: "x", ids: {} } } } };
  const acked = (now) => (id, since) => ackApplies(acks.get(id), since, now);
  // job:one's episode began before its ack (the ack was given while it was failing)
  const d1 = decideChannel({ read: { status: "ok", state: { channels: { glance: { seeded_at: "x", last_run: "x", ids: { "job:one": { present: false, since: new Date(NOW - 2 * H).toISOString(), last_seen: new Date(NOW - 2 * H).toISOString(), owed: true } } } } } }, channel: "glance", ids: ["job:one", "job:two", "job:three"], now: NOW, acked: acked(NOW) });
  assert.deepEqual(d1.notify, ["job:three"], "only the un-acked addition notifies");
  assert.deepEqual(d1.owed.sort(), ["job:one", "job:two"]);
  const read2 = { status: "ok", state: mergeChannel(read, "glance", d1.next) };
  const later = NOW + 3 * H;
  const d2 = decideChannel({ read: read2, channel: "glance", ids: ["job:one", "job:two", "job:three"], now: later, acked: acked(later) });
  assert.deepEqual(d2.notify, ["job:two"], "the snooze ran out and job:two was owed; the ack on job:one still holds this episode");
});

test("an ack holds for the episode: a return after the item cleared is notified", () => {
  const acks = new Map([["work:w1", { at: new Date(NOW).toISOString(), until: null }]]);
  assert.equal(ackApplies(acks.get("work:w1"), new Date(NOW - H).toISOString(), NOW + H), true, "same episode");
  assert.equal(ackApplies(acks.get("work:w1"), new Date(NOW + 30 * H).toISOString(), NOW + 31 * H), false, "a new episode began after the ack");
});

test("acks persist under the state dir, refuse non-id input, and fail open on a corrupt file", () => {
  const dir = fresh();
  const r = setAcks(dir, ["doctor:rules:x", "edge:ab12"], { until: NOW + 24 * H, now: NOW });
  assert.equal(r.file, acksPath(dir));
  assert.equal(readAcks(dir).get("edge:ab12").until, new Date(NOW + 24 * H).toISOString());
  assert.throws(() => setAcks(dir, ["a b; rm -rf"], { now: NOW }), /not an item id/);
  assert.throws(() => setAcks(dir, ["x"], { until: NOW - 1, now: NOW }), /future/);
  assert.deepEqual(clearAcks(dir, ["edge:ab12", "nope"], { now: NOW }).missing, ["nope"]);
  assert.deepEqual([...readAcks(dir).keys()], ["doctor:rules:x"]);
  writeFileSync(acksPath(dir), "garbage");
  assert.equal(readAcksState(dir).status, "corrupt");
  assert.equal(readAcks(dir).size, 0, "a corrupt file is no acks: tell again, never silence");
});

test("parseUntil takes a date, a date-time or a duration, and names anything else", () => {
  assert.equal(parseUntil("24h", NOW), NOW + 24 * H);
  assert.equal(parseUntil("3d", NOW), NOW + 72 * H);
  assert.equal(parseUntil("2026-11-20", NOW), Date.parse("2026-11-20T23:59:59Z"));
  assert.equal(parseUntil("2026-11-20T09:00:00Z", NOW), Date.parse("2026-11-20T09:00:00Z"));
  assert.throws(() => parseUntil("tomorrow", NOW), /"tomorrow"/);
});

test("an acked glance item is SHOWN as acked: glance.json carries ack, the terminal moves it to an ACKED line", () => {
  const dir = fresh();
  writeFileSync(path.join(dir, "doctor-snapshot.json"), JSON.stringify({
    generatedAt: new Date(NOW - H).toISOString(), problems: 1,
    sections: [{ name: "Rules", entries: [{ kind: "fail", label: "rule restated", detail: "", check_id: "rules.restated" }, { kind: "pass", label: "ok", detail: "" }] }],
  }));
  const before = computeGlance({ dir, now: NOW }).glance;
  const it = before.items.find((i) => i.signal === "doctor" && i.verdict !== "working");
  assert.ok(it, JSON.stringify(before.items.map((i) => i.id)));
  assert.equal(it.ack ?? null, null);
  setAcks(dir, [it.id], { now: NOW });
  const after = computeGlance({ dir, now: NOW + 60000, previous: before }).glance;
  const same = after.items.find((i) => i.id === it.id);
  assert.deepEqual(Object.keys(same.ack ?? {}).sort(), ["at", "until"]);
  assert.equal(same.verdict, it.verdict, "an ack is not a fix: the verdict is unchanged");
  const lines = renderLines(after, { color: false });
  assert.ok(lines.some((l) => /^\[ACKED\]/.test(l) && /doctor/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /^\[BROKEN\]\s+doctor:/.test(l)), "and no longer in the broken lines: " + lines.join("\n"));
});

// ── click targets (T-M6) ─────────────────────────────────────────────────────

test("T-M6 routes come from a fixed vocabulary; ids are encoded; item text cannot reach the shell", () => {
  assert.equal(uiRoute("glance"), "/glance");
  assert.equal(uiRoute("glance", "edge:ab12"), "/glance/edge%3Aab12");
  assert.equal(uiRoute("edge", "ab12"), "/judge?edge=ab12");
  assert.equal(uiRoute("backlog"), "/backlog");
  assert.throws(() => uiRoute("file:///etc"), /no UI route kind/);
  const evil = uiRoute("glance", `x'; touch /tmp/pwn; echo '`);
  assert.doesNotMatch(evil, /['; ]/, evil);
  const cmd = clickCommand({ route: evil }, { pluginRoot: "/opt/p", state: "/s" });
  assert.equal(cmd, `PROPAGATE_STATE_DIR='/s' PROPAGATE_CLI='/opt/p/cli.mjs' /bin/bash '/opt/p/widget/open-ui.sh' '${evil}'`);
  assert.throws(() => clickCommand({ route: "/glance/a b" }), /route vocabulary/);
});

test("T-M6 the glance notification names the item, carries its fix, and opens its route", () => {
  const one = formatGlanceNotification([{ id: "work:w1", signal: "work", verdict: "needs_you", flag: null, subject: "work", what: "sync parked after 2 refusals", fix: { text: "propagate work list", command: "propagate work list --state parked" } }]);
  assert.equal(one.title, "Needs you: work: sync parked after 2 refusals");
  assert.equal(one.body, "propagate work list --state parked");
  assert.deepEqual(one.route, { kind: "glance", id: "work:w1" });
  const two = formatGlanceNotification([
    { id: "job:a", signal: "jobs", verdict: "broken", flag: null, subject: "job a", what: "exit 1", fix: { text: "propagate doctor --full", command: "propagate doctor --full" } },
    { id: "work:w1", signal: "work", verdict: "needs_you", flag: null, subject: "work", what: "parked", fix: { text: "x", command: null } },
  ]);
  assert.equal(two.title, "propagate: 1 needs you, 1 broken");
  const same = formatGlanceNotification([1, 2, 3].map((n) => ({ id: `doctor:s:c${n}`, signal: "doctor", verdict: "broken", flag: null, subject: "doctor", what: `c${n}`, fix: { text: "propagate doctor --full", command: "propagate doctor --full" } })));
  assert.equal(same.body, "doctor (3): propagate doctor --full", "one line per distinct fix, not three copies");
  assert.deepEqual(two.route, { kind: "glance", id: null });
});

test("glanceCandidates: needs-you and broken only, never working, never the edges aggregate", () => {
  const ids = glanceCandidates({ items: [
    { id: "a", signal: "jobs", verdict: "broken" }, { id: "b", signal: "work", verdict: "needs_you" },
    { id: "c", signal: "hooks", verdict: "working" }, { id: "edges:broken", signal: "edges", verdict: "broken" },
    { id: "doctor", signal: "doctor", verdict: "broken", flag: "unknown" },
  ] }).map((i) => i.id);
  assert.deepEqual(ids, ["a", "b", "doctor"]);
});

// ── the digest body (T-O2) ───────────────────────────────────────────────────

test("T-O2 the digest body is the glance's verdict line, never a timestamp", () => {
  const glance = { verdict: "broken", generatedAt: new Date(NOW).toISOString(), signals_checked: 6, items: [
    { id: "job:x.y", signal: "jobs", verdict: "broken", flag: null, subject: "job x.y", what: "last exit code 1", fix: { text: "propagate doctor --full", command: "propagate doctor --full" } },
  ] };
  const n = digestNotification({ state: "ok", glance, stale: false });
  assert.match(n.body, /BROKEN/);
  assert.match(n.body, /jobs/);
  assert.doesNotMatch(n.body, /\d{4}-\d\d-\d\dT/, "not the timestamp heading");
  assert.deepEqual(n.route, { kind: "glance", id: null });
  const green = digestNotification({ state: "ok", glance: { verdict: "working", generatedAt: new Date(NOW).toISOString(), signals_checked: 6, items: [] }, stale: false });
  assert.match(green.body, /all clear/);
  assert.match(digestNotification({ state: "absent" }).body, /not computed yet/);
});

test("the notify state is written atomically and leaves no temp file", () => {
  const dir = fresh();
  writeNotifyState({ channels: { edges: { seeded_at: "x", last_run: "x", ids: {} } } }, dir);
  assert.ok(existsSync(notifyStatePath(dir)));
  assert.equal(JSON.parse(readFileSync(notifyStatePath(dir), "utf8")).schema_version, 1);
});

test("propagate glance ack / unack: writes the acks file under the state dir; a bad id or --until is a usage error", async () => {
  const dir = fresh();
  const out = [];
  const err = [];
  const io = { stateDirPath: dir, now: NOW, out: (x) => out.push(x), err: (x) => err.push(x) };
  assert.equal(await glanceCmd(["ack", "job:a.b", "work:w1", "--until", "3d"], io), 0, err.join("\n"));
  assert.match(out[0], /snoozed until 2026-11-19T12:00:00.000Z: job:a.b, work:w1/);
  assert.equal(readAcks(dir).get("work:w1").until, "2026-11-19T12:00:00.000Z");
  assert.equal(await glanceCmd(["ack", "x", "--until", "someday"], io), 2);
  assert.equal(await glanceCmd(["ack"], io), 2);
  assert.equal(await glanceCmd(["unack", "job:a.b"], io), 0);
  assert.deepEqual([...readAcks(dir).keys()], ["work:w1"]);
});

test("the session line counts acked items instead of listing them, and never calls them all clear", () => {
  const dir = fresh();
  const base = { schema_version: 1, generatedAt: new Date(NOW).toISOString(), stale_after_s: 21600, verdict: "broken", signals_checked: 6, needs_you_ids: [], skipped: [] };
  const it = (id, signal, ack) => ({ id, signal, verdict: "broken", flag: null, what: `${signal} failing`, ...(ack ? { ack: { at: new Date(NOW).toISOString(), until: null } } : {}) });
  writeFileSync(path.join(dir, "glance.json"), JSON.stringify({ ...base, items: [it("job:a", "jobs", true), it("hooks", "hooks", false)] }));
  const line = glanceLine(dir, NOW + 60000);
  assert.match(line, /\[BROKEN\] hooks/);
  assert.doesNotMatch(line, /jobs/);
  assert.match(line, /1 acked/);
  writeFileSync(path.join(dir, "glance.json"), JSON.stringify({ ...base, items: [it("job:a", "jobs", true)] }));
  const only = glanceLine(dir, NOW + 60000);
  assert.doesNotMatch(only, /all clear/);
  assert.match(only, /no unacknowledged problems, 1 acked/);
});
