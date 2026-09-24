/**
 * delivery.mjs — doctor's `# Delivery` section: is the plugin anyone is actually
 * running the same code as the one in this repo?
 *
 * THE INCIDENT THIS EXISTS FOR, measured 2026-09-16. The served plugin was 0.5.0
 * while source was 0.6.1 — FOUR merged PRs authored and not delivered.
 * `commands/goals.mjs` and `lib/claims/restate.mjs` were absent from the served
 * tree entirely, so the whole judgment lane ran nowhere. Every check in this repo
 * was green throughout, because every check reads the SOURCE.
 *
 * `hooks/hooks.json:12-22` already described the hazard in prose — "the change is
 * authored and not delivered" — and prescribed bumping `plugin.json`. The bump was
 * done every time. The `claude plugin update` was not. Prose about a hazard is not
 * a check for it (`rule:enforcement-watches-itself`), and this module is the check.
 *
 * WHY THE VERSION STRING IS NOT THE TEST. In the incident every manifest read the
 * same number and agreed with every other manifest, and the served tree was still
 * missing two modules. So a matching version is NOT delivery: this compares the
 * sha256 of `cli.mjs` as well, and reports the version-matches-but-content-differs
 * case as its own outcome rather than folding it into "current".
 *
 * FOUR OUTCOMES, NEVER COLLAPSED (`rule:discernment-checks` §2):
 *
 *   not-installed  — no served tree at all. INFO, not a failure: propagate is also
 *                    a published npm bin (`claude-propagate`) and using it without
 *                    the plugin is legitimate. "Looked and found nothing" and
 *                    "there is nothing to look for" are different facts.
 *   current        — version matches AND cli.mjs hashes match.
 *   stale          — served version differs from source. WARN, not a failure: a
 *                    developer between a VERSION bump and a `plugin update` is
 *                    legitimately in this state, and failing doctor for that window
 *                    would train people to ignore it.
 *   incoherent     — version MATCHES and content does not.
 *
 * NOTHING HERE FAILS DOCTOR, and that is a deliberate correction to this module's
 * first version. It initially failed on `incoherent` — and then fired on its very
 * first run, correctly, because cli.mjs had been edited since the last
 * `plugin update`. That is the NORMAL state of a repo someone is working in. A
 * health check that goes red during ordinary development trains people to ignore
 * it, which is precisely the failure the paragraph above describes.
 *
 * The deeper reason is a category error: doctor's exit code is about THIS REPO.
 * Which plugin version a particular machine happens to have installed is a fact
 * about that machine, not about the repo's correctness. So this section reports,
 * loudly and in words, and leaves the exit code alone.
 *
 * Every dynamic import is `../../`, not `./lib/` — G60.
 */

/**
 * Severity of what this section reports (N87 slice 2b).
 *
 * Whether a change can actually reach a consumer. N78: a code-only merge is
 * undeliverable because both delivery mechanisms gate on VERSION and only
 * `doctor` reads content. Noisy and wrong, not silent.
 *
 *
 * Declared per SECTION, not per call site: doctor has 60 `reporter.check`
 * sites and 8 sections, and sixty judgements is a project nobody finishes. A
 * section whose checks genuinely span two severities should SPLIT — that is
 * normally a section doing two jobs.
 */
export const SEVERITY = "S2";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const HOME_DIR = homedir();

/** sha256 of a file, or null when it cannot be read — never a throw, never "". */
function hashFile(p) {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Every served propagate tree under the plugin cache.
 *
 * Returns ALL of them, not just the newest. A cache holding both 0.5.0 and 0.6.1
 * is the normal post-update state and worth showing, but two trees at DIFFERENT
 * versions is also exactly what a half-finished update looks like, and a function
 * that silently picks one cannot tell you that.
 *
 * @param {string} [cacheRoot] override for tests
 */
export function servedTrees(cacheRoot = path.join(HOME_DIR, ".claude", "plugins", "cache")) {
  if (!existsSync(cacheRoot)) return [];
  const out = [];
  let markets;
  try {
    markets = readdirSync(cacheRoot);
  } catch {
    return [];
  }
  for (const mkt of markets) {
    const dir = path.join(cacheRoot, mkt, "propagate");
    if (!existsSync(dir)) continue;
    let versions;
    try {
      versions = readdirSync(dir);
    } catch {
      continue;
    }
    for (const v of versions) {
      const root = path.join(dir, v);
      try {
        if (!statSync(root).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({ marketplace: mkt, version: v, root });
    }
  }
  return out;
}

/**
 * Classify one served tree against source. Pure — takes facts, returns a verdict,
 * touches no reporter and prints nothing.
 *
 * @returns {{state: "current"|"stale"|"incoherent", why: string}}
 */
export function classifyServed({ servedVersion, sourceVersion, servedHash, sourceHash }) {
  if (servedVersion !== sourceVersion) {
    return { state: "stale", why: `serving ${servedVersion}, source is ${sourceVersion}` };
  }
  // Version agrees. Content is the real question — see the header.
  if (servedHash === null || sourceHash === null) {
    return { state: "incoherent", why: `version ${servedVersion} matches but cli.mjs could not be hashed on both sides` };
  }
  if (servedHash !== sourceHash) {
    return {
      state: "incoherent",
      why: `version ${servedVersion} matches but cli.mjs differs (served ${servedHash.slice(0, 12)}, source ${sourceHash.slice(0, 12)})`,
    };
  }
  return { state: "current", why: `${servedVersion}, cli.mjs identical` };
}

/**
 * doctor's `# Delivery` section.
 *
 * @param {{reporter: object, repoRoot: string, cacheRoot?: string}} opts
 */
export async function checkDelivery({ reporter, repoRoot, cacheRoot }) {
  reporter.header("# Delivery");

  const sourceVersionPath = path.join(repoRoot, "VERSION");
  const sourceVersion = existsSync(sourceVersionPath)
    ? readFileSync(sourceVersionPath, "utf8").trim()
    : null;
  const sourceHash = hashFile(path.join(repoRoot, "cli.mjs"));

  if (!sourceVersion) {
    // Could-not-derive, said in those words. Never let this read as "nothing to do".
    reporter.warn("source version", `could not read ${sourceVersionPath.replace(HOME_DIR, "~")} — delivery cannot be judged`);
    return;
  }

  const trees = servedTrees(cacheRoot);

  if (trees.length === 0) {
    reporter.info(
      "plugin",
      "not installed — no served tree under ~/.claude/plugins/cache. " +
        "Not a defect: propagate is also a plain CLI (`claude-propagate`). " +
        "Nothing to compare, which is different from comparing and agreeing.",
    );
    return;
  }

  for (const t of trees) {
    const verdict = classifyServed({
      servedVersion: t.version,
      sourceVersion,
      servedHash: hashFile(path.join(t.root, "cli.mjs")),
      sourceHash,
    });
    const label = `${t.marketplace}/propagate`;

    if (verdict.state === "current") {
      reporter.check(label, true, verdict.why);
    } else if (verdict.state === "stale") {
      reporter.warn(
        label,
        `${verdict.why} — run \`claude plugin update propagate@${t.marketplace}\`, then RESTART. ` +
          `A running session keeps the old code.`,
      );
    } else {
      reporter.warn(
        label,
        `${verdict.why}. Either this tree has uncommitted edits (normal while developing) ` +
          `or an update half-applied — \`git status\` distinguishes them.`,
      );
    }
  }

  // Two served trees at different versions is a half-finished update, and saying
  // so is cheaper than making the reader diff the rows above themselves.
  const distinct = new Set(trees.map((t) => t.version));
  if (distinct.size > 1) {
    reporter.info(
      "served versions",
      `${distinct.size} distinct (${[...distinct].sort().join(", ")}) — ` +
        `normal directly after an update; persistent means one was never cleaned up`,
    );
  }
}
