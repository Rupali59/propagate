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
 *
 * `commands/` (#97, moved 2026-10-18). Every `.md` under `commands/` becomes a slash command, so
 * `commands/vendor/README.md` was published as `/propagate:vendor:README` until it was renamed to `.txt`.
 * `commands/` holds only the slash-command `.md` files; implementation lives in `cli/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** What does not belong in a plugin's commands/: anything that is not a flat *.md file. */
export function strayInCommands(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => statSync(path.join(dir, n)).isDirectory() || !n.endsWith(".md"))
    .sort();
}

test("commands/ holds only flat *.md files — each one is a slash command, so implementation lives in cli/", () => {
  const md = readdirSync(path.join(REPO, "commands")).filter((n) => n.endsWith(".md"));
  assert.ok(md.length >= 4, `only ${md.length} slash-command files in commands/ — the scan has gone blind, it has not found nothing`);
  assert.deepEqual(
    strayInCommands(path.join(REPO, "commands")),
    [],
    "commands/ may hold only *.md files and no subdirectories: Claude Code turns every .md under it into a " +
      "slash command (commands/vendor/README.md became /propagate:vendor:README) and code there is shipped as a command. Put it in cli/",
  );
});

test("the commands/ check can fail: a stray .mjs, a stray subdirectory and a nested .md are each reported", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-layout-cmds-"));
  try {
    writeFileSync(path.join(dir, "propagate-ok.md"), "# ok\n");
    assert.deepEqual(strayInCommands(dir), []);
    writeFileSync(path.join(dir, "impl.mjs"), "export {};\n");
    mkdirSync(path.join(dir, "vendor"));
    writeFileSync(path.join(dir, "vendor", "README.md"), "# would be a slash command\n");
    assert.deepEqual(strayInCommands(dir), ["impl.mjs", "vendor"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
