/**
 * Shared helpers for the test-impact tooling (static.mjs, map.mjs, affected.mjs).
 *
 * Repo tooling, NOT shipped: it sits under scripts/, which is outside package.json
 * "files". Nothing under lib/ may import it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// TEST_IMPACT_MAP exists so a test can point affected.mjs at a fixture map without
// touching the committed one.
export const MAP_PATH = process.env.TEST_IMPACT_MAP || path.join(REPO, "tests", "impact-map.json");

// The same globs as package.json "test:propagate". The skills/curate-docs suite is
// a separate `npm test --prefix` run with its own package; it is NOT in this map,
// so a change under skills/curate-docs/ is unknown to the map and falls back to the
// full run (affected.mjs says so).
export const TEST_ROOTS = ["tests", "hooks"];

/** Repo-relative, forward-slash path of an absolute path. */
export function rel(abs) {
  return path.relative(REPO, abs).split(path.sep).join("/");
}

/**
 * Every `*.test.mjs` under TEST_ROOTS, derived by walking the disk rather than from
 * git, so a brand-new untracked test is seen (G76 is about the opposite tool).
 * Floor: an empty walk is a blind scan, not an empty suite.
 */
export function listTestFiles(repo = REPO) {
  const out = [];
  for (const root of TEST_ROOTS) {
    let entries;
    try {
      entries = readdirSync(path.join(repo, root), { recursive: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const f = String(e).split(path.sep).join("/");
      if (f.endsWith(".test.mjs") && !f.includes("node_modules/")) out.push(`${root}/${f}`);
    }
  }
  out.sort();
  if (out.length < 50) {
    throw new Error(`only ${out.length} test files found under ${TEST_ROOTS.join(", ")} — the scan has gone blind, it has not found a small suite`);
  }
  return out;
}

/**
 * `// @size small|medium|large` in the first 40 lines of a test file; default small.
 *
 * This header is a stand-in. Node's native test tags arrive in v26.2 and this repo's
 * floor is ">=22", so a comment is the only portable carrier today. When the floor
 * reaches 26.2, move these to `{ tags: [...] }` with --experimental-test-tag-filter
 * and delete this parser.
 */
export function readSize(file, repo = REPO) {
  let head;
  try {
    head = readFileSync(path.join(repo, file), "utf8").split("\n", 40).join("\n");
  } catch {
    return "small";
  }
  const m = head.match(/^\s*\/\/\s*@size\s+(small|medium|large)\b/m);
  return m ? m[1] : "small";
}
