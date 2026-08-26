/**
 * Tests for lib/report/manifest.mjs — the setup manifest.
 *
 * Fixtures, never the live tree: the command's whole value is that it reports
 * gaps, and a test bound to this machine's tree would go red the moment someone
 * cloned a repo.
 *
 * Run: `npm test` (G56).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { workspaceManifest } from "../../lib/report/manifest.mjs";

const NO_REGISTRIES = { portsFile: null, deployFile: null, mongoFile: null };

/** Build a workspace fixture: sidecars, project dirs, lockfiles, git repos. */
function fixture(spec) {
  const root = mkdtempSync(path.join(tmpdir(), "manifest-"));
  for (const [name, s] of Object.entries(spec.sidecars ?? {})) {
    const dir = path.join(root, "propagation", "state", name);
    mkdirSync(dir, { recursive: true });
    const lines = [`schema_version: 1`, `project: ${s.project ?? name}`, `repo_root: ${s.repo_root ?? name}`];
    if (s.remote) lines.push(`remote: ${s.remote}`);
    if (s.active_line) lines.push(`active_line: ${s.active_line}`);
    if (s.external) lines.push("external:", ...s.external.map((e) => `  - path: ${e}`));
    writeFileSync(path.join(dir, ".sidecar.yml"), lines.join("\n") + "\n");
  }
  for (const [rel, files] of Object.entries(spec.dirs ?? {})) {
    const d = path.join(root, rel);
    mkdirSync(d, { recursive: true });
    for (const f of files) writeFileSync(path.join(d, f), f.endsWith(".json") ? "{}" : "");
  }
  for (const rel of spec.gitRepos ?? []) {
    const d = path.join(root, rel);
    mkdirSync(d, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore" });
    if (spec.remotes?.[rel]) {
      execFileSync("git", ["remote", "add", "origin", spec.remotes[rel]], { cwd: d, stdio: "ignore" });
    }
  }
  return root;
}
const cleanup = (r) => rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const gapKinds = (m) => m.gaps.map((g) => g.kind).sort();

test("toolchain comes from the LOCKFILE, and an absent packageManager is never npm", () => {
  // The revision that made this command worth building. Measured on the real
  // tree: `packageManager` resolves 1 of 6 units, the lockfile resolves 6.
  // Worse, `Astroclarity` and `marketing-intel` have a package.json and NO
  // field — rendering those as npm reproduces the break Vipin Kaushik/CLAUDE.md
  // records: "npm install in a pnpm project breaks CI silently".
  const root = fixture({
    sidecars: { a: { remote: "https://x/a.git" }, b: { remote: "https://x/b.git" }, c: { remote: "https://x/c.git" } },
    dirs: {
      a: ["pnpm-lock.yaml", "package.json"],
      b: ["package.json"], // package.json, NO lockfile, NO packageManager
      c: ["pyproject.toml", "uv.lock"],
    },
  });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    const tool = Object.fromEntries(m.projects.map((p) => [p.project, p.units[0].toolchain]));
    assert.equal(tool.a, "pnpm");
    assert.equal(tool.c, "uv");
    assert.notEqual(tool.b, "npm", "a package.json with no lockfile must NOT be guessed as npm");
    assert.equal(tool.b, "none", "unknown stays unknown");
  } finally {
    cleanup(root);
  }
});

test("a project with sub-packages yields one unit per lockfile", () => {
  // VipinKaushik-mb has no root package.json; it is server(3152) + ui(3153).
  // A per-project row cannot express that, so units are the unit of report.
  const root = fixture({
    sidecars: { mb: { remote: "https://x/mb.git" } },
    dirs: { "mb/server": ["package-lock.json"], "mb/ui": ["package-lock.json"] },
  });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.deepEqual(m.projects[0].units.map((u) => u.rel).sort(), ["mb/server", "mb/ui"]);
    assert.ok(m.projects[0].units.every((u) => u.toolchain === "npm"));
  } finally {
    cleanup(root);
  }
});

test("no remote and not a repo of its own => cannot-clone", () => {
  const root = fixture({ sidecars: { solo: {} }, dirs: { solo: ["package.json"] } });
  try {
    assert.deepEqual(gapKinds(workspaceManifest(root, { integrations: NO_REGISTRIES })), ["cannot-clone"]);
  } finally {
    cleanup(root);
  }
});

test("no remote in the sidecar but a real one on disk => remote-undeclared, with the fix", () => {
  // The sidecar records a VALUE, so it goes stale. Three workspaces were given
  // remotes on 2026-08-26 and their sidecars still said none — a fixable
  // declaration, not an unclonable repo, and the two must not look alike.
  const root = fixture({
    sidecars: { app: {} },
    gitRepos: ["app"],
    remotes: { app: "https://github.com/x/app.git" },
  });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.deepEqual(gapKinds(m), ["remote-undeclared"]);
    assert.match(m.gaps[0].detail, /Add `remote: https:\/\/github\.com\/x\/app\.git`/);
  } finally {
    cleanup(root);
  }
});

test("`git -C` walks UP, so a non-repo subdir must not inherit the parent's remote", () => {
  // Measured 2026-08-26: `Keerti/Keerti-mb` reported `keerti-workspace.git`
  // because it has no .git of its own. Believing that would have turned two
  // genuinely-unclonable projects into "declared, all fine".
  const root = fixture({ sidecars: { child: {} }, dirs: { child: ["package.json"] }, gitRepos: ["."] });
  try {
    execFileSync("git", ["remote", "add", "origin", "https://github.com/x/parent.git"], { cwd: root, stdio: "ignore" });
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.deepEqual(gapKinds(m).filter((k) => k !== "would-be-missed"), ["cannot-clone"]);
    assert.ok(!JSON.stringify(m.gaps).includes("parent.git"), "the parent's remote must never be attributed to a child");
  } finally {
    cleanup(root);
  }
});

test("a repo on disk that no sidecar declares => would-be-missed", () => {
  const root = fixture({ sidecars: { known: { remote: "https://x/k.git" } }, dirs: { known: [] }, gitRepos: ["stranger"] });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.ok(gapKinds(m).includes("would-be-missed"));
    assert.equal(m.gaps.find((g) => g.kind === "would-be-missed").project, "stranger");
  } finally {
    cleanup(root);
  }
});

test("declared but absent locally is INFORMATIONAL, not an error — a fresh machine is entirely this", () => {
  const root = fixture({ sidecars: { later: { remote: "https://x/l.git" } } });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.deepEqual(gapKinds(m), ["not-cloned-here"]);
    assert.match(m.gaps[0].detail, /informational/);
  } finally {
    cleanup(root);
  }
});

test("registries absent => `not configured`, and no unit silently loses its port", () => {
  const root = fixture({ sidecars: { a: { remote: "https://x/a.git" } }, dirs: { a: ["package-lock.json"] } });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.equal(m.sources.ports, "not configured");
    assert.equal(m.projects[0].units[0].portStatus, "not configured");
    assert.equal(m.projects[0].units[0].port, null, "null port, but the STATUS says why");
  } finally {
    cleanup(root);
  }
});

test("a workspace with no sidecars at all says so — 0 projects is not 0 gaps", () => {
  const root = fixture({ gitRepos: ["orphan"] });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.equal(m.projects.length, 0);
    assert.deepEqual(gapKinds(m), ["would-be-missed"], "an undeclared repo must still be reported");
  } finally {
    cleanup(root);
  }
});

test("external: entries survive into the manifest", () => {
  const root = fixture({ sidecars: { corpus: { remote: "https://x/c.git", external: ["sources-dir"] } } });
  try {
    const m = workspaceManifest(root, { integrations: NO_REGISTRIES });
    assert.deepEqual(m.projects[0].external.map((e) => e.path), ["sources-dir"]);
  } finally {
    cleanup(root);
  }
});
