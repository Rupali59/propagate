// background-guard (propagate#224): rule:background-long-runs and rule:delegation-criteria §3 as a PreToolUse check.
// Inputs are literal payloads, never built through a helper that could only express valid ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decide, HEAVY } from "../../hooks/background-guard.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "background-guard.mjs");
const main = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });
const sub = (command, extra = {}) => ({ tool_name: "Bash", agent_id: "agent-abc123", agent_type: "general-purpose", tool_input: { command, ...extra } });

test("the heavy list has a floor, and every entry matches its own example (a blind list denies nothing)", () => {
  assert.ok(HEAVY.length >= 5, `only ${HEAVY.length} heavy entries: the list has gone empty, it has not found nothing`);
  for (const h of HEAVY) {
    assert.ok(h.label && h.example, `entry ${JSON.stringify(h.label)} lacks a label or example`);
    const d = decide(main(h.example));
    assert.equal(d.deny, true, `heavy entry "${h.label}" does not deny its own example "${h.example}"`);
    assert.match(d.reason, /run_in_background: true/);
    assert.equal(decide(main(h.example, { run_in_background: true })).deny, false, `"${h.label}" must pass when backgrounded`);
    assert.equal(decide(sub(h.example, { timeout: 600000 })).deny, false, `"${h.label}" must pass in a subagent foreground (rule 4)`);
  }
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
  test(`denies: ${input.agent_id ? "[subagent] " : ""}${input.tool_input.command} ${JSON.stringify({ ...input.tool_input, command: undefined })}`, () => {
    const d = decide(input);
    assert.equal(d.deny, true, "expected a deny");
    assert.match(d.reason, why);
  });
}
for (const [input, why] of ALLOW) {
  test(`allows: ${why}`, () => assert.deepEqual(decide(input), { deny: false }));
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
