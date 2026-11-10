/**
 * The release lifecycle script (#238): draft -> pre-release -> release -> "Replaced by" on the previous release.
 *
 * `gh` is a STUB here, a node script that keeps a JSON list of releases and applies POST/PATCH to it, so the tests run the
 * real lifecycle logic end to end and nothing can reach GitHub. The side effect is what is asserted: the stub's state file
 * (and its call log) is snapshotted before and after, because "dry run sends no write" is a claim about writing
 * (rule:safety-flag-needs-a-test). The tag preconditions run against a real fixture repo with a local bare "remote".
 */
// @size medium — starts processes (git, node); run when affected
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { publishRelease, extractChangelogSection, previousRelease } from "../../lib/core/release-publish.mjs";

const rm = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.18.0] — 2026-11-20

### Added

- thing (#1)

## [0.17.0] — 2026-11-10

### Fixed

- older thing
`;

/** A repo at 0.18.0 with an annotated propagate-v0.18.0, pushed to a local bare remote. */
function fixture({ annotated = true, pushed = true, tag = "propagate-v0.18.0", versionFile = "0.18.0" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-release-publish-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "CHANGELOG.md"), CHANGELOG);
  writeFileSync(path.join(repo, "VERSION"), versionFile + "\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "chore(release): v0.18.0");
  if (annotated) g(repo, "tag", "-a", tag, "-m", tag); else g(repo, "tag", tag);
  g(root, "init", "-q", "--bare", remote);
  g(repo, "remote", "add", "origin", remote);
  if (pushed) g(repo, "push", "-q", "origin", "refs/tags/" + tag);
  // the stub gh
  const stateFile = path.join(root, "gh-state.json");
  const logFile = path.join(root, "gh-calls.log");
  const ghBin = path.join(root, "gh");
  writeFileSync(ghBin, `#!/usr/bin/env node
const fs = require("node:fs");
const state = ${JSON.stringify(stateFile)}, log = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
fs.appendFileSync(log, args.join(" ") + "\\n");
const db = JSON.parse(fs.readFileSync(state, "utf8"));
const save = () => fs.writeFileSync(state, JSON.stringify(db));
const xi = args.indexOf("-X");
const method = xi === -1 ? "GET" : args[xi + 1];
const ep = args[xi === -1 ? 1 : xi + 2];
let input = ""; if (args.includes("--input")) input = fs.readFileSync(0, "utf8");
if (args[0] !== "api") { console.error("stub: unexpected " + args.join(" ")); process.exit(1); }
if (method === "GET") {
  const m = /releases\\?per_page=(\\d+)&page=(\\d+)/.exec(ep); const per = +m[1], page = +m[2];
  console.log(JSON.stringify(db.releases.slice((page - 1) * per, page * per))); process.exit(0);
}
const body = JSON.parse(input);
if (method === "POST") {
  const r = { id: ++db.seq, html_url: "https://example.invalid/" + body.tag_name, assets: db.assets || [], ...body };
  db.releases.unshift(r); save(); console.log(JSON.stringify(r)); process.exit(0);
}
if (method === "PATCH") {
  const id = +ep.split("/").pop(); const r = db.releases.find((x) => x.id === id);
  if (!r) { console.error("stub: no release " + id); process.exit(1); }
  const { make_latest, ...rest } = body; Object.assign(r, rest); if (make_latest) r.make_latest = make_latest;
  save(); console.log(JSON.stringify(r)); process.exit(0);
}
process.exit(1);
`);
  chmodSync(ghBin, 0o755);
  const setState = (releases, extra = {}) => writeFileSync(stateFile, JSON.stringify({ seq: 100, releases, ...extra }));
  setState([{ id: 1, tag_name: "v0.17.0", name: "v0.17.0", body: "old 0.17 body", draft: false, prerelease: false, assets: [] }]);
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);
  const run = (over = {}) => {
    const lines = [];
    const res = publishRelease({ root: repo, version: "0.18.0", tag, remote: "origin", gh: (a, o) => runStub(ghBin, a, o), out: (l) => lines.push(l), ...over });
    return { ...res, text: lines.join("\n") };
  };
  return { root, repo, remote, stateFile, setState, state, calls, run, snapshot: () => readFileSync(stateFile, "utf8") + "\n--\n" + calls().filter((c) => c.includes("-X")).join("\n") };
}

function runStub(bin, args, o = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", input: o.input });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("extractChangelogSection: the body is the section's text; a missing or empty section is null, never an empty body", () => {
  assert.equal(extractChangelogSection(CHANGELOG, "0.18.0"), "### Added\n\n- thing (#1)");
  assert.equal(extractChangelogSection(CHANGELOG, "0.17.0"), "### Fixed\n\n- older thing");
  assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), null);
  assert.equal(extractChangelogSection(CHANGELOG, "Unreleased"), null, "an empty section is not a body");
  assert.equal(extractChangelogSection(CHANGELOG, "0.1"), null, "a prefix of a heading is not that heading");
});

test("previousRelease: the highest FULL release below the version; drafts and pre-releases are not 'previous'", () => {
  const rel = [
    { tag_name: "v0.16.1", draft: false, prerelease: false },
    { tag_name: "propagate-v0.17.0", draft: false, prerelease: false },
    { tag_name: "v0.17.1", draft: false, prerelease: true },
    { tag_name: "propagate-v0.18.0", draft: true, prerelease: false },
    { tag_name: "not-a-version", draft: false, prerelease: false },
  ];
  assert.equal(previousRelease(rel, "0.18.0").tag_name, "propagate-v0.17.0");
  assert.equal(previousRelease(rel, "0.16.1"), null);
});

test("dry run (the default): reads, prints every write, and sends none (the stub's state and call log gain no write)", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    const r = f.run();
    assert.equal(r.exitCode, 0, r.text);
    assert.equal(f.snapshot(), before, "the release state and the write-call log are unchanged");
    assert.ok(f.calls().length > 0, "a dry run still READS");
    assert.deepEqual(f.calls().filter((c) => /-X/.test(c)), [], "no write call reached gh");
    assert.equal(r.writes, 0);
    for (const s of ["[draft] would create", "[pre-release] would promote", "[release] would promote — pre-release -> release, marked Latest", "[replaced] would mark"]) assert.ok(r.text.includes(s), `${s}\n${r.text}`);
    assert.match(r.text, /gh api -X POST repos\/Rupali59\/propagate\/releases --input -   \[dry run: not sent\]/);
    assert.match(r.text, /"body":"### Added\\n\\n- thing \(#1\)"/, "the body printed is the extracted CHANGELOG section");
    assert.match(r.text, /v0\.17\.0 now begins "Replaced by propagate-v0\.18\.0"/);
  } finally { rm(f.root); }
});

test("--apply runs the whole lifecycle: draft, pre-release, release (Latest), and the previous release gains 'Replaced by' at the top", () => {
  const f = fixture();
  try {
    const r = f.run({ apply: true });
    assert.equal(r.exitCode, 0, r.text);
    const s = f.state();
    const cur = s.releases.find((x) => x.tag_name === "propagate-v0.18.0");
    assert.equal(cur.draft, false);
    assert.equal(cur.prerelease, false);
    assert.equal(cur.make_latest, "true");
    assert.equal(cur.body, "### Added\n\n- thing (#1)", "the body is the CHANGELOG section, byte for byte");
    const prev = s.releases.find((x) => x.tag_name === "v0.17.0");
    assert.equal(prev.body, "Replaced by propagate-v0.18.0\n\nold 0.17 body");
    assert.equal(r.writes, 4, "POST draft, PATCH pre-release, PATCH release, PATCH previous");
  } finally { rm(f.root); }
});

test("idempotent: a second --apply sends NO write, and a run that stopped after the draft continues from there", () => {
  const f = fixture();
  try {
    assert.equal(f.run({ apply: true, only: "draft" }).exitCode, 0);
    assert.equal(f.state().releases.find((x) => x.tag_name === "propagate-v0.18.0").draft, true);
    const rest = f.run({ apply: true });
    assert.equal(rest.exitCode, 0, rest.text);
    assert.match(rest.text, /\[draft\] skip — a draft already exists/);
    assert.equal(rest.writes, 3, "pre-release, release, replaced only");
    const snap = f.snapshot().split("\n--\n")[0];
    const again = f.run({ apply: true });
    assert.equal(again.exitCode, 0, again.text);
    assert.equal(again.writes, 0, "nothing left to do, nothing written");
    assert.equal(f.snapshot().split("\n--\n")[0], snap, "the release state is byte-identical after a no-op run");
    assert.match(again.text, /\[replaced\] skip — v0\.17\.0 already begins "Replaced by/);
  } finally { rm(f.root); }
});

test("the order is enforced: the release step on a draft refuses and writes nothing", () => {
  const f = fixture();
  try {
    f.run({ apply: true, only: "draft" });
    const before = f.state();
    const r = f.run({ apply: true, only: "release" });
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /still a draft; promote it to a pre-release first/);
    assert.deepEqual(f.state(), before);
  } finally { rm(f.root); }
});

test("--no-latest promotes without marking Latest; an expected asset that is missing blocks the promotion to a release", () => {
  const f = fixture();
  try {
    f.run({ apply: true, only: "draft" });
    f.run({ apply: true, only: "pre-release" });
    const blocked = f.run({ apply: true, only: "pre-release", expectAssets: ["propagate.tgz"] });
    assert.equal(blocked.exitCode, 1);
    assert.match(blocked.text, /missing expected asset\(s\): propagate\.tgz/);
    const r = f.run({ apply: true, only: "release", latest: false });
    assert.equal(r.exitCode, 0, r.text);
    assert.equal(f.state().releases.find((x) => x.tag_name === "propagate-v0.18.0").make_latest, "false");
  } finally { rm(f.root); }
});

test("preconditions: --apply REFUSES a lightweight tag, a tag missing from the remote, or a tag whose VERSION differs, and sends nothing", () => {
  for (const [label, opts, pat] of [
    ["lightweight", { annotated: false }, /is lightweight; the release tag must be annotated/],
    ["unpushed", { pushed: false }, /is not on remote origin/],
    ["wrong VERSION", { versionFile: "0.17.9" }, /holds VERSION 0\.17\.9, not 0\.18\.0/],
  ]) {
    const f = fixture(opts);
    try {
      const before = f.snapshot();
      const dry = f.run();
      assert.equal(dry.exitCode, 0, `${label}: a dry run reports and continues\n${dry.text}`);
      assert.match(dry.text, pat);
      assert.match(dry.text, /would fail on --apply/);
      const r = f.run({ apply: true });
      assert.equal(r.exitCode, 1, `${label}\n${r.text}`);
      assert.match(r.text, pat);
      assert.equal(f.snapshot(), before, `${label}: no write`);
    } finally { rm(f.root); }
  }
});

test("a version with no CHANGELOG section refuses before any gh call", () => {
  const f = fixture();
  try {
    const r = f.run({ version: "0.19.0", tag: "propagate-v0.19.0", apply: true });
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /no non-empty "## \[0\.19\.0\]" section/);
    assert.deepEqual(f.calls(), []);
  } finally { rm(f.root); }
});

test("gh returning something that is not a list is refused, not read as 'no releases'", () => {
  const f = fixture();
  try {
    const r = f.run({ gh: () => ({ status: 0, stdout: '{"message":"Bad credentials"}', stderr: "" }) });
    assert.equal(r.exitCode, 1);
    assert.match(r.text, /did not return a list/);
  } finally { rm(f.root); }
});
