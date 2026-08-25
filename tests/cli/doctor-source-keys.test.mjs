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
