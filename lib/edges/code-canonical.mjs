/**
 * Per-workspace code-canonical loader (V2).
 *
 * Replaces the global CODE_CANONICAL hardcoded array in config.mjs.
 * Each workspace declares its canonical-pairs in `.code-canonical.yml` at
 * its root. The watcher loads + iterates these per-workspace at scan time.
 *
 * File format:
 *   canonical_pairs:
 *     - codePath: VipinKaushik/lib/pricing.ts
 *       upstreamDoc: docs/VIPIN.md
 *       upstreamSection: §Pricing
 *       note: "..."
 *
 * codePath is workspace-relative; resolved against workspace.root by the
 * watcher exactly like the V1 CODE_CANONICAL entries.
 *
 * Returns an empty array if the file doesn't exist (no breakage when a
 * workspace just uses propagates sidecars without code-canonical pairs).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

const FILE_NAME = ".code-canonical.yml";

/**
 * Load code-canonical entries for one workspace.
 * @param {string} workspaceRoot - absolute path to workspace root
 * @returns {Array<{codePath, upstreamDoc, upstreamSection, note}>}
 */
export function loadCodeCanonicalSync(workspaceRoot) {
  const filePath = path.join(workspaceRoot, FILE_NAME);
  if (!existsSync(filePath)) return [];

  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  let parsed;
  try {
    parsed = yaml.parse(text);
  } catch (err) {
    throw new Error(`${FILE_NAME} parse error in ${workspaceRoot}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object") return [];
  const pairs = parsed.canonical_pairs;
  if (!Array.isArray(pairs)) return [];

  return pairs
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      codePath: String(p.codePath || ""),
      upstreamDoc: String(p.upstreamDoc || ""),
      upstreamSection: String(p.upstreamSection || ""),
      note: String(p.note || ""),
    }))
    .filter((p) => p.codePath && p.upstreamDoc);
}
