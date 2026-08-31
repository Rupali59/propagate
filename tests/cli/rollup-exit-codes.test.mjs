/**
 * `propagate rollup --check` exit codes, and the two defects that were live in a
 * fully green suite.
 *
 * WHY THIS FILE EXISTS. On 2026-08-31 the command was exercised by hand against the
 * real tree, immediately after 1336 tests passed, and two of its four documented exit
 * codes were wrong:
 *
 *   ABSENT reported 1 (stale) instead of 2 (could-not-run). "Stale" means the file
 *   exists and the tree moved past it — there is a body to compare and a diff to
 *   print. "Absent" means there is nothing to check. A fresh clone has no
 *   ECOSYSTEM.md by construction, so it reported the same status as a genuinely
 *   drifted tree, and any gate consuming the code could not tell them apart.
 *
 *   TRAILING CONTENT after the footer was SILENTLY DESTROYED. The body hash covers
 *   only the bytes between the body marker and the footer, so an append past the
 *   footer's closing `-->` was invisible to it. Appending one line and re-running
 *   discarded it with exit 0 — while the command's own header promises it "REFUSES
 *   rather than clobbering". For the most natural way a human edits a long generated
 *   file (scroll to the bottom, type), the guarantee was inverted.
 *
 * BOTH SURVIVED A GREEN SUITE, and the reason is the same in each case: every
 * existing hand-edit test edited the BODY, and every exit-code test asserted the
 * MESSAGE. `rule:safety-flag-needs-a-test` says to construct the input that takes the
 * unsafe path and assert the effect is absent — these are the inputs nobody
 * constructed. `rule:discernment-checks` §1: a check that cannot fail is worse than
 * no check, and a check aimed one inch to the left of the defect cannot fail.
 *
 * So these assert the EXIT CODE and the BYTES, never the wording. A test that
 * matched on "does not exist yet" would have passed against the broken build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function runCli(argv, { searchRoot, stateDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

/** A minimal workspace the rollup can walk, so `--check` has something to derive. */
async function fixture() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "rollup-exit-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "rollup-exit-state-"));
  const ws = path.join(searchRoot, "alpha");
  await mkdir(path.join(ws, "propagation", "state", "workspace"), { recursive: true });
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
  await writeFile(
    path.join(ws, "propagation", "state", "workspace", "STATE.md"),
    "# alpha\n\n## Now (in flight)\n\n- something open\n",
  );
  return { searchRoot, stateDir, artifact: path.join(searchRoot, "ECOSYSTEM.md") };
}

test("--check on an ABSENT artifact exits 2 (could-not-run), never 1 (stale)", async () => {
  const { searchRoot, stateDir, artifact } = await fixture();
  try {
    assert.equal(existsSync(artifact), false, "fixture must start with no artifact");
    const r = runCli(["rollup", "--check"], { searchRoot, stateDir });
    assert.equal(
      r.status,
      2,
      `absent must be could-not-run (2), got ${r.status}. 1 would say "I checked and it is stale", ` +
        `which is a different and false claim.`,
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("--check on a freshly generated artifact exits 0", async () => {
  const { searchRoot, stateDir, artifact } = await fixture();
  try {
    const gen = runCli(["rollup"], { searchRoot, stateDir });
    assert.equal(gen.status, 0, `generate failed: ${gen.stderr}`);
    assert.equal(existsSync(artifact), true, "rollup must have written the artifact");
    const r = runCli(["rollup", "--check"], { searchRoot, stateDir });
    assert.equal(r.status, 0, `freshly generated must be current (0), got ${r.status}`);
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("content appended AFTER the footer is detected (3) and NOT clobbered", async () => {
  const { searchRoot, stateDir, artifact } = await fixture();
  try {
    assert.equal(runCli(["rollup"], { searchRoot, stateDir }).status, 0);

    const SENTINEL = "a human appended this after the footer";
    writeFileSync(artifact, readFileSync(artifact, "utf8") + `\n${SENTINEL}\n`);
    const before = readFileSync(artifact);

    const chk = runCli(["rollup", "--check"], { searchRoot, stateDir });
    assert.equal(chk.status, 3, `trailing content must read as hand-edited (3), got ${chk.status}`);

    // THE LOAD-BEARING ASSERTION: the artifact, not the message. A regenerate here
    // is the defect, and it exited 0 while doing it.
    const gen = runCli(["rollup"], { searchRoot, stateDir });
    assert.equal(gen.status, 3, `rollup over a hand edit must refuse (3), got ${gen.status}`);
    assert.deepEqual(
      readFileSync(artifact),
      before,
      "rollup must not have touched a hand-edited file — refuse, never clobber",
    );
    assert.ok(
      readFileSync(artifact, "utf8").includes(SENTINEL),
      "the appended line must survive verbatim",
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("--force is the documented way past a hand edit, and only --force", async () => {
  const { searchRoot, stateDir, artifact } = await fixture();
  try {
    assert.equal(runCli(["rollup"], { searchRoot, stateDir }).status, 0);
    writeFileSync(artifact, readFileSync(artifact, "utf8") + "\ntrailing\n");

    // Without --force: refuses, bytes unchanged (asserted above too; repeated here
    // so this test fails for its OWN reason rather than depending on the other).
    const before = readFileSync(artifact);
    assert.equal(runCli(["rollup"], { searchRoot, stateDir }).status, 3);
    assert.deepEqual(readFileSync(artifact), before);

    // With --force: overwrites, and the trailing line is gone by explicit instruction.
    const forced = runCli(["rollup", "--force"], { searchRoot, stateDir });
    assert.equal(forced.status, 0, `--force must regenerate, got ${forced.status}: ${forced.stderr}`);
    assert.ok(
      !readFileSync(artifact, "utf8").includes("\ntrailing\n"),
      "--force must actually discard the edit, or it is a no-op wearing a flag",
    );
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a body edit is still detected — the original guard is not weakened by the new one", async () => {
  const { searchRoot, stateDir, artifact } = await fixture();
  try {
    assert.equal(runCli(["rollup"], { searchRoot, stateDir }).status, 0);
    const text = readFileSync(artifact, "utf8");
    assert.ok(text.includes("## Per-workspace"), "fixture render must contain the body section");
    writeFileSync(artifact, text.replace("## Per-workspace", "## Per-workspace\n\nEDITED IN BODY."));
    const before = readFileSync(artifact);

    assert.equal(runCli(["rollup", "--check"], { searchRoot, stateDir }).status, 3);
    assert.equal(runCli(["rollup"], { searchRoot, stateDir }).status, 3);
    assert.deepEqual(readFileSync(artifact), before, "body hand edit must survive untouched");
  } finally {
    await rm(searchRoot, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
