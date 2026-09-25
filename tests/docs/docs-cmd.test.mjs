/**
 * `commands/docs.mjs` — the `propagate docs` command surface.
 *
 * Zero coverage existed for this module before this file (plan
 * `~/.claude/plans/i-saw-it-what-starry-sparkle.md` §4/T4). Under test:
 * `--doctrine [kind]`, real `--json` (previously silently accepted and
 * ignored — `cli.mjs` called `docsCmd()` with no arguments and the module
 * read `process.argv` directly), `--undeclared` (the full worklist,
 * replacing `--kinds`' 8-of-988 truncation), and `--reference` (§5, T5 —
 * regenerates/verifies the generated section of `docs/REFERENCE.md` itself,
 * reusing `lib/report/rollup.mjs`'s hash-footer guard under its own marks).
 *
 * FIXTURE TREE ONLY, NEVER THE REAL WORKSPACE LIST OR THE REAL REFERENCE.md.
 * `node cli.mjs docs --kinds` over the real ~1513 docs measured 21.03s
 * (`proseOnlySupersession` opens every file). `docsCmd`'s second parameter
 * (`{ workspaces }`) exists precisely so this file never scans that tree — a
 * handful of fixture docs instead. Its THIRD parameter (`{ referenceArtifact
 * }`) exists for the identical reason scoped to `--reference`: without it,
 * every `--reference` test would read and write this repo's own
 * `docs/REFERENCE.md` on every run.
 *
 * Console output is captured by swapping `console.log`/`console.error` for
 * the duration of one call and restoring immediately after (`finally`), never
 * left swapped across tests. `--json` mode's whole contract is "exactly one
 * `console.log` call, and it is valid JSON, and nothing touched `console.error`
 * except on a could-not-run path" — asserted directly, not inferred from a
 * substring match.
 *
 * Run via `npm test` (G56) — never bare `node --test`, which writes the
 * production event store. This file does not touch the event store at all
 * (`docs` is read-only over workspaces, and `--reference` only ever writes
 * to an injected tmp path in these tests), but the house rule is blanket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { docsCmd, guessKind } from "../../commands/docs.mjs";
import { KINDS, kindOf } from "../../lib/report/doc-kind.mjs";
import { REFERENCE_BODY_MARK, REFERENCE_FOOTER_MARK, bodyHash } from "../../lib/report/doc-reference.mjs";

const CLI_PATH = fileURLToPath(new URL("../../cli.mjs", import.meta.url));

/**
 * Swap console.log/console.error for the duration of `fn`, collect every
 * call's arguments (joined the way console does), restore unconditionally.
 */
async function captureConsole(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  console.error = (...args) => errs.push(args.map(String).join(" "));
  try {
    const code = await fn();
    return { code, logs, errs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/**
 * A small fixture tree with a KNOWN, hand-verifiable split of declared vs.
 * undeclared docs — never asserted against a hardcoded count. Every
 * assertion below that cares about "how many" re-derives it from `kindOf`
 * directly against these same paths, per the brief: "the census's own
 * undeclared total, derive both; do not hardcode."
 *
 *   docs/DECISIONS.md              -> decision-log  (filename tier)
 *   docs/design/OVERVIEW.md        -> design         (directory tier)
 *   docs/notes-deploy-checklist.md -> undeclared, guessKind -> "ops"
 *   docs/api-plan-notes.md         -> undeclared, guessKind -> "plan"
 *   docs/blue-sky-thoughts.md      -> undeclared, guessKind -> null
 */
async function fixtureTree() {
  const root = await mkdtemp(path.join(tmpdir(), "docs-cmd-"));
  await mkdir(path.join(root, "docs", "design"), { recursive: true });
  const w = (rel, body) => writeFile(path.join(root, "docs", rel), body, "utf8");
  await w("DECISIONS.md", "# Decisions\n");
  await w(path.join("design", "OVERVIEW.md"), "# Design overview\n");
  await w("notes-deploy-checklist.md", "# Deploy checklist notes\n");
  await w("api-plan-notes.md", "# API plan notes\n");
  await w("blue-sky-thoughts.md", "# Someday maybe\n");
  return root;
}

function fixtureDocPaths(root) {
  return [
    path.join(root, "docs", "DECISIONS.md"),
    path.join(root, "docs", "design", "OVERVIEW.md"),
    path.join(root, "docs", "notes-deploy-checklist.md"),
    path.join(root, "docs", "api-plan-notes.md"),
    path.join(root, "docs", "blue-sky-thoughts.md"),
  ];
}

// ── --doctrine ───────────────────────────────────────────────────────────

test("--doctrine with no kind covers every kind in KINDS, not a hardcoded ten", async () => {
  const names = Object.keys(KINDS);
  const { code, logs, errs } = await captureConsole(() => docsCmd(["--doctrine"], { workspaces: [] }));
  assert.equal(code, 0);
  assert.deepEqual(errs, []);
  const printed = logs.join("\n");
  for (const name of names) assert.match(printed, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("--doctrine <kind> prints all five fields for that kind", async () => {
  const { code, logs } = await captureConsole(() => docsCmd(["--doctrine", "design"], { workspaces: [] }));
  assert.equal(code, 0);
  const printed = logs.join("\n");
  assert.match(printed, /design\/IA intent; follows its surface/); // what
  assert.match(printed, /when a rendered surface exists that someone else must extend consistently/); // create
  assert.match(printed, /age — it follows its surface/); // maintain
  assert.match(printed, /the surface it governs; the canonical playbook it specialises/); // link
  assert.match(printed, /restate the playbook's token or component vocabulary/); // never
});

test("--doctrine <kind> --json returns exactly KINDS[kind] plus the kind name, nothing else on stdout", async () => {
  const { code, logs, errs } = await captureConsole(() =>
    docsCmd(["--doctrine", "design", "--json"], { workspaces: [] }),
  );
  assert.equal(code, 0);
  assert.deepEqual(errs, []);
  assert.equal(logs.length, 1, "exactly one console.log call in --json mode");
  const parsed = JSON.parse(logs[0]);
  assert.deepEqual(parsed, { kind: "design", ...KINDS.design });
});

test("--doctrine with an unknown kind errors with a named reason and exit 2 — never prints nothing", async () => {
  const { code, logs, errs } = await captureConsole(() =>
    docsCmd(["--doctrine", "not-a-real-kind"], { workspaces: [] }),
  );
  assert.equal(code, 2);
  assert.equal(logs.length, 0);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /unknown kind "not-a-real-kind"/);
  // The reason names every real kind, derived from KINDS — not restated.
  for (const name of Object.keys(KINDS)) assert.match(errs[0], new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("--doctrine with an unknown kind, --json: the error is JSON (still stdout), exit 2, stderr untouched", async () => {
  const { code, logs, errs } = await captureConsole(() =>
    docsCmd(["--doctrine", "not-a-real-kind", "--json"], { workspaces: [] }),
  );
  assert.equal(code, 2);
  assert.equal(errs.length, 0);
  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.match(parsed.error, /unknown kind "not-a-real-kind"/);
  assert.deepEqual(parsed.knownKinds, Object.keys(KINDS));
});

test("--doctrine reads nothing from the injected workspace list — O(10), free (empty workspaces is fine)", async () => {
  // workspaces: [] would break every scanning mode; --doctrine must not care.
  const { code } = await captureConsole(() => docsCmd(["--doctrine"], { workspaces: [] }));
  assert.equal(code, 0);
});

// ── --kinds --json ───────────────────────────────────────────────────────

test("--kinds --json emits ONLY JSON on stdout, and its counts match a direct kindOf() census", async () => {
  const root = await fixtureTree();
  const { code, logs, errs } = await captureConsole(() =>
    docsCmd(["--kinds", "--json"], { workspaces: [{ root }] }),
  );
  assert.equal(code, 0);
  assert.deepEqual(errs, []);
  assert.equal(logs.length, 1, "exactly one console.log call — nothing else may touch stdout in --json mode");
  const parsed = JSON.parse(logs[0]); // throws if anything non-JSON leaked onto stdout

  const paths = fixtureDocPaths(root);
  const expectedByKind = {};
  let expectedUndeclared = 0;
  for (const p of paths) {
    const k = kindOf(p);
    expectedByKind[k.kind ?? "(none)"] = (expectedByKind[k.kind ?? "(none)"] ?? 0) + 1;
    if (k.source === "undeclared") expectedUndeclared++;
  }

  assert.equal(parsed.scanned, paths.length);
  assert.deepEqual(parsed.byKind, expectedByKind);
  assert.equal(parsed.undeclaredCount, expectedUndeclared);
  assert.equal(expectedUndeclared, 3, "sanity: this fixture is deliberately 2 declared / 3 undeclared");
});

test("--kinds (human mode) still prints the truncated undeclared preview and points at --undeclared", async () => {
  const root = await fixtureTree();
  const { logs } = await captureConsole(() => docsCmd(["--kinds"], { workspaces: [{ root }] }));
  const printed = logs.join("\n");
  assert.match(printed, /docs --undeclared/);
});

// ── --undeclared ─────────────────────────────────────────────────────────

test("--undeclared emits the FULL worklist, count equal to the census's own undeclared total — never hardcoded", async () => {
  const root = await fixtureTree();
  const { code, logs, errs } = await captureConsole(() =>
    docsCmd(["--undeclared", "--json"], { workspaces: [{ root }] }),
  );
  assert.equal(code, 0);
  assert.deepEqual(errs, []);
  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);

  const paths = fixtureDocPaths(root);
  const expected = paths.filter((p) => kindOf(p).source === "undeclared");
  assert.equal(parsed.count, expected.length);
  assert.equal(parsed.undeclared.length, expected.length, "no 8-item truncation — every row present");

  const byPath = new Map(parsed.undeclared.map((u) => [u.path, u.guess]));
  for (const p of expected) {
    assert.ok(byPath.has(p), `${p} missing from the full worklist`);
    assert.equal(byPath.get(p), guessKind(p), "reported guess must match guessKind() exactly");
  }
});

test("--undeclared best-guess: a deploy-flavoured name guesses ops, a plan-flavoured name guesses plan, an unhinted name guesses null", async () => {
  const root = await fixtureTree();
  assert.equal(guessKind(path.join(root, "docs", "notes-deploy-checklist.md")), "ops");
  assert.equal(guessKind(path.join(root, "docs", "api-plan-notes.md")), "plan");
  assert.equal(guessKind(path.join(root, "docs", "blue-sky-thoughts.md")), null);
});

test("--undeclared with nothing undeclared says so explicitly, not a bare empty list", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "docs-cmd-clean-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "DECISIONS.md"), "# Decisions\n");
  const { logs } = await captureConsole(() => docsCmd(["--undeclared"], { workspaces: [{ root }] }));
  const printed = logs.join("\n");
  assert.match(printed, /none — every scanned doc resolves to a kind/);
});

// ── --reference ──────────────────────────────────────────────────────────
//
// Plan §5/T5: `docs --reference [--check|--dry-run] [--force] [--json]`
// regenerates/verifies the generated "Doc kind guidelines" section of
// `docs/REFERENCE.md`, reusing `lib/report/rollup.mjs`'s `bodyHash`/
// `parseFooter`/`compareInputs` under its own marks. Every test below passes
// `referenceArtifact` (a tmp path) so the REAL `docs/REFERENCE.md` is never
// touched by this suite.

async function refPath(name = "REFERENCE.md") {
  const root = await mkdtemp(path.join(tmpdir(), "docs-cmd-ref-"));
  return path.join(root, name);
}

/** Flip the last hex digit of the footer's `body:` line — the minimal edit
 *  that makes `bodyHash(...)` disagree with the stored value while keeping
 *  the footer otherwise well-formed. Asserts the substitution actually
 *  matched exactly once (rule:discernment-checks §1 / the plan's own
 *  "confirm the mutation applied" instruction). */
function flipStoredBodyHash(text) {
  const m = /^body: ([0-9a-f]{12})$/m.exec(text);
  assert.ok(m, "fixture must already contain a well-formed body: line");
  const original = m[1];
  const flipped = original.slice(0, -1) + (original.at(-1) === "0" ? "1" : "0");
  const needle = `body: ${original}`;
  const count = text.split(needle).length - 1;
  assert.equal(count, 1, "expected exactly one body: line to flip");
  return text.replace(needle, `body: ${flipped}`);
}

test("--reference on a path that does not exist yet creates it, and a --check on the result is current", async () => {
  const artifact = await refPath();
  assert.equal(existsSync(artifact), false);
  const gen = await captureConsole(() => docsCmd(["--reference"], { referenceArtifact: artifact }));
  assert.equal(gen.code, 0);
  assert.equal(existsSync(artifact), true);
  const text = await readFile(artifact, "utf8");
  assert.match(text, new RegExp(REFERENCE_BODY_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, new RegExp(REFERENCE_FOOTER_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const check = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(check.code, 0);
  assert.match(check.errs.join("\n"), /current/);
});

test("REGRESSION: regenerating repeatedly is idempotent — the heading does not accumulate a copy per run", async () => {
  // Caught during manual verification of this change: an earlier version put
  // the "## Doc kind guidelines (generated)" heading BEFORE `REFERENCE_BODY_MARK`.
  // `spliceReferenceDoc` preserves everything before the mark as "existing
  // hand-authored prefix", so regeneration N's heading was captured into that
  // preserved prefix and regeneration N+1 appended a SECOND heading after it —
  // an unbounded duplicate on every run, silently, with `--check` reporting
  // `current` throughout (it only ever compares the MARKED span, which never
  // itself duplicated). Fixed by moving the heading inside the marked span,
  // so `BODY_MARK` is the true, sole splice point.
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const once = await readFile(artifact, "utf8");

  await docsCmd(["--reference"], { referenceArtifact: artifact });
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const thrice = await readFile(artifact, "utf8");

  assert.equal(thrice, once, "three regenerations in a row must produce byte-identical output");
  const headingCount = thrice.split("## Doc kind guidelines (generated)").length - 1;
  assert.equal(headingCount, 1, `expected exactly one heading, found ${headingCount}`);
  const bodyMarkCount = thrice.split(REFERENCE_BODY_MARK).length - 1;
  assert.equal(bodyMarkCount, 1, `expected exactly one body mark, found ${bodyMarkCount}`);

  const check = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(check.code, 0);
});

test("--reference on an EXISTING hand-authored file with no marker treats it as ungenerated, not hand-edited — appends without --force and preserves the prose", async () => {
  const artifact = await refPath();
  const handProse = "# Some hand-authored heading\n\nReal prose that must survive regeneration verbatim.\n";
  await writeFile(artifact, handProse, "utf8");

  const gen = await captureConsole(() => docsCmd(["--reference"], { referenceArtifact: artifact }));
  assert.equal(gen.code, 0, gen.errs.join("\n"));
  const after = await readFile(artifact, "utf8");
  assert.ok(after.startsWith(handProse.trimEnd()), "hand-authored prefix must be preserved verbatim");
  assert.match(after, new RegExp(REFERENCE_BODY_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("--reference --check on an existing file with no generated section yet is could-not-run (2), never stale or hand-edited", async () => {
  const artifact = await refPath();
  await writeFile(artifact, "# Unrelated prose, never generated by this tool\n", "utf8");
  const { code, logs, errs } = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(code, 2);
  assert.equal(logs.length, 0);
  assert.match(errs.join("\n"), /could-not-run/);
  assert.match(errs.join("\n"), /no generated section yet/);
});

test("--reference --check --json on an absent path is could-not-run (2), JSON on stdout, stderr untouched", async () => {
  const artifact = await refPath();
  const { code, logs, errs } = await captureConsole(() =>
    docsCmd(["--reference", "--check", "--json"], { referenceArtifact: artifact }),
  );
  assert.equal(code, 2);
  assert.equal(errs.length, 0);
  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.status, "could-not-run");
  assert.equal(parsed.path, artifact);
});

test("hand-editing the generated body: --check reports hand-edited (3) with the stored-vs-current hashes named, and a bare regenerate refuses too, leaving the file byte-identical", async () => {
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact }); // generate once, silently
  const original = await readFile(artifact, "utf8");

  const mutated = original.replace(
    "### The ten kinds",
    "### The ten kinds\n\nHAND EDIT INJECTED BY TEST",
  );
  assert.notEqual(mutated, original, "mutation must actually change the text");
  await writeFile(artifact, mutated, "utf8");

  const check = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(check.code, 3);
  assert.match(check.errs.join("\n"), /does not match the current body/);

  const regen = await captureConsole(() => docsCmd(["--reference"], { referenceArtifact: artifact }));
  assert.equal(regen.code, 3, "a bare regenerate must refuse a hand-edited generated section, not silently clobber it");

  const stillMutated = await readFile(artifact, "utf8");
  assert.equal(stillMutated, mutated, "refused write must leave the file byte-identical to the hand edit");

  const forced = await captureConsole(() => docsCmd(["--reference", "--force"], { referenceArtifact: artifact }));
  assert.equal(forced.code, 0);
  const recheck = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(recheck.code, 0, "current again after --force regenerates");
});

test("--reference --dry-run never writes, and prints the generated section to stdout", async () => {
  const artifact = await refPath();
  const { code, logs } = await captureConsole(() => docsCmd(["--reference", "--dry-run"], { referenceArtifact: artifact }));
  assert.equal(code, 0);
  assert.equal(existsSync(artifact), false, "--dry-run must never create the file");
  assert.match(logs.join("\n"), new RegExp(REFERENCE_BODY_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("--reference --dry-run --json reports would-write, still never touches disk", async () => {
  const artifact = await refPath();
  const { code, logs } = await captureConsole(() =>
    docsCmd(["--reference", "--dry-run", "--json"], { referenceArtifact: artifact }),
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.action, "would-write");
  assert.equal(existsSync(artifact), false);
});

test("a stale INPUT (simulated: the stored footer names an input hash that no longer matches) reports --check exit 1, and regenerating without --force clears it back to 0", async () => {
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const original = await readFile(artifact, "utf8");

  // Rewrite ONLY the stored input hash for lib/report/doc-kind.mjs — this is
  // the same observable effect a real edit to KINDS would have on the
  // footer (the plan's own verification step 3), reached here without
  // mutating the real source file so this suite stays hermetic.
  const needle = /lib\/report\/doc-kind\.mjs :: [0-9a-f]{12}/;
  assert.ok(needle.test(original), "fixture must already have the doc-kind.mjs input line");
  const staled = original.replace(needle, "lib/report/doc-kind.mjs :: 000000000000");
  assert.notEqual(staled, original, "stale-input mutation must actually change the text");
  await writeFile(artifact, staled, "utf8");

  const check = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(check.code, 1, check.errs.join("\n"));
  assert.match(check.errs.join("\n"), /stale/);

  // Body was never touched, so a bare regenerate (no --force) must be
  // ALLOWED — staleness alone is not a hand-edit.
  const regen = await captureConsole(() => docsCmd(["--reference"], { referenceArtifact: artifact }));
  assert.equal(regen.code, 0, "regenerating over a merely-stale (not hand-edited) file must not require --force");
  const recheck = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(recheck.code, 0);
});

test("--reference is self-verifying: the rendered precedence example matches a live kindOf() call, not a hardcoded string", async () => {
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const text = await readFile(artifact, "utf8");
  assert.match(text, /docs\/design\/README\.md\s+->\s+router\s+\(filename tier\)/);
  assert.match(text, /docs\/design\/TODOS\.md\s+->\s+state\s+\(filename tier\)/);
  assert.match(text, /docs\/design\/OVERVIEW\.md\s+->\s+design\s+\(directory tier\)/);
  assert.equal(kindOf("docs/design/README.md").kind, "router");
  assert.equal(kindOf("docs/design/TODOS.md").kind, "state");
  assert.equal(kindOf("docs/design/OVERVIEW.md").kind, "design");
});

// ── --reference mutation checks (rule:discernment-checks §1) ──────────────

test("MUTATION CHECK: flipping the stored body hash's last hex digit is enough to trip hand-edited detection", async () => {
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const original = await readFile(artifact, "utf8");
  const flipped = flipStoredBodyHash(original);
  await writeFile(artifact, flipped, "utf8");
  const { code } = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(code, 3, "a one-character stored-hash mismatch must be caught, not tolerated as noise");
});

test("MUTATION CHECK: an UNTOUCHED round trip (generate, read back, check) is current — proves the hand-edit test above isn't vacuously red", async () => {
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const { code } = await captureConsole(() => docsCmd(["--reference", "--check"], { referenceArtifact: artifact }));
  assert.equal(code, 0);
});

test("MUTATION CHECK: bodyHash recomputed over the untouched file matches the stored footer body — proves the generator's own placeholder-then-rehash sequence is correct", async () => {
  const artifact = await refPath();
  await docsCmd(["--reference"], { referenceArtifact: artifact });
  const text = await readFile(artifact, "utf8");
  const m = /^body: ([0-9a-f]{12})$/m.exec(text);
  assert.ok(m);
  assert.equal(bodyHash(text, REFERENCE_BODY_MARK, REFERENCE_FOOTER_MARK).slice(0, 12), m[1]);
});

// ── The required failing-input mutations (rule:discernment-checks §1) ─────
//
// Each test above is paired here with the input that SHOULD make it fail,
// to prove the assertion is load-bearing rather than vacuously true. These
// stay in the suite (rather than a throwaway manual check) so a future
// regression in the same shape is caught the same way.

test("MUTATION CHECK: a kind missing from the printed --doctrine table would be caught", async () => {
  const { logs } = await captureConsole(() => docsCmd(["--doctrine"], { workspaces: [] }));
  const printed = logs.join("\n");
  // A kind name that does not exist must NOT appear — proves the assertion
  // in the real test above is not matching everything indiscriminately.
  assert.doesNotMatch(printed, /zzz-not-a-kind-zzz/);
});

test("MUTATION CHECK: --kinds --json with a doc reclassified would move the count — the census is not a constant", async () => {
  const root = await fixtureTree();
  // Add a sixth doc that IS declared (filename tier: GOTCHAS.md) and confirm
  // scanned/byKind move by exactly one — proving byKind is actually derived
  // from the fixture, not a fixed literal the test happens to match.
  await writeFile(path.join(root, "docs", "GOTCHAS.md"), "# Gotchas\n");
  const { logs } = await captureConsole(() => docsCmd(["--kinds", "--json"], { workspaces: [{ root }] }));
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.scanned, 6);
  assert.equal(parsed.byKind.gotchas, 1);
});

test("MUTATION CHECK: an unknown --doctrine kind that happens to be real (case mismatch) is still rejected", async () => {
  // KINDS keys are lowercase-hyphenated; "Design" must not silently resolve
  // to "design" — proves the lookup is an exact key match, not case-folded.
  const { code, errs } = await captureConsole(() => docsCmd(["--doctrine", "Design"], { workspaces: [] }));
  assert.equal(code, 2);
  assert.match(errs[0], /unknown kind "Design"/);
});

// ── End-to-end: cli.mjs actually threads argv and sets exitCode ───────────
//
// The one thing a unit test importing docsCmd() directly cannot prove: that
// cli.mjs's `mode === "docs"` dispatch passes argv through and surfaces the
// exit code. `--doctrine` is safe to run for real here — it is checked
// before any workspace scan, so this does not pay the 21s cost.

test("cli.mjs docs --doctrine design --json (real subprocess): argv reaches docsCmd, JSON-only stdout, exit 0", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "docs", "--doctrine", "design", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: "/tmp/propagate-docs-cmd-test-unused" },
    timeout: 30000,
  });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed, { kind: "design", ...KINDS.design });
});

test("cli.mjs docs --doctrine bogus --json (real subprocess): exit 2, JSON error on stdout", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "docs", "--doctrine", "bogus-kind", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: "/tmp/propagate-docs-cmd-test-unused" },
    timeout: 30000,
  });
  assert.equal(res.status, 2);
  const parsed = JSON.parse(res.stdout);
  assert.match(parsed.error, /unknown kind "bogus-kind"/);
});

test("cli.mjs docs --reference --check --json (real subprocess, read-only): argv reaches docsCmd against this repo's OWN docs/REFERENCE.md", () => {
  // Read-only (--check never writes), so this is safe to run against the
  // real file — same posture as the --doctrine subprocess tests above.
  // Asserts one of the two legitimate outcomes rather than a fixed exit
  // code: the real file's status depends on whether it was regenerated
  // after the most recent `lib/report/doc-kind.mjs` edit, which is exactly
  // what this command exists to report, not a fact this test should pin.
  const res = spawnSync(process.execPath, [CLI_PATH, "docs", "--reference", "--check", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_STATE_DIR: "/tmp/propagate-docs-cmd-test-unused" },
    timeout: 30000,
  });
  assert.ok([0, 1].includes(res.status), `expected current(0) or stale(1), got ${res.status}: ${res.stdout} ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.ok(["current", "stale"].includes(parsed.status));
  assert.equal(parsed.ok, res.status === 0);
});
