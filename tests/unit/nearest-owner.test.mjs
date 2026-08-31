/**
 * `nearestOwner` (lib/core/discovery.mjs) — the shared nearest-owner helper
 * `docs/ISSUES.md` §A4 asked for verbatim: "extract the nearest-owner
 * assignment into a shared helper (`lib/discovery.mjs` is the natural
 * home)". Three copies of this logic already existed (`cli.mjs`'s
 * `assignSidecarsToWorkspaces`, `commands/status.mjs`'s `nestedUnderOf`,
 * `lib/core/config.mjs`'s `currentWorkspace`) and a FOURTH, wrong, one was
 * found in the wild while scoping this work: `groupForBrief`'s `workspaceOf`
 * used `String(f).split("/")[0]` — a bare string-prefix split that would
 * attribute `/hub/Keerti/Keerti-portfolio/x.md` to `Keerti`, silently
 * dropping the nested `Keerti-portfolio` workspace. That is the exact bug
 * this test suite exists to keep from recurring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { nearestOwner } from "../../lib/core/discovery.mjs";

// ---------------------------------------------------------------------------
// 1. Nested workspaces: the deepest containing root wins, not the hub. This
//    is F7's bug made concrete — String(f).split("/")[0] would return
//    "Keerti", not the portfolio.
// ---------------------------------------------------------------------------

test("nearestOwner: a path under nested workspaces is owned by the deepest one, not the hub", () => {
  const hub = { root: "/hub" };
  const keerti = { root: "/hub/Keerti" };
  const portfolio = { root: "/hub/Keerti/Keerti-portfolio" };

  const owner = nearestOwner("/hub/Keerti/Keerti-portfolio/x.md", [hub, keerti, portfolio]);

  assert.equal(owner.root, portfolio.root, "must resolve to the portfolio, not the hub or the intermediate workspace");
});

// ---------------------------------------------------------------------------
// 2. A path exactly equal to a workspace root is owned by that workspace.
// ---------------------------------------------------------------------------

test("nearestOwner: a path exactly equal to a workspace root returns that workspace", () => {
  const ws = { root: "/hub/Keerti" };
  const owner = nearestOwner("/hub/Keerti", [ws]);
  assert.equal(owner.root, ws.root);
});

// ---------------------------------------------------------------------------
// 3. A path outside every root returns null, never throws.
// ---------------------------------------------------------------------------

test("nearestOwner: a path outside every workspace root returns null", () => {
  const ws = { root: "/hub/Keerti" };
  const owner = nearestOwner("/hub/Elsewhere/x.md", [ws]);
  assert.equal(owner, null);
});

// ---------------------------------------------------------------------------
// 4. Empty / undefined workspaces array returns null, never throws.
// ---------------------------------------------------------------------------

test("nearestOwner: an empty workspaces array returns null", () => {
  assert.equal(nearestOwner("/hub/Keerti/x.md", []), null);
});

test("nearestOwner: an absent path or absent workspaces list never throws", () => {
  assert.equal(nearestOwner("", [{ root: "/hub" }]), null);
  assert.equal(nearestOwner("/hub/x.md", undefined), null);
});

// ---------------------------------------------------------------------------
// 5. Prefix-string-but-not-path-component must NOT match. This is the exact
//    hazard path.sep containment prevents: "/hub/Keerti" is a STRING prefix
//    of "/hub/Keerti-other/x.md" but not a path-component ancestor of it.
// ---------------------------------------------------------------------------

test("nearestOwner: a string-prefix that is not a path-component match is not an owner", () => {
  const keerti = { root: "/hub/Keerti" };
  const owner = nearestOwner("/hub/Keerti-other/x.md", [keerti]);
  assert.equal(owner, null, "'/hub/Keerti' must not be treated as an ancestor of '/hub/Keerti-other'");
});

// ---------------------------------------------------------------------------
// 6. Coverage invariant: given N paths and a workspace set, every path maps
//    to exactly one workspace (or null when genuinely outside all of them),
//    and the union of assigned groups has size == (number of paths that
//    matched), with no path counted in two groups. Mirrors the shape of
//    tests/unit/sidecar-dedup.test.mjs's coverage-invariant test.
// ---------------------------------------------------------------------------

test("nearestOwner: coverage invariant — every path is assigned to exactly one workspace, none double-counted", () => {
  const hub = { root: "/hub" };
  const keerti = { root: "/hub/Keerti" };
  const portfolio = { root: "/hub/Keerti/Keerti-portfolio" };
  const vipin = { root: "/hub/Vipin Kaushik" };
  const workspaces = [hub, keerti, portfolio, vipin];

  const paths = [
    "/hub/CLAUDE.md",
    "/hub/Keerti/CLAUDE.md",
    "/hub/Keerti/Keerti-portfolio/x.md",
    "/hub/Keerti/Keerti-portfolio/deeper/y.md",
    "/hub/Vipin Kaushik/z.md",
    "/other-tree/w.md", // outside every workspace root entirely — must map to null, not swallowed
  ];

  const assignedByWsRoot = new Map(workspaces.map((ws) => [ws.root, []]));
  let nullCount = 0;

  for (const p of paths) {
    const owner = nearestOwner(p, workspaces);
    if (owner === null) {
      nullCount += 1;
      continue;
    }
    assignedByWsRoot.get(owner.root).push(p);
  }

  // Nothing dropped: every path is accounted for exactly once, either in a
  // workspace's group or in the null bucket.
  const union = new Set();
  for (const list of assignedByWsRoot.values()) {
    for (const p of list) {
      assert.equal(union.has(p), false, `${p} assigned to more than one workspace`);
      union.add(p);
    }
  }
  assert.equal(union.size + nullCount, paths.length, "every path must be assigned exactly once, across workspaces and the null bucket combined");

  // Deepest-wins, spelled out per path.
  assert.deepEqual(assignedByWsRoot.get(portfolio.root), [
    "/hub/Keerti/Keerti-portfolio/x.md",
    "/hub/Keerti/Keerti-portfolio/deeper/y.md",
  ]);
  assert.deepEqual(assignedByWsRoot.get(keerti.root), ["/hub/Keerti/CLAUDE.md"]);
  assert.deepEqual(assignedByWsRoot.get(hub.root), ["/hub/CLAUDE.md"]);
  assert.deepEqual(assignedByWsRoot.get(vipin.root), ["/hub/Vipin Kaushik/z.md"]);
  assert.equal(nullCount, 1);
});

// ---------------------------------------------------------------------------
// 7. Realpath resolution: the same file reachable via a symlink and its real
//    path is still assigned to the workspace containing the REAL location —
//    same reasoning as assignSidecarsToWorkspaces's realpath keying.
// ---------------------------------------------------------------------------

test("nearestOwner: resolves through a symlink to the real workspace, falling back to the raw path only when realpath fails", async () => {
  const rawRoot = await mkdtemp(path.join(tmpdir(), "nearest-owner-realpath-"));
  // Resolve the tmp root itself first: on macOS, os.tmpdir() sits under a
  // symlink (/var -> /private/var), so a workspace root built from the raw
  // mkdtemp path and a file path resolved via realpathSync would live on two
  // different, non-comparable string bases even though they name the same
  // directory. A real WORKSPACES entry is built from a plain directory walk
  // (lib/core/discovery.mjs's `dir` var, never realpath'd) — this mirrors
  // that by giving the workspace root a resolved basis of its own, the same
  // basis `absPath` resolves onto, rather than testing an artifact of the
  // OS's tmp-dir symlinking.
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(rawRoot);
  try {
    const realDir = path.join(root, "real-workspace");
    await mkdir(realDir, { recursive: true });
    const realFile = path.join(realDir, "x.md");
    await writeFile(realFile, "content\n", "utf8");

    const { symlink } = await import("node:fs/promises");
    const linkDir = path.join(root, "link-to-workspace");
    await symlink(realDir, linkDir, "dir");
    const linkedFile = path.join(linkDir, "x.md");

    const ws = { root: realDir };
    const owner = nearestOwner(linkedFile, [ws]);
    assert.equal(owner.root, realDir, "must resolve the symlinked path to the real workspace root");

    // A path that does not exist at all must fall back to the raw string and
    // still resolve correctly by plain containment — never throw.
    const missing = path.join(realDir, "does-not-exist.md");
    const ownerForMissing = nearestOwner(missing, [ws]);
    assert.equal(ownerForMissing.root, realDir, "a nonexistent path must fall back to raw-path containment, not throw");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
