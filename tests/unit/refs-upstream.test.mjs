/**
 * `upstream` is a required snapshot field and was never populated.
 *
 * `docs/REFERENCE.md:106-110` lists `upstream` per ref. `enumerateRefs` asked
 * git for `upstream:track` and never for `upstream:short`, so every LOCAL
 * branch carried `upstream: null` — indistinguishable from a branch that has
 * genuinely never been pushed.
 *
 * FOUND BY COMPARING SETS, NOT COUNTS. The ported findings produced 46 rows
 * against the shell's 11. The 11 matched exactly; the 35 extras were all
 * "unbacked — work exists only on this machine", fired at branches that are
 * every one of them pushed. A count comparison would have shown 46 ≠ 11 and
 * said nothing about which rule was wrong.
 *
 * This is the FIFTH thing lost by re-deriving rather than porting (G27).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { enumerateRefs } from "../../lib/edges/refs.mjs";

test("a branch WITH an upstream reports it; one without reports null", async (t) => {
  const remote = await mkdtemp(path.join(tmpdir(), "rem-"));
  const root = await mkdtemp(path.join(tmpdir(), "loc-"));
  t.after(() => Promise.all([rm(remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }), rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })]));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: ["ignore", "pipe", "pipe"] });
  g("config", "user.email", "t@e.st"); g("config", "user.name", "t");
  await writeFile(path.join(root, "f.txt"), "x\n");
  g("add", "-A"); g("commit", "-qm", "seed");
  g("remote", "add", "origin", remote);
  g("push", "-qu", "origin", "main");
  g("branch", "local-only");

  const { refs, error } = await enumerateRefs(root);
  assert.equal(error, null);
  const by = Object.fromEntries(refs.map((r) => [r.ref, r]));
  assert.equal(by.main.upstream, "origin/main", "a tracked branch must report its upstream");
  assert.equal(by["local-only"].upstream, null,
    "and a genuinely unpushed branch must report null — the distinction is the whole point");
});
