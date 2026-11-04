/**
 * plugin-validate.test.mjs — `claude plugin validate` passes, and the ONE warning it raises is the known one (#98).
 *
 * The warning: `skills/propagate/SKILL.md` is a symlink to the root SKILL.md, and the validator does not read
 * symlinks (its own text: "A session loading this plugin does follow them"). The root copy cannot move: lib/core/
 * config.mjs finds propagate's root by `package.json` + `SKILL.md`, the docs tests read it, and sidecar edges are keyed
 * on it; and the symlink cannot be flipped to the root, because SKILL.md links `sections/...` relative to
 * skills/propagate/. So `--strict` (warnings are failures) is not the gate — this is: any warning OTHER than the
 * pinned one, or a failure, is red. An allowlist of one fails loudly on anything new (rule:derive-dont-curate).
 *
 * READ `--json`, NEVER THE PROSE. Until 2026-11-04 this parsed `❯ ` lines out of the human report. Claude Code
 * 2.1.311 appended a plugin-directory section (12 `❯ ` findings) and an "About these checks" block (2 more `❯ `
 * notes) to that report, and both live tests went red with the validator's own verdict unchanged. The JSON keeps
 * the three apart: the validator's warnings (`manifest`, `contents[]`), the plugin directory's findings
 * (`directory.findings[]`, each with a stable `code`), and advice/notes, which never gate anything.
 *
 * The directory findings are gated too, separately: a blocking one is red, ICON_MISSING is pinned with its reason,
 * and ARCHIVE_OS_METADATA_FILE (.DS_Store) is accepted only for a file git does not track, which is the validator's
 * own instruction ("If it prints nothing, the file is not committed and so is not submitted"). A committed .DS_Store
 * is red.
 *
 * `classify`, `KNOWN_WARNINGS` and `KNOWN_DIRECTORY` live in lib/core/plugin-validate.mjs, shared with the release gate
 * (`release --check`'s `plugin-validate`, #115); this file tests them.
 *
 * The `claude` CLI is not on CI runners, so the live check SKIPS there with a stated reason, never passes
 * silently (rule:discernment-checks §2). `classify` is tested without it, so the logic is always exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify, claudeVersion, validatePlugin, isTrackedIn } from "../../lib/core/plugin-validate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const noClaude = claudeVersion() === null ? "the claude CLI is not installed here (CI) — classify() is still tested below" : false;
const validate = (dir) => validatePlugin(dir);
const tracked = isTrackedIn(REPO);

// Literal reports, not live output, so every branch is reachable without the CLI (rule:mutate-behind-the-fixture-builder).
const report = (over = {}) => ({
  success: true,
  manifest: { errors: [], warnings: [] },
  contents: [{ errors: [], warnings: [{ path: "directory", message: "1 component here was not read — the path is not a regular file" }] }],
  directory: { findings: [] },
  ...over,
});

test("classify: the pinned symlink warning is accepted, anything else is reported", () => {
  const ok = classify(report());
  assert.deepEqual({ passed: ok.passed, unexpected: ok.unexpected, directoryUnexpected: ok.directoryUnexpected }, { passed: true, unexpected: [], directoryUnexpected: [] });
  assert.deepEqual(ok.pinnedWarnings, ["skills/propagate/SKILL.md symlink, #98"], "the pinned warning is counted, so the gate can say it was pinned");
  const extra = report({ contents: [{ errors: [], warnings: [
    { path: "directory", message: "1 component here was not read — x" },
    { path: "root", message: "CLAUDE.md at the plugin root is not loaded as project context." },
  ] }] });
  assert.deepEqual(classify(extra).unexpected, ["root: CLAUDE.md at the plugin root is not loaded as project context."]);
  assert.equal(classify(report({ success: false })).passed, false);
  const errored = classify(report({ manifest: { errors: [{ path: "name", message: "missing" }], warnings: [] } }));
  assert.equal(errored.passed, false);
  assert.deepEqual(errored.unexpected, ["error name: missing"]);
});

test("classify: directory findings — icon pinned, untracked .DS_Store accepted, tracked or blocking or new is red", () => {
  const findings = [
    { code: "ICON_MISSING", file: ".claude-plugin/plugin.json", blocking: false },
    { code: "ARCHIVE_OS_METADATA_FILE", file: "lib/.DS_Store", blocking: false },
    { code: "ARCHIVE_OS_METADATA_FILE", file: "docs/.DS_Store", blocking: false },
    { code: "LICENSE_MISSING", file: "LICENSE", blocking: false },
    { code: "ICON_MISSING", file: "x", blocking: true },
  ];
  const r = classify(report({ directory: { findings } }), { isTracked: (f) => f === "docs/.DS_Store" });
  assert.deepEqual(r.directoryUnexpected, ["ARCHIVE_OS_METADATA_FILE docs/.DS_Store", "LICENSE_MISSING LICENSE", "ICON_MISSING x (blocking)"]);
});

test("classify: a report it does not recognise is a failure, never an empty pass", () => {
  for (const bad of [null, {}, { unparsed: "⚠ Found 1 warning" }, { success: true, contents: "x", manifest: {} }]) {
    const r = classify(bad);
    assert.equal(r.passed, false);
    assert.match(r.unexpected[0], /unrecognised validator report shape/);
  }
});

test("claude plugin validate passes on propagate with only the pinned warning", { skip: noClaude }, () => {
  const out = validate(REPO);
  const r = classify(out, { isTracked: tracked });
  const show = JSON.stringify(out, null, 1).slice(0, 4000);
  assert.equal(r.passed, true, `validation did not pass:\n${show}`);
  assert.deepEqual(r.unexpected, [], `a NEW validator warning — fix it, or pin it in KNOWN_WARNINGS with its reason:\n${show}`);
  assert.deepEqual(r.directoryUnexpected, [], `a NEW plugin-directory finding — fix it, or pin its code in KNOWN_DIRECTORY with its reason:\n${show}`);
});

test("the live check can fail: a probe plugin with a root CLAUDE.md raises an unpinned warning", { skip: noClaude }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-validate-"));
  try {
    mkdirSync(path.join(dir, ".claude-plugin"));
    mkdirSync(path.join(dir, "skills", "x"), { recursive: true });
    writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "probe-plugin", version: "0.0.1", description: "d", author: { name: "a" } }));
    writeFileSync(path.join(dir, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: Use when probing.\n---\nbody\n");
    writeFileSync(path.join(dir, "CLAUDE.md"), "hi\n");
    const r = classify(validate(dir));
    assert.equal(r.unexpected.length, 1, JSON.stringify(r));
    assert.match(r.unexpected[0], /^root: CLAUDE\.md at the plugin root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
