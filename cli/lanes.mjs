/**
 * `propagate lane-checks [--repo <dir>] [--json]` (propagate#453): run the repo's `.lane-checks`, the checks a lane
 * must run before it reports. Format and exit codes: lib/lanes/lane-checks.mjs. 0 pass, 1 a check failed, 2 could
 * not run (no file, an empty list, a missing path, a command that cannot start).
 */
import path from "node:path";

import { gitRootOf, runLaneChecks } from "../lib/lanes/lane-checks.mjs";

const USAGE = "usage: propagate lane-checks [--repo <dir>] [--json]";

/** @param {string[]} args argv after `lane-checks` @returns {Promise<number>} */
export async function laneChecksCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const err = inject.err ?? ((s) => console.error(s));
  let repo = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--repo" && args[i + 1] && !args[i + 1].startsWith("--")) repo = args[++i];
    else { err(`lane-checks: unknown argument ${args[i]}\n${USAGE}`); return 2; }
  }
  const root = gitRootOf(path.resolve(repo ?? process.cwd()));
  if (!root) { err(`lane-checks: ${repo ?? process.cwd()} is not inside a git repo`); return 2; }
  const r = runLaneChecks(root);
  if (json) { out(JSON.stringify({ root, ...r }, null, 2)); return r.exit; }
  if (r.reason) err(`lane-checks: ${r.reason}`);
  for (const e of r.entries) {
    out(`${e.status === "pass" ? "PASS" : e.status === "fail" ? "FAIL" : "ERROR"}  ${e.entry}${e.detail ? `\n      ${e.detail.replace(/\n/g, "\n      ")}` : ""}`);
  }
  if (!r.reason) out(`lane-checks: ${r.entries.filter((e) => e.status === "pass").length}/${r.entries.length} passed (exit ${r.exit})`);
  return r.exit;
}
