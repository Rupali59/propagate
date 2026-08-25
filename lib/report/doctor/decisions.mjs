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

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { decisionsAttributionReport } from "../decisions.mjs";

/**
 * @param {{skillDir: string, reporter: import("./reporter.mjs").Reporter}} deps
 * @returns {Promise<{
 *   counts: {decisionsEntries: number, decisionsWithTokens: number},
 *   details: {decisionsPath: string, decisionsZeroEntries: string[]},
 * }>}
 */
export async function checkDecisions({ skillDir, reporter }) {
  // Both locations, new first. The plugin's own artifacts moved to
  // propagation/state/workspace/ on 2026-08-23; the legacy path is retained so
  // an older checkout still resolves, and so this reports "not found" only when
  // it genuinely is not there rather than when it merely moved.
  const candidates = [
    path.join(skillDir, "propagation", "state", "workspace", "DECISIONS.md"),
    path.join(skillDir, "docs", "DECISIONS.md"),
  ];
  const decPath = candidates.find((c) => existsSync(c)) ?? candidates[0];

  const counts = { decisionsEntries: 0, decisionsWithTokens: 0 };
  const details = { decisionsPath: decPath, decisionsZeroEntries: [] };

  try {
    if (!existsSync(decPath)) {
      reporter.note(`(no DECISIONS.md — tried ${candidates.join(", ")})`);
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
