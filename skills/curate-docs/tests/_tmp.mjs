/**
 * Test helper: a temp directory to SCAN, with a private, empty parent.
 *
 * The link-graph resolver also tries the tree's parent (`externalBases = [path.dirname(root), ...]`), so a fixture
 * root made directly in the shared $TMPDIR resolves a bare citation against whatever any other process left there:
 * `tests/cascade.test.mjs` went red on 2026-10-19 with no code change because a stray `$TMPDIR/c.md` answered
 * `./c.md` (#115). One level under a directory only this call created, the parent is empty and ours.
 *
 * Use it for every directory that is scanned (a root handed to `buildLinkGraph`, `discover` for a graph, or the CLI).
 * A directory that is only a fake HOME, a config input, or a file bag is not scanned: mark it
 * `// not scanned: <reason>` (tests/tmp-fixtures.test.mjs derives every call site and asserts one or the other).
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** `<private temp dir>/root`, created. Its parent holds nothing but it, and nothing else knows the parent's name. */
export function privateRoot(prefix) {
  const d = path.join(mkdtempSync(path.join(tmpdir(), prefix)), "root");
  mkdirSync(d);
  return d;
}
