/**
 * delivery.mjs — doctor's `# Delivery` section: is the plugin anyone is actually
 * running the same code as the one in this repo, and if not, is it stale enough
 * to fail the run?
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
 * THE SECOND INCIDENT, filed as N78 and decided in
 * `~/.claude/plans/docs-plans-2026-09-23-reminders-todo-bri-playful-dawn.md`.
 * Measured 2026-09-24: served `cli.mjs` sha256 differed from source while BOTH
 * manifests read `0.6.2` — 48 commits landed on shipped paths with no VERSION
 * bump, so neither delivery trigger (`.githooks/post-merge`'s VERSION-diff check,
 * `claude plugin update`'s version-string compare) ever fired. `claude plugin
 * update` reported "already at the latest version" while the served tree was a
 * week and 48 commits stale. That review is why this module now:
 *   (a) compares the WHOLE shipped file set, not one file (`treeDigest`) — a
 *       one-file hash can only catch an absent module by luck;
 *   (b) FAILS doctor once the served tree is stale past a threshold, regardless
 *       of working-tree state — the previous version never failed doctor at all;
 *   (c) reads the SOURCE side from committed content at HEAD, never the working
 *       tree — a dirty file must not move the verdict, which is the exact
 *       regression that got this module's first failing version reverted (see
 *       below);
 *   (d) branches its remediation text by state, and never points at `git status`
 *       for `incoherent`, where the tree is reliably clean.
 *
 * WHY THE VERSION STRING IS NOT THE TEST. In both incidents every manifest read
 * the same number and agreed with every other manifest while the served tree was
 * missing or stale content. So a matching version is NOT delivery.
 *
 * THREE STATES, NEVER COLLAPSED (`rule:discernment-checks` §2):
 *
 *   not-installed  — no served tree at all. INFO, not a failure: propagate is also
 *                    a published npm bin (`claude-propagate`) and using it without
 *                    the plugin is legitimate. "Looked and found nothing" and
 *                    "there is nothing to look for" are different facts.
 *   current        — version matches AND the whole shipped-file digest matches.
 *   stale          — served version differs from source.
 *   incoherent     — version MATCHES and content does not (a changed file, or a
 *                    shipped path missing from the served tree entirely).
 *
 * `stale` and `incoherent` are no longer flat WARN. Each gets a `deliveryLag`
 * measurement (shipped-path commits/days behind the served commit) and FAILS
 * doctor once EITHER bound is crossed (`lib/core/config.mjs` deliveryMaxCommits/
 * deliveryMaxDays) — or immediately, at ANY distance, if a shipped path is
 * missing from the served tree (the exact 2026-09-16 symptom). Below the bound,
 * with nothing missing, it stays a WARN: a developer between a VERSION bump and
 * a `plugin update` is legitimately in that window, and failing doctor for it
 * would train people to ignore the check — this module's own history proves
 * that lesson. It initially failed on EVERY `incoherent`, unconditionally, and
 * fired on its very first run because cli.mjs had been edited since the last
 * `plugin update` — the NORMAL state of a repo someone is working in. That
 * version was reverted. The threshold is the fix, not a return to never-failing.
 *
 * THE REGRESSION THIS MODULE MUST NEVER REINTRODUCE: a dirty working tree at
 * zero shipped-path commits behind must still PASS. Reading the source side from
 * `git ls-tree -r HEAD` rather than the working tree is what makes that true by
 * construction, not by a special case — see `sourceHashesAtHead`.
 *
 * The deeper reason a gate belongs here at all is a category error otherwise:
 * doctor's exit code is about THIS REPO. Which plugin version a particular
 * machine has installed is normally a fact about that machine — but propagate's
 * OWN hooks and skills execute from the served copy (`docs/GOTCHAS.md` G63), so a
 * stale served tree is this repo's enforcement running old code, which makes it
 * a fact about this repo's correctness after all.
 *
 * Every dynamic import is `../../`, not `./lib/` — G60.
 */

/**
 * Severity of what this section reports (N87 slice 2b).
 *
 * Declared per SECTION, not per call site: doctor has 60 `reporter.check`
 * sites and 8 sections, and sixty judgements is a project nobody finishes. A
 * section whose checks genuinely span two severities should SPLIT — that is
 * normally a section doing two jobs.
 */
export const SEVERITY = "S2";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { DELIVERY_MAX_COMMITS, DELIVERY_MAX_DAYS } from "../../core/config.mjs";

const HOME_DIR = homedir();

/**
 * The single definition of "what this plugin ships" (T10 / D12). CI derives the
 * same value with a one-line node invocation rather than restating it in YAML —
 * `.github/workflows/test.yml`'s bump-gate job calls this, and
 * `tests/unit/doctor-delivery.test.mjs` asserts the workflow contains no
 * hardcoded shipped-path list, so the two cannot drift apart the way
 * `.githooks/post-merge`'s hand-maintained 3-of-141 list already has (F8).
 *
 * `tests/`, `docs/` and `propagation/` are excluded: nothing under them is
 * copied into a served install, and R3/D5 requires the staleness count to be
 * over exactly this population — a doc-only or test-only commit must not move
 * the "commits behind" number (the 2026-08-27 decision that a doc-only addition
 * is not a release).
 */
export const SHIPPED_EXCLUDE_DIRS = Object.freeze(["tests", "docs", "propagation"]);

export function shippedPathspec() {
  return [".", ...SHIPPED_EXCLUDE_DIRS.map((d) => `:(exclude)${d}/**`)];
}

/** sha256 of a file, or null when it cannot be read — never a throw, never "". */
function hashFile(p) {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Source-side hashes for the shipped set, read from COMMITTED content at HEAD —
 * never the working tree. One spawn (`git ls-tree`), not one per file.
 *
 * THIS IS THE REGRESSION FIX (T4/D6). The module's first failing version read
 * `cli.mjs` off disk with `readFileSync`, so any file you were mid-edit on moved
 * the verdict — normal while developing, and exactly why that version was
 * reverted after firing on its own first run. Reading `git ls-tree -r HEAD`
 * instead means an uncommitted edit to a shipped file can NEVER change what this
 * function returns, by construction, not by a special case checked afterward.
 *
 * @returns {Record<string,string>|null} path -> git blob hash, or null when
 *   `repoRoot` has no readable HEAD (not a git repo, or an unborn branch) — the
 *   caller must treat that as "could not look", never as zero shipped files.
 */
export function sourceHashesAtHead(repoRoot, excludeDirs = SHIPPED_EXCLUDE_DIRS) {
  // NOT `shippedPathspec()` here: `:(exclude)` pathspec magic is refused by
  // `ls-tree` ("pathspec magic not supported by this command"), even though
  // `rev-list`/`diff` both accept it. Measured directly against this repo
  // (git 2.54.0) rather than assumed. So this reads the WHOLE tree in one
  // spawn and filters by prefix in JS — still one spawn, and `shippedPathspec()`
  // stays the single definition for every command that can actually take it.
  let out;
  try {
    out = execFileSync("git", ["-C", repoRoot, "ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // a missing HEAD is an EXPECTED failure path (T6-f-adjacent), not a crash to surface on stderr
    });
  } catch {
    return null;
  }
  const excludePrefixes = excludeDirs.map((d) => `${d}/`);
  const hashes = {};
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    // "<mode> <type> <hash>\t<path>"
    const tab = rec.indexOf("\t");
    if (tab === -1) continue;
    const meta = rec.slice(0, tab).split(" ");
    const hash = meta[2];
    const p = rec.slice(tab + 1);
    if (!hash || !p) continue;
    if (excludePrefixes.some((pre) => p.startsWith(pre))) continue;
    hashes[p] = hash;
  }
  return hashes;
}

/**
 * Served-side hashes for whichever of `fileList` actually exists under
 * `servedRoot`, as git blob hashes (so they are directly comparable to
 * `sourceHashesAtHead`'s output). One BATCHED spawn (`git hash-object
 * --stdin-paths`) regardless of how many files are hashed — never one spawn per
 * file (T4). `git hash-object` needs no `.git` directory; the served tree is a
 * plain copy, not a repo, and this works against it unmodified.
 *
 * A path in `fileList` absent from the returned map is what "missing" means
 * downstream — this function does not decide that; it only reports what it found.
 *
 * @returns {Record<string,string>} path -> git blob hash, for files that exist.
 */
export function servedHashesFor(servedRoot, fileList) {
  const present = fileList.filter((p) => existsSync(path.join(servedRoot, p)));
  if (present.length === 0) return {};
  let out;
  try {
    out = execFileSync("git", ["hash-object", "--stdin-paths"], {
      input: present.map((p) => path.join(servedRoot, p)).join("\n") + "\n",
      encoding: "utf8",
    });
  } catch {
    return {};
  }
  const lines = out.split("\n").filter(Boolean);
  const hashes = {};
  present.forEach((p, i) => {
    if (lines[i]) hashes[p] = lines[i];
  });
  return hashes;
}

/**
 * Pure digest over a shipped file set (T2/D4). No IO — every hash is supplied,
 * not read; this is what keeps the module unit-testable over fixtures rather
 * than a real served tree.
 *
 * `missing` is a path named in `fileList` with no hash in `hashes` — this is the
 * exact shape of the 2026-09-16 incident (`commands/goals.mjs` and
 * `lib/claims/restate.mjs` absent from the served tree while a one-file hash
 * check stayed green). It is the caller's job to treat a non-empty `missing` as
 * a failure at ANY distance, not this function's — this function only measures.
 *
 * `extra` is a path present in `hashes` but not named in `fileList` — e.g. a
 * served tree's own `node_modules/` or install metadata. Kept for symmetry, not
 * currently gated on (suppressed finding, confidence 5/10 — an allowlist may be
 * needed if this proves noisy; unverified, since the served tree's non-git files
 * were never enumerated).
 *
 * EMPTY `fileList` is refused rather than digested. A digest over zero files
 * trivially "matches" any other digest over zero files, which would silently
 * green-light a served tree missing EVERYTHING the moment the shipped pathspec
 * is ever misconfigured to exclude the whole repo — the silent-pass shape this
 * whole module exists to prevent, one level up.
 *
 * @param {string[]} fileList the paths this build is supposed to ship
 * @param {Record<string,string>} hashes hash for each path actually found
 * @returns {{digest: string|null, missing: string[], extra: string[], checked: number, refused: string|null}}
 */
export function treeDigest(fileList, hashes) {
  if (!Array.isArray(fileList) || fileList.length === 0) {
    return { digest: null, missing: [], extra: [], checked: 0, refused: "empty fileList — refusing to report a digest over nothing" };
  }
  const sorted = [...fileList].sort();
  const missing = [];
  const parts = [];
  for (const p of sorted) {
    const h = Object.prototype.hasOwnProperty.call(hashes, p) ? hashes[p] : undefined;
    if (h === undefined || h === null) {
      missing.push(p);
      continue;
    }
    parts.push(`${p}\0${h}`);
  }
  const known = new Set(fileList);
  const extra = Object.keys(hashes)
    .filter((p) => !known.has(p) && hashes[p] != null)
    .sort();
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex");
  return { digest, missing, extra, checked: fileList.length, refused: null };
}

/** Paths present on both sides whose hash differs — used only for the evidence
 * text (differing-path count), not for the missing-at-any-distance gate. */
export function changedPaths(fileList, sourceHashes, servedHashes) {
  return fileList.filter(
    (p) => servedHashes[p] != null && sourceHashes[p] != null && servedHashes[p] !== sourceHashes[p],
  );
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
 * `installed_plugins.json`, parsed — or null when it cannot be read/parsed.
 * @param {string} [p] override for tests
 */
export function readInstalledPlugins(p = path.join(HOME_DIR, ".claude", "plugins", "installed_plugins.json")) {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The served commit for one plugin key (`"<plugin>@<marketplace>"`), read from
 * an already-parsed `installed_plugins.json` (T3). Pure — takes the parsed
 * object, returns a sha or null; the caller decides what null means (T6-f: it
 * must become `inconclusive`, never a silent pass).
 *
 * Prefers a `"user"`-scoped entry when more than one is recorded, since a
 * project-scoped override existing alongside it should not hide the user-level
 * install this repo's own doctor run cares about; falls back to the first entry
 * when none is user-scoped.
 *
 * @param {object|null} installedPluginsJson
 * @param {string} pluginKey e.g. "propagate@tathya"
 * @returns {string|null}
 */
export function servedCommit(installedPluginsJson, pluginKey) {
  const entries = installedPluginsJson?.plugins?.[pluginKey];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const entry = entries.find((e) => e && e.scope === "user") ?? entries[0];
  const sha = entry?.gitCommitSha;
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/**
 * The `installPath` of the tree Claude Code is ACTUALLY serving for one plugin
 * key, or null when it cannot be determined. Same selection rule as
 * `servedCommit` so the two can never disagree about which entry they mean.
 *
 * WHY THIS EXISTS — measured 2026-09-24, and it is the difference between one
 * finding and three. The cache legitimately holds several version-keyed trees
 * (0.5.0, 0.6.1, 0.6.2 on this machine), and only ONE of them is loaded. Judging
 * every tree alike made a stale-by-definition leftover produce its own failing
 * row, so one real problem rendered as three `✗` lines. A check that fires twice
 * for abandoned directories is the noise this module's own header warns trains
 * people to ignore it. Leftovers are still reported — as leftovers, which is a
 * cleanup fact about the machine, not a delivery failure of this repo.
 *
 * @param {object|null} installedPluginsJson
 * @param {string} pluginKey e.g. "propagate@tathya"
 * @returns {string|null}
 */
export function activeInstallPath(installedPluginsJson, pluginKey) {
  const entries = installedPluginsJson?.plugins?.[pluginKey];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const entry = entries.find((e) => e && e.scope === "user") ?? entries[0];
  const p = entry?.installPath;
  return typeof p === "string" && p.length > 0 ? path.resolve(p) : null;
}

/**
 * How far behind the served commit is, counting ONLY commits that touch the
 * shipped pathspec (D5/T3) — a doc-only or test-only commit must not move this
 * number, per the 2026-08-27 decision that a doc-only addition is not a release.
 *
 * `ancestor` is its own fact, checked BEFORE any count is trusted. When the
 * served commit is not an ancestor of HEAD — rewritten history, or a served
 * install pointing at a different branch entirely — a commit/day count would be
 * either meaningless or (with `..` range syntax) silently wrong, so this
 * returns `ancestor: false` with both counts null rather than a number that
 * looks like an ordinary answer. The caller must word that case differently
 * from ordinary lag, never fold it into a ordinary "N commits behind" message
 * (T6-h).
 *
 * @param {{servedSha: string, repoRoot: string, pathspec?: string[]}} args
 * @returns {{commitsBehind: number|null, daysBehind: number|null, ancestor: boolean|null}}
 *   `ancestor: null` means the ancestry check itself could not run (e.g. the sha
 *   is not a valid object in this repo at all) — distinct from `false`, which
 *   means the check ran and definitively said no.
 */
export function deliveryLag({ servedSha, repoRoot, pathspec = shippedPathspec() }) {
  if (!servedSha) {
    return { commitsBehind: null, daysBehind: null, ancestor: null };
  }

  let ancestor;
  try {
    execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", servedSha, "HEAD"], {
      stdio: "ignore",
    });
    ancestor = true;
  } catch (err) {
    // exit 1 = ran fine, answer is "no" (a real fact). Anything else (bad sha,
    // not a repo, no HEAD) is "could not tell" — different from a confident no.
    ancestor = err?.status === 1 ? false : null;
  }

  if (ancestor !== true) {
    return { commitsBehind: null, daysBehind: null, ancestor };
  }

  let commitsBehind = null;
  try {
    const out = execFileSync(
      "git",
      ["-C", repoRoot, "rev-list", "--count", `${servedSha}..HEAD`, "--", ...pathspec],
      { encoding: "utf8" },
    );
    const n = Number(out.trim());
    commitsBehind = Number.isFinite(n) ? n : null;
  } catch {
    commitsBehind = null;
  }

  let daysBehind = null;
  try {
    const out = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%ct", servedSha], {
      encoding: "utf8",
    });
    const committedMs = Number(out.trim()) * 1000;
    daysBehind = Number.isFinite(committedMs) ? Math.max(0, Math.floor((Date.now() - committedMs) / 86400000)) : null;
  } catch {
    daysBehind = null;
  }

  return { commitsBehind, daysBehind, ancestor: true };
}

/**
 * Classify one served tree against source. Pure — takes facts, returns a verdict,
 * touches no reporter and prints nothing.
 *
 * @param {{servedVersion: string, sourceVersion: string,
 *   sourceDigest: {digest: string|null}, servedDigest: {digest: string|null, missing: string[], checked: number}}} args
 * @returns {{state: "current"|"stale"|"incoherent", why: string, missing?: string[]}}
 */
export function classifyServed({ servedVersion, sourceVersion, sourceDigest, servedDigest }) {
  if (servedVersion !== sourceVersion) {
    return { state: "stale", why: `serving ${servedVersion}, source is ${sourceVersion}`, missing: [] };
  }
  // Version agrees. Content is the real question — see the header. Missing
  // paths are checked FIRST and reported on their own terms: they are the
  // literal shape of the incident this module exists for, and folding them
  // into a generic "digest differs" message would bury the one detail (WHICH
  // files are absent) that a reader actually needs to act on.
  if (servedDigest.missing.length > 0) {
    const shown = servedDigest.missing.slice(0, 3).join(", ");
    const more = servedDigest.missing.length > 3 ? `, +${servedDigest.missing.length - 3} more` : "";
    return {
      state: "incoherent",
      why: `version ${servedVersion} matches but ${servedDigest.missing.length} shipped path(s) missing from the served tree: ${shown}${more}`,
      missing: servedDigest.missing,
    };
  }
  if (sourceDigest.digest === null || servedDigest.digest === null || sourceDigest.digest !== servedDigest.digest) {
    return {
      state: "incoherent",
      why:
        `version ${servedVersion} matches but content differs ` +
        `(served ${String(servedDigest.digest).slice(0, 12)}, source ${String(sourceDigest.digest).slice(0, 12)})`,
      missing: [],
    };
  }
  return { state: "current", why: `${servedVersion}, ${servedDigest.checked} shipped file(s) identical`, missing: [] };
}

/**
 * The remediation text (T1/D3). Branches by verdict state — `stale` and
 * `incoherent` need genuinely different commands, verified against two
 * different sources: the `stale` command is Claude Code's documented update
 * path; the `incoherent` commands are N78's own transcript (the bump path
 * delivering successfully, and the marketplace-update+reinstall path being the
 * documented way to force a same-version re-copy).
 *
 * NEVER cites `git status` — the state it used to point at for `incoherent` is
 * reliably clean in exactly the case this text is for, which is what sent this
 * module's own incident report to "the least informative answer available".
 */
function remediationFor(state, { marketplace, servedSha, lag, differingCount }) {
  const evidence =
    `served commit ${servedSha.slice(0, 12)}, ` +
    `${lag.commitsBehind} shipped-path commit(s) / ${lag.daysBehind} day(s) behind, ` +
    `${differingCount} differing path(s)`;
  if (state === "stale") {
    return (
      `run \`claude plugin update propagate@${marketplace}\`, then RESTART — a running session ` +
      `keeps the old code. (${evidence})`
    );
  }
  // incoherent: same version, different content. Two verified paths — pick the
  // one that matches what actually happened.
  return (
    `two verified paths, pick one: if this is a release, bump VERSION and let ` +
    `\`.githooks/post-merge\` deliver it; otherwise run ` +
    `\`claude plugin marketplace update ${marketplace}\` then ` +
    `\`claude plugin uninstall propagate@${marketplace}\` and ` +
    `\`claude plugin install propagate@${marketplace}\`, then RESTART. (${evidence})`
  );
}

/**
 * doctor's `# Delivery` section.
 *
 * @param {{reporter: object, repoRoot: string, cacheRoot?: string, installedPluginsPath?: string}} opts
 */
export async function checkDelivery({ reporter, repoRoot, cacheRoot, installedPluginsPath }) {
  reporter.header("# Delivery");

  const sourceVersionPath = path.join(repoRoot, "VERSION");
  const sourceVersion = existsSync(sourceVersionPath)
    ? readFileSync(sourceVersionPath, "utf8").trim()
    : null;

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

  const pathspec = shippedPathspec();
  const sourceHashes = sourceHashesAtHead(repoRoot);
  if (sourceHashes === null) {
    reporter.inconclusive(
      "delivery",
      `could not read committed content at HEAD in ${repoRoot} — is this a git repo with a HEAD?`,
    );
    return;
  }
  const fileList = Object.keys(sourceHashes);
  const sourceDigest = treeDigest(fileList, sourceHashes);
  if (sourceDigest.refused) {
    reporter.inconclusive(
      "delivery",
      `shipped pathspec matched 0 files under ${repoRoot} — ${sourceDigest.refused}`,
    );
    return;
  }

  const installedPlugins = readInstalledPlugins(installedPluginsPath);

  for (const t of trees) {
    const servedHashes = servedHashesFor(t.root, fileList);
    const servedDigest = treeDigest(fileList, servedHashes);
    const verdict = classifyServed({ servedVersion: t.version, sourceVersion, sourceDigest, servedDigest });
    const label = `${t.marketplace}/propagate`;

    if (verdict.state === "current") {
      reporter.check(label, true, verdict.why);
      continue;
    }

    // ONLY THE TREE CLAUDE CODE IS ACTUALLY SERVING CAN FAIL THIS RUN. The cache
    // holds one directory per version ever installed, and a leftover is stale by
    // definition — gating on it turned one real problem into three `✗` rows on
    // this machine (0.5.0, 0.6.1 and the live 0.6.2). `installed_plugins.json`
    // already names the live one, so this is a fact that was being read and not
    // used, not a fact that needed inventing.
    const pluginKey = `propagate@${t.marketplace}`;
    const activeRoot = activeInstallPath(installedPlugins, pluginKey);
    if (activeRoot && path.resolve(t.root) !== activeRoot) {
      // Static label: a warning's label is its KIND, not the row
      // (tests/unit/doctor-warn-labels.test.mjs, N87 slice 3). The version and
      // path live in the detail.
      reporter.warn(
        "served plugin has a LEFTOVER cache tree",
        `${label} ${t.version} at ${t.root.replace(HOME_DIR, "~")} is not the served install ` +
          `(${activeRoot.replace(HOME_DIR, "~")}) — a version-keyed directory left behind by an ` +
          `earlier update. Stale by definition and not a delivery failure; remove it when convenient.`,
      );
      continue;
    }

    // stale or incoherent on the LIVE tree — figure out how far behind, and
    // whether that alone (or a missing shipped path) is enough to fail this run.
    const servedSha = servedCommit(installedPlugins, pluginKey);
    if (!servedSha) {
      reporter.inconclusive(
        `${label} delivery lag`,
        `no gitCommitSha recorded for ${pluginKey} in installed_plugins.json — cannot tell how far ` +
          `behind the served tree is`,
      );
      continue;
    }

    const lag = deliveryLag({ servedSha, repoRoot, pathspec });

    if (lag.ancestor !== true) {
      reporter.inconclusive(
        `${label} delivery lag`,
        lag.ancestor === false
          ? `served commit ${servedSha.slice(0, 12)} is NOT an ancestor of HEAD (rewritten history, ` +
            `or the served install points at a different branch) — a commit/day count would be meaningless`
          : `could not determine whether served commit ${servedSha.slice(0, 12)} is an ancestor of HEAD`,
      );
      continue;
    }
    if (lag.commitsBehind === null || lag.daysBehind === null) {
      reporter.inconclusive(
        `${label} delivery lag`,
        `could not measure commits/days behind for served commit ${servedSha.slice(0, 12)}`,
      );
      continue;
    }

    const changed = changedPaths(fileList, sourceHashes, servedHashes);
    const differingCount = verdict.missing.length + changed.length;
    const remediation = remediationFor(verdict.state, { marketplace: t.marketplace, servedSha, lag, differingCount });
    const detail = `${label} — ${verdict.why} — ${remediation}`;

    // A missing shipped path fails at ANY distance — this is the literal shape
    // of the 2026-09-16 incident, and waiting for it to also cross the commit/day
    // bound would mean the exact defect this module exists for could sit one
    // commit below the threshold and still read as a warning.
    const missingAtAnyDistance = verdict.missing.length > 0;
    const pastBound = lag.commitsBehind > DELIVERY_MAX_COMMITS || lag.daysBehind > DELIVERY_MAX_DAYS;

    if (missingAtAnyDistance || pastBound) {
      reporter.check(label, false, detail);
    } else {
      // A WARNING'S LABEL IS ITS KIND, not the row (tests/unit/doctor-warn-labels.test.mjs,
      // N87 slice 3) — `label` here is per-marketplace and would make every served
      // tree its own unfoldable kind, exactly the defect that test exists to catch.
      // The tree identity is still there, at the front of `detail`.
      // INLINED ON PURPOSE: tests/unit/doctor-warn-labels.test.mjs rejects a bare
      // identifier as a label too, not only string interpolation — a variable's
      // contents are unknown to that static scanner, so it cannot tell a literal
      // ternary from `const label = row.thing`. The ternary itself, written directly
      // here, is what makes this a KIND (one of two literals) rather than a row.
      reporter.warn(verdict.state === "stale" ? "served plugin is STALE" : "served plugin DIVERGED from source", detail);
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
