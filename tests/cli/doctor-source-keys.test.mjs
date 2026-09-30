/**
 * A sidecar `sources:` key that names a file which does not exist is a DEAD EDGE, and
 * doctor must say so.
 *
 * N18. `doctor` has validated downstream `path` entries since N17, but never the source
 * keys — the upstream file an edge fires FROM. A source key pointing at a renamed or
 * deleted file can never fire: there is nothing to change, so nothing is ever detected,
 * and the sidecar still reads as a declared coupling.
 *
 * MEASURED BASELINE, 2026-08-20 — a fixture declaring `does-not-exist.md` as a source
 * produced no mention of it anywhere in doctor's output. The only line containing the
 * word "source" was the unrelated `✓ no source open in more than one ledger`, which is
 * worse than silence: it reads like a source check passing.
 *
 * WHY THIS IS A FAILURE AND NOT A WARNING. A downstream may legitimately not exist yet —
 * that is declare-ahead, and doctor tolerates it deliberately. A SOURCE cannot: the edge
 * fires when the source changes, so a source that is not there is an edge that is
 * already dead. The two cases must not share a severity.
 *
 * ── 2026-09-30, and this file is where the lesson lands ─────────────────────────
 *
 * TWO DEFECTS, both found while "building the source check that did not exist".
 *
 * It did exist — here, since `360ecb9` (2026-08-20), with this file beside it. The
 * claim that it did not came from grepping `lib/` for the LABEL "source paths
 * resolve", finding nothing, and reading that as the behaviour being absent
 * (rule:measure-the-claim-not-a-proxy). A second, warn-level copy was written and
 * shipped, so one missing source printed twice — GOTCHAS G20. The duplicate is gone
 * and its `exactly once` guard is the last test below.
 *
 * AND THE ORIGINAL WAS WRONG ABOUT GLOBS FOR SIX WEEKS. It used a bare `existsSync`,
 * so `notes/*.md` matching two real files was reported `does not exist — this edge
 * can never fire`. Nothing caught it because this file only ever declared literal
 * source keys, which is rule:mutate-behind-the-fixture-builder exactly: the fixture
 * could not express the input that breaks the guard. The four tests appended below
 * are the inexpressible cases — a live glob, a dead glob, a bracket literal, and a
 * double-print — and they are deliberately built from literals rather than folded
 * into `workspace()` above, for that reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function workspace({ sourceKey, createSource }) {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-srckey-"));
  const ws = path.join(root, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    path.join(ws, ".propagates.yml"),
    `workspace: true\nsources:\n  ${sourceKey}:\n    propagates_to:\n      - path: README.md\n        why: probe fixture for N18\n        kind: prose\n`,
  );
  writeFileSync(path.join(ws, "README.md"), "# readme\n");
  if (createSource) writeFileSync(path.join(ws, sourceKey), "# source\n");
  return { root, ws, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

function doctor(root) {
  const r = spawnSync(process.execPath, [CLI, "doctor"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PROPAGATE_SEARCH_ROOTS: root,
      PROPAGATE_STATE_DIR: path.join(root, ".state"),
    },
  });
  return { out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`), code: r.status };
}

test("doctor FAILS and names a source key that does not exist", () => {
  const w = workspace({ sourceKey: "does-not-exist.md", createSource: false });
  try {
    const { out } = doctor(w.root);
    assert.match(
      out,
      /✗[^\n]*does-not-exist\.md/,
      `doctor must fail naming the missing source key. Output was:\n${out}`,
    );
  } finally {
    w.cleanup();
  }
});

test("NEGATIVE CONTROL: a source key that DOES exist produces no such failure", () => {
  // Without this the check above could be satisfied by a rule that flags every source
  // key, which would make doctor red on every healthy workspace — a check that always
  // fires is as useless as one that never does.
  const w = workspace({ sourceKey: "spec.md", createSource: true });
  try {
    const { out } = doctor(w.root);
    assert.doesNotMatch(out, /✗[^\n]*spec\.md/, `a present source key must not be flagged:\n${out}`);
  } finally {
    w.cleanup();
  }
});

// ── the cases the literal-only fixture above could not express ────────────────

/**
 * A workspace whose single source key may be a glob or a bracket path, with an
 * arbitrary set of real files beside it. Deliberately NOT the `workspace()` helper
 * above: that one takes one `sourceKey` and creates exactly that file, so it cannot
 * express "a pattern matching two files" — which is the shape that was broken.
 */
function patternWorkspace({ sourceKey, files }) {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-srcglob-"));
  const ws = path.join(root, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    path.join(ws, ".propagates.yml"),
    `workspace: true\nsources:\n  ${sourceKey}:\n    propagates_to:\n      - path: README.md\n        why: probe fixture for the glob-aware source check\n        kind: prose\n`,
  );
  writeFileSync(path.join(ws, "README.md"), "# readme\n");
  for (const f of files) {
    mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    writeFileSync(path.join(ws, f), "# file\n");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

test("a GLOB source matching real files is silent — the six-week false positive", () => {
  const w = patternWorkspace({ sourceKey: "notes/*.md", files: ["notes/a.md", "notes/b.md"] });
  try {
    const { out } = doctor(w.root);
    assert.doesNotMatch(
      out,
      /✗[^\n]*notes\/\*\.md/,
      `a glob source matching 2 files must not be reported dead:\n${out}`,
    );
  } finally {
    w.cleanup();
  }
});

test("a GLOB source matching NOTHING is its own outcome, never folded into 'does not exist'", () => {
  // rule:discernment-checks §2 — "widen the pattern" and "restore the file" are
  // different fixes, so they must not arrive as the same sentence.
  const w = patternWorkspace({ sourceKey: "nope/*.md", files: [] });
  try {
    const { out } = doctor(w.root);
    assert.match(out, /✗[^\n]*nope\/\*\.md/, `a dead glob must fail:\n${out}`);
    assert.match(out, /matched no files/, "and must say the pattern matched nothing");
    assert.doesNotMatch(
      out,
      /nope\/\*\.md[^\n]*does not exist/,
      "a pattern that matched nothing is not a file that is gone",
    );
  } finally {
    w.cleanup();
  }
});

test("a Next.js bracket path is a LITERAL source, not a glob", () => {
  // existsSync("app/work/[slug]/page.tsx") -> true, globSync(same) -> [] because
  // `[slug]` reads as a character class. Hence literal-first in the predicate.
  const w = patternWorkspace({
    sourceKey: "app/work/[slug]/page.tsx",
    files: ["app/work/[slug]/page.tsx"],
  });
  try {
    const { out } = doctor(w.root);
    assert.doesNotMatch(
      out,
      /✗[^\n]*\[slug\]/,
      `a bracket path that is on disk must not be reported dead:\n${out}`,
    );
  } finally {
    w.cleanup();
  }
});

test("a missing source is reported EXACTLY ONCE — the G20 double-print guard", () => {
  // The regression this guards is not hypothetical: a second warn-level source check
  // was added 2026-09-30 and shipped, so one dead source printed twice. Counting is
  // the only assertion that can see that; `assert.match` passes on two copies.
  const w = workspace({ sourceKey: "counted-once.md", createSource: false });
  try {
    const { out } = doctor(w.root);
    const hits = out.split("\n").filter((l) => l.includes("counted-once.md"));
    assert.equal(
      hits.length,
      1,
      `one dead source must produce one line, got ${hits.length}:\n${hits.join("\n")}`,
    );
  } finally {
    w.cleanup();
  }
});
