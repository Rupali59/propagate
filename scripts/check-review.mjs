#!/usr/bin/env node
/**
 * check-review.mjs — the deterministic gate on an adversarial-reviewer report (propagate#251).
 *
 * WHY IT EXISTS. The reviewer's findings are judgment, and its report arrives in one confident register whether it
 * is right or wrong. Rupali, 2026-11-12: "if we are replacing a functionality, it better have a deterministic check
 * at the end". What IS deterministic: (1) COVERAGE, that it reviewed every edge declared for the artifact; (2) every
 * finding points at a real place; (3) a finding counts only when its demonstration re-runs to the stated result.
 *
 * CLAUSES
 *   coverage   edges_reviewed must equal, as a SET, the edges declared for the artifact (derived here from propagate's
 *              own reconcile, never from the report). Missing and extra ids are named. FAILS the run.
 *   place      a finding's `file` must exist and `line` must be within it. A finding pointing nowhere is REFUTED.
 *   demo       no demo_cmd or expect -> UNVERIFIED (listed, not counted, does not fail the run).
 *   read-only  a demo_cmd that agent-guard's decide() refuses for adversarial-reviewer -> UNVERIFIED with its reason.
 *              The same allowlist that bounds the agent bounds the re-run.
 *   result     a demo that runs but whose stdout does not match `expect` -> REFUTED. FAILS the run.
 *   vacuous    0 declared edges: coverage is vacuous, not complete (rule:adversarial-review-reads-the-ledger: a green
 *              on an undeclared artifact is not evidence). Fails unless --allow-undeclared.
 *
 * Exit: 0 coverage complete and nothing refuted; 1 coverage incomplete (or vacuous) or any refuted; 2 the input is
 * unreadable or the declared edges cannot be derived. Nothing here writes.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { decide } from "../hooks/agent-guard.mjs";

const AGENT = "adversarial-reviewer";
export const DEMO_TIMEOUT_MS = 30_000;

/**
 * @param {unknown} report  the agent's JSON
 * @param {{declaredEdges: string[], exists: (file: string) => boolean, lineCount: (file: string) => number,
 *          runDemo: (cmd: string) => {stdout: string, timedOut?: boolean}, decide?: Function, allowUndeclared?: boolean}} env
 */
export function checkReview(report, env) {
  const out = { ok: false, coverage: { ok: false, vacuous: false, missing: [], extra: [] }, verified: [], unverified: [], refuted: [] };
  const declared = new Set(env.declaredEdges);
  const guard = env.decide ?? decide;

  const reviewed = Array.isArray(report?.edges_reviewed) ? report.edges_reviewed : null;
  if (!reviewed) out.coverage.extra.push("(edges_reviewed is not an array)");
  const got = new Set(reviewed ?? []);
  out.coverage.missing = [...declared].filter((e) => !got.has(e)).sort();
  out.coverage.extra.push(...[...got].filter((e) => !declared.has(e)).map(String).sort());
  out.coverage.vacuous = declared.size === 0;
  out.coverage.ok =
    reviewed !== null && !out.coverage.missing.length && !out.coverage.extra.length && (!out.coverage.vacuous || !!env.allowUndeclared);

  const findings = Array.isArray(report?.findings) ? report.findings : [];
  findings.forEach((f, i) => {
    const label = typeof f?.finding === "string" ? f.finding : `(finding #${i + 1})`;
    const base = { finding: label, file: f?.file ?? null, line: f?.line ?? null };
    // place: a finding that points nowhere cannot be checked, and is wrong about what it claims to point at.
    if (typeof f?.file !== "string" || !env.exists(f.file)) return out.refuted.push({ ...base, reason: `file ${JSON.stringify(f?.file)} does not exist` });
    const n = env.lineCount(f.file);
    if (!Number.isInteger(f.line) || f.line < 1 || f.line > n) {
      return out.refuted.push({ ...base, reason: `line ${JSON.stringify(f.line)} is outside ${f.file} (${n} lines)` });
    }
    if (typeof f.demo_cmd !== "string" || !f.demo_cmd.trim() || typeof f.expect !== "string" || !f.expect) {
      return out.unverified.push({ ...base, reason: "no demo_cmd or expect: a finding with no demonstration does not count" });
    }
    let re;
    try {
      re = new RegExp(f.expect);
    } catch (err) {
      return out.unverified.push({ ...base, reason: `expect is not a valid regex: ${err.message}` });
    }
    const g = guard({ agent_type: AGENT, tool_name: "Bash", tool_input: { command: f.demo_cmd } });
    if (g.deny) return out.unverified.push({ ...base, reason: `demo refused (${g.reason})` });
    const r = env.runDemo(f.demo_cmd);
    if (r.timedOut) return out.unverified.push({ ...base, reason: `demo timed out after ${DEMO_TIMEOUT_MS / 1000}s` });
    if (re.test(String(r.stdout ?? ""))) out.verified.push(base);
    else out.refuted.push({ ...base, reason: `demo stdout did not match /${f.expect}/` });
  });

  out.ok = out.coverage.ok && out.refuted.length === 0;
  return out;
}

/** Derive the edges declared for an artifact from propagate's own reconcile: every state, either side of the edge. */
export async function deriveDeclaredEdges(artifact, cwd = process.cwd()) {
  const { defaultDeps } = await import("../lib/report/queue.mjs");
  const deps = await defaultDeps();
  const workspaces = await deps.loadWorkspaces();
  const { rows } = await deps.reconcile(workspaces, {});
  if (!Array.isArray(rows)) throw new Error("reconcile returned no rows");
  const abs = path.resolve(cwd, artifact);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    /* not on disk: literal form only */
  }
  const want = new Set([abs, real]);
  const edges = rows.filter((r) => want.has(r.source?.path) || want.has(r.downstream?.path)).map((r) => r.edge_id);
  return { edges: [...new Set(edges)], rowsScanned: rows.length };
}

const realEnv = (cwd, declaredEdges, allowUndeclared) => ({
  declaredEdges,
  allowUndeclared,
  exists: (f) => existsSync(path.resolve(cwd, f)),
  lineCount: (f) => {
    const s = readFileSync(path.resolve(cwd, f), "utf8");
    return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
  },
  // Only reached after decide() allowed the command: a read, no redirection, no substitution.
  runDemo: (cmd) => {
    const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", timeout: DEMO_TIMEOUT_MS });
    return { stdout: r.stdout ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
  },
});

export function render(artifact, r) {
  const L = [`check-review ${artifact}: ${r.ok ? "PASS" : "FAIL"}`];
  if (r.coverage.vacuous) L.push("  0 edges declared: coverage is vacuous, not complete");
  else L.push(`  coverage: ${r.coverage.ok ? "complete" : "INCOMPLETE"}`);
  for (const e of r.coverage.missing) L.push(`    MISSING ${e} (declared, not reviewed)`);
  for (const e of r.coverage.extra) L.push(`    EXTRA ${e} (reviewed, not declared for this artifact)`);
  L.push(`  verified (${r.verified.length})`);
  for (const f of r.verified) L.push(`    ok ${f.file}:${f.line} ${f.finding}`);
  L.push(`  unverified (${r.unverified.length}), listed, not counted`);
  for (const f of r.unverified) L.push(`    ?? ${f.file}:${f.line} ${f.finding} -- ${f.reason}`);
  L.push(`  refuted (${r.refuted.length})`);
  for (const f of r.refuted) L.push(`    XX ${f.file}:${f.line} ${f.finding} -- ${f.reason}`);
  return L;
}

export async function main(argv, io = console) {
  const allowUndeclared = argv.includes("--allow-undeclared");
  const asJson = argv.includes("--json");
  const [artifact, reportFile] = argv.filter((a) => !a.startsWith("--"));
  if (!artifact || !reportFile) {
    io.log("usage: node scripts/check-review.mjs <artifact> <report.json> [--allow-undeclared] [--json]");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch (err) {
    io.log(`check-review: cannot read report ${reportFile}: ${err?.code || err?.message}`);
    return 2;
  }
  let derived;
  try {
    derived = await deriveDeclaredEdges(artifact);
  } catch (err) {
    io.log(`check-review: cannot derive declared edges for ${artifact}: ${err?.message ?? err}`);
    return 2;
  }
  if (derived.rowsScanned === 0) {
    io.log("check-review: reconcile returned 0 rows, so the scan has gone blind; declared edges cannot be derived");
    return 2;
  }
  const r = checkReview(report, realEnv(process.cwd(), derived.edges, allowUndeclared));
  if (asJson) io.log(JSON.stringify(r));
  else for (const l of render(artifact, r)) io.log(l);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
