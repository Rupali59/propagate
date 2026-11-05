/**
 * services.mjs — `propagate services [--json] [--service <id>] [--workspace <name>]`.
 *
 * Renders what `lib/report/services.mjs` derives. OFFLINE and read-only: no network, no write, no
 * secret file opened. Exit 0 clean, 1 findings, 2 could not run (including a blind scan).
 *
 * Import prefix is `../lib/…` from here (G60).
 */

import { RESET, DIM, RED, GREEN, YELLOW, BOLD } from "./ansi.mjs";

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

export async function servicesCmd(argv = []) {
  const json = argv.includes("--json");
  const service = flagValue(argv, "--service");
  const workspace = flagValue(argv, "--workspace");
  for (const f of ["--service", "--workspace"]) {
    if (argv.includes(f) && !flagValue(argv, f)) {
      console.error(`${RED}error:${RESET} ${f} needs a value`);
      return 2;
    }
  }

  const { WORKSPACES, INTEGRATIONS } = await import("../lib/core/config.mjs");
  const { buildServicesReport, MIN_UNITS } = await import("../lib/report/services.mjs");
  const envFloor = Number(process.env.PROPAGATE_SERVICES_MIN_UNITS);
  const report = buildServicesReport({
    workspaces: WORKSPACES,
    integrations: INTEGRATIONS,
    minUnits: Number.isFinite(envFloor) && process.env.PROPAGATE_SERVICES_MIN_UNITS ? envFloor : MIN_UNITS,
    service,
    workspace,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.exit;
  }

  if (report.state === "could-not-run") {
    console.log(`${RED}could-not-run${RESET} ${DIM}— ${report.reason}${RESET}`);
    for (const p of report.problems ?? []) console.log(`  ${DIM}- ${p}${RESET}`);
    return 2;
  }

  console.log(`${BOLD}# services${RESET}  ${DIM}(offline; ${report.units_scanned} unit(s) scanned, floor ${report.floor})${RESET}`);
  for (const s of report.services) {
    const tag = s.status === "stub" ? ` ${DIM}stub${RESET}` : "";
    console.log(`\n${BOLD}${s.id}${RESET}${tag}  ${s.unit_count} unit(s)`);
    for (const u of s.units) {
      console.log(`  ${u.workspace}/${u.unit}  ${DIM}${u.evidence.map((e) => `${e.kind}:${e.detail}`).join(", ")}${RESET}`);
    }
  }
  console.log(`\n${BOLD}# findings${RESET}`);
  if (report.findings.length === 0) {
    console.log(`  ${GREEN}none${RESET}`);
  } else {
    for (const f of report.findings) {
      console.log(`  ${YELLOW}${f.state}${f.cause ? `/${f.cause}` : ""}${RESET}  ${DIM}${f.detail}${RESET}`);
    }
  }
  return report.exit;
}
