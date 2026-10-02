/**
 * edgeDiff diffs the WORKING TREE, both sides, from the last PINNING event.
 *
 * Three defects pinned, each from the plan's Eng review:
 *  - `<since>..HEAD` reported `empty: true` for a source edited and not yet
 *    committed -- the state every drifting edge is in when someone sits down to
 *    settle it. Real git repos below, because a stubbed `git` would agree with
 *    whatever argument list the code builds.
 *  - a REVERSED/DIVERGED edge moved on the DOWNSTREAM; a source-only diff says
 *    "the source has not changed" and ends the investigation.
 *  - `deferred` pins nothing, so "since the last verify" must not move to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { edgeDiff } from "../../lib/report/evidence.mjs";
import { historyFromEvents } from "../../lib/report/queue.mjs";

function repo() {
  // NOT realpath'd, on purpose: on macOS tmpdir() is /var -> /private/var, and git
  // reports the real path, so this is also the regression test for relativeInRepo
  // (a plain path.relative walked out of the repo and git refused the diff).
  const dir = mkdtempSync(path.join(tmpdir(), "evidence-wt-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  writeFileSync(path.join(dir, "src.md"), "src v1\n");
  writeFileSync(path.join(dir, "down.md"), "down v1\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return { dir, g, sha: g("rev-parse", "HEAD") };
}

test("an UNCOMMITTED source edit shows a diff (it was empty:true under ..HEAD)", async () => {
  const { dir, sha } = repo();
  writeFileSync(path.join(dir, "src.md"), "src v2 uncommitted\n");
  const r = await edgeDiff({ file: path.join(dir, "src.md"), sinceCommit: sha });
  assert.equal(r.ok, true);
  assert.notEqual(r.empty, true);
  assert.match(r.text, /\+src v2 uncommitted/);
});

test("a COMMITTED edit still shows (the working tree includes it)", async () => {
  const { dir, g, sha } = repo();
  writeFileSync(path.join(dir, "src.md"), "src v2 committed\n");
  g("commit", "-qam", "edit");
  const r = await edgeDiff({ file: path.join(dir, "src.md"), sinceCommit: sha });
  assert.match(r.text, /\+src v2 committed/);
});

test("the downstream side is diffed too, from ITS own recorded commit", async () => {
  const { dir, sha } = repo();
  writeFileSync(path.join(dir, "down.md"), "down v2\n"); // only the downstream moved (REVERSED)
  const r = await edgeDiff({
    file: path.join(dir, "src.md"), sinceCommit: sha,
    downstreamFile: path.join(dir, "down.md"), downstreamSinceCommit: sha,
  });
  assert.equal(r.empty, true, "the source did not change");
  assert.ok(r.downstream, "and the answer does not stop there");
  assert.match(r.downstream.text, /\+down v2/);
  assert.equal(r.downstream.side, "downstream");
});

test("a downstream with no recorded commit says so (pre-2026-08-22 events), not 'unchanged'", async () => {
  const { dir, sha } = repo();
  const r = await edgeDiff({
    file: path.join(dir, "src.md"), sinceCommit: sha,
    downstreamFile: path.join(dir, "down.md"), downstreamSinceCommit: null,
  });
  assert.equal(r.downstream.ok, false);
  assert.match(r.downstream.reason, /no downstream commit was recorded/);
});

test("no downstream requested -> the result has the old shape, with no `downstream` key", async () => {
  const { dir, sha } = repo();
  const r = await edgeDiff({ file: path.join(dir, "src.md"), sinceCommit: sha });
  assert.equal("downstream" in r, false);
});

// ── "since last verify" = the last PINNING event ──────────────────────────

const ev = (ts, disposition, commit, extra = {}) => ({
  edge_id: "e1", ts, disposition, observed_at_commit: commit, observed_dirty: false, ...extra,
});

test("a later `deferred` does not move the baseline; the last PINNING event does", () => {
  const h = historyFromEvents([
    ev("2026-09-01T00:00:00Z", "propagated", "aaaa1111", { downstream_at_commit: "dddd1111" }),
    ev("2026-09-05T00:00:00Z", "deferred", "bbbb2222"),
  ]).get("e1");
  assert.equal(h.lastVerified.commit, "aaaa1111", "deferred pins nothing, so it is not 'the last verify'");
  assert.equal(h.lastVerified.downstreamCommit, "dddd1111");
  assert.equal(h.total, 2, "but it still counts as a judgement in the history");
  assert.equal(h.last.disposition, "deferred", "and `last` is still the most recent event of any kind");
});

test("a pinning event after a deferral wins; an edge with only deferrals has NO baseline (null, not the deferral)", () => {
  const later = historyFromEvents([
    ev("2026-09-01T00:00:00Z", "deferred", "aaaa1111"),
    ev("2026-09-02T00:00:00Z", "no-change-needed", "bbbb2222"),
  ]).get("e1");
  assert.equal(later.lastVerified.commit, "bbbb2222");

  const only = historyFromEvents([ev("2026-09-01T00:00:00Z", "deferred", "aaaa1111")]).get("e1");
  assert.equal(only.lastVerified, null);
});

test("a pre-2026-08-22 event has downstreamCommit null — absent is unknown, never invented", () => {
  const h = historyFromEvents([ev("2026-09-01T00:00:00Z", "propagated", "aaaa1111")]).get("e1");
  assert.equal(h.lastVerified.downstreamCommit, null);
});
