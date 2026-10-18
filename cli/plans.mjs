/**
 * plans.mjs — `propagate plans --check`.
 *
 * Renders what `lib/report/plans.mjs` derives: which markdown files are plans,
 * whether each is live / finished / undeclared, and — for plans authored on or
 * after `.templates/PLAN.md` landing (2026-09-14) — whether it conforms to the
 * template's `## Goal state` contract. READ-ONLY: no plan is written, no
 * `Derived by:` command is ever run.
 *
 * Import prefix is `../lib/…` from here — G60: a specifier copied out of
 * cli.mjs is relative to the REPO ROOT and fails only at runtime.
 */

import path from "node:path";

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import { checkPlans, planCounts, TEMPLATE_LANDED } from "../lib/report/plans.mjs";

function short(file, cwd) {
  const home = process.env.HOME ?? "";
  if (file.startsWith(cwd)) return file.slice(cwd.length + 1) || ".";
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

const STATE_COLOUR = { live: GREEN, finished: DIM, undeclared: YELLOW };
const GRADE_COLOUR = { conforms: GREEN, partial: YELLOW, flagged: RED };

export async function plansCmd(argv = []) {
  const json = argv.includes("--json");
  const cwd = process.cwd();

  const rootArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      const p = argv[i + 1];
      i += 1;
      if (!p) {
        console.error("plans: --root needs a path");
        return 2;
      }
      rootArgs.push(path.resolve(cwd, p));
    }
  }

  // No --root: the in-repo default corpus, classified through doc-kind KINDS.
  // Any --root given: EXTERNAL roots, classified by path alone (D2b) — never
  // combined silently with the default, so `--root` always means "instead of",
  // not "in addition to", and a caller who wants both says so explicitly by
  // passing the repo root too.
  const specs = rootArgs.length
    ? rootArgs.map((p) => ({ path: p, external: true }))
    : [{ path: cwd, external: false }];

  const report = checkPlans(specs);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    const bad = report.results.some((r) => !r.ok);
    const badFile = report.results.some((r) => r.ok && r.plans.some((p) => p.unreadable));
    return bad || badFile ? 1 : 0;
  }

  console.log(`${BOLD}# plans${RESET}  ${DIM}(read-only; a Derived by: command is printed, never run)${RESET}`);

  let anyInvalid = false;
  let anyUnreadable = false;

  for (const r of report.results) {
    const label = r.external ? `${short(r.root, cwd)} ${DIM}(--root, path-classified)${RESET}` : `${short(r.root, cwd)} ${DIM}(in-repo)${RESET}`;
    console.log(`\n${BOLD}${label}${RESET}`);

    if (!r.ok) {
      anyInvalid = true;
      console.log(`  ${RED}✗ ${r.reason}${RESET}  ${DIM}${r.detail}${RESET}`);
      continue;
    }

    if (r.empty) {
      // "root scanned, nothing found" and "root does not exist" must never
      // read the same — rule:discernment-checks §2.
      console.log(`  ${DIM}${r.scanned} markdown file(s) scanned under this root — none classified as a plan.${RESET}`);
      if (r.dropped.length) console.log(`  ${DIM}not fully walked: ${r.dropped.length} subtree(s) — see --json for paths${RESET}`);
      continue;
    }

    console.log(`  ${DIM}${r.scanned} markdown file(s) scanned · ${r.plans.length} classified as plan(s)${RESET}`);
    if (!r.external && r.excluded.length) {
      console.log(
        `  ${DIM}${r.excluded.length} file(s) under a plans/ dir excluded by the classifier ` +
          `(no dated basename, or frontmatter overrode it — see --json)${RESET}`,
      );
    }
    if (r.hubReason !== undefined) {
      console.log(`  ${DIM}hub: ${r.hubReason}${RESET}`);
    }
    if (r.dropped.length) console.log(`  ${DIM}not fully walked: ${r.dropped.length} subtree(s)${RESET}`);

    for (const p of r.plans) {
      if (p.unreadable) {
        anyUnreadable = true;
        console.log(`  ${RED}✗ unreadable${RESET}  ${short(p.file, cwd)}  ${DIM}${p.reason}${RESET}`);
        continue;
      }
      const col = STATE_COLOUR[p.state] ?? RESET;
      const dateNote = p.authoredDate.date
        ? `${p.authoredDate.date} (${p.authoredDate.source})`
        : `${RED}date unknown${RESET}`;
      const gateNote = p.authoredDate.date === null
        ? ""
        : p.gated
          ? ` · ${GRADE_COLOUR[p.grade]}${p.grade}${RESET}`
          : ` · ${DIM}exempt, pre-${TEMPLATE_LANDED}${RESET}`;
      console.log(`  ${col}${p.state.padEnd(11)}${RESET} ${short(p.file, cwd)}  ${DIM}${dateNote}${RESET}${gateNote}`);
      console.log(`               ${DIM}${p.why}${RESET}`);
    }
  }

  const c = planCounts(report);
  console.log(`\n${BOLD}totals${RESET}  ${DIM}(by class, never one number)${RESET}`);
  console.log(
    `  class        ${GREEN}${c.live} live${RESET} · ${DIM}${c.finishedByArchiveDir + c.finishedByStatus} finished${RESET}` +
      ` (${c.finishedByArchiveDir} by archive/, ${c.finishedByStatus} by Status:) · ${YELLOW}${c.undeclared} undeclared${RESET}`,
  );
  if (c.finishedByArchiveDir === 0) {
    console.log(
      `  ${DIM}finished-by-archive/ is 0 — on this corpus it cannot be non-zero (0 plans live under archive/ or _archive/)${RESET}`,
    );
  }
  console.log(
    `  date gate    ${DIM}${c.exempt} exempt (authored before ${TEMPLATE_LANDED}) · ${c.dateUnknown} date unknown${RESET}` +
      `${c.dateUnknown > 0 ? `  ${RED}(attributable, not counted as exempt)${RESET}` : ""}`,
  );
  console.log(
    `  conformance  ${DIM}(gated plans only, ${c.conforms + c.partial + c.flagged} graded)${RESET}  ` +
      `${GREEN}${c.conforms} conforms${RESET} · ${YELLOW}${c.partial} partial${RESET} · ${RED}${c.flagged} flagged${RESET}`,
  );
  if (c.unreadable > 0) console.log(`  ${RED}${c.unreadable} unreadable${RESET}`);
  if (c.invalidRoots > 0) console.log(`  ${RED}${c.invalidRoots} root(s) invalid${RESET}`);

  return anyInvalid || anyUnreadable ? 1 : 0;
}
