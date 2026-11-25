/**
 * #355 — `status` and `check --changed` must say so when the sidecar loader rejects a file.
 *
 * The defect: a project sidecar whose `why:` carries an unquoted colon is malformed YAML. Every
 * reader that walks sidecars skips it and carries on, so its edges load as zero and `status`
 * printed `(no ledger file yet)` and exited 0, which reads exactly like "nothing drifted".
 * `doctor` caught it, but `doctor` is not what people run before an edit.
 *
 * Asserted against the output line, the exit codes and the `--json` field. Control: the same
 * workspace with a clean sidecar prints no such line and `check` exits 0.
 *
 * Subprocess-based, PROPAGATE_STATE_DIR + PROPAGATE_SEARCH_ROOTS scoped to a tmpdir.
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runCli(argv, { searchRoot, stateDir, cwd }) {
  return spawnSync(process.execPath, [CLI_PATH, ...argv], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: searchRoot, PROPAGATE_STATE_DIR: stateDir },
  });
}

const BAD_WHY = "why: b restates a: the count must match";

async function makeWorkspace(why) {
  const searchRoot = await mkdtemp(path.join(tmpdir(), "rej-sc-root-"));
  const stateDir = await mkdtemp(path.join(tmpdir(), "rej-sc-state-"));
  const ws = path.join(searchRoot, "ws");
  const proj = path.join(ws, "proj");
  await mkdir(proj, { recursive: true });
  git(["init", "-q", "-b", "main"], ws);
  git(["config", "user.email", "t@example.com"], ws);
  git(["config", "user.name", "T"], ws);
  await writeFile(path.join(ws, ".propagates.yml"), "workspace: true\nsources: {}\n");
  await writeFile(path.join(proj, "a.md"), "a v1\n");
  await writeFile(path.join(proj, "b.md"), "b v1\n");
  await writeFile(
    path.join(proj, ".propagates.yml"),
    ["sources:", "  a.md:", "    propagates_to:", "      - path: b.md", `        ${why}`, "        kind: prose", ""].join("\n"),
  );
  git(["add", "."], ws);
  git(["commit", "-q", "-m", "init"], ws);
  // a tracked change so `check --changed` has something to look at
  await writeFile(path.join(proj, "a.md"), "a v2\n");
  return { searchRoot, stateDir, ws, env: { searchRoot, stateDir, cwd: ws } };
}

const cleanup = (w) => () =>
  Promise.all([w.searchRoot, w.stateDir].map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));

test("status prints a rejected-sidecar line naming file and parse error, keeps exit 0, and puts it in --json", async (t) => {
  const w = await makeWorkspace(BAD_WHY);
  t.after(cleanup(w));

  const r = runCli(["status"], w.env);
  assert.equal(r.status, 0, "status keeps its own exit code");
  const line = r.stdout.split("\n").find((l) => l.includes("rejected sidecar"));
  assert.ok(line, `no rejected-sidecar line in:\n${r.stdout}`);
  assert.ok(line.includes("proj/.propagates.yml"), `line must name the file: ${line}`);
  assert.ok(line.includes("malformed YAML"), `line must carry the parse error: ${line}`);

  const j = runCli(["status", "--json"], w.env);
  assert.equal(j.status, 0);
  const obj = JSON.parse(j.stdout);
  assert.equal(obj.rejectedSidecars.length, 1);
  assert.ok(obj.rejectedSidecars[0].path.endsWith(path.join("proj", ".propagates.yml")));
  assert.match(obj.rejectedSidecars[0].error, /malformed YAML/);
});

test("check --changed prints the line and exits non-zero, with and without --strict; --json carries it", async (t) => {
  const w = await makeWorkspace(BAD_WHY);
  t.after(cleanup(w));

  for (const extra of [[], ["--strict"]]) {
    const r = runCli(["check", "--changed", ...extra], w.env);
    assert.equal(r.status, 1, `check --changed ${extra} must exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
    const line = r.stdout.split("\n").find((l) => l.includes("rejected sidecar"));
    assert.ok(line, `no rejected-sidecar line in:\n${r.stdout}`);
    assert.ok(line.includes("proj/.propagates.yml") && line.includes("malformed YAML"), line);
  }

  const j = runCli(["check", "--changed", "--json"], w.env);
  assert.equal(j.status, 1);
  const obj = JSON.parse(j.stdout);
  assert.equal(obj.rejectedSidecars.length, 1);
  assert.equal(obj.exitCode, 1);
});

test("control: a clean sidecar prints no rejected line, check exits 0, --json field is empty", async (t) => {
  const w = await makeWorkspace("why: a feeds b");
  t.after(cleanup(w));

  const s = runCli(["status"], w.env);
  assert.equal(s.status, 0);
  assert.ok(!s.stdout.includes("rejected sidecar"), s.stdout);
  assert.deepEqual(JSON.parse(runCli(["status", "--json"], w.env).stdout).rejectedSidecars, []);

  const c = runCli(["check", "--changed"], w.env);
  assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
  assert.ok(!c.stdout.includes("rejected sidecar"), c.stdout);
  assert.deepEqual(JSON.parse(runCli(["check", "--changed", "--json"], w.env).stdout).rejectedSidecars, []);
});
