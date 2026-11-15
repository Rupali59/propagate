/**
 * manifest sees Dart: a root pubspec.lock is a unit, and the members of a pub `workspace:` are units.
 * Fixtures only, with invented names; the real hub is never read.
 *
 * Run: `PROPAGATE_STATE_DIR="$(mktemp -d)" node --test tests/unit/manifest-dart.test.mjs` (G56).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { workspaceManifest } from "../../lib/report/manifest.mjs";

const EMPTY = { integrations: { portsFile: null, deployFile: null, mongoFile: null, accessFile: null }, home: "/nonexistent-home" };

function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** One workspace `Ws` with one project `proj`; `files` maps a path under proj to its text. */
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "manifest-dart-"));
  const ws = path.join(root, "Ws");
  put(path.join(ws, ".propagates.yml"), "workspace: true\n");
  put(
    path.join(ws, "propagation/state/proj/.sidecar.yml"),
    "schema_version: 1\nproject: proj\nrepo_root: proj\nremote: https://x/proj.git\n",
  );
  for (const [rel, text] of Object.entries(files)) put(path.join(ws, "proj", rel), text);
  return { ws, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const projOf = (ws) => workspaceManifest(ws, EMPTY).projects.find((p) => p.project === "proj");

test("a pub workspace root gives the root plus each member as dart units", () => {
  const f = fixture({
    "pubspec.lock": "",
    "pubspec.yaml": "name: root_app\nworkspace:\n  - apps/app\n  - packages/core\n",
    "apps/app/pubspec.yaml": "name: app\nresolution: workspace\n",
    "packages/core/pubspec.yaml": "name: core\nresolution: workspace\n",
  });
  try {
    const dart = projOf(f.ws).units.filter((u) => u.toolchain === "dart");
    assert.deepEqual(dart.map((u) => u.rel).sort(), ["proj", "proj/apps/app", "proj/packages/core"]);
    assert.equal(dart.find((u) => u.rel === "proj").toolchainEvidence, "pubspec.lock");
    assert.equal(dart.find((u) => u.rel === "proj/apps/app").toolchainEvidence, "pubspec.yaml workspace: proj");
  } finally {
    f.cleanup();
  }
});

test("a member listed but absent is reported missing with its reason, not dropped", () => {
  const f = fixture({
    "pubspec.lock": "",
    "pubspec.yaml": "name: root_app\nworkspace:\n  - apps/app\n  - packages/ghost\n",
    "apps/app/pubspec.yaml": "name: app\n",
  });
  try {
    const p = projOf(f.ws);
    assert.deepEqual(p.units.filter((u) => u.toolchain === "dart").map((u) => u.rel).sort(), ["proj", "proj/apps/app"]);
    assert.deepEqual(p.unresolved, [{ rel: "proj/packages/ghost", reason: "workspace member not on disk" }]);
  } finally {
    f.cleanup();
  }
});

test("a lone pubspec.lock with no workspace: gives exactly one dart unit", () => {
  const f = fixture({ "pubspec.lock": "", "pubspec.yaml": "name: solo\n" });
  try {
    const p = projOf(f.ws);
    assert.equal(p.units.filter((u) => u.toolchain === "dart").length, 1);
    assert.deepEqual(p.unresolved, []);
  } finally {
    f.cleanup();
  }
});

test("regression: an npm project still gives its npm unit", () => {
  const f = fixture({ "package-lock.json": "{}", "package.json": "{}" });
  try {
    const units = projOf(f.ws).units;
    assert.deepEqual(units.map((u) => [u.rel, u.toolchain]), [["proj", "npm"]]);
  } finally {
    f.cleanup();
  }
});

test("a member that is absolute or escapes the project root is unresolved, never walked", () => {
  const f = fixture({
    "pubspec.lock": "",
    "pubspec.yaml": "name: r\nworkspace:\n  - ../outside/x\n  - /tmp\n  - apps/ok\n",
    "apps/ok/pubspec.yaml": "name: ok\n",
  });
  try {
    put(path.join(f.ws, "outside/x/pubspec.yaml"), "name: x\n");
    const p = projOf(f.ws);
    assert.deepEqual(p.units.map((u) => u.rel).sort(), ["proj", "proj/apps/ok"]);
    assert.deepEqual(p.unresolved, [
      { rel: "../outside/x", reason: "workspace member outside project root" },
      { rel: "/tmp", reason: "workspace member path must be relative" },
    ]);
  } finally {
    f.cleanup();
  }
});

test("a workspace: that is not a list, or a pubspec.yaml that does not parse, is unresolved with the detail", () => {
  const a = fixture({ "pubspec.lock": "", "pubspec.yaml": "name: r\nworkspace: apps/app\n" });
  const b = fixture({ "pubspec.lock": "", "pubspec.yaml": "name: [unclosed\nworkspace: {\n" });
  try {
    assert.deepEqual(projOf(a.ws).unresolved, [{ rel: "proj/pubspec.yaml", reason: "workspace: unreadable (not a list)" }]);
    const u = projOf(b.ws).unresolved;
    assert.equal(u.length, 1);
    assert.equal(u[0].rel, "proj/pubspec.yaml");
    assert.match(u[0].reason, /^workspace: unreadable \(unparseable: /);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
