/**
 * Tests for lib/inventory.mjs, the self-adoption probe.
 *
 * Fixtures build synthetic skills dirs / settings.json / repo trees under
 * mkdtemp -- the real filesystem is what this module observes, so asserting
 * against it would restate whatever happens to be on disk today instead of
 * pinning behaviour (same rationale as tests/skills-scan.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  STATUS,
  inventorySkills,
  inventoryPlugins,
  inventoryRepos,
  inventoryStandalone,
  inventory,
  toSystemsRow,
  emitRows,
  transcriptWindow,
  readFrontmatterDescription,
  countReferrers,
} from "../../lib/report/inventory.mjs";

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ── skills ──────────────────────────────────────────────────────────────

function skillDir(root, name, { description = "does a thing", body = "body" } = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const fm = description ? `---\nname: ${name}\ndescription: ${description}\n---\n\n` : `---\nname: ${name}\n---\n\n`;
  writeFileSync(path.join(dir, "SKILL.md"), fm + body);
  return dir;
}

test("readFrontmatterDescription reads the description scalar", () => {
  const root = tmp("inv-skills-");
  try {
    const dir = skillDir(root, "has-desc", { description: "triggers on X" });
    assert.equal(readFrontmatterDescription(path.join(dir, "SKILL.md")), "triggers on X");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFrontmatterDescription returns null when there is no description line", () => {
  const root = tmp("inv-skills-");
  try {
    const dir = skillDir(root, "no-desc", { description: null });
    assert.equal(readFrontmatterDescription(path.join(dir, "SKILL.md")), null);
    assert.equal(readFrontmatterDescription(null), null);
    assert.equal(readFrontmatterDescription(path.join(root, "missing", "SKILL.md")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invoked skill classifies active with usage/transcript evidence", () => {
  const root = tmp("inv-skills-");
  try {
    skillDir(root, "used-skill");
    const { items } = inventorySkills({
      skillsDir: root,
      usage: { "used-skill": { usageCount: 5, lastUsedAt: 1770000000000 } },
      transcripts: { byName: { "used-skill": { count: 2, sessions: 1 } }, scanned: true, searcher: "rg" },
      window: { start: "2026-03-17T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z", scanned: 100, error: null },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].status, STATUS.ACTIVE);
    assert.match(items[0].evidence, /usageCount=5/);
    assert.match(items[0].evidence, /transcriptCount=2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-invoked skill WITH a description classifies installed-never-invoked, evidence carries the probe window", () => {
  const root = tmp("inv-skills-");
  try {
    skillDir(root, "quiet-skill", { description: "does something" });
    const { items } = inventorySkills({
      skillsDir: root,
      usage: {},
      transcripts: { byName: {}, scanned: true, searcher: "rg" },
      window: { start: "2026-03-17T00:00:00.000Z", end: "2026-08-13T00:00:00.000Z", scanned: 3747, error: null },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].status, STATUS.INSTALLED_NEVER_INVOKED);
    assert.match(items[0].evidence, /2026-03-17.*2026-08-13/);
    assert.equal(items[0].hasDescription, true);
    assert.doesNotMatch(items[0].evidence, /cannot autotrigger/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-invoked skill with NO description frontmatter is flagged as unable to autotrigger", () => {
  const root = tmp("inv-skills-");
  try {
    skillDir(root, "no-trigger", { description: null });
    const { items } = inventorySkills({
      skillsDir: root,
      usage: {},
      transcripts: { byName: {}, scanned: true, searcher: "rg" },
      window: { start: null, end: null, scanned: 0, error: null },
    });
    assert.equal(items[0].status, STATUS.INSTALLED_NEVER_INVOKED);
    assert.equal(items[0].hasDescription, false);
    assert.match(items[0].evidence, /cannot autotrigger/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dangling SKILL.md symlink classifies unknown, never a default status", () => {
  const root = tmp("inv-skills-");
  try {
    const dir = path.join(root, "dangling-one");
    mkdirSync(dir, { recursive: true });
    symlinkSync(path.join(root, "nowhere", "SKILL.md"), path.join(dir, "SKILL.md"));
    const { items } = inventorySkills({
      skillsDir: root,
      usage: {},
      transcripts: { byName: {}, scanned: true, searcher: "rg" },
      window: { start: null, end: null, scanned: 0, error: null },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].status, STATUS.UNKNOWN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transcriptWindow recurses into nested session/subagent directories", () => {
  const root = tmp("inv-tx-");
  try {
    const proj = path.join(root, "proj1");
    mkdirSync(path.join(proj, "session1", "subagents"), { recursive: true });
    writeFileSync(path.join(proj, "top.jsonl"), "{}");
    writeFileSync(path.join(proj, "session1", "mid.jsonl"), "{}");
    writeFileSync(path.join(proj, "session1", "subagents", "deep.jsonl"), "{}");
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const midTime = new Date("2026-03-01T00:00:00.000Z");
    const newTime = new Date("2026-06-01T00:00:00.000Z");
    utimesSync(path.join(proj, "top.jsonl"), oldTime, oldTime);
    utimesSync(path.join(proj, "session1", "mid.jsonl"), midTime, midTime);
    utimesSync(path.join(proj, "session1", "subagents", "deep.jsonl"), newTime, newTime);

    const w = transcriptWindow({ projectsDir: root });
    assert.equal(w.scanned, 3, "must find the file nested two levels below the session dir, not just the top-level one");
    assert.equal(w.start, oldTime.toISOString());
    assert.equal(w.end, newTime.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transcriptWindow on a missing dir reports error, not a fabricated zero window", () => {
  const w = transcriptWindow({ projectsDir: "/nonexistent/path/for/sure" });
  assert.equal(w.error, "projects dir unreadable");
  assert.equal(w.start, null);
});

// ── plugins ─────────────────────────────────────────────────────────────

test("inventoryPlugins classifies true as active-unadopted and false as dormant, with evidence", () => {
  const root = tmp("inv-plugins-");
  try {
    const settingsPath = path.join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "a@x": true, "b@x": false } }));
    const { items, total, enabledCount } = inventoryPlugins({ settingsPath });
    assert.equal(total, 2);
    assert.equal(enabledCount, 1);
    const a = items.find((i) => i.id === "plugin:a@x");
    const b = items.find((i) => i.id === "plugin:b@x");
    assert.equal(a.status, STATUS.ACTIVE_UNADOPTED);
    assert.match(a.evidence, /no per-plugin invocation counter/);
    assert.equal(b.status, STATUS.DORMANT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventoryPlugins on an unreadable settings file reports an error, not an empty success", () => {
  const { items, error } = inventoryPlugins({ settingsPath: "/nonexistent/settings.json" });
  assert.equal(items.length, 0);
  assert.match(error, /unreadable or absent/);
});

// ── repos ───────────────────────────────────────────────────────────────

function initRepo(dir, { withRemote = false, commitAgeDays = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(path.join(dir, "f.txt"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  const date = new Date(Date.now() - commitAgeDays * 86400000).toISOString();
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (withRemote) {
    execFileSync("git", ["remote", "add", "origin", "https://example.com/repo.git"], { cwd: dir });
  }
  return dir;
}

test("a recently-committed repo with a remote classifies active", () => {
  const root = tmp("inv-repos-");
  try {
    initRepo(path.join(root, "proj"), { withRemote: true });
    const { items } = inventoryRepos({ searchRoots: [root], maxDepth: 3 });
    const repo = items.find((i) => i.kind === "git repo");
    assert.ok(repo, "expected a git repo item");
    assert.equal(repo.status, STATUS.ACTIVE);
    assert.equal(repo.hasRemote, true);
    assert.match(repo.evidence, /remote present/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recent repo with NO remote classifies active-unadopted, never silently dropped", () => {
  const root = tmp("inv-repos-");
  try {
    initRepo(path.join(root, "proj"), { withRemote: false });
    const { items } = inventoryRepos({ searchRoots: [root], maxDepth: 3 });
    const repo = items.find((i) => i.kind === "git repo");
    assert.equal(repo.status, STATUS.ACTIVE_UNADOPTED);
    assert.equal(repo.hasRemote, false);
    assert.match(repo.evidence, /NO REMOTE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory with real files and no .git anywhere below it is reported, not silently skipped", () => {
  const root = tmp("inv-repos-");
  try {
    const noGit = path.join(root, "no-git-project");
    mkdirSync(noGit, { recursive: true });
    writeFileSync(path.join(noGit, "data.csv"), "a,b\n1,2\n");
    const { items } = inventoryRepos({ searchRoots: [root], maxDepth: 3 });
    const found = items.find((i) => i.kind === "directory (no .git)" && i.artifacts === noGit);
    assert.ok(found, "expected the no-.git directory to be reported");
    assert.equal(found.status, STATUS.ACTIVE_UNADOPTED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty directory with no real files is not reported as a no-git artifact", () => {
  const root = tmp("inv-repos-");
  try {
    mkdirSync(path.join(root, "just-empty"), { recursive: true });
    const { items } = inventoryRepos({ searchRoots: [root], maxDepth: 3 });
    assert.equal(items.filter((i) => i.kind === "directory (no .git)").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo walk past its depth budget records a drop, never a silent truncation", () => {
  const root = tmp("inv-repos-");
  try {
    const deep = path.join(root, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "real.txt"), "x");
    const { items, dropped } = inventoryRepos({ searchRoots: [root], maxDepth: 2 });
    assert.equal(items.filter((i) => i.kind === "directory (no .git)").length, 0);
    assert.ok(dropped.length > 0, "expected the walk to log what it did not reach");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero-budget walk reports every root-level child as dropped, not silently empty", () => {
  const root = tmp("inv-repos-");
  try {
    mkdirSync(path.join(root, "child"), { recursive: true });
    writeFileSync(path.join(root, "child", "f.txt"), "x");
    const { items, dropped, budgetExceeded } = inventoryRepos({ searchRoots: [root], maxDepth: 3, budgetMs: -1 });
    assert.equal(items.length, 0);
    assert.ok(dropped.length > 0);
    assert.equal(budgetExceeded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── standalone artifacts ───────────────────────────────────────────────

test("countReferrers excludes the file's own path and counts distinct referring files", () => {
  const root = tmp("inv-standalone-");
  try {
    const target = path.join(root, "CANON.md");
    writeFileSync(target, "# canon\nCANON.md is the source of truth.\n");
    const referrer = path.join(root, "OTHER.md");
    writeFileSync(referrer, "see CANON.md for details");
    const { count, files } = countReferrers(target, { roots: [root] });
    assert.equal(count, 1);
    assert.deepEqual(files.map((f) => path.basename(f)), ["OTHER.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a standalone artifact with zero referrers and stale mtime classifies dormant", () => {
  const root = tmp("inv-standalone-");
  try {
    const target = path.join(root, "ORPHAN.md");
    writeFileSync(target, "nobody points at this");
    const old = new Date("2020-01-01");
    utimesSync(target, old, old);
    const { items } = inventoryStandalone({ seeds: [target], roots: [root] });
    assert.equal(items[0].status, STATUS.DORMANT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a standalone artifact with zero referrers but a recent mtime classifies active-unadopted", () => {
  const root = tmp("inv-standalone-");
  try {
    const target = path.join(root, "FRESH.md");
    writeFileSync(target, "nobody points at this yet");
    const { items } = inventoryStandalone({ seeds: [target], roots: [root] });
    assert.equal(items[0].status, STATUS.ACTIVE_UNADOPTED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing seed file reports unknown, never a fabricated status", () => {
  const { items } = inventoryStandalone({ seeds: ["/definitely/not/here.md"] });
  assert.equal(items[0].status, STATUS.UNKNOWN);
});

// ── top-level inventory() and emitRows() ───────────────────────────────

test("inventory() never writes anything -- read-only smoke test over synthetic dirs", () => {
  const root = tmp("inv-top-");
  try {
    const skillsDir = path.join(root, "skills");
    skillDir(skillsDir, "one");
    const settingsPath = path.join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "p@x": true } }));
    const repoRoot = path.join(root, "repos");
    initRepo(path.join(repoRoot, "proj"));

    const dropped = [];
    const inv = inventory({
      skillsDir,
      settingsPath,
      searchRoots: [repoRoot],
      standaloneSeeds: [],
      transcripts: { byName: {}, scanned: true, searcher: "rg" },
      log: (msg) => dropped.push(msg),
    });

    assert.equal(inv.categories.skills.length, 1);
    assert.equal(inv.categories.plugins.length, 1);
    assert.ok(inv.categories.repos.length >= 1);
    assert.equal(inv.categories.standalone.length, 0);
    assert.equal(inv.counts.total, inv.categories.skills.length + inv.categories.plugins.length + inv.categories.repos.length + inv.categories.standalone.length);
    assert.ok(inv.probeLimits.note.includes("seeded"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitRows / toSystemsRow match SYSTEMS.md's 9-column order and never fill adoption_date", () => {
  const item = {
    id: "example",
    kind: "skill (Claude Code)",
    status: STATUS.ACTIVE,
    artifacts: "/some/path",
    liveness_probe: "echo ok",
  };
  const row = toSystemsRow(item, { verifiedDate: "2026-08-13" });
  const cells = row.slice(2, -2).split(" | ");
  assert.equal(cells.length, 9);
  assert.equal(cells[0], "example");
  assert.equal(cells[1], "skill (Claude Code)");
  assert.equal(cells[2], STATUS.ACTIVE);
  assert.equal(cells[3], "—");
  assert.equal(cells[4], "/some/path");
  assert.equal(cells[5], "echo ok");
  assert.equal(cells[6], "2026-08-13");
  assert.match(cells[7], /BLANK/);
  assert.equal(cells[8], "n/a");
});

// ---------------------------------------------------------------------------
// STANDALONE_SEEDS must not carry a null — the integration-config leak
// ---------------------------------------------------------------------------

test("no seed is null — a null leaks a garbage row and a Node deprecation", async () => {
  // `INTEGRATIONS.portsFile` is built by `pick(env, key, legacy)`, which returns
  // `legacy && existsSync(legacy) ? legacy : null`. So a legacy default naming a
  // path that no longer exists resolves to NULL rather than to a dead path —
  // graceful, and then the null is spread straight into STANDALONE_SEEDS.
  //
  // Two consequences, both live before this test:
  //   1. `inventoryStandalone` emits `id: "standalone:null"`, status unknown,
  //      evidence "file does not exist at null" — a row about nothing.
  //   2. `existsSync(null)` raises Node's [DEP0187] deprecation and is slated to
  //      THROW in a future release, which would take the whole inventory down.
  //
  // Asserting on the SEEDS rather than on the resolved ports path keeps this
  // machine-independent: a checkout with no ports.yml at all must still pass.
  const { STANDALONE_SEEDS } = await import("../../lib/report/inventory.mjs");
  for (const [i, s] of STANDALONE_SEEDS.entries()) {
    assert.ok(
      typeof s === "string" && s.length > 0,
      `STANDALONE_SEEDS[${i}] is ${JSON.stringify(s)} — an unresolved integration must be omitted, not carried as null`,
    );
  }
});

test("no standalone row is reported about a null path", async () => {
  // The observable half of the same defect: even if a null survived into the
  // seeds, the report must never contain a row whose subject is "null". A row
  // that says "file does not exist at null" is noise that reads like a finding.
  const { inventoryStandalone } = await import("../../lib/report/inventory.mjs");
  const r = inventoryStandalone({});
  for (const item of r.items) {
    assert.ok(!String(item.id).includes("null"), `garbage row: ${item.id} — ${item.evidence}`);
  }
});
