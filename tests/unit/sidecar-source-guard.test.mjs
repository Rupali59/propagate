/**
 * The SOURCE side of a sidecar was checked by nothing (ISSUES N8 / workspace-hub#8).
 *
 * `doctor` has checked `sidecar downstream paths resolve` since v1, and
 * `downstream-path-guard.test.mjs`'s own header names the spec item as "bug B:
 * SOURCE/downstream names a file that no longer exists" — so the source half was
 * specified and never built. Measured 2026-09-30: `grep -rn "source paths resolve"`
 * over `lib/` returned nothing, and no check anywhere stats a declared source.
 *
 * That asymmetry cost six weeks of dead sidecar entries (2026-08-14). A dangling
 * source is worse than a missing declaration, because `status` counts it — so the
 * artifact reads as coupling-reviewed while nothing checks it.
 *
 * THE NEGATIVE CONTROLS ARE THE POINT. Without "a present source warns about
 * nothing" this check would fire on every workspace in the tree and be switched
 * off within a day; without "a glob matching files stays silent" it would fire on
 * every glob source. A check that cannot pass is as useless as one that cannot
 * fail (rule:discernment-checks §1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = fileURLToPath(new URL("../../", import.meta.url));
const CLI_PATH = path.join(SKILL_DIR, "cli.mjs");

/**
 * A minimal workspace whose `sub/.propagates.yml` declares `source` with one
 * downstream. `present` controls whether the source file is actually written.
 */
async function makeWorkspace({ source, present, downstreams = 1 }) {
  const root = await mkdtemp(path.join(tmpdir(), "srcguard-ws-"));
  await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(path.join(docsDir, "PROPAGATION_LEDGER.jsonl"), "", "utf8");

  const subDir = path.join(root, "sub");
  await mkdir(subDir, { recursive: true });
  // The downstream always exists, so any warning must be about the SOURCE.
  const outs = [];
  for (let i = 0; i < downstreams; i += 1) {
    const name = `down${i}.md`;
    await writeFile(path.join(subDir, name), "# downstream\n", "utf8");
    outs.push(`      - path: ${name}\n        why: "because reasons"`);
  }
  if (present) await writeFile(path.join(subDir, source.replace(/\*.*$/, "real.md")), "# source\n", "utf8");
  await writeFile(
    path.join(subDir, ".propagates.yml"),
    `sources:\n  ${source}:\n    propagates_to:\n${outs.join("\n")}\n`,
    "utf8",
  );
  return root;
}

function runDoctor(root) {
  // G10: one override moves every path together, or this writes the real
  // metrics.jsonl.
  const r = spawnSync(process.execPath, [CLI_PATH, "doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PROPAGATE_SEARCH_ROOTS: root, PROPAGATE_STATE_DIR: root },
  });
  return r.stdout + r.stderr;
}

test("a sidecar whose SOURCE file is gone is reported, naming how many edges died with it", async () => {
  const root = await makeWorkspace({ source: "moved-away.md", present: false, downstreams: 2 });
  try {
    const out = runDoctor(root);
    assert.match(
      out,
      /sidecar SOURCE missing/,
      `a declared source that is not on disk must be reported:\n${out}`,
    );
    assert.match(out, /moved-away\.md/, "the report must name the source path");
    // The edge count is the actionable part: it says how much coverage was lost,
    // which is the difference between a typo and a refactor that stranded a file.
    assert.match(out, /declares 2 downstream\(s\)/, "the report must say how many edges are dead");
    assert.match(
      out,
      /rule:refactor-updates-sidecar-same-commit/,
      "the report must name the rule that prevents it, not merely the symptom",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a source that exists warns about nothing", async () => {
  // Without this the check fires on every workspace in the tree and gets ignored
  // within a day — which is how a permanently-red doctor trains people to skip it.
  const root = await makeWorkspace({ source: "real.md", present: true });
  try {
    const out = runDoctor(root);
    assert.doesNotMatch(out, /sidecar SOURCE missing/, `a present source must be silent:\n${out}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a GLOB source matching nothing is its own outcome, never folded into 'missing'", async () => {
  // rule:discernment-checks §2. "This pattern matched no files" and "this file is
  // gone" lead to different fixes — widen the pattern, versus restore the path.
  const root = await makeWorkspace({ source: "nope/*.md", present: false });
  try {
    const out = runDoctor(root);
    assert.match(out, /sidecar SOURCE glob matched 0 files/, `a dead glob must say so:\n${out}`);
    assert.doesNotMatch(
      out,
      /sidecar SOURCE missing/,
      "a glob that matched nothing must NOT be reported as a missing file",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a glob source that matches a file stays silent", async () => {
  const root = await makeWorkspace({ source: "*.md", present: true });
  try {
    const out = runDoctor(root);
    assert.doesNotMatch(out, /sidecar SOURCE glob matched 0 files/, `a live glob must be silent:\n${out}`);
    assert.doesNotMatch(out, /sidecar SOURCE missing/, "a glob is never reported as a missing file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing source WARNS rather than failing the run", async () => {
  // Deliberate, and the same reasoning the adjacent missing-downstream branch
  // states: doctor is a cross-workspace health report, so one stale edge in one
  // workspace must not red the aggregate exit code. Per-repo enforcement belongs
  // in that repo's pre-commit hook.
  const root = await makeWorkspace({ source: "gone.md", present: false });
  try {
    const out = runDoctor(root);
    assert.match(out, /sidecar SOURCE missing/);
    assert.doesNotMatch(
      out,
      /✗[^\n]*sidecar SOURCE/,
      "a dangling source must not be a counted failure — a permanently-red doctor gets ignored",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Next.js bracket path is a LITERAL, not a glob — on both the source and downstream side", async () => {
  // FOUND BY RUNNING IT, not by review (rule:name-what-no-test-executes). The
  // first version of the source check reported
  // `Manav-portfolio: src/app/work/[slug]/page.tsx` as "glob matched 0 files"
  // for a file that is on disk:
  //
  //   existsSync("src/app/work/[slug]/page.tsx")  -> true
  //   globSync(same)                              -> []   ([slug] = char class)
  //
  // `[slug]` is a Next.js App Router dynamic segment. The DOWNSTREAM check had
  // the identical bug from the start and nobody had declared a bracket
  // downstream, so it never surfaced — which is why both sides now share one
  // literal-first predicate rather than two copies of the test.
  const root = await mkdtemp(path.join(tmpdir(), "srcguard-brackets-"));
  try {
    await writeFile(path.join(root, ".propagates.yml"), "workspace: true\nsources: {}\n", "utf8");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "PROPAGATION_LEDGER.jsonl"), "", "utf8");

    const sub = path.join(root, "sub");
    const dyn = path.join(sub, "app", "work", "[slug]");
    await mkdir(dyn, { recursive: true });
    await writeFile(path.join(dyn, "page.tsx"), "export default function P() {}\n", "utf8");
    await writeFile(path.join(sub, "down.md"), "# downstream\n", "utf8");
    // The bracket path is BOTH the source and a downstream, so one fixture
    // proves both call sites.
    await writeFile(
      path.join(sub, ".propagates.yml"),
      "sources:\n  app/work/[slug]/page.tsx:\n    propagates_to:\n" +
        "      - path: down.md\n        why: \"because reasons\"\n" +
        "      - path: app/work/[slug]/page.tsx\n        why: \"self, to exercise the downstream side\"\n",
      "utf8",
    );

    const out = runDoctor(root);
    assert.doesNotMatch(
      out,
      /sidecar SOURCE glob matched 0 files/,
      `an existing bracket path must not be treated as a glob:\n${out}`,
    );
    assert.doesNotMatch(out, /sidecar SOURCE missing/, "the source is on disk");
    assert.doesNotMatch(
      out,
      /glob matched 0 files[^\n]*\[slug\]/,
      "the DOWNSTREAM side must not report a bracket path as a dead glob either",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
