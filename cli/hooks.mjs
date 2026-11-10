/**
 * hooks.mjs — `propagate hooks instructions-gate [--apply] [--owned <a,b>] [--json]` (propagate#221).
 *
 * Dry run by default: derives every repo that tracks CLAUDE.md / AGENTS.md / GEMINI.md and reports what
 * adding the instruction-budget gate to its pre-commit WOULD do. `--apply` performs exactly the listed
 * actions on OWNED repos only (origin owner in the allowlist), never commits, never pushes.
 *
 * Allowlist: `--owned` > env PROPAGATE_HOOKS_OWNED_REMOTES (comma-separated) > config.yml `hooks.ownedRemotes`.
 * Empty (the default) means report only: nothing is owned, so `--apply` writes nothing.
 *
 * Exit: 0 report printed (and, for --apply, every action done); 2 could not run (blind scan, an action failed).
 */
import os from "node:os";

import { CONFIG, SEARCH_ROOTS, WORKSPACES } from "../lib/core/config.mjs";
import { planInstructionGate, applyPlan, willAct } from "../lib/report/hooks-gate.mjs";
import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";

function value(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

/** The owner allowlist and where it came from. */
export function ownedRemotes(args = [], env = process.env, config = CONFIG) {
  const split = (s) => String(s).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const cli = value(args, "--owned");
  if (cli !== null) return { owned: split(cli), source: "--owned" };
  if (env.PROPAGATE_HOOKS_OWNED_REMOTES) return { owned: split(env.PROPAGATE_HOOKS_OWNED_REMOTES), source: "PROPAGATE_HOOKS_OWNED_REMOTES" };
  const c = config?.hooks?.ownedRemotes;
  if (Array.isArray(c) && c.length) return { owned: c.map((x) => String(x).trim().toLowerCase()).filter(Boolean), source: "config.yml hooks.ownedRemotes" };
  return { owned: [], source: "none configured" };
}

const tilde = (p) => (p ?? "").replace(os.homedir(), "~");

function verdict(row) {
  if (row.action === "unreadable") return "unreadable";
  if (!row.owned) return "not owned: skipped";
  return { create: "would create", append: "would append", wire: "would wire", none: "nothing", "skip-external": "skipped (external hooksPath)", "skip-shebang": "skipped (not a shell hook)" }[row.action];
}

export async function hooksCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const sub = args[0];
  if (sub !== "instructions-gate") {
    console.error("usage: propagate hooks instructions-gate [--apply] [--owned <a,b>] [--json]");
    return 2;
  }
  const rest = args.slice(1);
  const apply = rest.includes("--apply");
  const asJson = rest.includes("--json");
  const { owned, source } = inject.owned ? { owned: inject.owned, source: "injected" } : ownedRemotes(rest);

  const plan = planInstructionGate({ roots: inject.roots ?? SEARCH_ROOTS, workspaces: inject.workspaces ?? WORKSPACES, owned, repos: inject.repos, minRepos: inject.minRepos ?? 1 });
  if (plan.blind) {
    console.error(`${RED}hooks instructions-gate: ${plan.reason}${RESET}`);
    return 2;
  }

  let applied = [];
  let failed = null;
  if (apply) {
    try {
      applied = applyPlan(plan.rows);
    } catch (e) {
      failed = e;
    }
  }

  const count = (f) => plan.rows.filter(f).length;
  const summary = {
    scanned: plan.scanned, tracking_instruction_files: plan.rows.length, not_tracking: plan.excluded,
    owned: count((r) => r.owned), not_owned: count((r) => !r.owned),
    would_act: count(willAct), nothing_to_do: count((r) => r.owned && r.action === "none"),
    skipped_owned: count((r) => r.owned && (r.action.startsWith("skip") || r.action === "unreadable")),
    unreadable: count((r) => r.action === "unreadable"),
    allowlist: owned, allowlist_source: source, applied: applied.length,
  };

  if (asJson) {
    out(JSON.stringify({ apply, summary, rows: plan.rows.map((r) => ({ ...r, verdict: verdict(r) })) }, null, 2));
  } else {
    out(`${BOLD}Instruction-gate hooks${RESET}  ${DIM}${apply ? "APPLY" : "dry run"} · repos tracking CLAUDE.md / AGENTS.md / GEMINI.md${RESET}`);
    out(`${DIM}owner allowlist: ${owned.length ? owned.join(", ") : "(empty: report only, --apply writes nothing)"} [${source}]${RESET}`);
    out("");
    const w = Math.max(4, ...plan.rows.map((r) => r.repo.length));
    out(`  ${"repo".padEnd(w)}  ${"owner".padEnd(14)}  ${"hooksPath".padEnd(12)}  pre-commit  gate  action`);
    for (const r of plan.rows) {
      const act = r.owned ? (r.action === "none" ? `${GREEN}nothing${RESET}` : `${YELLOW}${verdict(r)}${RESET}`) : `${DIM}${verdict(r)}${RESET}`;
      out(`  ${r.repo.padEnd(w)}  ${(r.owner ?? "(no origin)").padEnd(14)}  ${(r.hooksPath ?? "(unset)").padEnd(12)}  ${(r.hookExists ? "exists" : "absent").padEnd(10)}  ${(r.hasGate ? "yes" : "no").padEnd(4)}  ${act}`);
      if (r.owned && r.action !== "none") out(`  ${" ".repeat(w)}  ${DIM}${tilde(r.detail)}${RESET}`);
    }
    out("");
    out(`${summary.scanned} repos scanned · ${summary.tracking_instruction_files} track an instruction file (${summary.not_tracking} do not) · ` +
      `${summary.owned} owned, ${summary.not_owned} not owned · ${summary.would_act} would change · ${summary.nothing_to_do} already gated`);
    if (apply) out(`${GREEN}applied ${applied.length} change(s)${RESET}; nothing was committed or pushed. Commit the hook in each repo yourself.`);
    else if (summary.would_act) out(`${DIM}Dry run: nothing was written. Re-run with --apply to perform the ${summary.would_act} listed change(s).${RESET}`);
  }
  if (failed) {
    console.error(`${RED}hooks instructions-gate: apply failed: ${failed.message}${RESET}`);
    return 2;
  }
  return 0;
}
