/**
 * reminders.mjs — doctor's Reminders bridge section (D2,
 * `docs/plans/2026-09-23-reminders-todo-bridge.md:138-165`).
 *
 * A TCC denial, a missing list, a timeout, ... are all "could not look",
 * never `pass` (a green tick over an unmeasured population is N82's exact
 * shape — GOTCHAS G68) and never `fail` (nothing is broken when Reminders
 * access is merely ungranted). `Reporter.inconclusive()` is the third state
 * N87 slice 2 built for precisely this; PR-007 is its first real consumer.
 *
 * EVERY ONE of L4's seven `reason` strings (`lib/reminders/osascript.mjs`'s
 * `classify()` and `read.mjs`'s two synthesized reasons) gets its OWN
 * message below. Collapsing them into one generic "could not read
 * Reminders" line is exactly what `rule:discernment-checks` §2 forbids — a
 * TCC denial needs a System Settings pointer, a renamed list needs a
 * different one, and folding both into one sentence sends the reader
 * nowhere useful.
 *
 * NOT WIRED INTO `doctor()` IN cli.mjs. This lane's file list explicitly
 * excludes cli.mjs — see this lane's handback for why that wiring is a
 * follow-up, not a gap silently left out.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { HOME } from "../../core/paths.mjs";
import { DIGEST_LABEL } from "../../core/plist.mjs";
import { readReminders } from "../../reminders/read.mjs";

/**
 * The plist launchd actually loads.
 *
 * Mirrors `plist.mjs`'s own PLIST_DIR rule deliberately: an explicit
 * `PROPAGATE_STATE_DIR` redirects it (so a scoped test can point this gate at
 * a fixture), and everything else resolves to `~/Library/LaunchAgents`, which
 * is the only directory launchd reads. Kept in step with that file rather
 * than re-deriving a second answer.
 */
export const INSTALLED_DIGEST_PLIST = path.join(
  process.env.PROPAGATE_STATE_DIR
    ? process.env.PROPAGATE_STATE_DIR
    : path.join(HOME, "Library", "LaunchAgents"),
  `${DIGEST_LABEL}.plist`,
);

/**
 * Severity of what this section reports (N87 slice 2b,
 * `tests/unit/doctor-severity.test.mjs`).
 *
 * S2, matching `environment.mjs`'s plist/schedule-integrity sections: a TCC
 * denial or a renamed list is misleading rather than silent — it surfaces as
 * a named, attributable `inconclusive` entry, never a bare zero — but it is
 * not a data-loss risk (S1) on its own. If this section ever grows a check
 * for something that CAN silently lose data (e.g. a reconciliation write
 * gone wrong), that belongs in its own S1 section rather than raising this
 * one, per this same test file's own rule: "a module whose checks genuinely
 * span two severities should SPLIT."
 */
export const SEVERITY = "S2";

/**
 * L4's stable `reason` strings -> what a reader should actually do about
 * each. Keep in sync with `lib/reminders/osascript.mjs`'s `KNOWN_CODES` plus
 * `read.mjs`'s two synthesized reasons (`unparseable-output`; `timeout` is
 * synthesized in `osascript.mjs#readRaw`).
 */
const REASON_ADVICE = Object.freeze({
  "tcc-denied":
    "Reminders access is denied to this process. Grant it under System Settings -> Privacy & Security -> " +
    "Reminders, then re-run. This is the EXPECTED first-run failure mode for a background agent (spec H1) — " +
    "it does not mean zero reminders.",
  "missing-list":
    'The "Claude TODO" list does not exist, or was renamed. Recreate it, or pass a different --list.',
  "syntax-error":
    "osascript rejected the generated JXA script. This is a propagate bug in lib/reminders/osascript.mjs's " +
    "buildScript(), not a Reminders permissions issue — file it.",
  "app-not-running":
    "Reminders is not reachable (procNotFound). Unusual for a background read; investigate before assuming " +
    "a retry will resolve it.",
  timeout:
    "osascript did not return before the timeout — possibly blocked on a permission dialog on the desktop. " +
    "Check for a stuck dialog before re-running.",
  "osascript-error":
    "osascript exited non-zero with an OSStatus this reader does not recognise. See the detail for the raw stderr.",
  "unparseable-output":
    "osascript exited 0 but stdout was not the JSON array read.mjs expects. A propagate/JXA bug, not a " +
    "permissions issue — see lib/reminders/read.mjs's own guard.",
});

/**
 * @param {{ reporter: import("./reporter.mjs").Reporter, readRemindersFn?: () => Promise<*> }} deps
 * @returns {Promise<{ counts: { remindersTotal: number, remindersRouted: number, remindersHeldUntagged: number, remindersHeldUnknownTag: number } }>}
 */
/**
 * How long doctor waits for Reminders before calling it INCONCLUSIVE.
 *
 * `readRaw`'s own default is 15s, which is right for `propagate reminders` --
 * a command someone typed, waiting for an answer. It is wrong HERE. `doctor`
 * is run constantly and its whole purpose this quarter has been to become
 * trustworthy (N87); adding a silent 15-second stall to every invocation
 * would make the tool people check things with feel broken, and a doctor
 * nobody runs reports nothing.
 *
 * 3s is enough for a granted read (the measured healthy read is well under a
 * second) and short enough that a HUNG one -- the shape a never-answered TCC
 * prompt produces -- is a fast, attributable `inconclusive` instead of a
 * stall. Timing out early cannot produce a false pass: `timeout` is one of
 * the seven reasons, and every one of them routes to `inconclusive`.
 */
export const DOCTOR_READ_TIMEOUT_MS = 3_000;

/**
 * Is the bridge actually DEPLOYED on this machine?
 *
 * `writeDigestPlist()` emits two `StartCalendarInterval` entries (09:00 +
 * 21:00) once this lane landed, but generating a plist is not installing one
 * -- `digest.mjs --install` is a launchd one-way door reserved for a human.
 * So a freshly-built tree has the CODE for the bridge and no running bridge.
 *
 * This gate exists because without it `doctor` reports a permanent
 * `inconclusive` for a component nobody turned on: on a machine where
 * Reminders access was never granted, every run would carry a problem that
 * cannot be cleared by fixing anything. That is precisely N87 -- "354
 * warnings bury the one that fires" -- reappearing inside N87's own cure, and
 * the component it would bury signal for is one that does not exist yet.
 *
 * Reading the INSTALLED file rather than asking launchd is deliberate (G-O):
 * launchd keeps a bootstrapped job in its own database and never re-reads the
 * plist, so `launchctl list` stays green against a file that has been
 * truncated underneath it. Always `-o -`; `-o <the file>` overwrites it.
 */
export function bridgeDeployment(plistPath = INSTALLED_DIGEST_PLIST) {
  if (!existsSync(plistPath)) return { deployed: false, why: "no digest plist is installed" };
  const lint = spawnSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
  if (lint.status !== 0) {
    return { deployed: false, why: `the installed digest plist does not parse — ${String(lint.stdout || lint.stderr).trim()}` };
  }
  const x = spawnSync("/usr/bin/plutil", ["-extract", "StartCalendarInterval", "xml1", "-o", "-", plistPath], { encoding: "utf8" });
  if (x.status !== 0) return { deployed: false, why: "the installed digest plist has no StartCalendarInterval" };
  const entries = (String(x.stdout).match(/<dict>/g) ?? []).length;
  if (entries < 2) {
    return {
      deployed: false,
      why: `the installed digest plist carries ${entries} schedule entry(s), not 2 — the reminders slot is not installed. Run the digest install step to deploy it.`,
    };
  }
  return { deployed: true, why: null };
}

export async function checkReminders({
  reporter,
  readRemindersFn = readReminders,
  // Injecting a reader IS the statement "exercise the read path" -- a caller
  // that hands over a test double is not asking whether launchd has the job
  // installed. So the deployment gate defaults ON only for the real reader.
  // Without this, every injected-reader test short-circuits at "not
  // installed" and silently stops testing what it names.
  deploymentFn = readRemindersFn === readReminders ? bridgeDeployment : () => ({ deployed: true, why: null }),
}) {
  reporter.header("# Reminders bridge");

  // NOT DEPLOYED is a different fact from COULD NOT LOOK, and only one of
  // them is a problem (rule:discernment-checks §2). An uninstalled bridge is
  // reported and moves on; it never reads Reminders, so `doctor` also cannot
  // provoke a TCC prompt on a machine that never opted in.
  const deployment = deploymentFn();
  if (!deployment.deployed) {
    reporter.info("reminders bridge", `not installed — ${deployment.why}`);
    return {
      counts: { remindersTotal: 0, remindersRouted: 0, remindersHeldUntagged: 0, remindersHeldUnknownTag: 0 },
    };
  }

  // The default reader gets doctor's shorter budget; an injected one is a
  // test double and is called bare, exactly as before.
  const result =
    readRemindersFn === readReminders
      ? await readRemindersFn({ timeoutMs: DOCTOR_READ_TIMEOUT_MS })
      : await readRemindersFn();

  if (!result.ok) {
    const advice = REASON_ADVICE[result.reason];
    reporter.inconclusive(
      `reminders list readable (${result.reason})`,
      advice
        ? `${advice} — ${result.reasonDetail}`
        // An unrecognised reason is reported honestly rather than folded
        // into one of the seven known messages — rule:discernment-checks §6:
        // a reader that cannot say "I did not understand this" invents an
        // answer, and this refuses to be that reader.
        : `unrecognised reason "${result.reason}" from lib/reminders/read.mjs — ${result.reasonDetail}`,
    );
    return {
      counts: { remindersTotal: 0, remindersRouted: 0, remindersHeldUntagged: 0, remindersHeldUnknownTag: 0 },
    };
  }

  reporter.check(
    "reminders list readable",
    true,
    `"${result.list}" — ${result.summary.total} item(s): ${result.summary.routed} routed, ` +
      `${result.summary.heldUntagged} held-untagged, ${result.summary.heldUnknownTag} held-unknown-tag`,
  );

  return {
    counts: {
      remindersTotal: result.summary.total,
      remindersRouted: result.summary.routed,
      remindersHeldUntagged: result.summary.heldUntagged,
      remindersHeldUnknownTag: result.summary.heldUnknownTag,
    },
  };
}
