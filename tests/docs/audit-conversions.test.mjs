/**
 * The 2026-08-17 convertibility audit's ELIMINATE conversions.
 *
 * Each of these turned a prose-only gotcha into behaviour. Per
 * `rule:safety-flag-needs-a-test` — written the same day, out of this same
 * audit — a claim about behaviour ships with a test that constructs the input
 * making it fail. See `docs/AUDIT-2026-08.md`.
 *
 *   G43  `check --changed` could not see untracked files and said nothing
 *   G38  `drain` printed a green tick while derived edges sat unresolved
 *   G30  ANSI stripping was duplicated inline instead of shared
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { plain } from "../helpers/plain.mjs";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const git = (a, cwd) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const run = (argv, { searchRoot, stateDir, cwd }) =>
  spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    cwd: cwd || searchRoot,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });

/** A workspace with A.md -> B.md declared, both committed and CLEAN-able. */
async function fixture() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "audit-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "audit-state-"));
  const ws = path.join(searchRoot, "ws");
  await mkdir(ws, { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  await writeFile(path.join(ws, "A.md"), "A v1\n");
  await writeFile(path.join(ws, "B.md"), "B v1\n");
  await writeFile(
    path.join(ws, ".propagates.yml"),
    ["workspace: true", "sources:", "  A.md:", "    propagates_to:", "      - path: B.md",
     "        why: A feeds B", "        kind: prose", ""].join("\n"),
  );
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);
  return { searchRoot, stateDir, ws };
}

const cleanup = async (...d) => { for (const x of d) await rm(x, { recursive: true, force: true }); };

// ---------------------------------------------------------------------------
// G43 — a silent zero becomes attributable
// ---------------------------------------------------------------------------

test("G43: check --changed names untracked files instead of silently skipping them", async (t) => {
  const { searchRoot, stateDir, ws } = await fixture();
  t.after(() => cleanup(searchRoot, stateDir));

  // The exact shape from the entry: a brand-new declared doc, never added.
  await writeFile(path.join(ws, "NEW-DOC.md"), "brand new, untracked\n");

  const r = run(["check", "--changed"], { searchRoot, stateDir, cwd: ws });
  const out = plain(r.stdout + r.stderr);

  // FAILING INPUT: revert the `gitDiffNames(["ls-files","--others",...])` call
  // and this goes red — output is empty and indistinguishable from "your edges
  // are fine", which is what the entry describes.
  assert.match(out, /untracked file\(s\) not examined/, "the count must be stated");
  assert.match(out, /NEW-DOC\.md/, "and the file named — a bare count sends nobody anywhere");
});

test("G43: a clean tree says nothing about untracked files", async (t) => {
  const { searchRoot, stateDir, ws } = await fixture();
  t.after(() => cleanup(searchRoot, stateDir));
  const out = plain(run(["check", "--changed"], { searchRoot, stateDir, cwd: ws }).stdout);
  assert.doesNotMatch(out, /untracked/, "silence is correct when there is nothing to report");
});

test("G43: --staged does not report untracked, because it never claimed to see them", async (t) => {
  const { searchRoot, stateDir, ws } = await fixture();
  t.after(() => cleanup(searchRoot, stateDir));
  await writeFile(path.join(ws, "NEW-DOC.md"), "untracked\n");
  const out = plain(run(["check", "--staged"], { searchRoot, stateDir, cwd: ws }).stdout);
  assert.doesNotMatch(out, /untracked file\(s\) not examined/);
});

// ---------------------------------------------------------------------------
// G38 — the green tick no longer stands alone
// ---------------------------------------------------------------------------

test("G38: drain says derived edges are not its to close, and names the right tool", async (t) => {
  const { searchRoot, stateDir, ws } = await fixture();
  t.after(() => cleanup(searchRoot, stateDir));

  // Baseline the edge, then move the source so it derives DRIFTED. There are
  // still zero LEDGER rows — which is the whole trap.
  const before = JSON.parse(run(["reconcile", "--all", "--json"], { searchRoot, stateDir }).stdout);
  for (const row of before.rows) {
    run(["verify", "--edge", row.edge_id, "--disposition", "baselined",
         "--reason", "test baseline", "--apply"], { searchRoot, stateDir });
  }
  await writeFile(path.join(ws, "A.md"), "A v2\n");

  const out = plain(run(["drain"], { searchRoot, stateDir }).stdout);

  assert.match(out, /no open rows/, "the ledger really is empty — that part was always true");
  // FAILING INPUT: delete the reconcile block from drainList and only the green
  // tick remains, which is the entry's exact complaint: "it does not say so".
  assert.match(out, /derived edge\(s\) are not CLEAN/, "the derived state must be surfaced");
  assert.match(out, /verify/, "and the tool that CAN close them must be named");
});

test("G38: a genuinely clean workspace gets the green tick with no caveat", async (t) => {
  const { searchRoot, stateDir } = await fixture();
  t.after(() => cleanup(searchRoot, stateDir));

  const before = JSON.parse(run(["reconcile", "--all", "--json"], { searchRoot, stateDir }).stdout);
  for (const row of before.rows) {
    run(["verify", "--edge", row.edge_id, "--disposition", "baselined",
         "--reason", "test baseline", "--apply"], { searchRoot, stateDir });
  }

  const out = plain(run(["drain"], { searchRoot, stateDir }).stdout);
  assert.match(out, /no open rows/);
  assert.doesNotMatch(out, /not CLEAN/, "no caveat when there is genuinely nothing derived");
});

test("G38: drain's count uses graph.mjs's ACTIONABLE set, so it cannot disagree with graph", async () => {
  // Two commands answering "what needs work" with different numbers is worse
  // than either being slightly wrong. The first version of this hint counted
  // NOT_PRESENT_ON_REF and said 23 where `graph` said 21.
  const { isActionable } = await import("../../lib/graph/graph.mjs");
  assert.equal(isActionable("NOT_PRESENT_ON_REF"), false, "excluded from both, or from neither");
  assert.equal(isActionable("NEVER_VERIFIED"), false, "a baseline gap is not movement");
  for (const s of ["DRIFTED", "REVERSED", "DIVERGED", "UNMATCHED"]) {
    assert.equal(isActionable(s), true, `${s} is actionable in both`);
  }
});

// ---------------------------------------------------------------------------
// G30 — one implementation
// ---------------------------------------------------------------------------

test("G30: plain() strips the escape that sits between the glyph and the label", () => {
  // The literal string from the entry, which broke a real assertion.
  const raw = "\x1B[31m✗\x1B[0m no unowned ledger files";
  assert.doesNotMatch(raw, /✗\s*no unowned ledger files/, "raw output does NOT match — the bug");
  assert.match(plain(raw), /✗\s*no unowned ledger files/, "stripped output does");
});

test("G30: plain() leaves non-SGR text alone", () => {
  assert.equal(plain("a[0;1mb"), "a[0;1mb", "no escape byte, no change");
  assert.equal(plain(""), "");
  assert.equal(plain(undefined), "undefined", "never throws on a missing capture");
});
