/**
 * doctor's `# Claims` section — the tree-wide judgment census.
 *
 * WHY THIS FILE EXISTS. `claims judge` takes ONE file, so without doctor's
 * aggregate nobody sees the tree-wide picture unless they already suspect
 * something — `rule:enforcement-watches-itself`: a capability nobody invokes is
 * indistinguishable from one that was never built.
 *
 * WHAT IT PINS, and it is the absence branch rather than the happy path. A
 * corpus with nothing declared must say so in those words. "No declared source
 * files" and "declared sources with nothing to judge" are different facts, and
 * only one of them is a pass (`rule:discernment-checks` §2). The phrase
 * `0 findings` must never appear: that is the string the whole honest-
 * degradation lane exists to avoid, because it reads as "looked, found
 * nothing" when the truth is "nobody looked".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs");
const strip = (t) => t.replace(/\x1B\[[0-9;]*m/g, "");

/**
 * Slice out ONLY the `# Claims` section.
 *
 * This function is the whole reason these tests are worth anything, and it
 * exists because the first version of this file was GREEN FOR THE WRONG
 * REASON. doctor's `# Goals` block prints "no GOALS.md under the search roots
 * — an empty scan, not a clean one". A bare `assert.match(out, /an empty scan,
 * not a clean one/)` over the full output therefore matched the GOALS line and
 * passed no matter what the Claims block did — proven by mutating the Claims
 * string to "no claims found" and watching all four tests stay green.
 *
 * `rule:discernment-checks` §4 records this exact shape: "a smoke check
 * passing — it asserted on the wrong element. A check that fails for the wrong
 * reason is as bad as one that cannot fail."
 */
function claimsSection(out) {
  const start = out.indexOf("# Claims");
  if (start === -1) return "";
  const rest = out.slice(start + "# Claims".length);
  const end = rest.search(/\n#\s/u);
  return end === -1 ? rest : rest.slice(0, end);
}

/** A workspace whose sidecar declares NO sources — the empty-corpus case. */
async function makeEmptyWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "doctor-claims-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  return root;
}

function runDoctor(root) {
  return spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    // GOTCHAS G10: one override moves all the paths together. Without
    // PROPAGATE_STATE_DIR this would append to the real metrics.jsonl.
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
  });
}

test("doctor renders a Claims section", async () => {
  const root = await makeEmptyWorkspace();
  try {
    const out = strip(runDoctor(root).stdout + runDoctor(root).stderr);
    assert.match(out, /# Claims/, `doctor must render the Claims section:\n${out.slice(0, 2000)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty corpus says so — an empty scan is not a clean one", async () => {
  const root = await makeEmptyWorkspace();
  try {
    const r = runDoctor(root);
    const out = claimsSection(strip(r.stdout + r.stderr));
    assert.match(
      out,
      /an empty scan, not a clean one/,
      `a corpus with no declared sources must SAY it scanned nothing, never render as clean:\n${out.slice(0, 2000)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor never says `0 findings` for claims — that is the string this lane exists to avoid", async () => {
  const root = await makeEmptyWorkspace();
  try {
    const r = runDoctor(root);
    const out = claimsSection(strip(r.stdout + r.stderr));
    // "looked and found nothing" vs "nobody looked". Only one is a pass, and
    // `0 findings` is the phrasing that collapses them.
    assert.doesNotMatch(
      out,
      /0 findings/,
      `"0 findings" collapses "nobody looked" into "looked and found nothing":\n${out.slice(0, 2000)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a thrown reader is attributable, never silence", async () => {
  // A sidecar that parses but whose declared source cannot be read must still
  // produce a Claims line. The failure mode being pinned is a `catch` that
  // swallows and prints nothing, leaving the section absent — which reads as
  // "no claims" rather than "the reader failed".
  const root = await mkdtemp(path.join(tmpdir(), "doctor-claims-bad-"));
  try {
    await writeFile(
      path.join(root, ".propagates.yml"),
      "workspace: true\nsources:\n  does-not-exist.md:\n    propagates_to:\n      - path: also-missing.md\n        why: fixture for the unreadable branch\n        kind: prose\n",
      "utf8",
    );
    const r = runDoctor(root);
    const full = strip(r.stdout + r.stderr);
    const out = claimsSection(full);
    assert.match(full, /# Claims/, `the section must render even when a declared source is missing:\n${out.slice(0, 2000)}`);
    assert.match(
      out,
      /judgment states|could not be derived|could not be read/,
      `an unreadable corpus must be attributable, not silent:\n${out.slice(0, 2000)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor warns when blocks are unanswerable — the branch that means the machinery failed", async () => {
  // The actionable line in the Claims section is `unanswerable > 0`: a caller
  // tried to judge and could not. Everything else is informational. Found
  // untested by the ship testing specialist, which reproduced the branch by
  // hand and handed over this recipe.
  const root = await mkdtemp(path.join(tmpdir(), "doctor-claims-unans-"));
  try {
    const doc = path.join(root, "doc.md");
    await writeFile(doc, "# Doc\n\nA claim that can be judged.\n", "utf8");
    await writeFile(
      path.join(root, ".propagates.yml"),
      `workspace: true\nsources:\n  doc.md:\n    propagates_to:\n      - path: other.md\n        why: fixture declaring doc.md as a source so the corpus contains it\n        kind: prose\n`,
      "utf8",
    );
    await writeFile(path.join(root, "other.md"), "# Other\n", "utf8");

    // A run that STARTS and never ENDS is the crashed case — the caller tried
    // and we cannot tell whether it finished, which is exactly `unanswerable`.
    const started = spawnSync(process.execPath, [CLI_PATH, "claims", "answer", doc, "start"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
    });
    assert.equal(started.status, 0, `claims answer start must succeed:\n${started.stdout}${started.stderr}`);

    const out = claimsSection(strip(runDoctor(root).stdout + runDoctor(root).stderr));
    assert.match(
      out,
      /nobody could judge/,
      `an unended run must surface as unanswerable in doctor, not vanish:\n${out.slice(0, 2000)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
