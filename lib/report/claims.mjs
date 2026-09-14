/**
 * lib/report/claims.mjs — the tree-wide judgment census `doctor` renders.
 *
 * SHAPED LIKE `lib/report/goals.mjs`, deliberately. doctor's `# Goals` block
 * calls `goalCounts(files)` and prints its fields; this module is the same
 * seam for `# Claims`, so `cli.mjs` renders and never accumulates. That split
 * is the house rule `commands/ansi.mjs`'s header states — "zero of 58 lib/
 * modules contain an ANSI escape, and none of them print".
 *
 * WHY IT PRELOADS, and this is the whole reason the module exists rather than
 * a loop in cli.mjs. `readClaims({file})` reads and parses EVERY shard and
 * applies the `file` filter AFTER the parse (`lib/claims/store.mjs`), so
 * calling it once per file is O(files x store-size). Measured on this tree:
 *
 *     readClaims({})          once      ->   0ms   (152 claims)
 *     readClaims({file})      x499      -> 754ms
 *
 * 754ms of re-parsing the same bytes, about 71% of doctor's Claims cost.
 * Reading both stores ONCE and handing each file its own slice makes the loop
 * O(files + store-size). `readRuns` has the identical shape and is free today
 * only because no run store exists yet — it would acquire the same blowup the
 * first time `claims answer` is used, so it is preloaded here too rather than
 * left as a trap for whoever enables the lane.
 *
 * THREE STATES, NEVER TWO (`rule:discernment-checks` §2). `files.length === 0`
 * is reported as its own fact: a caller must be able to tell "nothing is
 * declared" from "declared things, nothing to judge". `unreadable` is counted
 * separately from both, because a reader that failed is not an empty file.
 */
import { readClaims, latestByBlock, canonicalFile } from "../claims/store.mjs";
import { readRuns } from "../claims/runs.mjs";
import { judgeStatus } from "../claims/judge.mjs";

/**
 * Group records by their canonical `file`, so each file's slice is one Map hit
 * rather than a re-scan. Records whose `file` is absent are dropped here and
 * counted by the caller's `malformed` path, never silently folded into a file.
 */
function groupByFile(records) {
  const byFile = new Map();
  for (const r of records) {
    if (!r || typeof r.file !== "string") continue;
    const key = canonicalFile(r.file);
    const bucket = byFile.get(key);
    if (bucket) bucket.push(r);
    else byFile.set(key, [r]);
  }
  return byFile;
}

/**
 * Fold `judgeStatus` over every declared source file, reading each store once.
 *
 * @param {string[]} files  declared source paths (doctor passes
 *   `buildClaimsCorpus().fileEntries.keys()`)
 * @returns {Promise<{files:number, judged:number, unjudged:number,
 *   unanswerable:number, runs:number, unreadable:number, storeExists:boolean}>}
 */
export async function claimsCounts(files, opts = {}) {
  const empty = {
    files: 0, judged: 0, unjudged: 0, unanswerable: 0, runs: 0,
    unreadable: 0, malformed: 0, storeExists: false,
  };
  if (!Array.isArray(files) || files.length === 0) return empty;

  // ONE read of each store, then a Map lookup per file. The injected readers
  // below are why `judgeStatus` grew `opts.readClaims` alongside `opts.readRuns`.
  const readClaimsFn = opts.readClaims ?? readClaims;
  const readRunsFn = opts.readRuns ?? readRuns;
  const allClaims = await readClaimsFn({});
  const allRuns = await readRunsFn({});
  const claimsByFile = groupByFile(allClaims.claims ?? []);
  const runsByFile = groupByFile(allRuns.runs ?? []);

  // MALFORMED IS STORE-WIDE, COUNTED ONCE, AND MUST NOT BE DISCARDED.
  // Both stores count corrupt lines on read — store.mjs's premise is "corrupt
  // lines COUNTED as malformed on read, never silently skipped". An earlier
  // version of this function upheld that at the store layer and then dropped
  // it here: the per-file stub below hardcoded `malformed: 0` and the
  // accumulator had no field for it, so real corruption was computed and
  // silently binned. Found by the ship red-team pass, which reproduced five
  // corrupt lines vanishing. Counting it per file would over-count (each file
  // would re-report the whole store's corruption), so it is taken once here
  // from the single whole-store read.
  const malformed = (allClaims.malformed ?? 0) + (allRuns.malformed ?? 0);

  const out = {
    ...empty,
    files: files.length,
    malformed,
    storeExists: Boolean(allClaims.storeExists),
  };
  for (const f of files) {
    const key = canonicalFile(f);
    const s = await judgeStatus(f, {
      readClaims: async () => ({
        claims: claimsByFile.get(key) ?? [],
        // Per-file malformed is 0 BY CONSTRUCTION, not by omission: the real
        // count is store-wide and already taken above. Returning the whole
        // store's count here would multiply it by the file count.
        malformed: 0,
        storeExists: Boolean(allClaims.storeExists),
      }),
      readRuns: async () => ({ runs: runsByFile.get(key) ?? [] }),
    });
    if (s.error) { out.unreadable += 1; continue; }
    out.judged += s.judged.length;
    out.unjudged += s.unjudged.length;
    out.unanswerable += s.unanswerable.length;
    out.runs += s.runs?.count ?? 0;
  }
  return out;
}

export { latestByBlock };
