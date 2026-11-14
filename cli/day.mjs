/**
 * day.mjs — `propagate day open [--json]` and `propagate day close [--apply] [--json]` (propagate#240).
 *
 * open is read-only. close is a dry-run unless --apply, which writes only promotions and closure fixes.
 * The usage-widget and GitHub plumbing is cli/sprint.mjs's (loadWidget, ghFetcher); nothing is re-implemented.
 * Exit: open 0 enough, 1 short or over, 2 cannot judge; close 0 proposed/applied, 1 read-back mismatch, 2 could not compute.
 */

import { readFileSync } from "node:fs";

import { INTEGRATIONS } from "../lib/core/config.mjs";
import { readCosts, samplesPath } from "../lib/core/costs.mjs";
import { parseSamples } from "../lib/report/sprint-plan.mjs";
import { buildDayOpen, buildDayClose, renderDayOpen, renderDayClose } from "../lib/report/day.mjs";
import { parseGoalsFile } from "../lib/report/goals.mjs";
import { discoverBacklogFiles } from "../lib/report/backlog.mjs";
import { ghFetcher, loadWidget } from "./sprint.mjs";
import { fold } from "../lib/sessions/assoc.mjs";
import { fail } from "../lib/sessions/errors.mjs";
import { readLive } from "../lib/sessions/live.mjs";
import { loadContext } from "../lib/sessions/resolve.mjs";
import { buildView } from "../lib/sessions/view.mjs";

/** The real sessions reader: `claude agents --json` + the association fold + the folder resolver, once per run. */
export function readSessions(now) {
  const live = readLive({ now: () => now });
  if (!live.ok) return live;
  try {
    return { ok: true, view: buildView(live, fold(), loadContext()) };
  } catch (e) {
    return fail("SESSION_ASSOC_UNREADABLE", `could not read the session associations (${e.message})`, "run propagate sessions");
  }
}

const USAGE = "day: usage: day open [--json] | day close [--apply] [--json]";

/**
 * @param {string[]} args argv after the command name (starts with `open` or `close`)
 * @param {{sessions?: () => object, out?: Function, err?: Function, now?: number, fetcher?: object, samplesRaw?: string, laneRows?: object[], widget?: object, widgetDir?: string}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function dayCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  const sub = args[0];
  if (sub !== "open" && sub !== "close") {
    err(USAGE);
    return 2;
  }
  const rest = args.slice(1);
  const known = new Set(sub === "close" ? ["--apply", "--json"] : ["--json"]);
  for (const a of rest) {
    if (!known.has(a)) {
      err(`day ${sub}: unknown argument ${a}`);
      return 2;
    }
  }
  const json = rest.includes("--json");
  const apply = sub === "close" && rest.includes("--apply");

  let widget = inject.widget ?? null;
  let widgetMissing;
  if (!widget) {
    const w = await loadWidget(inject.widgetDir ?? INTEGRATIONS.usageWidgetDir);
    widget = w.widget;
    widgetMissing = w.missing;
  }
  let raw = inject.samplesRaw;
  if (raw === undefined) {
    try {
      raw = readFileSync(samplesPath(), "utf8");
    } catch {
      raw = "";
    }
  }
  const { rows } = parseSamples(raw);
  const now = inject.now ?? Date.now();
  const fetcher = inject.fetcher ?? ghFetcher();

  if (sub === "open") {
    // The goals summary line reads the GOALS.md files here and the boards buildDayOpen already read (propagate#264).
    const goalFiles = inject.goalFiles ?? (discoverBacklogFiles().goalsMd ?? []).map(parseGoalsFile);
    // Sessions are information beside the verdict: a reader that fails or throws becomes a line, never an exit code.
    let sessions;
    try {
      sessions = await (inject.sessions ?? (() => readSessions(now)))();
    } catch (e) {
      sessions = { ok: false, code: "SESSION_READER_FAILED", what: e.message };
    }
    const r = await buildDayOpen({ sessions, sampleRows: rows, now, widget, widgetMissing, fetcher, goalFiles, laneRows: inject.laneRows ?? readCosts({ lanesOnly: true }).rows });
    if (json) out(JSON.stringify(r, null, 2));
    else for (const line of renderDayOpen(r)) out(line);
    return r.exit;
  }
  const goalFiles = inject.goalFiles ?? (discoverBacklogFiles().goalsMd ?? []).map(parseGoalsFile);
  const r = await buildDayClose({
    goalFiles,
    sampleRows: rows,
    now,
    widget,
    fetcher,
    apply,
    // Printed before the first write, so what is about to change is on screen first.
    beforeWrite: (res, mutations) => {
      if (json) return;
      out(`--apply: about to write ${res.operations.length} field value(s):`);
      for (const o of res.operations) out(`  ${o}`);
      for (const m of mutations) out(`  mutation: ${m}`);
    },
  });
  if (json) out(JSON.stringify(r, null, 2));
  else for (const line of renderDayClose(r, { apply })) out(line);
  return r.exit;
}
