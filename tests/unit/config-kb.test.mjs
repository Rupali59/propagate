/**
 * config-kb.test.mjs — the knowledge-base config keys read before the standards keys (#322).
 *
 * INTEGRATIONS is computed at import, so each case runs a child `node -e` with its own
 * PROPAGATE_STATE_DIR (the config.yml) and PROPAGATE_HUB_ROOT (the default paths).
 * An install that wrote `standardsFile:` into config.yml must keep resolving it after the
 * rename, and LEGACY_CONFIG_USED must name the old key so doctor can say so.
 */
// @size medium — starts processes (CLI or script); run when affected

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG_MJS = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "core", "config.mjs"),
).href;

/** Build a sandbox: hub with the given files, config.yml with the given integrations. */
function resolve({ hubFiles = [], integrations = null, env = {} }) {
  const root = mkdtempSync(path.join(tmpdir(), "config-kb-"));
  try {
    const hub = path.join(root, "hub");
    const state = path.join(root, "state");
    mkdirSync(hub, { recursive: true });
    mkdirSync(state, { recursive: true });
    for (const f of hubFiles) {
      mkdirSync(path.dirname(path.join(hub, f)), { recursive: true });
      writeFileSync(path.join(hub, f), "");
    }
    if (integrations) {
      const lines = ["integrations:", ...Object.entries(integrations).map(([k, v]) => `  ${k}: ${v.replace("$ROOT", root)}`)];
      writeFileSync(path.join(state, "config.yml"), lines.join("\n") + "\n");
    }
    const code = `import(${JSON.stringify(CONFIG_MJS)}).then(m => console.log(JSON.stringify({
      file: m.INTEGRATIONS.kbStandardsFile, dir: m.INTEGRATIONS.kbStandardsDir,
      refs: m.INTEGRATIONS.kbReferencesFile, legacy: m.LEGACY_CONFIG_USED,
      aliasFile: m.INTEGRATIONS.standardsFile, aliasDir: m.INTEGRATIONS.standardsDir })))`;
    const r = spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, PROPAGATE_STATE_DIR: state, PROPAGATE_HUB_ROOT: hub, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout.trim().split("\n").pop()), root, hub };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("old key still resolves, and is recorded as legacy", () => {
  const { out, root } = resolve({
    integrations: { standardsFile: "$ROOT/x/standards.yml" },
    hubFiles: [],
  });
  // The file need not exist for an explicit value: pick() never checked, only defaults are gated.
  assert.equal(out.file, path.join(root, "x", "standards.yml"));
  assert.ok(out.legacy.includes("standardsFile"));
  assert.equal(out.aliasFile, out.file, "standardsFile stays an alias for one release");
});

test("old env variable still resolves, and is recorded as legacy", () => {
  const { out } = resolve({ env: { PROPAGATE_STANDARDS_DIR: "/tmp/old-dir" } });
  assert.equal(out.dir, "/tmp/old-dir");
  assert.deepEqual(out.legacy, ["standardsDir"]);
});

test("new key wins over the old key, and nothing is recorded as legacy", () => {
  const { out, root } = resolve({
    integrations: { standardsFile: "$ROOT/old.yml", kbStandardsFile: "$ROOT/new.yml" },
  });
  assert.equal(out.file, path.join(root, "new.yml"));
  assert.deepEqual(out.legacy, []);
});

test("new env variable wins over the old one", () => {
  const { out } = resolve({
    env: { PROPAGATE_KB_STANDARDS_FILE: "/tmp/new.yml", PROPAGATE_STANDARDS_FILE: "/tmp/old.yml" },
  });
  assert.equal(out.file, "/tmp/new.yml");
  assert.deepEqual(out.legacy, []);
});

test("default falls back to the old path, and prefers the new one when both exist", () => {
  const onlyOld = resolve({ hubFiles: ["scripts/execution/standards.yml"] });
  assert.equal(onlyOld.out.file, path.join(onlyOld.hub, "scripts/execution/standards.yml"));
  assert.deepEqual(onlyOld.out.legacy, [], "a default path is not a legacy config key");

  const both = resolve({
    hubFiles: ["scripts/execution/standards.yml", "scripts/execution/kb-standards.yml"],
  });
  assert.equal(both.out.file, path.join(both.hub, "scripts/execution/kb-standards.yml"));
});

test("directories and the references file resolve the same way", () => {
  const a = resolve({ hubFiles: ["standards/.keep", "scripts/execution/kb-references.yml"] });
  assert.equal(a.out.dir, path.join(a.hub, "standards"));
  assert.equal(a.out.refs, path.join(a.hub, "scripts/execution/kb-references.yml"));
  const b = resolve({ hubFiles: ["standards/.keep", "kb/standards/.keep"] });
  assert.equal(b.out.dir, path.join(b.hub, "kb/standards"));
});

test("unconfigured is null, never zero", () => {
  const { out } = resolve({});
  assert.equal(out.file, null);
  assert.equal(out.dir, null);
  assert.equal(out.refs, null);
  assert.deepEqual(out.legacy, []);
});
