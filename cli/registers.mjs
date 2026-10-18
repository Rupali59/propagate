/**
 * registers.mjs — `propagate registers`.
 *
 * Renders what `lib/report/registers.mjs` derives: which registers are hot,
 * which are carrying finished work, and which the reader could not read.
 * Report only — it never moves an entry, never writes an archive, never
 * touches a register. There is deliberately no `--apply`.
 *
 * WHY THERE IS NO WRITER. This command exists to answer whether rotation is
 * worth automating at all. `rule:enforcement-watches-itself` lists nine
 * mechanisms built in this tree that nothing ever invoked; a rotate verb run
 * twice a year would be the tenth, and the existing `archive/` convention plus
 * `git mv` already does the job. If this report shows rotation is a frequent,
 * mechanical chore, that is the evidence for building one — and it will be
 * evidence rather than a guess.
 *
 * Import prefix is `../lib/…` from here. G60: a specifier copied out of cli.mjs
 * is relative to the REPO ROOT, resolves to a different (non-existent) file from
 * this directory, and fails only at runtime.
 */

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import { registers, rotationCandidates, LIFECYCLE } from "../lib/report/registers.mjs";
import { sourcesFor } from "../lib/gotchas/parse.mjs";

function short(file, cwd) {
  const home = process.env.HOME ?? "";
  if (file.startsWith(cwd)) return file.slice(cwd.length + 1);
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

export async function registersCmd(argv = []) {
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const cwd = process.cwd();

  const result = registers({ gotchasFiles: sourcesFor(cwd) });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const t = result.totals;

  console.log(`${BOLD}# registers${RESET}  ${DIM}(read-only derivation; nothing is moved)${RESET}`);
  console.log(
    `  ${t.files} register(s) · ${t.hot.issues} open issue(s) · ${t.hot.handovers} open handover(s) · ` +
      `${t.hot.todos} open todo(s) · ${t.hot.gotchas} live gotcha(s)`,
  );

  // UNREAD FIRST, always. A register the census could not read is the only
  // finding here that is a defect rather than a workload, and burying it under
  // counts is how the two genuinely broken gotchas files nearly went unread on
  // 2026-08-27 (N54).
  if (result.unread.length > 0) {
    console.log(`\n  ${RED}unread (${result.unread.length})${RESET} ${DIM}— a reader that failed, not an empty file${RESET}`);
    for (const r of result.unread) {
      console.log(`    ${short(r.file, cwd)}`);
      console.log(`      ${DIM}${r.reason}${RESET}`);
    }
  }

  const candidates = rotationCandidates(result, { limit: all ? 1000 : 8 });
  if (candidates.length === 0) {
    console.log(`\n  ${GREEN}nothing finished is sitting in a hot register${RESET}`);
  } else {
    console.log(
      `\n  ${YELLOW}rotatable${RESET} ${DIM}— finished entries occupying a file people open for live work${RESET}`,
    );
    for (const c of candidates) {
      const label = LIFECYCLE[c.kind]?.finishedLabel ?? "finished";
      console.log(
        `    ${String(c.rotatable).padStart(4)} ${label.padEnd(8)} ${DIM}of ${c.entries} entries, ${c.lines} lines${RESET}  ${short(c.file, cwd)}`,
      );
    }
    console.log(
      `\n  ${DIM}Rotation is by hand: git mv the finished entries into ` +
        `<register-dir>/archive/<NAME>-YYYY-MM.md and leave an index line per id.${RESET}`,
    );
  }

  // Gotchas get their own line BECAUSE they never appear above. Without this,
  // a reader sees gotchas in the hot count, never in the rotatable list, and is
  // left to guess whether that is policy or a bug.
  console.log(
    `\n  ${DIM}gotchas: ${t.hot.gotchas} live, ${t.retiredGotchas} retired — never rotated. ` +
      `${LIFECYCLE.gotchas.whyNever}.${RESET}`,
  );

  if (t.dropped.length > 0) {
    const byReason = new Map();
    for (const d of t.dropped) {
      const why = (typeof d === "string" ? d : d.reason) ?? "unrecorded reason";
      byReason.set(why, (byReason.get(why) ?? 0) + 1);
    }
    console.log(`  ${DIM}not walked: ${[...byReason].map(([w, n]) => `${n} × ${w}`).join(" · ")}${RESET}`);
  }

  if (!all && result.rows.filter((r) => r.rotatable > 0).length > candidates.length) {
    console.log(`  ${DIM}--all for every register${RESET}`);
  }

  // Exit non-zero only for an unread register. Size is warn-only everywhere in
  // this tree by explicit decision (see doctor/registers.mjs).
  return result.unread.length > 0 ? 1 : 0;
}
