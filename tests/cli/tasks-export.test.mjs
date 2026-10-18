/**
 * tasks-export.test.mjs — `propagate tasks export` end to end (dry run).
 *
 * rule:safety-flag-needs-a-test. The unsafe path is "writes to a register, the state dir or
 * GitHub". Pinned by measuring the SIDE EFFECT, not the output:
 *   - a run without --apply leaves every byte of the hub and the state dir untouched, and the
 *     fake gh's log holds only `repo view` (an allowlist; `gh api -f` is a POST);
 *   - `--apply` is refused with exit 2 BEFORE any work — nothing written, gh never called;
 *   - a missing population is a usage error naming --file and --all, not an empty plan.
 *
 * The fake gh is an injection seam (PROPAGATE_GH_BIN); the real gh path is untested by
 * construction (rule:name-what-no-test-executes) — the real-tree run is recorded in the lane report.
 */
// @size medium — starts the CLI and git; run when affected
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

let root, hub, state, ghBin, ghLog;

function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function snapshot(...dirs) {
  const rows = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rows.push(`D ${p}`); walk(p); }
      else rows.push(`F ${p} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  for (const d of dirs) walk(d);
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex") + ` (${rows.length} entries)`;
}

function run(argv) {
  return spawnSync(process.execPath, [CLI, "tasks", ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_HUB_ROOT: hub,
      PROPAGATE_SEARCH_ROOTS: hub,
      PROPAGATE_STATE_DIR: state,
      PROPAGATE_GH_BIN: ghBin,
      NO_COLOR: "1",
    },
  });
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "tasks-export-cli-"));
  hub = path.join(root, "hub");
  state = path.join(root, "state");
  mkdirSync(path.join(hub, "propagation/state/alpha"), { recursive: true });
  mkdirSync(path.join(hub, "propagation/state/beta"), { recursive: true });
  mkdirSync(state, { recursive: true });
  git(hub, "init", "-q");
  git(hub, "remote", "add", "origin", "https://github.com/hubowner/hub.git");
  git(hub, "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(
    path.join(hub, "propagation/state/alpha/TODOS.md"),
    "# TODOS\n\n### PR-001 · First P1\n\nbody one\n\n### PR-002 · Second\n\nbody two\n\n### PR-002 · Second again — RESOLVED\n\nold\n",
  );
  writeFileSync(path.join(hub, "propagation/state/beta/TODOS.md"), "# TODOS\n\n- [ ] a checkbox\n");

  ghLog = path.join(root, "gh.log");
  ghBin = path.join(root, "gh");
  writeFileSync(
    ghBin,
    `#!/bin/sh
echo "$@" >> "${ghLog}"
[ "$1 $2" = "repo view" ] || { echo "unexpected gh call" >&2; exit 9; }
printf '%s' '{"visibility":"PRIVATE","hasIssuesEnabled":true,"owner":{"login":"hubowner"}}'
`,
  );
  chmodSync(ghBin, 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

test("--all is INERT: no file in the hub or state dir changes, and gh sees only `repo view`", () => {
  const before = snapshot(hub, state);
  const r = run(["export", "--all"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snapshot(hub, state), before, "a dry run must not write anything");
  const log = readFileSync(ghLog, "utf8").trim().split("\n");
  for (const line of log) assert.match(line, /^repo view hubowner\/hub --json visibility,hasIssuesEnabled,owner$/, line);
  assert.equal(log.length, 1, "repo view is cached per repo per run");
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /HELD duplicate-id/);
  assert.match(r.stdout, /hubowner\/hub: 3 item\(s\), 1 held, 2 planned/);
});

test("--json prints the plan as JSON and is equally inert", () => {
  const before = snapshot(hub, state);
  const r = run(["export", "--all", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snapshot(hub, state), before);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.mode, "dry-run");
  const alpha = plan.files.find((f) => f.file.endsWith("alpha/TODOS.md"));
  assert.equal(alpha.items.find((i) => i.id === "PR-001").key, "propagation/state/alpha/TODOS.md#PR-001");
  assert.deepEqual(alpha.items.find((i) => i.id === "PR-002").held.map((h) => h.reason), ["duplicate-id"]);
});

test("--file plans exactly one register", () => {
  const r = run(["export", "--file", path.join(hub, "propagation/state/beta/TODOS.md"), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).files.length, 1);
});

test("--apply with no population is a usage error and --budget needs --apply: nothing is written, gh is never called", () => {
  rmSync(ghLog, { force: true });
  const before = snapshot(hub, state);
  for (const argv of [["export", "--apply"], ["export", "--all", "--budget", "5"]]) {
    const r = run(argv);
    assert.equal(r.status, 2, `${argv.join(" ")} -> ${r.status}`);
  }
  assert.equal(snapshot(hub, state), before, "a refused invocation must write nothing");
  assert.equal(existsSync(ghLog), false, "a refused invocation must not even ask gh");
});

test("no population is a usage error naming --file and --all, not an empty plan", () => {
  const r = run(["export"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--file/);
  assert.match(r.stderr, /--all/);
});

test("an unknown subcommand and an unknown flag are refused", () => {
  assert.equal(run(["frobnicate"]).status, 2);
  const r = run(["export", "--all", "--nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --nope/);
});

test("a --file that is not a discovered register exits 2 rather than printing an empty plan", () => {
  const r = run(["export", "--file", path.join(hub, "missing.md")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a register/);
});
