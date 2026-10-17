/**
 * Run only the tests a change can affect: `npm run test:affected`.
 *
 *   node scripts/test-impact/affected.mjs [--base <ref>] [--files a,b] [--all] [--large] [--list]
 *
 * The map (tests/impact-map.json, built by map.mjs) says which repo files each test
 * depends on. The changed set is `git diff --name-only <base>` plus untracked files,
 * or --files. A test is selected when one of its deps IS a changed file, is a
 * directory listing that contains one, or is a recursive listing above one.
 *
 * SAFETY BAR (test impact analysis): the selection must contain every test the change
 * could affect, so the tool falls back to the FULL suite, and says why, whenever it
 * cannot be sure. "When in doubt run more, never less."
 *   - the map is missing or unreadable
 *   - the map was recorded on a commit that is not an ancestor of HEAD
 *   - a changed file is unknown to the map (no test depends on it, and it is not a
 *     test): a new source file, package.json, a test helper nobody imports yet
 *   - a changed test file is not in the map
 * Known gap, stated in docs/GOTCHAS: a branch no recorded run exercised, and a test
 * that clears its env, are the two ways a real dependency can be missing. The latter is
 * marked `partial` in the map and selected on any source change.
 *
 * Release, merge and CI still run everything; this is the working tier.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, MAP_PATH, TEST_ROOTS } from "./lib.mjs";
import { TEST_GLOBS } from "./map.mjs";

// Changed paths that no test reads and that cannot change a test's outcome. This is an
// EXEMPTION list on purpose (rule:derive-dont-curate): forgetting an entry costs a full
// run, never a missed test. It applies only AFTER dep matching, so a test that does read
// one of these paths still selects.
export const EXEMPT = ["tests/impact-map.json", "propagation/", ".code-review-graph/"];

// Not "source": a change here selects partial (clean-env) tests only if the test reads it.
// A file that most tests depend on makes "subset" a fiction; say so and run all.
const PERVASIVE = 0.5;

const NOT_SOURCE = ["tests/", "docs/", "propagation/"];

function matches(dep, f) {
  if (dep === f) return true;
  if (dep === "**") return true;
  if (dep.endsWith("/**")) return f.startsWith(dep.slice(0, -2));
  if (dep.endsWith("/")) {
    const dir = path.posix.dirname(f);
    return (dep === "./" ? "." : dep.slice(0, -1)) === dir;
  }
  return false;
}

function depKind(dep) {
  if (dep === "**" || dep.endsWith("/**")) return "tree";
  if (dep.endsWith("/")) return "dir listing";
  return "dep";
}

/**
 * Pure selection. `map` is the parsed impact map, `changed` repo-relative paths.
 * Returns { mode: "full"|"subset", reason, selected: [{test, why}], skippedLarge: [{test, why}], exempt: [] }.
 */
export function selectTests({ map, changed, includeLarge = false, ancestor = true, all = false }) {
  const full = (reason) => ({ mode: "full", reason, selected: [], skippedLarge: [], exempt: [] });
  if (all) return full("--all requested");
  if (!map || !map.tests || typeof map.tests !== "object" || Object.keys(map.tests).length === 0) {
    return full("map missing or empty — run `npm run test:record` to build tests/impact-map.json");
  }
  if (!ancestor) return full(`map was recorded on ${map.header?.commit ?? "an unknown commit"}, which is not an ancestor of HEAD — it describes other code`);

  const tests = map.tests;
  const names = Object.keys(tests);
  const isTestFile = (f) => TEST_ROOTS.some((r) => f.startsWith(`${r}/`)) && f.endsWith(".test.mjs");

  const exempt = [];
  const pulled = new Map(); // test -> why
  const pullWhy = (t, why) => {
    if (!pulled.has(t)) pulled.set(t, why);
  };

  for (const f of changed) {
    if (isTestFile(f) && !tests[f]) {
      // A deleted test is not a risk; an existing one the map has not seen is.
      if (existsSync(path.join(REPO, f))) return full(`changed test file ${f} is not in the map`);
      continue;
    }
    let hit = false;
    for (const t of names) {
      const dep = tests[t].deps.find((d) => matches(d, f));
      if (dep !== undefined) {
        hit = true;
        pullWhy(t, `${f} (${dep === f ? "dep" : `${depKind(dep)} ${dep}`})`);
      }
    }
    if (hit) {
      const n = names.filter((t) => tests[t].deps.some((d) => matches(d, f))).length;
      if (n >= PERVASIVE * names.length) {
        return full(`changed file ${f} is a dependency of ${n} of ${names.length} tests — a subset that large is the full suite in disguise`);
      }
    }
    if (!hit) {
      if (EXEMPT.some((e) => f === e || (e.endsWith("/") && f.startsWith(e)))) {
        exempt.push(f);
        continue;
      }
      return full(`changed file ${f} is unknown to the map — no test depends on it, so the map cannot say what it affects`);
    }
  }

  const sourceChanged = changed.find((f) => !NOT_SOURCE.some((p) => f.startsWith(p)) && !exempt.includes(f));
  for (const t of names) {
    const e = tests[t];
    if (e.partial && sourceChanged) pullWhy(t, `partial: starts a process with a cleared env, so its deps are incomplete; ${sourceChanged} changed`);
    if (e.tree && e.size === "small") pullWhy(t, "whole-tree check (cheap, always run)");
  }

  const selected = [];
  const skippedLarge = [];
  for (const [t, why] of [...pulled].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (tests[t].size === "large" && !includeLarge) skippedLarge.push({ test: t, why });
    else selected.push({ test: t, why });
  }
  return { mode: "subset", reason: "", selected, skippedLarge, exempt };
}

function git(args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function changedSet(base) {
  const diff = git(["diff", "--name-only", base]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...new Set([...diff, ...untracked].filter(Boolean))].sort();
}

function isAncestor(commit) {
  if (!commit) return false;
  return spawnSync("git", ["-C", REPO, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" }).status === 0;
}

function loadMap() {
  try {
    return JSON.parse(readFileSync(MAP_PATH, "utf8"));
  } catch {
    return null;
  }
}

function run(files) {
  // G56: a bare `node --test` writes to the production ledger; scope it like the npm script.
  const env = { ...process.env, PROPAGATE_STATE_DIR: path.join(process.env.TMPDIR || "/tmp", "propagate-test-state") };
  const r = spawnSync(process.execPath, ["--test", ...files], { cwd: REPO, stdio: "inherit", env });
  return r.status ?? 1;
}

function main() {
  const a = process.argv.slice(2);
  const val = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const base = val("--base") || "HEAD";
  const filesArg = val("--files");
  const map = loadMap();
  const changed = filesArg ? filesArg.split(",").map((s) => s.trim()).filter(Boolean) : changedSet(base);
  const sel = selectTests({
    map,
    changed,
    includeLarge: a.includes("--large"),
    all: a.includes("--all"),
    ancestor: map ? isAncestor(map.header?.commit) : false,
  });

  const total = map?.tests && typeof map.tests === "object" ? Object.keys(map.tests).length : 0;
  if (sel.mode === "full") {
    console.log(`selected ALL${total ? ` ${total}` : ""} · full suite · ${sel.reason}`);
    if (changed.some((f) => f.startsWith("skills/curate-docs/"))) console.log("note: skills/curate-docs has its own suite — `npm run test:curate-docs`");
    if (a.includes("--list")) return;
    process.exit(run(TEST_GLOBS));
  }

  const bySize = {};
  for (const s of sel.selected) bySize[map.tests[s.test].size] = (bySize[map.tests[s.test].size] || 0) + 1;
  const sizes = Object.entries(bySize).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  console.log(`selected ${sel.selected.length} of ${total} · ${sizes} · ${changed.length} changed file(s)${sel.exempt.length ? `, ${sel.exempt.length} exempt` : ""}`);
  for (const s of sel.selected) console.log(`  ${s.test}  <- ${s.why}`);
  if (sel.skippedLarge.length) {
    console.log(`skipped ${sel.skippedLarge.length} large test(s) that WOULD be selected (release/merge tier; --large includes them):`);
    for (const s of sel.skippedLarge) console.log(`  ${s.test}  <- ${s.why}`);
  }
  if (a.includes("--list") || sel.selected.length === 0) {
    if (sel.selected.length === 0) console.log("nothing to run");
    return;
  }
  process.exit(run(sel.selected.map((s) => s.test)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
