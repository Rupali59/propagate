// `.lane-checks` (propagate#453): the parser, the runner's exit codes, the CLI, and the dispatch hook's deny.
// Fixtures are throwaway git repos in a temp dir, so nothing reads the real repo's file. The hook cases pass a
// literal payload with a `cwd`, the way the harness sends one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseLaneChecks, runLaneChecks } from "../../lib/lanes/lane-checks.mjs";
import { laneChecksCmd } from "../../cli/lanes.mjs";
import { decide } from "../../hooks/dispatch-model.mjs";

function repo(laneChecks, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "lane-checks-test-"));
  mkdirSync(path.join(root, ".git"));
  if (laneChecks !== null) writeFileSync(path.join(root, ".lane-checks"), laneChecks);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), body);
  }
  return root;
}
const PASS_TEST = `import { test } from "node:test"; test("ok", () => {});`;
const FAIL_TEST = `import { test } from "node:test"; import assert from "node:assert"; test("no", () => assert.equal(1, 2));`;

test("parser: paths, run: lines, comments and blanks", () => {
  const e = parseLaneChecks("# header\n\n  tests/a.test.mjs  \nrun: node x.mjs --check\n   # indented comment\nrun:\n");
  assert.deepEqual(e.map((x) => x.kind), ["test", "run", "bad"]);
  assert.equal(e[0].path, "tests/a.test.mjs");
  assert.equal(e[1].cmd, "node x.mjs --check");
});

test("runner: all entries pass gives exit 0 and names each entry", () => {
  const root = repo("tests/a.test.mjs\nrun: true\n", { "tests/a.test.mjs": PASS_TEST });
  const r = runLaneChecks(root);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.entries.map((x) => x.status), ["pass", "pass"]);
});

test("runner: a missing test path is exit 2, not a pass", () => {
  const root = repo("tests/nope.test.mjs\n");
  const r = runLaneChecks(root);
  assert.equal(r.exit, 2);
  assert.match(r.entries[0].detail, /does not exist/);
});

test("runner: a failing run: command is exit 1; a command that cannot start is exit 2", () => {
  assert.equal(runLaneChecks(repo("run: false\n")).exit, 1);
  const r = runLaneChecks(repo("run: lane-checks-no-such-command-xyz\n"));
  assert.equal(r.exit, 2);
  assert.match(r.entries[0].detail, /could not start/);
});

test("runner: a failing test file is exit 1, and a missing path outranks it (2)", () => {
  const root = repo("tests/f.test.mjs\ntests/gone.test.mjs\n", { "tests/f.test.mjs": FAIL_TEST });
  assert.equal(runLaneChecks(root).exit, 2);
  assert.equal(runLaneChecks(repo("tests/f.test.mjs\n", { "tests/f.test.mjs": FAIL_TEST })).exit, 1);
});

test("runner: an empty list and a missing file are exit 2 with a reason", () => {
  assert.match(runLaneChecks(repo("# nothing\n\n")).reason, /blind list/);
  assert.equal(runLaneChecks(repo("# nothing\n")).exit, 2);
  assert.equal(runLaneChecks(repo(null)).exit, 2);
});

test("cli: --repo, exit code and --json", async () => {
  const root = repo("run: true\n");
  const lines = [];
  assert.equal(await laneChecksCmd(["--repo", root, "--json"], { out: (s) => lines.push(s) }), 0);
  assert.equal(JSON.parse(lines[0]).entries[0].status, "pass");
  assert.equal(await laneChecksCmd(["--bogus"], { err: () => {} }), 2);
  assert.equal(await laneChecksCmd(["--repo", repo("run: false\n")], { out: () => {} }), 1);
});

// The hook: a code lane in a repo with a .lane-checks must say what it will run.
const P = "issue: acme/app#1\nbuild it";
const input = (cwd, prompt, subagent_type = "general-purpose") => ({ tool_name: "Agent", cwd, tool_input: { subagent_type, model: "sonnet", prompt } });

test("hook: a dispatch without the line is denied, naming both forms", () => {
  const d = decide(input(repo("run: true\n"), P), null).deny;
  assert.match(d, /#453/);
  assert.match(d, /lane-checks:/);
  assert.match(d, /lane_checks_reason:/);
});
test("hook: the line, or a reason, is honoured; an empty one is not", () => {
  const root = repo("run: true\n");
  assert.equal(decide(input(root, `${P}\nlane-checks: propagate lane-checks`), null).deny, undefined);
  assert.equal(decide(input(root, `${P}\nlane_checks_reason: docs only`), null).deny, undefined);
  assert.match(decide(input(root, `${P}\nlane_checks_reason:   `), null).deny, /#453/);
});
test("hook: a nested cwd finds the repo root", () => {
  const root = repo("run: true\n", { "sub/deep/x.txt": "x" });
  assert.match(decide(input(path.join(root, "sub", "deep"), P), null).deny, /#453/);
});
test("hook: a repo without .lane-checks, or no cwd, gets no check", () => {
  assert.equal(decide(input(repo(null), P), null).deny, undefined);
  assert.equal(decide({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose", model: "sonnet", prompt: P } }, null).deny, undefined);
});
for (const t of ["Explore", "Plan", "propagate:adversarial-reviewer"]) {
  test(`hook: read-only agent ${t} is exempt`, () => {
    assert.equal(decide(input(repo("run: true\n"), P, t), null).deny, undefined);
  });
}

test("runner: a composite package.json test script is not used for a one-path entry (the first live run ran the whole suite)", () => {
  const root = repo("tests/a.test.mjs\n", {
    "tests/a.test.mjs": PASS_TEST,
    "package.json": JSON.stringify({ scripts: { test: "exit 99" } }),
  });
  assert.equal(runLaneChecks(root).exit, 0);
});
