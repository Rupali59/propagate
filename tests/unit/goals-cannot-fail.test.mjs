// A Derived-by command that cannot fail (propagate#383): failurePath flags it, `goals allow` refuses it,
// `goals check` lists it, and check-done shows the output it read as a pass.
// Mutations: remove the echo rule -> "ends in echo" goes red; remove the allow refusal -> "allow refuses" goes red.
// @size medium — check-done spawns bash
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseGoalsFile } from "../../lib/report/goals.mjs";
import { failurePath, readTrust } from "../../lib/report/goals-run.mjs";
import { checkGoals } from "../../lib/report/goals-check.mjs";
import { allowCmd, checkDoneCmd } from "../../cli/goals.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "goals-cf-"));
  process.env.PROPAGATE_STATE_DIR = path.join(dir, "state");
});

const quiet = (fn) => {
  const log = console.log;
  const err = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  try {
    return { code: fn(), out: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
};

const FLAGGED = {
  "ends in echo": 'node /ws/cli.mjs rules check; echo "exit $?"',
  "ends in echo after &&": "build && echo done",
  "ends in printf": "check.sh; printf 'ok\\n'",
  "ends in true": "check.sh; true",
  "|| true": "check.sh || true",
  "|| :": "check.sh || :",
  "pipe to tail": "check.sh | tail -1",
  "pipe to head": "check.sh | head -3",
  "pipe to cat": "check.sh | cat",
  "pipe to sort": "check.sh | sort",
  "pipe to wc": "check.sh | wc -l",
  "pipe to tee": "check.sh | tee /tmp/out",
  "grep -c": "check.sh | grep -c unmet",
  "node -e with no exit path": "check.sh --json | node -e 'console.log(JSON.parse(require(\"fs\").readFileSync(0)).n)'",
  "node -e with only exit(0) and exit(2)": "check.sh | node -e 'if(!x)process.exit(2);process.exit(0)'",
  "awk whose only exit is 2": "check.sh | awk '{n++} END{if(n<10){print \"few\"; exit 2} print n \" of 46\"}'",
  "the old goal-11 grep-free summary": "check.sh | awk '/derivation:/{print}'",
};
for (const [name, cmd] of Object.entries(FLAGGED)) {
  test(`failurePath flags: ${name}`, () => {
    const r = failurePath(cmd);
    assert.equal(r.ok, false, `${cmd} should be flagged`);
    assert.ok(r.reason.length > 10);
  });
}

const HONEST = {
  "node -e with a computed exit": "check.sh --json | node -e 'const u=JSON.parse(require(\"fs\").readFileSync(0)).u;process.exit(u?1:0)'",
  "node -e with exitCode": "check.sh | node -e 'process.exitCode = 1'",
  "plain grep": "check.sh | grep -E 'derivation:'",
  "a bare command": "exit 3",
  "a bare true (the shape the existing tests use)": "true",
  "a test runner": "npm run test:propagate",
  "awk with an exit 1": "check.sh | awk '{n++} END{if(n<10){exit 2} exit (n>3 ? 1 : 0)}'",
  "echo that is not last": "echo start; check.sh",
};
for (const [name, cmd] of Object.entries(HONEST)) {
  test(`failurePath does not flag: ${name}`, () => {
    assert.deepEqual(failurePath(cmd), { ok: true }, cmd);
  });
}

test("failurePath ignores a separator inside quotes", () => {
  assert.equal(failurePath("check.sh --pattern 'a; echo b'").ok, true);
});

const GOALS = (cmd) => `# W

## 1 · Linked
**Done when:** none undeclared.
**Derived by:** \`${cmd}\`
`;
const write = (cmd) => {
  const p = path.join(dir, "GOALS.md");
  writeFileSync(p, GOALS(cmd));
  return p;
};

test("goals allow refuses a flagged command, writes nothing, and says why", () => {
  const p = write("exit 3; echo done");
  const r = quiet(() => allowCmd([p, "1"]));
  assert.equal(r.code, 3);
  assert.match(r.out, /cannot fail/);
  assert.match(r.out, /--force --reason/);
  assert.deepEqual(readTrust(path.join(dir, "state", "goals", "trusted.json")).entries, []);
});

test("goals allow --force --reason overrides and records the override", () => {
  const p = write("exit 3; echo done");
  assert.equal(quiet(() => allowCmd([p, "1", "--force"])).code, 2, "--force alone needs a reason");
  const r = quiet(() => allowCmd([p, "1", "--force", "--reason", "echo is the report, exit 3 is the gate"]));
  assert.equal(r.code, 0);
  const [e] = readTrust(path.join(dir, "state", "goals", "trusted.json")).entries;
  assert.equal(e.override.reason, "echo is the report, exit 3 is the gate");
  assert.match(e.override.lint, /echo/);
});

test("goals allow approves an honest command with no override recorded", () => {
  const p = write("exit 3");
  assert.equal(quiet(() => allowCmd([p, "1"])).code, 0);
  assert.equal(readTrust(path.join(dir, "state", "goals", "trusted.json")).entries[0].override, undefined);
});

test("goals check lists a flagged Derived-by command as a violation naming file, goal and reason", () => {
  const p = write("check.sh | tail -1");
  const res = checkGoals({
    files: [parseGoalsFile(p)],
    boards: [{ number: 1, title: "b", hasGoalField: false, items: [] }],
    approvals: [],
  });
  const v = res.violations.filter((x) => x.clause === "derived-by-cannot-fail");
  assert.equal(v.length, 1);
  assert.match(v[0].subject, /GOALS\.md/);
  assert.match(v[0].subject, /1/);
  assert.match(v[0].reason, /tail/);
  assert.equal(res.ok, false);
});

test("goals check does not list an honest command, or a closed goal's", () => {
  const p = write("exit 3");
  const ok = checkGoals({ files: [parseGoalsFile(p)], boards: [{ number: 1, title: "b", hasGoalField: false, items: [] }], approvals: [] });
  assert.equal(ok.violations.filter((x) => x.clause === "derived-by-cannot-fail").length, 0);
  writeFileSync(p, GOALS("check.sh | tail -1").replace("**Derived by:**", "**Resolved:** 2026-11-01 · done\n**Derived by:**"));
  const closed = checkGoals({ files: [parseGoalsFile(p)], boards: [{ number: 1, title: "b", hasGoalField: false, items: [] }], approvals: [] });
  assert.equal(closed.violations.filter((x) => x.clause === "derived-by-cannot-fail").length, 0);
});

test("check-done: a met row carries output_tail (last 3 lines) and the text shows them", () => {
  const p = write("printf 'a\\nb\\nc\\nd\\n'");
  assert.equal(quiet(() => allowCmd([p, "1"], {})).code, 0, "printf alone is not flagged");
  const opts = { files: [p], root: () => dir, now: new Date("2026-11-26T10:00:00Z") };
  const j = JSON.parse(quiet(() => checkDoneCmd(["--json"], opts)).out);
  const row = j.results.find((x) => x.n === 1);
  assert.equal(row.outcome, "met");
  assert.deepEqual(row.output_tail, ["b", "c", "d"]);
  const t = quiet(() => checkDoneCmd([], opts)).out;
  assert.match(t, /read as a pass: d/);
  assert.match(t, /read as a pass: b/);
  assert.doesNotMatch(t, /read as a pass: a\b/);
});
