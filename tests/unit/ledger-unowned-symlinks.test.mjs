/**
 * `findUnownedLedgers` compared owned vs. found paths with `path.resolve`,
 * which is lexical — it does not resolve symlinks. A ledger reachable by two
 * names (its real path, and a symlinked path into the same file) is one
 * inode, but two distinct strings under `path.resolve`: the walk finds it
 * under the symlinked name, that name is not literally in the owned set
 * (which was pinned via the real path, or vice versa), and it is reported as
 * an orphan even though it is fully owned. `docs/GOTCHAS.md` G54/G55 and
 * `~/.claude/plans/status-temporal-plum.md` §5 — this is already latent here:
 * `propagate-skill` and `rules` are both symlinks into `~/.claude/`.
 *
 * Fix: compare by `realpathSync`-equivalent (async `realpath`) on both sides,
 * falling back to the lexical `path.resolve` value when `realpath` throws (a
 * broken symlink or a race must not crash the check — see the "reporting
 * must never break doctor" comment at the call site in cli.mjs).
 *
 * The returned paths are unchanged in shape — still the lexical, discovered
 * path a human would act on. Only the *comparison* used to decide
 * owned-vs-not now goes through realpath.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findUnownedLedgers } from "../../lib/edges/ledger.mjs";

async function makeTmp() {
  return mkdtemp(path.join(tmpdir(), "unowned-ledger-symlink-"));
}

function driftLine(id) {
  return (
    JSON.stringify({
      type: "drift",
      id,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      source: `${id}.md`,
      change: `drift on ${id}`,
      status: "open",
    }) + "\n"
  );
}

test("a ledger reachable both directly and through a symlinked parent directory is NOT reported unowned", async () => {
  const root = await makeTmp();
  try {
    // The real ledger lives under `real/docs/PROPAGATION_LEDGER.jsonl`.
    const realDocsDir = path.join(root, "real", "docs");
    await mkdir(realDocsDir, { recursive: true });
    const realJsonl = path.join(realDocsDir, "PROPAGATION_LEDGER.jsonl");
    await writeFile(realJsonl, driftLine("001"), "utf8");

    // A search root reaches it via a symlinked parent directory pointing at
    // `real/` — mirrors `propagate-skill` / `rules` being symlinks into `~/.claude/`.
    const searchRoot = path.join(root, "search-root");
    await mkdir(searchRoot, { recursive: true });
    const symlinkedDir = path.join(searchRoot, "linked");
    await symlink(path.join(root, "real"), symlinkedDir, "dir");

    // "owned" is pinned via the SYMLINKED path (as discovery would pin it),
    // but the walk finds the ledger by descending into `real/` directly too
    // (a second, non-symlinked search root reaching the same real directory).
    const ownedViaSymlink = path.join(symlinkedDir, "docs", "PROPAGATION_LEDGER.jsonl");

    const unowned = await findUnownedLedgers([root], [ownedViaSymlink]);

    assert.deepEqual(
      unowned,
      [],
      "the same physical ledger reached by two names must not be reported as an orphan",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("negative control: a genuinely unowned ledger IS still reported", async () => {
  const root = await makeTmp();
  try {
    const ownedDocsDir = path.join(root, "owned", "docs");
    await mkdir(ownedDocsDir, { recursive: true });
    const ownedJsonl = path.join(ownedDocsDir, "PROPAGATION_LEDGER.jsonl");
    await writeFile(ownedJsonl, driftLine("001"), "utf8");

    const orphanDocsDir = path.join(root, "orphan", "docs");
    await mkdir(orphanDocsDir, { recursive: true });
    const orphanJsonl = path.join(orphanDocsDir, "PROPAGATION_LEDGER.jsonl");
    await writeFile(orphanJsonl, driftLine("999"), "utf8");

    const unowned = await findUnownedLedgers([root], [ownedJsonl]);

    assert.deepEqual(
      unowned,
      [path.resolve(orphanJsonl)],
      "a real orphan — no symlink involved, no relation to the owned ledger — must still be detected",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a broken symlink among owned paths does not throw — the function still returns", async () => {
  const root = await makeTmp();
  try {
    const docsDir = path.join(root, "proj", "docs");
    await mkdir(docsDir, { recursive: true });
    const realJsonl = path.join(docsDir, "PROPAGATION_LEDGER.jsonl");
    await writeFile(realJsonl, driftLine("001"), "utf8");

    // An owned path that points at a symlink whose target does not exist.
    const brokenLinkPath = path.join(root, "broken-owned-ledger.jsonl");
    await symlink(path.join(root, "does-not-exist.jsonl"), brokenLinkPath, "file");

    const orphanDocsDir = path.join(root, "orphan", "docs");
    await mkdir(orphanDocsDir, { recursive: true });
    const orphanJsonl = path.join(orphanDocsDir, "PROPAGATION_LEDGER.jsonl");
    await writeFile(orphanJsonl, driftLine("999"), "utf8");

    let unowned;
    await assert.doesNotReject(async () => {
      unowned = await findUnownedLedgers([root], [realJsonl, brokenLinkPath]);
    }, "a broken symlink in the owned set must not throw");

    assert.deepEqual(
      unowned,
      [path.resolve(orphanJsonl)],
      "the real orphan is still found even though one owned path was a broken symlink",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// Note: a ledger-named entry that is ITSELF a symlink is never picked up by
// the walk in the first place — `readdir(..., { withFileTypes: true })`
// Dirents report `isFile() === false` for a symlink (confirmed: a plain
// `fs.symlinkSync` target shows `isFile: false, isSymlink: true`), so the
// `e.isFile() && isLedger(e.name)` guard already excludes it before realpath
// is ever consulted. The only place a broken symlink can reach `realpath` is
// via the OWNED side (a caller-supplied path), covered above.
