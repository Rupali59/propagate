/**
 * `propagate attention next | list [--json] | clear [--apply]` (propagate#445).
 *
 * The Notification hook (scripts/attention-queue/hook.mjs) queues sessions that need the user; `next` focuses the
 * Ghostty tab of the oldest one whose tab still exists. Bind `next` to a global hotkey (docs/REFERENCE.md §attention).
 *
 * EXIT CODES. next: 0 focused, 1 nothing waiting, 2 could not run (osascript or Ghostty absent, Automation denied;
 * the reason is printed). list: 0. clear: 0. A usage error is 2. `list` is read-only; `clear` is a dry run without --apply.
 */
import path from "node:path";

import { stateDir } from "../lib/core/paths.mjs";
import { focus, liveTerminals, GhosttyError } from "../scripts/attention-queue/ghostty.mjs";
import { markHandled, normTty, pending, pop, queueFile, readEvents } from "../scripts/attention-queue/queue.mjs";

const USAGE = "usage: propagate attention next | attention list [--json] | attention clear [--apply]";

function age(ts, now) {
  const s = Math.max(0, Math.round((now - new Date(ts)) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** @param {string[]} argv everything after `attention` @param {object} [inject] tests: io, stateDirPath, now, ghostty */
export async function attentionCmd(argv = [], inject = {}) {
  const io = inject.io ?? console;
  const file = queueFile(inject.stateDirPath ?? stateDir());
  const now = inject.now ?? new Date();
  const gh = inject.ghostty ?? { liveTerminals, focus };
  const [sub, ...rest] = argv;

  if (sub === "list") {
    const entries = pending(readEvents(file));
    if (rest.includes("--json")) io.log(JSON.stringify(entries, null, 2));
    else if (!entries.length) io.log("nothing waiting");
    else for (const e of entries) io.log(`${age(e.ts, now).padEnd(5)} ${e.session_id}  ${path.basename(e.cwd || "") || "-"}  ${e.message}`);
    return 0;
  }

  if (sub === "clear") {
    const entries = pending(readEvents(file));
    if (!rest.includes("--apply")) {
      io.log(`dry run: would mark ${entries.length} waiting session(s) handled. Next: propagate attention clear --apply`);
      return 0;
    }
    for (const e of entries) markHandled(file, e.session_id, "cleared", now);
    io.log(`cleared ${entries.length}`);
    return 0;
  }

  if (sub === "next") {
    const entries = pending(readEvents(file));
    if (!entries.length) {
      io.log("nothing waiting");
      return 1;
    }
    let terms;
    try {
      terms = gh.liveTerminals();
    } catch (err) {
      io.error(err instanceof GhosttyError ? err.message : `could not list Ghostty terminals: ${err?.message ?? err}`);
      return 2;
    }
    const { entry, skipped } = pop(entries, terms.map((t) => t.tty));
    for (const s of skipped) {
      io.log(`skipped ${s.session_id} (tab closed)`);
      markHandled(file, s.session_id, "stale", now);
    }
    if (!entry) {
      io.log("nothing waiting");
      return 1;
    }
    const term = terms.find((t) => normTty(t.tty) === normTty(entry.tty));
    try {
      gh.focus(term.id);
    } catch (err) {
      io.error(err instanceof GhosttyError ? err.message : `could not focus the terminal: ${err?.message ?? err}`);
      return 2;
    }
    markHandled(file, entry.session_id, "focused", now);
    io.log(`focused ${entry.session_id}  ${path.basename(entry.cwd || "") || "-"}  ${entry.message}`);
    return 0;
  }

  io.error(USAGE);
  return 2;
}
