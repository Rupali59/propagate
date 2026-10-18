/**
 * `propagate tasks export (--file <path> | --all) [--json]` — the READ-ONLY plan for moving open
 * register entries to GitHub issues (plan: ticklish-gathering-brook), and
 * `... --apply [--budget N]` — R2: do it, for TODOS.md and ISSUES.md registers.
 *
 * WITHOUT --apply THIS COMMAND WRITES NOTHING. No register, no state file, no gh write call; gh is
 * used for read calls only (`repo view`, cached per repo per run).
 *
 * WITH --apply it creates labels and issues, adds them to the repo's linked project, journals each
 * issue in `<state dir>/tasks-export.jsonl`, and rewrites a register only when every open item in
 * it has an issue. Handover files are skipped with a printed reason until R3. See lib/tasks/export.mjs.
 *
 * EXIT CODES: 0 plan printed / apply finished or stopped cleanly at the budget (held items are a
 * result, not a failure); 1 apply left a file failed or refused; 2 usage error or a population that
 * could not be planned.
 */
import path from "node:path";

import { CONFIG, HUB_ROOT } from "../lib/core/config.mjs";
import { stateDir } from "../lib/core/paths.mjs";
import { planExport, validateRoutes, BODY_LIMIT } from "../lib/tasks/plan.mjs";
import { applyExport, DEFAULT_BUDGET, DEFAULT_THROTTLE_MS } from "../lib/tasks/export.mjs";

const USAGE = "usage: propagate tasks export (--file <path> | --all) [--json] [--apply [--budget <n>]]";

/**
 * @param {string[]} [argv] everything after `tasks`
 * @param {typeof console} [io]
 * @returns {Promise<number>}
 */
export async function tasksCmd(argv = [], io = console) {
  if (argv[0] !== "export") {
    io.error("tasks: " + (argv[0] ? `unknown subcommand "${argv[0]}"` : "missing subcommand"));
    io.error(USAGE);
    return 2;
  }
  const rest = argv.slice(1);
  const apply = rest.includes("--apply");
  const bi = rest.indexOf("--budget");
  let budget = DEFAULT_BUDGET;
  if (bi !== -1) {
    if (!apply) {
      io.error("tasks export: --budget only means something with --apply");
      return 2;
    }
    budget = Number(rest[bi + 1]);
    if (!Number.isInteger(budget) || budget < 1) {
      io.error("tasks export: --budget needs a positive whole number");
      return 2;
    }
  }
  const asJson = rest.includes("--json");
  const all = rest.includes("--all");
  const fi = rest.indexOf("--file");
  const file = fi !== -1 ? rest[fi + 1] : null;
  if (fi !== -1 && (!file || file.startsWith("--"))) {
    io.error("tasks export: --file needs a path");
    io.error(USAGE);
    return 2;
  }
  if (!all && !file) {
    io.error("tasks export: name a population — --file <path> for one register or --all for every register");
    io.error(USAGE);
    return 2;
  }
  if (all && file) {
    io.error("tasks export: --file and --all are alternatives, not a pair");
    return 2;
  }

  const routes = CONFIG.tasks?.routes;
  const routesError = validateRoutes(routes);
  if (routesError) {
    io.error(`tasks export: ${routesError}`);
    return 2;
  }
  const plan = planExport({ file: file ? path.resolve(file) : null, all, hubRoot: HUB_ROOT, stateDirPath: stateDir(), routes });
  if (!plan.ok) {
    io.error(`tasks export: ${plan.error}`);
    return 2;
  }
  if (apply) {
    // PROPAGATE_TASKS_THROTTLE_MS exists for tests (a hermetic run must not wait 2 s per write).
    const envMs = Number(process.env.PROPAGATE_TASKS_THROTTLE_MS);
    const throttleMs = process.env.PROPAGATE_TASKS_THROTTLE_MS !== undefined && Number.isFinite(envMs) && envMs >= 0 ? envMs : DEFAULT_THROTTLE_MS;
    const res = await applyExport(plan, { stateDir: stateDir(), budget, throttleMs, edgeRoots: HUB_ROOT ? [HUB_ROOT] : [] });
    if (!res.ok) {
      io.error(`tasks export --apply: ${res.error}`);
      return 2;
    }
    if (asJson) io.log(JSON.stringify(res, null, 2));
    else renderApply(res, io);
    return res.problemFiles ? 1 : 0;
  }
  if (asJson) {
    io.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  render(plan, io);
  return 0;
}

function render(plan, io) {
  io.log(`tasks export — DRY RUN (no issue, label or register is written; gh is used for \`repo view\` only)`);
  io.log(`hub owner: ${plan.hubOwner ?? "(unknown — other-owner check skipped)"}`);
  io.log("");
  for (const f of plan.files) {
    const heldFile = f.held.map((h) => h.reason);
    const head = `${f.file}  [${f.kind}/${f.format}]`;
    if (!f.items.length && !f.held.length) {
      io.log(`${head}\n  ${f.note ?? "none open"}${skipText(f)}`);
      continue;
    }
    io.log(head);
    if (f.target) {
      io.log(
        `  target: ${f.target.repo}${f.target.error ? "" : `  (${f.target.visibility.toLowerCase()}, issues ${f.target.hasIssuesEnabled ? "on" : "OFF"}, owner ${f.target.owner})`}  project:${f.project}`,
      );
    }
    for (const n of f.notes ?? []) io.log(`  note: ${n}`);
    for (const h of f.held) io.log(`  HELD ${h.reason}: ${h.detail}`);
    if (f.fallback) io.log(`  proposed fallback target: ${f.fallback.repo} — ${f.fallback.reason}`);
    if (skipText(f)) io.log(`  ${skipText(f).trim()}`);
    for (const it of f.items) {
      const status = heldFile.length || it.held.length ? "HELD" : "plan";
      io.log(`  ${status}  ${it.id}  ${it.title}`);
      io.log(`        key=${it.key}  body=${it.bodyLength}/${BODY_LIMIT}  labels=${it.labels.join(",")}`);
      for (const h of it.held) io.log(`        HELD ${h.reason}: ${h.detail}`);
      if (it.scrub && Object.keys(it.scrub).length) {
        if (it.scrub.title) io.log(`        scrub title: ${JSON.stringify(it.scrub.title.before)} -> ${JSON.stringify(it.scrub.title.after)}`);
        if (it.scrub.labels) for (const l of it.scrub.labels) io.log(`        scrub label: ${l.before} -> ${l.after}`);
        if (it.scrub.body) {
          io.log(`        scrub body: ${it.scrub.body.changedLines} line(s) changed`);
          for (const s of it.scrub.body.samples) io.log(`          L${s.line}: ${JSON.stringify(s.before)} -> ${JSON.stringify(s.after)}`);
        }
      }
    }
    io.log("");
  }

  const s = plan.summary;
  io.log("per target repo");
  for (const r of s.repos) {
    io.log(`  ${r.repo}: ${r.items} item(s), ${r.held} held, ${r.planned} planned, ~${r.estimatedWrites} writes (${r.planned}x2 + ${r.labels} label creates, upper bound)`);
    for (const n of r.notes) io.log(`      note: ${n}`);
  }
  io.log("");
  io.log(
    `total: ${s.totalItems} item(s), ${s.totalHeld} held, ${s.totalPlanned} planned; ~${s.totalEstimatedWrites} writes vs ${s.writesPerHour}/hour => at least ${s.runsNeeded} run(s)`,
  );
}

function renderApply(res, io) {
  io.log(`tasks export --apply — ${res.date}; journal ${res.journal}`);
  for (const f of res.files) {
    const line = `${f.status.toUpperCase().padEnd(14)} ${f.file}`;
    io.log(line);
    if (f.reason) io.log(`    ${f.reason}`);
    else if (f.status === "rewritten") io.log(`    ${f.moved} of ${f.total} moved to ${f.repo} (${f.created} created, ${f.matched} matched); register rewritten`);
    for (const n of f.notes ?? []) io.log(`    note: ${n}`);
  }
  io.log("");
  io.log(`writes ${res.writes} of budget ${res.budget}${res.stoppedByBudget ? " — STOPPED at the budget; rerun to continue" : ""}`);
  if (res.remainingFiles) io.log(`${res.remainingFiles} file(s) still to do`);
  if (res.problemFiles) io.log(`${res.problemFiles} file(s) failed or were refused — see above; the register of each is untouched`);
  if (res.edges.length) {
    io.log("");
    io.log("declared .propagates.yml edges touching a rewritten file — run `propagate verify` (or `decouple`) for each:");
    for (const e of res.edges) io.log(e.error ? `  ${e.sidecar}: ${e.error}` : `  ${e.sidecar}: ${e.source} -> ${e.downstream}`);
  }
}

function skipText(f) {
  const k = Object.entries(f.skipped ?? {});
  return k.length ? `  (skipped: ${k.map(([s, n]) => `${n} ${s}`).join(", ")})` : "";
}
