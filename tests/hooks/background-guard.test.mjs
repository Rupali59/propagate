// background-guard (propagate#224): rule:background-long-runs and rule:delegation-criteria §3 as a PreToolUse check.
// Inputs are literal payloads, never built through a helper that could only express valid ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";

import { decide, HEAVY, networkPatterns } from "../../hooks/background-guard.mjs";
import { COMMANDS } from "../../lib/core/commands.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "background-guard.mjs");
const main = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });
const sub = (command, extra = {}) => ({ tool_name: "Bash", agent_id: "agent-abc123", agent_type: "general-purpose", tool_input: { command, ...extra } });

test("the heavy list has a floor, and every entry matches its own example (a blind list denies nothing)", async () => {
  assert.ok(HEAVY.length >= 5, `only ${HEAVY.length} heavy entries: the list has gone empty, it has not found nothing`);
  for (const h of HEAVY) {
    assert.ok(h.label && h.example, `entry ${JSON.stringify(h.label)} lacks a label or example`);
    const d = await decide(main(h.example));
    assert.equal(d.deny, true, `heavy entry "${h.label}" does not deny its own example "${h.example}"`);
    assert.match(d.reason, /run_in_background: true/);
    assert.equal((await decide(main(h.example, { run_in_background: true }))).deny, false, `"${h.label}" must pass when backgrounded`);
    assert.equal((await decide(sub(h.example, { timeout: 600000 }))).deny, false, `"${h.label}" must pass in a subagent foreground (rule 4)`);
  }
});

// ── the network commands are DERIVED from COMMANDS, never listed here (propagate#224, rule:derive-dont-curate) ──
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the derivation has a floor, and every network command is denied in the foreground, in both spellings", async () => {
  const NETWORK = await networkPatterns();
  assert.ok(NETWORK.length >= 5, `only ${NETWORK.length} network commands are marked in lib/core/commands.mjs: the derivation has gone blind, it has not found nothing`);
  for (const [name, c] of Object.entries(COMMANDS).filter(([, c]) => c.network === true)) {
    for (const spelling of [`propagate ${name}`, `node /x/propagate/cli.mjs ${name} --json`, `FOO=1 propagate ${name}`]) {
      const d = await decide(main(spelling));
      assert.equal(d.deny, true, `network command "${name}" is not denied in the foreground: ${spelling}`);
      assert.equal((await decide(main(spelling, { run_in_background: true }))).deny, false, `"${spelling}" must pass backgrounded`);
      assert.equal((await decide(sub(spelling, { timeout: 600000 }))).deny, false, `"${spelling}" must pass in a subagent foreground`);
    }
    assert.equal((await decide(main(`git commit -m "propagate ${name}"`))).deny, false, `a quoted mention of "${name}" must not count`);
    for (const f of c.offline ?? []) assert.equal((await decide(main(`propagate ${name} ${f}`))).deny, false, `"${name} ${f}" skips GitHub and must pass`);
  }
  assert.equal((await decide(main("propagate goals check-done"))).deny, false, "goals check-done is not goals check");
});

test("a command that cannot name propagate never loads COMMANDS (the hook runs on every Bash call)", async () => {
  let loads = 0;
  const load = async () => { loads++; return COMMANDS; };
  for (const c of ["git status", "npm run lint", "ls -la", "npm test", "node --test tests/x.test.mjs"]) await decide(main(c), load);
  assert.equal(loads, 0, "COMMANDS was loaded for a command that names neither propagate nor cli.mjs");
  assert.equal((await decide(main("propagate broadcast new"), load)).deny, true);
  assert.equal(loads, 1, "a propagate command must load COMMANDS exactly once (the counter proves the test can see a load)");
});

// A module that calls GitHub, whose command is not marked, is the broadcast case. The scan is: for each cli/<word>.mjs,
// its own text plus the relative modules it imports one level deep; a hit means <word> must have a network entry.
const GH_CALL = /\bghFetcher\b|\bmakeGh\b|\bdefaultGh\b|\brefreshTrackers\b|broadcast\/gh\.mjs|spawnSync\(\s*gh\b|\bgraphql\b/;
// Exempt, with the reason: `ui` is a long-lived server whose gh refresh is a click-driven side path, never a foreground run.
const NOT_A_RUN = new Map([["ui", "a server, started once and left running"]]);
const reachesGh = (file) => {
  const text = readFileSync(file, "utf8");
  if (GH_CALL.test(text)) return true;
  for (const m of text.matchAll(/from\s+["'](\.[^"']+\.mjs)["']/g)) {
    const dep = path.resolve(path.dirname(file), m[1]);
    if (existsSync(dep) && GH_CALL.test(readFileSync(dep, "utf8"))) return true;
  }
  return false;
};

test("a cli module that reaches GitHub has its command marked network (mutation: unmark broadcast new and this goes red)", () => {
  const files = readdirSync(path.join(ROOT, "cli")).filter((f) => f.endsWith(".mjs"));
  const hits = files.filter((f) => reachesGh(path.join(ROOT, "cli", f)));
  assert.ok(hits.length >= 4, `only ${hits.length} of ${files.length} cli modules were found to reach GitHub: the scan has gone blind`);
  for (const f of hits) {
    const word = f.replace(/\.mjs$/, "");
    if (NOT_A_RUN.has(word)) continue;
    const entries = Object.entries(COMMANDS).filter(([n]) => n.split(" ")[0] === word);
    assert.ok(entries.length, `cli/${f} reaches GitHub but no COMMANDS entry starts with "${word}"`);
    assert.ok(entries.some(([, c]) => c.network === true), `cli/${f} reaches GitHub but none of ${entries.map(([n]) => `"${n}"`).join(", ")} is marked network: true in lib/core/commands.mjs`);
  }
  // `broadcast` is the case that shipped the defect: its two subcommands must each be marked, not just one.
  for (const n of ["broadcast new", "broadcast status"]) assert.equal(COMMANDS[n]?.network, true, `"${n}" must be marked network: true`);
});

const DENY = [
  // rule 1: main session, foreground
  [main("npm run lint", { timeout: 120000 }), /foreground timeout of 120000/],
  [main("sleep 5", { timeout: 500000 }), /foreground timeout/],
  [main("npm test"), /npm test/],
  [main("cd x && npm test"), /npm test/],
  [main("FOO=1 npm run test:record"), /test:record/],
  [main("node cli.mjs release --check"), /release --check/],
  [main("propagate doctor"), /doctor/],
  [main("node cli.mjs make-public Rupali59/x --check"), /make-public/],
  // rule 2: a shell & or nohup, in any session
  [main("npm run build &"), /shell `&`/],
  [main("npm test > log 2>&1 &", { run_in_background: true }), /shell `&`/],
  [main("a & b"), /shell `&`/],
  [sub("npm run build &"), /shell `&`/],
  [main("nohup node server.mjs"), /nohup/],
  [sub("nohup node server.mjs"), /nohup/],
  // rule 3: a subagent that backgrounds
  [sub("npm test", { run_in_background: true }), /FOREGROUND/],
  [sub("sleep 400", { run_in_background: true }), /FOREGROUND/],
];
const ALLOW = [
  [main("git log && npm run lint"), "&& is not a background"],
  [main("cmd 2>&1 | head"), "2>&1 is a redirection"],
  [main("echo x >&2"), ">&2 is a redirection"],
  [main("cmd &> out.log"), "&> is a redirection"],
  [main("npm test", { run_in_background: true }), "main session heavy command, backgrounded"],
  [main("npm run lint", { timeout: 119999 }), "timeout under the limit"],
  [main("npm run lint", { timeout: 600000, run_in_background: true }), "long timeout, backgrounded"],
  [sub("npm test", { timeout: 600000 }), "subagent foreground heavy command (rule 4)"],
  [main("propagate doctor --quick"), "doctor --quick"],
  [main("git commit -m 'fix a && b & c'"), "ampersands inside quotes"],
  [main('echo "nohup & friends"'), "nohup and & inside quotes"],
  [main('git commit -m "npm test and doctor"'), "a heavy command named inside quotes"],
  [main("node --test tests/hooks/x.test.mjs"), "one test file"],
  [{ tool_name: "Edit", tool_input: { file_path: "a" } }, "not Bash"],
  [{}, "empty payload"],
];

for (const [input, why] of DENY) {
  test(`denies: ${input.agent_id ? "[subagent] " : ""}${input.tool_input.command} ${JSON.stringify({ ...input.tool_input, command: undefined })}`, async () => {
    const d = await decide(input);
    assert.equal(d.deny, true, "expected a deny");
    assert.match(d.reason, why);
  });
}
for (const [input, why] of ALLOW) {
  test(`allows: ${why}`, async () => assert.deepEqual(await decide(input), { deny: false }));
}

// Always a throwaway state dir: a deny now appends a guard-log row, which must never land in a real ~/.propagate.
const run = (stdin) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: mkdtempSync(path.join(tmpdir(), "guard-run-")) } });

test("real process: a denied payload prints the deny JSON and exits 0", () => {
  const r = run(JSON.stringify(main("npm test")));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /run_in_background: true/);
});

test("real process: an allowed payload is silent and exits 0", () => {
  const r = run(JSON.stringify(main("git status")));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("real process: a subagent foreground heavy command is silent", () => {
  const r = run(JSON.stringify(sub("npm test", { timeout: 600000 })));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("real process: an unreadable payload fails open, silently", () => {
  for (const junk of ["not json{", "", "[1,2"]) {
    const r = run(junk);
    assert.equal(r.status, 0, `exit for ${JSON.stringify(junk)}`);
    assert.equal(r.stdout, "");
  }
});

// ── propagate#294: the guard log. One row per deny and per allow-bg, never any command text ─────────────────────────
import { mkdtempSync, writeFileSync, mkdirSync as mkdirSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { respond, guardRow, programOf } from "../../hooks/background-guard.mjs";
import { pruneGuard } from "../../lib/guard/log.mjs";

const ROW_KEYS = ["command_hash", "event", "label", "program", "rule", "session", "timeout_ms", "ts"];
const tmpState = () => mkdtempSync(path.join(tmpdir(), "guard-log-"));
const runIn = (stateDir, stdin) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8", env: { ...process.env, PROPAGATE_STATE_DIR: stateDir } });
const guardBytes = (stateDir) => {
  const d = path.join(stateDir, "guard");
  if (!existsSync(d)) return "";
  return readdirSync(d).map((f) => readFileSync(path.join(d, f), "utf8")).join("");
};
const guardRows = (stateDir) => guardBytes(stateDir).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const withSession = (input) => ({ session_id: "sess-0001", ...input });

test("T-G1 a deny writes exactly one row with exactly the stated keys, and stdout is unchanged", () => {
  const dir = tmpState();
  const r = runIn(dir, JSON.stringify(withSession(main("npm test"))));
  assert.equal(r.status, 0);
  const plain = run(JSON.stringify(withSession(main("npm test"))));
  assert.equal(r.stdout, plain.stdout, "the deny JSON on stdout must be byte-identical with or without a log");
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  const rows = guardRows(dir);
  assert.equal(rows.length, 1, "one deny, one row");
  assert.deepEqual(Object.keys(rows[0]).sort(), ROW_KEYS);
  assert.equal(rows[0].event, "deny");
  assert.equal(rows[0].rule, "heavy");
  assert.equal(rows[0].label, "npm test");
  assert.equal(rows[0].program, "npm");
  assert.equal(rows[0].session, "sess-0001");
  assert.equal(rows[0].timeout_ms, null);
  assert.match(rows[0].command_hash, /^[0-9a-f]{16}$/);
  assert.equal(rows[0].command_hash, createHash("sha256").update("npm test").digest("hex").slice(0, 16));
  const month = rows[0].ts.slice(0, 7);
  assert.ok(existsSync(path.join(dir, "guard", `${month}.jsonl`)), "the row lands in the UTC month file of its ts");
});

test("T-G1 every deny rule names itself: timeout, heavy, shell-bg, sub-bg", () => {
  const dir = tmpState();
  for (const p of [main("sleep 5", { timeout: 500000 }), main("npm run build &"), sub("sleep 400", { run_in_background: true })]) runIn(dir, JSON.stringify(withSession(p)));
  const rows = guardRows(dir);
  assert.deepEqual(rows.map((r) => [r.event, r.rule]), [["deny", "timeout"], ["deny", "shell-bg"], ["deny", "sub-bg"]]);
  assert.equal(rows[0].timeout_ms, 500000);
  assert.equal(rows[1].label, "&");
});

test("T-G2 a backgrounded heavy call writes an allow-bg row; a plain command writes nothing", () => {
  const dir = tmpState();
  const bg = runIn(dir, JSON.stringify(withSession(main("npm test", { run_in_background: true }))));
  assert.equal(bg.stdout, "", "a backgrounded call is still allowed silently");
  const bgTimeout = runIn(dir, JSON.stringify(withSession(main("sleep 5", { run_in_background: true, timeout: 600000 }))));
  assert.equal(bgTimeout.stdout, "");
  for (const c of ["git status", "ls -la"]) runIn(dir, JSON.stringify(withSession(main(c))));
  runIn(dir, JSON.stringify(withSession(main("ls -la", { run_in_background: true }))));
  runIn(dir, JSON.stringify(withSession(sub("npm test", { timeout: 600000 }))));
  const rows = guardRows(dir);
  assert.deepEqual(rows.map((r) => [r.event, r.rule, r.label]), [["allow-bg", "heavy", "npm test"], ["allow-bg", "timeout", null]],
    "only the two backgrounded calls that match a rule are logged; plain, plain-backgrounded and subagent-foreground calls write nothing");
});

test("T-G2 a backgrounded plain command never loads COMMANDS, and a backgrounded network command does", async () => {
  let loads = 0;
  const load = async () => { loads++; return COMMANDS; };
  const rows = [];
  const io = { load, write: () => {}, append: (row) => rows.push(row) };
  for (const c of ["git status", "npm run lint", "npm test"]) await respond(withSession(main(c, { run_in_background: true })), io);
  assert.equal(loads, 0, "COMMANDS was loaded for a backgrounded command that names neither propagate nor cli.mjs");
  await respond(withSession(main("propagate broadcast new", { run_in_background: true })), io);
  assert.equal(loads, 1);
  assert.deepEqual(rows.map((r) => [r.event, r.label]), [["allow-bg", "npm test"], ["allow-bg", "broadcast new (reaches GitHub)"]]);
});

test("T-G3 secrets never reach disk: no NAME=value value, no header, no token", () => {
  const dir = tmpState();
  const cases = [
    main("SECRET=hunter2 npm test"),
    main("DOPPLER_TOKEN=s3cr3t npm test"),
    main(`curl -H "Authorization: Bearer abc" https://example.invalid`, { timeout: 600000 }),
    main(`curl -H 'Authorization: Bearer abc' x`, { timeout: 600000 }),
    main("SECRET=hunter2 npm test", { run_in_background: true }),
  ];
  for (const p of cases) {
    const r = runIn(dir, JSON.stringify(withSession(p)));
    assert.equal(r.status, 0);
  }
  const rows = guardRows(dir);
  assert.equal(rows.length, cases.length, "every case was logged, so the absence below is not an empty file");
  const bytes = guardBytes(dir);
  for (const s of ["hunter2", "s3cr3t", "Bearer", "abc", "Authorization", "SECRET", "DOPPLER_TOKEN", "example.invalid"]) {
    assert.ok(!bytes.includes(s), `the guard log contains ${JSON.stringify(s)}`);
  }
  assert.deepEqual(rows.map((r) => r.program), ["npm", "npm", "curl", "curl", "npm"], "program is the bare program after VAR=value prefixes");
});

test("programOf: the first word after every NAME=value, kept only when it is a bare name", () => {
  assert.equal(programOf("A=1 B=two npm test"), "npm");
  assert.equal(programOf("  git status"), "git");
  assert.equal(programOf("node ./cli.mjs doctor"), "node");
  assert.equal(programOf("SECRET=hunter2"), null, "only assignments: no program, and never the value");
  assert.equal(programOf(`"quoted thing" x`), null);
  assert.equal(programOf("x".repeat(33)), null, "over 32 characters is not a bare name");
  assert.equal(programOf(""), null);
  assert.equal(programOf("/usr/local/bin/npm test"), "npm", "a path is reduced to its basename");
  assert.equal(programOf("./scripts/run.sh"), "run.sh");
});

test("a command that starts with an absolute path logs only the basename: no home directory or username on disk", () => {
  const dir = tmpState();
  const r = runIn(dir, JSON.stringify(withSession(main("/home/someone/bin/tool run", { timeout: 600000 }))));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  const rows = guardRows(dir);
  assert.equal(rows.length, 1, "the call was logged, so the absence below is not an empty file");
  assert.equal(rows[0].program, "tool");
  for (const s of ["someone", "/home"]) assert.ok(!guardBytes(dir).includes(s), `the guard log contains ${JSON.stringify(s)}`);
});

test("guardRow hashes the whitespace-normalised command and stores nothing else of it", () => {
  const a = guardRow(main("npm   test\n"), { event: "deny", rule: "heavy", label: "npm test" }, new Date("2026-11-30T23:59:00Z"));
  const b = guardRow(main("npm test"), { event: "deny", rule: "heavy", label: "npm test" }, new Date("2026-11-30T23:59:00Z"));
  assert.equal(a.command_hash, b.command_hash);
  assert.equal(a.ts, "2026-11-30T23:59:00.000Z");
  assert.equal(a.session, null, "no session_id in the payload is null, not a guess");
});

test("T-G4 a failing append still yields the same deny, exit 0 (guard/ is a file, so the append throws)", () => {
  const dir = tmpState();
  writeFileSync(path.join(dir, "guard"), "not a directory");
  const r = runIn(dir, JSON.stringify(withSession(main("npm test"))));
  const plain = run(JSON.stringify(withSession(main("npm test"))));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, plain.stdout, "a failed append changed the decision output");
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(r.stderr, "");
  assert.equal(readFileSync(path.join(dir, "guard"), "utf8"), "not a directory", "the blocking file is untouched");
});

test("T-G4 a failing append on an unwritable guard/ directory still yields the same deny", { skip: process.getuid?.() === 0 ? "root ignores directory modes" : false }, async () => {
  const { chmodSync } = await import("node:fs");
  const dir = tmpState();
  mkdirSyncFs(path.join(dir, "guard"));
  chmodSync(path.join(dir, "guard"), 0o500);
  try {
    const r = runIn(dir, JSON.stringify(withSession(main("npm test"))));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(readdirSync(path.join(dir, "guard")).length, 0, "the probe proves the append really failed");
  } finally {
    chmodSync(path.join(dir, "guard"), 0o700);
  }
});

test("T-G4 the decision is written before the row is appended, and a throwing append is swallowed", async () => {
  const order = [];
  const io = { write: () => order.push("write"), append: () => { order.push("append"); throw new Error("disk full"); } };
  const d = await respond(withSession(main("npm test")), io);
  assert.equal(d.deny, true);
  assert.deepEqual(order, ["write", "append"], "the deny must be on stdout before the log append is attempted");
});

test("T-G5 the month file is the UTC month of ts", async () => {
  const dir = tmpState();
  const io = { write: () => {}, stateDir: dir, now: () => new Date("2026-11-30T23:59:00Z") };
  await respond(withSession(main("npm test")), io);
  assert.deepEqual(readdirSync(path.join(dir, "guard")), ["2026-11.jsonl"]);
});

test("T-G6 prune removes only month files that ended more than 90 days ago", () => {
  const dir = tmpState();
  const g = path.join(dir, "guard");
  mkdirSyncFs(g);
  for (const f of ["2026-07.jsonl", "2026-08.jsonl", "2026-10.jsonl", "notes.txt", "2026-13.jsonl"]) writeFileSync(path.join(g, f), "{}\n");
  const removed = pruneGuard(dir, Date.parse("2026-11-16T12:00:00Z"));
  assert.deepEqual(removed, ["2026-07.jsonl"]);
  assert.deepEqual(readdirSync(g).sort(), ["2026-08.jsonl", "2026-10.jsonl", "2026-13.jsonl", "notes.txt"]);
});

test("T-G6 prune with no guard/ directory removes nothing and creates nothing (an install from before #294)", () => {
  const dir = tmpState();
  assert.deepEqual(pruneGuard(dir, Date.now()), []);
  assert.equal(existsSync(path.join(dir, "guard")), false);
});

test("T-G6 prune reads the same file names the hook writes", async () => {
  const dir = tmpState();
  await respond(withSession(main("npm test")), { write: () => {}, stateDir: dir, now: () => new Date("2026-01-15T00:00:00Z") });
  assert.deepEqual(pruneGuard(dir, Date.parse("2026-11-16T00:00:00Z")), ["2026-01.jsonl"]);
});

test("T-G6/T-G7 the hook never prunes and imports only node builtins and lib/core/paths.mjs (plus the lazy COMMANDS)", () => {
  const src = readFileSync(HOOK, "utf8");
  for (const fn of ["readdirSync", "unlinkSync", "rmSync", "rmdirSync"]) assert.ok(!src.includes(fn), `the hook mentions ${fn}: pruning belongs to the CLI`);
  const specs = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 3, `only ${specs.length} imports found: the scan has gone blind`);
  for (const s of specs) assert.ok(s.startsWith("node:") || s === "../lib/core/paths.mjs", `background-guard imports ${s}`);
  const dynamic = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(dynamic, ["../lib/core/commands.mjs"]);
});
