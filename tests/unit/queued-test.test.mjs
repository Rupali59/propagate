// scripts/queued-test.sh (#437): queued when test-queue and its `where` exist, an announced unqueued run otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "queued-test.sh");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "queued-test-"));

function tinyTest(dir, pass) {
  const f = path.join(dir, "tiny.test.mjs");
  writeFileSync(f, `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("tiny", () => assert.equal(1, ${pass ? 1 : 2}));\n`);
  return f;
}

/** A PATH holding only node and the few tools the script calls, so no test-queue can be found. */
function bareBin(dir) {
  const bin = path.join(dir, "bare-bin");
  mkdirSync(bin);
  for (const tool of ["dirname", "mktemp"]) {
    const found = ["/usr/bin", "/bin"].map((d) => path.join(d, tool)).find((p) => existsSync(p));
    if (found) symlinkSync(found, path.join(bin, tool));
  }
  symlinkSync(process.execPath, path.join(bin, "node"));
  return bin;
}

/** A fake test-queue: `where` echoes a dir holding a fake adapter, `run` records argv then runs everything after `--`. */
function fakeQueue(dir, { withWhere = true } = {}) {
  const bin = path.join(dir, "queue-bin");
  const toolDir = path.join(dir, "queue-tool");
  mkdirSync(bin);
  mkdirSync(path.join(toolDir, "adapters"), { recursive: true });
  writeFileSync(path.join(toolDir, "adapters", "node-tap.mjs"), "// fake adapter\n");
  const argvFile = path.join(dir, "argv.txt");
  const stub = `#!/bin/sh
case "$1" in
  where) ${withWhere ? `echo "${toolDir}"; exit 0` : "exit 2"} ;;
  run)
    printf '%s\\n' "$@" > "${argvFile}"
    while [ "$1" != "--" ]; do shift; done
    shift
    # drop the adapter command up to its own "--", as the real adapter would
    exec "$@" ;;
esac
exit 2
`;
  writeFileSync(path.join(bin, "test-queue"), stub);
  chmodSync(path.join(bin, "test-queue"), 0o755);
  return { bin, toolDir, argvFile };
}

function run(args, PATH, dir) {
  return spawnSync("/bin/sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH, PROPAGATE_STATE_DIR: path.join(dir, "state"), HOME: dir },
    timeout: 60000,
  });
}

test("queued: passes --profile lane by default and the adapter path to test-queue run", () => {
  const dir = tmp();
  const q = fakeQueue(dir);
  const t = tinyTest(dir, true);
  // the stub execs the command after the first `--`, so the fake adapter runs the real test command after its own `--`
  writeFileSync(path.join(q.toolDir, "adapters", "node-tap.mjs"), `import { spawnSync } from "node:child_process";\nconst i = process.argv.indexOf("--");\nconst r = spawnSync(process.argv[i + 1], process.argv.slice(i + 2), { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`);
  const r = run([t], `${q.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const argv = readFileSync(q.argvFile, "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 3), ["run", "--profile", "lane"]);
  assert.ok(argv.includes(path.join(q.toolDir, "adapters", "node-tap.mjs")), argv.join(" "));
  assert.ok(argv.includes("--test-reporter=tap"));
  assert.ok(argv.includes(t));
  assert.doesNotMatch(r.stderr, /lock: unavailable/);
});

test("queued: --profile gate is forwarded", () => {
  const dir = tmp();
  const q = fakeQueue(dir);
  writeFileSync(path.join(q.toolDir, "adapters", "node-tap.mjs"), `process.exit(0);\n`);
  run(["--profile", "gate", tinyTest(dir, true)], `${q.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, dir);
  const argv = readFileSync(q.argvFile, "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 3), ["run", "--profile", "gate"]);
});

test("queued: a failing test gives a non-zero exit", () => {
  const dir = tmp();
  const q = fakeQueue(dir);
  writeFileSync(path.join(q.toolDir, "adapters", "node-tap.mjs"), `import { spawnSync } from "node:child_process";\nconst i = process.argv.indexOf("--");\nconst r = spawnSync(process.argv[i + 1], process.argv.slice(i + 2), { stdio: "ignore" });\nprocess.exit(r.status ?? 1);\n`);
  const r = run([tinyTest(dir, false)], `${q.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, dir);
  assert.notEqual(r.status, 0);
});

test("fallback: no test-queue on PATH runs the test unqueued and says lock: unavailable", () => {
  const dir = tmp();
  const r = run([tinyTest(dir, true)], bareBin(dir), dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /test-queue: not installed, lock: unavailable \(running unqueued\)/);
});

test("fallback: test-queue without a working `where` also runs unqueued", () => {
  const dir = tmp();
  const q = fakeQueue(dir, { withWhere: false });
  const r = run([tinyTest(dir, true)], `${q.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /lock: unavailable/);
  assert.equal(existsSync(q.argvFile), false, "run must not be reached without where");
});

test("fallback: a failing test gives a non-zero exit", () => {
  const dir = tmp();
  const r = run([tinyTest(dir, false)], bareBin(dir), dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lock: unavailable/);
});
