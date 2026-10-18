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
 * The `claude` CLI is not on CI runners, so the live check SKIPS there with a stated reason, never passes
 * silently (rule:discernment-checks §2). `classify` is tested without it, so the logic is always exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The warnings propagate knowingly carries, each with the reason it is accepted. */
export const KNOWN_WARNINGS = [
  { re: /^directory: 1 component here was not read/, why: "skills/propagate/SKILL.md is a symlink to the root SKILL.md (#98)" },
];

/** `{passed, unexpected}` from the validator's output: `❯ ` lines are warnings or errors. */
export function classify(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("❯ ")).map((l) => l.slice(2));
  const unexpected = lines.filter((l) => !KNOWN_WARNINGS.some((k) => k.re.test(l)));
  return { passed: /Validation passed/.test(output) && !/Validation failed/.test(output), unexpected };
}

const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
const noClaude = claude.error || claude.status !== 0 ? "the claude CLI is not installed here (CI) — classify() is still tested below" : false;
const validate = (dir) => {
  const r = spawnSync("claude", ["plugin", "validate", dir], { encoding: "utf8", timeout: 60000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

test("classify: the pinned symlink warning is accepted, anything else is reported", () => {
  const known = "⚠ Found 1 warning:\n  ❯ directory: 1 component here was not read — the path is not a regular file\n✔ Validation passed with warnings";
  assert.deepEqual(classify(known), { passed: true, unexpected: [] });
  const extra = known.replace("✔", "  ❯ root: CLAUDE.md at the plugin root is not loaded as project context.\n✔");
  assert.deepEqual(classify(extra).unexpected, ["root: CLAUDE.md at the plugin root is not loaded as project context."]);
  assert.equal(classify("✘ Validation failed").passed, false);
});

test("claude plugin validate passes on propagate with only the pinned warning", { skip: noClaude }, () => {
  const out = validate(REPO);
  const r = classify(out);
  assert.equal(r.passed, true, `validation did not pass:\n${out}`);
  assert.deepEqual(r.unexpected, [], `a NEW validator warning — fix it, or pin it in KNOWN_WARNINGS with its reason:\n${out}`);
});

test("the live check can fail: a probe plugin with a root CLAUDE.md raises an unpinned warning", { skip: noClaude }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-validate-"));
  try {
    mkdirSync(path.join(dir, ".claude-plugin"));
    mkdirSync(path.join(dir, "skills", "x"), { recursive: true });
    writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "probe-plugin", version: "0.0.1", description: "d", author: { name: "a" } }));
    writeFileSync(path.join(dir, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: Use when probing.\n---\nbody\n");
    writeFileSync(path.join(dir, "CLAUDE.md"), "hi\n");
    assert.equal(classify(validate(dir)).unexpected.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
