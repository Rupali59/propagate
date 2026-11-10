/**
 * sprint.mjs — `propagate sprint plan [--approvals N] [--json]` (propagate#190) and
 * `propagate sprint review [--sprint <title>] [--apply] [--json]` (propagate#191; writes only with --apply).
 *
 * Read-only: no GitHub write, no ledger write. The daily-cap rule is NOT re-implemented here: it lives in the
 * usage widget (a separate private repo), and is imported from the directory named by PROPAGATE_USAGE_WIDGET_DIR
 * (src/collect/daily-cap.mjs and day-used.mjs). Unset or unimportable: exit 2, never a guess.
 * Exit: 0 fits; 1 over (cut list); 2 could not compute or cannot judge fit.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readCosts, samplesPath } from "../lib/core/costs.mjs";
import { buildSprintPlan, parseSamples, renderPlan } from "../lib/report/sprint-plan.mjs";
import { buildSprintReview, moveLines, renderReview } from "../lib/report/sprint-review.mjs";

function value(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/** @returns {Promise<{widget: {dailyCap: Function, dayUsed: Function}|null, missing?: string}>} */
export async function loadWidget(dir = process.env.PROPAGATE_USAGE_WIDGET_DIR) {
  if (!dir) return { widget: null };
  try {
    const collect = path.join(dir, "src", "collect");
    const [cap, used] = await Promise.all([
      import(pathToFileURL(path.join(collect, "daily-cap.mjs")).href),
      import(pathToFileURL(path.join(collect, "day-used.mjs")).href),
    ]);
    if (typeof cap.dailyCap !== "function" || typeof used.dayUsed !== "function") {
      return { widget: null, missing: "daily-cap.mjs/day-used.mjs do not export dailyCap/dayUsed" };
    }
    return { widget: { dailyCap: cap.dailyCap, dayUsed: used.dayUsed } };
  } catch (err) {
    return { widget: null, missing: `import failed (${err?.code || err?.message})` };
  }
}

/** The real GitHub reader: `gh api rate_limit` (free) and `gh api graphql`. */
export function ghFetcher(gh = process.env.PROPAGATE_GH_BIN || "gh") {
  const run = (args) => {
    const r = spawnSync(gh, args, { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`${gh}: ${r.error.code || r.error.message}`);
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout).trim().split("\n")[0]);
    return JSON.parse(r.stdout);
  };
  return {
    rateLimit: () => run(["api", "rate_limit"]).resources,
    graphql: async (query) => {
      const res = run(["api", "graphql", "-f", `query=${query}`]);
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
      return res.data;
    },
    // The only method that sends a mutation. sprint review reaches it solely behind --apply.
    write: async (mutation) => {
      const res = run(["api", "graphql", "-f", `query=${mutation}`]);
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
      return res.data;
    },
  };
}

/**
 * @param {string[]} args argv after the command name (starts with `plan`)
 * @param {{out?: Function, err?: Function, now?: number, fetcher?: object, samplesRaw?: string, laneRows?: object[], widgetDir?: string}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function sprintCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  if (args[0] === "review") return sprintReview(args.slice(1), inject, out, err);
  if (args[0] !== "plan") {
    err("sprint: usage: sprint plan [--approvals <n>] [--json] | sprint review [--sprint <title>] [--apply] [--json]");
    return 2;
  }
  const rest = args.slice(1);
  let approvals = null;
  const a = value(rest, "--approvals");
  if (a !== null) {
    approvals = Number(a);
    if (!Number.isInteger(approvals) || approvals < 0) {
      err("sprint plan: --approvals needs a non-negative integer");
      return 2;
    }
  }

  const { widget, missing } = await loadWidget(inject.widgetDir ?? process.env.PROPAGATE_USAGE_WIDGET_DIR);
  let raw = inject.samplesRaw;
  let samplesNote = null;
  if (raw === undefined) {
    try {
      raw = readFileSync(samplesPath(), "utf8");
    } catch (e) {
      raw = "";
      samplesNote = e?.code === "ENOENT" ? "no samples file" : `samples file unreadable (${e?.code || e})`;
    }
  }
  const { rows } = parseSamples(raw);

  const plan = await buildSprintPlan({
    sampleRows: rows,
    now: inject.now ?? Date.now(),
    widget,
    widgetMissing: missing,
    fetcher: inject.fetcher ?? ghFetcher(),
    laneRows: inject.laneRows ?? readCosts({ lanesOnly: true }).rows,
    approvals,
  });
  if (samplesNote && plan.reason) plan.reason += ` (${samplesNote})`;

  if (rest.includes("--json")) out(JSON.stringify(plan, null, 2));
  else for (const line of renderPlan(plan)) out(line);
  return plan.exit;
}

async function sprintReview(rest, inject, out, err) {
  const known = new Set(["--sprint", "--apply", "--json"]);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--sprint") i++;
    else if (!known.has(rest[i])) {
      err(`sprint review: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  const sprintTitle = value(rest, "--sprint");
  if (rest.includes("--sprint") && !sprintTitle) {
    err("sprint review: --sprint needs a title");
    return 2;
  }
  const apply = rest.includes("--apply");
  const json = rest.includes("--json");
  const review = await buildSprintReview({
    now: inject.now ?? Date.now(),
    fetcher: inject.fetcher ?? ghFetcher(),
    laneRows: inject.laneRows ?? readCosts({ lanesOnly: true }).rows,
    sprintTitle,
    apply,
    // Printed before the first write, so what is about to change is on screen first.
    beforeWrite: (r, mutations) => {
      if (json) return;
      out(`--apply: about to write ${r.moves.length} move(s), carry-over only, no re-prioritising:`);
      for (const line of moveLines(r)) out(line);
      for (const m of mutations) out(`  mutation: ${m}`);
    },
  });
  if (json) out(JSON.stringify(review, null, 2));
  else for (const line of renderReview(review, { apply })) out(line);
  return review.exit;
}
