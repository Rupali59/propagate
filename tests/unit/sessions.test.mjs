/**
 * sessions.test.mjs — `propagate sessions`, `sessions show`, `sessions assoc` (the read half of propagate#272).
 *
 * NO TEST MAY LAUNCH A REAL CLAUDE SESSION (`claude --bg --help` starts one, measured 2026-11-14). Every call goes
 * through PROPAGATE_CLAUDE_BIN to a stub: a node script that prints a fixture and records its argv.
 * Fixtures use fake paths (/w/acme/repo-a) and fake ids; the public repo carries no account, client or personal path.
 */
// @size small — in-process, stub binary, temp state dir
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sessionsCmd } from "../../cli/sessions.mjs";
import { append, assocPath, fold } from "../../lib/sessions/assoc.mjs";
import { CODES, fail } from "../../lib/sessions/errors.mjs";
import { checkShape, readLive, rowKeyOf } from "../../lib/sessions/live.mjs";
import { buildCheckouts, folderOf } from "../../lib/sessions/resolve.mjs";
import { buildView, renderView } from "../../lib/sessions/view.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "cli.mjs");
const NOW = Date.parse("2026-11-14T12:00:00Z");

/** The claude stub: prints `fixture` (or `raw`), exits `code`, sleeps `sleepMs`, and appends its argv to argv.log. */
function makeStub(dir, cfg) {
  const bin = path.join(dir, "claude-stub.mjs");
  writeFileSync(path.join(dir, "stub.json"), JSON.stringify(cfg));
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
appendFileSync(join(here, "argv.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
const cfg = JSON.parse(readFileSync(join(here, "stub.json"), "utf8"));
if (cfg.sleepMs) await new Promise((r) => setTimeout(r, cfg.sleepMs));
if (cfg.stderr) process.stderr.write(cfg.stderr);
process.stdout.write(cfg.raw ?? JSON.stringify(cfg.fixture ?? []));
process.exit(cfg.code ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, argv: () => { try { return readFileSync(path.join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}

/** 5 interactive + 1 background, one sessionId on both an interactive and the background row. */
const SHARED = "aaaaaaaa-1111-4111-8111-111111111111";
const FIXTURE = [
  { id: "aaaaaaaa", cwd: "/w/acme/repo-a", kind: "background", startedAt: NOW - 3 * 86400000, sessionId: SHARED, name: "bg-lane", state: "blocked" },
  { pid: 101, cwd: "/w/acme/repo-a", kind: "interactive", startedAt: NOW - 3600000, sessionId: SHARED, name: "repo-a-work", status: "busy" },
  { pid: 102, cwd: "/w/acme", kind: "interactive", startedAt: NOW - 7200000, sessionId: "bbbbbbbb-2222-4222-8222-222222222222", name: "acme-root", status: "waiting", waitingFor: "permission prompt" },
  { pid: 103, cwd: "/w/acme/repo-b", kind: "interactive", startedAt: NOW - 600000, sessionId: "cccccccc-3333-4333-8333-333333333333", name: "same-name", status: "idle" },
  { pid: 104, cwd: "/x/outside", kind: "interactive", startedAt: NOW - 60000, sessionId: "dddddddd-4444-4444-8444-444444444444", name: "same-name", status: "idle" },
  { pid: 105, cwd: "/hub", kind: "interactive", startedAt: NOW - 300000, sessionId: "eeeeeeee-5555-4555-8555-555555555555", name: "hub-session", status: "busy" },
];

const CTX = {
  workspaces: [{ name: "acme", root: "/w/acme" }, { name: "globex", root: "/w/globex" }],
  checkouts: [
    { path: "/w/acme/repo-a", repo: "o/repo-a" },
    { path: "/w/acme/repo-b", repo: "o/repo-b" },
    { path: "/w/globex", repo: "o/globex" },
    { path: "/hub", repo: "o/hub" },
  ],
  hubRoot: "/hub",
  warnings: [],
};

const scratch = mkdtempSync(path.join(tmpdir(), "sessions-test-"));
let n = 0;
const fresh = () => {
  const dir = path.join(scratch, `t${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const emitted = new Set(); // every failure code a test below actually saw, asserted against CODES at the end
const noNext = [];

/** Run sessionsCmd with captured output and the stub as the claude binary. */
async function run(argv, { cfg = { fixture: FIXTURE }, state = fresh(), snapshot, ctx = CTX } = {}) {
  const stubDir = fresh();
  const stub = makeStub(stubDir, cfg);
  const prev = process.env.PROPAGATE_CLAUDE_BIN;
  process.env.PROPAGATE_CLAUDE_BIN = stub.bin;
  const out = [];
  const err = [];
  try {
    const code = await sessionsCmd(argv, { io: { log: (s) => out.push(s), error: (s) => err.push(s) }, ctx, stateDirPath: state, now: () => NOW, snapshot });
    const text = out.join("\n");
    let json = null;
    if (argv.includes("--json")) json = JSON.parse(text);
    if (json && json.ok === false) {
      emitted.add(json.code);
      if (!json.next) noNext.push(json.code);
    }
    for (const l of err) {
      const m = /^(SESSION_[A-Z_]+): .* Next: (.+)$/.exec(l);
      if (m) emitted.add(m[1]);
    }
    return { code, out, err, text, json, argv: stub.argv(), state };
  } finally {
    if (prev === undefined) delete process.env.PROPAGATE_CLAUDE_BIN;
    else process.env.PROPAGATE_CLAUDE_BIN = prev;
  }
}

after(() => {
  // every code in the contract was emitted by some test below
  const missing = Object.keys(CODES).filter((c) => !emitted.has(c));
  assert.deepEqual(missing, [], `codes no test reached: ${missing.join(", ")}`);
});

// ── the reader ─────────────────────────────────────────────────────────────

test("the reader keeps a duplicated sessionId as two rows: 6 rows, never 5", () => {
  const stub = makeStub(fresh(), { fixture: FIXTURE });
  process.env.PROPAGATE_CLAUDE_BIN = stub.bin;
  try {
    const r = readLive({ now: () => NOW });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 6, "6 sessions in, 6 rows out");
    assert.equal(new Set(r.rows.map((x) => x.key)).size, 6, "every row key is distinct");
    assert.equal(r.rows.filter((x) => x.sessionId === SHARED).length, 2, "the shared sessionId is on two rows");
    assert.deepEqual(stub.argv(), [["agents", "--json"]], "the reader's only call is `agents --json`");
    const bg = r.rows.find((x) => x.kind === "background");
    const ia = r.rows.find((x) => x.pid === 101);
    assert.equal(bg.state, "blocked", "background rows carry `state`");
    assert.equal(ia.state, "busy", "interactive rows carry `status`");
    assert.equal(bg.key, `background:aaaaaaaa:`);
    assert.equal(ia.key, `interactive:${SHARED}:101`);
  } finally {
    delete process.env.PROPAGATE_CLAUDE_BIN;
  }
});

test("rowKeyOf is (kind, id || sessionId, pid), and sessionId alone is not a key", () => {
  assert.equal(rowKeyOf({ kind: "interactive", id: "", sessionId: "s", pid: 7 }), "interactive:s:7");
  assert.notEqual(rowKeyOf({ kind: "background", id: "x", sessionId: "s" }), rowKeyOf({ kind: "interactive", sessionId: "s", pid: 1 }));
});

// failure table: each way the reader can fail -> a typed code and exit 2, never an empty list
const FAILURES = [
  { name: "non-zero exit", cfg: { code: 3, stderr: "boom\n", raw: "" }, code: "SESSION_READER_FAILED", what: /exit 3: boom/ },
  { name: "timeout", cfg: { sleepMs: 3000, fixture: FIXTURE }, code: "SESSION_READER_FAILED", what: /timed out/, timeoutMs: 300 },
  { name: "bad JSON", cfg: { raw: "not json" }, code: "SESSION_READER_FAILED", what: /not JSON/ },
  { name: "an object instead of an array", cfg: { raw: '{"sessions":[]}' }, code: "SESSION_SHAPE_UNKNOWN", what: /expected an array/ },
  { name: "a row with no cwd", cfg: { fixture: [{ kind: "interactive", sessionId: "s" }] }, code: "SESSION_SHAPE_UNKNOWN", what: /no string `cwd` \(keys: kind,sessionId\)/ },
  { name: "a row that is not an object", cfg: { fixture: ["x"] }, code: "SESSION_SHAPE_UNKNOWN", what: /row 0 is not an object/ },
  { name: "renamed keys", cfg: { fixture: [{ dir: "/w", type: "interactive", id: "s" }] }, code: "SESSION_SHAPE_UNKNOWN", what: /no string `cwd`/ },
];
for (const f of FAILURES) {
  test(`reader failure, ${f.name}: exit 2 with ${f.code}, text and --json`, async () => {
    if (f.timeoutMs) process.env.PROPAGATE_CLAUDE_TIMEOUT_MS = String(f.timeoutMs);
    try {
      const t = await run([], { cfg: f.cfg });
      assert.equal(t.code, 2);
      assert.equal(t.out.length, 0, "stdout carries no table, no `0 live sessions`");
      assert.match(t.err[0], new RegExp(`^${f.code}: .*${f.what.source}.* Next: \\S`));
      const j = await run(["--json"], { cfg: f.cfg });
      assert.equal(j.code, 2);
      assert.equal(j.json.ok, false);
      assert.equal(j.json.code, f.code);
      assert.match(j.json.what, f.what);
      assert.ok(j.json.next.length > 0);
      assert.deepEqual(j.json.side_effects, []);
    } finally {
      delete process.env.PROPAGATE_CLAUDE_TIMEOUT_MS;
    }
  });
}

test("a missing claude binary is SESSION_READER_FAILED, through the real CLI process, exit 2", () => {
  const r = spawnSync(process.execPath, [CLI, "sessions"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_CLAUDE_BIN: path.join(scratch, "does-not-exist"), PROPAGATE_STATE_DIR: fresh() },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^SESSION_READER_FAILED: could not read claude agents \(.*ENOENT.*\)\. Next: /m);
  assert.equal(r.stdout, "");
  emitted.add("SESSION_READER_FAILED");
});

test("an empty array is a valid read: `0 live sessions (claude agents read <ts>)`, exit 0", async () => {
  const t = await run([], { cfg: { fixture: [] } });
  assert.equal(t.code, 0);
  assert.equal(t.out[0], `0 live sessions (claude agents read ${new Date(NOW).toISOString()})`);
});

test("checkShape accepts the measured keys and rejects each missing required key", () => {
  assert.equal(checkShape(FIXTURE).ok, true);
  for (const k of ["cwd", "kind", "sessionId"]) {
    const row = { ...FIXTURE[1] };
    delete row[k];
    assert.equal(checkShape([row]).ok, false, `a row with no ${k}`);
  }
});

// ── resolution ─────────────────────────────────────────────────────────────

test("a cwd at a workspace root covers every repo at or below it; inside a repo, that repo only", () => {
  assert.deepEqual(folderOf("/w/acme", CTX), { workspace: "acme", project: "(workspace root)", repos: ["o/repo-a", "o/repo-b"], workspaceRoot: "/w/acme", cwd: "/w/acme" });
  const inRepo = folderOf("/w/acme/repo-a", CTX);
  assert.equal(inRepo.project, "repo-a");
  assert.deepEqual(inRepo.repos, ["o/repo-a"]);
  const deeper = folderOf("/w/acme/repo-a/src/deep", CTX);
  assert.deepEqual(deeper.repos, ["o/repo-a"], "a subdirectory of a checkout is that repo");
});

test("an unplaced cwd, and the hub root as `hub (all)`", () => {
  assert.deepEqual(folderOf("/x/outside", CTX), { unplaced: true });
  const hub = folderOf("/hub", CTX);
  assert.equal(hub.all, true);
  assert.deepEqual(hub.repos, [], "the hub never lists its repos");
});

test("the hub's own repo is not listed for a workspace root that sits below it", () => {
  const ctx = { ...CTX, workspaces: [{ name: "acme", root: "/hub/acme" }], checkouts: [{ path: "/hub", repo: "o/hub" }, { path: "/hub/acme/repo-a", repo: "o/repo-a" }] };
  assert.deepEqual(folderOf("/hub/acme", ctx).repos, ["o/repo-a"]);
});

test("buildCheckouts maps real git checkouts to their origin, skipping dot-directories", () => {
  const ws = path.join(fresh(), "acme");
  mkdirSync(path.join(ws, "repo-a", ".git"), { recursive: true });
  mkdirSync(path.join(ws, ".claude", "worktrees", "wt", ".git"), { recursive: true });
  const git = (dir, ...a) => assert.equal(spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }).status, 0);
  git(path.join(ws, "repo-a"), "init", "-q");
  git(path.join(ws, "repo-a"), "remote", "add", "origin", "https://github.com/o/repo-a.git");
  const m = buildCheckouts({ workspaces: [{ name: "acme", root: ws }], now: NOW });
  assert.deepEqual(m.checkouts, [{ path: path.join(ws, "repo-a"), repo: "o/repo-a" }]);
});

// ── the table ──────────────────────────────────────────────────────────────

test("sessions: one row per live session (6), grouped by workspace, the unassociated hint closes the table", async () => {
  const t = await run([]);
  assert.equal(t.code, 0);
  const text = t.out.join("\n");
  assert.match(text, /^acme$/m);
  assert.match(text, /^unplaced$/m);
  assert.match(text, /^hub$/m);
  assert.match(text, /project\s+goal\s+item\s+state\s+since\s+id\s+name/);
  assert.equal((text.match(/unassociated/g) ?? []).length, 6 + 1 - 1, "6 unassociated rows; the hint says `assoc:`, not `unassociated`");
  assert.equal(t.out.at(-1), "assoc: propagate sessions assoc <id> --from owner/repo#n");
  assert.match(text, /hub \(all\)/);
  assert.match(text, /\(workspace root\)\s+-\s+unassociated\s+waiting\s+2h/);
});

test("sessions --json carries the same data and the counts: live, unassociated, unplaced, unknown, ended", async () => {
  const t = await run(["--json"]);
  assert.equal(t.json.ok, true);
  assert.equal(t.json.sessions.length, 6);
  assert.deepEqual(t.json.counts, { live: 6, unassociated: 6, unplaced: 1, unknown: 0, ended: 0 });
});

test("an associated session shows its goal and item, and the hint disappears when none is unassociated", async () => {
  const state = fresh();
  const rows = FIXTURE.map((r) => ({ ...r }));
  const view = buildView({ rows: (await (async () => { const s = makeStub(fresh(), { fixture: rows }); process.env.PROPAGATE_CLAUDE_BIN = s.bin; try { return readLive({ now: () => NOW }).rows; } finally { delete process.env.PROPAGATE_CLAUDE_BIN; } })()), readAt: "t" }, { byKey: new Map(), corrupt: 0 }, CTX);
  for (const s of view.sessions) await append({ event: "associate", rowKey: s.key, goal: "G3", item: "o/repo-a#9", row: { name: s.name } }, { stateDirPath: state, now: () => NOW });
  const t = await run([], { state });
  assert.equal(t.code, 0);
  assert.ok(!t.out.join("\n").includes("assoc: propagate"), "no hint: nothing is unassociated");
  assert.match(t.out.join("\n"), /repo-a\s+G3\s+o\/repo-a#9\s+busy/);
});

test("an association whose session is absent from claude agents reads `ended (not in claude agents)`, never dropped", async () => {
  const state = fresh();
  await append({ event: "associate", rowKey: "interactive:gone:999", goal: "G3", item: "o/repo-a#5", project: "repo-a", row: { kind: "interactive", sessionId: "gone", pid: 999, name: "old-lane" } }, { stateDirPath: state, now: () => NOW });
  const t = await run([], { state });
  assert.match(t.out.join("\n"), /ended \(not in claude agents\)/);
  assert.match(t.out.join("\n"), /old-lane/);
  const j = await run(["--json"], { state });
  assert.equal(j.json.counts.ended, 1);
  assert.equal(j.json.ended[0].state, "ended (not in claude agents)");
});

test("renderView caps the ended list in text and says how to see the rest", () => {
  const ended = Array.from({ length: 12 }, (_, i) => ({ rowKey: `k${i}`, state: "ended (not in claude agents)", association: { ts: `2026-11-${10 + (i % 5)}`, goal: "G3", item: `o/r#${i}`, row: { name: `n${i}` } }, last: {} }));
  const lines = renderView({ readAt: "t", sessions: [], ended, counts: { unassociated: 0 }, corrupt: 0 }, { now: NOW });
  assert.ok(lines.includes("  +2 older ended: propagate sessions --json"));
});

// ── show ───────────────────────────────────────────────────────────────────

test("show: an unknown id refuses SESSION_NOT_FOUND with a next command", async () => {
  const t = await run(["show", "nope"]);
  assert.equal(t.code, 1);
  assert.match(t.err[0], /^SESSION_NOT_FOUND: no session matches "nope" \(6 live\)\. Next: propagate sessions$/);
});

test("show: the select tiers: pid:, background id before sessionId, then name; a shared name is SESSION_AMBIGUOUS", async () => {
  const byPid = await run(["show", "pid:101", "--json"]);
  assert.equal(byPid.json.live.pid, 101);
  const byId = await run(["show", "aaaaaaaa", "--json"]);
  assert.equal(byId.json.live.kind, "background", "the background id wins over the interactive row sharing its sessionId prefix");
  const bySession = await run(["show", SHARED, "--json"]);
  assert.equal(bySession.code, 1, "a sessionId shared by two rows is ambiguous");
  assert.equal(bySession.json.code, "SESSION_AMBIGUOUS");
  assert.match(bySession.json.next, /^propagate sessions show aaaaaaaa {2}\(or pid:101\)$/, "names both selectors that disambiguate");
  const dup = await run(["show", "same-name"]);
  assert.equal(dup.code, 1);
  assert.match(dup.err[0], /^SESSION_AMBIGUOUS: "same-name" matches 2 sessions .* Next: propagate sessions show pid:103/);
  const byName = await run(["show", "hub-session", "--json"]);
  assert.equal(byName.json.live.pid, 105);
});

test("show: the live row, repos, association history, guidance and the next command", async () => {
  const state = fresh();
  await append({ event: "associate", rowKey: "interactive:bbbbbbbb-2222-4222-8222-222222222222:102", goal: "G3", item: "o/repo-b#4", row: {} }, { stateDirPath: state, now: () => NOW });
  await append({ event: "stop-requested", rowKey: "interactive:bbbbbbbb-2222-4222-8222-222222222222:102", note: "act-lane event" }, { stateDirPath: state, now: () => NOW });
  const t = await run(["show", "acme-root", "--json"], { state });
  assert.equal(t.code, 0);
  assert.equal(t.json.live.waitingFor, "permission prompt");
  assert.deepEqual(t.json.repos, ["o/repo-a", "o/repo-b"]);
  assert.equal(t.json.association.goal, "G3");
  assert.deepEqual(t.json.history.map((h) => h.event), ["associate", "stop-requested"]);
  assert.ok(Array.isArray(t.json.guidance.claudeMd) && Array.isArray(t.json.guidance.state));
  assert.match(t.json.next, /^propagate sessions show /);
  const text = await run(["show", "repo-a-work"], { state });
  assert.match(text.out.join("\n"), /next:\s+propagate sessions assoc \S+ --from owner\/repo#n/);
});

test("show: an ended association is found by its stored row and says so", async () => {
  const state = fresh();
  await append({ event: "associate", rowKey: "interactive:gone:999", goal: "G3", item: "o/r#5", row: { kind: "interactive", sessionId: "gone-session-id", pid: 999, name: "old-lane" } }, { stateDirPath: state, now: () => NOW });
  const t = await run(["show", "old-lane", "--json"], { state });
  assert.equal(t.code, 0);
  assert.equal(t.json.state, "ended (not in claude agents)");
});

// ── assoc ──────────────────────────────────────────────────────────────────

const SNAP = (goal, generatedAt = new Date(NOW - 3600000).toISOString()) => ({ generatedAt, items: { "o/repo-a#9": { goal } } });

test("assoc --from with a null goal refuses SESSION_GOAL_UNKNOWN and writes nothing", async () => {
  const state = fresh();
  const t = await run(["assoc", "pid:101", "--from", "o/repo-a#9"], { state, snapshot: SNAP(null) });
  assert.equal(t.code, 1);
  assert.match(t.err[0], /^SESSION_GOAL_UNKNOWN: .* Next: pass --goal G<n> --item o\/repo-a#9, or run propagate day open$/);
  assert.equal(fold(state).byKey.size, 0, "no association was written");
});

test("assoc --from with an item missing from the snapshot, or no snapshot at all, is SESSION_GOAL_UNKNOWN", async () => {
  const missing = await run(["assoc", "pid:101", "--from", "o/other#1", "--json"], { snapshot: SNAP("G3") });
  assert.equal(missing.json.code, "SESSION_GOAL_UNKNOWN");
  assert.match(missing.json.what, /not in the dispatch snapshot/);
  const none = await run(["assoc", "pid:101", "--from", "o/repo-a#9", "--json"], { snapshot: null });
  assert.equal(none.json.code, "SESSION_GOAL_UNKNOWN");
  assert.match(none.json.what, /no dispatch snapshot/);
});

test("assoc --from derives the goal from the snapshot, records one event, and the table then shows it", async () => {
  const state = fresh();
  const t = await run(["assoc", "pid:101", "--from", "o/repo-a#9"], { state, snapshot: SNAP("G3") });
  assert.equal(t.code, 0, t.err.join("\n"));
  const lines = readFileSync(assocPath(state), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.deepEqual({ event: ev.event, goal: ev.goal, item: ev.item, source: ev.source, rowKey: ev.rowKey, project: ev.project }, { event: "associate", goal: "G3", item: "o/repo-a#9", source: "from", rowKey: `interactive:${SHARED}:101`, project: "repo-a" });
  const after = await run(["--json"], { state });
  const s = after.json.sessions.find((x) => x.pid === 101);
  assert.equal(s.association.item, "o/repo-a#9");
  assert.equal(after.json.counts.unassociated, 5);
  const bg = after.json.sessions.find((x) => x.kind === "background");
  assert.equal(bg.association, null, "the background row sharing that sessionId is not associated by the interactive row's association");
});

test("assoc: a stale snapshot (over 24 h) warns and does not refuse", async () => {
  const t = await run(["assoc", "pid:101", "--from", "o/repo-a#9", "--json"], { snapshot: SNAP("G3", new Date(NOW - 30 * 3600000).toISOString()) });
  assert.equal(t.code, 0);
  assert.match(t.json.warnings[0], /30 h old/);
});

test("assoc --goal --item takes no snapshot; --from with --goal is a usage error; a later association replaces the earlier", async () => {
  const state = fresh();
  assert.equal((await run(["assoc", "pid:101", "--goal", "G1", "--item", "o/a#1"], { state, snapshot: null })).code, 0);
  assert.equal((await run(["assoc", "pid:101", "--goal", "G3", "--item", "o/b#2"], { state, snapshot: null })).code, 0);
  assert.equal(fold(state).byKey.get(`interactive:${SHARED}:101`).assoc.item, "o/b#2", "latest association wins");
  assert.equal(fold(state).byKey.get(`interactive:${SHARED}:101`).history.length, 2, "both stay in history");
  const both = await run(["assoc", "pid:101", "--from", "o/a#1", "--goal", "G1", "--json"], { state });
  assert.equal(both.json.code, "SESSION_USAGE");
});

test("usage errors are SESSION_USAGE, exit 2, with a next command", async () => {
  for (const argv of [["assoc"], ["assoc", "pid:101"], ["assoc", "pid:101", "--from", "bad"], ["assoc", "pid:101", "--goal", "3", "--item", "o/a#1"], ["show"], ["show", "a", "b"], ["frobnicate"], ["--bogus"], ["assoc", "pid:101", "--from"]]) {
    const t = await run(argv);
    assert.equal(t.code, 2, argv.join(" "));
    assert.match(t.err[0], /^SESSION_USAGE: .* Next: /, argv.join(" "));
  }
});

test("assoc on an ended or unknown session refuses SESSION_NOT_FOUND", async () => {
  const t = await run(["assoc", "nope", "--goal", "G3", "--item", "o/a#1"]);
  assert.equal(t.code, 1);
  assert.match(t.err[0], /^SESSION_NOT_FOUND:/);
});

test("an assoc log that cannot be read is SESSION_ASSOC_UNREADABLE (exit 2), never an empty fold", async () => {
  const state = fresh();
  mkdirSync(assocPath(state), { recursive: true }); // a directory where the file should be: EISDIR
  const t = await run([], { state });
  assert.equal(t.code, 2);
  assert.match(t.err[0], /^SESSION_ASSOC_UNREADABLE: .* Next: /);
});

test("an association that cannot be written is SESSION_ASSOC_WRITE_FAILED (exit 1)", { skip: process.getuid?.() === 0 ? "root ignores file modes" : false }, async () => {
  const state = fresh();
  mkdirSync(path.join(state, "sessions"), { recursive: true });
  writeFileSync(assocPath(state), "");
  chmodSync(assocPath(state), 0o444);
  const t = await run(["assoc", "pid:101", "--goal", "G3", "--item", "o/a#1"], { state });
  assert.equal(t.code, 1);
  assert.match(t.err[0], /^SESSION_ASSOC_WRITE_FAILED: .* Next: .*nothing was changed/);
});

// ── the log ────────────────────────────────────────────────────────────────

test("fold: latest association per row key; forgotten clears it; unknown event kinds stay in history and never fail; corrupt lines are counted", async () => {
  const state = fresh();
  await append({ event: "associate", rowKey: "k1", goal: "G1", item: "o/a#1" }, { stateDirPath: state });
  await append({ event: "associate", rowKey: "k1", goal: "G2", item: "o/a#2" }, { stateDirPath: state });
  await append({ event: "associate", rowKey: "k2", goal: "G1", item: "o/a#1" }, { stateDirPath: state });
  await append({ event: "forgotten", rowKey: "k2" }, { stateDirPath: state });
  await append({ event: "some-future-kind", rowKey: "k3", whatever: 1 }, { stateDirPath: state });
  writeFileSync(assocPath(state), readFileSync(assocPath(state), "utf8") + "{not json\n{\"event\":1}\n");
  const f = fold(state);
  assert.equal(f.byKey.get("k1").assoc.item, "o/a#2");
  assert.equal(f.byKey.get("k2").assoc, null);
  assert.equal(f.byKey.get("k3").last.event, "some-future-kind");
  assert.equal(f.byKey.get("k3").assoc, null);
  assert.equal(f.corrupt, 2);
  await assert.rejects(append({ event: "x" }, { stateDirPath: state }), /needs string/);
});

test("the log is append-only: a second append leaves the first line's bytes untouched", async () => {
  const state = fresh();
  await append({ event: "associate", rowKey: "k", goal: "G1", item: "o/a#1" }, { stateDirPath: state, now: () => NOW });
  const first = readFileSync(assocPath(state), "utf8");
  await append({ event: "forgotten", rowKey: "k" }, { stateDirPath: state, now: () => NOW });
  assert.ok(readFileSync(assocPath(state), "utf8").startsWith(first));
});

// ── the error contract ─────────────────────────────────────────────────────

test("every failure names a next step: fail() refuses an empty one, and no code reached a test without it", () => {
  assert.throws(() => fail("SESSION_USAGE", "x", ""), /no next step/);
  assert.throws(() => fail("SESSION_MADE_UP", "x", "y"), /unknown session error code/);
  assert.deepEqual(noNext, []);
});

test("docs/REFERENCE.md §sessions lists exactly the codes in the contract", () => {
  const doc = readFileSync(path.join(ROOT, "docs", "REFERENCE.md"), "utf8");
  const at = doc.indexOf("## `propagate sessions`");
  assert.ok(at >= 0, "REFERENCE.md has no `## \\`propagate sessions\\`` section");
  const next = doc.indexOf("\n## ", at + 5);
  const section = doc.slice(at, next < 0 ? undefined : next);
  const documented = [...new Set(section.match(/SESSION_[A-Z_]+/g) ?? [])].sort();
  assert.ok(documented.length >= 6, `only ${documented.length} codes found in the section: the scan has gone blind`);
  const lane = new Set(documented.filter((c) => !Object.hasOwn(CODES, c)));
  assert.deepEqual([...lane], [], "REFERENCE documents a code the contract does not define");
  assert.deepEqual(Object.keys(CODES).filter((c) => !documented.includes(c)), [], "a code in the contract is missing from REFERENCE");
});
