/**
 * The seam that keeps this skill from becoming a second doc taxonomy.
 *
 * propagate/docs/GOTCHAS.md G20: a second mechanism duplicates the first unless you
 * delete the first. So the kinds, the frontmatter reader, supersession parsing and the
 * broken-citation extension rules are IMPORTED from propagate, never restated here. The
 * precedent is ~/.claude/hooks/doc-authority.mjs, which already imports propagate's libs
 * from outside the skill.
 *
 * WHEN PROPAGATE IS ABSENT THIS FAILS LOUD. It must never fall back to a local guess:
 * a silent local re-implementation is exactly how the second copy gets born, and per
 * rule:discernment-checks §2 absence must be attributable. Callers get a thrown
 * TaxonomyUnavailable carrying the paths that were tried.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** This module's own directory — the anchor for the co-located propagate lookup. */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
import { pathToFileURL } from "node:url";

export class TaxonomyUnavailable extends Error {
  constructor(tried) {
    super(
      `taxonomy: unavailable (propagate's lib/doc-kind.mjs not found)\n` +
        tried.map((t) => `  tried: ${t}`).join("\n") +
        `\n  set PROPAGATE_SKILL_DIR to propagate's root, or install it at ~/.claude/skills/propagate`,
    );
    this.name = "TaxonomyUnavailable";
    this.tried = tried;
  }
}

/**
 * `lib/report/` FIRST, `lib/` second. propagate reorganised its lib/ into subdirectories
 * and doc-kind.mjs moved to lib/report/; this list still named only the old path, so every
 * test in this skill threw TaxonomyUnavailable. The failure was loud and correct — a
 * relocation the export-surface assertion below could not have caught, because the module
 * never loaded at all. Only the list was stale.
 *
 * The old path is retained, not replaced: an older propagate install still resolves. Both
 * appear in TaxonomyUnavailable.tried, so the next relocation prints every path attempted
 * rather than only the one someone remembered to update.
 *
 * `selfDir` is the co-located anchor, and it is INJECTABLE for two reasons that both trace
 * back to the same hazard: the co-located candidate always resolves on this checkout, which
 * makes "propagate is absent" unconstructible through env alone — the exact "a guard that
 * cannot fire is worse than no guard" shape (rule:discernment-checks §1).
 *   - An explicit third argument lets a unit test force a nonexistent anchor directly
 *     (tests/taxonomy.test.mjs — "an absent propagate throws with the paths it tried").
 *   - `CURATE_DOCS_SELF_DIR` lets a SUBPROCESS force the same thing via env alone, since a
 *     spawned CLI can only be steered through env vars, not call-time arguments
 *     (tests/report.test.mjs — "without propagate the tool still runs"). cli.mjs's `analyse()`
 *     calls `loadTaxonomy()` with no arguments, so this default is what it actually gets.
 */
export function propagateCandidates(
  env = process.env,
  home = os.homedir(),
  selfDir = env.CURATE_DOCS_SELF_DIR || SELF_DIR,
) {
  const rel = ["lib/report/doc-kind.mjs", "lib/doc-kind.mjs"];
  const c = [];

  // CO-LOCATED FIRST (plan §2). Since the consolidation, propagate lives in the
  // same repo as this file — curate-docs was vendored to skills/curate-docs/, so
  // propagate's lib/ is three levels up. This candidate is the one that resolves
  // on a CONSUMER machine, where none of the others exist: PROPAGATE_SKILL_DIR is
  // unset and ~/.claude/skills/propagate is a symlink only the author has. That is
  // exactly how `taxonomy: none` shipped while every local check passed.
  for (const r of rel) c.push(path.resolve(selfDir, "../../..", r));

  // Retained fallbacks: an explicit override (this skill's own tests set it) and
  // the skill-mode install path, which is still how propagate reaches this machine.
  if (env.PROPAGATE_SKILL_DIR) {
    for (const r of rel) c.push(path.resolve(env.PROPAGATE_SKILL_DIR, r));
  }
  for (const r of rel) c.push(path.join(home, ".claude/skills/propagate", r));
  return c;
}

/**
 * Cached PER RESOLVED CANDIDATE SET, not globally. A single module-level cache made the
 * loud-failure path unreachable in any process that had already loaded successfully —
 * caught by the absent-propagate test, and exactly the class of defect this skill is for:
 * a check that cannot fire.
 */
const cache = new Map();

/** @returns {Promise<{KINDS, kindOf, frontmatter, parseSupersedes, buildSupersessionIndex,
 *                     brokenPathCitations, source: string}>} */
export async function loadTaxonomy(env = process.env, home = os.homedir(), selfDir = env.CURATE_DOCS_SELF_DIR || SELF_DIR) {
  const tried = propagateCandidates(env, home, selfDir);
  const key = tried.join("\0");
  if (cache.has(key)) return cache.get(key);
  const found = tried.find((p) => existsSync(p));
  if (!found) throw new TaxonomyUnavailable(tried);
  const m = await import(pathToFileURL(found).href);
  // Assert the surface we depend on. A propagate that renamed an export must fail here,
  // audibly, rather than silently degrade every kind to `undeclared`.
  const required = ["KINDS", "kindOf", "frontmatter", "parseSupersedes", "buildSupersessionIndex", "brokenPathCitations"];
  const missing = required.filter((k) => typeof m[k] === "undefined");
  if (missing.length) {
    throw new TaxonomyUnavailable([`${found} (loaded, but missing exports: ${missing.join(", ")})`]);
  }
  const loaded = { ...Object.fromEntries(required.map((k) => [k, m[k]])), source: found };
  cache.set(key, loaded);
  return loaded;
}

/**
 * Staleness rule per kind — Rupali's formulation: "only the most recent changes should be
 * there, otherwise it's a plan file, or a design file which has a process."
 *
 * `age` kinds are the ones that describe something still standing, so silence is a defect.
 * `plan` is STALE BY DESIGN (propagate's own KINDS says so); its defect is having no
 * DECLARED STATE, which is a graph question, not an mtime question.
 */
export const STALENESS = {
  state: "age",
  "page-spec": "age",
  "functionality-spec": "age",
  ops: "age",
  design: "age",
  plan: "declared-state",
  "decision-log": "append-only",
  router: "completeness",
  undeclared: "none",
};

export function stalenessRule(kind) {
  return STALENESS[kind ?? "undeclared"] ?? "none";
}
