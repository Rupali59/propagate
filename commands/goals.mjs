/**
 * goals.mjs — `propagate goals`.
 *
 * Renders what `lib/report/goals.mjs` derives: the arrival conditions declared
 * across the tree, whether each is open / closed / unknown, and — the axis
 * this command exists for — whether anyone could check it at all.
 *
 * READ-ONLY, AND IT DOES NOT RUN THE COMMANDS. Every `Derived by:` is printed
 * for a person to run. Executing them would mean running shell written inside
 * a markdown file, which `lib/report/handovers.mjs` refuses in those words and
 * `tests/unit/goals.test.mjs` pins with a canary. There is deliberately no
 * `--apply` and no `--run`.
 *
 * Import prefix is `../lib/…` from here — G60: a specifier copied out of
 * cli.mjs is relative to the REPO ROOT and fails only at runtime.
 */

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import { parseGoalsFile, goalCounts } from "../lib/report/goals.mjs";
import { discoverBacklogFiles } from "../lib/report/backlog.mjs";

function short(file, cwd) {
  const home = process.env.HOME ?? "";
  if (file.startsWith(cwd)) return file.slice(cwd.length + 1);
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

const STATUS_COLOUR = { open: YELLOW, closed: GREEN, unknown: RED };

export async function goalsCmd(argv = []) {
  const json = argv.includes("--json");
  const cwd = process.cwd();

  const discovery = discoverBacklogFiles();
  const files = (discovery.goalsMd ?? []).map(parseGoalsFile);
  const counts = goalCounts(files);

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), counts, files }, null, 2));
    return counts.uncheckable > 0 || counts.unread > 0 ? 1 : 0;
  }

  console.log(`${BOLD}# goals${RESET}  ${DIM}(read-only; Derived by: commands are printed, never run)${RESET}`);

  // "No GOALS.md anywhere" and "GOALS.md everywhere, all empty" are different
  // facts, and neither is a pass (`rule:discernment-checks` §2).
  if (files.length === 0) {
    console.log(
      `  ${DIM}no GOALS.md found under the search roots — an empty scan, not a clean one.${RESET}`,
    );
    console.log(
      `  ${DIM}A direction with no arrival condition cannot be reported as met or unmet.${RESET}`,
    );
    return 0;
  }

  console.log(
    `  ${counts.files} file(s) · ${counts.total} goal(s) — ` +
      `${counts.open} open · ${counts.closed} closed · ${counts.unknown} unknown`,
  );
  console.log(
    `  ${DIM}derivation:${RESET} ${counts.claimed} name a command · ${counts.waived} declare themselves judgement · ` +
      (counts.uncheckable > 0 ? `${RED}${counts.uncheckable} neither${RESET}` : `${GREEN}0 neither${RESET}`),
  );
  console.log();

  for (const f of files) {
    console.log(`${BOLD}${short(f.file, cwd)}${RESET}`);
    if (f.unread) {
      // A file the reader could not understand is NOT zero goals.
      console.log(`  ${RED}✗${RESET} unread  ${DIM}${f.reason}${RESET}`);
      console.log();
      continue;
    }
    for (const e of f.entries) {
      const col = STATUS_COLOUR[e.status] ?? RED;
      console.log(`  ${col}${e.status.padEnd(7)}${RESET} ${e.n} · ${e.title}`);
      if (e.derivation === "claimed") {
        // Multi-line commands print one per line. Flattening them onto one line
        // is how a `#` comment ends up swallowing the command after it.
        const lines = String(e.command ?? "").split("\n");
        console.log(`          ${DIM}derived by:${RESET} ${lines[0]}`);
        for (const extra of lines.slice(1)) console.log(`                      ${extra}`);
      } else if (e.derivation === "waived") {
        console.log(`          ${DIM}judgement — no command claimed, and it says so${RESET}`);
      } else {
        // The defect this command exists to find.
        console.log(
          `          ${RED}UNCHECKABLE${RESET} ${DIM}— asserts an arrival condition with no` +
            ` \`Derived by:\`, and does not declare itself judgement${RESET}`,
        );
      }
    }
    console.log();
  }

  if (counts.unknown > 0) {
    console.log(
      `${DIM}unknown = neither \`Done when:\` nor \`Resolved:\`. Nobody has said what would finish it —${RESET}`,
    );
    console.log(`${DIM}which is not the same as done, and must never render as done.${RESET}`);
  }
  if (counts.uncheckable > 0) {
    console.log(
      `${RED}${counts.uncheckable} goal(s) cannot be checked by anyone.${RESET} ${DIM}Add a \`Derived by:\`` +
        ` command, or say \`Judgement, not derivable:\` and why — "no command exists" and${RESET}`,
    );
    console.log(`${DIM}"nobody wrote one" are different facts.${RESET}`);
  }

  return counts.uncheckable > 0 || counts.unread > 0 ? 1 : 0;
}
