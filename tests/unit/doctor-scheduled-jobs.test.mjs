/**
 * doctor-scheduled-jobs.test.mjs — workspace-hub#75, lib/report/doctor/scheduled-jobs.mjs.
 *
 * Fixtures are XML plist literals in a temp HOME, converted by the real `plutil` (darwin only;
 * skipped with a stated reason elsewhere). `launchctl` is stubbed through the injected runner,
 * so nothing here touches launchd. Log ages are set with utimes, never by waiting.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/doctor-scheduled-jobs.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Reporter } from "../../lib/report/doctor/reporter.mjs";
import { checkScheduledJobs, defaultRunner, parseLaunchctlPrint, SEVERITY } from "../../lib/report/doctor/scheduled-jobs.mjs";

const darwin = process.platform === "darwin";
const skip = darwin ? false : "plutil is macOS only";
const HOUR = 3600000;
const NOW = Date.now();

function plistXml({ label, args, schedule, out, err }) {
  const strs = (a) => a.map((s) => `<string>${s}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strs(args)}</array>
${schedule ?? ""}
${out ? `<key>StandardOutPath</key><string>${out}</string>` : ""}
${err ? `<key>StandardErrorPath</key><string>${err}</string>` : ""}
</dict></plist>`;
}
const DAILY = "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>";
const every = (s) => `<key>StartInterval</key><integer>${s}</integer>`;

const LCTL_OK = "gui/501/x = {\n\tstate = not running\n\truns = 7\n\tlast exit code = 0\n}\n";

/** A temp HOME with a root dir; jobs: [{label, runsUnderRoot, schedule, logAgeH, log:false}] */
function fixture(jobs, { launchctl = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "sched-"));
  const root = path.join(home, "tree");
  mkdirSync(root, { recursive: true });
  const dir = path.join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  for (const j of jobs) {
    const log = path.join(home, `${j.label}.log`);
    if (j.logAgeH !== undefined) {
      writeFileSync(log, "x\n");
      const t = new Date(NOW - j.logAgeH * HOUR);
      utimesSync(log, t, t);
    }
    const script = j.runsUnderRoot === false ? "/usr/bin/true" : path.join(root, "job.mjs");
    writeFileSync(
      path.join(dir, `${j.label}.plist`),
      plistXml({ label: j.label, args: ["/usr/bin/env", script], schedule: j.schedule, out: j.noLogPath ? null : log }),
    );
  }
  const calls = [];
  const runner = (cmd, args) => {
    if (cmd === "plutil") return defaultRunner(cmd, args);
    calls.push([cmd, ...args]);
    const label = args[1].split("/").pop();
    if (label in launchctl) return launchctl[label] === null ? { status: 113, stdout: "" } : { status: 0, stdout: launchctl[label] };
    return { status: 0, stdout: LCTL_OK };
  };
  return { home, root, runner, calls };
}

function run(fx, extra = {}) {
  const reporter = new Reporter();
  const res = checkScheduledJobs({ reporter, roots: [fx.root], home: fx.home, platform: "darwin", now: NOW, uid: 501, runner: fx.runner, ...extra });
  return { reporter, res, warns: reporter.entries.filter((e) => e.kind === "warn"), info: reporter.entries.filter((e) => e.kind === "info") };
}

test("severity is S3 and nothing here can vote", { skip }, () => {
  assert.equal(SEVERITY, "S3");
  const fx = fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 500 }], { launchctl: { "t.daily": "runs = x\nlast exit code = 78\nlast exit reason = OS_REASON_CODESIGNING\n" } });
  const { reporter } = run(fx);
  assert.equal(reporter.problems, 0);
});

test("a fresh daily job is fine", { skip }, () => {
  const { warns, res } = run(fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 3 }]));
  assert.deepEqual(warns, []);
  assert.equal(res.jobs, 1);
});

test("a daily job 27 h old warns, 25 h does not", { skip }, () => {
  const old = run(fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 27 }]));
  assert.equal(old.warns.length, 1);
  assert.match(old.warns[0].detail, /over 26 h/);
  const ok = run(fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 25 }]));
  assert.deepEqual(ok.warns, []);
});

test("a non-zero exit warns and names the exit reason", { skip }, () => {
  const lc = "state = not running\nruns = 3\nlast exit code = 9\nlast exit reason = OS_REASON_CODESIGNING\n";
  const { warns } = run(fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 1 }], { launchctl: { "t.daily": lc } }));
  assert.equal(warns.length, 1);
  assert.match(warns[0].detail, /last exit code 9/);
  assert.match(warns[0].detail, /OS_REASON_CODESIGNING/);
});

test("a plist that runs nothing under the roots is excluded", { skip }, () => {
  const fx = fixture([
    { label: "t.other", schedule: DAILY, logAgeH: 900, runsUnderRoot: false },
    { label: "t.mine", schedule: DAILY, logAgeH: 1 },
  ]);
  const { warns, res } = run(fx);
  const calls = fx.calls;
  assert.equal(res.jobs, 1);
  assert.deepEqual(warns, []);
  assert.deepEqual(calls.map((c) => c[2].split("/").pop()), ["t.mine"], "launchctl is never asked about an excluded job");
});

test("no log path gives 'not derivable', never fresh", { skip }, () => {
  const { reporter, warns, res } = run(fixture([{ label: "t.nolog", schedule: DAILY, noLogPath: true }]));
  assert.deepEqual(warns, []);
  assert.equal(res.notDerivable, 1);
  assert.match(JSON.stringify(reporter.entries), /not derivable \(no log path in the plist\)/);
});

test("zero plists states the floor; a missing LaunchAgents dir is stated", { skip }, () => {
  const fx = fixture([]);
  const { warns } = run(fx);
  assert.equal(warns.length, 1);
  assert.match(warns[0].label, /no scheduled jobs found/);
  const bare = mkdtempSync(path.join(tmpdir(), "sched-bare-"));
  const r = run({ home: bare, root: bare, runner: fx.runner });
  assert.match(r.warns[0].detail, /does not exist/);
});

test("not macOS prints one skipped line", () => {
  const reporter = new Reporter();
  checkScheduledJobs({ reporter, roots: ["/x"], platform: "linux" });
  const body = reporter.entries.filter((e) => e.kind !== "header");
  assert.equal(body.length, 1);
  assert.match(body[0].detail, /skipped: not macOS/);
});

test("an interval job uses max(3 x interval, 2 h), not the 26 h daily limit", { skip }, () => {
  const sched = every(1800); // 3 x 30 min = 1.5 h, so the 2 h floor applies
  const stale = run(fixture([{ label: "t.int", schedule: sched, logAgeH: 3 }]));
  assert.equal(stale.warns.length, 1);
  assert.match(stale.warns[0].detail, /interval job last ran 3\.0 h ago, over 2\.0 h/);
  const fine = run(fixture([{ label: "t.int", schedule: sched, logAgeH: 1.5 }]));
  assert.deepEqual(fine.warns, []);
  const hourly = run(fixture([{ label: "t.int", schedule: every(3 * 3600), logAgeH: 8 }])); // limit 9 h
  assert.deepEqual(hourly.warns, []);
});

test("an unparseable launchctl reply is stated, and a failed print on a scheduled job warns", { skip }, () => {
  const junk = run(fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 1 }], { launchctl: { "t.daily": "<<not the format you expect>>" } }));
  assert.deepEqual(junk.warns, []);
  assert.match(JSON.stringify(junk.reporter.entries), /launchctl reply not parseable/);
  const gone = run(fixture([{ label: "t.daily", schedule: DAILY, logAgeH: 1 }], { launchctl: { "t.daily": null } }));
  assert.equal(gone.warns.length, 1);
  assert.match(gone.warns[0].detail, /not loaded/);
});

test("parseLaunchctlPrint reads the fields it uses and nulls the rest", () => {
  assert.deepEqual(parseLaunchctlPrint("\tstate = running\n\truns = 4\n\tlast exit code = (never exited)\n"), {
    state: "running",
    runs: 4,
    exitCode: null,
    exitCodeRaw: "(never exited)",
    exitReason: null,
  });
  assert.equal(parseLaunchctlPrint("garbage").state, null);
});
