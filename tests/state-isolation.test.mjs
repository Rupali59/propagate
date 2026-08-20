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
import { SKILL_DIR, STATE_DIR, STATE_PATH, WATCHER_LOG, HEARTBEAT_PATH } from "../lib/config.mjs";

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
