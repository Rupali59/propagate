/**
 * fold.mjs — doctor's DEFAULT view: the rendered lines, folded (#107).
 *
 * WHY IT FOLDS THE RENDERED LINES, NOT THE REPORTER. Same reason as
 * structure.mjs (read its header): about 31 doctor `console.log` calls never
 * touch a Reporter, so a fold at the Reporter would drop whole sections while
 * looking whole. Folding the captured text makes the default view a FUNCTION OF
 * the full view, so the two cannot disagree about what was found.
 *
 * WHAT IS FOLDED, AND WHAT NEVER IS.
 *   - `✗` fail, `?` inconclusive, `?!` unknown kind: kept VERBATIM. Never grouped,
 *     never counted away. These are the lines that vote on the exit code.
 *   - `!` warn: grouped by label within a section. One stays verbatim; N become a
 *     single `! <label> ×N  <first detail> (+N-1 more: doctor --full)` line.
 *   - `✓` pass, `·` info and marker-less notes: one count line per section.
 *   - A line `classifyLine` cannot place (blank, unindented, the verdict line) is
 *     KEPT in place. An unclassifiable line is a line nobody understood, and
 *     dropping it is how a reader loses output it never knew existed
 *     (rule:discernment-checks §6).
 *
 * NOT DONE HERE, NAMED: a severity threshold (warnings at or above S2 shown
 * individually). The rendered lines do not carry the module's SEVERITY, and
 * mapping a section to its module is its own change (#136).
 *
 * The module prints nothing and holds no ANSI of its own (cli/ansi.mjs header:
 * lib/ takes input and returns data). Colours arrive as `style`.
 */

import { classifyLine, stripAnsi, actionSuffix } from "./structure.mjs";

// `?` (inconclusive) and `?!` (unknown kind) are not markers classifyLine knows:
// it files them as "note". Recognised here so they are kept, not counted away.
const MUST_KEEP = /^\s{2}(?:✗|\?!|\?)\s/;

/** Split captured console.log arguments into physical lines (a header arrives as "\n# Name"). */
function physicalLines(lines) {
  return (lines ?? []).flatMap((l) => String(l ?? "").split("\n"));
}

/**
 * @param {string[]} captured  what doctor's console.log received, one entry per call
 * @param {{dim?:string, yellow?:string, reset?:string}} [style]  ANSI strings; empty = plain
 * @returns {string[]} the folded view, first line the "showing folded view" notice
 */
export function foldDoctorLines(captured, style = {}) {
  const { dim = "", yellow = "", reset = "" } = style;
  const all = physicalLines(captured);

  // A section is a run of lines from one header to the next. Lines before the
  // first header form an anonymous leading run, kept the same way.
  const out = [];
  let run = null; // { items: [{raw}|{group}], counts: {ok, info}, groups: Map }
  const flush = () => {
    if (!run) return;
    const { items, ok, info } = run;
    const bits = [];
    if (ok) bits.push(`${ok} ok`);
    if (info) bits.push(`${info} info`);
    // Count line goes right under the header so a reader sees the tally first.
    // A run before any header has no header to sit under; the count leads it.
    const header = run.headerAt === -1 ? [] : items.splice(0, 1);
    out.push(...header.map((i) => i.raw));
    if (bits.length) out.push(`  ${dim}\u00b7 ${bits.join(" \u00b7 ")} (doctor --full)${reset}`);
    for (const it of items) {
      if (it.raw !== undefined) out.push(it.raw);
      else {
        const g = it.group;
        if (g.count === 1) out.push(g.firstRaw);
        else {
          const act = g.first.action ? dim + actionSuffix(g.first.action) + reset : "";
          out.push(
            `  ${yellow}!${reset} ${g.first.label} ×${g.count}` +
              `${g.first.detail ? "  " + dim + g.first.detail + reset : ""}` +
              `  ${dim}(+${g.count - 1} more: doctor --full)${reset}${act}`,
          );
        }
      }
    }
    run = null;
  };
  const start = () => ({ items: [], ok: 0, info: 0, groups: new Map(), headerAt: -1 });

  for (const raw of all) {
    const plain = stripAnsi(raw);
    const e = classifyLine(raw);

    if (e && e.kind === "header") {
      flush();
      run = start();
      run.items.push({ raw });
      run.headerAt = 0;
      continue;
    }
    if (!run) run = start();

    if (!e || MUST_KEEP.test(plain) || e.kind === "fail") {
      run.items.push({ raw });
    } else if (e.kind === "pass") {
      run.ok += 1;
    } else if (e.kind === "info" || e.kind === "note") {
      run.info += 1;
    } else if (e.kind === "warn") {
      const g = run.groups.get(e.label);
      if (g) g.count += 1;
      else {
        const group = { count: 1, first: e, firstRaw: raw };
        run.groups.set(e.label, group);
        run.items.push({ group });
      }
    } else {
      run.items.push({ raw }); // a kind this file has no rule for: keep it
    }
  }
  flush();

  const head = (n) =>
    `${dim}showing folded view: ${n} lines of ${all.length} (doctor --full for all)${reset}`;
  return [head(out.length + 1), ...out];
}
