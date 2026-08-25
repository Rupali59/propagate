/**
 * `setup` — the install-time bootstrap, and the one claim it must never make falsely.
 *
 * WHY THIS COMMAND EXISTS. Installing the plugin and running `status` gave: zero
 * workspaces, no error, exit 0, nothing works. `lib/config.mjs:78-86` predicted it
 * in prose years before anything detected it. Phase 4 of
 * docs/plans/2026-08-19-portability-and-rules.md closes it with a command that
 * configures the install AND verifies the configuration produced a working one.
 *
 * WHY NOT `init`. `init <dir>` already scaffolds a `.propagates.yml`, and
 * `bootstrap` already baselines edges. Overloading either verb with "configure the
 * whole install" would make the dangerous reading the plausible one. `setup` is
 * free, and bare `init` now names it rather than printing usage into a void.
 *
 * THE LOAD-BEARING TEST is "refuses to report success when discovery finds nothing"
 * (rule:safety-flag-needs-a-test — a command that promises a working install is
 * making a claim about another subsystem, and an unverified claim is worse than no
 * claim because people act on it). Every other case here is scaffolding around it.
 *
 * MEASURED BASELINE, 2026-08-19 — `setup` did not exist; every case below exited 2
 * with "unknown mode". That is a real RED but a weak one, so each success case
 * carries a negative control that makes it fail for the stated reason.
 *
 * SANDBOXED BY CONSTRUCTION: every case runs under HOME=mkdtemp with an explicit
 * PROPAGATE_STATE_DIR. A test for install-time behaviour that could write the real
 * ~/.propagate/config.yml would be both wrong and dangerous.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "..", "cli.mjs");

/**
 * A throwaway install. Unlike tests/fresh-machine.test.mjs's helper this does NOT
 * delete the home before returning — these tests assert on the FILE the command
 * wrote, not only on what it printed, and a command's own description of what it
 * did is exactly the evidence rule:safety-flag-needs-a-test says not to trust.
 */
function sandbox() {
  const home = mkdtempSync(path.join(tmpdir(), "propagate-setup-"));
  const stateDir = path.join(home, ".propagate");
  return {
    home,
    stateDir,
    configPath: path.join(stateDir, "config.yml"),
    /** A directory under HOME, optionally carrying a discoverable workspace marker. */
    root(name, { marker = false } = {}) {
      const dir = path.join(home, name);
      mkdirSync(dir, { recursive: true });
      if (marker) {
        const repo = path.join(dir, "some-repo");
        mkdirSync(repo, { recursive: true });
        writeFileSync(path.join(repo, ".propagates.yml"), "workspace: true\nsources: {}\n");
      }
      return dir;
    },
    run(args) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, HOME: home, PROPAGATE_STATE_DIR: stateDir, PROPAGATE_SEARCH_ROOTS: "" },
        encoding: "utf8",
      });
      return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("setup writes a config that discovery can actually use", () => {
  const s = sandbox();
  try {
    const root = s.root("code", { marker: true });
    const r = s.run(["setup", "--roots", root]);
    assert.equal(r.code, 0, `expected success, got ${r.code}:\n${r.out}`);
    assert.ok(existsSync(s.configPath), "setup must write config.yml");
    assert.match(readFileSync(s.configPath, "utf8"), new RegExp(root), "config.yml must record the root");
    assert.match(r.out, /1 workspace/, `must report what discovery found, got:\n${r.out}`);
  } finally {
    s.cleanup();
  }
});

test("NEGATIVE CONTROL: identical invocation without the marker must fail", () => {
  // Proves the test above passes because discovery found a workspace, not because
  // `setup` exits 0 whenever it manages to write a file.
  const s = sandbox();
  try {
    const root = s.root("code", { marker: false });
    const r = s.run(["setup", "--roots", root]);
    assert.notEqual(r.code, 0, `an install that discovers nothing must not exit 0:\n${r.out}`);
  } finally {
    s.cleanup();
  }
});

test("setup refuses to report success when discovery finds nothing, and names the roots walked", () => {
  // THE load-bearing case. Silent-zero-discovery is the failure this whole skill
  // exists to catch; a bootstrap that reports success into it is that failure
  // wearing the uniform of the fix.
  const s = sandbox();
  try {
    const root = s.root("empty-code", { marker: false });
    const r = s.run(["setup", "--roots", root]);
    assert.notEqual(r.code, 0, "must exit non-zero");
    assert.ok(r.out.includes(root), `must name the root it walked, got:\n${r.out}`);
    assert.match(r.out, /no-markers|no `?\.propagates\.yml`?/i, "must say WHY it found nothing");
    assert.doesNotMatch(r.out, /propagate is ready|setup complete|✓ ready/i, "must not claim success");
  } finally {
    s.cleanup();
  }
});

test("the depth in the no-markers message is a number, never the word undefined", () => {
  // config.mjs MAX_DEPTH is deliberately `undefined` when unconfigured, so that
  // discovery falls back to its own default rather than having one hardcoded in
  // two places. That sentinel is correct and must never reach a human: "no markers
  // under it (depth undefined)" tells the reader nothing about how deep it looked,
  // which is the whole actionable content of that line. Caught by smoke-testing the
  // real command, not by any assertion that existed.
  const s = sandbox();
  try {
    const root = s.root("empty-code", { marker: false });
    const r = s.run(["setup", "--roots", root]);
    assert.doesNotMatch(r.out, /depth undefined/, "must not print the sentinel");
    assert.match(r.out, /depth \d+/, `must name a concrete depth, got:\n${r.out}`);
  } finally {
    s.cleanup();
  }
});

test("a root that does not exist is reported differently from a root with no markers", () => {
  // Two causes, two fixes: a config error vs an onboarding step. One message for
  // both sends the reader down the wrong path (the distinction lib/config.mjs's
  // SEARCH_ROOTS_DIAGNOSTIC already draws — setup must not collapse it again).
  const s = sandbox();
  try {
    const missing = path.join(s.home, "nope");
    const r = s.run(["setup", "--roots", missing]);
    assert.notEqual(r.code, 0, "must exit non-zero");
    assert.ok(r.out.includes(missing), "must name the path");
    assert.match(r.out, /does not exist/i, "must say the root is missing, not that it is empty");
    assert.doesNotMatch(r.out, /no-markers/, "must not report this as an onboarding gap");
  } finally {
    s.cleanup();
  }
});

test("re-running setup does not clobber an existing config", () => {
  const s = sandbox();
  try {
    const root = s.root("code", { marker: true });
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(s.configPath, "searchRoots:\n  - /somewhere/else\nscheduler: none\n");
    const before = readFileSync(s.configPath, "utf8");
    const r = s.run(["setup", "--roots", root]);
    assert.equal(readFileSync(s.configPath, "utf8"), before, "must not overwrite without --force");
    assert.match(r.out, /--force/, `must name the flag that would overwrite, got:\n${r.out}`);
  } finally {
    s.cleanup();
  }
});

test("setup --force overwrites, and says so", () => {
  const s = sandbox();
  try {
    const root = s.root("code", { marker: true });
    mkdirSync(s.stateDir, { recursive: true });
    writeFileSync(s.configPath, "searchRoots:\n  - /somewhere/else\n");
    const r = s.run(["setup", "--roots", root, "--force"]);
    assert.equal(r.code, 0, `expected success, got ${r.code}:\n${r.out}`);
    const after = readFileSync(s.configPath, "utf8");
    assert.ok(after.includes(root), "must record the new root");
    assert.ok(!after.includes("/somewhere/else"), "must drop the old root");
  } finally {
    s.cleanup();
  }
});

test("bare `init` names setup instead of printing usage into a void", () => {
  const s = sandbox();
  try {
    const r = s.run(["init"]);
    assert.notEqual(r.code, 0, "still an error — init needs a dir");
    assert.match(r.out, /setup/, `must point at the install-time command, got:\n${r.out}`);
  } finally {
    s.cleanup();
  }
});

test("package.json declares a bin, and it points at a file that exists", () => {
  // `bin: NONE` was why there is no way to invoke this outside the plugin dir.
  const pkg = JSON.parse(readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8"));
  assert.ok(pkg.bin, "package.json must declare a bin entry");
  const targets = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin);
  assert.ok(targets.length > 0, "bin must name at least one target");
  for (const t of targets) {
    assert.ok(existsSync(path.join(HERE, "..", "..", t)), `bin target ${t} does not exist`);
  }
});
