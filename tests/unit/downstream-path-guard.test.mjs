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

import { classifyDownstreamPath } from "../../cli.mjs";

const SKILL_DIR = fileURLToPath(new URL("../../", import.meta.url));
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("classifyDownstreamPath reports 'missing' (not 'is-directory') for an absent file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-"));
  try {
    const result = await classifyDownstreamPath(root, "does/not/exist.tsx");
    assert.equal(result, "missing");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("classifyDownstreamPath reports 'ok' for a real file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guard-"));
  try {
    await writeFile(path.join(root, "real.tsx"), "// hi\n", "utf8");
    const result = await classifyDownstreamPath(root, "real.tsx");
    assert.equal(result, "ok");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── N11: a MOVED downstream versus one nobody has written yet ─────────────────
//
// Both were a warn, so the two were indistinguishable — N11 (S1), hit twice in one
// day. The discriminator is git: a deletion commit means the path EXISTED.
//
// THE NEGATIVE CONTROLS ARE THE POINT, and there are two of them, because the
// escalation is only as good as its refusals. A path never written must stay a warn,
// or every declare-ahead entry in the tree turns red. And a NON-GIT directory must
// also stay a warn, or "git could not answer" silently becomes "the path existed" —
// absence of confirmation reading as confirmation (rule:discernment-checks §2).

/** Like makeWorkspaceWithSidecar, but the workspace is a git repo. */
async function makeGitWorkspace({ downstreamPath, kind, commitThenDelete }) {
  const { root, sidecarPath } = await makeWorkspaceWithSidecar({ downstreamPath, kind });
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  if (commitThenDelete) {
    const target = path.join(root, "sub", downstreamPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "# downstream, for now\n", "utf8");
    git("add", "-A", ".");
    git("commit", "-qm", "the downstream exists at this point");
    // The move N11 describes: the file leaves, the sidecar entry does not.
    await rm(target, { force: true });
    git("add", "-A", ".");
    git("commit", "-qm", "moved the downstream away and forgot the sidecar");
  } else {
    git("add", "-A", ".");
    git("commit", "-qm", "the downstream was never written");
  }
  return { root, sidecarPath };
}

test("a downstream that EXISTED and is gone FAILS, naming the commit that removed it", async () => {
  const { root } = await makeGitWorkspace({ downstreamPath: "moved.md", commitThenDelete: true });
  try {
    const out = runDoctor(root).stdout;
    assert.match(out, /downstream EXISTED and is gone/, `a moved downstream must not be a warn:\n${out}`);
    // The commit is the actionable part — it is what tells a reader WHEN, so they can
    // find where the file went. A verdict without it is unauditable.
    assert.match(out, /deleted or moved at [0-9a-f]{7,}/, "the verdict must name the deletion commit");
    assert.match(out, /✗[^\n]*moved\.md/, "and it must be a failure, not a warning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a downstream never written stays a declare-ahead WARN", async () => {
  // Without this, every declare-ahead entry in the tree goes red and the check is
  // switched off within a day.
  const { root } = await makeGitWorkspace({ downstreamPath: "not-yet.md", commitThenDelete: false });
  try {
    const out = runDoctor(root).stdout;
    assert.doesNotMatch(out, /downstream EXISTED and is gone/, `a path never written is not a break:\n${out}`);
    assert.match(out, /prose downstream missing/, "it stays the v1 warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: git that cannot answer stays a WARN, never an escalation", async () => {
  // A non-git workspace. `git log` fails, the helper returns null, and the verdict
  // must be unchanged — "could not establish" must not render as "established".
  const { root } = await makeWorkspaceWithSidecar({ downstreamPath: "absent.md" });
  try {
    const out = runDoctor(root).stdout;
    assert.doesNotMatch(out, /downstream EXISTED and is gone/, `no repo means no claim:\n${out}`);
    assert.match(out, /prose downstream missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a kind:code downstream that EXISTED is still a break — declare-ahead is about the FUTURE", async () => {
  // The prose/code allowance exists for code not written yet. Code that was written
  // and removed is the same dead edge as prose, so the kind must not exempt it.
  const { root } = await makeGitWorkspace({ downstreamPath: "gone.ts", kind: "code", commitThenDelete: true });
  try {
    const out = runDoctor(root).stdout;
    assert.match(out, /downstream EXISTED and is gone/, `kind:code must not exempt a path that existed:\n${out}`);
    assert.doesNotMatch(out, /declare-ahead code, not on disk/, "it is not declare-ahead once it has existed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
