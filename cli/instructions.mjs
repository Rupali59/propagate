/**
 * instructions.mjs — `propagate instructions [--calibrate [--log <path>]] [--json]`.
 *
 * Read-only. The measurement is lib/report/instructions.mjs; this renders it. `doctor` asserts
 * and prints two info lines; this is where a person (or an agent, via --json) sees EVERY
 * directory and what dominates its load, so "which CLAUDE.md should I trim" has an answer.
 *
 * `--calibrate` compares an InstructionsLoaded hook log against the load set the model predicts
 * for each logged session cwd — a SET comparison naming the files that differ, because a total
 * can match while the files do not. A mismatch is a finding about the MODEL; it is reported,
 * never tuned toward.
 *
 * Exit: 0 report printed (and, for --calibrate, every session matched); 1 calibration mismatch;
 * 2 could not run (blind scan, no log) — "looked at nothing" is never exit 0.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SEARCH_ROOTS, INTEGRATIONS, STATE_DIR } from "../lib/core/config.mjs";
import { STATE_DIR_DEFAULT } from "../lib/core/paths.mjs";
import {
  DEFAULT_LIMIT,
  HARNESS_OBSERVED,
  instructionBudget,
  createBudgetModel,
  parseBudgetRegistry,
  evaluateBudget,
  calibrate,
} from "../lib/report/instructions.mjs";
import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";

const n = (x) => x.toLocaleString("en-US");
const tilde = (p) => (p ?? "").replace(os.homedir(), "~");

function value(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : (args[i + 1] ?? null);
}

export function defaultLogPath() {
  return path.join(STATE_DIR || STATE_DIR_DEFAULT, "instructions-loaded.jsonl");
}

/**
 * @param {string[]} args argv after the command name
 * @param {{roots?: string[], registryFile?: string|null, home?: string, out?: (s: string) => void}} [inject] tests
 * @returns {Promise<number>} exit code
 */
export async function instructionsCmd(args, inject = {}) {
  const out = inject.out ?? ((s) => console.log(s));
  const asJson = args.includes("--json");
  const roots = inject.roots ?? SEARCH_ROOTS;
  const registryFile = inject.registryFile === undefined ? INTEGRATIONS.instructionBudgetFile : inject.registryFile;
  const home = inject.home ?? os.homedir();

  if (args.includes("--calibrate")) {
    const logPath = value(args, "--log") ?? defaultLogPath();
    const result = calibrate({ logPath, model: createBudgetModel({ home }) });
    if (asJson) out(JSON.stringify(result, null, 2));
    else out(renderCalibration(result));
    if (result.status !== "ok") return 2;
    return result.mismatches === 0 ? 0 : 1;
  }

  let registry = null;
  let registryNote = null;
  if (registryFile && existsSync(registryFile)) {
    const parsed = parseBudgetRegistry(readFileSync(registryFile, "utf8"));
    if (parsed.problems.length) registryNote = `${tilde(registryFile)} is malformed (${parsed.problems.join("; ")}) — exceptions NOT applied`;
    else registry = { ...parsed, file: registryFile };
  } else {
    registryNote = `no exceptions registry (${registryFile ? `${tilde(registryFile)} missing` : "not configured"}) — every over-limit directory shows as unexcepted`;
  }
  const limit = registry?.limit ?? DEFAULT_LIMIT;
  const budget = instructionBudget({ home, roots, limit });
  const hub = registry ? path.resolve(path.dirname(registry.file), "..", "..") : null;
  const ev = registry ? evaluateBudget(budget, registry.entries, { hubRoot: hub, limit }) : null;
  const keyOf = (dir) => (hub ? path.relative(hub, dir) || "." : dir);

  if (asJson) {
    out(
      JSON.stringify(
        {
          status: budget.status,
          reason: budget.reason,
          unit: budget.unit,
          limit,
          harness_observed: HARNESS_OBSERVED,
          max: budget.max,
          worst_dir: budget.worst_dir,
          over: budget.over,
          excluded_chars: budget.excluded_chars,
          scan: budget.scan,
          inputs: budget.inputs,
          notes: budget.notes,
          registry: registry ? { file: registry.file, entries: registry.entries.size } : null,
          registry_note: registryNote,
          evaluation: ev,
          dirs: budget.dirs.map((r) => ({
            ...r,
            excepted: registry ? registry.entries.has(keyOf(r.dir)) : null,
            ceiling: registry?.entries.get(keyOf(r.dir))?.ceiling ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return budget.status === "ok" ? 0 : 2;
  }

  out(`${BOLD}Instruction budget${RESET}  ${DIM}chars loaded at session start, per directory owning a CLAUDE.md${RESET}`);
  out(`${DIM}limit ${n(limit)} chars (gate) · harness warning observed at ${n(HARNESS_OBSERVED)} on 2026-10-02, not a documented constant${RESET}`);
  out(`${DIM}scan: ${budget.scan.dirs} dirs · ${budget.scan.limits}${RESET}`);
  out(
    `${DIM}user-level: ${budget.inputs.rulesDir.files} rule file(s) under ${tilde(budget.inputs.rulesDir.path)}` +
      ` (${budget.inputs.rulesDir.path_scoped} path-scoped, not counted) · claudeMdExcludes saves ${n(budget.excluded_chars)} chars${RESET}`,
  );
  for (const note of budget.notes) out(`${YELLOW}!${RESET} ${note}`);
  if (registryNote) out(`${YELLOW}!${RESET} ${registryNote}`);
  if (budget.status !== "ok") {
    out(`${RED}✗${RESET} ${budget.reason}`);
    return 2;
  }
  out("");
  out(`  ${"total".padStart(8)}  ${"vs limit".padStart(9)}  status      directory  ${DIM}(largest file in the chain)${RESET}`);
  for (const r of budget.dirs) {
    const e = registry?.entries.get(keyOf(r.dir));
    const stat = r.total <= limit ? `${GREEN}ok${RESET}         ` : e ? (r.total > e.ceiling ? `${RED}>CEILING${RESET}   ` : `${YELLOW}excepted${RESET}   `) : `${RED}OVER${RESET}       `;
    const delta = r.total > limit ? `+${n(r.over_by)}` : `-${n(limit - r.total)}`;
    const b = r.biggest ? `${tilde(r.biggest.file)} ${n(r.biggest.chars)}` : "";
    out(`  ${n(r.total).padStart(8)}  ${delta.padStart(9)}  ${stat} ${tilde(r.dir)}  ${DIM}${b}${RESET}`);
  }
  out("");
  if (ev) {
    out(
      `${BOLD}${ev.unexcepted_over.length}${RESET} unexcepted over · ${BOLD}${ev.stale.length}${RESET} stale exception(s) · ` +
        `${BOLD}${ev.over_ceiling.length}${RESET} over ceiling · ${ev.excepted} excepted of ${ev.over} over`,
    );
    for (const s of ev.stale) out(`  ${YELLOW}stale${RESET} ${s.key}: ${s.reason}`);
  } else {
    out(`${BOLD}${budget.over}${RESET} of ${budget.dirs.length} directories over ${n(limit)}`);
  }
  return 0;
}

function renderCalibration(r) {
  if (r.status !== "ok") return `${RED}✗${RESET} calibrate: ${r.reason}`;
  const lines = [
    `${BOLD}Calibration${RESET}  ${DIM}${tilde(r.logPath)} · ${r.lines} line(s), ${r.badLines} unparseable${r.truncated ? " · TAIL ONLY (log larger than the read cap)" : ""}${r.capped ? " · newest sessions only" : ""}${RESET}`,
    `${DIM}set comparison of session_start loads vs the predicted load set, per session cwd${RESET}`,
  ];
  for (const s of r.results) {
    if (s.error) {
      lines.push(`  ${YELLOW}?${RESET} ${s.session_id.slice(0, 8)} ${tilde(s.cwd ?? "(no cwd)")} — ${s.error}`);
    } else if (s.match) {
      lines.push(`  ${GREEN}✓${RESET} ${s.session_id.slice(0, 8)} ${tilde(s.cwd)}  ${DIM}${s.predicted} predicted = ${s.logged} logged${RESET}`);
    } else {
      lines.push(`  ${RED}✗${RESET} ${s.session_id.slice(0, 8)} ${tilde(s.cwd)}  ${DIM}${s.predicted} predicted, ${s.logged} logged${RESET}`);
      for (const f of s.missing) lines.push(`      predicted, NOT logged: ${tilde(f)}`);
      for (const f of s.extra) lines.push(`      logged, NOT predicted: ${tilde(f)}`);
    }
  }
  lines.push(`${r.mismatches === 0 ? GREEN : RED}${r.mismatches}${RESET} mismatch(es) over ${r.sessions} session(s) — a mismatch is a finding about the model, not something to tune toward`);
  return lines.join("\n");
}
