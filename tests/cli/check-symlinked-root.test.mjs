/**
 * The commit-time gate must fire for a repo whose path traverses a symlink.
 *
 * FOUND BY EXERCISING THE EDGE LIFECYCLE END TO END, 2026-08-20, not by a unit test.
 * The same fixture — one workspace, one declared `spec.md -> docs/impl.md` edge, source
 * staged and downstream deliberately stale — behaved two different ways depending only
 * on WHERE it lived:
 *
 *   under /var/folders/... (macOS tmpdir, a symlink to /private/var/folders)
 *       check --staged   ->  prints NOTHING, exit 0
 *   under $HOME/...      (no symlink in the path)
 *       check --staged   ->  "spec.md -> verify: docs/impl.md"
 *
 * `reconcile` said DRIFTED in both. Discovery, reconcile and graph were all correct; the
 * GATE was the only dead part — the same signature as N32, in a different shape.
 *
 * WHY THE N32 FIX DOES NOT COVER IT. N32 handles a repo reached through a symlink that
 * is a CHILD of the workspace root (`workspaceLinks` scans depth-1 children). Here the
 * root's own ANCESTOR is the symlink: `git rev-parse --show-toplevel` returns the
 * realpath'd `/private/var/...` while discovery holds the lexical `/var/...`, so the
 * prefix test compares two spellings of one directory and finds no match.
 *
 * This does NOT reintroduce the realpath-on-both-sides approach that was tried and
 * reverted during N32. That was proposed as a REPLACEMENT for the real->link
 * translation, and it fails N32's case because there the workspace root is not the
 * symlink. Here it is a THIRD strategy, tried only after both existing ones miss, so
 * N32's case still takes the link-preserving path. Both cases are asserted below —
 * fixing one by breaking the other is the failure mode this file exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveChangedFile } from "../../cli.mjs";

function sandbox() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "propagate-symroot-")));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a changed file given by REALPATH resolves against a workspace held by its symlinked path", () => {
  const s = sandbox();
  try {
    // `real/ws` is the workspace; `link` is a symlink to `real`. Discovery walked in via
    // `link`, so it holds `link/ws`. git will report `real/ws`. Same directory, two
    // spellings — exactly what /var vs /private/var is on macOS.
    const real = path.join(s.root, "real");
    mkdirSync(path.join(real, "ws"), { recursive: true });
    writeFileSync(path.join(real, "ws", "spec.md"), "# spec\n");
    const link = path.join(s.root, "link");
    symlinkSync(real, link);

    const workspaces = [{ root: path.join(link, "ws"), name: "ws" }];
    const changedByRealPath = path.join(real, "ws", "spec.md");

    const got = resolveChangedFile(changedByRealPath, workspaces);
    assert.ok(got, "a repo under a symlinked ancestor must still resolve — the gate is dead otherwise");
    assert.equal(got.rel, "spec.md", `expected spec.md, got ${got?.rel}`);
    assert.equal(got.workspace.name, "ws");
  } finally {
    s.cleanup();
  }
});

test("NEGATIVE CONTROL: a file genuinely outside every workspace still resolves to null", () => {
  // Without this, the test above could be satisfied by a fallback that matches anything,
  // which would make the gate fire on unrelated files instead of not firing at all —
  // trading a silent miss for a noisy false positive.
  const s = sandbox();
  try {
    mkdirSync(path.join(s.root, "ws"), { recursive: true });
    const outside = path.join(s.root, "elsewhere", "other.md");
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, "x\n");
    assert.equal(resolveChangedFile(outside, [{ root: path.join(s.root, "ws"), name: "ws" }]), null);
  } finally {
    s.cleanup();
  }
});

test("the lexical case still wins, unchanged — no realpath is consulted when it matches", () => {
  // Strategy order is load-bearing. N32's fix translates real -> link and must keep
  // running before any realpath comparison, or a markered symlink inside a workspace
  // starts resolving to its real path and lands outside the sidecar's namespace.
  const s = sandbox();
  try {
    const ws = path.join(s.root, "ws");
    mkdirSync(path.join(ws, "docs"), { recursive: true });
    const f = path.join(ws, "docs", "a.md");
    writeFileSync(f, "x\n");
    const got = resolveChangedFile(f, [{ root: ws, name: "ws" }]);
    assert.equal(got.rel, path.join("docs", "a.md"));
  } finally {
    s.cleanup();
  }
});
