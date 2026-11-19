// session-guide x day close catch-up (propagate#339). The real hook runs as a subprocess against a temp state dir.
// The detached child is a STUB script (PROPAGATE_DAY_CLOSE_CMD) that records its start, so no test can reach a real
// board, and PROPAGATE_GH_BIN is a recording stub so "the hook makes zero GitHub calls" is asserted, not claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { lastClosePath, lockPath, ymd, RETRY_COOLDOWN_MS } from "../../lib/report/day-close-auto.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "session-guide.mjs");
const TODAY = ymd(Date.now());
const EARLIER = ymd(Date.now() - 25 * 3600e3);
const base = { mode: "apply", promoted: 2, closedToDone: 3, inProgress: 1, exit: 0, status: "ok" };

function fixture(stubSeconds = 3) {
  const root = mkdtempSync(path.join(tmpdir(), "sgdc-"));
  const state = path.join(root, "state");
  mkdirSync(path.join(state, "day"), { recursive: true });
  const calls = path.join(root, "close-calls.log");
  const stub = path.join(root, "close-stub.mjs");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(calls)}, process.pid + " " + process.argv.slice(2).join(" ") + "\\n");\nsetTimeout(() => {}, ${stubSeconds * 1000});\n`);
  const ghLog = path.join(root, "gh-calls.log");
  const gh = path.join(root, "gh-stub.sh");
  writeFileSync(gh, `#!/bin/sh\necho "$@" >> "${ghLog}"\necho '{}'\n`);
  chmodSync(gh, 0o755);
  const put = (rec) => writeFileSync(lastClosePath(state), JSON.stringify(rec));
  const started = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
  const env = (extra = {}) => ({ ...process.env, PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: "", PROPAGATE_DAY_CLOSE_CMD: stub, PROPAGATE_GH_BIN: gh, ...extra });
  return { root, state, calls, ghLog, put, started, env };
}
const payload = JSON.stringify({ session_id: "s1", cwd: tmpdir(), source: "startup" });
const runHook = (f, extra = {}) => spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", env: f.env(extra) });
const ctx = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
const settle = async (f, n = 1, ms = 3000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms && f.started().length < n; ) await new Promise((r) => setTimeout(r, 25));
};
const reap = (f) => {
  try {
    const held = JSON.parse(readFileSync(lockPath(f.state), "utf8"));
    process.kill(held.pid, "SIGKILL");
  } catch {
    // nothing running
  }
};

test("last-close dated before today: the hook starts exactly one detached run, with --apply", async () => {
  const f = fixture();
  f.put({ ...base, date: EARLIER, caughtUpDate: EARLIER });
  const r = runHook(f);
  assert.equal(r.status, 0);
  await settle(f);
  const calls = f.started();
  assert.equal(calls.length, 1, calls.join("\n"));
  assert.match(calls[0], /day close --apply$/);
  assert.match(ctx(r), /^day close: catch-up started in the background/m);
  reap(f);
});

test("last-close dated today: no run, and the guide line carries the counts", () => {
  const f = fixture();
  f.put({ ...base, date: TODAY, caughtUpDate: TODAY, finishedAt: new Date().toISOString() });
  const r = runHook(f);
  assert.equal(f.started().length, 0);
  assert.ok(ctx(r).includes(`day close ${TODAY}: 2 promoted, 3 closed → Done, 1 In progress to look at (close-${TODAY}.txt)`), ctx(r));
});

test("two concurrent SessionStarts start ONE run (the lock)", async () => {
  const f = fixture(4);
  f.put({ ...base, date: EARLIER, caughtUpDate: EARLIER });
  const one = () => new Promise((res) => {
    const c = spawn(process.execPath, [HOOK], { env: f.env(), stdio: ["pipe", "pipe", "ignore"] });
    c.stdin.end(payload);
    c.on("close", res);
    c.stdout.resume();
  });
  await Promise.all([one(), one(), one()]);
  await settle(f);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.started().length, 1, `three sessions, expected one run:\n${f.started().join("\n")}`);
  reap(f);
});

test("the hook returns within its budget with the run still going", async () => {
  const f = fixture(8);
  f.put({ ...base, date: EARLIER, caughtUpDate: EARLIER });
  const t0 = process.hrtime.bigint();
  const r = runHook(f);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# hook wall time with a run starting: ${ms.toFixed(0)} ms`);
  assert.equal(r.status, 0);
  assert.ok(ms < 1500, `hook took ${ms} ms`);
  await settle(f);
  const held = JSON.parse(readFileSync(lockPath(f.state), "utf8"));
  assert.doesNotThrow(() => process.kill(held.pid, 0), "the run is still going after the hook returned");
  reap(f);
});

test("off switch: PROPAGATE_DAY_CLOSE_AUTO=0 and the config key start nothing and say so", async () => {
  const f = fixture();
  f.put({ ...base, date: EARLIER, caughtUpDate: EARLIER });
  const a = runHook(f, { PROPAGATE_DAY_CLOSE_AUTO: "0" });
  writeFileSync(path.join(f.state, "config.yml"), "dayCloseAuto: false\n");
  const b = runHook(f);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.started().length, 0);
  assert.match(ctx(a), /day close: auto catch-up is off \(PROPAGATE_DAY_CLOSE_AUTO=0\)/);
  assert.match(ctx(b), /day close: auto catch-up is off \(config\.yml dayCloseAuto is off\)/);
});

test("every outcome is on the next session's line: failed, rate-limited, 5xx, timeout, partial", () => {
  const f = fixture();
  const cases = [
    [{ exit: 2, status: "failed", reason: "board listing failed: nope" }, /failed \(exit 2\): board listing failed: nope/],
    [{ exit: 2, status: "rate-limited", failureLabel: "rate-limited" }, /rate-limited, will retry next session/],
    [{ exit: 2, status: "unavailable", failureLabel: "github unavailable (HTTP 504)" }, /github unavailable \(HTTP 504\), will retry next session/],
    [{ exit: 2, status: "unavailable", failureLabel: "github unavailable (ETIMEDOUT)" }, /github unavailable \(ETIMEDOUT\), will retry next session/],
    [{ exit: 2, status: "partial", partial: { written: 100, total: 131 }, failureLabel: "github unavailable (ETIMEDOUT)" }, /partial: 100 of 131 written/],
  ];
  for (const [over, re] of cases) {
    // finished just now, so the cooldown keeps the hook from starting a retry while we read the line
    f.put({ ...base, date: TODAY, finishedAt: new Date().toISOString(), ...over });
    assert.match(ctx(runHook(f)), re);
  }
  assert.equal(f.started().length, 0);
});

test("a corrupt last-close.json is reported and the catch-up still starts", async () => {
  const f = fixture();
  writeFileSync(lastClosePath(f.state), "{nope");
  const r = runHook(f);
  assert.equal(r.status, 0);
  await settle(f);
  assert.equal(f.started().length, 1);
  assert.match(ctx(r), /catch-up started/);
  reap(f);
});

test("under the test runner with no stub the hook refuses to start a real run, and says so", () => {
  const f = fixture();
  f.put({ ...base, date: EARLIER });
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", env: { ...f.env(), PROPAGATE_DAY_CLOSE_CMD: "", NODE_TEST_CONTEXT: "child-v8" } });
  assert.match(ctx(r), /catch-up not started \(refused: running under the test runner/);
});

test("SAFETY: the hook path makes zero GitHub calls and writes nothing but its lock", async () => {
  const f = fixture();
  f.put({ ...base, date: EARLIER, caughtUpDate: EARLIER });
  const before = readdirSync(path.join(f.state, "day")).sort();
  const r = runHook(f);
  assert.equal(r.status, 0);
  assert.equal(existsSync(f.ghLog), false, "the hook (or the stub it started) invoked gh");
  await settle(f);
  const after = readdirSync(path.join(f.state, "day")).sort();
  assert.deepEqual(after.filter((x) => !before.includes(x)), ["close.lock"], "only the lock is new");
  reap(f);
  // the source half: the hook's import graph carries no GitHub module
  const src = readFileSync(HOOK, "utf8") + readFileSync(path.join(path.dirname(HOOK), "..", "lib", "report", "day-close-auto.mjs"), "utf8");
  assert.doesNotMatch(src, /ghFetcher|sprint\.mjs|report\/day\.mjs|"gh"|fetcher\.write/);
});

test("cooldown constant is sane (a retry never fires within a minute of the last attempt)", () => {
  assert.ok(RETRY_COOLDOWN_MS >= 60000);
});
