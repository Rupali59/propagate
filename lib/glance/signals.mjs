/**
 * signals.mjs — ONE definition per glance signal (propagate#295, design §1). PURE: no imports, no filesystem.
 *
 * Each signal declares its `kind`, which decides what "unknown" means (design §2):
 *   heartbeat  a periodic writer. Missing, unreadable, or older than `staleAfterMs` is unknown.
 *   event log  written only when something happens. A missing file or an empty window is 0 events, working; it is
 *              never unknown for being quiet. Its liveness is "the writer is registered and importable"
 *              (hooks/hooks.json, tests/hooks/hook-imports.test.mjs).
 *
 * FIX TEXT IS A TEMPLATE, never generated, and short (at most 36 characters: the line is capped at 80, and the
 * fix is the part that must survive the cut, so it is a bare command or a few words, never "next: ..."): `{slot}` names are filled by fillFix from the item, and a missing slot
 * throws rather than printing a guess. Keys: working, broken, needs_you, unknown (whichever the signal can produce).
 * `owner` is who acts on a broken item: `propagate` retries it on its own schedule, `you` must act. A propagate-owned
 * item still broken after PROMOTE_AFTER_MS (6 monitor runs) is promoted to needs-you by the compute.
 *
 * `source` is a NAME, never a path: paths stay out of the line and the file (design §4).
 */

const H = 3600000;

/** 6 monitor runs at the monitor's 1800 s interval (design §2). */
export const PROMOTE_AFTER_MS = 6 * 1800 * 1000;

/** @type {ReadonlyArray<object>} */
export const SIGNALS = Object.freeze([
  {
    name: "doctor", kind: "heartbeat", source: "doctor snapshot", reader: "readDoctor", owner: "you",
    question: "do doctor's checks pass?",
    failure: "a red doctor check",
    staleAfterMs: 26 * H, // DAILY_MAX_HOURS in lib/report/doctor/scheduled-jobs.mjs; the fingerprint ceiling is 24 h + one interval
    fix: {
      working: { text: "checked {time}", command: null },
      broken: { text: "propagate doctor --full", command: "propagate doctor --full" },
      needs_you: { text: "act: propagate doctor --full", command: "propagate doctor --full" },
      unknown: { text: "propagate monitor", command: "propagate monitor" },
    },
  },
  {
    name: "metrics", kind: "heartbeat", source: "doctor history", reader: "readMetrics", owner: "you",
    question: "is doctor's problem count jumping?",
    failure: "doctor.problems today more than twice its 7-day median and at least 3",
    staleAfterMs: 26 * H, // written by doctor, so it ages with the snapshot
    fix: {
      working: { text: "checked {time}", command: null },
      broken: { text: "propagate doctor --since 7d", command: "propagate doctor --since 7d" },
      unknown: { text: "propagate doctor", command: "propagate doctor" },
    },
  },
  {
    name: "monitor", kind: "heartbeat", source: "monitor log", reader: "readMonitor", owner: "propagate",
    question: "is the monitor running on schedule?",
    failure: "the last run logged an error",
    staleAfterMs: 3 * 1800 * 1000, // lib/report/doctor/environment.mjs STALE_AFTER_MS
    fix: {
      working: { text: "ran {time}", command: null },
      broken: { text: "propagate monitor --dry-run", command: "propagate monitor --dry-run" },
      needs_you: { text: "stuck; propagate monitor --dry-run", command: "propagate monitor --dry-run" },
      unknown: { text: "propagate doctor", command: "propagate doctor" },
    },
  },
  {
    name: "edges", kind: "heartbeat", source: "reconcile rows", reader: "readEdges", owner: "you",
    question: "can every declared edge be resolved?",
    failure: "an edge whose actionOf is broken (UNMATCHED, UNRESOLVABLE, NOT_PRESENT_ON_REF)",
    staleAfterMs: 6 * H, // carried from the previous glance only while that glance is itself fresh
    fix: {
      working: { text: "propagate settles {n} queued", command: null },
      broken: { text: "propagate status", command: "propagate status" },
      unknown: { text: "propagate monitor", command: "propagate monitor" },
    },
  },
  {
    name: "hooks", kind: "event log", source: "hook error logs", reader: "readHooks", owner: "propagate",
    question: "are the hooks failing?",
    failure: "error-shaped lines in a hook's errors.log (skipped and row-written traces excluded)",
    fix: {
      working: { text: "{n} errors today", command: null },
      learning: { text: "learning, {have} of {need} days", command: null },
      broken: { text: "propagate doctor", command: "propagate doctor" },
      needs_you: { text: "stuck; propagate doctor --full", command: "propagate doctor --full" },
      unknown: { text: "propagate doctor", command: "propagate doctor" },
    },
  },
  {
    name: "guard", kind: "event log", source: "guard log", reader: "readGuard", owner: "you",
    question: "is the background guard being worked around?",
    failure: "a deny with no backgrounded re-run of the same command within 10 minutes",
    fix: {
      working: { text: "{n} blocks, all re-run", command: null },
      learning: { text: "learning, {have} of {need} days", command: null },
      broken: { text: "re-run heavy work in the background", command: null },
      unknown: { text: "propagate doctor", command: "propagate doctor" },
    },
  },
  {
    name: "jobs", kind: "heartbeat", source: "doctor snapshot", reader: "readJobs", owner: "you",
    question: "did each scheduled job's last run succeed?",
    failure: "no live pid and a non-zero last exit, or a daily job not run for 26 h",
    staleAfterMs: 26 * H,
    fix: {
      working: { text: "checked {time}", command: null },
      broken: { text: "propagate doctor --full", command: "propagate doctor --full" },
      unknown: { text: "propagate monitor", command: "propagate monitor" },
    },
  },
  {
    name: "broadcast", kind: "heartbeat", source: "broadcast index", reader: "readBroadcast", owner: "you",
    question: "has every open broadcast child been shown to a session?",
    failure: "an open child not shown for more than 2 days",
    staleAfterMs: 7 * 24 * H, // hooks/session-guide.mjs stops listing items past 7 days
    fix: {
      working: { text: "{n} open, all shown", command: null },
      needs_you: { text: "propagate broadcast status", command: "propagate broadcast status" },
      unknown: { text: "propagate day open", command: "propagate day open" },
    },
  },
  {
    name: "work", kind: "heartbeat", source: "work queue", reader: "readWork", owner: "you",
    question: "is any queued work parked waiting for a person?",
    failure: "a work item parked after two refusals",
    fix: {
      working: { text: "{n} items, none parked", command: null },
      needs_you: { text: "propagate work list", command: "propagate work list --state parked" },
      unknown: { text: "propagate work list", command: "propagate work list" },
    },
  },
  {
    name: "cleaner", kind: "heartbeat", source: "cleaner audit", reader: "readCleaner", owner: "you",
    question: "did the cleaner's last worktrees audit run, and what does it hold?",
    failure: "no last-audit.json, an unreadable one, or a worktrees audit older than 24 h",
    staleAfterMs: 24 * H, // lib/glance/cleaner.mjs AUDIT_STALE_MS, per domain by its own `at`
    fix: {
      working: { text: "audit {time} ago", command: null },
      unknown: { text: "run the cleaner's audit", command: null },
    },
  },
]);

export const signalByName = (name) => SIGNALS.find((s) => s.name === name) ?? null;

/** The fix for a signal and situation, with `{slot}`s filled from `slots`. A missing slot throws: never a guess. */
export function fillFix(name, key, slots = {}) {
  const s = signalByName(name);
  if (!s) throw new Error(`glance: no signal ${name}`);
  const f = s.fix[key];
  if (!f) throw new Error(`glance: signal ${name} has no ${key} fix`);
  const text = f.text.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in slots)) throw new Error(`glance: ${name}.${key} fix needs slot {${k}}`);
    return String(slots[k]);
  });
  return { text, command: f.command };
}
