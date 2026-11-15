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

export function writeCensus(census, file = censusFile(), now = new Date()) {
  writeRecord({ at: now.toISOString(), status: "ran", census }, file);
  return file;
}

/** A check that could not run is recorded as such: never a count, never a clean-looking census. */
export function writeDidNotRun(why, file = censusFile(), now = new Date()) {
  writeRecord({ at: now.toISOString(), status: "did-not-run", why: String(why) }, file);
  return file;
}

function writeRecord(rec, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  renameSync(tmp, file);
}

/** Whether a computed census came from a check that actually ran (vs. had no rules to check with). */
export function censusRan(census) {
  return census.diagnostic !== "no-rules";
}

/** @returns {{at: string, census: object}|null} null when absent or unreadable. */
export function readCensus(file = censusFile()) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && j.status === "did-not-run" && j.at) return j;
    return j && j.census && typeof j.census === "object" ? { status: "ran", ...j } : null;
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

/**
 * The whole banner for a cache record: did-not-run, blind scan, or the census, always with its age.
 * `now` is injectable so staleness is testable without a clock.
 */
export function renderCensus(rec, now = new Date()) {
  if (rec.status === "did-not-run") {
    return `\n\n⚠️  RULES CHECK did not run at ${rec.at}: ${rec.why}. This is not "no drift".`;
  }
  const c = rec.census;
  const ageMs = now.getTime() - Date.parse(rec.at);
  const hours = Math.max(0, Math.floor(ageMs / 3600e3));
  const age = Number.isFinite(ageMs)
    ? ageMs < 3600e3 ? `${Math.max(0, Math.floor(ageMs / 60e3))}m` : `${hours}h`
    : "an unknown time";
  const stale = !Number.isFinite(ageMs) || ageMs > 24 * 3600e3;
  const blind =
    c.diagnostic === "no-files-scanned" || c.filesScanned === 0
      ? `\n\n⚠️  RULES CHECK scanned nothing: no CLAUDE.md was found under the search roots. This is a blind scan, not "no drift".`
      : "";
  const ageLine = `\n\n_rules census from ${age} ago${stale ? " — may be stale: run propagate rules check" : ""}._`;
  return formatDrift(c) + blind + ageLine;
}
