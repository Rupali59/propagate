/**
 * The rules-restatement census, cached for the SessionStart hook (#283).
 *
 * WHY: `hooks/load-rules.mjs` used to run the whole restatement scan at every session start, resume,
 * clear and compact. Profiled 2026-11-15: 24-27 s per run, of which ~6 s was `readdirSync` walking the
 * search roots and ~14 s was the fingerprint regexes (nested `(?:.|\n){0,250}?` lookaheads) over every
 * CLAUDE.md. A hook that blocks a session start for that long is a tax on every session.
 *
 * SHAPE: the CLI (`propagate rules check`) computes the census and writes it here; the hook only reads
 * it, as session-guide reads sessions/checkouts.json. This module imports nothing heavy, so the hook
 * can load it without paying for config.mjs or the scanner. The scan itself (`computeCensus`) loads
 * those lazily and is called only by the CLI.
 *
 * ABSENCE IS ATTRIBUTABLE: no cache is rendered as a one-line "not computed" notice, never as silence
 * and never as a slow scan.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../core/paths.mjs";

export function censusFile() {
  return path.join(stateDir(), "rules", "census.json");
}

/** Run the same scan the hook used to run inline, reduced to what the banner needs. */
export async function computeCensus() {
  const { checkRulesAdjudicated } = await import("./rules-check.mjs");
  const { SEARCH_ROOTS, INTEGRATIONS } = await import("../core/config.mjs");
  const { CLAUDE_RULES } = await import("../core/paths.mjs");
  const r = checkRulesAdjudicated({
    rulesDir: CLAUDE_RULES,
    roots: SEARCH_ROOTS,
    registryFile: INTEGRATIONS.healthExceptionsFile,
  });
  return {
    diagnostic: r.diagnostic,
    missing: r.missing ?? [],
    filesScanned: r.filesScanned,
    failing: (r.failing ?? []).map((f) => ({ file: f.file, line: f.lines?.[0] ?? null, rule: f.rule })),
    acceptedCount: r.accepted?.length ?? 0,
    stale: r.stale ?? [],
    registryFile: INTEGRATIONS.healthExceptionsFile,
  };
}

export function writeCensus(census, file = censusFile()) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), census }, null, 2));
  renameSync(tmp, file);
  return file;
}

/** @returns {{at: string, census: object}|null} null when absent or unreadable. */
export function readCensus(file = censusFile()) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && j.census && typeof j.census === "object" ? j : null;
  } catch {
    return null;
  }
}

/** The banner text for a census: byte-identical to what the hook printed when it scanned inline. */
export function formatDrift(r) {
  let drift = "";
  // A registry that is missing or broken is NOT a reason to go quiet or to fail the scan.
  const registryUnusable = r.diagnostic === "registry-missing" || r.diagnostic === "registry-broken";
  const diagnostic = registryUnusable ? "ok" : r.diagnostic;
  if (diagnostic && diagnostic !== "ok" && diagnostic !== "no-files-scanned") {
    drift =
      `\n\n⚠️  RULES CHECK could not run: ${diagnostic}` +
      (r.missing?.length ? ` (missing roots: ${r.missing.join(", ")})` : "") +
      `. The scan was INCOMPLETE — this is not "no drift".`;
  } else if (diagnostic !== "no-files-scanned" && r.failing.length > 0) {
    const lines = r.failing
      .slice(0, 10)
      .map((f) => `  - ${f.file}${f.line ? `:${f.line}` : ""} restates rule:${f.rule}`);
    drift =
      `\n\n⚠️  ${r.failing.length} RESTATEMENT(S) of a canonical rule, across ` +
      `${r.filesScanned} file(s) scanned:\n${lines.join("\n")}` +
      (r.failing.length > 10 ? `\n  (+${r.failing.length - 10} more)` : "") +
      `\nReference the rule as \`rule:<id>\` instead, or declare a deviation in that ` +
      `file's own CLAUDE.md. Copying is what produced 9 divergent copies of ` +
      `tool-priority making 4 mutually exclusive claims.`;
  }
  if (r.acceptedCount) {
    drift += `\n\n_${r.acceptedCount} accepted restatement(s), see health-exceptions.yml (${r.registryFile})._`;
  }
  if (r.stale?.length) {
    drift += `\n\n⚠️  STALE accepted-restatement entr${r.stale.length === 1 ? "y" : "ies"} in health-exceptions.yml: ${r.stale.join(", ")}. The finding no longer fails; remove the entry.`;
  }
  return drift;
}
