/**
 * Fixture for tests/unit/test-impact.test.mjs — run it with `node --test` and the
 * recorder preloaded. It is not named *.test.mjs, so the suite's globs never run it on
 * their own.
 *
 * It does what the real CLI tests do: a test file spawns a node child that reads a repo
 * file, once with the env inherited (the case that must be attributed to this file) and
 * once with a CLEARED env (the case the recorder must flag, because the child cannot
 * record under this owner).
 */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const CHILD = 'require("node:fs").readFileSync(process.argv[1])';

test("inherited env: the child records under this file", () => {
  const r = spawnSync(process.execPath, ["-e", CHILD, path.join(REPO, "VERSION")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
});

test("cleared env: the spawn is flagged", () => {
  const r = spawnSync(process.execPath, ["-e", "0"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
});
