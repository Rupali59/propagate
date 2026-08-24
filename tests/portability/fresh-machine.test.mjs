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
import { homedir } from "node:os";
import { renderConfig } from "../../lib/core/setup.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");

// The operator's real hub, for the one test that must READ it. Named and
// derived once, via os.homedir() rather than process.env.HOME, so it can never
// be confused with the isolated HOME a child is given. It is only ever passed
// to read-only verbs — see the N46 note at its use site.
const REAL_HUB = path.join(homedir(), "Documents", "GitHub");

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
    // maxRetries, because `force` does NOT cover ENOTEMPTY. The CLI under test
    // can still be flushing to this tree when the child exits, so a bare rmSync
    // loses the race intermittently and fails a test that already passed its
    // assertions — a failure for the wrong reason, which rule:discernment-checks
    // §4 rates as bad as a check that cannot fail. Observed 2026-08-24 on two
    // consecutive full-suite runs, a DIFFERENT test in this file each time,
    // both ENOTEMPTY from here and neither from the product.
    //
    // BOTH sites, not one. They are byte-identical, and a `count=1` replace
    // hitting the wrong one of two identical blocks is itself a recorded
    // failure in this tree (rule:discernment-checks §4).
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  // `setup --hub` added 2026-08-23. The comment above says the wording is free to
  // change and only the CONTRACT holds — but the regex enumerated two actions, so
  // when `hubRoot` made "run `propagate setup --hub <path>`" the primary fix, this
  // went red against a diagnostic that was strictly BETTER: it named the condition,
  // the two config sources tried, and the exact command. A contract test that lists
  // the acceptable answers is a phrase test wearing a contract's comment.
  assert.match(
    out,
    /PROPAGATE_SEARCH_ROOTS|run `init`|setup --hub/,
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
    const stateDir = path.join(home, ".propagate");
    const env = { ...process.env, HOME: home, PROPAGATE_STATE_DIR: stateDir };
    const run = (args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
      return strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    };

    // THE CONFIG IS WRITTEN, NOT `setup`-ed. This is N46, and the distinction is
    // the whole fix.
    //
    // The assertion below needs the real tree — an unconfigured allowlist can
    // only be shown not to fail if there are actual repos carrying cross edges
    // to be outside it. Reading the real tree is fine and is what `doctor` does.
    //
    // But this used to reach it by running `setup --roots <real hub>`, and
    // `setup` is one of LEDGER_SCAFFOLDING_VERBS: it walked the operator's tree
    // and created a ledger pair in every workspace that lacked one. Isolating
    // HOME and PROPAGATE_STATE_DIR protected the config and the event store; it
    // could not protect the tree the command was deliberately pointed at.
    //
    // Silent for as long as it did nothing — `ensureLedgerPair` writes only iff
    // NEITHER file exists — and it surfaced on 2026-08-24 the moment six newly
    // declared workspaces gave it somewhere to act.
    //
    // Writing the config file directly reaches the same state with a read-only
    // verb. `renderConfig` is imported rather than hand-rolled so the format
    // cannot drift from what `setup` actually writes.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "config.yml"),
      renderConfig({ roots: [REAL_HUB], scheduler: "none", hub: REAL_HUB }),
    );
    const out = run(["doctor"]);
    assert.doesNotMatch(
      out,
      /✗ cross-repo edges resolve/,
      "an unconfigured allowlist must not FAIL a fresh install",
    );
    assert.match(out, /allowlist/i, "but it must still say the allowlist is unconfigured");
  } finally {
    // maxRetries, because `force` does NOT cover ENOTEMPTY. The CLI under test
    // can still be flushing to this tree when the child exits, so a bare rmSync
    // loses the race intermittently and fails a test that already passed its
    // assertions — a failure for the wrong reason, which rule:discernment-checks
    // §4 rates as bad as a check that cannot fail. Observed 2026-08-24 on two
    // consecutive full-suite runs, a DIFFERENT test in this file each time,
    // both ENOTEMPTY from here and neither from the product.
    //
    // BOTH sites, not one. They are byte-identical, and a `count=1` replace
    // hitting the wrong one of two identical blocks is itself a recorded
    // failure in this tree (rule:discernment-checks §4).
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * `ref registry` — BOTH halves, because one without the other proves nothing.
 *
 * This section of doctor is deliberately informational: "prunable", "do NOT
 * prune yet", "exists only on this machine" are all human judgement calls, not
 * propagate defects, and making them red would leave doctor permanently red on
 * a healthy workspace.
 *
 * But a section that can only ever be informational is a check that cannot
 * fail, and the suite's own coverage ratchet exists to catch that. It caught
 * this one. So the ONE genuine propagate defect in reach — a snapshot propagate
 * itself wrote that will not parse — is a real ✗.
 */
test("ref registry FAILS on a snapshot that does not parse", () => {
  const r = runIsolated(["doctor"], {
    searchRoots: (h) => {
      const root = path.join(h, "code");
      const ws = path.join(root, "myrepo");
      mkdirSync(path.join(ws, "propagation", "refs"), { recursive: true });
      writeFileSync(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
      // Propagate wrote this file. Truncated JSON here means propagate's own
      // artifact is corrupt, which is not a branch anyone has to decide about.
      writeFileSync(path.join(ws, "propagation", "refs", "snapshot.json"), '{"projects": {');
      return root;
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /ref registry/, "the section must run at all");
  assert.match(out, /snapshot does not parse/, `expected a parse failure, got:\n${out}`);
  // ASSERT THE VERDICT, NOT THE MESSAGE. The first version of this test checked
  // only that the words appeared — so downgrading the `check(false)` to `info`
  // left it green, and the suite's coverage ratchet ALSO stayed green because
  // removing the check removes its label from the parse. Two guards, one blind
  // spot, and the mutation check is what found it.
  const line = out.split("\n").find((l) => l.includes("snapshot does not parse")) ?? "";
  assert.ok(line.includes("✗"), `must be a FAILURE, not an informational line: ${JSON.stringify(line)}`);
  assert.notEqual(r.code, 0, "and doctor must exit non-zero on it");
});

test("ref registry does NOT fail when there is simply no snapshot", () => {
  // The other half. Six of seven workspaces have no ref snapshot; if absence
  // were a failure, doctor would be red everywhere for a feature nobody has
  // adopted yet. Absence must still be ATTRIBUTABLE, so it says what to run.
  const r = runIsolated(["doctor"], {
    searchRoots: (h) => {
      const root = path.join(h, "code");
      const ws = path.join(root, "myrepo");
      mkdirSync(ws, { recursive: true });
      writeFileSync(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
      return root;
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /no snapshot — run `propagate migrate-refs/, "absence must name its own fix");
  assert.doesNotMatch(out, /snapshot does not parse/);
});

/**
 * The PRUNED surface — the hook's red rule, which is why the hook could not
 * just be deleted.
 *
 * `classifyPruned` computed this verdict and `migrate-refs` wrote it to
 * lifecycle.jsonl from the day both landed. Nothing ever read it back, so a
 * ref pruned while carrying work that exists nowhere else was recorded
 * correctly and shown to nobody — which is indistinguishable from not
 * detecting it (rule:enforcement-watches-itself: "grep for the callers of what
 * you just built").
 */
test("a ref pruned CARRYING WORK is surfaced, and a safe prune is not", () => {
  const rows = [
    { type: "pruned", project: "p", ref: "gone-risky", work: "lost", evidence: "upstream=NONE, track=(none)" },
    { type: "pruned", project: "p", ref: "gone-unclear", work: "unknown", evidence: "no previous row" },
    // Both of these must stay silent, or the alarm is noise: `safe` means the
    // commits are in the base, and `recoverable` means they are on the remote.
    { type: "pruned", project: "p", ref: "gone-safe", work: "safe", evidence: "merge_state=merged" },
    { type: "pruned", project: "p", ref: "gone-pushed", work: "recoverable", evidence: "pushed to origin/gone-pushed" },
  ];
  const r = runIsolated(["doctor"], {
    searchRoots: (h) => {
      const root = path.join(h, "code");
      const ws = path.join(root, "myrepo");
      mkdirSync(path.join(ws, "propagation", "refs"), { recursive: true });
      writeFileSync(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
      writeFileSync(
        path.join(ws, "propagation", "refs", "snapshot.json"),
        JSON.stringify({ schema_version: 2, projects: { p: { repo_root: "/p", base_ref: "origin/main", error: null, refs: {}, detached_worktrees: [] } } }),
      );
      writeFileSync(path.join(ws, "propagation", "refs", "lifecycle.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
      return root;
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /gone-risky.*PRUNED CARRYING WORK/, `lost work must be surfaced:\n${out}`);
  assert.match(out, /gone-unclear.*work status UNKNOWN/, "unmeasured is not reassurance");
  assert.doesNotMatch(out, /gone-safe/, "a merged prune is not an alarm");
  assert.doesNotMatch(out, /gone-pushed/, "a recoverable prune is not an alarm");
});
