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

const run = (stdin) => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });

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
