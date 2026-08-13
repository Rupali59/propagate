/**
 * Guards for SPEC §3c "Nine real sidecar bugs, found incidentally" (bug A:
 * a directory declared as a downstream; bug B: source/downstream names a
 * file that no longer exists).
 *
 * Two layers, each tested separately:
 *   1. Schema (propagates.schema.json) rejects the shapes that are ALWAYS
 *      wrong — an empty `path`, or one ending in `/`. Schema cannot stat the
 *      filesystem, so it cannot detect "this is a directory" on its own
 *      (`admin/app` has no trailing slash and is syntactically a fine file
 *      path) — that's layer 2.
 *   2. `classifyDownstreamPath` (cli.mjs), exercised directly and through
 *      `doctor`, stats the real filesystem and reports `is-directory`
 *      distinctly from `missing` — different problems, different messages,
 *      different severities (directory is always a bug; missing may be
 *      declare-ahead for `kind: code`, per v1's existing, unchanged allowance).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { classifyDownstreamPath } from "../cli.mjs";

const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = path.join(SKILL_DIR, "cli.mjs");
const SCHEMA_PATH = path.join(SKILL_DIR, "propagates.schema.json");

function compileSchema() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema);
}

function sidecarWithDownstreamPath(p) {
  return {
    sources: {
      "a.md": {
        propagates_to: [{ path: p, why: "because reasons" }],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Layer 1: schema
// ---------------------------------------------------------------------------

test("schema rejects a downstream path ending in '/' (bare directory shape)", () => {
  const validate = compileSchema();
  assert.equal(validate(sidecarWithDownstreamPath("admin/app/")), false);
  const msgs = validate.errors.map((e) => e.message).join("; ");
  assert.match(msgs, /must NOT match pattern|not/i);
});

test("schema rejects an empty downstream path", () => {
  const validate = compileSchema();
  assert.equal(validate(sidecarWithDownstreamPath("")), false);
});

test("schema still accepts a normal file downstream path (no spurious rejection)", () => {
  const validate = compileSchema();
  assert.equal(validate(sidecarWithDownstreamPath("admin/app/page.tsx")), true);
});

test("schema still accepts a glob downstream path (no spurious rejection)", () => {
  const validate = compileSchema();
  assert.equal(validate(sidecarWithDownstreamPath("src/app/work/*/page.tsx")), true);
});

// ---------------------------------------------------------------------------
// Layer 2: classifyDownstreamPath — filesystem stat, at doctor/validate time
// ---------------------------------------------------------------------------

test("classifyDownstreamPath reports 'is-directory' for a real directory downstream", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-"));
  try {
    const target = path.join(root, "admin", "app");
    await mkdir(target, { recursive: true });
    const result = await classifyDownstreamPath(root, "admin/app");
    assert.equal(result, "is-directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyDownstreamPath reports 'missing' (not 'is-directory') for an absent file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-"));
  try {
    const result = await classifyDownstreamPath(root, "does/not/exist.tsx");
    assert.equal(result, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyDownstreamPath reports 'ok' for a real file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-"));
  try {
    await writeFile(path.join(root, "real.tsx"), "// hi\n", "utf8");
    const result = await classifyDownstreamPath(root, "real.tsx");
    assert.equal(result, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Layer 3: doctor — surfaces both, distinctly, naming the sidecar
// ---------------------------------------------------------------------------

/** Build a throwaway workspace with one non-root sidecar declaring a downstream. */
async function makeWorkspaceWithSidecar({ downstreamPath, kind }) {
  const root = await mkdtemp(path.join(tmpdir(), "guard-ws-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const subDir = path.join(root, "sub");
  await mkdir(subDir, { recursive: true });
  const sidecarPath = path.join(subDir, ".propagates.yml");
  const kindLine = kind ? `\n        kind: ${kind}` : "";
  await writeFile(
    sidecarPath,
    `sources:\n  a.md:\n    propagates_to:\n      - path: ${downstreamPath}\n        why: "because reasons"${kindLine}\n`,
    "utf8",
  );
  return { root, sidecarPath };
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

test("doctor FAILS on a directory downstream and names the sidecar", async () => {
  const { root, sidecarPath } = await makeWorkspaceWithSidecar({ downstreamPath: "admin/app" });
  try {
    await mkdir(path.join(root, "sub", "admin", "app"), { recursive: true });
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, "a directory-as-downstream must fail doctor");
    assert.match(out, /downstream is a directory/i);
    const relSidecar = path.relative(root, sidecarPath);
    assert.match(
      out,
      new RegExp(relSidecar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "output names the offending sidecar",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor still only WARNS for a declare-ahead missing kind: code downstream (allowance intact)", async () => {
  const { root } = await makeWorkspaceWithSidecar({
    downstreamPath: "not_yet_written.py",
    kind: "code",
  });
  try {
    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    // A missing kind:code downstream must NOT, by itself, fail doctor —
    // v1's declare-ahead allowance must remain intact.
    assert.match(out, /declare-ahead code, not on disk/);
    assert.doesNotMatch(out, /✗.*not_yet_written\.py/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor passes clean (no directory/missing findings) on a healthy fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-ws-"));
  try {
    await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
    const docsDir = path.join(root, "docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

    const subDir = path.join(root, "sub");
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, "downstream.md"), "# ok\n", "utf8");
    await writeFile(
      path.join(subDir, ".propagates.yml"),
      `sources:\n  a.md:\n    propagates_to:\n      - path: downstream.md\n        why: "because reasons"\n`,
      "utf8",
    );

    const result = runDoctor(root);
    const out = result.stdout + result.stderr;
    assert.match(out, /✓.*sidecar downstream paths resolve/, "clean fixture must not trip the new checks");
    assert.doesNotMatch(out, /downstream is a directory/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
