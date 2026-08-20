/**
 * No tracked source file may contain a literal NUL byte.
 *
 * WHY (docs/GOTCHAS.md G49, docs/ISSUES.md N33). A NUL separator in a composite map
 * key is correct — it is the one byte that cannot occur in a path, so it is the only
 * separator that cannot collide. Writing it as a RAW BYTE rather than the `\u0000`
 * escape is not correct: one NUL makes the whole file "binary", and the `grep` shim
 * here passes `-I` (skip binary), so the file returns no matches, exits 1, and warns
 * about nothing. That is indistinguishable from "the symbol is not in this file".
 *
 * MEASURED BASELINE, 2026-08-19 — this test was written RED against three real files:
 * lib/events.mjs, lib/frontmatter.mjs, lib/graph.mjs. It very nearly produced the
 * published claim that lib/graph.mjs does not implement `fixOrder`, a function it
 * exports.
 *
 * The fix is a display change only: `\u0000` is six ASCII characters that evaluate to
 * the same one byte. tests/edge-id-stability.test.mjs is the half that proves that —
 * this test alone would pass just as well if someone "fixed" it by deleting the
 * separator, which would be a correctness bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("no tracked non-vendor file contains a literal NUL byte", () => {
  // `--others --exclude-standard` as well as the tracked set. THIS TEST FAILED TO
  // CATCH ITSELF on 2026-08-19: it was written with two literal NULs in its own
  // docstring, ran green while still untracked, and only went red once `git add`
  // brought it into `git ls-files`. A guard that cannot see a file until someone
  // stages it is blind at exactly the moment a new file is written — which is when
  // the mistake is made. docs/GOTCHAS.md G48: an enforcement point that does not
  // watch itself.
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((f) => f && !f.startsWith("node_modules/"))
    // Source only. `docs/archive/` holds retired artifacts kept verbatim as evidence —
    // including gzipped watcher logs, which are binary by definition and would fail a
    // guard whose whole point is "source files must stay greppable". Excluding them is
    // narrowing the claim to what it always meant, not weakening it.
    .filter((f) => !f.startsWith("docs/archive/") && !/\.(gz|db|png|jpg|jpeg|ico|zip|tgz)$/i.test(f));

  // Attributable absence: an empty file list means git failed or the cwd is wrong,
  // not that the repo is clean. A check that cannot fail is worse than no check.
  assert.ok(files.length > 20, `expected a populated file list, got ${files.length}`);

  const offenders = [];
  for (const f of files) {
    let buf;
    try {
      buf = readFileSync(path.join(REPO, f));
    } catch {
      continue; // deleted-but-tracked; not this test's business
    }
    const at = buf.indexOf(0);
    if (at !== -1) {
      const line = buf.subarray(0, at).toString("utf8").split("\n").length;
      offenders.push(`${f}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "literal NUL bytes make these files invisible to `grep` (-I skips binary). " +
      "Write the separator as the escape backslash-u-0000 instead — same byte at runtime.\n  " +
      offenders.join("\n  "),
  );
});
