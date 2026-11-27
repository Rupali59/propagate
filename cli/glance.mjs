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
 * A text run ends with one `test-queue:` line read from the machine-wide queue (lib/report/test-queue.mjs; files only).
 *
 * Exit: 0 working, 1 broken or needs-you, 2 nothing could be read (a blind glance) or a usage error.
 *
 * `propagate glance ack <id>... [--until <date|date-time|Nh|Nd>] [--json]` (propagate#296) acknowledges items, or
 * snoozes them with --until, in `$STATE/glance-acks.json`; `propagate glance unack <id>...` removes that. An acked item
 * is shown as acked and not notified; its verdict is unchanged (lib/glance/acks.mjs). Exit 0 written, 2 usage error.
 */
import { stateDir } from "../lib/core/paths.mjs";
import { runGlance, exitCodeOf } from "../lib/glance/compute.mjs";
import { renderLines, shouldColor } from "../lib/glance/render.mjs";
import { glanceLine, queueDir, readStatus } from "../lib/report/test-queue.mjs";
import { setAcks, clearAcks, parseUntil } from "../lib/glance/acks.mjs";

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
  if (args[0] === "ack" || args[0] === "unack") return runAck(args[0], args.slice(1), { ...inject, out, err });
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
    // The test-queue line (#428) is information, not a verdict: it is not a glance signal, so it never changes the exit
    // code or glance.json, and --json stays exactly the glance.json object. A caller that injected a state dir and no
    // queueDir reads no queue, the way it reads no env-override paths.
    const qd = inject.queueDir !== undefined ? inject.queueDir : inject.stateDirPath ? null : queueDir();
    if (qd) out(glanceLine(readStatus({ dir: qd, now }), now));
    if (r.pruned.length) out(`note: guard log: removed ${r.pruned.length} month file(s) older than 90 days (${r.pruned.join(", ")})`);
  }
  return exitCodeOf(r.glance);
}

const ACK_USAGE = "usage: propagate glance ack <id>... [--until <2026-11-20|2026-11-20T09:00:00Z|24h|3d>] [--json]\n       propagate glance unack <id>... [--json]";

/** `glance ack` / `glance unack`. A helper of glanceCmd (the flag allowlist for these is `glance ack` / `glance unack`). */
async function runAck(verb, args, { out, err, stateDirPath, now = Date.now() }) {
  const ids = [];
  let until = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--until" && verb === "ack") {
      if (i + 1 >= args.length) { err(`glance ack: --until needs a value\n${ACK_USAGE}`); return 2; }
      try { until = parseUntil(args[++i], now); } catch (e) { err(`glance ack: ${e.message}`); return 2; }
    } else if (a.startsWith("--")) { err(`glance ${verb}: unknown argument ${a}\n${ACK_USAGE}`); return 2; }
    else ids.push(a);
  }
  if (!ids.length) { err(`glance ${verb}: name at least one item id (propagate glance --json lists them)\n${ACK_USAGE}`); return 2; }
  const dir = stateDirPath ?? stateDir();
  let r;
  try {
    r = verb === "ack" ? setAcks(dir, ids, { until, now }) : clearAcks(dir, ids, { now });
  } catch (e) {
    err(`glance ${verb}: ${e.message}`);
    return 2;
  }
  if (json) out(JSON.stringify({ verb, ...r }, null, 2));
  else if (verb === "ack") {
    out(`${r.until ? `snoozed until ${r.until}` : "acknowledged for the current episode"}: ${ids.join(", ")}`);
    out("  shown as acked and not notified; the verdict is unchanged. Undo: propagate glance unack <id>");
    if (r.replacedCorrupt) out("  note: the previous acks file was unreadable and has been replaced");
  } else {
    if (r.removed.length) out(`unacked: ${r.removed.join(", ")}`);
    if (r.missing.length) out(`not acked (nothing to remove): ${r.missing.join(", ")}`);
  }
  return 0;
}
