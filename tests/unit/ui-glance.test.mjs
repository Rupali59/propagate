/**
 * ui-glance.test.mjs — propagate#296: the web glance view, rendered by the REAL client over the vendored Preact
 * (tests/helpers/mount-client.mjs), and its two server endpoints, called as functions over a temp state dir.
 *
 *   - badges carry an icon, a word and a count (never colour alone, std:design-web-047), and every badge class has a
 *     stylesheet rule;
 *   - a route per item (`#/glance/<id>`) opens that item's detail pane;
 *   - filters by verdict and source;
 *   - right-click opens a row menu; multi-select drives BULK ack, whose request names every selected id;
 *   - the server: GET re-derives acks from the acks file, POST validates the whole request before writing.
 *
 * MUTATIONS RECORDED (run by hand; see the PR3 report):
 *   U1 GlanceBadge drops the word -> "every badge carries an icon, a word and a count" red
 *   U2 bulk ack sends only the first selected id -> "bulk ack" red
 *   U3 parseHash ignores glance/<id> -> "a route per item" red
 *   U4 rows lose onContextMenu -> "right-click on a row opens its action menu" red
 *   U5 glanceAckWrite skips checkIds -> "server: ... POST validates before writing" red
 *
 * Run: PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/ui-glance.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { byClass, byTag, textOf, findAll } from "../helpers/minidom.mjs";
import { mountClient, respond } from "../helpers/mount-client.mjs";
import { worklistWithUnplaced } from "../../lib/report/inbox.mjs";
import { buildLeverage } from "../../lib/report/surface.mjs";
import { glancePayload, glanceAckWrite, stylesheet } from "../../cli/ui.mjs";
import { setAcks, readAcks } from "../../lib/glance/acks.mjs";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const INBOX = {
  fatal: null, declared: 1, expanded: 1,
  divisions: { worklist: { error: null, actionable: 0, unplaced: 0, ready: [], blocked: [] }, parked: { error: null, items: [] }, gap: { error: null, total: 0, deferred: 0, buckets: null, bucketsLazy: true }, reference: { registers: null, lazy: true, error: null, sources: null } },
  worklist: worklistWithUnplaced([]), leverage: buildLeverage([], { root: "/u/" }), generatedAt: "2026-11-16T10:00:00.000Z",
};
const SURFACE = { generatedAt: "2026-11-16T10:00:00.000Z", health: { ok: false, reason: "fixture" } };

const item = (id, signal, verdict, over = {}) => ({
  id, signal, kind: "heartbeat", verdict, flag: null, owner: "you", subject: over.subject ?? signal, what: over.what ?? `${signal} thing`,
  line: "x", why: `${signal} because a cause; next: propagate doctor`, fix: { text: "propagate doctor --full", command: "propagate doctor --full" },
  since: iso(NOW - 3600000), looked_at: 2, source: `${signal} source`, ...over,
});
const GLANCE = {
  ok: true, state: "ok", ageMs: 60000, stale: false, generatedAt: iso(NOW), verdict: "needs_you", signals_checked: 6, skipped: [], needs_you_ids: ["work:w1"],
  items: [
    item("job:sample.collect", "jobs", "broken", { subject: "job sample.collect", what: "last exit code 1" }),
    item("work:w1", "work", "needs_you", { what: "sync parked after 2 refusals" }),
    item("doctor:rules:r1", "doctor", "broken", { what: "rule restated", ack: { at: iso(NOW - 60000), until: null } }),
    item("hooks", "hooks", "working", { what: "0 errors today" }),
    item("metrics", "metrics", "working", { flag: "learning", what: "learning" }),
  ],
};

const click = (node) => node.dispatchEvent({ type: "click", stopPropagation() {}, preventDefault() {} });
const change = (node) => { node.checked = !node.checked; node.dispatchEvent({ type: "change", stopPropagation() {} }); };
const mount = (opts = {}) => mountClient({
  inbox: INBOX, hash: "#/glance", speedUp: true, ...opts,
  routes: { "/api/surface": SURFACE, "/api/glance": GLANCE, "/api/glance/ack": respond(200, { ok: true, action: "ack", ids: [] }), ...(opts.routes || {}) },
});
const glanceRows = (app) => byClass(app, "gl-row");
const boxes = (root) => findAll(root, (n) => n.nodeType === 1 && n.localName === "input" && n.getAttribute("type") === "checkbox");

test("the glance view renders one row per item, needs-you first, each with a badge of icon, word and count", async () => {
  const m = await mount();
  assert.deepEqual(m.unstubbed, []);
  const rows = glanceRows(m.app);
  assert.equal(rows.length, 5, textOf(m.app).slice(0, 400));
  assert.match(textOf(rows[0]), /NEEDS YOU/);
  const badges = byClass(m.app, "badge").filter((b) => /\bgl-/.test(b.getAttribute("class")));
  assert.ok(badges.length >= 5);
  for (const b of badges) {
    const ic = byClass(b, "gl-ic")[0];
    assert.ok(ic && textOf(ic).trim().length >= 1, `icon missing in ${textOf(b)}`);
    assert.match(textOf(b), /(NEEDS YOU|BROKEN|UNKNOWN|LEARNING|OK|ACKED)/, `word missing in ${textOf(b)}`);
    assert.match(textOf(byClass(b, "gl-n")[0] ?? { childNodes: [] }), /^\d+$/, `count missing in ${textOf(b)}`);
  }
  const acked = rows.find((r) => /rule restated/.test(textOf(r)));
  assert.match(textOf(acked), /ACKED/, "an acked item is SHOWN as acked");
});

test("every glance badge class has its own stylesheet rule", async () => {
  const css = stylesheet();
  for (const k of ["needs_you", "broken", "unknown", "learning", "working", "acked"]) {
    assert.ok(css.includes(`.badge.gl-${k} {`), `no rule for .badge.gl-${k}`);
  }
});

test("a route per item: #/glance/<id> opens that item's detail pane", async () => {
  const m = await mount({ hash: "#/glance/" + encodeURIComponent("job:sample.collect") });
  const d = byClass(m.app, "gl-detail")[0];
  assert.ok(d, "detail pane rendered");
  assert.match(textOf(d), /job sample\.collect/);
  assert.match(textOf(d), /propagate doctor --full/);
  assert.match(textOf(d), /jobs source/, "the source is shown in the detail");
  assert.match(textOf(d), /job:sample\.collect/);
  assert.equal(m.ui.parseHash("#/glance/edge%3Aab12?verdict=broken").item, "edge:ab12");
  assert.equal(m.ui.parseHash("#/glance/edge%3Aab12?verdict=broken").view, "glance");
});

test("filters by verdict and by source narrow the rows and ride in the hash", async () => {
  const m = await mount({ hash: "#/glance?verdict=broken" });
  assert.deepEqual(glanceRows(m.app).map((r) => r.getAttribute("data-id")), ["job:sample.collect"]);
  const m2 = await mount({ hash: "#/glance?source=work" });
  assert.deepEqual(glanceRows(m2.app).map((r) => r.getAttribute("data-id")), ["work:w1"]);
  assert.equal(m.ui.glanceHash({ verdict: "broken", source: "jobs" }, null), "glance?verdict=broken&source=jobs");
});

test("right-click on a row opens its action menu", async () => {
  const m = await mount();
  const row = glanceRows(m.app).find((r) => r.getAttribute("data-id") === "work:w1");
  row.dispatchEvent({ type: "contextmenu", clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {} });
  await m.settle();
  const menu = byClass(m.app, "gl-menu")[0];
  assert.ok(menu, "menu rendered");
  const labels = byTag(menu, "button").map((b) => textOf(b).trim());
  assert.deepEqual(labels, ["Open detail", "Copy fix", "Acknowledge", "Snooze 24 h", "Snooze 7 days"]);
});

test("bulk ack: selecting two rows and pressing Acknowledge sends ONE request naming both ids", async () => {
  const m = await mount();
  const pick = (id) => change(boxes(glanceRows(m.app).find((r) => r.getAttribute("data-id") === id))[0]);
  pick("job:sample.collect");
  await m.settle();
  pick("work:w1");
  await m.settle();
  const bar = byClass(m.app, "bulkstrip")[0];
  assert.ok(bar, "the bulk bar appears once something is selected");
  assert.match(textOf(bar), /2 items selected/);
  click(byTag(bar, "button").find((b) => /^Acknowledge 2/.test(textOf(b))));
  await m.settle();
  const posts = m.fetches.filter((f) => f.path === "/api/glance/ack");
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].body);
  assert.equal(body.action, "ack");
  assert.deepEqual(body.ids.slice().sort(), ["job:sample.collect", "work:w1"]);
  assert.equal(body.until, null);
  assert.ok(m.fetches.filter((f) => f.path === "/api/glance").length >= 2, "the list is re-read after the write");
});

test("server: GET re-derives acks from the file; POST validates before writing and persists under the state dir", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ui-glance-"));
  const g = { schema_version: 1, generatedAt: iso(NOW), stale_after_s: 21600, verdict: "broken", signals_checked: 2, needs_you_ids: [], skipped: [],
    items: [item("job:a.b", "jobs", "broken"), item("hooks", "hooks", "working")] };
  writeFileSync(path.join(dir, "glance.json"), JSON.stringify(g));
  assert.equal(glancePayload(dir, NOW).items[0].ack, undefined);
  const bad = glanceAckWrite({ action: "ack", ids: ["ok:id", "../../etc/passwd x"] }, dir, NOW);
  assert.equal(bad.code, 400);
  assert.equal(readAcks(dir).size, 0, "a refused request writes nothing");
  assert.equal(glanceAckWrite({ action: "nuke", ids: ["job:a.b"] }, dir, NOW).code, 400);
  const ok = glanceAckWrite({ action: "ack", ids: ["job:a.b"], until: "24h" }, dir, NOW);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  const after = glancePayload(dir, NOW + 1000);
  assert.equal(after.items[0].ack.until, iso(NOW + 24 * 3600000));
  assert.equal(after.items[1].ack, undefined, "a working item is never shown acked");
  assert.equal(glanceAckWrite({ action: "unack", ids: ["job:a.b"] }, dir, NOW).code, 200);
  assert.equal(glancePayload(dir, NOW + 2000).items[0].ack, undefined);
  setAcks(dir, ["job:a.b"], { now: NOW });
  assert.ok(JSON.parse(readFileSync(path.join(dir, "glance-acks.json"), "utf8")).acks["job:a.b"]);
  const absent = glancePayload(mkdtempSync(path.join(tmpdir(), "ui-glance-empty-")), NOW);
  assert.equal(absent.state, "absent", "an absent glance is a named state, never an empty list");
});

test("the glance is in the TODAY group of the rail", async () => {
  const m = await mount();
  const today = m.ui.railGroups(m.ui.DIVISIONS)[0];
  assert.equal(today.key, "today");
  assert.ok(today.items.some((d) => d.key === "glance"));
});
