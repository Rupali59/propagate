/**
 * Phase 2 — no feature may depend on this author's machine layout.
 *
 * WHY THESE ARE BEHAVIOURAL AND NOT A GREP. A regex for `/opt/homebrew` cannot tell
 * an executable literal from the docstring explaining why that literal was wrong, and
 * this repo is full of the latter on purpose — the incident write-ups cite real paths
 * because that traceability is what makes them worth reading. Every case here instead
 * puts the module in the condition another machine is in and asserts what it does.
 *
 * MEASURED BASELINE, 2026-08-19 — the RED each was written against:
 *   - lib/skills-scan.mjs pinned BOTH tools absolutely: `/opt/homebrew/bin/rg` with
 *     `/usr/bin/grep` as its fallback. On Linux, or an Intel Mac, or under a version
 *     manager, the first does not exist and the second is not guaranteed either.
 *   - lib/notify.mjs ended its resolution chain with the Homebrew path as a literal
 *     fallback, so "not found" produced a confident path into a directory that was
 *     never there rather than a null the caller could report.
 *   - digest.mjs rebuilt `~/.claude/skills/telegram` by hand although
 *     INTEGRATIONS.telegramDir already existed for exactly this.
 *   - The `.gstack-backup` skip list was duplicated across lib/discovery.mjs and
 *     lib/refs.mjs, with DIFFERENT contents — refs carried two timestamped literals
 *     discovery did not. Two copies of one list is the drift this skill exists to
 *     detect, sitting inside the detector.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Evaluate an expression in a child with a controlled env. Returns trimmed stdout. */
function evalIn(code, env = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

test("skills-scan resolves its search tool through PATH", () => {
  // Asserting "the result is not /opt/homebrew/bin/rg" would test THIS MACHINE, not
  // the code: here rg genuinely lives there and a correct PATH lookup finds it. So
  // point PATH at a directory holding a decoy and require the decoy to win — that
  // can only happen by resolution, never by a literal.
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-path-"));
  try {
    const decoy = path.join(dir, "rg");
    writeFileSync(decoy, "#!/bin/sh\nexit 0\n");
    chmodSync(decoy, 0o755);
    const out = evalIn(
      `import { resolveScanner } from "./lib/skills-scan.mjs";
       console.log(JSON.stringify(resolveScanner()));`,
      { PATH: dir },
    );
    assert.equal(JSON.parse(out)?.bin, decoy, `must resolve via PATH, got ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skills-scan degrades attributably when no search tool exists at all", () => {
  // The condition a minimal container is in. Absence must be attributable
  // (rule:discernment-checks §2): "no skills found" and "could not look" are
  // different facts, and the second must never render as the first.
  const out = evalIn(
    `import { resolveScanner } from "./lib/skills-scan.mjs";
     console.log(JSON.stringify(resolveScanner()));`,
    { PATH: "/nonexistent-bin-dir" },
  );
  assert.equal(out, "null", `with an empty PATH the scanner must be null, got ${out}`);
});

test("notify does not fall back to a hardcoded Homebrew path", () => {
  const out = evalIn(
    `import { resolveNotifier } from "./lib/notify.mjs";
     console.log(JSON.stringify(resolveNotifier()));`,
    { PATH: "/nonexistent-bin-dir", PROPAGATE_NOTIFIER: "" },
  );
  assert.equal(out, "null", `unresolvable notifier must be null, got ${out}`);
});

test("the telegram integration is configurable, not rebuilt from HOME", () => {
  const out = evalIn(
    `import { INTEGRATIONS } from "./lib/config.mjs";
     console.log(INTEGRATIONS.telegramDir);`,
    { PROPAGATE_TELEGRAM_DIR: "/tmp/telegram-elsewhere" },
  );
  assert.equal(out, "/tmp/telegram-elsewhere");

  // And digest must actually READ it rather than rebuilding the same path by hand.
  const src = readFileSync(path.join(REPO, "digest.mjs"), "utf8");
  assert.ok(
    !/path\.join\(\s*HOME\s*,\s*["']\.claude["']\s*,\s*["']skills["']\s*,\s*["']telegram["']/.test(src),
    "digest.mjs still rebuilds the telegram path from HOME instead of using INTEGRATIONS.telegramDir",
  );
});

test("the backup-directory skip list is declared once", async () => {
  const [discovery, refs] = await Promise.all([
    import("../lib/discovery.mjs"),
    import("../lib/refs.mjs"),
  ]);
  assert.ok(Array.isArray(discovery.BACKUP_DIR_PREFIXES), "discovery must export the list");
  // Identity, not deep-equality: two arrays that happen to match today are still two
  // lists, and the whole point is that they cannot diverge tomorrow.
  assert.equal(
    refs.BACKUP_DIR_PREFIXES,
    discovery.BACKUP_DIR_PREFIXES,
    "refs.mjs must re-export discovery's list, not keep its own copy",
  );
});

test("a generated liveness probe names configured roots, not the author's", () => {
  const out = evalIn(
    `import { livenessProbeFor } from "./lib/inventory.mjs";
     console.log(livenessProbeFor("SOME_DOC.md"));`,
    { PROPAGATE_SEARCH_ROOTS: "/tmp/probe-root" },
  );
  assert.ok(out.includes("/tmp/probe-root"), `probe must use configured roots, got: ${out}`);
  assert.ok(
    !out.includes("Documents/GitHub"),
    `probe still hardcodes the author's layout: ${out}`,
  );
});

test("the SHIPPED cross-allow.yml names no absolute machine-specific path", () => {
  // This file is checked in, so whatever it contains ships to every install. It
  // carried three of the author's repo roots as the default allowlist — on any other
  // machine those paths do not resolve, and the allowlist that is supposed to BOUND
  // cross-repo edges instead describes a tree nobody has. The real list belongs in
  // the user copy at $PROPAGATE_STATE_DIR/cross-allow.yml, which config.mjs already
  // prefers; the shipped one is an example.
  const shipped = readFileSync(path.join(REPO, "cross-allow.yml"), "utf8");
  const offenders = shipped
    .split("\n")
    .filter((l) => /^\s*-\s*(~|\/)/.test(l) && !/^\s*#/.test(l));
  assert.deepEqual(
    offenders,
    [],
    `shipped cross-allow.yml hardcodes machine paths:\n  ${offenders.join("\n  ")}`,
  );
});

test("a user cross-allow.yml takes precedence over the shipped one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "propagate-xa-"));
  try {
    writeFileSync(path.join(dir, "cross-allow.yml"), "partner_roots: []\n");
    const out = evalIn(
      `import { CROSS_ALLOW_PATH } from "./lib/config.mjs";
       console.log(CROSS_ALLOW_PATH);`,
      { PROPAGATE_STATE_DIR: dir },
    );
    assert.equal(out, path.join(dir, "cross-allow.yml"), "user copy must win");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

