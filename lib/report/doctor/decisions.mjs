/**
 * decisions.mjs — doctor's `# DECISIONS.md attribution` section.
 *
 * THE PILOT MODULE for the cli.mjs split (#31, T2). Chosen as the first
 * extraction because it is the smallest section that owns a complete,
 * DISJOINT accumulator set — all four `decisions*` values are written here and
 * read only by `# Metrics`. Nothing else in doctor touches them.
 *
 * WHAT THIS SECTION IS FOR (N12). The mechanism that records *why* a choice
 * was made must be able to read its own `Affects:` attribution field. A
 * non-empty DECISIONS.md where every entry parses to zero tokens means the
 * parser is reading nothing from content that exists — always a bug, and the
 * exact failure that shipped silently for weeks (all 8 live entries, 0 tokens)
 * before being caught by hand.
 *
 * WHERE THE ASSERTION LIVES, AND WHY NOT HERE. The `withTokens == entries`
 * verdict is owned solely by EXPECTATIONS (`lib/report/metrics.mjs`, GOTCHAS
 * G20) so there is ONE mechanism, not two that can disagree. This module
 * therefore reports the counts as `info` rather than voting on them.
 *
 * The one failure mode EXPECTATIONS cannot see stays here: a parse that
 * THROWS leaves entries=0 and withTokens=0, which reads as a satisfied
 * "0 == 0" — a green pass produced by the check never running. That is why the
 * catch below is a `check(..., false)` and not a `warn`.
 *
 * RETURNS, NEVER MUTATES SHARED STATE (D4). The orchestrator merges
 * `counts`/`details` into the run-level metrics. A dropped key then surfaces as
 * a missing property you can assert on, rather than a silent zero in the
 * `# Metrics` table — which is precisely the regression this split risks.
 */

/**
 * Severity of what this section reports (N87 slice 2b).
 *
 * Attribution of DECISIONS.md entries. A gap here costs archaeology later;
 * it never makes current state wrong.
 *
 *
 * Declared per SECTION, not per call site: doctor has 60 `reporter.check`
 * sites and 8 sections, and sixty judgements is a project nobody finishes. A
 * section whose checks genuinely span two severities should SPLIT — that is
 * normally a section doing two jobs.
 */
export const SEVERITY = "S3";

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { decisionsAttributionReport } from "../decisions.mjs";
import { isPointerStubText } from "../../migrate/workspace.mjs";
import { hubAbsentReason, hubStateFile } from "../../core/hub-state.mjs";

/**
 * @param {{skillDir: string, reporter: import("./reporter.mjs").Reporter}} deps
 * @returns {Promise<{
 *   counts: {decisionsEntries: number, decisionsWithTokens: number},
 *   details: {decisionsPath: string, decisionsZeroEntries: string[]},
 * }>}
 */
export async function checkDecisions({ skillDir, reporter }) {
  // THREE locations, the private hub first. Since 2026-10-19 (propagate #12) the real file is in
  // the private hub beside this checkout and what sits in the repo is a pointer stub, so a bare
  // existsSync picked the stub and parsed a 16-line signpost as "0 entries". The stub is skipped
  // by shape (isPointerStubText), and when no hub copy exists either, the check says so and does
  // not grade — "not present here" is not "0 entries" (rule:discernment-checks §2). The legacy
  // docs/ path is retained so an older checkout still resolves.
  const hubPath = hubStateFile(skillDir, "DECISIONS.md");
  const candidates = [
    ...(hubPath ? [hubPath] : []),
    path.join(skillDir, "propagation", "state", "workspace", "DECISIONS.md"),
    path.join(skillDir, "docs", "DECISIONS.md"),
  ];
  const isReal = (c) => {
    if (!existsSync(c)) return false;
    try {
      return !isPointerStubText(readFileSync(c, "utf8"));
    } catch {
      return true; // unreadable is reported below, by the read, not hidden here
    }
  };
  const decPath = candidates.find(isReal) ?? candidates[0];

  const counts = { decisionsEntries: 0, decisionsWithTokens: 0 };
  const details = { decisionsPath: decPath, decisionsZeroEntries: [] };

  try {
    if (!isReal(decPath)) {
      reporter.note(
        existsSync(decPath)
          ? `(DECISIONS.md is a pointer stub here — ${hubAbsentReason("propagation/state/propagate/DECISIONS.md")})`
          : `(no DECISIONS.md — tried ${candidates.join(", ")})`,
      );
      return { counts, details };
    }

    const text = await readFile(decPath, "utf8");
    const { entries, zero } = decisionsAttributionReport(text);

    counts.decisionsEntries = entries.length;
    counts.decisionsWithTokens = entries.length - zero.length;
    details.decisionsZeroEntries = zero.map((e) => `${e.date} ${e.title || "(untitled)"}`);

    reporter.info(
      "Affects: tokens parse",
      `${entries.length} entries, ${entries.length - zero.length} with tokens`,
    );
  } catch (err) {
    // The gap EXPECTATIONS cannot cover — see the module doc. A throw here must
    // fail the run, not fall through to a "0 == 0" that looks like health.
    reporter.check("Affects: tokens parse", false, err.message);
  }

  return { counts, details };
}
