/**
 * broadcast-cli.test.mjs — `propagate broadcast new` through the real CLI process and PROPAGATE_GH_BIN.
 * The unit file injects a gh function; this one proves the env override and the cli.mjs dispatch are wired, and that a
 * dry run's gh log holds reads only (an allowlist: `gh api -f` is a POST).
 */
// @size medium — starts the CLI; run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

test("broadcast new without --apply: the gh log holds only repo view and issue list", () => {
  const root = mkdtempSync(path.join(tmpdir(), "broadcast-cli-"));
  try {
    const log = path.join(root, "gh.log");
    const gh = path.join(root, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "repo view") printf '%s' '{"visibility":"PRIVATE","hasIssuesEnabled":true,"owner":{"login":"o"}}' ;;
  "issue list") printf '%s' '[]' ;;
  *) echo "unexpected gh call" >&2; exit 9 ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    const body = path.join(root, "body.md");
    writeFileSync(body, "do it\n\nDone when: it is done\n");
    const r = spawnSync(process.execPath, [CLI, "broadcast", "new", "--title", "Check", "--goal", "G3", "--to", "o/a,o/b", "--body-file", body, "--hub", "o/hub"], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_GH_BIN: gh, PROPAGATE_STATE_DIR: path.join(root, "state"), NO_COLOR: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(lines.length >= 4, "it read");
    for (const l of lines) assert.match(l, /^(repo view|issue list) /, `a write-shaped call in a dry run: ${l}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("broadcast status through the CLI: an unreadable GitHub is exit 2", () => {
  const root = mkdtempSync(path.join(tmpdir(), "broadcast-cli-"));
  try {
    const gh = path.join(root, "gh");
    writeFileSync(gh, "#!/bin/sh\necho boom >&2\nexit 1\n");
    chmodSync(gh, 0o755);
    const r = spawnSync(process.execPath, [CLI, "broadcast", "status", "--hub", "o/hub"], {
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_GH_BIN: gh, PROPAGATE_STATE_DIR: path.join(root, "state"), NO_COLOR: "1" },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /could not read GitHub/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
