/**
 * A fresh machine must not read as a working one.
 *
 * This is the portability gate: propagate is installable on any machine, and the
 * failure that matters is the one it exists to catch — automation that finds
 * nothing and reports success. `lib/config.mjs:33-38` predicts it in prose
 * ("discovery on another machine silently finds zero workspaces and the watcher
 * reports healthy forever"); these tests are the detection that prose never got.
 *
 * MEASURED BASELINE, 2026-08-19 — the RED this was written against:
 *   - `doctor` ALREADY fails correctly (exit 1) via the workspaces.discovered >= 1
 *     expectation (N7). Do not "fix" that; assert it so it cannot regress.
 *   - `status` printed NOTHING and exited 0. That is the silent one.
 *   - Neither distinguished "the configured root does not exist" from "the root
 *     exists and contains no markers". Both are recoverable, but by different
 *     actions — one is a config error, the other is an onboarding step — and a
 *     single message for both sends the reader down the wrong path.
 *
 * SANDBOXED BY CONSTRUCTION: every case runs under HOME=mkdtemp. A test for
 * "behaviour on a machine with no repos" that could touch the real $HOME would be
 * both wrong and dangerous.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");

/** Run the CLI with a throwaway HOME. Returns {stdout, stderr, code} and never throws. */
function runIsolated(args, { searchRoots } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "propagate-fresh-"));
  try {
    const env = {
      ...process.env,
      HOME: home,
      PROPAGATE_STATE_DIR: path.join(home, ".propagate"),
    };
    if (searchRoots) env.PROPAGATE_SEARCH_ROOTS = searchRoots(home);
    else delete env.PROPAGATE_SEARCH_ROOTS;
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", code: 0, home };
    } catch (e) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1, home };
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("status on a machine with no repos must not be silently empty", () => {
  const r = runIsolated(["status"]);
  const out = `${r.stdout}${r.stderr}`.trim();
  assert.notEqual(
    out,
    "",
    "status printed nothing at all on a fresh machine — an empty report is indistinguishable " +
      "from a clean one, which is the exact failure this skill exists to catch",
  );
  assert.match(
    out,
    /no workspaces|zero workspaces|not configured|roots/i,
    "status must name the problem and the roots it walked, so the reader knows what to set",
  );
});

test("doctor already fails on zero discovery — assert it so it cannot regress", () => {
  const r = runIsolated(["doctor"]);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.code, 0, "doctor must fail when it discovered no workspaces (N7)");

  // Asserts the CONTRACT, not a phrase. An earlier version of this test pinned
  // the literal "zero workspaces found" and went red the moment that message was
  // improved — a test that forbids its subject from getting better. What must
  // hold is that the failure names the condition AND the action; the wording is
  // free to change.
  assert.match(out, /search root|workspace/i, "the failure must name the condition");
  assert.match(
    out,
    /PROPAGATE_SEARCH_ROOTS|run `init`/,
    "…and the action — a diagnostic that does not say what to do is a dead end on a fresh machine",
  );
});

test("a MISSING root and an EMPTY root are different problems and must read differently", () => {
  // Missing: the configured path does not exist -> a configuration error.
  const missing = runIsolated(["doctor"], { searchRoots: (h) => path.join(h, "nope") });
  // Present but unmarked: the path exists, has repos, none carry .propagates.yml
  // -> an onboarding step, not a config error.
  const empty = runIsolated(["doctor"], {
    searchRoots: (h) => {
      const root = path.join(h, "code");
      mkdirSync(path.join(root, "someproject"), { recursive: true });
      return root;
    },
  });

  // Compare ONLY the discovery diagnostic, and strip the two things that differ
  // incidentally: the sandbox path, and reconcile's duration. Written this way
  // because the first version of this test compared whole outputs and passed on
  // a `0ms` vs `1ms` timing jitter while the diagnostic line was byte-identical —
  // a check that passes for the wrong reason is as useless as one that cannot fail.
  const discoveryLine = (r) =>
    `${r.stdout}${r.stderr}`
      .split("\n")
      .find((l) => /workspace/i.test(l) && /discover/i.test(l))
      ?.replace(/\/[^\s\]]*propagate-fresh-[^\s\]]*/g, "<TMP>")
      .replace(/\d+ms/g, "<MS>") ?? "<no discovery line>";

  const a = discoveryLine(missing);
  const b = discoveryLine(empty);

  assert.notEqual(
    a,
    b,
    `identical diagnostic for a nonexistent root and an unmarked root sends the reader down the ` +
      `wrong path: one is fixed by setting PROPAGATE_SEARCH_ROOTS, the other by adding a marker.\n` +
      `  missing: ${a}\n  empty:   ${b}`,
  );
  assert.match(
    a,
    /does not exist|not found|absent|unreadable/i,
    `the missing-root case must say the ROOT is absent, on the discovery line itself — got: ${a}`,
  );
});

test("a configured, marked workspace is discovered — the guard must not fire on a good install", () => {
  // The other half of the gate. Asserting only the failure half is how a check
  // that can never pass ships, which is as bad as one that can never fail (G1).
  const r = runIsolated(["doctor"], {
    searchRoots: (h) => {
      const root = path.join(h, "code");
      const ws = path.join(root, "myrepo");
      mkdirSync(ws, { recursive: true });
      writeFileSync(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
      return root;
    },
  });
  assert.doesNotMatch(
    `${r.stdout}${r.stderr}`,
    /zero workspaces found/i,
    "a root containing a workspace: true marker must be discovered",
  );
});

test("doctor does not fail a fresh machine over the RETIRED watcher's state.json", () => {
  // Found by the Phase 6 baseline (a fresh-context agent installing from SKILL.md
  // alone): on a new machine `doctor` exits 1 partly on `✗ state.json exists`, with
  // NO reason printed. The only writer of that file is watcher.mjs, which was retired
  // 2026-08-14 and now refuses to run — so the file will never be created, and the
  // check can never pass on any machine installed after that date.
  //
  // It passes on the author's machine only because a FOSSIL is still on disk, dated
  // the day of the retirement. A check that is green by leftover and red everywhere
  // else is measuring the wrong thing.
  //
  // tests/doctor-check-coverage.test.mjs recorded the suspicion on 2026-08-14 —
  // "may be removable rather than testable. Verify before writing fixtures" — and
  // this is that verification. Contradicting the documented posture directly:
  // "doctor and the digest report the replacement's health (event store + reconcile),
  // not the retired watcher's".
  //
  // NOTE ON THE ASSERTION ITSELF. The first version matched /✗ state\.json exists/ and
  // PASSED against the broken code — doctor prints `\x1b[31m✗\x1b[0m state.json exists`,
  // so the reset sequence sits between the mark and the label and the literal never
  // occurs. A test that cannot fail is worse than no test (GOTCHAS G1); strip ANSI
  // first, then assert.
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const r = runIsolated(["doctor"]);
  const plain = strip(r.stdout);
  assert.doesNotMatch(
    plain,
    /✗ state\.json exists/,
    "a fresh machine must not be FAILED for a retired component's artifact",
  );
  // Not merely deleted: the absence still has to be attributable, so it must still
  // be reported — as information, with the reason.
  assert.match(plain, /state\.json/, "the state must still be named, just not as a failure");
});

test("an UNCONFIGURED cross-repo allowlist is not a doctor failure", () => {
  // A REGRESSION I INTRODUCED IN PHASE 2, found by the Phase 6 GREEN baseline.
  //
  // Phase 2 emptied the SHIPPED cross-allow.yml, correctly: an empty allowlist permits
  // no cross-repo edge, so a fresh install cannot fire one it was never configured
  // for. But doctor then reported the resulting "N outside-allowlist" as a FAILURE, so
  // every fresh machine with real repos got `✗ cross-repo edges resolve` and exit 1 —
  // for not having configured an optional feature. Before Phase 2 it passed only
  // because the author's three repo roots shipped inside the file.
  //
  // The distinction that matters, and the one the check was missing:
  //   allowlist EMPTY   + edges outside it -> NOT CONFIGURED. Informational.
  //   allowlist present + edges outside it -> a real failure: a declared edge reaches
  //                                          past the bound someone set.
  // Emptiness is a state to report, not a verdict to fail. Same shape as the retired
  // watcher's state.json above.
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const home = mkdtempSync(path.join(tmpdir(), "propagate-xallow-"));
  try {
    const env = { ...process.env, HOME: home, PROPAGATE_STATE_DIR: path.join(home, ".propagate") };
    // Real roots: the failure needs actual repos carrying cross edges to appear at all.
    const roots = path.join(process.env.HOME, "Documents", "GitHub");
    const run = (args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
      return strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    };
    run(["setup", "--roots", roots]);
    const out = run(["doctor"]);
    assert.doesNotMatch(
      out,
      /✗ cross-repo edges resolve/,
      "an unconfigured allowlist must not FAIL a fresh install",
    );
    assert.match(out, /allowlist/i, "but it must still say the allowlist is unconfigured");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

