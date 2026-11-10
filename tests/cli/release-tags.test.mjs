/**
 * Tags under rule:release-versioning (#238): the alias script, and the `release-tag` gate in `release --check`.
 *
 * Both run against FIXTURE repos built here; the real repo's tags are never read and never touched. The alias
 * script's safety claim is its side effect, so each case snapshots every ref before and after
 * (rule:safety-flag-needs-a-test): a dry run must change none, and --apply must only ADD refs, never move or delete one.
 * The gate is tested in both directions (a violation fails, a conforming tag passes), and each failing case is the
 * one a mutation of the gate (accept a lightweight tag) turns green.
 */
// @size medium — starts processes (git, node); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateReleaseTag } from "../../lib/core/release.mjs";
import { planAliases, listVersionTags, legacyTagsYaml } from "../../lib/core/release-tags.mjs";
import { lastTag, tagVersion } from "../../lib/core/release-git.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "..", "scripts", "release-tag-aliases.mjs");
const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repo with three commits; `spec` lists [name, commitIndex, annotated]. */
function repoWith(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-release-tags-"));
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "t");
  const shas = [];
  for (let i = 0; i < 3; i++) {
    writeFileSync(path.join(dir, "f.txt"), `c${i}\n`);
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", `c${i}`);
    shas.push(g(dir, "rev-parse", "HEAD"));
  }
  for (const [name, idx, annotated] of spec) {
    if (annotated) g(dir, "tag", "-a", name, shas[idx], "-m", name);
    else g(dir, "tag", name, shas[idx]);
  }
  return { dir, shas };
}
const refs = (dir) => g(dir, "for-each-ref", "refs/tags", "--format=%(refname) %(objecttype) %(objectname)");
const script = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, "--repo", dir, ...args], { encoding: "utf8" });

test("alias script: a dry run (the default) reports the plan and changes no ref", () => {
  const { dir } = repoWith([["v0.1.0", 0, false], ["v0.1.1", 1, true], ["v0.2.0", 2, false]]);
  try {
    const before = refs(dir);
    const r = script(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(refs(dir), before, "a dry run must not touch any ref");
    assert.match(r.stdout, /dry run/);
    for (const v of ["0.1.0", "0.1.1", "0.2.0"]) assert.match(r.stdout, new RegExp(`v${v.replace(/\./g, "\\.")}\\s+-> propagate-v${v.replace(/\./g, "\\.")}.*would create`));
    assert.match(r.stdout, /3 to create, 0 already aliased, 0 conflict/);
  } finally { rm(dir); }
});

test("alias script --apply: creates ANNOTATED aliases on the same commits, adds refs only, never moves or deletes one", () => {
  const { dir, shas } = repoWith([["v0.1.0", 0, false], ["v0.1.1", 1, true], ["v0.2.0", 2, false]]);
  try {
    const before = refs(dir).split("\n");
    const r = script(dir, "--apply");
    assert.equal(r.status, 0, r.stderr);
    const after = refs(dir).split("\n");
    for (const line of before) assert.ok(after.includes(line), `existing ref changed or vanished: ${line}`);
    assert.equal(after.length, before.length + 3, "exactly one new ref per legacy tag");
    for (const [v, idx] of [["0.1.0", 0], ["0.1.1", 1], ["0.2.0", 2]]) {
      assert.equal(g(dir, "cat-file", "-t", `propagate-v${v}`), "tag", `propagate-v${v} must be annotated`);
      assert.equal(g(dir, "rev-parse", `propagate-v${v}^{commit}`), shas[idx], `propagate-v${v} must point at the legacy tag's commit`);
    }
    assert.match(r.stdout, /push is yours/);
    // idempotent: a second --apply creates nothing and reports the aliases as present.
    const again = script(dir, "--apply");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(refs(dir).split("\n").length, after.length);
    assert.match(again.stdout, /0 to create, 3 already aliased/);
  } finally { rm(dir); }
});

test("alias script: an alias already on a DIFFERENT commit is a conflict, left alone, and the exit code says so", () => {
  const { dir, shas } = repoWith([["v0.1.0", 0, false], ["propagate-v0.1.0", 2, true]]);
  try {
    const before = refs(dir);
    const r = script(dir, "--apply");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CONFLICT: propagate-v0\.1\.0 already points at/);
    assert.equal(refs(dir), before, "a conflicting alias must not be moved");
    assert.equal(g(dir, "rev-parse", "propagate-v0.1.0^{commit}"), shas[2]);
  } finally { rm(dir); }
});

test("alias script: a repo with no v* tags is could-not-run (exit 2), never a clean 'nothing to do'", () => {
  const { dir } = repoWith([]);
  try {
    const r = script(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no v\* tags found/);
  } finally { rm(dir); }
});

test("alias script: --print-sidecar derives legacy_tags from git (every v* tag, none typed), and refuses when there are none", () => {
  const { dir } = repoWith([["v0.1.0", 0, false], ["v0.2.0", 2, true]]);
  const empty = repoWith([]);
  try {
    const r = script(dir, "--print-sidecar");
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/- repo: /g) ?? []).length, 2);
    assert.match(r.stdout, /tag: v0\.1\.0/);
    assert.match(r.stdout, /tag: v0\.2\.0/);
    assert.equal(legacyTagsYaml(dir, "o/r").count, 2);
    assert.equal(script(empty.dir, "--print-sidecar").status, 2, "an empty scan is a blind scan, not a clean one");
  } finally { rm(dir); rm(empty.dir); }
});

test("alias script: unknown arguments are refused", () => {
  const { dir } = repoWith([["v0.1.0", 0, false]]);
  try { assert.equal(script(dir, "--force").status, 2); } finally { rm(dir); }
});

// --- the gate --------------------------------------------------------------------------------------------------------

test("release-tag gate: a LIGHTWEIGHT propagate-v* tag on HEAD fails (mutation: accept it and this goes red)", () => {
  const { dir } = repoWith([["propagate-v0.3.0", 2, false]]);
  try {
    const r = gateReleaseTag({ skillDir: dir });
    assert.equal(r.status, "failed");
    assert.match(r.detail, /propagate-v0\.3\.0 is a LIGHTWEIGHT tag on HEAD/);
    assert.match(r.detail, /git tag -a propagate-v0\.3\.0/);
  } finally { rm(dir); }
});

test("release-tag gate: a v*-only tag on HEAD with no propagate-v* alias fails", () => {
  const { dir } = repoWith([["v0.3.0", 2, true]]);
  try {
    const r = gateReleaseTag({ skillDir: dir });
    assert.equal(r.status, "failed");
    assert.match(r.detail, /v0\.3\.0 is on HEAD with no propagate-v0\.3\.0 alias/);
  } finally { rm(dir); }
});

test("release-tag gate: an annotated propagate-v* tag on HEAD passes, and so does a legacy v* tag that has its alias", () => {
  const a = repoWith([["propagate-v0.3.0", 2, true]]);
  const b = repoWith([["v0.3.0", 2, false], ["propagate-v0.3.0", 2, true]]);
  try {
    const ra = gateReleaseTag({ skillDir: a.dir });
    assert.equal(ra.status, "passed", ra.detail);
    assert.match(ra.detail, /propagate-v0\.3\.0 \(annotated\)/);
    const rb = gateReleaseTag({ skillDir: b.dir });
    assert.equal(rb.status, "passed", rb.detail);
  } finally { rm(a.dir); rm(b.dir); }
});

test("release-tag gate: no version tag on HEAD passes AND says there was nothing to look at; unaliased legacy tags are named", () => {
  const { dir } = repoWith([["v0.1.0", 0, false], ["v0.2.0", 1, false]]);
  try {
    const r = gateReleaseTag({ skillDir: dir });
    assert.equal(r.status, "passed");
    assert.match(r.detail, /no version tag on HEAD yet, so there is nothing to refuse/);
    assert.match(r.detail, /2 legacy v\* tag\(s\) still have no propagate-v\* alias/);
    assert.deepEqual(r.unaliasedLegacy, ["v0.1.0", "v0.2.0"]);
  } finally { rm(dir); }
});

test("release-tag gate: not a git work tree is could-not-run, with the reason", () => {
  const d = mkdtempSync(path.join(tmpdir(), "propagate-release-nogit-"));
  try {
    const r = gateReleaseTag({ skillDir: d });
    assert.equal(r.status, "could-not-run");
    assert.match(r.reason, /not a git work tree/);
  } finally { rm(d); }
});

// --- the tag readers the release-kind path depends on ------------------------------------------------------------------

test("lastTag finds BOTH tag forms: after the first propagate-v* release, v* alone would keep answering the old tag", () => {
  const { dir } = repoWith([["v0.1.0", 0, false], ["propagate-v0.2.0", 1, true]]);
  try {
    assert.equal(lastTag(dir).tag, "propagate-v0.2.0", "the newer propagate-v* tag, not the stale v0.1.0");
    assert.equal(tagVersion("propagate-v0.2.0"), "0.2.0");
    assert.equal(tagVersion("v0.1.0"), "0.1.0");
    assert.deepEqual(listVersionTags(dir).tags.map((t) => [t.name, t.annotated]), [["propagate-v0.2.0", true], ["v0.1.0", false]]);
    assert.equal(planAliases(dir).plan.length, 1);
  } finally { rm(dir); }
});
