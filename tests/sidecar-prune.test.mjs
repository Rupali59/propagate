/**
 * N9 fix (docs/ISSUES.md N9, the live SSJK-mb outage 2026-08-13): a schema
 * violation confined to one downstream entry
 * (`/sources/<key>/propagates_to/<i>/...`) must prune that entry and report
 * it — never fail the whole sidecar. Structural damage (malformed YAML,
 * `sources` not an object, a shape violation outside a downstream entry)
 * stays fatal, because it cannot be partially recovered.
 *
 * See docs/DECISIONS.md 2026-08-13 "a schema constraint must not be able to
 * disable a file that previously worked" for the rule this restores.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSidecar, SidecarError } from "../lib/frontmatter.mjs";

const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));

async function withTempSidecar(yamlText, fn) {
  const root = await mkdtemp(path.join(tmpdir(), "prune-"));
  const sidecarPath = path.join(root, ".propagates.yml");
  await writeFile(sidecarPath, yamlText, "utf8");
  try {
    return await fn(sidecarPath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. one bad downstream path loads, other entries survive, one problem
// ---------------------------------------------------------------------------

test("one bad downstream path: loads, keeps the other entries, reports one problem", async () => {
  await withTempSidecar(
    [
      "sources:",
      "  a.md:",
      "    propagates_to:",
      '      - path: "good/one.md"',
      '        why: "because reasons"',
      '      - path: "bad/two/"',
      '        why: "trailing slash, invalid"',
      '      - path: "good/three.md"',
      '        why: "also fine"',
      "",
    ].join("\n"),
    async (sidecarPath) => {
      const result = await loadSidecar(sidecarPath);
      const paths = result.sources["a.md"].propagates_to.map((e) => e.path);
      assert.deepEqual(paths, ["good/one.md", "good/three.md"]);
      assert.equal(result.problems.length, 1);
      assert.equal(result.problems[0].sourceKey, "a.md");
      assert.equal(result.problems[0].index, 1);
      assert.equal(result.problems[0].path, "bad/two/");
    },
  );
});

// ---------------------------------------------------------------------------
// 2. the pruned entry is genuinely absent, not just flagged
// ---------------------------------------------------------------------------

test("the pruned entry is genuinely absent from sources, not just flagged", async () => {
  await withTempSidecar(
    [
      "sources:",
      "  a.md:",
      "    propagates_to:",
      '      - path: "bad/"',
      '        why: "trailing slash"',
      "",
    ].join("\n"),
    async (sidecarPath) => {
      const result = await loadSidecar(sidecarPath);
      assert.equal(result.sources["a.md"].propagates_to.length, 0);
      assert.equal(result.problems.length, 1);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. malformed YAML still throws (structural, unrecoverable)
// ---------------------------------------------------------------------------

test("malformed YAML still throws SidecarError", async () => {
  await withTempSidecar("sources:\n  a.md: [unclosed\n", async (sidecarPath) => {
    await assert.rejects(() => loadSidecar(sidecarPath), SidecarError);
  });
});

// ---------------------------------------------------------------------------
// 4. top-level shape violation still throws
// ---------------------------------------------------------------------------

test("top-level shape violation (sources not an object) still throws", async () => {
  await withTempSidecar('sources: "a string"\n', async (sidecarPath) => {
    await assert.rejects(() => loadSidecar(sidecarPath), SidecarError);
  });
});

test("a source missing propagates_to entirely still throws (fatal, not prunable)", async () => {
  await withTempSidecar("sources:\n  a.md:\n    concepts: {}\n", async (sidecarPath) => {
    await assert.rejects(() => loadSidecar(sidecarPath), SidecarError);
  });
});

// ---------------------------------------------------------------------------
// 5. pruning that does NOT make the object valid still throws
// ---------------------------------------------------------------------------

test("when pruning does not yield a valid object, still throws — never returns unproven output", async () => {
  // additionalProperties:false on the sidecar root — pruning a propagates_to
  // entry can never fix an unrelated top-level extra key, so this must
  // remain fatal even though it ALSO happens to contain a prunable entry.
  await withTempSidecar(
    [
      "sources:",
      "  a.md:",
      "    propagates_to:",
      '      - path: "bad/"',
      '        why: "trailing slash"',
      "not_a_real_top_level_key: true",
      "",
    ].join("\n"),
    async (sidecarPath) => {
      await assert.rejects(() => loadSidecar(sidecarPath), SidecarError);
    },
  );
});

// ---------------------------------------------------------------------------
// 6. a fully valid sidecar is untouched: problems: [], sources unchanged
// ---------------------------------------------------------------------------

test("a fully valid sidecar returns problems: [] and unchanged sources", async () => {
  await withTempSidecar(
    [
      "sources:",
      "  a.md:",
      "    propagates_to:",
      '      - path: "good/one.md"',
      '        why: "because reasons"',
      "",
    ].join("\n"),
    async (sidecarPath) => {
      const result = await loadSidecar(sidecarPath);
      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.sources, {
        "a.md": { propagates_to: [{ path: "good/one.md", why: "because reasons" }] },
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 7. doctor FAILS and names the sidecar + source key + path
// ---------------------------------------------------------------------------

async function makeWorkspaceWithBrokenSidecar() {
  const root = await mkdtemp(path.join(tmpdir(), "prune-ws-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const subDir = path.join(root, "sub");
  await mkdir(subDir, { recursive: true });
  await writeFile(path.join(subDir, "good.md"), "# ok\n", "utf8");
  const sidecarPath = path.join(subDir, ".propagates.yml");
  await writeFile(
    sidecarPath,
    [
      "sources:",
      "  a.md:",
      "    propagates_to:",
      '      - path: "good.md"',
      '        why: "because reasons"',
      '      - path: "bad/"',
      '        why: "trailing slash, invalid"',
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, sidecarPath };
}

function runDoctor(root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root },
  });
}

test("doctor FAILS and names the sidecar, source key, and offending path for a pruned entry", async () => {
  const { root, sidecarPath } = await makeWorkspaceWithBrokenSidecar();
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, "a pruned entry must still fail doctor");
    const relSidecar = path.relative(root, sidecarPath);
    assert.match(
      out,
      new RegExp(relSidecar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "output names the offending sidecar",
    );
    assert.match(out, /a\.md/, "output names the source key");
    assert.match(out, /bad\//, "output names the offending path");
    // And the file as a whole still loaded — the other, valid entry is not
    // itself reported as a failure by the sidecar-load check.
    assert.match(out, new RegExp(`✓.*${relSidecar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
