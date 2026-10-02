/**
 * instructions.mjs — doctor's `# Instruction budget` section.
 *
 * THE MEASUREMENT lives in lib/report/instructions.mjs (pure, tested without doctor); this is
 * the glue that resolves the exceptions registry, prints two info lines and hands three scalar
 * counts back for `doctor`'s metrics object. The ASSERTIONS on those counts live in
 * `EXPECTATIONS` (lib/report/metrics.mjs) and nowhere else — one fact, one assertion (G20),
 * which is why this section carries one scan-health check and no verdict of its own.
 *
 * REGISTRY ABSENT => SKIP, STATED. A fresh machine has no `instruction-budget.yml` and no
 * instruction load of the author's to judge, and CI's "fresh-machine install reaches
 * doctor-clean" must stay clean. The three keys are still EMITTED, as `null`, so the
 * vanished-key guard (cli.mjs R6) does not read a skip as a collector that stopped. `null`
 * passes the expectation on purpose and the info line says why; a registry that RESOLVES but
 * whose scan is blind or malformed fails a check instead, so a skip can never hide a break.
 */

/**
 * Severity of what this section reports (N87 slice 2b). S3: a context-size regression costs
 * tokens and attention, and fails loudly in doctor — it never loses data or lies silently.
 */
export const SEVERITY = "S3";

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_LIMIT,
  HARNESS_OBSERVED,
  instructionBudget,
  parseBudgetRegistry,
  evaluateBudget,
} from "../instructions.mjs";

const n = (x) => x.toLocaleString("en-US");

/** `<hub-relative dir>` for display, falling back to the absolute path. */
function rel(hub, dir) {
  const r = path.relative(hub, dir);
  return r === "" ? "." : r.startsWith("..") ? dir : r;
}

/**
 * @param {object} opts
 * @param {{header: Function, check: Function, info: Function}} opts.reporter
 * @param {string[]} opts.roots
 * @param {string|null} opts.registryFile    INTEGRATIONS.instructionBudgetFile
 * @param {string} [opts.home]
 * @param {object} [opts.settings]
 * @param {string|null} [opts.managedDir]
 * @param {number} [opts.minDirs]
 * @returns {{metrics: Record<string, number|null>, context: object}}
 */
export function checkInstructions({ reporter, roots, registryFile, home, settings, managedDir, minDirs }) {
  reporter.header("# Instruction budget");
  const metrics = {
    "instructions.unexcepted_over": null,
    "instructions.stale_exceptions": null,
    "instructions.over_ceiling": null,
    "instructions.chars.max": null,
  };
  const context = { unexcepted: [], stale: [], overCeiling: [] };

  if (!registryFile || !existsSync(registryFile)) {
    reporter.info(
      "instruction budget",
      `skipped — no exceptions registry (${registryFile ? `${registryFile} does not exist` : "not configured"}); ` +
        "set PROPAGATE_INSTRUCTION_BUDGET_FILE or integrations.instructionBudgetFile. " +
        "Not measured, which is different from within budget. `propagate instructions` still runs.",
    );
    return { metrics, context };
  }

  const parsed = parseBudgetRegistry(readFileSync(registryFile, "utf8"));
  if (parsed.problems.length) {
    reporter.check("instruction-budget registry parses", false, `${registryFile}: ${parsed.problems.join("; ")}`);
    return { metrics, context };
  }
  const limit = parsed.limit ?? DEFAULT_LIMIT;
  const hub = path.resolve(path.dirname(registryFile), "..", "..");

  const budget = instructionBudget({ home, roots, settings, managedDir, limit, ...(minDirs ? { minDirs } : {}) });
  if (budget.status !== "ok") {
    reporter.check("instruction budget scan covers the tree", false, budget.reason);
    return { metrics, context };
  }
  reporter.check(
    "instruction budget scan covers the tree",
    true,
    `${budget.scan.dirs} director${budget.scan.dirs === 1 ? "y" : "ies"} owning a CLAUDE.md, ${parsed.entries.size} listed exception(s)`,
  );

  const ev = evaluateBudget(budget, parsed.entries, { hubRoot: hub, limit });
  metrics["instructions.unexcepted_over"] = ev.unexcepted_over.length;
  metrics["instructions.stale_exceptions"] = ev.stale.length;
  metrics["instructions.over_ceiling"] = ev.over_ceiling.length;
  metrics["instructions.chars.max"] = budget.max;
  context.unexcepted = ev.unexcepted_over.map((u) => `${rel(hub, u.dir)} ${n(u.total)} (+${n(u.over_by)})`);
  context.stale = ev.stale.map((s) => `${s.key}: ${s.reason}`);
  context.overCeiling = ev.over_ceiling.map((o) => `${rel(hub, o.dir)} ${n(o.total)} > ceiling ${n(o.ceiling)} (+${n(o.over_by)})`);

  const biggest = (b) => {
    if (!b?.file) return "n/a";
    const r = path.relative(hub, b.file);
    return `${r.startsWith("..") ? b.file.replace(os.homedir(), "~") : r} ${n(b.chars)}`;
  };
  const wu = ev.worst_unexcepted;
  reporter.info(
    "instruction budget",
    wu
      ? `worst unexcepted: ${rel(hub, wu.dir)} ${n(wu.total)} / ${n(limit)} (${wu.headroom >= 0 ? `${n(wu.headroom)} headroom` : `+${n(-wu.headroom)} OVER`})` +
          ` · biggest in chain: ${biggest(wu.biggest)}` +
          ` · ${ev.over} dir(s) over, ${ev.excepted} excepted · all: propagate instructions`
      : "every directory is listed as an exception — nothing unexcepted to rank",
  );
  const w = ev.worst;
  if (w) {
    reporter.info(
      "instruction budget (worst overall)",
      `${rel(hub, w.dir)} ${n(w.total)} chars${w.total > limit ? ` (+${n(w.total - limit)} over ${n(limit)}${w.excepted ? ", excepted" : ""})` : ""}` +
        ` · limit ${n(limit)} chars, 5k under the ${n(HARNESS_OBSERVED)} the harness warning was observed to fire at (2026-10-02)`,
    );
  }
  if (budget.notes.length) reporter.info("instruction budget inputs", budget.notes.join("; "));
  return { metrics, context };
}
