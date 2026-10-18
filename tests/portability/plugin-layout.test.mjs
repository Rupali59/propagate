/**
 * plugin-layout.test.mjs — the plugin root must not carry directories Claude Code gives a meaning to
 * that propagate does not intend.
 *
 * `bin/` (#96, moved 2026-10-18). The plugin reference, "Standard layout": files in a plugin's `bin/`
 * are on the Bash tool's PATH while the plugin is enabled, and claude.ai and Cowork do not install a
 * plugin that has the directory (https://code.claude.com/docs/en/plugins-reference). propagate shipped a
 * release-only scrub script and its update check there, so both were bare commands in every session and
 * the plugin was uninstallable on two surfaces. They live in `scripts/` now. A bin/ that comes back
 * must be a deliberate decision, recorded, not a convenient folder name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The directories at a plugin root that Claude Code treats specially and propagate must not ship. */
export function forbiddenRootDirs(root) {
  return ["bin"].filter((d) => existsSync(path.join(root, d)));
}

test("the plugin root has no bin/ — Claude Code would put its files on every session's PATH", () => {
  assert.deepEqual(
    forbiddenRootDirs(REPO),
    [],
    "a bin/ directory at the plugin root puts its files on the Bash tool's PATH while the plugin is enabled, " +
      "and claude.ai and Cowork refuse to install a plugin that has one — put scripts in scripts/",
  );
});

test("the check can fail: a root that has bin/ is reported", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-layout-"));
  try {
    mkdirSync(path.join(dir, "bin"));
    assert.deepEqual(forbiddenRootDirs(dir), ["bin"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the moved scripts exist where their callers look for them", () => {
  for (const f of ["scripts/make-public.mjs", "scripts/propagate-update-check"]) {
    assert.ok(existsSync(path.join(REPO, f)), `${f} is missing — lib/core/release.mjs or update-notice.mjs would fail to spawn it`);
  }
});
