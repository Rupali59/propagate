/**
 * doctor reports each sidecar defect exactly once, not once per containing
 * workspace (docs/ISSUES.md A2 measurement: workspace roots nest — `GitHub`
 * ⊃ `PanditPawanKaushik` ⊃ `SSJK-mb` — and `findSidecars` recursively walks
 * a workspace's ENTIRE subtree with no awareness of nested workspace
 * boundaries, so the same `.propagates.yml` was found, and validated, by
 * every ancestor workspace independently).
 *
 * `assignSidecarsToWorkspaces` (cli.mjs) collapses that: each unique sidecar
 * (by realpath) is assigned to its nearest — deepest — owning workspace.
 * Unit-tested directly here (pure, given a synthetic sidecarsByWsRoot map),
 * plus one subprocess `doctor` run proving the report itself is deduped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assignSidecarsToWorkspaces } from "../../cli.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// 1. nearest-workspace assignment: a/, a/b/, a/b/c/ — a sidecar in a/b/c/ is
//    assigned to a/b/c/, not a/ or a/b/.
// ---------------------------------------------------------------------------

test("assignSidecarsToWorkspaces: sidecar in the deepest nested root is assigned there, not an ancestor", () => {
  const a = { root: "/a" };
  const ab = { root: "/a/b" };
  const abc = { root: "/a/b/c" };
  const sidecarPath = "/a/b/c/.propagates.yml";

  // All three ancestor walks find it (findSidecars has no workspace-boundary
  // awareness), exactly as the real bug does.
  const sidecarsByWsRoot = new Map([
    [a.root, [sidecarPath]],
    [ab.root, [sidecarPath]],
    [abc.root, [sidecarPath]],
  ]);

  const { assignedByWsRoot } = assignSidecarsToWorkspaces([a, ab, abc], sidecarsByWsRoot);

  assert.deepEqual(assignedByWsRoot.get(abc.root), [sidecarPath]);
  assert.deepEqual(assignedByWsRoot.get(ab.root), []);
  assert.deepEqual(assignedByWsRoot.get(a.root), []);
});

// ---------------------------------------------------------------------------
// 2. coverage invariant: union of all assigned sets == set of unique sidecars.
//    Nothing dropped while deduping.
// ---------------------------------------------------------------------------

test("assignSidecarsToWorkspaces: coverage invariant — union of assigned sets equals the unique sidecar set", () => {
  const a = { root: "/a" };
  const ab = { root: "/a/b" };
  const other = { root: "/other" };

  const sidecarInAb = "/a/b/.propagates.yml";
  const sidecarInA = "/a/x/.propagates.yml"; // only under a, not under a/b
  const sidecarInOther = "/other/.propagates.yml";

  const sidecarsByWsRoot = new Map([
    [a.root, [sidecarInAb, sidecarInA]], // a's walk finds both (b is nested under a)
    [ab.root, [sidecarInAb]],
    [other.root, [sidecarInOther]],
  ]);

  const { assignedByWsRoot, uniqueCount } = assignSidecarsToWorkspaces(
    [a, ab, other],
    sidecarsByWsRoot,
  );

  const uniqueSidecars = new Set([sidecarInAb, sidecarInA, sidecarInOther]);
  assert.equal(uniqueCount, uniqueSidecars.size);

  const union = new Set();
  for (const list of assignedByWsRoot.values()) {
    for (const p of list) {
      assert.equal(union.has(p), false, `${p} assigned to more than one workspace — duplicate, not deduped`);
      union.add(p);
    }
  }
  assert.deepEqual(union, uniqueSidecars, "every unique sidecar must appear exactly once across all assignments");
});

// ---------------------------------------------------------------------------
// 3. realpath keying: the same file reachable via two paths (a symlink) is
//    counted once.
// ---------------------------------------------------------------------------

test("assignSidecarsToWorkspaces: a sidecar reachable via a symlink and its real path counts once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sidecar-dedup-realpath-"));
  try {
    const realDir = path.join(root, "real");
    await mkdir(realDir, { recursive: true });
    const realSidecar = path.join(realDir, ".propagates.yml");
    await writeFile(realSidecar, "sources: {}\n", "utf8");

    const linkDir = path.join(root, "link");
    await symlink(realDir, linkDir, "dir");
    const linkedSidecar = path.join(linkDir, ".propagates.yml");

    const ws = { root };
    // Same underlying file, reached via two different raw path strings —
    // exactly what a worktree checkout or symlinked workspace produces.
    const sidecarsByWsRoot = new Map([[ws.root, [realSidecar, linkedSidecar]]]);

    const { assignedByWsRoot, uniqueCount } = assignSidecarsToWorkspaces([ws], sidecarsByWsRoot);

    assert.equal(uniqueCount, 1, "same file via two paths must count once");
    assert.equal(assignedByWsRoot.get(ws.root).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// 4. a sidecar directly at a workspace root is assigned to that workspace.
// ---------------------------------------------------------------------------

test("assignSidecarsToWorkspaces: a sidecar at a workspace's own root is assigned to that workspace", () => {
  const parent = { root: "/p" };
  const child = { root: "/p/child" };
  const rootSidecar = "/p/.propagates.yml"; // lives at parent's root, not under child

  const sidecarsByWsRoot = new Map([
    [parent.root, [rootSidecar]],
    [child.root, []], // child's walk never sees it — it's not under child
  ]);

  const { assignedByWsRoot } = assignSidecarsToWorkspaces([parent, child], sidecarsByWsRoot);

  assert.deepEqual(assignedByWsRoot.get(parent.root), [rootSidecar]);
  assert.deepEqual(assignedByWsRoot.get(child.root), []);
});

// ---------------------------------------------------------------------------
// 5. doctor reports a given sidecar's defect exactly once when nested
//    workspaces contain it (end-to-end, via subprocess).
// ---------------------------------------------------------------------------

/** Build a workspace root containing a nested child workspace with a broken sidecar. */
async function makeNestedWorkspaces() {
  const root = await mkdtemp(path.join(tmpdir(), "sidecar-dedup-nested-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const rootDocs = path.join(root, "docs");
  await mkdir(rootDocs, { recursive: true });
  await writeFile(path.join(rootDocs, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const childRoot = path.join(root, "child");
  await mkdir(childRoot, { recursive: true });
  await writeFile(path.join(childRoot, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const childDocs = path.join(childRoot, "docs");
  await mkdir(childDocs, { recursive: true });
  await writeFile(path.join(childDocs, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  // A broken sidecar (unresolvable prose downstream) nested one level under
  // the child workspace — reachable by BOTH the root's and the child's
  // recursive findSidecars walk.
  const subDir = path.join(childRoot, "sub");
  await mkdir(subDir, { recursive: true });
  const brokenSidecar = path.join(subDir, ".propagates.yml");
  await writeFile(
    brokenSidecar,
    [
      "sources:",
      "  a.md:",
      "    propagates_to:",
      '      - path: "does/not/exist.md"',
      '        why: "because reasons"',
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, childRoot, brokenSidecar };
}

function runDoctor(root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    // G10: one override moves all the paths together — doctor now writes
    // metrics.jsonl every run, so PROPAGATE_STATE_DIR must move with
    // PROPAGATE_SEARCH_ROOTS or this pollutes the real production file.
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
  });
}

test("doctor reports a nested sidecar's defect exactly once, not once per containing workspace", async () => {
  const { root, brokenSidecar } = await makeNestedWorkspaces();
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;

    // "prose downstream missing" is the warn produced for the broken entry —
    // it must appear exactly once across the whole doctor run, not once for
    // the hub workspace AND once for the child workspace.
    const occurrences = (out.match(/prose downstream missing/g) || []).length;
    assert.equal(
      occurrences,
      1,
      `expected the sidecar's defect to be reported exactly once, got ${occurrences}:\n${out}`,
    );

    // Likewise the sidecar's own load-check line ("✓  <rel>") must appear
    // exactly once, under whichever workspace ends up owning it.
    const relFromRoot = path.relative(root, brokenSidecar);
    const relEscaped = relFromRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const loadLineOccurrences = (out.match(new RegExp(`✓\\s+${relEscaped}\\b`, "g")) || []).length;
    assert.ok(
      loadLineOccurrences <= 1,
      `sidecar load line must not repeat per ancestor workspace, got ${loadLineOccurrences}:\n${out}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ---------------------------------------------------------------------------
// 6. a defect in a non-nested workspace still reports normally (no over-dedup).
// ---------------------------------------------------------------------------

test("doctor still reports a defect normally in a workspace with no nesting involved (no over-dedup)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sidecar-dedup-flat-"));
  try {
    await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

    const subDir = path.join(root, "sub");
    await mkdir(subDir, { recursive: true });
    const sidecarPath = path.join(subDir, ".propagates.yml");
    await writeFile(
      sidecarPath,
      [
        "sources:",
        "  a.md:",
        "    propagates_to:",
        '      - path: "does/not/exist.md"',
        '        why: "because reasons"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.match(out, /prose downstream missing/, "the lone workspace must still report the defect");
    const occurrences = (out.match(/prose downstream missing/g) || []).length;
    assert.equal(occurrences, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
