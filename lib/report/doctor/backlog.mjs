/**
 * backlog.mjs — doctor's `# Backlog` section.
 *
 * WHY THIS SECTION EXISTS. Until 2026-08-26 `backlog()` had exactly ONE caller:
 * the `propagate backlog` command. Edges get three delivery channels — `doctor`,
 * `monitor`, and the pre-commit hook — while todos, issues and handovers got
 * none. That is why the ISSUES.md discovery path survived a whole layout move
 * unnoticed: nothing looked unless a human remembered to look.
 *
 * WHY IT REPORTS DEFECTS AND NOT THE LIST. There were 500 open items on the day
 * this landed. Printing them here would bury doctor's other sections and teach
 * the reader to skip the section, which is the same outcome as not having it.
 * The section reports COUNTS as context and NAMES only the defects — the same
 * shape the gotchas section uses, where "14 files present" is context and
 * "5 cannot fire" is the finding.
 *
 * THE DEFINITION OF A DEFECT IS NOT HERE. It is `backlogDefects()` in
 * `lib/report/backlog.mjs`, shared with `monitor`. Two commands deciding
 * separately what counts as a problem is how `graph` and `drain` once reported
 * 23 and 21 for the same question (`lib/report/monitor.mjs:89`).
 *
 * ORDER OF OPERATIONS MATTERS HERE, and it is the reason this section did not
 * ship a day earlier: the item model was wrong (priority BUCKET LABELS reported
 * as work, the tasks under them dropped — 174 items where 343 existed). A wrong
 * number broadcast through doctor and monitor is worse than the same wrong
 * number sitting quietly in a command nobody runs. Delivery came second, on
 * purpose.
 *
 * RETURNS, NEVER MUTATES SHARED STATE (D4), like every other doctor module.
 */

/**
 * @param {{reporter: import("./reporter.mjs").Reporter, backlogFn?: Function, defectsFn?: Function}} deps
 * @returns {Promise<{counts: {backlogOpenItems: number, backlogDefects: number, backlogFilesRead: number}}>}
 */
export async function checkBacklog({ reporter, backlogFn, defectsFn }) {
  reporter.header("# Backlog");

  // Injectable for tests; the default is the real thing. Relative specifier is
  // `../backlog.mjs` from lib/report/doctor/ — G60: a path copied out of
  // cli.mjs resolves to a different, non-existent file from here, fails only at
  // runtime, and this section's own try/catch would report it as one dim line.
  let backlog = backlogFn;
  let backlogDefects = defectsFn;
  if (!backlog || !backlogDefects) {
    const mod = await import("../backlog.mjs");
    backlog = backlog || mod.backlog;
    backlogDefects = backlogDefects || mod.backlogDefects;
  }

  let result;
  try {
    result = backlog();
  } catch (err) {
    // A probe that could not run is a THIRD state, distinct from pass and fail
    // (rule:discernment-checks §2). Reported as a failure, not a warning,
    // because "0 defects" from a walk that threw is indistinguishable from a
    // clean tree — and only one of those is health.
    reporter.check("backlog readable", false, `discovery threw — ${err.message}`);
    return { counts: { backlogOpenItems: 0, backlogDefects: 0, backlogFilesRead: 0 } };
  }

  const t = result.totals ?? {};
  const filesRead = (t.stateFilesRead ?? 0) + (t.todoFilesRead ?? 0) + (t.issueFilesRead ?? 0);
  const handoverFiles = result.handovers?.files?.length ?? 0;

  reporter.info(
    "sources",
    `${t.stateFilesRead ?? 0} STATE.md · ${t.todoFilesRead ?? 0} TODOS.md · ${t.issueFilesRead ?? 0} ISSUES.md · ${handoverFiles} handover file(s)`,
  );
  reporter.info("open items", `${t.parsedItems ?? 0} across ${t.parsedFiles ?? 0} parsed file(s)`);

  const defects = backlogDefects(result);
  const ok = reporter.check(
    "every register can be read and every handover can be closed",
    defects.length === 0,
    defects.length === 0 ? "" : `${defects.length} file(s) hold work no count can see`,
  );
  if (!ok) {
    for (const d of defects) {
      reporter.note(`    ${d.kind}  ${d.file}`);
      reporter.note(`      ${d.detail}`);
    }
  }

  // Absence stays ATTRIBUTABLE but does not vote. "0 files read" is reported so
  // a reader can tell an empty scan from a clean one, and that is the whole
  // requirement — rule:discernment-checks §2 asks for the two to be
  // distinguishable, not for one of them to be a failure.
  //
  // This WAS a `check(..., false)` for one commit and it was wrong: a workspace
  // that genuinely holds no STATE.md or TODOS.md — a fresh install, a small
  // repo, every doctor test fixture — reads 0 files and is perfectly healthy.
  // It turned three passing fixture tests red. "Could not look" is a real
  // failure and it is already caught above, where discovery THROWS; "looked and
  // there is nothing" is an answer, not a fault. Conflating them is the same
  // over-reach as a stub detector that swallows real registers.
  if (filesRead === 0) {
    reporter.info("no backlog files found", "0 STATE.md/TODOS.md/ISSUES.md under the search roots — an empty scan, not a failed one");
  }

  return {
    counts: {
      backlogOpenItems: t.parsedItems ?? 0,
      backlogDefects: defects.length,
      backlogFilesRead: filesRead,
    },
  };
}
