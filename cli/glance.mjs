/**
 * glance.mjs — `propagate glance [--json] [--no-write]` (propagate#295): what is working, what is broken, what needs you.
 *
 * A standalone run READS: the doctor snapshot, monitor.log, metrics.jsonl, the hook error logs, the guard log, the
 * broadcast index and the work queue. It never runs doctor, reconcile or `gh` (lib/glance/compute.mjs), so it takes
 * well under a second; the edges item is carried from the monitor's last glance, and is unknown when that is stale.
 * It writes `$PROPAGATE_STATE_DIR/glance.json` (atomically) and prunes guard-log months older than 90 days, unless
 * `--no-write`, which writes and deletes nothing. Badges are coloured on a TTY; `NO_COLOR` or `--no-color` prints
 * them as plain `[BROKEN]` words, and piped output is never coloured.
 *
 * Exit: 0 working, 1 broken or needs-you, 2 nothing could be read (a blind glance) or a usage error.
 */
import { stateDir } from "../lib/core/paths.mjs";
import { runGlance, exitCodeOf } from "../lib/glance/compute.mjs";
import { renderLines, shouldColor } from "../lib/glance/render.mjs";

/** The env overrides the monitor and doctor honour for their own files, so a glance reads what they wrote. */
export function envPaths(env = process.env) {
  const p = {};
  if (env.PROPAGATE_DOCTOR_SNAPSHOT) p.snapshot = env.PROPAGATE_DOCTOR_SNAPSHOT;
  if (env.PROPAGATE_MONITOR_LOG) p.monitor = env.PROPAGATE_MONITOR_LOG;
  return p;
}

/**
 * @param {string[]} args argv after `glance`
 * @param {{stateDirPath?: string, now?: number, out?: Function, err?: Function, color?: boolean}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function glanceCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  for (const a of args) {
    if (a !== "--json" && a !== "--no-write" && a !== "--no-color") {
      err(`glance: unknown argument ${a}\nusage: propagate glance [--json] [--no-write] [--no-color]`);
      return 2;
    }
  }
  const json = args.includes("--json");
  const write = !args.includes("--no-write");
  const dir = inject.stateDirPath ?? stateDir();
  const now = inject.now ?? Date.now();
  let r;
  try {
    r = runGlance({ dir, now, write, paths: inject.stateDirPath ? {} : envPaths() });
  } catch (e) {
    err(`glance: could not compute (${e.message})`);
    return 2;
  }
  if (json) out(JSON.stringify(r.glance, null, 2));
  else {
    // Badges are coloured only on a TTY without NO_COLOR or --no-color (render.mjs shouldColor); tests inject `color`.
    const color = inject.color ?? shouldColor({ argv: args });
    for (const l of renderLines(r.glance, { color })) out(l);
    if (r.pruned.length) out(`note: guard log: removed ${r.pruned.length} month file(s) older than 90 days (${r.pruned.join(", ")})`);
  }
  return exitCodeOf(r.glance);
}
