/**
 * usage-recorder.test.mjs -- the exit hook in cli.mjs that records one line per run
 * (D13), and `usage --backfill`.
 *
 * cli.mjs calls process.exit() ~80 times, so these run the REAL cli.mjs as a child
 * and read the store it leaves behind. Two harness facts:
 *   - node:test sets NODE_TEST_CONTEXT and every child inherits it; the recorder
 *     skips under it (D11), so the child env must DELETE it or nothing is written.
 *   - the store is $PROPAGATE_STATE_DIR/runs/<YYYY-MM>.jsonl; every child gets a
 *     fresh temp dir so nothing here can touch ~/.propagate (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { usageReport, countCommandCalls } from "../../lib/report/usage.mjs";
import { resolveCommand } from "../../lib/core/commands.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "cli.mjs");

function freshState() {
  return mkdtempSync(path.join(tmpdir(), "propagate-usage-"));
}

function childEnv(stateDir, extra = {}) {
  const env = { ...process.env, PROPAGATE_STATE_DIR: stateDir, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.PROPAGATE_ORIGIN;
  return { ...env, ...extra };
}

function records(stateDir) {
  const dir = path.join(stateDir, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

/** Every byte of every shard, for a before/after comparison. */
function snapshot(stateDir) {
  const dir = path.join(stateDir, "runs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).sort().map((f) => f + "\n" + readFileSync(path.join(dir, f), "utf8")).join("\n--\n");
}

function run(args, stateDir, { env = {}, node = [] } = {}) {
  return spawnSync(process.execPath, [...node, CLI, ...args], {
    encoding: "utf8",
    env: childEnv(stateDir, env),
    timeout: 60_000,
  });
}

/** A --import preload that runs `body` once the CLI has registered its exit listener. */
function preload(dir, body) {
  const f = path.join(dir, "preload.mjs");
  writeFileSync(
    f,
    `process.on("newListener", function once(ev) {
       if (ev !== "exit") return;
       process.removeListener("newListener", once);
       ${body}
     });\n`,
  );
  return ["--import", f];
}

test("(a) a command that leaves via process.exit writes exactly one record", () => {
  const s = freshState();
  const r = run(["nonsense-mode"], s); // unknown mode: cli.mjs prints usage and process.exit(2)
  assert.equal(r.status, 2);
  const recs = records(s);
  assert.equal(recs.length, 1, `expected one record, got ${JSON.stringify(recs)}`);
  assert.equal(recs[0].command, "unknown", "an unresolvable mode is 'unknown', never the typed text");
  assert.equal(recs[0].outcome, "error");
  assert.equal(recs[0].kind, "command");
  assert.equal(recs[0].origin, "interactive");
  assert.equal(typeof recs[0].duration_ms, "number");
  assert.ok(!JSON.stringify(recs[0]).includes("nonsense"), "argv must never reach the store");
});

test("(a2) a resolved command is recorded by name, ok on exit 0, and argv values stay out", () => {
  const s = freshState();
  const r = run(["settle", "--json", "SECRET-REASON-TEXT.md"], s);
  const recs = records(s);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].command, "settle");
  assert.equal(recs[0].outcome, r.status === 0 ? "ok" : "error");
  assert.ok(!JSON.stringify(recs).includes("SECRET"), "an argument value leaked into the store");
});

test("(b) exit 3 is a refusal, not an error", () => {
  const s = freshState();
  // Real exit-3 paths need a hand-edited artifact or a blocked verify fixture; this
  // forces the code through the same process.exit seam the real ones use.
  const node = preload(s, `const real = process.exit; process.exit = (c) => real.call(process, c === 2 ? 3 : c);`);
  const r = run(["nonsense-mode"], s, { node });
  assert.equal(r.status, 3);
  const recs = records(s);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].outcome, "refused");
});

test("(c) an uncaught exception is recorded as error", () => {
  const s = freshState();
  const node = preload(s, `setImmediate(() => { throw new Error("boom"); });`);
  const r = run(["status"], s, { node });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /boom/);
  const recs = records(s);
  assert.equal(recs.length, 1, `got ${JSON.stringify(recs)}`);
  assert.equal(recs[0].outcome, "error");
  assert.equal(recs[0].command, "status");
});

test("(d) --help is recorded, as 'help', outcome ok", () => {
  const s = freshState();
  const r = run(["--help"], s);
  assert.equal(r.status, 0);
  const recs = records(s);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].command, "help");
  assert.equal(recs[0].outcome, "ok");
});

test("PROPAGATE_ORIGIN tags the record; an unknown origin falls back to interactive", () => {
  const s = freshState();
  run(["--help"], s, { env: { PROPAGATE_ORIGIN: "widget" } });
  run(["--help"], s, { env: { PROPAGATE_ORIGIN: "some-free-text" } });
  const [a, b] = records(s);
  assert.equal(a.origin, "widget");
  assert.equal(b.origin, "interactive", "free text from the environment must not reach the store");
});

test("(e) under NODE_TEST_CONTEXT the store is byte-identical before and after", () => {
  const s = freshState();
  // Seed a shard so 'identical' is not 'both empty'.
  const seed = run(["--help"], s);
  assert.equal(seed.status, 0);
  const before = snapshot(s);
  assert.ok(before.length > 0, "control: the seed run must have written a record");
  for (const argv of [["--help"], ["nonsense-mode"], ["settle", "--json"], ["usage"]]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], {
      encoding: "utf8",
      env: { ...childEnv(s), NODE_TEST_CONTEXT: "child-v8" },
      timeout: 60_000,
    });
    assert.notEqual(r.status, null, `${argv.join(" ")} did not finish`);
  }
  assert.equal(snapshot(s), before, "a test-context run wrote to the store");
});

test("a recorder write failure neither throws nor changes the exit code", () => {
  const s = freshState();
  // RUNS_DIR is a FILE, so mkdirSync/appendFileSync throw inside the exit hook.
  writeFileSync(path.join(s, "runs"), "not a directory");
  const r = run(["nonsense-mode"], s);
  assert.equal(r.status, 2, "exit code must be the command's own");
  assert.ok(!/Error:/.test(r.stderr.split("unknown mode")[1] ?? ""), "recorder failure must be silent");
});

test("(f) usageReport origin filter: default interactive, 'all' keeps everything, legacy has no origin", () => {
  const mk = (o) => ({ ts: "2026-10-15T00:00:00Z", command: "doctor", outcome: "ok", ...o });
  const runs = [mk({ origin: "interactive" }), mk({ origin: "monitor" }), mk({ origin: "monitor" }), mk({ origin: "widget" }), mk({})];
  const d = usageReport(runs, ["doctor"]);
  assert.equal(d.origin, "interactive");
  assert.equal(d.byCommand.doctor.invocations, 2, "interactive + the legacy record with no origin");
  assert.equal(d.legacyOrigin, 1);
  assert.equal(usageReport(runs, ["doctor"], { origin: "monitor" }).byCommand.doctor.invocations, 2);
  assert.equal(usageReport(runs, ["doctor"], { origin: "all" }).byCommand.doctor.invocations, 5);
  assert.deepEqual(d.byOrigin, { interactive: 2, monitor: 2, widget: 1 });
  assert.equal(d.totalBeforeFilter, 5);
});

test("a backfill count (outcome null) is not an ok and does not dilute the failure rate", () => {
  const r = usageReport(
    [
      { command: "verify", outcome: "error", origin: "interactive" },
      { command: "verify", outcome: null, origin: "backfill" },
      { command: "verify", outcome: null, origin: "backfill" },
    ],
    ["verify"],
    { origin: "all" },
  );
  const v = r.byCommand.verify;
  assert.equal(v.invocations, 3);
  assert.equal(v.ok, 0, "an unobserved outcome must not be counted ok");
  assert.equal(v.unrecorded, 2);
  assert.equal(v.failureRate, 1, "1 error over the 1 OBSERVED outcome");
});

// ── usage --backfill ────────────────────────────────────────────────────────

function toolUse(id, command, ts) {
  return JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
}

test("countCommandCalls: registry-filtered, deduped per tool call, no command text returned", () => {
  const text = [
    toolUse("t1", "node /x/cli.mjs verify --edge E --note 'SECRET'", "2026-10-01T10:00:00Z"),
    toolUse("t2", "node cli.mjs status && node cli.mjs status --json", "2026-10-01T11:00:00Z"),
    toolUse("t3", "node cli.mjs echo hi", "2026-10-01T12:00:00Z"), // not a command
    toolUse("t4", "node cli.mjs claims check --json", "2026-10-01T13:00:00Z"),
    "not json cli.mjs",
  ].join("\n");
  const out = countCommandCalls(text, resolveCommand);
  assert.deepEqual(out.map((c) => c.command), ["verify", "status", "claims check"], "echo dropped; status counted once for one tool call");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

function backfillSetup() {
  const s = freshState();
  const home = mkdtempSync(path.join(tmpdir(), "propagate-home-"));
  const proj = path.join(home, ".claude", "projects", "p1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    path.join(proj, "sess.jsonl"),
    [
      toolUse("a1", "node cli.mjs verify --edge E --note 'SECRET'", "2026-10-01T10:00:00Z"),
      toolUse("a2", "node cli.mjs doctor", "2026-09-30T10:00:00Z"),
    ].join("\n") + "\n",
  );
  return { s, home };
}

test("usage --backfill is a DRY RUN: the store is untouched without --apply", () => {
  const { s, home } = backfillSetup();
  const env = { HOME: home };
  const r = run(["usage", "--backfill", "--json"], s, { env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.apply, false);
  assert.equal(out.wouldWrite, 2);
  assert.equal(out.written, 0);
  // The only runs/ content allowed is the recorder's own line for THIS command.
  assert.deepEqual(records(s).filter((x) => x.origin === "backfill"), [], "dry run wrote backfill records");
});

test("usage --backfill --apply writes counts only, once; a second run adds nothing", () => {
  const { s, home } = backfillSetup();
  const env = { HOME: home };
  const first = JSON.parse(run(["usage", "--backfill", "--apply", "--json"], s, { env }).stdout);
  assert.equal(first.written, 2);
  const bf = records(s).filter((x) => x.origin === "backfill");
  assert.equal(bf.length, 2);
  for (const b of bf) {
    assert.equal(b.outcome, null);
    assert.equal(b.kind, "command");
  }
  assert.ok(!JSON.stringify(bf).includes("SECRET"), "command text reached the store");
  assert.deepEqual(bf.map((b) => b.command).sort(), ["doctor", "verify"]);
  const second = JSON.parse(run(["usage", "--backfill", "--apply", "--json"], s, { env }).stdout);
  assert.equal(second.written, 0);
  assert.equal(second.alreadyRecorded, 2);
  assert.equal(records(s).filter((x) => x.origin === "backfill").length, 2);
});

test("plain `usage` aggregates the store and defaults to the interactive origin", () => {
  const s = freshState();
  run(["--help"], s);
  run(["--help"], s, { env: { PROPAGATE_ORIGIN: "monitor" } });
  const d = JSON.parse(run(["usage", "--json"], s).stdout);
  assert.equal(d.origin, "interactive");
  assert.equal(d.byCommand.help.invocations, 1);
  const all = JSON.parse(run(["usage", "--json", "--origin", "all"], s).stdout);
  assert.ok(all.byCommand.help.invocations >= 2);
});
