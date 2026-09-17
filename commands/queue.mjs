/**
 * queue.mjs — the disposition backlog as a one-shot, for consumers that cannot
 * hold a server open: the Übersicht widget, a status line, a cron.
 *
 * `propagate ui` serves the same payload from `lib/report/queue.mjs`; this
 * prints it once and exits. One derivation, three renderers — the widget must
 * never grow its own idea of what "actionable" means.
 */
import { queuePayload } from "../lib/report/queue.mjs";
import path from "node:path";

export async function queueCmd(argv = [], io = console) {
  const asJson = argv.includes("--json");
  const root = path.join(process.env.HOME ?? "", "Documents/GitHub/");
  let payload;
  try {
    payload = await queuePayload({ root });
  } catch (err) {
    // A reader that cannot report failure invents an answer. Emit the shape a
    // consumer expects, with the error IN it, rather than an empty queue that
    // would render as "all clear" (rule:discernment-checks §6).
    const msg = String(err?.message ?? err);
    if (asJson) { io.log(JSON.stringify({ error: msg, items: null, summary: null, declared: null, expanded: null })); return 2; }
    io.log(`queue: could not derive — ${msg}`);
    return 2;
  }
  if (asJson) { io.log(JSON.stringify(payload)); return 0; }
  const s = payload.summary;
  if (!payload.expanded) {
    // Same distinction the widget draws. `0 actionable of 0` reads as health and
    // means the opposite (rule:discernment-checks §2). The guard is on EXPANDED
    // because that is the population the queue is drawn from.
    io.log("0 edges scanned — that is not a clean tree; check the config with `propagate doctor`.");
    return 2;
  }
  // The denominator is the EXPANDED count, because that is what the actionable
  // set is drawn from. Both are printed: saying "of 493" over a 1003-row
  // population is the compare-unlike-things error (rule:discernment-checks §5).
  io.log(`${s.total} actionable of ${payload.expanded} edges (from ${payload.declared} declared) · ${Object.entries(s.byState).map(([k, v]) => `${v} ${k}`).join(" · ")}`);
  io.log(`${s.neverJudged} never judged · ${s.highNoise} mostly-no-op`);
  for (const i of payload.items.slice(0, 10)) {
    const h = i.judgedCount === 0 ? "never judged" : `${i.judgedCount}× · ${Math.round(i.noiseRatio * 100)}% no-op`;
    io.log(`  ${i.state.padEnd(9)} ${i.edge_id}  ${i.sourceShort} → ${i.downstreamShort}  (${h})`);
  }
  if (payload.items.length > 10) io.log(`  +${payload.items.length - 10} more`);
  return 0;
}
