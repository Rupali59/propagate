/**
 * D1 — the reminders<->TODO bridge rides `propagate-digest`'s existing plist
 * rather than getting a new agent (`docs/plans/2026-09-23-reminders-todo-bridge.md`
 * D1; `docs/SYSTEMS.md`'s `reminders-bridge` row).
 *
 * Two things this file proves against the GENERATED XML, never against a
 * comment describing it:
 *   1. `writeDigestPlist()` emits TWO `StartCalendarInterval` fire times
 *      (09:00 and 21:00), as an array of dicts, not a bare dict.
 *   2. `docs/SYSTEMS.md`'s liveness probe for the `reminders-bridge` row —
 *      `plutil -lint` PLUS a count of the two calendar entries — actually
 *      EXECUTES and returns different exit codes for a healthy plist versus
 *      a damaged one. `lib/report/adoption.mjs`'s `formatAdoptionLines()`
 *      only PRINTS the `liveness_probe` column; nothing runs it. The cited
 *      precedent is G-O: a plist truncated from 2846 bytes of XML to 94
 *      bytes of JSON stayed `launchctl list`-green for seven days because
 *      nothing ever executed a probe against the FILE.
 *
 * Uses the SAME subprocess pattern as tests/portability/plist-relocation.test.mjs
 * (`tests/helpers/plist-generate.mjs`), so PLIST_DIR resolves under a scoped
 * PROPAGATE_STATE_DIR rather than the real ~/Library/LaunchAgents — this test
 * never touches the production digest plist.
 *
 * Run: `PROPAGATE_STATE_DIR="${TMPDIR:-/tmp}/propagate-test-state" node --test
 * tests/unit/plist-digest-reminders.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELPER_ABS = path.join(REPO_ROOT, "tests/helpers/plist-generate.mjs");

async function freshStateDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}
const cleanup = (...dirs) =>
  Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));

function generateDigestPlist(stateDir, wsRoot) {
  const result = spawnSync(process.execPath, [HELPER_ABS, JSON.stringify([{ name: "fake", root: wsRoot }])], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: stateDir, PROPAGATE_SEARCH_ROOTS: stateDir },
  });
  assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

// The EXACT probe documented in docs/SYSTEMS.md's `reminders-bridge` row.
// Kept as one string so the doc and this test cannot silently diverge --
// copy this literal into SYSTEMS.md, do not paraphrase it there.
const PROBE = String.raw`plutil -lint "$PLIST" >/dev/null 2>&1 && [ "$(plutil -extract StartCalendarInterval xml1 -o - "$PLIST" 2>/dev/null | grep -c '<dict>')" = "2" ]`;

function runProbe(plistPath) {
  return spawnSync("/bin/sh", ["-c", PROBE], { env: { ...process.env, PLIST: plistPath } });
}

test("writeDigestPlist emits an ARRAY of two StartCalendarInterval entries (09:00 and 21:00)", async () => {
  const stateDir = await freshStateDir("plist-digest-reminders-");
  const wsRoot = await freshStateDir("plist-digest-reminders-ws-");
  try {
    const out = generateDigestPlist(stateDir, wsRoot);
    assert.equal(out.digest.ok, true, JSON.stringify(out.digest));
    const content = await readFile(out.digest.resolvedPath, "utf8");

    assert.match(content, /<key>StartCalendarInterval<\/key>\s*<array>/, "must be an array, not a bare <dict> — a bare dict would silently drop the second fire time");
    const dictCount = (content.match(/<dict>/g) || []).length;
    // 1 outer <dict> for the whole plist body + 2 inner <dict>s, one per fire time.
    assert.ok(dictCount >= 3, `expected at least 3 <dict> (root + 2 calendar entries), got ${dictCount}`);
    assert.match(content, /<integer>9<\/integer>/);
    assert.match(content, /<integer>21<\/integer>/);
    assert.match(content, /<integer>0<\/integer>/, "both entries fire on the hour");
  } finally {
    await cleanup(stateDir, wsRoot);
  }
});

test("the SYSTEMS.md liveness probe EXECUTES and exits 0 against a healthy generated plist", async () => {
  const stateDir = await freshStateDir("plist-digest-reminders-");
  const wsRoot = await freshStateDir("plist-digest-reminders-ws-");
  try {
    const out = generateDigestPlist(stateDir, wsRoot);
    const probe = runProbe(out.digest.resolvedPath);
    assert.equal(probe.status, 0, `probe should pass against a healthy plist -- stdout=${probe.stdout} stderr=${probe.stderr}`);
  } finally {
    await cleanup(stateDir, wsRoot);
  }
});

test("the SYSTEMS.md liveness probe exits NON-ZERO against a plist truncated the way G-O describes", async () => {
  // G-O, verbatim: "com.rupali.claude-usage-sample.plist was truncated from
  // 2846 bytes of XML to 94 bytes of JSON, and nobody noticed for seven
  // days." Simulate exactly that shape here -- a plist-lint failure, not a
  // missing-second-entry failure (the next test covers that one).
  const stateDir = await freshStateDir("plist-digest-reminders-damaged-");
  try {
    const damaged = path.join(stateDir, "damaged.plist");
    await writeFile(damaged, '{"not":"a plist"}', "utf8");
    const probe = runProbe(damaged);
    assert.notEqual(probe.status, 0, "a truncated/non-plist file must fail the probe, not read as healthy");
  } finally {
    await cleanup(stateDir);
  }
});

test("the SYSTEMS.md liveness probe exits NON-ZERO against a well-formed plist with only ONE calendar entry", async () => {
  // The second, sharper failure this probe exists to catch: a REGRESSION
  // back to a bare <dict> (one fire time) would still `plutil -lint` OK --
  // that is exactly why the probe is two ANDed conditions, not one.
  const stateDir = await freshStateDir("plist-digest-reminders-onefire-");
  try {
    const onefire = path.join(stateDir, "onefire.plist");
    await writeFile(
      onefire,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tathya.propagate.digest</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
`,
      "utf8",
    );
    // Sanity: this file IS a valid plist on its own terms.
    const lint = spawnSync("plutil", ["-lint", onefire]);
    assert.equal(lint.status, 0, "the fixture itself must be a well-formed plist, or this test proves nothing");

    const probe = runProbe(onefire);
    assert.notEqual(probe.status, 0, "a plist with only ONE calendar entry must fail the probe -- it silently dropped the 21:00 run");
  } finally {
    await cleanup(stateDir);
  }
});
