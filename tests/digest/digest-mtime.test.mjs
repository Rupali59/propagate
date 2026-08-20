/**
 * `safeNewestMtimeMs` must not depend on external binaries.
 *
 * It shelled out to `find … -exec stat -f %m {} +`. `-f` is **BSD stat**; GNU stat spells
 * the same thing `-c %Y`, so on Linux the whole pipeline threw and the function returned
 * `null` — indistinguishable from "this directory has no files". The digest's staleness
 * section then read as "nothing to report" rather than "could not measure", which is the
 * attributable-absence failure this codebase already has a rule about (GOTCHAS G2).
 *
 * THE TEST THAT ACTUALLY FAILS ON THIS PLATFORM. The platform bug cannot fail on macOS,
 * so asserting mtimes here would have passed before the fix and proved nothing. Running
 * with a PATH that contains neither `find` nor `stat` reproduces the same defect
 * everywhere: it is exactly the condition a Linux box is in with respect to BSD `stat`.
 * Removing a spawn is also the measured win — GOTCHAS G6, "the cost is usually subprocess
 * spawns, not work".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "digest.mjs");

/** Build a tree with a known newest file, plus content inside skipped dirs. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "digest-mtime-"));
  mkdirSync(path.join(root, "a", "b"), { recursive: true });
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  writeFileSync(path.join(root, "old.txt"), "x");
  writeFileSync(path.join(root, "a", "b", "new.txt"), "x");
  writeFileSync(path.join(root, "node_modules", "newest.txt"), "x");
  const t = (secs) => new Date(Date.now() - secs * 1000);
  utimesSync(path.join(root, "old.txt"), t(9000), t(9000));
  utimesSync(path.join(root, "a", "b", "new.txt"), t(60), t(60));
  // The newest file on disk sits in node_modules and must be IGNORED.
  utimesSync(path.join(root, "node_modules", "newest.txt"), t(1), t(1));
  return root;
}

/** Call safeNewestMtimeMs in a child, optionally with a PATH lacking find/stat. */
function callInChild(dir, { emptyPath = false } = {}) {
  const code = `import(${JSON.stringify(DIGEST)}).then((m) => {
    const f = m.safeNewestMtimeMsForTest;
    if (!f) { process.stdout.write("NOT_EXPORTED"); return; }
    process.stdout.write(String(f(${JSON.stringify(dir)}, 5000)));
  })`;
  const env = { ...process.env };
  if (emptyPath) env.PATH = path.join(tmpdir(), "definitely-not-a-real-bin-dir");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env,
    encoding: "utf8",
  });
  return { out: (r.stdout ?? "").trim(), stderr: r.stderr ?? "", status: r.status };
}

test("finds the newest mtime, and ignores node_modules", () => {
  const root = fixture();
  try {
    const { out } = callInChild(root);
    assert.notEqual(out, "NOT_EXPORTED", "safeNewestMtimeMs must be exported to be testable");
    const ms = Number(out);
    assert.ok(Number.isFinite(ms) && ms > 0, `expected an mtime, got ${out}`);
    const ageSec = (Date.now() - ms) / 1000;
    assert.ok(
      ageSec > 30 && ageSec < 300,
      `expected the ~60s-old file under a/b, not the 1s-old one in node_modules (age ${ageSec}s)`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("works with no `find` or `stat` on PATH — the Linux condition, reproduced here", () => {
  const root = fixture();
  try {
    const { out } = callInChild(root, { emptyPath: true });
    const ms = Number(out);
    assert.ok(
      Number.isFinite(ms) && ms > 0,
      `returned "${out}" with an empty PATH — a shell-out cannot survive this, and on Linux ` +
        `BSD \`stat -f\` fails the same way, reporting "no files" instead of "could not measure"`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing directory is null, not a throw", () => {
  const { out, status } = callInChild(path.join(tmpdir(), "nope-does-not-exist-12345"));
  assert.equal(status, 0, "must not throw");
  assert.equal(out, "null");
});
