/**
 * Genericity, asserted against real repos rather than claimed.
 *
 * Phase 1 hardcoded the hub to STATE.md. A seven-repo survey found that correct in ONE.
 * These assert SHAPE, never frozen counts — a count here would fail every time someone
 * writes a doc, and a test that cries wolf gets deleted.
 *
 * A repo that is not on this machine is NAMED AND COUNTED as skipped. A table row that
 * silently does not run is the check that cannot fail (rule:discernment-checks §1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
const GH = path.join(os.homedir(), "Documents", "GitHub");

function run(dir, mode = "report", ...extra) {
  try {
    return { code: 0, out: execFileSync("node", [CLI, mode, dir, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const skipped = [];
function onRepo(name, dir, fn) {
  test(name, (t) => {
    if (!existsSync(dir)) {
      skipped.push(dir);
      t.diagnostic(`SKIPPED — ${dir} is not on this machine`);
      return;
    }
    fn();
  });
}

// --- the four repos whose real hub is NOT STATE.md, or not only STATE.md ---

onRepo("Motherboard: STATE.md seeds, and no doc is counted twice via .worktrees", path.join(GH, "Motherboard"), () => {
  const { code, out } = run(path.join(GH, "Motherboard"));
  assert.equal(code, 0);
  assert.match(out, /hub `[^`]*STATE\.md/);
  assert.match(out, /discovery: git \(/, "git excludes worktrees and submodules for free");
  // Read the node list, not the rendered tables: a doc legitimately appears in several
  // tables (its kind section, dangling, relinkable), so scraping markdown counted 173 rows
  // for 65 docs and the ASSERTION was wrong, not the tool (rule:discernment-checks §4).
  const rows = JSON.parse(run(path.join(GH, "Motherboard"), "graph", "--json").out.replace(/^[^[]*/, ""));
  const paths = rows.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length, "a path appearing twice means a worktree was double-counted");
  assert.ok(!paths.some((p) => p.includes(".worktrees/")), "worktrees duplicate whole doc trees");
  assert.ok(!paths.some((p) => p.includes("node_modules")));
});

onRepo("VipinKaushik: docs/README.md seeds — its STATE.md links nothing", path.join(GH, "Vipin Kaushik/VipinKaushik"), () => {
  const { code, out } = run(path.join(GH, "Vipin Kaushik/VipinKaushik"));
  assert.equal(code, 0);
  assert.match(out, /hub `[^`]*docs\/README\.md/,
    "the hardcoded single STATE.md hub would have made this repo read as almost entirely detached");
});

onRepo("SSJK-mb: CLAUDE.md seeds despite there being no root README", path.join(GH, "PanditPawanKaushik/SSJK-mb"), () => {
  const dir = path.join(GH, "PanditPawanKaushik/SSJK-mb");
  assert.ok(!existsSync(path.join(dir, "README.md")), "premise: this repo has no root README");
  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /hub `[^`]*CLAUDE\.md/);
});

onRepo("propagate: SKILL.md seeds, and the result is not mostly orphans", path.join(os.homedir(), ".claude/skills/propagate"), () => {
  const { code, out } = run(path.join(os.homedir(), ".claude/skills/propagate"));
  assert.equal(code, 0);
  assert.match(out, /hub `[^`]*SKILL\.md/);
  const [, docs, orphans] = /(\d+) markdown files[\s\S]*?\*\*(\d+) orphan\*\*/.exec(out);
  assert.ok(Number(orphans) < Number(docs) / 2, `${orphans}/${docs} orphaned — a hub was probably missed`);
});

// --- the two repos that must NOT be analysed as if they were ordinary ---

onRepo("a single-file repo is hubless, says so LOUDLY, and exits non-zero when asked to grade", path.join(GH, "Tushar/Youvan"), () => {
  const dir = path.join(GH, "Tushar/Youvan");
  const rep = run(dir);
  assert.equal(rep.code, 0);
  assert.match(rep.out, /hub: none/);
  assert.match(rep.out, /SUPPRESSED/, "suppressing quietly is the failure this skill exists to catch");
  const orph = run(dir, "orphans");
  assert.equal(orph.code, 4, "grading with no reachable hub must be a non-zero refusal");
  assert.match(orph.out, /suppressed/i);
});

onRepo("an Obsidian vault is REFUSED, not silently reported clean", path.join(GH, "Rupali/Obsidian"), () => {
  const dir = path.join(GH, "Rupali/Obsidian");
  assert.ok(existsSync(path.join(dir, ".obsidian")), "premise: this is a vault");
  const { code, out } = run(dir);
  assert.equal(code, 5);
  assert.match(out, /wikilink/, "554 files this extractor cannot see must not read as a clean run");
});

// --- a repo with an ordinary shape, as the control ---

onRepo("keerti-job-radar has a hub and is graded normally", path.join(GH, "Keerti/keerti-job-radar"), () => {
  const { code, out } = run(path.join(GH, "Keerti/keerti-job-radar"));
  assert.equal(code, 0);
  assert.doesNotMatch(out, /hub: none/,
    "the survey called this hubless; measured, its README does link — the survey was wrong, not the tool");
});

test("no repo was silently skipped", () => {
  assert.deepEqual(skipped, [], `these rows did not run: ${skipped.join(", ")}`);
});
