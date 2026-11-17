/**
 * #291 — a workspace repo whose own root holds a lockfile is a unit, and
 * `would-be-missed` reaches an undeclared repo three levels deep.
 * Fixtures only; invented names.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { workspaceManifest } from "../../lib/report/manifest.mjs";

const NO_REGISTRIES = { portsFile: null, deployFile: null, mongoFile: null };

function sidecar(root, name, repoRoot) {
  const dir = path.join(root, "propagation", "state", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".sidecar.yml"), `schema_version: 1\nproject: ${name}\nrepo_root: ${repoRoot}\nremote: https://x/${name}.git\n`);
}
function touch(root, rel) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), "");
}
const gitInit = (d) => {
  mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "ignore" });
};
const cleanup = (r) => rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const run = (root) => workspaceManifest(root, { integrations: NO_REGISTRIES, home: root });
const wsUnits = (m) => m.projects.find((p) => p.isWorkspaceItself).units;

test("a workspace root with a lockfile is a detected unit; nested units are kept and not duplicated", () => {
  const root = mkdtempSync(path.join(tmpdir(), "roots-"));
  try {
    sidecar(root, "workspace", ".");
    sidecar(root, "app", "app");
    touch(root, "package-lock.json");
    touch(root, "app/pnpm-lock.yaml");
    const m = run(root);
    assert.deepEqual(wsUnits(m).map((u) => [u.rel, u.toolchain]), [[".", "npm"]]);
    const app = m.projects.find((p) => p.project === "app");
    assert.deepEqual(app.units.map((u) => [u.rel, u.toolchain]), [["app", "pnpm"]]);
    const all = m.projects.flatMap((p) => p.units.map((u) => u.rel));
    assert.equal(new Set(all).size, all.length, `a unit is listed twice: ${all}`);
  } finally { cleanup(root); }
});

test("a workspace root with no lockfile stays toolchain none", () => {
  const root = mkdtempSync(path.join(tmpdir(), "roots-"));
  try {
    sidecar(root, "workspace", ".");
    sidecar(root, "app", "app");
    touch(root, "app/package-lock.json");
    const m = run(root);
    assert.deepEqual(wsUnits(m).map((u) => u.toolchain), ["none"]);
  } finally { cleanup(root); }
});

test("an undeclared repo three levels into the workspace is would-be-missed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "roots-"));
  try {
    sidecar(root, "workspace", ".");
    gitInit(path.join(root, "alpha", "beta", "gamma"));
    const m = run(root);
    const hit = m.gaps.find((g) => g.kind === "would-be-missed" && g.project === "alpha/beta/gamma");
    assert.ok(hit, `depth-3 repo not reported; gaps: ${JSON.stringify(m.gaps.map((g) => [g.kind, g.project]))}`);
  } finally { cleanup(root); }
});
