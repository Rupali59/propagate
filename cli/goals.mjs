/**
 * goals.mjs — `propagate goals`.
 *
 * Renders what `lib/report/goals.mjs` derives: the arrival conditions declared
 * across the tree, whether each is open / closed / unknown, and — the axis
 * this command exists for — whether anyone could check it at all.
 *
 * `propagate goals` IS READ-ONLY AND RUNS NOTHING. Every `Derived by:` is printed
 * for a person to run; `tests/unit/goals.test.mjs` pins that with a canary.
 *
 * Two subcommands run commands, and only APPROVED ones (propagate#55; this
 * supersedes the earlier "no --apply and no --run", DECISIONS 2026-11-13):
 *
 *   goals allow <GOALS.md> <goal-id>   the owner approves one goal's exact command text.
 *                                      Its SHA-256 goes to $PROPAGATE_STATE_DIR/goals/trusted.json.
 *   goals check [--json]               read-only standing check (propagate#264): active-goal limit, appetite, board items
 *                                      carry a declared active goal and the fields that make them startable. Exit 0 / 1 / 2.
 *   goals check-done [--apply]       runs each TRUSTED command (bash -c, cwd = the repo
 *                                      root, 120 s or --timeout <s>); exit 0 = met. An untrusted or edited
 *                                      command is reported and never run. Judgement goals are
 *                                      never closed. --apply writes one `**Resolved:**` line
 *                                      per met goal; without it the files are untouched.
 *
 * `allow` is the trust decision, so propagate's agents may not run it
 * (hooks/agent-guard.mjs keeps every `goals` call out of their read list).
 *
 * Import prefix is `../lib/…` from here — G60: a specifier copied out of
 * cli.mjs is relative to the REPO ROOT and fails only at runtime.
 */

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseGoalsFile, goalCounts } from "../lib/report/goals.mjs";
import { discoverBacklogFiles } from "../lib/report/backlog.mjs";
import { checkGoals } from "../lib/report/goals-check.mjs";
import { readBoards, boardsForGoals } from "../lib/report/day.mjs";
import { ghFetcher } from "./sprint.mjs";
import { RUN_TIMEOUT_MS, allow, readTrust, planChecks, runDerived, repoRoot, writeResolved, trustPath } from "../lib/report/goals-run.mjs";

function short(file, cwd) {
  const home = process.env.HOME ?? "";
  if (file.startsWith(cwd)) return file.slice(cwd.length + 1);
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

const STATUS_COLOUR = { open: YELLOW, closed: GREEN, parked: DIM, unknown: RED };

/** `goals allow <file> <goal-id>`: approve one command. Exit 0 approved, 2 not found or no command. */
export function allowCmd(argv, { now = new Date() } = {}) {
  const [file, id] = argv.filter((a) => !a.startsWith("--"));
  if (!file || id == null) {
    console.error("usage: propagate goals allow <GOALS.md> <goal-id>");
    return 2;
  }
  const abs = path.resolve(file);
  const parsed = parseGoalsFile(abs);
  if (parsed.unread) {
    console.error(`${abs}: ${parsed.reason}`);
    return 2;
  }
  const e = parsed.entries.find((x) => String(x.n) === String(id));
  if (!e) {
    console.error(`${abs}: no goal ${id} (goals here: ${parsed.entries.map((x) => x.n).join(", ")})`);
    return 2;
  }
  if (e.derivation !== "claimed" || !e.command) {
    console.error(`goal ${id} names no Derived by: command (${e.derivation}); nothing to approve`);
    return 2;
  }
  const h = allow({ file: abs, goal: id, cmd: e.command, now });
  console.log(`approved goal ${id} in ${abs}`);
  console.log(`  command: ${e.command.split("\n").join("\n           ")}`);
  console.log(`  sha256 ${h.slice(0, 12)} in ${trustPath()}. An edit to the command makes it untrusted again.`);
  return 0;
}

/**
 * `goals check-done [--apply] [--json]`. Exit 0 when every trusted command ran
 * (met or not); 1 when a write was refused; 2 when no GOALS.md was found.
 */
export function checkDoneCmd(argv, { files, now = new Date(), run = runDerived, root = repoRoot } = {}) {
  const apply = argv.includes("--apply");
  const json = argv.includes("--json");
  const ti = argv.indexOf("--timeout");
  const timeout = ti === -1 ? RUN_TIMEOUT_MS : Number(argv[ti + 1]) * 1000;
  if (!(timeout > 0)) {
    console.error("--timeout takes a number of seconds");
    return 2;
  }
  const paths = files ?? discoverBacklogFiles().goalsMd ?? [];
  if (!paths.length) {
    console.error("no GOALS.md found under the search roots: an empty scan, not a clean one");
    return 2;
  }
  const store = readTrust();
  const date = now.toISOString().slice(0, 10);
  const results = [];
  let refused = 0;
  for (const file of paths) {
    const parsed = parseGoalsFile(file);
    if (parsed.unread) {
      results.push({ file, unread: true, reason: parsed.reason });
      continue;
    }
    const met = [];
    for (const e of planChecks(parsed, store)) {
      const r = { file, n: e.n, title: e.title, outcome: e.outcome, command: e.command ?? null };
      if (e.outcome === "run") {
        Object.assign(r, run(e.command, root(file), { timeout }));
        r.outcome = r.met ? "met" : "unmet";
        if (r.met) met.push(e);
      }
      results.push(r);
    }
    // THE --apply GUARD. Everything above reads; the write is below it, and only here.
    if (!apply || !met.length) continue;
    let text = readFileSync(file, "utf8");
    // Last section first: sections are counted by heading, so order is only for readability of the diff.
    for (const e of [...met].sort((a, b) => b.section - a.section)) {
      const line = `**Resolved:** ${date} · derived: \`${e.command.split("\n").join(" && ")}\` exited 0 (propagate goals check-done)`;
      const next = writeResolved(text, e.section, line);
      if (next === null) {
        refused += 1;
        results.find((x) => x.file === file && x.n === e.n).written = false;
        continue;
      }
      text = next;
      results.find((x) => x.file === file && x.n === e.n).written = true;
    }
    writeFileSync(file, text);
  }

  if (json) {
    console.log(JSON.stringify({ generatedAt: now.toISOString(), apply, results }, null, 2));
    return refused ? 1 : 0;
  }
  const n = (o) => results.filter((r) => r.outcome === o).length;
  console.log(`${BOLD}# goals check-done${RESET}  ${DIM}(${apply ? "--apply: met goals get a Resolved line" : "dry run: no file is written"})${RESET}`);
  console.log(`  ${GREEN}${n("met")} met${RESET} · ${n("unmet")} unmet · ${YELLOW}${n("untrusted")} untrusted${RESET} · ${n("judgement")} need a person · ${n("parked")} parked · ${n("closed")} already closed`);
  for (const r of results) {
    if (r.unread) console.log(`  ${RED}unread${RESET} ${short(r.file, process.cwd())}: ${r.reason}`);
    else if (r.outcome === "met" || r.outcome === "unmet") {
      const col = r.outcome === "met" ? GREEN : YELLOW;
      const w = r.written === true ? " · Resolved written" : r.written === false ? ` ${RED}· section not found, nothing written${RESET}` : "";
      console.log(`  ${col}${r.outcome.padEnd(9)}${RESET} ${r.n} · ${r.title}  ${DIM}${short(r.file, process.cwd())}: ${r.reason}${RESET}${w}`);
    } else if (r.outcome === "untrusted") {
      console.log(`  ${YELLOW}untrusted${RESET} ${r.n} · ${r.title}  ${DIM}not run; approve with: propagate goals allow ${r.file} ${r.n}${RESET}`);
    }
  }
  if (!apply && n("met")) console.log(`${DIM}pass --apply to write the ${n("met")} Resolved line(s).${RESET}`);
  return refused ? 1 : 0;
}

/**
 * `goals check [--json]` (propagate#264). Exit 0 pass, 1 violations, 2 could not check (no GOALS.md, or the boards
 * could not be read: a blind scan is never a pass). `fetcher` is injectable for tests.
 */
export async function checkCmd(argv, { files, fetcher, now = Date.now(), out = (s) => console.log(s), err = (s) => console.error(s) } = {}) {
  const json = argv.includes("--json");
  for (const a of argv) {
    if (a !== "--json") {
      err(`goals check: unknown argument ${a}`);
      return 2;
    }
  }
  const paths = files ?? discoverBacklogFiles().goalsMd ?? [];
  const parsed = paths.map((f) => (typeof f === "string" ? parseGoalsFile(f) : f));
  if (!parsed.length) {
    err("goals check: no GOALS.md found under the search roots: an empty scan, not a clean one");
    return 2;
  }
  const read = await readBoards({ fetcher: fetcher ?? ghFetcher(), now, count: () => {} });
  if (read.stop) {
    err(`goals check: could not read the boards: ${read.stop}`);
    return 2;
  }
  const result = checkGoals({ files: parsed, boards: boardsForGoals(read), now });
  if (result.blind) {
    err(`goals check: ${result.blind}`);
    return 2;
  }
  if (json) {
    out(JSON.stringify({ generatedAt: new Date(now).toISOString(), ...result }, null, 2));
    return result.ok ? 0 : 1;
  }
  const c = result.counts;
  out(`${BOLD}# goals check${RESET}  ${DIM}(read-only)${RESET}`);
  out(`  ${c.files} file(s) · ${c.goals} goal(s) · ${c.active} active · ${c.boards} board(s) · ${c.itemsChecked} Ready / In progress item(s) checked`);
  for (const v of result.violations) out(`  ${RED}violation${RESET} [${v.clause}] ${v.subject}: ${v.reason}`);
  for (const n of result.notChecked) out(`  ${YELLOW}not checked${RESET} ${n}`);
  out(result.ok ? `${GREEN}pass${RESET}: no violations (the not-checked lines above are not passes)` : `${RED}${result.violations.length} violation(s)${RESET}`);
  return result.ok ? 0 : 1;
}

export async function goalsCmd(argv = []) {
  if (argv[0] === "allow") return allowCmd(argv.slice(1));
  if (argv[0] === "check-done") return checkDoneCmd(argv.slice(1));
  if (argv[0] === "check") return checkCmd(argv.slice(1));
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
      `${counts.open} open · ${counts.closed} closed · ${counts.parked} parked · ${counts.unknown} unknown`,
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
