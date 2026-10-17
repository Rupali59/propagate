/**
 * `propagate tasks export [--file <path> | --all] [--json]` — R1: the READ-ONLY plan for
 * moving open register entries to GitHub issues (plan: ticklish-gathering-brook).
 *
 * THIS COMMAND WRITES NOTHING. No register, no state file, no gh write call; the only gh call
 * is `gh repo view` (cached per repo per run). `--apply` is declared in the flag table so the
 * refusal below can name itself, and it is refused BEFORE any work happens: a flag that is
 * accepted and ignored is N69, and a flag that does the work half-way is worse. R2 builds it.
 *
 * EXIT CODES: 0 plan printed (held items are a result, not a failure); 2 usage error,
 * `--apply`, or a population that could not be planned.
 */
import path from "node:path";

import { HUB_ROOT } from "../lib/core/config.mjs";
import { stateDir } from "../lib/core/paths.mjs";
import { planExport, BODY_LIMIT } from "../lib/tasks/plan.mjs";

const USAGE = "usage: propagate tasks export (--file <path> | --all) [--json]";

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
  if (rest.includes("--apply")) {
    io.error("tasks export --apply: not built yet — R2. This release plans only; nothing was written.");
    return 2;
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

  const plan = planExport({ file: file ? path.resolve(file) : null, all, hubRoot: HUB_ROOT, stateDirPath: stateDir() });
  if (!plan.ok) {
    io.error(`tasks export: ${plan.error}`);
    return 2;
  }
  if (asJson) {
    io.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  render(plan, io);
  return 0;
}

function render(plan, io) {
  io.log(`tasks export — DRY RUN (R1: no issue, label or register is written; gh is used for \`repo view\` only)`);
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

function skipText(f) {
  const k = Object.entries(f.skipped ?? {});
  return k.length ? `  (skipped: ${k.map(([s, n]) => `${n} ${s}`).join(", ")})` : "";
}
