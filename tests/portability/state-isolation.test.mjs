/**
 * The test suite must not write production state, and state must not live in the
 * skill directory.
 *
 * MEASURED BASELINE, 2026-08-20 — the RED this was written against:
 *
 *   before=$(wc -c < watcher.log); node --test 'tests/*.test.mjs'; after=$(wc -c < watcher.log)
 *   3047677 -> 3048847     (+1170 bytes, every run)
 *
 * Ten test files import `watcher.mjs`, and `watcher.mjs:109` appends to WATCHER_LOG.
 * WATCHER_LOG resolved to `<skill>/watcher.log`, so the suite had been appending to
 * the real log since the day those tests were written. That is how 2.9 MB accumulated
 * in a plugin directory.
 *
 * THE ROOT CAUSE is not the tests. `resolveStateDir()` returned `null` when
 * PROPAGATE_STATE_DIR was unset, and every state path fell back to SKILL_DIR — while
 * `~/.propagate` ALREADY held the v2 state (events/, graph-index.db, monitor.log,
 * notified.jsonl). State was split across two homes with no rule saying which was
 * which, and the half that landed in the skill directory sits somewhere a marketplace
 * update destroys — which `lib/config.mjs` itself warns about (N13/N14) two hundred
 * lines above where it puts it.
 *
 * ON G12, WHICH THIS DELIBERATELY CHANGES. `tests/config-state-dir.test.mjs` guarded
 * that the unset case resolve byte-identically to SKILL_DIR, because "the live watcher
 * loses its mtime baseline on the next run". That watcher was RETIRED 2026-08-14 and
 * `state.json` is now a fossil `doctor` reports as info (G50). The specific harm is
 * gone; the general form — a moving default losing state silently — is discharged by
 * migrating the live artifacts (metrics.jsonl, index.db, graph-mcp-cache.json,
 * SKILLS_LIFECYCLE.jsonl) rather than by refusing to move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SKILL_DIR, STATE_DIR, STATE_PATH, WATCHER_LOG, HEARTBEAT_PATH } from "../../lib/core/config.mjs";

// RECURSIVE, and the whole suite — not this directory. tests/ gained
// subdirectories on 2026-08-20, and a non-recursive read here would inspect a
// sixth of the suite and then report a confident verdict about the rest, which
// is the failure tests/cli/doctor-check-coverage.test.mjs warns about and once
// committed itself.
const TESTS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILES = readdirSync(TESTS_ROOT, { recursive: true }).filter((f) => String(f).endsWith(".mjs"));

const under = (dir, p) => p === dir || p.startsWith(dir + path.sep);

test("no state path resolves inside the skill directory", () => {
  // The skill directory is code. A marketplace update replaces it wholesale, so
  // anything written there is state with a deletion date nobody chose.
  const offenders = Object.entries({ STATE_PATH, WATCHER_LOG, HEARTBEAT_PATH })
    .filter(([, p]) => under(SKILL_DIR, p))
    .map(([name, p]) => `${name} -> ${p}`);

  assert.deepEqual(
    offenders,
    [],
    "state must live in $PROPAGATE_STATE_DIR (default ~/.propagate), never beside the code:\n  " +
      offenders.join("\n  "),
  );
});

test("STATE_DIR has a real default rather than null", () => {
  // `null` meant "fall back to SKILL_DIR" at eight separate call sites. A default
  // expressed as the absence of a value is a default nobody can see.
  assert.ok(STATE_DIR, "STATE_DIR must resolve to a directory even with no env override");
  assert.ok(path.isAbsolute(STATE_DIR), `STATE_DIR must be absolute, got ${STATE_DIR}`);
});

test("the suite's own run cannot append to a production watcher log", () => {
  // This file runs inside the suite, so WATCHER_LOG here is exactly what the ten
  // watcher-importing tests will append to. Asserting on it is asserting on them.
  assert.ok(
    !under(SKILL_DIR, WATCHER_LOG),
    `tests would append to ${WATCHER_LOG}, which is production state inside the skill dir`,
  );
});

test("SKILL_DIR points at the skill root, identified by a marker it must contain", () => {
  // SKILL_DIR is derived from config.mjs's OWN location by counting "..", "..", so it is
  // wrong by exactly one level the moment config.mjs moves — which happened on
  // 2026-08-20 when lib/config.mjs became lib/core/config.mjs. Seventeen tests went
  // red with `no such file or directory .../lib/cross-allow.yml`: every path built on
  // SKILL_DIR silently gained a `lib/` segment.
  //
  // Asserting a MARKER rather than a literal is the point. A test comparing SKILL_DIR
  // to a hardcoded absolute path would pass on this machine and prove nothing about
  // the derivation; asserting that the resolved directory actually contains SKILL.md
  // and package.json fails wherever the count is wrong, on any machine.
  for (const marker of ["SKILL.md", "package.json", "propagates.schema.json"]) {
    assert.ok(
      existsSync(path.join(SKILL_DIR, marker)),
      `SKILL_DIR resolved to ${SKILL_DIR}, which has no ${marker} — the "..", "..", ".." count is wrong`,
    );
  }
});


/**
 * …AND THE SUITE MUST NOT WRITE THE OPERATOR'S WORKSPACE TREE EITHER.
 *
 * This file's original scope was state files. N46 is the same principle one
 * level out: `fresh-machine.test.mjs` isolated HOME and PROPAGATE_STATE_DIR —
 * so config and the event store were safe — and then handed the REAL hub to a
 * scaffolding verb:
 *
 *     const roots = path.join(process.env.HOME, "Documents", "GitHub");
 *     run(["setup", "--roots", roots]);
 *
 * `process.env.HOME` there is the TEST RUNNER's home, not the isolated one.
 * `setup` is one of LEDGER_SCAFFOLDING_VERBS, so `verifyDiscovery` walked the
 * real tree and `ensureLedgerPair` ran in every workspace it found.
 *
 * IT WAS INVISIBLE FOR AS LONG AS IT DID NOTHING. `ensureLedgerPair` creates
 * the pair only iff NEITHER file exists, so on a tree where every workspace
 * already had one it was a silent no-op. Declaring six new workspaces on
 * 2026-08-24 created six directories where it was not, and twelve `doctor`
 * failures cleared themselves between two runs with no scaffolding verb in
 * between. That is what surfaced it.
 *
 * The invariant is narrow on purpose: a test may READ the real tree, and some
 * must. It may not build a path from the runner's HOME and hand it to a
 * command, because there is no way to tell from the call site whether that
 * command writes.
 */
test("no test builds a path from the RUNNER's HOME — read the real tree, never target it", () => {
  const offenders = [];
  for (const rel of TEST_FILES) {
    const src = readFileSync(path.join(TESTS_ROOT, rel), "utf8");
    // `HOME: home` (setting an isolated HOME for a child) is the correct
    // pattern and must not match. Only READING process.env.HOME to build a
    // path does.
    for (const m of src.matchAll(/process\.env\.HOME/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      const text = src.split("\n")[line - 1].trim();
      if (/HOME:\s/.test(text)) continue; // assigning an isolated HOME — fine
      // COMMENTS ARE NOT CODE, and skipping them is not a hole: a line behind
      // `//` or ` * ` does not execute, so it cannot target anything. Without
      // this the rule cannot be WRITTEN DOWN without tripping itself — the
      // docstring above quotes the offending line verbatim, on purpose, and
      // four of the first run's five hits were this file explaining the rule.
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
      offenders.push(`${rel}:${line}  ${text}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these tests derive a path from the runner's real HOME:\n  ${offenders.join("\n  ")}\n` +
      `Build fixtures under tmpdir, or write the config directly into the isolated HOME. N46.`,
  );
});
