/**
 * day.mjs — `propagate day open [--json]` and `propagate day close [--apply] [--json]` (propagate#240).
 *
 * open is read-only on GitHub; its local writes are the dispatch snapshot and, through ONE `fetcher.graphql` search, the
 * broadcast index (propagate#267: the open children the SessionStart hook shows; counted in the GraphQL-calls line,
 * and a failed refresh is a note that leaves the old index). open also computes the glance from local files and
 * writes glance.json, which prunes guard-log months older than 90 days (propagate#295, #294; local, a note when it
 * removes anything or fails). close is a dry-run unless --apply, which writes only promotions and closure fixes.
 * The usage-widget and GitHub plumbing is cli/sprint.mjs's (loadWidget, ghFetcher); nothing is re-implemented.
 * Exit: open 0 enough, 1 short or over, 2 cannot judge; close 0 proposed/applied, 1 read-back mismatch, 2 could not compute.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { INTEGRATIONS } from "../lib/core/config.mjs";
import { readCosts, samplesPath } from "../lib/core/costs.mjs";
import { parseSamples } from "../lib/report/sprint-plan.mjs";
import { buildDayOpen, buildDayClose, renderDayOpen, renderDayClose, readBoardRead } from "../lib/report/day.mjs";
import { closeTextPath, lastCloseRecord, readLastClose, releaseLock, writeLastClose, ymd } from "../lib/report/day-close-auto.mjs";
import { parseGoalsFile } from "../lib/report/goals.mjs";
import { discoverBacklogFiles } from "../lib/report/backlog.mjs";
import { ghFetcher, loadWidget } from "./sprint.mjs";
import { hubOwnerOf } from "./broadcast.mjs";
import { refreshIndex, writeIndex } from "../lib/broadcast/index.mjs";
import { stateDir } from "../lib/core/paths.mjs";
import { runGlance } from "../lib/glance/compute.mjs";
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

/** One search through the same fetcher; counted. `inject.broadcastOwner === null` skips it. Never moves the exit code. */
async function refreshBroadcastIndex(r, { fetcher, now, inject }) {
  const owner = inject.broadcastOwner === undefined ? hubOwnerOf() : inject.broadcastOwner;
  if (!owner) return;
  r.graphqlCalls++;
  const res = await refreshIndex({ fetcher, owner, now });
  if (!res.ok) return void r.notes.push(`${res.error}; the local broadcast index is unchanged`);
  try {
    writeIndex(res.index, inject.stateDirPath ?? stateDir(), { prune: true });
    if (res.index.truncated) r.notes.push("broadcast index truncated: more than 50 broadcasts or 100 sub-issues in one");
  } catch (e) {
    r.notes.push(`broadcast index not written (${e.message})`);
  }
}

/**
 * The glance (propagate#295), after the broadcast refresh so it reads the fresh index. It reads files only: never
 * reconcile, doctor or gh. It also owns the guard log's 90-day prune now (moved here from a day-open step, #294
 * deferred it: every glance caller is a CLI process, and the monitor runs one every pass). Local only, so it runs
 * whatever the verdict; a removal or a failure is a note, never an exit code.
 */
function glanceStep(r, { now, inject }) {
  try {
    const res = (inject.runGlance ?? runGlance)({ dir: inject.stateDirPath ?? stateDir(), now });
    if (res.pruned.length) r.notes.push(`guard log: removed ${res.pruned.length} month file(s) older than 90 days (${res.pruned.join(", ")})`);
  } catch (e) {
    r.notes.push(`glance not written (${e.message})`);
  }
}

const USAGE = "day: usage: day open [--json] | day close [--apply] [--fresh] [--json]";

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
  const known = new Set(sub === "close" ? ["--apply", "--json", "--fresh"] : ["--json"]);
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
    if (r.exit !== 2) await refreshBroadcastIndex(r, { fetcher, now, inject });
    glanceStep(r, { now, inject });
    if (json) out(JSON.stringify(r, null, 2));
    else for (const line of renderDayOpen(r)) out(line);
    return r.exit;
  }
  const goalFiles = inject.goalFiles ?? (discoverBacklogFiles().goalsMd ?? []).map(parseGoalsFile);
  const dir = inject.stateDirPath ?? stateDir();
  // propagate#339: today's day-open board read is reused unless --fresh; the run's output says so.
  const boardRead = rest.includes("--fresh") ? null : readBoardRead(dir, now);
  let r;
  try {
    r = await buildDayClose({
      goalFiles,
      sampleRows: rows,
      now,
      widget,
      fetcher,
      apply,
      boardRead,
      sleep: inject.sleep ?? null,
      // Printed before the first write, so what is about to change is on screen first.
      beforeWrite: (res, mutations) => {
        if (json) return;
        out(`--apply: about to write ${res.operations.length} field value(s):`);
        for (const o of res.operations) out(`  ${o}`);
        for (const m of mutations) out(`  mutation: ${m}`);
      },
    });
  } catch (e) {
    // A crash is still an outcome the next session must see (propagate#339): record it, then say so.
    r = { command: "day close", exit: 2, graphqlCalls: 0, notes: [], reason: `day close crashed: ${e?.message ?? e}` };
  }
  const lines = json ? [JSON.stringify(r, null, 2)] : renderDayClose(r, { apply });
  for (const line of lines) out(line);
  leaveRecord({ dir, r, apply, now, text: lines.join("\n"), err });
  return r.exit;
}

/**
 * What the next session reads (propagate#339): last-close.json and the run's output, written for EVERY close run, then
 * the catch-up lock released if this process holds it. A failure to write is said on stderr, never swallowed.
 */
function leaveRecord({ dir, r, apply, now, text, err }) {
  try {
    mkdirSync(path.join(dir, "day"), { recursive: true });
    writeFileSync(closeTextPath(dir, ymd(now), apply), `${text}\n`);
    let prev = null;
    try {
      prev = readLastClose(dir);
    } catch {
      // an unreadable previous record only loses its caught-up date
    }
    writeLastClose(dir, lastCloseRecord(r, { apply, now, prev }));
  } catch (e) {
    err(`day close: could not write last-close.json (${e.message}); the next session will not see this run`);
  } finally {
    releaseLock(dir, process.pid);
  }
}
