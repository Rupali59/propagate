/**
 * No executable path literal for a known root (`.claude`, `.propagate`,
 * `.agents`, `.claude.json`) may appear outside lib/core/paths.mjs.
 *
 * WHY THIS EXISTS. `~/.claude/plans/i-saw-it-what-starry-sparkle.md` (N96):
 * three components -- the rules loader, the rule-guard hook, and doctor's own
 * checker -- each independently computed `~/.claude/rules` and agreed today
 * only by coincidence. lib/core/paths.mjs (Lane A) gives every caller a
 * single place to read that path from; this test is the guard that stops a
 * fourth literal from growing back once paths.mjs exists to prevent it.
 *
 * WHY THIS IS NOT A BLANKET GREP. tests/portability/portability-literals.test.mjs:1-23
 * already raises the objection: a regex for a path fragment cannot tell an
 * executable literal from the docstring explaining why that literal was
 * wrong, and this repo is full of the latter ON PURPOSE -- incident
 * write-ups, dashboard prose, and shell commands printed for a human to run
 * all cite real paths because that is what makes them legible. Answering
 * that objection the way tests/unit/bare-reference-guard.test.mjs answers the
 * analogous one for bare `lib/` calls:
 *
 *   1. Skip comment lines (`/^\s*(\*|\/\/)/`). Most of the false positives
 *      this very file's header would otherwise trip live in comments -- this
 *      guard's own docstring says `.claude` and `.propagate` a dozen times.
 *
 *   2. Require the literal to be a WHOLE quoted argument to `path.join(...)`
 *      or `path.resolve(...)`, not merely present on the line. This is what
 *      keeps the guard out of:
 *        - `.claude-plugin` (lib/core/release.mjs, lib/skills/skills-scan.mjs)
 *          -- a different, marketplace-internal directory. The literal
 *          ".claude-plugin" does not equal, and does not path-segment-prefix,
 *          ".claude", so it never matches the root patterns below.
 *        - a bare directory-skip-list array (lib/edges/edges.mjs:53) and a
 *          basename comparison (lib/edges/journal.mjs:71) -- neither calls
 *          path.join/path.resolve with the literal, so neither is a path
 *          construction at all.
 *        - display strings for a human (lib/report/doctor/delivery.mjs,
 *          lib/report/doctor/environment.mjs, lib/report/inventory.mjs's
 *          liveness_probe text, lib/report/rollup.mjs, lib/report/caps.mjs)
 *          -- these embed "~/.claude/..." inside prose or a shell command
 *          template string; they build no path.join/path.resolve call at all.
 *
 *   3. Require the call's FIRST argument to be exactly the identifier `HOME`
 *      or the call `os.homedir()` -- the only two spellings in this codebase
 *      that resolve to the real home directory. This is what keeps the guard
 *      off lib/core/release.mjs:388's `path.join(home, ".propagate")`: same
 *      literal, same shape, but `home` there is a local fixture variable
 *      the stranger-install test builds for a throwaway HOME -- guarding
 *      HOME-rooted joins must not catch a join rooted in a same-named local
 *      variable. It is also why hand-rolled tilde expansion
 *      (lib/edges/cross-repo.mjs:59, lib/core/setup.mjs:90,
 *      commands/setup.mjs:55,118,170) is out of scope on a second,
 *      independent ground: those join HOME (or os.homedir()) with a RUNTIME
 *      slice of a user-supplied string (`p.slice(1)`, `r.slice(2)`), never a
 *      literal root -- there is no known-root literal on those lines for
 *      this guard to find in the first place.
 *
 * NO FILE IS EXEMPT. lib/core/config.mjs needed an exception until
 * PATHS["propagate.stateDirDefault"] existed. It does now, so the guard
 * holds every file to the same rule — pinned by its own test below.
 *
 * Run: `npm test` (G56 -- never bare `node --test`, that writes to the
 * production event ledger).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The four roots N96 found duplicated, per the plan this test guards. */
const ROOTS = [".claude", ".propagate", ".agents", ".claude.json"];

/** Matches a quoted string whose content IS one of ROOTS, or is one of
 * ROOTS followed by a path separator (a combined literal like ".claude/rules"
 * written as one segment rather than a further path.join argument). Anchored
 * with (["'])...\1 so ".claude-plugin" -- a different literal that merely
 * shares a prefix -- never matches: the character after ".claude" must be
 * the closing quote or "/", never "-".
 */
const ROOT_ARG_RE = new RegExp(
  `(["'])(${ROOTS.map((r) => r.replace(/\./g, "\\.")).join("|")})(?:/[^"']*)?\\1`,
);

/** A path.join/path.resolve call whose FIRST argument is HOME or os.homedir(). */
const HOME_ROOTED_CALL_RE = /\bpath\s*\.\s*(?:join|resolve)\s*\(\s*(?:HOME\b|os\s*\.\s*homedir\s*\(\s*\))/;

/**
 * Offenders in one file's source: executable lines that call
 * path.join/path.resolve rooted at HOME (or os.homedir()) with one of the
 * four known-root literals as a later argument.
 */
function findOffenders(relPath, src) {
  const found = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\*|\/\/)/.test(line)) continue; // comment -- the objection this test must answer
    if (!HOME_ROOTED_CALL_RE.test(line)) continue; // not a HOME-rooted join/resolve call at all
    if (!ROOT_ARG_RE.test(line)) continue; // no known-root literal argument on this line
    found.push({ line: i + 1, text: line.trim().slice(0, 140) });
  }
  return found;
}

/** git ls-files, tracked + untracked, filtered to the plan's corpus. */
function corpus() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => f === "cli.mjs" || /^(lib|commands|hooks)\//.test(f))
    .filter((f) => f !== "lib/core/paths.mjs"); // the registry itself
  return files;
}

const CORPUS = corpus();

test("the scan has inputs — an empty corpus must not read as a pass", () => {
  // rule:discernment-checks §1 and §2. G48 (no-literal-nul.test.mjs): a scan
  // that cannot see its own corpus reports health for something it never
  // looked at. cli.mjs plus everything currently under lib/, commands/ and
  // hooks/ is well over a hundred files; a floor of 50 catches "the filter
  // regex stopped matching" or "corpus() returned the wrong cwd" without
  // being so tight that ordinary file churn trips it.
  assert.ok(CORPUS.length > 50, `only ${CORPUS.length} corpus files found — the filter likely broke`);
  assert.ok(CORPUS.includes("cli.mjs"), "cli.mjs must be in the corpus");
  assert.ok(CORPUS.some((f) => f.startsWith("lib/")), "no lib/ files in the corpus");
  assert.ok(CORPUS.some((f) => f.startsWith("commands/")), "no commands/ files in the corpus");
  assert.ok(CORPUS.some((f) => f.startsWith("hooks/")), "no hooks/ files in the corpus");
});

test("the scan CAN fail — a planted literal on an executable line is caught, the same text in a comment is not", () => {
  // Both directions, per the task brief and rule:discernment-checks §1 — a
  // check that cannot fail is worse than no check, and a check that fires on
  // a comment is a grep with better manners, not this guard.
  const executable = 'export const X = path.join(HOME, ".claude", "rogue.json");\n';
  // Confirm the mutation actually applies before trusting its result (the
  // task brief's "confirm every mutation applies" — a sed/regex that matches
  // nothing has silently no-op'd this exact check before).
  assert.ok(executable.includes('path.join(HOME, ".claude"'), "planted literal did not land in the fixture source");

  const hitsExecutable = findOffenders("lib/scratch-fixture.mjs", executable);
  assert.equal(hitsExecutable.length, 1, "the scan failed to flag a planted executable HOME-rooted literal");
  assert.equal(hitsExecutable[0].line, 1);

  const commented = `// export const X = path.join(HOME, ".claude", "rogue.json");\n`;
  assert.ok(commented.trim().startsWith("//"), "planted comment did not land in the fixture source");
  const hitsCommented = findOffenders("lib/scratch-fixture.mjs", commented);
  assert.equal(hitsCommented.length, 0, "the scan must not flag the identical literal inside a comment");
});

test("the scan does not flag the documented legitimate shapes", () => {
  // Each shape from the task brief's exception list, reproduced verbatim
  // enough to exercise the guard the way the real file does. A guard held
  // together by exceptions it cannot actually distinguish is worse than none
  // (the objection portability-literals.test.mjs raises) — so this proves
  // each one is excluded by the RULE, not by a name-based skip.
  const cases = {
    "a .claude-plugin literal (different directory, shares a prefix only)":
      'const mp = path.join(marketplaceDir, ".claude-plugin", "marketplace.json");\n',
    "a bare directory-skip-list array entry, not a path.join argument":
      'const SKIP = new Set([".next", "dist", ".claude"]);\n',
    "a basename comparison, not a join":
      'if (e.name.startsWith(".") && e.name !== ".claude") continue;\n',
    "a display string for a human, no path.join/path.resolve call at all":
      'reporter.info("plugin", "not installed — no served tree under ~/.claude/plugins/cache.");\n',
    "a fixture HOME (local lowercase variable, not the real HOME)":
      'const env = { ...process.env, HOME: home, PROPAGATE_STATE_DIR: path.join(home, ".propagate") };\n',
    "hand-rolled tilde expansion — HOME-rooted, but no literal root argument":
      'function expandHome(p) { return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p; }\n',
  };
  for (const [why, src] of Object.entries(cases)) {
    assert.deepEqual(findOffenders("lib/scratch-fixture.mjs", src), [], `should not flag: ${why}`);
  }
});

test("lib/core/config.mjs is NOT exempt — the exception it needed no longer exists", () => {
  // It used to need one. `paths.mjs` had no .propagate entry, so config.mjs was
  // structurally forced to hand-roll `path.join(HOME, ".propagate")` twice:
  // CONFIG_ROOT's fallback, and ensureStateDir's DEFAULT — which fires WHEN
  // PROPAGATE_STATE_DIR is set but unusable, so it cannot call stateDir() again
  // and get a different answer. Adding PATHS["propagate.stateDirDefault"]
  // removed the need, and with it the exemption.
  //
  // This test exists because a removed exception is exactly the kind of thing
  // that creeps back. config.mjs is held to the same rule as every other file.
  const expr = 'const CONFIG_ROOT = process.env.PROPAGATE_STATE_DIR || path.join(HOME, ".propagate");\n';
  assert.equal(
    findOffenders("lib/core/config.mjs", expr).length,
    1,
    "config.mjs must be held to the same rule as every other file — no exemption, file-wide or expression-wide",
  );
  assert.equal(findOffenders("lib/edges/example.mjs", expr).length, 1, "and the same expression elsewhere is still caught");
});

test("no executable path literal for a known root appears outside lib/core/paths.mjs", () => {
  const offenders = [];
  for (const rel of CORPUS) {
    const abs = path.join(REPO, rel);
    if (!existsSync(abs)) continue; // deleted-but-tracked; not this test's business
    const src = readFileSync(abs, "utf8");
    for (const hit of findOffenders(rel, src)) {
      offenders.push(`${rel}:${hit.line}  ${hit.text}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `path literal(s) for a known root (${ROOTS.join(", ")}) found outside lib/core/paths.mjs — ` +
      `add a PATHS entry there and import it instead:\n  ${offenders.join("\n  ")}`,
  );
});
