/**
 * environment.mjs — doctor's first three sections: the retired launchd watcher,
 * the v2 replacement (event store + reconcile), and State.
 *
 * IT OWNS ITS OWN HEADERS. The three earlier modules each covered one printed
 * section, so their caller printed the header and the module returned what went
 * under it. This one covers three consecutive sections, so the headers are
 * emitted as `header` entries to keep them ordered with the checks between them.
 * `leadingBlank: false` on the first is not cosmetic — doctor's first section
 * has no blank line above it and every later one does.
 *
 * IT RETURNS `reconcileRows`, AND THAT IS THE POINT (D8). reconcile() runs
 * exactly once per doctor run, here, and the rows travel back to the
 * orchestrator for `# Metrics` to derive graph metrics from. The comment beside
 * the call has said why since before this split: running it twice would double
 * doctor's slowest operation AND could report two different trees if a file
 * moved between the calls. A module that *can* call reconcile eventually will,
 * so it does not get the chance — it is called here and passed on.
 *
 * Every dynamic import is `../../`, not `./lib/` — G60.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

import { WORKSPACES, STATE_PATH, HEARTBEAT_PATH, SCHEDULER, LAUNCHD_ACTIVE } from "../../core/config.mjs";
import { LABEL as LAUNCHD_LABEL } from "../../core/plist.mjs";
import { readEvents } from "../../edges/events.mjs";
import { reconcile } from "../../edges/reconcile.mjs";

const HOME_DIR = homedir();

/**
 * @param {{reporter: import("./reporter.mjs").Reporter}} deps
 * @returns {Promise<{counts: {stateTrackedFiles: number}, details: {reconcileRows: Array|null}}>}
 */
export async function checkEnvironment({ reporter }) {
  const counts = { stateTrackedFiles: 0 };

reporter.header("# launchd watcher — RETIRED 2026-08-14", false);
reporter.note(`resolved label: ${LAUNCHD_LABEL}`);
reporter.note(`see docs/DECISIONS.md 2026-08-14 for why; these are informational, never a failure`);
if (!LAUNCHD_ACTIVE) {
  reporter.info(
    "scheduler",
    `${SCHEDULER} — launchd not consulted. ` +
      (SCHEDULER === "none"
        ? "Nothing is scheduled; `reconcile` derives drift on demand in ~1.2s, so this is a supported configuration, not a gap."
        : `${SCHEDULER} is declarable but not implemented — scheduled runs will not happen.`),
  );
} else {
  try {
    const out = execSync("launchctl list", { encoding: "utf8" });
    const loaded = out.split("\n").some((l) => l.includes(LAUNCHD_LABEL));
    reporter.info("plist loaded", loaded ? "yes — unloading is a separate, later step; loaded is not a failure here" : "no — unloaded (expected once retirement is complete)");
  } catch (err) {
    reporter.info("launchctl unreachable", err.message);
  }
}

if (existsSync(HEARTBEAT_PATH)) {
  const raw = (await readFile(HEARTBEAT_PATH, "utf8")).trim();
  const ts = parseInt(raw, 10);
  const ageMs = Date.now() - ts;
  const ageMin = Math.round(ageMs / 60_000);
  const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));
  const ageLabel = ageDays > 1 ? `${ageDays} days old` : `${ageMin} min old`;
  reporter.info("heartbeat age", `${ageLabel} — a retired component's heartbeat is expected to go stale; not a health signal`);
} else {
  reporter.info("heartbeat file", "does not exist — expected once the watcher has stopped running");
}

// Replacement health: does the v2 event store (lib/events.mjs) actually
// hold the verification history `reconcile` derives drift from, and does
// `reconcile` itself complete? These are the checks that matter now — see
// the retirement note above for why the launchd checks above no longer are.
reporter.header("# v2 replacement (event store + reconcile)");
try {
  const { events, malformed } = await readEvents();
  reporter.check("event store readable", true, `${events.length} event(s), ${malformed} malformed`);
  reporter.check(
    "event store non-empty",
    events.length > 0,
    events.length === 0 ? "no verification events recorded yet — run `bootstrap --apply`" : "",
  );
  if (malformed > 0) {
    reporter.check("event store lines all parseable", false, `${malformed} malformed line(s)`);
  }
} catch (err) {
  reporter.check("event store readable", false, err.message);
}
// The rows are kept, not discarded: the graph metrics below derive from this
// same pass. Running reconcile twice in one doctor would double its cost and
// could report two different trees if a file moved between the calls.
let reconcileRows = null;
try {
  const reconcileStart = Date.now();
  ({ rows: reconcileRows } = await reconcile(WORKSPACES));
  reporter.check("reconcile completes", true, `${Date.now() - reconcileStart}ms`);
} catch (err) {
  reporter.check("reconcile completes", false, err.message);
}

// ── monitor liveness ──────────────────────────────────────────────────────
// Three states, not two. "Never ran" and "ran and found nothing" are different
// facts and must not share an output (rule:discernment-checks §2) — that
// conflation is how a zombie LaunchAgent wrote 37 MB of stderr for six weeks
// before anyone noticed it was still loaded.
//
// Deliberately INFORMATIONAL, never a failure: the monitor is generated but
// not armed by default, so "not installed" is the expected state and must not
// read as broken. It becomes worth escalating only once someone loads it.
try {
  const { MONITOR_LOG } = await import("../../report/monitor.mjs");
  const { MONITOR_PLIST_PATH } = await import("../../core/plist.mjs");
  if (!existsSync(MONITOR_LOG)) {
    reporter.info("monitor", "never run — no ~/.propagate/monitor.log (expected until `monitor --install` is armed)");
  } else {
    const runs = (await readFile(MONITOR_LOG, "utf8")).split("\n").filter(Boolean);
    const last = runs[runs.length - 1] || "";
    const notified = runs.filter((l) => /notified=[1-9]/.test(l)).length;
    const errored = runs.filter((l) => / error=/.test(l)).length;
    reporter.info(
      "monitor",
      `${runs.length} run(s), ${notified} that notified, ${errored} that could not look — last: ${last.slice(0, 80)}`,
    );

    // ── FRESHNESS, which the line above cannot express ──────────────────
    //
    // Printing the last run's timestamp is not a liveness probe: three
    // hours stale and two minutes fresh render identically, and on
    // 2026-08-22 this section reported "all green" while the agent had
    // been failing every 1800s for hours (docs/ISSUES.md N43). Both this
    // file and docs/SYSTEMS.md already described that failure in prose —
    // "a monitor that has silently died is indistinguishable from a quiet
    // week without that log" — which is exactly the fluency
    // rule:enforcement-watches-itself warns makes a hazard feel handled.
    //
    // Gated on the PLIST, not on the log, and that gate is what makes a
    // reporter.check() safe here: the monitor is generated but not armed by
    // default, so an unarmed one must stay informational forever. Only an
    // ARMED monitor that ran and then went quiet is a failure.
    const armed = existsSync(MONITOR_PLIST_PATH);
    if (armed) {
      // 3x the 1800s StartInterval. Generous on purpose: a laptop asleep
      // through one or two intervals is normal, six hours of silence is
      // not.
      const STALE_AFTER_MS = 3 * 1800 * 1000;
      const stamp = Date.parse((last.match(/^\S+/) || [""])[0]);
      const ageMs = Number.isNaN(stamp) ? null : Date.now() - stamp;

      // monitor.log records only SUCCESSFUL runs. A crash goes to
      // monitor.stderr.log, which nothing read — so a newer stderr is the
      // ONLY on-disk tell that the agent is loaded and failing rather
      // than merely idle. One mtime comparison; it would have surfaced
      // N43 in seconds.
      const stderrPath = MONITOR_LOG.replace(/monitor\.log$/, "monitor.stderr.log");
      let crashing = false;
      try {
        crashing =
          existsSync(stderrPath) &&
          statSync(stderrPath).mtimeMs > statSync(MONITOR_LOG).mtimeMs;
      } catch {
        /* an unreadable stderr is not itself a monitor failure */
      }

      if (ageMs === null) {
        reporter.check("monitor is running on schedule", false, `last log line carries no parseable timestamp: ${last.slice(0, 60)}`);
      } else if (ageMs > STALE_AFTER_MS || crashing) {
        const mins = Math.round(ageMs / 60000);
        reporter.check(
          "monitor is running on schedule",
          false,
          `armed but last successful run was ${mins} min ago (expected every 30 min)` +
            (crashing ? `; monitor.stderr.log is NEWER than monitor.log — it is loaded and CRASHING` : "") +
            `. Disarm with \`launchctl bootout gui/$(id -u)/${"com.tathya.propagate.monitor"}\` if this is deliberate.`,
        );
      } else {
        reporter.check("monitor is running on schedule", true, `last run ${Math.round(ageMs / 60000)} min ago`);
      }
    }
  }
} catch (err) {
  // info, not check: adding a reporter.check() label means adding a failing-case test
  // for it (tests/doctor-check-coverage.test.mjs), and a log that cannot be
  // read is not a doctor failure — the monitor is generated, not armed, so
  // "no log" is the expected state. Still named, never swallowed.
  reporter.info("monitor", `liveness log unreadable: ${err.message}`);
}

reporter.header("# State");
// INFO, NOT A CHECK — the v1 watcher was retired 2026-08-14 and watcher.mjs is the
// ONLY thing that ever wrote state.json. So on any machine installed after that date
// the file will never exist, and a `reporter.check()` here fails every fresh install forever
// for the absence of a dead component's artifact.
//
// It reads green on the author's machine only because a FOSSIL is still on disk,
// dated the day of the retirement. Green-by-leftover and red everywhere else is a
// check measuring the wrong thing, and it contradicted this command's own
// documented posture: doctor reports the REPLACEMENT's health (event store +
// reconcile), not the retired watcher's.
//
// Reported, never swallowed — absence must stay attributable
// (rule:discernment-checks §2). Same treatment the monitor log already gets above.
// Found by the Phase 6 baseline; tests/doctor-check-coverage.test.mjs had recorded
// the suspicion on 2026-08-14 and asked for exactly this verification first.
if (existsSync(STATE_PATH)) {
  reporter.info("state.json", `present (${STATE_PATH.replace(HOME_DIR, "~")}) — v1 watcher fossil, read by nothing live`);
} else {
  reporter.info("state.json", "absent — expected: the v1 watcher that wrote it was retired 2026-08-14");
}
if (existsSync(STATE_PATH)) {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    counts.stateTrackedFiles = Object.keys(parsed.mtimes || {}).length;
    reporter.check("state.json parseable", true, `${counts.stateTrackedFiles} tracked files`);
  } catch (err) {
    reporter.check("state.json parseable", false, err.message);
  }
}
if (existsSync(`${STATE_PATH}.bak`)) {
  reporter.check("state.json.bak exists", true);
} else {
  reporter.warn("state.json.bak exists", "no .bak yet (normal until watcher writes for the 2nd time)");
}

  return { counts, details: { reconcileRows } };
}
