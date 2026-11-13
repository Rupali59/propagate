// goals allow / check-done (propagate#55): approved Derived-by commands run, a pass writes Resolved.
// Every guard here has a test that goes red when the guard is removed: the untrusted canary (drop the
// trust check), the byte-identical dry run (drop the --apply guard), and the fence test (drop fence-awareness).
// @size medium — spawns bash, and one case waits out a 300 ms timeout; run when affected
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseGoalsFile, goalCounts } from "../../lib/report/goals.mjs";
import { runDerived, writeResolved, commandHash, readTrust } from "../../lib/report/goals-run.mjs";
import { allowCmd, checkDoneCmd } from "../../cli/goals.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "goals-run-"));
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
// cwd for every command is the temp dir, not a repo root found by git.
const opts = (extra = {}) => ({ files: [path.join(dir, "GOALS.md")], root: () => dir, now: new Date("2026-11-13T10:00:00Z"), ...extra });
const write = (text) => {
  const p = path.join(dir, "GOALS.md");
  writeFileSync(p, text);
  return p;
};

const FIVE = `# W

## 1 · Met
**Done when:** the file exists.
**Derived by:** \`true\`

## 2 · Unmet
**Done when:** never.
**Derived by:** \`exit 3\`

## 3 · Untrusted
**Done when:** never.
**Derived by:** \`touch CANARY\`

## 4 · Judgement
**Done when:** Pandit signs off.
**Judgement, not derivable:** a person decides.

## 5 · Parked
**Done when:** later.
**Derived by:** \`true\`
**Parked (cycle 1, 2026-11-13):** not this cycle; returns when G1 closes.
`;

test("an untrusted command is never run, and says how to approve it", () => {
  write(FIVE);
  const r = quiet(() => checkDoneCmd(["--apply"], opts()));
  assert.equal(existsSync(path.join(dir, "CANARY")), false, "check-done ran a command nobody approved");
  assert.match(r.out, /untrusted.*goals allow .*GOALS\.md 3/);
});

test("trusted: exit 0 is met, non-zero is unmet with its exit code", () => {
  const p = write(FIVE);
  quiet(() => allowCmd([p, "1"]));
  quiet(() => allowCmd([p, "2"]));
  const r = quiet(() => checkDoneCmd(["--json"], opts()));
  const res = JSON.parse(r.out).results;
  assert.equal(res.find((x) => x.n === 1).outcome, "met");
  const u = res.find((x) => x.n === 2);
  assert.equal(u.outcome, "unmet");
  assert.match(u.reason, /exited 3/);
});

test("editing an approved command makes it untrusted again", () => {
  const p = write(FIVE);
  quiet(() => allowCmd([p, "1"]));
  writeFileSync(p, FIVE.replace("**Derived by:** `true`", `**Derived by:** \`touch EDITED\``));
  const r = quiet(() => checkDoneCmd(["--json", "--apply"], opts()));
  assert.equal(existsSync(path.join(dir, "EDITED")), false, "a changed command ran under the old approval");
  assert.equal(JSON.parse(r.out).results.find((x) => x.n === 1).outcome, "untrusted");
});

test("a timeout kills the command's children too, not only bash", () => {
  const pidFile = path.join(dir, "child.pid");
  const r = runDerived(`sleep 30 & echo $! > ${pidFile}; wait`, dir, { timeout: 300 });
  assert.match(r.reason, /timed out/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  // A SIGKILLed process is a zombie until reaped, and a zombie still answers kill(pid, 0). So allow it up to 2 s
  // to disappear; a child that truly outlived the timeout (sleep 30) is still there after that.
  const exists = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let alive = exists();
  for (let i = 0; alive && i < 20; i++) {
    spawnSync("sleep", ["0.1"]);
    alive = exists();
  }
  if (alive) process.kill(pid, "SIGKILL");
  assert.equal(alive, false, `the child sleep (pid ${pid}) outlived the timeout`);
});

test("a timeout is unmet and says so", () => {
  const r = runDerived("sleep 5", dir, { timeout: 200 });
  assert.equal(r.met, false);
  assert.match(r.reason, /timed out/);
});

test("judgement and parked goals are never run and never closed", () => {
  const p = write(FIVE);
  quiet(() => allowCmd([p, "5"])); // parked, though its command is approved
  const res = JSON.parse(quiet(() => checkDoneCmd(["--json", "--apply"], opts())).out).results;
  assert.equal(res.find((x) => x.n === 4).outcome, "judgement");
  assert.equal(res.find((x) => x.n === 5).outcome, "parked");
  assert.doesNotMatch(readFileSync(p, "utf8").split("## 4")[1], /Resolved/);
});

test("without --apply the file is byte-identical, whatever the outcomes", () => {
  const p = write(FIVE);
  for (const id of ["1", "2"]) quiet(() => allowCmd([p, id]));
  const before = readFileSync(p);
  quiet(() => checkDoneCmd([], opts()));
  quiet(() => checkDoneCmd(["--json"], opts()));
  assert.ok(readFileSync(p).equals(before), "a dry run wrote to GOALS.md");
});

test("--apply adds exactly one Resolved line, directly under the met goal's heading, never a fenced one", () => {
  const p = write(`# W

\`\`\`md
## 1 · an example heading inside a fence: never written under
\`\`\`

## 1 · Met
**Done when:** it runs.
**Derived by:** \`true\`

## 2 · Next
**Done when:** never.
`);
  quiet(() => allowCmd([p, "1"]));
  const before = readFileSync(p, "utf8");
  quiet(() => checkDoneCmd(["--apply"], opts()));
  const after = readFileSync(p, "utf8");
  const added = after.split("\n").filter((l) => !before.split("\n").includes(l) && l.trim());
  assert.deepEqual(added, ["**Resolved:** 2026-11-13 · derived: `true` exited 0 (propagate goals check-done)"]);
  assert.match(after, /## 1 · Met\n\*\*Resolved:\*\*/, "directly under the real heading, not the fenced one");
  assert.equal(parseGoalsFile(p).entries[0].status, "closed", "the written line closes the goal for the reader");
  // A second run finds it closed and writes nothing.
  const again = readFileSync(p);
  quiet(() => checkDoneCmd(["--apply"], opts()));
  assert.ok(readFileSync(p).equals(again));
});

test("writeResolved returns null for a section that does not exist", () => {
  assert.equal(writeResolved("# W\n\n## 1 · A\n", 3, "x"), null);
});

test("allow refuses a goal with no command, and an id that does not exist", () => {
  const p = write(FIVE);
  assert.equal(quiet(() => allowCmd([p, "4"])).code, 2);
  assert.equal(quiet(() => allowCmd([p, "99"])).code, 2);
  assert.equal(readTrust().entries.length, 0, "nothing approved");
  assert.equal(quiet(() => allowCmd([p, "1"])).code, 0);
  assert.equal(readTrust().entries[0].sha256, commandHash("true"));
});

test("parked is its own status, never counted as open; Resolved wins over Parked", () => {
  const p = write(FIVE + `
## 6 · Parked then met
**Parked (cycle 1, 2026-11-13):** later.
**Resolved:** 2026-11-14 · done.

## 7 · Parked only in an example
**Done when:** never.
\`\`\`md
**Parked (cycle 1, 2026-11-13):** an example.
\`\`\`

## 8 · Parked mentioned far down, in discussion
**Done when:** never.
**Derived by:** \`true\`
Some prose.
More prose.
**Parked (cycle 1, 2026-11-13):** this line is outside the marker window.
`);
  const f = parseGoalsFile(p);
  assert.equal(f.entries.find((e) => e.n === 5).status, "parked");
  assert.equal(f.entries.find((e) => e.n === 6).status, "closed");
  assert.equal(f.entries.find((e) => e.n === 7).status, "open", "a Parked line inside a fence parks nothing");
  assert.equal(f.entries.find((e) => e.n === 8).status, "open", "a Parked line past the marker window parks nothing, like Resolved");
  const c = goalCounts([f]);
  assert.equal(c.parked, 1);
  assert.equal(c.open + c.closed + c.parked + c.unknown, c.total);
});
