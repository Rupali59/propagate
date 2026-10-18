/**
 * The `propagate ui` HTTP server, driven over real sockets with injected data.
 *
 * WHAT THIS PROVES (plan "Eng review 2026-10-15", lane A): the write path's
 * guards at the level a browser reaches them -- the request body in, the event
 * store out. tests/cli/ui-dispose-batch.test.mjs covers the pure gates; this
 * file covers the ROUTE, which is where D9/D11 (which rows are members), F1
 * (observed), F9 (401 vs 403) and F12 (a throw must answer JSON, not kill the
 * process) live.
 *
 * THE STORE IS SCOPED HERE, NOT BY THE CALLER (GOTCHAS G56). lib/edges/events.mjs
 * fixes EVENTS_DIR from PROPAGATE_STATE_DIR when it is first imported, and
 * `node --test` runs files concurrently, so a shared test store would make a
 * before/after snapshot race with other files' appends. So this file makes its
 * own directory and imports everything AFTER setting it -- which is why every
 * import below is dynamic. Static imports are hoisted above the assignment.
 *
 * "NOTHING APPENDED" IS ASSERTED ON THE STORE, never on the response
 * (rule:safety-flag-needs-a-test): a guard that threw after writing would
 * satisfy every status-code assertion.
 */
// @size medium — starts processes (CLI or script); run when affected
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const STATE = mkdtempSync(path.join(tmpdir(), "ui-server-state-"));
process.env.PROPAGATE_STATE_DIR = STATE;
// The seen-set and cursor must resolve under STATE too (stream.mjs reads this at import).
delete process.env.PROPAGATE_STREAM_CURSOR;
delete process.env.PROPAGATE_SEEN_EDGES;

const { uiCmd, buildId } = await import("../../cli/ui.mjs");
const { CURSOR_PATH } = await import("../../lib/report/stream.mjs");
const { SEEN_PATH } = await import("../../lib/report/seen-edges.mjs");
const { appendEvent } = await import("../../lib/edges/events.mjs");

const FIX = mkdtempSync(path.join(tmpdir(), "ui-server-files-"));
const file = (name, text) => { const p = path.join(FIX, name); writeFileSync(p, text); return p; };

function storeSnapshot() {
  const dir = path.join(STATE, "events");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => readFileSync(path.join(dir, f), "utf8")).join("");
}
const storeLines = () => storeSnapshot().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

let ROWS = [];
function mkRow(id, state, extra = {}) {
  return {
    edge_id: id,
    node_id: "/n/" + id,
    state,
    why: "fixture",
    source: { path: file(`src-${id}.md`, `source of ${id}\n`), contentId: "src-" + id },
    downstream: { path: file(`dst-${id}.md`, `downstream of ${id}\n`), contentId: "dst-" + id },
    ...extra,
  };
}

const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

let ctx;       // the server with injected data
let real;      // a server built with NO overrides: the production construction path
let hooks = {}; // per-test behaviour for the injected dependencies

before(async () => {
  const quiet = { log() {} };
  const port = await free();
  const deps = {
    loadWorkspaces: async () => { if (hooks.reconcileThrows) throw new Error("reconcile exploded"); return []; },
    reconcile: async () => ({ rows: ROWS, stats: { edges: ROWS.length, expanded: ROWS.length } }),
  };
  const inboxDeps = {
    loadWorkspaces: deps.loadWorkspaces,
    reconcile: deps.reconcile,
    historyByEdge: async () => new Map(),
    planBaseline: () => ({ neverVerifiedCount: 0, outcomes: { examinedAndDeferred: [] } }),
    registerQueue: () => ({ issues: [], todos: [] }),
  };
  const r = await uiCmd(["--port", String(port)], quiet, {
    deps,
    inboxDeps,
    root: FIX + "/",
    readSnapshot: async () => { if (hooks.snapshotThrows) throw new Error("snapshot exploded"); return { ok: false, reason: "none", ageMs: null }; },
    evidenceFor: async (b) => { if (hooks.evidenceThrows) throw new Error("diff exploded"); return (await import("../../lib/report/evidence.mjs")).evidenceFor(b); },
    surfacePayload: async () => { if (hooks.surfaceThrows) throw new Error("surface exploded"); return { fixture: "surface" }; },
    // ttlMs 0: every request recomputes, so a per-test hook is seen. The cache itself is tested in machinery.test.mjs.
    // "history" (Phase 4b) is page-only: it has no count and no tile, so it returns a detail and nothing else.
    machinery: { ttlMs: 0, sources: { ...Object.fromEntries(["claims", "rules", "caps", "skills", "backlog", "goals"].map((k) => [k, async () => {
      if (hooks.machineryThrows === k) throw new Error(k + " exploded");
      return { count: 7, of: 9, label: k + " things", top: "top of " + k, detail: { rows: [{ id: k + "-row" }], summary: { of: k } } };
    }])), history: async () => {
      if (hooks.machineryThrows === "history") throw new Error("history exploded");
      return { detail: { parts: [{ key: "doctor", status: "none" }], summary: { withARecord: 0, of: 3 } } };
    } } },
  });
  ctx = { ...r, port, cookie: `ptok=${r.token}` };

  const port2 = await free();
  real = { ...(await uiCmd(["--port", String(port2)], quiet)), port: port2 };
});

after(async () => {
  for (const c of [ctx, real]) await new Promise((res) => c?.server.close(res));
  rmSync(STATE, { recursive: true, force: true });
  rmSync(FIX, { recursive: true, force: true });
});

/** node:http rather than fetch: fetch will not let a test set Host or Origin. */
function call(c, method, pathAndQuery, { body, headers = {}, token = c.token } = {}) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const target = token === null ? pathAndQuery : `${pathAndQuery}${sep}token=${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: c.port, path: target, method, headers: { host: `127.0.0.1:${c.port}`, ...headers } }, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d));
      res.on("end", () => {
        let json = null; try { json = JSON.parse(raw); } catch { /* html or text */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const dispose = (body) => call(ctx, "POST", "/api/dispose", { body });
const REASON = "reviewed both sides, no change is needed here";
const edges = (...pairs) => pairs.map(([edge_id, state, observed]) => (observed ? { edge_id, state, observed } : { edge_id, state }));

// ── F9: 401 for a token, 403 for Host / Origin ──────────────────────────────

test("F9: a missing or wrong token is 401 {ok:false,error:'token'}; Host and Origin refusals stay 403", async () => {
  const none = await call(ctx, "GET", "/api/inbox", { token: null });
  assert.equal(none.status, 401);
  assert.deepEqual(none.json, { ok: false, error: "token" });
  const wrong = await call(ctx, "GET", "/api/inbox", { token: "nope" });
  assert.equal(wrong.status, 401);

  const host = await call(ctx, "GET", "/api/inbox", { headers: { host: "evil.example.com" } });
  assert.equal(host.status, 403);
  assert.notEqual(host.json.error, "token");
  const origin = await call(ctx, "GET", "/api/inbox", { headers: { origin: "https://evil.example.com" } });
  assert.equal(origin.status, 403);

  // The graph route shares the guard; it answers text, with the same split.
  assert.equal((await call(ctx, "GET", "/graph", { token: "nope" })).status, 401);
});

test("F9: the page with a bad token is not a 200", async () => {
  const bad = await call(ctx, "GET", "/", { token: "nope" });
  assert.notEqual(bad.status, 200);
  assert.equal(bad.status, 404, "current behaviour kept: an unknown token on the page is not found");
  // A tokened visit is now a 302 to the clean URL (cookie session); the cookie serves the page.
  assert.equal((await call(ctx, "GET", "/", {})).status, 302);
  assert.equal((await call(ctx, "GET", "/", { token: null, headers: { cookie: ctx.cookie } })).status, 200);
});

// ── F5: /api/version and data-build ─────────────────────────────────────────

test("F5: /api/version serves the build id the server started from, and the page carries data-build", async () => {
  const v = await call(ctx, "GET", "/api/version");
  assert.equal(v.status, 200);
  assert.equal(v.json.ok, true);
  assert.match(v.json.build, /^[0-9a-f]{16}$/);
  assert.equal(v.json.build, buildId());
  const html = (await call(ctx, "GET", "/", { token: null, headers: { cookie: ctx.cookie } })).raw;
  assert.ok(html.includes(` data-build="${v.json.build}"`), "the page must carry the same id the server reports");
  // Behind the token like every /api route.
  assert.equal((await call(ctx, "GET", "/api/version", { token: "nope" })).status, 401);
});

test("the production construction path: a server built with NO overrides answers /api/version and refuses a bad token", async () => {
  const v = await call(real, "GET", "/api/version");
  assert.equal(v.status, 200);
  assert.equal(v.json.build, buildId());
  assert.equal((await call(real, "GET", "/api/inbox", { token: "x" })).status, 401);
});

// ── D9 + F2 over HTTP ───────────────────────────────────────────────────────

test("D9: a mixed-state, cross-node selection writes both, each carrying the one reason", async () => {
  ROWS = [mkRow("m1", "DRIFTED"), mkRow("m2", "REVERSED")];
  const before = storeLines().length;
  const r = await dispose({ edges: edges(["m1", "DRIFTED"], ["m2", "REVERSED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json.results.map((x) => x.edge_id), ["m1", "m2"], "results come back in the order sent");
  const added = storeLines().slice(before);
  assert.deepEqual(new Set(added.map((e) => e.edge_id)), new Set(["m1", "m2"]));
  assert.ok(added.every((e) => e.reason === REASON && e.node_id.startsWith("/n/")));
});

test("D9: a foreign id is a per-edge 'not actionable' and nothing is appended -- even though the row exists in the world", async () => {
  ROWS = [mkRow("f1", "DRIFTED"), mkRow("f2", "NEVER_VERIFIED")];
  const before = storeSnapshot();
  // f2 EXISTS in the reconciled rows; it is simply not one of the server's queue items.
  const r = await dispose({ edges: edges(["f2", "NEVER_VERIFIED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(r.status, 207);
  assert.equal(r.json.results[0].ok, false);
  assert.match(r.json.results[0].error, /not actionable/);
  assert.equal(storeSnapshot(), before, "a non-parked NEVER_VERIFIED edge must not reach the store");
});

test("D9: 207 on partial failure -- the valid member lands, the foreign one does not", async () => {
  ROWS = [mkRow("p1", "DRIFTED"), mkRow("p2", "DRIFTED")];
  const before = storeLines().length;
  const r = await dispose({ edges: edges(["p1", "DRIFTED"], ["ghost", "DRIFTED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(r.status, 207);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.results.map((x) => x.ok), [true, false]);
  assert.deepEqual(storeLines().slice(before).map((e) => e.edge_id), ["p1"]);
});

test("D9: a member whose state moved is refused, store unchanged", async () => {
  ROWS = [mkRow("v1", "REVERSED")];
  const before = storeSnapshot();
  const r = await dispose({ edges: edges(["v1", "DRIFTED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(r.status, 207);
  assert.match(r.json.results[0].error, /moved to REVERSED/);
  assert.equal(storeSnapshot(), before);
});

test("F2: edges:[] is 400 and writes nothing", async () => {
  ROWS = [mkRow("z1", "DRIFTED")];
  const before = storeSnapshot();
  const r = await dispose({ edges: [], disposition: "no-change-needed", reason: REASON });
  assert.equal(r.status, 400);
  assert.equal(storeSnapshot(), before);
});

test("F2: a reason under 12 characters (after trimming) is 400 and writes nothing", async () => {
  ROWS = [mkRow("r1", "DRIFTED")];
  const before = storeSnapshot();
  const r = await dispose({ edges: edges(["r1", "DRIFTED"]), disposition: "no-change-needed", reason: "   short   " });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /12 characters/);
  assert.equal(storeSnapshot(), before);
});

test("F2: a disposition one member cannot take is refused for THAT member only", async () => {
  ROWS = [mkRow("a1", "DRIFTED"), mkRow("a2", "DIVERGED")];
  const before = storeLines().length;
  const r = await dispose({ edges: edges(["a1", "DRIFTED"], ["a2", "DIVERGED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(r.status, 207);
  assert.deepEqual(r.json.results.map((x) => x.ok), [true, false]);
  assert.match(r.json.results[1].error, /both-reconciled/);
  assert.deepEqual(storeLines().slice(before).map((e) => e.edge_id), ["a1"]);
});

test("F2: more ids than the queue holds, and duplicate ids, are 400 and write nothing", async () => {
  ROWS = [mkRow("l1", "DRIFTED"), mkRow("l2", "DRIFTED")];
  const before = storeSnapshot();
  const many = await dispose({ edges: edges(["l1", "DRIFTED"], ["l2", "DRIFTED"], ["l3", "DRIFTED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(many.status, 400);
  const dup = await dispose({ edges: edges(["l1", "DRIFTED"], ["l1", "DRIFTED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(dup.status, 400);
  assert.equal(storeSnapshot(), before);
});

// ── F1: observed ────────────────────────────────────────────────────────────

test("F1: /api/evidence returns the contentId pair it diffed", async () => {
  ROWS = [mkRow("c1", "DRIFTED")];
  const r = await call(ctx, "POST", "/api/evidence", { body: { kind: "edge", edge_id: "c1" } });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.json.contentIds, { source: "src-c1", downstream: "dst-c1" });
});

test("F1: a content change between the evidence call and the flush is a per-edge 409, store unchanged (single, node_id, edges)", async () => {
  ROWS = [mkRow("o1", "DRIFTED"), mkRow("o2", "DRIFTED", { node_id: "/n/shared" }), mkRow("o3", "DRIFTED", { node_id: "/n/shared" })];
  const ev = await call(ctx, "POST", "/api/evidence", { body: { kind: "edge", edge_id: "o1" } });
  const seen = ev.json.contentIds;
  // The file changes AFTER the diff was drawn.
  ROWS = ROWS.map((r) => ({ ...r, source: { ...r.source, contentId: "src-CHANGED-" + r.edge_id } }));
  const before = storeSnapshot();

  const single = await dispose({ edge_id: "o1", disposition: "no-change-needed", reason: REASON, observed: seen });
  assert.equal(single.status, 409);
  assert.match(single.json.error, /source changed/);

  const batch = await dispose({ node_id: "/n/shared", state: "DRIFTED", disposition: "no-change-needed", reason: REASON,
    observed: { o2: { source: "src-o2", downstream: "dst-o2" }, o3: { source: "src-o3", downstream: "dst-o3" } } });
  assert.equal(batch.status, 207);
  assert.deepEqual(batch.json.results.map((x) => x.code), [409, 409]);

  const multi = await dispose({ edges: edges(["o1", "DRIFTED", seen]), disposition: "no-change-needed", reason: REASON });
  assert.equal(multi.status, 207);
  assert.equal(multi.json.results[0].code, 409);

  assert.equal(storeSnapshot(), before, "no shape may pin content the reviewer did not read");
});

test("F1: an unchanged observed pair writes; a malformed one is 400 and writes nothing", async () => {
  ROWS = [mkRow("k1", "DRIFTED"), mkRow("k2", "DRIFTED")];
  const bad = storeSnapshot();
  const malformed = await dispose({ edge_id: "k1", disposition: "no-change-needed", reason: REASON, observed: { source: "src-k1" } });
  assert.equal(malformed.status, 400);
  assert.equal(storeSnapshot(), bad);
  const ok = await dispose({ edge_id: "k1", disposition: "no-change-needed", reason: REASON, observed: { source: "src-k1", downstream: "dst-k1" } });
  assert.equal(ok.status, 200, ok.raw);
  const noObserved = await dispose({ edge_id: "k2", disposition: "no-change-needed", reason: REASON });
  assert.equal(noObserved.status, 200, "back-compat: a body without observed still writes");
});

// ── D11: parked edges ───────────────────────────────────────────────────────

const parkedRow = (id, extra = {}) => mkRow(id, "NEVER_VERIFIED", { deferred: { ts: "2026-09-01T00:00:00Z", reason: "waiting", by: "t" }, ...extra });

test("D11: a parked (deferred NEVER_VERIFIED) edge is accepted, single and in an edges batch", async () => {
  ROWS = [parkedRow("pk1"), parkedRow("pk2"), mkRow("pk3", "DRIFTED")];
  const before = storeLines().length;
  const one = await dispose({ edge_id: "pk1", disposition: "no-change-needed", reason: REASON });
  assert.equal(one.status, 200, one.raw);
  const many = await dispose({ edges: edges(["pk2", "NEVER_VERIFIED"], ["pk3", "DRIFTED"]), disposition: "no-change-needed", reason: REASON });
  assert.equal(many.status, 200, many.raw);
  assert.deepEqual(storeLines().slice(before).map((e) => e.edge_id), ["pk1", "pk2", "pk3"]);
});

test("D11: a NON-parked NEVER_VERIFIED edge is still refused (single and evidence), store unchanged", async () => {
  ROWS = [mkRow("nv1", "NEVER_VERIFIED")];
  const before = storeSnapshot();
  const w = await dispose({ edge_id: "nv1", disposition: "no-change-needed", reason: REASON });
  assert.equal(w.status, 400);
  assert.match(w.json.error, /no actionable edge/);
  const ev = await call(ctx, "POST", "/api/evidence", { body: { kind: "edge", edge_id: "nv1" } });
  assert.equal(ev.status, 404);
  assert.equal(storeSnapshot(), before);
});

test("D11: a parked edge goes through the SAME guards -- both-reconciled is refused on it, and the ordering guard applies", async () => {
  ROWS = [parkedRow("pg1")];
  const before = storeSnapshot();
  const r = await dispose({ edge_id: "pg1", disposition: "both-reconciled", reason: REASON });
  assert.equal(r.status, 400, "validateWrite: both-reconciled is not in a NEVER_VERIFIED edge's allowed list");
  assert.equal(storeSnapshot(), before);

  // Ordering: an unsettled upstream into the parked edge's source blocks pinning dispositions.
  const up = mkRow("up", "DRIFTED");
  const parked = parkedRow("pg2", { source: { path: up.downstream.path, contentId: "mid" } });
  ROWS = [up, parked];
  const blocked = await dispose({ edge_id: "pg2", disposition: "no-change-needed", reason: REASON });
  assert.ok(blocked.status === 400 || blocked.status === 409, blocked.raw);
  assert.equal(storeSnapshot(), before, "the ordering guard must hold for a parked edge as it does for a queued one");
});

test("D11: a DIVERGED edge that is also deferred is offered only both-reconciled", async () => {
  ROWS = [mkRow("dv1", "DIVERGED", { deferred: { ts: "2026-09-01T00:00:00Z", reason: "waiting" } })];
  const before = storeSnapshot();
  const bad = await dispose({ edge_id: "dv1", disposition: "no-change-needed", reason: REASON });
  assert.equal(bad.status, 400);
  assert.equal(storeSnapshot(), before);
  const good = await dispose({ edge_id: "dv1", disposition: "both-reconciled", reason: REASON });
  assert.equal(good.status, 200, good.raw);
});

test("D11: evidence for a parked edge is the current content, labelled 'no earlier verdict to diff against'", async () => {
  ROWS = [parkedRow("pe1")];
  const ev = await call(ctx, "POST", "/api/evidence", { body: { kind: "edge", edge_id: "pe1" } });
  assert.equal(ev.status, 200, ev.raw);
  assert.equal(ev.json.ok, true);
  assert.equal(ev.json.noPriorVerdict, true);
  assert.match(ev.json.reason, /no earlier verdict to diff against/);
  assert.equal(ev.json.text, "source of pe1\n");
  assert.equal(ev.json.downstream.noPriorVerdict, true);
  assert.equal(ev.json.downstream.text, "downstream of pe1\n");
  assert.deepEqual(ev.json.contentIds, { source: "src-pe1", downstream: "dst-pe1" });
});

// ── D10: counts inside /api/inbox ───────────────────────────────────────────

test("D10: /api/inbox returns the widget's worklist and leverage over the rows it renders, plus contentKey", async () => {
  ROWS = [mkRow("i1", "DRIFTED"), mkRow("i2", "DIVERGED"), mkRow("i3", "REVERSED")];
  const r = await call(ctx, "GET", "/api/inbox");
  assert.equal(r.status, 200, r.raw);
  const rendered = r.json.divisions.worklist.ready.length + r.json.divisions.worklist.blocked.length;
  assert.equal(r.json.worklist.total, rendered, "the badge denominator is the rendered list");
  assert.equal(r.json.worklist.toJudge, 2, "unblocked and not DIVERGED");
  assert.ok(r.json.leverage && "roots" in r.json.leverage);
  const keys = r.json.divisions.worklist.ready.map((i) => i.contentKey).sort();
  assert.deepEqual(keys, ["i1|src-i1|dst-i1", "i2|src-i2|dst-i2", "i3|src-i3|dst-i3"]);
});

// ── /api/surface ────────────────────────────────────────────────────────────

test("/api/surface serves surfacePayload behind the token, and a throw is a 500 JSON body", async () => {
  const ok = await call(ctx, "GET", "/api/surface");
  assert.deepEqual(ok.json, { fixture: "surface" });
  assert.equal((await call(ctx, "GET", "/api/surface", { token: "nope" })).status, 401);
  hooks.surfaceThrows = true;
  try {
    const bad = await call(ctx, "GET", "/api/surface");
    assert.equal(bad.status, 500);
    assert.deepEqual(bad.json, { ok: false, error: "surface exploded" });
  } finally { hooks = {}; }
});

// ── /api/machinery (dashboard Phase 2) ──────────────────────────────────────

test("/api/machinery answers six blocks behind the token, and one failing source is status:error with its message, never a 0", async () => {
  const ok = await call(ctx, "GET", "/api/machinery");
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json).filter((k) => ok.json[k] && ok.json[k].status), ["claims", "rules", "caps", "skills", "backlog", "goals"]);
  assert.deepEqual(ok.json.skills, { status: "ok", reason: null, count: 7, of: 9, label: "skills things", top: "top of skills" });
  assert.equal((await call(ctx, "GET", "/api/machinery", { token: "nope" })).status, 401);
  hooks.machineryThrows = "caps";
  try {
    const bad = await call(ctx, "GET", "/api/machinery");
    assert.equal(bad.status, 200, "one bad source is not a failed request");
    assert.equal(bad.json.caps.status, "error");
    assert.equal(bad.json.caps.reason, "caps exploded");
    assert.equal(bad.json.caps.count, null, "a failed source has no count: null, never 0");
    assert.equal(bad.json.claims.status, "ok", "the other five are untouched");
  } finally { hooks = {}; }
});

// ── the four pages behind the tiles (dashboard Phase 4a) ────────────────────

test("/api/claims, /rules, /caps, /skills, /backlog and /goals answer their rows from the same source as the tile, behind the token", async () => {
  for (const k of ["claims", "rules", "caps", "skills", "backlog", "goals"]) {
    const r = await call(ctx, "GET", "/api/" + k);
    assert.equal(r.status, 200, k);
    assert.equal(r.json.ok, true, k);
    assert.deepEqual(r.json.rows, [{ id: k + "-row" }], k + " sends the source's rows");
    assert.deepEqual(r.json.headline, { count: 7, of: 9, label: k + " things" }, k + " carries the tile's own headline");
    assert.equal((await call(ctx, "GET", "/api/" + k, { token: "nope" })).status, 401, k + " is behind the token");
    assert.equal((await call(ctx, "POST", "/api/" + k, { body: {} })).status === 200, false, k + " is not a write route");
  }
  const tile = await call(ctx, "GET", "/api/machinery");
  assert.equal(tile.json.claims.count, 7);
  assert.equal(tile.json.claims.rows, undefined, "the tile payload does not carry the rows");
  assert.equal(tile.json.details, undefined, "and the detail map is not serialised");
});

test("/api/history (Phase 4b) answers the recorded parts behind the token, has no headline and no tile block, and a failure is a 502 with its reason", async () => {
  const r = await call(ctx, "GET", "/api/history");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.parts, [{ key: "doctor", status: "none" }]);
  assert.equal(r.json.headline, null, "history has no tile, so no headline figure");
  assert.equal((await call(ctx, "GET", "/api/history", { token: "nope" })).status, 401);
  assert.equal((await call(ctx, "POST", "/api/history", { body: {} })).status === 200, false, "not a write route");
  const tile = await call(ctx, "GET", "/api/machinery");
  assert.equal(tile.json.history, undefined, "the tile payload has six blocks; history is not one of them");
  hooks.machineryThrows = "history";
  try {
    const bad = await call(ctx, "GET", "/api/history");
    assert.equal(bad.status, 502);
    assert.deepEqual(bad.json, { ok: false, error: "history exploded" });
    assert.equal((await call(ctx, "GET", "/api/backlog")).status, 200, "the other pages are untouched");
  } finally { hooks = {}; }
});

test("a failed source is a 502 carrying its reason on its own page, never an empty table; the other pages are untouched", async () => {
  hooks.machineryThrows = "caps";
  try {
    const bad = await call(ctx, "GET", "/api/caps");
    assert.equal(bad.status, 502);
    assert.deepEqual(bad.json, { ok: false, error: "caps exploded" });
    assert.equal((await call(ctx, "GET", "/api/claims")).status, 200, "claims is fine");
  } finally { hooks = {}; }
});

test("?fresh=1 on a page bypasses the cache the tile shares; without it the page and the tile are one computation", async () => {
  // Its own server: ctx runs with ttlMs 0 (every request recomputes), which would hide a dropped `fresh`.
  let runs = 0;
  const port = await free();
  const counted = Object.fromEntries(["claims", "rules", "caps", "skills", "backlog", "goals"].map((k) => [k, async () => { runs += 1; return { count: runs, label: k, top: "", detail: { rows: [{ id: "r" + runs }], summary: {} } }; }]));
  const r = await uiCmd(["--port", String(port)], { log() {} }, {
    deps: { loadWorkspaces: async () => [], reconcile: async () => ({ rows: [], stats: { edges: 0, expanded: 0 } }) },
    inboxDeps: { loadWorkspaces: async () => [], reconcile: async () => ({ rows: [], stats: { edges: 0, expanded: 0 } }), historyByEdge: async () => new Map(), planBaseline: () => ({ neverVerifiedCount: 0, outcomes: { examinedAndDeferred: [] } }), registerQueue: () => ({ issues: [], todos: [] }) },
    root: FIX + "/", readSnapshot: async () => ({ ok: false, reason: "none", ageMs: null }),
    machinery: { ttlMs: 60_000, sources: counted },
  });
  const c = { ...r, port };
  try {
    await call(c, "GET", "/api/machinery");
    const a = await call(c, "GET", "/api/claims");
    assert.equal(runs, 6, "the tile and the page ran the six sources once between them");
    assert.deepEqual(a.json.rows, [{ id: "r1" }], "the page shows the computation the tile used");
    await call(c, "GET", "/api/claims?fresh=1");
    assert.equal(runs, 12, "fresh recomputed");
    const b = await call(c, "GET", "/api/claims");
    assert.deepEqual(b.json.rows, [{ id: "r7" }], "and what it computed is what is held afterwards");
    assert.equal(runs, 12);
  } finally { await new Promise((res) => c.server.close(res)); }
});

test("/api/rules is the Rules page's data now: coverage rows, not the raw hub rules check with whole file bodies", async () => {
  const r = await call(real, "GET", "/api/rules");
  assert.equal(r.json.findings, undefined, "the old raw checkRules shape is gone");
  assert.ok(r.status === 200 || r.status === 502, "production path answers a page or a reason, got " + r.status);
  if (r.status === 200) assert.ok(Array.isArray(r.json.rows) && r.json.summary, "rows and a summary");
  else assert.ok(r.json.error, "a 502 says why");
});

test("/api/backlog, /goals and /history on the production construction path answer a page or a reason (the default sources are the arm the injected ones bypass)", async () => {
  for (const k of ["backlog", "goals"]) {
    const r = await call(real, "GET", "/api/" + k);
    assert.ok(r.status === 200 || r.status === 502, k + " answered " + r.status);
    if (r.status === 200) assert.ok(Array.isArray(r.json.rows) && r.json.summary, k + " rows and a summary");
    else assert.ok(r.json.error, k + " 502 without a reason");
  }
  const h = await call(real, "GET", "/api/history");
  assert.equal(h.status, 200, "history reads three files and cannot fail as a whole: " + JSON.stringify(h.json).slice(0, 200));
  assert.deepEqual(h.json.parts.map((p) => p.key).sort(), ["doctor", "monitor", "release"]);
  for (const p of h.json.parts) assert.ok(["recorded", "partial", "failed", "none", "error"].includes(p.status) && (p.status === "recorded" || p.status === "partial" || p.reason || p.status === "failed"), p.key + " " + p.status + " carries no reason");
});

test("/api/machinery on the production construction path (no overrides) answers six well-formed blocks, each ok or error with a reason", async () => {
  // Reads the real tree, read-only: the same libraries the CLI calls. Under a test state dir with no
  // config some blocks are errors -- that is the point of the blind-scan guard -- so only the SHAPE is asserted.
  const r = await call(real, "GET", "/api/machinery");
  assert.equal(r.status, 200);
  for (const k of ["claims", "rules", "caps", "skills", "backlog", "goals"]) {
    const b = r.json[k];
    assert.ok(b && (b.status === "ok" || b.status === "error"), k + " block missing or malformed: " + JSON.stringify(b));
    if (b.status === "ok") assert.equal(typeof b.count, "number", k);
    else assert.ok(b.reason && b.count === null, k + " failed without a reason, or with a count");
  }
});

// ── F12: a throwing dependency answers JSON and the server survives ─────────

test("F12: a throwing reconcile / diff / snapshot is a 500 {ok:false,error} on every wrapped route, and the server keeps serving", async () => {
  ROWS = [mkRow("t1", "DRIFTED")];
  const before = storeSnapshot();

  hooks = { reconcileThrows: true };
  const d = await dispose({ edge_id: "t1", disposition: "no-change-needed", reason: REASON });
  assert.equal(d.status, 500);
  assert.deepEqual(d.json, { ok: false, error: "reconcile exploded" });
  assert.equal((await dispose({ edges: edges(["t1", "DRIFTED"]), disposition: "no-change-needed", reason: REASON })).status, 500);
  assert.equal((await dispose({ node_id: "/n/t1", state: "DRIFTED", disposition: "no-change-needed", reason: REASON })).status, 500);
  const e1 = await call(ctx, "POST", "/api/evidence", { body: { kind: "edge", edge_id: "t1" } });
  assert.equal(e1.status, 500);
  assert.equal(e1.json.ok, false);

  hooks = { evidenceThrows: true };
  const e2 = await call(ctx, "POST", "/api/evidence", { body: { kind: "edge", edge_id: "t1" } });
  assert.equal(e2.status, 500);
  assert.deepEqual(e2.json, { ok: false, error: "diff exploded" });

  hooks = { snapshotThrows: true };
  const h = await call(ctx, "GET", "/api/health");
  assert.equal(h.status, 500);
  assert.deepEqual(h.json, { ok: false, error: "snapshot exploded" });

  hooks = {};
  assert.equal((await call(ctx, "GET", "/api/version")).status, 200, "the process must still be serving");
  assert.equal(storeSnapshot(), before);
});

// ── D12: the seen-set, and that it never touches the cursor ─────────────────

test("D12: seen-set round trip, validated and bounded, and writeCursor's file is never touched", async () => {
  assert.ok(SEEN_PATH !== CURSOR_PATH);
  const cur = await call(ctx, "POST", "/api/seen", { body: { at: "2026-10-15T10:00:00.000Z" } });
  assert.equal(cur.status, 200);
  const cursorBefore = readFileSync(CURSOR_PATH, "utf8");

  const empty = await call(ctx, "GET", "/api/seen-edges");
  assert.equal(empty.json.status, "missing");
  assert.deepEqual(empty.json.triples, []);

  const t1 = ["e1|s1|d1", "e2|s2|null"];
  const post = await call(ctx, "POST", "/api/seen-edges", { body: { triples: t1 } });
  assert.equal(post.status, 200, post.raw);
  assert.equal(post.json.added, 2);
  const again = await call(ctx, "POST", "/api/seen-edges", { body: { triples: ["e1|s1|d1", "e3|s3|d3"] } });
  assert.equal(again.json.added, 1, "an existing triple is not added twice");
  assert.deepEqual((await call(ctx, "GET", "/api/seen-edges")).json.triples.sort(), ["e1|s1|d1", "e2|s2|null", "e3|s3|d3"]);

  assert.equal(readFileSync(CURSOR_PATH, "utf8"), cursorBefore, "the seen-set must not touch the cursor file");
  // …and the reverse: moving the cursor does not erase the seen-set.
  await call(ctx, "POST", "/api/seen", { body: { at: "2026-10-15T11:00:00.000Z" } });
  assert.equal((await call(ctx, "GET", "/api/seen-edges")).json.triples.length, 3);

  for (const bad of [{}, { triples: [] }, { triples: "x" }, { triples: [1] }, { triples: ["a|b"] }, { triples: ["|a|b"] }, { triples: ["a|b|c|d"] },
    { triples: Array.from({ length: 5001 }, (_, i) => `e${i}|s|d`) }]) {
    const r = await call(ctx, "POST", "/api/seen-edges", { body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await call(ctx, "GET", "/api/seen-edges")).json.triples.length, 3, "a refused POST adds nothing");
});


// ── Part 7: stable token file, cookie session, headers (2026-10-16) ─────────
//
// Every file-level assertion is on the FILE (bytes and mode), never on what the
// server said about it (rule:safety-flag-needs-a-test). All of it runs in temp
// state directories: PROPAGATE_STATE_DIR is pointed at one for the duration of
// each uiCmd call and restored, so ~/.propagate is never read or written.

const CLI = path.resolve(import.meta.dirname, "..", "..", "cli.mjs");
const modeOf = (f) => (statSync(f).mode & 0o777).toString(8);
const tmpState = () => mkdtempSync(path.join(tmpdir(), "ui-token-state-"));
const HEX64 = /^[0-9a-f]{64}$/;

async function startIn(dir, io = { log() {} }) {
  const prev = process.env.PROPAGATE_STATE_DIR;
  process.env.PROPAGATE_STATE_DIR = dir;
  try { return { ...(await uiCmd(["--port", String(await free())], io)) }; }
  finally { process.env.PROPAGATE_STATE_DIR = prev; }
}
const stop = (r) => new Promise((res) => r.server.close(res));
const runCli = (dir, args) => spawnSync(process.execPath, [CLI, "ui", ...args], {
  env: { ...process.env, PROPAGATE_STATE_DIR: dir, HOME: dir }, encoding: "utf8", timeout: 20000,
});

test("token file: created 64-hex at mode 0600 on first start, and the SAME token survives a second start", async () => {
  const dir = tmpState();
  try {
    const a = await startIn(dir);
    await stop(a);
    const file = path.join(dir, "ui-token");
    assert.match(readFileSync(file, "utf8").trim(), HEX64);
    assert.equal(readFileSync(file, "utf8").trim(), a.token);
    assert.equal(modeOf(file), "600");
    const before = readFileSync(file);
    const b = await startIn(dir);
    await stop(b);
    assert.equal(b.token, a.token, "a restart must not mint a new token -- that is what killed every bookmark");
    assert.ok(readFileSync(file).equals(before), "a second start must not rewrite the file");
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "the atomic write must leave no temp file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("token file: a pre-existing 0644 file is tightened to 0600 on the FILE, and the startup line says so", async () => {
  const dir = tmpState();
  try {
    const file = path.join(dir, "ui-token");
    const tok = "ab".repeat(32);
    writeFileSync(file, tok + "\n"); chmodSync(file, 0o644);
    const lines = [];
    const r = await startIn(dir, { log: (l) => lines.push(l) });
    await stop(r);
    assert.equal(r.token, tok);
    assert.equal(modeOf(file), "600");
    assert.match(lines.join("\n"), /tightened .*ui-token from mode 0644 to 0600/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("token file: a malformed file REFUSES to start (nonzero, names the file and the fix) and is left byte-for-byte unchanged", () => {
  const dir = tmpState();
  try {
    const file = path.join(dir, "ui-token");
    for (const bad of ["", "not-a-token\n", "AB".repeat(32), "ab".repeat(31), "ab".repeat(32) + "x"]) {
      writeFileSync(file, bad); chmodSync(file, 0o644);
      const bytes = readFileSync(file), mode = modeOf(file);
      const r = runCli(dir, ["--port", "0"]);
      assert.notEqual(r.status, 0, `${JSON.stringify(bad)} must be refused`);
      assert.ok(r.stderr.includes(file), `the message must name the file: ${r.stderr}`);
      assert.match(r.stderr, /--rotate-token/);
      assert.ok(readFileSync(file).equals(bytes), "a refused file must not be regenerated or rewritten");
      assert.equal(modeOf(file), mode);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--rotate-token: changes the file (0600), starts no server, exits 0; the old token is then refused by a fresh server", async () => {
  const dir = tmpState();
  try {
    const first = await startIn(dir);
    await stop(first);
    const file = path.join(dir, "ui-token");
    const before = readFileSync(file, "utf8");
    const r = runCli(dir, ["--rotate-token"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /reopen|restart/);
    const after = readFileSync(file, "utf8");
    assert.notEqual(after, before);
    assert.match(after.trim(), HEX64);
    assert.equal(modeOf(file), "600");
    const second = await startIn(dir);
    try {
      assert.equal(second.token, after.trim());
      assert.notEqual(second.token, first.token);
      assert.equal((await call(second, "GET", "/api/version", { token: first.token })).status, 401, "the OLD token must be refused");
      assert.equal((await call(second, "GET", "/api/version")).status, 200);
    } finally { await stop(second); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cookie session: a tokened GET / is a 302 to / with an HttpOnly, SameSite=Strict, Path=/ ptok cookie", async () => {
  const r = await call(ctx, "GET", "/");
  assert.equal(r.status, 302);
  const res = await new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: ctx.port, path: `/?token=${ctx.token}`, headers: { host: `127.0.0.1:${ctx.port}` } }, resolve).on("error", reject));
  res.resume();
  assert.equal(res.headers.location, "/");
  const cookie = [].concat(res.headers["set-cookie"]).join("\n");
  assert.ok(cookie.startsWith(`ptok=${ctx.token};`), cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
});

test("cookie session: the cookie alone serves the page (among other cookies); a bad or missing cookie is 404", async () => {
  const ok = await call(ctx, "GET", "/", { token: null, headers: { cookie: `a=1; ptok=${ctx.token} ;b=2` } });
  assert.equal(ok.status, 200);
  assert.ok(ok.raw.includes("<html") || ok.raw.includes("<!doctype") || ok.raw.includes("<!DOCTYPE"));
  for (const cookie of [`ptok=${"0".repeat(64)}`, "ptok=", "ptok", `xptok=${ctx.token}`, `ptok=${ctx.token}x`]) {
    assert.equal((await call(ctx, "GET", "/", { token: null, headers: { cookie } })).status, 404, cookie);
  }
  assert.equal((await call(ctx, "GET", "/", { token: null })).status, 404);
});

test("cookie session: the API accepts the cookie alone; a bad cookie is 401", async () => {
  assert.equal((await call(ctx, "GET", "/api/version", { token: null, headers: { cookie: ctx.cookie } })).status, 200);
  assert.equal((await call(ctx, "GET", "/api/version", { token: null, headers: { cookie: "ptok=nope" } })).status, 401);
});

test("cookie session: a VALID cookie with a foreign Origin (or Host) is still 403 -- Origin runs before the cookie", async () => {
  const origin = await call(ctx, "GET", "/api/version", { token: null, headers: { cookie: ctx.cookie, origin: "https://evil.example.com" } });
  assert.equal(origin.status, 403);
  const host = await call(ctx, "GET", "/api/version", { token: null, headers: { cookie: ctx.cookie, host: "evil.example.com" } });
  assert.equal(host.status, 403);
  // Effect, not status: a cross-origin POST with the cookie writes nothing.
  ROWS = [mkRow("co1", "DRIFTED")];
  const before = storeSnapshot();
  const w = await call(ctx, "POST", "/api/dispose", { token: null, headers: { cookie: ctx.cookie, origin: "https://evil.example.com" },
    body: { edges: edges(["co1", "DRIFTED"]), disposition: "no-change-needed", reason: REASON } });
  assert.equal(w.status, 403);
  assert.equal(storeSnapshot(), before);
});

test("headers: no-store, no-referrer, frame-ancestors 'none' and X-Frame-Options DENY on the 302, page, API 200/401/403, graph refusal and 404", async () => {
  const raw = (pathAndQuery, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: ctx.port, path: pathAndQuery, headers: { host: `127.0.0.1:${ctx.port}`, ...headers } }, (res) => { res.resume(); res.on("end", () => resolve(res)); }).on("error", reject);
  });
  const t = ctx.token;
  const responses = {
    "302": await raw(`/?token=${t}`),
    "page 200": await raw("/", { cookie: ctx.cookie }),
    "api 200": await raw(`/api/version?token=${t}`),
    "api 401": await raw("/api/version?token=nope"),
    "api 403": await raw(`/api/version?token=${t}`, { origin: "https://evil.example.com" }),
    "graph 401": await raw("/graph?token=nope"),
    "page 404": await raw("/"),
    "unknown 404": await raw(`/nope?token=${t}`),
  };
  assert.deepEqual(Object.entries(responses).map(([k, r]) => `${k}:${r.statusCode}`),
    ["302:302", "page 200:200", "api 200:200", "api 401:401", "api 403:403", "graph 401:401", "page 404:404", "unknown 404:404"]);
  for (const [name, res] of Object.entries(responses)) {
    assert.equal(res.headers["cache-control"], "no-store", name);
    assert.equal(res.headers["referrer-policy"], "no-referrer", name);
    assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'", name);
    assert.equal(res.headers["x-frame-options"], "DENY", name);
  }
});
