/**
 * A glob `kind: code` edge is NOT enforced, and doctor must say so.
 *
 * N6. `lib/edges/edges.mjs` logs-and-skips glob `kind: code` downstreams, and `check`
 * passes a noop logger, so the deferral is not printed anywhere. A sidecar declaring
 * `path: lib/**\/*.ts, kind: code` therefore gets ZERO coverage in both the watcher and
 * the gate while looking exactly like a working edge.
 *
 * Self-documented in five places as "a documented limitation, not a bug" — but the
 * user-visible effect is indistinguishable from an edge that fires. That is the gap this
 * closes: not implementing glob-code expansion (a larger change), but refusing to let an
 * unenforceable edge read as an enforced one. This is the fix N6 itself specifies.
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

function ws({ downstreamPath, kind }) {
  const root = mkdtempSync(path.join(tmpdir(), "propagate-globcode-"));
  const w = path.join(root, "ws");
  mkdirSync(path.join(w, "lib"), { recursive: true });
  writeFileSync(path.join(w, "spec.md"), "# spec\n");
  writeFileSync(path.join(w, "lib", "a.ts"), "export const a = 1;\n");
  writeFileSync(
    path.join(w, ".propagates.yml"),
    `workspace: true\nsources:\n  spec.md:\n    propagates_to:\n      - path: ${downstreamPath}\n        why: probe fixture for N6\n        kind: ${kind}\n`,
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

function doctor(root) {
  const r = spawnSync(process.execPath, [CLI, "doctor"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: path.join(root, ".state") },
  });
  return strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

test("doctor reports a glob kind:code edge as UNENFORCED", () => {
  const w = ws({ downstreamPath: "lib/**/*.ts", kind: "code" });
  try {
    const out = doctor(w.root);
    assert.match(out, /unenforced/i, `doctor must name glob kind:code edges as unenforced:\n${out}`);
    assert.match(out, /lib\/\*\*\/\*\.ts/, "and name the edge itself");
  } finally {
    w.cleanup();
  }
});

test("NEGATIVE CONTROL: a CONCRETE kind:code edge is enforced and not reported", () => {
  // A concrete kind:code downstream fires in both directions. Flagging it would be a
  // false alarm on the common case, which is how a real warning gets tuned out.
  const w = ws({ downstreamPath: "lib/a.ts", kind: "code" });
  try {
    assert.doesNotMatch(doctor(w.root), /unenforced/i);
  } finally {
    w.cleanup();
  }
});

test("NEGATIVE CONTROL: a glob PROSE edge is enforced and not reported", () => {
  // Globs are only unenforceable for kind:code, whose reverse direction needs a concrete
  // path. Glob prose edges expand normally.
  const w = ws({ downstreamPath: "lib/**/*.ts", kind: "prose" });
  try {
    assert.doesNotMatch(doctor(w.root), /unenforced/i);
  } finally {
    w.cleanup();
  }
});
