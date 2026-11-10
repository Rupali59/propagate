/**
 * scheduled-jobs.mjs — doctor's `# Scheduled jobs` section (workspace-hub#75, option A).
 *
 * THE QUESTION. Did each launchd job that runs this tree's code run recently? `man launchd.plist`
 * (lines 348-366): a StartCalendarInterval job that comes due while the Mac sleeps runs on the
 * next wake, and missed firings coalesce into one; StartInterval firings during sleep are
 * skipped. So a daily job older than 26 h is a real signal (Mac off, job broken, job unloaded),
 * and a skipped interval is not.
 *
 * POPULATION, derived (rule:derive-dont-curate): every ~/Library/LaunchAgents/*.plist whose
 * ProgramArguments or Program names a path under one of the search roots. No job label is
 * written here; this repo is public. Plists are read with `plutil -convert json` (GOTCHAS G-O).
 *
 * FLOOR. On macOS with zero such plists, or a missing LaunchAgents directory, the section says
 * so. It never reads as a pass. Off macOS the section is one "skipped" line.
 *
 * LAST RUN is the newest mtime of the declared StandardOutPath / StandardErrorPath (or a .log
 * argument in the command line). A job with neither says "not derivable", never "fresh".
 * `launchctl print` supplies state / runs / last exit; its format is not a contract, so it is
 * parsed leniently and an unparseable reply is stated.
 *
 * SEVERITY S3, warn-only. Never votes on the exit code: a laptop that was off overnight must
 * not turn doctor red (#129).
 */
export const SEVERITY = "S3";

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DAILY_MAX_HOURS = 26;

const HOUR = 3600000;

/** Default runner: only ever `launchctl print` and `plutil -convert`. Read-only. */
export function defaultRunner(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    return { status: 0, stdout };
  } catch (err) {
    return { status: typeof err.status === "number" ? err.status : 1, stdout: err.stdout?.toString() ?? "", error: err.message.split("\n")[0] };
  }
}

function underRoots(p, roots) {
  if (typeof p !== "string") return false;
  const n = path.normalize(p);
  return roots.some((r) => {
    const root = path.normalize(r).replace(/\/+$/, "");
    return n === root || n.startsWith(root + path.sep);
  });
}

/** Classify the schedule: "daily" | "calendar-other" | "interval" | "none". */
export function classifySchedule(job) {
  const cal = job.StartCalendarInterval;
  if (cal !== undefined && cal !== null) {
    const dicts = Array.isArray(cal) ? cal : [cal];
    const narrower = dicts.some((d) => d && ("Weekday" in d || "Day" in d || "Month" in d));
    return narrower ? "calendar-other" : "daily";
  }
  if (typeof job.StartInterval === "number") return "interval";
  return "none";
}

/** Parse the fields we use out of `launchctl print`; any may be null. Lenient on purpose. */
export function parseLaunchctlPrint(text) {
  const grab = (re) => {
    const m = re.exec(text ?? "");
    return m ? m[1].trim() : null;
  };
  const state = grab(/^\s*state = (.+)$/m);
  const runsRaw = grab(/^\s*runs = (\d+)\s*$/m);
  const codeRaw = grab(/^\s*last exit code = (.+)$/m);
  const reason = grab(/^\s*last exit reason = (.+)$/m);
  const codeNum = codeRaw !== null && /^-?\d+/.test(codeRaw) ? Number(/^-?\d+/.exec(codeRaw)[0]) : null;
  return { state, runs: runsRaw === null ? null : Number(runsRaw), exitCode: codeNum, exitCodeRaw: codeRaw, exitReason: reason };
}

function logPaths(job) {
  const declared = [job.StandardOutPath, job.StandardErrorPath].filter((p) => typeof p === "string" && p);
  if (declared.length) return declared;
  const args = Array.isArray(job.ProgramArguments) ? job.ProgramArguments : [];
  return args.filter((a) => typeof a === "string" && a.startsWith("/") && a.endsWith(".log"));
}

function newestMtime(files) {
  let best = null;
  for (const f of files) {
    try {
      const t = statSync(f).mtimeMs;
      if (best === null || t > best) best = t;
    } catch {
      /* absent: the caller states "declared log file absent on disk" */
    }
  }
  return best;
}

const fmtH = (ms) => `${(ms / HOUR).toFixed(1)} h`;

/**
 * @param {object} opts
 * @param {{header: Function, warn: Function, info: Function}} opts.reporter
 * @param {string[]} opts.roots propagate's SEARCH_ROOTS
 * @param {string} [opts.home] default os.homedir()
 * @param {string} [opts.platform] default process.platform
 * @param {number} [opts.now] ms epoch
 * @param {number} [opts.uid] default process.getuid()
 * @param {(cmd: string, args: string[]) => {status: number, stdout: string}} [opts.runner]
 */
export function checkScheduledJobs({
  reporter,
  roots,
  home = os.homedir(),
  platform = process.platform,
  now = Date.now(),
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  runner = defaultRunner,
}) {
  reporter.header("# Scheduled jobs");
  if (platform !== "darwin") {
    reporter.info("scheduled jobs", "skipped: not macOS");
    return { skipped: true, jobs: 0, warned: 0 };
  }
  const dir = path.join(home, "Library", "LaunchAgents");
  if (!existsSync(dir)) {
    reporter.warn("no scheduled jobs found", `${dir} does not exist, so this section has looked at nothing; that is not a clean result`);
    return { jobs: 0, warned: 0 };
  }
  const plists = readdirSync(dir).filter((f) => f.endsWith(".plist")).sort();
  const jobs = [];
  const unreadable = [];
  for (const f of plists) {
    const file = path.join(dir, f);
    const r = runner("plutil", ["-convert", "json", "-o", "-", file]);
    let job;
    try {
      if (r.status !== 0) throw new Error("plutil exit " + r.status);
      job = JSON.parse(r.stdout);
    } catch {
      unreadable.push(f);
      continue;
    }
    const cmd = [...(Array.isArray(job.ProgramArguments) ? job.ProgramArguments : []), job.Program];
    if (!cmd.some((c) => underRoots(c, roots))) continue;
    jobs.push({ file, job });
  }
  for (const f of unreadable) reporter.warn("plist unreadable", `${f}: plutil could not convert it, so it was not graded`);
  if (jobs.length === 0) {
    reporter.warn(
      "no scheduled jobs found",
      `${plists.length} plist(s) in ${dir}, none runs code under the search roots; a section that matched nothing has not shown the jobs are fine`,
    );
    return { jobs: 0, warned: 0 };
  }

  let warned = 0;
  let notDerivable = 0;
  let services = 0;
  for (const { file, job } of jobs) {
    const label = job.Label ?? path.basename(file, ".plist");
    const kind = classifySchedule(job);
    const problems = [];
    const facts = [];

    const lc = runner("launchctl", ["print", `gui/${uid}/${label}`]);
    if (lc.status !== 0) {
      facts.push("launchctl: job not loaded or print failed");
      if (kind !== "none") problems.push("not loaded in launchd (launchctl print failed)");
    } else {
      const p = parseLaunchctlPrint(lc.stdout);
      if (p.state === null && p.runs === null && p.exitCodeRaw === null) {
        facts.push("launchctl reply not parseable");
      } else {
        facts.push(`state ${p.state ?? "?"}, runs ${p.runs ?? "?"}, last exit ${p.exitCodeRaw ?? "?"}`);
        if (p.exitCode !== null && p.exitCode !== 0) problems.push(`last exit code ${p.exitCodeRaw}`);
        if (p.exitReason) problems.push(`last exit reason ${p.exitReason}`);
      }
    }

    if (kind === "none") {
      services++;
      facts.push("no schedule (service), age not graded");
    } else if (kind === "calendar-other") {
      facts.push("calendar schedule narrower than daily, age not graded");
    } else {
      const logs = logPaths(job);
      const m = logs.length ? newestMtime(logs) : null;
      if (!logs.length) {
        notDerivable++;
        facts.push("last run: not derivable (no log path in the plist)");
      } else if (m === null) {
        notDerivable++;
        facts.push("last run: not derivable (declared log file absent on disk)");
      } else {
        const age = now - m;
        facts.push(`last run (log mtime) ${fmtH(age)} ago`);
        if (kind === "daily" && age > DAILY_MAX_HOURS * HOUR) problems.push(`daily job last ran ${fmtH(age)} ago, over ${DAILY_MAX_HOURS} h`);
        // Interval jobs: no age verdict. Their firings are skipped during sleep anyway, and a stdout/stderr
        // log only moves when the job PRINTS: the usage sampler writes samples.jsonl and keeps its log quiet, so
        // the first real run (2026-11-10) read it as 547 h stale while it ran every 15 min. A bad exit still warns
        // (above); the age is shown as a fact, not judged.
      }
    }

    if (problems.length) {
      warned++;
      reporter.warn("scheduled job needs attention", `${label}: ${problems.join("; ")} (${facts.join("; ")})`);
    } else {
      reporter.note(`${label}: ${facts.join("; ")}`);
    }
  }
  reporter.info(
    "scheduled jobs",
    `${jobs.length} job(s) run this tree's code, ${warned} warned, ${notDerivable} with last run not derivable, ${services} unscheduled service(s); ` +
      `daily limit ${DAILY_MAX_HOURS} h (man launchd.plist: calendar jobs run on wake, interval firings during sleep are skipped)`,
  );
  return { jobs: jobs.length, warned, notDerivable };
}
