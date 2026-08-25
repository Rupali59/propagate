/**
 * lib/gotchas/parse.mjs — the half of the guard that decides WHICH hazard files
 * govern you, and whether their entries can fire at all.
 *
 * WHY THIS FILE EXISTS. `hooks/gotcha-guard.test.mjs` has nine good tests and
 * every one of them injects its fixture through `GOTCHA_GUARD_GLOBAL`. So the
 * global-index branch of `sourcesFor()` is well covered and the **upward
 * `docs/GOTCHAS.md` walk has never been tested at all** — no test anywhere in
 * the tree creates such a fixture.
 *
 * That is the branch G3b rewrites, to add
 * `<workspace>/propagation/state/<project>/GOTCHAS.md`. Its failure mode is
 * silence: hazards simply stop arriving, with no error and no exit code. A
 * change with a silent failure mode landing on the one untested function is
 * the shape this repo keeps paying for, so the coverage goes in first.
 *
 * ORDER IS A BEHAVIOUR, NOT AN ACCIDENT. `sourcesFor` promises "nearest first",
 * and `render()` shows at most MAX_SHOWN entries. If order inverts, the
 * workspace-wide note displaces the project-specific one that was the reason to
 * interrupt. Silent, and strictly worse than not firing.
 *
 * ENV IS READ AT MODULE LOAD, so the fixture tree is built and the vars are set
 * BEFORE the dynamic import below. Static `import` would hoist above the setup
 * and read the real `$HOME` — which is exactly how a test ends up asserting
 * against the developer's own machine and passing everywhere except CI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = await mkdtemp(path.join(tmpdir(), "gotchas-parse-"));
const WS = path.join(ROOT, "ws");
const PROJ = path.join(WS, "proj");
const DEEP = path.join(PROJ, "src", "nested");

const WS_FILE = path.join(WS, "docs", "GOTCHAS.md");
const PROJ_FILE = path.join(PROJ, "docs", "GOTCHAS.md");

await mkdir(path.dirname(WS_FILE), { recursive: true });
await mkdir(path.dirname(PROJ_FILE), { recursive: true });
await mkdir(DEEP, { recursive: true });

await writeFile(
  WS_FILE,
  "# ws\n\n### W1 · a workspace-wide hazard\n**Trigger:** `wscmd`\n**Fires on:** `wscmd --go`\nbody.\n**Instead:** do the other thing.\n",
);
await writeFile(
  PROJ_FILE,
  "# proj\n\n### P1 · a project hazard\n**Trigger:** `projcmd`\n**Fires on:** `projcmd --go`\nbody.\n**Instead:** do the other thing.\n",
);

// Point the global index at a path that does not exist, so `found` contains the
// walk results ONLY and the ordering assertions below are unambiguous.
process.env.GOTCHA_GUARD_GLOBAL = path.join(ROOT, "no-such-global.md");
process.env.GOTCHA_GUARD_CEILING = ROOT;
process.env.GOTCHA_GUARD_LOG = path.join(ROOT, "log");

const { parseEntries, selftestProblems, sourcesFor } = await import("../../lib/gotchas/parse.mjs");

process.on("exit", () => {
  try {
    rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// sourcesFor — the branch with no prior coverage
// ---------------------------------------------------------------------------

test("finds a docs/GOTCHAS.md by walking up from a nested directory", () => {
  // The whole premise of the guard: you are deep in a source tree and the
  // hazard file is several levels above you.
  const found = sourcesFor(DEEP);
  assert.ok(found.includes(PROJ_FILE), `expected the project file in ${JSON.stringify(found)}`);
  assert.ok(found.includes(WS_FILE), `expected the workspace file in ${JSON.stringify(found)}`);
});

test("nearest wins: the project file comes before the workspace file", () => {
  // Load-bearing. render() truncates to MAX_SHOWN, so if this inverts the
  // workspace-wide note pushes out the specific one you needed. No error, no
  // exit code — you just get the less useful hazard.
  const found = sourcesFor(DEEP);
  assert.ok(
    found.indexOf(PROJ_FILE) < found.indexOf(WS_FILE),
    `nearest-first violated: ${JSON.stringify(found)}`,
  );
});

test("the ceiling is respected — the walk does not escape above it", () => {
  const found = sourcesFor(DEEP);
  for (const f of found) {
    assert.ok(f.startsWith(ROOT), `${f} is outside the ceiling ${ROOT}`);
  }
});

test("a directory with no GOTCHAS above it yields none, and that is not an error", () => {
  // "found nothing" must be an ordinary empty result, distinguishable from a
  // throw. rule:discernment-checks §2.
  const found = sourcesFor(ROOT);
  assert.deepEqual(found, [], "no file above ROOT, so nothing should be found");
});

// ---------------------------------------------------------------------------
// parseEntries — a broken trigger must be reported, never silently dropped
// ---------------------------------------------------------------------------

test("a non-compiling trigger is collected into `bad`, not thrown and not dropped", async () => {
  // An entry whose regex does not compile stops matching forever. If it were
  // merely skipped, the file would look healthy while carrying one fewer
  // hazard than it declares — the exact failure the guard exists to prevent.
  const f = path.join(ROOT, "broken.md");
  await writeFile(
    f,
    "# x\n\n### B1 · unclosed group\n**Trigger:** `foo(`\n**Fires on:** `foo(`\nbody.\n\n" +
      "### B2 · a fine one\n**Trigger:** `okcmd`\n**Fires on:** `okcmd`\nbody.\n",
  );
  const { entries, bad } = parseEntries(f);
  assert.equal(bad.length, 1, "the broken trigger must be reported");
  assert.match(bad[0].pattern, /foo\(/);
  assert.equal(entries.length, 1, "the good entry still parses");
  assert.equal(entries[0].title.includes("B2"), true);
});

test("an unreadable file yields no entries rather than throwing", () => {
  const { entries, bad } = parseEntries(path.join(ROOT, "definitely-absent.md"));
  assert.deepEqual(entries, []);
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// selftestProblems — the capability the doc taxonomy structurally cannot supply
// ---------------------------------------------------------------------------

test("an entry whose trigger cannot match its own `Fires on:` IS reported", async () => {
  // N45: 3 of 10 triggers were inert while --selftest reported green. A
  // GOTCHAS.md can be present, current and reconciled, and still deliver
  // nothing. Staleness checks cannot see this; only this one can.
  const f = path.join(ROOT, "inert.md");
  await writeFile(
    f,
    "# x\n\n### I1 · an inert entry\n**Trigger:** `never-matches-this`\n**Fires on:** `something else entirely`\nbody.\n",
  );
  const problems = selftestProblems([f]);
  assert.equal(problems.length >= 1, true, "an inert trigger must be a problem");
  assert.match(problems.join("\n"), /I1|does NOT match/);
});

test("an entry with a Trigger but no `Fires on:` is reported as unproven", async () => {
  const f = path.join(ROOT, "unproven.md");
  await writeFile(f, "# x\n\n### U1 · no proof\n**Trigger:** `somecmd`\nbody.\n");
  const problems = selftestProblems([f]);
  assert.match(problems.join("\n"), /no \*\*Fires on:\*\*|nothing proves it can fire/);
});

test("an empty source list is attributable, not silently fine", () => {
  const problems = selftestProblems([]);
  assert.equal(problems.length >= 1, true, "zero sources means the guard can never fire — say so");
});

test("a healthy file produces no problems", async () => {
  // The negative control. Without it, a selftestProblems() that returned a
  // problem for EVERY input would pass every test above.
  const problems = selftestProblems([PROJ_FILE, WS_FILE]);
  assert.deepEqual(problems, [], `expected clean, got ${JSON.stringify(problems)}`);
});

// ---------------------------------------------------------------------------
// G3b — the propagation layout: <workspace>/propagation/state/<project>/
// ---------------------------------------------------------------------------

test("finds a project's GOTCHAS.md under propagation/state/<project>/", async () => {
  // The norm: internal repos' data lives in the WORKSPACE's propagation folder.
  // STATE.md and DECISIONS.md moved there 2026-08-21; GOTCHAS.md follows.
  //
  // The guard resolves by relative path, so if it does not learn this location the
  // move stops hazard delivery SILENTLY — no error, no exit code, the entries
  // simply never arrive. Which is why this lands before anything moves.
  const file = path.join(WS, "propagation", "state", "proj", "GOTCHAS.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    "# migrated\n\n### M1 · a migrated hazard\n**Trigger:** `migratedcmd`\n**Fires on:** `migratedcmd --go`\nbody.\n**Instead:** care.\n",
  );
  const found = sourcesFor(DEEP);
  assert.ok(found.includes(file), `expected the migrated file in ${JSON.stringify(found)}`);
});

test("the migrated project file still outranks the workspace file", async () => {
  // Nearest-first must survive the move. Relocating a file must not quietly
  // change WHICH hazard you see first when render() truncates.
  const file = path.join(WS, "propagation", "state", "proj", "GOTCHAS.md");
  const found = sourcesFor(DEEP);
  // Assert PRESENCE before order. `indexOf` returns -1 for a missing entry and
  // -1 < 0 is true, so an order-only assertion passes loudest when the file is
  // not found at all — it went green against an unimplemented resolver, which is
  // the vacuous pass rule:discernment-checks §1 exists to catch.
  assert.ok(found.includes(file), `migrated file absent entirely: ${JSON.stringify(found)}`);
  assert.ok(found.includes(WS_FILE), `workspace file absent: ${JSON.stringify(found)}`);
  assert.ok(
    found.indexOf(file) < found.indexOf(WS_FILE),
    `project file must precede the workspace file: ${JSON.stringify(found)}`,
  );
});

test("finds the workspace's own GOTCHAS.md at propagation/state/workspace/", async () => {
  const file = path.join(WS, "propagation", "state", "workspace", "GOTCHAS.md");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    "# ws migrated\n\n### M2 · a workspace hazard\n**Trigger:** `wsmigrated`\n**Fires on:** `wsmigrated --go`\nbody.\n**Instead:** care.\n",
  );
  assert.ok(sourcesFor(DEEP).includes(file));
});

test("the state directory is matched case-insensitively", async () => {
  // `Motherboard/` the repo vs `propagation/state/motherboard/` the project dir.
  // macOS hides this; Linux CI would not, so an exact-match-only resolver ships
  // green here and drops the hazard everywhere else.
  const projDir = path.join(ROOT, "ws2", "MixedCase");
  const file = path.join(ROOT, "ws2", "propagation", "state", "mixedcase", "GOTCHAS.md");
  await mkdir(projDir, { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    "# mc\n\n### M3 · case hazard\n**Trigger:** `casecmd`\n**Fires on:** `casecmd --go`\nbody.\n**Instead:** care.\n",
  );
  // Compared case-INSENSITIVELY on purpose. On a case-insensitive filesystem the
  // cheap `existsSync` exact branch succeeds and returns the spelling we asked
  // for; on Linux it misses and the readdir fallback returns the real on-disk
  // name. Both resolve the same file, which is the actual contract — asserting a
  // literal spelling would encode this machine's filesystem into the test.
  const found = sourcesFor(projDir);
  assert.ok(
    found.some((f) => f.toLowerCase() === file.toLowerCase()),
    `case-differing state dir must still resolve: ${JSON.stringify(found)}`,
  );
});

/**
 * N45 — a trigger whose SUBJECT can never be delivered must be reported.
 *
 * The test above catches a trigger that cannot match its own example. This
 * catches the subtler half: a trigger that matches its example perfectly, where
 * the example is a string the guard is never handed.
 *
 * `subjectOf` (hooks/gotcha-guard.mjs:68) passes exactly two kinds of string to
 * the matcher — `input.command` for Bash, and `input.file_path` for Edit /
 * Write / NotebookEdit. **Never the content being written.** So a trigger
 * describing a CODE PATTERN can never fire on the edit that introduces it.
 *
 * Measured 2026-08-22 across both GOTCHAS.md files: of 10 entries carrying a
 * trigger, 4 fire via Bash, 3 via a file path, and THREE are inert —
 * `toLocaleString(undefined`, `unstable_cache`, `const elapsedMs = Date.now()`.
 * Two of the three are marked ⚡ in `Vipin Kaushik/CLAUDE.md`, whose text says
 * they fire automatically and are "put in front of you at the moment of risk".
 *
 * `--selftest` passed throughout, because asserting a regex against a string of
 * its author's choosing cannot detect that the string never occurs. That is
 * `rule:enforcement-watches-itself`'s corollary exactly: the selftest was the
 * mechanism meant to make this impossible.
 *
 * This does NOT make those entries work — it makes their deadness loud. N45
 * argues that lands first regardless, and it is this repo's stated posture:
 * "found nothing" and "looked at nothing" must read differently.
 */
test("N45: a Fires-on literal that is neither a path nor a command is reported UNREACHABLE", async () => {
  const f = path.join(ROOT, "unreachable.md");
  await writeFile(
    f,
    "# x\n\n### U1 · a code-pattern trigger\n**Trigger:** `unstable_cache`\n" +
      "**Fires on:** `unstable_cache`\nA cached Date comes back a string.\n",
  );
  const problems = selftestProblems([f]);
  assert.match(
    problems.join("\n"),
    /U1/,
    `the inert entry must be named, got ${JSON.stringify(problems)}`,
  );
  assert.match(problems.join("\n"), /unreachable|never delivered|no tool call/i, problems.join("\n"));
});

test("N45: real path and command triggers stay QUIET — the check must not fire on everything", async () => {
  // A check that flags every entry is the always-on banner G23 warns about, and
  // it would make the seven live triggers indistinguishable from the three dead
  // ones — which is the failure being fixed, inverted.
  const f = path.join(ROOT, "reachable.md");
  await writeFile(
    f,
    "# x\n\n### R1 · a path trigger\n**Trigger:** `layout\\.tsx`\n**Fires on:** `app/(site)/layout.tsx`\nbody.\n" +
      "\n### R2 · a command trigger\n**Trigger:** `npm install`\n**Fires on:** `npm install --save-dev x`\nbody.\n" +
      "\n### R3 · a bare-word command\n**Trigger:** `^rm\\s`\n**Fires on:** `rm -rf dist/`\nbody.\n",
  );
  assert.deepEqual(selftestProblems([f]), [], "all three are deliverable subjects");
});
