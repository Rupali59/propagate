/**
 * rollup-artifact-path.test.mjs — where `ECOSYSTEM.md` is written.
 *
 * ISSUES N101. `artifactPath()` returned `SEARCH_ROOTS[0]`, and `searchRoots`
 * is a DISCOVERY setting — the list of places to walk looking for
 * `.propagates.yml`. It is ordered for the walk, not to name the tree.
 *
 * On this machine `config.yml` lists `Rupali/Experiments` first, so the
 * artifact resolved to `Rupali/Experiments/ECOSYSTEM.md` — a file that has
 * never existed — while the real, tool-generated, four-times-cited
 * `ECOSYSTEM.md` sits at the hub root and had gone stale since 2026-09-01.
 * Nothing moved the file; a config key was added for an unrelated reason and
 * the derived path followed it. Exactly G24's shape: "removing a config key's
 * built-in default silently nulls every derived path", one door over.
 *
 * `ECOSYSTEM.md` is a rollup of the WHOLE tree. `hubRoot` is the declared name
 * for that tree. Writing a tree-wide artifact into one nested search root is
 * incoherent regardless of ordering, which is why this is a preference and not
 * a sort.
 *
 * There was no test for this function at all. That is why it could move in
 * silence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { artifactPath, ARTIFACT_NAME } from "../../commands/rollup.mjs";

const HUB = "/tmp/hub";
const NESTED = "/tmp/hub/Rupali/Experiments";

test("the artifact goes to the declared HUB, not to whichever search root sorts first", () => {
  const got = artifactPath({ hubRoot: HUB, roots: [NESTED, HUB] });
  assert.equal(got, path.join(HUB, ARTIFACT_NAME),
    "a tree-wide rollup must not be written inside one nested search root");
  assert.ok(!got.startsWith(NESTED), `wrote inside a nested root: ${got}`);
});

test("search-root ORDER cannot move the artifact", () => {
  // The negative control for the test above: if `roots` still decided, these
  // two would disagree.
  const a = artifactPath({ hubRoot: HUB, roots: [NESTED, HUB] });
  const b = artifactPath({ hubRoot: HUB, roots: [HUB, NESTED] });
  assert.equal(a, b, "reordering searchRoots changed where ECOSYSTEM.md is written");
});

test("with no hub declared it falls back to the first root, and to null with neither", () => {
  // G24's sentinel: `hubRoot` may legitimately be null on an unconfigured
  // machine. Falling back keeps such an install working; returning a path
  // built from `null` would be the crash this repo keeps designing away.
  assert.equal(artifactPath({ hubRoot: null, roots: [NESTED] }), path.join(NESTED, ARTIFACT_NAME));
  assert.equal(artifactPath({ hubRoot: null, roots: [] }), null,
    "nowhere to write is a could-not-run, never a crash and never a guess");
});
