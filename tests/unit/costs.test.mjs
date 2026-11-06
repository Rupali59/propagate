/**
 * Tests for lib/core/costs.mjs, hooks/subagent-cost.mjs and scripts/costs-backfill.mjs
 * (propagate#188).
 *
 * Isolation: every test builds fixtures in a fresh tmpdir and points PROPAGATE_STATE_DIR and
 * PROPAGATE_SAMPLES_PATH at it. The real ~/.propagate and the real samples file are never
 * touched. The hook and the back-fill tool run as subprocesses with that env.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test tests/unit/costs.test.mjs`
 */
// @size medium — starts processes (hook and back-fill CLI); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { summarizeTranscript, readingAt, buildCostRow } from "../../lib/core/costs.mjs";

const HOOK = path.resolve("hooks/subagent-cost.mjs");
const BACKFILL = path.resolve("scripts/costs-backfill.mjs");

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "costs-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function asst(id, ts, u, model = "claude-sonnet-5-5") {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      id,
      model,
      usage: {
        input_tokens: u[0],
        output_tokens: u[1],
        cache_creation_input_tokens: u[2],
        cache_read_input_tokens: u[3],
      },
    },
  };
}

/** Two calls (m1 appears on two lines, as real transcripts repeat it per content block). */
const LINES = [
  { type: "user", timestamp: "2026-11-06T06:00:00.000Z", message: { role: "user", content: "go" } },
  asst("m1", "2026-11-06T06:01:00.000Z", [2, 100, 1000, 10]),
  asst("m1", "2026-11-06T06:01:00.500Z", [2, 100, 1000, 10]),
  asst("m2", "2026-11-06T06:03:00.000Z", [3, 50, 200, 2000]),
  { type: "user", timestamp: "2026-11-06T06:04:00.000Z", message: { role: "user", content: "done" } },
];

async function writeTranscript(dir, name, lines, meta = { agentType: "general-purpose", description: "Do #188 thing", model: "sonnet" }) {
  const sub = path.join(dir, "proj", "sess1", "subagents");
  await mkdir(sub, { recursive: true });
  const p = path.join(sub, `agent-${name}.jsonl`);
  await writeFile(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  if (meta) await writeFile(p.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta));
  return p;
}

function sampleLine(t, over = {}) {
  return JSON.stringify({ t, ok: true, week_pct: 50, cc_cost_week: 100, ...over });
}

function env(dir, extra = {}) {
  return {
    ...process.env,
    PROPAGATE_STATE_DIR: path.join(dir, "state"),
    PROPAGATE_SAMPLES_PATH: path.join(dir, "samples.jsonl"),
    ...extra,
  };
}

function runHook(dir, stdin, extra = {}) {
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env: env(dir, extra), timeout: 30000 });
}

function costsDirOf(dir) {
  return path.join(dir, "state", "costs");
}

function readRows(dir) {
  const d = costsDirOf(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(path.join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

/** Every byte of the state dir, as one string, or "<absent>". */
function storeSnapshot(dir) {
  const root = path.join(dir, "state");
  if (!existsSync(root)) return "<absent>";
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out.push(`DIR ${p}`);
        walk(p);
      } else out.push(`FILE ${p}\n${readFileSync(p, "utf8")}`);
    }
  };
  walk(root);
  return out.join("\n");
}

function payloadFor(p, over = {}) {
  return JSON.stringify({
    session_id: "sess1",
    agent_id: path.basename(p, ".jsonl").replace(/^agent-/, ""),
    agent_type: "general-purpose",
    agent_transcript_path: p,
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    ...over,
  });
}

// ---------------------------------------------------------------------------

test("summarizeTranscript: a message id repeated across lines is counted once", async () => {
  await withTmp(async (dir) => {
    const p = await writeTranscript(dir, "dup", LINES);
    const s = summarizeTranscript(p);
    // m1 once (not twice) + m2: 2 calls.
    assert.equal(s.api_calls, 2, "api_calls must count unique message ids");
    assert.deepEqual(s.usage, { input: 5, output: 150, cache_create: 1200, cache_read: 2010 });
    assert.deepEqual(s.models, ["claude-sonnet-5-5"]);
    assert.equal(s.start, "2026-11-06T06:00:00.000Z");
    assert.equal(s.end, "2026-11-06T06:04:00.000Z");
  });
});

test("summarizeTranscript: unreadable and empty are reported as such, never as zeros", async () => {
  await withTmp(async (dir) => {
    const missing = summarizeTranscript(path.join(dir, "nope.jsonl"));
    assert.equal(missing.unreadable, true);
    assert.equal(missing.usage, undefined, "an unreadable file must not carry a usage object");

    const p = await writeTranscript(dir, "empty", [LINES[0], "not json at all", LINES[4]]);
    const empty = summarizeTranscript(p);
    assert.equal(empty.empty, true);
    assert.equal(empty.usage, undefined);
    assert.equal(empty.malformed, 1);

    const row = buildCostRow({ agent_id: "x" }, {}, missing, { missing: "r" }, { missing: "r" });
    assert.equal(row.usage, null);
    assert.equal(row.api_calls, null);
    assert.match(row.summary_status, /^unreadable/);
    const row2 = buildCostRow({ agent_id: "x" }, {}, empty, { missing: "r" }, { missing: "r" });
    assert.match(row2.summary_status, /^empty/);
  });
});

test("readingAt: latest ok non-zero line at or before ts; skips cc_cost_week 0; missing when older than 6h", async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, "samples.jsonl");
    await writeFile(
      f,
      [
        sampleLine("2026-11-06T08:00:00Z", { week_pct: 10, cc_cost_week: 1 }),
        sampleLine("2026-11-06T09:00:00Z", { week_pct: 20, cc_cost_week: 2 }),
        sampleLine("2026-11-06T09:30:00Z", { week_pct: 99, cc_cost_week: 0 }), // --quick sample
        JSON.stringify({ t: "2026-11-06T09:40:00Z", ok: false, week_pct: null, cc_cost_week: null }),
        "garbage line",
        sampleLine("2026-11-06T11:00:00Z", { week_pct: 30, cc_cost_week: 3 }), // after ts
      ].join("\n") + "\n",
    );
    const r = readingAt(f, "2026-11-06T10:00:00Z");
    assert.equal(r.week_pct, 20);
    assert.equal(r.cc_cost_week, 2);
    assert.equal(r.t, "2026-11-06T09:00:00Z");

    const old = readingAt(f, "2026-11-06T20:00:00Z");
    assert.equal(old.missing, "older than 6h");
    assert.equal(old.week_pct, undefined);

    assert.match(readingAt(f, "2026-11-06T07:00:00Z").missing, /none at or before/);
    assert.equal(readingAt(path.join(dir, "absent.jsonl"), "2026-11-06T10:00:00Z").missing, "no samples file");

    const g = path.join(dir, "allbad.jsonl");
    await writeFile(g, sampleLine("2026-11-06T09:00:00Z", { cc_cost_week: 0 }) + "\n");
    assert.match(readingAt(g, "2026-11-06T10:00:00Z").missing, /none ok/);
  });
});

test("hook: append-only — two runs give exactly two rows and the first row's bytes never change", async () => {
  await withTmp(async (dir) => {
    await writeFile(path.join(dir, "samples.jsonl"), sampleLine("2026-11-06T05:30:00Z") + "\n");
    const a = await writeTranscript(dir, "aaa", LINES);
    const b = await writeTranscript(dir, "bbb", LINES);

    const r1 = runHook(dir, payloadFor(a));
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout, "", "the hook must write nothing to stdout");
    const shard = path.join(costsDirOf(dir), "2026-11.jsonl");
    const before = await readFile(shard, "utf8");
    assert.equal(before.split("\n").filter(Boolean).length, 1);

    const r2 = runHook(dir, payloadFor(b));
    assert.equal(r2.status, 0);
    const after = await readFile(shard, "utf8");
    assert.equal(after.split("\n").filter(Boolean).length, 2, "two hook runs give exactly 2 rows");
    assert.ok(after.startsWith(before), "the first row's bytes must be unchanged by the second run");

    const rows = readRows(dir);
    assert.deepEqual(rows[0].usage, { input: 5, output: 150, cache_create: 1200, cache_read: 2010 });
    assert.equal(rows[0].issue, "#188");
    assert.equal(rows[0].source, "subagent-stop");
    assert.equal(rows[0].week_pct.start, 50);
    assert.equal(rows[0].week_pct.delta, 0);
  });
});

test("hook: malformed stdin exits 0, writes one errors.log line, no cost row, nothing on stdout", async () => {
  await withTmp(async (dir) => {
    const r = runHook(dir, "{ this is not json");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(readRows(dir).length, 0);
    const log = (await readFile(path.join(costsDirOf(dir), "errors.log"), "utf8")).split("\n").filter(Boolean);
    assert.equal(log.length, 1, "exactly one errors.log line");
    assert.match(log[0], /unparseable stdin/);
  });
});

test("hook: fails open when costs.mjs cannot load (exit 0, error attributed in errors.log)", async () => {
  await withTmp(async (dir) => {
    const emptyRoot = path.join(dir, "empty-plugin-root");
    await mkdir(emptyRoot, { recursive: true });
    const p = await writeTranscript(dir, "ccc", LINES);
    const r = runHook(dir, payloadFor(p), { CLAUDE_PLUGIN_ROOT: emptyRoot });
    assert.equal(r.status, 0, `hook must exit 0 even when its module is missing; stderr: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.equal(readRows(dir).length, 0);
    const log = await readFile(path.join(costsDirOf(dir), "errors.log"), "utf8");
    assert.match(log, /subagent-cost:/);
  });
});

test("hook: stop_hook_active true writes no row and no error", async () => {
  await withTmp(async (dir) => {
    const p = await writeTranscript(dir, "ddd", LINES);
    const r = runHook(dir, payloadFor(p, { stop_hook_active: true }));
    assert.equal(r.status, 0);
    assert.equal(storeSnapshot(dir), "<absent>", "nothing at all may be written");
  });
});

test("hook: an unreadable transcript still yields a row with usage:null and an attributable error", async () => {
  await withTmp(async (dir) => {
    const p = path.join(dir, "proj", "sess1", "subagents", "agent-gone.jsonl");
    const r = runHook(dir, payloadFor(p));
    assert.equal(r.status, 0);
    const rows = readRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usage, null);
    assert.match(rows[0].summary_status, /^unreadable/);
    assert.match(await readFile(path.join(costsDirOf(dir), "errors.log"), "utf8"), /transcript unreadable/);
  });
});

test("back-fill without --apply leaves the store byte-identical, for every flag combination", async () => {
  await withTmp(async (dir) => {
    const p = await writeTranscript(dir, "eee", LINES);
    const combos = [["--widget"], ["--transcript", p], ["--widget", "--transcript", p]];

    // Store absent: a dry run must not even create the directory.
    for (const args of combos) {
      const before = storeSnapshot(dir);
      const r = spawnSync(process.execPath, [BACKFILL, ...args], { encoding: "utf8", env: env(dir), timeout: 30000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /DRY RUN: would append/);
      assert.equal(storeSnapshot(dir), before, `dry run with ${args.join(" ")} must not touch an absent store`);
    }

    // Store present with a prior row: still byte-identical.
    runHook(dir, payloadFor(p));
    assert.equal(readRows(dir).length, 1);
    for (const args of combos) {
      const before = storeSnapshot(dir);
      const r = spawnSync(process.execPath, [BACKFILL, ...args], { encoding: "utf8", env: env(dir), timeout: 30000 });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(storeSnapshot(dir), before, `dry run with ${args.join(" ")} must not touch a populated store`);
    }
  });
});

test("back-fill --apply writes the rows once; a second --apply skips them", async () => {
  await withTmp(async (dir) => {
    const p = await writeTranscript(dir, "fff", LINES);
    const args = [BACKFILL, "--widget", "--transcript", p, "--apply"];
    const r1 = spawnSync(process.execPath, args, { encoding: "utf8", env: env(dir), timeout: 30000 });
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /APPLIED: appended 8 row/);
    const rows = readRows(dir);
    assert.equal(rows.length, 8);
    const w = rows.find((r) => r.issue === "#35");
    assert.equal(w.usage, null);
    assert.equal(w.tokens_reported, 215962);
    assert.equal(w.tokens_reported_label, "final-request size, not cost");

    const snap = storeSnapshot(dir);
    const r2 = spawnSync(process.execPath, args, { encoding: "utf8", env: env(dir), timeout: 30000 });
    assert.match(r2.stdout, /appended 0 row\(s\), skipped 8/);
    assert.equal(storeSnapshot(dir), snap, "a repeated --apply must not change the store");
  });
});
