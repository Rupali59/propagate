/**
 * `verify` cited-commit guard (#354): a SHA in --reason that HEAD does not contain is
 * refused, a checkout behind its upstream is warned about, and neither path writes
 * on a refusal. The load-bearing assertion is the byte-identical event store.
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeChain, runCli, storeSnapshot, cleanup, git } from "../helpers/verify-fixture.mjs";

const verifyAB = (fx, reason, extra = []) =>
  runCli(["verify", "--edge", fx.edgeAB.edge_id, "--disposition", "propagated", "--reason", reason, ...extra], fx.env);

/** A commit on a side branch, then back to main: it exists in the repo but not in HEAD. */
async function foreignSha(ws) {
  git(["checkout", "-q", "-b", "side"], ws);
  await writeFile(path.join(ws, "side.txt"), "side\n");
  git(["add", "side.txt"], ws);
  git(["commit", "-q", "-m", "side"], ws);
  const sha = git(["rev-parse", "HEAD"], ws);
  git(["checkout", "-q", "main"], ws);
  return sha;
}

test("a cited SHA that HEAD does not contain is refused, naming the SHA and HEAD, and writes nothing", async (t) => {
  const fx = await makeChain();
  t.after(() => cleanup(fx.searchRoot, fx.stateDir));
  const sha = await foreignSha(fx.ws);
  const head = git(["rev-parse", "HEAD"], fx.ws);
  const snap = storeSnapshot(fx.stateDir);

  // FAILING INPUT: make the ancestor check always pass (mutation) and this goes to exit 0.
  for (const extra of [["--apply"], []]) {
    const r = verifyAB(fx, `settled per ${sha.slice(0, 10)}`, extra);
    assert.equal(r.status, 1, `exit 1 expected (${extra.join(" ") || "dry run"}): ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(sha.slice(0, 10)), "names the SHA");
    assert.ok(r.stderr.includes(head), "names HEAD");
    assert.equal(storeSnapshot(fx.stateDir), snap, "a refused verify must write nothing");
  }
});

test("a cited SHA that HEAD contains is accepted", async (t) => {
  const fx = await makeChain();
  t.after(() => cleanup(fx.searchRoot, fx.stateDir));
  const sha = git(["rev-parse", "HEAD"], fx.ws);
  const r = verifyAB(fx, `settled per ${sha.slice(0, 12)}`, ["--apply"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.notEqual(storeSnapshot(fx.stateDir), "");
});

test("a cited string that resolves to no commit gets its own message", async (t) => {
  const fx = await makeChain();
  t.after(() => cleanup(fx.searchRoot, fx.stateDir));
  const snap = storeSnapshot(fx.stateDir);
  const r = verifyAB(fx, "settled per 1234567abcd", ["--apply"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resolves to no commit/);
  assert.equal(storeSnapshot(fx.stateDir), snap);
});

test("no SHA cited: unchanged behaviour, and words made of a-f are not read as SHAs", async (t) => {
  const fx = await makeChain();
  t.after(() => cleanup(fx.searchRoot, fx.stateDir));
  const r = verifyAB(fx, "defaced facade, checked by hand", ["--apply"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("a checkout behind its upstream warns, and still proceeds", async (t) => {
  const fx = await makeChain();
  t.after(() => cleanup(fx.searchRoot, fx.stateDir));
  const remote = await mkdtemp(path.join(tmpdir(), "verify-cited-remote-"));
  t.after(() => cleanup(remote));
  git(["init", "-q", "--bare", "-b", "main"], remote);
  git(["remote", "add", "origin", remote], fx.ws);
  git(["push", "-q", "-u", "origin", "main"], fx.ws);
  // Advance the remote from a second clone, then fetch: ws is now behind.
  const other = await mkdtemp(path.join(tmpdir(), "verify-cited-other-"));
  t.after(() => cleanup(other));
  git(["clone", "-q", remote, other], other);
  git(["config", "user.email", "t@example.com"], other);
  git(["config", "user.name", "T"], other);
  await writeFile(path.join(other, "z.txt"), "z\n");
  git(["add", "z.txt"], other);
  git(["commit", "-q", "-m", "ahead"], other);
  git(["push", "-q", "origin", "main"], other);
  git(["fetch", "-q"], fx.ws);

  const r = verifyAB(fx, "no sha here", ["--apply"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /1 commit\(s\) behind/);
});
