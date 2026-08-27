/**
 * registers.mjs — doctor's `# Registers` section.
 *
 * WHY THIS SECTION EXISTS. `# Backlog` answers "is every register READABLE and
 * every handover CLOSEABLE" — a correctness question. It says nothing about
 * whether a register has grown past the point where anyone opens it. Measured
 * 2026-08-27: propagate's own `ISSUES.md` stood at 2738 lines with 31 of its 62
 * entries already finished, and nothing anywhere reported that.
 *
 * WHY IT REPORTS BULK AND NOT ENTRIES. Same reasoning as `# Backlog`: printing
 * the rotatable entries would bury every other section. Counts are context, the
 * named files are the finding.
 *
 * WHAT IT MUST NOT BE READ AS. This is not evidence that the gotchas PUSH path
 * is degrading — measured the same day, it is not (see `lib/report/registers.mjs`
 * header). The cost being reported here is reading and context.
 *
 * WARN, NEVER FAIL. Size is warn-only everywhere in this tree by explicit
 * decision: a blocking size gate deadlocked `precommit-check.sh` until
 * 2026-08-19, because it read the committed ref and so could not see the fix
 * sitting in the working tree. An UNREAD register is different and DOES fail —
 * that is a reader that could not read, not a file that is merely large.
 *
 * RETURNS, NEVER MUTATES SHARED STATE (D4), like every other doctor module.
 */

/**
 * @param {{reporter: import("./reporter.mjs").Reporter, registersFn?: Function, gotchasSourcesFn?: Function, caps?: object}} deps
 * @returns {Promise<{counts: {registerFiles: number, rotatable: number, unread: number}}>}
 */
export async function checkRegisters({ reporter, registersFn, gotchasSourcesFn, caps = {} }) {
  reporter.header("# Registers");

  // Injectable for tests; the default is the real thing. The specifier is
  // `../registers.mjs` from lib/report/doctor/ — G60: a path copied out of
  // cli.mjs resolves to a different, non-existent file from here and fails only
  // at runtime, where this section's own catch would render it as one dim line.
  let registers = registersFn;
  let sourcesFor = gotchasSourcesFn;
  if (!registers) registers = (await import("../registers.mjs")).registers;
  if (!sourcesFor) sourcesFor = (await import("../../gotchas/parse.mjs")).sourcesFor;

  let result;
  try {
    // Gotchas are discovered relative to a cwd rather than walked tree-wide,
    // because `sourcesFor` answers "what would fire HERE" — a different question
    // from "every register that exists". Passing them explicitly keeps that
    // distinction visible rather than hiding it inside the walk.
    result = registers({ gotchasFiles: sourcesFor(process.cwd()) });
  } catch (err) {
    reporter.check("registers readable", false, `census threw — ${err.message}`);
    return { counts: { registerFiles: 0, rotatable: 0, unread: 0 } };
  }

  const t = result.totals;
  const hot = t.hot;

  reporter.info(
    "hot",
    `${hot.issues} open issue(s) · ${hot.handovers} open handover(s) · ${hot.todos} open todo(s) · ${hot.gotchas} live gotcha(s)`,
  );

  if (t.rotatableTotal === 0) {
    reporter.info("rotatable", "nothing finished is sitting in a hot register");
  } else {
    const parts = [];
    if (t.rotatable.issues) parts.push(`${t.rotatable.issues} resolved issue(s)`);
    if (t.rotatable.handovers) parts.push(`${t.rotatable.handovers} closed handover section(s)`);
    if (t.rotatable.todos) parts.push(`${t.rotatable.todos} checked todo(s)`);
    reporter.info("rotatable", `${parts.join(", ")} across ${result.rows.filter((r) => r.rotatable > 0).length} file(s)`);
  }

  // Reported separately from `rotatable` and never folded into it. A retired
  // gotcha is finished but is NOT bulk to move out — the entry is the argument
  // for why its fix exists (`lib/report/registers.mjs` LIFECYCLE.gotchas).
  if (t.retiredGotchas > 0) {
    reporter.info(
      "retired gotchas",
      `${t.retiredGotchas} — kept deliberately; a fixed hazard is still the argument for its fix`,
    );
  }

  // Any subtree the walk could not reach. Never silently omitted (G3), and
  // reported BY REASON — "hit the depth limit" and "ran out of time" are
  // different facts with different remedies, and attributing one to the other
  // is worse than saying nothing. Measured 2026-08-27: all 59 were the depth-6
  // limit hitting directories like `src/app/api/citations`, where a register
  // would never live; none was budget exhaustion. An earlier draft of this line
  // said "exceeded the walk budget" for all of them, which was simply untrue.
  if (t.dropped.length > 0) {
    const byReason = new Map();
    for (const d of t.dropped) {
      const why = (typeof d === "string" ? d : d.reason) ?? "unrecorded reason";
      byReason.set(why, (byReason.get(why) ?? 0) + 1);
    }
    const summary = [...byReason].map(([why, n]) => `${n} × ${why}`).join(" · ");
    reporter.info("not walked", summary);
  }

  // THE FAILING CONDITION. A register the census could not read is a reader that
  // failed, and it must be distinguishable from a register with nothing in it
  // (`rule:discernment-checks` §6). Named with its path, so it is actionable.
  const ok = reporter.check(
    "every register could be read",
    result.unread.length === 0,
    result.unread.length === 0
      ? undefined
      : `${result.unread.length} unread — ${result.unread.map((r) => `${r.file}: ${r.reason}`).join(" · ")}`,
  );

  // Warn-only, and only when a cap is actually configured for that kind. An
  // absent cap means "not budgeted", never "budget of zero".
  const { overCap } = await import("../registers.mjs");
  for (const row of overCap(result, caps)) {
    reporter.warn(`${row.file} is ${row.lines} lines (cap ${row.cap})`);
  }

  return {
    counts: { registerFiles: t.files, rotatable: t.rotatableTotal, unread: result.unread.length },
    ok,
  };
}
