/**
 * retirement.mjs — doctor's `# Retirement candidates` section (#298, glance PR5).
 *
 * THE QUESTION. Which running systems has nobody adopted after a month, so that
 * someone has to answer "earned it, retire it, or not yet"? The answer comes from
 * `scanRetirement` in lib/report/adoption.mjs: the one SYSTEMS.md scan the digest
 * also reads, with the retirement rule (`classifyRetirementRows`) the glance also
 * imports. The rule is wider than the digest's adoption ask on purpose (two rules,
 * 2026-11-16). This section adds no parsing and no definition of its own.
 *
 * WHAT IT PRINTS. One `retirement candidate` warn per candidate (the label is the
 * kind and the id leads the detail, so the folded view groups them), one per `unknown: no start date` row, one
 * per unreadable SYSTEMS.md (with its path), and an info naming what was read and
 * how many worktree copies were counted once. With no SYSTEMS.md anywhere it prints
 * the blind-scan line, `retirement: no SYSTEMS.md found in N workspaces scanned`,
 * never "0 candidates": "looked at nothing" and "found nothing" are different facts.
 *
 * SEVERITY S3, warn-only. A candidate is a question for a human, not a fault, and
 * an unreadable table is a registry that needs a header, not a broken tree. Nothing
 * here votes on the exit code.
 *
 * RETURNS, NEVER MUTATES SHARED STATE (D4).
 */
export const SEVERITY = "S3";

import { scanRetirement, blindScanLine } from "../adoption.mjs";

/**
 * @param {{reporter: import("./reporter.mjs").Reporter, scan?: object, workspaces?: Array<{name: string, root: string}>, skillDir?: string|null, now?: number}} deps
 *   `scan` is injectable for tests; otherwise it is computed from workspaces + skillDir.
 * @returns {{scan: object}}
 */
export function checkRetirement({ reporter, scan, workspaces, skillDir, now = Date.now() }) {
  reporter.header("# Retirement candidates");

  if (!scan) {
    try {
      scan = scanRetirement({ workspaces, skillDir, now });
    } catch (err) {
      reporter.warn("retirement scan", `could not run: ${err.message}`);
      return { scan: null };
    }
  }

  if (scan.sources.length === 0 && scan.unreadable.length === 0) {
    reporter.warn(blindScanLine(scan), "nothing was read, so this is not a clean result");
    return { scan };
  }

  for (const u of scan.unreadable) {
    reporter.warn("SYSTEMS.md unreadable", `${u.path}: ${u.error.replace(/^unreadable: [^:]+: /, "")}`);
  }

  const copies = scan.duplicates.length;
  reporter.info(
    "sources",
    `${scan.sources.length} SYSTEMS.md read (${scan.scanned} workspaces scanned, plus propagate's own docs/)` +
      (copies ? `; ${copies} worktree or repeated copy(ies) counted once` : ""),
  );

  for (const c of scan.candidates) {
    const status = c.status.length > 40 ? `${c.status.slice(0, 40)}…` : c.status;
    reporter.warn(
      "retirement candidate",
      `${c.id} · ${c.workspace} · ${status} · first verified ${c.startDate} (${c.ageDays}d ago), adoption_date blank · earned it, retire it, or not yet? A human fills adoption_date.`,
    );
  }
  for (const u of scan.unknown) {
    reporter.warn("retirement candidate", `${u.id} · ${u.workspace} · ${u.status} · unknown: no start date (no date in last_verified)`);
  }
  if (scan.candidates.length === 0 && scan.unknown.length === 0 && scan.sources.length > 0) {
    const rows = scan.sources.reduce((n, s) => n + s.rows, 0);
    reporter.info("candidates", `none: no unadopted row among ${rows} row(s) in ${scan.sources.length} file(s) read`);
  }
  return { scan };
}
