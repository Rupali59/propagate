/**
 * `propagate rollup --dry-run` must never write `ECOSYSTEM.md` — under ANY
 * flag combination, and against EVERY reachable state of the artifact.
 *
 * `rule:safety-flag-needs-a-test`, stated at its head: "Not 'the flag is
 * read'. Not 'the happy path works'. UNREACHABLE — construct the input that
 * would take the unsafe path and assert it does not." So this measures the
 * SIDE EFFECT (a byte-for-byte snapshot of the artifact before and after),
 * never stdout text — a guard that trusts the tool's own description of
 * itself ("would write...") is exactly the failure the rule exists to catch.
 * `tests/digest/digest-dryrun.test.mjs` is the sister case for the exact
 * defect this rule was written about: a `dryRun` parameter that gated the
 * top-level function while a NESTED call ignored it, so a documented preview
 * ran an armed write. `commands/rollup.mjs` has exactly one `writeFileSync`
 * call and it is gated on `!dryRun` — this file is what proves that gate
 * actually holds under every combination the CLI accepts, not just the one
 * that was reasoned about.
 *
 * FOUR FIXTURE STATES, each its own top-level `test()` so a failure names
 * WHICH state broke the guard rather than reporting one bulk failure:
 *   - absent       — the artifact has never been generated. MUST STAY ABSENT:
 *                     a zero-byte file created by an unguarded write is a
 *                     DIFFERENT value from "no file", and `existsSync` alone
 *                     would not catch a write that reproduced the same bytes
 *                     by coincidence — `snap()` below returns a marker
 *                     Symbol, not a falsy value, specifically so "the file
 *                     exists and is empty" cannot be confused with "absent".
 *   - current      — a real, freshly-generated file. The unguarded-write
 *                     regression here is invisible in a plain existence
 *                     check (the file is already there) and only shows up in
 *                     a byte comparison, which is why `snap()` reads content.
 *   - stale        — a real, self-consistent generated file (its own footer
 *                     matches its own body) whose underlying inputs have
 *                     since moved. This is the case the unguarded write
 *                     path in `digest.mjs`'s 2026-08-14 incident actually
 *                     HIT: staleness is precisely when a real run WOULD
 *                     write something different, so it is the sharpest test
 *                     of whether `--dry-run` truly suppresses the write.
 *   - hand-edited  — the body between the two markers was edited directly,
 *                     so its recomputed hash no longer matches the footer's
 *                     stored `body:`. `--dry-run` must not write here either,
 *                     even though the un-dry-run behaviour (refuse, exit 3)
 *                     already would not write on its own — this test is what
 *                     proves `--dry-run` does not change that refusal into a
 *                     silent `--force`-shaped write.
 *
 * FLAG COMBINATIONS, per the plan's own loop, `--dry-run --force` INCLUDED
 * deliberately: "the nested-path candidate" — `--force` bypasses the
 * hand-edit refusal inside `runGenerate`, so if `dryRun` were checked only
 * BEFORE that bypass (or only after it) rather than gating the single
 * `writeFileSync` call directly, this is the combination that would catch
 * it. `--dry-run --check` is also in the loop: `--check` never writes on
 * its own, so this combination asserts the two flags do not interact badly
 * (e.g. `--check`'s branch somehow falling through to the writer).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderRollup, rollup } from "../../lib/report/rollup.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));
const ROLLUP_MJS_PATH = fileURLToPath(new URL("../../commands/rollup.mjs", import.meta.url));

/** Distinguishable from "empty string" and from "file exists" — see header. */
const ABSENT = Symbol.for("propagate:rollup-test:absent");

function snap(p) {
  return existsSync(p) ? readFileSync(p) : ABSENT;
}

async function scopedRoots() {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "rollup-dryrun-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "rollup-dryrun-state-"));
  return { searchRoot, stateDir };
}

function runCli(argv, { searchRoot, stateDir }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

// Every `--dry-run` invocation the CLI is asked to support, per the plan's
// own loop verbatim (Verification §1).
const FLAG_COMBOS = [[], ["--json"], ["--force"], ["--check"], ["--json", "--force"]];

/**
 * Build one of the four fixture states inside `searchRoot`/`stateDir` and
 * return the artifact path. Each builder calls the REAL `rollup()` /
 * `renderRollup()` (never a hand-rolled stand-in for the real render), so a
 * "current" or "stale" fixture is byte-for-byte what the tool itself would
 * produce — the only way "stale" can be trusted to mean what a live run
 * would actually see as different.
 */
async function buildFixture(state, { searchRoot, stateDir }) {
  const artifact = path.join(searchRoot, "ECOSYSTEM.md");

  if (state === "absent") return artifact;

  if (state === "current") {
    const r = runCli(["rollup"], { searchRoot, stateDir });
    assert.equal(r.status, 0, `fixture setup: real rollup write failed: ${r.stdout}${r.stderr}`);
    assert.ok(existsSync(artifact), "fixture setup: rollup did not create the artifact");
    return artifact;
  }

  if (state === "stale") {
    // Render once against a tree that HAS a project (so the footer carries
    // a real, non-trivial input), write it, then change what that input
    // resolves to — a second, DIFFERENT owner project appears — without
    // touching the artifact. The file on disk stays self-consistent (its
    // own footer matches its own body) while no longer matching what a
    // fresh derivation would produce, which is the actual definition of
    // "stale" this tool uses (see `compareInputs` in lib/report/rollup.mjs).
    const projectDir = path.join(searchRoot, "demo-project", "propagation", "state", "workspace");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "STATE.md"), "# demo — v1\n\nOpen: nothing yet.\n");
    const r1 = runCli(["rollup"], { searchRoot, stateDir });
    assert.equal(r1.status, 0, `fixture setup: first rollup write failed: ${r1.stdout}${r1.stderr}`);
    const before = readFileSync(artifact);
    await writeFile(path.join(projectDir, "STATE.md"), "# demo — v2\n\nOpen: a new item.\n");
    const after = snap(artifact);
    assert.deepEqual(after, before, "fixture setup: editing the INPUT must not touch the artifact itself");
    // Sanity: the underlying derivation really did change, or this fixture
    // is not testing staleness at all (rule:discernment-checks §1 — a check
    // that cannot fail is worse than no check).
    const fresh = rollup({ searchRoots: [searchRoot] });
    const freshText = renderRollup(fresh);
    assert.notEqual(freshText, before.toString("utf8"), "fixture setup: the fixture is not actually stale — inputs did not change the render");
    return artifact;
  }

  if (state === "hand-edited") {
    const r = runCli(["rollup"], { searchRoot, stateDir });
    assert.equal(r.status, 0, `fixture setup: real rollup write failed: ${r.stdout}${r.stderr}`);
    const original = readFileSync(artifact, "utf8");
    assert.match(original, /## Coverage/, "fixture setup: expected render shape not found — update this fixture if renderRollup's shape changes");
    const edited = original.replace("## Coverage", "## Coverage (edited by hand, not by propagate)");
    assert.notEqual(edited, original, "fixture setup: the replace() must actually change the text");
    await writeFile(artifact, edited);
    return artifact;
  }

  throw new Error(`unknown fixture state: ${state}`);
}

for (const state of ["absent", "current", "stale", "hand-edited"]) {
  test(`--dry-run never writes ECOSYSTEM.md — fixture: ${state}`, async () => {
    const roots = await scopedRoots();
    try {
      const artifact = await buildFixture(state, roots);
      for (const extra of FLAG_COMBOS) {
        const before = snap(artifact);
        const argv = ["rollup", "--dry-run", ...extra];
        const r = runCli(argv, roots);
        const after = snap(artifact);
        assert.deepEqual(
          after,
          before,
          `[${state}] \`${argv.join(" ")}\` must not write ${artifact} — before/after snapshots differ ` +
            `(exit ${r.status}; stdout: ${r.stdout.slice(0, 300)}; stderr: ${r.stderr.slice(0, 300)})`,
        );
      }
    } finally {
      await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}

test("absent fixture specifically: a zero-byte file is a DIFFERENT value from ABSENT and must not appear", async () => {
  // Belt-and-suspenders on the "absent" case above: assert directly that no
  // file — zero-byte or otherwise — exists at the artifact path after every
  // combination, not merely that snap() before/after matched (which an
  // unguarded write producing the SAME zero bytes twice could not catch,
  // if snap() were reading only a boolean rather than content+existence).
  const roots = await scopedRoots();
  try {
    const artifact = path.join(roots.searchRoot, "ECOSYSTEM.md");
    for (const extra of FLAG_COMBOS) {
      runCli(["rollup", "--dry-run", ...extra], roots);
      assert.equal(existsSync(artifact), false, `\`rollup --dry-run ${extra.join(" ")}\` created ${artifact} where none should exist`);
    }
  } finally {
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// §2 of the plan's verification: assert the SOURCE never contains an
// unconditional writeFileSync, and that the one call site it does have is
// gated on `!dryRun`, threaded from argv. Source-level, deliberately, same
// discipline as tests/digest/digest-dryrun.test.mjs — the property being
// asserted ("this parameter reaches this call site") is a wiring fact, not
// a behavioural one, and is cheaper and more precise to assert as text than
// to try to trigger from outside via every possible code path.
// ─────────────────────────────────────────────────────────────────────────

const ROLLUP_CMD_SRC = readFileSync(ROLLUP_MJS_PATH, "utf8");

test("commands/rollup.mjs contains exactly one writeFileSync call", () => {
  const matches = ROLLUP_CMD_SRC.match(/\bwriteFileSync\s*\(/g) || [];
  assert.equal(matches.length, 1, `expected exactly one writeFileSync call, found ${matches.length}`);
});

test("the one writeFileSync call is reached only inside `if (!dryRun)`", () => {
  // Anchor on the marked call site (the file comments it explicitly) and
  // walk backwards to the nearest guarding `if`, asserting it is the dryRun
  // negation and nothing else sits between the guard and the call that
  // could let a different branch reach it unguarded.
  const idx = ROLLUP_CMD_SRC.indexOf("writeFileSync(artifact, text)");
  assert.notEqual(idx, -1, "could not locate the writeFileSync(artifact, text) call site — did the source change shape?");
  const before = ROLLUP_CMD_SRC.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /if\s*\(\s*!\s*dryRun\s*\)/, "the write call site must be preceded by `if (!dryRun)` within the surrounding block");
});

test("`dryRun` is threaded from argv through rollupCmd -> runGenerate, not re-derived", () => {
  // Three links, each asserted separately so a failure names which one
  // broke (same shape as digest-dryrun.test.mjs's four-link chain test).
  assert.match(ROLLUP_CMD_SRC, /const\s+dryRun\s*=\s*argv\.includes\(\s*["']--dry-run["']\s*\)/, "rollupCmd must parse --dry-run from argv into a `dryRun` const");
  assert.match(ROLLUP_CMD_SRC, /runGenerate\(\s*\{\s*artifact,\s*json,\s*dryRun,\s*force\s*\}\s*\)/, "rollupCmd must pass dryRun through to runGenerate by name");
  assert.match(ROLLUP_CMD_SRC, /async function runGenerate\(\{\s*artifact,\s*json,\s*dryRun,\s*force\s*\}\)/, "runGenerate must accept dryRun as a parameter, not read a module-level flag");
});

// ─────────────────────────────────────────────────────────────────────────
// §3 of the plan's verification: mutate the guard and confirm the test
// suite above goes red FOR THE STATED REASON — not merely "some assertion
// somewhere failed". Run as a subprocess against a temp copy of the file so
// this test file never edits its own dependency in place. Skipped rather
// than failed if the source shape has drifted enough that the mutation
// cannot be located, per rule:discernment-checks §1's own corollary: a
// mutation test that silently no-ops on a shape change is exactly the
// "sed matched nothing" failure the rule warns about, so this asserts the
// mutation TEXT CHANGED before trusting the run that follows it.
// ─────────────────────────────────────────────────────────────────────────

test("mutating the dry-run guard makes the safety tests fail, for the stated reason", async () => {
  const mutated = ROLLUP_CMD_SRC.replace("if (!dryRun) {", "if (true) {");
  assert.notEqual(
    mutated,
    ROLLUP_CMD_SRC,
    "the guard-mutation replace() matched nothing — commands/rollup.mjs's shape changed; update this test's search string",
  );
  // .replace() without a global flag touches the FIRST match only — confirm
  // that was the intended one (the write guard) and not some other, earlier
  // `if (!dryRun)` (e.g. a doc-comment reference), by counting occurrences.
  const guardCount = (ROLLUP_CMD_SRC.match(/if \(!dryRun\) \{/g) || []).length;
  assert.equal(guardCount, 1, `expected exactly one \`if (!dryRun) {\` block, found ${guardCount} — this mutation would hit the wrong one`);
  assert.match(mutated, /if \(true\) \{/, "the mutated source must actually contain the disarmed guard");

  // Shadow tree: only commands/rollup.mjs is swapped for the mutated text;
  // everything it imports (lib/, commands/ansi.mjs) is the REAL code, via a
  // symlinked lib/ and a byte-for-byte copy of ansi.mjs — never a second
  // stand-in for the module under test, which would test the copy and not
  // the guard.
  const tmpRepo = await mkdtemp(path.join(tmpdir(), "rollup-mutation-"));
  const roots = await scopedRoots();
  try {
    const commandsDir = path.join(tmpRepo, "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(path.join(commandsDir, "rollup.mjs"), mutated);
    await writeFile(
      path.join(commandsDir, "ansi.mjs"),
      readFileSync(fileURLToPath(new URL("../../commands/ansi.mjs", import.meta.url)), "utf8"),
    );
    const { symlink } = await import("node:fs/promises");
    await symlink(fileURLToPath(new URL("../../lib", import.meta.url)), path.join(tmpRepo, "lib"));

    const artifact = path.join(roots.searchRoot, "ECOSYSTEM.md");
    const before = snap(artifact);
    // Invoke the MUTATED command module directly — never through cli.mjs's
    // own dispatch, which would import the real, unmutated commands/rollup.mjs.
    const invokePath = path.join(tmpRepo, "invoke.mjs");
    await writeFile(
      invokePath,
      [
        `import { rollupCmd } from ${JSON.stringify(path.join(commandsDir, "rollup.mjs"))};`,
        `process.exitCode = await rollupCmd(["--dry-run"]);`,
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, [invokePath], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_SEARCH_ROOTS: roots.searchRoot, PROPAGATE_STATE_DIR: roots.stateDir },
    });
    const after = snap(artifact);
    assert.notDeepEqual(
      after,
      before,
      `mutating the guard to `+"`if (true)`"+` should make --dry-run write anyway — if this assertion fails, ` +
        "the mutation did not reach the write path for the stated reason, and the guard test above is not " +
        `actually exercising what it claims to (mutated run: exit ${r.status}, stderr: ${(r.stderr || "").slice(0, 300)})`,
    );
  } finally {
    await rm(tmpRepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.searchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(roots.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
